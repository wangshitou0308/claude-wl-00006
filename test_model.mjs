// test_model.mjs — 在 Node 下检验 model.js 的核心计算
import * as M from './static/model.js';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name); }
}
function near(a, b, eps = 0.01) { return Math.abs(a - b) <= eps; }

console.log('== 几何 ==');
ok(M.dist({ x: 0, y: 0 }, { x: 3, y: 4 }) === 5, 'dist 3-4-5');
ok(near(M.polyLen([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }]), 11), 'polyLen');
ok(M.segRectHit({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 4, y: 4, w: 2, h: 2 }), 'seg 穿越矩形');
ok(!M.segRectHit({ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 4, w: 2, h: 2 }), 'seg 不碰矩形');
ok(M.pointInRect({ x: 5, y: 5 }, { x: 4, y: 4, w: 2, h: 2 }), '点在矩形内');

console.log('== 模型 ==');
const d = M.sampleDesign();
ok(d.wires.length === 8, '示例 8 根导线（含三分支拼接）');
ok(d.nodes.some(n => n.type === 'splice'), '示例含实体拼接件');
// 接线表按物理分量生成；S1 把 J1.5/J3.2/J4.1 并成一个三端网络
const tri = d.nets.find(n => n.endpoints.length === 3);
ok(tri && tri.endpoints.join(',') === 'J1.5,J3.2,J4.1',
  '拼接网络三端连通：' + (tri ? tri.endpoints.join(',') : '(无)'));

// 束段合并：J1→N1→B1 主干应有 6 根重合
const bundles = M.computeBundles(d);
const trunk = bundles.filter(b => b.wires.length === 6);
ok(trunk.length === 2, `主干束段 2 段（实际 ${trunk.length}）`);
const D6 = M.bundleDiameter(d, d.wires.filter(w => w.label !== 'W-107' && w.label !== 'W-108').map(w => w.id));
// 主干六根：1.6,1.6,1.3,1.3,1.3,2.4 → D = 1.2*sqrt(2·1.6²+3·1.3²+2.4²)
ok(near(D6, 1.2 * Math.sqrt(2 * 1.6 * 1.6 + 3 * 1.3 * 1.3 + 2.4 * 2.4), 1e-9), '束径公式 D=k·√Σd²');

// 裁线长：路径 + 维修余量 + 剥线
const w101 = d.wires[0];
const c = M.cutInfo(d, w101);
ok(near(c.cut, c.path + 40 + 10), '裁线长=路径+余量+剥线');
ok(c.rounded >= c.cut && c.rounded - c.cut < 5, '裁线向上取整到 5mm');

// 节点移动后长度同步更新
const before = M.wireLength(d, w101);
const N1 = d.nodes.find(n => n.name === 'N1');
N1.y += 100;
const after = M.wireLength(d, w101);
ok(after > before, '移动钉位后路径长同步增大');
N1.y -= 100;
ok(near(M.wireLength(d, w101), before), '移回后长度还原');

console.log('== 校验 ==');
const issues0 = M.validate(d);
ok(issues0.filter(i => i.level === 'error').length === 0, '示例无错误级问题（实际 ' + JSON.stringify(issues0.filter(i=>i.level==='error').map(i=>i.msg)) + '）');

// 端子重复占用
const d2 = M.sampleDesign();
d2.wires[1].from.pin = 1; // 与 W-101 的 J1.1 冲突
ok(M.validate(d2).some(i => i.kind === 'pin'), '检出端子重复占用');

// 穿越禁布区
const d3 = M.sampleDesign();
d3.wires[0].path.splice(2, 0, { x: 520, y: 300 }); // 穿过禁布区中心
ok(M.validate(d3).some(i => i.kind === 'zone'), '检出穿越禁布区');

