# fai.py — 首件尺寸检验（FAI）：方案尺寸快照与测量分析（纯函数，无 I/O）
"""从已保存的钉板方案冻结连接器姿态、分支点、拼接件、包覆边界与理论尺寸，
按检验路线生成测点项目；对实测读数做偏差计算，标出基准缺失、测点错序、
单位不明、结论矛盾；超差项需处置（返工/让步/报废）后才可放行。
供 server.py 调用，并由 test_fai.py 单元测试。"""
import hashlib
import json
import math
import re

# 测点类型
CONN_SPACING = 'conn_spacing'     # 连接器间距
BRANCH_POS = 'branch_pos'         # 分支定位（沿支路到相邻连接器/分支/拼接）
WIRE_LEN = 'wire_len'             # 支路长度（导线路径长）
COVER_EDGE = 'cover_edge'         # 包覆起止（边界到最近基准节点）
TAIL = 'tail'                     # 尾部余量（连接器到首个路径顶点之外）
CUSTOM = 'custom'                 # 检验员自选两基准补录

TYPE_NAMES = {
    CONN_SPACING: '连接器间距',
    BRANCH_POS: '分支定位',
    WIRE_LEN: '支路长度',
    COVER_EDGE: '包覆起止',
    TAIL: '尾部余量',
    CUSTOM: '自选测点',
}
REQUIRED_TYPES = (CONN_SPACING, BRANCH_POS, WIRE_LEN, COVER_EDGE, TAIL)

# 各类测点默认上下公差（mm，单边绝对值）：neg=下偏差, pos=上偏差
DEFAULT_TOL = {
    CONN_SPACING: {'neg': 5.0, 'pos': 5.0},
    BRANCH_POS: {'neg': 5.0, 'pos': 5.0},
    WIRE_LEN: {'neg': 5.0, 'pos': 10.0},
    COVER_EDGE: {'neg': 3.0, 'pos': 3.0},
    TAIL: {'neg': 0.0, 'pos': 10.0},   # 尾部余量只欠不少（下偏差 0 即不允许短于理论）
    CUSTOM: {'neg': 5.0, 'pos': 5.0},
}

# 长度单位（全部换算为 mm）。空单位按 mm 计但提示“单位缺失”，
# 无法识别的单位标“单位不明”，不做猜测换算。
UNIT_TO_MM = {
    'mm': 1.0, '毫米': 1.0, 'm': 1000.0, '米': 1000.0,
    'cm': 10.0, '厘米': 10.0,
}
UNIT_CANON = {'毫米': 'mm', '米': 'm', '厘米': 'cm'}

NEAR_NODE = 2.0   # 基准/边界吸附节点的距离阈值（mm）

# ---------- 基础几何 ----------


def _dist(a, b):
    return math.hypot(a['x'] - b['x'], a['y'] - b['y'])


def _poly_len(pts):
    return sum(_dist(pts[i - 1], pts[i]) for i in range(1, len(pts)))


def resolve_path(design, wire, by_id):
    """绑定节点的路径顶点解析为当前坐标（与前端 resolvePath 一致）。"""
    out = []
    for p in wire.get('path') or []:
        nid = p.get('node')
        n = by_id.get(nid) if nid else None
        if n:
            out.append({'x': n['x'], 'y': n['y'], 'node': nid})
        else:
            out.append({'x': p.get('x', 0), 'y': p.get('y', 0), 'node': nid or None})
    return out


def _point_at_arc(pts, s):
    if not pts:
        return {'x': 0, 'y': 0}
    acc = 0.0
    for i in range(1, len(pts)):
        L = _dist(pts[i - 1], pts[i])
        if acc + L >= s - 1e-9 or i == len(pts) - 1:
            t = max(0.0, min(1.0, (s - acc) / L)) if L > 1e-12 else 0.0
            return {'x': pts[i - 1]['x'] + (pts[i]['x'] - pts[i - 1]['x']) * t,
                    'y': pts[i - 1]['y'] + (pts[i]['y'] - pts[i - 1]['y']) * t}
        acc += L
    return {'x': pts[-1]['x'], 'y': pts[-1]['y']}


