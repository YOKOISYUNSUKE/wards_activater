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

// ===== Sheet columns =====
const SHEET_COLUMNS = [
  'ベッドNo',
  '患者ID',
  '退院許可',
  '主病名',
  'DPCコード',
  '期間Ⅰ',
  '期間Ⅱ',
  '期間Ⅲ',
  '入院日',
  '入院日数',
  '看護必要度',
  '退院予定日',
  'メモ',
];

// 列インデックス
const COL_BED_NO = 0;
const COL_PATIENT_ID = 1;
const COL_DISCHARGE_OK = 2;
const COL_DPC = 4;
const COL_DPC_I = 5;
const COL_DPC_II = 6;
const COL_DPC_III = 7;
const COL_ADMIT_DATE = 8;
const COL_ADMIT_DAYS = 9;
const COL_NURSING = 10;
const COL_EST_DISCHARGE = 11;

// ベッドタイプ定義
const BED_TYPES = {
  PRIVATE: 'private',
  DOUBLE: 'double',
  QUAD: 'quad'
};

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
  saveObj(key, normalizePlannedAdmissionsList(list));
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
    return;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  const clamped = Math.max(1, Math.min(10, Math.trunc(n)));
  localStorage.setItem(key, String(clamped));
}



function loadSession() {
  return loadObj(KEY_SESSION, null);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// ===== 日付ユーティリティ =====
function todayJSTIsoDate() {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return dtf.format(new Date());
}

function calcAdmitDays(admitDateStr) {
  if (!admitDateStr) return '';
  const today = new Date(todayJSTIsoDate());
  const admit = new Date(admitDateStr);
  if (isNaN(admit.getTime())) return '';
  const diffMs = today - admit;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
  return days > 0 ? String(days) : '';
}

function normalizeDateSlash(val) {
  const s = String(val || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : s;
}

function normalizeDateIso(val) {
  const s = String(val || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

// ===== ベッドNo関連 =====
function parseBedNo(val) {
  const s = String(val ?? '').trim();
  if (s === '') return { num: '', type: BED_TYPES.PRIVATE, slot: 0, isEmpty: true };

  const colonMatch = s.match(/^(\d+):(\w+)$/);
  if (colonMatch) {
    return { num: colonMatch[1], type: colonMatch[2], slot: 0, isEmpty: false };
  }

  const dashMatch = s.match(/^(\d+)-(\d+)$/);
  if (dashMatch) {
    return { num: dashMatch[1], type: null, slot: Number(dashMatch[2]), isEmpty: false };
  }

  if (/^\d+$/.test(s)) {
    return { num: s, type: BED_TYPES.PRIVATE, slot: 0, isEmpty: false };
  }

  return { num: s, type: BED_TYPES.PRIVATE, slot: 0, isEmpty: false };
}

function formatBedNoDisplay(val) {
  const p = parseBedNo(val);
  if (p.isEmpty) return '';
  if (p.slot > 0) return `-${p.slot}`;
  switch (p.type) {
    case BED_TYPES.DOUBLE: return `${p.num}-1`;
    case BED_TYPES.QUAD: return `${p.num}-1`;
    default: return p.num;
  }
}

// ===== シート行の正規化 =====
function normalizeSheetRows(rows) {
  const out = Array.isArray(rows) ? rows : [];
  let changed = false;

  out.forEach((row, rIdx) => {
    const arr = Array.isArray(row) ? row : [];

    if (arr.length === SHEET_COLUMNS.length - 1) {
      arr.unshift('');
      changed = true;
    }

    while (arr.length < SHEET_COLUMNS.length) {
      arr.push('');
      changed = true;
    }
    if (arr.length > SHEET_COLUMNS.length) {
      arr.length = SHEET_COLUMNS.length;
      changed = true;
    }

    if (String(arr[COL_BED_NO] ?? '').trim() === '') {
      arr[COL_BED_NO] = String(rIdx + 1);
      changed = true;
    }
  });

  return { rows: out, changed };
}

function makeEmptyRows(rowCount = 3) {
  return Array.from({ length: rowCount }, (_, rIdx) => {
    const row = Array.from({ length: SHEET_COLUMNS.length }, () => '');
    row[COL_BED_NO] = String(rIdx + 1);
    return row;
  });
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

async function setSheetRows(userId, wardId, rows) {
  const d = await ensureDb();
  await dbPutSheet(d, userId, wardId, rows);
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

  // ユーティリティ
  loadSession,
  escapeHtml,
  todayJSTIsoDate,
  calcAdmitDays,
  getPlannedAdmissions,
  setPlannedAdmissions,
  getErEstimate,
  setErEstimate,
  normalizeDateSlash,
  normalizeDateIso,
  parseBedNo,
  formatBedNoDisplay,
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
};

})();