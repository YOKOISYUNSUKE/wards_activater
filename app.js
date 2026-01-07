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
const headerUserInfo = document.getElementById('headerUserInfo');


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
function ensureSyncOverlay() {
  let overlay = document.getElementById('syncOverlay');
  if (overlay) return overlay;

  // style（1回だけ）
  if (!document.getElementById('syncOverlayStyle')) {
    const style = document.createElement('style');
    style.id = 'syncOverlayStyle';
    style.textContent = `
      .sync-overlay {
        position: fixed;
        inset: 0;
        background: rgba(255,255,255,0.72);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999;
      }
      .sync-overlay.hidden { display: none; }
      .sync-box {
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 14px;
        padding: 16px 18px;
        box-shadow: 0 10px 28px rgba(0,0,0,0.12);
        display: flex;
        align-items: center;
        gap: 12px;
        max-width: calc(100vw - 24px);
      }
      .sync-spinner {
        width: 22px;
        height: 22px;
        border-radius: 999px;
        border: 3px solid rgba(0,0,0,0.12);
        border-top-color: rgba(0,0,0,0.55);
        animation: syncspin 0.9s linear infinite;
      }
      @keyframes syncspin { to { transform: rotate(360deg); } }
      .sync-text {
        font-size: 13px;
        color: #111827;
        line-height: 1.3;
      }
    `;
    document.head.appendChild(style);
  }

  overlay = document.createElement('div');
  overlay.id = 'syncOverlay';
  overlay.className = 'sync-overlay hidden';
  overlay.innerHTML = `
    <div class="sync-box" role="status" aria-live="polite" aria-busy="true">
      <div class="sync-spinner" aria-hidden="true"></div>
      <div class="sync-text" id="syncOverlayText">同期中…</div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function setSyncOverlay(isOn, text) {
  const overlay = ensureSyncOverlay();
  const t = document.getElementById('syncOverlayText');
  if (t) t.textContent = String(text || '同期中…');
  overlay.classList.toggle('hidden', !isOn);

  // 同期中の誤操作を少し抑制（任意）
  try {
    const btn = document.getElementById('btnAddWard');
    if (btn) btn.disabled = !!isOn;
  } catch { }
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

  // いったん病棟画面へ（同期前描画はしない）
  await render(false);

  // 同期中スピナー
  setSyncOverlay(true, 'クラウドから同期中…');

  try {
    await WardCore.cloudSyncDownAll();
    await render(true);
  } finally {
    setSyncOverlay(false);
  }


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

  // いったん病棟画面へ（同期前描画はしない）
  await render(false);

//ヘッダー右側のユーザー情報を表示
if (headerUserInfo) {
  headerUserInfo.classList.remove('hidden');
}

  // 同期中スピナー
  setSyncOverlay(true, 'クラウドから同期中…');

  try {
    await WardCore.cloudSyncDownAll();
    await render(true);
  } finally {
    setSyncOverlay(false);
  }

}


async function logout() {
  await CloudSupabase.signOut();

setMsg('ログアウトしました。');

if (headerUserInfo) {
  headerUserInfo.classList.add('hidden');
}

// 既存UIは bm_session_v1 を参照するため、ログアウト時に明示的に破棄
try {
  WardCore.clearSession?.();
} catch { }

// 病棟側の状態をクリア（存在すれば）
window.BMWard?.reset?.();


  await render();
}


// ===== Views =====
// ===== Views =====
async function render(afterSync = false) {
  const { data } = await CloudSupabase.getUser();
  const loggedIn = !!data?.user;

  authView?.classList.toggle('hidden', loggedIn);
  btnLogout?.classList.toggle('hidden', !loggedIn);

  if (!loggedIn) {
    setSyncOverlay(false);
    wardView?.classList.add('hidden');
    sheetView?.classList.add('hidden');
    if (inputPass) inputPass.value = '';
    return;
  }


  // ✅ Supabaseのuidをローカルセッション（bm_session_v1）へ同期
  // これが無いと、病棟カードクリック時の openWardSheet が userId なしで中断し「進めない」
  try {
    const uid = data?.user?.id || '';
    const email = loadLoginEmail() || data?.user?.email || '';
    WardCore.setSession?.({ userId: uid, loginId: emailForDisplay(email) });
  } catch { }

// 同期完了後のみ病棟選択画面を表示
if (afterSync) {
  wardView?.classList.remove('hidden');
} else {
  wardView?.classList.add('hidden');
  sheetView?.classList.add('hidden');
}


  // 🔑 同期完了後のみ「病棟一覧の描画」を実行（同期前描画を防ぐ）
  if (afterSync) {
    const email = loadLoginEmail() || 'user@example.com';
    window.BMWard?.render?.(emailForDisplay(email));
  }

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