def _nearest_node(design, p, skip=()):
    best, bd = None, float('inf')
    for n in design['nodes']:
        if n.get('id') in skip:
            continue
        d = _dist(n, p)
        if d < bd:
            best, bd = n, d
    return best, bd


def _nat_key(name):
    return [(0, int(x)) if x.isdigit() else (1, x) for x in re.split(r'(\d+)', str(name))]


def _base_node(n):
    return bool(n) and n.get('type') in ('connector', 'branch', 'splice')


def _wire_end_nodes(w, pts, by_id):
    """导线两端的基准节点：以实际路径端点绑定的节点为准（冻结理论几何），
    路径端点未绑定节点时才回退到保存的 from/to；返回 (node_a, node_b)。"""
    out = []
    path_ends = [pts[0] if pts else None, pts[-1] if pts else None]
    saved = [(w.get('from') or {}).get('node'), (w.get('to') or {}).get('node')]
    for i in range(2):
        n = None
        pe = path_ends[i]
        if pe and pe.get('node') and _base_node(by_id.get(pe['node'])):
            n = by_id[pe['node']]
        else:
            cand = by_id.get(saved[i])
            if _base_node(cand):
                n = cand
        out.append(n)
    return out[0], out[1]


# ---------- 快照 ----------

def _ref_of_node(n):
    return {'id': n.get('id'), 'name': str(n.get('name')),
            'type': n.get('type'), 'x': n.get('x', 0), 'y': n.get('y', 0)}