// 线号接错端点（旧格式接线表：网络名=线号）
const d4 = M.sampleDesign();
d4.nets = [{ name: 'W-101', endpoints: ['J1.1', 'J2.1'] }];
d4.wires[0].to.pin = 4; // 接线表要求 J2.1
ok(M.validate(d4).some(i => i.kind === 'net' && i.level === 'error'), '检出线号接错端点');

// 支路余量不足：把导线拉成接近直线
const d5 = M.sampleDesign();
const w5 = d5.wires[0];
w5.path = [w5.path[0], w5.path[w5.path.length - 1]]; // 直线
ok(M.validate(d5).some(i => i.kind === 'slack'), '检出支路余量不足');

// 维修余量不足
const d6 = M.sampleDesign();
d6.wires[0].ends.from.service = 0;
ok(M.validate(d6).some(i => i.kind === 'service'), '检出维修余量不足');

// 弯曲半径不足：极短边 + 急转弯
const d7 = M.sampleDesign();
const w7 = d7.wires[0];
w7.path = [w7.path[0], { x: 200, y: 300 }, { x: 200.5, y: 290 }, { x: 400, y: 290 }, w7.path[w7.path.length - 1]];
ok(M.validate(d7).some(i => i.kind === 'bend'), '检出弯曲半径不足');

// 线号重复
const d8 = M.sampleDesign();
d8.wires[1].label = 'W-101';
ok(M.validate(d8).some(i => i.kind === 'dupl'), '检出线号重复');

console.log('== 展开 ==');
const cuts = M.cutList(d);
ok(cuts.length === 8 && cuts.every(r => r.rounded > 0), '裁线表 8 行');
ok(cuts.some(r => r.spliceFrom || r.spliceTo), '裁线表标注拼接孔位');
const mats = M.materialSummary(d);
ok(mats.length > 0 && mats.every(g => g.total > 0), '用料汇总按线径分组');
const ties = M.tieList(d);
ok(ties.some(t => t.desc.includes('B1')), '分支点绑扎位置');
const order = M.assemblyOrder(d);
ok(order.length === 8 && order[0].shared >= order[7].shared, '装配顺序主干优先');

console.log('== 整理（锁定跳过） ==');
const d9 = M.sampleDesign();
const w9 = d9.wires[0];
w9.path.splice(1, 0, { x: 160, y: 300 }); // 共线自由点
const w9b = d9.wires[1];
w9b.locked = true;
w9b.path.splice(1, 0, { x: 160, y: 300 });
const n0 = w9.path.length, n0b = w9b.path.length;
M.tidyDesign(d9);
ok(w9.path.length === n0 - 1, '未锁定导线共线点被移除');
ok(w9b.path.length === n0b, '锁定导线不被整理');

console.log('== 共线拆分汇束 ==');
{
  // 两条水平路径 0–100 与 50–150：重合区 50–100 必须汇成 2 根导线的束段
  const dd = M.createDesign('t');
  const J1 = M.makeNode('connector', 0, 0, 'J1', 2);
  const J2 = M.makeNode('connector', 100, 0, 'J2', 2);
  const J3 = M.makeNode('connector', 50, 0, 'J3', 2);
  const J4 = M.makeNode('connector', 150, 0, 'J4', 2);
  dd.nodes.push(J1, J2, J3, J4);
  const w1 = M.makeWire(dd, J1.id, 1);
  w1.to = { node: J2.id, pin: 1 };
  w1.path = [{ x: 0, y: 0, node: J1.id }, { x: 100, y: 0, node: J2.id }];
  const w2 = M.makeWire(dd, J3.id, 1);
  w2.to = { node: J4.id, pin: 1 };
  w2.path = [{ x: 50, y: 0, node: J3.id }, { x: 150, y: 0, node: J4.id }];
  dd.wires.push(w1, w2);
  const bs = M.computeBundles(dd);
  const shared = bs.filter(b => b.wires.length === 2);
  ok(shared.length === 1, `重合区汇成 1 段束段（实际 ${shared.length}）`);
  ok(shared.length === 1 && near(shared[0].a.x, 50) && near(shared[0].b.x, 100), '重合区为 50–100mm');
  ok(shared.length === 1 && near(shared[0].length, 50), '重合束段长 50mm');
  const singles = bs.filter(b => b.wires.length === 1);
  ok(singles.length === 2 && near(singles.reduce((s, b) => s + b.length, 0), 100), '两侧各为单线段（0–50、100–150）');
}

