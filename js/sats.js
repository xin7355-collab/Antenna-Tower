/*
 * sats.js — 多衛星追蹤（台灣自主衛星 + ISS + 自訂 NORAD）
 * ------------------------------------------------------------------
 * 架構：TLE（兩行軌道根數）抓一次、快取 12 小時，之後全部用
 * vendor/satellite（SGP4）在本地傳播 —— 不管勾幾顆衛星，
 * 都不需要對每顆衛星輪詢網路。
 *
 * TLE 來源：CelesTrak（主）→ tle API（備援）。兩者都支援 CORS。
 * 抓到的名稱會與目錄的 match 關鍵字比對，編號錯了會自動改用
 * 名稱搜尋補救（衛星編號偶爾會因來源不同而對不上）。
 *
 * 「抓得到」的前提是衛星在軌且被公開編目：
 *   ✅ 福衛五號、福衛七號×6、獵風者、福衛八號A、ISS
 *   ✅ 同步衛星：ST-2（中華電信）、向日葵9號、Inmarsat 4-F1
 *   ❌ 福八B之後、福九、B5G —— 還沒發射，沒有軌道可抓
 */
(function (global) {
  'use strict';

  const sat = global.satellite;   // vendor/satellite/satellite.min.js（SGP4）
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // 台灣在軌衛星 + ISS。norad 為 NORAD 編目編號；match 用來驗證抓回來的
  // 名稱（編號錯誤時改用 nameQuery 搜尋）。
  const CATALOG = [
    { id: 'iss', name: 'ISS 國際太空站', short: 'ISS', norad: 25544, group: '國際',
      match: ['ISS', 'ZARYA'], nameQuery: 'ISS (ZARYA)' },
    { id: 'fs5', name: '福衛五號', short: '福五', norad: 42920, group: '遙測',
      match: ['FORMOSAT', 'FORMOSAT-5'], nameQuery: 'FORMOSAT 5' },
    { id: 'triton', name: '獵風者 TRITON', short: '獵風者', norad: 58014, group: '氣象',
      match: ['TRITON'], nameQuery: 'TRITON' },
    { id: 'fs8a', name: '福衛八號 FS-8A 齊柏林', short: '福八A', norad: null, group: '遙測',
      match: ['FORMOSAT-8', 'FORMOSAT 8'], nameQuery: 'FORMOSAT 8' },
    // 福衛七號（COSMIC-2）星系：6 顆，傾角 24°，專看低緯度
    { id: 'fs7-1', name: '福衛七號-1', short: '福七1', norad: 44349, group: '氣象', match: ['COSMIC', 'FORMOSAT'] },
    { id: 'fs7-2', name: '福衛七號-2', short: '福七2', norad: 44350, group: '氣象', match: ['COSMIC', 'FORMOSAT'] },
    { id: 'fs7-3', name: '福衛七號-3', short: '福七3', norad: 44351, group: '氣象', match: ['COSMIC', 'FORMOSAT'] },
    { id: 'fs7-4', name: '福衛七號-4', short: '福七4', norad: 44352, group: '氣象', match: ['COSMIC', 'FORMOSAT'] },
    { id: 'fs7-5', name: '福衛七號-5', short: '福七5', norad: 44353, group: '氣象', match: ['COSMIC', 'FORMOSAT'] },
    { id: 'fs7-6', name: '福衛七號-6', short: '福七6', norad: 44358, group: '氣象', match: ['COSMIC', 'FORMOSAT'] },
    // 同步軌道（GEO）：在天空中固定不動，24 小時都在同一個方位/仰角。
    // 肉眼看不到（太暗），但位置固定 —— 正適合拿來對碟型天線。
    { id: 'st2', name: 'ST-2 中華電信', short: 'ST-2', norad: 37606, group: '同步',
      match: ['ST-2', 'ST 2'], nameQuery: 'ST-2' },
    { id: 'himawari9', name: '向日葵9號 氣象', short: '向日葵9', norad: 41836, group: '同步',
      match: ['HIMAWARI'], nameQuery: 'HIMAWARI-9' },
    { id: 'inmarsat4f1', name: 'Inmarsat 4-F1', short: 'I-4F1', norad: 28628, group: '同步',
      match: ['INMARSAT'], nameQuery: 'INMARSAT 4-F1' },
  ];
  const byId = new Map(CATALOG.map((c) => [c.id, c]));

  // ---- TLE 快取（localStorage，12 小時）---------------------------------
  const LS_KEY = 'vrmap.tle.v1';
  const TTL_MS = 12 * 3600 * 1000;
  let mem = null;   // { key: {name,l1,l2,at} }

  function store() {
    if (mem) return mem;
    try { mem = JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
    catch (_) { mem = {}; }
    return mem;
  }
  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(mem)); } catch (_) { /* 可能被停用 */ }
  }
  function cacheKey(entry) { return entry.norad ? String(entry.norad) : entry.id; }

  function getTle(id) {
    const e = byId.get(id) || dynamicEntry(id);
    if (!e) return null;
    const t = store()[cacheKey(e)];
    if (!t || !t.l1 || !t.l2) return null;
    return t;
  }
  function hasTle(id) { return !!getTle(id); }
  function tleFresh(t) { return t && (Date.now() - (t.at || 0)) < TTL_MS; }

  /** 測試/離線注入用 */
  function _setTle(id, name, l1, l2) {
    const e = byId.get(id) || dynamicEntry(id);
    store()[cacheKey(e)] = { name, l1, l2, at: Date.now() };
    persist();
  }

  // 使用者以 NORAD 編號自訂加入：id 格式 "norad-XXXXX"
  function dynamicEntry(id) {
    const m = /^norad-(\d{1,9})$/.exec(id);
    if (!m) return null;
    const t = store()[m[1]];
    return { id, name: (t && t.name) || `NORAD ${m[1]}`, short: `#${m[1]}`,
      norad: Number(m[1]), group: '自訂', match: [] };
  }
  function entryOf(id) { return byId.get(id) || dynamicEntry(id); }

  // ---- 抓取 TLE ----------------------------------------------------------
  const SRC_CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';
  const SRC_BACKUP = 'https://tle.ivanstanojevic.me/api/tle';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastReqAt = 0;
  async function politeFetch(url) {
    const gap = 250 - (Date.now() - lastReqAt);   // 共用免費服務，請求間留間隔
    if (gap > 0) await sleep(gap);
    lastReqAt = Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  /** 把 TLE 文字（名稱行 + 兩行一組，可能多組）解析為陣列 */
  function parseTleText(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i + 2 < lines.length; i++) {
      if (lines[i + 1] && lines[i + 1][0] === '1' && lines[i + 2] && lines[i + 2][0] === '2' &&
          lines[i][0] !== '1' && lines[i][0] !== '2') {
        out.push({ name: lines[i], l1: lines[i + 1], l2: lines[i + 2] });
        i += 2;
      }
    }
    return out;
  }
  const nameMatches = (name, match) =>
    !match || !match.length || match.some((m) => String(name).toUpperCase().includes(m.toUpperCase()));

  async function fetchOne(e) {
    // 1) CelesTrak 依編號
    if (e.norad) {
      try {
        const got = parseTleText(await politeFetch(`${SRC_CELESTRAK}?CATNR=${e.norad}&FORMAT=TLE`));
        if (got.length && nameMatches(got[0].name, e.match)) return got[0];
      } catch (_) { /* 換下一招 */ }
    }
    // 2) CelesTrak 依名稱（編號錯誤或沒有編號時）
    if (e.nameQuery) {
      try {
        const got = parseTleText(await politeFetch(`${SRC_CELESTRAK}?NAME=${encodeURIComponent(e.nameQuery)}&FORMAT=TLE`));
        const hit = got.find((g) => nameMatches(g.name, e.match));
        if (hit) return hit;
      } catch (_) { /* 換備援 */ }
    }
    // 3) 備援 API 依編號（JSON）
    if (e.norad) {
      const j = JSON.parse(await politeFetch(`${SRC_BACKUP}/${e.norad}`));
      if (j && j.line1 && j.line2) return { name: j.name || e.name, l1: j.line1, l2: j.line2 };
    }
    throw new Error('TLE 無資料');
  }

  const status = {};   // id -> { state:'ok'|'loading'|'error', error?, age? }

  /**
   * 確保 ids 的 TLE 都在手上（快取新鮮就不重抓）。逐顆回報進度。
   * @returns statusMap
   */
  async function ensureTles(ids, opts = {}) {
    for (const id of ids) {
      const e = entryOf(id);
      if (!e) { status[id] = { state: 'error', error: '未知衛星' }; continue; }
      const cached = store()[cacheKey(e)];
      if (tleFresh(cached)) { status[id] = { state: 'ok', age: Date.now() - cached.at }; continue; }
      status[id] = { state: 'loading' };
      if (opts.onStatus) opts.onStatus(id, status[id]);
      try {
        const t = await fetchOne(e);
        store()[cacheKey(e)] = { name: t.name, l1: t.l1, l2: t.l2, at: Date.now() };
        persist();
        status[id] = { state: 'ok', age: 0 };
      } catch (err) {
        // 過期但還在的舊 TLE 仍可用（LEO 幾天內誤差仍是幾公里級）
        if (cached && cached.l1) status[id] = { state: 'ok', age: Date.now() - cached.at, stale: true };
        else status[id] = { state: 'error', error: err.message };
      }
      if (opts.onStatus) opts.onStatus(id, status[id]);
    }
    return { ...status };
  }
  function getStatus(id) { return status[id] || (hasTle(id) ? { state: 'ok' } : { state: 'none' }); }

  // ---- 位置與過境（SGP4，本地計算）--------------------------------------
  function satrecOf(id) {
    const t = getTle(id);
    if (!t || !sat) return null;
    try { return sat.twoline2satrec(t.l1, t.l2); } catch (_) { return null; }
  }

  // ---- 肉眼可見性 ---------------------------------------------------------
  // 低軌衛星本身不發光，是反射太陽光。肉眼看得到的條件：
  //   1) 衛星還照得到太陽（不在地球的影子裡）
  //   2) 觀測者這邊天已經暗了（太陽在地平線下 6° 以上，民用曙暮光結束）
  // 所以通常只有日落後、日出前 1～2 小時看得到；深夜衛星多半在地影中。
  const R_EARTH_KM = 6378.137;

  /** 太陽在 ECI 座標的單位向量（低精度，足夠判斷地影） */
  function sunUnitEci(date) {
    if (!global.Sky) return null;
    const s = Sky.sunEqu(Sky.julianDate(date));
    const ra = s.ra * D2R, dec = s.dec * D2R;
    return { x: Math.cos(dec) * Math.cos(ra), y: Math.cos(dec) * Math.sin(ra), z: Math.sin(dec) };
  }

  /** 衛星是否照得到太陽（圓柱形地影模型） */
  function isSunlit(posEci, sun) {
    if (!sun) return true;
    const proj = posEci.x * sun.x + posEci.y * sun.y + posEci.z * sun.z;
    if (proj > 0) return true;                       // 在地球朝向太陽那一側
    const px = posEci.x - proj * sun.x, py = posEci.y - proj * sun.y, pz = posEci.z - proj * sun.z;
    return Math.sqrt(px * px + py * py + pz * pz) > R_EARTH_KM;
  }

  /** 觀測者處的太陽仰角（度） */
  function sunAltAt(obs, date) {
    if (!global.Sky) return null;
    const jd = Sky.julianDate(date), s = Sky.sunEqu(jd);
    return Sky.equToHor(s.ra, s.dec, jd, obs.lat, obs.lng).alt;
  }

  /** 由平均運動（圈/日）分軌道類別 */
  function orbitClass(rec) {
    const revPerDay = rec.no * 1440 / (2 * Math.PI);   // satrec.no：rad/min
    if (revPerDay < 1.1 && revPerDay > 0.9) return 'GEO';
    if (revPerDay < 11) return 'MEO';
    return 'LEO';
  }

  /**
   * 回傳 ids 中「有 TLE」的衛星在 date 時刻的觀測資料。
   * @returns [{id, name, short, group, az, alt, rangeKm, subLat, subLng, heightKm}]
   */
  function positions(ids, obs, date = new Date()) {
    if (!sat) return [];
    const observerGd = {
      latitude: obs.lat * D2R, longitude: obs.lng * D2R,
      height: (obs.alt || 0) / 1000,
    };
    const gmst = sat.gstime(date);
    const sun = sunUnitEci(date);
    const sunAlt = sunAltAt(obs, date);
    const out = [];
    for (const id of ids) {
      const e = entryOf(id);
      const rec = satrecOf(id);
      if (!e || !rec) continue;
      const pv = sat.propagate(rec, date);
      if (!pv || !pv.position) continue;
      const orbit = orbitClass(rec);
      const sunlit = isSunlit(pv.position, sun);
      const ecf = sat.eciToEcf(pv.position, gmst);
      const la = sat.ecfToLookAngles(observerGd, ecf);
      const gd = sat.eciToGeodetic(pv.position, gmst);
      const tname = (getTle(id) || {}).name;
      out.push({
        id, name: e.name, short: e.short, group: e.group, tleName: tname,
        az: ((la.azimuth * R2D) % 360 + 360) % 360,
        alt: la.elevation * R2D,
        rangeKm: la.rangeSat,
        subLat: sat.degreesLat(gd.latitude),
        subLng: sat.degreesLong(gd.longitude),
        heightKm: gd.height,
        orbit, sunlit,
        // 同步衛星太暗，肉眼一律看不到；低軌要「照得到太陽 + 天黑 + 在地平線上」
        nakedEye: orbit === 'LEO' && sunlit && sunAlt != null && sunAlt < -6 && la.elevation * R2D > 10,
      });
    }
    return out;
  }

  /**
   * 下一次過境（SGP4 直接取樣，比圓軌道近似準）。
   * @returns {start,end,maxT,maxEl,maxAz} 或 null
   */
  function nextPass(id, obs, opts = {}) {
    const { hours = 24, stepS = 30, minEl = 5, from = Date.now() } = opts;
    const rec = satrecOf(id);
    if (!rec || !sat) return null;
    if (orbitClass(rec) === 'GEO') return null;   // 同步衛星固定不動，沒有升落
    const observerGd = {
      latitude: obs.lat * D2R, longitude: obs.lng * D2R, height: (obs.alt || 0) / 1000,
    };
    let cur = null, prevT = from;
    for (let s = 0; s <= hours * 3600; s += stepS) {
      const t = from + s * 1000;
      const d = new Date(t);
      const pv = sat.propagate(rec, d);
      if (!pv || !pv.position) return cur;   // 傳播失敗（TLE 太舊）就到此為止
      const la = sat.ecfToLookAngles(observerGd, sat.eciToEcf(pv.position, sat.gstime(d)));
      const el = la.elevation * R2D;
      if (el >= minEl) {
        if (!cur) cur = { start: t, maxEl: -90 };
        if (el > cur.maxEl) {
          cur.maxEl = el;
          cur.maxAz = ((la.azimuth * R2D) % 360 + 360) % 360;
          cur.maxT = t;
        }
      } else if (cur) {
        cur.end = prevT;
        return finishPass(rec, cur, obs);
      }
      prevT = t;
    }
    if (cur) { cur.end = prevT; return finishPass(rec, cur, obs); }
    return cur;
  }

  /** 收尾：四捨五入，並判斷最高點那一刻肉眼看不看得到 */
  function finishPass(rec, p, obs) {
    p.maxEl = Math.round(p.maxEl * 10) / 10;
    const d = new Date(p.maxT);
    const pv = sat.propagate(rec, d);
    const sunAlt = sunAltAt(obs, d);
    p.sunlit = pv && pv.position ? isSunlit(pv.position, sunUnitEci(d)) : null;
    p.dark = sunAlt != null ? sunAlt < -6 : null;
    p.visible = !!(p.sunlit && p.dark);
    return p;
  }

  global.Sats = {
    CATALOG, entryOf, available: !!sat,
    ensureTles, getStatus, hasTle, getTle, _setTle, parseTleText,
    positions, nextPass,
    TAIWAN_IDS: CATALOG.filter((c) => c.group !== '國際' && c.group !== '同步').map((c) => c.id),
    GEO_IDS: CATALOG.filter((c) => c.group === '同步').map((c) => c.id),
    isSunlit, orbitClass,
  };
})(typeof window !== 'undefined' ? window : globalThis);
