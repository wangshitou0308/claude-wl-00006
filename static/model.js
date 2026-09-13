// model.js — 线束钉板数据模型与纯计算逻辑（无 DOM 依赖，可在 Node 中单元测试）
'use strict';

export const VERSION = 2;

export const WIRE_COLORS = [
  ['#d62728', '红'], ['#ff7f0e', '橙'], ['#f2c200', '黄'], ['#2ca02c', '绿'],
  ['#1f77b4', '蓝'], ['#9467bd', '紫'], ['#8c564b', '棕'], ['#17becf', '青'],
  ['#e377c2', '粉'], ['#7f7f7f', '灰'], ['#ffffff', '白'], ['#222222', '黑'],
];

// 线径为成品线外径(mm)，括号内为常见导体截面积参考
export const GAUGES = [
  { d: 1.0, label: '⌀1.0mm (0.35mm²)' },
  { d: 1.3, label: '⌀1.3mm (0.5mm²)' },
  { d: 1.6, label: '⌀1.6mm (0.75mm²)' },
  { d: 2.0, label: '⌀2.0mm (1.0mm²)' },
  { d: 2.4, label: '⌀2.4mm (1.5mm²)' },
  { d: 2.8, label: '⌀2.8mm (2.5mm²)' },
  { d: 3.4, label: '⌀3.4mm (4.0mm²)' },
];

// 实体拼接件：闭端(闭端子压线帽) / 对接(对接管) / 超声焊(超声波金属焊)
export const SPLICE_KINDS = [
  { id: 'cap', name: '闭端拼接', short: '闭', glyph: '🔗', color: '#8d6e63' },
  { id: 'butt', name: '对接拼接', short: '对', glyph: '🔗', color: '#5c6bc0' },
  { id: 'ultra', name: '超声焊拼接', short: '焊', glyph: '∿', color: '#00897b' },
];
export const spliceKind = k => SPLICE_KINDS.find(x => x.id === k) || SPLICE_KINDS[0];

// 闭端帽线径组合上限：最大/最小外径比不宜超过该值（粗线顶不到帽底、细线压不紧）
export const CAP_GAUGE_RATIO = 1.6;