console.log('== 弯曲半径（退距约束） ==');
{
  // 90° 拐点、两侧各 6mm 退距：可容纳 r = 6·tan45° = 6.0mm ≥ 要求 3.6mm → 不应报警
  const mk = (L1, L2) => {
    const dd = M.createDesign('t');
    const A = M.makeNode('connector', 0, 0, 'J1', 1);
    const B = M.makeNode('connector', L1, L2, 'J2', 1);
    dd.nodes.push(A, B);
    const w = M.makeWire(dd, A.id, 1);
    w.gauge = 1.0; // D = 1.2×1.0 = 1.2 → r_req = 3×1.2 = 3.6mm
    w.to = { node: B.id, pin: 1 };
    w.path = [{ x: 0, y: 0, node: A.id }, { x: L1, y: 0 }, { x: L1, y: L2, node: B.id }];
    dd.wires.push(w);
    return dd;
  };
  ok(!M.validate(mk(6, 6)).some(i => i.kind === 'bend'), '6mm 退距 90° 拐点可容纳 6.0mm ≥ 3.6mm，不报警');
  const bad = M.validate(mk(3, 3));
  ok(bad.some(i => i.kind === 'bend'), '3mm 退距 < 所需 3.6mm，报警');
  const msg = (bad.find(i => i.kind === 'bend') || {}).msg || '';
  ok(msg.includes('3.0') && msg.includes('3.6'), '报警含可达成/要求半径：' + msg);
}

