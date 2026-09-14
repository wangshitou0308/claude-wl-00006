// app.js — 主控制器：工具交互、撤销重做、面板、逐步推演、存档
'use strict';

import * as M from './model.js';
import { render, esc } from './render.js';
import * as IO from './io.js';

// ---------- 状态 ----------

const state = {
  design: M.createDesign(),
  savedId: null,
  tool: 'select',
  spliceKind: 'cap', // 当前放置的拼接件类型
  coverKind: 'corr', // 当前放置的包覆类型
  sel: { kind: null, id: null },       // kind: node|wire|zone|cover
  view: { tx: 30, ty: 30, z: 1 },
  opts: { snap: true, showBundles: true, showTies: false, showCovers: true, showLabels: true },
  drawing: null,   // 布线中 {from:{node,pin}, pts:[], cursor}
  coverDraw: null, // 包覆绘制中 {kind, anchors:[{wire,s,node?}], pts:[], cursor}
  preview: null,   // 禁布区拖拽预览 {x,y,w,h}
  step: null,      // 逐步推演 {active,steps,idx,confirmed:Set,coverDone:Set,locks:Set,lock}
  drag: null,
  epDrag: null,    // 拖接导线端 {wireId,side,start,cur,moved}
};

const $ = id => document.getElementById(id);
const canvas = $('canvas'), wrap = $('canvasWrap');
const layers = {
  board: $('layer-board'), zone: $('layer-zone'), bundle: $('layer-bundle'),
  wire: $('layer-wire'), cover: $('layer-cover'), tie: $('layer-tie'), node: $('layer-node'), overlay: $('layer-overlay'),
};
const ctx = {
  get design() { return state.design; },
  get sel() { return state.sel; },
  get view() { return state.view; },
  get opts() { return state.opts; },
  get step() { return state.step; },
  get drawing() { return state.drawing; },
  get coverDraw() { return state.coverDraw; },
  get preview() { return state.preview; },
  get epDrag() { return state.epDrag; },
  layers,
};

// ---------- 撤销 / 重做 ----------

const undoStack = [], redoStack = [];
function checkpoint() {
  undoStack.push(JSON.stringify(state.design));
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  refreshUndoBtns();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(state.design));
  state.design = M.migrateDesign(JSON.parse(undoStack.pop()));
  afterLoad(); refreshUndoBtns();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(state.design));
  state.design = M.migrateDesign(JSON.parse(redoStack.pop()));
  afterLoad(); refreshUndoBtns();
}
function refreshUndoBtns() {
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
}

// ---------- 视图 ----------

function toWorld(sx, sy) {
  return { x: (sx - state.view.tx) / state.view.z, y: (sy - state.view.ty) / state.view.z };
}
function toScreen(p) {
  return { x: p.x * state.view.z + state.view.tx, y: p.y * state.view.z + state.view.ty };
}
function eventPos(e) {
  const r = canvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}
function zoomAt(sx, sy, factor) {
  const v = state.view;
  const z2 = Math.min(8, Math.max(0.1, v.z * factor));
  const k = z2 / v.z;
  v.tx = sx - (sx - v.tx) * k;
  v.ty = sy - (sy - v.ty) * k;
  v.z = z2;
  refreshCanvas();
}
function fitView() {
  const b = state.design.board;
  const r = wrap.getBoundingClientRect();
  const z = Math.min((r.width - 40) / b.width, (r.height - 40) / b.height);
  state.view.z = Math.max(0.1, Math.min(8, z));
  state.view.tx = (r.width - b.width * state.view.z) / 2;
  state.view.ty = (r.height - b.height * state.view.z) / 2;
  refreshCanvas();
}
function centerOn(p) {
  const r = wrap.getBoundingClientRect();
  state.view.tx = r.width / 2 - p.x * state.view.z;
  state.view.ty = r.height / 2 - p.y * state.view.z;
  refreshCanvas();
}
function updateZoomLabel() {
  $('zoomLabel').textContent = Math.round(state.view.z * 100) + '%';
}

// ---------- 刷新 ----------

function refreshCanvas() {
  render(ctx);
  updateZoomLabel();
}
function refreshAll() {
  refreshCanvas();
  renderProps(); renderChecks(); renderCuts(); renderTies(); renderAsm();
}
function afterLoad() {
  state.sel = { kind: null, id: null };
  state.drawing = null;
  state.coverDraw = null;
  state.step = null;       // 导入/载入新方案时退出任何逐步推演状态
  state.epDrag = null;
  $('stepBar').classList.add('hidden');
  hideCoverBar();
  hidePinPicker();
  syncDataPanel();
  refreshAll();
}
function setStatus(t) { $('statusHint').textContent = t; }

// ---------- 命中测试 ----------

function connSize(n) { return { w: Math.max(34, (n.pins || 4) * 7 + 12), h: 18 }; }
function spliceSize(n) { return { w: Math.max(18, Math.max(2, n.ports || 4) * 6 + 8), h: 13 }; }

function nodeAt(p) {
  const tol = 8 / state.view.z;
  for (let i = state.design.nodes.length - 1; i >= 0; i--) {
    const n = state.design.nodes[i];
    if (n.type === 'connector') {
      const { w, h } = connSize(n);
      if (Math.abs(p.x - n.x) <= w / 2 + tol && Math.abs(p.y - n.y) <= h / 2 + tol) return n;
    } else if (n.type === 'splice') {
      const { w, h } = spliceSize(n);
      if (Math.abs(p.x - n.x) <= w / 2 + tol && Math.abs(p.y - n.y) <= h / 2 + 2 + tol) return n;
    } else if (Math.hypot(p.x - n.x, p.y - n.y) <= (n.type === 'branch' ? 7 : 6) + tol) {
      return n;
    }
  }
  return null;
}
function wireAt(p) {
  const tol = Math.max(4 / state.view.z, 1.5);
  let best = null, bestD = tol;
  for (const w of state.design.wires) {
    const pts = M.resolvePath(state.design, w);
    for (let i = 1; i < pts.length; i++) {
      const d = M.pointSegDist(p, pts[i - 1], pts[i]);
      if (d < bestD) { bestD = d; best = w; }
    }
  }
  return best;
}
function zoneAt(p) {
  for (let i = state.design.zones.length - 1; i >= 0; i--) {
    const z = state.design.zones[i];
    if (M.pointInRect(p, z)) return z;
  }
  return null;
}

// 包覆命中：到任一已解析覆盖折线中线距离 < 半宽+容差
function coverAt(p) {
  const tol = 6 / state.view.z;
  let best = null, bestD = tol;
  for (const c of state.design.covers || []) {
    const geo = M.coverGeometry(state.design, c);
    for (const s of geo.seg) {
      const half = (c.kind === 'tape' ? Math.max(2.2, s.diameter) : Math.max(c.innerD || 2, s.diameter)) / 2;
      const d = M.pointSegDist(p, s.a, s.b);
      if (d < bestD + half && d - half < bestD) { best = c; bestD = Math.max(0, d - half); }
    }
  }
  return best;
}

// 找距离点最近的导线路径点，返回 {wire, s, point, d}（沿束段中心吸附）
function nearestPathPoint(p, onlyWire = null) {
  let best = null;
  for (const w of state.design.wires) {
    if (onlyWire && w.id !== onlyWire) continue;
    const pts = M.resolvePath(state.design, w);
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const L = M.dist(a, b);
      if (L < 0.01) { acc += L; continue; }
      let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (L * L);
      t = Math.max(0, Math.min(1, t));
      const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const d = M.dist(p, q);
      if (!best || d < best.d) best = { wire: w, s: acc + t * L, point: q, d };
      acc += L;
    }
  }
  return best;
}
function vertexAt(p) {
  if (state.sel.kind !== 'wire') return -1;
  const w = M.wireById(state.design, state.sel.id);
  if (!w || w.locked) return -1;
  const pts = M.resolvePath(state.design, w);
  const tol = 7 / state.view.z;
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(p.x - pts[i].x, p.y - pts[i].y) <= tol) return i;
  }
  return -1;
}

// 选中包覆的路径锚点手柄
function coverAnchorAt(p) {
  if (state.sel.kind !== 'cover') return null;
  const c = M.coverById(state.design, state.sel.id);
  if (!c) return null;
  const tol = 8 / state.view.z;
  for (let i = 0; i < c.anchors.length; i++) {
    const a = c.anchors[i];
    const w = M.wireById(state.design, a.wire);
    if (!w) continue;
    const q = M.pointAtArcOnPath(M.resolvePath(state.design, w), a.s);
    if (Math.hypot(p.x - q.x, p.y - q.y) <= tol) return { coverId: c.id, idx: i };
  }
  return null;
}

// 选中导线两端的可拖接手柄（拼接件端收到孔位点）
function epHandleAt(p) {
  if (state.sel.kind !== 'wire') return null;
  const w = M.wireById(state.design, state.sel.id);
  if (!w || w.locked) return null;
  const pts = displayPathForHit(state.design, w);
  const tol = 9 / state.view.z;
  for (const [i, side] of [[0, 'from'], [pts.length - 1, 'to']]) {
    const q = pts[i];
    if (Math.hypot(p.x - q.x, p.y - q.y) <= tol) return { side, x: q.x, y: q.y };
  }
  return null;
}

// 与 render.displayPath 等价的命中坐标（拼接端收到孔位）
function displayPathForHit(design, w) {
  const pts = M.resolvePath(design, w);
  return pts.map((p, i) => {
    const side = i === 0 ? 'from' : i === pts.length - 1 ? 'to' : null;
    if (!side) return p;
    const ep = w[side];
    const n = ep && ep.node ? M.nodeById(design, ep.node) : null;
    if (n && n.type === 'splice') {
      const ww = Math.max(18, Math.max(2, n.ports || 4) * 6 + 8);
      const ports = Math.max(2, n.ports || 4);
      const pin = Math.min(Math.max(1, ep.pin), ports);
      return { x: n.x - ww / 2 + ((pin - 0.5) / ports) * ww, y: n.y + 6.5, node: n.id };
    }
    return p;
  });
}

// 吸附：优先就近节点（绑定），其次网格
function snapPt(p, allowNode = true) {
  if (allowNode) {
    const n = nodeAt(p);
    if (n && Math.hypot(p.x - n.x, p.y - n.y) <= 10 / state.view.z) {
      return { x: n.x, y: n.y, node: n.id };
    }
  }
  if (state.opts.snap) {
    const g = state.design.board.grid || 10;
    return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
  }
  return { x: p.x, y: p.y };
}

// ---------- 端子选择弹窗 ----------

