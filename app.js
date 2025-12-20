'use strict';

/**
 * GitHub Pages向け（静的サイト）のため、ユーザーDBは localStorage に保存。
 * 注意：端末・ブラウザ単位でしか一意性を保証できません。
 */

// ===== Storage Keys =====
const KEY_USERS = 'bm_users_v1';          // { [userId]: { passHash, createdAt } }
const KEY_SESSION = 'bm_session_v1';      // { userId, loginAt }
const KEY_WARDCOUNT = 'bm_wardcount_v1';  // { [userId]: number(1..20) }
const KEY_SHEETS = 'bm_sheets_v1';        // { [userId]: { [wardId]: { rows: string[][] } } }
const KEY_GSHEETS = 'bm_gsheets_v1';      // { [userId]: { [wardId]: { url: string } } }

// ===== Sheet columns（簡易スプレッドシート） =====
const SHEET_COLUMNS = [
  '患者ID',
  '主病名',
  'DPCコード',
  '入院日',
  '入院日数',
  '看護必要度',
  '退院見込み',
  '平均緊急入院数',
  'メモ',
];

// ===== DOM =====
const authView = document.getElementById('authView');
const wardView = document.getElementById('wardView');
const sheetView = document.getElementById('sheetView');

const inputId = document.getElementById('inputId');
const inputPass = document.getElementById('inputPass');

const btnLogin = document.getElementById('btnLogin');
const btnSignup = document.getElementById('btnSignup');
const btnLogout = document.getElementById('btnLogout');

const authMsg = document.getElementById('authMsg');
const wardGrid = document.getElementById('wardGrid');
const currentUser = document.getElementById('currentUser');

// ward count controls
const wardCount = document.getElementById('wardCount');
const wardCountLabel = document.getElementById('wardCountLabel');
const btnSaveWardCount = document.getElementById('btnSaveWardCount');

// sheet view controls
const btnBackToWards = document.getElementById('btnBackToWards');
const sheetWardName = document.getElementById('sheetWardName');
const sheetTable = document.getElementById('sheetTable');
const btnAddRow = document.getElementById('btnAddRow');
const btnClearSheet = document.getElementById('btnClearSheet');

const gsheetUrl = document.getElementById('gsheetUrl');
const btnSaveGsheetUrl = document.getElementById('btnSaveGsheetUrl');
const btnOpenGsheet = document.getElementById('btnOpenGsheet');

