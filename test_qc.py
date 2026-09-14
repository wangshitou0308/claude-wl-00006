#!/usr/bin/env python3
# test_qc.py — 电气检验批次：qc.py 纯逻辑与批次接口测试
import json
import os
import tempfile
import threading
from http.client import HTTPConnection

os.environ['HARNESS_DB'] = os.path.join(tempfile.mkdtemp(prefix='qcdb'), 'test.db')

import qc
import server

passed = failed = 0


def ok(cond, name):
    global passed, failed
    if cond:
        passed += 1
        print('  ✓', name)
    else:
        failed += 1
        print('  ✗', name)


def sample_design():
    return {
        'version': 1, 'name': '检验测试线束',
        'board': {'width': 900, 'height': 600, 'grid': 10},
        'settings': {},
        'nodes': [
            {'id': 'nJ1', 'type': 'connector', 'x': 80, 'y': 300, 'name': 'J1', 'pins': 6},
            {'id': 'nJ2', 'type': 'connector', 'x': 780, 'y': 140, 'name': 'J2', 'pins': 4},
            {'id': 'nJ3', 'type': 'connector', 'x': 780, 'y': 460, 'name': 'J3', 'pins': 4},
        ],
        'zones': [],
        'wires': [
            {'id': 'w1', 'label': 'W-101', 'from': {'node': 'nJ1', 'pin': 1}, 'to': {'node': 'nJ2', 'pin': 1}},
            {'id': 'w2', 'label': 'W-102', 'from': {'node': 'nJ1', 'pin': 2}, 'to': {'node': 'nJ2', 'pin': 2}},
            {'id': 'w3', 'label': 'W-103', 'from': {'node': 'nJ1', 'pin': 3}, 'to': {'node': 'nJ3', 'pin': 1}},
            {'id': 'w4', 'label': 'W-104', 'from': {'node': 'nJ2', 'pin': 3}, 'to': {'node': 'nJ3', 'pin': 2}},
            {'id': 'w5', 'label': 'W-105', 'from': {'node': 'nJ1', 'pin': 4}, 'to': {'node': 'nJ2', 'pin': 4}},
            {'id': 'w6', 'label': 'W-106', 'from': {'node': 'nJ2', 'pin': 4}, 'to': {'node': 'nJ3', 'pin': 3}},
        ],
        'nets': [],
    }


_id = [0]


def R(a, b, result, **kw):
    _id[0] += 1
    return {'id': _id[0], 'a': a, 'b': b, 'result': result,
            'ohms': kw.get('ohms'), 'unit': kw.get('unit', ''),
            'polarity': kw.get('polarity', 'none'), 'withdrawn': kw.get('withdrawn', False)}


print('== 快照 ==')
snap = qc.build_snapshot(sample_design(), design_id=1, design_name='t')
ok(len(snap['connectors']) == 3, '快照 3 个连接器')
ok(len(snap['terminals']) == 14, '快照 14 个端子')
ok(len(snap['nets']) == 5, '快照 5 个网络（J2.4 跨接汇成三端点网络）')
three = next(n for n in snap['nets'] if len(n['endpoints']) == 3)
ok(three['endpoints'] == ['J1.4', 'J2.4', 'J3.3'], '三端点网络端点正确')
net11 = next(n['id'] for n in snap['nets'] if 'J1.1' in n['endpoints'])

bad = sample_design()
bad['nodes'].append({'id': 'nJ1b', 'type': 'connector', 'x': 0, 'y': 0, 'name': 'J1', 'pins': 2})
try:
    qc.build_snapshot(bad)
    ok(False, '重名连接器应拒绝')
except ValueError:
    ok(True, '重名连接器被拒绝')

print('== 覆盖与推荐 ==')
an = qc.analyze(snap, [])
ok(an['stats']['nets'] == 5 and an['stats']['covered'] == 0, '初始覆盖 0/5')
ok(len([a for a in an['anomalies'] if a['kind'] == 'uncovered']) == 5, '5 个网络未覆盖')
ok(len(an['recommendations']) == 5, '5 组推荐测点')
rec3 = next(r for r in an['recommendations'] if r['net'] == three['id'])
ok((rec3['a'], rec3['b']) == ('J1.4', 'J2.4'), '三端点网络首对推荐 J1.4—J2.4')

