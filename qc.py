# qc.py — 电气检验批次：方案快照构建与读数分析（纯函数，无 I/O）
"""从已保存的钉板方案取得连接器、端子与接线网络快照，对检验读数做拓扑分析：
自动判定开路、跨网短接、错接与重复测量；端点无效、单位缺失、结论矛盾
交人工处理（不改放样方案）。供 server.py 调用，并由 test_qc.py 单元测试。"""
import re

CONTINUITY = 'continuity'   # 导通
OPEN = 'open'               # 开路（不导通）

KNOWN_UNITS = {'mΩ', 'Ω', 'kΩ', 'MΩ'}
UNIT_ALIASES = {
    'ω': 'Ω', 'ohm': 'Ω', 'ohms': 'Ω', 'r': 'Ω',
    'mω': 'mΩ', 'mohm': 'mΩ', 'mr': 'mΩ',
    'kω': 'kΩ', 'kohm': 'kΩ', 'kr': 'kΩ',
    'meg': 'MΩ',
}

EP_RE = re.compile(r'^\s*([A-Za-z0-9_一-龥-]+)\.(\d+)\s*$')


def parse_endpoint(s):
    """'J1.3' → ('J1', 3)；无法解析返回 None。"""
    m = EP_RE.match(str(s or ''))
    if not m:
        return None
    return (m.group(1), int(m.group(2)))


def norm_endpoint(s):
    p = parse_endpoint(s)
    return '%s.%d' % p if p else None


def pair_key(a, b):
    """无序端点对标识。"""
    return '|'.join(sorted((a, b)))


def norm_unit(u):
    """单位规范化；缺失或无法识别返回 None。"""
    if u is None:
        return None
    s = str(u).strip()
    if not s:
        return None
    if s in KNOWN_UNITS:
        return s
    return UNIT_ALIASES.get(s.lower())


def _nat_key(conn):
    # 自然排序：J2 < J10；拆成 (类型, 值) 元组避免 str/int 混比
    return [(0, int(p)) if p.isdigit() else (1, p) for p in re.split(r'(\d+)', conn)]


def sort_endpoints(eps):
    def key(ep):
        p = parse_endpoint(ep)
        return (_nat_key(p[0]), p[1]) if p else ([(1, ep)], 0)
    return sorted(eps, key=key)


class _UF:
    """并查集：网络连通分量。"""

    def __init__(self):
        self.p = {}

    def find(self, x):
        p = self.p
        if x not in p:
            p[x] = x
        root = x
        while p[root] != root:
            root = p[root]
        while p[x] != root:
            p[x], x = root, p[x]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb

    def connected(self, a, b):
        return self.find(a) == self.find(b)


# ---------- 快照 ----------

