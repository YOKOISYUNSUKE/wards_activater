'use strict';

/**
 * ward-kpi.js
 * KPI計算（病棟KPI / 病院全体KPI）
 */

(function () {

  const {
    COL_PATIENT_ID,
    COL_ADMIT_DATE,
    COL_ADMIT_DAYS,
    COL_NURSING,
    loadSession,
    todayJSTIsoDate,
    calcAdmitDays,
    getWardsForUser,
    getSheetRows,
    ensureDb,
  } = window.WardCore;

  // ===== 稼働率 =====
  function calcOccupancyFromRows(rows) {
    const bedCount = Array.isArray(rows) ? rows.length : 0;
    const inpatients = (rows || []).reduce((acc, row) => {
      const pid = String(row?.[COL_PATIENT_ID] ?? '').trim();
      return acc + (pid ? 1 : 0);
    }, 0);
    const percent = bedCount > 0 ? (inpatients / bedCount) * 100 : 0;
    return { inpatients, bedCount, percent };
  }

  function updateOccupancyUI(sheetAllRows) {
    const fracEl = document.getElementById('occFraction');
    const pctEl = document.getElementById('occPercent');
    if (!fracEl || !pctEl) return;

    const { inpatients, bedCount, percent } = calcOccupancyFromRows(sheetAllRows);
    fracEl.textContent = `${inpatients}/${bedCount}`;
    pctEl.textContent = `${Math.round(percent)}%`;
  }

  // ===== 平均在院日数 =====
  function calcAvgLosFromRows(rows) {
    const items = (rows || []).filter(r => String(r?.[COL_PATIENT_ID] ?? '').trim());
    const n = items.length;
    if (n === 0) return { n: 0, avg: null };

    let sum = 0;
    let cnt = 0;
    items.forEach(r => {
      const v = Number(String(r?.[COL_ADMIT_DAYS] ?? '').trim());
      if (Number.isFinite(v) && v > 0) { sum += v; cnt += 1; }
    });

    if (cnt === 0) return { n, avg: null };
    return { n, avg: sum / cnt };
  }

  function updateLosUI(sheetAllRows) {
    const nEl = document.getElementById('losInpatients');
    const avgEl = document.getElementById('losAvg');
    if (!nEl || !avgEl) return;

    const { n, avg } = calcAvgLosFromRows(sheetAllRows);
    nEl.textContent = `${n}名`;

    if (avg === null) {
      avgEl.textContent = '-日';
    } else {
      avgEl.textContent = `${avg.toFixed(1)}日`;
    }
  }

  // ===== 看護必要度 KPI（3ヶ月：延べ患者） =====
  function parseNursingCell(val) {
    const s = String(val ?? '').trim();
    if (!s) return null;

    const mNew = s.match(/^A(\d+)\s*\/\s*B(\d+)\s*\/\s*C(\d+)$/);
    if (mNew) {
      const a = Number(mNew[1]);
      const b = Number(mNew[2]);
      const c = Number(mNew[3]);
      if (![a, b, c].every(Number.isFinite)) return null;
      return { total: a + b + c, a, b, c };
    }

    const mOld = s.match(/A(\d+)\s*\/\s*B(\d+)\s*\/\s*C(\d+)/i);
    if (mOld) {
      const a = Number(mOld[1]);
      const b = Number(mOld[2]);
      const c = Number(mOld[3]);
      if (![a, b, c].every(Number.isFinite)) return null;
      return { total: a + b + c, a, b, c };
    }

    return null;
  }

  function nursingKpiDayKey(userId, wardId, isoDate) {
    return `bm_nursing_kpi_day_v1|${userId}|${wardId}|${isoDate}`;
  }

  function isNursingKpiQualified(a, b, c) {
    const A = Number(a) || 0;
    const B = Number(b) || 0;
    const C = Number(c) || 0;

    const cond1 = (A >= 2 && B >= 3);
    const cond2 = (A >= 3);
    const cond3 = (C >= 1);

    return (cond1 || cond2 || cond3);
  }

  function recordNursingKpiForToday(userId, wardId, rows) {
    const iso = todayJSTIsoDate(); // YYYY-MM-DD
    const inpatients = (rows || []).filter(r => String(r?.[COL_PATIENT_ID] ?? '').trim());

    const denom = inpatients.length;

    let num = 0;
    inpatients.forEach(r => {
      const parsed = parseNursingCell(r?.[COL_NURSING]);
      if (!parsed) return;
      if (isNursingKpiQualified(parsed.a, parsed.b, parsed.c)) num += 1;
    });

    const key = nursingKpiDayKey(userId, wardId, iso);
    localStorage.setItem(key, JSON.stringify({ denom, num }));
  }

  function listLastNDaysIso(nDays) {
    const out = [];
    const base = new Date(todayJSTIsoDate());
    base.setHours(0, 0, 0, 0);

    for (let i = 0; i < nDays; i++) {
      const d = new Date(base.getTime());
      d.setDate(d.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      out.push(`${y}-${m}-${da}`);
    }
    return out;
  }

  function sumNursingKpiLastNDays(userId, wardId, nDays) {
    const days = listLastNDaysIso(nDays);
    let denomSum = 0;
    let numSum = 0;
    let availableDays = 0;

    days.forEach(iso => {
      const key = nursingKpiDayKey(userId, wardId, iso);
      const raw = localStorage.getItem(key);
      if (!raw) return;
      try {
        const obj = JSON.parse(raw);
        const d = Number(obj?.denom) || 0;
        const n = Number(obj?.num) || 0;
        denomSum += d;
        numSum += n;
        availableDays += 1;
      } catch { }
    });

    const rate = denomSum > 0 ? (numSum / denomSum) * 100 : null;
    return { denomSum, numSum, rate, availableDays };
  }

  function updateNursingUI(currentWard) {
    const avgEl = document.getElementById('nursingAvg');
    const subEl = document.getElementById('nursingAvgAbc');
    if (!avgEl || !subEl) return;

    const session = loadSession();
    if (!session?.userId || !currentWard) {
      avgEl.textContent = '-%';
      subEl.textContent = '-/- (3ヶ月)';
      return;
    }

    const k = sumNursingKpiLastNDays(session.userId, currentWard.id, 90);

    if (k.rate === null) {
      avgEl.textContent = '-%';
      subEl.textContent = '-/- (3ヶ月)';
      return;
    }

    avgEl.textContent = `${k.rate.toFixed(1)}%`;
    subEl.textContent = `${k.numSum}/${k.denomSum} (3ヶ月)`;

    if (k.availableDays < 90) {
      subEl.textContent = `${k.numSum}/${k.denomSum} (${k.availableDays}日分)`;
    }
  }

  function updateWardKpiUI(sheetAllRows, currentWard) {
    updateLosUI(sheetAllRows);
    updateNursingUI(currentWard);
    updateOccupancyUI(sheetAllRows);
  }

  // ===== 病院全体KPI（全病棟合算） =====
  async function computeHospitalKpi(userId) {
    const wards = getWardsForUser(userId);

    let bedCount = 0;
    let inpatients = 0;

    let losSum = 0;
    let losCnt = 0;

    let nkDenom = 0;
    let nkNum = 0;
    let nkAvailDaysMax = 0;

    for (const w of wards) {
      const rows = await getSheetRows(userId, w.id);
      bedCount += Array.isArray(rows) ? rows.length : 0;

      (rows || []).forEach(row => {
        const pid = String(row?.[COL_PATIENT_ID] ?? '').trim();
        if (!pid) return;
        inpatients++;

        const admitDate = String(row?.[COL_ADMIT_DATE] ?? '').trim();
        const los = Number(calcAdmitDays(admitDate));
        if (Number.isFinite(los) && los > 0) {
          losSum += los;
          losCnt++;
        }
      });

      const k = sumNursingKpiLastNDays(userId, w.id, 90);
      nkDenom += k.denomSum;
      nkNum += k.numSum;
      nkAvailDaysMax = Math.max(nkAvailDaysMax, k.availableDays);
    }

    const nkRate = nkDenom > 0 ? (nkNum / nkDenom) * 100 : null;

    return {
      bedCount,
      inpatients,
      occPercent: bedCount ? (inpatients / bedCount) * 100 : 0,
      losAvg: losCnt ? losSum / losCnt : null,

      nursingKpiNum: nkNum,
      nursingKpiDenom: nkDenom,
      nursingKpiRate: nkRate,
      nursingKpiAvailDays: nkAvailDaysMax,
    };
  }

  function setHospitalKpiUiUnknown() {
    const hospitalLosInpatients = document.getElementById('hospitalLosInpatients');
    const hospitalLosAvg = document.getElementById('hospitalLosAvg');
    const hospitalNursingAvgAbc = document.getElementById('hospitalNursingAvgAbc');
    const hospitalNursingAvg = document.getElementById('hospitalNursingAvg');
    const hospitalOccFraction = document.getElementById('hospitalOccFraction');
    const hospitalOccPercent = document.getElementById('hospitalOccPercent');

    if (hospitalLosInpatients) hospitalLosInpatients.textContent = '-名';
    if (hospitalLosAvg) hospitalLosAvg.textContent = '-日';
    if (hospitalNursingAvgAbc) hospitalNursingAvgAbc.textContent = '-/- (3ヶ月)';
    if (hospitalNursingAvg) hospitalNursingAvg.textContent = '-%';
    if (hospitalOccFraction) hospitalOccFraction.textContent = '0/0';
    if (hospitalOccPercent) hospitalOccPercent.textContent = '0%';
  }

  async function updateHospitalKpiUI(userId) {
    const hospitalLosInpatients = document.getElementById('hospitalLosInpatients');
    const hospitalLosAvg = document.getElementById('hospitalLosAvg');
    const hospitalNursingAvgAbc = document.getElementById('hospitalNursingAvgAbc');
    const hospitalNursingAvg = document.getElementById('hospitalNursingAvg');
    const hospitalOccFraction = document.getElementById('hospitalOccFraction');
    const hospitalOccPercent = document.getElementById('hospitalOccPercent');

    const hasAny = !!(
      hospitalLosInpatients ||
      hospitalLosAvg ||
      hospitalNursingAvgAbc ||
      hospitalNursingAvg ||
      hospitalOccFraction ||
      hospitalOccPercent
    );
    if (!hasAny) return;

    try {
      await ensureDb();
      const k = await computeHospitalKpi(userId);

      if (hospitalLosInpatients) hospitalLosInpatients.textContent = `${k.inpatients}名`;
      if (hospitalLosAvg) hospitalLosAvg.textContent = (k.losAvg === null) ? '-日' : `${k.losAvg.toFixed(1)}日`;

      if (hospitalNursingAvg) {
        hospitalNursingAvg.textContent =
          (k.nursingKpiRate === null) ? '-%' : `${k.nursingKpiRate.toFixed(1)}%`;
      }

      if (hospitalNursingAvgAbc) {
        if (k.nursingKpiRate === null) {
          hospitalNursingAvgAbc.textContent = '-/- (3ヶ月)';
        } else {
          const label =
            (k.nursingKpiAvailDays < 90) ? `${k.nursingKpiAvailDays}日分` : '3ヶ月';
          hospitalNursingAvgAbc.textContent =
            `${k.nursingKpiNum}/${k.nursingKpiDenom} (${label})`;
        }
      }

      if (hospitalOccFraction) hospitalOccFraction.textContent = `${k.inpatients}/${k.bedCount}`;
      if (hospitalOccPercent) hospitalOccPercent.textContent = `${Math.round(k.occPercent)}%`;
    } catch (e) {
      console.warn(e);
      setHospitalKpiUiUnknown();
    }
  }

  window.WardKpi = {
    updateWardKpiUI,
    recordNursingKpiForToday,
    updateHospitalKpiUI,
    setHospitalKpiUiUnknown,
  };

})();
