// render.js — SVG 画布渲染
'use strict';

import {
  resolvePath, computeBundles, tieList, nodeById, polyLen, dist,
} from './model.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

export function viewTransform(view) {
  return `translate(${view.tx},${view.ty}) scale(${view.z})`;
}

// 折线中点（用于放置线号标签）
export function polyMid(pts) {
  const total = polyLen(pts);
  if (total === 0) return pts[0] || { x: 0, y: 0 };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = dist(pts[i - 1], pts[i]);
    if (acc + L >= total / 2) {
      const t = (total / 2 - acc) / L;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    acc += L;
  }
  return pts[pts.length - 1];
}

const ptsAttr = pts => pts.map(p => `${p.x},${p.y}`).join(' ');

function connectorSize(n) {
  return { w: Math.max(34, (n.pins || 4) * 7 + 12), h: 18 };
}

// ctx: {design, sel, view, opts, step, drawing, layers}
export function render(ctx) {
  const { design, layers } = ctx;
  renderBoard(ctx);
  renderZones(ctx);
  renderBundles(ctx);
  renderWires(ctx);
  renderTies(ctx);
  renderNodes(ctx);
  renderOverlay(ctx);
  for (const name of Object.keys(layers)) {
    if (layers[name]) layers[name].setAttribute('transform', viewTransform(ctx.view));
  }
}

function renderBoard(ctx) {
  const { design, layers } = ctx;
  const b = design.board;
  let h = `<rect x="0" y="0" width="${b.width}" height="${b.height}" fill="#fdfdf8" stroke="#444" stroke-width="0.8"/>`;
  // 网格
  const g = b.grid || 10;
  h += `<g stroke="#e4e4da" stroke-width="0.25">`;
  for (let x = g; x < b.width; x += g) h += `<line x1="${x}" y1="0" x2="${x}" y2="${b.height}"/>`;
  for (let y = g; y < b.height; y += g) h += `<line x1="0" y1="${y}" x2="${b.width}" y2="${y}"/>`;
  h += `</g><g stroke="#cfcfc2" stroke-width="0.4">`;
  for (let x = 0; x <= b.width; x += g * 5) h += `<line x1="${x}" y1="0" x2="${x}" y2="${b.height}"/>`;
  for (let y = 0; y <= b.height; y += g * 5) h += `<line x1="0" y1="${y}" x2="${b.width}" y2="${y}"/>`;
  h += `</g>`;
  h += `<text x="4" y="${b.height - 4}" font-size="5" fill="#999">钉板 ${b.width}×${b.height}mm 网格${g}mm</text>`;
  layers.board.innerHTML = h;
}

function renderZones(ctx) {
  const { design, layers } = ctx;
  let h = '';
  for (const z of design.zones) {
    const sel = ctx.sel.kind === 'zone' && ctx.sel.id === z.id;
    h += `<g data-zone="${z.id}" style="cursor:move">
      <rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="url(#hatch)" stroke="${sel ? '#d62728' : '#b04040'}" stroke-width="${sel ? 1.2 : 0.6}"/>
      <text x="${z.x + z.w / 2}" y="${z.y + z.h / 2}" font-size="4.5" fill="#a03030" text-anchor="middle" dominant-baseline="middle">⛔ ${esc(z.name)}</text>
    </g>`;
  }
  layers.zone.innerHTML = h;
}

function renderBundles(ctx) {
  const { design, layers } = ctx;
  let h = '';
  for (const b of computeBundles(design)) {
    if (b.wires.length < 2) continue;
    h += `<line x1="${b.a.x}" y1="${b.a.y}" x2="${b.b.x}" y2="${b.b.y}" stroke="#8f979e" stroke-width="${b.diameter}" stroke-linecap="round" opacity="0.45"/>`;
    if (ctx.opts.showBundles) {
      const mx = (b.a.x + b.b.x) / 2, my = (b.a.y + b.b.y) / 2;
      h += `<text x="${mx}" y="${my - b.diameter / 2 - 1.5}" font-size="4" fill="#5a636a" text-anchor="middle" class="halo">${b.wires.length}根 ⌀${b.diameter.toFixed(1)}</text>`;
    }
  }
  layers.bundle.innerHTML = h;
}