console.log('== 拼接件与多分支网络 ==');
{
  const dd = M.sampleDesign();
  const S1 = dd.nodes.find(n => n.name === 'S1');
  ok(S1 && S1.type === 'splice' && S1.ports === 4, '拼接件 S1 存在且端口容量 4');
  // 三端网络端子
  const { groups } = M.physicalTopology(dd);
  const comps = [...groups.values()].map(s => [...s]);
  ok(comps.some(c => c.length === 3 && c.includes('J1.5') && c.includes('J3.2') && c.includes('J4.1')),
    '并查集沿拼接件追踪出三端网络');
  // 示例无错误级问题（拼接网络与接线表一致）
  ok(!M.validate(dd).some(i => i.level === 'error'), '示例拼接网络无错误级问题');

  // 悬空拼接端：S1 只留 1 根
  const dD = M.sampleDesign();
  const s1 = dD.nodes.find(n => n.name === 'S1');
  dD.wires = dD.wires.filter(w => !(w.to && w.to.node === s1.id));
  // 保留 J1.5→S1#1
  ok(M.validate(dD).some(i => i.kind === 'splice-dangling'), '检出拼接悬空端（仅 1 根）');

  // 端口超容：第 5 根线接到容量 4 的 S1
  const dC = M.sampleDesign();
  const sc = dC.nodes.find(n => n.name === 'S1');
  const J2 = dC.nodes.find(n => n.name === 'J2');
  const wExtra = M.makeWire(dC, J2.id, 4);
  wExtra.label = 'W-201';
  // J2.4 被 W-106? 实际 J2.4 未用（J2 用 1-3），可接
  wExtra.to = { node: sc.id, pin: 4 };
  wExtra.path = [{ x: J2.x, y: J2.y, node: J2.id }, { x: sc.x, y: sc.y, node: sc.id }];
  dC.wires.push(wExtra);
  // S1 已用孔 1,2,3 → 加孔 4 恰好满容，不应超容
  ok(!M.validate(dC).some(i => i.kind === 'splice-cap'), '容量 4 用满 4 孔不超容');

  // 线径超出适用范围
  const dG = M.sampleDesign();
  const sg = dG.nodes.find(n => n.name === 'S1');
  sg.gaugeMax = 1.0;
  ok(M.validate(dG).some(i => i.kind === 'splice-gauge'), '检出拼接适用线径超标');

  // 闭端帽粗细比不适配
  const dR = M.sampleDesign();
  const sr = dR.nodes.find(n => n.name === 'S1');
  dR.wires.find(w => w.label === 'W-105').gauge = 2.4; // 2.4/1.3=1.85 > 1.6
  sr.gaugeMax = 3.4;
  ok(M.validate(dR).some(i => i.kind === 'splice-gauge' && /线径组合不适配/.test(i.msg)), '检出闭端帽线径组合不适配');

  // 拼接位置侵入禁布区
  const dZ = M.sampleDesign();
  const sz = dZ.nodes.find(n => n.name === 'S1');
  sz.x = 530; sz.y = 300; // 落入禁布区 500,260 60x80
  ok(M.validate(dZ).some(i => i.kind === 'splice-zone'), '检出拼接位置侵入禁布区');

  // 对接件缺保护套
  const dB = M.createDesign('b');
  const sb = M.makeSplice(100, 100, 'S1', 'butt', 3);
  sb.sleeveD = 0; sb.sleeveLen = 0;
  const c1 = M.makeNode('connector', 0, 0, 'J1', 2);
  const c2 = M.makeNode('connector', 200, 0, 'J2', 2);
  dB.nodes.push(sb, c1, c2);
  const wb = M.makeWire(dB, c1.id, 1);
  wb.to = { node: sb.id, pin: 1 };
  wb.path = [{ x: 0, y: 0, node: c1.id }, { x: 100, y: 100, node: sb.id }];
  const wb2 = M.makeWire(dB, sb.id, 2);
  wb2.to = { node: c2.id, pin: 1 };
  wb2.path = [{ x: 100, y: 100, node: sb.id }, { x: 200, y: 0, node: c2.id }];
  dB.wires.push(wb, wb2);
  ok(M.validate(dB).some(i => i.kind === 'splice-sleeve'), '检出对接件缺保护套');
  // 拼接件连通两端
  const tB = M.physicalTopology(dB);
  ok([...tB.groups.values()].some(s => s.has('J1.1') && s.has('J2.1')), '对接拼接连通 J1.1—J2.1');
}

