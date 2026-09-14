// io.js — 存档接口、JSON 备份、CSV、分页打印模板与线号标签
'use strict';

import {
  resolvePath, computeBundles, cutList, materialSummary, tieList,
  nodeName, endpointStr, polyLen, spliceList, spliceKind, migrateDesign,
  coverList, coverGeometry, coverKind, coverLocateText,
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
        resolve(migrateDesign(d));
      } catch (e) { reject(e); }
    };
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsText(file);
  });
}

// ---------- CSV ----------

export function cutListCSV(design) {
  const rows = [['线号', '颜色', '线径mm', '起点', '终点', '路径长mm', '维修余量mm', '剥线mm', '裁线长mm', '建议裁线mm', '压接(起)', '压接(讫)', '拼接(起)', '拼接(讫)', '保护套(起)', '保护套(讫)']];
  for (const r of cutList(design)) {
    rows.push([
      r.label, r.color, r.gauge, r.from, r.to,
      r.path.toFixed(1), r.svc, r.strip, r.cut.toFixed(1), r.rounded,
      r.crimpFrom || '', r.crimpTo || '',
      r.spliceFrom || '', r.spliceTo || '', r.sleeveFrom || '', r.sleeveTo || '',
    ]);
  }
  const spl = spliceList(design);
  if (spl.length) {
    rows.push([]);
    rows.push(['拼接件', '类型', '孔位/已接', '适用线径', '剥线mm', '保护套外径mm', '保护套长度mm', '接入线号']);
    for (const s of spl) {
      rows.push([
        s.name, s.kindName, `${s.ports}/${s.count}`, `⌀${s.gaugeMin}~⌀${s.gaugeMax}`,
        s.strip, s.sleeveD || '', s.sleeveLen || '',
        s.wires.map(x => x.wire.label + '#' + x.pin).join(' '),
      ]);
    }
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
  // 包覆（波纹管/编织管/胶带）：按层次画出覆盖范围，标编号、起止与定位尺寸
  for (const c of design.covers || []) {
    const geo = coverGeometry(design, c);
    if (!geo.pts.length) continue;
    const kd = coverKind(c.kind);
    const d = geo.pts.map((p, i) => (i ? 'L' : 'M') + p.x + ' ' + p.y).join(' ');
    const w = c.kind === 'tape' ? Math.max(2.2, geo.maxD + 1.2) : Math.max(c.innerD || 2, geo.maxD + 1);
    h += `<path d="${d}" fill="none" stroke="${kd.color}" stroke-width="${w}" stroke-opacity="0.35" stroke-linecap="round"/>`;
    // 起止端竖线（收口位置）
    for (const p of [geo.pts[0], geo.pts[geo.pts.length - 1]]) {
      h += `<line x1="${p.x}" y1="${p.y - w / 2 - 1}" x2="${p.x}" y2="${p.y + w / 2 + 1}" stroke="${kd.color}" stroke-width="0.6"/>`;
    }
    const mid = geo.pts[Math.floor(geo.pts.length / 2)];
    h += `<text x="${mid.x}" y="${mid.y + 1.5}" font-size="4.2" font-weight="bold" fill="${kd.color}" text-anchor="middle" style="paint-order:stroke;stroke:#fff;stroke-width:1.2">${esc(kd.glyph)}${esc(c.name)}</text>`;
  }
  for (const n of design.nodes) {
    if (n.type === 'connector') {
      const w = Math.max(34, (n.pins || 4) * 7 + 12), hh = 18;
      h += `<rect x="${n.x - w / 2}" y="${n.y - hh / 2}" width="${w}" height="${hh}" fill="none" stroke="#000" stroke-width="0.5"/>
            <text x="${n.x}" y="${n.y - hh / 2 - 2}" font-size="5" font-weight="bold" text-anchor="middle">${esc(n.name)}</text>`;
    } else if (n.type === 'splice') {
      const ports = Math.max(2, n.ports || 4);
      const w = Math.max(18, ports * 6 + 8);
      const kind = spliceKind(n.kind);
      if (n.kind === 'cap') {
        h += `<path d="M ${n.x - w / 2 + 3} ${n.y + 4} L ${n.x - w / 2 + 1} ${n.y - 3} L ${n.x + w / 2 - 1} ${n.y - 3} L ${n.x + w / 2 - 3} ${n.y + 4} Z"
              fill="none" stroke="#000" stroke-width="0.5"/>`;
      } else if (n.kind === 'butt') {
        h += `<rect x="${n.x - w / 2 + 1}" y="${n.y - 5}" width="${w - 2}" height="8" rx="1.5" fill="none" stroke="#000" stroke-width="0.5"/>
              <line x1="${n.x}" y1="${n.y - 5}" x2="${n.x}" y2="${n.y + 3}" stroke="#000" stroke-width="0.4"/>`;
      } else {
        h += `<rect x="${n.x - w / 2 + 1}" y="${n.y - 5.5}" width="${w - 2}" height="9.5" rx="2" fill="none" stroke="#000" stroke-width="0.5"/>`;
      }
      for (let i = 1; i <= ports; i++) {
        const px = n.x - w / 2 + ((i - 0.5) / ports) * w;
        h += `<circle cx="${px}" cy="${n.y + 6.5}" r="1.1" fill="none" stroke="#000" stroke-width="0.3"/>`;
      }
      h += `<text x="${n.x}" y="${n.y - 8}" font-size="4.2" font-weight="bold" text-anchor="middle">${esc(kind.short)}${esc(n.name)}</text>`;
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
  openPrintWindow(design.name + ' - 打印模板', pages + spliceTablePage(design) + coverTablePage(design), 'A4 landscape');
  return tiles.length;
}

// 包覆下料与定位表（保留包覆范围、层次、材料规格与定位尺寸）
function coverTablePage(design) {
  const covers = coverList(design);
  if (!covers.length) return '';
  const rows = covers.map(cv => {
    const src = design.covers.find(x => x.id === cv.id);
    const closeName = ({ seal: '胶带收口', split: '剖开收口', none: '不处理（露线）' })[cv.branchClose] || cv.branchClose;
    const param = cv.kind === 'tape'
      ? `宽${cv.tapeW}mm · 节距${cv.pitch}mm · 搭接${cv.overlap}%`
      : `内径 ⌀${cv.innerD} · 搭接${cv.overlap}mm`;
    const cutText = cv.kind === 'tape' ? cv.cut.toFixed(0) + 'mm' : cv.rounded + 'mm';
    // 逐锚点定位尺寸：节点名 或 导线#弧长
    const locs = (src.anchors || []).map((a, i) => esc(coverLocateText(design, src, i))).join(' → ');
    return `<tr>
      <td><b>${esc(cv.name)}</b><br><span style="color:#666">第${cv.layer}层</span></td>
      <td>${esc(cv.glyph)} ${esc(cv.kindName)}</td>
      <td>${esc(cv.spec || '—')}<br><span style="color:#666">${esc(param)}</span></td>
      <td>⌀${cv.maxD.toFixed(1)}</td>
      <td>${cv.length.toFixed(0)}</td>
      <td><b>${cutText}</b></td>
      <td>${esc(closeName)}</td>
      <td class="l">${esc(cv.start)} → ${esc(cv.end)}</td>
      <td class="l">${locs}</td></tr>`;
  }).join('');
  return `<div class="page">
  <svg width="${PAGE_W}mm" height="${PAGE_H}mm" viewBox="0 0 ${PAGE_W} ${PAGE_H}" xmlns="http://www.w3.org/2000/svg">
    <foreignObject x="${MARGIN}" y="${MARGIN}" width="${PAGE_W - 2 * MARGIN}" height="${PAGE_H - 2 * MARGIN}">
      <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:sans-serif;color:#000">
        <h3 style="margin:0 0 6px;font-size:15px">${esc(design.name)} — 包覆下料与定位表（波纹管 / 编织套管 / 胶带缠绕）</h3>
        <table style="border-collapse:collapse;width:100%;font-size:10px" border="1">
          <thead><tr style="background:#eee">
            <th>编号/层次</th><th>类型</th><th>材料规格/参数</th><th>束径max</th>
            <th>路径mm</th><th>下料/用带</th><th>分支收口</th>
            <th style="text-align:left">起止范围</th><th style="text-align:left">逐锚点定位尺寸（沿路径锚点）</th>
          </tr></thead><tbody>${rows}</tbody></table>
        <p style="font-size:10px;color:#444;margin-top:8px">
          定位尺寸以“节点名”或“导线 沿线路长mm”给出；套管内径须 ≥ 束径，穿不过已装端头时，
          须在相应压接之前完成裁套与预套。钉板图中包覆按层次以彩色半透明覆盖段画出，起止竖线为收口位置。</p>
      </div>
    </foreignObject>
  </svg>
</div>`;
}

// 拼接件下料与工艺表（保留拼接拓扑：孔位、线径、剥线、保护套、接入线号）
function spliceTablePage(design) {
  const spl = spliceList(design);
  if (!spl.length) return '';
  const rows = spl.map(s => {
    const wires = s.wires.map(x =>
      `${esc(x.wire.label)}→${esc(endpointStr(design, x.wire[x.side === 'from' ? 'to' : 'from']))}#${x.pin}（⌀${x.wire.gauge}）`
    ).join('<br>');
    return `<tr>
      <td>${esc(s.name)}</td><td>${esc(s.kindName)}</td>
      <td>${s.ports}/${s.count}</td><td>⌀${s.gaugeMin}~⌀${s.gaugeMax}（实 ${esc(s.gaugeRange)}）</td>
      <td>${s.strip}</td><td>${s.sleeveD ? '⌀' + s.sleeveD + '×' + s.sleeveLen : '—'}</td>
      <td class="l">${wires}</td></tr>`;
  }).join('');
  return `<div class="page">
  <svg width="${PAGE_W}mm" height="${PAGE_H}mm" viewBox="0 0 ${PAGE_W} ${PAGE_H}" xmlns="http://www.w3.org/2000/svg">
    <foreignObject x="${MARGIN}" y="${MARGIN}" width="${PAGE_W - 2 * MARGIN}" height="${PAGE_H - 2 * MARGIN}">
      <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:sans-serif;color:#000">
        <h3 style="margin:0 0 6px;font-size:15px">${esc(design.name)} — 拼接件下料与压接工艺表</h3>
        <table style="border-collapse:collapse;width:100%;font-size:11px" border="1">
          <thead><tr style="background:#eee">
            <th>拼接件</th><th>类型</th><th>容量/已接</th><th>适用/实配线径</th>
            <th>剥线mm</th><th>保护套mm</th><th style="text-align:left">集线线号与孔位（剥线→集线→压接→套管确认）</th>
          </tr></thead><tbody>${rows}</tbody></table>
        <p style="font-size:10px;color:#444;margin-top:8px">
          工艺：按孔位逐根送线到位 → 集线核对线径组合与容量 → 压接/超声焊接 → 套保护套并热缩确认；未接齐不得完成。</p>
      </div>
    </foreignObject>
  </svg>
</div>`;
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
        <text x="${x + LW - 2}" y="${y + 9.6}" font-size="2.8" text-anchor="end">剥${r.stripFrom}/${r.stripTo}${r.sleeveFrom || r.sleeveTo ? ' 套' + esc([r.sleeveFrom, r.sleeveTo].filter(Boolean).join('/')) : ''}</text>
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