const sheetMsg = document.getElementById('sheetMsg');
// ===== IndexedDB =====
const DB_NAME = 'bedman_db_v1';
const DB_VERSION = 1;
const STORE_SHEETS = 'sheets';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SHEETS)) {
        const store = db.createObjectStore(STORE_SHEETS, { keyPath: 'key' });
        store.createIndex('by_user', 'userId', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function makeSheetKey(userId, wardId) {
  return `${userId}|${wardId}`;
}

async function dbGetSheet(db, userId, wardId) {
  const key = makeSheetKey(userId, wardId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SHEETS, 'readonly');
    const store = tx.objectStore(STORE_SHEETS);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPutSheet(db, userId, wardId, rows) {
  const key = makeSheetKey(userId, wardId);
  const rec = {
    key,
    userId,
    wardId,
    rows,
    updatedAt: new Date().toISOString(),
  };

  const tx = db.transaction(STORE_SHEETS, 'readwrite');
  tx.objectStore(STORE_SHEETS).put(rec);
  await txDone(tx);
}

async function dbDeleteSheet(db, userId, wardId) {
  const key = makeSheetKey(userId, wardId);
  const tx = db.transaction(STORE_SHEETS, 'readwrite');
  tx.objectStore(STORE_SHEETS).delete(key);
  await txDone(tx);
}

// ===== Utilities =====
function nowIso() { return new Date().toISOString(); }

function setMsg(text, isError = false) {
  authMsg.textContent = text || '';
  authMsg.classList.toggle('error', !!isError);
}

function setSheetMsg(text, isError = false) {
  sheetMsg.textContent = text || '';
  sheetMsg.classList.toggle('error', !!isError);
}

function normalizeUserId(raw) {
  return (raw || '').trim();
}

function validateCredentials(userId, pass) {
  if (!userId) return { ok: false, msg: 'IDを入力してください。' };
  if (userId.length < 3) return { ok: false, msg: 'IDは3文字以上にしてください。' };
  if (/\s/.test(userId)) return { ok: false, msg: 'IDに空白は使えません。' };
  if (!pass) return { ok: false, msg: 'PASSを入力してください。' };
  if (pass.length < 4) return { ok: false, msg: 'PASSは4文字以上にしてください。' };
  return { ok: true, msg: '' };
}

function safeJsonParse(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function loadObj(key, fallback) {
  return safeJsonParse(localStorage.getItem(key), fallback);
}
function saveObj(key, obj) {
  localStorage.setItem(key, JSON.stringify(obj));
}

function loadUsers() { return loadObj(KEY_USERS, {}); }
function saveUsers(users) { saveObj(KEY_USERS, users); }

function loadSession() { return loadObj(KEY_SESSION, null); }
function saveSession(session) { saveObj(KEY_SESSION, session); }
function clearSession() { localStorage.removeItem(KEY_SESSION); }

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== Ward Count =====
function getWardCountForUser(userId) {
  const all = loadObj(KEY_WARDCOUNT, {});
  const n = Number(all[userId] ?? 6);
  if (Number.isFinite(n) && n >= 1 && n <= 20) return n;
  return 6;
}

function setWardCountForUser(userId, n) {
  const all = loadObj(KEY_WARDCOUNT, {});
  all[userId] = n;
  saveObj(KEY_WARDCOUNT, all);
}

function buildWardList(n) {
  const wards = [];
  for (let i = 1; i <= n; i++) {
    wards.push({ id: `ward${i}`, name: `第${i}病棟` });
  }
  return wards;
}

// ===== Sheet Storage =====
let db = null;
let dbReady = null;

// DBの準備が終わる前に操作されても壊れないように、必ずここを経由して取得する
async function ensureDb() {
  if (db) return db;
  if (!dbReady) {
    dbReady = openDb().then((d) => {
      db = d;
      return d;
    });
  }
  return dbReady;
}

function makeEmptyRows(rowCount = 3) {
  return Array.from({ length: rowCount }, () =>
    Array.from({ length: SHEET_COLUMNS.length }, () => '')
  );
}

async function getSheetRows(userId, wardId) {
  const d = await ensureDb();
  const rec = await dbGetSheet(d, userId, wardId);
  const rows = rec?.rows;
  if (Array.isArray(rows) && rows.length) return rows;
  return makeEmptyRows(3);
}

async function setSheetRows(userId, wardId, rows) {
  const d = await ensureDb();
  await dbPutSheet(d, userId, wardId, rows);
}


// ===== Google Sheets URL Storage =====
function loadGSheets() { return loadObj(KEY_GSHEETS, {}); }
function saveGSheets(all) { saveObj(KEY_GSHEETS, all); }

function getGSheetUrl(userId, wardId) {
  const all = loadGSheets();
  return (all?.[userId]?.[wardId]?.url) || '';
}

function setGSheetUrl(userId, wardId, url) {
  const all = loadGSheets();
  all[userId] = all[userId] || {};
  all[userId][wardId] = { url };
  saveGSheets(all);
}

// ===== Auth =====
async function signup() {
  setMsg('');
  const userId = normalizeUserId(inputId.value);
  const pass = inputPass.value;

  const v = validateCredentials(userId, pass);
  if (!v.ok) return setMsg(v.msg, true);

  const users = loadUsers();
  if (users[userId]) return setMsg('このIDはすでに使用されています。別のIDにしてください。', true);

  const passHash = await sha256(pass);
  users[userId] = { passHash, createdAt: nowIso() };
  saveUsers(users);

  saveSession({ userId, loginAt: nowIso() });
  setMsg('登録しました。ログイン状態になりました。');
  render();
}

async function login() {
  setMsg('');
  const userId = normalizeUserId(inputId.value);
  const pass = inputPass.value;

  const v = validateCredentials(userId, pass);
  if (!v.ok) return setMsg(v.msg, true);

  const users = loadUsers();
  const u = users[userId];
  if (!u) return setMsg('IDが見つかりません。新規登録してください。', true);

  const passHash = await sha256(pass);
  if (passHash !== u.passHash) return setMsg('PASSが違います。', true);

  saveSession({ userId, loginAt: nowIso() });
  setMsg('ログインしました。');
  render();
}

function logout() {
  clearSession();
  setMsg('ログアウトしました。');
  render();
}

// ===== Views =====
let currentWard = null; // { id, name }

// ===== Ward UI =====
function renderWardCountUI(userId) {
  const n = getWardCountForUser(userId);
  wardCount.value = String(n);
  wardCountLabel.textContent = String(n);
}

function renderWardButtons(userId) {
  const n = getWardCountForUser(userId);
  const wards = buildWardList(n);

  wardGrid.innerHTML = '';
  wards.forEach((w, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ward';
    btn.innerHTML = `
      <p class="title">${w.name}</p>
      <p class="meta">Ward ID: ${w.id} / No.${idx + 1}</p>
    `;
    btn.addEventListener('click', () => {
      openWardSheet(w);
    });
    wardGrid.appendChild(btn);
  });

  currentUser.textContent = userId;
}
const sheetSearch = document.getElementById('sheetSearch');
const btnResetSort = document.getElementById('btnResetSort');

let sheetAllRows = [];     // DBから読み込んだ“正”
let sheetViewRows = [];    // 検索/ソート適用後に描画する“表示用”
let sortState = { col: -1, dir: 0 }; // dir: 0=なし, 1=昇順, -1=降順

function applySearchAndSort() {
  const q = (sheetSearch?.value || '').trim().toLowerCase();

  // 1) filter
  let rows = sheetAllRows;
  if (q) {
    rows = rows.filter(r => r.some(cell => String(cell ?? '').toLowerCase().includes(q)));
  }

  // 2) sort
  if (sortState.col >= 0 && sortState.dir !== 0) {
    const c = sortState.col;
    const dir = sortState.dir;
    rows = [...rows].sort((a, b) => {
      const av = String(a?.[c] ?? '');
      const bv = String(b?.[c] ?? '');
      // 数字っぽければ数字優先
      const an = Number(av), bn = Number(bv);
      const bothNum = Number.isFinite(an) && Number.isFinite(bn) && av.trim() !== '' && bv.trim() !== '';
      if (bothNum) return (an - bn) * dir;
      return av.localeCompare(bv, 'ja') * dir;
    });
  }

  sheetViewRows = rows;
  renderSheetTable(sheetViewRows);
}

// ===== Sheet UI =====
async function openWardSheet(ward) {
  const session = loadSession();
  if (!session?.userId) return;

  currentWard = ward;
  setSheetMsg('読み込み中…');

  // DBから読込
  sheetAllRows = await getSheetRows(session.userId, ward.id);
  setSheetMsg('');

  sheetWardName.textContent = `${ward.name}（${ward.id}）`;

  // view switch
  wardView.classList.add('hidden');
  sheetView.classList.remove('hidden');

  // 初期：検索/ソートを適用して描画
  applySearchAndSort();
}


function backToWards() {
  currentWard = null;
  setSheetMsg('');
  sheetView.classList.add('hidden');
  wardView.classList.remove('hidden');
}

function renderSheetTable(rows) {
  const thead = `
    <thead>
      <tr>
        ${SHEET_COLUMNS.map((c, idx) => {
          const ind =
            sortState.col === idx
              ? (sortState.dir === 1 ? '▲' : sortState.dir === -1 ? '▼' : '')
              : '';
          return `<th class="sortable" data-col="${idx}">${escapeHtml(c)}<span class="sort-ind">${ind}</span></th>`;
        }).join('')}
      </tr>
    </thead>
  `;

  const tbody = `
    <tbody>
      ${rows.map((row, r) => `
        <tr>
          ${row.map((cell, c) => `
            <td>
              <div class="cell" contenteditable="true" data-r="${r}" data-c="${c}">${escapeHtml(cell)}</div>
            </td>
          `).join('')}
        </tr>
      `).join('')}
    </tbody>
  `;

  sheetTable.innerHTML = thead + tbody;

  // ヘッダ：ソート
  sheetTable.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = Number(th.getAttribute('data-col'));
      if (sortState.col !== col) {
        sortState = { col, dir: 1 };
      } else {
        // 1回目:昇順 → 2回目:降順 → 3回目:解除
        sortState.dir = sortState.dir === 1 ? -1 : sortState.dir === -1 ? 0 : 1;
        if (sortState.dir === 0) sortState.col = -1;
      }
      applySearchAndSort();
    });
  });

  // セル：blurで保存（非同期）
  sheetTable.querySelectorAll('.cell').forEach(el => {
    el.addEventListener('blur', () => {
      persistSheetFromDom().catch(() => setSheetMsg('保存に失敗しました。', true));
    });
  });
}