console.log('== 接线网络校验 ==');
{
  // 跨网合并：两个不同网络名的端子经一根导线连通
  const dd = M.createDesign('net');
  const c1 = M.makeNode('connector', 0, 0, 'J1', 3);
  const c2 = M.makeNode('connector', 200, 0, 'J2', 3);
  dd.nodes.push(c1, c2);
  const w = M.makeWire(dd, c1.id, 1);
  w.to = { node: c2.id, pin: 1 };
  w.path = [{ x: 0, y: 0, node: c1.id }, { x: 200, y: 0, node: c2.id }];
  dd.wires.push(w);
  dd.nets = [
    { name: 'PWR', endpoints: ['J1.1', 'J2.1'] },
    { name: 'GND', endpoints: ['J1.2', 'J2.2'] },
  ];
  ok(!M.validate(dd).some(i => i.kind === 'net-merge'), '同分量同网络名不报跨网合并');
  // 制造跨网：把 J2.1 也归入 GND
  dd.nets = [
    { name: 'PWR', endpoints: ['J1.1'] },
    { name: 'GND', endpoints: ['J2.1'] },
  ];
  ok(M.validate(dd).some(i => i.kind === 'net-merge'), '检出跨网合并（异名端子物理连通）');

  // 接线表内同端子多网络名
  const dd2 = M.createDesign('net2');
  dd2.nodes.push(c1, c2);
  dd2.nets = [
    { name: 'A', endpoints: ['J1.1'] },
    { name: 'B', endpoints: ['J1.1'] },
  ];
  ok(M.validate(dd2).some(i => i.kind === 'net-merge'), '检出接线表同端子跨网络名');

  // 冗余成环：两端同网且不经本线已连通（独立夹具；复用端子同时报占用，不影响环判定）
  {
    const dr = M.createDesign('loop');
    const A = M.makeNode('connector', 0, 0, 'J1', 2);
    const B = M.makeNode('connector', 200, 0, 'J2', 2);
    const Sp = M.makeSplice(100, 80, 'S1', 'butt', 4);
    dr.nodes.push(A, B, Sp);
    const w1 = M.makeWire(dr, A.id, 1);
    w1.to = { node: Sp.id, pin: 1 };
    w1.path = [{ x: 0, y: 0, node: A.id }, { x: 100, y: 80, node: Sp.id }];
    const w2 = M.makeWire(dr, Sp.id, 2);
    w2.to = { node: B.id, pin: 1 };
    w2.path = [{ x: 100, y: 80, node: Sp.id }, { x: 200, y: 0, node: B.id }];
    const w3 = M.makeWire(dr, A.id, 1);
    w3.label = 'W-LP';
    w3.to = { node: B.id, pin: 1 };
    w3.path = [{ x: 0, y: 0, node: A.id }, { x: 200, y: 0, node: B.id }];
    dr.wires.push(w1, w2, w3);
    M.autoNets(dr);
    ok(M.validate(dr).some(i => i.kind === 'net-loop'), '检出冗余环支路（导线两端落入同网）');
  }

  // 未连通网络
  const dn = M.createDesign('n');
  dn.nodes.push(
    M.makeNode('connector', 0, 0, 'J1', 2),
    M.makeNode('connector', 200, 0, 'J2', 2));
  dn.nets = [{ name: 'X', endpoints: ['J1.1', 'J2.1'] }];
  ok(M.validate(dn).some(i => i.kind === 'net-open'), '检出网络未连通');
}

console.log('== 拼接件装配步骤与清单 ==');
{
  const dd = M.sampleDesign();
  const confirmed = new Set(dd.wires.filter(w => w.label !== 'W-108').map(w => w.id));
  const steps = M.assemblySteps(dd, confirmed);
  const wireSteps = steps.filter(s => s.kind === 'wire');
  const spliceSteps = steps.filter(s => s.kind === 'splice');
  ok(wireSteps.length === 8 && spliceSteps.length === 1, '装配步骤 = 8 送线 + 1 拼接');
  const ss = spliceSteps[0];
  // 拼接步骤排在其所属导线之后
  ok(steps.indexOf(ss) > Math.max(...ss.attaches.map(a => steps.findIndex(x => x.wireId === a.wire.id))),
    '拼接步骤排在所属导线之后');
  ok(ss.doneWires === ss.count - 1 && !ss.ready, '未接齐时拼接步骤未就绪');
  const allConf = new Set(dd.wires.map(w => w.id));
  ok(M.assemblySteps(dd, allConf).find(s => s.kind === 'splice').ready, '导线全部确认后拼接就绪');
  const sl = M.spliceList(dd);
  ok(sl.length === 1 && sl[0].count === 3 && sl[0].kindName.includes('闭端'), '拼接件清单 3 线接入');
}

console.log('== 旧方案迁移 ==');
{
  const old = {
    version: 1, name: '旧', board: {}, settings: {},
    nodes: [{ id: 'x', type: 'nail', x: 1, y: 2, name: 'N1' }],
    wires: [],
  };
  M.migrateDesign(old);
  ok(Array.isArray(old.nets) && Array.isArray(old.zones), '旧方案补全 nets/zones');
  // 归一化旧版接线表
  const nn = M.normalizeNets([{ label: 'W-101', from: 'J1.1', to: 'J2.1' }]);
  ok(nn[0].name === 'W-101' && nn[0].endpoints.join(',') === 'J1.1,J2.1', '旧版接线表 {label,from,to} 归一化');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
