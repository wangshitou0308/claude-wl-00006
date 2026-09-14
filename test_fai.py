#!/usr/bin/env python3
# test_fai.py — 首件尺寸检验批次：fai.py 纯逻辑与接口测试
import json
import os
import tempfile
import threading
from http.client import HTTPConnection

os.environ['HARNESS_DB'] = os.path.join(tempfile.mkdtemp(prefix='faidb'), 'test.db')

import fai
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


def fai_design():
    """J1—(B1)—J2 主干 + B1—J3 分支 + J1—S1—J3 拼接支路；C1 包覆；w4 直通。"""
    return {
        'version': 3, 'name': 'FAI测试线束',
        'board': {'width': 900, 'height': 600, 'grid': 10}, 'settings': {},
        'nodes': [
            {'id': 'j1', 'type': 'connector', 'x': 80, 'y': 300, 'name': 'J1', 'pins': 4},
            {'id': 'j2', 'type': 'connector', 'x': 780, 'y': 140, 'name': 'J2', 'pins': 4},
            {'id': 'j3', 'type': 'connector', 'x': 780, 'y': 460, 'name': 'J3', 'pins': 4},
            {'id': 'b1', 'type': 'branch', 'x': 430, 'y': 220, 'name': 'B1'},
            {'id': 's1', 'type': 'splice', 'x': 600, 'y': 460, 'name': 'S1',
             'kind': 'cap', 'ports': 4, 'strip': 7, 'sleeveD': 4, 'sleeveLen': 15},
        ],
        'zones': [],
        'wires': [
            {'id': 'w1', 'label': 'W-101', 'gauge': 1.6, 'color': '#f00',
             'from': {'node': 'j1', 'pin': 1}, 'to': {'node': 'j2', 'pin': 1},
             'path': [{'x': 80, 'y': 300, 'node': 'j1'},
                      {'x': 430, 'y': 220, 'node': 'b1'},
                      {'x': 780, 'y': 140, 'node': 'j2'}]},
            # from 保存端点与路径不一致（保存成 j1，路径起点绑定 b1）
            {'id': 'w2', 'label': 'W-102', 'gauge': 1.6, 'color': '#0f0',
             'from': {'node': 'j1', 'pin': 9}, 'to': {'node': 'j3', 'pin': 1},
             'path': [{'x': 430, 'y': 220, 'node': 'b1'},
                      {'x': 780, 'y': 460, 'node': 'j3'}]},
            # 含自由折点：起端有尾部余量
            {'id': 'w3', 'label': 'W-103', 'gauge': 1.6, 'color': '#00f',
             'from': {'node': 'j1', 'pin': 2}, 'to': {'node': 's1', 'pin': 1},
             'path': [{'x': 80, 'y': 300, 'node': 'j1'},
                      {'x': 300, 'y': 400},
                      {'x': 600, 'y': 460, 'node': 's1'}]},
            # 直通导线（两端顶点都绑定节点，中间无折点）
            {'id': 'w4', 'label': 'W-104', 'gauge': 1.6, 'color': '#ff0',
             'from': {'node': 's1', 'pin': 2}, 'to': {'node': 'j3', 'pin': 2},
             'path': [{'x': 600, 'y': 460, 'node': 's1'},
                      {'x': 780, 'y': 460, 'node': 'j3'}]},
        ],
        'nets': [],
        'covers': [{'id': 'c1', 'name': 'C1', 'kind': 'tape',
                    'anchors': [{'wire': 'w1', 's': 100}, {'wire': 'w1', 's': 400}]}],
    }


D = fai_design()
snap = fai.build_snapshot(D, design_id=1, design_name='t')

print('== 快照测点 ==')
ok(len(snap['connectors']) == 3 and len(snap['branches']) == 1 and len(snap['splices']) == 1,
   '冻结连接器/分支/拼接姿态')
kinds = {}
for it in snap['items']:
    kinds[it['kind']] = kinds.get(it['kind'], 0) + 1