full = [R('J1.1', 'J2.1', 'continuity', ohms=0.1, unit='Ω'),
        R('J1.2', 'J2.2', 'continuity'),
        R('J1.3', 'J3.1', 'continuity'),
        R('J2.3', 'J3.2', 'continuity'),
        R('J1.4', 'J2.4', 'continuity'),
        R('J2.4', 'J3.3', 'continuity')]
an = qc.analyze(snap, full)
ok(an['stats']['covered'] == 5 and not an['anomalies'], '全部导通则覆盖且无异常')

an = qc.analyze(snap, [R('J1.4', 'J2.4', 'continuity')])
rec = next(r for r in an['recommendations'] if r['net'] == three['id'])
ok((rec['a'], rec['b']) == ('J1.4', 'J3.3'), '部分覆盖后推荐桥接剩余分量')

print('== 拓扑异常 ==')
an = qc.analyze(snap, [R('J1.1', 'J2.1', 'open')])
ok(any(a['kind'] == 'open' for a in an['anomalies']), '检出开路')

an = qc.analyze(snap, [R('J1.1', 'J2.1', 'continuity'),
                       R('J1.2', 'J2.2', 'continuity'),
                       R('J1.1', 'J1.2', 'continuity', ohms=0.02, unit='Ω')])
kinds = {a['kind'] for a in an['anomalies']}
ok('short' in kinds and 'miswire' not in kinds, '检出跨网短接（两端仍接本网，非错接）')

an = qc.analyze(snap, [R('J1.1', 'J2.1', 'open'), R('J1.1', 'J2.2', 'continuity')])
kinds = {a['kind'] for a in an['anomalies']}
ok('miswire' in kinds, '检出错接（本网开路却与异网导通）')

an = qc.analyze(snap, [R('J1.1', 'J2.1', 'continuity'), R('J1.1', 'J2.1', 'continuity')])
ok(any(a['kind'] == 'duplicate' for a in an['anomalies']), '检出重复测量')

an = qc.analyze(snap, [R('J1.1', 'J2.1', 'continuity'), R('J1.1', 'J2.1', 'open')])
kinds = {a['kind'] for a in an['anomalies']}
ok('conflict' in kinds, '结论矛盾交人工')
ok(any(a['kind'] == 'uncovered' and a['net'] == net11 for a in an['anomalies']), '矛盾对不计入覆盖')

print('== 人工处理项 ==')
an = qc.analyze(snap, [R('J9.9', 'J2.1', 'continuity')])
ok(any(a['kind'] == 'invalid_endpoint' for a in an['anomalies']), '端点无效交人工')
an = qc.analyze(snap, [R('J1.1', 'J2.1', 'continuity', ohms=0.5, unit='')])
ok(any(a['kind'] == 'missing_unit' for a in an['anomalies']), '阻值缺单位交人工')
an = qc.analyze(snap, [R('J1.1', 'J2.1', 'continuity', ohms=0.5, unit='ohm')])
ok(not any(a['kind'] == 'missing_unit' for a in an['anomalies']), '单位别名 ohm→Ω 可识别')
an = qc.analyze(snap, [R('J1.1', 'J2.1', 'continuity', ohms=0.5, unit='英尺')])
ok(any(a['kind'] == 'missing_unit' for a in an['anomalies']), '无法识别的单位交人工')

print('== 处置与撤回 ==')
an = qc.analyze(snap, [R('J1.1', 'J2.1', 'open')], [{'akey': 'open:J1.1|J2.1'}])
open_a = next(a for a in an['anomalies'] if a['kind'] == 'open')
ok(open_a['resolved'], '处置后异常标记已结论')
ok(an['stats']['unresolved'] == len(an['anomalies']) - 1, '未决计数正确')
an = qc.analyze(snap, [R('J1.1', 'J2.1', 'open', withdrawn=True)])
ok(not any(a['kind'] == 'open' for a in an['anomalies']), '已撤回读数不参与分析')