def build_snapshot(design, design_id=None, design_name=None, tol=None):
    """从钉板方案冻结首件检验快照并生成检验路线测点。

    冻结内容：连接器（含姿态坐标）、分支点、拼接件、包覆边界（锚点解析坐标）、
    导线路径与理论尺寸。测点按测量路线排序：连接器间距 → 分支定位 →
    支路长度 → 包覆起止 → 尾部余量。"""
    tol = tol or {}
    nodes = design.get('nodes') or []
    wires = design.get('wires') or []
    by_id = {n.get('id'): n for n in nodes}

    conns = sorted((n for n in nodes if n.get('type') == 'connector'),
                   key=lambda n: _nat_key(n.get('name')))
    if not conns:
        raise ValueError('方案中没有连接器，无法生成首件尺寸测点')

    names = [str(c.get('name') or '') for c in conns]
    dups = sorted({n for n in names if n and names.count(n) > 1})
    if dups:
        raise ValueError('连接器名称重复：' + '、'.join(dups))

    branches = [n for n in nodes if n.get('type') == 'branch']
    splices = [n for n in nodes if n.get('type') == 'splice']

    # 导线解析路径与弧长（弧长用于把包裹锚点还原为物理坐标）
    wpaths = {}
    for w in wires:
        wpaths[w.get('id')] = resolve_path(design, w, by_id)

    items = []
    seq = [0]

    def add(kind, name, a, b, nominal, refs=None, wire=None, cover=None, note='', required=True):
        seq[0] += 1
        d = tol.get(kind) or DEFAULT_TOL[kind]
        neg = float(d.get('neg', 0.0)); pos = float(d.get('pos', 0.0))
        items.append({
            'id': 'M%03d' % seq[0], 'seq': seq[0], 'kind': kind,
            'name': name, 'note': note,
            'ref_a': a, 'ref_b': b,            # {'id','name','type','x','y'}
            'axis_refs': refs or ([r['id'] for r in (a, b) if r]),
            'wire_id': wire, 'cover_id': cover,
            'nominal': round(float(nominal), 2),
            'tol_neg': neg, 'tol_pos': pos,
            'required': bool(required),
        })

    # 1) 连接器间距：两两组合（直线中心距），按名字自然排序
    for i in range(len(conns)):
        for j in range(i + 1, len(conns)):
            a, b = conns[i], conns[j]
            add(CONN_SPACING, '%s—%s 间距' % (a['name'], b['name']),
                _ref_of_node(a), _ref_of_node(b), _dist(a, b))

    # 2) 分支定位：每个分支点沿各引出支路到相邻连接器/分支/拼接的沿线路径长。
    #    路径以“实际路径绑定节点”为准，避免保存端点与路径不一致时基准错位。
    def path_from_node(pts, nid):
        idx = next((k for k, p in enumerate(pts) if p.get('node') == nid), None)
        if idx is None:
            return []
        results = []
        for step in (-1, 1):
            k = idx
            while 0 <= k + step < len(pts):
                k += step
                p = pts[k]
                t = by_id.get(p.get('node'))
                if t and p.get('node') != nid and _base_node(t):
                    lo, hi = sorted((idx, k))
                    results.append((t, _poly_len(pts[lo:hi + 1])))
                    break
        return results

    for br in sorted(branches, key=lambda n: _nat_key(n.get('name'))):
        touched = []
        for w in wires:
            pts = wpaths.get(w.get('id')) or []
            if not any(p.get('node') == br.get('id') for p in pts):
                continue
            for t, L in path_from_node(pts, br.get('id')):
                if any(x[0] == t.get('id') for x in touched) or L <= 1e-6:
                    continue
                touched.append((t.get('id'), L, w.get('id')))
        touched.sort(key=lambda x: x[1])
        for key, L, wid in touched[:4]:
            t = by_id[key]
            add(BRANCH_POS, '%s→%s 定位' % (br['name'], t['name']),
                _ref_of_node(br), _ref_of_node(t), L,
                wire=wid, note='沿支路线长')

    # 3) 支路长度：两端基准节点以路径端点为准（保存端点与路径不一致时不产生错位）
    for w in sorted(wires, key=lambda x: str(x.get('label') or x.get('id'))):
        pts = wpaths.get(w.get('id')) or []
        ep_a, ep_b = _wire_end_nodes(w, pts, by_id)
        if not ep_a or not ep_b or len(pts) < 2:
            continue
        L = _poly_len(pts)
        if L <= 1e-6:
            continue
        add(WIRE_LEN, '%s %s—%s 支路长' % (w.get('label') or w.get('id'),
                                          ep_a['name'], ep_b['name']),
            _ref_of_node(ep_a), _ref_of_node(ep_b), L, wire=w.get('id'))

    # 4) 包覆起止：每个包覆段首尾锚点解析为坐标，量到最近基准节点的沿线/直线距离
    for c in design.get('covers') or []:
        anchors = c.get('anchors') or []
        cname = str(c.get('name') or c.get('id'))
        for edge_i, tail in ((0, '起'), (-1, '止')):
            if not anchors:
                continue
            a = anchors[edge_i]
            w = next((x for x in wires if x.get('id') == a.get('wire')), None)
            pts = wpaths.get(a.get('wire'))
            if not w or not pts:
                continue
            s = max(0.0, min(_poly_len(pts), float(a.get('s') or 0.0)))
            p = _point_at_arc(pts, s)
            ref = {'id': None, 'name': '%s%s' % (cname, tail),
                   'type': 'cover_edge', 'x': p['x'], 'y': p['y']}
            near, nd = _nearest_node(design, p)
            # 包覆边界通常落在某节点处；距节点 ≤NEAR_NODE 则以该节点为零基准
            if near and nd <= NEAR_NODE and near.get('type') in ('connector', 'branch', 'splice'):
                add(COVER_EDGE, '%s 包覆%s（%s）' % (cname, tail, near['name']),
                    ref, _ref_of_node(near), 0.0,
                    refs=[near.get('id')], cover=c.get('id'),
                    note='边界应落在 %s 处' % near['name'])
            else:
                # 自由边界：量到沿同一导线最近的基准节点的沿线距离
                tnode, tdist = _cover_edge_target(pts, s, by_id, a.get('wire'), wires)
                add(COVER_EDGE, '%s 包覆%s边界' % (cname, tail),
                    ref, _ref_of_node(tnode) if tnode else None,
                    tdist if tnode else 0.0,
                    refs=[tnode.get('id')] if tnode else [],
                    wire=w.get('id'), cover=c.get('id'),
                    note='沿%s到 %s' % (w.get('label') or '导线',
                                        tnode['name'] if tnode else '（无基准）'),
                    required=bool(tnode))

    # 5) 尾部余量：连接器到引出后“首个自由折点”的直线段。
    #    若相邻路径顶点仍绑定节点（导线直通分支/拼接/另一连接器），说明该端无
    #    独立尾部，不生成测点（避免给直通导线造出不存在的尾部余量）。
    for w in sorted(wires, key=lambda x: str(x.get('label') or x.get('id'))):
        pts = wpaths.get(w.get('id')) or []
        if len(pts) < 2:
            continue
        for side, end_idx, nxt_idx in (('from', 0, 1), ('to', len(pts) - 1, len(pts) - 2)):
            ep = pts[end_idx]
            n = by_id.get(ep.get('node'))
            if not n or n.get('type') != 'connector':
                continue
            nxt = pts[nxt_idx]
            if nxt.get('node'):
                continue  # 直通：相邻顶点是另一基准节点，无独立尾部
            L = _dist(ep, nxt)
            if L <= 1e-6:
                continue
            add(TAIL, '%s %s端 %s 尾部余量' % (w.get('label') or w.get('id'),
                                               '起' if side == 'from' else '终', n['name']),
                _ref_of_node(n),
                {'id': None, 'name': '首个折点', 'type': 'bend',
                 'x': nxt['x'], 'y': nxt['y']},
                L, wire=w.get('id'))

    if not items:
        raise ValueError('方案中没有可冻结的尺寸测点')

    snapshot = {
        'design_id': design_id,
        'design_name': design_name or '',
        'board': {
            'width': (design.get('board') or {}).get('width', 900),
            'height': (design.get('board') or {}).get('height', 600),
            'grid': (design.get('board') or {}).get('grid', 10),
        },
        'connectors': [_ref_of_node(c) for c in conns],
        'branches': [_ref_of_node(b) for b in branches],
        'splices': [{
            'id': s.get('id'), 'type': 'splice', 'name': str(s.get('name')),
            'kind': s.get('kind', 'cap'),
            'x': s.get('x', 0), 'y': s.get('y', 0),
            'ports': max(2, int(s.get('ports') or 4)),
            'strip': s.get('strip', 7),
            'sleeve_d': s.get('sleeveD', 0), 'sleeve_len': s.get('sleeveLen', 0),
        } for s in splices],
        'wires': [_wire_freeze(w, wpaths.get(w.get('id')) or [], by_id) for w in wires
                  if wpaths.get(w.get('id'))],
        'covers': _covers_freeze(design, wpaths, wires, by_id),
        'items': items,
        'defaults': DEFAULT_TOL,
    }
    snapshot['hash'] = snapshot_hash(snapshot)
    snapshot['geom_hash'] = geometry_hash(snapshot)
    return snapshot


