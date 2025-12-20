'use strict';

/**
 * 入口（Auth + 画面切替）
 * 病棟ページ機能は ward.js に分離。
 *
 * GitHub Pages向け（静的サイト）のため、ユーザーDBは localStorage に保存。
 * 注意：端末・ブラウザ単位でしか一意性を保証できません。
 */

// ===== Storage Keys =====
const KEY_USERS = 'bm_users_v1';     // { [userId]: { passHash, createdAt } }
const KEY_SESSION = 'bm_session_v1'; // { userId, loginAt }

// ===== DOM（Auth / App Shell） =====
const authView = document.getElementById('authView');
const wardView = document.getElementById('wardView');
const sheetView = document.getElementById('sheetView');

const inputId = document.getElementById('inputId');
const inputPass = document.getElementById('inputPass');

const btnLogin = document.getElementById('btnLogin');
const btnSignup = document.getElementById('btnSignup');
const btnLogout = document.getElementById('btnLogout');

const authMsg = document.getElementById('authMsg');

// ===== Utilities =====
function nowIso() { return new Date().toISOString(); }

function setMsg(text, isError = false) {
  if (!authMsg) return;
  authMsg.textContent = text || '';
  authMsg.classList.toggle('error', !!isError);
}
// 日本時間（JST）で「2025年12月20日（土）」形式を返す
function todayJSTJa() {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  });

  // 例: "2025年12月20日(土)"
  return formatter.format(new Date()).replace(' ', '');
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

// ===== Auth =====
async function signup() {
  setMsg('');
  const userId = normalizeUserId(inputId?.value);
  const pass = inputPass?.value;

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
  const userId = normalizeUserId(inputId?.value);
  const pass = inputPass?.value;

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

  // 病棟側の状態をクリア（存在すれば）
  window.BMWard?.reset?.();

  render();
}

// ===== Views =====
function render() {
  const session = loadSession();
  const loggedIn = !!(session && session.userId);

  authView?.classList.toggle('hidden', loggedIn);
  btnLogout?.classList.toggle('hidden', !loggedIn);

  if (!loggedIn) {
    // ログアウト時：病棟/シートは閉じる
    wardView?.classList.add('hidden');
    sheetView?.classList.add('hidden');

    // 入力欄は安全のため空に
    if (inputPass) inputPass.value = '';
    return;
  }

  // ログイン中：病棟選択を表示（sheetViewは ward.js が必要時に開く）
  if (sheetView?.classList.contains('hidden')) {
    wardView?.classList.remove('hidden');
  }

// 病棟側の描画（存在しなくても落ちない）
window.BMWard?.render?.(session.userId);

// ★ 日本の日付を表示
const todayEl = document.getElementById('todayJst');
if (todayEl) todayEl.textContent = todayJSTJa();


// 入力欄は安全のため空に
if (inputPass) inputPass.value = '';

}

// ===== Events =====
btnSignup?.addEventListener('click', () => { signup(); });
btnLogin?.addEventListener('click', () => { login(); });
btnLogout?.addEventListener('click', () => { logout(); });

// Enterキーでログイン
[inputId, inputPass].filter(Boolean).forEach(el => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });
});

// ✅ 起動時：初回描画
(function bootstrap() {
  render();
})();