let pinCb = null;
function occupiedPins(nodeId, extra) {
  const occ = new Map();
  for (const w of state.design.wires) {
    for (const side of ['from', 'to']) {
      const ep = w[side];
      if (ep && ep.node === nodeId) occ.set(ep.pin, w.label);
    }
  }
  if (extra) occ.set(extra.pin, '本线');
  return occ;
}
function showPinPicker(node, title, extraPin, cb) {
  const pk = $('pinPicker');
  const isSplice = node.type === 'splice';
  const count = isSplice ? Math.max(2, node.ports || 4) : (node.pins || 4);
  const occ = occupiedPins(node.id, extraPin);
  const s = toScreen(node);
  let h = `<h5>${esc(title)}：${esc(node.name)} ${isSplice ? '孔位' : '端子'}</h5><div class="pins">`;
  for (let i = 1; i <= count; i++) {
    const o = occ.get(i);
    h += `<button data-pin="${i}" class="${o ? 'occ' : ''}" ${o ? 'disabled' : ''} title="${o ? '已被 ' + esc(o) + ' 占用' : ''}">${i}</button>`;
  }
  h += `</div><button class="cancel">取消</button>`;
  pk.innerHTML = h;
  pk.classList.remove('hidden');
  pk.style.left = Math.min(s.x + 12, wrap.clientWidth - 180) + 'px';
  pk.style.top = Math.max(4, s.y - 20) + 'px';
  pinCb = cb;
  pk.querySelectorAll('button[data-pin]').forEach(b => {
    b.onclick = () => { const p = +b.dataset.pin; hidePinPicker(); cb(p); };
  });
  pk.querySelector('.cancel').onclick = hidePinPicker;
}
function hidePinPicker() {
  $('pinPicker').classList.add('hidden');
  pinCb = null;
}

// ---------- 画布交互 ----------

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const { sx, sy } = eventPos(e);
  zoomAt(sx, sy, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

canvas.addEventListener('pointerdown', e => {
  if (e.button === 2) return; // 右键交给 contextmenu
  canvas.setPointerCapture(e.pointerId);
  const { sx, sy } = eventPos(e);
  const p = toWorld(sx, sy);
  hidePinPicker();

  if (state.step && state.step.active) {
    // 推演模式只允许平移缩放
    state.drag = { type: 'pan', sx, sy, tx: state.view.tx, ty: state.view.ty, moved: false };
    return;
  }

  if (e.button === 1 || state.tool === 'select') {
    // 中键一律平移；选择工具按下述命中处理
    if (e.button === 1) {
      state.drag = { type: 'pan', sx, sy, tx: state.view.tx, ty: state.view.ty, moved: false };
      return;
    }
    const vi = vertexAt(p);
    if (vi >= 0) {
      state.drag = { type: 'vertex', idx: vi, ck: false };
      return;
    }
    const cai = coverAnchorAt(p);
    if (cai) {
      state.drag = { type: 'coverAnchor', coverId: cai.coverId, idx: cai.idx, ck: false };
      return;
    }
    const eh = epHandleAt(p);
    if (eh) {
      state.epDrag = { wireId: state.sel.id, side: eh.side, start: { x: eh.x, y: eh.y }, cur: p, moved: false };
      state.drag = { type: 'ep', ck: false };
      return;
    }
    const n = nodeAt(p);
    if (n) {
      state.sel = { kind: 'node', id: n.id };
      state.drag = { type: 'node', node: n, dx: n.x - p.x, dy: n.y - p.y, ck: false };
      refreshAll();
      return;
    }
    const z = zoneAt(p);
    if (z) {
      state.sel = { kind: 'zone', id: z.id };
      state.drag = { type: 'zone', zone: z, dx: z.x - p.x, dy: z.y - p.y, ck: false };
      refreshAll();
      return;
    }
    const w = wireAt(p);
    if (w) {
      state.sel = { kind: 'wire', id: w.id };
      refreshAll();
      return;
    }
    const cv = coverAt(p);
    if (cv) {
      state.sel = { kind: 'cover', id: cv.id };
      refreshAll();
      return;
    }
    state.drag = { type: 'pan', sx, sy, tx: state.view.tx, ty: state.view.ty, moved: false };
    return;
  }

  if (state.tool === 'connector' || state.tool === 'branch' || state.tool === 'nail') {
    const sp = snapPt(p, false);
    checkpoint();
    const typeName = { connector: 'J', branch: 'B', nail: 'N' }[state.tool];
    const count = state.design.nodes.filter(n => n.name.startsWith(typeName)).length + 1;
    const node = M.makeNode(state.tool, sp.x, sp.y, typeName + count, 4);
    state.design.nodes.push(node);
    state.sel = { kind: 'node', id: node.id };
    refreshAll();
    return;
  }

  if (state.tool === 'splice') {
    const sp = snapPt(p, false);
    checkpoint();
    const count = state.design.nodes.filter(n => n.name.startsWith('S')).length + 1;
    const node = M.makeSplice(sp.x, sp.y, 'S' + count, state.spliceKind || 'cap',
      state.spliceKind === 'cap' ? 4 : state.spliceKind === 'butt' ? 3 : 4);
    state.design.nodes.push(node);
    state.sel = { kind: 'node', id: node.id };
    refreshAll();
    return;
  }

  if (state.tool === 'zone') {
    state.drag = { type: 'zoneNew', x0: p.x, y0: p.y };
    state.preview = { x: p.x, y: p.y, w: 0, h: 0 };
    return;
  }

  if (state.tool === 'cover') {
    const hit = nearestPathPoint(p);
    if (!hit) { setStatus('附近没有束段/导线，请把包覆起指点在已有走线上'); return; }
    if (!state.coverDraw) {
      state.coverDraw = { kind: state.coverKind, anchors: [], pts: [], cursor: null };
    }
    addCoverAnchor(hit);
    return;
  }

  if (state.tool === 'wire') {
    const n = nodeAt(p);
    const connectable = n && (n.type === 'connector' || n.type === 'splice');
    if (!state.drawing) {
      if (connectable) {
        const word = n.type === 'splice' ? '选择起点孔位' : '选择起点端子';
        showPinPicker(n, word, null, pin => {
          state.drawing = { from: { node: n.id, pin }, pts: [{ x: n.x, y: n.y, node: n.id }], cursor: null };
          setStatus(`布线中：${M.endpointStr(state.design, state.drawing.from)} → 点击画布加途经点（可吸附钉/分支/拼接件），点击目标连接器或拼接件结束，Esc 取消，退格撤点`);
          refreshCanvas();
        });
      } else {
        setStatus('请先点击一个连接器或拼接件作为起点');
      }
      return;
    }
    // 布线中：目标必须是连接器或拼接件
    if (connectable) {
      const from = state.drawing.from;
      if (n.id === from.node) { setStatus('起点与终点不能是同一件，请另选目标'); return; }
      showPinPicker(n, n.type === 'splice' ? '选择终点孔位' : '选择终点端子', null, pin => {
        finishWire(n, pin);
      });
      return;
    }
    const sp = snapPt(p);
    state.drawing.pts.push(sp);
    refreshCanvas();
  }
});

canvas.addEventListener('pointermove', e => {
  const { sx, sy } = eventPos(e);
  const p = toWorld(sx, sy);
  $('statusPos').textContent = `X ${p.x.toFixed(0)}  Y ${p.y.toFixed(0)} mm`;
  const d = state.drag;
  if (d) {
    // 首次实际移动时才记入撤销历史，避免选择操作污染撤销栈
    if ((d.type === 'node' || d.type === 'zone' || d.type === 'vertex' || d.type === 'ep' || d.type === 'coverAnchor') && !d.ck) {
      checkpoint();
      d.ck = true;
    }
    if (d.type === 'pan') {
      state.view.tx = d.tx + (sx - d.sx);
      state.view.ty = d.ty + (sy - d.sy);
      d.moved = true;
      refreshCanvas();
    } else if (d.type === 'node') {
      const sp = state.opts.snap ? snapGrid({ x: p.x + d.dx, y: p.y + d.dy }) : { x: p.x + d.dx, y: p.y + d.dy };
      d.node.x = sp.x; d.node.y = sp.y;
      refreshCanvas();
    } else if (d.type === 'vertex') {
      const w = M.wireById(state.design, state.sel.id);
      if (w && w.path[d.idx]) {
        const sp = snapPt(p);
        w.path[d.idx] = sp.node ? { x: sp.x, y: sp.y, node: sp.node } : { x: sp.x, y: sp.y };
        refreshCanvas();
      }
    } else if (d.type === 'zone') {
      const sp = state.opts.snap ? snapGrid({ x: p.x + d.dx, y: p.y + d.dy }) : { x: p.x + d.dx, y: p.y + d.dy };
      d.zone.x = sp.x; d.zone.y = sp.y;
      refreshCanvas();
    } else if (d.type === 'zoneNew') {
      state.preview = {
        x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y),
        w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0),
      };
      refreshCanvas();
    } else if (d.type === 'coverAnchor') {
      // 锚点沿所属导线滑动（保持路径锚点语义，改线后仍重算）
      const c = M.coverById(state.design, d.coverId);
      const a = c && c.anchors[d.idx];
      const w = a && M.wireById(state.design, a.wire);
      if (w) {
        const pts = M.resolvePath(state.design, w);
        let acc = 0, bestS = a.s, bestD = Infinity;
        for (let i = 1; i < pts.length; i++) {
          const L = M.dist(pts[i - 1], pts[i]);
          let t = ((p.x - pts[i - 1].x) * (pts[i].x - pts[i - 1].x) + (p.y - pts[i - 1].y) * (pts[i].y - pts[i - 1].y)) / (L * L);
          t = Math.max(0, Math.min(1, t));
          const q = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
          const dd = M.dist(p, q);
          if (dd < bestD) { bestD = dd; bestS = acc + t * L; }
          acc += L;
        }
        a.s = bestS;
        refreshCanvas();
      }
    }
    // 拖接导线端
    if (state.epDrag) {
      state.epDrag.cur = p;
      if (Math.hypot(p.x - state.epDrag.start.x, p.y - state.epDrag.start.y) > 4 / state.view.z) {
        state.epDrag.moved = true;
      }
      refreshCanvas();
    }
    return;
  }
  if (state.drawing) {
    state.drawing.cursor = snapPt(p);
    refreshCanvas();
  }
  if (state.coverDraw) {
    const hit = nearestPathPoint(p);
    state.coverDraw.cursor = hit && hit.d <= COVER_SNAP / Math.min(1, state.view.z) ? hit.point : p;
    refreshCanvas();
  }
});

