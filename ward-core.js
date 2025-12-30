'use strict';

(() => {

/**
 * ward-core.js
 * 定数・ユーティリティ・IndexedDB・病棟管理
 */

// ===== Storage Keys =====
const KEY_SESSION = 'bm_session_v1';
const KEY_WARDCOUNT = 'bm_wardcount_v1';
const KEY_WARDS = 'bm_wards_v1';
const KEY_PLANNED_ADMISSIONS_PREFIX = 'bm_planned_admissions_v1';
const KEY_ER_ESTIMATE_PREFIX = 'bm_er_estimate_v1';
const KEY_WARD_TRANSFERS_PREFIX = 'bm_ward_transfers_v1';

// ===== Session =====
// Supabase移行後も、既存UI（病棟一覧/病棟シート）が bm_session_v1 を参照するため保持する
function setSession(session) {
  if (!session) return;
  const userId = String(session.userId || '').trim();
  if (!userId) return;
  const loginId = String(session.loginId || '').trim();
  saveObj(KEY_SESSION, {
    userId,
    loginId,
    updatedAt: new Date().toISOString(),
  });
}

function clearSession() {
  localStorage.removeItem(KEY_SESSION);
}


// ===== Cloud（Supabase）=====
const CLOUD_TABLE_USER_STATE = 'bm_user_state';
const CLOUD_TABLE_WARD_STATE = 'bm_ward_state';
const CLOUD_DEBOUNCE_MS = 1200;

const _cloudTimers = new Map();

// Supabase client / uid helpers
function cloudClient() {
  return window.CloudSupabase?.client || null;
}

async function cloudUid() {
  // 1) Supabaseの現在ユーザー（最優先）
  try {
    const res = await window.CloudSupabase?.getUser?.();
    const uid = res?.data?.user?.id;
    if (uid) return String(uid);
  } catch { }

  // 2) 互換: ローカルセッション（bm_session_v1）
  try {
    const s = loadSession?.();
    const uid2 = s?.userId;
    if (uid2) return String(uid2);
  } catch { }

  return '';
}

function scheduleCloud(fn, key) {
  const k = String(key || 'default');
  const prev = _cloudTimers.get(k);
  if (prev) clearTimeout(prev);
  _cloudTimers.set(k, setTimeout(async () => {
    try {
      await fn();
    } finally {
      _cloudTimers.delete(k);
    }
}, CLOUD_DEBOUNCE_MS));
}



// ===== Base（定数・表示・日付ユーティリティ）=====
// ward-core.base.js で定義し、ここでは参照のみ行う
const WardCoreBase = window.WardCoreBase || null;
if (!WardCoreBase) {
  console.warn('WardCoreBase not loaded: ward-core.base.js');
}

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
  BED_TYPES,
  escapeHtml,
  todayJSTIsoDate,
  calcAdmitDays,
  normalizeDateSlash,
  normalizeDateIso,
  parseBedNo,
  formatBedNoDisplay,
  formatBedNoDisplayHtml,
  makeEmptyRows,
} = WardCoreBase || {};

// ===== Utilities =====
function safeJsonParse(raw, fallback) {

  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function loadObj(key, fallback) {
  return safeJsonParse(localStorage.getItem(key), fallback);
}

function saveObj(key, obj) {
  localStorage.setItem(key, JSON.stringify(obj));
}

// ===== Cloud I/O =====
async function cloudUpsertUserState(uid, data) {
  const c = cloudClient();
  if (!c || !uid) return;

  const res = await c.from(CLOUD_TABLE_USER_STATE).upsert({
    user_id: uid,
    data,
    updated_at: new Date().toISOString()
  });

  if (res?.error) {
    console.warn('cloudUpsertUserState failed', res.error);
  }
}



async function cloudUpsertWardState(wardId, partialData) {
  const c = cloudClient();
  const uid = await cloudUid();
  if (!c || !uid || !wardId) return;

  // 既存データを取得してマージ
  let existingData = {};
  try {
    const res = await c
      .from(CLOUD_TABLE_WARD_STATE)
      .select('data')
      .eq('user_id', uid)
      .eq('ward_id', wardId)
      .maybeSingle();
    if (res?.data?.data) {
      existingData = res.data.data;
    }
  } catch { /* 新規の場合は空 */ }

  // null でないフィールドのみマージ
  const mergedData = { ...existingData };
  Object.entries(partialData || {}).forEach(([k, v]) => {
    if (v !== null) mergedData[k] = v;
  });

  const res = await c.from(CLOUD_TABLE_WARD_STATE).upsert({
    user_id: uid,
    ward_id: wardId,
    data: mergedData,
    updated_at: new Date().toISOString()
  });

  if (res?.error) {
    console.warn('cloudUpsertWardState failed', res.error);
  }

}

async function cloudDownloadUserState(uid) {
  const c = cloudClient();
  if (!c || !uid) return null;

  const res = await c
    .from(CLOUD_TABLE_USER_STATE)
    .select('data, updated_at')
    .eq('user_id', uid)
    .maybeSingle();

  if (res?.error) {
    console.warn('cloudDownloadUserState failed', res.error);
  }

  return res?.data || null;

}

async function cloudDownloadWardStates(uid) {
  const c = cloudClient();
  if (!c || !uid) return [];

  const res = await c
    .from(CLOUD_TABLE_WARD_STATE)
    .select('ward_id, data, updated_at')
    .eq('user_id', uid);

  if (res?.error) {
    console.warn('cloudDownloadWardStates failed', res.error);
  }

  return Array.isArray(res?.data) ? res.data : [];

}


function pickArrayFromMaybeMap(raw, uid) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (uid && Array.isArray(raw[uid])) return raw[uid];
    if (Array.isArray(raw.list)) return raw.list;
    if (Array.isArray(raw.items)) return raw.items;
  }
  return [];
}

