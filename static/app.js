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
  sel: { kind: null, id: null },       // kind: node|wire|zone
  view: { tx: 30, ty: 30, z: 1 },
  opts: { snap: true, showBundles: true, showTies: false, showLabels: true },
  drawing: null,   // 布线中 {from:{node,pin}, pts:[], cursor}
  preview: null,   // 禁布区拖拽预览 {x,y,w,h}
  step: null,      // 逐步推演 {active,order,idx,confirmed:Set,lock}
  drag: null,
};

const $ = id => document.getElementById(id);
const canvas = $('canvas'), wrap = $('canvasWrap');
const layers = {
  board: $('layer-board'), zone: $('layer-zone'), bundle: $('layer-bundle'),
  wire: $('layer-wire'), tie: $('layer-tie'), node: $('layer-node'), overlay: $('layer-overlay'),
};
const ctx = {
  get design() { return state.design; },
  get sel() { return state.sel; },
  get view() { return state.view; },
  get opts() { return state.opts; },
  get step() { return state.step; },
  get drawing() { return state.drawing; },
  get preview() { return state.preview; },
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
  state.design = JSON.parse(undoStack.pop());
  afterLoad(); refreshUndoBtns();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(state.design));
  state.design = JSON.parse(redoStack.pop());
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
  hidePinPicker();
  syncDataPanel();
  refreshAll();
}
function setStatus(t) { $('statusHint').textContent = t; }

// ---------- 命中测试 ----------

function connSize(n) { return { w: Math.max(34, (n.pins || 4) * 7 + 12), h: 18 }; }

