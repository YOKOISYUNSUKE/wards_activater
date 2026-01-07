'use strict';

/**
 * ward_occupancy_idealizer.js
 *
 * 目的：
 * - GAS(gas.gs) の「退院日候補生成＆スコアリング」を、GASを使わない純JSに移植。
 * - Excel（Settings / Constraints / DPC_Master / Patients）のパラメータ構造に合わせる。
 *
 * 方針：
 * - 入出力は「配列（表） or オブジェクト」で扱う（UI/保存/APIは持たない）
 * - 日付はローカルTZに左右されにくいよう、基本は "YYYY-MM-DD" を推奨
 */

/** =========================
 *  ユーティリティ
 *  ========================= */

/** "yyyy-MM-dd" または "yyyy/MM/dd" を Date(ローカル0:00) にする */
function parseIsoDateLoose(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date && !isNaN(dateStr.getTime())) {
    const d = new Date(dateStr.getTime());
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (typeof dateStr !== 'string') return null;

  const s = dateStr.trim();
  const m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const da = Number(m[3]);
  const d = new Date(y, mo, da);
  d.setHours(0, 0, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/** Date -> "YYYY-MM-DD" */
function formatIsoDate(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

/** 2つの日付差（d2 - d1）を「日」で返す（d1,d2は0:00前提） */
function diffDays(d1, d2) {
  const ms = d2.getTime() - d1.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/** 安全なJSON parse（失敗時 fallback） */
function safeJsonParse(raw, fallback) {
  try {
    if (raw == null || raw === '') return fallback;
    if (typeof raw === 'object') return raw; // すでにobjectならそのまま
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

/** 曜日名（gas.gs に合わせて 日/月/火/水/木/金/土） */
const WEEKDAY_NAMES_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** =========================
 *  Excel相当のパース
 *  ========================= */

/**
 * Settingsシート相当の key-value を受け取り settings object にする
 * 例（2列の表）:
 * [
 *   ["w_dpc", 40],
 *   ["cap_th1", 0.85],
 *   ...
 * ]
 */
function parseSettingsKeyValue(rows) {
  const settings = {};
  (rows || []).forEach((r) => {
    const k = r?.[0];
    const v = r?.[1];
    if (!k) return;
    const key = String(k).trim();
    if (!key || key.startsWith('【')) return;
    settings[key] = v;
  });
  return settings;
}

/**
 * DPC_Master相当（ヘッダ付き表）→ { [code]: { dpc_name, L_std, L_max } }
 * 例ヘッダ：["dpc_code","dpc_name","L_std","L_max"]
 */
function parseDpcMasterTable(rows, headerRowIndex = 0) {
  const data = rows || [];
  const header = data[headerRowIndex] || [];
  const col = (name) => header.indexOf(name);

  const cCode = col('dpc_code');
  const cName = col('dpc_name');
  const cStd = col('L_std');
  const cMax = col('L_max');

  const master = {};
  for (let i = headerRowIndex + 1; i < data.length; i++) {
    const r = data[i];
    const code = String(r?.[cCode] ?? '').trim();
    if (!code) continue;
    master[code] = {
      dpc_name: r?.[cName] ?? '',
      L_std: Number(r?.[cStd] ?? 14),
      L_max: Number(r?.[cMax] ?? 30),
    };
  }
  return master;
}

/**
 * Constraints相当（ヘッダ付き）→ { [ward]: constraintObj }
 * ヘッダ（Excel一致）:
 * ["ward","beds","target_occupancy","hard_no_discharge_weekdays","discharge_cutoff_time","weekday_weights","ER_avg","scoring_weights","risk_params"]
 */
function parseConstraintsTable(rows, headerRowIndex = 0) {
  const data = rows || [];
  const header = data[headerRowIndex] || [];
  const col = (name) => header.indexOf(name);

  const cWard = col('ward');
  const cBeds = col('beds');
  const cTarget = col('target_occupancy');
  const cHardNo = col('hard_no_discharge_weekdays');
  const cWkWeights = col('weekday_weights');
  const cErAvg = col('ER_avg');
  const cScoreW = col('scoring_weights');
  const cRisk = col('risk_params');

  const constraints = {};
  for (let i = headerRowIndex + 1; i < data.length; i++) {
    const r = data[i];
    const ward = String(r?.[cWard] ?? '').trim();
    if (!ward) continue;

    constraints[ward] = {
      beds: Number(r?.[cBeds] ?? 0),
      target_occupancy: Number(r?.[cTarget] ?? 0.85),
      hard_no_discharge_weekdays: r?.[cHardNo] ?? '',
      weekday_weights: safeJsonParse(r?.[cWkWeights], {}),
      ER_avg: Number(r?.[cErAvg] ?? 0),
      scoring_weights: safeJsonParse(r?.[cScoreW], { w_dpc: 40, w_cap: 35, w_adj: 10, w_wk: 10, w_dev: 5 }),
      risk_params: safeJsonParse(r?.[cRisk], { cap_th1: 0.85, cap_th2: 0.95 }),

    };
  }
  return constraints;
}

/**
 * Patients相当（ヘッダ付き）→ patient objects
 * gas.gs に寄せたキー:
 * - patient_key, ward, dpc_code, adm_date, los_today, nursing_acuity, est_discharge_date, discharge_ready_flag, notes_flag
 */
function parsePatientsTable(rows, headerRowIndex = 0) {
  const data = rows || [];
  const header = data[headerRowIndex] || [];
  const col = (name) => header.indexOf(name);

  // 想定ヘッダ（Excel側が違う可能性があるので、必要なら呼び出し側で整形）
  const cKey = col('patient_key');
  const cWard = col('ward');
  const cDpc = col('dpc_code');
  const cAdm = col('adm_date');
  const cLos = col('los_today');
  const cNA = col('nursing_acuity');
  const cEdd = col('est_discharge_date');
  const cReady = col('discharge_ready_flag');
  const cNote = col('notes_flag');

  const out = [];
  for (let i = headerRowIndex + 1; i < data.length; i++) {
    const r = data[i];
    const key = r?.[cKey];
    if (!key) continue;

    out.push({
      patient_key: String(key).trim(),
      ward: String(r?.[cWard] ?? '').trim(),
      dpc_code: String(r?.[cDpc] ?? '').trim(),
      adm_date: r?.[cAdm] ?? '',
      los_today: r?.[cLos] ?? '',
      nursing_acuity: r?.[cNA] ?? '',
      est_discharge_date: r?.[cEdd] ?? '',
      discharge_ready_flag: r?.[cReady] ?? '',
      notes_flag: r?.[cNote] ?? '',
    });
  }
  return out;
}

/** =========================
 *  as-of / LOS（入院日数）
 *  ========================= */

/**
 * gas.gs の resolveAsOfDate_() 相当
 * - asOfIso が指定されなければ today を採用
 * - 返すDateは0:00固定
 */
function resolveAsOfDate(asOfIso) {
  if (asOfIso == null || asOfIso === '') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const d = parseIsoDateLoose(asOfIso);
  if (!d) {
    throw new Error("asOfIso は 'yyyy-MM-dd' または 'yyyy/MM/dd' で指定してください: " + String(asOfIso));
  }
  return d;
}

/**
 * gas.gs の loadPatients() の los_today補完に寄せる
 * - row.los_today が空なら、asOf - adm_date の日数を計算（負は0）
 */
function normalizePatientsLos(patients, asOfDate) {
  const base = resolveAsOfDate(asOfDate);
  return (patients || []).map((p) => {
    const losRaw = p?.los_today;
    const hasLos = !(losRaw == null || losRaw === '');
    if (hasLos) return { ...p, los_today: Number(losRaw) };

    const adm = parseIsoDateLoose(p?.adm_date);
    if (!adm) return { ...p, los_today: 0 };

    const los = Math.max(0, diffDays(adm, base));
    return { ...p, los_today: los };
  });
}

/** =========================
 *  稼働率（Forecast）の受け渡し
 *  ========================= */

/**
 * 候補日に対する稼働率を返す関数を作る
 * - forecastMap: { "YYYY-MM-DD": 0.91, ... } のような辞書（任意）
 * - fallbackRate: 見つからない場合に使う値（gas.gsの暫定0.85に寄せる）
 */
function makeOccupancyProvider({ forecastMap, fallbackRate = 0.85 } = {}) {
  const map = forecastMap || {};
  return (dateObj) => {
    const k = formatIsoDate(dateObj);
    const v = map[k];
    const n = Number(v);
    return Number.isFinite(n) ? n : fallbackRate;
  };
}

/** =========================
 *  スコアリング（gas.gs generateCandidateDates の移植）
 *  ========================= */

/**
 * 1患者について、見込み日の±7日（計15日）から候補を作ってスコアリング
 * - gas.gs と同じ：candidateDate <= asOfDate は除外
 *
 * options:
 * - candidateRangeDays: 7（±7）
 * - occupancyProvider: (date)->rate
 */
function generateCandidateDates(patient, { settings, dpcMaster, constraints, asOfDate, occupancyProvider, candidateRangeDays = 7 } = {}) {
  const candidates = [];

  const baseAsOf = resolveAsOfDate(asOfDate);
  const estDate = parseIsoDateLoose(patient?.est_discharge_date);
  const admDate = parseIsoDateLoose(patient?.adm_date);

  if (!estDate || !admDate) return candidates;

  const wardKey = patient?.ward || 'ALL';
  const wardConstraints = (constraints && (constraints[wardKey] || constraints.ALL)) || {};
  const weights = wardConstraints.scoring_weights || (settings || {});
  const riskParams = wardConstraints.risk_params || (settings || {});

  const getOcc = occupancyProvider || makeOccupancyProvider({ fallbackRate: 0.85 });

  for (let offset = -candidateRangeDays; offset <= candidateRangeDays; offset++) {
    const candidateDate = new Date(estDate.getTime());
    candidateDate.setDate(candidateDate.getDate() + offset);
    candidateDate.setHours(0, 0, 0, 0);

    // 過去日はスキップ（candidateDate <= asOfDate は除外）
    if (candidateDate.getTime() <= baseAsOf.getTime()) continue;

    // LOS（入院日数）: gas.gs は ceil((candidate - adm)/1day)
    const los = Math.ceil((candidateDate.getTime() - admDate.getTime()) / (1000 * 60 * 60 * 24));

    const dpcInfo = (dpcMaster && dpcMaster[patient?.dpc_code]) || { L_std: 14, L_max: 30 };

    // DPC適合度
    let F_dpc = 0;
    if (los <= Number(dpcInfo.L_std ?? 14)) F_dpc = 100;
    else if (los <= Number(dpcInfo.L_max ?? 30)) F_dpc = 70;
    else F_dpc = 30;

    // 病床逼迫貢献度（稼働率に依存）
    const occupancyRate = Number(getOcc(candidateDate));
    const cap_th1 = Number(riskParams.cap_th1 ?? 0.85);
    const cap_th2 = Number(riskParams.cap_th2 ?? 0.95);

    let F_cap = 0;
    if (occupancyRate >= cap_th2) F_cap = 100;
    else if (occupancyRate >= cap_th1) F_cap = 70;
    else F_cap = Math.round((1 - occupancyRate) * 100);


    // 曜日ペナルティ（gas.gs は土日だけ）
    const dayOfWeek = candidateDate.getDay();
    const dayName = WEEKDAY_NAMES_JA[dayOfWeek];

    const weekdayWeights = wardConstraints.weekday_weights || {};
    let P_hard = 0;
    if (dayOfWeek === 0) P_hard = Number(weekdayWeights['日'] ?? 10);
    if (dayOfWeek === 6) P_hard = Number(weekdayWeights['土'] ?? 6);

    // 退院調整リスク
    const P_risk = (patient?.discharge_ready_flag === '調整中') ? 100 : 0;

    // 見込み日乖離
    const deviation = Math.abs(offset);
    const F_ops = deviation * 2;

    // 変動数ペナルティ（変動許容範囲を超える場合）
    const fluctuation_limit = Number(wardConstraints.fluctuation_limit ?? 3);
    let P_fluctuation = 0;
    if (Math.abs(offset) > fluctuation_limit) {
      P_fluctuation = (Math.abs(offset) - fluctuation_limit) * 5;
    }

    // 緊急入院吸収余力（gas.gs: (1-occ) * ER_avg * 20）
    const ER_avg = Number(wardConstraints.ER_avg ?? 0);
    const F_er = Math.round((1 - occupancyRate) * ER_avg * 20);

    // 総合スコア計算（gas.gsの式をそのまま）
const w_dpc = Number(weights.w_dpc ?? 40);
const w_cap = Number(weights.w_cap ?? 35);
const w_adj = Number(weights.w_adj ?? 10);
const w_wk = Number(weights.w_wk ?? 10);
const w_dev = Number(weights.w_dev ?? 5);

const score_total =
  w_dpc * (F_dpc / 100) * 40 +
  w_cap * (F_cap / 100) * 35 -
  w_adj * (P_risk / 100) * 10 -
  w_wk * P_hard -
  w_dev * (F_ops / 100) * 5 -
  P_fluctuation;


    // ハード制約：退院不可曜日
    let hard_ng_reason = '';
    const hardNoDays = wardConstraints.hard_no_discharge_weekdays;

    const noDaysList = Array.isArray(hardNoDays)
      ? hardNoDays
      : String(hardNoDays || '').split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);

    if (noDaysList.includes(dayName)) {
      hard_ng_reason = '曜日制約違反';
    }

    candidates.push({
      date: new Date(candidateDate.getTime()),
      date_iso: formatIsoDate(candidateDate),

      // 主要スコア
      F_dpc,
      F_cap,
      F_acu,
      F_ops,
      F_er,
      P_risk,
      P_hard,
      P_fluctuation,

      // 参考
      occupancyRate,
      los,

      score_total: Math.round(score_total * 10) / 10,
      hard_ng_reason,
      offset_from_est: offset,
      weekday: dayName,
    });
  }

  return candidates;
}

/**
 * 患者ごとの上位N候補を返す（ハードNGは除外）
 */
function pickTopCandidates(candidates, topN = 3) {
  return (candidates || [])
    .filter(c => !c.hard_ng_reason)
    .sort((a, b) => Number(b.score_total) - Number(a.score_total))
    .slice(0, topN);
}

/**
 * 推奨理由（超軽量・gas.gsのgenerateRationale相当）
 */
function generateRationale(patient, topCandidates) {
  const c0 = topCandidates?.[0];
  if (!c0) return { dpc: '', cap: '', weekday: '' };

  return {
    dpc: (c0.F_dpc >= 70) ? '期間I/II内' : '期間超過',
    cap: (c0.F_cap >= 70) ? '逼迫緩和効果高' : '逼迫緩和効果中',
    weekday: (c0.P_hard === 0) ? '平日' : '週末',
    note: (patient?.discharge_ready_flag === '調整中') ? '退院調整中のため要確認' : '',
  };
}

/** =========================
 *  まとめて回す（患者一覧→推奨）
 *  ========================= */

/**
 * buildRecommendations:
 * - 患者配列を受け取り、患者ごとに候補と上位案を返す
 *
 * returns:
 * [
 *   {
 *     patient_key,
 *     ward,
 *     dpc_code,
 *     candidates: [...],
 *     top: [...],
 *     rationale: {...}
 *   }
 * ]
 */
function buildRecommendations(patients, { settings, dpcMaster, constraints, asOfDate, occupancyProvider, topN = 3, candidateRangeDays = 7 } = {}) {
  const normalized = normalizePatientsLos(patients || [], asOfDate);

  return normalized.map((p) => {
    const candidates = generateCandidateDates(p, {
      settings,
      dpcMaster,
      constraints,
      asOfDate,
      occupancyProvider,
      candidateRangeDays,
    });

    const top = pickTopCandidates(candidates, topN);
    const rationale = generateRationale(p, top);

    return {
      patient_key: p.patient_key,
      ward: p.ward,
      dpc_code: p.dpc_code,

      candidates,
      top,
      rationale,
    };
  });
}

/** =========================
 *  エクスポート（ブラウザ/Node両対応）
 *  ========================= */
const WardOccupancyIdealizer = {
  // parse
  parseSettingsKeyValue,
  parseDpcMasterTable,
  parseConstraintsTable,
  parsePatientsTable,

  // core
  resolveAsOfDate,
  normalizePatientsLos,
  makeOccupancyProvider,

  generateCandidateDates,
  pickTopCandidates,
  generateRationale,
  buildRecommendations,

  // utils（必要なら）
  parseIsoDateLoose,
  formatIsoDate,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WardOccupancyIdealizer };
} else {
  // eslint-disable-next-line no-undef
  window.WardOccupancyIdealizer = WardOccupancyIdealizer;
}
