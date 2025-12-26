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
    normalizeDateSlash,
    makeEmptyRows,
    getSheetRows,
    setSheetRows,
    ensureDb,
    SHEET_COLUMNS,
    COL_ADMIT_DATE,
    COL_ADMIT_DAYS,
  } = window.WardCore;

  const {
    updateWardKpiUI,
    recordNursingKpiForToday,
    updateHospitalKpiUI,
    setHospitalKpiUiUnknown,
  } = window.WardKpi || {};

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
      selectErEstimate: document.getElementById('selectErEstimate'),
      erEstimateMsg: document.getElementById('erEstimateMsg'),
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
          <th>ID</th>
          <th>病名</th>
          <th>入院予定日</th>
          <th>予定期間（日）</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${items.map((row, idx) => `
          <tr>
            <td><input class="plan-cell" value="${escapeHtml(row.id || '')}" data-i="${idx}" data-k="id"></td>
            <td><input class="plan-cell" value="${escapeHtml(row.disease || '')}" data-i="${idx}" data-k="disease"></td>
            <td><input type="date" class="plan-cell" value="${escapeHtml(row.date || '')}" data-i="${idx}" data-k="date"></td>
            <td><input type="number" class="plan-cell" min="1" value="${escapeHtml(row.days || '')}" data-i="${idx}" data-k="days"></td>
            <td><button class="btn btn-outline" data-del="${idx}">削除</button></td>
          </tr>
        `).join('')}
      </tbody>
    `;
  }

  function refreshPlanInputsUi() {
    const { plannedAdmissionsMsg, erEstimateMsg, selectErEstimate } = dom();
    const { userId, wardId } = getActiveUserWard();
    if (!userId || !wardId) return;

    const planned = getPlannedAdmissions(userId, wardId);
    renderPlannedAdmissionsTable(planned);

    const iso = todayJSTIsoDate();
    const er = getErEstimate(userId, wardId, iso);
    if (selectErEstimate) selectErEstimate.value = er || '';

    if (plannedAdmissionsMsg) plannedAdmissionsMsg.textContent = '';
    if (erEstimateMsg) erEstimateMsg.textContent = '';
  }

  function initPlanInputs() {
    const {
      plannedAdmissionsTable,
      plannedAdmissionsMsg,
      btnAddPlannedAdmission,
      selectErEstimate,
      erEstimateMsg,
    } = dom();

    if (btnAddPlannedAdmission) {
      btnAddPlannedAdmission.addEventListener('click', () => {
        const { userId, wardId } = getActiveUserWard();
        if (!userId || !wardId) return;

        const list = getPlannedAdmissions(userId, wardId);

        if (list.length >= 20) {
          if (plannedAdmissionsMsg) {
            plannedAdmissionsMsg.textContent = '予定入院患者は最大20人まで登録できます。';
            plannedAdmissionsMsg.classList.add('error');
          }
          return;
        }

        list.push({ id: '', disease: '', date: '', days: '' });
        setPlannedAdmissions(userId, wardId, list);
        renderPlannedAdmissionsTable(list);

        if (plannedAdmissionsMsg) {
          plannedAdmissionsMsg.textContent = '追加しました';
          plannedAdmissionsMsg.classList.remove('error');
        }
      });
    }

    if (selectErEstimate) {
      selectErEstimate.addEventListener('change', () => {
        const { userId, wardId } = getActiveUserWard();
        if (!userId || !wardId) return;

        const iso = todayJSTIsoDate();
        const val = (selectErEstimate.value || '').trim();
        setErEstimate(userId, wardId, iso, val);

        if (erEstimateMsg) {
          erEstimateMsg.textContent = '保存しました';
          erEstimateMsg.classList.remove('error');
        }
      });
    }

    plannedAdmissionsTable?.addEventListener('input', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (!t.classList.contains('plan-cell')) return;

      const idx = Number(t.getAttribute('data-i'));
      const key = t.getAttribute('data-k');
      if (!Number.isFinite(idx) || idx < 0 || !key) return;

      const { userId, wardId } = getActiveUserWard();
      if (!userId || !wardId) return;

      const list = getPlannedAdmissions(userId, wardId);
      if (!list[idx]) return;

      const val = t.type === 'number' ? t.value : '';
      list[idx] = { ...list[idx], [key]: val };

      setPlannedAdmissions(userId, wardId, list);
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

      const list = getPlannedAdmissions(userId, wardId);
      list.splice(idx, 1);
      setPlannedAdmissions(userId, wardId, list);
      renderPlannedAdmissionsTable(list);
      if (plannedAdmissionsMsg) plannedAdmissionsMsg.textContent = '削除しました';
    });
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
  };

})();