canvas.addEventListener('pointerup', e => {
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  if (d.type === 'pan' && !d.moved && state.tool === 'select') {
    state.sel = { kind: null, id: null };
    refreshAll();
  }
  if (d.type === 'zoneNew') {
    const r = state.preview;
    state.preview = null;
    if (r && r.w > 3 && r.h > 3) {
      checkpoint();
      const z = M.makeZone(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h),
        '禁布区' + (state.design.zones.length + 1));
      state.design.zones.push(z);
      state.sel = { kind: 'zone', id: z.id };
    }
    refreshAll();
  }
  if (d.type === 'node' || d.type === 'zone' || d.type === 'vertex' || d.type === 'coverAnchor') {
    refreshAll(); // 拖动结束后重算裁线表/检查
  }
  if (d.type === 'ep' && state.epDrag) {
    const ed = state.epDrag;
    state.epDrag = null;
    const w = M.wireById(state.design, ed.wireId);
    const target = ed.moved ? nodeAt(ed.cur) : null;
    if (w && ed.moved) {
      if (target && (target.type === 'connector' || target.type === 'splice')) {
        showPinPicker(target, `把 ${w.label} 的${ed.side === 'from' ? '起' : '终'}端接到`, null, pin => {
          w[ed.side] = { node: target.id, pin };
          const idx = ed.side === 'from' ? 0 : w.path.length - 1;
          w.path[idx] = { x: target.x, y: target.y, node: target.id };
          applySpliceStrip(w, ed.side);
          setStatus(`已把 ${w.label} ${ed.side === 'from' ? '起' : '终'}端接到 ${M.endpointStr(state.design, w[ed.side])}`);
          refreshAll();
        });
      } else {
        setStatus('请拖到连接器或拼接件上以重接该端');
      }
    }
    refreshCanvas();
  }
});

canvas.addEventListener('dblclick', e => {
  if (state.coverDraw) { e.preventDefault(); finishCover(); return; }
  if (state.sel.kind !== 'wire') return;
  const w = M.wireById(state.design, state.sel.id);
  if (!w || w.locked) return;
  const { sx, sy } = eventPos(e);
  const p = toWorld(sx, sy);
  const pts = M.resolvePath(state.design, w);
  const tol = 5 / state.view.z;
  for (let i = 1; i < pts.length; i++) {
    if (M.pointSegDist(p, pts[i - 1], pts[i]) <= tol) {
      checkpoint();
      const sp = snapPt(p, false);
      w.path.splice(i, 0, { x: sp.x, y: sp.y });
      refreshAll();
      return;
    }
  }
});

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (state.coverDraw) { cancelCover(); return; }
  if (state.drawing) { state.drawing = null; setStatus('已取消布线'); refreshCanvas(); return; }
  const { sx, sy } = eventPos(e);
  const p = toWorld(sx, sy);
  const vi = vertexAt(p);
  if (vi > 0) {
    const w = M.wireById(state.design, state.sel.id);
    if (w && w.path.length > 2 && vi < w.path.length - 1) {
      checkpoint();
      w.path.splice(vi, 1);
      refreshAll();
    }
    return;
  }
  if (state.tool !== 'select') setTool('select');
});

function snapGrid(p) {
  const g = state.design.board.grid || 10;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

function finishWire(toNode, toPin) {
  const dr = state.drawing;
  if (!dr) return;
  checkpoint();
  const w = M.makeWire(state.design, dr.from.node, dr.from.pin);
  w.to = { node: toNode.id, pin: toPin };
  w.path = [...dr.pts, { x: toNode.x, y: toNode.y, node: toNode.id }];
  // 落到拼接件的一端：剥线长度默认取拼接件设置
  applySpliceStrip(w, 'from');
  applySpliceStrip(w, 'to');
  state.design.wires.push(w);
  state.drawing = null;
  state.sel = { kind: 'wire', id: w.id };
  setStatus(`已布 ${w.label}：${M.endpointStr(state.design, w.from)} → ${M.endpointStr(state.design, w.to)}，可继续布下一根`);
  refreshAll();
}

// 若导线某端落在拼接件，按拼接件剥线长度回填
function applySpliceStrip(w, side) {
  const sp = M.spliceById(state.design, w[side].node);
  if (sp) w.ends[side].strip = sp.strip;
}

// ---------- 包覆绘制 ----------

const COVER_SNAP = 10; // 吸附到走线的容差（世界坐标，mm，另按缩放放宽）

function addCoverAnchor(hit) {
  const dr = state.coverDraw;
  const tol = COVER_SNAP / Math.min(1, state.view.z);
  if (hit.d > tol) { setStatus(`距走线 ${hit.d.toFixed(0)}mm 太远，请沿连续束段点取包覆起止`); return; }
  const last = dr.anchors[dr.anchors.length - 1];
  if (last && last.wire === hit.wire.id && Math.abs(last.s - hit.s) < 1) return; // 忽略重复点
  if (last) {
    // 连续性：换线时两锚点必须在同一物理位置（分支换线）
    const lp = coverAnchorPoint(last);
    if (hit.wire.id !== last.wire && M.dist(lp, hit.point) > M.COVER_MAX_JUMP) {
      setStatus(`该处与上一锚点相距 ${M.dist(lp, hit.point).toFixed(0)}mm（> ${M.COVER_MAX_JUMP}mm），包覆不能跨越非连续束段`);
      return;
    }
    // 同线回退（点到更靠近起点的位置）忽略，避免自交
    if (hit.wire.id === last.wire && hit.s < last.s - 0.5) {
      setStatus('请沿一个方向点取（退格可撤点）');
      return;
    }
  }
  dr.anchors.push({ wire: hit.wire.id, s: hit.s });
  dr.pts.push(hit.point);
  showCoverBar();
  refreshCanvas();
  setStatus(`包覆路径已取 ${dr.anchors.length} 个锚点：继续沿束段点取，双击或点上方「完成」结束（退格撤点、Esc 取消）`);
}

function coverAnchorPoint(a) {
  const w = M.wireById(state.design, a.wire);
  if (!w) return { x: 0, y: 0 };
  return M.pointAtArcOnPath(M.resolvePath(state.design, w), a.s);
}

function showCoverBar() {
  const dr = state.coverDraw;
  if (!dr) return;
  const kd = M.coverKind(dr.kind);
  const bar = $('coverBar');
  bar.innerHTML = `<span class="prog">${kd.name}包覆绘制</span>
    <span>已取 ${dr.anchors.length} 个路径锚点</span>
    <button id="cvOk" ${dr.anchors.length >= 2 ? '' : 'disabled'}>完成并设置参数</button>
    <button id="cvUndo">撤点</button>
    <button id="cvCancel">取消</button>`;
  bar.classList.remove('hidden');
  $('cvOk').onclick = finishCover;
  $('cvUndo').onclick = () => { if (dr.anchors.length) { dr.anchors.pop(); dr.pts.pop(); showCoverBar(); refreshCanvas(); } };
  $('cvCancel').onclick = cancelCover;
}
function hideCoverBar() { $('coverBar').classList.add('hidden'); $('coverBar').innerHTML = ''; }
function cancelCover() { state.coverDraw = null; hideCoverBar(); refreshCanvas(); setStatus('已取消包覆绘制'); }

function finishCover() {
  const dr = state.coverDraw;
  if (!dr || dr.anchors.length < 2) return setStatus('至少需要起、止两个锚点');
  checkpoint();
  const cover = M.makeCover(state.design, dr.kind, dr.anchors.map(a => ({ wire: a.wire, s: a.s })));
  state.design.covers.push(cover);
  state.coverDraw = null;
  hideCoverBar();
  state.sel = { kind: 'cover', id: cover.id };
  refreshAll();
  setStatus(`已建立${M.coverKind(cover.kind).name}包覆 ${cover.name}，请在属性面板设置材料规格、内径、搭接/节距与收口方式`);
}

// ---------- 工具与快捷键 ----------

const TOOL_HINTS = {
  select: '选择：拖动移动节点/顶点；双击线段加点；右键顶点删点；空白处拖动平移，滚轮缩放',
  connector: '点击画布放置连接器',
  branch: '点击画布放置分支点',
  nail: '点击画布放置固定钉',
  splice: '点击画布放置拼接件（闭端/对接/超声焊）；布线时把导线端接到其孔位',
  zone: '按住拖出禁布区矩形',
  wire: '布线：点击连接器或拼接件选起点孔位 → 点击途经点 → 点击目标选终点孔位',
  cover: '包覆：沿连续束段点击起止位（分支处可换线），双击或点「完成」结束；之后设置材料规格、内径、搭接/节距与收口',
};
function setTool(t, kind) {
  state.tool = t;
  if (t === 'splice' && kind) state.spliceKind = kind;
  if (t === 'cover' && kind) state.coverKind = kind;
  if (t !== 'cover') cancelCover();
  state.drawing = null;
  hidePinPicker();
  document.querySelectorAll('#tools .tool').forEach(b => {
    const on = b.dataset.tool === t &&
      (t !== 'splice' || (b.dataset.kind || 'cap') === state.spliceKind) &&
      (t !== 'cover' || (b.dataset.kind || 'corr') === state.coverKind);
    b.classList.toggle('active', on);
  });
  canvas.classList.toggle('wiretool', t === 'wire' || t === 'splice' || t === 'cover');
  if (t === 'cover') setStatus(`布置${M.coverKind(state.coverKind).name}：沿连续束段点击起、止位（双击/「完成」结束）`);
  else setStatus(t === 'splice' ? `放置${M.spliceKind(state.spliceKind).name}：点击画布；再用布线工具把导线端拖接到孔位` : TOOL_HINTS[t]);
  refreshCanvas();
}

document.querySelectorAll('#tools .tool').forEach(b => (b.onclick = () => setTool(b.dataset.tool, b.dataset.kind)));
$('zoomIn').onclick = () => { const r = wrap.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); };
$('zoomOut').onclick = () => { const r = wrap.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.8); };
$('zoomFit').onclick = fitView;
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;
for (const [id, key] of [['optSnap', 'snap'], ['optBundles', 'showBundles'], ['optTies', 'showTies'], ['optCovers', 'showCovers'], ['optLabels', 'showLabels']]) {
  $(id).onchange = e => { state.opts[key] = e.target.checked; refreshCanvas(); if (key === 'showTies') renderTies(); };
}