print('== CSV 预览 ==')
existing = [R('J1.1', 'J2.1', 'continuity')]
rows = [
    {'a': 'J1.1', 'b': 'J2.1', 'result': 'open', 'ohms': None, 'unit': ''},
    {'a': 'J1.1', 'b': 'J2.1', 'result': 'continuity', 'ohms': None, 'unit': ''},
    {'a': 'J9.9', 'b': 'J2.1', 'result': 'continuity', 'ohms': None, 'unit': ''},
    {'a': 'J1.3', 'b': 'J3.1', 'result': 'continuity', 'ohms': None, 'unit': ''},
    {'a': 'J1.3', 'b': 'J3.1', 'result': 'open', 'ohms': None, 'unit': ''},
    {'a': 'bad', 'b': '', 'result': '', 'ohms': None, 'unit': ''},
]
pv = qc.preview_rows(snap, existing, rows)
ok('与既有读数结论冲突' in pv[0]['problems'], '预览：与既有读数冲突')
ok('与既有读数重复' in pv[1]['problems'], '预览：与既有读数重复')
ok(any('端点无效' in p for p in pv[2]['problems']), '预览：端点无效')
ok(any('文件' in p and '冲突' in p for p in pv[4]['problems']), '预览：文件内互相冲突')
ok(not pv[5]['ok'], '预览：无法解析行不可导入')
ok(pv[3]['ok'] and not pv[3]['problems'], '预览：正常行通过')

print('== 拼接件多分支网络 ==')


def splice_design():
    return {
        'version': 2, 'name': '拼接测试线束',
        'board': {'width': 900, 'height': 600, 'grid': 10},
        'settings': {},
        'nodes': [
            {'id': 'nJ1', 'type': 'connector', 'x': 80, 'y': 300, 'name': 'J1', 'pins': 4},
            {'id': 'nJ2', 'type': 'connector', 'x': 700, 'y': 140, 'name': 'J2', 'pins': 4},
            {'id': 'nJ3', 'type': 'connector', 'x': 700, 'y': 460, 'name': 'J3', 'pins': 4},
            {'id': 'nS1', 'type': 'splice', 'x': 400, 'y': 300, 'name': 'S1',
             'kind': 'cap', 'ports': 4, 'gaugeMin': 0.5, 'gaugeMax': 2.4,
             'strip': 7, 'sleeveD': 4, 'sleeveLen': 15},
        ],
        'zones': [],
        'wires': [
            {'id': 'w1', 'label': 'W-101', 'from': {'node': 'nJ1', 'pin': 1}, 'to': {'node': 'nS1', 'pin': 1}},
            {'id': 'w2', 'label': 'W-102', 'from': {'node': 'nS1', 'pin': 2}, 'to': {'node': 'nJ2', 'pin': 1}},
            {'id': 'w3', 'label': 'W-103', 'from': {'node': 'nJ3', 'pin': 1}, 'to': {'node': 'nS1', 'pin': 3}},
            {'id': 'w4', 'label': 'W-104', 'from': {'node': 'nJ1', 'pin': 2}, 'to': {'node': 'nJ2', 'pin': 2}},
        ],
        'nets': [],
    }


ssnap = qc.build_snapshot(splice_design(), design_id=2, design_name='sp')
ok(len(ssnap['splices']) == 1 and ssnap['splices'][0]['name'] == 'S1', '快照保留拼接件拓扑')
ok(ssnap['splices'][0]['ports'] == 4 and ssnap['splices'][0]['strip'] == 7, '快照保留孔位容量与剥线长度')
snet = next((n for n in ssnap['nets'] if len(n['endpoints']) == 3), None)
ok(bool(snet), '拼接件追踪出三端网络')
ok(snet and snet['endpoints'] == ['J1.1', 'J2.1', 'J3.1'], '三端网络端子正确：%s' % (snet and snet['endpoints']))
ok(snet and snet['splices'] == ['S1'], '网络标注经由拼接件 S1')
ok(len(ssnap['nets']) == 2, '共 2 个网络（三端 + 双端）')