function normalizeWardsList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((w) => ({
      id: String(w?.id ?? '').trim(),
      name: String(w?.name ?? '').trim(),
    }))
    .filter((w) => w.id || w.name)
    .map((w, idx) => ({
      id: w.id || `ward${idx + 1}`,
      name: w.name || w.id || defaultWardName(idx + 1),
    }));
}

async function cloudSyncDownAll() {
  const uid = await cloudUid();
  if (!uid) return;

  const u = await cloudDownloadUserState(uid);
  if (u?.data) {
    const wardsRaw = u.data.wards;
    const transfersRaw = u.data.transfers;

    const wardsList = normalizeWardsList(pickArrayFromMaybeMap(wardsRaw, uid));
    const transfersList = normalizeWardTransfersList(pickArrayFromMaybeMap(transfersRaw, uid));

    saveObj(KEY_WARDS, { [uid]: wardsList });
    saveObj(wardTransfersKey(uid), transfersList);

    // 旧形式（Map保存）からの自動移行：配列形式へ上書き保存
    const needsMigrate =
      (wardsRaw && !Array.isArray(wardsRaw) && typeof wardsRaw === 'object') ||
      (transfersRaw && !Array.isArray(transfersRaw) && typeof transfersRaw === 'object');

    if (needsMigrate) {
      scheduleCloud(async () => {
        await cloudUpsertUserState(uid, { wards: wardsList, transfers: transfersList });
      }, `user:${uid}:migrate`);
    }
  } else {
    // 新規ユーザー or クラウドにデータなし: デフォルト病棟がなければ作成
    const existing = loadObj(KEY_WARDS, {});
    if (!Array.isArray(existing[uid]) || existing[uid].length === 0) {
      existing[uid] = [{ id: 'ward1', name: '第1病棟' }];
      saveObj(KEY_WARDS, existing);
    }

    // bm_user_state が未作成の場合、ローカル状態をクラウドへ初期保存しておく
    try {
      const wards = getWardsForUser(uid);
      const transfers = getWardTransfers(uid);
      await cloudUpsertUserState(uid, { wards, transfers });
    } catch (e) {
      console.warn('cloudSyncDownAll initial user_state upsert failed', e);
    }
  }


  const wards = await cloudDownloadWardStates(uid);
  for (const row of wards) {
    if (!row?.ward_id || !row.data) continue;

    if (Array.isArray(row.data.sheetRows)) {
      await setSheetRows(uid, row.ward_id, row.data.sheetRows, { skipCloud: true });
    }
    if (Array.isArray(row.data.plannedAdmissions)) {
      saveObj(plannedAdmissionsKey(uid, row.ward_id), row.data.plannedAdmissions);
    }
    if (row.data.erEstimateByDate && typeof row.data.erEstimateByDate === 'object') {
      Object.entries(row.data.erEstimateByDate).forEach(([isoDate, v]) => {
        const k = erEstimateKey(uid, row.ward_id, isoDate);
        localStorage.setItem(k, String(v));
      });
    }
  }
}