document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') {
    if (pinCb) return hidePinPicker();
    if (state.coverDraw) { cancelCover(); return; }
    if (state.drawing) { state.drawing = null; setStatus('已取消布线'); return refreshCanvas(); }
    state.sel = { kind: null, id: null };
    return refreshAll();
  }
  if (e.key === 'Backspace' && state.coverDraw) {
    e.preventDefault();
    if (state.coverDraw.anchors.length) { state.coverDraw.anchors.pop(); state.coverDraw.pts.pop(); showCoverBar(); refreshCanvas(); }
    return;
  }
  if (e.key === 'Enter' && state.coverDraw && state.coverDraw.anchors.length >= 2) { e.preventDefault(); return finishCover(); }
  if (e.key === 'Backspace' && state.drawing) {
    e.preventDefault();
    if (state.drawing.pts.length > 1) state.drawing.pts.pop();
    return refreshCanvas();
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
  const k = e.key.toLowerCase();
  const tools = { v: 'select', j: 'connector', b: 'branch', n: 'nail', z: 'zone', w: 'wire', s: 'splice', c: 'cover' };
  if (tools[k]) return setTool(tools[k], k === 's' ? state.spliceKind : k === 'c' ? state.coverKind : undefined);
  if (e.key.startsWith('Arrow') && state.sel.kind === 'node') {
    const n = M.nodeById(state.design, state.sel.id);
    if (!n) return;
    e.preventDefault();
    const st = (e.shiftKey ? 10 : 1);
    checkpoint();
    n.x += { ArrowLeft: -st, ArrowRight: st }[e.key] || 0;
    n.y += { ArrowUp: -st, ArrowDown: st }[e.key] || 0;
    refreshAll();
  }
});

function deleteSelected() {
  const { kind, id } = state.sel;
  if (!kind) return;
  if (kind === 'wire') {
    const w = M.wireById(state.design, id);
    if (!w) return;
    if (w.locked) return setStatus(`${w.label} 已锁定，请先在属性中解锁`);
    const used = (state.design.covers || []).some(c => c.anchors.some(a => a.wire === id));
    if (used && !confirm(`${w.label} 处于包覆路径上，删除后相关包覆的锚点会悬空（需重取）。仍要删除？`)) return;
    checkpoint();
    state.design.wires = state.design.wires.filter(x => x.id !== id);
  } else if (kind === 'cover') {
    if (!M.coverById(state.design, id)) return;
    checkpoint();
    state.design.covers = state.design.covers.filter(x => x.id !== id);
  } else if (kind === 'zone') {
    checkpoint();
    state.design.zones = state.design.zones.filter(x => x.id !== id);
  } else if (kind === 'node') {
    const n = M.nodeById(state.design, id);
    if (!n) return;
    if (n.type === 'connector') {
      const wired = state.design.wires.some(w => w.from.node === id || w.to.node === id);
      if (wired) return setStatus(`连接器 ${n.name} 上还有导线，请先移除相关导线`);
    }
    const spliceWires = n.type === 'splice'
      ? state.design.wires.filter(w => w.from.node === id || w.to.node === id) : [];
    checkpoint();
    state.design.nodes = state.design.nodes.filter(x => x.id !== id);
    for (const w of state.design.wires) {
      // 删除拼接件：其孔位上的导线端变为悬空（保留路径，端点清空），便于重新拖接
      if (spliceWires.includes(w)) {
        if (w.from.node === id) w.from = { node: null, pin: null };
        if (w.to.node === id) w.to = { node: null, pin: null };
      }
      for (const p of w.path) if (p.node === id) delete p.node; // 路径点退化为自由点
    }
  }
  state.sel = { kind: null, id: null };
  refreshAll();
}

// ---------- 属性面板 ----------