# 三端网络只需测 2 对即可全覆盖
an = qc.analyze(ssnap, [R('J1.1', 'J2.1', 'continuity'), R('J2.1', 'J3.1', 'open')])
kinds = {a['kind'] for a in an['anomalies']}
ok('open' in kinds, '拼接网络检出开路（同网实测开路）')
an = qc.analyze(ssnap, [R('J1.1', 'J2.1', 'continuity', ohms=0.1, unit='Ω'),
                        R('J1.1', 'J3.1', 'continuity', ohms=0.1, unit='Ω'),
                        R('J1.2', 'J2.2', 'continuity', ohms=0.1, unit='Ω')])
ok(an['stats']['covered'] == 2 and not an['anomalies'], '拼接网络 2 对导通全覆盖')

# 对接拼接：两段导线连通
butt = splice_design()
butt['nodes'][3]['kind'] = 'butt'
butt['nodes'][3]['ports'] = 3
bsnap = qc.build_snapshot(butt)
ok(bsnap['splices'][0]['kind'] == 'butt', '对接拼接类型保留')

print('== 多级拼接链：网络名与孔位映射 ==')


def chain_design():
    return {
        'version': 2, 'name': 'BRANCH',
        'board': {'width': 900, 'height': 600, 'grid': 10}, 'settings': {},
        'nodes': [
            {'id': 'j1', 'type': 'connector', 'x': 0, 'y': 0, 'name': 'J1', 'pins': 2},
            {'id': 'j2', 'type': 'connector', 'x': 300, 'y': 0, 'name': 'J2', 'pins': 2},
            {'id': 'j3', 'type': 'connector', 'x': 300, 'y': 200, 'name': 'J3', 'pins': 2},
            {'id': 's1', 'type': 'splice', 'x': 100, 'y': 100, 'name': 'S1',
             'kind': 'butt', 'ports': 3, 'gaugeMin': 0.5, 'gaugeMax': 3,
             'strip': 7, 'sleeveD': 4, 'sleeveLen': 20},
            {'id': 's2', 'type': 'splice', 'x': 200, 'y': 100, 'name': 'S2',
             'kind': 'cap', 'ports': 3, 'gaugeMin': 0.5, 'gaugeMax': 3,
             'strip': 7, 'sleeveD': 0, 'sleeveLen': 0},
        ],
        'zones': [],
        'wires': [
            {'id': 'w1', 'label': 'W1', 'from': {'node': 'j1', 'pin': 1}, 'to': {'node': 's1', 'pin': 1}},
            {'id': 'w2', 'label': 'W2', 'from': {'node': 's1', 'pin': 2}, 'to': {'node': 's2', 'pin': 1}},
            {'id': 'w3', 'label': 'W3', 'from': {'node': 's2', 'pin': 2}, 'to': {'node': 'j2', 'pin': 1}},
            {'id': 'w4', 'label': 'W4', 'from': {'node': 'j3', 'pin': 1}, 'to': {'node': 's2', 'pin': 3}},
        ],
        'nets': [{'name': 'BRANCH', 'endpoints': ['J1.1', 'J2.1', 'J3.1']}],
    }


