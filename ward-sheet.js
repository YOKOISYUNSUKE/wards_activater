'use strict';

/**
 * ward-sheet.js
 * 役割：
 * - 共通State/Msg/HScrollのハブ
 * - 画面全体の配線（ボタン・検索など）
 * - 互換API（window.BMWard）
 *
 * 実処理は以下へ分割：
 * - ward-ui-wardlist.js（病棟選択）
 * - ward-ui-sheet.js（開く/戻る/状態/予定入院・ER）
 * - ward-sheet-table.js（検索/ソート/描画/イベント/保存）
 */

(function () {

  const {
    loadSession,
    setSheetRows,
  } = window.WardCore;

  const {
    runDischargeOptimize,
  } = window.WardFeatures || {};

  // ===== 共通State =====
  function ensureState() {
    window.BMWardState = window.BMWardState || {
      currentWard: null,
      sheetAllRows: [],
      sheetViewRows: [],
      sortState: { col: -1, dir: 0 },
    };
    return window.BMWardState;
  }

  // ===== メッセージ表示（病棟画面/シート画面） =====
  function setMsg(el, text, isError) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  function setWardMsg(text, isError) {
    setMsg(document.getElementById('wardMsg'), text, isError);
  }

  function setSheetMsg(text, isError) {
    setMsg(document.getElementById('sheetMsg'), text, isError);
  }

  window.BMWardMsg = {
    setWardMsg,
    setSheetMsg,
  };

  // ===== 固定 横スクロールバー（画面下 常時表示） =====
  let fixedHScroll = null;
  let fixedHScrollInner = null;
  let fixedHScrollReady = false;
  let syncingHScroll = false;
  let wrapScrollBound = false;

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

    const w = Math.max(table.scrollWidth, wrap.clientWidth);
    fixedHScrollInner.style.width = `${w}px`;
    fixedHScroll.scrollLeft = wrap.scrollLeft;
  }

  function bindWrapScrollOnce() {
    if (wrapScrollBound) return;
    const wrap = document.querySelector('#sheetView .table-wrap');
    if (!wrap) return;

    wrap.addEventListener('scroll', () => {
      if (!fixedHScrollReady) return;
      if (syncingHScroll) return;
      syncingHScroll = true;
      fixedHScroll.scrollLeft = wrap.scrollLeft;
      syncingHScroll = false;
    });

    wrapScrollBound = true;
  }

  function showFixedHScroll() {
    ensureFixedHScroll();

    fixedHScroll.classList.remove('hidden');
    document.body.classList.add('has-hscroll');

    bindWrapScrollOnce();
    updateFixedHScrollMetrics();

    window.addEventListener('resize', updateFixedHScrollMetrics);
  }

  function hideFixedHScroll() {
    if (!fixedHScrollReady) return;
    fixedHScroll.classList.add('hidden');
    document.body.classList.remove('has-hscroll');
    window.removeEventListener('resize', updateFixedHScrollMetrics);
  }

  window.BMWardHScroll = {
    showFixedHScroll,
    hideFixedHScroll,
    updateFixedHScrollMetrics,
  };

  // ===== 画面配線 =====
  function wireOnce() {
    const btnAddWard = document.getElementById('btnAddWard');
    const btnBackToWards = document.getElementById('btnBackToWards');
    const inputBedCount = document.getElementById('inputBedCount');
    const btnClearSheet = document.getElementById('btnClearSheet');
    const btnDischargeOptimize = document.getElementById('btnDischargeOptimize');
    const sheetSearch = document.getElementById('sheetSearch');

    if (btnAddWard) {
      btnAddWard.addEventListener('click', () => {
        const session = loadSession();
        if (!session?.userId) return;
        window.BMWardWardList?.addWardForUser?.(session.userId);
      });
    }

    if (btnBackToWards) {
      btnBackToWards.addEventListener('click', () => {
        window.BMWardSheetUI?.backToWards?.();
      });
    }

    if (inputBedCount) {
      inputBedCount.addEventListener('change', () => {
        window.BMWardSheetUI?.applyBedCount?.(inputBedCount.value);
      });
    }

    if (btnClearSheet) {
      btnClearSheet.addEventListener('click', () => {
        window.BMWardSheetUI?.clearSheet?.();
      });
    }

    if (sheetSearch) {
      sheetSearch.addEventListener('input', () => {
        window.BMWardSheetTable?.applySearchAndSort?.();
      });
    }

    if (btnDischargeOptimize) {
      btnDischargeOptimize.addEventListener('click', async () => {
        const session = loadSession();
        if (!session?.userId) return;

        const st = ensureState();
        const wardId = st.currentWard?.id;
        if (!wardId) {
          setSheetMsg('病棟を開いてから実行してください。', true);
          return;
        }

        try {
          setSheetMsg('退院最適化を実行中…');
          const nextRows = await runDischargeOptimize?.(st.sheetAllRows);
          if (Array.isArray(nextRows)) {
            st.sheetAllRows = nextRows;
            await setSheetRows(session.userId, wardId, st.sheetAllRows);
            window.BMWardSheetTable?.applySearchAndSort?.();
            window.BMWardSheetUI?.updateKpiUI?.();
          }
          setSheetMsg('完了しました');
        } catch (e) {
          console.error(e);
          setSheetMsg('退院最適化に失敗しました。', true);
        }
      });
    }

    window.BMWardSheetUI?.initPlanInputs?.();
  }

  // ===== 互換API（app.js 等から呼ばれる前提） =====
  // ===== 互換API（app.js 等から呼ばれる前提） =====
  function render(loginIdForUi) {
    const session = loadSession();
    if (!session?.userId) return;

    // 表示用：ログイン中メール等を病棟選択画面へ反映
    try {
      const el = document.getElementById('currentUser');
      const text = String(loginIdForUi || session?.loginId || '').trim();
      if (el) el.textContent = text;
    } catch { }

    ensureState();
    window.BMWardSheetUI?.render?.(session.userId);
    setWardMsg('');
    setSheetMsg('');

    wireOnce();

    // 病院KPI（病棟選択画面）
    try {
      window.WardKpi?.updateHospitalKpiUI?.(session.userId);
    } catch (e) {
      console.warn(e);
      window.WardKpi?.setHospitalKpiUiUnknown?.();
    }
  }


  function reset() {
    const st = ensureState();
    st.currentWard = null;
    st.sheetAllRows = [];
    st.sheetViewRows = [];
    st.sortState = { col: -1, dir: 0 };

    window.BMWardSheetUI?.reset?.();

    hideFixedHScroll();
    setWardMsg('');
    setSheetMsg('');
  }

  window.BMWard = {
    render,
    reset,
  };

})();
