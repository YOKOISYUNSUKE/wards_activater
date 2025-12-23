'use strict';

/**
 * ward-sheet.js
 * シートUI・テーブル描画・イベント処理・病棟選択画面
 */

(function () {

const {
  SHEET_COLUMNS,
  COL_BED_NO,
  COL_PATIENT_ID,
  COL_DISCHARGE_OK,
  COL_DPC,
  COL_DPC_I,
  COL_DPC_II,
  COL_DPC_III,
  COL_ADMIT_DATE,
  COL_ADMIT_DAYS,
  COL_NURSING,
  COL_EST_DISCHARGE,
  loadSession,
  escapeHtml,
  todayJSTIsoDate,
  calcAdmitDays,
  normalizeDateSlash,
  normalizeDateIso,
  formatBedNoDisplay,
  makeEmptyRows,
  getSheetRows,
  setSheetRows,
  deleteSheetRows,
  getWardsForUser,
  setWardsForUser,
  getNextWardNumber,
  defaultWardName,
  ensureDb,
} = window.WardCore;

const {
  openDpcPicker,
  showBedTypeSelector,
  applyBedType,
  clearBedNo,
  showNursingSelector,
  runDischargeOptimize,
} = window.WardFeatures;

// ===== 固定 横スクロールバー（画面下 常時表示） =====
let fixedHScroll = null;
let fixedHScrollInner = null;
let fixedHScrollReady = false;
let syncingHScroll = false;

function ensureFixedHScroll() {
  if (fixedHScrollReady) return;

  fixedHScroll = document.createElement('div');
  fixedHScroll.className = 'fixed-hscroll hidden';

  fixedHScrollInner = document.createElement('div');
  fixedHScrollInner.className = 'fixed-hscroll-inner';
  fixedHScroll.appendChild(fixedHScrollInner);

  document.body.appendChild(fixedHScroll);

  // fixedHScroll -> tableWrap
  fixedHScroll.addEventListener('scroll', () => {
    if (syncingHScroll) return;
    const wrap = document.querySelector('#sheetView .table-wrap');
    if (!wrap) return;
    syncingHScroll = true;
    wrap.scrollLeft = fixedHScroll.scrollLeft;
    syncingHScroll = false;
  });

  fixedHScrollReady = true;
}

function updateFixedHScrollMetrics() {
  if (!fixedHScrollReady) return;

  const wrap = document.querySelector('#sheetView .table-wrap');
  const table = document.getElementById('sheetTable');
  if (!wrap || !table) return;

  // テーブルの実幅を“ダミー要素”に反映（これがスクロール幅になる）
  const w = Math.max(table.scrollWidth, wrap.clientWidth);
  fixedHScrollInner.style.width = `${w}px`;

  // wrap側の現在位置を固定バーに反映
  fixedHScroll.scrollLeft = wrap.scrollLeft;
}

function showFixedHScroll() {
  ensureFixedHScroll();

  fixedHScroll.classList.remove('hidden');
  document.body.classList.add('has-hscroll');

  const wrap = document.querySelector('#sheetView .table-wrap');
  if (wrap) {
    // tableWrap -> fixedHScroll
    wrap.addEventListener('scroll', () => {
      if (syncingHScroll) return;
      syncingHScroll = true;
      fixedHScroll.scrollLeft = wrap.scrollLeft;
      syncingHScroll = false;
    });
  }

  updateFixedHScrollMetrics();

  // リサイズで幅が変わるので追従
  window.addEventListener('resize', updateFixedHScrollMetrics);
}

function hideFixedHScroll() {
  if (!fixedHScrollReady) return;
  fixedHScroll.classList.add('hidden');
  document.body.classList.remove('has-hscroll');
  window.removeEventListener('resize', updateFixedHScrollMetrics);
}

// ===== DOM =====
const wardView = document.getElementById('wardView');
const sheetView = document.getElementById('sheetView');
const wardGrid = document.getElementById('wardGrid');
const currentUser = document.getElementById('currentUser');
const wardCountLabel = document.getElementById('wardCountLabel');
const btnAddWard = document.getElementById('btnAddWard');
const wardMsg = document.getElementById('wardMsg');
const btnBackToWards = document.getElementById('btnBackToWards');
const sheetWardName = document.getElementById('sheetWardName');
const sheetTable = document.getElementById('sheetTable');
const inputBedCount = document.getElementById('inputBedCount');
const btnClearSheet = document.getElementById('btnClearSheet');
const btnDischargeOptimize = document.getElementById('btnDischargeOptimize');
const sheetMsg = document.getElementById('sheetMsg');
const sheetSearch = document.getElementById('sheetSearch');

// 病院全体KPI（病棟選択画面）
const hospitalLosInpatients = document.getElementById('hospitalLosInpatients');
const hospitalLosAvg = document.getElementById('hospitalLosAvg');
const hospitalNursingAvgAbc = document.getElementById('hospitalNursingAvgAbc');
const hospitalNursingAvg = document.getElementById('hospitalNursingAvg');
const hospitalOccFraction = document.getElementById('hospitalOccFraction');
const hospitalOccPercent = document.getElementById('hospitalOccPercent');


// ===== State =====
let currentWard = null;
let sheetAllRows = [];
let sheetViewRows = [];
let sortState = { col: -1, dir: 0 };

// ===== メッセージ表示 =====
function setWardMsg(text, isError = false) {
  if (!wardMsg) return;
  wardMsg.textContent = text || '';
  wardMsg.classList.toggle('error', !!isError);
}

function setSheetMsg(text, isError = false) {
  if (!sheetMsg) return;
  sheetMsg.textContent = text || '';
  sheetMsg.classList.toggle('error', !!isError);
}

// ===== 稼働率 =====
function calcOccupancyFromRows(rows) {
  const bedCount = Array.isArray(rows) ? rows.length : 0;
  const inpatients = (rows || []).reduce((acc, row) => {
    const pid = String(row?.[COL_PATIENT_ID] ?? '').trim();
    return acc + (pid ? 1 : 0);
  }, 0);
  const percent = bedCount > 0 ? (inpatients / bedCount) * 100 : 0;
  return { inpatients, bedCount, percent };
}

function updateOccupancyUI() {
  const fracEl = document.getElementById('occFraction');
  const pctEl = document.getElementById('occPercent');
  if (!fracEl || !pctEl) return;

  const { inpatients, bedCount, percent } = calcOccupancyFromRows(sheetAllRows);
  fracEl.textContent = `${inpatients}/${bedCount}`;
  pctEl.textContent = `${Math.round(percent)}%`;
}

function calcAvgLosFromRows(rows) {
  const items = (rows || []).filter(r => String(r?.[COL_PATIENT_ID] ?? '').trim());
  const n = items.length;
  if (n === 0) return { n: 0, avg: null };

  let sum = 0;
  let cnt = 0;
  items.forEach(r => {
    const v = Number(String(r?.[COL_ADMIT_DAYS] ?? '').trim());
    if (Number.isFinite(v) && v > 0) { sum += v; cnt += 1; }
  });

  if (cnt === 0) return { n, avg: null };
  return { n, avg: sum / cnt };
}

function parseNursingCell(val) {
  const s = String(val ?? '').trim();
  if (!s) return null;

  // 新: "A1/B2/C0" → total は内部で a+b+c
  const mNew = s.match(/^A(\d+)\s*\/\s*B(\d+)\s*\/\s*C(\d+)$/);
  if (mNew) {
    const a = Number(mNew[1]);
    const b = Number(mNew[2]);
    const c = Number(mNew[3]);
    if (![a, b, c].every(Number.isFinite)) return null;
    return { total: a + b + c, a, b, c };
  }
function nursingKpiDayKey(userId, wardId, isoDate) {
  return `bm_nursing_kpi_day_v1|${userId}|${wardId}|${isoDate}`;
}

function isNursingKpiQualified(a, b, c) {
  const A = Number(a) || 0;
  const B = Number(b) || 0;
  const C = Number(c) || 0;

  const cond1 = (A >= 2 && B >= 3);
  const cond2 = (A >= 3);
  const cond3 = (C >= 1);

  return (cond1 || cond2 || cond3);
}

function recordNursingKpiForToday(userId, wardId, rows) {
  const iso = todayJSTIsoDate(); // "YYYY-MM-DD"
  const inpatients = (rows || []).filter(r => String(r?.[COL_PATIENT_ID] ?? '').trim());

  const denom = inpatients.length;

  let num = 0;
  inpatients.forEach(r => {
    const parsed = parseNursingCell(r?.[COL_NURSING]); // {a,b,c,total}
    if (!parsed) return;
    if (isNursingKpiQualified(parsed.a, parsed.b, parsed.c)) num += 1;
  });

  const key = nursingKpiDayKey(userId, wardId, iso);
  localStorage.setItem(key, JSON.stringify({ denom, num }));
}

function listLastNDaysIso(nDays) {
  const out = [];
  const base = new Date(todayJSTIsoDate());
  base.setHours(0,0,0,0);

  for (let i = 0; i < nDays; i++) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${da}`);
  }
  return out;
}

function sumNursingKpiLastNDays(userId, wardId, nDays) {
  const days = listLastNDaysIso(nDays);
  let denomSum = 0;
  let numSum = 0;
  let availableDays = 0;

  days.forEach(iso => {
    const key = nursingKpiDayKey(userId, wardId, iso);
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try {
      const obj = JSON.parse(raw);
      const d = Number(obj?.denom) || 0;
      const n = Number(obj?.num) || 0;
      denomSum += d;
      numSum += n;
      availableDays += 1;
    } catch {}
  });

  const rate = denomSum > 0 ? (numSum / denomSum) * 100 : null;
  return { denomSum, numSum, rate, availableDays };
}




function calcAvgNursingFromRows(rows) {
  const items = (rows || []).filter(r => String(r?.[COL_PATIENT_ID] ?? '').trim());
  const n = items.length;
  if (n === 0) return { n: 0, avgTotal: null, avgA: null, avgB: null, avgC: null };

  let sumT = 0, cntT = 0;
  let sumA = 0, cntA = 0;
  let sumB = 0, cntB = 0;
  let sumC = 0, cntC = 0;

  items.forEach(r => {
    const parsed = parseNursingCell(r?.[COL_NURSING]);
    if (!parsed) return;

    sumT += parsed.total; cntT += 1;

    if (parsed.a !== null) { sumA += parsed.a; cntA += 1; }
    if (parsed.b !== null) { sumB += parsed.b; cntB += 1; }
    if (parsed.c !== null) { sumC += parsed.c; cntC += 1; }
  });

  return {
    n,
    avgTotal: cntT ? (sumT / cntT) : null,
    avgA: cntA ? (sumA / cntA) : null,
    avgB: cntB ? (sumB / cntB) : null,
    avgC: cntC ? (sumC / cntC) : null,
  };
}

function updateLosUI() {
  const nEl = document.getElementById('losInpatients');
  const avgEl = document.getElementById('losAvg');
  if (!nEl || !avgEl) return;

  const { n, avg } = calcAvgLosFromRows(sheetAllRows);
  nEl.textContent = `${n}名`;

  if (avg === null) {
    avgEl.textContent = '-日';
  } else {
    avgEl.textContent = `${avg.toFixed(1)}日`;
  }
}

function updateNursingUI() {
  const avgEl = document.getElementById('nursingAvg');
  const subEl = document.getElementById('nursingAvgAbc');
  if (!avgEl || !subEl) return;

  const session = loadSession();
  if (!session?.userId || !currentWard) {
    avgEl.textContent = '-%';
    subEl.textContent = '-/- (3ヶ月)';
    return;
  }

  const k = sumNursingKpiLastNDays(session.userId, currentWard.id, 90);

  if (k.rate === null) {
    avgEl.textContent = '-%';
    subEl.textContent = '-/- (3ヶ月)';
    return;
  }

  avgEl.textContent = `${k.rate.toFixed(1)}%`;
  subEl.textContent = `${k.numSum}/${k.denomSum} (3ヶ月)`;

  // 収集期間が短い間は注記（“3ヶ月”未満を明示）
  if (k.availableDays < 90) {
    subEl.textContent = `${k.numSum}/${k.denomSum} (${k.availableDays}日分)`;
  }
}


function updateKpiUI() {
  updateLosUI();
  updateNursingUI();
  updateOccupancyUI();
}

async function computeHospitalKpi(userId) {
  const wards = getWardsForUser(userId);

  let bedCount = 0;
  let inpatients = 0;

  let losSum = 0;
  let losCnt = 0;

  // 新KPI（90日）
  let nkDenom = 0;
  let nkNum = 0;
  let nkAvailDaysMax = 0;

  for (const w of wards) {
    const rows = await getSheetRows(userId, w.id);
    bedCount += Array.isArray(rows) ? rows.length : 0;

    (rows || []).forEach(row => {
      const pid = String(row?.[COL_PATIENT_ID] ?? '').trim();
      if (!pid) return;
      inpatients++;

      const admitDate = String(row?.[COL_ADMIT_DATE] ?? '').trim();
      const los = Number(calcAdmitDays(admitDate));
      if (Number.isFinite(los) && los > 0) {
        losSum += los;
        losCnt++;
      }
    });

    const k = sumNursingKpiLastNDays(userId, w.id, 90);
    nkDenom += k.denomSum;
    nkNum += k.numSum;
    nkAvailDaysMax = Math.max(nkAvailDaysMax, k.availableDays);
  }

  const nkRate = nkDenom > 0 ? (nkNum / nkDenom) * 100 : null;

  return {
    bedCount,
    inpatients,
    occPercent: bedCount ? (inpatients / bedCount) * 100 : 0,
    losAvg: losCnt ? losSum / losCnt : null,

    nursingKpiNum: nkNum,
    nursingKpiDenom: nkDenom,
    nursingKpiRate: nkRate,
    nursingKpiAvailDays: nkAvailDaysMax,
  };
}


function setHospitalKpiUiUnknown() {
    if (hospitalNursingAvg) {
      hospitalNursingAvg.textContent = (k.nursingKpiRate === null) ? '-%' : `${k.nursingKpiRate.toFixed(1)}%`;
    }
    if (hospitalNursingAvgAbc) {
      if (k.nursingKpiRate === null) {
        hospitalNursingAvgAbc.textContent = '-/- (3ヶ月)';
      } else {
        const label = (k.nursingKpiAvailDays < 90) ? `${k.nursingKpiAvailDays}日分` : '3ヶ月';
        hospitalNursingAvgAbc.textContent = `${k.nursingKpiNum}/${k.nursingKpiDenom} (${label})`;
      }
    }

}

async function updateHospitalKpiUI(userId) {
  const hasAny = !!(hospitalLosInpatients || hospitalLosAvg || hospitalNursingAvgAbc || hospitalNursingAvg || hospitalOccFraction || hospitalOccPercent);
  if (!hasAny) return;

  try {
    await ensureDb();
    const k = await computeHospitalKpi(userId);

    if (hospitalLosInpatients) hospitalLosInpatients.textContent = `${k.inpatients}名`;
    if (hospitalLosAvg) hospitalLosAvg.textContent = (k.losAvg === null) ? '-日' : `${k.losAvg.toFixed(1)}日`;

    if (hospitalNursingAvg) hospitalNursingAvg.textContent = (k.nursingAvgTotal === null) ? '-' : k.nursingAvgTotal.toFixed(1);
    if (hospitalNursingAvgAbc) {
      const aTxt = (k.nursingAvgA === null) ? '-' : k.nursingAvgA.toFixed(1);
      const bTxt = (k.nursingAvgB === null) ? '-' : k.nursingAvgB.toFixed(1);
      const cTxt = (k.nursingAvgC === null) ? '-' : k.nursingAvgC.toFixed(1);
      hospitalNursingAvgAbc.textContent = `A${aTxt}/B${bTxt}/C${cTxt}`;
    }

    if (hospitalOccFraction) hospitalOccFraction.textContent = `${k.inpatients}/${k.bedCount}`;
    if (hospitalOccPercent) hospitalOccPercent.textContent = `${Math.round(k.occPercent)}%`;
  } catch (e) {
    console.warn(e);
    setHospitalKpiUiUnknown();
  }
}


// ===== 病棟管理UI =====
function updateWardCountBadge(userId) {
  if (!wardCountLabel) return;
  const wards = getWardsForUser(userId);
  wardCountLabel.textContent = String(wards.length);
}

function addWardForUser(userId) {
  const wards = getWardsForUser(userId);

  if (wards.length >= 20) {
    setWardMsg('病棟は最大20まで追加できます。', true);
    return;
  }

  const nextN = getNextWardNumber(wards);
  const suggested = defaultWardName(nextN);

  const name = (window.prompt('追加する病棟名を入力してください（未入力なら自動命名）', suggested) || '').trim();
  const finalName = name || suggested;

  const id = `ward${nextN}`;
  const exists = wards.some(w => w.id === id);
  const finalId = exists ? `ward${Date.now()}` : id;

  const next = [...wards, { id: finalId, name: finalName }];
  setWardsForUser(userId, next);

  setWardMsg(`「${finalName}」を追加しました。`);
  renderWardButtons(userId);
}

function renameWardForUser(userId, wardId) {
  const wards = getWardsForUser(userId);
  const w = wards.find(x => x.id === wardId);
  if (!w) return;

  const nextName = (window.prompt('病棟名を変更してください', w.name) || '').trim();
  if (!nextName) return;

  const next = wards.map(x => x.id === wardId ? { ...x, name: nextName } : x);
  setWardsForUser(userId, next);

  setWardMsg(`「${w.name}」→「${nextName}」に変更しました。`);
  renderWardButtons(userId);

  if (currentWard && currentWard.id === wardId) {
    currentWard = { ...currentWard, name: nextName };
    if (sheetWardName) sheetWardName.textContent = `${currentWard.name}（${currentWard.id}）`;
  }
}

async function deleteWardForUser(userId, wardId) {
  const wards = getWardsForUser(userId);
  const w = wards.find(x => x.id === wardId);
  if (!w) return;

  if (wards.length <= 1) {
    setWardMsg('病棟は最低1つ必要です。', true);
    return;
  }

  const ok = window.confirm(`「${w.name}」を削除します。\nこの病棟のシートデータ（患者一覧）も削除されます。よろしいですか？`);
  if (!ok) return;

  const next = wards.filter(x => x.id !== wardId);
  setWardsForUser(userId, next);

  await deleteSheetRows(userId, wardId);

  setWardMsg(`「${w.name}」を削除しました。`);
  renderWardButtons(userId);
}

function renderWardButtons(userId) {
  if (!wardGrid) return;

  const wards = getWardsForUser(userId);

  wardGrid.innerHTML = '';
  wards.forEach((w, idx) => {
    const card = document.createElement('div');
    card.className = 'ward-card';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'ward';
    main.innerHTML = `
      <p class="title">${escapeHtml(w.name)}</p>
      <p class="meta">Ward ID: ${escapeHtml(w.id)} / No.${idx + 1}</p>
    `;
    main.addEventListener('click', () => {
      openWardSheet(w).catch(() => setSheetMsg('読み込みに失敗しました。', true));
    });

    const actions = document.createElement('div');
    actions.className = 'ward-actions';

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'btn btn-outline ward-action-btn';
    renameBtn.textContent = '名前変更';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      renameWardForUser(userId, w.id);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-outline ward-action-btn danger';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteWardForUser(userId, w.id).catch(() => setWardMsg('削除に失敗しました。', true));
    });

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    card.appendChild(main);
    card.appendChild(actions);
    wardGrid.appendChild(card);
  });

  if (currentUser) currentUser.textContent = userId;
  updateWardCountBadge(userId);
}

// ===== シート操作 =====
async function openWardSheet(ward) {
  const session = loadSession();
  if (!session?.userId) return;

  currentWard = ward;
  setSheetMsg('読み込み中…');

  try {
    await ensureDb();
  } catch (e) {
    console.error(e);
    setWardMsg(
      'データベースの初期化に失敗しました。ブラウザのストレージ制限やプライベートモードの可能性があります。',
      true
    );
    return;
  }

  sheetAllRows = await getSheetRows(session.userId, ward.id);
  recordNursingKpiForToday(session.userId, ward.id, sheetAllRows);
  setSheetMsg('');


  if (sheetWardName) sheetWardName.textContent = `${ward.name}（${ward.id}）`;
  if (sheetSearch) sheetSearch.value = '';
  sortState = { col: -1, dir: 0 };

  if (inputBedCount) inputBedCount.value = String(sheetAllRows.length);

  wardView?.classList.add('hidden');
  sheetView?.classList.remove('hidden');

  showFixedHScroll();
  updateFixedHScrollMetrics();

applySearchAndSort();
updateKpiUI();

}

function backToWards() {
  currentWard = null;
  setSheetMsg('');
  sheetView?.classList.add('hidden');
  wardView?.classList.remove('hidden');
  hideFixedHScroll();
}

// ===== 検索・ソート =====
function applySearchAndSort() {
  const q = (sheetSearch?.value || '').trim().toLowerCase();
  let items = sheetAllRows.map((row, idx) => ({ idx, row }));

  if (q) {
    const master = window.DPC_MASTER;
    items = items.filter(it => {
      const hitCell = it.row.some(cell => String(cell ?? '').toLowerCase().includes(q));
      if (hitCell) return true;

      const dpc = String(it.row?.[COL_DPC] ?? '').trim();
      const rec = master?.lookupByCode?.(dpc);
      if (!rec) return false;

      return String(rec.name ?? '').toLowerCase().includes(q);
    });
  }

  if (sortState.col >= 0 && sortState.dir !== 0) {
    const c = sortState.col;
    const dir = sortState.dir;
    items = [...items].sort((a, b) => {
      const av = String(a.row?.[c] ?? '');
      const bv = String(b.row?.[c] ?? '');
      const an = Number(av);
      const bn = Number(bv);
      const bothNum = Number.isFinite(an) && Number.isFinite(bn) && av.trim() !== '' && bv.trim() !== '';
      if (bothNum) return (an - bn) * dir;
      return av.localeCompare(bv, 'ja') * dir;
    });
  }

  sheetViewRows = items;
  renderSheetTable(sheetViewRows);
}

// ===== テーブル描画 =====
function renderSheetTable(items) {
  if (!sheetTable) return;

  const thead = `
    <thead>
      <tr>
        ${SHEET_COLUMNS.map((c, idx) => {
          const ind = sortState.col === idx
            ? (sortState.dir === 1 ? '▲' : sortState.dir === -1 ? '▼' : '')
            : '';
          return `<th class="sortable" data-col="${idx}">${escapeHtml(c)}<span class="sort-ind">${ind}</span></th>`;
        }).join('')}
      </tr>
    </thead>
  `;

  const tbody = `
    <tbody>
      ${items.map((it) => `
        <tr data-idx="${it.idx}">
          ${it.row.map((cell, c) => {
            if (c === COL_BED_NO) {
              const display = formatBedNoDisplay(cell);
              return `
                <td>
                  <div class="cell bed-no-cell" data-idx="${it.idx}" data-c="${c}" data-raw="${escapeHtml(cell)}">${escapeHtml(display)}</div>
                </td>
              `;
            }
            if (c === COL_DISCHARGE_OK) {
              const checked = String(cell || '').trim() === '1';
              return `
                <td style="text-align:center;">
                  <input type="checkbox" class="discharge-ok-check" data-idx="${it.idx}" data-c="${c}" ${checked ? 'checked' : ''} />
                </td>
              `;
            }
if (c === COL_NURSING) {
  const display = String(cell || '').trim();
  return `
    <td>
      <div class="cell nursing-cell" data-idx="${it.idx}" data-c="${c}" title="クリックしてA/B/C点数を選択">
        ${escapeHtml(display)}
      </div>
    </td>
  `;
}


            if (c === COL_ADMIT_DATE || c === COL_EST_DISCHARGE) {
              const isoVal = normalizeDateIso(cell);
              return `
                <td>
                  <input class="date-input" type="date" data-idx="${it.idx}" data-c="${c}" value="${escapeHtml(isoVal)}" />
                </td>
              `;
            }
            return `
              <td>
                <div class="cell" contenteditable="true" data-idx="${it.idx}" data-c="${c}">${escapeHtml(cell)}</div>
              </td>
            `;
          }).join('')}
        </tr>
      `).join('')}
    </tbody>
  `;

  sheetTable.innerHTML = thead + tbody;
 
  updateFixedHScrollMetrics();
 
 // ソートイベント
  sheetTable.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = Number(th.getAttribute('data-col'));
      if (sortState.col !== col) {
        sortState = { col, dir: 1 };
      } else {
        sortState.dir = sortState.dir === 1 ? -1 : sortState.dir === -1 ? 0 : 1;
        if (sortState.dir === 0) sortState.col = -1;
      }
      applySearchAndSort();
    });
  });

  // セル編集イベント
  sheetTable.querySelectorAll('.cell').forEach(el => {
    el.addEventListener('blur', () => {
      try {
        const c = Number(el.getAttribute('data-c'));
        const rowIdx = Number(el.getAttribute('data-idx'));
        const master = window.DPC_MASTER;

// 患者ID → 入院日自動設定（date-input対応）
if (c === COL_PATIENT_ID) {
  const pid = (el.textContent ?? '').trim();
  if (pid) {
    const admitInp = sheetTable.querySelector(
      `input.date-input[data-idx="${rowIdx}"][data-c="${COL_ADMIT_DATE}"]`
    );

    const hasIso = (admitInp?.value || '').trim();
    if (admitInp && hasIso === '') {
      const todayIso = todayJSTIsoDate();           // YYYY-MM-DD
      const todaySlash = normalizeDateSlash(todayIso); // YYYY/MM/DD

      admitInp.value = todayIso;

      if (Number.isFinite(rowIdx) && rowIdx >= 0 && sheetAllRows[rowIdx]) {
        sheetAllRows[rowIdx][COL_ADMIT_DATE] = todaySlash;

        const days = calcAdmitDays(todaySlash);
        sheetAllRows[rowIdx][COL_ADMIT_DAYS] = days;

        const daysEl = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${COL_ADMIT_DAYS}"]`);
        if (daysEl) daysEl.textContent = days;
      }
    }
  }
}


        // 入院日 → 入院日数
        if (c === COL_ADMIT_DATE) {
          const admitDate = (el.textContent ?? '').trim();
          const days = calcAdmitDays(admitDate);
          const daysEl = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${COL_ADMIT_DAYS}"]`);
          if (daysEl) daysEl.textContent = days;
        }

        // 日付正規化
        if (c === COL_ADMIT_DATE || c === COL_EST_DISCHARGE) {
          el.textContent = normalizeDateSlash(el.textContent);
        }

        // DPCコード → 期間自動反映
        if (c === COL_DPC) {
          const input = (el.textContent ?? '').trim();
          if (input && master) {
            let rec = master.lookupByCode?.(input);

            if (!rec) {
              const cands = master.findCandidates?.(input, Infinity) || [];
              if (cands.length === 1) {
                const picked = cands[0];
                el.textContent = picked.code;
                rec = { name: picked.name, I: picked.I, II: picked.II, III: picked.III };
              } else if (cands.length >= 2) {
                openDpcPicker(el, cands, (picked) => {
                  el.textContent = picked.code;

                  const setCell = (col, val) => {
                    const cell = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${col}"]`);
                    if (cell) cell.textContent = String(val ?? '');
                  };
                  setCell(COL_DPC_I, picked.I);
                  setCell(COL_DPC_II, picked.II);
                  setCell(COL_DPC_III, picked.III);

                  persistSheetFromDom().catch(() => setSheetMsg('保存に失敗しました。', true));
                });
                return;
              }
            }

            if (rec) {
              const setCell = (col, val) => {
                const cell = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${col}"]`);
                if (cell) cell.textContent = String(val ?? '');
              };
              setCell(COL_DPC_I, rec.I);
              setCell(COL_DPC_II, rec.II);
              setCell(COL_DPC_III, rec.III);
            }
          }
        }
      } catch (e) {
        console.warn(e);
      }

      persistSheetFromDom().catch(() => setSheetMsg('保存に失敗しました。', true));
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        el.blur();
      }
    });
  });

  // 日付入力イベント
  sheetTable.querySelectorAll('input.date-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      try {
        const c = Number(inp.getAttribute('data-c'));
        const rowIdx = Number(inp.getAttribute('data-idx'));
        const iso = (inp.value || '').trim();
        const slash = normalizeDateSlash(iso);

        if (!Number.isFinite(rowIdx) || rowIdx < 0) return;
        if (!sheetAllRows[rowIdx]) return;

        sheetAllRows[rowIdx][c] = slash;

        if (c === COL_ADMIT_DATE) {
          const days = calcAdmitDays(slash);
          sheetAllRows[rowIdx][COL_ADMIT_DAYS] = days;
        }

        const session = loadSession();
        if (session?.userId && currentWard) {
          await setSheetRows(session.userId, currentWard.id, sheetAllRows);
        }

        setSheetMsg('保存しました。');
        updateKpiUI();
        applySearchAndSort();
      } catch (e) {
        console.warn(e);
        setSheetMsg('日付の保存に失敗しました。', true);
      }
    });
  });

  // ベッドNo列クリック
  sheetTable.querySelectorAll('.bed-no-cell').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showBedTypeSelector(el, sheetAllRows, async (action, rowIdx, num, type) => {
        if (action === 'clear') {
          await clearBedNo(rowIdx, sheetAllRows, currentWard, (msg) => {
            setSheetMsg(msg);
            applySearchAndSort();
          });
        } else {
          await applyBedType(rowIdx, num, type, sheetAllRows, currentWard, (msg) => {
            setSheetMsg(msg);
            applySearchAndSort();
          });
        }
      });
    });
  });

  // 看護必要度セルクリック
  sheetTable.querySelectorAll('.nursing-cell').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showNursingSelector(el, sheetAllRows, currentWard, (msg) => {
        setSheetMsg(msg);
        applySearchAndSort();
      });
    });
  });

  // 退院許可チェックボックス
  sheetTable.querySelectorAll('.discharge-ok-check').forEach(cb => {
    cb.addEventListener('change', async () => {
      const rowIdx = Number(cb.getAttribute('data-idx'));
      if (!Number.isFinite(rowIdx) || rowIdx < 0) return;
      if (!sheetAllRows[rowIdx]) return;

      sheetAllRows[rowIdx][COL_DISCHARGE_OK] = cb.checked ? '1' : '';

      const session = loadSession();
      if (session?.userId && currentWard) {
        await setSheetRows(session.userId, currentWard.id, sheetAllRows);
      }
      setSheetMsg('保存しました。');
    });
  });
}