def build_snapshot(design, design_id=None, design_name=None):
    """从钉板方案构建检验快照：连接器、端子（针位）与接线网络。

    导线两端可落在连接器端子或拼接件孔位；同一拼接件的所有孔位内部导通，
    因此沿“导线 + 拼接件”用并查集追踪多分支网络，保留拼接拓扑（splices）。"""
    nodes = design.get('nodes') or []
    wires = design.get('wires') or []
    conns = [n for n in nodes if n.get('type') == 'connector']
    names = [str(c.get('name') or '') for c in conns]
    dups = sorted({n for n in names if n and names.count(n) > 1})
    if dups:
        raise ValueError('连接器名称重复：' + '、'.join(dups))
    if not conns:
        raise ValueError('方案中没有连接器')
    connectors = [{
        'name': str(c.get('name')),
        'pins': max(1, int(c.get('pins') or 4)),
        'x': c.get('x', 0), 'y': c.get('y', 0),
    } for c in conns]
    by_id = {n.get('id'): n for n in nodes}

    # 拼接件拓扑：每个孔位 → 连接器端子（经一根导线）
    splices = []
    splice_port_term = {}   # (splice_id, pin) -> 连接器端子
    splice_wire = {}        # wire_id -> splice_id
    for sp in nodes:
        if sp.get('type') != 'splice':
            continue
        ports = max(2, int(sp.get('ports') or 4))
        splices.append({
            'id': sp.get('id'), 'name': str(sp.get('name')),
            'kind': str(sp.get('kind') or 'cap'), 'ports': ports,
            'gauge_min': sp.get('gaugeMin', 0.5), 'gauge_max': sp.get('gaugeMax', 5),
            'strip': sp.get('strip', 7),
            'sleeve_d': sp.get('sleeveD', 0), 'sleeve_len': sp.get('sleeveLen', 0),
        })

    uf = _UF()
    links = []  # (端点A, 端点B, 线号)
    wire_terms = {}  # wire_id -> [from_term or None, to_term or None]
    for w in wires:
        eps = []
        for side in ('from', 'to'):
            ep = w.get(side) or {}
            node = by_id.get(ep.get('node'))
            pin = ep.get('pin')
            if node and node.get('type') == 'connector' and isinstance(pin, int) and pin >= 1:
                eps.append('%s.%d' % (node.get('name'), pin))
            else:
                eps.append(None)
        wire_terms[w.get('id')] = eps
        a, b = eps
        if a and b and a != b:
            uf.union(a, b)
            links.append((a, b, str(w.get('label') or '')))

    # 拼接件：把同件各孔所连导线的对侧连接器端子全部并起来
    for sp in splices:
        sid = sp['id']
        terms = set()
        for w in wires:
            for i, side in enumerate(('from', 'to')):
                ep = w.get(side) or {}
                if ep.get('node') != sid:
                    continue
                pin = ep.get('pin')
                opp = wire_terms.get(w.get('id'))
                if opp:
                    t = opp[1 - i]  # 对侧连接器端子
                    if t:
                        terms.add(t)
                        splice_port_term[(sid, pin)] = t
                        splice_wire[w.get('id')] = sid
        terms = list(terms)
        for t in terms[1:]:
            uf.union(terms[0], t)

    if not links and not splice_port_term:
        raise ValueError('方案中没有已连接的导线')

    groups = {}
    labels = {}
    all_terms = set()
    for a, b, lb in links:
        all_terms.update((a, b))
    all_terms.update(splice_port_term.values())
    for t in all_terms:
        root = uf.find(t)
        groups.setdefault(root, set()).add(t)
    for a, b, lb in links:
        root = uf.find(a)
        if lb:
            lst = labels.setdefault(root, [])
            if lb not in lst:
                lst.append(lb)
    nets = []
    for i, root in enumerate(sorted(groups, key=lambda r: sort_endpoints(groups[r])[0])):
        members = sort_endpoints(groups[root])
        via = sorted({sid for (sid, _pin), t in splice_port_term.items() if t in groups[root]})
        nets.append({
            'id': 'NET%d' % (i + 1),
            'label': '/'.join(labels.get(root, [])) or ('网络%d' % (i + 1)),
            'endpoints': members,
            'splices': [next((s['name'] for s in splices if s['id'] == sid), sid) for sid in via],
        })
    terminals = []
    for c in connectors:
        for p in range(1, c['pins'] + 1):
            terminals.append('%s.%d' % (c['name'], p))
    return {
        'design_id': design_id,
        'design_name': design_name or '',
        'connectors': connectors,
        'terminals': terminals,
        'splices': splices,
        'nets': nets,
    }


# ---------- 分析 ----------

