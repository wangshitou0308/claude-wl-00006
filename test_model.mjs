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
ok(d.wires.length === 6, '示例 6 根导线');
ok(d.nets.length === 6, '示例自动生成接线表');

// 束段合并：J1→N1→B1 主干应有 6 根重合
const bundles = M.computeBundles(d);
const trunk = bundles.filter(b => b.wires.length === 6);
ok(trunk.length === 2, `主干束段 2 段（实际 ${trunk.length}）`);
const D6 = M.bundleDiameter(d, d.wires.map(w => w.id));
// 线径 1.6,1.6,1.3,1.3,1.0,2.4 → D = 1.2*sqrt(2·1.6²+2·1.3²+1.0²+2.4²) = 1.2*sqrt(15.26)
ok(near(D6, 1.2 * Math.sqrt(15.26), 1e-9), '束径公式 D=k·√Σd²');

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

// 线号接错端点
const d4 = M.sampleDesign();
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
ok(cuts.length === 6 && cuts.every(r => r.rounded > 0), '裁线表 6 行');
const mats = M.materialSummary(d);
ok(mats.length > 0 && mats.every(g => g.total > 0), '用料汇总按线径分组');
const ties = M.tieList(d);
ok(ties.some(t => t.desc.includes('B1')), '分支点绑扎位置');
const order = M.assemblyOrder(d);
ok(order.length === 6 && order[0].shared >= order[5].shared, '装配顺序主干优先');

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

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