def geometry_hash(snapshot):
    """只对冻结的几何（连接器/分支/拼接/导线路径/包覆边界）取指纹。
    自选测点与公差调整不影响几何，因此不会误报快照过期。"""
    payload = {
        'connectors': [[c['id'], round(c['x'], 2), round(c['y'], 2)] for c in snapshot['connectors']],
        'branches': [[b['id'], round(b['x'], 2), round(b['y'], 2)] for b in snapshot['branches']],
        'splices': [[s['id'], round(s['x'], 2), round(s['y'], 2)] for s in snapshot['splices']],
        'wires': [[w['id'], w['from_node'], w['to_node'],
                   [[round(p['x'], 1), round(p['y'], 1)] for p in w['path']]]
                  for w in snapshot['wires']],
        'covers': [[c['id'], [[round(p['x'], 1), round(p['y'], 1)] for p in c['anchors']]]
                   for c in snapshot['covers']],
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]


def _cover_edge_target(pts, s, by_id, wire_id, wires):
    """自由包覆边界：沿该导线在弧长 s 两侧找最近的基准节点，返回 (node, 沿线距离)。"""
    # 计算逐顶点累计弧长
    acc = [0.0]
    for i in range(1, len(pts)):
        acc.append(acc[-1] + _dist(pts[i - 1], pts[i]))
    best = None
    for i, p in enumerate(pts):
        t = by_id.get(p.get('node'))
        if not t or t.get('type') not in ('connector', 'branch', 'splice'):
            continue
        d = abs(acc[i] - s)
        if best is None or d < best[1]:
            best = (t, d)
    return best if best else (None, 0.0)