// ===== シート保存 =====
async function persistSheetFromDom() {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  const rowEls = Array.from(sheetTable.querySelectorAll('tbody tr'));

  rowEls.forEach((tr) => {
    const idx = Number(tr.getAttribute('data-idx'));
    if (!Number.isFinite(idx) || idx < 0) return;

    if (!sheetAllRows[idx]) {
      sheetAllRows[idx] = Array.from({ length: SHEET_COLUMNS.length }, () => '');
    }

const row = Array.from({ length: SHEET_COLUMNS.length }, () => '');

    for (let c = 0; c < SHEET_COLUMNS.length; c++) {
      if (c === COL_ADMIT_DATE || c === COL_EST_DISCHARGE) {
        const inp = tr.querySelector(`input.date-input[data-c="${c}"]`);
        const iso = (inp?.value || '').trim();
        row[c] = iso ? normalizeDateSlash(iso) : '';
      } else if (c === COL_BED_NO) {
        // ★ ベッドNo列は.bed-no-cellから読み取る
        const bedCell = tr.querySelector(`.bed-no-cell[data-c="${c}"]`);
        const rawBedNo = bedCell?.getAttribute('data-raw') || '';
        row[c] = rawBedNo;
      } else {
        const div = tr.querySelector(`.cell[data-c="${c}"]`);
        row[c] = (div?.textContent ?? '').trimEnd();
      }
    }

    // 入院日数は入院日から再計算（整合性担保）
    if (row[COL_ADMIT_DATE]) {
      row[COL_ADMIT_DAYS] = calcAdmitDays(row[COL_ADMIT_DATE]);
      const daysEl = tr.querySelector(`.cell[data-c="${COL_ADMIT_DAYS}"]`);
      if (daysEl) daysEl.textContent = row[COL_ADMIT_DAYS];
    }

    sheetAllRows[idx] = row;
  });

  await setSheetRows(session.userId, currentWard.id, sheetAllRows);
  setSheetMsg('保存しました。');

  recordNursingKpiForToday(session.userId, currentWard.id, sheetAllRows);

  updateKpiUI();

}