let _uid = 1;
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${(_uid++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createDesign(name = '未命名线束') {
  return {
    version: VERSION,
    name,
    board: { width: 900, height: 600, grid: 10 },
    settings: {
      packFactor: 1.2,   // 束径填充系数: D = k·√(Σd²)
      bendFactor: 3,       // 最小弯曲半径 = 系数 × 束径
      minSlackPct: 3,      // 支路最小余量 %
      minService: 10,      // 最小维修余量 mm
      tieSpacing: 150,     // 束段绑扎间距 mm
      tieOffset: 15,       // 分支点绑扎偏移 mm
      roundTo: 5,          // 裁线向上取整 mm
    },
    nodes: [],   // {id,type:'connector'|'branch'|'nail'|'splice',x,y,name,pins?}
    zones: [],   // {id,x,y,w,h,name}
    wires: [],   // {id,label,gauge,color,from:{node,pin},to:{node,pin},path:[{x,y,node?}],locked,ends:{from:{strip,crimp,service},to:{...}}}
    nets: [],    // 接线表 {name,endpoints:['J1.1','J2.3',...]}；旧版 {label,from,to} 仍可读
  };
}

// 旧方案补全：v1（无拼接件）无需手工迁移即可打开
export function migrateDesign(d) {
  if (!d || typeof d !== 'object') return d;
  d.version = d.version || 1;
  d.nodes = Array.isArray(d.nodes) ? d.nodes : [];
  d.zones = Array.isArray(d.zones) ? d.zones : [];
  d.wires = Array.isArray(d.wires) ? d.wires : [];
  d.nets = Array.isArray(d.nets) ? d.nets : [];
  for (const n of d.nodes) {
    if (n.type === 'splice') {
      n.kind = SPLICE_KINDS.some(k => k.id === n.kind) ? n.kind : 'cap';
      n.ports = Math.max(2, Math.min(24, n.ports || 4));
      if (!(n.gaugeMin >= 0)) n.gaugeMin = 0.5;
      if (!(n.gaugeMax > 0)) n.gaugeMax = 5;
      n.strip = n.strip ?? 7;
      n.sleeveD = n.sleeveD ?? 0;
      n.sleeveLen = n.sleeveLen ?? 0;
    }
  }
  for (const w of d.wires) {
    if (!w.ends) w.ends = defaultEnds();
    w.ends.from = w.ends.from || { strip: 5, crimp: '', service: 20 };
    w.ends.to = w.ends.to || { strip: 5, crimp: '', service: 20 };
  }
  return d;
}

export function makeNode(type, x, y, name, pins) {
  const n = { id: uid('n'), type, x, y, name };
  if (type === 'connector') n.pins = pins || 4;
  return n;
}

// 实体拼接件：ports 端口容量（孔位数），gaugeMin/Max 适用线径，
// strip 默认剥线长度，sleeveD/sleeveLen 保护套（热缩管/焊壳）外径与长度
export function makeSplice(x, y, name, kind = 'cap', ports = 4) {
  const n = {
    id: uid('n'), type: 'splice', x, y, name,
    kind, ports,
    gaugeMin: 0.5, gaugeMax: kind === 'cap' ? 2.4 : 3.4,
    strip: kind === 'ultra' ? 10 : 7,
    sleeveD: kind === 'butt' ? 5 : kind === 'cap' ? 4 : 0,
    sleeveLen: kind === 'butt' ? 25 : kind === 'cap' ? 15 : 0,
  };
  return n;
}

export function makeZone(x, y, w, h, name) {
  return { id: uid('z'), x, y, w, h, name: name || '禁布区' };
}

export function defaultEnds() {
  return {
    from: { strip: 5, crimp: '', service: 20 },
    to: { strip: 5, crimp: '', service: 20 },
  };
}

export function makeWire(design, fromNodeId, fromPin) {
  const node = nodeById(design, fromNodeId);
  const w = {
    id: uid('w'),
    label: nextLabel(design),
    gauge: 1.6,
    color: WIRE_COLORS[design.wires.length % WIRE_COLORS.length][0],
    from: { node: fromNodeId, pin: fromPin },
    to: { node: null, pin: null },
    path: [{ x: node ? node.x : 0, y: node ? node.y : 0, node: fromNodeId }],
    locked: false,
    ends: defaultEnds(),
  };
  return w;
}

export function nextLabel(design) {
  const used = new Set(design.wires.map(w => w.label));
  for (let i = 101; i < 10000; i++) {
    const l = 'W-' + i;
    if (!used.has(l)) return l;
  }
  return 'W-' + Date.now();
}

// ---------- 查找 ----------

export function nodeById(design, id) {
  return design.nodes.find(n => n.id === id) || null;
}
export function wireById(design, id) {
  return design.wires.find(w => w.id === id) || null;
}
export function zoneById(design, id) {
  return design.zones.find(z => z.id === id) || null;
}
export function nodeByName(design, name) {
  return design.nodes.find(n => n.name === name) || null;
}
export function nodeName(design, id) {
  const n = nodeById(design, id);
  return n ? n.name : '?' + String(id).slice(-4);
}

export function spliceById(design, id) {
  const n = nodeById(design, id);
  return n && n.type === 'splice' ? n : null;
}

// 导线某一侧是否落到拼接件
export function endpointSplice(design, ep) {
  return ep && ep.node ? spliceById(design, ep.node) : null;
}

// ---------- 接线拓扑：沿导线与拼接件追踪连通关系 ----------

class UF {
  constructor() { this.p = new Map(); }
  add(x) { if (!this.p.has(x)) this.p.set(x, x); }
  find(x) {
    this.add(x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const nx = this.p.get(x); this.p.set(x, r); x = nx; }
    return r;
  }
  union(a, b) { this.add(a); this.add(b); const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
  same(a, b) { return this.find(a) === this.find(b); }
}

// 设计中被导线占用的端点：'nodeId:pin' → [{wire,side}]
export function pinOccupancy(design) {
  const occ = new Map();
  for (const w of design.wires) {
    for (const side of ['from', 'to']) {
      const ep = w[side];
      if (!ep || !ep.node) continue;
      const k = ep.node + ':' + ep.pin;
      if (!occ.has(k)) occ.set(k, []);
      occ.get(k).push({ wire: w, side });
    }
  }
  return occ;
}

// 规范化接线表：旧版 {label,from,to} → {name:label,endpoints:[from,to]}
export function normalizeNets(nets) {
  return (nets || []).map(n => {
    if (Array.isArray(n.endpoints)) return { name: n.name ?? n.label ?? 'NET', endpoints: n.endpoints.map(String) };
    return { name: n.name ?? n.label ?? 'NET', endpoints: [String(n.from || ''), String(n.to || '')] };
  });
}

// 沿导线与拼接件并查集，求物理连通分量（端子字符串集合）。
// 拼接件的所有孔位内部导通；悬空的拼接孔位不计入端子。
export function physicalTopology(design) {
  const uf = new UF();
  const links = []; // {a,b,wire,side?} 有效连通段
  const wireEnds = new Map(); // wireId → [端子或null, 端子或null]
  const termNode = new Map(); // 端串 → 连接器节点
  for (const w of design.wires) {
    const eps = [];
    for (const side of ['from', 'to']) {
      const ep = w[side];
      const n = ep && ep.node ? nodeById(design, ep.node) : null;
      if (n && n.type === 'connector' && ep.pin >= 1) {
        const t = `${n.name}.${ep.pin}`;
        eps.push(t);
        termNode.set(t, n);
      } else {
        eps.push(null);
      }
    }
    wireEnds.set(w.id, eps);
    const [a, b] = eps;
    if (a && b && a !== b) {
      uf.union(a, b);
      links.push({ a, b, wire: w.id });
    }
  }
  // 拼接件把同件各孔所连导线的连接器端子全部并起来
  for (const sp of design.nodes.filter(n => n.type === 'splice')) {
    const terms = new Set();
    for (const w of design.wires) {
      for (const side of ['from', 'to']) {
        const ep = w[side];
        if (!ep || ep.node !== sp.id) continue;
        // 取拼接孔对侧的连接器端子（本侧是拼接件，其端子串为 null）
        const t = wireEnds.get(w.id)[side === 'from' ? 1 : 0];
        if (t) terms.add(t);
      }
    }
    const arr = [...terms];
    for (let i = 1; i < arr.length; i++) uf.union(arr[0], arr[i]);
  }
  // 汇总分量
  const groups = new Map();
  for (const t of termNode.keys()) {
    const r = uf.find(t);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r).add(t);
  }
  return { uf, groups, links, wireEnds };
}

// 每根导线连通到的连接器端子（自身端优先），及所在物理分量
export function wireTerminals(design) {
  const { uf, wireEnds } = physicalTopology(design);
  const out = new Map();
  for (const w of design.wires) {
    const [a, b] = wireEnds.get(w.id) || [null, null];
    out.set(w.id, { from: a, to: b, uf });
  }
  return out;
}

// ---------- 几何 ----------

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function polyLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

export function pointSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function ccw(a, b, c) { return (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x); }

function onSeg(a, b, p) {
  return p.x >= Math.min(a.x, b.x) - 1e-9 && p.x <= Math.max(a.x, b.x) + 1e-9 &&
         p.y >= Math.min(a.y, b.y) - 1e-9 && p.y <= Math.max(a.y, b.y) + 1e-9;
}

export function segsIntersect(p1, p2, p3, p4) {
  const d1 = ccw(p3, p4, p1), d2 = ccw(p3, p4, p2), d3 = ccw(p1, p2, p3), d4 = ccw(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSeg(p3, p4, p1)) return true;
  if (d2 === 0 && onSeg(p3, p4, p2)) return true;
  if (d3 === 0 && onSeg(p1, p2, p3)) return true;
  if (d4 === 0 && onSeg(p1, p2, p4)) return true;
  return false;
}

export function pointInRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

// 线段与矩形（含穿越、含端点落入）
export function segRectHit(a, b, r) {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const c1 = { x: r.x, y: r.y }, c2 = { x: r.x + r.w, y: r.y };
  const c3 = { x: r.x + r.w, y: r.y + r.h }, c4 = { x: r.x, y: r.y + r.h };
  return segsIntersect(a, b, c1, c2) || segsIntersect(a, b, c2, c3) ||
         segsIntersect(a, b, c3, c4) || segsIntersect(a, b, c4, c1);
}

// ---------- 路径解析 ----------

// 把绑定到节点的路径点解析为当前坐标（节点移动后路径自动跟随）
export function resolvePath(design, wire) {
  return wire.path.map(p => {
    if (p.node) {
      const n = nodeById(design, p.node);
      if (n) return { x: n.x, y: n.y, node: p.node };
    }
    return { x: p.x, y: p.y, node: p.node || null };
  });
}

export function wireLength(design, wire) {
  return polyLen(resolvePath(design, wire));
}

// 裁线长 = 路径长 + 两端维修余量 + 两端剥线
export function cutInfo(design, wire) {
  const path = wireLength(design, wire);
  const e = wire.ends;
  const svc = (e.from.service || 0) + (e.to.service || 0);
  const strip = (e.from.strip || 0) + (e.to.strip || 0);
  const cut = path + svc + strip;
  const r = design.settings.roundTo || 1;
  return { path, svc, strip, cut, rounded: Math.ceil(cut / r) * r };
}

export function endpointStr(design, ep) {
  if (!ep || !ep.node) return '(悬空)';
  const n = nodeById(design, ep.node);
  if (!n) return '(悬空)';
  if (n.type === 'splice') return `${n.name}#${ep.pin}`;
  return `${n.name}.${ep.pin}`;
}

// 端对端目标的人类描述：拼接件给出类型与孔位
export function endpointKind(design, ep) {
  const n = ep && ep.node ? nodeById(design, ep.node) : null;
  return n && n.type === 'splice' ? 'splice' : n ? n.type : 'none';
}

// 解析 "J1.3" → {conn:'J1', pin:3}
export function parseEndpoint(s) {
  const m = /^\s*([A-Za-z0-9_一-龥-]+)\.(\d+)\s*$/.exec(String(s || ''));
  if (!m) return null;
  return { conn: m[1], pin: parseInt(m[2], 10) };
}

// ---------- 束段合并 ----------

function ptKey(p) {
  if (p.node) return 'n:' + p.node;
  return 'q:' + Math.round(p.x * 2) + ',' + Math.round(p.y * 2); // 0.5mm 量化
}

export function segmentKey(a, b) {
  const ka = ptKey(a), kb = ptKey(b);
  return ka < kb ? ka + '|' + kb : kb + '|' + ka;
}

// 所有导线的逐段列表（解析后坐标）
export function segmentList(design) {
  const segs = [];
  for (const w of design.wires) {
    const pts = resolvePath(design, w);
    for (let i = 1; i < pts.length; i++) {
      if (dist(pts[i - 1], pts[i]) < 0.01) continue;
      segs.push({ a: pts[i - 1], b: pts[i], wire: w.id });
    }
  }
  return segs;
}

// 重合路径汇成线束段：共线分组 + 投影拆分。
// 部分重合的共线路径（如 0–100 与 50–150）被拆成原子段，
// 重合区 50–100 成为含全部覆盖导线的束段，而非两段单线。
export function computeBundles(design) {
  const segs = segmentList(design);
  // 1) 按所在直线分组（方向平行且法向偏移 < 0.5mm 视为共线）
  const groups = [];
  for (const s of segs) {
    const L = dist(s.a, s.b);
    if (L < 0.01) continue;
    let ux = (s.b.x - s.a.x) / L, uy = (s.b.y - s.a.y) / L;
    if (ux < 0 || (ux === 0 && uy < 0)) { ux = -ux; uy = -uy; } // 方向规范化
    const nx = -uy, ny = ux;
    const c = nx * s.a.x + ny * s.a.y;
    let g = groups.find(g =>
      Math.abs(ux * g.u.x + uy * g.u.y) > 1 - 1e-6 &&
      Math.abs(c - g.c) < 0.5
    );
    if (!g) { g = { u: { x: ux, y: uy }, n: { x: nx, y: ny }, c, segs: [] }; groups.push(g); }
    g.segs.push(s);
  }
  // 2) 组内投影到直线方向，按所有端点切分为原子区间
  const out = [];
  for (const g of groups) {
    const ox = g.n.x * g.c, oy = g.n.y * g.c; // 直线上参考点
    const iv = [];
    const cuts = new Set();
    for (const s of g.segs) {
      let s0 = g.u.x * (s.a.x - ox) + g.u.y * (s.a.y - oy);
      let s1 = g.u.x * (s.b.x - ox) + g.u.y * (s.b.y - oy);
      if (s0 > s1) { const t = s0; s0 = s1; s1 = t; }
      iv.push({ s0, s1, wire: s.wire });
      cuts.add(Math.round(s0 * 2) / 2);
      cuts.add(Math.round(s1 * 2) / 2);
    }
    const pts = [...cuts].sort((a, b) => a - b);
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1], p1 = pts[i];
      if (p1 - p0 < 0.01) continue;
      const mid = (p0 + p1) / 2;
      const wires = [];
      for (const s of iv) {
        if (s.s0 <= mid + 1e-9 && s.s1 >= mid - 1e-9 && !wires.includes(s.wire)) wires.push(s.wire);
      }
      if (!wires.length) continue;
      out.push({
        a: { x: ox + g.u.x * p0, y: oy + g.u.y * p0 },
        b: { x: ox + g.u.x * p1, y: oy + g.u.y * p1 },
        wires, length: p1 - p0,
        diameter: bundleDiameter(design, wires),
      });
    }
  }
  return out;
}

