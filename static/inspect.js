// inspect.js — 电气检验批次：状态机、读数录入、异常处置、CSV 导入、归档比较与复核单打印
'use strict';

import { esc } from './render.js';

const $ = id => document.getElementById(id);

const STATUS_NAMES = { preparing: '待准备', testing: '检测中', review: '待复核', archived: '已归档' };
const LEVEL_ICON = { error: '⛔', manual: '🖐', warn: '⚠️' };
const KIND_NAMES = {
  open: '开路', short: '跨网短接', miswire: '错接', duplicate: '重复测量',
  invalid_endpoint: '端点无效', missing_unit: '单位缺失', conflict: '结论矛盾', uncovered: '网络未覆盖',
};
const DISP_ACTIONS = ['确认缺陷（待返修）', '复测合格', '作废读数', '免于测试', '确认重复', '其他'];
const POLARITY_NAMES = { none: '—', normal: '正向', reverse: '反向' };
const UNIT_SCALE = { 'mΩ': 0.001, 'Ω': 1, 'kΩ': 1000, 'MΩ': 1e6 };
const NET_COLORS = ['#1f77b4', '#2ca02c', '#9467bd', '#8c564b', '#e377c2',
  '#17becf', '#bcbd22', '#ff7f0e', '#d62728', '#7f7f7f'];

const state = {
  batches: [],
  current: null,    // {batch, snapshot, readings, dispositions}
  analysis: null,   // {anomalies, coverage, recommendations, stats}
  entryA: '', entryB: '',
  designs: [],
  csvRows: null, csvPreview: null,
};

// ---------- 接口 ----------

async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || r.statusText);
    e.payload = data;
    throw e;
  }
  return data;
}
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

function setStatus(t) { $('statusHint').textContent = t; }

// ---------- 载入 ----------

async function loadBatchList(keepId) {
  state.batches = await api('/api/batches');
  $('batchSel').innerHTML = '<option value="">（选择批次）</option>' + state.batches.map(b =>
    `<option value="${b.id}" ${keepId === b.id ? 'selected' : ''}>${esc(b.name)}｜${STATUS_NAMES[b.status]}${b.paused ? '｜已暂停' : ''}</option>`
  ).join('');
}

async function loadBatch(id) {
  const [detail, analysis] = await Promise.all([
    api('/api/batches/' + id),
    api(`/api/batches/${id}/analysis`),
  ]);
  state.current = detail;
  state.analysis = analysis;
  state.entryA = '';
  state.entryB = '';
  renderAll();
}

async function refresh() {
  const id = state.current && state.current.batch.id;
  await loadBatchList(id);
  if (id) await loadBatch(id);
  else renderAll();
}

// ---------- 渲染 ----------

function renderAll() {
  const cur = state.current;
  $('emptyHint').classList.toggle('hidden', !!cur);
  for (const id of ['connViews', 'entryFields']) $(id).classList.toggle('hidden', !cur);
  if (!cur) {
    $('batchStatus').textContent = '';
    $('batchStatus').className = 'qc-status';
    $('statusActions').innerHTML = '';
    $('batchMeta').innerHTML = '';
    $('netList').innerHTML = '';
    $('recList').innerHTML = '';
    $('qcTab-anoms').innerHTML = '';
    $('qcTab-readings').innerHTML = '';
    $('qcTab-archive').innerHTML = '';
    $('anomBadge').classList.add('hidden');
    $('pausedBanner').classList.add('hidden');
    return;
  }
  renderMeta();
  renderActions();
  renderNets();
  renderRecs();
  renderEntryOptions();
  renderConnViews();
  renderAnoms();
  renderReadings();
  renderArchive();
  const b = cur.batch;
  $('entryFields').disabled = !(b.status === 'testing' && !b.paused);
  $('pausedBanner').classList.toggle('hidden', !(b.status === 'testing' && b.paused));
  $('entryHint').textContent = {
    preparing: '点击顶栏「开测」后开始录入',
    testing: b.paused ? '已暂停' : '',
    review: '待复核：处置异常后可归档，或返回检测',
    archived: '已归档（只读）',
  }[b.status];
}

function renderMeta() {
  const b = state.current.batch, s = state.analysis.stats;
  const st = $('batchStatus');
  st.textContent = STATUS_NAMES[b.status] + (b.paused ? ' · 已暂停' : '');
  st.className = 'qc-status ' + b.status;
  $('batchMeta').innerHTML = `<h4>批次信息</h4>
    <div class="meta">方案：${esc(state.current.snapshot.design_name || '—')}</div>
    <div class="meta">创建：${esc(b.created_at).replace('T', ' ')}　更新：${esc(b.updated_at).replace('T', ' ')}</div>
    <div class="meta">读数 ${s.readings}（撤回 ${s.withdrawn}） · 网络覆盖 ${s.covered}/${s.nets} · 未决异常 ${s.unresolved}</div>`;
}