function renderProps() {
  const el = $('panel-prop');
  const d = state.design;
  const { kind, id } = state.sel;

  if (kind === 'node') {
    const n = M.nodeById(d, id);
    if (!n) { state.sel = { kind: null, id: null }; return renderProps(); }

    if (n.type === 'splice') {
      const tname = M.spliceKind(n.kind).name;
      const att = d.wires.reduce((a, w) => {
        for (const side of ['from', 'to']) if (w[side].node === n.id) a.push({ w, side });
        return a;
      }, []);
      const attH = att.map(x =>
        `<span class="attchip" title="${esc(M.endpointStr(d, x.w[x.side === 'from' ? 'to' : 'from']))}">${esc(x.w.label)}#${x.w[x.side].pin}</span>`).join('');
      el.innerHTML = `<h4>${tname} ${esc(n.name)}</h4>
        <div class="grid2">
          <label>名称 <input id="p-name" type="text" value="${esc(n.name)}"></label>
          <label>类型 <select id="p-kind">${M.SPLICE_KINDS.map(k => `<option value="${k.id}" ${k.id === n.kind ? 'selected' : ''}>${k.name}</option>`).join('')}</select></label>
          <label>孔位容量 <input id="p-ports" type="number" min="2" max="24" value="${n.ports}"></label>
          <label>已接 ${att.length} 孔</label>
          <label>适用最小线径 <input id="p-gmin" type="number" min="0.2" step="0.1" value="${n.gaugeMin}"></label>
          <label>适用最大线径 <input id="p-gmax" type="number" min="0.2" step="0.1" value="${n.gaugeMax}"></label>
          <label>剥线长度mm <input id="p-strip" type="number" min="0" step="0.5" value="${n.strip}"></label>
          <label>X <input id="p-x" type="number" value="${n.x}"></label>
          <label>保护套外径mm <input id="p-sd" type="number" min="0" step="0.1" value="${n.sleeveD}"></label>
          <label>Y <input id="p-y" type="number" value="${n.y}"></label>
          <label>保护套长度mm <input id="p-sl" type="number" min="0" step="0.5" value="${n.sleeveLen}"></label>
        </div>
        <div class="row"><span class="hint">接入导线：</span>${attH || '<span class="hint">（无，悬空）</span>'}</div>
        <div class="row btns"><button id="p-del">删除拼接件（导线端转悬空）</button></div>`;
      $('p-name').onchange = e => { checkpoint(); n.name = e.target.value.trim() || n.name; refreshAll(); };
      $('p-kind').onchange = e => { checkpoint(); n.kind = e.target.value; refreshAll(); };
      $('p-ports').onchange = e => {
        const v = Math.max(2, Math.min(24, +e.target.value || 2));
        checkpoint(); n.ports = v;
        // 超出新容量的孔位会在校验中报端口超容
        refreshAll();
      };
      $('p-gmin').onchange = e => { checkpoint(); n.gaugeMin = Math.max(0.1, +e.target.value || 0.5); refreshAll(); };
      $('p-gmax').onchange = e => { checkpoint(); n.gaugeMax = Math.max(0.1, +e.target.value || 3); refreshAll(); };
      $('p-strip').onchange = e => {
        const v = Math.max(0, +e.target.value || 0);
        checkpoint(); n.strip = v;
        // 同步更新接到本件的导线端剥线长度
        for (const w of d.wires) for (const side of ['from', 'to'])
          if (w[side].node === n.id) w.ends[side].strip = v;
        refreshAll();
      };
      $('p-sd').onchange = e => { checkpoint(); n.sleeveD = Math.max(0, +e.target.value || 0); refreshAll(); };
      $('p-sl').onchange = e => { checkpoint(); n.sleeveLen = Math.max(0, +e.target.value || 0); refreshAll(); };
      $('p-x').onchange = e => { checkpoint(); n.x = +e.target.value || 0; refreshAll(); };
      $('p-y').onchange = e => { checkpoint(); n.y = +e.target.value || 0; refreshAll(); };
      $('p-del').onclick = deleteSelected;
      return;
    }

    const tname = { connector: '连接器', branch: '分支点', nail: '固定钉' }[n.type];
    el.innerHTML = `<h4>${tname} ${esc(n.name)}</h4>
      <div class="grid2">
        <label>名称 <input id="p-name" type="text" value="${esc(n.name)}"></label>
        ${n.type === 'connector' ? `<label>针数 <input id="p-pins" type="number" min="1" max="64" value="${n.pins || 4}"></label>` : ''}
        <label>X <input id="p-x" type="number" value="${n.x}"></label>
        <label>Y <input id="p-y" type="number" value="${n.y}"></label>
      </div>
      <div class="row btns"><button id="p-del">删除</button></div>`;
    $('p-name').onchange = e => { checkpoint(); n.name = e.target.value.trim() || n.name; refreshAll(); };
    if (n.type === 'connector') $('p-pins').onchange = e => { checkpoint(); n.pins = Math.max(1, Math.min(64, +e.target.value || 4)); refreshAll(); };
    $('p-x').onchange = e => { checkpoint(); n.x = +e.target.value || 0; refreshAll(); };
    $('p-y').onchange = e => { checkpoint(); n.y = +e.target.value || 0; refreshAll(); };
    $('p-del').onclick = deleteSelected;
    return;
  }

  if (kind === 'zone') {
    const z = M.zoneById(d, id);
    if (!z) { state.sel = { kind: null, id: null }; return renderProps(); }
    el.innerHTML = `<h4>禁布区 ${esc(z.name)}</h4>
      <div class="grid2">
        <label>名称 <input id="p-name" type="text" value="${esc(z.name)}"></label>
        <label>X <input id="p-x" type="number" value="${z.x}"></label>
        <label>Y <input id="p-y" type="number" value="${z.y}"></label>
        <label>宽 <input id="p-w" type="number" min="1" value="${z.w}"></label>
        <label>高 <input id="p-h" type="number" min="1" value="${z.h}"></label>
      </div>
      <div class="row btns"><button id="p-del">删除</button></div>`;
    $('p-name').onchange = e => { checkpoint(); z.name = e.target.value; refreshAll(); };
    $('p-x').onchange = e => { checkpoint(); z.x = +e.target.value || 0; refreshAll(); };
    $('p-y').onchange = e => { checkpoint(); z.y = +e.target.value || 0; refreshAll(); };
    $('p-w').onchange = e => { checkpoint(); z.w = Math.max(1, +e.target.value || 1); refreshAll(); };
    $('p-h').onchange = e => { checkpoint(); z.h = Math.max(1, +e.target.value || 1); refreshAll(); };
    $('p-del').onclick = deleteSelected;
    return;
  }

  if (kind === 'wire') {
    const w = M.wireById(d, id);
    if (!w) { state.sel = { kind: null, id: null }; return renderProps(); }
    const c = M.cutInfo(d, w);
    const conns = d.nodes.filter(n => n.type === 'connector' || n.type === 'splice');
    const connOpts = sel => conns.map(n => {
      const tag = n.type === 'splice' ? `〔${M.spliceKind(n.kind).short}〕` : '';
      return `<option value="${n.id}" ${n.id === sel ? 'selected' : ''}>${tag}${esc(n.name)}</option>`;
    }).join('');
    const pinOpts = (nodeId, sel) => {
      const n = M.nodeById(d, nodeId);
      if (!n) return '';
      const m = n.type === 'splice' ? Math.max(2, n.ports || 4) : (n.pins || 4);
      let h = '';
      for (let i = 1; i <= m; i++) h += `<option ${i === sel ? 'selected' : ''}>${i}</option>`;
      return h;
    };
    el.innerHTML = `<h4>导线 ${esc(w.label)} ${w.locked ? '🔒' : ''}</h4>
      <div class="grid2">
        <label>线号 <input id="w-label" type="text" value="${esc(w.label)}"></label>
        <label>线径 <select id="w-gauge">${M.GAUGES.map(g => `<option value="${g.d}" ${g.d === w.gauge ? 'selected' : ''}>${g.label}</option>`).join('')}</select></label>
      </div>
      <div class="row"><span>颜色</span><span class="swatch" id="w-color">${M.WIRE_COLORS.map(([c, nm]) => `<button data-c="${c}" title="${nm}" class="${c === w.color ? 'cur' : ''}" style="background:${c}"></button>`).join('')}</span></div>
      <div class="grid2">
        <label>起点 <select id="w-from-node">${connOpts(w.from.node)}</select></label>
        <label>端子/孔 <select id="w-from-pin">${pinOpts(w.from.node, w.from.pin)}</select></label>
        <label>终点 <select id="w-to-node">${connOpts(w.to.node)}</select></label>
        <label>端子/孔 <select id="w-to-pin">${pinOpts(w.to.node, w.to.pin)}</select></label>
      </div>
      <div class="sub">端头处理（起 / 讫）</div>
      <div class="grid2">
        <label>剥线mm <input id="w-strip-f" type="number" min="0" step="0.5" value="${w.ends.from.strip}"> / <input id="w-strip-t" type="number" min="0" step="0.5" value="${w.ends.to.strip}"></label>
        <label>维修余量 <input id="w-svc-f" type="number" min="0" value="${w.ends.from.service}"> / <input id="w-svc-t" type="number" min="0" value="${w.ends.to.service}"></label>
        <label>压接(起) <input id="w-crimp-f" type="text" value="${esc(w.ends.from.crimp)}" placeholder="端子型号"></label>
        <label>压接(讫) <input id="w-crimp-t" type="text" value="${esc(w.ends.to.crimp)}" placeholder="端子型号"></label>
      </div>
      <div class="leninfo">路径 ${c.path.toFixed(1)}mm ＋ 余量 ${c.svc}mm ＋ 剥线 ${c.strip}mm ＝ 裁线 <b>${c.cut.toFixed(1)}mm</b>（建议 ${c.rounded}mm）</div>
      <div class="row">
        <label class="chk"><input type="checkbox" id="w-lock" ${w.locked ? 'checked' : ''}> 锁定（不重排、不可编辑）</label>
      </div>
      <div class="row btns"><button id="w-del">删除导线</button></div>`;
    $('w-label').onchange = e => { checkpoint(); w.label = e.target.value.trim() || w.label; refreshAll(); };
    $('w-gauge').onchange = e => { checkpoint(); w.gauge = +e.target.value; refreshAll(); };
    $('w-color').querySelectorAll('button').forEach(b => (b.onclick = () => { checkpoint(); w.color = b.dataset.c; refreshAll(); }));
    const rebind = side => {
      checkpoint();
      const nodeId = $(`w-${side}-node`).value;
      const pin = +$(`w-${side}-pin`).value;
      w[side] = { node: nodeId, pin };
      const n = M.nodeById(d, nodeId);
      const idx = side === 'from' ? 0 : w.path.length - 1;
      if (n) w.path[idx] = { x: n.x, y: n.y, node: nodeId };
      applySpliceStrip(w, side);
      refreshAll();
    };
    $('w-from-node').onchange = () => { const sel = $('w-from-pin'); sel.innerHTML = pinOpts($('w-from-node').value, 1); rebind('from'); };
    $('w-to-node').onchange = () => { const sel = $('w-to-pin'); sel.innerHTML = pinOpts($('w-to-node').value, 1); rebind('to'); };
    $('w-from-pin').onchange = () => rebind('from');
    $('w-to-pin').onchange = () => rebind('to');
    $('w-strip-f').onchange = e => { checkpoint(); w.ends.from.strip = Math.max(0, +e.target.value || 0); refreshAll(); };
    $('w-strip-t').onchange = e => { checkpoint(); w.ends.to.strip = Math.max(0, +e.target.value || 0); refreshAll(); };
    $('w-svc-f').onchange = e => { checkpoint(); w.ends.from.service = Math.max(0, +e.target.value || 0); refreshAll(); };
    $('w-svc-t').onchange = e => { checkpoint(); w.ends.to.service = Math.max(0, +e.target.value || 0); refreshAll(); };
    $('w-crimp-f').onchange = e => { checkpoint(); w.ends.from.crimp = e.target.value; refreshAll(); };
    $('w-crimp-t').onchange = e => { checkpoint(); w.ends.to.crimp = e.target.value; refreshAll(); };
    $('w-lock').onchange = e => { checkpoint(); w.locked = e.target.checked; refreshAll(); };
    $('w-del').onclick = deleteSelected;
    return;
  }

  if (kind === 'cover') return renderCoverProps();

  // 未选中：钉板与校验参数
  const b = d.board, s = d.settings;
  el.innerHTML = `<h4>钉板与参数</h4>
    <div class="grid2">
      <label>板宽mm <input id="b-w" type="number" min="100" value="${b.width}"></label>
      <label>板高mm <input id="b-h" type="number" min="100" value="${b.height}"></label>
      <label>网格mm <input id="b-g" type="number" min="1" value="${b.grid}"></label>
      <label>裁线取整mm <input id="s-round" type="number" min="1" value="${s.roundTo}"></label>
      <label>束径填充系数 <input id="s-pack" type="number" min="1" step="0.05" value="${s.packFactor}"></label>
      <label>弯曲半径倍数 <input id="s-bend" type="number" min="1" step="0.5" value="${s.bendFactor}"></label>
      <label>最小余量% <input id="s-slack" type="number" min="0" step="0.5" value="${s.minSlackPct}"></label>
      <label>最小维修余量 <input id="s-svc" type="number" min="0" value="${s.minService}"></label>
      <label>绑扎间距mm <input id="s-tsp" type="number" min="20" value="${s.tieSpacing}"></label>
      <label>分支绑扎偏移 <input id="s-toff" type="number" min="1" value="${s.tieOffset}"></label>
    </div>
    <p class="hint">共 ${d.nodes.filter(n=>n.type==='connector').length} 个连接器、${d.nodes.filter(n=>n.type==='splice').length} 个拼接件、${d.wires.length} 根导线、${d.zones.length} 个禁布区。点击画布对象可编辑其属性。</p>`;
  const bind = (id, fn) => ($(id).onchange = e => { checkpoint(); fn(+e.target.value); refreshAll(); });
  bind('b-w', v => { b.width = Math.max(100, v || 100); });
  bind('b-h', v => { b.height = Math.max(100, v || 100); });
  bind('b-g', v => { b.grid = Math.max(1, v || 10); });
  bind('s-round', v => { s.roundTo = Math.max(1, v || 5); });
  bind('s-pack', v => { s.packFactor = Math.max(1, v || 1.2); });
  bind('s-bend', v => { s.bendFactor = Math.max(1, v || 3); });
  bind('s-slack', v => { s.minSlackPct = Math.max(0, v || 0); });
  bind('s-svc', v => { s.minService = Math.max(0, v || 0); });
  bind('s-tsp', v => { s.tieSpacing = Math.max(20, v || 150); });
  bind('s-toff', v => { s.tieOffset = Math.max(1, v || 15); });
}

// ---------- 包覆属性面板 ----------

function renderCoverProps() {
  const el = $('panel-prop');
  const d = state.design;
  const c = M.coverById(d, state.sel.id);
  if (!c) { state.sel = { kind: null, id: null }; return renderProps(); }
  const geo = M.coverGeometry(d, c);
  const cut = M.coverCutInfo(d, c, geo);
  const issues = M.validate(d).filter(i => i.cover === c.id);
  const kd = M.coverKind(c.kind);
  const locRows = c.anchors.map((a, i) => {
    const w = M.wireById(d, a.wire);
    const tail = i === 0 ? '起' : i === c.anchors.length - 1 ? '止' : '#' + (i + 1);
    return `<tr><td>${tail}</td><td class="l">${w ? esc(w.label) : '<span style="color:#c62828">导线缺失</span>'}</td><td>${(+a.s || 0).toFixed(0)}</td></tr>`;
  }).join('');
  const isTape = c.kind === 'tape';
  el.innerHTML = `<h4>${kd.glyph} ${kd.name} ${esc(c.name)}</h4>
    <div class="grid2">
      <label>名称 <input id="c-name" type="text" value="${esc(c.name)}"></label>
      <label>类型 <select id="c-kind">${M.COVER_KINDS.map(k => `<option value="${k.id}" ${k.id === c.kind ? 'selected' : ''}>${k.name}</option>`).join('')}</select></label>
      <label colspan="2">材料规格 <input id="c-spec" type="text" style="width:100%" value="${esc(c.spec)}" placeholder="如 PA阻燃波纹管 / PVC胶带"></label>
      ${isTape ? '' : `<label>内径mm <input id="c-id" type="number" min="0" step="0.5" value="${c.innerD}"></label>
        <label>层次 <input id="c-layer" type="number" min="1" max="9" value="${c.layer}"></label>
        <label>接头搭接mm <input id="c-overlap" type="number" min="0" step="1" value="${c.overlap}"></label>`}
      ${isTape ? `<label>胶带宽mm <input id="c-tapew" type="number" min="1" step="0.5" value="${c.tapeW}"></label>
        <label>缠绕节距mm <input id="c-pitch" type="number" min="0.5" step="0.5" value="${c.pitch}"></label>
        <label>搭接率% <input id="c-ovpct" type="number" min="0" max="90" step="5" value="${c.overlap}"></label>` : ''}
      <label>分支收口 <select id="c-close">${M.COVER_CLOSE.map(x => `<option value="${x.id}" ${x.id === c.branchClose ? 'selected' : ''}>${x.name}</option>`).join('')}</select></label>
    </div>
    <div class="leninfo">
      路径长 <b>${geo.length.toFixed(0)}mm</b> · 最大束径 ⌀${geo.maxD.toFixed(1)} ·
      ${isTape
        ? `有效节距 ${cut.pitch.toFixed(1)}mm · 用带 <b>${cut.cut.toFixed(0)}mm</b>（${(cut.cut / 1000).toFixed(2)}m）`
        : `弯头累计 ${cut.bendDeg.toFixed(0)}° · 下料 <b>${cut.rounded}mm</b>`}
    </div>
    <table class="list"><thead><tr><th>锚点</th><th class="l">导线</th><th>弧长mm</th></tr></thead><tbody>${locRows}</tbody></table>
    <p class="hint">起止：${esc(M.coverLocateText(d, c, 0))} → ${esc(M.coverLocateText(d, c, c.anchors.length - 1))}。拖动画布上的黄色锚点可沿线改位，改线后按路径锚点重算。</p>
    ${issues.length ? `<div class="sub">本段问题</div>${issues.map(i =>
      `<div class="issue ${i.level}">${{ error: '⛔', warn: '⚠️', info: 'ℹ️' }[i.level]} ${esc(i.msg)}</div>`).join('')}` : '<div class="okline">✓ 本段校验通过</div>'}
    <div class="row btns"><button id="c-del">删除包覆</button></div>`;
  $('c-name').onchange = e => { checkpoint(); c.name = e.target.value.trim() || c.name; refreshAll(); };
  $('c-kind').onchange = e => {
    checkpoint(); c.kind = e.target.value;
    if (c.kind === 'tape') { c.overlap = 50; c.pitch = c.pitch || 12; c.tapeW = c.tapeW || 19; }
    else if (!(c.innerD > 0)) { const g = M.coverGeometry(d, c); c.innerD = Math.ceil((g.maxD + 1) * 2) / 2; }
    refreshAll();
  };
  $('c-spec').onchange = e => { checkpoint(); c.spec = e.target.value; refreshAll(); };
  $('c-close').onchange = e => { checkpoint(); c.branchClose = e.target.value; refreshAll(); };
  if (!isTape) {
    $('c-id').onchange = e => { checkpoint(); c.innerD = Math.max(0, +e.target.value || 0); refreshAll(); };
    $('c-layer').onchange = e => { checkpoint(); c.layer = Math.max(1, Math.min(9, +e.target.value || 1)); refreshAll(); };
    $('c-overlap').onchange = e => { checkpoint(); c.overlap = Math.max(0, +e.target.value || 0); refreshAll(); };
  } else {
    $('c-tapew').onchange = e => { checkpoint(); c.tapeW = Math.max(1, +e.target.value || 19); refreshAll(); };
    $('c-pitch').onchange = e => { checkpoint(); c.pitch = Math.max(0.5, +e.target.value || 12); refreshAll(); };
    $('c-ovpct').onchange = e => { checkpoint(); c.overlap = Math.max(0, Math.min(90, +e.target.value || 0)); refreshAll(); };
  }
  $('c-del').onclick = deleteSelected;
}

