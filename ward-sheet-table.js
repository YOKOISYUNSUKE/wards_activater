'use strict';

/**
 * ward-sheet-table.js
 * 検索・ソート・テーブル描画・テーブル内イベント・保存
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
    formatBedNoDisplayHtml,
    setSheetRows,
  } = window.WardCore;

const {
  openDpcPicker,
  showBedTypeSelector,
  applyBedType,
  clearBedNo,
  showNursingSelector,
} = window.WardFeatures || {};


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

  function updateKpiUI() {
    window.BMWardSheetUI?.updateKpiUI?.();
  }

  function updateFixedHScrollMetrics() {
    window.BMWardHScroll?.updateFixedHScrollMetrics?.();
  }

  function elSheetTable() {
    return document.getElementById('sheetTable');
  }

  function elSheetSearch() {
    return document.getElementById('sheetSearch');
  }

  // ===== 検索・ソート =====
  function applySearchAndSort() {
    const st = state();
    const sheetAllRows = Array.isArray(st?.sheetAllRows) ? st.sheetAllRows : [];
    const sortState = st?.sortState || { col: -1, dir: 0 };

    const q = (elSheetSearch()?.value || '').trim().toLowerCase();
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

    st.sheetViewRows = items;
    renderSheetTable(items);
  }

  // ===== テーブル描画 =====
  function renderSheetTable(items) {
    const sheetTable = elSheetTable();
    if (!sheetTable) return;

    const st = state();
    const sortState = st?.sortState || { col: -1, dir: 0 };

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
  const html = formatBedNoDisplayHtml(cell);
  return `
    <td>
      <div class="cell bed-no-cell" data-idx="${it.idx}" data-c="${c}" data-raw="${escapeHtml(cell)}">${html}</div>
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
              if (c === COL_PATIENT_ID) {
                return `
                  <td>
                    <div
                      class="cell patient-id-cell"
                      data-idx="${it.idx}"
                      data-c="${c}"
                    ><span class="patient-drag-handle" title="ドラッグで入れ替え">⠿</span><span class="patient-id-text" contenteditable="true">${escapeHtml(cell)}</span></div>
                  </td>
                `;
              }

              return `
                <td>
                  <div class="cell" contenteditable="true" data-idx="${it.idx}" data-c="${c}">
                    ${escapeHtml(cell)}
                  </div>
                </td>
              `;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    `;

    sheetTable.innerHTML = thead + tbody;
    bindSheetEvents();
    updateFixedHScrollMetrics();
  }

  // ===== テーブル内イベント =====
  function bindSheetEvents() {
    const sheetTable = elSheetTable();
    if (!sheetTable) return;

    const st = state();

    // ★ 患者IDセルのドラッグ＆ドロップをバインド（ハンドル経由）
    if (window.WardDnD?.bindPatientSwap) {
      window.WardDnD.bindPatientSwap(sheetTable, {
        getRows: () => st.sheetAllRows,
        getWard: () => st.currentWard,
        setMsg: (text, isError) => setSheetMsg(text, isError),
        applySearchAndSort,
        updateKpiUI,
      });
    }

    // ソートイベント
    sheetTable.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = Number(th.getAttribute('data-col'));
        if (!st.sortState) st.sortState = { col: -1, dir: 0 };

        if (st.sortState.col !== col) {
          st.sortState = { col, dir: 1 };
        } else {
          st.sortState.dir = st.sortState.dir === 1 ? -1 : st.sortState.dir === -1 ? 0 : 1;
          if (st.sortState.dir === 0) st.sortState.col = -1;
        }
        applySearchAndSort();
      });
    });

    // セル編集イベント（患者ID用：.patient-id-text）
    sheetTable.querySelectorAll('.patient-id-text').forEach(el => {
      el.addEventListener('blur', () => {
        try {
          const parentCell = el.closest('.patient-id-cell');
          if (!parentCell) return;

          const c = Number(parentCell.getAttribute('data-c'));
          const rowIdx = Number(parentCell.getAttribute('data-idx'));
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
                const todayIso = todayJSTIsoDate();
                const todaySlash = normalizeDateSlash(todayIso);

                admitInp.value = todayIso;

                if (Number.isFinite(rowIdx) && rowIdx >= 0 && st.sheetAllRows?.[rowIdx]) {
                  st.sheetAllRows[rowIdx][COL_ADMIT_DATE] = todaySlash;

                  const days = calcAdmitDays(todaySlash);
                  st.sheetAllRows[rowIdx][COL_ADMIT_DAYS] = days;

                  const daysEl = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${COL_ADMIT_DAYS}"]`);
                  if (daysEl) daysEl.textContent = days;
                }
              }
            }
          }

          // 通常セル更新
          if (Number.isFinite(rowIdx) && rowIdx >= 0 && st.sheetAllRows?.[rowIdx]) {
            st.sheetAllRows[rowIdx][c] = (el.textContent ?? '').trim();
          }

          persistSheetFromDom('自動保存しました');
        } catch (e) {
          console.error(e);
        }
      });
    });

    // セル編集イベント（通常セル）
    sheetTable.querySelectorAll('.cell:not(.patient-id-cell)').forEach(el => {
      if (!el.hasAttribute('contenteditable')) return;

      el.addEventListener('blur', () => {
        try {
          const c = Number(el.getAttribute('data-c'));
          const rowIdx = Number(el.getAttribute('data-idx'));
          const master = window.DPC_MASTER;

          // DPC入力セル（contenteditable）→ マスタ参照して I/II/III 自動セット
          if (c === COL_DPC) {
            const code = (el.textContent ?? '').trim();
            if (Number.isFinite(rowIdx) && rowIdx >= 0 && st.sheetAllRows?.[rowIdx]) {
              st.sheetAllRows[rowIdx][COL_DPC] = code;

              const rec = master?.lookupByCode?.(code);
              st.sheetAllRows[rowIdx][COL_DPC_I] = rec?.i || '';
              st.sheetAllRows[rowIdx][COL_DPC_II] = rec?.ii || '';
              st.sheetAllRows[rowIdx][COL_DPC_III] = rec?.iii || '';

              const iEl = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${COL_DPC_I}"]`);
              const iiEl = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${COL_DPC_II}"]`);
              const iiiEl = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${COL_DPC_III}"]`);
              if (iEl) iEl.textContent = rec?.i || '';
              if (iiEl) iiEl.textContent = rec?.ii || '';
              if (iiiEl) iiiEl.textContent = rec?.iii || '';
            }
          }

          // 通常セル更新
          if (Number.isFinite(rowIdx) && rowIdx >= 0 && st.sheetAllRows?.[rowIdx]) {
            st.sheetAllRows[rowIdx][c] = (el.textContent ?? '').trim();
          }

          persistSheetFromDom('自動保存しました');
        } catch (e) {
          console.error(e);
        }
      });
    });

    // 日付（date input）変更
    sheetTable.querySelectorAll('input.date-input').forEach(inp => {
      inp.addEventListener('change', () => {
        const c = Number(inp.getAttribute('data-c'));
        const rowIdx = Number(inp.getAttribute('data-idx'));
        const iso = (inp.value || '').trim();
        const slash = iso ? normalizeDateSlash(iso) : '';

        if (Number.isFinite(rowIdx) && rowIdx >= 0 && st.sheetAllRows?.[rowIdx]) {
          st.sheetAllRows[rowIdx][c] = slash;

          // 入院日変更 → 入院日数も更新
          if (c === COL_ADMIT_DATE) {
            const days = slash ? calcAdmitDays(slash) : '';
            st.sheetAllRows[rowIdx][COL_ADMIT_DAYS] = days;

            const daysEl = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${COL_ADMIT_DAYS}"]`);
            if (daysEl) daysEl.textContent = days;
          }
        }

        persistSheetFromDom('自動保存しました');
      });
    });

    // 退院OKチェック
    sheetTable.querySelectorAll('input.discharge-ok-check').forEach(chk => {
      chk.addEventListener('change', () => {
        const c = Number(chk.getAttribute('data-c'));
        const rowIdx = Number(chk.getAttribute('data-idx'));

        if (Number.isFinite(rowIdx) && rowIdx >= 0 && st.sheetAllRows?.[rowIdx]) {
          st.sheetAllRows[rowIdx][c] = chk.checked ? '1' : '';
        }

        persistSheetFromDom('自動保存しました');
      });
    });

// ベッドNoセル（クリックでベッドタイプ選択など）
sheetTable.querySelectorAll('.bed-no-cell').forEach(cell => {
  cell.addEventListener('click', () => {
    const rowIdx = Number(cell.getAttribute('data-idx'));
    if (!Number.isFinite(rowIdx) || rowIdx < 0) return;

    // ward-features.js の正しいシグネチャに合わせる
    showBedTypeSelector(cell, st.sheetAllRows, async (action, startIdx, inputNum, bedType) => {
      if (!Number.isFinite(startIdx) || startIdx < 0) return;

      try {
        if (action === 'clear') {
          await clearBedNo(startIdx, st.sheetAllRows, st.currentWard, (msg) => {
            if (msg) setSheetMsg(msg);
          });
        } else if (action === 'set') {
          await applyBedType(startIdx, inputNum, bedType, st.sheetAllRows, st.currentWard, (msg) => {
            if (msg) setSheetMsg(msg);
          });
        }

        // UI表示を rows の最新値に同期（複数床は連動して表示更新）
        const refreshBedCell = (idx) => {
          const el = sheetTable.querySelector(`.bed-no-cell[data-idx="${idx}"]`);
          if (!el) return;
          const raw = String(st.sheetAllRows?.[idx]?.[COL_BED_NO] ?? '');
          el.setAttribute('data-raw', raw);
          el.innerHTML = formatBedNoDisplayHtml(raw);
        };

        refreshBedCell(startIdx);

        const bt = String(bedType || '');
        const slotCount = (bt === 'quad') ? 4 : (bt === 'double') ? 2 : 1;
        for (let i = 1; i < slotCount; i++) {
          refreshBedCell(startIdx + i);
        }

        updateKpiUI();
      } catch (e) {
        console.error(e);
        setSheetMsg('ベッドNoの更新に失敗しました。', true);
      }
    });
  });
});


// 看護必要度（クリックで選択）
sheetTable.querySelectorAll('.nursing-cell').forEach(cell => {
  cell.addEventListener('click', () => {
    const rowIdx = Number(cell.getAttribute('data-idx'));
    if (!Number.isFinite(rowIdx) || rowIdx < 0) return;

    // ✅ ward-features.js の想定シグネチャに合わせる
    showNursingSelector(cell, st.sheetAllRows, st.currentWard, (msg) => {
      // セレクタ側で sheetAllRows[COL_NURSING] が更新されるので、表示を追随
      if (st.sheetAllRows?.[rowIdx]) {
        cell.textContent = String(st.sheetAllRows[rowIdx][COL_NURSING] ?? '').trim();
      }

      // 表示メッセージ（"保存しました。" 等）
      if (msg) setSheetMsg(msg);

      updateKpiUI();
    });
  });
});


// DPCピッカー（ダブルクリック / Enterで呼び出し）
sheetTable.querySelectorAll('.cell[data-c="' + COL_DPC + '"]').forEach(cell => {
  const openByKeyword = () => {
    const rowIdx = Number(cell.getAttribute('data-idx'));
    const kw = (cell.textContent ?? '').trim();

    const candidates = window.WardFeatures?.getDpcCandidates?.(kw, 80) || [];
    if (!candidates.length) {
      setSheetMsg('DPC候補が見つかりませんでした。', true);
      return;
    }

    openDpcPicker(cell, candidates, (picked) => {
      const code = String(picked?.code ?? '').trim();
      if (!code) return;

      const master = window.DPC_MASTER;
      const rec = master?.lookupByCode?.(code) || null;

      cell.textContent = code;

      if (Number.isFinite(rowIdx) && rowIdx >= 0 && st.sheetAllRows?.[rowIdx]) {
        st.sheetAllRows[rowIdx][COL_DPC] = code;

        st.sheetAllRows[rowIdx][COL_DPC_I] = String(rec?.i ?? picked?.I ?? '').trim();
        st.sheetAllRows[rowIdx][COL_DPC_II] = String(rec?.ii ?? picked?.II ?? '').trim();
        st.sheetAllRows[rowIdx][COL_DPC_III] = String(rec?.iii ?? picked?.III ?? '').trim();
      }

      const iEl = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${COL_DPC_I}"]`);
      const iiEl = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${COL_DPC_II}"]`);
      const iiiEl = sheetTable.querySelector(`.cell[data-idx="${rowIdx}"][data-c="${COL_DPC_III}"]`);
      if (iEl) iEl.textContent = String(rec?.i ?? picked?.I ?? '').trim();
      if (iiEl) iiEl.textContent = String(rec?.ii ?? picked?.II ?? '').trim();
      if (iiiEl) iiiEl.textContent = String(rec?.iii ?? picked?.III ?? '').trim();

      persistSheetFromDom('自動保存しました');
    });
  };

  cell.addEventListener('dblclick', openByKeyword);

  cell.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    openByKeyword();
  });
});

  }

  async function persistSheetFromDom(msgOk) {
    const session = loadSession();
    if (!session?.userId) return;
    const st = state();
    if (!st.currentWard?.id) return;

    try {
      await setSheetRows(session.userId, st.currentWard.id, st.sheetAllRows);
      setSheetMsg(msgOk || '保存しました');
      updateKpiUI();
    } catch (e) {
      console.error(e);
      setSheetMsg('保存に失敗しました。', true);
    }
  }

  window.BMWardSheetTable = {
    applySearchAndSort,
    renderSheetTable,
    bindSheetEvents,
    persistSheetFromDom,
  };

})();