function renderActions() {
  const b = state.current.batch;
  const el = $('statusActions');
  let h = '';
  if (b.status === 'preparing') h += '<button id="actStart">开测</button>';
  if (b.status === 'testing') {
    h += b.paused ? '<button id="actResume">继续检测</button>' : '<button id="actPause">暂停后续测</button>';
    h += '<button id="actFinish">结束检测</button>';
  }
  if (b.status === 'review') h += '<button id="actReopen">返回检测</button><button id="actArchive">归档</button>';
  if (b.status === 'review' || b.status === 'archived') h += '<button id="actPrint">打印复核单</button>';
  el.innerHTML = h;
  const bind = (id, fn) => { const x = $(id); if (x) x.onclick = fn; };
  bind('actStart', () => statusAction('start', '已开测，开始录入读数'));
  bind('actPause', () => statusAction('pause', '已暂停后续测'));
  bind('actResume', () => statusAction('resume', '已继续检测'));
  bind('actFinish', () => {
    const s = state.analysis.stats;
    if (s.covered < s.nets && !confirm(`尚有 ${s.nets - s.covered} 个网络未覆盖，仍要结束检测进入复核？`)) return;
    statusAction('finish', '已进入待复核，请处置异常后归档');
  });
  bind('actReopen', () => statusAction('reopen', '已返回检测'));
  bind('actArchive', doArchive);
  bind('actPrint', printSheet);
}

async function statusAction(action, okMsg) {
  try {
    await post(`/api/batches/${state.current.batch.id}/status`, { action });
    setStatus(okMsg);
    await refresh();
  } catch (e) { setStatus('操作失败：' + e.message); }
}

async function doArchive() {
  if (!confirm('归档后批次变为只读，确认归档？')) return;
  try {
    await post(`/api/batches/${state.current.batch.id}/status`, { action: 'archive' });
    setStatus('批次已归档，可在「归档」页与同方案批次并排比较');
    await refresh();
  } catch (e) {
    const un = e.payload && e.payload.unresolved;
    setStatus('归档失败：' + e.message + (un && un.length ? `（如：${un[0].msg}）` : ''));
    switchTab('anoms');
    await refresh();
  }
}

// ---------- 网络覆盖与推荐测点 ----------

function renderNets() {
  const cur = state.current;
  const testing = cur.batch.status === 'testing';
  $('netList').innerHTML = state.analysis.coverage.map(c => {
    const sp = cur.snapshot.nets.find(n => n.id === c.net);
    const via = sp && sp.splices && sp.splices.length ? ` <span class="viasp">🔗 ${esc(sp.splices.join('、'))}</span>` : '';
    return `
    <div class="netitem ${c.covered ? 'done' : ''}">
      <div><b>${esc(c.net)}</b> ${esc(c.label)} ${c.covered ? '✓' : ''}${via}</div>
      <div class="eps">${c.endpoints.map(esc).join(' · ')}</div>
      <div class="prog"><span>已测 ${c.measured}/${c.needed}</span>
        ${testing ? `<button data-retest="${esc(c.net)}" title="撤回该网络全部有效读数后重新测量">重测</button>` : ''}
      </div>
    </div>`;
  }).join('') || '<p class="hint">快照中没有网络。</p>';
  $('netList').querySelectorAll('[data-retest]').forEach(btn => (btn.onclick = async () => {
    if (!confirm(`重测 ${btn.dataset.retest}：该网络现有读数将被撤回，继续？`)) return;
    try {
      const r = await post(`/api/batches/${cur.batch.id}/retest`, { net: btn.dataset.retest });
      setStatus(`已撤回 ${r.withdrawn} 条读数，可重新测量 ${btn.dataset.retest}`);
      await refresh();
    } catch (e) { setStatus('重测失败：' + e.message); }
  }));
}

function renderRecs() {
  const recs = state.analysis.recommendations;
  $('recList').innerHTML = recs.length ? recs.map((r, i) => `
    <div class="recitem ${i === 0 ? 'cur' : ''}" data-a="${esc(r.a)}" data-b="${esc(r.b)}">
      <b>${esc(r.net)}</b> ${esc(r.label)}：${esc(r.a)} ↔ ${esc(r.b)}
      <span class="hint">余 ${r.remaining} 对</span>
    </div>`).join('') : '<p class="hint">全部网络已覆盖。</p>';
  $('recList').querySelectorAll('.recitem').forEach(div => (div.onclick = () => {
    state.entryA = div.dataset.a;
    state.entryB = div.dataset.b;
    syncEntryUI();
    setStatus(`已装入推荐测点 ${div.dataset.a} ↔ ${div.dataset.b}`);
  }));
}

// ---------- 连接器正视图 ----------

function pinNetMap(snapshot) {
  const m = new Map();
  snapshot.nets.forEach((n, i) => {
    const color = NET_COLORS[i % NET_COLORS.length];
    for (const ep of n.endpoints) m.set(ep, { id: n.id, label: n.label, color });
  });
  return m;
}