// 查询某段路径上经过的最大束径（用于弯曲半径核算）
export function segBundleDiameter(bundles, a, b) {
  const L = dist(a, b);
  if (L < 0.01) return 0;
  let ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
  if (ux < 0 || (ux === 0 && uy < 0)) { ux = -ux; uy = -uy; }
  const nx = -uy, ny = ux;
  const c = nx * a.x + ny * a.y;
  let best = 0;
  for (const bd of bundles) {
    const L2 = dist(bd.a, bd.b);
    if (L2 < 0.01) continue;
    let vx = (bd.b.x - bd.a.x) / L2, vy = (bd.b.y - bd.a.y) / L2;
    if (vx < 0 || (vx === 0 && vy < 0)) { vx = -vx; vy = -vy; }
    if (Math.abs(ux * vx + uy * vy) < 1 - 1e-6) continue;      // 不平行
    if (Math.abs(nx * bd.a.x + ny * bd.a.y - c) >= 0.5) continue; // 不共线
    const t0 = ux * (bd.a.x - a.x) + uy * (bd.a.y - a.y);
    const t1 = ux * (bd.b.x - a.x) + uy * (bd.b.y - a.y);
    const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
    if (hi - lo > 0.01 && bd.diameter > best) best = bd.diameter;
  }
  return best;
}