function nodeAt(p) {
  const tol = 8 / state.view.z;
  for (let i = state.design.nodes.length - 1; i >= 0; i--) {
    const n = state.design.nodes[i];
    if (n.type === 'connector') {
      const { w, h } = connSize(n);
      if (Math.abs(p.x - n.x) <= w / 2 + tol && Math.abs(p.y - n.y) <= h / 2 + tol) return n;
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
function occupiedPins(connId, extra) {
  const occ = new Map();
  for (const w of state.design.wires) {
    for (const side of ['from', 'to']) {
      const ep = w[side];
      if (ep && ep.node === connId) occ.set(ep.pin, w.label);
    }
  }
  if (extra) occ.set(extra.pin, '本线');
  return occ;
}
function showPinPicker(conn, title, extraPin, cb) {
  const pk = $('pinPicker');
  const occ = occupiedPins(conn.id, extraPin);
  const s = toScreen(conn);
  let h = `<h5>${esc(title)}：${esc(conn.name)} 端子</h5><div class="pins">`;
  for (let i = 1; i <= (conn.pins || 4); i++) {
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

  if (state.tool === 'zone') {
    state.drag = { type: 'zoneNew', x0: p.x, y0: p.y };
    state.preview = { x: p.x, y: p.y, w: 0, h: 0 };
    return;
  }

  if (state.tool === 'wire') {
    const n = nodeAt(p);
    if (!state.drawing) {
      if (n && n.type === 'connector') {
        showPinPicker(n, '选择起点端子', null, pin => {
          state.drawing = { from: { node: n.id, pin }, pts: [{ x: n.x, y: n.y, node: n.id }], cursor: null };
          setStatus(`布线中：${n.name}.${pin} → 点击画布加途经点（可吸附钉/分支点），点击目标连接器结束，Esc 取消，退格撤点`);
          refreshCanvas();
        });
      } else {
        setStatus('请先点击一个连接器作为起点');
      }
      return;
    }
    // 布线中
    if (n && n.type === 'connector') {
      const from = state.drawing.from;
      showPinPicker(n, '选择终点端子', n.id === from.node ? from : null, pin => {
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
    if ((d.type === 'node' || d.type === 'zone' || d.type === 'vertex') && !d.ck) {
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
    }
    return;
  }
  if (state.drawing) {
    state.drawing.cursor = snapPt(p);
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
  if (d.type === 'node' || d.type === 'zone' || d.type === 'vertex') {
    refreshAll(); // 拖动结束后重算裁线表/检查
  }
});

canvas.addEventListener('dblclick', e => {
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
  state.design.wires.push(w);
  state.drawing = null;
  state.sel = { kind: 'wire', id: w.id };
  setStatus(`已布 ${w.label}：${M.endpointStr(state.design, w.from)} → ${M.endpointStr(state.design, w.to)}，可继续布下一根`);
  refreshAll();
}

// ---------- 工具与快捷键 ----------

const TOOL_HINTS = {
  select: '选择：拖动移动节点/顶点；双击线段加点；右键顶点删点；空白处拖动平移，滚轮缩放',
  connector: '点击画布放置连接器',
  branch: '点击画布放置分支点',
  nail: '点击画布放置固定钉',
  zone: '按住拖出禁布区矩形',
  wire: '布线：点击连接器选起点端子 → 点击途经点 → 点击目标连接器选终点端子',
};
function setTool(t) {
  state.tool = t;
  state.drawing = null;
  hidePinPicker();
  document.querySelectorAll('#tools .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  canvas.classList.toggle('wiretool', t === 'wire');
  setStatus(TOOL_HINTS[t]);
  refreshCanvas();
}

document.querySelectorAll('#tools .tool').forEach(b => (b.onclick = () => setTool(b.dataset.tool)));
$('zoomIn').onclick = () => { const r = wrap.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); };
$('zoomOut').onclick = () => { const r = wrap.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.8); };
$('zoomFit').onclick = fitView;
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;
for (const [id, key] of [['optSnap', 'snap'], ['optBundles', 'showBundles'], ['optTies', 'showTies'], ['optLabels', 'showLabels']]) {
  $(id).onchange = e => { state.opts[key] = e.target.checked; refreshCanvas(); if (key === 'showTies') renderTies(); };
}

document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') {
    if (pinCb) return hidePinPicker();
    if (state.drawing) { state.drawing = null; setStatus('已取消布线'); return refreshCanvas(); }
    state.sel = { kind: null, id: null };
    return refreshAll();
  }
  if (e.key === 'Backspace' && state.drawing) {
    e.preventDefault();
    if (state.drawing.pts.length > 1) state.drawing.pts.pop();
    return refreshCanvas();
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
  const k = e.key.toLowerCase();
  const tools = { v: 'select', j: 'connector', b: 'branch', n: 'nail', z: 'zone', w: 'wire' };
  if (tools[k]) return setTool(tools[k]);
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
    checkpoint();
    state.design.wires = state.design.wires.filter(x => x.id !== id);
  } else if (kind === 'zone') {
    checkpoint();
    state.design.zones = state.design.zones.filter(x => x.id !== id);
  } else if (kind === 'node') {
    const n = M.nodeById(state.design, id);
    if (!n) return;
    if (n.type === 'connector' && state.design.wires.some(w => w.from.node === id || w.to.node === id)) {
      return setStatus(`连接器 ${n.name} 上还有导线，请先移除相关导线`);
    }
    checkpoint();
    state.design.nodes = state.design.nodes.filter(x => x.id !== id);
    for (const w of state.design.wires) {
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
    const conns = d.nodes.filter(n => n.type === 'connector');
    const connOpts = sel => conns.map(n => `<option value="${n.id}" ${n.id === sel ? 'selected' : ''}>${esc(n.name)}</option>`).join('');
    const pinOpts = (nodeId, sel) => {
      const n = M.nodeById(d, nodeId);
      const m = n ? (n.pins || 4) : 0;
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
        <label>端子 <select id="w-from-pin">${pinOpts(w.from.node, w.from.pin)}</select></label>
        <label>终点 <select id="w-to-node">${connOpts(w.to.node)}</select></label>
        <label>端子 <select id="w-to-pin">${pinOpts(w.to.node, w.to.pin)}</select></label>
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
    <p class="hint">共 ${d.nodes.length} 个节点、${d.wires.length} 根导线、${d.zones.length} 个禁布区。点击画布对象可编辑其属性。</p>`;
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
  h += `</tbody></table><h4>用料汇总（按建议裁线）</h4><table class="list"><thead><tr><th class="l">线径</th><th class="l">颜色</th><th>根数</th><th>总长</th></tr></thead><tbody>`;
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
  el.querySelectorAll('tr[data-w]').forEach(tr => (tr.onclick = () => {
    state.sel = { kind: 'wire', id: tr.dataset.w };
    const w = M.wireById(state.design, tr.dataset.w);
    if (w) { const pts = M.resolvePath(state.design, w); centerOn(pts[Math.floor(pts.length / 2)]); }
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
  let h = `<div class="row btns">
    ${st && st.active
      ? `<button id="asmStop">退出逐步推演</button>`
      : `<button id="asmStart" ${order.length ? '' : 'disabled'}>开始逐步推演</button>
         <label class="chk"><input type="checkbox" id="asmLock" checked> 确认后锁定</label>`}
    <button id="asmTidy" title="移除共线冗余点并吸附就近节点，锁定导线不受影响">重排未锁定路径</button>
  </div>`;
  h += '<div>' + order.map((o, i) => {
    const w = M.wireById(state.design, o.wireId);
    const cls = st && st.active
      ? (st.confirmed.has(o.wireId) ? 'done' : st.order[st.idx] === o.wireId ? 'cur' : '')
      : '';
    return `<div class="asmitem ${cls}" data-w="${o.wireId}">
      <span class="no">${i + 1}</span>
      <span class="colorchip" style="background:${w ? w.color : '#999'}"></span>
      <span>${esc(o.label)}${o.locked ? ' 🔒' : ''}</span>
      <span style="color:#777">${o.length.toFixed(0)}mm</span>
      <span style="color:#999;font-size:11px">主干 ${o.shared.toFixed(0)}mm</span>
    </div>`;
  }).join('') + '</div>';
  h += '<p class="hint">顺序按“主干优先”排列：与其它导线重合段越长、自身越长的先敷设。</p>';
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
    state.sel = { kind: 'wire', id: div.dataset.w };
    refreshAll();
  }));
}

function startStep() {
  const order = M.assemblyOrder(state.design).map(o => o.wireId);
  if (!order.length) return;
  checkpoint(); // 推演中的锁定可一次撤销
  state.step = { active: true, order, idx: 0, confirmed: new Set(), lock: $('asmLock') ? $('asmLock').checked : true };
  setTool('select');
  state.sel = { kind: 'wire', id: order[0] };
  $('stepBar').classList.remove('hidden');
  setStatus('逐步推演：核对当前导线与固定钉，确认后才推进');
  refreshAll();
}
function stopStep() {
  state.step = null;
  $('stepBar').classList.add('hidden');
  setStatus('已退出逐步推演');
  refreshAll();
}
function renderStepBar() {
  const st = state.step;
  const bar = $('stepBar');
  if (!st || !st.active) { bar.classList.add('hidden'); return; }
  const d = state.design;
  const wid = st.order[st.idx];
  const w = M.wireById(d, wid);
  if (!w) { stopStep(); return; }
  const c = M.cutInfo(d, w);
  const nails = M.resolvePath(d, w).filter(p => p.node).map(p => M.nodeName(d, p.node));
  bar.innerHTML = `<span class="prog">第 ${st.idx + 1}/${st.order.length} 根</span>
    <span class="cur"><span class="colorchip" style="background:${w.color}"></span> ${esc(w.label)}</span>
    <span>${esc(M.endpointStr(d, w.from))} → ${esc(M.endpointStr(d, w.to))} · ⌀${w.gauge} · 裁线 ${c.rounded}mm</span>
    <span style="color:#666">途经：${nails.map(esc).join(' → ')}</span>
    <button id="stPrev" ${st.idx === 0 ? 'disabled' : ''}>上一步</button>
    <button id="stOk">确认并推进</button>
    <button id="stExit">退出</button>`;
  $('stPrev').onclick = () => { st.idx = Math.max(0, st.idx - 1); state.sel = { kind: 'wire', id: st.order[st.idx] }; refreshAll(); };
  $('stOk').onclick = () => {
    st.confirmed.add(wid);
    if (st.lock) w.locked = true;
    st.idx++;
    if (st.idx >= st.order.length) {
      stopStep();
      setStatus(`推演完成：${st.confirmed.size} 根导线已确认${st.lock ? '并锁定' : ''}`);
      return;
    }
    state.sel = { kind: 'wire', id: st.order[st.idx] };
    refreshAll();
  };
  $('stExit').onclick = stopStep;
}

// ---------- 数据面板 ----------

function syncDataPanel() {
  $('designName').value = state.design.name;
  $('netlist').value = state.design.nets.map(n => `${n.label} ${n.from} ${n.to}`).join('\n');
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
  const nets = [], bad = [];
  for (const ln of lines) {
    const parts = ln.split(/[\s,，]+/).filter(Boolean);
    if (parts.length !== 3 || !M.parseEndpoint(parts[1]) || !M.parseEndpoint(parts[2])) {
      bad.push(ln);
      continue;
    }
    nets.push({ label: parts[0], from: parts[1], to: parts[2] });
  }
  checkpoint();
  state.design.nets = nets;
  refreshAll();
  setStatus(bad.length ? `接线表已应用，${bad.length} 行无法解析：${bad[0]}` : `接线表已应用（${nets.length} 条）`);
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