function connSVG(conn, pinNet, covOf, rec) {
  const pins = conn.pins;
  const perRow = pins <= 8 ? pins : Math.ceil(pins / 2);
  const rows = Math.ceil(pins / perRow);
  const W = perRow * 26 + 20, H = rows * 28 + 42;
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  s += `<rect x="1" y="14" width="${W - 2}" height="${H - 16}" rx="4" fill="#fff" stroke="#78909c"/>`;
  s += `<text x="${W / 2}" y="10" font-size="9" font-weight="bold" text-anchor="middle" fill="#37474f">${esc(conn.name)}</text>`;
  for (let i = 1; i <= pins; i++) {
    const ep = `${conn.name}.${i}`;
    const row = Math.floor((i - 1) / perRow), col = (i - 1) % perRow;
    const cx = 23 + col * 26, cy = 36 + row * 28;
    const net = pinNet.get(ep);
    const color = net ? net.color : '#cfd8dc';
    const covered = net ? covOf.get(net.id) : false;
    let rings = '';
    if (rec && (rec.a === ep || rec.b === ep)) {
      rings += `<circle cx="${cx}" cy="${cy}" r="11.5" fill="none" stroke="#2e7d32" stroke-width="2" class="pulse"/>`;
    }
    if (state.entryA === ep) rings += `<circle cx="${cx}" cy="${cy}" r="11.5" fill="none" stroke="#d62728" stroke-width="2.5"/>`;
    if (state.entryB === ep) rings += `<circle cx="${cx}" cy="${cy}" r="11.5" fill="none" stroke="#1565c0" stroke-width="2.5"/>`;
    s += `<g class="qc-pin" data-ep="${ep}">${rings}
      <circle cx="${cx}" cy="${cy}" r="8" fill="${color}" fill-opacity="${net ? (covered ? 0.95 : 0.35) : 0.5}"
        stroke="${net ? color : '#90a4ae'}" stroke-width="1.2" ${covered ? '' : 'stroke-dasharray="2.5,2"'}/>
      <text x="${cx}" y="${cy + 3}" font-size="8" text-anchor="middle" fill="#222">${i}</text>
      <title>${ep}${net ? ` · ${net.id} ${net.label}` : ' · 未使用端子'}</title>
    </g>`;
  }
  return s + '</svg>';
}

function renderConnViews() {
  const cur = state.current;
  if (!cur) return;
  const snap = cur.snapshot;
  const pinNet = pinNetMap(snap);
  const covOf = new Map(state.analysis.coverage.map(c => [c.net, c.covered]));
  const rec = state.analysis.recommendations[0] || null;
  $('connViews').innerHTML = snap.connectors.map(c =>
    `<div class="conn-card">${connSVG(c, pinNet, covOf, rec)}</div>`).join('');
  $('connViews').querySelectorAll('.qc-pin').forEach(g => g.addEventListener('click', () => {
    const ep = g.dataset.ep;
    if (!state.entryA || (state.entryA && state.entryB)) {
      state.entryA = ep;
      state.entryB = '';
    } else {
      state.entryB = ep;
    }
    syncEntryUI();
  }));
}

// ---------- 读数录入 ----------

function renderEntryOptions() {
  const snap = state.current.snapshot;
  const opts = snap.connectors.map(c => {
    const os = [];
    for (let p = 1; p <= c.pins; p++) os.push(`<option>${c.name}.${p}</option>`);
    return `<optgroup label="${esc(c.name)}">${os.join('')}</optgroup>`;
  }).join('');
  for (const id of ['epA', 'epB']) $(id).innerHTML = '<option value="">（未选）</option>' + opts;
  syncEntryUI();
}

function syncEntryUI() {
  $('epA').value = state.entryA;
  $('epB').value = state.entryB;
  renderConnViews();
}

async function submitReading() {
  const cur = state.current;
  if (!cur) return;
  const a = $('epA').value, b = $('epB').value;
  if (!a || !b) return setStatus('请先选择探针 A / B 两个端点');
  if (a === b) return setStatus('两个端点相同，无法测量');
  const ohmsRaw = $('ohms').value.trim();
  const body = {
    a, b,
    result: document.querySelector('input[name=result]:checked').value,
    ohms: ohmsRaw === '' ? null : +ohmsRaw,
    unit: $('unit').value,
    polarity: $('polarity').value,
    operator: $('operator').value.trim(),
    note: $('note').value.trim(),
  };
  if (body.ohms !== null && !(body.ohms >= 0)) return setStatus('阻值无效');
  try {
    await post(`/api/batches/${cur.batch.id}/readings`, body);
    localStorage.setItem('qc.operator', body.operator);
    $('note').value = '';
    await refresh();
    const rec = state.analysis.recommendations[0];
    if (rec) {
      state.entryA = rec.a;
      state.entryB = rec.b;
      syncEntryUI();
    }
    setStatus(`已录入 ${a}—${b}${rec ? `，下一测点 ${rec.a} ↔ ${rec.b}` : ''}`);
  } catch (e) { setStatus('录入失败：' + e.message); }
}

