'use strict';

/**
 * 入口（Auth + 画面切替）
 * 病棟ページ機能は ward.js に分離。
 *
 * Supabase Auth + RLS によりクラウド保存。
 * ※ service_role key はフロントで使用しない。
 */


// ===== Storage Keys =====
// UI表示用に「最後に入力したメールアドレス」を保持（AuthはSupabaseが保持）
const KEY_LOGIN_EMAIL = 'bm_login_email_v1';


// ===== DOM（Auth / App Shell） =====
const authView = document.getElementById('authView');
const wardView = document.getElementById('wardView');
const sheetView = document.getElementById('sheetView');

const inputEmail = document.getElementById('inputEmail');
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





function normalizeEmail(raw) {
  return (raw || '').trim();
}

function validateCredentials(email, pass) {
  if (!email) return { ok: false, msg: 'メールアドレスを入力してください。' };
  if (email.length < 6) return { ok: false, msg: 'メールアドレスが短すぎます。' };
  if (/\s/.test(email)) return { ok: false, msg: 'メールアドレスに空白は使えません。' };
  // 簡易バリデーション（厳密判定ではない）
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return { ok: false, msg: 'メールアドレスの形式が正しくありません。' };
  if (!pass) return { ok: false, msg: 'PASSを入力してください。' };
  if (pass.length < 8) return { ok: false, msg: 'PASSは8文字以上にしてください。' };
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

function loadLoginEmail() {
  return (localStorage.getItem(KEY_LOGIN_EMAIL) || '').trim();
}

function saveLoginEmail(email) {
  localStorage.setItem(KEY_LOGIN_EMAIL, (email || '').trim());
}

function emailForDisplay(email) {
  return (email || '').trim();
}


// ===== Auth =====
async function signup() {
  setMsg('');
  const email = normalizeEmail(inputEmail?.value);
  const pass = inputPass?.value;

  const v = validateCredentials(email, pass);
  if (!v.ok) return setMsg(v.msg, true);

  saveLoginEmail(email);

  const { data, error } = await CloudSupabase.signUp(email, pass);
  if (error) return setMsg(error.message || '登録に失敗しました。', true);

  // Email確認が必須の場合、ここではログイン状態にならない（session が null）
  const needsConfirm = !data?.session;
  if (needsConfirm) {
    setMsg('確認メールを送信しました。メール内のリンクを開いて確認後、ログインしてください。');
    if (inputPass) inputPass.value = '';
    return;
  }

  setMsg('登録しました。ログイン状態になりました。');

  // 初回同期（クラウド→ローカル）
  await WardCore.cloudSyncDownAll();

  await render();
}


async function login() {
  setMsg('');
  const email = normalizeEmail(inputEmail?.value);
  const pass = inputPass?.value;

  const v = validateCredentials(email, pass);
  if (!v.ok) return setMsg(v.msg, true);

  saveLoginEmail(email);

    const { error } = await CloudSupabase.signIn(email, pass);
  if (error) {
    const msg = (error.message || '').includes('Email not confirmed')
      ? 'メール確認が未完了です。受信した確認メールのリンクを開いてからログインしてください。'
      : (error.message || 'ログインに失敗しました。');
    return setMsg(msg, true);
  }

  setMsg('ログインしました。');

  // ログイン直後にクラウド→ローカル
  await WardCore.cloudSyncDownAll();

  await render();
}


async function logout() {
  await CloudSupabase.signOut();

  setMsg('ログアウトしました。');

  // 病棟側の状態をクリア（存在すれば）
  window.BMWard?.reset?.();

  await render();
}


// ===== Views =====
async function render() {
  const { data } = await CloudSupabase.getUser();
  const loggedIn = !!data?.user;

  authView?.classList.toggle('hidden', loggedIn);
  btnLogout?.classList.toggle('hidden', !loggedIn);

  if (!loggedIn) {
    wardView?.classList.add('hidden');
    sheetView?.classList.add('hidden');
    if (inputPass) inputPass.value = '';
    return;
  }

  if (sheetView?.classList.contains('hidden')) {
    wardView?.classList.remove('hidden');
  }

  // 表示用（メールアドレス）
  const email = loadLoginEmail() || 'user@example.com';
  window.BMWard?.render?.(emailForDisplay(email));

  const todayEl = document.getElementById('todayJst');
  if (todayEl) todayEl.textContent = todayJSTJa();

  if (inputPass) inputPass.value = '';
}


// ===== Events =====
btnSignup?.addEventListener('click', () => { signup(); });
btnLogin?.addEventListener('click', () => { login(); });
btnLogout?.addEventListener('click', async () => { await logout(); });

// Enterキーでログイン
[inputEmail, inputPass].filter(Boolean).forEach(el => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });
});

// ✅ 起動時：初回描画
(async function bootstrap() {
  await render();
})();