// 按线径估算束径: D = 填充系数 × √(Σ dᵢ²)
export function bundleDiameter(design, wireIds) {
  let sum = 0;
  for (const id of wireIds) {
    const w = wireById(design, id);
    if (w) sum += w.gauge * w.gauge;
  }
  return (design.settings.packFactor || 1.2) * Math.sqrt(sum);
}

// ---------- 校验 ----------

export function validate(design) {
  const issues = [];
  const s = design.settings;
  const bundles = computeBundles(design);

  // 端子重复占用
  const occ = new Map();
  for (const w of design.wires) {
    for (const side of ['from', 'to']) {
      const ep = w[side];
      if (!ep || !ep.node) continue;
      const k = ep.node + ':' + ep.pin;
      if (!occ.has(k)) occ.set(k, []);
      occ.get(k).push(w);
    }
  }
  for (const [k, ws] of occ) {
    if (ws.length > 1) {
      const [nid, pin] = k.split(':');
      issues.push({
        level: 'error', kind: 'pin', wire: ws[1].id, node: nid,
        msg: `端子重复占用：${nodeName(design, nid)}.${pin} 被 ${ws.map(w => w.label).join('、')} 同时占用`,
      });
    }
  }

  // 线号重复
  const byLabel = new Map();
  for (const w of design.wires) {
    if (!byLabel.has(w.label)) byLabel.set(w.label, []);
    byLabel.get(w.label).push(w);
  }
  for (const [label, ws] of byLabel) {
    if (ws.length > 1) {
      issues.push({ level: 'error', kind: 'dupl', wire: ws[1].id, msg: `线号重复：${label} 使用了 ${ws.length} 次` });
    }
  }

  for (const w of design.wires) {
    // 端点有效性（连接器端子或拼接件孔位）
    for (const side of ['from', 'to']) {
      const ep = w[side];
      const cn = ep && ep.node ? nodeById(design, ep.node) : null;
      if (!cn) {
        issues.push({ level: 'error', kind: 'endpoint', wire: w.id, msg: `${w.label}：${side === 'from' ? '起点' : '终点'}悬空，未连接到连接器或拼接件` });
      } else if (cn.type === 'connector' && !(ep.pin >= 1 && ep.pin <= cn.pins)) {
        issues.push({ level: 'error', kind: 'endpoint', wire: w.id, node: cn.id, msg: `${w.label}：端子 ${cn.name}.${ep.pin} 超出针位范围(1-${cn.pins})` });
      } else if (cn.type === 'splice' && !(ep.pin >= 1 && ep.pin <= cn.ports)) {
        issues.push({ level: 'error', kind: 'endpoint', wire: w.id, node: cn.id, msg: `${w.label}：${cn.name} 孔位 ${ep.pin} 超出容量(1-${cn.ports})` });
      } else if (cn.type !== 'connector' && cn.type !== 'splice') {
        issues.push({ level: 'error', kind: 'endpoint', wire: w.id, node: cn.id, msg: `${w.label}：端点 ${cn.name} 既不是连接器也不是拼接件` });
      }
    }

    const pts = resolvePath(design, w);
    const L = polyLen(pts);

    // 穿越禁布区
    for (const z of design.zones) {
      for (let i = 1; i < pts.length; i++) {
        if (segRectHit(pts[i - 1], pts[i], z)) {
          issues.push({ level: 'error', kind: 'zone', wire: w.id, zone: z.id, msg: `${w.label} 穿越禁布区「${z.name}」` });
          break;
        }
      }
    }

    // 支路余量不足
    if (pts.length >= 2) {
      const direct = dist(pts[0], pts[pts.length - 1]);
      if (direct > 1) {
        const slack = (L - direct) / direct * 100;
        if (slack < s.minSlackPct) {
          issues.push({ level: 'warn', kind: 'slack', wire: w.id, msg: `${w.label} 支路余量不足：${slack.toFixed(1)}% < ${s.minSlackPct}%` });
        }
      }
    }

    // 维修余量不足
    for (const side of ['from', 'to']) {
      const svc = w.ends[side].service || 0;
      if (svc < s.minService) {
        issues.push({ level: 'warn', kind: 'service', wire: w.id, msg: `${w.label} ${side === 'from' ? '起' : '终'}端维修余量 ${svc}mm < ${s.minService}mm` });
      }
    }

    // 弯曲半径不足（按经过该拐点的束径）。
    // 拐角 i 所需切线长 tᵢ = r_req / tan(θ/2)；相邻两拐角共用一段时须满足 tᵢ + tᵢ₊₁ ≤ L，
    // 端点一侧不消耗退距。可容纳半径 r = 可用退距 × tan(θ/2)。
    const n = pts.length;
    const defl = new Array(n).fill(0);
    const tReq = new Array(n).fill(0);
    const rReq = new Array(n).fill(0);
    const dAt = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      const L1 = dist(p0, p1), L2 = dist(p1, p2);
      if (L1 < 0.5 || L2 < 0.5) continue;
      const v1 = { x: (p0.x - p1.x) / L1, y: (p0.y - p1.y) / L1 };
      const v2 = { x: (p2.x - p1.x) / L2, y: (p2.y - p1.y) / L2 };
      const dot = Math.max(-1, Math.min(1, v1.x * v2.x + v1.y * v2.y));
      defl[i] = Math.PI - Math.acos(dot); // 偏转角，0=笔直
      if (defl[i] < 0.087) continue; // <5° 忽略
      const D = Math.max(
        segBundleDiameter(bundles, p0, p1),
        segBundleDiameter(bundles, p1, p2),
        (design.settings.packFactor || 1.2) * w.gauge
      );
      dAt[i] = D;
      rReq[i] = s.bendFactor * D;
      tReq[i] = rReq[i] / Math.tan(defl[i] / 2);
    }
    for (let i = 1; i < n - 1; i++) {
      if (defl[i] < 0.087) continue;
      const avail = Math.min(
        dist(pts[i - 1], pts[i]) - tReq[i - 1],
        dist(pts[i], pts[i + 1]) - tReq[i + 1]
      );
      if (tReq[i] > avail + 0.01) {
        const rMax = Math.max(0, avail) * Math.tan(defl[i] / 2);
        issues.push({
          level: 'warn', kind: 'bend', wire: w.id,
          msg: `${w.label} 第${i}个拐点弯曲半径不足：可达成 ≈${rMax.toFixed(1)}mm < 要求 ${rReq[i].toFixed(1)}mm（束径⌀${dAt[i].toFixed(1)}）`,
        });
      }
    }
  }

  // 拼接件：悬空、超容、线径组合、保护套、禁布区
  for (const sp of design.nodes.filter(n => n.type === 'splice')) {
    const att = [];
    for (const w of design.wires) {
      for (const side of ['from', 'to']) {
        const ep = w[side];
        if (ep && ep.node === sp.id) att.push({ wire: w, side, pin: ep.pin });
      }
    }
    // 拼接位置侵入禁布区
    for (const z of design.zones) {
      if (pointInRect(sp, z)) {
        issues.push({ level: 'error', kind: 'splice-zone', node: sp.id, zone: z.id,
          msg: `拼接件 ${sp.name} 位于禁布区「${z.name}」内` });
      }
    }
    if (att.length === 0) {
      issues.push({ level: 'warn', kind: 'splice-dangling', node: sp.id, msg: `拼接件 ${sp.name} 未接入任何导线（悬空拼接点）` });
    } else if (att.length < 2) {
      const a = att[0];
      issues.push({ level: 'warn', kind: 'splice-dangling', node: sp.id, wire: a.wire.id,
        msg: `拼接件 ${sp.name} 仅接 1 根导线（${a.wire.label}），未形成拼接（悬空端）` });
    }
    // 端口超容：不同导线落到同一孔位
    const pins = new Map();
    for (const a of att) {
      if (!pins.has(a.pin)) pins.set(a.pin, []);
      pins.get(a.pin).push(a.wire);
    }
    // 端口超容：孔位重复由上方端子重复占用覆盖；此处报容量（att 数不超 ports 即不超容，
    // 但允许同孔重复会绕过容量，故显式按占用孔位数检查）
    const usedPins = [...pins.keys()].filter(p => p >= 1 && p <= sp.ports);
    if (usedPins.length > sp.ports) {
      issues.push({ level: 'error', kind: 'splice-cap', node: sp.id,
        msg: `拼接件 ${sp.name} 端口超容：占用 ${usedPins.length} 孔 > 容量 ${sp.ports}` });
    }
    // 线径组合
    const gauges = att.map(a => a.wire.gauge);
    const gmin = Math.min(...gauges), gmax = Math.max(...gauges);
    for (const a of att) {
      if (a.wire.gauge < sp.gaugeMin - 1e-9 || a.wire.gauge > sp.gaugeMax + 1e-9) {
        issues.push({ level: 'error', kind: 'splice-gauge', node: sp.id, wire: a.wire.id,
          msg: `${a.wire.label} 线径 ⌀${a.wire.gauge} 超出 ${sp.name} 适用线径（⌀${sp.gaugeMin}~⌀${sp.gaugeMax}）` });
      }
    }
    if (att.length >= 2 && sp.kind === 'cap' && gmin > 0 && gmax / gmin > CAP_GAUGE_RATIO + 1e-9) {
      issues.push({ level: 'error', kind: 'splice-gauge', node: sp.id,
        msg: `闭端拼接 ${sp.name} 线径组合不适配：⌀${gmax}/⌀${gmin} = ${(gmax / gmin).toFixed(2)} > ${CAP_GAUGE_RATIO}（细线压不紧）` });
    }
    // 保护套尺寸缺失（对接件通常必须热缩）
    if (sp.kind === 'butt' && !(sp.sleeveD > 0 && sp.sleeveLen > 0)) {
      issues.push({ level: 'warn', kind: 'splice-sleeve', node: sp.id,
        msg: `对接拼接 ${sp.name} 未填写保护套（热缩管）外径/长度` });
    }
  }

  // ---------- 接线网络：沿导线 + 拼接件追踪连通关系 ----------
  const nets = normalizeNets(design.nets);
  const topo = physicalTopology(design);

  // 接线表自身：同一端子被多个网络名声明（跨网合并的表内版本）
  const decl = new Map(); // ep → [netName...]
  for (const n of nets) {
    for (const ep of n.endpoints) {
      if (!parseEndpoint(ep)) continue;
      if (!decl.has(ep)) decl.set(ep, []);
      decl.get(ep).push(n.name);
    }
  }
  for (const [ep, names] of decl) {
    const uniq = [...new Set(names)];
    if (uniq.length > 1) {
      issues.push({ level: 'error', kind: 'net-merge',
        msg: `接线表冲突：${ep} 同时归入网络 ${uniq.join('、')}` });
    }
  }

  // 端子 → 网络名
  const netOf = new Map();
  for (const n of nets) for (const ep of n.endpoints) if (parseEndpoint(ep)) netOf.set(ep, n.name);

  // 端点存在性：接线表中写到方案里不存在的端子
  const validTerms = new Set();
  for (const c of design.nodes.filter(n => n.type === 'connector')) {
    for (let p = 1; p <= (c.pins || 4); p++) validTerms.add(`${c.name}.${p}`);
  }
  for (const [ep] of netOf) {
    if (!validTerms.has(ep)) {
      issues.push({ level: 'warn', kind: 'net', msg: `接线表端子 ${ep} 在方案连接器中不存在` });
    }
  }

  // 物理分量 → 端子集合，逐个与接线表网络名核对
  const compList = [...topo.groups.values()].map(s => [...s]);
  for (const comp of compList) {
    const names = new Set();
    const missing = [];
    for (const ep of comp) {
      if (netOf.has(ep)) names.add(netOf.get(ep));
      else missing.push(ep);
    }
    if (names.size > 1) {
      // 跨网合并：不同网络名的端子经导线/拼接件被物理导通
      issues.push({ level: 'error', kind: 'net-merge',
        msg: `跨网合并：${comp.sort().join('、')} 物理连通，却分属网络 ${[...names].join('、')}` });
    }
    if (names.size >= 1 && missing.length) {
      issues.push({ level: 'warn', kind: 'net',
        msg: `端子 ${missing.join('、')} 与网络「${[...names][0]}」物理连通，但未列入接线表` });
    }
  }

  // 导线两端落入同网：去掉本线后两端仍经其余导线/拼接件导通 → 冗余成环
  for (const w of design.wires) {
    const [a, b] = topo.wireEnds.get(w.id) || [null, null];
    if (!a || !b) continue;
    const netA = netOf.get(a), netB = netOf.get(b);
    if (netA && netB && netA === netB) {
      // 两端同网。若去掉本线（保留拼接件）仍连通，则本线为冗余闭环支路
      const rest = { ...design, wires: design.wires.filter(x => x.id !== w.id) };
      const t2 = physicalTopology(rest);
      if (t2.uf.find(a) === t2.uf.find(b)) {
        issues.push({ level: 'warn', kind: 'net-loop', wire: w.id,
          msg: `${w.label} 两端落入同一网络「${netA}」且不经本线已连通，构成冗余回路（${a}—${b}）` });
      }
    }
  }

  // 线号接错端点：接线表以线号为网络名的旧格式行，仍逐根比对（兼容旧方案）
  const legacyByName = new Map();
  for (const n of nets) for (const ep of n.endpoints) legacyByName.set(ep + '@' + n.name, n);
  for (const w of design.wires) {
    const rows = nets.filter(n => n.name === w.label && n.endpoints.length === 2);
    if (!rows.length) continue;
    const row = rows[0];
    const ef = parseEndpoint(row.endpoints[0]), et = parseEndpoint(row.endpoints[1]);
    if (!ef || !et) continue;
    const ep2t = ep => {
      const cn = ep && ep.node ? nodeById(design, ep.node) : null;
      return cn && cn.type === 'connector' ? { conn: cn.name, pin: ep.pin } : null;
    };
    const af = ep2t(w.from), at = ep2t(w.to);
    const eq = (x, y) => x && y && x.conn === y.conn && x.pin === y.pin;
    const ok = (eq(af, ef) && eq(at, et)) || (eq(af, et) && eq(at, ef));
    if (!ok) {
      issues.push({
        level: 'error', kind: 'net', wire: w.id,
        msg: `${w.label} 线号接错端点：应为 ${row.endpoints[0]}→${row.endpoints[1]}，实际 ${af ? af.conn + '.' + af.pin : '(未接)'}→${at ? at.conn + '.' + at.pin : '(未接)'}`,
      });
    }
  }

  // 接线表网络尚未连通（网络内端子在物理上分成多个分量）
  for (const n of nets) {
    const eps = n.endpoints.filter(ep => parseEndpoint(ep) && validTerms.has(ep));
    for (let i = 1; i < eps.length; i++) {
      if (topo.uf.find(eps[0]) !== topo.uf.find(eps[i])) {
        issues.push({ level: 'info', kind: 'net-open',
          msg: `网络「${n.name}」未连通：${eps[0]} 与 ${eps[i]} 之间缺少导线/拼接路径` });
        break;
      }
    }
  }
  // 接线表网络在方案中完全没有导线
  const wiredTerms = new Set();
  for (const eps of topo.wireEnds.values()) { if (eps[0]) wiredTerms.add(eps[0]); if (eps[1]) wiredTerms.add(eps[1]); }
  for (const n of nets) {
    if (!n.endpoints.some(ep => wiredTerms.has(ep))) {
      issues.push({ level: 'info', kind: 'orphan', msg: `接线表网络「${n.name}」尚未布线` });
    }
  }

  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return issues;
}