ok(kinds.get('conn_spacing') == 3, '3 组连接器间距')
ok(kinds.get('branch_pos', 0) >= 1, '生成分支定位测点')
ok(kinds.get('wire_len') == 4, '4 根支路长度')
ok(kinds.get('cover_edge') == 2, '包覆起止 2 个边界')
# 冻结拼接件工艺尺寸
sp = snap['splices'][0]
ok(sp['ports'] == 4 and sp['strip'] == 7 and sp['sleeve_len'] == 15, '冻结拼接件孔位/剥线/保护套')

print('== 尾部余量：直通导线不应产生 ==')
tails = [i for i in snap['items'] if i['kind'] == fai.TAIL]
ok(not any('W-104' in i['name'] for i in tails), '直通导线 W-104 无尾部余量')
ok(not any('W-102' in i['name'] for i in tails), 'B1-J3 直通支路无尾部余量')
w3tail = [i for i in tails if 'W-103' in i['name']]
ok(len(w3tail) == 1, 'W-103 起端自由折点生成 1 个尾部余量')
import math as _m
exp = round(_m.hypot(300 - 80, 400 - 300), 2)
ok(w3tail and abs(w3tail[0]['nominal'] - exp) < 0.05, '尾部余量取连接器到首个自由折点距离')

print('== 保存端点与路径不一致：以路径为准 ==')
w2 = next(i for i in snap['items'] if i['kind'] == fai.WIRE_LEN and 'W-102' in i['name'])
ok(w2['ref_a']['name'] == 'B1' and w2['ref_b']['name'] == 'J3', 'W-102 名称/基准为 B1—J3（不被错误 from=j1 污染）')
fw2 = next(w for w in snap['wires'] if w['id'] == 'w2')
ok(fw2['from_node'] == 'b1' and fw2['to_node'] == 'j3', '冻结导线端点取路径绑定节点')

print('== 单位：单次换算 / 空单位提示 / 未知不明 ==')
p = fai.parse_value('10', 'cm')
ok(abs(p['value_mm'] - 100) < 1e-9 and p['error'] is None, '10 cm = 100 mm（仅换算一次）')
p = fai.parse_value('10', 'mm')
ok(p['value_mm'] == 10 and p['error'] is None, '10 mm = 10')
p = fai.parse_value('10', '')
ok(p['value_mm'] == 10 and p['error'] == 'missing_unit', '空单位按 mm 计但提示单位缺失')
p = fai.parse_value('10', '英尺')
ok(p['value_mm'] is None and p['error'] == 'unknown_unit', '无法识别单位标单位不明')
p = fai.parse_value('abc', 'mm')
ok(p['error'] == 'bad_value', '非数字为无效值')

print('== 偏差、合格/超差 ==')
it0 = snap['items'][0]
rid = [0]


def M(iid, val, unit='mm', withdrawn=False):
    rid[0] += 1
    return {'id': rid[0], 'item': iid, 'value': None, 'value_raw': str(val),
            'unit': unit, 'withdrawn': withdrawn}


def all_nominal(over=None):
    out = []
    for it in snap['items']:
        if not it.get('required', True):
            continue
        v = it['nominal']
        if over and it['id'] == over[0]:
            v += over[1]
        out.append(M(it['id'], v))
    return out


an = fai.analyze(snap, all_nominal())
ok(an['stats']['releasable'] and an['stats']['ng'] == 0, '全部理论值：合格可放行')
an = fai.analyze(snap, all_nominal(over=(it0['id'], it0['tol_pos'] + 5)))
ok(not an['stats']['releasable'] and an['stats']['ng'] == 1, '超差项阻塞放行')

print('== 返工：未新增读数不可放行；重测合格才放行 ==')
ms = all_nominal(over=(it0['id'], 50))
ngkey = next(a['key'] for a in fai.analyze(snap, ms)['anomalies'] if a['kind'] == 'out_of_tol')
maxid = max(m['id'] for m in ms)
an = fai.analyze(snap, ms, [{'id': 1, 'akey': ngkey, 'kind': 'out_of_tol',
                             'action': 'rework', 'meas_max_id': maxid}])