async function withdrawLast() {
  const cur = state.current;
  if (!cur) return;
  const rs = cur.readings.filter(r => !r.withdrawn);
  if (!rs.length) return setStatus('没有可撤回的读数');
  const last = rs[rs.length - 1];
  try {
    await post(`/api/batches/${cur.batch.id}/readings/${last.id}/withdraw`);
    setStatus(`已撤回最近读数 #${last.id}（${last.a}—${last.b}）`);
    await refresh();
  } catch (e) { setStatus('撤回失败：' + e.message); }
}

// ---------- 异常处置 ----------

function pairReadings(a, b) {
  return state.current.readings.filter(r =>
    !r.withdrawn && ((r.a === a && r.b === b) || (r.a === b && r.b === a)));
}

function renderAnoms() {
  const cur = state.current;
  const an = state.analysis.anomalies;
  const un = an.filter(a => !a.resolved).length;
  const badge = $('anomBadge');
  badge.textContent = un;
  badge.classList.toggle('hidden', !un);
  const el = $('qcTab-anoms');
  if (!an.length) {
    el.innerHTML = '<div class="okline">✓ 当前无异常。</div>';
    return;
  }
  const canDispose = ['testing', 'review'].includes(cur.batch.status);
  const testing = cur.batch.status === 'testing';
  el.innerHTML = an.map(a => {
    const hist = cur.dispositions.filter(d => d.akey === a.key).map(d =>
      `<div class="dp-hist">✔ ${esc(d.action)}<span class="hint"> ${esc(d.operator || '—')} ${esc(d.created_at).replace('T', ' ')}</span>${d.note ? ' — ' + esc(d.note) : ''}</div>`
    ).join('');
    let extra = '';
    if (!a.resolved && testing && a.reading_id) {
      extra += `<button data-wd-rid="${a.reading_id}" class="mini">撤回读数 #${a.reading_id}</button>`;
    }
    if (!a.resolved && testing && a.kind === 'conflict' && a.endpoints.length === 2) {
      const rs = pairReadings(a.endpoints[0], a.endpoints[1]);
      extra += '<div class="hint">相关读数：' + rs.map(r =>
        `#${r.id} ${r.result === 'continuity' ? '导通' : '开路'} <button data-wd-rid="${r.id}" class="mini">撤回</button>`
      ).join('　') + '</div>';
    }
    const form = (!a.resolved && canDispose) ? `
      <div class="dp-form">
        <select class="dp-action">${DISP_ACTIONS.map(x => `<option>${x}</option>`).join('')}</select>
        <input class="dp-note" placeholder="处置说明（可空）">
        <button data-dp-key="${esc(a.key)}" data-dp-kind="${esc(a.kind)}">提交结论</button>
      </div>` : '';
    return `<div class="anomitem ${a.level} ${a.resolved ? 'resolved' : ''}">
      <div>${LEVEL_ICON[a.level] || 'ℹ️'} <b>${KIND_NAMES[a.kind] || a.kind}</b>${a.resolved ? ' <span class="hint">（已结论）</span>' : ''}</div>
      <div class="amsg">${esc(a.msg)}</div>
      ${extra}${hist}${form}
    </div>`;
  }).join('');
}

// ---------- 读数日志 ----------

function renderReadings() {
  const cur = state.current;
  const el = $('qcTab-readings');
  const rs = [...cur.readings].reverse();
  if (!rs.length) {
    el.innerHTML = '<p class="hint">尚无读数。</p>';
    return;
  }
  const testing = cur.batch.status === 'testing';
  el.innerHTML = `<table class="list"><thead><tr>
    <th>#</th><th class="l">时间</th><th class="l">测点</th><th>结果</th><th>阻值</th><th>极性</th><th class="l">检验人</th><th>来源</th><th></th>
    </tr></thead><tbody>` + rs.map(r => `<tr class="${r.withdrawn ? 'wd' : ''}">
      <td>${r.id}</td><td class="l">${esc(r.created_at).replace('T', ' ')}</td>
      <td class="l">${esc(r.a)} — ${esc(r.b)}</td>
      <td>${r.result === 'continuity' ? '导通' : '开路'}</td>
      <td>${r.ohms == null ? '' : esc(String(r.ohms)) + ' ' + esc(r.unit || '')}</td>
      <td>${POLARITY_NAMES[r.polarity] || '—'}</td>
      <td class="l">${esc(r.operator || '')}</td>
      <td>${r.source === 'csv' ? 'CSV' : '手动'}</td>
      <td>${r.withdrawn ? '已撤回' : (testing ? `<button data-wd-rid="${r.id}" class="mini">撤回</button>` : '')}</td>
    </tr>`).join('') + '</tbody></table>';
}

// ---------- CSV 导入 ----------

