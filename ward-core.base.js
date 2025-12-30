'use strict';

(() => {

  /**
   * ward-core.base.js
   * 定数・表示ユーティリティ・日付ユーティリティ
   * 依存: なし（副作用なしの層）
   */

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

  // ===== 表示ユーティリティ =====
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
      case BED_TYPES.DOUBLE:
      case BED_TYPES.QUAD:
        return `${p.num}-1`;
      default:
        return p.num;
    }
  }

  function formatBedNoDisplayHtml(val) {
    const p = parseBedNo(val);
    if (p.isEmpty) return '';

    // child（"123-2" 等）: 部屋番号は透明、"-2" は見せる
    if (p.slot > 1) {
      const num = escapeHtml(p.num);
      return `<span class="bed-room-ghost">${num}</span><span class="bed-suffix">-${p.slot}</span>`;
    }

    // 安全策：もし "123-1" が来たら通常表示
    if (p.slot === 1) {
      return `${escapeHtml(p.num)}-1`;
    }

    // base（"123:double" 等）や個室
    switch (p.type) {
      case BED_TYPES.DOUBLE:
      case BED_TYPES.QUAD:
        return `${escapeHtml(p.num)}-1`; // 部屋番号は見える
      default:
        return escapeHtml(p.num); // 個室
    }
  }

  function makeEmptyRows(rowCount = 3) {
    return Array.from({ length: rowCount }, (_, rIdx) => {
      const row = Array.from({ length: SHEET_COLUMNS.length }, () => '');
      row[COL_BED_NO] = String(rIdx + 1);
      return row;
    });
  }

  // ===== グローバル公開 =====
  window.WardCoreBase = {
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
  };

})();