// ---------- 检查面板 ----------

function renderChecks() {
  const el = $('panel-check');
  const issues = M.validate(state.design);
  const nErr = issues.filter(i => i.level === 'error').length;
  const nWarn = issues.filter(i => i.level === 'warn').length;
  const badge = $('checkBadge');
  if (nErr + nWarn) {
    badge.textContent = nErr + nWarn;
    badge.classList.remove('hidden');
    badge.style.background = nErr ? '#c62828' : '#f9a825';
  } else badge.classList.add('hidden');
  if (!issues.length) {
    el.innerHTML = `<div class="okline">✓ 未发现问题：束径、弯曲半径、禁布区、端子占用、余量、接线表均通过。</div>`;
    return;
  }
  el.innerHTML = issues.map((it, i) =>
    `<div class="issue ${it.level}" data-i="${i}">${{ error: '⛔', warn: '⚠️', info: 'ℹ️' }[it.level]} ${esc(it.msg)}</div>`
  ).join('');
  el.querySelectorAll('.issue').forEach(div => {
    div.onclick = () => {
      const it = issues[+div.dataset.i];
      if (it.cover) {
        state.sel = { kind: 'cover', id: it.cover };
        const c = M.coverById(state.design, it.cover);
        if (c) {
          const g = M.coverGeometry(state.design, c);
          if (g.pts.length) centerOn({ x: g.pts[0].x, y: g.pts[0].y });
        }
        refreshAll();
        return;
      }
      if (it.wire) state.sel = { kind: 'wire', id: it.wire };
      else if (it.node) state.sel = { kind: 'node', id: it.node };
      else if (it.zone) state.sel = { kind: 'zone', id: it.zone };
      const w = it.wire && M.wireById(state.design, it.wire);
      if (w) {
        const pts = M.resolvePath(state.design, w);
        centerOn(pts[Math.floor(pts.length / 2)]);
      } else if (it.node) {
        const n = M.nodeById(state.design, it.node);
        if (n) centerOn(n);
      } else if (it.zone) {
        const z = M.zoneById(state.design, it.zone);
        if (z) centerOn({ x: z.x + z.w / 2, y: z.y + z.h / 2 });
      }
      refreshAll();
    };
  });
}

// ---------- 裁线面板 ----------

function renderCuts() {
  const el = $('panel-cut');
  const rows = M.cutList(state.design);
  if (!rows.length) { el.innerHTML = '<p class="hint">尚未布线。</p>'; return; }
  let h = `<div class="row btns"><button id="csvBtn">下载裁线表 CSV</button></div>
    <table class="list"><thead><tr>
      <th class="l">线号</th><th>颜色</th><th>线径</th><th class="l">起→讫</th>
      <th>路径</th><th>余量</th><th>剥线</th><th>裁线</th><th>建议</th>
    </tr></thead><tbody>`;
  for (const r of rows) {
    h += `<tr data-w="${r.id}" class="${state.sel.kind === 'wire' && state.sel.id === r.id ? 'cur' : ''}">
      <td class="l">${esc(r.label)}${r.locked ? ' 🔒' : ''}</td>
      <td><span class="colorchip" style="background:${r.color}"></span></td>
      <td>⌀${r.gauge}</td><td class="l">${esc(r.from)}→${esc(r.to)}</td>
      <td>${r.path.toFixed(0)}</td><td>${r.svc}</td><td>${r.stripFrom}/${r.stripTo}</td>
      <td>${r.cut.toFixed(0)}</td><td><b>${r.rounded}</b></td></tr>`;
  }
  h += `</tbody></table>`;
  // 包覆下料表
  const covers = M.coverList(state.design);
  if (covers.length) {
    h += `<h4>包覆下料（波纹管 / 编织管 / 胶带）</h4><table class="list"><thead><tr>
      <th class="l">编号</th><th class="l">材料</th><th class="l">规格</th><th>内径</th><th>束径max</th>
      <th>路径</th><th>下料/用带</th><th class="l">起 → 止</th><th>状态</th></tr></thead><tbody>`;
    for (const cv of covers) {
      const bad = cv.broken || cv.dangling;
      h += `<tr data-cv="${cv.id}" style="cursor:pointer" class="${state.sel.kind === 'cover' && state.sel.id === cv.id ? 'cur' : ''}">
        <td class="l"><b>${esc(cv.glyph)}${esc(cv.name)}</b><br><span style="color:#888;font-size:10px">${esc(cv.kindName)}·${cv.layer}层</span></td>
        <td class="l">${esc(cv.kindName)}</td>
        <td class="l">${esc(cv.spec || '—')}</td>
        <td>${cv.kind === 'tape' ? '—' : '⌀' + cv.innerD}</td>
        <td>⌀${cv.maxD.toFixed(1)}</td>
        <td>${cv.length.toFixed(0)}</td>
        <td><b>${cv.kind === 'tape' ? cv.cut.toFixed(0) + 'mm' : cv.rounded + 'mm'}</b></td>
        <td class="l" style="white-space:normal">${esc(cv.start)} → ${esc(cv.end)}</td>
        <td>${bad ? '⚠️' : '✓'}</td></tr>`;
    }
    h += `</tbody></table>`;
    const cmats = M.coverMaterialSummary(state.design);
    if (cmats.length) {
      h += `<h4>包覆用料汇总</h4><table class="list"><thead><tr><th class="l">材料</th><th class="l">规格/参数</th><th>段数</th><th>总量</th></tr></thead><tbody>`;
      for (const m of cmats) {
        h += `<tr><td class="l">${esc(m.name)}</td>
          <td class="l">${m.kind === 'tape'
            ? esc(m.spec) + ` 宽${m.width} 节距${m.pitch.toFixed(1)}`
            : esc(m.spec) + ` ⌀${m.innerD}`}</td>
          <td>${m.count}</td><td><b>${(m.total / 1000).toFixed(2)} m</b></td></tr>`;
      }
      h += `</tbody></table>`;
    }
  }
  const spl = M.spliceList(state.design);
  if (spl.length) {
    h += `<h4>拼接件（集线→压接→套管）</h4><table class="list"><thead><tr>
      <th class="l">拼接件</th><th class="l">类型</th><th>孔位/已接</th><th class="l">适用/实配</th>
      <th>剥线</th><th>保护套</th><th class="l">接入线号#孔</th></tr></thead><tbody>`;
    for (const s of spl) {
      const wires = s.wires.map(x => `${x.wire.label}#${x.pin}`).join('、');
      h += `<tr data-sp="${s.id}" style="cursor:pointer">
        <td class="l"><b>${esc(s.name)}</b></td><td class="l">${esc(s.kindName)}</td>
        <td>${s.ports}/${s.count}</td><td class="l">⌀${s.gaugeMin}~⌀${s.gaugeMax}｜${esc(s.gaugeRange)}</td>
        <td>${s.strip}</td><td>${s.sleeveD ? '⌀' + s.sleeveD + '×' + s.sleeveLen : '—'}</td>
        <td class="l">${esc(wires)}</td></tr>`;
    }
    h += `</tbody></table>`;
  }
  h += `<h4>用料汇总（按建议裁线）</h4><table class="list"><thead><tr><th class="l">线径</th><th class="l">颜色</th><th>根数</th><th>总长</th></tr></thead><tbody>`;
  for (const g of M.materialSummary(state.design)) {
    g.colors.forEach((c, i) => {
      h += `<tr>${i === 0 ? `<td class="l" rowspan="${g.colors.length}">⌀${g.gauge}mm</td>` : ''}
        <td class="l"><span class="colorchip" style="background:${c.color}"></span></td>
        <td>${c.count}</td><td>${(c.total / 1000).toFixed(2)} m</td></tr>`;
    });
  }
  h += `</tbody></table><p class="hint">裁线长 = 路径长 + 两端维修余量 + 两端剥线；建议值按设定向上取整。</p>`;
  el.innerHTML = h;
  $('csvBtn').onclick = () => IO.download(state.design.name + '-裁线表.csv', IO.cutListCSV(state.design), 'text/csv;charset=utf-8');
  el.querySelectorAll('tr[data-sp]').forEach(tr => (tr.onclick = () => {
    state.sel = { kind: 'node', id: tr.dataset.sp };
    const n = M.nodeById(state.design, tr.dataset.sp);
    if (n) centerOn(n);
    refreshAll();
  }));
  el.querySelectorAll('tr[data-w]').forEach(tr => (tr.onclick = () => {
    state.sel = { kind: 'wire', id: tr.dataset.w };
    const w = M.wireById(state.design, tr.dataset.w);
    if (w) { const pts = M.resolvePath(state.design, w); centerOn(pts[Math.floor(pts.length / 2)]); }
    refreshAll();
  }));
  el.querySelectorAll('tr[data-cv]').forEach(tr => (tr.onclick = () => {
    state.sel = { kind: 'cover', id: tr.dataset.cv };
    const g = M.coverGeometry(state.design, M.coverById(state.design, tr.dataset.cv));
    if (g.pts.length) centerOn({ x: g.pts[0].x, y: g.pts[0].y });
    refreshAll();
  }));
}