def analyze(snapshot, readings, dispositions=None):
    """对未撤回读数做拓扑分析，返回异常、网络覆盖与推荐测点。

    异常 level：error（开路/短接/错接）、manual（端点无效/单位缺失/结论矛盾）、
    warn（重复测量/网络未覆盖）。所有异常均需处置结论后方可归档。"""
    terminals = set(snapshot.get('terminals') or [])
    nets = snapshot.get('nets') or []
    net_of = {}
    for n in nets:
        for ep in n['endpoints']:
            net_of[ep] = n['id']
    net_by_id = {n['id']: n for n in nets}
    active = [r for r in (readings or []) if not r.get('withdrawn')]
    anomalies = []

    def add(kind, key, level, msg, eps=None, reading_id=None, net=None):
        anomalies.append({
            'kind': kind, 'key': key, 'level': level, 'msg': msg,
            'endpoints': eps or [], 'reading_id': reading_id, 'net': net,
        })

    # 1) 端点有效性、单位检查（问题读数仍按结论参与拓扑，除非端点无效）
    clean = []
    for r in active:
        rid = r.get('id')
        a, b = str(r.get('a') or '').strip(), str(r.get('b') or '').strip()
        if a == b:
            add('invalid_endpoint', 'invalid:%s' % rid, 'manual',
                '端点无效：#%s 两个端点相同（%s）' % (rid, a), [a, b], rid)
            continue
        bad = [ep for ep in (a, b) if ep not in terminals]
        if bad:
            add('invalid_endpoint', 'invalid:%s' % rid, 'manual',
                '端点无效：#%s %s—%s，%s 不在方案快照中' % (rid, a, b, '、'.join(bad)), [a, b], rid)
            continue
        if r.get('ohms') is not None and not norm_unit(r.get('unit')):
            add('missing_unit', 'unit:%s' % rid, 'manual',
                '单位缺失：#%s %s—%s 阻值 %s 未标注有效单位' % (rid, a, b, r.get('ohms')), [a, b], rid)
        clean.append(r)

    # 2) 同一对端点的多次测量：结论矛盾交人工；结论一致记重复测量
    groups = {}
    for r in clean:
        groups.setdefault(pair_key(r['a'], r['b']), []).append(r)
    usable = []  # (a, b, result, reading)
    for key, rs in groups.items():
        a, b = key.split('|')
        if len(rs) > 1:
            if len({x.get('result') for x in rs}) > 1:
                add('conflict', 'conflict:' + key, 'manual',
                    '结论矛盾：%s—%s 共 %d 次测量，导通/开路结论不一致' % (a, b, len(rs)), [a, b])
                continue  # 矛盾对不参与拓扑
            add('duplicate', 'dup:' + key, 'warn',
                '重复测量：%s—%s 结论一致，共 %d 次' % (a, b, len(rs)), [a, b])
        latest = max(rs, key=lambda x: x.get('id') or 0)
        usable.append((latest['a'], latest['b'], latest.get('result'), latest))

    # 3) 拓扑：导通并查集
    uf = _UF()
    for t in terminals:
        uf.find(t)
    for a, b, res, _r in usable:
        if res == CONTINUITY:
            uf.union(a, b)

    def home_ok(ep):
        """该端子是否经实测导通接回本网其他成员。"""
        nid = net_of.get(ep)
        if not nid:
            return False
        return any(uf.connected(ep, x) for x in net_by_id[nid]['endpoints'] if x != ep)

    for a, b, res, r in usable:
        na, nb = net_of.get(a), net_of.get(b)
        if res == OPEN and na and na == nb:
            add('open', 'open:' + pair_key(a, b), 'error',
                '开路：%s—%s 属同一网络 %s（%s）但实测开路'
                % (a, b, na, net_by_id[na]['label']), [a, b], r.get('id'), na)
        if res == CONTINUITY and na != nb:
            la = net_by_id[na]['label'] if na else '未使用端子'
            lb = net_by_id[nb]['label'] if nb else '未使用端子'
            if na and nb and not (home_ok(a) and home_ok(b)):
                who = []
                if not home_ok(a):
                    who.append('%s 未接入本网 %s' % (a, na))
                if not home_ok(b):
                    who.append('%s 未接入本网 %s' % (b, nb))
                add('miswire', 'miswire:' + pair_key(a, b), 'error',
                    '错接：%s，却与异网导通（%s—%s，%s / %s）'
                    % ('；'.join(who), a, b, la, lb), [a, b], r.get('id'))
            else:
                add('short', 'short:' + pair_key(a, b), 'error',
                    '跨网短接：%s（%s）与 %s（%s）实测导通' % (a, la, b, lb), [a, b], r.get('id'))

    # 4) 网络覆盖（仅本网内部的导通测量）与推荐测点
    cont_pairs = [(a, b) for a, b, res, _r in usable if res == CONTINUITY]
    coverage = []
    recs = []
    for n in nets:
        eps = n['endpoints']
        local = _UF()
        for ep in eps:
            local.find(ep)
        measured = 0
        for a, b in cont_pairs:
            if net_of.get(a) == n['id'] and net_of.get(b) == n['id']:
                if not local.connected(a, b):
                    measured += 1
                local.union(a, b)
        comps = {}
        for ep in eps:
            comps.setdefault(local.find(ep), []).append(ep)
        covered = len(comps) == 1
        invalid = [ep for ep in eps if ep not in terminals]
        coverage.append({
            'net': n['id'], 'label': n['label'], 'endpoints': eps,
            'covered': covered, 'measured': measured,
            'needed': max(0, len(eps) - 1), 'invalid': invalid,
        })
        if not covered:
            hint = '；含快照外端子 %s' % '、'.join(invalid) if invalid else ''
            add('uncovered', 'uncovered:' + n['id'], 'warn',
                '网络未覆盖：%s（%s）%s 尚未完成导通验证%s'
                % (n['id'], n['label'], '、'.join(eps), hint), list(eps), None, n['id'])
            if not invalid:
                gs = sorted(comps.values(), key=lambda g: sort_endpoints(g)[0])
                recs.append({
                    'net': n['id'], 'label': n['label'],
                    'a': sort_endpoints(gs[0])[0], 'b': sort_endpoints(gs[1])[0],
                    'remaining': len(comps) - 1,
                })

    # 5) 处置结论 → 异常结案标记
    disposed = {d.get('akey') for d in (dispositions or [])}
    for a in anomalies:
        a['resolved'] = a['key'] in disposed
    order = {'error': 0, 'manual': 1, 'warn': 2}
    anomalies.sort(key=lambda a: (a['resolved'], order.get(a['level'], 3), a['key']))
    stats = {
        'readings': len(active),
        'withdrawn': sum(1 for r in (readings or []) if r.get('withdrawn')),
        'nets': len(nets),
        'covered': sum(1 for c in coverage if c['covered']),
        'anomalies': len(anomalies),
        'unresolved': sum(1 for a in anomalies if not a['resolved']),
    }
    return {'anomalies': anomalies, 'coverage': coverage, 'recommendations': recs, 'stats': stats}