def _wire_freeze(w, pts, by_id):
    ep_a, ep_b = _wire_end_nodes(w, pts, by_id)
    return {
        'id': w.get('id'), 'label': str(w.get('label') or w.get('id')),
        'gauge': w.get('gauge', 0), 'color': w.get('color', '#888'),
        'from_node': ep_a.get('id') if ep_a else None,
        'to_node': ep_b.get('id') if ep_b else None,
        'path': [{'x': p['x'], 'y': p['y'], 'node': p.get('node')} for p in pts],
        'length': round(_poly_len(pts), 2),
    }


def _covers_freeze(design, wpaths, wires, by_id):
    out = []
    wmap = {w.get('id'): w for w in wires}
    for c in design.get('covers') or []:
        anchors = c.get('anchors') or []
        pts = []
        for a in anchors:
            ppts = wpaths.get(a.get('wire'))
            if not ppts:
                continue
            s = max(0.0, min(_poly_len(ppts), float(a.get('s') or 0.0)))
            p = _point_at_arc(ppts, s)
            pts.append({'x': p['x'], 'y': p['y']})
        if len(pts) >= 2:
            length = _poly_len(pts)
        else:
            length = 0.0
        out.append({
            'id': c.get('id'), 'name': str(c.get('name') or c.get('id')),
            'kind': c.get('kind', 'corr'),
            'anchors': [{'x': p['x'], 'y': p['y']} for p in pts],
            'length': round(length, 2),
        })
    return out


def snapshot_hash(snapshot):
    """对冻结的几何与测点做指纹（快照内容版本，含测点编排）。"""
    payload = {
        'geom': geometry_hash(snapshot),
        'items': [[i['id'], i['kind'], i['nominal'],
                   [r for r in i['axis_refs']], i['tol_neg'], i['tol_pos'],
                   i.get('required', True)]
                  for i in snapshot['items']],
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]


def current_hash(design):
    """对当前方案即时建快照取几何指纹（不落库），用于标记快照过期。"""
    return build_snapshot(design)['geom_hash']


# ---------- 读数解析 ----------

def parse_value(raw, unit):
    """解析实测长度。返回 dict(value_mm, raw, unit, error)。

    - 数字始终按“所填单位”换算一次到 mm（避免与存储值重复换算）；
    - 空单位：按 mm 参与判定，但标记 missing_unit（提示补单位）；
    - 无法识别的单位：unknown_unit，不猜测换算，读数转人工、不参与偏差判定。
    """
    s = str(raw if raw is not None else '').strip()
    try:
        v = float(s)
    except (TypeError, ValueError):
        return {'value_mm': None, 'raw': s, 'unit': str(unit or ''),
                'error': 'bad_value'}
    if not math.isfinite(v) or v < 0 or v > 1e6:
        return {'value_mm': None, 'raw': s, 'unit': str(unit or ''),
                'error': 'bad_value'}
    u_raw = str(unit or '').strip()
    u_key = u_raw.lower()
    if u_key == '':
        return {'value_mm': v, 'raw': s, 'unit': 'mm', 'error': 'missing_unit'}
    scale = UNIT_TO_MM.get(u_key)
    canon = UNIT_CANON.get(u_key, u_key)
    if scale is None:
        return {'value_mm': None, 'raw': s, 'unit': u_raw,
                'error': 'unknown_unit'}
    return {'value_mm': v * scale, 'raw': s, 'unit': canon, 'error': None}


# ---------- 分析 ----------