// ===== 病床数変更 =====
async function applyBedCount(count) {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  const n = Math.max(0, Math.min(200, Number(count)));
  sheetAllRows = Array.isArray(sheetAllRows) ? sheetAllRows : [];

  if (sheetAllRows.length < n) {
    while (sheetAllRows.length < n) {
      const rIdx = sheetAllRows.length;
      const row = Array.from({ length: SHEET_COLUMNS.length }, () => '');
      row[COL_BED_NO] = String(rIdx + 1);
      sheetAllRows.push(row);
    }
  }

  if (sheetAllRows.length > n) {
    sheetAllRows.length = n;
  }

  await setSheetRows(session.userId, currentWard.id, sheetAllRows);

  setSheetMsg(`病床数を ${n} 床に設定しました。`);
  applySearchAndSort();
  updateKpiUI();
}

// ===== クリア =====
async function clearSheet() {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  sheetAllRows = makeEmptyRows(3);
  await setSheetRows(session.userId, currentWard.id, sheetAllRows);

  setSheetMsg('クリアしました。');
  applySearchAndSort();
  updateKpiUI();
}

// ===== Public API =====
function render(userId) {
  renderWardButtons(userId);

  updateHospitalKpiUI(userId)
    .catch(() => setHospitalKpiUiUnknown());
}

