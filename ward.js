(function () {
'use strict';

/**
 * 病棟ページ（病棟一覧・病棟シート）
 */

// ===== Storage Keys =====
const KEY_SESSION = 'bm_session_v1';      // { userId, loginAt }

// 旧：wardcount は「移行」にだけ使う（残っていてもOK）
const KEY_WARDCOUNT = 'bm_wardcount_v1';  // { [userId]: number(1..20) }

// 新：ユーザーごとの病棟リスト
// 形式：{ [userId]: Array<{ id:string, name:string }> }
const KEY_WARDS = 'bm_wards_v1';

// ===== Sheet columns（簡易スプレッドシート） =====
// 先頭に「ベッドNo」を追加（編集可）
const SHEET_COLUMNS = [
  'ベッドNo',
  '患者ID',
  '主病名',
  'DPCコード',
  '期間Ⅰ',
  '期間Ⅱ',
  '期間Ⅲ',
  '入院日',
  '入院日数',
  '看護必要度',
  '退院見込み',
  'メモ',
];


// 列インデックス（SHEET_COLUMNSに依存）
const COL_BED_NO = 0;
const COL_PATIENT_ID = 1;
// ベッドタイプ定義
const BED_TYPES = {
  PRIVATE: 'private',    // 個室
  DOUBLE: 'double',      // 二人床
  QUAD: 'quad'           // 四人床
};
const COL_DPC = 3;
const COL_DPC_I = 4;
const COL_DPC_II = 5;
const COL_DPC_III = 6;
const COL_ADMIT_DATE = 7;
const COL_ADMIT_DAYS = 8;


// ==============================
// JSTの本日（YYYY-MM-DD）を返す
// ==============================
function todayJSTIsoDate() {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return dtf.format(new Date());
}
// ==============================
// 入院日数を計算（JST・当日=1日目）
// ==============================
function calcAdmitDays(admitDateStr) {
  if (!admitDateStr) return '';

  const today = new Date(todayJSTIsoDate());
  const admit = new Date(admitDateStr);

  if (isNaN(admit.getTime())) return '';

  const diffMs = today - admit;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;

  return days > 0 ? String(days) : '';
}

// =====================================
// 旧データ互換：ベッドNo列を自動追加
// =====================================
function normalizeSheetRows(rows) {
  const out = Array.isArray(rows) ? rows : [];
  let changed = false;

  out.forEach((row, rIdx) => {
    const arr = Array.isArray(row) ? row : [];

    // 旧形式（ベッドNoなし） → 先頭に追加
    if (arr.length === SHEET_COLUMNS.length - 1) {
      arr.unshift('');
      changed = true;
    }

    // 列数を合わせる
    while (arr.length < SHEET_COLUMNS.length) {
      arr.push('');
      changed = true;
    }
    if (arr.length > SHEET_COLUMNS.length) {
      arr.length = SHEET_COLUMNS.length;
      changed = true;
    }

    // ベッドNo 初期値（空なら行番号）
    if (String(arr[COL_BED_NO] ?? '').trim() === '') {
      arr[COL_BED_NO] = String(rIdx + 1);
      changed = true;
    }
  });

  return { rows: out, changed };
}

//  ベッドタイプと番号をパース
// 形式: "番号" | "番号:type" | "番号-slot" | " " (空白=マージセル)
function parseBedNo(val) {
  const s = String(val ?? '').trim();
  if (s === '') return { num: '', type: BED_TYPES.PRIVATE, slot: 0, isEmpty: true };
  
  // "番号:type" 形式をチェック
  const colonMatch = s.match(/^(\d+):(\w+)$/);
  if (colonMatch) {
    return { num: colonMatch[1], type: colonMatch[2], slot: 0, isEmpty: false };
  }
  
  // "番号-slot" 形式（二人床・四人床の子セル）
  const dashMatch = s.match(/^(\d+)-(\d+)$/);
  if (dashMatch) {
    return { num: dashMatch[1], type: null, slot: Number(dashMatch[2]), isEmpty: false };
  }
  
  // 数字のみ → 個室
  if (/^\d+$/.test(s)) {
    return { num: s, type: BED_TYPES.PRIVATE, slot: 0, isEmpty: false };
  }
  
  return { num: s, type: BED_TYPES.PRIVATE, slot: 0, isEmpty: false };
}

// ベッドNo表示用文字列を生成
function formatBedNoDisplay(val) {
  const p = parseBedNo(val);
  if (p.isEmpty) return '';
  
  // 子セル（-2, -3, -4）→ "-2" のように番号なしで表示
  if (p.slot > 0) return `-${p.slot}`;
  
  switch (p.type) {
    // 親セル（二人床・四人床）→ "番号-1" のように病室番号付きで表示
    case BED_TYPES.DOUBLE: return `${p.num}-1`;
    case BED_TYPES.QUAD: return `${p.num}-1`;
    default: return p.num;
  }
}

// ===== DOM（病棟） =====
const wardView = document.getElementById('wardView');
const sheetView = document.getElementById('sheetView');

const wardGrid = document.getElementById('wardGrid');
const currentUser = document.getElementById('currentUser');

const wardCountLabel = document.getElementById('wardCountLabel');
const btnAddWard = document.getElementById('btnAddWard');
const wardMsg = document.getElementById('wardMsg'); // ない場合もある

// ===== DOM（シート） =====
const btnBackToWards = document.getElementById('btnBackToWards');
const sheetWardName = document.getElementById('sheetWardName');
const sheetTable = document.getElementById('sheetTable');
const inputBedCount = document.getElementById('inputBedCount');
const btnClearSheet = document.getElementById('btnClearSheet');
const btnDischargeOptimize = document.getElementById('btnDischargeOptimize');
const sheetMsg = document.getElementById('sheetMsg');
const sheetSearch = document.getElementById('sheetSearch');

// ===== Utilities（このモジュール内で完結） =====
function safeJsonParse(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function loadObj(key, fallback) { return safeJsonParse(localStorage.getItem(key), fallback); }
function saveObj(key, obj) { localStorage.setItem(key, JSON.stringify(obj)); }

function loadSession() { return loadObj(KEY_SESSION, null); }

// 日付表記を YYYY/MM/DD に正規化（YYYY-MM-DD も吸収）
function normalizeDateSlash(val) {
  const s = String(val || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : s;
}

// input[type="date"] 用：YYYY/MM/DD または YYYY-MM-DD → YYYY-MM-DD
function normalizeDateIso(val) {
  const s = String(val || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}



function setWardMsg(text, isError = false) {
  if (!wardMsg) return;
  wardMsg.textContent = text || '';
  wardMsg.classList.toggle('error', !!isError);
}
function setSheetMsg(text, isError = false) {
  if (!sheetMsg) return;
  sheetMsg.textContent = text || '';
  sheetMsg.classList.toggle('error', !!isError);
}
function calcOccupancyFromRows(rows) {
  const bedCount = Array.isArray(rows) ? rows.length : 0;

  const inpatients = (rows || []).reduce((acc, row) => {
    const pid = String(row?.[COL_PATIENT_ID] ?? '').trim();
    return acc + (pid ? 1 : 0);
  }, 0);

  const percent = bedCount > 0 ? (inpatients / bedCount) * 100 : 0;

  return { inpatients, bedCount, percent };
}

function updateOccupancyUI() {
  const fracEl = document.getElementById('occFraction');
  const pctEl = document.getElementById('occPercent');
  if (!fracEl || !pctEl) return;

  const { inpatients, bedCount, percent } = calcOccupancyFromRows(sheetAllRows);

  fracEl.textContent = `${inpatients}/${bedCount}`;
  pctEl.textContent = `${Math.round(percent)}%`;
}

// ===== Wards（新方式：リスト） =====
function loadAllWards() { return loadObj(KEY_WARDS, {}); }
function saveAllWards(all) { saveObj(KEY_WARDS, all); }

function defaultWardName(n) {
  return `第${n}病棟`;
}

function getNextWardNumber(wards) {
  // ward{id} の末尾数字を拾って最大+1（無理なら wards.length+1）
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

  // 旧 wardcount があればそれを採用、なければ6（従来デフォルト）
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

function updateWardCountBadge(userId) {
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

  // 追加時に名前指定（要件）
  const name = (window.prompt('追加する病棟名を入力してください（未入力なら自動命名）', suggested) || '').trim();
  const finalName = name || suggested;

  // id は読みやすい連番（ward1, ward2 ...）
  const id = `ward${nextN}`;

  // 念のため重複回避（極端なケース）
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

  if (currentWard && currentWard.id === wardId) {
    currentWard = { ...currentWard, name: nextName };
    if (sheetWardName) sheetWardName.textContent = `${currentWard.name}（${currentWard.id}）`;
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


// ===== IndexedDB（病棟シート保存） =====
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
function makeSheetKey(userId, wardId) { return `${userId}|${wardId}`; }

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

function makeEmptyRows(rowCount = 3) {
  return Array.from({ length: rowCount }, (_, rIdx) => {
    const row = Array.from({ length: SHEET_COLUMNS.length }, () => '');
    row[COL_BED_NO] = String(rIdx + 1);
    return row;
  });
}

async function getSheetRows(userId, wardId) {
  const d = await ensureDb();
  const rec = await dbGetSheet(d, userId, wardId);
  const rows = rec?.rows;
if (Array.isArray(rows) && rows.length) {
  const norm = normalizeSheetRows(rows);
  // 形式が変わっていたら即保存しておく（以降の処理を単純化）
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

// ===== State =====
let currentWard = null; // { id, name }

let sheetAllRows = [];
let sheetViewRows = [];
let sortState = { col: -1, dir: 0 };

// ===== HTML escape =====
function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// ===== Ward UI =====
function renderWardButtons(userId) {
  if (!wardGrid) return;

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
      openWardSheet(w).catch(() => setSheetMsg('読み込みに失敗しました。', true));
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
      deleteWardForUser(userId, w.id).catch(() => setWardMsg('削除に失敗しました。', true));
    });

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);

    card.appendChild(main);
    card.appendChild(actions);

    wardGrid.appendChild(card);
  });

  if (currentUser) currentUser.textContent = userId;
  updateWardCountBadge(userId);
}


// ===== Search & Sort =====
function applySearchAndSort() {
  const q = (sheetSearch?.value || '').trim().toLowerCase();
  let items = sheetAllRows.map((row, idx) => ({ idx, row }));

if (q) {
  const master = window.DPC_MASTER;

  items = items.filter(it => {
    // まず既存のセル文字列で検索
    const hitCell = it.row.some(cell => String(cell ?? '').toLowerCase().includes(q));
    if (hitCell) return true;

    // 追加：DPCコード → 病名で検索（シートに病名を書いてなくてもヒット）
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

  sheetViewRows = items;
  renderSheetTable(sheetViewRows);
}

// ===== Sheet UI =====
async function openWardSheet(ward) {
  const session = loadSession();
  if (!session?.userId) return;

  currentWard = ward;
  setSheetMsg('読み込み中…');

  sheetAllRows = await getSheetRows(session.userId, ward.id);
  setSheetMsg('');

  if (sheetWardName) sheetWardName.textContent = `${ward.name}（${ward.id}）`;

if (sheetSearch) sheetSearch.value = '';
sortState = { col: -1, dir: 0 };

// 病床数入力に現在行数を反映
if (inputBedCount) inputBedCount.value = String(sheetAllRows.length);


  wardView?.classList.add('hidden');
  sheetView?.classList.remove('hidden');

  applySearchAndSort();
  updateOccupancyUI();
}


function backToWards() {
  currentWard = null;
  setSheetMsg('');
  sheetView?.classList.add('hidden');
  wardView?.classList.remove('hidden');
}

function renderSheetTable(items) {
  if (!sheetTable) return;

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
      ${items.map((it) => `
        <tr data-idx="${it.idx}">
          ${it.row.map((cell, c) => {
            if (c === COL_BED_NO) {
              // ベッドNo列: クリックでタイプ選択、表示はフォーマット済み
              const display = formatBedNoDisplay(cell);
              return `
                <td>
                  <div class="cell bed-no-cell" data-idx="${it.idx}" data-c="${c}" data-raw="${escapeHtml(cell)}">${escapeHtml(display)}</div>
                </td>
              `;
            }
if (c === COL_ADMIT_DATE || c === COL_EST_DISCHARGE) {
  const isoVal = normalizeDateIso(cell);
  return `
    <td>
      <input
        class="date-input"
        type="date"
        data-idx="${it.idx}"
        data-c="${c}"
        value="${escapeHtml(isoVal)}"
      />
    </td>
  `;
}

return `
  <td>
    <div class="cell" contenteditable="true" data-idx="${it.idx}" data-c="${c}">${escapeHtml(cell)}</div>
  </td>
`;

          }).join('')}
        </tr>
      `).join('')}
    </tbody>
  `;

  sheetTable.innerHTML = thead + tbody;

  sheetTable.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = Number(th.getAttribute('data-col'));
      if (sortState.col !== col) {
        sortState = { col, dir: 1 };
      } else {
        sortState.dir = sortState.dir === 1 ? -1 : sortState.dir === -1 ? 0 : 1;
        if (sortState.dir === 0) sortState.col = -1;
      }
      applySearchAndSort();
    });
  });

  sheetTable.querySelectorAll('.cell').forEach(el => {
el.addEventListener('blur', () => {
  try {
    const c = Number(el.getAttribute('data-c'));
    const rowIdx = Number(el.getAttribute('data-idx'));
    const master = window.DPC_MASTER;

 
// ① 患者ID → 入院日（既存）
if (c === COL_PATIENT_ID) {
  const pid = (el.textContent ?? '').trim();
  if (pid) {
    const admitEl = sheetTable.querySelector(
      `.cell[data-idx="${rowIdx}"][data-c="${COL_ADMIT_DATE}"]`
    );
    if (admitEl && (admitEl.textContent ?? '').trim() === '') {
      admitEl.textContent = normalizeDateSlash(todayJSTIsoDate());
    }
  }
}


// ★② 入院日 → 入院日数（自動計算）
if (c === COL_ADMIT_DATE) {
  const admitDate = (el.textContent ?? '').trim();
  const days = calcAdmitDays(admitDate);

  const daysEl = sheetTable.querySelector(
    `.cell[data-idx="${rowIdx}"][data-c="${COL_ADMIT_DAYS}"]`
  );
  if (daysEl) daysEl.textContent = days;
}

// 日付表記を YYYY/MM/DD に正規化（入院日・退院見込み）
if (c === COL_ADMIT_DATE || c === COL_EST_DISCHARGE) {
  el.textContent = normalizeDateSlash(el.textContent);
}



    // ② DPCコード列：コード or 病名 → 期間ⅠⅡⅢ自動反映
    if (c === COL_DPC) {
      const input = (el.textContent ?? '').trim();
      if (input && master) {
        let rec = master.lookupByCode?.(input);

        // コードで見つからない → 病名候補検索
        if (!rec) {
          const cands = master.findCandidates?.(input, 10) || [];
          if (cands.length === 1) {
            // 1件なら自動採用（コードも自動補正）
            const picked = cands[0];
            el.textContent = picked.code;
            rec = { name: picked.name, I: picked.I, II: picked.II, III: picked.III };
          } else if (cands.length >= 2) {
            // 複数なら簡易選択（番号入力）
            const menu = cands
              .map((x, i) => `${i + 1}) ${x.code} / ${x.name} （Ⅰ${x.I} Ⅱ${x.II} Ⅲ${x.III}）`)
              .join('\n');
            const ans = (window.prompt(`DPC候補が複数あります。番号で選択してください。\n\n${menu}`) || '').trim();
            const n = Number(ans);
            if (Number.isFinite(n) && n >= 1 && n <= cands.length) {
              const picked = cands[n - 1];
              el.textContent = picked.code;
              rec = { name: picked.name, I: picked.I, II: picked.II, III: picked.III };
            }
          }
        }

        // 期間セルへ反映
        if (rec) {
          const setCell = (col, val) => {
            const cell = sheetTable.querySelector(
              `.cell[data-idx="${rowIdx}"][data-c="${col}"]`
            );
            if (cell) cell.textContent = String(val ?? '');
          };
          setCell(COL_DPC_I, rec.I);
          setCell(COL_DPC_II, rec.II);
          setCell(COL_DPC_III, rec.III);
        }
      }
    }
  } catch (e) {
    console.warn(e);
  }

persistSheetFromDom().catch(() => setSheetMsg('保存に失敗しました。', true));
});
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        el.blur(); // フォーカスを外して保存トリガー
      }
    });
// 日付列（カレンダー入力）
sheetTable.querySelectorAll('input.date-input').forEach(inp => {
  inp.addEventListener('change', async () => {
    try {
      const c = Number(inp.getAttribute('data-c'));
      const rowIdx = Number(inp.getAttribute('data-idx'));
      const iso = (inp.value || '').trim();     // YYYY-MM-DD
      const slash = normalizeDateSlash(iso);    // YYYY/MM/DD

      if (!Number.isFinite(rowIdx) || rowIdx < 0) return;
      if (!sheetAllRows[rowIdx]) return;

      sheetAllRows[rowIdx][c] = slash;

      // 入院日変更なら入院日数も更新
      if (c === COL_ADMIT_DATE) {
        const days = calcAdmitDays(slash);
        sheetAllRows[rowIdx][COL_ADMIT_DAYS] = days;
      }

      const session = loadSession();
      if (session?.userId && currentWard) {
        await setSheetRows(session.userId, currentWard.id, sheetAllRows);
      }

      setSheetMsg('保存しました。');
      updateOccupancyUI();
      applySearchAndSort();
    } catch (e) {
      console.warn(e);
      setSheetMsg('日付の保存に失敗しました。', true);
    }
  });
});


  });


  // ベッドNo列クリックでタイプ選択
  sheetTable.querySelectorAll('.bed-no-cell').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showBedTypeSelector(el);
    });
  });
}

// ベッドタイプ選択UIを表示
function showBedTypeSelector(el) {
  // 既存のセレクタを削除
  document.querySelectorAll('.bed-type-selector').forEach(s => s.remove());
  
  const rowIdx = Number(el.getAttribute('data-idx'));
  const raw = el.getAttribute('data-raw') || '';
  const parsed = parseBedNo(raw);
  
  // 子セル（-2, -3, -4）はクリック不可
  if (parsed.slot > 1) {
    return;
  }
  
  // 現在の番号（デフォルトは行番号+1）
  const currentNum = parsed.num || String(rowIdx + 1);
  
  const selector = document.createElement('div');
  selector.className = 'bed-type-selector';
  selector.innerHTML = `
    <div class="bed-type-num-input">
      <label>番号：<input type="text" class="bed-num-input" value="${currentNum}" /></label>
    </div>
    <div class="bed-type-divider"></div>
    <div class="bed-type-option" data-type="${BED_TYPES.PRIVATE}">個室</div>
    <div class="bed-type-option" data-type="${BED_TYPES.DOUBLE}">二人床</div>
    <div class="bed-type-option" data-type="${BED_TYPES.QUAD}">四人床</div>
    <div class="bed-type-divider"></div>
    <div class="bed-type-option bed-type-clear" data-type="clear">消去</div>
  `;
  
  // 位置設定
  const rect = el.getBoundingClientRect();
  selector.style.position = 'absolute';
  selector.style.left = `${rect.left + window.scrollX}px`;
  selector.style.top = `${rect.bottom + window.scrollY + 4}px`;
  
  document.body.appendChild(selector);
  
  // 番号入力欄の参照
  const numInput = selector.querySelector('.bed-num-input');
  
  // 選択イベント
  selector.querySelectorAll('.bed-type-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const type = opt.getAttribute('data-type');
      const inputNum = (numInput?.value || '').trim() || String(rowIdx + 1);
      
      if (type === 'clear') {
        clearBedNo(rowIdx);
      } else {
        applyBedType(rowIdx, inputNum, type);
      }
      selector.remove();
    });
  });
  
  // 外側クリックで閉じる
  setTimeout(() => {
    document.addEventListener('click', function closeSelector(e) {
      if (!selector.contains(e.target)) {
        selector.remove();
        document.removeEventListener('click', closeSelector);
      }
    });
  }, 0);
}

// ベッドタイプを適用（後続行も自動更新）
async function applyBedType(startIdx, baseNum, type) {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;
  
  const slotCount = type === BED_TYPES.QUAD ? 4 : type === BED_TYPES.DOUBLE ? 2 : 1;
  
  // 開始行のベッドNoを設定
  if (sheetAllRows[startIdx]) {
    sheetAllRows[startIdx][COL_BED_NO] = slotCount > 1 ? `${baseNum}:${type}` : baseNum;
  }
  
  // 二人床・四人床の場合、後続行を子セルとして設定
  for (let i = 1; i < slotCount; i++) {
    const targetIdx = startIdx + i;
    if (targetIdx < sheetAllRows.length && sheetAllRows[targetIdx]) {
      // 後続行のベッドNoを「番号-slot」形式に
      sheetAllRows[targetIdx][COL_BED_NO] = `${baseNum}-${i + 1}`;
    }
  }
  
await setSheetRows(session.userId, currentWard.id, sheetAllRows);
  setSheetMsg('ベッドタイプを変更しました。');
  applySearchAndSort();
}

// ベッドNoを消去（グループの子セルも連動消去）
async function clearBedNo(rowIdx) {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;
  
  if (!sheetAllRows[rowIdx]) return;
  
  const raw = sheetAllRows[rowIdx][COL_BED_NO];
  const parsed = parseBedNo(raw);
  
  // 親セルの場合、タイプに応じて子セルも消去
  let slotCount = 1;
  if (parsed.type === BED_TYPES.QUAD) {
    slotCount = 4;
  } else if (parsed.type === BED_TYPES.DOUBLE) {
    slotCount = 2;
  }
  
  // 親セルを消去
  sheetAllRows[rowIdx][COL_BED_NO] = '';
  
  // 子セルを消去（-2, -3, -4）
  for (let i = 1; i < slotCount; i++) {
    const targetIdx = rowIdx + i;
    if (targetIdx < sheetAllRows.length && sheetAllRows[targetIdx]) {
      const childRaw = sheetAllRows[targetIdx][COL_BED_NO];
      const childParsed = parseBedNo(childRaw);
      // 同じ番号の子セルのみ消去
      if (childParsed.num === parsed.num && childParsed.slot > 0) {
        sheetAllRows[targetIdx][COL_BED_NO] = '';
      }
    }
  }
  
  await setSheetRows(session.userId, currentWard.id, sheetAllRows);
  setSheetMsg('ベッドNoを消去しました。');
  applySearchAndSort();
}

async function persistSheetFromDom() {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  const rowEls = Array.from(sheetTable.querySelectorAll('tbody tr'));
  rowEls.forEach((tr) => {
    const idx = Number(tr.getAttribute('data-idx'));
    if (!Number.isFinite(idx) || idx < 0) return;

    const cells = Array.from(tr.querySelectorAll('.cell'));
    const row = cells.map(div => (div.textContent ?? '').trimEnd());

    while (row.length < SHEET_COLUMNS.length) row.push('');
    if (row.length > SHEET_COLUMNS.length) row.length = SHEET_COLUMNS.length;

    sheetAllRows[idx] = row;
  });

  await setSheetRows(session.userId, currentWard.id, sheetAllRows);
  setSheetMsg('保存しました。');
  updateOccupancyUI();
}


async function applyBedCount(count) {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  const n = Math.max(0, Math.min(200, Number(count)));

  sheetAllRows = Array.isArray(sheetAllRows) ? sheetAllRows : [];

  // 増やす：空行を追加
  if (sheetAllRows.length < n) {
    while (sheetAllRows.length < n) {
      const rIdx = sheetAllRows.length;
const row = Array.from({ length: SHEET_COLUMNS.length }, () => '');
row[COL_BED_NO] = String(rIdx + 1);
sheetAllRows.push(row);

    }
  }

  // 減らす：末尾から削る
  if (sheetAllRows.length > n) {
    sheetAllRows.length = n;
  }

  await setSheetRows(session.userId, currentWard.id, sheetAllRows);

  setSheetMsg(`病床数を ${n} 床に設定しました。`);
  applySearchAndSort();
  updateOccupancyUI();
}



async function clearSheet() {
  const session = loadSession();
  if (!session?.userId || !currentWard) return;

  sheetAllRows = makeEmptyRows(3);
  await setSheetRows(session.userId, currentWard.id, sheetAllRows);

  setSheetMsg('クリアしました。');
  applySearchAndSort();
  updateOccupancyUI();
}


// ===== 退院調整機能 ===== 
const COL_EST_DISCHARGE = 10;  // 退院見込み
const COL_NURSING = 9;         // 看護必要度

/**
 * シートデータをWardOccupancyIdealizer用の患者配列に変換
 */
function convertRowsToPatients(rows, wardName) {
  return (rows || [])
    .map((row, idx) => {
      const patientId = String(row[COL_PATIENT_ID] ?? '').trim();
      const dpcCode = String(row[COL_DPC] ?? '').trim();
      const admitDate = String(row[COL_ADMIT_DATE] ?? '').trim();
      const estDischarge = String(row[COL_EST_DISCHARGE] ?? '').trim();
      
      if (!patientId || !estDischarge) return null;
      
      return {
        patient_key: patientId,
        ward: wardName || 'ALL',
        dpc_code: dpcCode,
        adm_date: admitDate,
        los_today: String(row[COL_ADMIT_DAYS] ?? '').trim(),
        nursing_acuity: String(row[COL_NURSING] ?? '').trim(),
        est_discharge_date: estDischarge,
        discharge_ready_flag: '',
        notes_flag: '',
        _rowIdx: idx,
      };
    })
    .filter(Boolean);
}

/**
 * DPC_MASTERからdpcMasterマップを構築
 */
function buildDpcMasterMap() {
  const master = window.DPC_MASTER;
  if (!master?.list) return {};
  
  const map = {};
  master.list.forEach(item => {
    map[item.code] = {
      dpc_name: item.name,
      L_std: item.I || 14,
      L_max: item.III || 30,
    };
  });
  return map;
}

/**
 * 退院調整実行
 */
function runDischargeOptimize() {
  const WOI = window.WardOccupancyIdealizer;
  if (!WOI) {
    setSheetMsg('退院調整モジュールが読み込まれていません。', true);
    return;
  }
  
  const patients = convertRowsToPatients(sheetAllRows, currentWard?.name);
  
  if (patients.length === 0) {
    setSheetMsg('退院見込み日が入力されている患者がいません。', true);
    return;
  }
  
  const dpcMaster = buildDpcMasterMap();
  const asOfDate = todayJSTIsoDate();
  
  const constraints = {
    ALL: {
      beds: sheetAllRows.length,
      target_occupancy: 0.85,
      hard_no_discharge_weekdays: '日',
      weekday_weights: { '日': 10, '土': 6 },
      ER_avg: 2,
      scoring_weights: { w_dpc: 40, w_cap: 35, w_n: 10, w_adj: 10, w_wk: 10, w_dev: 5 },
      risk_params: { cap_th1: 0.85, cap_th2: 0.95, nurse_max: 5 },
    }
  };
  
  try {
    const recommendations = WOI.buildRecommendations(patients, {
      dpcMaster,
      constraints,
      asOfDate,
      topN: 3,
      candidateRangeDays: 7,
    });
    
    showDischargeRecommendations(recommendations, patients);
  } catch (e) {
    console.error('退院調整エラー:', e);
    setSheetMsg('退院調整の計算中にエラーが発生しました。', true);
  }
}

/**
 * 退院候補日モーダルを表示
 */
function showDischargeRecommendations(recommendations, patients) {
  document.querySelectorAll('.discharge-modal-overlay').forEach(m => m.remove());
  
  const overlay = document.createElement('div');
  overlay.className = 'discharge-modal-overlay';
  
  const modal = document.createElement('div');
  modal.className = 'discharge-modal';
  
  const header = document.createElement('div');
  header.className = 'discharge-modal-header';
  header.innerHTML = `
    <h3>退院候補日一覧</h3>
    <button class="discharge-modal-close" type="button">✕</button>
  `;
  modal.appendChild(header);
  
  const content = document.createElement('div');
  content.className = 'discharge-modal-content';
  
  if (recommendations.length === 0) {
    content.innerHTML = '<p class="muted">候補日を算出できる患者がいません。</p>';
  } else {
    recommendations.forEach((rec, i) => {
      const card = document.createElement('div');
      card.className = 'discharge-card';
      
      const topList = (rec.top || []).map((c, idx) => {
        const rank = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
        return `
          <div class="discharge-candidate ${idx === 0 ? 'best' : ''}">
            <span class="rank">${rank}</span>
            <span class="date">${c.date_iso}（${c.weekday}）</span>
            <span class="score">スコア: ${c.score_total}</span>
            <span class="detail">
              DPC: ${c.F_dpc} / 逼迫: ${c.F_cap} / LOS: ${c.los}日
            </span>
          </div>
        `;
      }).join('');
      
      const rationale = rec.rationale || {};
      const rationaleText = [
        rationale.dpc,
        rationale.cap,
        rationale.weekday,
        rationale.note
      ].filter(Boolean).join('・');
      
      card.innerHTML = `
        <div class="discharge-card-header">
          <span class="patient-id">${escapeHtml(rec.patient_key)}</span>
          <span class="dpc-code">${escapeHtml(rec.dpc_code || '---')}</span>
        </div>
        <div class="discharge-card-body">
          ${topList || '<p class="muted">候補なし</p>'}
        </div>
        ${rationaleText ? `<div class="discharge-rationale">${escapeHtml(rationaleText)}</div>` : ''}
      `;
      
      content.appendChild(card);
    });
  }
  
  modal.appendChild(content);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  
  overlay.querySelector('.discharge-modal-close')?.addEventListener('click', () => {
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  
  setSheetMsg(`${recommendations.length}名の退院候補日を算出しました。`);
}

// ===== Public API（app.js から呼ぶ） =====
function render(userId) {
  // 病棟一覧を描画（ログイン中に wardView を表示している想定）
  renderWardButtons(userId);
}

function reset() {
  currentWard = null;
  sheetAllRows = [];
  sheetViewRows = [];
  sortState = { col: -1, dir: 0 };
  setWardMsg('');
  setSheetMsg('');
  if (wardGrid) wardGrid.innerHTML = '';
  if (sheetSearch) sheetSearch.value = '';
}

window.BMWard = { render, reset };

// ===== Events（1回だけバインド） =====
btnAddWard?.addEventListener('click', () => {
  const session = loadSession();
  if (!session?.userId) return;
  addWardForUser(session.userId);
});

btnBackToWards?.addEventListener('click', () => backToWards());
btnClearSheet?.addEventListener('click', () => clearSheet());
btnDischargeOptimize?.addEventListener('click', () => runDischargeOptimize());

// 病床数の変更で行数を増減
inputBedCount?.addEventListener('change', () => {
  applyBedCount(inputBedCount.value);
});



sheetSearch?.addEventListener('input', () => applySearchAndSort());

// ✅ 起動時：DBを先に開いておく（失敗しても致命ではない）
(async function bootstrapWard() {

  try {
    await ensureDb();
  } catch (e) {
    console.error(e);
    setSheetMsg(
      'データベースの初期化に失敗しました。ブラウザのストレージ制限やプライベートモードの可能性があります。',
      true
    );
  }
})();

})();