function mapResult(s) {
  if (/^(导通|通|ok|pass|√|✓|1)$/i.test(s)) return 'continuity';
  if (/^(开路|断|open|ng|×|0)$/i.test(s)) return 'open';
  return '';
}
function mapPolarity(s) {
  if (/^正/.test(s)) return 'normal';
  if (/^反/.test(s)) return 'reverse';
  return 'none';
}

function parseCSV(text) {
  const rows = [];
  for (const ln of text.split(/\r?\n/)) {
    const line = ln.trim();
    if (!line) continue;
    const cells = line.split(/[,，;；\t]/).map(s => s.trim());
    if (!rows.length && cells.some(c => /起点|终点|结果/.test(c))) continue; // 表头
    if (cells.length < 3) {
      rows.push({ a: cells[0] || '', b: cells[1] || '', result: '', ohms: null, unit: '', polarity: 'none' });
      continue;
    }
    rows.push({
      a: cells[0], b: cells[1], result: mapResult(cells[2]),
      ohms: cells[3] && !isNaN(+cells[3]) ? +cells[3] : null,
      unit: cells[4] || '', polarity: mapPolarity(cells[5] || ''),
    });
  }
  return rows;
}

async function previewCsv() {
  const cur = state.current;
  if (!cur) return setStatus('请先选择批次');
  const rows = parseCSV($('csvText').value);
  if (!rows.length) {
    $('csvPreviewBox').innerHTML = '<p class="hint">未解析到数据行。</p>';
    state.csvRows = state.csvPreview = null;
    return;
  }
  state.csvRows = rows;
  try {
    state.csvPreview = await post(`/api/batches/${cur.batch.id}/readings/preview`, { rows });
    renderCsvPreview();
    setStatus(`预览 ${rows.length} 行：${state.csvPreview.filter(r => r.ok).length} 行可导入`);
  } catch (e) { setStatus('预览失败：' + e.message); }
}

function renderCsvPreview() {
  const rows = state.csvPreview;
  const okCount = rows.filter(r => r.ok).length;
  let h = `<table class="list"><thead><tr><th>行</th><th class="l">起点</th><th class="l">终点</th><th>结果</th><th>阻值</th><th class="l">检查</th></tr></thead><tbody>`;
  for (const r of rows) {
    h += `<tr class="${r.ok ? (r.problems.length ? 'warnrow' : '') : 'badrow'}">
      <td>${r.line}</td><td class="l">${esc(r.a)}</td><td class="l">${esc(r.b)}</td>
      <td>${r.result === 'continuity' ? '导通' : r.result === 'open' ? '开路' : '？'}</td>
      <td>${r.ohms == null ? '' : esc(String(r.ohms)) + ' ' + esc(r.unit)}</td>
      <td class="l">${r.problems.length ? esc(r.problems.join('；')) : '✓'}</td></tr>`;
  }
  h += `</tbody></table>
    <div class="row btns"><button id="csvImportBtn" ${okCount ? '' : 'disabled'}>导入 ${okCount} 行</button></div>
    <p class="hint">标注「端点无效 / 冲突 / 重复 / 单位缺失」的行仍会导入并转人工处理；无法解析的行将被跳过。</p>`;
  $('csvPreviewBox').innerHTML = h;
  const btn = $('csvImportBtn');
  if (btn) btn.onclick = doCsvImport;
}

async function doCsvImport() {
  const cur = state.current;
  if (!cur || !state.csvRows) return;
  const rows = state.csvRows.filter((r, i) => state.csvPreview[i] && state.csvPreview[i].ok);
  try {
    const r = await post(`/api/batches/${cur.batch.id}/readings/import`, { rows });
    setStatus(`CSV 导入完成：写入 ${r.inserted} 行，跳过 ${r.skipped} 行`);
    $('csvText').value = '';
    $('csvPreviewBox').innerHTML = '';
    state.csvRows = state.csvPreview = null;
    await refresh();
    switchTab('anoms');
  } catch (e) { setStatus('导入失败：' + e.message); }
}

// ---------- 归档：复核单与并排比较 ----------

function renderArchive() {
  const cur = state.current;
  const b = cur.batch;
  const el = $('qcTab-archive');
  const canPrint = b.status === 'review' || b.status === 'archived';
  let h = `<h4>复核单</h4>
    <div class="row btns"><button id="printSheet" ${canPrint ? '' : 'disabled'}>打印复核单</button></div>
    <p class="hint">包含针位、实测值与处置记录；待复核或已归档时可用。</p>
    <h4>同方案归档批次并排比较</h4>`;
  const archived = state.batches.filter(x => x.status === 'archived' && x.design_id === b.design_id);
  if (!archived.length) {
    h += '<p class="hint">该方案暂无已归档批次。</p>';
  } else {
    h += archived.map(x =>
      `<label class="chk"><input type="checkbox" class="cmpSel" value="${x.id}" ${x.id === b.id ? 'checked' : ''}> ${esc(x.name)}（${esc(x.updated_at).replace('T', ' ')}）</label>`
    ).join('');
    h += '<div class="row btns"><button id="cmpRun">并排比较</button></div><div id="cmpBox"></div>';
  }
  el.innerHTML = h;
  const ps = $('printSheet');
  if (ps) ps.onclick = printSheet;
  const cr = $('cmpRun');
  if (cr) cr.onclick = runCompare;
}

