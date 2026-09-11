// io.js — 存档接口、JSON 备份、CSV、分页打印模板与线号标签
'use strict';

import {
  resolvePath, computeBundles, cutList, materialSummary, tieList,
  nodeName, endpointStr, polyLen,
} from './model.js';
import { esc } from './render.js';

// ---------- 本地存档（sqlite3 后端） ----------

export async function apiList() {
  const r = await fetch('/api/designs');
  if (!r.ok) throw new Error('读取存档列表失败');
  return r.json();
}

export async function apiSave(design, id) {
  const r = await fetch('/api/designs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id || null, name: design.name, data: design }),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function apiLoad(id) {
  const r = await fetch('/api/designs/' + id);
  if (!r.ok) throw new Error('读取存档失败');
  return r.json();
}

export async function apiDelete(id) {
  const r = await fetch('/api/designs/' + id, { method: 'DELETE' });
  if (!r.ok) throw new Error('删除失败');
  return r.json();
}

async function errText(r) {
  try { return (await r.json()).error || r.statusText; } catch { return r.statusText; }
}

// ---------- 文件下载 / 读取 ----------

export function download(filename, content, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function exportJSON(design) {
  download(`${design.name}.harness.json`, JSON.stringify(design, null, 2), 'application/json');
}

export function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        if (!d || !Array.isArray(d.nodes) || !Array.isArray(d.wires)) throw new Error('不是有效的线束设计文件');
        d.zones = d.zones || []; d.nets = d.nets || [];
        resolve(d);
      } catch (e) { reject(e); }
    };
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsText(file);
  });
}

// ---------- CSV ----------

export function cutListCSV(design) {
  const rows = [['线号', '颜色', '线径mm', '起点', '终点', '路径长mm', '维修余量mm', '剥线mm', '裁线长mm', '建议裁线mm', '压接(起)', '压接(讫)']];
  for (const r of cutList(design)) {
    rows.push([
      r.label, r.color, r.gauge, r.from, r.to,
      r.path.toFixed(1), r.svc, r.strip, r.cut.toFixed(1), r.rounded,
      r.crimpFrom || '', r.crimpTo || '',
    ]);
  }
  return '﻿' + rows.map(r => r.join(',')).join('\r\n');
}

// ---------- 打印模板（按实际尺寸分页的 SVG） ----------

const PAGE_W = 297, PAGE_H = 210, MARGIN = 10, OVERLAP = 12; // A4 横放，单位 mm

function pageTiles(board) {
  const stepX = PAGE_W - 2 * MARGIN - OVERLAP;
  const stepY = PAGE_H - 2 * MARGIN - OVERLAP;
  const nx = Math.max(1, Math.ceil((board.width - OVERLAP) / stepX));
  const ny = Math.max(1, Math.ceil((board.height - OVERLAP) / stepY));
  const tiles = [];
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      tiles.push({ ox: c * stepX, oy: r * stepY, col: c + 1, row: r + 1 });
    }
  }
  return { tiles, nx, ny };
}