def analyze(snapshot, readings, dispositions=None, released=False):
    """对未撤回读数逐测点分析偏差与路线顺序。

    异常 level：error（基准缺失/超差/结论矛盾/返工待重测）、
    manual（单位缺失/单位不明/无效值/测点错序）、warn（重复测量）。
    返工后必须新增合格读数；让步/报废可结案。放行条件：必测项合格或均完成
    授权处置，且无未决返工。"""
    items = snapshot.get('items') or []
    active = [r for r in (readings or []) if not r.get('withdrawn')]
    anomalies = []

    def add(kind, key, level, msg, item=None, reading_id=None, gating=False):
        anomalies.append({'kind': kind, 'key': key, 'level': level, 'msg': msg,
                          'item': item, 'reading_id': reading_id, 'gating': gating})

    # 1) 基准缺失（快照生成时就不可测的必测项）
    for it in items:
        if it.get('required', True) and not _item_axis_ok(it):
            add('missing_ref', 'missing:%s' % it['id'], 'error',
                '基准缺失：%s（%s）缺少测量基准，无法测量' % (it['id'], it['name']),
                it['id'], gating=True)

    by_item = {}
    for r in active:
        by_item.setdefault(r.get('item'), []).append(r)

    item_states = {}
    measured_seq = []   # (seq, reading_id) 按读数时间
    for it in items:
        iid = it['id']
        rs = by_item.get(iid, [])
        st = {
            'item': iid, 'kind': it['kind'], 'name': it['name'], 'seq': it['seq'],
            'required': it.get('required', True),
            'nominal': it['nominal'], 'tol_neg': it['tol_neg'], 'tol_pos': it['tol_pos'],
            'status': 'pending', 'latest': None, 'count': len(rs),
            'dev': None, 'value_mm': None, 'unit': '',
        }
        if rs:
            latest = max(rs, key=lambda x: x.get('id') or 0)
            measured_seq.append((it['seq'], latest.get('id') or 0))
            parsed = parse_value(latest.get('value_raw', latest.get('value')),
                                 latest.get('unit'))
            st['latest'] = latest
            st['unit'] = parsed['unit']
            err = parsed['error']
            if err == 'bad_value':
                st['status'] = 'bad'
                add('bad_value', 'badvalue:%s:%s' % (iid, latest.get('id')), 'manual',
                    '无效值：%s 实测值“%s”不是有效数字' % (it['name'], parsed['raw']),
                    iid, latest.get('id'), gating=True)
            elif err == 'unknown_unit':
                st['status'] = 'bad'
                add('unknown_unit', 'unit:%s:%s' % (iid, latest.get('id')), 'manual',
                    '单位不明：%s 实测 %s 的单位“%s”无法识别（支持 mm/cm/m）'
                    % (it['name'], parsed['raw'], parsed['unit']),
                    iid, latest.get('id'), gating=True)
            else:
                v = parsed['value_mm']
                st['value_mm'] = round(v, 3)
                st['dev'] = round(v - it['nominal'], 3)
                if err == 'missing_unit':
                    add('missing_unit', 'nounit:%s:%s' % (iid, latest.get('id')), 'manual',
                        '单位缺失：%s 实测 %s 未标注单位（已按 mm 计，请补注）'
                        % (it['name'], parsed['raw']), iid, latest.get('id'))
                within = -it['tol_neg'] - 1e-9 <= (v - it['nominal']) <= it['tol_pos'] + 1e-9
                st['status'] = 'ok' if within else 'ng'
                if not within:
                    add('out_of_tol', 'ng:%s' % iid, 'error',
                        '超差：%s 理论 %.1f 实测 %.1f 偏差 %+.1f mm（公差 %+.1f/%+.1f）'
                        % (it['name'], it['nominal'], v, v - it['nominal'],
                           -it['tol_neg'], it['tol_pos']),
                        iid, latest.get('id'), gating=True)
            # 结论矛盾：同测点多次“可判定”读数跨合格/超差
            verdicts = []
            for x in rs:
                p2 = parse_value(x.get('value_raw', x.get('value')), x.get('unit'))
                if p2['error'] in (None, 'missing_unit'):
                    verdicts.append(-it['tol_neg'] - 1e-9
                                    <= (p2['value_mm'] - it['nominal']) <= it['tol_pos'] + 1e-9)
            if len(set(verdicts)) > 1:
                add('conflict', 'conflict:%s' % iid, 'error',
                    '结论矛盾：%s 共 %d 次测量，合格/超差结论不一致' % (it['name'], len(rs)),
                    iid, gating=True)
            if len(rs) > 1:
                add('duplicate', 'dup:%s' % iid, 'warn',
                    '重复测量：%s 共 %d 次读数（以最近一次为准）' % (it['name'], len(rs)), iid)
        item_states[iid] = st

    # 2) 测点错序：按读数时间，后测读数的路线序号小于之前已到达序号
    measured_seq.sort(key=lambda t: t[1])
    cursor, out_of_order = 0, set()
    for seq_v, _rid in measured_seq:
        if seq_v < cursor:
            out_of_order.add(seq_v)
        cursor = max(cursor, seq_v)
    seq_to_item = {it['seq']: it for it in items}
    for seq_v in sorted(out_of_order):
        it = seq_to_item[seq_v]
        add('out_of_order', 'order:%s' % it['id'], 'manual',
            '测点错序：%s（%s）在后续测点之后才测量，请按检验路线核对' % (it['id'], it['name']),
            it['id'])

    # 3) 处置 → 结案。处置按测点（从 akey 解析 item）作用于该测点的全部异常；
    #    返工后必须有“处置登记之后新增”的合格读数才结案，否则生成返工待重测。
    disps_by_item = {}
    for d in (dispositions or []):
        iid = _item_of_key(d.get('akey'))
        if iid:
            disps_by_item.setdefault(iid, []).append(d)

    for a in anomalies:
        iid = a.get('item')
        ds = disps_by_item.get(iid, [])
        a['resolved'] = bool(ds) and _disposition_resolves(ds[-1], a, item_states.get(iid))

    # 返工待重测（每个有返工结论但尚无后续合格读数的测点各一条）
    rework_items = set()
    for iid, ds in disps_by_item.items():
        last = ds[-1]
        if str(last.get('action')) == DISP_REWORK:
            st = item_states.get(iid)
            cutoff = last.get('meas_max_id', last.get('id', 0)) or 0
            good_after = st and st['status'] == 'ok' and st['latest'] and \
                (st['latest'].get('id') or 0) > cutoff
            if not good_after:
                rework_items.add(iid)
    for iid in sorted(rework_items, key=lambda x: item_states[x]['seq']):
        st = item_states[iid]
        a = {'kind': 'rework_pending', 'key': 'rework:%s' % iid, 'level': 'error',
             'msg': '返工待重测：%s 已登记返工，须新增合格读数后方可放行' % st['name'],
             'item': iid, 'reading_id': None, 'resolved': False, 'gating': True}
        anomalies.append(a)

    order_rank = {'error': 0, 'manual': 1, 'warn': 2}
    anomalies.sort(key=lambda a: (a['resolved'], order_rank.get(a['level'], 3),
                                  (a.get('item') or '')))

    required = [it for it in items if it.get('required', True)]
    pending = [it['id'] for it in required
               if item_states[it['id']]['status'] == 'pending']
    unresolved_gating = [a for a in anomalies
                         if not a['resolved'] and a.get('gating')]

    blocking = [{'item': iid, 'reason': '必测项未测量'} for iid in pending]
    blocking += [{'item': a.get('item'), 'reason': a['msg'], 'key': a['key']}
                 for a in unresolved_gating]

    releasable = not blocking
    next_item = _next_item(item_states, required)
    stats = {
        'items': len(items),
        'required': len(required),
        'measured': sum(1 for s in item_states.values() if s['status'] != 'pending'),
        'ok': sum(1 for s in item_states.values() if s['status'] == 'ok'),
        'ng': sum(1 for s in item_states.values() if s['status'] == 'ng'),
        'bad': sum(1 for s in item_states.values() if s['status'] == 'bad'),
        'pending': len(pending),
        'readings': len(active),
        'withdrawn': sum(1 for r in (readings or []) if r.get('withdrawn')),
        'anomalies': len(anomalies),
        'unresolved': sum(1 for a in anomalies if not a['resolved']),
        'releasable': releasable,
        'released': bool(released),
    }
    return {
        'anomalies': anomalies,
        'item_states': [item_states[it['id']] for it in items],
        'blocking': blocking,
        'next_item': next_item,
        'stats': stats,
    }


