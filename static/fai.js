// fai.js — 首件尺寸检验批次：冻结快照、路线测点、SVG 引导测量、偏差/异常、
// 返工/让步/报废处置、中断续测、撤回读数、同方案比较与首件检验单打印
'use strict';

const $ = id => document.getElementById(id);

const STATUS_NAMES = { preparing: '待准备', measuring: '测量中', review: '待复核', released: '已放行' };
const KIND_NAMES = {
  conn_spacing: '连接器间距', branch_pos: '分支定位', wire_len: '支路长度',
  cover_edge: '包覆起止', tail: '尾部余量', custom: '自选测点',
};
const ANOM_NAMES = {
  out_of_tol: '超差', missing_ref: '基准缺失', conflict: '结论矛盾', rework_pending: '返工待重测',
  bad_value: '无效值', unknown_unit: '单位不明', missing_unit: '单位缺失',
  out_of_order: '测点错序', duplicate: '重复测量',
};
const DISP = [
  { id: 'rework', name: '返工（重测）' },
  { id: 'concession', name: '让步接收' },
  { id: 'scrap', name: '报废' },
];
const KIND_ORDER = ['conn_spacing', 'branch_pos', 'wire_len', 'cover_edge', 'tail', 'custom'];

const state = {
  batches: [], designs: [], current: null,   // {batch,snapshot,measurements,dispositions,analysis,stale}
  activeItem: null, pick: null,
  view: { scale: 1, ox: 0, oy: 0 },
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
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function setStatus(t) { $('statusHint').textContent = t; }

// ---------- 载入 ----------

async function loadBatchList(keepId) {
  state.batches = await api('/api/fai');
  $('batchSel').innerHTML = '<option value="">（选择批次）</option>' + state.batches.map(b =>
    `<option value="${b.id}" ${keepId === b.id ? 'selected' : ''}>${esc(b.name)}｜${STATUS_NAMES[b.status]}${b.stale ? '｜快照过期' : ''}</option>`
  ).join('');
}

async function loadBatch(id) {
  state.current = await api('/api/fai/' + id);
  state.activeItem = null;
  const next = state.current.analysis.next_item;
  if (next) state.activeItem = next;
  resetView(true);
  renderAll();
}

async function refresh(keepId) {
  const id = keepId ?? (state.current && state.current.batch.id);
  await loadBatchList(id);
  if (id) await loadBatch(id); else { state.current = null; renderAll(); }
}

// ---------- 快照索引 ----------

function nodeIndex() {
  const m = new Map();
  const snap = state.current.snapshot;
  for (const k of ['connectors', 'branches', 'splices'])
    for (const n of snap[k] || []) m.set(n.id, n);
  return m;
}
function itemById(iid) {
  return state.current.snapshot.items.find(i => i.id === iid) || null;
}
function stateById(iid) {
  return state.current.analysis.item_states.find(s => s.item === iid) || null;
}

// ---------- 渲染总控 ----------

function renderAll() {
  const cur = state.current;
  $('emptyHint').classList.toggle('hidden', !!cur);
  for (const id of ['boardWrap', 'entryFields']) $(id).classList.toggle('hidden', !cur);
  if (!cur) {
    $('batchStatus').textContent = '';
    $('batchStatus').className = 'qc-status';
    $('statusActions').innerHTML = '';
    $('batchMeta').innerHTML = '';
    $('routeList').innerHTML = '';
    $('faiSvg').querySelectorAll('#layer-node,#layer-wire,#layer-cover,#layer-measure').forEach(g => (g.innerHTML = ''));
    ['anoms', 'readings', 'release'].forEach(() => {});
    $('qcTab-anoms').innerHTML = $('qcTab-readings').innerHTML = $('qcTab-release').innerHTML = $('cmpBox').innerHTML = '';
    $('anomBadge').classList.add('hidden');
    $('staleBanner').classList.add('hidden');
    $('releasedBanner').classList.add('hidden');
    return;
  }
  renderMeta();
  renderActions();
  renderRoute();
  renderBoard();
  renderEntry();
  renderAnoms();
  renderReadings();
  renderRelease();
  renderComparePickers();
  const b = cur.batch;
  $('staleBanner').classList.toggle('hidden', !cur.stale);
  $('releasedBanner').classList.toggle('hidden', b.status !== 'released');
  $('entryFields').disabled = b.status !== 'measuring';
  const pickBtn = $('pickMeasureBtn');
  if (pickBtn) pickBtn.disabled = b.status !== 'measuring';
  $('entryHint').textContent = {
    preparing: '待准备：可添加自选测点，点击「开测」开始',
    measuring: '沿路线测量，或点图上两基准录入',
    review: '待复核：登记处置后可放行，或返回测量',
    released: '已放行（只读）',
  }[b.status];
}

function renderMeta() {
  const { batch: b, snapshot: s, analysis: an } = state.current;
  const st = $('batchStatus');
  st.textContent = STATUS_NAMES[b.status];
  st.className = 'qc-status ' + b.status;
  const pct = an.stats.required ? Math.round(an.stats.measured / s.items.filter(i => i.required).length * 100) : 0;
  $('batchMeta').innerHTML = `<h4>批次信息</h4>
    <div class="meta">方案：${esc(s.design_name || '—')}</div>
    <div class="meta">创建：${esc(b.created_at).replace('T', ' ')}　更新：${esc(b.updated_at).replace('T', ' ')}</div>
    <div class="fai-progbar"><i style="width:${pct}%"></i></div>
    <div class="meta">测点 ${an.stats.measured}/${an.stats.required}（必测） ·
      合格 ${an.stats.ok} · 超差 ${an.stats.ng} · 异常 ${an.stats.unresolved}/${an.stats.anomalies}</div>`;
}

function renderActions() {
  const b = state.current.batch;
  let h = '';
  if (b.status === 'preparing') {
    h += '<button id="actPick">＋自选测点</button><button id="actStart">开测</button>';
  }
  if (b.status === 'measuring') h += '<button id="actFinish">完成测量</button>';
  if (b.status === 'review') h += '<button id="actReopen">返回测量</button><button id="actRelease">放行</button>';
  if (b.status === 'review' || b.status === 'released') h += '<button id="actPrint">打印检验单</button>';
  $('statusActions').innerHTML = h;
  const bind = (id, fn) => { const x = $(id); if (x) x.onclick = fn; };
  bind('actStart', () => statusAction('start', '已开测，沿检验路线测量'));
  bind('actPick', () => openPick('custom'));
  bind('actFinish', () => statusAction('finish', '已完成测量，进入待复核'));
  bind('actReopen', () => statusAction('reopen', '已返回测量，可中断续测'));
  bind('actRelease', doRelease);
  bind('actPrint', printSheet);
}

// ---------- 路线测点 ----------

function renderRoute() {
  const { snapshot: s, analysis: an } = state.current;
  const filter = $('routeFilter').value.trim().toLowerCase();
  const sm = new Map(an.item_states.map(x => [x.item, x]));
  const groups = new Map(KIND_ORDER.map(k => [k, []]));
  for (const it of s.items) {
    if (filter && !(it.name.toLowerCase().includes(filter) ||
      `${it.ref_a?.name || ''} ${it.ref_b?.name || ''}`.toLowerCase().includes(filter))) continue;
    (groups.get(it.kind) || groups.get('custom')).push(it);
  }
  let h = '';
  for (const k of KIND_ORDER) {
    const list = groups.get(k) || [];
    if (!list.length) continue;
    h += `<h4 style="margin:10px 0 4px">${KIND_NAMES[k]} <span class="hint">(${list.length})</span></h4>`;
    for (const it of list) {
      const st = sm.get(it.id) || { status: 'pending' };
      const dev = st.dev == null ? '' :
        `<span class="rdev ${st.status === 'ok' ? 'ok' : 'ng'}">${st.dev >= 0 ? '+' : ''}${st.dev.toFixed(1)}</span>`;
      const icon = { ok: '<span class="st-chk">✓</span>', ng: '<span class="st-ng">✗超差</span>',
        bad: '<span class="st-bad">?</span>', pending: '<span class="st-pend">○</span>' }[st.status];
      h += `<div class="route-item ${st.status} ${state.activeItem === it.id ? 'active' : ''} ${it.required ? '' : 'opt'}"
              data-item="${it.id}">
        <div class="rname">${it.seq}. ${esc(it.name)} ${icon}${it.required ? '' : '<span class="rkind">（选测）</span>'}</div>
        <div class="rmeta"><span>${esc(it.ref_a?.name || '?')} → ${esc(it.ref_b?.name || '?')}</span>
          <span>理论 ${it.nominal.toFixed(1)} ${dev}</span></div>
      </div>`;
    }
  }
  $('routeList').innerHTML = h || '<p class="hint">无匹配测点</p>';
  $('routeList').querySelectorAll('.route-item').forEach(el => {
    el.onclick = () => selectItem(el.dataset.item, true);
  });
}

function selectItem(iid, focusValue) {
  state.activeItem = iid;
  const it = itemById(iid);
  $('entryItem').value = iid;
  renderEntryMeta(it);
  renderRoute();
  renderBoard();
  if (focusValue && state.current.batch.status === 'measuring') $('entryValue').focus();
}

// ---------- SVG 钉板 ----------

function resetView(fit) {
  const cur = state.current;
  if (!cur) return;
  const b = cur.snapshot.board || { width: 900, height: 600 };
  const svg = $('faiSvg');
  const w = svg.clientWidth || 800, h = svg.clientHeight || 420;
  const pad = 40;
  const scale = Math.min((w - pad * 2) / b.width, (h - pad * 2) / b.height);
  state.view = { scale, fitScale: scale, w, h, bw: b.width, bh: b.height };
  applyView();
}

function applyView() {
  const v = state.view;
  const w = v.w || 800, h = v.h || 420;
  const ox = (w / v.scale - v.bw) / 2 + (v.ox || 0);
  const oy = (h / v.scale - v.bh) / 2 + (v.oy || 0);
  $('view').setAttribute('transform', `translate(${w / 2},${h / 2}) scale(${v.scale}) translate(${-(v.bw / 2 + (v.ox || 0))},${-(v.bh / 2 + (v.oy || 0))})`);
  $('zoomLabel').textContent = Math.round(v.scale * 100) + '%';
}

function renderBoard() {
  const { snapshot: s, analysis: an } = state.current;
  const b = s.board || { width: 900, height: 600 };
  const sm = new Map(an.item_states.map(x => [x.item, x]));
  let board = `<rect x="0" y="0" width="${b.width}" height="${b.height}" fill="#fff" stroke="#90a4ae"/>`;
  const g = b.grid || 10;
  board += '<g stroke="#eee" stroke-width="0.4">';
  for (let x = g; x < b.width; x += g) board += `<line x1="${x}" y1="0" x2="${x}" y2="${b.height}"/>`;
  for (let y = g; y < b.height; y += g) board += `<line x1="0" y1="${y}" x2="${b.width}" y2="${y}"/>`;
  board += '</g>';
  $('layer-board').innerHTML = board;

  // 包覆边界（半透明粗线 + 起止竖线）
  let cover = '';
  const KIND_COLOR = { corr: '#ef6c00', braid: '#6d4c41', tape: '#283593' };
  for (const c of s.covers || []) {
    if (!c.anchors || c.anchors.length < 2) continue;
    const col = KIND_COLOR[c.kind] || '#ef6c00';
    const d = c.anchors.map((p, i) => (i ? 'L' : 'M') + p.x + ' ' + p.y).join(' ');
    cover += `<path d="${d}" fill="none" stroke="${col}" stroke-width="6" opacity=".25" stroke-linecap="round"/>`;
    for (const p of [c.anchors[0], c.anchors[c.anchors.length - 1]])
      cover += `<line x1="${p.x}" y1="${p.y - 5}" x2="${p.x}" y2="${p.y + 5}" stroke="${col}" stroke-width=".8"/>`;
  }
  $('layer-cover').innerHTML = cover;

  // 导线
  let wire = '';
  for (const w of s.wires || []) {
    if (w.path.length < 2) continue;
    const d = w.path.map((p, i) => (i ? 'L' : 'M') + p.x + ' ' + p.y).join(' ');
    wire += `<path d="${d}" fill="none" stroke="${w.color || '#888'}" stroke-width="${Math.max(w.gauge || 1.2, 1.2)}" stroke-linejoin="round" opacity=".9"/>`;
  }
  $('layer-wire').innerHTML = wire;

  // 测线：全部测点细线，合格绿/超差红/当前橙
  let meas = '';
  for (const it of s.items) {
    const a = it.ref_a, b2 = it.ref_b;
    if (!a || !b2) continue;
    const st = sm.get(it.id);
    const cls = it.id === state.activeItem ? 'active' : st ? st.status : '';
    const mx = (a.x + b2.x) / 2, my = (a.y + b2.y) / 2 - 2;
    meas += `<line class="meas-line ${cls}" data-item="${it.id}" x1="${a.x}" y1="${a.y}" x2="${b2.x}" y2="${b2.y}"/>`;
    if (it.id === state.activeItem)
      meas += `<text class="meas-tag" x="${mx}" y="${my}" text-anchor="middle">${esc(it.id)} 理论${it.nominal.toFixed(0)}</text>`;
  }
  $('layer-measure').innerHTML = meas;

  // 节点
  const idx = nodeIndex();
  let node = '';
  for (const n of idx.values()) {
    const sel = state.pick && (state.pick.a === n.id || state.pick.b === n.id);
    const active = state.activeItem && isItemRef(state.activeItem, n.id);
    node += `<g class="fai-node ${sel ? 'sel' : ''} ${active ? 'active' : ''}" data-node="${n.id}">`;
    if (n.type === 'connector') node += drawConnector(n);
    else if (n.type === 'splice') node += drawSplice(n);
    else node += drawBranch(n);
    node += '</g>';
  }
  $('layer-node').innerHTML = node;

  $('faiSvg').classList.toggle('picking', !!state.pick);
  $('layer-node').querySelectorAll('.fai-node').forEach(g => {
    g.onclick = e => { e.stopPropagation(); onNodeClick(g.dataset.node); };
  });
  $('layer-measure').querySelectorAll('.meas-line').forEach(l => {
    l.onclick = e => { e.stopPropagation(); selectItem(l.dataset.item, true); };
  });
}

function isItemRef(iid, nid) {
  const it = itemById(iid);
  return it && (it.ref_a?.id === nid || it.ref_b?.id === nid || (it.axis_refs || []).includes(nid));
}

function drawConnector(n) {
  const w = 26, h = 14;
  return `<rect class="fai-hit" x="${n.x - w / 2}" y="${n.y - h / 2}" width="${w}" height="${h}" rx="2"
      fill="#fff" stroke="#000" stroke-width=".8"/>
    <circle class="fai-hit" cx="${n.x}" cy="${n.y}" r="10" fill="transparent"/>
    <text x="${n.x}" y="${n.y - h / 2 - 2}" font-size="7" font-weight="bold" text-anchor="middle">${esc(n.name)}</text>`;
}
function drawBranch(n) {
  const s = 5;
  return `<rect class="fai-hit" x="${n.x - s}" y="${n.y - s}" width="${s * 2}" height="${s * 2}"
      transform="rotate(45 ${n.x} ${n.y})" fill="#fff8e1" stroke="#ef6c00" stroke-width=".9"/>
    <circle class="fai-hit" cx="${n.x}" cy="${n.y}" r="9" fill="transparent"/>
    <text x="${n.x}" y="${n.y - 8}" font-size="6" text-anchor="middle" fill="#ef6c00">${esc(n.name)}</text>`;
}
function drawSplice(n) {
  const w = 16, h = 8;
  return `<rect class="fai-hit" x="${n.x - w / 2}" y="${n.y - h / 2}" width="${w}" height="${h}" rx="2"
      fill="#efebe9" stroke="#5d4037" stroke-width=".8"/>
    <circle class="fai-hit" cx="${n.x}" cy="${n.y}" r="9" fill="transparent"/>
    <text x="${n.x}" y="${n.y - h / 2 - 2}" font-size="6" font-weight="bold" text-anchor="middle" fill="#5d4037">${esc(n.name)}</text>`;
}

// ---------- 录入 ----------

function renderEntry() {
  const { snapshot: s, batch: b } = state.current;
  const sel = $('entryItem');
  sel.innerHTML = s.items.map(it =>
    `<option value="${it.id}">${it.seq}. ${esc(it.name)}（理论 ${it.nominal.toFixed(1)}）</option>`).join('');
  if (state.activeItem) sel.value = state.activeItem;
  renderEntryMeta(itemById(sel.value));
  $('entryValue').value = '';
  $('entryValue').disabled = b.status !== 'measuring';
  $('submitMeasure').disabled = b.status !== 'measuring';
  $('withdrawLast').disabled = b.status !== 'measuring';
  sel.onchange = () => selectItem(sel.value, false);
}

function renderEntryMeta(it) {
  if (!it) return;
  $('entryNominal').textContent = it.nominal.toFixed(1);
  $('entryTol').textContent = `(-${it.tol_neg}/+${it.tol_pos}) mm`;
  $('entryRefs').textContent = `${it.ref_a?.name || '?'} → ${it.ref_b?.name || '?'}${it.required ? '' : '（选测）'}`;
}

async function submitMeasurement() {
  const cur = state.current;
  if (cur.batch.status !== 'measuring') return;
  const iid = $('entryItem').value;
  const value = $('entryValue').value;
  if (value.trim() === '') { setStatus('请填写实测值'); $('entryValue').focus(); return; }
  try {
    const res = await post(`/api/fai/${cur.batch.id}/measurements`, {
      item: iid, value, unit: $('entryUnit').value,
      operator: $('operator').value, note: $('note').value,
    });
    $('entryValue').value = '';
    setStatus(res.warning ? '已录入：' + res.warning : '读数已录入');
    const id = cur.batch.id;
    await loadBatch(id);
    // 自动跳到下一待测项
    const next = state.current.analysis.next_item;
    if (next) selectItem(next, true);
  } catch (e) {
    setStatus('录入失败：' + e.message);
    alert(e.message);
  }
}

async function withdrawLast(rid) {
  const cur = state.current;
  if (cur.batch.status !== 'measuring') return;
  try {
    await post(`/api/fai/${cur.batch.id}/withdraw`, rid ? { id: rid } : {});
    setStatus(rid ? '该读数已撤回' : '最近读数已撤回');
    await loadBatch(cur.batch.id);
  } catch (e) { alert(e.message); }
}

// ---------- 点选两基准 ----------

function openPick(mode) {
  const cur = state.current;
  if (mode === 'custom' && cur.batch.status !== 'preparing') return;
  state.pick = { a: null, b: null, mode };
  $('pickTitle').textContent = mode === 'custom' ? '添加自选测点：点选两个基准' : '点选两个基准录入';
  $('pickName').value = '';
  // 名称/公差仅“添加自选测点”需要
  $('pickName').parentElement.style.display = mode === 'custom' ? '' : 'none';
  $('pickNeg').parentElement.style.display = mode === 'custom' ? '' : 'none';
  $('pickConfirm').textContent = mode === 'custom' ? '加入测点' : '定位测点';
  updatePickSel();
  $('pickModal').classList.remove('hidden');
  $('faiSvg').classList.add('picking');
}
function closePick() {
  state.pick = null;
  $('pickModal').classList.add('hidden');
  renderBoard();
}
function updatePickSel() {
  const idx = nodeIndex();
  const nm = id => idx.get(id)?.name || '（未选）';
  const p = state.pick;
  $('pickSel').textContent = `基准 A：${nm(p.a)}　｜　基准 B：${nm(p.b)}`;
  $('pickConfirm').disabled = !(p.a && p.b);
  $('pickMeasure').disabled = !(p.a && p.b);
}
function onNodeClick(nid) {
  const p = state.pick;
  const cur = state.current;
  if (p) {
    if (!p.a) p.a = nid;
    else if (!p.b) p.b = nid;
    else { p.a = nid; p.b = null; }   // 重新开始
    updatePickSel();
    renderBoard();
    return;
  }
  // 非选基准模式：点节点选中关联的首个待测/当前测点
  const candidates = cur.snapshot.items.filter(i => isItemRef(i.id, nid));
  const target = candidates.find(i => {
    const st = stateById(i.id);
    return st && st.status === 'pending';
  }) || candidates[0];
  if (target) selectItem(target.id, true);
}

async function confirmPick(andMeasure) {
  const cur = state.current;
  const p = state.pick;
  if (!p.a || !p.b) return;
  if (p.mode === 'custom') {
    try {
      const res = await post(`/api/fai/${cur.batch.id}/items`, {
        ref_a: p.a, ref_b: p.b, name: $('pickName').value,
        tol_neg: $('pickNeg').value, tol_pos: $('pickPos').value,
      });
      setStatus('已添加自选测点 ' + res.item.id);
      closePick();
      await loadBatch(cur.batch.id);
      selectItem(res.item.id, andMeasure);
    } catch (e) { alert(e.message); }
    return;
  }
  // 测量模式：匹配既有测点（两端基准一致，无序）
  const hit = cur.snapshot.items.find(it =>
    (it.ref_a?.id === p.a && it.ref_b?.id === p.b) ||
    (it.ref_a?.id === p.b && it.ref_b?.id === p.a) ||
    ((it.axis_refs || []).includes(p.a) && (it.axis_refs || []).includes(p.b)));
  closePick();
  if (!hit) { alert('这两个基准没有对应测点；可在待准备阶段先添加自选测点。'); return; }
  selectItem(hit.id, true);
}

// ---------- 异常与处置 ----------

function renderAnoms() {
  const { analysis: an, dispositions: disps, batch: b } = state.current;
  const list = an.anomalies;
  const n = an.stats.unresolved;
  $('anomBadge').classList.toggle('hidden', !n);
  $('anomBadge').textContent = n;
  if (!list.length) {
    $('qcTab-anoms').innerHTML = '<p class="okline">暂无异常。</p>';
    return;
  }
  $('qcTab-anoms').innerHTML = list.map(a => {
    const hist = (disps.filter(d => d.akey === a.key) || []).map(d =>
      `<div class="dp-hist">${esc(DISP.find(x => x.id === d.action)?.name || d.action)}
        （${esc(d.operator || '—')} ${esc(d.created_at).replace('T', ' ')}）${d.note ? '：' + esc(d.note) : ''}</div>`
    ).join('');
    const form = (!a.resolved && b.status === 'measuring') || b.status === 'review' ? `
      <div class="dp-form">
        <select class="dp-act">${DISP.map(x => `<option value="${x.id}">${x.name}</option>`).join('')}</select>
        <input class="dp-op" placeholder="处置人" value="${esc($('operator').value || '')}">
        <input class="dp-note" placeholder="说明（可空）">
        <button data-key="${esc(a.key)}" data-kind="${esc(a.kind)}" class="dp-save">登记</button>
      </div>` : '';
    return `<div class="anomitem ${a.level} ${a.resolved ? 'resolved' : ''}">
      <div class="amsg"><b>[${ANOM_NAMES[a.kind] || a.kind}]</b> ${esc(a.msg)}</div>
      <div class="hint">${a.resolved ? '✓ 已结案' : '未结案'}</div>${hist}${form}</div>`;
  }).join('');
  $('qcTab-anoms').querySelectorAll('.dp-save').forEach(btn => {
    btn.onclick = async () => {
      const box = btn.closest('.anomitem');
      try {
        await post(`/api/fai/${state.current.batch.id}/dispositions`, {
          akey: btn.dataset.key, kind: btn.dataset.kind,
          action: box.querySelector('.dp-act').value,
          operator: box.querySelector('.dp-op').value,
          note: box.querySelector('.dp-note').value,
        });
        setStatus('处置已登记（返工需重测合格）');
        await loadBatch(state.current.batch.id);
      } catch (e) { alert(e.message); }
    };
  });
}

// ---------- 读数表 ----------

function renderReadings() {
  const { measurements: ms, batch: b, snapshot: s } = state.current;
  const imap = new Map(s.items.map(i => [i.id, i]));
  const rows = ms.slice().reverse().map(r => {
    const it = imap.get(r.item);
    const st = stateById(r.item);
    return `<tr class="${r.withdrawn ? 'wd' : ''}">
      <td>${r.id}</td>
      <td class="l">${esc(r.item)} ${esc(it?.name || '')}</td>
      <td>${esc(r.value_raw)} ${esc(r.unit || '')}</td>
      <td>${st && st.latest && st.latest.id === r.id && st.dev != null ? (st.dev >= 0 ? '+' : '') + st.dev.toFixed(1) : ''}</td>
      <td>${esc(r.operator || '')}</td>
      <td>${esc(r.created_at).replace('T', ' ')}</td>
      <td>${(!r.withdrawn && b.status === 'measuring') ? `<button class="mini" data-rid="${r.id}">撤回</button>` : (r.withdrawn ? '已撤回' : '')}</td>
    </tr>`;
  }).join('');
  $('qcTab-readings').innerHTML = `<h4>读数记录（${ms.filter(m => !m.withdrawn).length} 条有效）</h4>
    <table class="list"><thead><tr><th>#</th><th class="l">测点</th><th>原值/单位</th><th>偏差mm</th><th>检验人</th><th>时间</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">（暂无读数，可中断续测）</td></tr>'}</tbody></table>`;
  $('qcTab-readings').querySelectorAll('.mini').forEach(btn => {
    btn.onclick = () => withdrawLast(+btn.dataset.rid);
  });
}

// ---------- 比较 ----------

function renderComparePickers() {
  const cur = state.current;
  const did = cur.batch.design_id;
  const peers = state.batches.filter(x => x.design_id === did && x.status === 'released');
  $('cmpPick').innerHTML = peers.length
    ? peers.map(x => `<label class="chk"><input type="checkbox" class="cmp-chk" value="${x.id}"> ${esc(x.name)}</label>`).join('') +
      '<button id="cmpGo">比较选中批次</button>'
    : '<span class="hint">同方案暂无其他已放行批次。</span>';
  const btn = $('cmpGo');
  if (btn) btn.onclick = doCompare;
}

async function doCompare() {
  const ids = [...$('cmpPick').querySelectorAll('.cmp-chk:checked')].map(x => +x.value);
  if (ids.length < 2) { $('cmpBox').innerHTML = '<p class="hint">请至少勾选两个批次。</p>'; return; }
  try {
    const res = await api('/api/fai/compare?ids=' + ids.join(','));
    const head = res.batches.map(b => `<th>${esc(b.name)}</th>`).join('');
    const body = res.items.map(it => {
      const tds = res.batches.map((b, bi) => {
        const c = it.cells[bi];
        if (!c) return '<td>—</td>';
        const cls = c.status === 'ok' ? 'st-chk' : c.status === 'ng' ? 'st-ng' : c.status === 'bad' ? 'st-bad' : 'st-pend';
        const v = c.value_mm == null ? '—' : c.value_mm.toFixed(1);
        const d = c.dev == null ? '' : ` <span class="hint">(${c.dev >= 0 ? '+' : ''}${c.dev.toFixed(1)})</span>`;
        return `<td class="${cls}">${v}${d}</td>`;
      }).join('');
      return `<tr><td>${it.seq}</td><td class="l">${esc(it.name)}</td><td>${it.nominal.toFixed(1)}</td>${tds}</tr>`;
    }).join('');
    $('cmpBox').innerHTML = `<table class="list"><thead><tr><th>#</th><th class="l">测点</th><th>理论</th>${head}</tr></thead>
      <tbody>${body}</tbody></table>`;
  } catch (e) { $('cmpBox').innerHTML = '<p class="hint">' + esc(e.message) + '</p>'; }
}

// ---------- 放行 ----------

function renderRelease() {
  const { analysis: an, batch: b, stale } = state.current;
  const st = an.stats;
  const blocking = an.blocking.map(x => `<li>${esc(x.reason)}</li>`).join('');
  $('qcTab-release').innerHTML = `<h4>放行检查</h4>
    <div class="meta">状态：<b>${STATUS_NAMES[b.status]}</b>${stale ? '　<span class="st-ng">快照已过期（方案已改，仅标记不改写）</span>' : ''}</div>
    <div class="meta">必测 ${st.required} · 已测 ${st.measured} · 合格 ${st.ok} · 超差 ${st.ng} · 无效 ${st.bad} · 待处理异常 ${st.unresolved}</div>
    ${st.releasable ? '<p class="okline">✓ 必测项合格或已完成授权处置，可放行。</p>'
      : `<p class="hint">以下项阻塞放行：</p><ul>${blocking || '<li>—</li>'}</ul>`}
    ${b.status === 'review' ? '<button id="relBtn">放 行</button>' : ''}
    ${b.status === 'review' || b.status === 'released' ? '<button id="printBtn2">打印首件检验单</button>' : ''}
    ${b.status === 'released' ? '<p class="okline">🔒 已放行，记录只读、不可删除。</p>' : ''}`;
  const r = $('relBtn'); if (r) r.onclick = doRelease;
  const p = $('printBtn2'); if (p) p.onclick = printSheet;
}

async function statusAction(action, okMsg) {
  const cur = state.current;
  try {
    await post(`/api/fai/${cur.batch.id}/status`, { action });
    setStatus(okMsg);
    await loadBatch(cur.batch.id);
  } catch (e) {
    if (e.payload?.blocking) alert(e.message + '\n· ' + e.payload.blocking.map(x => x.reason).join('\n· '));
    else alert(e.message);
  }
}

async function doRelease() {
  const cur = state.current;
  if (!cur.analysis.stats.releasable) {
    alert('尚不能放行：\n· ' + cur.analysis.blocking.map(x => x.reason).join('\n· '));
    return;
  }
  if (!confirm('确认放行该首件批次？放行后记录只读、不可改写或删除。')) return;
  try {
    await post(`/api/fai/${cur.batch.id}/status`, { action: 'release' });
    setStatus('已放行');
    await loadBatch(cur.batch.id);
  } catch (e) {
    if (e.payload?.blocking) alert(e.message + '\n· ' + e.payload.blocking.map(x => x.reason).join('\n· '));
    else alert(e.message);
  }
}

// ---------- 打印首件检验单 ----------

function printSheet() {
  const { batch: b, snapshot: s, analysis: an, measurements: ms, dispositions: ds } = state.current;
  const sm = new Map(an.item_states.map(x => [x.item, x]));
  const judge = st => !st || st.status === 'pending' ? '待检'
    : st.status === 'ok' ? '合格' : st.status === 'ng' ? '超差' : '待人工';
  const rows = s.items.map(it => {
    const st = sm.get(it.id);
    const latest = st?.latest;
    const valTxt = latest ? `${esc(latest.value_raw)} ${esc(latest.unit || '')}` : '';
    const devTxt = st && st.dev != null ? ((st.dev >= 0 ? '+' : '') + st.dev.toFixed(1)) : '';
    const disp = ds.filter(d => faiItemOfKey(d.akey) === it.id)
      .map(d => (DISP.find(x => x.id === d.action)?.name || d.action) + (d.note ? '：' + d.note : '')).join('；');
    return `<tr>
      <td>${it.seq}</td><td>${esc(KIND_NAMES[it.kind])}</td>
      <td style="text-align:left">${esc(it.name)}<br><span class="hh">${esc(it.ref_a?.name || '?')} → ${esc(it.ref_b?.name || '?')}</span></td>
      <td>${it.nominal.toFixed(1)}</td>
      <td>-${it.tol_neg}/+${it.tol_pos}</td>
      <td>${valTxt}</td><td>${devTxt}</td>
      <td class="${st?.status === 'ok' ? 'j-ok' : st?.status === 'ng' ? 'j-ng' : ''}">${judge(st)}</td>
      <td style="text-align:left">${esc(disp)}</td>
    </tr>`;
  }).join('');
  const win = window.open('', '_blank');
  if (!win) { alert('浏览器拦截了弹出窗口，请允许后重试'); return; }
  win.document.write(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${esc(b.name)} - 首件检验单</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  body { font: 11px/1.5 "PingFang SC","Microsoft YaHei",sans-serif; color:#000; }
  h2 { font-size: 18px; margin: 0 0 4px; } h3 { font-size: 13px; margin: 12px 0 4px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #555; padding: 2px 5px; text-align: center; }
  th { background: #eee; } .hh { color:#555; font-size:10px; }
  .j-ok { color:#1b5e20; font-weight:700; } .j-ng { color:#c62828; font-weight:700; }
  .sign { margin-top: 22px; font-size: 13px; }
  .noprint button { padding: 6px 16px; }
</style></head><body>
<div class="noprint"><button onclick="window.print()">打印</button></div>
<h2>首件尺寸检验单</h2>
<p>批次：${esc(b.name)}　方案：${esc(s.design_name || '—')}　状态：${STATUS_NAMES[b.status]}
  ${state.current.stale ? '　（注：方案已变化，本单为冻结快照）' : ''}<br>
 创建：${esc(b.created_at).replace('T', ' ')}　测量/更新：${esc(b.updated_at).replace('T', ' ')}　共 ${s.items.length} 个测点（必测 ${an.stats.required}）</p>
<h3>测点、理论值、实测值与判定</h3>
<table><thead><tr><th>序号</th><th>类别</th><th>测点（基准）</th><th>理论mm</th><th>公差mm</th>
  <th>实测</th><th>偏差mm</th><th>判定</th><th>处置（返工/让步/报废）</th></tr></thead>
<tbody>${rows}</tbody></table>
<h3>签字栏</h3>
<p class="sign">检验员：＿＿＿＿＿＿＿　日期：＿＿＿＿＿　复核：＿＿＿＿＿＿＿　日期：＿＿＿＿＿
  　质量/授权（让步/报废）：＿＿＿＿＿＿＿　日期：＿＿＿＿＿　放行：＿＿＿＿＿＿＿</p>
</body></html>`);
  win.document.close();
}

function faiItemOfKey(akey) {
  const m = /[MC]\d+/.exec(String(akey || ''));
  return m ? m[0] : null;
}

// ---------- 新建批次 ----------

async function openNewBatch() {
  state.designs = await api('/api/designs');
  $('nbDesign').innerHTML = state.designs.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')
    || '<option value="">（没有已保存方案）</option>';
  $('nbName').value = '首件批次 ' + new Date().toLocaleString('zh-CN', { hour12: false });
  $('newBatchModal').classList.remove('hidden');
}
async function createBatch() {
  const design_id = +$('nbDesign').value;
  if (!design_id) return;
  try {
    const res = await post('/api/fai', { design_id, name: $('nbName').value.trim() });
    $('newBatchModal').classList.add('hidden');
    setStatus('已冻结尺寸快照并创建批次');
    await refresh(res.id);
    await loadBatch(res.id);
  } catch (e) { alert(e.message); }
}

// ---------- 视图交互（滚轮缩放 / 拖拽平移） ----------

function setupBoardNav() {
  const svg = $('faiSvg');
  svg.addEventListener('wheel', e => {
    if (!state.current) return;
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.view.scale = Math.max(0.1, Math.min(8, state.view.scale * f));
    applyView();
  }, { passive: false });
  let drag = null;
  svg.addEventListener('mousedown', e => {
    if (e.target.closest('.fai-node') || e.target.classList.contains('meas-line') || state.pick) return;
    drag = { x: e.clientX, y: e.clientY, ox: state.view.ox || 0, oy: state.view.oy || 0 };
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    const s = state.view.scale;
    state.view.ox = drag.ox - (e.clientX - drag.x) / s;
    state.view.oy = drag.oy - (e.clientY - drag.y) / s;
    applyView();
  });
  window.addEventListener('mouseup', () => (drag = null));
  $('zoomIn').onclick = () => { state.view.scale = Math.min(8, state.view.scale * 1.15); applyView(); };
  $('zoomOut').onclick = () => { state.view.scale = Math.max(0.1, state.view.scale / 1.15); applyView(); };
  $('zoomFit').onclick = () => resetView(true);
}

// ---------- 选项卡 ----------

function switchTab(t) {
  document.querySelectorAll('#qcTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.tab === t));
  document.querySelectorAll('#qcRight .qc-panel').forEach(p => p.classList.add('hidden'));
  $('qcTab-' + t).classList.remove('hidden');
}

// ---------- 事件与初始化 ----------

document.querySelectorAll('#qcTabs .tab').forEach(b => (b.onclick = () => switchTab(b.dataset.tab)));
$('routeFilter').oninput = () => state.current && renderRoute();
$('submitMeasure').onclick = submitMeasurement;
$('pickMeasureBtn').onclick = () => {
  if (!state.current || state.current.batch.status !== 'measuring') { setStatus('仅测量中可录入读数'); return; }
  openPick('measure');
};
$('withdrawLast').onclick = () => withdrawLast();
$('jumpNext').onclick = () => {
  const next = state.current?.analysis.next_item;
  if (next) selectItem(next, true); else setStatus('已无待测必测项');
};
$('entryValue').addEventListener('keydown', e => { if (e.key === 'Enter') submitMeasurement(); });
$('newBatchBtn').onclick = openNewBatch;
$('nbCancel').onclick = () => $('newBatchModal').classList.add('hidden');
$('nbCreate').onclick = createBatch;
$('delBatchBtn').onclick = async () => {
  const id = +$('batchSel').value;
  if (!id) return;
  if (!confirm('删除该未放行批次及其全部读数与处置？（已放行批次不可删除）')) return;
  try {
    await api('/api/fai/' + id, { method: 'DELETE' });
    setStatus('批次已删除');
    state.current = null;
    await refresh();
  } catch (e) { alert(e.message); }
};
$('batchSel').onchange = async e => {
  const id = +e.target.value;
  if (id) await loadBatch(id); else { state.current = null; renderAll(); }
};
$('pickCancel').onclick = closePick;
$('pickConfirm').onclick = () => confirmPick(false);
$('pickMeasure').onclick = () => confirmPick(true);
$('pickModal').addEventListener('click', e => { if (e.target.id === 'pickModal') closePick(); });
$('newBatchModal').addEventListener('click', e => { if (e.target.id === 'newBatchModal') e.target.classList.add('hidden'); });

(async function init() {
  setupBoardNav();
  window.addEventListener('resize', () => state.current && resetView(false));
  await loadBatchList();
  if (state.batches.length) await loadBatch(state.batches[0].id);
  else renderAll();
})();
