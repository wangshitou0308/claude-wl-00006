// model.js — 线束钉板数据模型与纯计算逻辑（无 DOM 依赖，可在 Node 中单元测试）
'use strict';

export const VERSION = 3;

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

// ---------- 包覆材料：波纹管 / 编织套管 / 胶带缠绕 ----------

export const COVER_KINDS = [
  { id: 'corr', name: '波纹管', glyph: '〰', color: '#ef6c00', wall: 1.2 },
  { id: 'braid', name: '编织套管', glyph: '⫷', color: '#6d4c41', wall: 0.8 },
  { id: 'tape', name: '胶带缠绕', glyph: '🩹', color: '#283593', wall: 0.35 },
];
export const coverKind = k => COVER_KINDS.find(x => x.id === k) || COVER_KINDS[0];

// 分支收口方式：胶带收口 / 套管剖开缠收口 / 不处理（露线）
export const COVER_CLOSE = [
  { id: 'seal', name: '胶带收口' },
  { id: 'split', name: '剖开收口' },
  { id: 'none', name: '不处理（露线）' },
];

// 锚点沿导线路径的最大悬空（导线删除/被截短后）与跨线最大间隙
export const COVER_MAX_DANGLING = 20;
export const COVER_MAX_JUMP = 12;
// 相邻包覆层壁厚叠加后内径不足的判定余量
export const COVER_WALL_GAP = 0.5;
// 端头/拼接件收口安全间隙（mm）
export const COVER_END_GAP = 2;
// 可视为包覆内部经过（而非收口）的节点距离
export const COVER_NEAR_NODE = 1.5;

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
    covers: [],  // 包覆段（波纹管/编织套管/胶带缠绕）：见 makeCover
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
  d.covers = Array.isArray(d.covers) ? d.covers : [];
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
  for (const c of d.covers) {
    if (!COVER_KINDS.some(k => k.id === c.kind)) c.kind = 'corr';
    if (!COVER_CLOSE.some(k => k.id === c.branchClose)) c.branchClose = 'seal';
    if (!(c.innerD > 0)) c.innerD = 0;
    if (!(c.overlap >= 0)) c.overlap = 0;
    if (!(c.pitch > 0)) c.pitch = 0;
    if (!(c.tapeW > 0)) c.tapeW = 19;
    if (!(c.layer >= 1)) c.layer = 1;
    if (!Array.isArray(c.anchors)) c.anchors = [];
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

// ---------- 包覆段（波纹管 / 编织套管 / 胶带缠绕） ----------
//
// 包覆沿“连续路径”布置：anchors 为有序路径锚点 [{wire, s}]，s 是从该导线起点
// 沿解析路径的弧长(mm)。节点被拖动或改线后，锚点仍按 (导线, 弧长) 重新解析，
// 而非存死坐标；相邻锚点可落在不同导线上（分支处换线），系统检查两锚点处是否
// 处于同一物理位置。kind=tape 时 innerD 可为 0；pitch/tapeW 为缠绕参数。
export function makeCover(design, kind = 'corr', anchors = []) {
  const c = {
    id: uid('c'),
    name: nextCoverName(design),
    kind,
    spec: '',                 // 材料规格（自由文本）
    innerD: 0,                // 内径 mm（胶带可为 0）
    overlap: kind === 'tape' ? 50 : 10, // 胶带=搭接率%；套管=接头搭接 mm
    pitch: kind === 'tape' ? 12 : 0,    // 缠绕节距 mm（胶带）
    tapeW: 19,                // 胶带宽度 mm
    branchClose: 'seal',      // 分支收口：seal 胶带 / split 剖开 / none 露线
    layer: 1,                 // 包覆层次（1 最内）
    anchors,
  };
  if (!c.innerD) {
    const g = coverGeometry(design, c);
    if (g.maxD > 0) c.innerD = Math.ceil((g.maxD + 1) * 2) / 2;
  }
  return c;
}

export function nextCoverName(design) {
  const used = new Set((design.covers || []).map(c => c.name));
  for (let i = 1; i < 1000; i++) {
    const nm = 'C' + i;
    if (!used.has(nm)) return nm;
  }
  return 'C' + Date.now();
}

export function coverById(design, id) {
  return (design.covers || []).find(c => c.id === id) || null;
}

// 沿折线在弧长 s 处取点（含切线方向）
export function pointAtArcOnPath(pts, s) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = dist(pts[i - 1], pts[i]);
    if (acc + L >= s - 1e-9 || i === pts.length - 1) {
      const t = L > 0 ? Math.max(0, Math.min(1, (s - acc) / L)) : 0;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
        ux: (pts[i].x - pts[i - 1].x) / (L || 1),
        uy: (pts[i].y - pts[i - 1].y) / (L || 1),
      };
    }
    acc += L;
  }
  const p = pts[pts.length - 1];
  return { x: p.x, y: p.y, ux: 0, uy: 0 };
}