// 以钉板坐标绘制全部内容（平移由外层 g 负责），打印用细线风格
function printContent(design) {
  const b = design.board;
  let h = '';
  const g = b.grid || 10;
  h += `<rect x="0" y="0" width="${b.width}" height="${b.height}" fill="#fff" stroke="#000" stroke-width="0.4"/>`;
  h += `<g stroke="#ddd" stroke-width="0.15">`;
  for (let x = g; x < b.width; x += g) h += `<line x1="${x}" y1="0" x2="${x}" y2="${b.height}"/>`;
  for (let y = g; y < b.height; y += g) h += `<line x1="0" y1="${y}" x2="${b.width}" y2="${y}"/>`;
  h += `</g>`;
  for (const z of design.zones) {
    h += `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="none" stroke="#c00" stroke-width="0.5" stroke-dasharray="3,2"/>
          <text x="${z.x + z.w / 2}" y="${z.y + z.h / 2}" font-size="5" fill="#c00" text-anchor="middle">禁布区 ${esc(z.name)}</text>`;
  }
  for (const bd of computeBundles(design)) {
    if (bd.wires.length < 2) continue;
    h += `<line x1="${bd.a.x}" y1="${bd.a.y}" x2="${bd.b.x}" y2="${bd.b.y}" stroke="#bbb" stroke-width="${bd.diameter}" stroke-linecap="round" opacity="0.5"/>`;
  }
  for (const w of design.wires) {
    const pts = resolvePath(design, w);
    if (pts.length < 2) continue;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p.x + ' ' + p.y).join(' ');
    h += `<path d="${d}" fill="none" stroke="${w.color}" stroke-width="${Math.max(w.gauge, 0.9)}" stroke-linejoin="round" stroke-linecap="round"/>`;
    const mid = pts[Math.floor(pts.length / 2)];
    h += `<text x="${mid.x}" y="${mid.y - 2}" font-size="4.5" fill="#000" text-anchor="middle">${esc(w.label)}</text>`;
  }
  for (const t of tieList(design)) {
    h += `<g stroke="#e67700" stroke-width="0.6"><line x1="${t.x - 2.5}" y1="${t.y - 2.5}" x2="${t.x + 2.5}" y2="${t.y + 2.5}"/><line x1="${t.x - 2.5}" y1="${t.y + 2.5}" x2="${t.x + 2.5}" y2="${t.y - 2.5}"/></g>`;
  }
  for (const n of design.nodes) {
    if (n.type === 'connector') {
      const w = Math.max(34, (n.pins || 4) * 7 + 12), hh = 18;
      h += `<rect x="${n.x - w / 2}" y="${n.y - hh / 2}" width="${w}" height="${hh}" fill="none" stroke="#000" stroke-width="0.5"/>
            <text x="${n.x}" y="${n.y - hh / 2 - 2}" font-size="5" font-weight="bold" text-anchor="middle">${esc(n.name)}</text>`;
    } else if (n.type === 'branch') {
      h += `<rect x="${n.x - 4}" y="${n.y - 4}" width="8" height="8" transform="rotate(45 ${n.x} ${n.y})" fill="none" stroke="#000" stroke-width="0.5"/>
            <text x="${n.x}" y="${n.y - 7}" font-size="4" text-anchor="middle">${esc(n.name)}</text>`;
    } else {
      h += `<circle cx="${n.x}" cy="${n.y}" r="2.5" fill="none" stroke="#000" stroke-width="0.5"/>
            <line x1="${n.x - 4}" y1="${n.y}" x2="${n.x + 4}" y2="${n.y}" stroke="#000" stroke-width="0.3"/>
            <line x1="${n.x}" y1="${n.y - 4}" x2="${n.x}" y2="${n.y + 4}" stroke="#000" stroke-width="0.3"/>
            <text x="${n.x}" y="${n.y - 5.5}" font-size="4" text-anchor="middle">${esc(n.name)}</text>`;
    }
  }
  return h;
}

export function openPrintTemplate(design) {
  const { tiles, nx, ny } = pageTiles(design.board);
  let pages = '';
  tiles.forEach((t, i) => {
    const clipId = 'clip' + i;
    pages += `<div class="page">
  <svg width="${PAGE_W}mm" height="${PAGE_H}mm" viewBox="0 0 ${PAGE_W} ${PAGE_H}" xmlns="http://www.w3.org/2000/svg">
    <defs><clipPath id="${clipId}"><rect x="${MARGIN}" y="${MARGIN}" width="${PAGE_W - 2 * MARGIN}" height="${PAGE_H - 2 * MARGIN}"/></clipPath></defs>
    <rect x="0.5" y="0.5" width="${PAGE_W - 1}" height="${PAGE_H - 1}" fill="none" stroke="#999" stroke-width="0.2"/>
    <text x="${MARGIN}" y="7" font-size="4" fill="#333">${esc(design.name)} — 钉板模板 1:1（第${t.row}行第${t.col}列，共${tiles.length}页）</text>
    <text x="${PAGE_W - MARGIN}" y="7" font-size="4" fill="#333" text-anchor="end">原点(${t.ox.toFixed(0)}, ${t.oy.toFixed(0)}) 拼接重叠${OVERLAP}mm</text>
    <g clip-path="url(#${clipId})"><g transform="translate(${MARGIN - t.ox},${MARGIN - t.oy})">${printContent(design)}</g></g>
    <g stroke="#06c" stroke-width="0.3">
      <path d="M${MARGIN - 4} ${MARGIN}h4M${MARGIN} ${MARGIN - 4}v4" fill="none"/>
      <path d="M${PAGE_W - MARGIN + 4} ${MARGIN}h-4M${PAGE_W - MARGIN} ${MARGIN - 4}v4" fill="none"/>
      <path d="M${MARGIN - 4} ${PAGE_H - MARGIN}h4M${MARGIN} ${PAGE_H - MARGIN + 4}v-4" fill="none"/>
      <path d="M${PAGE_W - MARGIN + 4} ${PAGE_H - MARGIN}h-4M${PAGE_W - MARGIN} ${PAGE_H - MARGIN + 4}v-4" fill="none"/>
    </g>
    <text x="${PAGE_W / 2}" y="${PAGE_H - 4}" font-size="3.5" fill="#666" text-anchor="middle">打印时请关闭“适应页面”，按 100% 比例输出即为实际尺寸</text>
  </svg>
</div>`;
  });
  openPrintWindow(design.name + ' - 打印模板', pages, 'A4 landscape');
  return tiles.length;
}

