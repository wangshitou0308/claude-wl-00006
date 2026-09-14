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

# 长度单位（全部换算为 mm）
UNIT_TO_MM = {
    'mm': 1.0, '毫米': 1.0, 'm': 1000.0, '米': 1000.0,
    'cm': 10.0, '厘米': 10.0,
}
UNIT_ALIASES = {
    '': 1.0,        # 空：默认 mm（不标“单位不明”）
    'm/m': 1.0,
}

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

    # 2) 分支定位：每个分支点沿各引出支路到最近的连接器/分支/拼接
    #    取该支路导线上从分支点起算的路径长（沿真实折线，而非直线）。
    def path_from_node(wire, nid):
        pts = wpaths.get(wire.get('id')) or []
        idx = next((k for k, p in enumerate(pts) if p.get('node') == nid), None)
        if idx is None:
            return None, 0.0
        # 向两侧取到第一个“基准节点”（连接器/分支/拼接）的路径
        results = []
        for step in (-1, 1):
            k = idx
            while 0 <= k + step < len(pts):
                k += step
                p = pts[k]
                if p.get('node') and p['node'] != nid and p['node'] in by_id:
                    t = by_id[p['node']]
                    if t.get('type') in ('connector', 'branch', 'splice'):
                        lo, hi = sorted((idx, k))
                        results.append((t, _poly_len(pts[lo:hi + 1])))
                        break
        return results

    for br in sorted(branches, key=lambda n: _nat_key(n.get('name'))):
        touched = []
        for w in wires:
            ends = [w.get('from') or {}, w.get('to') or {}]
            linked = any(e.get('node') == br.get('id') for e in ends)
            pts = wpaths.get(w.get('id')) or []
            on_path = any(p.get('node') == br.get('id') for p in pts)
            if not (linked or on_path):
                continue
            targets = path_from_node(w, br.get('id'))
            for t, L in targets or []:
                key = t.get('id')
                if any(x[0] == key for x in touched) or L <= 1e-6:
                    continue
                touched.append((key, L, w.get('id')))
        # 只保留最近的两条支路，避免大量组合；至少保留几何上存在的全部短支路
        touched.sort(key=lambda x: x[1])
        for key, L, wid in touched[:4]:
            t = by_id[key]
            add(BRANCH_POS, '%s→%s 定位' % (br['name'], t['name']),
                _ref_of_node(br), _ref_of_node(t), L,
                wire=wid, note='沿支路线长')

    # 3) 支路长度：每根两端均接到基准节点的导线，测路径折线长
    for w in sorted(wires, key=lambda x: str(x.get('label') or x.get('id'))):
        pts = wpaths.get(w.get('id')) or []
        ep_a = by_id.get((w.get('from') or {}).get('node'))
        ep_b = by_id.get((w.get('to') or {}).get('node'))
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

    # 5) 尾部余量：每根接到连接器的导线，连接器本体到首个折点（第二个路径顶点）
    for w in sorted(wires, key=lambda x: str(x.get('label') or x.get('id'))):
        pts = wpaths.get(w.get('id')) or []
        for side, ep in (('from', w.get('from') or {}), ('to', w.get('to') or {})):
            n = by_id.get(ep.get('node'))
            if not n or n.get('type') != 'connector' or len(pts) < 2:
                continue
            idx = 0 if side == 'from' else len(pts) - 1
            nxt = pts[1] if side == 'from' else pts[-2]
            L = _dist(pts[idx], nxt)
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
        'wires': [_wire_freeze(w, wpaths.get(w.get('id')) or []) for w in wires
                  if wpaths.get(w.get('id'))],
        'covers': _covers_freeze(design, wpaths, wires, by_id),
        'items': items,
        'defaults': DEFAULT_TOL,
    }
    snapshot['hash'] = snapshot_hash(snapshot)
    return snapshot


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