function pointAtArc(pts, s) { return pointAtArcOnPath(pts, s); }

// 同一折线 [s0,s1] 子段
function subPolyline(pts, s0, s1) {
  if (s1 < s0) { const t = s0; s0 = s1; s1 = t; }
  const out = [pointAtArc(pts, s0)];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = dist(pts[i - 1], pts[i]);
    if (acc + L > s0 && acc < s1) {
      const lo = Math.max(acc, s0), hi = Math.min(acc + L, s1);
      if (lo > acc + 1e-6) out.push(pointAtArc(pts, lo));
      if (hi < acc + L - 1e-6) out.push(pointAtArc(pts, hi));
    }
    acc += L;
  }
  out.push(pointAtArc(pts, s1));
  // 去重相邻点
  return out.filter((p, i) => i === 0 || dist(p, out[i - 1]) > 1e-6);
}

// 点所在的重合束段：沿束段中线投影落在区间内且法向偏移 ≤0.5mm。
// 同一束段的多条导线共线但法向有微差，故按“点到束段中线的投影+垂距”判定，
// 而非要求采样点恰好落在中线上。
function bundleAtPoint(bundles, p) {
  let best = null, bestD = 0.5;
  for (const b of bundles) {
    const L = dist(b.a, b.b);
    if (L < 0.01) continue;
    const ux = (b.b.x - b.a.x) / L, uy = (b.b.y - b.a.y) / L;
    const t = (p.x - b.a.x) * ux + (p.y - b.a.y) * uy;
    if (t < -0.5 || t > L + 0.5) continue;
    const nx = -uy, ny = ux;
    const off = Math.abs((p.x - b.a.x) * nx + (p.y - b.a.y) * ny);
    if (off <= bestD) { bestD = off; best = b; }
  }
  return best;
}

// 子段折线上的最大/最小束径（采样每 5mm 一点），及首点所在束段的导线集合
function subBundleStats(bundles, sub) {
  let maxD = 0, minD = Infinity, wires = null;
  const total = polyLen(sub);
  const nPts = Math.max(1, Math.ceil(total / 5));
  for (let t = 0; t <= nPts; t++) {
    const s = total * t / nPts;
    const p = pointAtArc(sub, s);
    const b = bundleAtPoint(bundles, p);
    if (b) {
      maxD = Math.max(maxD, b.diameter);
      minD = Math.min(minD, b.diameter);
      if (!wires) wires = b.wires.slice();
    }
  }
  if (!wires) return null;
  return { maxD, minD, wires };
}