ok(not an['stats']['releasable'], '登记返工但无新读数 → 不可放行')
ok(any(a['kind'] == 'rework_pending' for a in an['anomalies']), '生成返工待重测异常')
# 新增合格读数
ms2 = ms + [M(it0['id'], it0['nominal'])]
an = fai.analyze(snap, ms2, [{'id': 1, 'akey': ngkey, 'kind': 'out_of_tol',
                              'action': 'rework', 'meas_max_id': maxid}])
ok(an['stats']['releasable'], '返工后新增合格读数 → 可放行')
# 新增但仍超差
ms3 = ms + [M(it0['id'], it0['nominal'] + 50)]
an = fai.analyze(snap, ms3, [{'id': 1, 'akey': ngkey, 'kind': 'out_of_tol',
                              'action': 'rework', 'meas_max_id': maxid}])
ok(not an['stats']['releasable'], '返工后仍超差 → 不可放行')
# 让步/报废直接结案
for act in ('concession', 'scrap'):
    an = fai.analyze(snap, ms, [{'id': 1, 'akey': ngkey, 'kind': 'out_of_tol', 'action': act}])
    ok(an['stats']['releasable'], '%s 授权处置后可放行' % fai.DISP_NAMES[act])

print('== 单位缺失/不明对放行的影响 ==')
it1 = next(i for i in snap['items'] if i['id'] != it0['id'])
ms = [M(i['id'], i['nominal']) for i in snap['items']
      if i.get('required', True) and i['id'] not in (it0['id'], it1['id'])]
ms.append(M(it0['id'], it0['nominal']))
ms.append(M(it1['id'], it1['nominal'], ''))   # 空单位但数值合格
an = fai.analyze(snap, ms)
ok(any(a['kind'] == 'missing_unit' for a in an['anomalies']) and an['stats']['releasable'],
   '空单位仅提示，不阻塞放行')
ms[-1] = M(it1['id'], 12, '英尺')
an = fai.analyze(snap, ms)
ok(any(a['kind'] == 'unknown_unit' and a['gating'] for a in an['anomalies'])
   and not an['stats']['releasable'], '单位不明读数不可用，阻塞放行')
ukey = next(a['key'] for a in an['anomalies'] if a['kind'] == 'unknown_unit')
an = fai.analyze(snap, ms, [{'id': 1, 'akey': ukey, 'kind': 'unknown_unit',
                             'action': 'concession'}])
ok(an['stats']['releasable'], '单位不明项让步后可放行')

print('== 测点错序 / 撤回 ==')
seq_items = [i for i in snap['items'] if i.get('required', True)]
rs = [M(seq_items[k]['id'], seq_items[k]['nominal']) for k in range(4)]
rs.append(M(seq_items[0]['id'], seq_items[0]['nominal']))  # 回头测
an = fai.analyze(snap, rs)
ok(any(a['kind'] == 'out_of_order' for a in an['anomalies']), '检出测点错序')
rs[-1]['withdrawn'] = True
an = fai.analyze(snap, rs)
ok(not any(a['kind'] == 'out_of_order' for a in an['anomalies']), '撤回后错序消失')

print('== 自选测点不改几何指纹（不误报过期） ==')
g0 = snap['geom_hash']
snap2 = json.loads(json.dumps(snap))
snap2['items'].append(fai.custom_item(snap2, 'j1', 'j3', tol_neg=2, tol_pos=2))
ok(fai.geometry_hash(snap2) == g0, '追加自选测点几何指纹不变')
# 方案节点移动 → 几何指纹变化
D2 = json.loads(json.dumps(D))
D2['nodes'][0]['x'] += 30
ok(fai.current_hash(D2) != fai.current_hash(D), '方案移动连接器 → 指纹变化（标记过期）')
# 几何不变仅重存 → 不过期
ok(fai.current_hash(json.loads(json.dumps(D))) == fai.current_hash(D), '几何未变则快照不过期')

