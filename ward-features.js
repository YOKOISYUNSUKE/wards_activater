'use strict';

/**
 * ward-features.js
 * 看護必要度選択・退院調整・DPCピッカー・ベッドタイプ選択
 */

(function () {

const {
  SHEET_COLUMNS,
  COL_BED_NO,
  COL_PATIENT_ID,
  COL_DPC,
  COL_ADMIT_DATE,
  COL_ADMIT_DAYS,
  COL_NURSING,
  COL_EST_DISCHARGE,
  BED_TYPES,
  loadSession,
  escapeHtml,
  todayJSTIsoDate,
  parseBedNo,
  setSheetRows,
} = window.WardCore;

// ===== DPC候補ピッカー =====
let activeDpcPicker = null;

function closeDpcPicker() {
  if (activeDpcPicker) {
    activeDpcPicker.remove();
    activeDpcPicker = null;
  }
}

function openDpcPicker(anchorEl, candidates, onPick) {
  closeDpcPicker();
  if (!anchorEl) return;

  const rect = anchorEl.getBoundingClientRect();
  const picker = document.createElement('div');
  picker.className = 'dpc-picker';
  picker.style.position = 'fixed';
  picker.style.zIndex = '9999';
  picker.style.left = `${Math.min(rect.left, window.innerWidth - 560)}px`;
  picker.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 360)}px`;
  picker.style.width = '560px';
  picker.style.maxWidth = 'calc(100vw - 16px)';
  picker.style.maxHeight = '340px';
  picker.style.overflow = 'auto';
  picker.style.background = '#fff';
  picker.style.border = '1px solid #d0d0d0';
  picker.style.borderRadius = '10px';
  picker.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
  picker.style.padding = '8px';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.style.gap = '8px';
  header.style.padding = '4px 6px 8px 6px';

  const title = document.createElement('div');
  title.textContent = `DPC候補（${candidates.length}件）`;
  title.style.fontWeight = '700';
  title.style.fontSize = '13px';
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.border = 'none';
  closeBtn.style.background = 'transparent';
  closeBtn.style.fontSize = '18px';
  closeBtn.style.lineHeight = '1';
  closeBtn.style.padding = '2px 6px';
  closeBtn.addEventListener('click', () => closeDpcPicker());
  header.appendChild(closeBtn);

  picker.appendChild(header);

  const list = document.createElement('div');
  list.style.display = 'flex';
  list.style.flexDirection = 'column';
  list.style.gap = '6px';

  (candidates || []).forEach((x) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.textAlign = 'left';
    btn.style.cursor = 'pointer';
    btn.style.padding = '8px 10px';
    btn.style.borderRadius = '10px';
    btn.style.border = '1px solid #e5e5e5';
    btn.style.background = '#fafafa';
    btn.innerHTML = `
      <div style="font-weight:700; font-size:13px;">${escapeHtml(String(x.code || ''))}</div>
      <div style="font-size:12px; opacity:0.9;">${escapeHtml(String(x.name || ''))}</div>
      <div style="font-size:12px; opacity:0.8;">期間 Ⅰ${escapeHtml(String(x.I ?? ''))} Ⅱ${escapeHtml(String(x.II ?? ''))} Ⅲ${escapeHtml(String(x.III ?? ''))}</div>
    `;
    btn.addEventListener('click', () => {
      try { onPick && onPick(x); } finally { closeDpcPicker(); }
    });
    list.appendChild(btn);
  });

  picker.appendChild(list);
  document.body.appendChild(picker);
  activeDpcPicker = picker;

  const onDocMouseDown = (ev) => {
    if (!activeDpcPicker) return;
    if (activeDpcPicker.contains(ev.target)) return;
    if (anchorEl.contains && anchorEl.contains(ev.target)) return;
    closeDpcPicker();
    document.removeEventListener('mousedown', onDocMouseDown, true);
  };
  document.addEventListener('mousedown', onDocMouseDown, true);
}

// ===== ベッドタイプ選択UI =====
function showBedTypeSelector(el, sheetAllRows, onApply) {
  document.querySelectorAll('.bed-type-selector').forEach(s => s.remove());

  const rowIdx = Number(el.getAttribute('data-idx'));
  const raw = el.getAttribute('data-raw') || '';
  const parsed = parseBedNo(raw);

  if (parsed.slot > 1) return;

  const currentNum = parsed.num || String(rowIdx + 1);

  const selector = document.createElement('div');
  selector.className = 'bed-type-selector';
  selector.innerHTML = `
    <div class="bed-type-num-input">
      <label>番号：<input type="text" class="bed-num-input" value="${currentNum}" /></label>
    </div>
    <div class="bed-type-divider"></div>
    <div class="bed-type-option" data-type="${BED_TYPES.PRIVATE}">個室</div>
    <div class="bed-type-option" data-type="${BED_TYPES.DOUBLE}">二人床</div>
    <div class="bed-type-option" data-type="${BED_TYPES.QUAD}">四人床</div>
    <div class="bed-type-divider"></div>
    <div class="bed-type-option bed-type-clear" data-type="clear">消去</div>
  `;

  const rect = el.getBoundingClientRect();
  selector.style.position = 'absolute';
  selector.style.left = `${rect.left + window.scrollX}px`;
  selector.style.top = `${rect.bottom + window.scrollY + 4}px`;

  document.body.appendChild(selector);

  const numInput = selector.querySelector('.bed-num-input');

  selector.querySelectorAll('.bed-type-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const type = opt.getAttribute('data-type');
      const inputNum = (numInput?.value || '').trim() || String(rowIdx + 1);

      if (type === 'clear') {
        onApply('clear', rowIdx, null, null);
      } else {
        onApply('set', rowIdx, inputNum, type);
      }
      selector.remove();
    });
  });

  setTimeout(() => {
    document.addEventListener('click', function closeSelector(e) {
      if (!selector.contains(e.target)) {
        selector.remove();
        document.removeEventListener('click', closeSelector);
      }
    });
  }, 0);
}

async function applyBedType(startIdx, baseNum, type, sheetAllRows, currentWard, callback) {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  const slotCount = type === BED_TYPES.QUAD ? 4 : type === BED_TYPES.DOUBLE ? 2 : 1;

  if (sheetAllRows[startIdx]) {
    sheetAllRows[startIdx][COL_BED_NO] = slotCount > 1 ? `${baseNum}:${type}` : baseNum;
  }

  for (let i = 1; i < slotCount; i++) {
    const targetIdx = startIdx + i;
    if (targetIdx < sheetAllRows.length && sheetAllRows[targetIdx]) {
      sheetAllRows[targetIdx][COL_BED_NO] = `${baseNum}-${i + 1}`;
    }
  }

  await setSheetRows(session.userId, currentWard.id, sheetAllRows);
  callback && callback('ベッドタイプを変更しました。');
}

async function clearBedNo(rowIdx, sheetAllRows, currentWard, callback) {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  if (!sheetAllRows[rowIdx]) return;

  const raw = sheetAllRows[rowIdx][COL_BED_NO];
  const parsed = parseBedNo(raw);

  let slotCount = 1;
  if (parsed.type === BED_TYPES.QUAD) slotCount = 4;
  else if (parsed.type === BED_TYPES.DOUBLE) slotCount = 2;

  sheetAllRows[rowIdx][COL_BED_NO] = '';

  for (let i = 1; i < slotCount; i++) {
    const targetIdx = rowIdx + i;
    if (targetIdx < sheetAllRows.length && sheetAllRows[targetIdx]) {
      const childRaw = sheetAllRows[targetIdx][COL_BED_NO];
      const childParsed = parseBedNo(childRaw);
      if (childParsed.num === parsed.num && childParsed.slot > 0) {
        sheetAllRows[targetIdx][COL_BED_NO] = '';
      }
    }
  }

  await setSheetRows(session.userId, currentWard.id, sheetAllRows);
  callback && callback('ベッドNoを消去しました。');
}

// ===== 看護必要度 =====
const NURSING_ITEMS = {
  A: [
    { id: 'A1', label: '医療処置1' },
    { id: 'A2', label: '医療処置2' },
    { id: 'A3', label: '医療処置3' },
  ],
  B: [
    { id: 'B1', label: 'ADL/介助1' },
    { id: 'B2', label: 'ADL/介助2' },
    { id: 'B3', label: 'ADL/介助3' },
  ],
  C: [
    { id: 'C1', label: '特記事項1' },
    { id: 'C2', label: '特記事項2' },
  ],
};

const NURSING_WEIGHTS = { A: 1, B: 1, C: 1 };

function nursingDetailKey(userId, wardId, rowIdx) {
  return `bm_nursing_v1|${userId}|${wardId}|${rowIdx}`;
}

function loadNursingDetail(userId, wardId, rowIdx) {
  const key = nursingDetailKey(userId, wardId, rowIdx);
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') || { A: [], B: [], C: [] };
  } catch {
    return { A: [], B: [], C: [] };
  }
}

function saveNursingDetail(userId, wardId, rowIdx, detail) {
  const key = nursingDetailKey(userId, wardId, rowIdx);
  localStorage.setItem(key, JSON.stringify(detail || { A: [], B: [], C: [] }));
}

function calcNursingScore(detail) {
  const a = (detail?.A || []).length;
  const b = (detail?.B || []).length;
  const c = (detail?.C || []).length;
  const total = a * (NURSING_WEIGHTS.A || 0) + b * (NURSING_WEIGHTS.B || 0) + c * (NURSING_WEIGHTS.C || 0);
  return { total, a, b, c };
}

async function applyNursingSelection(rowIdx, detail, sheetAllRows, currentWard, callback) {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;
  if (!sheetAllRows[rowIdx]) return;

  saveNursingDetail(session.userId, currentWard.id, rowIdx, detail);

  const { total, a, b, c } = calcNursingScore(detail);
  sheetAllRows[rowIdx][COL_NURSING] = `${total}（A${a}/B${b}/C${c}）`;

  await setSheetRows(session.userId, currentWard.id, sheetAllRows);
  callback && callback('保存しました。');
}

function showNursingSelector(el, sheetAllRows, currentWard, callback) {
  document.querySelectorAll('.nursing-selector').forEach(s => s.remove());

  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  const rowIdx = Number(el.getAttribute('data-idx'));
  if (!Number.isFinite(rowIdx) || rowIdx < 0) return;

  const current = loadNursingDetail(session.userId, currentWard.id, rowIdx);

  const selector = document.createElement('div');
  selector.className = 'nursing-selector';

  function renderCategory(cat) {
    const items = NURSING_ITEMS[cat] || [];
    const selected = new Set(current[cat] || []);
    return `
      <div class="nursing-cat">
        <div class="nursing-cat-title">${cat}</div>
        ${items.map(it => `
          <label class="nursing-item">
            <input type="checkbox" data-cat="${cat}" data-id="${it.id}" ${selected.has(it.id) ? 'checked' : ''} />
            <span>${escapeHtml(it.label)}</span>
          </label>
        `).join('')}
      </div>
    `;
  }

  selector.innerHTML = `
    <div class="nursing-head">
      <div class="nursing-title">看護必要度（A/B/C選択）</div>
      <button class="nursing-close" type="button">✕</button>
    </div>
    <div class="nursing-body">
      ${renderCategory('A')}
      ${renderCategory('B')}
      ${renderCategory('C')}
    </div>
    <div class="nursing-actions">
      <button class="btn btn-outline nursing-clear" type="button">クリア</button>
      <button class="btn btn-primary nursing-save" type="button">反映</button>
    </div>
  `;

  const rect = el.getBoundingClientRect();
  selector.style.position = 'absolute';
  selector.style.left = `${rect.left + window.scrollX}px`;
  selector.style.top = `${rect.bottom + window.scrollY + 4}px`;

  document.body.appendChild(selector);

  selector.querySelector('.nursing-close')?.addEventListener('click', () => selector.remove());

  selector.querySelector('.nursing-clear')?.addEventListener('click', async () => {
    await applyNursingSelection(rowIdx, { A: [], B: [], C: [] }, sheetAllRows, currentWard, callback);
    selector.remove();
  });

  selector.querySelector('.nursing-save')?.addEventListener('click', async () => {
    const next = { A: [], B: [], C: [] };
    selector.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const cat = cb.getAttribute('data-cat');
      const id = cb.getAttribute('data-id');
      if (!cat || !id) return;
      if (cb.checked) next[cat].push(id);
    });
    await applyNursingSelection(rowIdx, next, sheetAllRows, currentWard, callback);
    selector.remove();
  });

  setTimeout(() => {
    document.addEventListener('click', function closeSelector(e) {
      if (!selector.contains(e.target)) {
        selector.remove();
        document.removeEventListener('click', closeSelector);
      }
    });
  }, 0);
}

// ===== 退院調整 =====
function convertRowsToPatients(rows, wardName) {
  return (rows || [])
    .map((row, idx) => {
      const patientId = String(row[COL_PATIENT_ID] ?? '').trim();
      const dpcCode = String(row[COL_DPC] ?? '').trim();
      const admitDate = String(row[COL_ADMIT_DATE] ?? '').trim();
      const estDischarge = String(row[COL_EST_DISCHARGE] ?? '').trim();

      if (!patientId || !estDischarge) return null;

      return {
        patient_key: patientId,
        ward: wardName || 'ALL',
        dpc_code: dpcCode,
        adm_date: admitDate,
        los_today: String(row[COL_ADMIT_DAYS] ?? '').trim(),
        nursing_acuity: String(row[COL_NURSING] ?? '').trim(),
        est_discharge_date: estDischarge,
        discharge_ready_flag: '',
        notes_flag: '',
        _rowIdx: idx,
      };
    })
    .filter(Boolean);
}

function buildDpcMasterMap() {
  const master = window.DPC_MASTER;
  if (!master?.list) return {};

  const map = {};
  master.list.forEach(item => {
    map[item.code] = {
      dpc_name: item.name,
      L_std: item.I || 14,
      L_max: item.III || 30,
    };
  });
  return map;
}

function runDischargeOptimize(sheetAllRows, currentWard, setSheetMsg) {
  const WOI = window.WardOccupancyIdealizer;
  if (!WOI) {
    setSheetMsg('退院調整モジュールが読み込まれていません。', true);
    return;
  }

  const patients = convertRowsToPatients(sheetAllRows, currentWard?.name);

  if (patients.length === 0) {
    setSheetMsg('退院見込み日が入力されている患者がいません。', true);
    return;
  }

  const dpcMaster = buildDpcMasterMap();
  const asOfDate = todayJSTIsoDate();

  const constraints = {
    ALL: {
      beds: sheetAllRows.length,
      target_occupancy: 0.85,
      hard_no_discharge_weekdays: '日',
      weekday_weights: { '日': 10, '土': 6 },
      ER_avg: 2,
      scoring_weights: { w_dpc: 40, w_cap: 35, w_n: 10, w_adj: 10, w_wk: 10, w_dev: 5 },
      risk_params: { cap_th1: 0.85, cap_th2: 0.95, nurse_max: 5 },
    }
  };

  try {
    const recommendations = WOI.buildRecommendations(patients, {
      dpcMaster,
      constraints,
      asOfDate,
      topN: 3,
      candidateRangeDays: 7,
    });

    showDischargeRecommendations(recommendations, setSheetMsg);
  } catch (e) {
    console.error('退院調整エラー:', e);
    setSheetMsg('退院調整の計算中にエラーが発生しました。', true);
  }
}

function showDischargeRecommendations(recommendations, setSheetMsg) {
  document.querySelectorAll('.discharge-modal-overlay').forEach(m => m.remove());

  const overlay = document.createElement('div');
  overlay.className = 'discharge-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'discharge-modal';

  const header = document.createElement('div');
  header.className = 'discharge-modal-header';
  header.innerHTML = `
    <h3>退院候補日一覧</h3>
    <button class="discharge-modal-close" type="button">✕</button>
  `;
  modal.appendChild(header);

  const content = document.createElement('div');
  content.className = 'discharge-modal-content';

  if (recommendations.length === 0) {
    content.innerHTML = '<p class="muted">候補日を算出できる患者がいません。</p>';
  } else {
    recommendations.forEach((rec) => {
      const card = document.createElement('div');
      card.className = 'discharge-card';

      const topList = (rec.top || []).map((c, idx) => {
        const rank = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
        return `
          <div class="discharge-candidate ${idx === 0 ? 'best' : ''}">
            <span class="rank">${rank}</span>
            <span class="date">${c.date_iso}（${c.weekday}）</span>
            <span class="score">スコア: ${c.score_total}</span>
            <span class="detail">
              DPC: ${c.F_dpc} / 逼迫: ${c.F_cap} / LOS: ${c.los}日
            </span>
          </div>
        `;
      }).join('');

      const rationale = rec.rationale || {};
      const rationaleText = [
        rationale.dpc,
        rationale.cap,
        rationale.weekday,
        rationale.note
      ].filter(Boolean).join('・');

      card.innerHTML = `
        <div class="discharge-card-header">
          <span class="patient-id">${escapeHtml(rec.patient_key)}</span>
          <span class="dpc-code">${escapeHtml(rec.dpc_code || '---')}</span>
        </div>
        <div class="discharge-card-body">
          ${topList || '<p class="muted">候補なし</p>'}
        </div>
        ${rationaleText ? `<div class="discharge-rationale">${escapeHtml(rationaleText)}</div>` : ''}
      `;

      content.appendChild(card);
    });
  }

  modal.appendChild(content);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.querySelector('.discharge-modal-close')?.addEventListener('click', () => {
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  setSheetMsg(`${recommendations.length}名の退院候補日を算出しました。`);
}

// ===== グローバル公開 =====
window.WardFeatures = {
  // DPCピッカー
  openDpcPicker,
  closeDpcPicker,

  // ベッドタイプ
  showBedTypeSelector,
  applyBedType,
  clearBedNo,

  // 看護必要度
  showNursingSelector,

  // 退院調整
  runDischargeOptimize,
};

})();