# ---------- CSV 导入预览 ----------

def preview_rows(snapshot, readings, rows):
    """逐行检查：端点匹配、与既有读数及文件内部互相冲突的记录。
    无法解析的行 ok=False（不导入）；其余问题行仍可导入并转人工处理。"""
    terminals = set(snapshot.get('terminals') or [])
    existing = {}
    for r in readings or []:
        if r.get('withdrawn'):
            continue
        a, b = str(r.get('a') or ''), str(r.get('b') or '')
        if a and b:
            existing.setdefault(pair_key(a, b), set()).add(r.get('result'))
    seen = {}
    out = []
    for i, row in enumerate(rows or []):
        a = str(row.get('a') or '').strip()
        b = str(row.get('b') or '').strip()
        res = row.get('result')
        item = {
            'line': i + 1, 'a': a, 'b': b, 'result': res,
            'ohms': row.get('ohms'), 'unit': norm_unit(row.get('unit')) or '',
            'polarity': row.get('polarity') or 'none',
            'ok': True, 'problems': [],
        }
        if res not in (CONTINUITY, OPEN):
            item['ok'] = False
            item['problems'].append('结果无法识别（应为导通/开路）')
        if not norm_endpoint(a) or not norm_endpoint(b):
            item['ok'] = False
            item['problems'].append('端点格式无法解析（应为 J1.3 形式）')
        elif a == b:
            item['ok'] = False
            item['problems'].append('两个端点相同')
        else:
            unknown = [ep for ep in (a, b) if ep not in terminals]
            if unknown:
                item['problems'].append('端点无效：' + '、'.join(unknown) + '（导入后交人工处理）')
            key = pair_key(a, b)
            if key in existing:
                if res and res not in existing[key]:
                    item['problems'].append('与既有读数结论冲突')
                else:
                    item['problems'].append('与既有读数重复')
            if key in seen:
                first, first_res = seen[key]
                item['problems'].append('与文件第 %d 行%s' % (first, '结论冲突' if res != first_res else '重复'))
            else:
                seen[key] = (i + 1, res)
            if item['ohms'] is not None and not item['unit']:
                item['problems'].append('单位缺失（导入后交人工处理）')
        out.append(item)
    return out