function reset() {
  currentWard = null;
  sheetAllRows = [];
  sheetViewRows = [];
  sortState = { col: -1, dir: 0 };
  setWardMsg('');
  setSheetMsg('');
  if (wardGrid) wardGrid.innerHTML = '';
  if (sheetSearch) sheetSearch.value = '';
}

window.BMWard = { render, reset };

// ===== イベントバインド =====
btnAddWard?.addEventListener('click', () => {
  const session = loadSession();
  if (!session?.userId) return;
  addWardForUser(session.userId);
});

btnBackToWards?.addEventListener('click', () => backToWards());
btnClearSheet?.addEventListener('click', () => clearSheet());
btnDischargeOptimize?.addEventListener('click', () => {
  runDischargeOptimize(sheetAllRows, currentWard, setSheetMsg, async (rowIdx, dateIso) => {
    if (!Number.isFinite(rowIdx) || rowIdx < 0) return;
    if (!sheetAllRows[rowIdx]) return;

    const slash = normalizeDateSlash(dateIso);
    sheetAllRows[rowIdx][COL_EST_DISCHARGE] = slash;

    const session = loadSession();
    if (session?.userId && currentWard) {
      await setSheetRows(session.userId, currentWard.id, sheetAllRows);
    }

    setSheetMsg(`行${rowIdx + 1}の退院予定日を ${slash} に設定しました。`);
    applySearchAndSort();
    updateKpiUI();
  });
});

inputBedCount?.addEventListener('change', () => {
  applyBedCount(inputBedCount.value);
});

sheetSearch?.addEventListener('input', () => applySearchAndSort());

// ===== 初期化 =====
(async function bootstrapWard() {
  try {
    await ensureDb();
  } catch (e) {
    console.error(e);
    setSheetMsg(
      'データベースの初期化に失敗しました。ブラウザのストレージ制限やプライベートモードの可能性があります。',
      true
    );
  }
})();

})();