'use strict';

/**
 * ward-ui-wardlist.js
 * 病棟選択画面（病棟カード一覧）のUI
 */

(function () {

  const {
    escapeHtml,
    getWardsForUser,
    setWardsForUser,
    getNextWardNumber,
    defaultWardName,
    deleteSheetRows,
    loadSession,
    getDischargeParamsAll,
    setDischargeParamsAll,
  } = window.WardCore;


  function getDom() {
    return {
      wardGrid: document.getElementById('wardGrid'),
      currentUser: document.getElementById('currentUser'),
      wardCountLabel: document.getElementById('wardCountLabel'),
    };
  }

  function getState() {
    window.BMWardState = window.BMWardState || {
      currentWard: null,
      sheetAllRows: [],
      sheetViewRows: [],
      sortState: { col: -1, dir: 0 },
    };
    return window.BMWardState;
  }

  function setWardMsg(text, isError) {
    window.BMWardMsg?.setWardMsg?.(text, isError);
  }

  function setSheetMsg(text, isError) {
    window.BMWardMsg?.setSheetMsg?.(text, isError);
  }

  function updateWardCountBadge(userId) {
    const { wardCountLabel } = getDom();
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

    const st = getState();
    if (st?.currentWard && st.currentWard.id === wardId) {
      st.currentWard = { ...st.currentWard, name: nextName };
      const sheetWardName = document.getElementById('sheetWardName');
      if (sheetWardName) sheetWardName.textContent = `${st.currentWard.name}（${st.currentWard.id}）`;
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

  function updateDischargeParamsCard(userId) {
    const el = document.getElementById('dischargeParamsSummary');
    if (!el) return;

    let params = null;
    try {
      params = getDischargeParamsAll?.(userId) || null;
    } catch (e) {
      params = null;
    }

    if (!params) {
      el.textContent = '目標稼働率などの設定（未設定）';
      return;
    }

    const occ = Number(params.target_occupancy);
    const occPct = Number.isFinite(occ) ? Math.round(occ * 100) : null;
    const noDis = (params.hard_no_discharge_weekdays || '').trim();

    const parts = [];
    if (occPct !== null) parts.push(`目標稼働率 ${occPct}%`);
    if (noDis) parts.push(`退院不可 ${noDis}`);
    el.textContent = parts.length ? parts.join(' / ') : '目標稼働率などの設定';
  }

function openDischargeParamsDialog(userId) {
    const existing = document.getElementById('dischargeParamsPopup');
    if (existing) {
      existing.remove();
      return; // トグル動作：既に開いていれば閉じる
    }

    const params = (() => {
      try {
        return getDischargeParamsAll?.(userId) || null;
      } catch (e) {
        return null;
      }
    })();

    const current = params || {
      target_occupancy: 0.85,
      hard_no_discharge_weekdays: '日',
      weekday_weights: { '日': 10, '土': 6 },
      ER_avg: 2,
      risk_params: { cap_th1: 0.85, cap_th2: 0.95, nurse_max: 5 },
      scoring_weights: { w_dpc: 40, w_cap: 35, w_n: 10, w_adj: 10, w_wk: 10, w_dev: 5 },
    };

// 退院調整カードの右隣にポップアップ表示
    const anchorCard = document.querySelector('.ward-header-card.discharge-params');
    if (!anchorCard) return;

    const popup = document.createElement('div');
    popup.id = 'dischargeParamsPopup';
    popup.className = 'discharge-params-popup';
    popup.innerHTML = `
      <div class="popup-head">
        <h3 class="popup-title">退院調整パラメータ</h3>
        <button type="button" class="btn btn-ghost popup-close" id="btnCloseDischargeParams">✕</button>
      </div>

      <div class="popup-body">
        <div class="form-row">
          <label>目標稼働率（%）</label>
          <input id="dp_target_occ" type="number" min="0" max="100" step="1" value="${escapeHtml(String(Math.round(Number(current.target_occupancy || 0.85) * 100)))}" />
        </div>

        <div class="form-row">
          <label>退院不可曜日（例：日 / 日,土 / 空欄=なし）</label>
          <input id="dp_no_dis" type="text" value="${escapeHtml(String(current.hard_no_discharge_weekdays || ''))}" />
        </div>

        <div class="form-row">
          <label>ER平均（/日）</label>
          <input id="dp_er_avg" type="number" min="0" max="50" step="0.1" value="${escapeHtml(String(current.ER_avg ?? 2))}" />
        </div>

        <div class="form-row">
          <label>変動数（入院患者数の変動許容範囲：人）</label>
          <input id="dp_fluctuation" type="number" min="0" max="20" step="1" value="${escapeHtml(String(current.fluctuation_limit ?? 3))}" />
        </div>

        <div class="form-row">
          <label>逼迫閾値 cap_th1 / cap_th2</label>
          <div class="form-inline">
            <input id="dp_cap_th1" type="number" min="0" max="1" step="0.01" value="${escapeHtml(String(current.risk_params?.cap_th1 ?? 0.85))}" />
            <span class="muted">/</span>
            <input id="dp_cap_th2" type="number" min="0" max="1" step="0.01" value="${escapeHtml(String(current.risk_params?.cap_th2 ?? 0.95))}" />
          </div>
        </div>

        <div class="form-row">
          <label>nurse_max</label>
          <input id="dp_nurse_max" type="number" min="0" max="50" step="1" value="${escapeHtml(String(current.risk_params?.nurse_max ?? 5))}" />
        </div>
</div>

      <div class="popup-foot">
        <button type="button" class="btn btn-primary" id="btnSaveDischargeParams">保存</button>
      </div>
    `;

    // 退院調整カードの右隣に配置
    anchorCard.style.position = 'relative';
    anchorCard.appendChild(popup);

function close() {
      popup.remove();
    }

    // 外側クリックで閉じる
    setTimeout(() => {
      const onDocClick = (e) => {
        if (!popup.contains(e.target) && !anchorCard.contains(e.target)) {
          close();
          document.removeEventListener('click', onDocClick, true);
        }
      };
      document.addEventListener('click', onDocClick, true);
    }, 0);

    const closeBtn = document.getElementById('btnCloseDischargeParams');
    if (closeBtn) closeBtn.addEventListener('click', close);

    const saveBtn = document.getElementById('btnSaveDischargeParams');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const occPct = Number(document.getElementById('dp_target_occ')?.value);
        const noDis = String(document.getElementById('dp_no_dis')?.value || '').trim();
        const erAvg = Number(document.getElementById('dp_er_avg')?.value);
        const fluctuation = Number(document.getElementById('dp_fluctuation')?.value);
        const capTh1 = Number(document.getElementById('dp_cap_th1')?.value);
        const capTh2 = Number(document.getElementById('dp_cap_th2')?.value);
        const nurseMax = Number(document.getElementById('dp_nurse_max')?.value);

        const nextParams = {
          ...current,
          target_occupancy: Number.isFinite(occPct) ? Math.max(0, Math.min(1, occPct / 100)) : current.target_occupancy,
          hard_no_discharge_weekdays: noDis,
          ER_avg: Number.isFinite(erAvg) ? Math.max(0, erAvg) : current.ER_avg,
          fluctuation_limit: Number.isFinite(fluctuation) ? Math.max(0, Math.min(20, fluctuation)) : current.fluctuation_limit,
          risk_params: {
            ...(current.risk_params || {}),
            cap_th1: Number.isFinite(capTh1) ? Math.max(0, Math.min(1, capTh1)) : current.risk_params?.cap_th1,
            cap_th2: Number.isFinite(capTh2) ? Math.max(0, Math.min(1, capTh2)) : current.risk_params?.cap_th2,
            nurse_max: Number.isFinite(nurseMax) ? Math.max(0, nurseMax) : current.risk_params?.nurse_max,
          },
        };

        try {
          await setDischargeParamsAll?.(userId, nextParams);
          setWardMsg('退院調整（ALL）パラメータを保存しました。');
          updateDischargeParamsCard(userId);
          close();
        } catch (e) {
          setWardMsg('保存に失敗しました。', true);
        }
      });
    }
  }

  function renderWardButtons(userId) {
    const { wardGrid, currentUser } = getDom();
    if (!wardGrid) return;


    if (!userId) {
      wardGrid.innerHTML = '';
      if (currentUser) currentUser.textContent = '';
      setWardMsg('同期中…', false);
      return;
    }

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
        window.BMWardSheetUI?.openWardSheet?.(w)
          .catch(() => setSheetMsg('読み込みに失敗しました。', true));
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
        deleteWardForUser(userId, w.id)
          .catch(() => setWardMsg('削除に失敗しました。', true));
      });

      actions.appendChild(renameBtn);
      actions.appendChild(delBtn);
      card.appendChild(main);
      card.appendChild(actions);
      wardGrid.appendChild(card);
    });

    const session = loadSession?.();
    const displayUser = session?.loginId ? session.loginId : userId;

    if (currentUser) currentUser.textContent = displayUser;

    updateWardCountBadge(userId);
    updateDischargeParamsCard(userId);
  }



  window.BMWardWardList = {
    renderWardButtons,
    addWardForUser,
    renameWardForUser,
    deleteWardForUser,
    updateWardCountBadge,
    openDischargeParamsDialog,
    updateDischargeParamsCard,
  };


})();