print('== HTTP 接口全流程 ==')
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


code, d = req('POST', '/api/designs', {'name': 'FAI接口方案', 'data': D})
ok(code == 200 and d.get('id'), '保存方案')
did = d['id']
code, d = req('POST', '/api/fai', {'design_id': did, 'name': '首件批次A'})
ok(code == 200, '创建首件批次（待准备）')
bid = d['id']
code, det = req('GET', '/api/fai/%s' % bid)
ok(code == 200 and len(det['snapshot']['items']) > 0 and det['analysis']['next_item'],
   '批次详情含冻结测点与下一测点')

# 待准备不可录入
any_item = det['snapshot']['items'][0]['id']
code, d = req('POST', '/api/fai/%s/measurements' % bid, {'item': any_item, 'value': 10, 'unit': 'mm'})
ok(code == 409, '待准备不可录入读数')

# 待准备添加自选测点
code, d = req('POST', '/api/fai/%s/items' % bid, {'ref_a': 'j1', 'ref_b': 'j2', 'tol_neg': 3, 'tol_pos': 3})
ok(code == 200 and d['item']['required'] is False, '待准备可加自选测点')
custom_id = d['item']['id']
code, det2 = req('GET', '/api/fai/%s' % bid)
ok(not det2['stale'], '添加自选测点后不标记快照过期')

# 开测
code, d = req('POST', '/api/fai/%s/status' % bid, {'action': 'start'})
ok(code == 200 and d['status'] == 'measuring', '开测 → 测量中')

# 10cm 经接口只换算一次
code, d = req('POST', '/api/fai/%s/measurements' % bid, {'item': any_item, 'value': 10, 'unit': 'cm'})
ok(code == 200, '录入 10cm')
code, det = req('GET', '/api/fai/%s' % bid)
m10 = [m for m in det['measurements'] if m['item'] == any_item][-1]
ok(abs(m10['value'] - 100) < 1e-6 and m10['value_raw'] == '10' and m10['unit'] == 'cm',
   '接口存 100mm / 原值 10 / 单位 cm（无重复换算）')
# 撤回该读数
code, d = req('POST', '/api/fai/%s/withdraw' % bid, {'id': m10['id']})
ok(code == 200, '撤回指定读数')

# 未知单位：读数存档但分析标 unknown_unit、不可放行
code, d = req('POST', '/api/fai/%s/measurements' % bid, {'item': any_item, 'value': 5, 'unit': '英尺'})
ok(code == 200 and '单位不明' in (d.get('warning') or ''), '未知单位读数存档并返回警告')
code, det = req('GET', '/api/fai/%s' % bid)
ok(any(a['kind'] == 'unknown_unit' for a in det['analysis']['anomalies']), '分析标出单位不明')

# 把必测项按理论值补齐（未知单位项改录正常值前先撤回）
um = [m for m in det['measurements'] if m['item'] == any_item and not m['withdrawn']][-1]
req('POST', '/api/fai/%s/withdraw' % bid, {'id': um['id']})
for it in det['snapshot']['items']:
    if not it.get('required', True):
        continue
    code, d = req('POST', '/api/fai/%s/measurements' % bid,
                  {'item': it['id'], 'value': it['nominal'], 'unit': 'mm'})
    assert code == 200, (it, d)
code, det = req('GET', '/api/fai/%s' % bid)
ok(det['analysis']['stats']['releasable'], '全部必测合格后可放行')

# 完成测量 → 待复核 → 放行
code, d = req('POST', '/api/fai/%s/status' % bid, {'action': 'finish'})
ok(code == 200 and d['status'] == 'review', '完成测量 → 待复核')
code, d = req('POST', '/api/fai/%s/status' % bid, {'action': 'release'})
ok(code == 200 and d['status'] == 'released', '放行 → 已放行')