// ---------- 绑扎面板 ----------

function renderTies() {
  const el = $('panel-tie');
  const ties = M.tieList(state.design);
  if (!ties.length) { el.innerHTML = '<p class="hint">暂无绑扎点：需要分支点或超长的多线束段。</p>'; return; }
  let h = `<p class="hint">绑扎位置已在画布上用橙色 × 标出（顶栏「绑扎点」开关）。</p>
    <table class="list"><thead><tr><th>#</th><th class="l">位置</th><th>X</th><th>Y</th></tr></thead><tbody>`;
  ties.forEach((t, i) => {
    h += `<tr><td>T${i + 1}</td><td class="l">${esc(t.desc)}</td><td>${t.x.toFixed(0)}</td><td>${t.y.toFixed(0)}</td></tr>`;
  });
  el.innerHTML = h + '</tbody></table>';
}

// ---------- 装配面板与逐步推演 ----------

function renderAsm() {
  const el = $('panel-asm');
  const order = M.assemblyOrder(state.design);
  if (!order.length) { el.innerHTML = '<p class="hint">尚未布线。</p>'; return; }
  const st = state.step;
  const steps = st ? st.steps : M.assemblySteps(state.design, new Set());
  let h = `<div class="row btns">
    ${st && st.active
      ? `<button id="asmStop">退出逐步推演</button>`
      : `<button id="asmStart">开始逐步推演</button>
         <label class="chk"><input type="checkbox" id="asmLock" checked> 送线确认后锁定</label>`}
    <button id="asmTidy" title="移除共线冗余点并吸附就近节点，锁定导线不受影响">重排未锁定路径</button>
  </div>`;
  h += '<div>' + steps.map((s, i) => {
    let cls = '', body = '';
    if (st && st.active) {
      if (s.kind === 'wire') cls = st.confirmed.has(s.wireId) ? 'done' : st.idx === i ? 'cur' : '';
      else if (s.kind === 'splice') cls = st.spliceDone.has(s.spliceId) ? 'done' : st.idx === i ? 'cur' : '';
      else cls = st.coverDone.has(`${s.coverId}:${s.phase}`) ? 'done' : st.idx === i ? 'cur' : '';
    }
    if (s.kind === 'wire') {
      const w = M.wireById(state.design, s.wireId);
      body = `<span class="no">${i + 1}</span>
        <span class="colorchip" style="background:${w ? w.color : '#999'}"></span>
        <span class="asmname">${esc(s.label)}${s.locked ? ' 🔒' : ''}</span>
        <span style="color:#777">${s.length.toFixed(0)}mm</span>
        <span style="color:#999;font-size:11px">主干 ${s.shared.toFixed(0)}mm</span>`;
    } else if (s.kind === 'cover') {
      const kd = M.coverKind(s.cover.kind);
      body = `<span class="no">${i + 1}</span>
        <span class="covertag" style="border-color:${kd.color};color:${kd.color}">${kd.glyph}</span>
        <span class="asmname">${esc(s.label)}</span>
        ${s.blocked ? '<span style="color:#c62828;font-size:11px">压接前预套</span>' : ''}
        <span style="color:#888;font-size:11px">${s.phaseName}</span>`;
    } else {
      const kd = M.spliceKind(s.splice.kind);
      let statusH;
      if (st && st.active) {
        // 推演中：实时统计已就位导线数
        const live = s.attaches.filter(a => st.confirmed.has(a.wire.id)).length;
        const ready = s.count >= 2 && live === s.count;
        statusH = `<span style="color:#${ready ? '2e7d32' : 'c62828'};font-size:11px">${live}/${s.count} 线就位</span>`;
      } else {
        // 尚未开始推演：只显示待接线数，不访问可能为 null 的 step
        statusH = `<span style="color:#888;font-size:11px">${s.count} 线待接</span>`;
      }
      body = `<span class="no">${i + 1}</span>
        <span class="splicetag">${kd.short}</span>
        <span class="asmname">${esc(s.label)}（集线→压接→套管）</span>
        ${statusH}`;
    }
    const dataAttr = s.kind === 'wire' ? `data-w="${s.wireId}"`
      : s.kind === 'cover' ? `data-cover-step="${i}"`
      : `data-sp="${s.spliceId}"`;
    return `<div class="asmitem ${cls}" ${dataAttr}>${body}</div>`;
  }).join('') + '</div>';
  h += '<p class="hint">先逐根送线（主干优先）；穿不过已装端头的套管在压接前裁套/预套；再按拼接件压接，随后套装、收口、缠带逐项确认。</p>';
  el.innerHTML = h;
  if (st && st.active) $('asmStop').onclick = stopStep;
  else {
    const btn = $('asmStart');
    if (btn) btn.onclick = startStep;
  }
  $('asmTidy').onclick = () => {
    checkpoint();
    const n = M.tidyDesign(state.design);
    setStatus(n ? `已整理 ${n} 处（锁定导线已跳过）` : '无需整理');
    refreshAll();
  };
  el.querySelectorAll('.asmitem').forEach(div => (div.onclick = () => {
    if (div.dataset.w) { state.sel = { kind: 'wire', id: div.dataset.w }; refreshAll(); }
    else if (div.dataset.sp) { state.sel = { kind: 'node', id: div.dataset.sp }; refreshAll(); }
    else if (div.dataset.coverStep !== undefined && state.step && state.step.active) {
      selectStep(+div.dataset.coverStep); refreshAll();
    }
  }));
}