async function persistSheetFromDom() {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  const rows = [];
  const rowEls = Array.from(sheetTable.querySelectorAll('tbody tr'));

  rowEls.forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('.cell'));
    const row = cells.map(div => (div.textContent ?? '').trimEnd());
    rows.push(row);
  });

  // ✅ 今画面に見えている内容を「正」として確定
  sheetAllRows = rows;

  // ✅ 正データのみを IndexedDB に保存
  await setSheetRows(session.userId, currentWard.id, sheetAllRows);

  setSheetMsg('保存しました。');
}


async function addRow() {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  // 「正」のデータ（全体）に対して追加
  sheetAllRows = sheetAllRows.length ? sheetAllRows : makeEmptyRows(0);
  sheetAllRows.push(Array.from({ length: SHEET_COLUMNS.length }, () => ''));

  // IndexedDBへ保存
  await setSheetRows(session.userId, currentWard.id, sheetAllRows);

  setSheetMsg('行を追加しました。');
  applySearchAndSort(); // 検索/ソート中でも表示が崩れない
}

async function clearSheet() {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  // 初期状態（空行3行）に戻す
  sheetAllRows = makeEmptyRows(3);

  // IndexedDBへ保存
  await setSheetRows(session.userId, currentWard.id, sheetAllRows);

  setSheetMsg('クリアしました。');
  applySearchAndSort();
}