# 已放行只读
code, d = req('POST', '/api/fai/%s/measurements' % bid, {'item': any_item, 'value': 1, 'unit': 'mm'})
ok(code == 409, '已放行不可再录入')
code, d = req('POST', '/api/fai/%s/withdraw' % bid, {})
ok(code == 409, '已放行不可撤回')
code, d = req('POST', '/api/fai/%s/dispositions' % bid,
              {'akey': 'ng:%s' % any_item, 'kind': 'out_of_tol', 'action': 'rework'})
ok(code == 409, '已放行不可登记处置')
code, d = req('DELETE', '/api/fai/%s' % bid)
ok(code == 409, '已放行批次不可删除')
code, d = req('POST', '/api/fai/%s/status' % bid, {'action': 'reopen'})
ok(code == 409, '已放行状态机锁定')

# 返工接口门槛：登记返工但无新读数时不能放行
code, d = req('POST', '/api/fai', {'design_id': did, 'name': '首件批次B'})
bid2 = d['id']
req('POST', '/api/fai/%s/status' % bid2, {'action': 'start'})
code, det = req('GET', '/api/fai/%s' % bid2)
items = det['snapshot']['items']
target = items[0]
for it in items:
    if not it.get('required', True):
        continue
    v = it['nominal'] + (50 if it['id'] == target['id'] else 0)
    req('POST', '/api/fai/%s/measurements' % bid2, {'item': it['id'], 'value': v, 'unit': 'mm'})
code, det = req('GET', '/api/fai/%s' % bid2)
ngkey = next(a['key'] for a in det['analysis']['anomalies'] if a['kind'] == 'out_of_tol')
req('POST', '/api/fai/%s/status' % bid2, {'action': 'finish'})
code, d = req('POST', '/api/fai/%s/dispositions' % bid2,
              {'akey': ngkey, 'kind': 'out_of_tol', 'action': 'rework', 'operator': 'Q'})
ok(code == 200, '待复核可登记返工处置')
code, d = req('POST', '/api/fai/%s/status' % bid2, {'action': 'release'})
ok(code == 409 and d.get('blocking'), '返工后未重测 → 拒绝放行')
# 返回测量补合格读数后放行
req('POST', '/api/fai/%s/status' % bid2, {'action': 'reopen'})
code, d = req('POST', '/api/fai/%s/measurements' % bid2,
              {'item': target['id'], 'value': target['nominal'], 'unit': 'mm'})
ok(code == 200, '返工后重新测量合格')
req('POST', '/api/fai/%s/status' % bid2, {'action': 'finish'})
code, d = req('POST', '/api/fai/%s/status' % bid2, {'action': 'release'})
ok(code == 200 and d['status'] == 'released', '返工重测合格后放行')

# 同方案比较
code, d = req('GET', '/api/fai/compare?ids=%s,%s' % (bid, bid2))
ok(code == 200 and len(d['batches']) == 2 and d['items'], '两个已放行批次可比较')
code, d = req('GET', '/api/fai/compare?ids=%s' % bid)
ok(code == 400, '比较至少需要两个批次')

# 方案改变后旧批次标记过期（仅标记，不改写）
code, d = req('POST', '/api/designs', {'id': did, 'name': 'FAI接口方案', 'data': D2})
code, det = req('GET', '/api/fai/%s' % bid)
ok(det['stale'], '方案连接器移动后旧批次标记快照过期')
code, det2b = req('GET', '/api/fai/%s' % bid2)
ok(det2b['stale'], '另一批次同样标记过期，且冻结测点未被改写')
lst = server.fai_list()
ok(all(x['stale'] for x in lst if x['id'] in (bid, bid2)), '批次列表带快照过期标记')

# 未放行批次可删除
code, d = req('POST', '/api/fai', {'design_id': did, 'name': '首件批次C'})
bid3 = d['id']
code, d = req('DELETE', '/api/fai/%s' % bid3)
ok(code == 200, '未放行批次可删除')

srv.shutdown()

print('\n结果：%d 通过，%d 失败' % (passed, failed))
raise SystemExit(1 if failed else 0)
