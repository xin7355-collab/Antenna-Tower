/*
 * parse.js — 匯入資料解析（JSON / CSV / GPX）
 * ------------------------------------------------------------------
 * 純字串處理，無外部相依，可獨立測試。
 * parseStations(text, filename) 依副檔名/內容判斷格式，回傳
 *   { stations:[...], me?, settings?, mode:'replace'|'append' }
 * JSON（完整狀態）→ replace；CSV/GPX（站臺清單）→ append。
 */
(function (global) {
  'use strict';

  function stationId(prefix, i, lat) {
    return `${prefix}-${i}-${Math.round(lat * 1e4)}`;
  }

  // CSV / TSV：首列為欄名，欄名支援中英對照。
  // 回傳 { stations, markers }：type 欄寫「標註/marker」的列會歸到 markers。
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return { stations: [], markers: [] };
    const delim = lines[0].includes('\t') ? '\t' : ',';
    const header = lines[0].split(delim).map((h) => h.trim().toLowerCase());
    const col = (names) => header.findIndex((h) => names.includes(h));
    const iName = col(['name', '名稱', '站臺', 'station']);
    const iLat = col(['lat', 'latitude', '緯度']);
    const iLng = col(['lng', 'lon', 'long', 'longitude', '經度']);
    const iAlt = col(['alt', 'elev', 'elevation', '海拔', '高度']);
    const iAnt = col(['antenna', 'ant', '天線']);
    const iFreq = col(['freq', 'frequency', '頻率', 'mhz']);
    const iTrue = col(['truealt', 'true_alt', 'realalt', '真實高度', '目標真實高度']);
    const iGroup = col(['group', 'grp', 'category', '群組', '分類']);
    const iType = col(['type', 'kind', '類型', '種類']);
    const iIcon = col(['icon', 'emoji', '圖示']);
    const iNote = col(['note', 'remark', 'desc', '備註', '說明']);
    if (iLat < 0 || iLng < 0) throw new Error('CSV 需有經緯度欄位（lat/lng 或 緯度/經度）');

    const cell = (c, i) => (i >= 0 && c[i] != null ? String(c[i]).trim() : '');
    // 類型欄位：出現「標註/marker/mark/註記」視為自訂標註，其餘一律當站臺
    const isMarkerRow = (v) => /^(marker|mark|note|標註|註記|標記)$/i.test(v);

    const stations = [], markers = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(delim);
      const lat = parseFloat(c[iLat]);
      const lng = parseFloat(c[iLng]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const group = cell(c, iGroup);
      const note = cell(c, iNote);
      const alt = iAlt >= 0 ? (parseFloat(c[iAlt]) || 0) : 0;

      if (isMarkerRow(cell(c, iType))) {
        markers.push({
          id: stationId('mk-csv', i, lat),
          type: 'marker',
          name: cell(c, iName) || `匯入標註${i}`,
          lat, lng, alt,
          icon: cell(c, iIcon) || '📌',
          note,
          custom: true,
          ...(group ? { group } : { group: 'mark' }),
        });
        continue;
      }
      stations.push({
        id: stationId('st-csv', i, lat),
        type: 'station',
        name: cell(c, iName) || `匯入站臺${i}`,
        lat, lng, alt,
        antenna: iAnt >= 0 ? (parseFloat(c[iAnt]) || 6) : 6,
        freqMHz: iFreq >= 0 ? (parseFloat(c[iFreq]) || undefined) : undefined,
        ...(note ? { note } : {}),
        ...(group ? { group } : {}),
        ...(iTrue >= 0 && c[iTrue] != null && String(c[iTrue]).trim() !== '' && isFinite(parseFloat(c[iTrue]))
          ? { trueAlt: parseFloat(c[iTrue]) } : {}),
      });
    }
    return { stations, markers };
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

  // ---- 萬用座標解析 ----------------------------------------------------
  // 支援：十進位、度分秒(DMS)、度分(DDM)、N/S/E/W、°′″ 各種符號、
  //       逗號或空白分隔、貼上整串（含 Google Maps 格式）。

  // 解析單一座標分量（可含半球字母），回傳十進位度數或 null
  function parseCoordComponent(str) {
    if (str == null) return null;
    let s = String(str).trim().toUpperCase()
      .replace(/[°˚º]/g, ' ').replace(/[’'′`]/g, ' ').replace(/[”"″]/g, ' ');
    if (!s) return null;
    let sign = 1;
    const hemi = s.match(/[NSEW]/);
    if (hemi) { if (hemi[0] === 'S' || hemi[0] === 'W') sign = -1; s = s.replace(/[NSEW]/g, ' '); }
    if (/^\s*-/.test(s)) sign = -1;
    const nums = s.match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return null;
    const d = parseFloat(nums[0]) || 0;
    const m = nums[1] ? parseFloat(nums[1]) : 0;
    const sec = nums[2] ? parseFloat(nums[2]) : 0;
    return sign * (d + m / 60 + sec / 3600);
  }

  // 解析一對座標，回傳 {lat, lng} 或 null
  function parseLatLng(str) {
    if (str == null) return null;
    const norm = String(str).trim()
      .replace(/[°˚º]/g, ' ').replace(/[’'′`]/g, ' ').replace(/[”"″]/g, ' ');
    if (!norm) return null;

    // 有半球字母：先判斷是「數字在前」(23.47N) 還是「字母在前」(N23.47)
    if (/[NSEW]/i.test(norm)) {
      const letters = [];
      norm.replace(/[NSEW]/gi, (ch, i) => { letters.push({ l: ch.toUpperCase(), i }); return ch; });
      const allBefore = letters.every((o) => /\d\s*$/.test(norm.slice(0, o.i)));
      const allAfter = letters.every((o) => /^\s*-?\d/.test(norm.slice(o.i + 1)));
      const side = allBefore ? 'before' : (allAfter ? 'after' : null);
      const numRe = /(-?\d[\d.]*(?:\s+\d[\d.]*){0,2})/;
      const grab = (set) => {
        const o = letters.find((x) => set.includes(x.l));
        if (!o || !side) return null;
        let m;
        if (side === 'before') m = norm.slice(0, o.i).match(new RegExp(numRe.source + '\\s*$'));
        else m = norm.slice(o.i + 1).match(new RegExp('^\\s*' + numRe.source));
        if (!m) return null;
        const p = m[1].trim().split(/\s+/).map(parseFloat);
        let v = (Math.abs(p[0]) || 0) + (p[1] || 0) / 60 + (p[2] || 0) / 3600;
        if (o.l === 'S' || o.l === 'W' || p[0] < 0) v = -Math.abs(v);
        return v;
      };
      const lat = grab(['N', 'S']), lng = grab(['E', 'W']);
      if (lat != null && lng != null) return clampLL(lat, lng);
    }

    // 純十進位一對（逗號或空白分隔）
    const nums = norm.match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 2) {
      return clampLL(parseFloat(nums[0]), parseFloat(nums[1]));
    }
    return null;
  }

  function clampLL(lat, lng) {
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }

  /**
   * 依副檔名/內容判斷格式並解析。
   * @returns { stations, markers, me?, settings?, groups?, mode:'replace'|'append' }
   */
  function parseStations(text, filename = '') {
    const t = text.trim();
    const fn = filename.toLowerCase();
    if (fn.endsWith('.json') || t[0] === '{' || t[0] === '[') {
      const d = JSON.parse(t);
      if (Array.isArray(d)) return { stations: d, markers: [], mode: 'replace' };
      return {
        me: d.me,
        stations: d.stations || [],
        markers: d.markers || [],
        groups: d.groups || null,
        settings: d.settings,
        mode: 'replace',
      };
    }
    if (fn.endsWith('.gpx') || t.includes('<gpx') || t.includes('<wpt')) {
      return { stations: parseGPX(t), markers: [], mode: 'append' };
    }
    const csv = parseCSV(t);
    return { stations: csv.stations, markers: csv.markers, mode: 'append' };
  }

  global.Parse = { parseStations, parseCSV, parseGPX, parseLatLng, parseCoordComponent };
})(typeof window !== 'undefined' ? window : globalThis);