function stepStateOf(ctx, wireId) {
  const st = ctx.step;
  if (!st || !st.active) return 'normal';
  if (st.confirmed.has(wireId)) return 'done';
  if (st.order[st.idx] === wireId) return 'current';
  return 'dim';
}

function renderWires(ctx) {
  const { design, layers } = ctx;
  let h = '';
  for (const w of design.wires) {
    const pts = resolvePath(design, w);
    if (pts.length < 2) continue;
    const sel = ctx.sel.kind === 'wire' && ctx.sel.id === w.id;
    const st = stepStateOf(ctx, w.id);
    const opacity = st === 'dim' ? 0.12 : st === 'done' ? 0.45 : 1;
    const width = Math.max(w.gauge, 1.0);
    const cls = st === 'current' ? 'wire-current' : '';
    h += `<g data-wire="${w.id}" opacity="${opacity}" class="wiregrp ${cls}">`;
    if (sel) h += `<polyline points="${ptsAttr(pts)}" fill="none" stroke="#2f7df6" stroke-width="${width + 3}" stroke-opacity="0.35" stroke-linejoin="round" stroke-linecap="round"/>`;
    h += `<polyline points="${ptsAttr(pts)}" fill="none" stroke="#333" stroke-width="${width + 0.7}" stroke-linejoin="round" stroke-linecap="round" style="pointer-events:none"/>`;
    h += `<polyline class="colored" points="${ptsAttr(pts)}" fill="none" stroke="${w.color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" style="cursor:pointer"/>`;
    // 端点
    for (const p of [pts[0], pts[pts.length - 1]]) {
      h += `<circle cx="${p.x}" cy="${p.y}" r="1.8" fill="${w.color}" stroke="#333" stroke-width="0.4" style="pointer-events:none"/>`;
    }
    // 线号标签
    if (ctx.opts.showLabels) {
      const m = polyMid(pts);
      h += `<text x="${m.x}" y="${m.y - width / 2 - 1.5}" font-size="4.5" fill="#111" text-anchor="middle" class="halo" style="pointer-events:none">${esc(w.label)}${w.locked ? ' 🔒' : ''}</text>`;
    }
    if (st === 'done') {
      const m = polyMid(pts);
      h += `<text x="${m.x}" y="${m.y + 5}" font-size="5" fill="#2ca02c" text-anchor="middle" class="halo">✓</text>`;
    }
    h += `</g>`;
  }
  layers.wire.innerHTML = h;
}

function renderTies(ctx) {
  const { design, layers } = ctx;
  if (!ctx.opts.showTies) { layers.tie.innerHTML = ''; return; }
  let h = '';
  tieList(design).forEach((t, i) => {
    h += `<g class="tiemark">
      <line x1="${t.x - 3}" y1="${t.y - 3}" x2="${t.x + 3}" y2="${t.y + 3}" stroke="#e67700" stroke-width="1"/>
      <line x1="${t.x - 3}" y1="${t.y + 3}" x2="${t.x + 3}" y2="${t.y - 3}" stroke="#e67700" stroke-width="1"/>
      <text x="${t.x + 4}" y="${t.y - 3}" font-size="3.5" fill="#e67700" class="halo">T${i + 1}</text>
    </g>`;
  });
  layers.tie.innerHTML = h;
}