// 解析包覆几何：把锚点链展开为连续折线 + 逐子段束径/弯曲/节点信息。
// 返回 {ok, pts, seg:[{a,b,wires,diameter,from,to,jump}], length, maxD, minD,
//   bends:[{p,angle,deg}], broken:[{i,reason}], dangling:[{i}], start,end, nodes:[...]}
export function coverGeometry(design, cover) {
  const bundles = computeBundles(design);
  const resolved = [];
  const dangling = [];
  (cover.anchors || []).forEach((a, i) => {
    const w = wireById(design, a.wire);
    if (!w) { dangling.push({ i, reason: '导线已删除' }); return; }
    const pts = resolvePath(design, w);
    const L = polyLen(pts);
    let s = +a.s;
    if (!Number.isFinite(s)) s = 0;
    let over = null;
    if (s < 0) { over = '锚点超出导线起点'; s = 0; }
    if (s > L + COVER_MAX_DANGLING) over = '锚点超出导线终点';
    s = Math.max(0, Math.min(L, s));
    const p = pointAtArc(pts, s);
    resolved.push({ i, wire: w, s, L, p, pts, over });
    if (over) dangling.push({ i, reason: over });
  });

  const broken = [];
  const seg = [];
  const pts = [];
  for (let k = 0; k < resolved.length; k++) {
    const r = resolved[k];
    if (pts.length === 0) pts.push({ x: r.p.x, y: r.p.y });
    if (k === resolved.length - 1) break;
    const n = resolved[k + 1];
    const same = r.wire.id === n.wire.id;
    let sub = [];
    let jump = 0;
    if (same) {
      sub = subPolyline(r.pts, r.s, n.s);
    } else {
      // 跨导线：两锚点应处于同一物理位置（分支换线）；以各自锚点直连
      jump = dist(r.p, n.p);
      sub = [r.p, n.p];
      if (jump > COVER_MAX_JUMP) broken.push({ i: k, reason: `跨线间隙 ${jump.toFixed(1)}mm` });
    }
    // 子段各点束径（沿中线采样）
    let maxD = 0, minD = Infinity, wires = null;
    const stats = subBundleStats(bundles, sub);
    if (stats) ({ maxD, minD, wires } = stats);
    if (!wires) {
      // 束段表中找不到（极短/零长）时退化为该导线单径
      const D = (design.settings.packFactor || 1.2) * r.wire.gauge;
      maxD = minD = D; wires = [r.wire.id];
    }
    for (let j = 1; j < sub.length; j++) {
      seg.push({ a: sub[j - 1], b: sub[j], wires: wires.slice(), diameter: maxD, from: r.wire.id, to: n.wire.id, jump });
      pts.push({ x: sub[j].x, y: sub[j].y });
    }
  }

  // 折线总长度与拐点
  let length = 0;
  for (const s of seg) length += dist(s.a, s.b);
  const bends = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const L1 = dist(pts[i - 1], pts[i]), L2 = dist(pts[i], pts[i + 1]);
    if (L1 < 0.5 || L2 < 0.5) continue;
    const dot = ((pts[i - 1].x - pts[i].x) * (pts[i + 1].x - pts[i].x) +
                 (pts[i - 1].y - pts[i].y) * (pts[i + 1].y - pts[i].y)) / (L1 * L2);
    const ang = Math.PI - Math.acos(Math.max(-1, Math.min(1, dot)));
    if (ang >= 0.087) bends.push({ p: pts[i], angle: ang, deg: ang * 180 / Math.PI });
  }

  // 路径内部经过的节点（分支点/拼接件/连接器）。
  // 束段中线相对折线顶点可能有微差，故沿锚点导线的真实解析路径逐段判断。
  const endNodeIds = new Set();
  const startNode = nearestNodeAt(design, pts[0]), endNode = nearestNodeAt(design, pts[pts.length - 1]);
  if (startNode && dist(pts[0], startNode) <= COVER_NEAR_NODE) endNodeIds.add(startNode.id);
  if (endNode && dist(pts[pts.length - 1], endNode) <= COVER_NEAR_NODE) endNodeIds.add(endNode.id);
  const nodes = [];
  const addNode = node => { if (node && !endNodeIds.has(node.id) && !nodes.some(x => x.id === node.id)) nodes.push(node); };
  // 相邻锚点同线：扫该导线 [s0,s1] 弧长区间；跨线/单锚点：仅判断锚点处
  const coveredArcs = new Map(); // resolved 索引 → [[lo,hi]]
  for (let k = 0; k < resolved.length; k++) {
    const r = resolved[k], wins = [];
    if (k > 0 && resolved[k - 1].wire.id === r.wire.id) wins.push([resolved[k - 1].s, r.s]);
    if (k < resolved.length - 1 && resolved[k + 1].wire.id === r.wire.id) wins.push([r.s, resolved[k + 1].s]);
    if (!wins.length) wins.push([r.s, r.s]);
    let acc = 0;
    for (let i = 1; i < r.pts.length; i++) {
      const L = dist(r.pts[i - 1], r.pts[i]);
      const hit = wins.some(([a, b]) => Math.min(a, b) <= acc + L + 1e-6 && Math.max(a, b) >= acc - 1e-6);
      if (hit) for (const node of design.nodes) if (pointSegDist(node, r.pts[i - 1], r.pts[i]) <= COVER_NEAR_NODE) addNode(node);
      acc += L;
    }
  }

  const diameters = seg.map(s => s.diameter);
  return {
    ok: broken.length === 0,
    pts, seg, length, broken, dangling,
    maxD: diameters.length ? Math.max(...diameters) : 0,
    minD: diameters.length ? Math.min(...diameters.filter(x => Number.isFinite(x))) : 0,
    bends,
    nodes,
    startNode: startNode && dist(pts[0], startNode) <= COVER_NEAR_NODE + 0.5 ? startNode : null,
    endNode: endNode && dist(pts[pts.length - 1], endNode) <= COVER_NEAR_NODE + 0.5 ? endNode : null,
    startNodeNear: startNode, endNodeNear: endNode,
  };
}