function startStep() {
  const confirmed = new Set(state.design.wires.filter(w => w.locked).map(w => w.id));
  const steps = M.assemblySteps(state.design, confirmed);
  if (!steps.some(s => s.kind === 'wire')) return;
  checkpoint(); // 推演中的锁定可一次撤销
  state.step = {
    active: true, steps, idx: 0,
    confirmed, spliceDone: new Set(), coverDone: new Set(),
    locks: new Set(state.design.wires.filter(w => w.locked).map(w => w.id)),
    lock: $('asmLock') ? $('asmLock').checked : true,
  };
  setTool('select');
  selectStep(0);
  $('stepBar').classList.remove('hidden');
  setStatus('逐步推演：送线 →（必要时压接前预套）→ 拼接压接 → 套装/收口/缠带确认');
  refreshAll();
}
function stopStep() {
  state.step = null;
  $('stepBar').classList.add('hidden');
  setStatus('已退出逐步推演');
  refreshAll();
}
function selectStep(i) {
  const st = state.step;
  st.idx = Math.max(0, Math.min(st.steps.length - 1, i));
  const s = st.steps[st.idx];
  if (s.kind === 'wire') {
    state.sel = { kind: 'wire', id: s.wireId };
    const w = M.wireById(state.design, s.wireId);
    if (w) { const pts = M.resolvePath(state.design, w); centerOn(pts[Math.floor(pts.length / 2)]); }
  } else if (s.kind === 'cover') {
    state.sel = { kind: 'cover', id: s.coverId };
    const m = s.geo && s.geo.pts[Math.floor(s.geo.pts.length / 2)];
    if (m) centerOn(m);
  } else {
    state.sel = { kind: 'node', id: s.spliceId };
    centerOn(s.splice);
  }
}
function renderStepBar() {
  const st = state.step;
  const bar = $('stepBar');
  if (!st || !st.active) { bar.classList.add('hidden'); return; }
  const d = state.design;
  const s = st.steps[st.idx];
  if (!s) { stopStep(); return; }

  if (s.kind === 'wire') {
    const w = M.wireById(d, s.wireId);
    if (!w) { stopStep(); return; }
    const c = M.cutInfo(d, w);
    const nails = M.resolvePath(d, w).filter(p => p.node).map(p => M.nodeName(d, p.node));
    bar.innerHTML = `<span class="prog">送线 第 ${st.idx + 1}/${st.steps.length} 步</span>
      <span class="cur"><span class="colorchip" style="background:${w.color}"></span> ${esc(w.label)}</span>
      <span>${esc(M.endpointStr(d, w.from))} → ${esc(M.endpointStr(d, w.to))} · ⌀${w.gauge} · 裁线 ${c.rounded}mm</span>
      <span style="color:#666">途经：${nails.map(esc).join(' → ')}</span>
      <button id="stPrev" ${st.idx === 0 ? 'disabled' : ''}>上一步</button>
      <button id="stOk">确认送线并推进</button>
      <button id="stExit">退出</button>`;
    $('stOk').onclick = () => {
      st.confirmed.add(w.id);
      if (st.lock) w.locked = true;
      advance();
    };
  } else if (s.kind === 'splice') {
    const sp = s.splice;
    const kd = M.spliceKind(sp.kind);
    // 实时重算就位情况（导线可能在本步骤之前刚确认）
    s.doneWires = s.attaches.filter(a => st.confirmed.has(a.wire.id)).length;
    s.ready = s.count >= 2 && s.doneWires === s.count;
    if (st.phaseStep !== st.idx) { st.phase = 0; st.phaseStep = st.idx; }
    const issues = M.validate(d).filter(i => i.node === sp.id && i.level === 'error');
    const labels = s.attaches.map(a =>
      `${a.wire.label}#${a.wire[a.side].pin}（⌀${a.wire.gauge}）`).join('、');
    const sleeve = sp.sleeveD > 0 ? `⌀${sp.sleeveD}×${sp.sleeveLen}mm` : '无套管';
    bar.innerHTML = `<span class="prog">拼接 第 ${st.idx + 1}/${st.steps.length} 步</span>
      <span class="cur">${kd.glyph} ${kd.name} ${esc(sp.name)}</span>
      <span style="color:#${s.ready ? '2e7d32' : 'c62828'}">就位 ${s.doneWires}/${s.count} 根</span>
      <span style="color:#666">孔位：${esc(labels)} · 剥线${sp.strip}mm · 套${esc(sleeve)}</span>
      <button id="stPrev" ${st.idx === 0 ? 'disabled' : ''}>上一步</button>
      <button id="stGather">集线确认</button>
      <button id="stCrimp">压接确认</button>
      <button id="stSleeve">套管确认</button>
      <button id="stOk" ${s.ready && !issues.length ? '' : 'disabled'} title="${issues.length ? '该拼接件存在校验错误' : '导线未接齐'}">完成拼接并推进</button>
      <button id="stExit">退出</button>`;
    $('stGather').onclick = () => { st.phase = Math.max(st.phase || 0, 1); setStatus(`已集线：核对 ${labels}`); };
    $('stCrimp').onclick = () => {
      if ((st.phase || 0) < 1) return setStatus('请先确认集线');
      // 穿不过已装端头的套管：其裁套/预套必须已确认，才能压接
      const pending = (s.preCovers || []).filter(c =>
        !st.coverDone.has(`${c.id}:preslip`) || !st.coverDone.has(`${c.id}:cut`));
      if (pending.length) {
        return setStatus(`压接前请先完成套管预套：${pending.map(c => M.coverKind(c.kind).name + ' ' + c.name).join('、')}（裁套/预套步骤在本件之前）`);
      }
      st.phase = 2; setStatus(`${sp.name} 已${sp.kind === 'ultra' ? '超声焊接' : '压接'}`);
    };
    $('stSleeve').onclick = () => {
      if ((st.phase || 0) < 2) return setStatus('请先确认压接');
      st.phase = 3; setStatus(sp.sleeveD > 0 ? `保护套已就位（${sleeve}），热缩确认` : '该件无保护套，确认完成');
    };
    $('stOk').onclick = () => {
      if (!s.ready || issues.length) { setStatus('未接齐或存在校验错误，不得完成拼接'); return; }
      st.spliceDone.add(sp.id);
      st.phase = 0;
      advance();
    };
  } else if (s.kind === 'cover') {
    const c = s.cover, kd = M.coverKind(c.kind);
    const key = `${c.id}:${s.phase}`;
    const done = st.coverDone.has(key);
    // 该包覆先前阶段是否都已确认（收口/缠带必须在裁切、套装之后）
    const order = { cut: 1, preslip: 1, fit: 1, close: 2, tape: 2 };
    const prevKeys = (s.phase === 'close' || s.phase === 'tape')
      ? st.steps.filter(x => x.kind === 'cover' && x.coverId === c.id && order[x.phase] === 1)
      : [];
    const prevOk = prevKeys.every(x => st.coverDone.has(`${c.id}:${x.phase}`));
    const cutLen = s.cut.rounded ?? Math.ceil(s.cut.cut);
    let detail = '';
    if (s.phase === 'cut') detail = `下料 ${cutLen}mm · 最大束径 ⌀${s.geo.maxD.toFixed(1)}${c.innerD ? ' · 内径 ⌀' + c.innerD : ''}`;
    else if (s.phase === 'preslip') detail = `套到 ${M.nodeName(d, s.gateNode)} 一侧待压接的导线上，压接后再回拉就位`;
    else if (s.phase === 'fit') detail = `沿路径套装 ${s.geo.length.toFixed(0)}mm`;
    else if (s.phase === 'close') detail = `分支收口：${M.COVER_CLOSE.find(x => x.id === c.branchClose)?.name}`;
    else detail = `带宽 ${c.tapeW}mm · 节距 ${s.cut.pitch.toFixed(1)}mm · 用带 ${s.cut.cut.toFixed(0)}mm`;
    bar.innerHTML = `<span class="prog">包覆 第 ${st.idx + 1}/${st.steps.length} 步</span>
      <span class="cur">${kd.glyph} ${esc(c.name)} · ${s.phaseName}</span>
      <span style="color:#666">${esc(detail)}</span>
      <button id="stPrev" ${st.idx === 0 ? 'disabled' : ''}>上一步</button>
      <button id="stOk" ${done || !prevOk ? 'disabled' : ''}>${s.phaseName}确认</button>
      <button id="stWithdraw" ${done ? '' : 'disabled'}>撤回本步</button>
      <button id="stExit">退出</button>`;
    if (!prevOk && !done) setStatus(`请先确认 ${c.name} 的裁切/预套步骤`);
    $('stOk').onclick = () => { st.coverDone.add(key); advance(); };
    $('stWithdraw').onclick = () => { st.coverDone.delete(key); renderAllStep(); };
  }
  const prev = $('stPrev');
  if (prev) prev.onclick = () => selectStep(st.idx - 1);
  const ex = $('stExit'); if (ex) ex.onclick = stopStep;
}

function renderAllStep() {
  renderStepBar();
  renderAsm();
  refreshCanvas();
}
function advance() {
  const st = state.step;
  selectStep(st.idx + 1);
  const cur = st.steps[st.idx];
  const done = cur.kind === 'wire' ? st.confirmed.has(cur.wireId)
    : cur.kind === 'splice' ? st.spliceDone.has(cur.spliceId)
    : st.coverDone.has(`${cur.coverId}:${cur.phase}`);
  if (done) {
    const ns = st.steps.filter(s => s.kind === 'splice').length;
    const nc = st.steps.filter(s => s.kind === 'cover').length;
    stopStep();
    setStatus(`装配推演完成：${st.confirmed.size} 根导线送线、${ns} 个拼接件压接、${nc} 项包覆裁切/套装/收口/缠带确认`);
    return;
  }
  refreshAll();
}

// ---------- 数据面板 ----------

function syncDataPanel() {
  $('designName').value = state.design.name;
  $('netlist').value = M.normalizeNets(state.design.nets)
    .map(n => [n.name, ...n.endpoints].join(' ')).join('\n');
}

async function refreshSaveList() {
  const el = $('saveList');
  try {
    const list = await IO.apiList();
    if (!list.length) { el.innerHTML = '（尚未保存）'; return; }
    el.innerHTML = list.map(d =>
      `<div class="sv"><span class="nm">${esc(d.name)}</span><span class="tm">${esc(d.updated_at).replace('T', ' ')}</span>
       <button data-load="${d.id}">载入</button><button data-del="${d.id}">删</button></div>`
    ).join('');
    el.querySelectorAll('[data-load]').forEach(b => (b.onclick = async () => {
      try {
        const d = await IO.apiLoad(b.dataset.load);
        checkpoint();
        state.design = d.data;
        state.savedId = d.id;
        afterLoad(); fitView();
        setStatus(`已载入「${d.name}」`);
      } catch (err) { setStatus('载入失败：' + err.message); }
    }));
    el.querySelectorAll('[data-del]').forEach(b => (b.onclick = async () => {
      try {
        await IO.apiDelete(b.dataset.del);
        refreshSaveList();
        setStatus('已删除存档');
      } catch (err) { setStatus('删除失败：' + err.message); }
    }));
  } catch {
    el.innerHTML = '（无法连接本地服务，存档不可用；仍可使用 JSON 备份）';
  }
}

$('saveBtn').onclick = async () => {
  state.design.name = $('designName').value.trim() || '未命名线束';
  try {
    const r = await IO.apiSave(state.design, state.savedId);
    state.savedId = r.id;
    setStatus(`已保存「${state.design.name}」到本地库`);
    refreshSaveList();
  } catch (err) { setStatus('保存失败：' + err.message); }
};
$('newBtn').onclick = () => {
  checkpoint();
  state.design = M.createDesign();
  state.savedId = null;
  afterLoad(); fitView();
  setStatus('已新建空白设计');
};
$('sampleBtn').onclick = () => {
  checkpoint();
  state.design = M.sampleDesign();
  state.savedId = null;
  afterLoad(); fitView();
  setStatus('已载入示例线束');
};
$('exportBtn').onclick = () => { IO.exportJSON(state.design); setStatus('已导出 JSON 备份'); };
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = await IO.readJSONFile(f);
    checkpoint();
    state.design = d;
    state.savedId = null;
    afterLoad(); fitView();
    setStatus(`已导入「${d.name}」`);
  } catch (err) { setStatus('导入失败：' + err.message); }
};
$('printBtn').onclick = () => {
  const n = IO.openPrintTemplate(state.design);
  setStatus(`已生成 ${n} 页 1:1 打印模板（A4 横向，100% 比例打印）`);
};
$('labelsBtn').onclick = () => {
  const n = IO.openLabels(state.design);
  setStatus(n ? `已生成 ${n} 枚线号标签` : '尚无导线，无法生成标签');
};
$('netsApply').onclick = () => {
  const lines = $('netlist').value.split('\n').map(s => s.trim()).filter(Boolean);
  const byName = new Map();
  const bad = [];
  for (const ln of lines) {
    const parts = ln.split(/[\s,，→]+/).filter(Boolean);
    if (parts.length < 3) { bad.push(ln); continue; }
    const name = parts[0];
    const eps = parts.slice(1);
    if (!eps.every(M.parseEndpoint)) { bad.push(ln); continue; }
    // 同一网络名出现多行即合并；旧格式 线号 起 讫 同样兼容
    if (!byName.has(name)) byName.set(name, []);
    const list = byName.get(name);
    for (const ep of eps) if (!list.includes(ep)) list.push(ep);
  }
  checkpoint();
  state.design.nets = [...byName.entries()].map(([name, endpoints]) => ({ name, endpoints }));
  refreshAll();
  setStatus(bad.length
    ? `接线表已应用，${bad.length} 行无法解析：${bad[0]}`
    : `接线表已应用（${state.design.nets.length} 个网络）`);
};
$('netsAuto').onclick = () => {
  checkpoint();
  const n = M.autoNets(state.design);
  syncDataPanel();
  refreshAll();
  setStatus(`已从布线生成 ${n} 条接线表`);
};
$('designName').onchange = e => {
  checkpoint();
  state.design.name = e.target.value.trim() || state.design.name;
  refreshAll();
};

// ---------- 选项卡 ----------

document.querySelectorAll('#tabs .tab').forEach(b => (b.onclick = () => {
  document.querySelectorAll('#tabs .tab').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  $('panel-' + b.dataset.tab).classList.remove('hidden');
  if (b.dataset.tab === 'data') refreshSaveList();
}));

// ---------- 启动 ----------

const origRefreshAll = refreshAll;
refreshAll = function () { origRefreshAll(); renderStepBar(); };

refreshUndoBtns();
setTool('select');
requestAnimationFrame(() => { fitView(); refreshAll(); });
