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
  }


  window.BMWardWardList = {
    renderWardButtons,
    addWardForUser,
    renameWardForUser,
    deleteWardForUser,
    updateWardCountBadge,
  };

})();