function nearestNodeAt(design, p) {
  let best = null, bd = Infinity;
  for (const n of design.nodes) {
    const d = dist(n, p);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

// 已装端头外形尺寸（判断套管能否穿过）：连接器取本体高度，拼接件取保护套外径/本体
export function endPassDim(design, node) {
  if (!node) return 0;
  if (node.type === 'connector') return 18;
  if (node.type === 'splice') return Math.max(node.sleeveD || 0, node.kind === 'butt' ? 8 : 10);
  return 0;
}

// 包覆下料核算：
//  波纹管/编织管：下料 = 路径长 + 弯头裕量 + 分支裕量 + 接头搭接
//  胶带：带长 = Σ π·(束径+带厚) × 带宽 / 有效节距（搭接率换算），
//        另加分支收口带；返回有效节距与总用量。
export function coverCutInfo(design, cover, geo) {
  geo = geo || coverGeometry(design, cover);
  const bendDeg = geo.bends.reduce((a, b) => a + b.deg, 0);
  // 分支收口只针对显式分支点；拼接件/固定钉的引出不计分支露线
  const branchCount = geo.nodes.filter(n => n.type === 'branch').length;
  const joints = 1;
  const isTape = cover.kind === 'tape';

  if (isTape) {
    const ov = Math.max(0, Math.min(90, cover.overlap || 0)) / 100;
    const w = Math.max(1, cover.tapeW || 19);
    const pitch = cover.pitch > 0 ? cover.pitch : w * (1 - ov);
    // 半叠绕 pitch = w/2；有效前进节距不得小于带宽 10%
    const effPitch = Math.max(w * 0.1, pitch);
    let tape = 0;
    for (const s of geo.seg) {
      const L = dist(s.a, s.b);
      const wraps = L / effPitch;
      tape += wraps * Math.PI * (s.diameter + coverKind('tape').wall);
    }
    const branchCount = geo.nodes.filter(n => n.type === 'branch').length;
    const seal = cover.branchClose === 'seal' ? branchCount * 3 * w : 0;
    const ends = 2 * 1.5 * w; // 两端封口
    return {
      kind: 'tape', length: geo.length, cut: tape + seal + ends, unit: 'mm',
      pitch: effPitch, overlapPct: ov, tapeW: w, branchCount, bendDeg, joints,
      seal, ends,
    };
  }

  const bendAllow = bendDeg / 360 * 0.12 * geo.length; // 每 360° 累计转角 +12%
  const branchAllow = branchCount * (cover.branchClose === 'split' ? 25 : cover.branchClose === 'seal' ? 35 : 0);
  const overlapMm = Math.max(0, cover.overlap || 0);
  const cut = geo.length + bendAllow + branchAllow + joints * overlapMm;
  return {
    kind: cover.kind, length: geo.length, cut, unit: 'mm', rounded: Math.ceil(cut),
    bendDeg, bendAllow, branchCount, branchAllow, joints, overlap: overlapMm,
  };
}

// 包覆清单（下料/打印/用料用）
export function coverList(design) {
  return (design.covers || []).map(c => {
    const geo = coverGeometry(design, c);
    const cut = coverCutInfo(design, c, geo);
    const startText = coverLocateText(design, c, 0), endText = coverLocateText(design, c, (c.anchors || []).length - 1);
    return {
      id: c.id, name: c.name, kind: c.kind, kindName: coverKind(c.kind).name,
      glyph: coverKind(c.kind).glyph, spec: c.spec, innerD: c.innerD,
      overlap: c.overlap, pitch: c.pitch, tapeW: c.tapeW,
      branchClose: c.branchClose, layer: c.layer,
      length: geo.length, maxD: geo.maxD, broken: geo.broken.length, dangling: geo.dangling.length,
      bends: geo.bends.length, bendDeg: cut.bendDeg || 0,
      branchCount: cut.branchCount || 0, cut: cut.cut, rounded: cut.rounded, cutInfo: cut,
      start: startText, end: endText,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
}

// 锚点定位描述：节点名 + 沿线距离（用于打印模板保留定位尺寸）
export function coverLocateText(design, cover, idx) {
  const a = (cover.anchors || [])[idx];
  if (!a) return '';
  const w = wireById(design, a.wire);
  if (!w) return `锚点${idx + 1}（导线缺失）`;
  const pts = resolvePath(design, w);
  const L = polyLen(pts);
  const s = Math.max(0, Math.min(L, +a.s || 0));
  const p = pointAtArc(pts, s);
  const near = nearestNodeAt(design, p);
  const tail = idx === 0 ? '起' : idx === (cover.anchors || []).length - 1 ? '止' : `#${idx + 1}`;
  const base = near && dist(near, p) <= COVER_NEAR_NODE + 0.5
    ? nodeName(design, near.id)
    : `${w.label} 沿线 ${s.toFixed(0)}mm`;
  return `${base}（${tail}）`;
}

// 包覆用料汇总：套管按规格×内径统计根长，胶带按宽度×节距统计总带长
export function coverMaterialSummary(design) {
  const tube = new Map(); // key 材料+内径 → {count,total}
  const tape = new Map();
  for (const c of design.covers || []) {
    const geo = coverGeometry(design, c);
    if (!geo.seg.length) continue;
    const cut = coverCutInfo(design, c, geo);
    if (c.kind === 'tape') {
      const key = `${c.spec || '胶带'} ⌀${(geo.maxD || 0).toFixed(1)} 宽${c.tapeW} 节距${cut.pitch.toFixed(1)}`;
      if (!tape.has(key)) tape.set(key, { kind: 'tape', name: '胶带缠绕', spec: c.spec || '胶带', width: c.tapeW, pitch: cut.pitch, count: 0, total: 0 });
      const g = tape.get(key);
      g.count++; g.total += cut.cut;
    } else {
      const key = `${coverKind(c.kind).name} ${c.spec || ''} ⌀${c.innerD}`;
      if (!tube.has(key)) tube.set(key, { kind: c.kind, name: coverKind(c.kind).name, spec: c.spec || '', innerD: c.innerD, count: 0, total: 0 });
      const g = tube.get(key);
      g.count++; g.total += cut.rounded ?? Math.ceil(cut.cut);
    }
  }
  return [...tube.values(), ...tape.values()];
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

// 拼接件孔位在并查集中的节点键（不对外展示，仅用于追踪）
function portKey(spId, pin) { return `port:${spId}#${pin}`; }

// 沿导线与拼接件并查集，求物理连通分量（连接器端子字符串集合）。
// 拼接件所有孔位内部导通；导线把其两端键（连接器端子或拼接孔）合并，
// 因而可正确追踪 J1—S1—S2—J2/J3 这样的多级串接拼接链。
export function physicalTopology(design) {
  const uf = new UF();
  const links = []; // {a,b,wire} 两端均为连接器端子的有效连通段
  const wireEnds = new Map(); // wireId → [连接器端子或null, 连接器端子或null]
  const termNode = new Map(); // 连接器端串 → 节点

  // 导线每一端的并查集键与（若是连接器）端子串
  const endKey = new Map(); // wireId → [keyFrom, keyTo]
  for (const w of design.wires) {
    const keys = [], terms = [];
    for (const side of ['from', 'to']) {
      const ep = w[side];
      const n = ep && ep.node ? nodeById(design, ep.node) : null;
      if (n && n.type === 'connector' && ep.pin >= 1) {
        const t = `${n.name}.${ep.pin}`;
        keys.push(t); terms.push(t); termNode.set(t, n);
      } else if (n && n.type === 'splice' && ep.pin >= 1) {
        keys.push(portKey(n.id, ep.pin)); terms.push(null);
      } else {
        keys.push(null); terms.push(null);
      }
    }
    wireEnds.set(w.id, terms);
    endKey.set(w.id, keys);
    const [a, b] = terms;
    if (a && b && a !== b) links.push({ a, b, wire: w.id });
  }
  // 拼接件本体：其所有孔位内部导通
  for (const sp of design.nodes.filter(n => n.type === 'splice')) {
    const body = portKey(sp.id, 0);
    uf.add(body);
    for (let p = 1; p <= Math.max(2, sp.ports || 2); p++) uf.union(body, portKey(sp.id, p));
  }
  // 导线合并其两端
  for (const w of design.wires) {
    const [ka, kb] = endKey.get(w.id);
    if (ka && kb) uf.union(ka, kb);
  }
  // 分量：仅汇总连接器端子
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

// ---------- 包覆校验 ----------

// 两包覆折线在同一束段上重叠的长度（不同导线/错位时为 0，采样近似）
function coverOverlap(ga, gb) {
  if (!ga.seg.length || !gb.seg.length) return 0;
  let over = 0;
  const samplePts = [];
  for (const s of ga.seg) {
    const L = dist(s.a, s.b), n = Math.max(1, Math.ceil(L / 5));
    for (let i = 0; i <= n; i++) {
      samplePts.push({ x: s.a.x + (s.b.x - s.a.x) * i / n, y: s.a.y + (s.b.y - s.a.y) * i / n });
    }
  }
  for (const p of samplePts) {
    for (const s of gb.seg) {
      if (pointSegDist(p, s.a, s.b) <= 2.5) { over += 5 / Math.max(1, samplePts.length / (ga.length + 1)); break; }
    }
  }
  // 采样近似足以判定“是否重叠”；返回重叠长度估值（仅用于阈值）
  const hits = samplePts.filter(p => gb.seg.some(s => pointSegDist(p, s.a, s.b) <= 2.5)).length;
  return hits / Math.max(1, samplePts.length) * ga.length;
}

export function validateCovers(design) {
  const issues = [];
  const covers = design.covers || [];
  const geos = new Map();
  for (const c of covers) geos.set(c.id, coverGeometry(design, c));

  for (const c of covers) {
    const g = geos.get(c.id);
    const tag = `包覆 ${c.name}（${coverKind(c.kind).name}）`;

    // 锚点悬空 / 导线缺失 / 超出端点
    for (const d of g.dangling) {
      issues.push({ level: 'error', kind: 'cover-broken', cover: c.id,
        msg: `${tag} 第${d.i + 1}个路径锚点失效：${d.reason}，请重新指定包覆起止` });
    }
    // 包覆跨越非连续束段
    for (const b of g.broken) {
      issues.push({ level: 'error', kind: 'cover-broken', cover: c.id,
        msg: `${tag} 跨越非连续束段：第${b.i + 1}~${b.i + 2}个锚点${b.reason}（> ${COVER_MAX_JUMP}mm）` });
    }
    if (!c.anchors || c.anchors.length < 2) {
      issues.push({ level: 'warn', kind: 'cover-broken', cover: c.id, msg: `${tag} 路径锚点不足 2 个` });
    }

    // 内径核算
    if (c.kind !== 'tape') {
      if (!(c.innerD > 0)) {
        issues.push({ level: 'error', kind: 'cover-id', cover: c.id, msg: `${tag} 未设置内径（最大束径 ⌀${g.maxD.toFixed(1)}）` });
      } else if (g.maxD > 0 && c.innerD < g.maxD - 1e-9) {
        issues.push({ level: 'error', kind: 'cover-id', cover: c.id,
          msg: `${tag} 内径不足：⌀${c.innerD} < 束径 ⌀${g.maxD.toFixed(1)}，套不进该束段` });
      } else if (g.maxD > 0 && c.innerD < g.maxD + 1) {
        issues.push({ level: 'warn', kind: 'cover-id', cover: c.id,
          msg: `${tag} 内径裕量偏小：⌀${c.innerD} 对束径 ⌀${g.maxD.toFixed(1)} 不足 1mm` });
      }
    }

    // 接头无法穿套：收口端若已有连接器/拼接件端头且外径大于内径，
    // 整根套管无法从该端穿入 → 必须在相应压接之前裁套、预套
    if (c.kind !== 'tape') {
      for (const ep of [['起', g.startNode], ['止', g.endNode]]) {
        const node = ep[1];
        if (!node || (node.type !== 'connector' && node.type !== 'splice')) continue;
        const dim = endPassDim(design, node);
        if (dim > 0 && c.innerD > 0 && c.innerD < dim) {
          issues.push({ level: 'error', kind: 'cover-pass', cover: c.id, node: node.id,
            msg: `${tag} ${ep[0]}端收口位于 ${nodeName(design, node.id)}，已装端头外形 ⌀${dim} > 套管内径 ⌀${c.innerD}：无法穿套，装配时须把裁套与预套排在该端压接之前` });
        }
      }
    }

    // 收口压到连接器或拼接件（收口间隙不足）
    for (const [ep, near, at] of [['起', g.startNodeNear, g.startNode], ['止', g.endNodeNear, g.endNode]]) {
      if (!near || (near.type !== 'connector' && near.type !== 'splice')) continue;
      const d = dist(g.pts[ep === '起' ? 0 : g.pts.length - 1], near);
      if (at && d <= COVER_NEAR_NODE) {
        issues.push({ level: 'warn', kind: 'cover-end', cover: c.id, node: near.id,
          msg: `${tag} ${ep}端收口直抵 ${nodeName(design, near.id)}（间隙 0mm），建议留出 ≥${COVER_END_GAP}mm 收口距离，避免压到连接器/拼接件` });
      }
    }

    // 分支露线：路径内部经过分叉点，收口方式为“不处理”
    if (g.seg.length) {
      for (const n of g.nodes) {
        if (n.type === 'branch' && c.branchClose === 'none') {
          issues.push({ level: 'error', kind: 'cover-branch', cover: c.id, node: n.id,
            msg: `${tag} 经过分支 ${nodeName(design, n.id)} 但收口方式为“不处理”，分支处会露线` });
        }
      }
    }
  }

  // 层次冲突：同层包覆在同一束段重叠 → 冲突；异层嵌套时外径需容得下
  const ids = covers.map(c => c.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const ca = covers.find(c => c.id === ids[i]), cb = covers.find(c => c.id === ids[j]);
      const ga = geos.get(ca.id), gb = geos.get(cb.id);
      if (!ga.ok || !gb.ok) continue;
      const ov = coverOverlap(ga, gb);
      if (ov < 5) continue; // 重叠 <5mm 忽略
      if (ca.kind === 'tape' && cb.kind === 'tape') {
        issues.push({ level: 'warn', kind: 'cover-layer', cover: ca.id,
          msg: `包覆 ${ca.name} 与 ${cb.name} 在约 ${ov.toFixed(0)}mm 束段上重复缠带` });
      } else if ((ca.layer || 1) === (cb.layer || 1)) {
        issues.push({ level: 'error', kind: 'cover-layer', cover: ca.id,
          msg: `层次冲突：${ca.name} 与 ${cb.name} 同为第 ${ca.layer} 层，却在约 ${ov.toFixed(0)}mm 束段上重叠` });
      } else {
        // 异层：外层内径需 > 内层外径 + 双侧壁厚
        const [inner, outer] = (ca.layer || 1) < (cb.layer || 1) ? [ca, cb] : [cb, ca];
        if (outer.kind !== 'tape' && inner.kind !== 'tape' && outer.innerD > 0) {
          const innerOd = inner.innerD + 2 * coverKind(inner.kind).wall;
          if (outer.innerD < innerOd + COVER_WALL_GAP) {
            issues.push({ level: 'warn', kind: 'cover-layer', cover: outer.id,
              msg: `包覆嵌套过紧：外层 ${outer.name} 内径 ⌀${outer.innerD} 小于内层 ${inner.name} 外径 ⌀${innerOd.toFixed(1)} + ${COVER_WALL_GAP}mm 间隙` });
          }
        }
      }
    }
  }
  return issues;
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

  // ---------- 包覆（波纹管 / 编织套管 / 胶带缠绕） ----------
  issues.push(...validateCovers(design));

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

// 装配步骤：先逐根送线，再按拼接件引导集线/压接/套管，最后按路线完成包覆。
// 对无法穿过已装端头的套管（收口端连接器/拼接件外形 > 内径），把“裁套/预套”
// 排到相应压接之前：precut/preslip 步骤锚定在被阻塞的送线步骤之前，收口/缠带
// 确认仍在导线全部敷设之后。拼接步骤在其所属导线全部敷设之后。
export function assemblySteps(design, confirmedWires, confirmedCoverSteps = null) {
  const order = assemblyOrder(design);
  const wireIdx = new Map(order.map((o, i) => [o.wireId, i]));
  const N = order.length;
  // 导线步骤直接展开装配顺序字段（length/shared/locked），渲染层直接 toFixed
  const steps = order.map((o, i) => ({ ...o, kind: 'wire', sort: i }));
  for (const sp of design.nodes.filter(n => n.type === 'splice')) {
    const att = [];
    for (const w of design.wires) {
      for (const side of ['from', 'to']) {
        if (w[side] && w[side].node === sp.id) att.push({ wire: w, side });
      }
    }
    const maxIdx = Math.max(-1, ...att.map(a => wireIdx.get(a.wire.id) ?? -1));
    const done = att.filter(a => confirmedWires.has(a.wire.id)).length;
    // 阻塞该拼接件压接的“预套”：收口端位于该件且内径小于端头外形的套管
    const preCovers = (design.covers || []).filter(c => {
      if (c.kind === 'tape') return false;
      const g = coverGeometry(design, c);
      return (g.startNode && g.startNode.id === sp.id) || (g.endNode && g.endNode.id === sp.id);
    }).filter(c => c.innerD > 0 && c.innerD < endPassDim(design, sp));
    steps.push({
      kind: 'splice', spliceId: sp.id,
      label: `${spliceKind(sp.kind).name} ${sp.name}`,
      splice: sp, attaches: att, count: att.length,
      doneWires: done, ready: att.length >= 2 && done === att.length,
      preCovers,
      // 排在最后一根所属导线之后、下一根导线之前
      sort: maxIdx + 0.5,
    });
  }

  // 包覆步骤（裁切 → 套装/预套 → 收口 → 缠带确认）
  let coverSeq = 0;
  for (const c of design.covers || []) {
    const g = coverGeometry(design, c);
    if (!g.pts.length) continue;
    const cut = coverCutInfo(design, c, g);
    const base = { kind: 'cover', coverId: c.id, cover: c, geo: g, cut };
    const blockedNode = c.kind !== 'tape'
      ? [g.startNode, g.endNode].find(n => n && (n.type === 'connector' || n.type === 'splice') &&
          endPassDim(design, n) > 0 && c.innerD > 0 && c.innerD < endPassDim(design, n))
      : null;
    const throughWires = [...new Set(g.seg.flatMap(s => s.wires).filter(id => wireById(design, id)))];
    const maxWireIdx = Math.max(-1, ...throughWires.map(id => wireIdx.get(id) ?? -1));
    const layer = c.layer || 1;

    if (c.kind === 'tape') {
      steps.push({ ...base, phase: 'tape', phaseName: '缠带确认',
        label: `${coverKind(c.kind).name} ${c.name} 缠带确认`,
        sort: N + layer * 10 + coverSeq + 0.9 });
    } else {
      // 裁切（必要时带预套警示）
      const cutLen = cut.rounded ?? Math.ceil(cut.cut);
      steps.push({ ...base, phase: 'cut', phaseName: '裁切',
        label: `${coverKind(c.kind).name} ${c.name} 裁切 ${cutLen}mm`,
        blocked: !!blockedNode, gateNode: blockedNode ? blockedNode.id : null,
        sort: blockedNode ? (wireIdx.get(g.startNode && design.wires.find(w => w.from.node === blockedNode.id || w.to.node === blockedNode.id)?.id) ?? maxWireIdx) - 0.4
                         : N + layer * 10 + coverSeq + 0.1 });
      if (blockedNode) {
        // 预套：排到被阻塞端头的压接/送线之前
        const gateWire = design.wires.find(w => w.from.node === blockedNode.id || w.to.node === blockedNode.id);
        const gi = gateWire ? (wireIdx.get(gateWire.id) ?? maxWireIdx) : maxWireIdx;
        steps.push({ ...base, phase: 'preslip', phaseName: '预套',
          label: `${coverKind(c.kind).name} ${c.name} 预套（在 ${nodeName(design, blockedNode.id)} 压接之前）`,
          gateNode: blockedNode.id, sort: gi - 0.2 });
      } else {
        steps.push({ ...base, phase: 'fit', phaseName: '套装',
          label: `${coverKind(c.kind).name} ${c.name} 套装`,
          sort: N + layer * 10 + coverSeq + 0.3 });
      }
      steps.push({ ...base, phase: 'close', phaseName: '收口',
        label: `${coverKind(c.kind).name} ${c.name} 收口（${COVER_CLOSE.find(x => x.id === c.branchClose)?.name || c.branchClose}）`,
        sort: N + layer * 10 + coverSeq + 0.6 });
    }
    coverSeq++;
  }
  return steps.sort((a, b) => a.sort - b.sort);
}

// 包覆步骤的确认键（供装配推演逐项确认/撤回）
export function coverStepKey(step) {
  return `cover:${step.coverId}:${step.phase}`;
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
  // 示例包覆：J1→N1→B1 六线主干套波纹管（不到连接器，两端各留收口距离）；
  // B1→N3 两支缠胶带（半叠绕）。锚点存 (导线, 弧长)，改线后按路径重算。
  const w101 = d.wires.find(w => w.label === 'W-101');
  const w104 = d.wires.find(w => w.label === 'W-104');
  // 在某导线上求路径经过 node 时的累计弧长，再加偏移（负=未到该节点 offset mm）
  const arcAt = (wire, nodeId, offset) => {
    const pts = resolvePath(d, wire);
    const total = polyLen(pts);
    let acc = 0, at = pts[0].node === nodeId ? 0 : total;
    for (let i = 1; i < pts.length; i++) {
      const L = dist(pts[i - 1], pts[i]);
      if (pts[i].node === nodeId) { at = acc + L; break; }
      acc += L;
    }
    return Math.max(0, Math.min(total, at + offset));
  };
  d.covers.push(makeCover(d, 'corr', [
    { wire: w101.id, s: arcAt(w101, J1.id, 10) },
    { wire: w101.id, s: arcAt(w101, B1.id, -10) },
  ]));
  d.covers[0].name = 'C1';
  d.covers[0].spec = 'PA 阻燃波纹管';
  d.covers[0].innerD = Math.max(d.covers[0].innerD, Math.ceil(coverGeometry(d, d.covers[0]).maxD + 2));
  const tape = makeCover(d, 'tape', [
    { wire: w104.id, s: arcAt(w104, B1.id, 6) },
    { wire: w104.id, s: arcAt(w104, N3.id, -6) },
  ]);
  tape.name = 'C2'; tape.spec = 'PVC 电工胶带'; tape.overlap = 50; tape.pitch = 9.5; tape.tapeW = 19;
  d.covers.push(tape);
  return d;
}