function renderNodes(ctx) {
  const { design, layers } = ctx;
  // 逐步模式下当前导线经过的节点
  const glow = new Set();
  if (ctx.step && ctx.step.active) {
    const w = design.wires.find(x => x.id === ctx.step.order[ctx.step.idx]);
    if (w) for (const p of resolvePath(design, w)) if (p.node) glow.add(p.node);
  }
  let h = '';
  for (const n of design.nodes) {
    const sel = ctx.sel.kind === 'node' && ctx.sel.id === n.id;
    const g = glow.has(n.id);
    const ring = g ? `<circle cx="${n.x}" cy="${n.y}" r="14" fill="none" stroke="#2f7df6" stroke-width="1.2" class="pulse"/>` : '';
    const selRing = sel ? `<circle cx="${n.x}" cy="${n.y}" r="12" fill="none" stroke="#2f7df6" stroke-width="0.8" stroke-dasharray="2,1.5"/>` : '';
    if (n.type === 'connector') {
      const { w, h: hh } = connectorSize(n);
      let pins = '';
      for (let i = 1; i <= (n.pins || 4); i++) {
        const px = n.x - w / 2 + 6 + (i - 0.5) * (w - 12) / (n.pins || 4);
        pins += `<circle cx="${px}" cy="${n.y}" r="1.3" fill="#fff" stroke="#555" stroke-width="0.3"/>
                 <text x="${px}" y="${n.y + hh / 2 - 1.2}" font-size="2.6" fill="#777" text-anchor="middle">${i}</text>`;
      }
      h += `<g data-node="${n.id}" style="cursor:move">${ring}${selRing}
        <rect x="${n.x - w / 2}" y="${n.y - hh / 2}" width="${w}" height="${hh}" rx="2" fill="#dde7f5" stroke="#345" stroke-width="0.7"/>
        ${pins}
        <text x="${n.x}" y="${n.y - hh / 2 - 2}" font-size="5" font-weight="bold" fill="#234" text-anchor="middle" class="halo">${esc(n.name)}</text>
      </g>`;
    } else if (n.type === 'branch') {
      h += `<g data-node="${n.id}" style="cursor:move">${ring}${selRing}
        <rect x="${n.x - 5}" y="${n.y - 5}" width="10" height="10" transform="rotate(45 ${n.x} ${n.y})" fill="#ffe9b3" stroke="#a80" stroke-width="0.7"/>
        <text x="${n.x}" y="${n.y - 8}" font-size="4.5" fill="#860" text-anchor="middle" class="halo">${esc(n.name)}</text>
      </g>`;
    } else {
      h += `<g data-node="${n.id}" style="cursor:move">${ring}${selRing}
        <circle cx="${n.x}" cy="${n.y}" r="3" fill="#fff" stroke="#444" stroke-width="0.8"/>
        <line x1="${n.x - 4.5}" y1="${n.y}" x2="${n.x + 4.5}" y2="${n.y}" stroke="#444" stroke-width="0.5"/>
        <line x1="${n.x}" y1="${n.y - 4.5}" x2="${n.x}" y2="${n.y + 4.5}" stroke="#444" stroke-width="0.5"/>
        <text x="${n.x}" y="${n.y - 6}" font-size="4" fill="#555" text-anchor="middle" class="halo">${esc(n.name)}</text>
      </g>`;
    }
  }
  layers.node.innerHTML = h;
}

function renderOverlay(ctx) {
  const { design, layers, view } = ctx;
  const z = view.z;
  let h = '';
  // 选中导线的顶点手柄
  if (ctx.sel.kind === 'wire') {
    const w = design.wires.find(x => x.id === ctx.sel.id);
    if (w && !w.locked) {
      const pts = resolvePath(design, w);
      pts.forEach((p, i) => {
        const bound = p.node ? 1 : 0;
        h += `<rect class="vhandle" data-vi="${i}" x="${p.x - 4 / z}" y="${p.y - 4 / z}" width="${8 / z}" height="${8 / z}"
          fill="${bound ? '#ffd166' : '#fff'}" stroke="#2f7df6" stroke-width="${1 / z}" style="cursor:grab"/>`;
      });
    }
  }
  // 禁布区拖拽预览
  if (ctx.preview) {
    const r = ctx.preview;
    h += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#f8d7da88" stroke="#c62828" stroke-width="${1 / z}" stroke-dasharray="${4 / z},${2 / z}" style="pointer-events:none"/>`;
  }
  // 布线预览
  if (ctx.drawing && ctx.drawing.pts.length) {
    const pts = [...ctx.drawing.pts];
    if (ctx.drawing.cursor) pts.push(ctx.drawing.cursor);
    h += `<polyline points="${ptsAttr(pts)}" fill="none" stroke="#2f7df6" stroke-width="1.2" stroke-dasharray="4,2" opacity="0.8" style="pointer-events:none"/>`;
    for (const p of ctx.drawing.pts) {
      h += `<circle cx="${p.x}" cy="${p.y}" r="${3 / z}" fill="#2f7df6" style="pointer-events:none"/>`;
    }
  }
  layers.overlay.innerHTML = h;
}