// ===== 退院調整ロジック入力（予定入院 / 推定緊急入院） =====
function plannedAdmissionsKey(userId, wardId) {

  return `${KEY_PLANNED_ADMISSIONS_PREFIX}|${userId}|${wardId}`;
}

function erEstimateKey(userId, wardId, isoDate) {
  return `${KEY_ER_ESTIMATE_PREFIX}|${userId}|${wardId}|${isoDate}`;
}

function normalizePlannedAdmissionsList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((x) => ({
      id: String(x?.id ?? '').trim(),
      disease: String(x?.disease ?? '').trim(),
      date: String(x?.date ?? '').trim(),
      days: String(x?.days ?? '').trim(),
    }))
    .filter((x) => x.id || x.disease || x.date || x.days);
}

function getPlannedAdmissions(userId, wardId) {
  if (!userId || !wardId) return [];
  const key = plannedAdmissionsKey(userId, wardId);
  const raw = loadObj(key, []);
  return normalizePlannedAdmissionsList(raw);
}

function setPlannedAdmissions(userId, wardId, list) {
  if (!userId || !wardId) return;
  const key = plannedAdmissionsKey(userId, wardId);
  const normalized = normalizePlannedAdmissionsList(list);
  saveObj(key, normalized);

  scheduleCloud(async () => {
    const payload = {
      plannedAdmissions: normalized,
      erEstimateByDate: null,
      sheetRows: null
    };
    await cloudUpsertWardState(wardId, payload);
  });
}

function getErEstimate(userId, wardId, isoDate) {

  if (!userId || !wardId || !isoDate) return '';
  const key = erEstimateKey(userId, wardId, isoDate);
  const raw = localStorage.getItem(key);
  const v = String(raw ?? '').trim();
  if (!v) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const clamped = Math.max(1, Math.min(10, Math.trunc(n)));
  return String(clamped);
}

function setErEstimate(userId, wardId, isoDate, value) {
  if (!userId || !wardId || !isoDate) return;
  const key = erEstimateKey(userId, wardId, isoDate);
  const v = String(value ?? '').trim();
  if (!v) {
    localStorage.removeItem(key);
  } else {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(1, Math.min(10, Math.trunc(n)));
    localStorage.setItem(key, String(clamped));
  }

  scheduleCloud(async () => {
    const map = {};
    // 直近分だけでも良いが、互換維持のため「当該isoDateのみ」を保存
    const raw = localStorage.getItem(key);
    if (raw) map[isoDate] = raw;

    const payload = {
      plannedAdmissions: null,
      erEstimateByDate: map,
      sheetRows: null
    };
    await cloudUpsertWardState(wardId, payload);
  });
}


// ===== 病棟移動（病棟間で共有） =====
function wardTransfersKey(userId) {
  return `${KEY_WARD_TRANSFERS_PREFIX}|${userId}`;
}

function normalizeWardTransfersList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((x) => ({
      id: String(x?.id ?? '').trim(),
      fromWardId: String(x?.fromWardId ?? '').trim(),
      toWardId: String(x?.toWardId ?? '').trim(),
      updatedAt: String(x?.updatedAt ?? '').trim(),
    }))
    .filter((x) => x.id || x.fromWardId || x.toWardId);
}

function getWardTransfers(userId) {
  if (!userId) return [];
  const key = wardTransfersKey(userId);
  const raw = loadObj(key, []);
  return normalizeWardTransfersList(raw);
}

function setWardTransfers(userId, list) {
  if (!userId) return;
  const key = wardTransfersKey(userId);
  const next = normalizeWardTransfersList(list).map(x => ({
    ...x,
    updatedAt: new Date().toISOString(),
  }));
  saveObj(key, next);

  scheduleCloud(async () => {
    const transfers = getWardTransfers(userId);
    const wards = getWardsForUser(userId);
    await cloudUpsertUserState(userId, { wards, transfers });
  });
}


function getWardTransfersForWard(userId, wardId) {
  if (!userId || !wardId) return [];
  return getWardTransfers(userId)
    .filter(x => x.fromWardId === wardId || x.toWardId === wardId);
}

function loadSession() {
  return loadObj(KEY_SESSION, null);
}




// ===== IndexedDB =====
const DB_NAME = 'bedman_db_v1';
const DB_VERSION = 1;
const STORE_SHEETS = 'sheets';