def _item_of_key(akey):
    """从异常 key 解析测点 id：ng:M003 / conflict:M003 / missing:M003 /
    badvalue:M003:5 / unit:M003:5 / order:M003 / rework:M003。"""
    if not akey:
        return None
    m = re.search(r'[MC]\d+', str(akey))
    return m.group(0) if m else None


def _disposition_resolves(disp, anomaly, st):
    """单条处置是否结案该测点的某类异常。"""
    action = str(disp.get('action'))
    kind = anomaly['kind']
    if kind == 'rework_pending':
        return False
    if action in (DISP_CONCESSION, DISP_SCRAP):
        return True
    if action == DISP_REWORK:
        # 返工：只有后续新增合格读数才算真正结案
        if st is None or st['status'] != 'ok' or not st.get('latest'):
            return False
        cutoff = disp.get('meas_max_id', disp.get('id', 0)) or 0
        return (st['latest'].get('id') or 0) > cutoff
    return False


def _item_axis_ok(it):
    """测点是否具备被测基准（两端点）。"""
    a, b = it.get('ref_a'), it.get('ref_b')
    if not a or not b:
        return False
    if it.get('kind') == COVER_EDGE:
        # 零基准边界只需吸附节点；自由边界需 axis_refs
        if it.get('nominal', 0) == 0:
            return bool((it.get('axis_refs') or []))
        return bool((it.get('axis_refs') or []))
    return True