csnap = qc.build_snapshot(chain_design())
ok(len(csnap['nets']) == 1, '两级拼接链只生成 1 个网络（实际 %d）' % len(csnap['nets']))
cnet = csnap['nets'][0]
ok(cnet['endpoints'] == ['J1.1', 'J2.1', 'J3.1'], '链式三端网络端子正确：%s' % cnet['endpoints'])
ok(cnet['label'] == 'BRANCH', '保留原网络名 BRANCH（实际 %s）' % cnet['label'])
ok(cnet['splices'] == ['S1', 'S2'], '网络标注经由 S1、S2：%s' % cnet['splices'])
# 孔位映射 S1#1→J1.1/W1, S1#2→拼接链/W2；S2 三孔
s1 = next(s for s in csnap['splices'] if s['name'] == 'S1')
s2 = next(s for s in csnap['splices'] if s['name'] == 'S2')
m1 = {(w['port'], w['wire']): w['terminal'] for w in s1['wiring']}
ok(m1.get((1, 'W1')) == 'J1.1' and m1.get((2, 'W2')) == '', 'S1 孔位映射 S1#1→J1.1、S1#2→拼接链')
ports2 = sorted((w['port'], w['wire'], w['terminal']) for w in s2['wiring'])
ok(ports2 == [(1, 'W2', ''), (2, 'W3', 'J2.1'), (3, 'W4', 'J3.1')],
   'S2 孔位映射 S2#1/#2/#3 完整：%s' % (ports2,))
# 链式网络 2 对导通即可全覆盖
an = qc.analyze(csnap, [R('J1.1', 'J2.1', 'continuity', ohms=0.1, unit='Ω'),
                        R('J1.1', 'J3.1', 'continuity', ohms=0.1, unit='Ω')])
ok(an['stats']['covered'] == 1 and not an['anomalies'], '链式三端网络 2 对导通全覆盖无异常')
# 旧版接线表 {label,from,to} 同样可用于取名
oldfmt = chain_design()
oldfmt['nets'] = [{'label': 'W1', 'from': 'J1.1', 'to': 'J2.1'}]
osnap = qc.build_snapshot(oldfmt)
ok(osnap['nets'][0]['label'] in ('W1', '网络1'), '旧版接线表不报错（实际名 %s）' % osnap['nets'][0]['label'])

print('== 接口（状态机与导入） ==')
srv = server.create_server('127.0.0.1', 0)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()


def req(method, path, body=None):
    c = HTTPConnection('127.0.0.1', port)
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    c.request(method, path, body=data, headers={'Content-Type': 'application/json'})
    r = c.getresponse()
    raw = r.read()
    c.close()
    return r.status, json.loads(raw or b'{}')


code, d = req('POST', '/api/designs', {'name': '接口测试方案', 'data': sample_design()})
ok(code == 200 and d.get('id'), '保存方案')
design_id = d['id']
code, d = req('POST', '/api/batches', {'design_id': design_id, 'name': '批次A'})
ok(code == 200, '创建批次（待准备）')
bid = d['id']
code, d = req('POST', '/api/batches/%s/readings' % bid, {'a': 'J1.1', 'b': 'J2.1', 'result': 'continuity'})
ok(code == 409, '待准备状态不可录入')
code, d = req('POST', '/api/batches/%s/status' % bid, {'action': 'start'})
ok(code == 200 and d['status'] == 'testing', '开测 → 检测中')
code, d = req('POST', '/api/batches/%s/readings' % bid,
              {'a': 'J1.1', 'b': 'J2.1', 'result': 'continuity', 'ohms': 0.12, 'unit': 'Ω'})
ok(code == 200, '检测中录入读数')
code, d = req('POST', '/api/batches/%s/status' % bid, {'action': 'pause'})
ok(code == 200 and d['paused'], '暂停后续测')
code, d = req('POST', '/api/batches/%s/readings' % bid, {'a': 'J1.2', 'b': 'J2.2', 'result': 'continuity'})
ok(code == 409, '暂停时不可录入')
code, d = req('POST', '/api/batches/%s/status' % bid, {'action': 'resume'})
ok(code == 200 and not d['paused'], '继续检测')

