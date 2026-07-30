/*
 * parse.js — 匯入資料解析（JSON / CSV / GPX）
 * ------------------------------------------------------------------
 * 純字串處理，無外部相依，可獨立測試。
 * parseStations(text, filename) 依副檔名/內容判斷格式，回傳
 *   { stations:[...], me?, settings?, mode:'replace'|'append' }
 * JSON（完整狀態）→ replace；CSV/GPX（站台清單）→ append。
 */
(function (global) {
  'use strict';

  function stationId(prefix, i, lat) {
    return `${prefix}-${i}-${Math.round(lat * 1e4)}`;
  }

  // CSV / TSV：首列為欄名，欄名支援中英對照
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    const delim = lines[0].includes('\t') ? '\t' : ',';
    const header = lines[0].split(delim).map((h) => h.trim().toLowerCase());
    const col = (names) => header.findIndex((h) => names.includes(h));
    const iName = col(['name', '名稱', '站台', 'station']);
    const iLat = col(['lat', 'latitude', '緯度']);
    const iLng = col(['lng', 'lon', 'long', 'longitude', '經度']);
    const iAlt = col(['alt', 'elev', 'elevation', '海拔', '高度']);
    const iAnt = col(['antenna', 'ant', '天線']);
    const iFreq = col(['freq', 'frequency', '頻率', 'mhz']);
    if (iLat < 0 || iLng < 0) throw new Error('CSV 需有經緯度欄位（lat/lng 或 緯度/經度）');

    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(delim);
      const lat = parseFloat(c[iLat]);
      const lng = parseFloat(c[iLng]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      out.push({
        id: stationId('st-csv', i, lat),
        type: 'station',
        name: iName >= 0 && c[iName] ? c[iName].trim() : `匯入站台${i}`,
        lat, lng,
        alt: iAlt >= 0 ? (parseFloat(c[iAlt]) || 0) : 0,
        antenna: iAnt >= 0 ? (parseFloat(c[iAnt]) || 6) : 6,
        freqMHz: iFreq >= 0 ? (parseFloat(c[iFreq]) || undefined) : undefined,
      });
    }
    return out;
  }

  // GPX 航點：<wpt lat lon>[<ele><name>]</wpt> 及自封閉 <wpt .../>
  function parseGPX(text) {
    const out = [];
    let i = 0;
    const push = (attrs, body) => {
      const la = /\blat="([-\d.]+)"/i.exec(attrs);
      const lo = /\blon="([-\d.]+)"/i.exec(attrs);
      if (!la || !lo) return;
      const lat = parseFloat(la[1]), lng = parseFloat(lo[1]);
      if (!isFinite(lat) || !isFinite(lng)) return;
      i++;
      const nameM = body && /<name>([\s\S]*?)<\/name>/i.exec(body);
      const eleM = body && /<ele>([\s\S]*?)<\/ele>/i.exec(body);
      out.push({
        id: stationId('st-gpx', i, lat),
        type: 'station',
        name: nameM ? nameM[1].trim() : `航點${i}`,
        lat, lng,
        alt: eleM ? Math.round(parseFloat(eleM[1]) || 0) : 0,
        antenna: 6,
      });
    };
    // 成對標籤
    const pair = /<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/gi;
    let m;
    while ((m = pair.exec(text))) push(m[1], m[2]);
    // 自封閉標籤
    const self = /<wpt\b([^>]*?)\/>/gi;
    while ((m = self.exec(text))) push(m[1], '');
    return out;
  }

  function parseStations(text, filename = '') {
    const t = text.trim();
    const fn = filename.toLowerCase();
    if (fn.endsWith('.json') || t[0] === '{' || t[0] === '[') {
      const d = JSON.parse(t);
      if (Array.isArray(d)) return { stations: d, mode: 'replace' };
      return { me: d.me, stations: d.stations || [], settings: d.settings, mode: 'replace' };
    }
    if (fn.endsWith('.gpx') || t.includes('<gpx') || t.includes('<wpt')) {
      return { stations: parseGPX(t), mode: 'append' };
    }
    return { stations: parseCSV(t), mode: 'append' };
  }

  global.Parse = { parseStations, parseCSV, parseGPX };
})(typeof window !== 'undefined' ? window : globalThis);