def _next_item(item_states, required):
    for it in required:
        st = item_states[it['id']]
        if st['status'] == 'pending' and _item_axis_ok(it):
            return it['id']
    return None


# ---------- 自选测点 ----------

def custom_item(snapshot, ref_a_id, ref_b_id, name='', tol_neg=5.0, tol_pos=5.0):
    """检验员点选两个基准后补录的测点；基准可取连接器/分支/拼接/包覆边界折点。"""
    pool = _ref_pool(snapshot)
    a = next((r for r in pool if r['id'] == ref_a_id), None)
    b = next((r for r in pool if r['id'] == ref_b_id), None)
    if not a or not b:
        raise ValueError('所选基准不存在，请在钉板图上重新点选')
    if a['id'] == b['id']:
        raise ValueError('两个基准不能相同')
    nominal = _dist(a, b)
    max_seq = max([i['seq'] for i in snapshot['items']] or [0])
    return {
        'id': 'C%03d' % (max_seq + 1), 'seq': max_seq + 1, 'kind': CUSTOM,
        'name': name or '%s—%s 自选' % (a['name'], b['name']), 'note': '',
        'ref_a': {k: a[k] for k in ('id', 'name', 'type', 'x', 'y')},
        'ref_b': {k: b[k] for k in ('id', 'name', 'type', 'x', 'y')},
        'axis_refs': [a['id'], b['id']],
        'wire_id': None, 'cover_id': None,
        'nominal': round(nominal, 2),
        'tol_neg': float(tol_neg), 'tol_pos': float(tol_pos),
        'required': False,
    }


def _ref_pool(snapshot):
    pool = []
    for key in ('connectors', 'branches', 'splices'):
        for n in snapshot.get(key) or []:
            pool.append({'id': n['id'], 'name': n['name'],
                         'type': n['type'], 'x': n['x'], 'y': n['y']})
    return pool


def ref_pool(snapshot):
    return _ref_pool(snapshot)


# ---------- 处置 ----------

DISP_REWORK = 'rework'
DISP_CONCESSION = 'concession'
DISP_SCRAP = 'scrap'
DISP_ACTIONS = (DISP_REWORK, DISP_CONCESSION, DISP_SCRAP)
DISP_NAMES = {
    DISP_REWORK: '返工', DISP_CONCESSION: '让步接收', DISP_SCRAP: '报废',
}


# ---------- 同方案批次比较 ----------

def compare_rows(details):
    """把多个（同方案）批次按测点并排：理论值、各批次实测值与偏差、结论。"""
    if not details:
        return {'items': [], 'batches': []}
    base = details[0]['snapshot']
    items = base.get('items') or []
    batches = []
    grids = {}
    for d in details:
        b = d['batch']
        batches.append({'id': b['id'], 'name': b['name'], 'status': b['status']})
        st = {s['item']: s for s in d['analysis']['item_states']}
        for iid, s in st.items():
            grids.setdefault(iid, []).append(s)
    rows = []
    for it in items:
        cells = grids.get(it['id'], [])
        rows.append({
            'item': it['id'], 'seq': it['seq'], 'kind': it['kind'], 'name': it['name'],
            'nominal': it['nominal'], 'tol_neg': it['tol_neg'], 'tol_pos': it['tol_pos'],
            'cells': cells,
        })
    return {'items': rows, 'batches': batches}