// ===== Google Sheets actions =====
function saveCurrentGsheetUrl() {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  const url = (gsheetUrl.value || '').trim();
  setGSheetUrl(session.userId, currentWard.id, url);
  setSheetMsg('URLを保存しました。');
}

function openCurrentGsheet() {
  const url = (gsheetUrl.value || '').trim();
  if (!url) return setSheetMsg('URLが空です。', true);

  // 最低限のチェック（完全ではない）
  if (!/^https?:\/\//i.test(url)) return setSheetMsg('URL形式が不正です。', true);

  window.open(url, '_blank', 'noopener');
  setSheetMsg('新しいタブで開きました。');
}

// ===== HTML escape =====
function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function render() {
  const session = loadSession();
  const loggedIn = !!(session && session.userId);

  authView.classList.toggle('hidden', loggedIn);
  btnLogout.classList.toggle('hidden', !loggedIn);

  // sheet view はログアウト時に閉じる
  if (!loggedIn) {
    wardView.classList.add('hidden');
    sheetView.classList.add('hidden');
    currentUser.textContent = '';
    currentWard = null;
    return;
  }

  // ログイン中：病棟選択を表示（sheetViewは必要時のみ）
  if (sheetView.classList.contains('hidden')) {
    wardView.classList.remove('hidden');
  }

  renderWardCountUI(session.userId);
  renderWardButtons(session.userId);

  // 入力欄は安全のため空に
  inputPass.value = '';
}

// ===== Events =====
btnSignup.addEventListener('click', () => { signup(); });
btnLogin.addEventListener('click', () => { login(); });
btnLogout.addEventListener('click', () => { logout(); });

// Enterキーでログイン
[inputId, inputPass].forEach(el => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });
});
sheetSearch?.addEventListener('input', () => {
  applySearchAndSort();
});

btnResetSort?.addEventListener('click', () => {
  sortState = { col: -1, dir: 0 };
  applySearchAndSort();
});
// ward count UI
wardCount.addEventListener('input', () => {
  wardCountLabel.textContent = String(wardCount.value);
});

btnSaveWardCount.addEventListener('click', () => {
  const session = loadSession();
  if (!session?.userId) return;

  const n = Math.max(1, Math.min(20, Number(wardCount.value)));
  setWardCountForUser(session.userId, n);
  setMsg(`病棟数を ${n} に保存しました。`);
  // いま表示されている病棟一覧にも即反映
  renderWardButtons(session.userId);
});

// sheet UI
btnBackToWards.addEventListener('click', () => backToWards());
btnAddRow.addEventListener('click', () => addRow());
btnClearSheet.addEventListener('click', () => clearSheet());
btnSaveGsheetUrl.addEventListener('click', () => saveCurrentGsheetUrl());
btnOpenGsheet.addEventListener('click', () => openCurrentGsheet());

// ✅ 起動時：DBを開いてから描画
(async function bootstrap() {
  try {
    await ensureDb();      // IndexedDB をオープン（準備）
  } catch (e) {
    console.error(e);
    setMsg(
      'データベースの初期化に失敗しました。ブラウザのストレージ制限やプライベートモードの可能性があります。',
      true
    );
    // DBが使えなくてもログインUIは動かせるようにする
  }
  render();                // 初回描画
})();