function fmtOhm(v) {
  if (v < 1) return (v * 1000).toFixed(1) + ' mΩ';
  if (v >= 1000) return (v / 1000).toFixed(2) + ' kΩ';
  return v.toFixed(2) + ' Ω';
}

function ohmRange(detail, endpoints) {
  const set = new Set(endpoints);
  let min = Infinity, max = -Infinity;
  for (const r of detail.readings) {
    if (r.withdrawn || r.result !== 'continuity' || r.ohms == null) continue;
    const sc = UNIT_SCALE[r.unit];
    if (!sc || !set.has(r.a) || !set.has(r.b)) continue;
    const v = r.ohms * sc;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? '—' : (min === max ? fmtOhm(min) : fmtOhm(min) + ' ~ ' + fmtOhm(max));
}

async function runCompare() {
  const ids = [...document.querySelectorAll('.cmpSel:checked')].map(x => +x.value);
  if (ids.length < 2) return setStatus('请勾选至少两个已归档批次');
  try {
    const list = await api('/api/batches/compare?ids=' + ids.join(','));
    renderCompare(list);
    setStatus(`已比较 ${list.length} 个归档批次`);
  } catch (e) { setStatus('比较失败：' + e.message); }
}

function renderCompare(list) {
  const netKeys = [];
  const covMaps = list.map(d => {
    const m = new Map();
    for (const c of d.analysis.coverage) {
      const k = c.endpoints.join(' · ');
      if (!netKeys.includes(k)) netKeys.push(k);
      m.set(k, c);
    }
    return m;
  });
  let h = `<table class="list"><thead><tr><th class="l">项目</th>${list.map(d => `<th>${esc(d.batch.name)}</th>`).join('')}</tr></thead><tbody>`;
  h += `<tr><td class="l">归档时间</td>${list.map(d => `<td>${esc(d.batch.updated_at).replace('T', ' ')}</td>`).join('')}</tr>`;
  h += `<tr><td class="l">有效读数</td>${list.map(d => `<td>${d.analysis.stats.readings}</td>`).join('')}</tr>`;
  h += `<tr><td class="l">异常（已结论/总数）</td>${list.map(d => `<td>${d.analysis.stats.anomalies - d.analysis.stats.unresolved}/${d.analysis.stats.anomalies}</td>`).join('')}</tr>`;
  for (const k of netKeys) {
    h += `<tr><td class="l">${esc(k)}</td>`;
    list.forEach((d, i) => {
      const c = covMaps[i].get(k);
      h += c ? `<td>${c.covered ? '✓ 覆盖' : '✗ 未覆盖'}<br><span class="hint">${ohmRange(d, c.endpoints)}</span></td>` : '<td>—</td>';
    });
    h += '</tr>';
  }
  $('cmpBox').innerHTML = h + '</tbody></table>';
}

function printSheet() {
  const cur = state.current;
  if (!cur) return;
  const b = cur.batch, snap = cur.snapshot, an = state.analysis;
  const covMap = new Map(an.coverage.map(c => [c.net, c]));
  const netRows = snap.nets.map(n => {
    const c = covMap.get(n.id);
    const via = n.splices && n.splices.length ? `（经拼接 ${n.splices.join('、')}）` : '';
    return `<tr><td>${esc(n.id)}</td><td>${esc(n.label)}</td><td>${n.endpoints.map(esc).join(' · ')}${via}</td><td>${c && c.covered ? '已覆盖' : '未覆盖'}</td></tr>`;
  }).join('');
  // 拼接拓扑快照
  const spl = snap.splices || [];
  const splRows = spl.map(s => {
    const used = new Set();
    snap.nets.forEach(n => (n.splices || []).includes(s.name) && n.endpoints.forEach(e => used.add(e)));
    const kindName = { cap: '闭端', butt: '对接', ultra: '超声焊' }[s.kind] || s.kind;
    return `<tr><td>${esc(s.name)}</td><td>${esc(kindName)}</td><td>${s.ports} 孔</td>
      <td>⌀${s.gauge_min}~⌀${s.gauge_max}</td><td>${s.strip}</td>
      <td>${s.sleeve_d ? '⌀' + s.sleeve_d + '×' + s.sleeve_len : '—'}</td>
      <td>${[...used].map(esc).join(' · ')}</td></tr>`;
  }).join('');
  const readRows = cur.readings.map(r => `<tr${r.withdrawn ? ' class="wd"' : ''}>
    <td>${r.id}</td><td>${esc(r.created_at).replace('T', ' ')}</td><td>${esc(r.a)}</td><td>${esc(r.b)}</td>
    <td>${r.result === 'continuity' ? '导通' : '开路'}</td>
    <td>${r.ohms == null ? '' : esc(String(r.ohms)) + ' ' + esc(r.unit || '')}</td>
    <td>${POLARITY_NAMES[r.polarity] || '—'}</td><td>${esc(r.operator || '')}</td>
    <td>${r.source === 'csv' ? 'CSV' : '手动'}</td>
    <td>${r.withdrawn ? '已撤回 ' : ''}${esc(r.note || '')}</td></tr>`).join('');
  const anomRows = an.anomalies.map(a => {
    const ds = cur.dispositions.filter(d => d.akey === a.key).map(d =>
      `${esc(d.action)}（${esc(d.operator || '—')} ${esc(d.created_at).replace('T', ' ')}）${d.note ? '：' + esc(d.note) : ''}`
    ).join('<br>');
    return `<tr><td>${KIND_NAMES[a.kind] || a.kind}</td><td>${esc(a.msg)}</td><td>${a.resolved ? '已结论' : '未结论'}</td><td>${ds || '—'}</td></tr>`;
  }).join('');
  printWindow(`${b.name} - 复核单`, `
    <h2>电气检验复核单</h2>
    <p>批次：${esc(b.name)}　方案：${esc(snap.design_name || '—')}　状态：${STATUS_NAMES[b.status]}<br>
    创建：${esc(b.created_at).replace('T', ' ')}　更新：${esc(b.updated_at).replace('T', ' ')}<br>
    读数 ${an.stats.readings}（撤回 ${an.stats.withdrawn}）　网络覆盖 ${an.stats.covered}/${an.stats.nets}　未决异常 ${an.stats.unresolved}</p>
    <h3>一、网络与针位</h3>
    <table><thead><tr><th>网络</th><th>线号</th><th>针位（拼接拓扑）</th><th>覆盖</th></tr></thead><tbody>${netRows}</tbody></table>
    ${splRows ? `<h3>二、实体拼接件</h3>
    <table><thead><tr><th>拼接件</th><th>类型</th><th>容量</th><th>适用线径</th><th>剥线mm</th><th>保护套mm</th><th>连通端子</th></tr></thead>
    <tbody>${splRows}</tbody></table>` : ''}
    <h3>${splRows ? '三' : '二'}、实测读数</h3>
    <table><thead><tr><th>#</th><th>时间</th><th>测点 A</th><th>测点 B</th><th>结果</th><th>阻值</th><th>极性</th><th>检验人</th><th>来源</th><th>备注</th></tr></thead>
    <tbody>${readRows || '<tr><td colspan="10">（无）</td></tr>'}</tbody></table>
    <h3>${splRows ? '四' : '三'}、异常与处置记录</h3>
    <table><thead><tr><th>类型</th><th>说明</th><th>状态</th><th>处置记录</th></tr></thead>
    <tbody>${anomRows || '<tr><td colspan="4">（无异常）</td></tr>'}</tbody></table>
    <p class="sign">检验：＿＿＿＿＿＿　复核：＿＿＿＿＿＿　日期：＿＿＿＿＿＿</p>`);
}

function printWindow(title, bodyHtml) {
  const win = window.open('', '_blank');
  if (!win) { alert('浏览器拦截了弹出窗口，请允许后重试'); return; }
  win.document.write(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  body { font: 12px/1.5 "PingFang SC", "Microsoft YaHei", sans-serif; color: #000; }
  h2 { font-size: 18px; } h3 { font-size: 14px; margin: 14px 0 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th, td { border: 1px solid #666; padding: 3px 6px; text-align: left; }
  th { background: #eee; }
  tr.wd td { color: #999; text-decoration: line-through; }
  .sign { margin-top: 24px; }
  @media print { .noprint { display: none; } }
</style></head><body>
<div class="noprint"><button onclick="window.print()">打印</button></div>
${bodyHtml}
</body></html>`);
  win.document.close();
}

// ---------- 选项卡 ----------

function switchTab(t) {
  document.querySelectorAll('#qcTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.tab === t));
  document.querySelectorAll('#qcRight .qc-panel').forEach(p => p.classList.add('hidden'));
  $('qcTab-' + t).classList.remove('hidden');
}

// ---------- 事件绑定 ----------

document.querySelectorAll('#qcTabs .tab').forEach(b => (b.onclick = () => switchTab(b.dataset.tab)));

$('batchSel').onchange = async e => {
  const id = +e.target.value;
  if (!id) {
    state.current = null;
    state.analysis = null;
    renderAll();
    return;
  }
  try {
    await loadBatch(id);
    setStatus('已载入批次');
  } catch (err) { setStatus('载入失败：' + err.message); }
};

$('newBatchBtn').onclick = async () => {
  try {
    state.designs = await api('/api/designs');
  } catch (e) { return setStatus('无法读取方案列表：' + e.message); }
  if (!state.designs.length) return setStatus('本地库暂无钉板方案，请先在推演台保存方案');
  const today = new Date().toISOString().slice(0, 10);
  $('nbDesign').innerHTML = state.designs.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  $('nbName').value = `${state.designs[0].name}-检验-${today}`;
  $('newBatchModal').classList.remove('hidden');
};
$('nbDesign').onchange = e => {
  const d = state.designs.find(x => x.id === +e.target.value);
  if (d) $('nbName').value = `${d.name}-检验-${new Date().toISOString().slice(0, 10)}`;
};
$('nbCancel').onclick = () => $('newBatchModal').classList.add('hidden');
$('nbCreate').onclick = async () => {
  try {
    const r = await post('/api/batches', { design_id: +$('nbDesign').value, name: $('nbName').value.trim() });
    $('newBatchModal').classList.add('hidden');
    await loadBatchList(r.id);
    await loadBatch(r.id);
    setStatus('已创建批次（待准备），点击顶栏「开测」开始');
  } catch (e) { setStatus('创建失败：' + e.message); }
};

$('delBatchBtn').onclick = async () => {
  const cur = state.current;
  if (!cur) return setStatus('请先选择批次');
  if (!confirm(`删除批次「${cur.batch.name}」及其全部读数与处置记录？`)) return;
  try {
    await api('/api/batches/' + cur.batch.id, { method: 'DELETE' });
    state.current = null;
    state.analysis = null;
    await loadBatchList();
    renderAll();
    setStatus('批次已删除');
  } catch (e) { setStatus('删除失败：' + e.message); }
};

$('epA').onchange = e => { state.entryA = e.target.value; renderConnViews(); };
$('epB').onchange = e => { state.entryB = e.target.value; renderConnViews(); };
$('swapBtn').onclick = () => {
  [state.entryA, state.entryB] = [state.entryB, state.entryA];
  syncEntryUI();
};
$('scanInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const tokens = e.target.value.split(/[\s,，;；→]+/).filter(Boolean);
  const eps = tokens.filter(t => /^[A-Za-z0-9_一-龥-]+\.\d+$/.test(t));
  const valid = new Set(state.current ? state.current.snapshot.terminals : []);
  const bad = eps.filter(ep => !valid.has(ep));
  if (bad.length) setStatus('端子不在方案快照中：' + bad.join('、'));
  if (eps.length >= 2) {
    [state.entryA, state.entryB] = [eps[0], eps[1]];
  } else if (eps.length === 1) {
    if (!state.entryA) state.entryA = eps[0];
    else state.entryB = eps[0];
  }
  e.target.value = '';
  syncEntryUI();
  if (eps.length >= 2 && !bad.length) setStatus(`已扫描 ${eps[0]} ↔ ${eps[1]}，请选择导通结果后录入`);
});
$('submitReading').onclick = submitReading;
$('withdrawLast').onclick = withdrawLast;
$('operator').value = localStorage.getItem('qc.operator') || '';

$('csvPreviewBtn').onclick = previewCsv;
$('csvFileBtn').onclick = () => $('csvFile').click();
$('csvFile').onchange = e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const fr = new FileReader();
  fr.onload = () => { $('csvText').value = fr.result; previewCsv(); };
  fr.onerror = () => setStatus('文件读取失败');
  fr.readAsText(f);
};

// 异常处置与读数撤回（事件委托，覆盖动态内容）
$('qcRight').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn || !state.current) return;
  const id = state.current.batch.id;
  if (btn.dataset.wdRid) {
    try {
      await post(`/api/batches/${id}/readings/${btn.dataset.wdRid}/withdraw`);
      setStatus(`已撤回读数 #${btn.dataset.wdRid}`);
      await refresh();
    } catch (err) { setStatus('撤回失败：' + err.message); }
  } else if (btn.dataset.dpKey) {
    const item = btn.closest('.anomitem');
    try {
      await post(`/api/batches/${id}/dispositions`, {
        akey: btn.dataset.dpKey,
        kind: btn.dataset.dpKind || '',
        action: item.querySelector('.dp-action').value,
        note: item.querySelector('.dp-note').value.trim(),
        operator: $('operator').value.trim(),
      });
      setStatus('已记录处置结论');
      await refresh();
    } catch (err) { setStatus('提交失败：' + err.message); }
  }
});

// ---------- 启动 ----------

(async function boot() {
  renderAll();
  try {
    await loadBatchList();
  } catch (e) {
    setStatus('无法连接本地服务：' + e.message);
    return;
  }
  const bid = +new URLSearchParams(location.search).get('batch');
  if (bid && state.batches.some(b => b.id === bid)) {
    $('batchSel').value = bid;
    try {
      await loadBatch(bid);
      setStatus('已载入批次');
    } catch (e) { setStatus('载入失败：' + e.message); }
  }
})();
