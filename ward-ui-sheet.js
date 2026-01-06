'use strict';

/**
 * ward-ui-sheet.js
 * 病棟シート画面（開く/戻る/状態管理/予定入院・ER入力）
 */

(function () {

  const {
    loadSession,
    escapeHtml,
    todayJSTIsoDate,
    calcAdmitDays,
    getPlannedAdmissions,
    setPlannedAdmissions,
    getErEstimate,
    setErEstimate,
    getWardTransfersForWard,
    getWardTransfers,
    setWardTransfers,
    getWardsForUser,
    normalizeDateSlash,
    makeEmptyRows,
    getSheetRows,
    setSheetRows,
    ensureDb,
    SHEET_COLUMNS,
    COL_PATIENT_ID,
    COL_ADMIT_DATE,
    COL_ADMIT_DAYS,
  } = window.WardCore;

  const {
    updateWardKpiUI,
    recordNursingKpiForToday,
    updateHospitalKpiUI,
    setHospitalKpiUiUnknown,
  } = window.WardKpi || {};

  // 主病名列（ward-core.jsで未定義のためローカル定義）
  const COL_DISEASE = 3;

  function dom() {
    return {
      wardView: document.getElementById('wardView'),
      sheetView: document.getElementById('sheetView'),
      sheetWardName: document.getElementById('sheetWardName'),
      inputBedCount: document.getElementById('inputBedCount'),
      sheetSearch: document.getElementById('sheetSearch'),
      plannedAdmissionsTable: document.getElementById('plannedAdmissionsTable'),
      plannedAdmissionsMsg: document.getElementById('plannedAdmissionsMsg'),
      btnAddPlannedAdmission: document.getElementById('btnAddPlannedAdmission'),
      wardTransfersTable: document.getElementById('wardTransfersTable'),
      wardTransfersMsg: document.getElementById('wardTransfersMsg'),
      btnAddWardTransfer: document.getElementById('btnAddWardTransfer'),
      
    };
  }


  function state() {
    window.BMWardState = window.BMWardState || {
      currentWard: null,
      sheetAllRows: [],
      sheetViewRows: [],
      sortState: { col: -1, dir: 0 },
    };
    return window.BMWardState;
  }

  function setSheetMsg(text, isError) {
    window.BMWardMsg?.setSheetMsg?.(text, isError);
  }

  function setWardMsg(text, isError) {
    window.BMWardMsg?.setWardMsg?.(text, isError);
  }

  function updateKpiUI() {
    const st = state();
    try {
      updateWardKpiUI && updateWardKpiUI(st.sheetAllRows, st.currentWard);
    } catch (e) {
      console.warn(e);
    }
  }

  function getActiveUserWard() {
    const session = loadSession();
    const st = state();
    const userId = session?.userId || '';
    const wardId = st.currentWard?.id || '';
    return { userId, wardId };
  }

function renderPlannedAdmissionsTable(items) {
    const { plannedAdmissionsTable } = dom();
    if (!plannedAdmissionsTable) return;

    plannedAdmissionsTable.innerHTML = `
      <thead>
        <tr>
          <th>ID <span style="font-weight:400;font-size:11px;color:#6b7280;">（クリックで入院）</span></th>
          <th>病名</th>
          <th>入院予定日</th>
          <th>予定期間（日）</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${items.map((row, idx) => `
          <tr>
            <td>
              <div style="display:flex; gap:6px; align-items:center;">
                <input class="plan-cell"
                  value="${escapeHtml(row.id || '')}"
                  data-i="${idx}" data-k="id"
                  placeholder="患者ID">

                <button class="btn btn-outline btn-sm"
                  type="button"
                  data-admit="${idx}"
                  title="病棟シートに入院登録">
                  入院
                </button>
              </div>
            </td>
            <td><input class="plan-cell" value="${escapeHtml(row.disease || '')}" data-i="${idx}" data-k="disease"></td>
            <td><input type="date" class="plan-cell" value="${escapeHtml(row.date || '')}" data-i="${idx}" data-k="date"></td>
            <td><input type="number" class="plan-cell" min="1" value="${escapeHtml(row.days || '')}" data-i="${idx}" data-k="days"></td>
            <td><button class="btn btn-outline" data-del="${idx}">削除</button></td>
          </tr>
        `).join('')}
      </tbody>
    `;
  }

// ===== 病棟移動（移動元/移動先の両病棟で共有） =====
function ensureWardTransfersUi() {
  const d = dom();
  if (d.wardTransfersTable && d.btnAddWardTransfer && d.wardTransfersMsg) return;

  // plan-grid 内（予定入院 / 病棟移動 / 推定緊急入院）にカードを追加
  const planGrid = document.querySelector('.plan-grid');
  if (!planGrid) return;

  // 二重生成防止
  if (document.getElementById('wardTransfersCard')) return;

  const wrap = document.createElement('div');
  wrap.className = 'plan-card';
  wrap.id = 'wardTransfersCard';
  wrap.innerHTML = `
    <div class="plan-card-head">
      <div>
        <p class="plan-title">病棟移動</p>
        <p class="plan-sub">移動元 / 移動先</p>
      </div>
      <button class="btn btn-outline plan-btn" id="btnAddWardTransfer" type="button">＋ 追加</button>
    </div>

    <div class="plan-table-wrap">
      <table class="plan-table" id="wardTransfersTable"></table>
    </div>

    <div id="wardTransfersMsg" class="msg" role="status" aria-live="polite"></div>

    <div class="muted" style="margin-top:6px;">
      ※「移動先」＝この病棟 → 他病棟 ／ 「移動元」＝他病棟 → この病棟
    </div>
  `;

  planGrid.appendChild(wrap);
}


  function getWardLabelMap(userId) {
    const wards = getWardsForUser ? getWardsForUser(userId) : [];
    const map = new Map();
    wards.forEach(w => map.set(w.id, `${w.name}（${w.id}）`));
    return { wards, map };
  }

  function renderWardTransfersTable(items, userId, wardId) {
    const { wardTransfersTable } = dom();
    if (!wardTransfersTable) return;

    const { wards, map } = getWardLabelMap(userId);

    wardTransfersTable.innerHTML = `
      <thead>
        <tr>
          <th>ID <span style="font-weight:400;font-size:11px;color:#6b7280;">（クリックでシートへ）</span></th>
          <th>移動先/移動元</th>
          <th>相手病棟</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${(items || []).map((row, idx) => {
          const isTo = row.fromWardId === wardId;
          const mode = isTo ? 'to' : 'from';
          const otherWardId = isTo ? row.toWardId : row.fromWardId;
          const otherLabel = map.get(otherWardId) || otherWardId || '';
          const hasPatientId = String(row.id || '').trim() !== '';

          return `
            <tr>
              <td>
                <div style="display:flex; gap:6px; align-items:center;">
                  <input class="transfer-cell" value="${escapeHtml(row.id || '')}" data-i="${idx}" data-k="id">
                  ${hasPatientId ? `<button class="btn btn-outline btn-sm" type="button" data-admit-transfer="${idx}" title="病棟シートに入院登録">入院</button>` : ''}
                </div>
              </td>
              <td>
                <select class="transfer-cell" data-i="${idx}" data-k="mode">
                  <option value="to" ${mode === 'to' ? 'selected' : ''}>移動先</option>
                  <option value="from" ${mode === 'from' ? 'selected' : ''}>移動元</option>
                </select>
              </td>
              <td>
                <select class="transfer-cell" data-i="${idx}" data-k="ward">
                  <option value="">（選択）</option>
                  ${wards.map(w => `
                    <option value="${escapeHtml(w.id)}" ${(w.id === otherWardId) ? 'selected' : ''}>
                      ${escapeHtml(w.name)}（${escapeHtml(w.id)}）
                    </option>
                  `).join('')}
                </select>
                <div class="muted" style="margin-top:2px;">${escapeHtml(otherLabel)}</div>
              </td>
              <td><button class="btn btn-outline" data-del-transfer="${idx}">削除</button></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    `;
  }

  function refreshWardTransfersUi() {
    ensureWardTransfersUi();

    const { wardTransfersMsg } = dom();
    const { userId, wardId } = getActiveUserWard();
    if (!userId || !wardId) return;

    const list = getWardTransfersForWard ? getWardTransfersForWard(userId, wardId) : [];
    renderWardTransfersTable(list, userId, wardId);

    if (wardTransfersMsg) {
      wardTransfersMsg.textContent = '';
      wardTransfersMsg.classList.remove('error');
    }
  }

  function updateOneTransfer(userId, wardId, idx, patch) {
    const viewList = getWardTransfersForWard(userId, wardId);
    const row = viewList[idx];
    if (!row) return { ok: false, msg: '対象行が見つかりません。' };

const all = getWardTransfers(userId);

let pos = -1;

if (row._key) {
  pos = all.findIndex(x => x._key === row._key);
}

if (pos < 0) {
  const k = `${row.updatedAt}|${row.id}|${row.fromWardId}|${row.toWardId}`;
  pos = all.findIndex(x => `${x.updatedAt}|${x.id}|${x.fromWardId}|${x.toWardId}` === k);
}

if (pos < 0) return { ok: false, msg: '保存対象が見つかりません。再読み込みしてください。' };

const next = { ...all[pos], ...patch };


    if (patch.mode || patch.otherWardId || patch.id !== undefined) {
      const mode = patch.mode || (next.fromWardId === wardId ? 'to' : 'from');
      const otherWardId = patch.otherWardId ?? (mode === 'to' ? next.toWardId : next.fromWardId);

      if (mode === 'to') {
        next.fromWardId = wardId;
        next.toWardId = otherWardId || '';
      } else {
        next.fromWardId = otherWardId || '';
        next.toWardId = wardId;
      }
    }

    all[pos] = next;
    setWardTransfers(userId, all);
    return { ok: true };
  }

  function initWardTransfersInputs() {
    const { wardTransfersTable, wardTransfersMsg, btnAddWardTransfer } = dom();

    if (btnAddWardTransfer) {
      btnAddWardTransfer.addEventListener('click', () => {
        const { userId, wardId } = getActiveUserWard();
        if (!userId || !wardId) return;

        const viewList = getWardTransfersForWard(userId, wardId);
        if (viewList.length >= 20) {
          if (wardTransfersMsg) {
            wardTransfersMsg.textContent = '病棟移動は最大20件まで登録できます。';
            wardTransfersMsg.classList.add('error');
          }
          return;
        }

        const all = getWardTransfers(userId);
        all.push({
          id: '',
          fromWardId: wardId,
          toWardId: '',
          updatedAt: new Date().toISOString(),
        });
        setWardTransfers(userId, all);
        refreshWardTransfersUi();

        if (wardTransfersMsg) {
          wardTransfersMsg.textContent = '追加しました';
          wardTransfersMsg.classList.remove('error');
        }
      });
    }

    wardTransfersTable?.addEventListener('change', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLSelectElement)) return;
      if (!t.classList.contains('transfer-cell')) return;

      const idx = Number(t.getAttribute('data-i'));
      const key = t.getAttribute('data-k');
      if (!Number.isFinite(idx) || idx < 0 || !key) return;

      const { userId, wardId } = getActiveUserWard();
      if (!userId || !wardId) return;

      let patch = {};
      if (key === 'mode') patch = { mode: t.value };
      if (key === 'ward') patch = { otherWardId: t.value };

      const res = updateOneTransfer(userId, wardId, idx, patch);
      if (!res.ok) {
        if (wardTransfersMsg) {
          wardTransfersMsg.textContent = res.msg || '保存に失敗しました。';
          wardTransfersMsg.classList.add('error');
        }
        return;
      }

      refreshWardTransfersUi();
      if (wardTransfersMsg) {
        wardTransfersMsg.textContent = '保存しました';
        wardTransfersMsg.classList.remove('error');
      }
    });

    wardTransfersTable?.addEventListener('input', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (!t.classList.contains('transfer-cell')) return;

      const idx = Number(t.getAttribute('data-i'));
      const key = t.getAttribute('data-k');
      if (!Number.isFinite(idx) || idx < 0 || !key) return;

      if (key !== 'id') return;

      const { userId, wardId } = getActiveUserWard();
      if (!userId || !wardId) return;

      const res = updateOneTransfer(userId, wardId, idx, { id: (t.value || '').trim() });
      if (!res.ok) return;

      if (wardTransfersMsg) wardTransfersMsg.textContent = '保存しました';
    });

    wardTransfersTable?.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const del = t.getAttribute('data-del-transfer');
      if (del === null) return;

      const idx = Number(del);
      if (!Number.isFinite(idx) || idx < 0) return;

      const { userId, wardId } = getActiveUserWard();
      if (!userId || !wardId) return;

      const viewList = getWardTransfersForWard(userId, wardId);
      const row = viewList[idx];
      if (!row) return;

const all = getWardTransfers(userId);

let next = all;

if (row._key) {
  next = all.filter(x => x._key !== row._key);
} else {
  const k = `${row.updatedAt}|${row.id}|${row.fromWardId}|${row.toWardId}`;
  next = all.filter(x => `${x.updatedAt}|${x.id}|${x.fromWardId}|${x.toWardId}` !== k);
}

setWardTransfers(userId, next);
refreshWardTransfersUi();


      if (wardTransfersMsg) {
        wardTransfersMsg.textContent = '削除しました';
        wardTransfersMsg.classList.remove('error');
      }
    });

    // ★ 病棟移動から病棟シートへ入院ボタン
    wardTransfersTable?.addEventListener('click', async (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;

      const admitIdx = t.getAttribute('data-admit-transfer');
      if (admitIdx === null) return;

      const idx = Number(admitIdx);
      if (Number.isNaN(idx)) return;

      const { userId, wardId } = getActiveUserWard();
      if (!userId || !wardId) return;

      const viewList = getWardTransfersForWard(userId, wardId);
      const transfer = viewList[idx];
      if (!transfer || !transfer.id) {
        if (wardTransfersMsg) {
          wardTransfersMsg.textContent = 'IDが入力されていません。';
          wardTransfersMsg.classList.add('error');
        }
        return;
      }

      // 空きベッドを探す（患者IDが空の行）
      const st = state();
      const rows = st.sheetAllRows || [];

      let emptyIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        if (!String(rows[i]?.[COL_PATIENT_ID] ?? '').trim()) {
          emptyIdx = i;
          break;
        }
      }

      if (emptyIdx < 0) {
        if (wardTransfersMsg) {
          wardTransfersMsg.textContent = '空きベッドがありません。ベッド数を増やしてください。';
          wardTransfersMsg.classList.add('error');
        }
        return;
      }

      // 病棟シートに患者を追加
      rows[emptyIdx][COL_PATIENT_ID] = transfer.id;

      // 入院日を本日に設定
      const todaySlash = normalizeDateSlash(todayJSTIsoDate());
      rows[emptyIdx][COL_ADMIT_DATE] = todaySlash;
      const days = calcAdmitDays(todaySlash);
      rows[emptyIdx][COL_ADMIT_DAYS] = days;

      // 保存
      await setSheetRows(userId, wardId, rows);

      // 病棟移動リストから削除
      const all = getWardTransfers(userId);
      let next = all;
      if (transfer._key) {
        next = all.filter(x => x._key !== transfer._key);
      } else {
        const k = `${transfer.updatedAt}|${transfer.id}|${transfer.fromWardId}|${transfer.toWardId}`;
        next = all.filter(x => `${x.updatedAt}|${x.id}|${x.fromWardId}|${x.toWardId}` !== k);
      }
      setWardTransfers(userId, next);

      // UI更新
      refreshWardTransfersUi();
      window.BMWardSheetTable?.applySearchAndSort?.();
      updateKpiUI();

      if (wardTransfersMsg) {
        wardTransfersMsg.textContent = `「${transfer.id}」を病棟シートに移動しました。`;
        wardTransfersMsg.classList.remove('error');
      }
    });
  }

  function refreshPlanInputsUi() {
    const { plannedAdmissionsMsg } = dom();
    const { userId, wardId } = getActiveUserWard();
    if (!userId || !wardId) return;

    const planned = getPlannedAdmissions(userId, wardId);
    renderPlannedAdmissionsTable(planned);

    refreshWardTransfersUi();

    if (plannedAdmissionsMsg) plannedAdmissionsMsg.textContent = '';
  }

  // 予定入院：DOM上の入力値を優先して取得（再描画やボタンクリックで入力途中の値が消えるのを防ぐ）
  // NOTE: 画面上の行インデックス（data-i）と整合させるため、空行も含めて「密な配列」で返す。
  function getPlannedAdmissionsFromDom(userId, wardId) {
    const { plannedAdmissionsTable } = dom();
    if (!plannedAdmissionsTable) return getPlannedAdmissions(userId, wardId);

    const rows = [];
    let maxIdx = -1;

    plannedAdmissionsTable.querySelectorAll('input.plan-cell').forEach((inp) => {
      if (!(inp instanceof HTMLInputElement)) return;
      const idx = Number(inp.getAttribute('data-i'));
      const key = inp.getAttribute('data-k');
      if (!Number.isFinite(idx) || idx < 0 || !key) return;

      maxIdx = Math.max(maxIdx, idx);

      if (!rows[idx]) rows[idx] = { id: '', disease: '', date: '', days: '' };
      rows[idx][key] = (inp.value ?? '').trim();
    });

    // data-i の最大まで穴埋め（map時に row が undefined にならないように）
    for (let i = 0; i <= maxIdx; i++) {
      if (!rows[i]) rows[i] = { id: '', disease: '', date: '', days: '' };
    }

    return rows;
  }

  function compactPlannedAdmissions(list) {
    const src = Array.isArray(list) ? list : [];
    return src.filter((x) => {
      const id = String(x?.id ?? '').trim();
      const disease = String(x?.disease ?? '').trim();
      const date = String(x?.date ?? '').trim();
      const days = String(x?.days ?? '').trim();
      return id || disease || date || days;
    });
  }

  function initPlanInputs() {
    const {
      plannedAdmissionsTable,
      plannedAdmissionsMsg,
      btnAddPlannedAdmission,
    } = dom();

    if (btnAddPlannedAdmission) {
      btnAddPlannedAdmission.addEventListener('click', () => {
        const { userId, wardId } = getActiveUserWard();
        if (!userId || !wardId) return;

        const list = getPlannedAdmissionsFromDom(userId, wardId);

        if (list.length >= 20) {
          if (plannedAdmissionsMsg) {
            plannedAdmissionsMsg.textContent = '予定入院患者は最大20人まで登録できます。';
            plannedAdmissionsMsg.classList.add('error');
          }
          return;
        }

        // 追加前に、入力途中も含めて現在値を確実に保存（空行は保存しない）
        setPlannedAdmissions(userId, wardId, compactPlannedAdmissions(list));

        list.push({ id: '', disease: '', date: '', days: '' });
        renderPlannedAdmissionsTable(list);

        if (plannedAdmissionsMsg) {
          plannedAdmissionsMsg.textContent = '追加しました';
          plannedAdmissionsMsg.classList.remove('error');
        }
      });
    }


    // ★ 予定入院患者IDクリック → 病棟シートに移動
plannedAdmissionsTable?.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  const admit = t.getAttribute('data-admit');
  if (admit === null) return;

  const idx = Number(admit);
  if (Number.isNaN(idx)) return;

      const { userId, wardId } = getActiveUserWard();
      if (!userId || !wardId) return;

      const list = getPlannedAdmissionsFromDom(userId, wardId);
      const planned = list[idx];
      if (!planned || !planned.id) {
        if (plannedAdmissionsMsg) {
          plannedAdmissionsMsg.textContent = 'IDが入力されていません。';
          plannedAdmissionsMsg.classList.add('error');
        }
        return;
      }

      // 空きベッドを探す（患者IDが空の行）
      const st = state();
      const rows = st.sheetAllRows || [];

      let emptyIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        if (!String(rows[i]?.[COL_PATIENT_ID] ?? '').trim()) {
          emptyIdx = i;
          break;
        }
      }

      if (emptyIdx < 0) {
        if (plannedAdmissionsMsg) {
          plannedAdmissionsMsg.textContent = '空きベッドがありません。ベッド数を増やしてください。';
          plannedAdmissionsMsg.classList.add('error');
        }
        return;
      }

      // 病棟シートに患者を追加
      rows[emptyIdx][COL_PATIENT_ID] = planned.id;
      rows[emptyIdx][COL_DISEASE] = planned.disease || '';

      // 入院予定日を入院日として設定（あれば）
      if (planned.date) {
        rows[emptyIdx][COL_ADMIT_DATE] = normalizeDateSlash(planned.date);
        const days = calcAdmitDays(planned.date);
        rows[emptyIdx][COL_ADMIT_DAYS] = days;
      }

      // 保存
      await setSheetRows(userId, wardId, rows);

      // 予定入院リストから削除
      list.splice(idx, 1);
      setPlannedAdmissions(userId, wardId, compactPlannedAdmissions(list));

      // UI更新
      renderPlannedAdmissionsTable(list);
      window.BMWardSheetTable?.applySearchAndSort?.();
      updateKpiUI();

      if (plannedAdmissionsMsg) {
        plannedAdmissionsMsg.textContent = `「${planned.id}」を病棟シートに移動しました。`;
        plannedAdmissionsMsg.classList.remove('error');
      }
    });

    plannedAdmissionsTable?.addEventListener('input', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (!t.classList.contains('plan-cell')) return;
      // plan-id-clickable は readonly なので input イベントは発火しないが念のため除外
      if (t.classList.contains('plan-id-clickable')) return;

      const idx = Number(t.getAttribute('data-i'));
      const key = t.getAttribute('data-k');
      if (!Number.isFinite(idx) || idx < 0 || !key) return;

      const { userId, wardId } = getActiveUserWard();
      if (!userId || !wardId) return;

      const list = getPlannedAdmissionsFromDom(userId, wardId);
      if (!list[idx]) list[idx] = { id: '', disease: '', date: '', days: '' };

      const val = t.value;
      list[idx] = { ...list[idx], [key]: val };

      setPlannedAdmissions(userId, wardId, compactPlannedAdmissions(list));
      if (plannedAdmissionsMsg) plannedAdmissionsMsg.textContent = '保存しました';
    });

    // date入力はブラウザによって input が発火しないことがあるので change も拾う
    plannedAdmissionsTable?.addEventListener('change', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (!t.classList.contains('plan-cell')) return;
      if (t.classList.contains('plan-id-clickable')) return;

      const idx = Number(t.getAttribute('data-i'));
      const key = t.getAttribute('data-k');
      if (!Number.isFinite(idx) || idx < 0 || !key) return;

      const { userId, wardId } = getActiveUserWard();
      if (!userId || !wardId) return;

      const list = getPlannedAdmissionsFromDom(userId, wardId);
      if (!list[idx]) list[idx] = { id: '', disease: '', date: '', days: '' };

      list[idx] = { ...list[idx], [key]: t.value };
      setPlannedAdmissions(userId, wardId, compactPlannedAdmissions(list));

      if (plannedAdmissionsMsg) plannedAdmissionsMsg.textContent = '保存しました';
    });

    plannedAdmissionsTable?.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const del = t.getAttribute('data-del');
      if (del === null) return;

      const idx = Number(del);
      if (!Number.isFinite(idx) || idx < 0) return;

      const { userId, wardId } = getActiveUserWard();
      if (!userId || !wardId) return;

      const list = getPlannedAdmissionsFromDom(userId, wardId);
      list.splice(idx, 1);
      setPlannedAdmissions(userId, wardId, compactPlannedAdmissions(list));
      renderPlannedAdmissionsTable(list);
      if (plannedAdmissionsMsg) plannedAdmissionsMsg.textContent = '削除しました';
    });

    // 病棟移動（病棟間で共有）
    ensureWardTransfersUi();
    initWardTransfersInputs();
  }

  function refreshAdmitDaysAllRows() {
    const st = state();

    let changed = false;
    const rows = Array.isArray(st.sheetAllRows) ? st.sheetAllRows : [];

    rows.forEach((row) => {
      if (!Array.isArray(row)) return;
      const admit = String(row[COL_ADMIT_DATE] ?? '').trim();
      if (!admit) return;

      const nextDays = calcAdmitDays(admit);
      const prevDays = String(row[COL_ADMIT_DAYS] ?? '').trim();
      if (nextDays && nextDays !== prevDays) {
        row[COL_ADMIT_DAYS] = nextDays;
        changed = true;
      }
    });

    return changed;
  }

  async function openWardSheet(ward) {
    const session = loadSession();
    if (!session?.userId) return;

    const st = state();
    st.currentWard = ward;
    setSheetMsg('読み込み中…');

    try {
      await ensureDb();

      st.sheetAllRows = await getSheetRows(session.userId, ward.id);

      const losChanged = refreshAdmitDaysAllRows();
      if (losChanged) {
        await setSheetRows(session.userId, ward.id, st.sheetAllRows);
      }

      recordNursingKpiForToday && recordNursingKpiForToday(session.userId, ward.id, st.sheetAllRows);
      setSheetMsg('');

      const {
        wardView,
        sheetView,
        sheetWardName,
        inputBedCount,
        sheetSearch,
      } = dom();

      if (wardView) wardView.classList.add('hidden');
      if (sheetView) sheetView.classList.remove('hidden');

      if (sheetWardName) sheetWardName.textContent = `${ward.name}（${ward.id}）`;

      if (inputBedCount) {
        const bedCount = st.sheetAllRows.length;
        inputBedCount.value = String(bedCount);
      }

      if (sheetSearch) sheetSearch.value = '';

      window.BMWardSheetTable?.applySearchAndSort?.();
      window.BMWardHScroll?.showFixedHScroll?.();

      refreshPlanInputsUi();
      updateKpiUI();
      updateHospitalKpiUI && updateHospitalKpiUI(session.userId);

    } catch (e) {
      console.error(e);
      setSheetMsg('読み込みに失敗しました。', true);
    }
  }

  async function backToWards() {
    const session = loadSession();
    if (!session?.userId) return;

    const st = state();

    try {
      const ward = st.currentWard;
      const userId = session.userId;

      if (ward?.id) {
        await setSheetRows(userId, ward.id, st.sheetAllRows);
      }

      updateHospitalKpiUI && updateHospitalKpiUI(userId);
      setSheetMsg('');

    } catch (e) {
      console.error(e);
      setSheetMsg('保存に失敗しました。', true);
    }

    const { wardView, sheetView } = dom();
    if (sheetView) sheetView.classList.add('hidden');
    if (wardView) wardView.classList.remove('hidden');

    window.BMWardHScroll?.hideFixedHScroll?.();
    st.currentWard = null;

    try {
      window.BMWardWardList?.renderWardButtons?.(session.userId);
      setWardMsg('');
    } catch (e) {
      console.warn(e);
      setWardMsg('病棟一覧の描画に失敗しました。', true);
    }
  }

  async function applyBedCount(n) {
    const session = loadSession();
    if (!session?.userId) return;

    const st = state();
    const ward = st.currentWard;
    if (!ward?.id) return;

    const nextN = Math.max(1, Math.min(200, Number(n) || 0));
    const cur = Array.isArray(st.sheetAllRows) ? st.sheetAllRows.length : 0;

    if (cur === nextN) return;

    if (cur < nextN) {
      const more = makeEmptyRows(nextN - cur, SHEET_COLUMNS.length);
      st.sheetAllRows = [...st.sheetAllRows, ...more];
    } else {
      const ok = window.confirm(`ベッド数を ${cur} → ${nextN} に減らします。\n末尾の行データは削除されます。よろしいですか？`);
      if (!ok) return;
      st.sheetAllRows = st.sheetAllRows.slice(0, nextN);
    }

    await setSheetRows(session.userId, ward.id, st.sheetAllRows);

    window.BMWardSheetTable?.applySearchAndSort?.();
    updateKpiUI();
    setSheetMsg('保存しました');
  }

  async function clearSheet() {
    const ok = window.confirm('シートを完全にクリアします。よろしいですか？');
    if (!ok) return;

    const session = loadSession();
    if (!session?.userId) return;

    const st = state();
    const ward = st.currentWard;
    if (!ward?.id) return;

    st.sheetAllRows = makeEmptyRows(st.sheetAllRows.length || 1, SHEET_COLUMNS.length);
    await setSheetRows(session.userId, ward.id, st.sheetAllRows);

    window.BMWardSheetTable?.applySearchAndSort?.();
    updateKpiUI();
    setSheetMsg('クリアしました');
  }

  function render(userId) {
    window.BMWardWardList?.renderWardButtons?.(userId);
  }

  function reset() {
    const st = state();
    st.currentWard = null;
    st.sheetAllRows = [];
    st.sheetViewRows = [];
    st.sortState = { col: -1, dir: 0 };
  }

// （sendToWardTransfer関数を追加し、エクスポートに含める）
  async function sendToWardTransfer(patientId, rowIdx) {
    const { wardTransfersMsg } = dom();
    const { userId, wardId } = getActiveUserWard();
    if (!userId || !wardId) {
      setSheetMsg('ユーザーまたは病棟が特定できません。', true);
      return;
    }

    // 病棟移動UIを確保
    ensureWardTransfersUi();

    // 現在の病棟移動リストを取得
    const all = getWardTransfers(userId);
    const viewList = getWardTransfersForWard(userId, wardId);

    if (viewList.length >= 20) {
      if (wardTransfersMsg) {
        wardTransfersMsg.textContent = '病棟移動は最大20件まで登録できます。';
        wardTransfersMsg.classList.add('error');
      }
      return;
    }

    // 新しい移動レコードを追加（この病棟から出る＝fromWardId=wardId）
    all.push({
      id: patientId,
      fromWardId: wardId,
      toWardId: '',
      updatedAt: new Date().toISOString(),
    });
    setWardTransfers(userId, all);

    // ★ 患者シートから該当行をクリア
    const st = state();
    if (Array.isArray(st.sheetAllRows) && st.sheetAllRows[rowIdx]) {
      // 行の全セルをクリア（ベッドNo以外）
      const row = st.sheetAllRows[rowIdx];
      for (let c = 0; c < row.length; c++) {
        if (c === 0) continue; // COL_BED_NO（0）は保持
        row[c] = '';
      }

      // 保存
      await setSheetRows(userId, wardId, st.sheetAllRows);

      // UI更新
      window.BMWardSheetTable?.applySearchAndSort?.();
      updateKpiUI();
    }



    // UI更新
    refreshWardTransfersUi();

    if (wardTransfersMsg) {
      wardTransfersMsg.textContent = `「${patientId}」を病棟移動に追加しました。`;
      wardTransfersMsg.classList.remove('error');
    }

    setSheetMsg(`「${patientId}」を病棟移動に送りました。`);
  }

  window.BMWardSheetUI = {
    render,
    reset,
    openWardSheet,
    backToWards,
    applyBedCount,
    clearSheet,
    initPlanInputs,
    refreshPlanInputsUi,
    updateKpiUI,
    sendToWardTransfer,
  };

})();