// render.js — SVG 画布渲染
'use strict';

import {
  resolvePath, computeBundles, tieList, nodeById, polyLen, dist, spliceKind,
  coverGeometry, coverKind, coverById, wireById, pointAtArcOnPath,
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

// 拼接件外形尺寸（含端口圆点）
export function spliceSize(n) {
  const ports = Math.max(2, n.ports || 4);
  return { w: Math.max(18, ports * 6 + 8), h: 13 };
}

// 某拼接孔位的相对坐标（沿底边均布）
function splicePortPos(n, pin) {
  const { w } = spliceSize(n);
  const ports = Math.max(2, n.ports || 4);
  const p = Math.min(Math.max(1, pin), ports);
  return { x: n.x - w / 2 + ((p - 0.5) / ports) * w, y: n.y + 6.5 };
}

// 渲染用路径：落到拼接件的端收到孔位点（中心线仍解析到拼接中心参与长度/汇束）
function displayPath(design, wire) {
  const pts = resolvePath(design, wire);
  if (pts.length < 2) return pts;
  const out = pts.map(p => ({ ...p }));
  for (const [i, side] of [[0, 'from'], [out.length - 1, 'to']]) {
    const ep = wire[side];
    const n = ep && ep.node ? nodeById(design, ep.node) : null;
    if (n && n.type === 'splice') out[i] = { ...splicePortPos(n, ep.pin), node: n.id };
  }
  return out;
}

// ctx: {design, sel, view, opts, step, drawing, layers}
export function render(ctx) {
  const { design, layers } = ctx;
  renderBoard(ctx);
  renderZones(ctx);
  renderBundles(ctx);
  renderWires(ctx);
  renderCovers(ctx);
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
  const step = st.steps ? st.steps[st.idx] : null;
  if (st.confirmed && st.confirmed.has(wireId)) return 'done';
  if (step && step.kind === 'wire' && step.wireId === wireId) return 'current';
  if (step && step.kind === 'splice') {
    // 拼接步骤：高亮该件所接导线
    if (step.attaches && step.attaches.some(a => a.wire.id === wireId)) return 'current';
  }
  return 'dim';
}

function renderWires(ctx) {
  const { design, layers } = ctx;
  let h = '';
  for (const w of design.wires) {
    const pts = displayPath(design, w);
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

// ---------- 包覆层（波纹管 / 编织套管 / 胶带缠绕） ----------

// 沿折线生成等距法向刻度（波纹环纹 / 缠带斜纹 / 编织纹）
function hatchMarks(pts, spacing, halfW, skew = 0) {
  let out = '';
  let acc = spacing / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = dist(a, b);
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    const nx = -uy, ny = ux;
    for (; acc <= L; acc += spacing) {
      const cx = a.x + ux * acc, cy = a.y + uy * acc;
      const dx = nx * halfW + ux * skew, dy = ny * halfW + uy * skew;
      out += `<line x1="${cx - dx}" y1="${cy - dy}" x2="${cx + dx}" y2="${cy + dy}" stroke="#ffffff" stroke-width="0.5" opacity="0.7"/>`;
    }
    acc -= L;
  }
  return out;
}

function coverPathD(geo) {
  if (!geo.pts.length) return '';
  return geo.pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
}

function renderCovers(ctx) {
  const { design, layers } = ctx;
  if (!ctx.opts.showCovers) { layers.cover.innerHTML = ''; return; }
  let h = '';
  for (const c of design.covers || []) {
    const geo = coverGeometry(design, c);
    if (!geo.pts.length) continue;
    const sel = ctx.sel.kind === 'cover' && ctx.sel.id === c.id;
    const kd = coverKind(c.kind);
    const bad = geo.broken.length || geo.dangling.length;
    const d = coverPathD(geo);
    const w = c.kind === 'tape' ? Math.max(2.2, geo.maxD + 1.2) : Math.max(c.innerD || 2, geo.maxD + 1);
    const st = coverStepStateOf(ctx, c.id);
    const op = st === 'dim' ? 0.18 : st === 'done' ? 0.55 : 0.92;
    const stroke = bad ? '#c62828' : kd.color;
    if (sel) h += `<path d="${d}" fill="none" stroke="#2f7df6" stroke-width="${(w + 3).toFixed(1)}" stroke-opacity="0.3" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (c.kind === 'tape') {
      // 胶带：深色基带 + 白色斜纹（节距取有效节距的视觉近似）
      const cut = geo && c;
      const ov = Math.max(0, Math.min(90, c.overlap || 0)) / 100;
      const eff = c.pitch > 0 ? c.pitch : (c.tapeW || 19) * (1 - ov);
      h += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-opacity="${op}" stroke-linejoin="round" stroke-linecap="round"/>`;
      h += `<g opacity="${Math.min(1, op + 0.08)}">${hatchMarks(geo.pts, Math.max(2, eff), w / 2, eff * 0.5)}</g>`;
    } else if (c.kind === 'corr') {
      h += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-opacity="${op * 0.55}" stroke-linejoin="round" stroke-linecap="round"/>`;
      h += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="0.9" stroke-opacity="${op}" stroke-dasharray="2.2,1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
      h += `<g opacity="${Math.min(1, op + 0.05)}">${hatchMarks(geo.pts, 4, w / 2 + 0.3)}</g>`;
    } else {
      // 编织管：半透明褐色套 + 交叉网纹
      h += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-opacity="${op * 0.4}" stroke-linejoin="round" stroke-linecap="round"/>`;
      h += `<g opacity="${Math.min(1, op + 0.05)}">
        ${hatchMarks(geo.pts, 3.2, w / 2 + 0.2, 1.4)}
        ${hatchMarks(geo.pts, 3.2, w / 2 + 0.2, -1.4)}</g>`;
    }
    // 起止端帽
    for (const p of [geo.pts[0], geo.pts[geo.pts.length - 1]]) {
      h += `<circle cx="${p.x}" cy="${p.y}" r="${Math.min(3, w / 2 + 0.6)}" fill="${stroke}" opacity="${op}"/>`;
    }
    // 标签
    if (ctx.opts.showLabels) {
      const m = geo.pts[Math.floor(geo.pts.length / 2)];
      h += `<text x="${m.x}" y="${m.y - w / 2 - 2}" font-size="4.2" fill="${bad ? '#c62828' : '#333'}" text-anchor="middle" class="halo">${esc(kd.glyph)}${esc(c.name)}${bad ? ' ⚠' : ''}</text>`;
    }
  }
  // 包覆绘制预览
  if (ctx.coverDraw && ctx.coverDraw.pts.length) {
    const pts = [...ctx.coverDraw.pts];
    if (ctx.coverDraw.cursor) pts.push(ctx.coverDraw.cursor);
    const kd = coverKind(ctx.coverDraw.kind);
    const dd = pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
    h += `<path d="${dd}" fill="none" stroke="${kd.color}" stroke-width="5" stroke-opacity="0.4" stroke-dasharray="4,2" stroke-linecap="round" style="pointer-events:none"/>`;
    for (const p of ctx.coverDraw.pts) h += `<circle cx="${p.x}" cy="${p.y}" r="2.4" fill="${kd.color}" style="pointer-events:none"/>`;
  }
  layers.cover.innerHTML = h;
}

function coverStepStateOf(ctx, coverId) {
  const st = ctx.step;
  if (!st || !st.active) return 'normal';
  const step = st.steps ? st.steps[st.idx] : null;
  if (step && step.kind === 'cover' && step.coverId === coverId) return 'current';
  // 该包覆任一阶段未确认即不淡化
  const related = st.steps.filter(s => s.kind === 'cover' && s.coverId === coverId);
  if (related.some(s => !st.coverDone.has(`${coverId}:${s.phase}`))) return 'dim';
  return 'done';
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
  // 逐步模式下当前导线经过的节点 / 当前拼接件
  const glow = new Set();
  if (ctx.step && ctx.step.active && ctx.step.steps) {
    const step = ctx.step.steps[ctx.step.idx];
    if (step) {
      if (step.kind === 'wire') {
        const w = design.wires.find(x => x.id === step.wireId);
        if (w) for (const p of resolvePath(design, w)) if (p.node) glow.add(p.node);
      } else if (step.kind === 'splice') {
        glow.add(step.spliceId);
        for (const a of step.attaches) {
          const w = design.wires.find(x => x.id === a.wire.id);
          if (w) for (const p of resolvePath(design, w)) if (p.node) glow.add(p.node);
        }
      }
    }
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
    } else if (n.type === 'splice') {
      const { w: ww } = spliceSize(n);
      const kind = spliceKind(n.kind);
      const ports = Math.max(2, n.ports || 4);
      let portsH = '';
      for (let i = 1; i <= ports; i++) {
        const pp = splicePortPos(n, i);
        portsH += `<circle cx="${pp.x}" cy="${pp.y}" r="1.3" fill="#fff" stroke="#333" stroke-width="0.4"/>
                   <text x="${pp.x}" y="${pp.y + 4}" font-size="2.6" fill="#555" text-anchor="middle">${i}</text>`;
      }
      let body;
      if (n.kind === 'cap') {
        // 闭端帽：锥形帽
        body = `<path d="M ${n.x - ww / 2 + 3} ${n.y + 4} L ${n.x - ww / 2 + 1} ${n.y - 3} L ${n.x + ww / 2 - 1} ${n.y - 3} L ${n.x + ww / 2 - 3} ${n.y + 4} Z"
                fill="#efebe9" stroke="${kind.color}" stroke-width="0.8"/>`;
      } else if (n.kind === 'butt') {
        // 对接管：两节套筒
        body = `<rect x="${n.x - ww / 2 + 1}" y="${n.y - 5}" width="${ww - 2}" height="8" rx="1.5" fill="#e8eaf6" stroke="${kind.color}" stroke-width="0.8"/>
                <line x1="${n.x}" y1="${n.y - 5}" x2="${n.x}" y2="${n.y + 3}" stroke="${kind.color}" stroke-width="0.6"/>`;
      } else {
        // 超声焊：圆角方块 + 波纹
        body = `<rect x="${n.x - ww / 2 + 1}" y="${n.y - 5.5}" width="${ww - 2}" height="9.5" rx="2" fill="#e0f2f1" stroke="${kind.color}" stroke-width="0.8"/>
                <path d="M ${n.x - 4} ${n.y - 1} q 2 -3 4 0 t 4 0" fill="none" stroke="${kind.color}" stroke-width="0.7"/>`;
      }
      h += `<g data-node="${n.id}" style="cursor:move">${ring}${selRing}
        ${portsH}${body}
        <text x="${n.x}" y="${n.y - 8}" font-size="4.5" font-weight="bold" fill="${kind.color}" text-anchor="middle" class="halo">${esc(kind.short)} ${esc(n.name)}</text>
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
      const pts = displayPath(design, w);
      pts.forEach((p, i) => {
        if (i !== 0 && i !== pts.length - 1) {
          const bound = p.node ? 1 : 0;
          h += `<rect class="vhandle" data-vi="${i}" x="${p.x - 4 / z}" y="${p.y - 4 / z}" width="${8 / z}" height="${8 / z}"
            fill="${bound ? '#ffd166' : '#fff'}" stroke="#2f7df6" stroke-width="${1 / z}" style="cursor:grab"/>`;
        }
      });
      // 两端可拖接手柄（拖到连接器/拼接件重接）
      for (const [i, side] of [[0, 'from'], [pts.length - 1, 'to']]) {
        const p = pts[i];
        h += `<circle cx="${p.x}" cy="${p.y}" r="${5 / z}" fill="#2f7df6" fill-opacity="0.25"
          stroke="#2f7df6" stroke-width="${1.2 / z}" style="cursor:grab"/>`;
      }
    }
  }
  // 拖接导线端：跟随线 + 落点高亮
  if (ctx.epDrag) {
    const w = design.wires.find(x => x.id === ctx.epDrag.wireId);
    if (w) {
      const pts = displayPath(design, w);
      const side = ctx.epDrag.side;
      const fixed = side === 'from' ? pts[pts.length - 1] : pts[0];
      const c = ctx.epDrag.cur;
      h += `<line x1="${fixed.x}" y1="${fixed.y}" x2="${c.x}" y2="${c.y}"
        stroke="#2f7df6" stroke-width="${1.4 / z}" stroke-dasharray="${4 / z},${2 / z}" style="pointer-events:none"/>`;
      h += `<circle cx="${c.x}" cy="${c.y}" r="${4.5 / z}" fill="#2f7df6" style="pointer-events:none"/>`;
    }
  }
  // 禁布区拖拽预览
  if (ctx.preview) {
    const r = ctx.preview;
    h += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#f8d7da88" stroke="#c62828" stroke-width="${1 / z}" stroke-dasharray="${4 / z},${2 / z}" style="pointer-events:none"/>`;
  }
  // 选中包覆：显示路径锚点手柄（可拖动沿线改位）
  if (ctx.sel.kind === 'cover') {
    const c = coverById(design, ctx.sel.id);
    if (c) {
      const geo = coverGeometry(design, c);
      const z = view.z;
      c.anchors.forEach((a, i) => {
        const w = wireById(design, a.wire);
        if (!w) {
          h += `<text x="20" y="${20 + i * 6}" font-size="5" fill="#c62828">锚点${i + 1} 导线缺失</text>`;
          return;
        }
        const pts = resolvePath(design, w);
        const L = polyLen(pts);
        const s = Math.max(0, Math.min(L, +a.s || 0));
        const q = pointAtArcOnPath(pts, s);
        h += `<circle class="chandle" data-ci="${i}" cx="${q.x}" cy="${q.y}" r="${4.5 / z}"
          fill="#ffd166" stroke="${coverKind(c.kind).color}" stroke-width="${1.2 / z}" style="cursor:grab"/>`;
      });
    }
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