let db = null;
let dbReady = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_SHEETS)) {
        const store = d.createObjectStore(STORE_SHEETS, { keyPath: 'key' });
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

async function ensureDb() {
  if (db) return db;
  if (!dbReady) {
    dbReady = openDb().then((d) => { db = d; return d; });
  }
  return dbReady;
}

async function dbGetSheet(d, userId, wardId) {
  const key = makeSheetKey(userId, wardId);
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_SHEETS, 'readonly');
    const store = tx.objectStore(STORE_SHEETS);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPutSheet(d, userId, wardId, rows) {
  const key = makeSheetKey(userId, wardId);
  const rec = { key, userId, wardId, rows, updatedAt: new Date().toISOString() };
  const tx = d.transaction(STORE_SHEETS, 'readwrite');
  tx.objectStore(STORE_SHEETS).put(rec);
  await txDone(tx);
}


async function dbDeleteSheet(d, userId, wardId) {
  const key = makeSheetKey(userId, wardId);
  const tx = d.transaction(STORE_SHEETS, 'readwrite');
  tx.objectStore(STORE_SHEETS).delete(key);
  await txDone(tx);
}

async function deleteSheetRows(userId, wardId) {
  const d = await ensureDb();
  await dbDeleteSheet(d, userId, wardId);
}

async function setSheetRows(userId, wardId, rows, options) {

  const d = await ensureDb();
  await dbPutSheet(d, userId, wardId, rows);

  const opt = options || {};
  if (opt.skipCloud) return;

  scheduleCloud(async () => {
    const payload = {
      sheetRows: rows,
      plannedAdmissions: null,
      erEstimateByDate: null
    };
    await cloudUpsertWardState(wardId, payload);
  }, `ward:${userId}:${wardId}:sheetRows`);
}

// NOTE: setSheetRows は上で定義済み（クラウド同期あり）。


async function getSheetRows(userId, wardId) {
  const d = await ensureDb();
  const rec = await dbGetSheet(d, userId, wardId);
  const rows = rec?.rows;
  if (Array.isArray(rows) && rows.length) {
    const norm = normalizeSheetRows(rows);
    if (norm.changed) {
      await dbPutSheet(d, userId, wardId, norm.rows);
    }
    return norm.rows;
  }
  return makeEmptyRows(3);
}


// ===== 病棟管理 =====
function loadAllWards() { return loadObj(KEY_WARDS, {}); }
function saveAllWards(all) { saveObj(KEY_WARDS, all); }

function defaultWardName(n) {
  return `第${n}病棟`;
}

function getNextWardNumber(wards) {
  let maxN = 0;
  (wards || []).forEach(w => {
    const m = String(w?.id || '').match(/^ward(\d+)$/);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  });
  return Math.max(maxN + 1, (wards?.length || 0) + 1);
}

function migrateWardCountIfNeeded(userId) {
  const all = loadAllWards();
  if (Array.isArray(all[userId]) && all[userId].length) return;

  const old = loadObj(KEY_WARDCOUNT, {});
  const n = Math.max(1, Math.min(20, Number(old?.[userId] ?? 6)));

  const wards = [];
  for (let i = 1; i <= n; i++) {
    wards.push({ id: `ward${i}`, name: defaultWardName(i) });
  }
  all[userId] = wards;
  saveAllWards(all);
}

function getWardsForUser(userId) {
  migrateWardCountIfNeeded(userId);
  const all = loadAllWards();
  const wards = all[userId];
  if (Array.isArray(wards)) return wards;
  return [];
}

function setWardsForUser(userId, wards) {
  const all = loadAllWards();
  all[userId] = wards;
  saveAllWards(all);

  scheduleCloud(async () => {
    const transfers = getWardTransfers(userId);
    await cloudUpsertUserState(userId, { wards, transfers }); 
  });
}

// ===== グローバル公開 =====
window.WardCore = {

  // 定数
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
  BED_TYPES,

  // 表示ユーティリティ
  parseBedNo,
  formatBedNoDisplay,
  formatBedNoDisplayHtml,

  // ユーティリティ
  loadSession,
  setSession,
  clearSession,
  escapeHtml,
  todayJSTIsoDate,
  calcAdmitDays,
  getPlannedAdmissions,
  setPlannedAdmissions,
  getErEstimate,
  setErEstimate,
  normalizeDateSlash,
  normalizeDateIso,
  makeEmptyRows,

  // IndexedDB
  ensureDb,
  getSheetRows,
  setSheetRows,
  deleteSheetRows,

  // 病棟管理
  getWardsForUser,
  setWardsForUser,
  getNextWardNumber,
  defaultWardName,
  getWardTransfers,
  setWardTransfers,
  getWardTransfersForWard,
  cloudSyncDownAll,

};

})(); 