def _wire_freeze(w, pts):
    return {
        'id': w.get('id'), 'label': str(w.get('label') or w.get('id')),
        'gauge': w.get('gauge', 0), 'color': w.get('color', '#888'),
        'from_node': (w.get('from') or {}).get('node'),
        'to_node': (w.get('to') or {}).get('node'),
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
    """对冻结的几何与测点做指纹；方案重新保存后据此判定快照是否过期。"""
    payload = {
        'connectors': [[c['id'], round(c['x'], 2), round(c['y'], 2)] for c in snapshot['connectors']],
        'branches': [[b['id'], round(b['x'], 2), round(b['y'], 2)] for b in snapshot['branches']],
        'splices': [[s['id'], round(s['x'], 2), round(s['y'], 2)] for s in snapshot['splices']],
        'wires': [[w['id'], w['from_node'], w['to_node'],
                   [[round(p['x'], 1), round(p['y'], 1)] for p in w['path']]]
                  for w in snapshot['wires']],
        'covers': [[c['id'], [[round(p['x'], 1), round(p['y'], 1)] for p in c['anchors']]]
                   for c in snapshot['covers']],
        'items': [[i['id'], i['kind'], i['nominal'],
                   [r for r in i['axis_refs']], i['tol_neg'], i['tol_pos']]
                  for i in snapshot['items']],
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]


def current_hash(design):
    """对当前方案即时建快照取指纹（不落库），用于标记快照过期。"""
    snap = build_snapshot(design)
    return snap['hash']


# ---------- 读数解析 ----------

def parse_value(raw, unit):
    """解析实测长度为 (mm 值, 单位文本, 错误)。
    空单位默认 mm；无法识别的单位返回错误（标“单位不明”）。"""
    try:
        v = float(str(raw).strip())
    except (TypeError, ValueError, AttributeError):
        return None, '', '实测值必须是数字'
    if not math.isfinite(v) or v < 0 or v > 1e6:
        return None, '', '实测值超出范围'
    u = str(unit or '').strip().lower()
    scale = UNIT_TO_MM.get(u)
    if scale is None:
        scale = UNIT_ALIASES.get(u)
    if scale is None:
        return None, str(unit or ''), '单位不明：%s' % (unit or '（空）')
    return v * scale, (u or 'mm'), None


# ---------- 分析 ----------

def analyze(snapshot, readings, dispositions=None, released=False):
    """对未撤回读数逐测点分析偏差与路线顺序，返回异常、测点状态与统计。

    异常 level：error（超差/基准缺失/结论矛盾）、manual（单位不明/测点错序/无效值）、
    warn（重复测量）。返工处置后须重新测量；让步/报废可结案。
    放行条件：必测项合格或均有授权处置（且无未决返工）。"""
    items = snapshot.get('items') or []
    item_by_id = {it['id']: it for it in items}
    active = [r for r in (readings or []) if not r.get('withdrawn')]
    anomalies = []

    def add(kind, key, level, msg, item=None, reading_id=None):
        anomalies.append({
            'kind': kind, 'key': key, 'level': level, 'msg': msg,
            'item': item, 'reading_id': reading_id,
        })

    # 1) 基准缺失：测点在快照生成时就缺少被测基准（不可测）
    for it in items:
        if it.get('required') and not _item_axis_ok(it):
            add('missing_ref', 'missing:%s' % it['id'], 'error',
                '基准缺失：%s（%s）缺少测量基准，无法测量' % (it['id'], it['name']), it['id'])

    # 2) 逐测点聚合并判定最新有效读数
    by_item = {}
    for r in active:
        by_item.setdefault(r.get('item'), []).append(r)

    item_states = {}
    order_cursor = 0          # 已按路线顺序测到的最大序号
    measured_seq = []
    for it in items:
        iid = it['id']
        rs = by_item.get(iid, [])
        state = {
            'item': iid, 'kind': it['kind'], 'name': it['name'], 'seq': it['seq'],
            'required': it.get('required', True),
            'nominal': it['nominal'], 'tol_neg': it['tol_neg'], 'tol_pos': it['tol_pos'],
            'status': 'pending',      # pending / ok / ng / bad
            'latest': None, 'count': len(rs),
            'dev': None, 'value_mm': None,
        }
        if rs:
            latest = max(rs, key=lambda x: x.get('id') or 0)
            measured_seq.append((it['seq'], latest.get('id') or 0))
            v, unit, verr = parse_value(latest.get('value'), latest.get('unit'))
            state['latest'] = latest
            state['unit'] = unit
            if verr:
                state['status'] = 'bad'
                add('bad_value', 'badvalue:%s:%s' % (iid, latest.get('id')), 'manual',
                    '%s：%s' % (it['name'], verr), iid, latest.get('id'))
            else:
                dev = v - it['nominal']
                state['value_mm'] = round(v, 3)
                state['dev'] = round(dev, 3)
                if -it['tol_neg'] - 1e-9 <= dev <= it['tol_pos'] + 1e-9:
                    state['status'] = 'ok'
                else:
                    state['status'] = 'ng'
                    add('out_of_tol', 'ng:%s' % iid, 'error',
                        '超差：%s 理论 %.1f 实测 %.1f 偏差 %+.1f mm（公差 %+.1f/%+.1f）'
                        % (it['name'], it['nominal'], v, dev, -it['tol_neg'], it['tol_pos']),
                        iid, latest.get('id'))
            # 结论矛盾：同测点多次有效读数跨“合格/超差”结论
            valid = []
            for x in rs:
                vv, _, e2 = parse_value(x.get('value'), x.get('unit'))
                if e2 is None:
                    ok = -it['tol_neg'] - 1e-9 <= (vv - it['nominal']) <= it['tol_pos'] + 1e-9
                    valid.append(ok)
            if len(set(valid)) > 1:
                add('conflict', 'conflict:%s' % iid, 'error',
                    '结论矛盾：%s 共 %d 次测量，合格/超差结论不一致' % (it['name'], len(rs)), iid)
            if len(rs) > 1:
                add('duplicate', 'dup:%s' % iid, 'warn',
                    '重复测量：%s 共 %d 次读数（以最近一次为准）' % (it['name'], len(rs)), iid)
        item_states[iid] = state

    # 3) 测点错序：后测的读数序号小于之前已测到的序号（跳回测）
    measured_seq.sort(key=lambda t: t[1])
    cursor = 0
    out_of_order = set()
    for seq_v, _rid in measured_seq:
        if seq_v < cursor:
            out_of_order.add(seq_v)
        cursor = max(cursor, seq_v)
    for seq_v in sorted(out_of_order):
        it = next(i for i in items if i['seq'] == seq_v)
        add('out_of_order', 'order:%s' % it['id'], 'manual',
            '测点错序：%s（%s）在后续测点之后才测量，请按检验路线补测/核对' % (it['id'], it['name']),
            it['id'])

    # 4) 处置结论 → 异常结案；返工未重测合格时仍阻塞放行
    disp_list = list(dispositions or [])
    disp_by_key = {}
    for d in disp_list:
        disp_by_key.setdefault(d.get('akey'), []).append(d)

    rework_open = set()   # 返工后尚未重测合格的测点
    for it in items:
        rs = by_item.get(it['id'], [])
        latest = max(rs, key=lambda x: x.get('id') or 0) if rs else None
        latest_id = latest.get('id') if latest else 0
        ngs = [d for d in disp_by_key.get('ng:%s' % it['id'], [])]
        if ngs:
            last = ngs[-1]
            if str(last.get('action')) == 'rework':
                # 返工后需要一条晚于处置时间/ID 的合格读数
                rework_ids = [x.get('id') or 0 for x in rs]
                good_after = any(
                    (x.get('id') or 0) > (last.get('id') or 0) and
                    item_states[it['id']].get('status') == 'ok'
                    for x in rs)
                if not good_after:
                    rework_open.add(it['id'])
                    add('rework_pending', 'rework:%s' % it['id'], 'error',
                        '返工待重测：%s 已登记返工，须重新测量合格后方可放行' % it['name'], it['id'])

    def is_resolved(a):
        ds = disp_by_key.get(a['key'], [])
        if not ds:
            return False
        if a['kind'] == 'rework_pending':
            return False
        # 返工结论在“返工待重测”消失前不算结案
        if a['kind'] == 'out_of_tol':
            last = ds[-1]
            if str(last.get('action')) == 'rework' and a['item'] in rework_open:
                return False
        return True

    for a in anomalies:
        a['resolved'] = is_resolved(a)

    order_rank = {'error': 0, 'manual': 1, 'warn': 2}
    anomalies.sort(key=lambda a: (a['resolved'], order_rank.get(a['level'], 3),
                                  (a.get('item') or '')))

    required = [it for it in items if it.get('required', True)]
    pending = [it['id'] for it in required if item_states[it['id']]['status'] == 'pending']
    ng_items = [s['item'] for s in item_states.values()
                if s['required'] and s['status'] in ('ng', 'bad')]
    unresolved = [a for a in anomalies if not a['resolved']]

    # 放行阻塞项
    blocking = []
    for iid in pending:
        blocking.append({'item': iid, 'reason': '必测项未测量'})
    for a in unresolved:
        if a['level'] == 'error':
            blocking.append({'item': a.get('item'), 'reason': a['msg'], 'key': a['key']})

    releasable = not blocking and not rework_open
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
        'unresolved': len(unresolved),
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
