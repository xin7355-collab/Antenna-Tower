/*
 * groups.js — 地點群組（分類 + 配色）
 * ------------------------------------------------------------------
 * 站臺、山峰、自訂標註都可掛在一個「群組」下，用於：
 *   1. 地圖 marker 與 AR 標籤的顏色區分
 *   2. 面板清單分段顯示
 *   3. 顯示/隱藏整個群組（過濾）
 *
 * 群組不需事先定義：資料裡出現沒看過的 group 字串會自動註冊，
 * 並以 id 雜湊分配一個穩定的顏色（同名永遠同色，不受載入順序影響）。
 * 純函式 + 一份模組內註冊表，無外部相依，可獨立測試。
 */
(function (global) {
  'use strict';

  // 自動配色盤（新群組依 id 雜湊取用，確保同名同色）
  const PALETTE = [
    '#4da3ff', '#35d07f', '#ff8a5b', '#c88bff', '#ffd36b',
    '#7dffcf', '#ff6bd6', '#9fd356', '#ff6161', '#6bb6ff',
  ];

  // 內建群組。id 為資料中使用的值，name 為顯示名稱。
  const BUILTIN = [
    { id: 'north', name: '北部', color: '#4da3ff' },
    { id: 'central', name: '中部', color: '#35d07f' },
    { id: 'south', name: '南部', color: '#ff8a5b' },
    { id: 'east', name: '東部', color: '#c88bff' },
    { id: 'peak', name: '參考山峰', color: '#c9a227' },
    { id: 'custom', name: '自訂站臺', color: '#ffb247' },
    { id: 'mark', name: '自訂標註', color: '#ff6bd6' },
  ];

  // 沒有指定 group 時，依 type 落到哪個群組
  const FALLBACK_BY_TYPE = { station: 'custom', peak: 'peak', marker: 'mark', me: 'me' };

  const registry = new Map();
  BUILTIN.forEach((g) => registry.set(g.id, { ...g, builtin: true }));
  registry.set('me', { id: 'me', name: '我的位置', color: '#2f6fff', builtin: true, hidden: true });

  /** 字串 → 穩定的非負整數雜湊（djb2 變體） */
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h;
  }

  /** 依 id 取穩定顏色（同一 id 永遠同色） */
  function autoColor(id) {
    return PALETTE[hash(String(id)) % PALETTE.length];
  }

  /**
   * 註冊/更新一個群組。已存在則只補上缺的欄位（不覆蓋使用者設定的顏色）。
   * @returns 群組物件
   */
  function register(id, name, color) {
    if (id == null || id === '') return null;
    const key = String(id);
    let g = registry.get(key);
    if (!g) {
      g = { id: key, name: name || key, color: color || autoColor(key), builtin: false };
      registry.set(key, g);
    } else {
      if (name) g.name = name;
      if (color) g.color = color;
    }
    return g;
  }

  /** 取得群組（未註冊者即時註冊，永遠不會回傳 null 除非 id 為空） */
  function resolve(id) {
    if (id == null || id === '') return null;
    return registry.get(String(id)) || register(id);
  }

  /** 某個實體所屬的群組 id（無 group 欄位則依 type 落底） */
  function groupIdOf(ent) {
    if (!ent) return null;
    if (ent.group != null && ent.group !== '') return String(ent.group);
    return FALLBACK_BY_TYPE[ent.type] || null;
  }

  /** 某個實體的代表色 */
  function colorOf(ent) {
    const g = resolve(groupIdOf(ent));
    return g ? g.color : '#9fb0c0';
  }

  /** 某個實體所屬群組的顯示名稱 */
  function nameOf(ent) {
    const g = resolve(groupIdOf(ent));
    return g ? g.name : '';
  }

  /** 目前所有群組（不含隱藏的內部群組如「我的位置」） */
  function all() {
    return [...registry.values()].filter((g) => !g.hidden);
  }

  /**
   * 掃過實體清單，把沒看過的 group 自動註冊起來。
   * 匯入外部資料後呼叫，讓新群組立刻有顏色與過濾項。
   */
  function learn(entities) {
    (entities || []).forEach((e) => {
      const id = groupIdOf(e);
      if (id) register(id);
    });
    return all();
  }

  /**
   * 依群組把實體分堆，回傳 [{ group, items }]，
   * 群組順序：內建者依定義順序在前，其餘依首次出現順序。
   */
  function partition(entities) {
    const order = [...registry.keys()];
    const buckets = new Map();
    (entities || []).forEach((e) => {
      const id = groupIdOf(e) || '_none';
      if (!buckets.has(id)) buckets.set(id, []);
      buckets.get(id).push(e);
    });
    return [...buckets.entries()]
      .sort((a, b) => {
        const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
        return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
      })
      .map(([id, items]) => ({ group: resolve(id) || { id, name: '未分組', color: '#9fb0c0' }, items }));
  }

  /** 群組是否被隱藏（hidden 為 id 陣列） */
  function isHidden(ent, hidden) {
    if (!hidden || !hidden.length) return false;
    const id = groupIdOf(ent);
    return id != null && hidden.indexOf(id) >= 0;
  }

  /** 過濾掉被隱藏群組的實體 */
  function visible(entities, hidden) {
    if (!hidden || !hidden.length) return (entities || []).slice();
    return (entities || []).filter((e) => !isHidden(e, hidden));
  }

  global.Groups = {
    register, resolve, all, learn, partition,
    groupIdOf, colorOf, nameOf, isHidden, visible, autoColor,
    PALETTE, BUILTIN, FALLBACK_BY_TYPE,
    _registry: registry,
  };
})(typeof window !== 'undefined' ? window : globalThis);
