'use strict';

/**
 * ward-dnd.js
 * 患者IDセルのポインターベース ドラッグ＆ドロップ入れ替え（ベッドNoは固定）
 *
 * 使い方：
 *   WardDnD.bindPatientSwap(sheetTable, {
 *     getRows: () => sheetAllRows,
 *     getWard: () => currentWard,
 *     setMsg: (text, isError) => setSheetMsg(text, isError),
 *     applySearchAndSort,
 *     updateKpiUI,
 *   });
 */

(function () {

  const {
    SHEET_COLUMNS,
    COL_BED_NO,
    loadSession,
    setSheetRows,
  } = window.WardCore;

  const PATIENT_SWAP_DRAG_ARM_MS = 200;       // ドラッグ開始までの長押し時間
  const PATIENT_SWAP_DRAG_THRESHOLD_PX = 6;   // ドラッグ判定の移動閾値

  // 患者ID：ポインターベースのドラッグ状態
  const patientSwapDragState = {
    active: false,
    armed: false,
    dragging: false,
    pointerId: null,
    srcRowIdx: null,
    startX: 0,
    startY: 0,
    srcEl: null,
    overEl: null,
    ghostEl: null,
    armTimer: null,
    prevBodyUserSelect: '',
  };

  function resetPatientSwapDragState() {
    if (patientSwapDragState.armTimer) {
      clearTimeout(patientSwapDragState.armTimer);
    }
    patientSwapDragState.active = false;
    patientSwapDragState.armed = false;
    patientSwapDragState.dragging = false;
    patientSwapDragState.pointerId = null;
    patientSwapDragState.srcRowIdx = null;
    patientSwapDragState.startX = 0;
    patientSwapDragState.startY = 0;
    patientSwapDragState.srcEl = null;
    patientSwapDragState.overEl = null;
    patientSwapDragState.ghostEl = null;
    patientSwapDragState.armTimer = null;
  }

  function stopPatientSwapDragVisuals() {
    if (patientSwapDragState.ghostEl) {
      patientSwapDragState.ghostEl.remove();
      patientSwapDragState.ghostEl = null;
    }
    if (patientSwapDragState.srcEl) {
      patientSwapDragState.srcEl.classList.remove('dragging');
    }
    if (patientSwapDragState.overEl) {
      patientSwapDragState.overEl.classList.remove('drag-over');
      patientSwapDragState.overEl = null;
    }
    if (patientSwapDragState.prevBodyUserSelect !== undefined) {
      document.body.style.userSelect = patientSwapDragState.prevBodyUserSelect;
      patientSwapDragState.prevBodyUserSelect = '';
    }
  }

  function updatePatientSwapGhostPos(ghost, clientX, clientY) {
    if (!ghost) return;
    ghost.style.left = `${clientX + 12}px`;
    ghost.style.top = `${clientY + 12}px`;
  }

  function startPatientSwapDrag(srcEl, pointerId, clientX, clientY) {
    patientSwapDragState.dragging = true;
    patientSwapDragState.prevBodyUserSelect = document.body.style.userSelect || '';
    document.body.style.userSelect = 'none';

    srcEl.classList.add('dragging');

    const ghost = document.createElement('div');
    ghost.className = 'patient-swap-ghost';
    ghost.textContent = srcEl.textContent || '（空）';
    ghost.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 9999;
      background: #3b82f6;
      color: #fff;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      opacity: 0.95;
      white-space: nowrap;
    `;
    document.body.appendChild(ghost);
    patientSwapDragState.ghostEl = ghost;

    updatePatientSwapGhostPos(ghost, clientX, clientY);

    // ドラッグ開始後にポインターキャプチャ
    try {
      srcEl.setPointerCapture(pointerId);
    } catch (e) {
      // 一部環境では非対応
    }
  }

  function patientIdCellFromPoint(clientX, clientY) {
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      if (el.classList && el.classList.contains('patient-id-cell')) {
        return el;
      }
    }
    return null;
  }

  function setPatientSwapDragOverEl(el) {
    if (patientSwapDragState.overEl && patientSwapDragState.overEl !== el) {
      patientSwapDragState.overEl.classList.remove('drag-over');
    }
    patientSwapDragState.overEl = el;
    if (el) {
      el.classList.add('drag-over');
    }
  }

  function nursingDetailStorageKey(userId, wardId, rowIdx) {
    return `bm_nursing_v2|${userId}|${wardId}|${rowIdx}`;
  }

  function swapLocalStorageKeys(keyA, keyB) {
    const a = localStorage.getItem(keyA);
    const b = localStorage.getItem(keyB);
    if (a === null && b === null) return;

    if (a === null) localStorage.removeItem(keyB);
    else localStorage.setItem(keyB, a);

    if (b === null) localStorage.removeItem(keyA);
    else localStorage.setItem(keyA, b);
  }

  async function swapPatientsKeepBedNo(srcRowIdx, dstRowIdx, ctx) {
    const rows = ctx.getRows?.();
    const ward = ctx.getWard?.();

    if (!Array.isArray(rows)) return;
    if (!Number.isFinite(srcRowIdx) || !Number.isFinite(dstRowIdx)) return;
    if (srcRowIdx < 0 || dstRowIdx < 0) return;
    if (srcRowIdx === dstRowIdx) return;
    if (!rows[srcRowIdx] || !rows[dstRowIdx]) return;

    // ベッドNo（COL_BED_NO）は固定：患者に紐づく列だけをスワップ
    for (let c = 0; c < SHEET_COLUMNS.length; c++) {
      if (c === COL_BED_NO) continue;
      const tmp = rows[srcRowIdx][c];
      rows[srcRowIdx][c] = rows[dstRowIdx][c];
      rows[dstRowIdx][c] = tmp;
    }

    // 行インデックスに紐づく詳細（看護必要度：bm_nursing_v2）もキーごと入れ替える
    const session = loadSession();
    const userId = session?.userId;
    const wardId = ward?.id;
    if (userId && wardId) {
      const keyA = nursingDetailStorageKey(userId, wardId, srcRowIdx);
      const keyB = nursingDetailStorageKey(userId, wardId, dstRowIdx);
      swapLocalStorageKeys(keyA, keyB);
    }

    if (userId && wardId) {
      await setSheetRows(userId, wardId, rows);
    }

    ctx.setMsg?.('患者を入れ替えました（ベッドNoは固定）。');
    ctx.applySearchAndSort?.();
    ctx.updateKpiUI?.();
  }

  async function commitPatientSwapIfNeeded(dstEl, ctx) {
    if (!dstEl) return;
    const srcRowIdx = patientSwapDragState.srcRowIdx;
    const dstRowIdx = Number(dstEl.getAttribute('data-idx'));
    if (!Number.isFinite(srcRowIdx) || !Number.isFinite(dstRowIdx)) return;
    if (srcRowIdx === dstRowIdx) return;
    await swapPatientsKeepBedNo(srcRowIdx, dstRowIdx, ctx);
  }

  function bindPatientSwap(sheetTable, ctx) {
    if (!sheetTable) return;

    sheetTable.querySelectorAll('.patient-id-cell').forEach(el => {
      if (el.dataset.patientSwapBound === '1') return;
      el.dataset.patientSwapBound = '1';

      // ネイティブDnDを抑止
      el.addEventListener('dragstart', (e) => e.preventDefault());

      el.addEventListener('pointerdown', (e) => {
        if (!('pointerId' in e)) return;
        if (e.button !== 0) return;

        const rowIdx = Number(el.getAttribute('data-idx'));
        if (!Number.isFinite(rowIdx) || rowIdx < 0) return;
        if (patientSwapDragState.active) return;

        // ★ 即座にキャプチャしない（クリック編集との競合防止）
        patientSwapDragState.active = true;
        patientSwapDragState.armed = false;
        patientSwapDragState.dragging = false;
        patientSwapDragState.pointerId = e.pointerId;
        patientSwapDragState.srcRowIdx = rowIdx;
        patientSwapDragState.startX = e.clientX;
        patientSwapDragState.startY = e.clientY;
        patientSwapDragState.srcEl = el;
        patientSwapDragState.overEl = null;

        patientSwapDragState.armTimer = setTimeout(() => {
          patientSwapDragState.armed = true;
        }, PATIENT_SWAP_DRAG_ARM_MS);

        const onPointerMove = (ev) => {
          if (!('pointerId' in ev)) return;
          if (!patientSwapDragState.active) return;
          if (ev.pointerId !== patientSwapDragState.pointerId) return;

          const dx = ev.clientX - patientSwapDragState.startX;
          const dy = ev.clientY - patientSwapDragState.startY;
          const moved2 = dx * dx + dy * dy;
          const thr2 = PATIENT_SWAP_DRAG_THRESHOLD_PX * PATIENT_SWAP_DRAG_THRESHOLD_PX;

          // アーム前に閾値を超えた移動 → ドラッグ意図なしとみなしキャンセル
          if (!patientSwapDragState.armed && moved2 >= thr2) {
            window.removeEventListener('pointermove', onPointerMove, { passive: false });
            window.removeEventListener('pointerup', onPointerUp, true);
            window.removeEventListener('pointercancel', onPointerUp, true);
            resetPatientSwapDragState();
            return;
          }

          if (!patientSwapDragState.armed) return;

          // ドラッグ開始
          if (!patientSwapDragState.dragging && moved2 >= thr2) {
            startPatientSwapDrag(el, ev.pointerId, ev.clientX, ev.clientY);
          }

          if (!patientSwapDragState.dragging) return;

          ev.preventDefault();
          updatePatientSwapGhostPos(patientSwapDragState.ghostEl, ev.clientX, ev.clientY);

          const cand = patientIdCellFromPoint(ev.clientX, ev.clientY);
          setPatientSwapDragOverEl(cand && cand !== patientSwapDragState.srcEl ? cand : null);
        };

        const onPointerUp = async (ev) => {
          if (!('pointerId' in ev)) return;
          if (ev.pointerId !== patientSwapDragState.pointerId) return;

          window.removeEventListener('pointermove', onPointerMove, { passive: false });
          window.removeEventListener('pointerup', onPointerUp, true);
          window.removeEventListener('pointercancel', onPointerUp, true);

          // ポインターキャプチャをリリース
          try {
            el.releasePointerCapture(ev.pointerId);
          } catch (err) {
            // 無視
          }

          const dstEl = patientSwapDragState.overEl;
          const wasDragging = patientSwapDragState.dragging;

          stopPatientSwapDragVisuals();

          try {
            if (wasDragging && dstEl) {
              await commitPatientSwapIfNeeded(dstEl, ctx);
            } else if (!wasDragging) {
              // ドラッグしなかった（短いクリック）→ 編集モードに
              el.focus();
            }
          } finally {
            resetPatientSwapDragState();
          }
        };

        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', onPointerUp, true);
      });
    });
  }

  window.WardDnD = window.WardDnD || {};
  window.WardDnD.bindPatientSwap = bindPatientSwap;

})();