// ---------- 裁线表 / 用料 ----------

export function cutList(design) {
  return design.wires.map(w => {
    const c = cutInfo(design, w);
    const spF = endpointSplice(design, w.from), spT = endpointSplice(design, w.to);
    return {
      id: w.id, label: w.label, color: w.color, gauge: w.gauge,
      from: endpointStr(design, w.from), to: endpointStr(design, w.to),
      spliceFrom: spF ? `${spF.name}#${w.from.pin}` : '',
      spliceTo: spT ? `${spT.name}#${w.to.pin}` : '',
      sleeveFrom: spF && spF.sleeveD > 0 ? `⌀${spF.sleeveD}×${spF.sleeveLen}` : '',
      sleeveTo: spT && spT.sleeveD > 0 ? `⌀${spT.sleeveD}×${spT.sleeveLen}` : '',
      path: c.path, svc: c.svc, strip: c.strip, cut: c.cut, rounded: c.rounded,
      stripFrom: w.ends.from.strip, stripTo: w.ends.to.strip,
      crimpFrom: w.ends.from.crimp, crimpTo: w.ends.to.crimp,
      locked: !!w.locked,
    };
  }).sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN', { numeric: true }));
}

// 拼接件清单（下料/打印用）
export function spliceList(design) {
  return design.nodes.filter(n => n.type === 'splice').map(sp => {
    const wires = [];
    for (const w of design.wires) {
      for (const side of ['from', 'to']) {
        const ep = w[side];
        if (ep && ep.node === sp.id) wires.push({ wire: w, side, pin: ep.pin });
      }
    }
    const gauges = wires.map(x => x.wire.gauge);
    return {
      id: sp.id, name: sp.name, kind: sp.kind, kindName: spliceKind(sp.kind).name,
      ports: sp.ports, gaugeMin: sp.gaugeMin, gaugeMax: sp.gaugeMax,
      strip: sp.strip, sleeveD: sp.sleeveD, sleeveLen: sp.sleeveLen,
      count: wires.length, wires,
      gaugeRange: gauges.length ? `${Math.min(...gauges)}~${Math.max(...gauges)}` : '',
      x: sp.x, y: sp.y,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
}

export function materialSummary(design) {
  const map = new Map();
  for (const w of design.wires) {
    const key = `⌀${w.gauge}mm`;
    const c = cutInfo(design, w);
    if (!map.has(key)) map.set(key, { gauge: w.gauge, count: 0, total: 0, colors: new Map() });
    const g = map.get(key);
    g.count++;
    g.total += c.rounded;
    if (!g.colors.has(w.color)) g.colors.set(w.color, { count: 0, total: 0 });
    const cc = g.colors.get(w.color);
    cc.count++; cc.total += c.rounded;
  }
  return [...map.values()].sort((a, b) => a.gauge - b.gauge).map(g => ({
    gauge: g.gauge, count: g.count, total: g.total,
    colors: [...g.colors.entries()].map(([color, v]) => ({ color, count: v.count, total: v.total })),
  }));
}

// ---------- 绑扎位置 ----------

function ptDesc(design, p) {
  if (p.node) return nodeName(design, p.node);
  const n = design.nodes.find(nd => dist(nd, p) < 0.6);
  return n ? n.name : `(${p.x.toFixed(0)},${p.y.toFixed(0)})`;
}

// 节点引出的线臂（方向 + 邻点）
function armsAt(design, nodeId) {
  const arms = [];
  for (const w of design.wires) {
    const pts = resolvePath(design, w);
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].node !== nodeId) continue;
      const nbs = [];
      if (i > 0) nbs.push(pts[i - 1]);
      if (i < pts.length - 1) nbs.push(pts[i + 1]);
      for (const nb of nbs) {
        const L = dist(pts[i], nb);
        if (L < 1) continue;
        arms.push({ dir: { x: (nb.x - pts[i].x) / L, y: (nb.y - pts[i].y) / L }, len: L, to: ptDesc(design, nb) });
      }
    }
  }
  // 按方向去重
  const seen = new Set();
  return arms.filter(a => {
    const k = Math.round(a.dir.x * 50) + ',' + Math.round(a.dir.y * 50);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function tieList(design) {
  const s = design.settings;
  const ties = [];
  // 分支点：每个引出臂靠近节点处绑扎
  for (const n of design.nodes) {
    const arms = armsAt(design, n.id);
    const isBranch = n.type === 'branch' || arms.length >= 3;
    if (!isBranch || arms.length < 2) continue;
    for (const arm of arms) {
      const d = Math.min(s.tieOffset, arm.len / 2);
      ties.push({ x: n.x + arm.dir.x * d, y: n.y + arm.dir.y * d, desc: `分支 ${n.name} → ${arm.to}` });
    }
  }
  // 束段（≥2根重合）超长等距绑扎
  for (const b of computeBundles(design)) {
    if (b.wires.length < 2 || b.length <= s.tieSpacing) continue;
    const n = Math.floor(b.length / s.tieSpacing);
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      ties.push({
        x: b.a.x + (b.b.x - b.a.x) * t, y: b.a.y + (b.b.y - b.a.y) * t,
        desc: `束段 ${ptDesc(design, b.a)}—${ptDesc(design, b.b)} ${(t * 100).toFixed(0)}%（${b.wires.length}根）`,
      });
    }
  }
  // 5mm 内去重
  const out = [];
  for (const t of ties) {
    if (!out.some(o => dist(o, t) < 5)) out.push(t);
  }
  return out;
}

// ---------- 装配顺序 ----------

// 主干优先：与其余导线重合的长度越长、自身越长，越先敷设
export function assemblyOrder(design) {
  const bundles = computeBundles(design);
  const shared = new Map();
  for (const b of bundles) {
    if (b.wires.length < 2) continue;
    for (const id of b.wires) shared.set(id, (shared.get(id) || 0) + b.length);
  }
  return design.wires.map(w => ({
    wireId: w.id, label: w.label,
    length: wireLength(design, w),
    shared: shared.get(w.id) || 0,
    locked: !!w.locked,
  })).sort((a, b) => (b.shared - a.shared) || (b.length - a.length));
}

// 装配步骤：先逐根送线，再按拼接件引导集线/压接/套管。
// 拼接步骤在其所属导线全部敷设之后；就绪度 = 已确认导线数 / 接入导线数。
export function assemblySteps(design, confirmedWires) {
  const order = assemblyOrder(design);
  const wireIdx = new Map(order.map((o, i) => [o.wireId, i]));
  const steps = order.map(o => ({ kind: 'wire', wireId: o.wireId, label: o.label, order: o }));
  for (const sp of design.nodes.filter(n => n.type === 'splice')) {
    const att = [];
    for (const w of design.wires) {
      for (const side of ['from', 'to']) {
        if (w[side] && w[side].node === sp.id) att.push({ wire: w, side });
      }
    }
    const maxIdx = Math.max(-1, ...att.map(a => wireIdx.get(a.wire.id) ?? -1));
    const done = att.filter(a => confirmedWires.has(a.wire.id)).length;
    steps.push({
      kind: 'splice', spliceId: sp.id,
      label: `${spliceKind(sp.kind).name} ${sp.name}`,
      splice: sp, attaches: att, count: att.length,
      doneWires: done, ready: att.length >= 2 && done === att.length,
      sort: maxIdx + 0.5,
    });
  }
  // 导线按原序号，拼接件排在最后一根所属导线之后
  return steps.map((s, i) => ({ ...s, sort: s.kind === 'wire' ? i : s.sort }))
    .sort((a, b) => a.sort - b.sort);
}

// ---------- 路径整理（跳过锁定） ----------

export function tidyDesign(design, snapRadius = 4) {
  let changed = 0;
  for (const w of design.wires) {
    if (w.locked) continue;
    // 自由点吸附到附近节点
    for (const p of w.path) {
      if (p.node) continue;
      for (const n of design.nodes) {
        if (dist(p, n) <= snapRadius) { p.x = n.x; p.y = n.y; p.node = n.id; changed++; break; }
      }
    }
    // 去除重复点与共线自由点
    const pts = resolvePath(design, w);
    const keep = [w.path[0]];
    for (let i = 1; i < w.path.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      if (dist(p0, p1) < 0.1) { changed++; continue; }
      if (!w.path[i].node) {
        const L1 = dist(p0, p1), L2 = dist(p1, p2);
        if (L1 > 0.5 && L2 > 0.5) {
          const dot = ((p0.x - p1.x) * (p2.x - p1.x) + (p0.y - p1.y) * (p2.y - p1.y)) / (L1 * L2);
          if (Math.PI - Math.acos(Math.max(-1, Math.min(1, dot))) < 0.009) { changed++; continue; }
        }
      }
      keep.push(w.path[i]);
    }
    keep.push(w.path[w.path.length - 1]);
    w.path = keep;
  }
  return changed;
}

// 从现有布线生成接线表：同一网络名可描述多个连接器端子（沿拼接件追踪）。
// 若方案已有同名网络，沿用其名字；否则按物理分量生成 NET-n。
export function autoNets(design) {
  const prev = normalizeNets(design.nets);
  const nameOf = new Map();
  for (const n of prev) for (const ep of n.endpoints) nameOf.set(ep, n.name);
  const { groups } = physicalTopology(design);
  const comps = [...groups.values()]
    .map(s => [...s].sort())
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN', { numeric: true }));
  design.nets = comps.map((eps, i) => {
    const used = new Set();
    for (const ep of eps) { const nm = nameOf.get(ep); if (nm) used.add(nm); }
    const name = used.size === 1 ? [...used][0] : 'NET-' + (i + 1);
    return { name, endpoints: eps };
  });
  return design.nets.length;
}

// ---------- 示例设计 ----------

export function sampleDesign() {
  const d = createDesign('示例线束');
  const J1 = makeNode('connector', 80, 300, 'J1', 6);
  const J2 = makeNode('connector', 780, 140, 'J2', 4);
  const J3 = makeNode('connector', 780, 460, 'J3', 4);
  const J4 = makeNode('connector', 420, 540, 'J4', 3);
  const B1 = makeNode('branch', 420, 300, 'B1');
  const N1 = makeNode('nail', 240, 300, 'N1');
  const N2 = makeNode('nail', 600, 200, 'N2');
  const N3 = makeNode('nail', 600, 400, 'N3');
  const N4 = makeNode('nail', 360, 470, 'N4');
  // 实体拼接件：闭端帽，把 J1.5、J3.2、J4.1 并为同一网络
  const S1 = makeSplice(470, 470, 'S1', 'cap', 4);
  d.nodes.push(J1, J2, J3, J4, B1, N1, N2, N3, N4, S1);
  d.zones.push(makeZone(500, 260, 60, 80, '禁布区'));

  const mk = (label, color, gauge, from, fp, to, tp, mids) => {
    const w = makeWire(d, from, fp);
    w.label = label; w.color = color; w.gauge = gauge;
    w.to = { node: to, pin: tp };
    const tn = nodeById(d, to);
    w.path = [w.path[0], ...mids, { x: tn.x, y: tn.y, node: to }];
    return w;
  };
  const nb = id => ({ x: nodeById(d, id).x, y: nodeById(d, id).y, node: id });
  d.wires.push(
    mk('W-101', '#d62728', 1.6, J1.id, 1, J2.id, 1, [nb(N1.id), nb(B1.id), nb(N2.id)]),
    mk('W-102', '#1f77b4', 1.6, J1.id, 2, J2.id, 2, [nb(N1.id), nb(B1.id), nb(N2.id)]),
    mk('W-103', '#2ca02c', 1.3, J1.id, 3, J2.id, 3, [nb(N1.id), nb(B1.id), nb(N2.id)]),
    mk('W-104', '#f2c200', 1.3, J1.id, 4, J3.id, 1, [nb(N1.id), nb(B1.id), nb(N3.id)]),
    mk('W-106', '#222222', 2.4, J1.id, 6, J3.id, 3, [nb(N1.id), nb(B1.id), nb(N3.id)]),
    // 三支拼接网络：J1.5 —S1— J3.2 / J4.1
    mk('W-105', '#9467bd', 1.3, J1.id, 5, S1.id, 1, [nb(N1.id), nb(B1.id), nb(N4.id)]),
    mk('W-107', '#17becf', 1.3, S1.id, 2, J3.id, 2, [nb(N3.id)]),
    mk('W-108', '#e377c2', 1.3, J4.id, 1, S1.id, 3, [{ x: 430, y: 500 }]),
  );
  // 拼接孔位剥线默认取拼接件设置
  for (const w of d.wires) {
    for (const side of ['from', 'to']) {
      const sp = spliceById(d, w[side].node);
      if (sp) w.ends[side].strip = sp.strip;
    }
  }
  autoNets(d);
  return d;
}