// ---------- 线号标签 ----------

export function openLabels(design) {
  const LW = 60, LH = 12, GAP = 2, MX = 10, MY = 10;
  const cols = Math.floor((210 - 2 * MX + GAP) / (LW + GAP));
  const rows = Math.floor((297 - 2 * MY + GAP) / (LH + GAP));
  const perPage = cols * rows;
  const list = cutList(design);
  if (!list.length) return 0;
  let pages = '';
  for (let p = 0; p * perPage < list.length; p++) {
    let labels = '';
    list.slice(p * perPage, (p + 1) * perPage).forEach((r, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = MX + col * (LW + GAP), y = MY + row * (LH + GAP);
      labels += `<g>
        <rect x="${x}" y="${y}" width="${LW}" height="${LH}" fill="none" stroke="#888" stroke-width="0.2" stroke-dasharray="1.5,1"/>
        <rect x="${x + 1}" y="${y + 1}" width="4" height="${LH - 2}" fill="${r.color}" stroke="#333" stroke-width="0.15"/>
        <text x="${x + 7}" y="${y + 5.2}" font-size="4.2" font-weight="bold">${esc(r.label)}</text>
        <text x="${x + 7}" y="${y + 9.6}" font-size="3">${esc(r.from)} → ${esc(r.to)}　⌀${r.gauge}</text>
        <text x="${x + LW - 2}" y="${y + 5.2}" font-size="3.6" text-anchor="end">${r.rounded}mm</text>
        <text x="${x + LW - 2}" y="${y + 9.6}" font-size="2.8" text-anchor="end">剥${r.stripFrom}/${r.stripTo}</text>
      </g>`;
    });
    pages += `<div class="page">
      <svg width="210mm" height="297mm" viewBox="0 0 210 297" xmlns="http://www.w3.org/2000/svg">
        <text x="${MX}" y="7" font-size="4" fill="#333">${esc(design.name)} — 线号标签（第${p + 1}页）</text>
        ${labels}
      </svg>
    </div>`;
  }
  openPrintWindow(design.name + ' - 线号标签', pages, 'A4 portrait');
  return list.length;
}

function openPrintWindow(title, pagesHtml, pageSize) {
  const win = window.open('', '_blank');
  if (!win) { alert('浏览器拦截了弹出窗口，请允许后重试'); return; }
  win.document.write(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: ${pageSize}; margin: 0; }
  html, body { margin: 0; padding: 0; background: #eee; }
  .page { page-break-after: always; margin: 8px auto; width: fit-content; background: #fff; box-shadow: 0 1px 6px #0003; }
  .page svg { display: block; }
  @media print { .page { margin: 0; box-shadow: none; } .noprint { display: none; } }
  .noprint { padding: 8px; text-align: center; font: 14px sans-serif; }
</style></head><body>
<div class="noprint"><button onclick="window.print()">打印</button>（请在打印对话框中选择 100% 比例 / 实际大小）</div>
${pagesHtml}
</body></html>`);
  win.document.close();
}