# CSV 导入（回归：字段与值数量一致，预览通过的行正常写入）
rows = [
    {'a': 'J1.2', 'b': 'J2.2', 'result': 'open', 'ohms': None, 'unit': ''},
    {'a': 'J9.9', 'b': 'J2.1', 'result': 'continuity', 'ohms': None, 'unit': ''},
    {'a': 'bad', 'b': '', 'result': '', 'ohms': None, 'unit': ''},
]
code, d = req('POST', '/api/batches/%s/readings/preview' % bid, {'rows': rows})
ok(code == 200 and len(d) == 3 and d[0]['ok'] and not d[2]['ok'], 'CSV 预览返回逐行检查')
code, d = req('POST', '/api/batches/%s/readings/import' % bid, {'rows': rows})
ok(code == 200 and d['inserted'] == 2 and d['skipped'] == 1, 'CSV 导入：2 行写入 1 行跳过')
code, an = req('GET', '/api/batches/%s/analysis' % bid)
kinds = {a['kind'] for a in an['anomalies']}
ok('open' in kinds and 'invalid_endpoint' in kinds, '导入读数已参与分析（开路 + 端点无效）')

# 重测网络：撤回该网络读数
net_open = next(a['net'] for a in an['anomalies'] if a['kind'] == 'open')
code, d = req('POST', '/api/batches/%s/retest' % bid, {'net': net_open})
ok(code == 200 and d['withdrawn'] == 1, '重测网络撤回 1 条读数')
code, an = req('GET', '/api/batches/%s/analysis' % bid)
ok(not any(a['kind'] == 'open' for a in an['anomalies']), '重测后开路消失')

# 撤回最近读数（此处撤回 J9.9 无效端点读数）
code, det = req('GET', '/api/batches/%s' % bid)
last = [r for r in det['readings'] if not r['withdrawn']][-1]
code, d = req('POST', '/api/batches/%s/readings/%s/withdraw' % (bid, last['id']))
ok(code == 200, '撤回最近读数')

# 结束检测 → 待复核 → 归档门槛
code, d = req('POST', '/api/batches/%s/status' % bid, {'action': 'finish'})
ok(code == 200 and d['status'] == 'review', '结束检测 → 待复核')
code, d = req('POST', '/api/batches/%s/status' % bid, {'action': 'archive'})
ok(code == 409 and d.get('unresolved'), '异常未结论不可归档')
code, an = req('GET', '/api/batches/%s/analysis' % bid)
for a in an['anomalies']:
    if not a['resolved']:
        c2, d2 = req('POST', '/api/batches/%s/dispositions' % bid, {
            'akey': a['key'], 'kind': a['kind'],
            'action': '免于测试' if a['kind'] == 'uncovered' else '确认缺陷（待返修）',
            'operator': '测试员'})
        assert c2 == 200, (c2, d2)
code, d = req('POST', '/api/batches/%s/status' % bid, {'action': 'archive'})
ok(code == 200 and d['status'] == 'archived', '全部结论后归档')
code, d = req('POST', '/api/batches/%s/readings' % bid, {'a': 'J1.3', 'b': 'J3.1', 'result': 'continuity'})
ok(code == 409, '已归档批次只读')

# 第二个批次：全覆盖直接归档，用于并排比较
code, d = req('POST', '/api/batches', {'design_id': design_id, 'name': '批次B'})
bid2 = d['id']
req('POST', '/api/batches/%s/status' % bid2, {'action': 'start'})
for a, b in [('J1.1', 'J2.1'), ('J1.2', 'J2.2'), ('J1.3', 'J3.1'),
             ('J2.3', 'J3.2'), ('J1.4', 'J2.4'), ('J2.4', 'J3.3')]:
    req('POST', '/api/batches/%s/readings' % bid2,
        {'a': a, 'b': b, 'result': 'continuity', 'ohms': 0.1, 'unit': 'Ω'})
req('POST', '/api/batches/%s/status' % bid2, {'action': 'finish'})
code, d = req('POST', '/api/batches/%s/status' % bid2, {'action': 'archive'})
ok(code == 200, '全覆盖批次直接归档')
code, d = req('GET', '/api/batches/compare?ids=%s,%s' % (bid, bid2))
ok(code == 200 and len(d) == 2 and d[0].get('analysis'), '归档批次并排比较')
code, d = req('DELETE', '/api/batches/%s' % bid2)
ok(code == 200, '删除批次')

srv.shutdown()

print('\n结果：%d 通过，%d 失败' % (passed, failed))
raise SystemExit(1 if failed else 0)
