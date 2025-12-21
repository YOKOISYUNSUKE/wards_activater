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

  const mTotal = s.match(/^(\d+)/);
  const total = mTotal ? Number(mTotal[1]) : NaN;

  const mAbc = s.match(/A(\d+)\s*\/\s*B(\d+)\s*\/\s*C(\d+)/);
  const a = mAbc ? Number(mAbc[1]) : NaN;
  const b = mAbc ? Number(mAbc[2]) : NaN;
  const c = mAbc ? Number(mAbc[3]) : NaN;

  if (!Number.isFinite(total)) return null;
  return {
    total,
    a: Number.isFinite(a) ? a : null,
    b: Number.isFinite(b) ? b : null,
    c: Number.isFinite(c) ? c : null,
  };
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
  const abcEl = document.getElementById('nursingAvgAbc');
  if (!avgEl || !abcEl) return;

  const { avgTotal, avgA, avgB, avgC } = calcAvgNursingFromRows(sheetAllRows);

  avgEl.textContent = (avgTotal === null) ? '-' : avgTotal.toFixed(1);

  const aTxt = (avgA === null) ? '-' : avgA.toFixed(1);
  const bTxt = (avgB === null) ? '-' : avgB.toFixed(1);
  const cTxt = (avgC === null) ? '-' : avgC.toFixed(1);
  abcEl.textContent = `A${aTxt}/B${bTxt}/C${cTxt}`;
}

function updateKpiUI() {
  updateLosUI();
  updateNursingUI();
  updateOccupancyUI();
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

  sheetAllRows = await getSheetRows(session.userId, ward.id);
  setSheetMsg('');

  if (sheetWardName) sheetWardName.textContent = `${ward.name}（${ward.id}）`;
  if (sheetSearch) sheetSearch.value = '';
  sortState = { col: -1, dir: 0 };

  if (inputBedCount) inputBedCount.value = String(sheetAllRows.length);

  wardView?.classList.add('hidden');
  sheetView?.classList.remove('hidden');

applySearchAndSort();
updateKpiUI();

}

function backToWards() {
  currentWard = null;
  setSheetMsg('');
  sheetView?.classList.add('hidden');
  wardView?.classList.remove('hidden');
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
            if (c === COL_NURSING) {
              const display = String(cell || '').trim();
              const shown = display || '（クリックして選択）';
              return `
                <td>
                  <div class="cell nursing-cell" data-idx="${it.idx}" data-c="${c}" title="クリックしてA/B/Cを選択">
                    ${escapeHtml(shown)}
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

  // KPIも含めて更新
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
  runDischargeOptimize(sheetAllRows, currentWard, setSheetMsg);
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