/*
 * elevation.js — 高程資料 + 視線/無線電路徑遮蔽分析
 * ------------------------------------------------------------------
 * 「中間有沒有山擋住？」的核心邏輯。
 *
 * 1. 取得任意座標的地面海拔：主要用 DEM 地形圖磚（AWS Terrarium），
 *    抓不到時退回 Open-Meteo Elevation API（免金鑰、有速率限制）。
 * 2. 沿兩點大圓路徑取樣，組出「地形剖面」。
 * 3. 以地球曲率 + 菲涅耳區判斷無線電/視線路徑是否被地形擋住。
 * 4. 天際線（山體輪廓）：在圖磚上沿 720 條射線逐像素掃描。
 */
(function (global) {
  'use strict';

  const Geo = global.Geo;
  const API = 'https://api.open-meteo.com/v1/elevation';
  const cache = new Map(); // key: "lat,lng"(4dp) -> elevation(m)

  const keyOf = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- DEM 地形圖磚（主要高程來源）---------------------------------------
  // AWS Open Data 的 Terrarium 地形圖磚：靜態 PNG、無速率限制、CORS 開放。
  // 每張 256×256 像素，像素值編碼海拔：h = R*256 + G + B/256 − 32768。
  // 一次抓十幾張圖磚就能在本地取樣上千點，取代 open-meteo 的逐點查詢
  // （那是 429 的根源）。open-meteo 降為圖磚抓不到時的備援。
  //
  // 為什麼自己解 PNG 而不畫到 canvas 再讀像素：Safari 的反指紋保護會在
  // canvas 讀回的像素加雜訊，R 通道差 1 就是 256 公尺的誤差。直接用
  // DecompressionStream 解 zlib，拿到的是原始位元組，不受影響。
  const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const demTiles = new Map();          // "z/x/y" -> Promise<{w,h,data:Float32Array}>
  const DEM_TILE_CAP = 80;             // 記憶體中最多保留幾張（每張 256KB）
  let demEnabled = true;

  function demSupported() {
    return demEnabled && typeof fetch === 'function' && typeof DecompressionStream === 'function' &&
      typeof Response === 'function' && typeof Blob === 'function';
  }
  function setDemEnabled(on) { demEnabled = !!on; }

  /** Terrarium 像素 → 海拔 (m) */
  function decodeTerrarium(r, g, b) { return r * 256 + g + b / 256 - 32768; }

  /** 經緯度 → 指定縮放層級的「分數」圖磚座標（Web Mercator） */
  function tileCoord(lat, lng, z) {
    const n = Math.pow(2, z);
    const la = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
    return {
      x: (lng + 180) / 360 * n,
      y: (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n,
    };
  }

  /** 選一個縮放層級：在「用到的圖磚數 ≤ maxTiles」的前提下取最清晰的 */
  function pickZoom(points, opts = {}) {
    const { maxTiles = 16, zMin = 8, zMax = 12 } = opts;
    for (let z = zMax; z >= zMin; z--) {
      const set = new Set();
      for (const p of points) {
        const t = tileCoord(p.lat, p.lng, z);
        set.add(Math.floor(t.x) + '/' + Math.floor(t.y));
        if (set.size > maxTiles) break;
      }
      if (set.size <= maxTiles) return z;
    }
    return zMin;
  }

  async function inflateZlib(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * 解 Terrarium PNG（8-bit RGB/RGBA、非交錯）→ 海拔陣列。
   * 只實作圖磚需要的子集；其他格式直接拋出，由呼叫端退回備援來源。
   */
  async function decodeTerrariumPng(buf) {
    const d = new Uint8Array(buf);
    const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) if (d[i] !== SIG[i]) throw new Error('不是 PNG');
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let pos = 8, w = 0, h = 0, bpp = 0;
    const parts = [];
    let total = 0;
    while (pos + 8 <= d.length) {
      const len = dv.getUint32(pos);
      const type = String.fromCharCode(d[pos + 4], d[pos + 5], d[pos + 6], d[pos + 7]);
      if (type === 'IHDR') {
        w = dv.getUint32(pos + 8); h = dv.getUint32(pos + 12);
        const depth = d[pos + 16], ct = d[pos + 17], il = d[pos + 20];
        if (depth !== 8 || (ct !== 2 && ct !== 6) || il !== 0) throw new Error('不支援的 PNG 格式');
        bpp = ct === 2 ? 3 : 4;
      } else if (type === 'IDAT') {
        parts.push(d.subarray(pos + 8, pos + 8 + len)); total += len;
      } else if (type === 'IEND') break;
      pos += 12 + len;
    }
    if (!w || !h || !parts.length) throw new Error('PNG 缺少影像資料');
    const z = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { z.set(p, o); o += p.length; }
    const raw = await inflateZlib(z);

    const stride = w * bpp;
    const data = new Float32Array(w * h);
    let prev = new Uint8Array(stride), i = 0;
    for (let y = 0; y < h; y++) {
      const f = raw[i++];
      const line = raw.subarray(i, i + stride);
      i += stride;
      // PNG 逐列反濾波（None/Sub/Up/Average/Paeth）
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        let v = line[x];
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        }
        line[x] = v & 255;
      }
      for (let x = 0; x < w; x++) {
        data[y * w + x] = decodeTerrarium(line[x * bpp], line[x * bpp + 1], line[x * bpp + 2]);
      }
      prev = line;
    }
    return { w, h, data };
  }

  /**
   * 去除單點雜訊。Terrarium 在部分海岸線有資料雜訊：一個像素突然 +2500 m、
   * 隔壁 −800 m（基隆港附近就有）。這種尖刺在天際線上會變成一根不存在的高峰，
   * 路徑分析也會被它「擋住」。
   *
   * 判定：8 個鄰居中有超過一半比它低（或高）超過 thr，就換成鄰居的中位數。
   * thr 取 max(200 m, 1.5 像素寬) —— 相當於比四周陡 56° 以上，真實山頭
   * 在這個解析度下不會這樣（稜線上至少有兩個鄰居跟它差不多高）。
   * 判定用原始值、寫到新陣列，成群的尖刺也不會互相掩護。
   */
  function despikeTile(t, pixelM) {
    const { w, h, data: D } = t;
    const thr = Math.max(200, 1.5 * pixelM);
    const out = new Float32Array(D);
    const nb = new Float32Array(8);
    for (let y = 0; y < h; y++) {
      const ym = y > 0 ? y - 1 : y, yp = y < h - 1 ? y + 1 : y;
      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : x, xp = x < w - 1 ? x + 1 : x;
        const c = D[y * w + x];
        nb[0] = D[ym * w + xm]; nb[1] = D[ym * w + x]; nb[2] = D[ym * w + xp];
        nb[3] = D[y * w + xm]; nb[4] = D[y * w + xp];
        nb[5] = D[yp * w + xm]; nb[6] = D[yp * w + x]; nb[7] = D[yp * w + xp];
        let hi = 0, lo = 0;
        for (let i = 0; i < 8; i++) { if (nb[i] >= c - thr) hi++; if (nb[i] <= c + thr) lo++; }
        if (hi >= 4 && lo >= 4) continue;     // 絕大多數像素：正常
        nb.sort();
        out[y * w + x] = hi < 4 ? nb[4] : nb[3];
      }
    }
    return { w, h, data: out };
  }

  /** 圖磚中心緯度（算像素寬度用） */
  function tileCenterLat(z, y) {
    const n = Math.PI * (1 - (2 * (y + 0.5)) / Math.pow(2, z));
    return Geo.toDeg(Math.atan(Math.sinh(n)));
  }

  function loadDemTile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    let p = demTiles.get(key);
    if (p) { demTiles.delete(key); demTiles.set(key, p); return p; }   // LRU：移到最新
    p = (async () => {
      const res = await fetch(DEM_URL(z, x, y));
      if (!res.ok) throw new Error('DEM ' + res.status);
      const t = await decodeTerrariumPng(await res.arrayBuffer());
      return despikeTile(t, demPixelM(tileCenterLat(z, y), z));
    })();
    p.catch(() => demTiles.delete(key));   // 失敗的不要留著，下次可重試
    demTiles.set(key, p);
    while (demTiles.size > DEM_TILE_CAP) demTiles.delete(demTiles.keys().next().value);
    return p;
  }

  /** 圖磚內雙線性內插（以像素中心為取樣點；邊緣夾在圖磚內） */
  function sampleTile(t, px, py) {
    const x = Math.max(0, Math.min(t.w - 1, px - 0.5));
    const y = Math.max(0, Math.min(t.h - 1, py - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(t.w - 1, x0 + 1), y1 = Math.min(t.h - 1, y0 + 1);
    const dx = x - x0, dy = y - y0, W = t.w, D = t.data;
    return D[y0 * W + x0] * (1 - dx) * (1 - dy) + D[y0 * W + x1] * dx * (1 - dy) +
      D[y1 * W + x0] * (1 - dx) * dy + D[y1 * W + x1] * dx * dy;
  }

  /**
   * 用 DEM 圖磚查多點海拔。抓不到的圖磚，其上的點回傳 null。
   * 海面以下（海底地形）一律視為 0 —— 視線看到的是海面。
   */
  async function demElevations(points, opts = {}) {
    const z = opts.zoom || pickZoom(points, opts);
    const groups = new Map();
    points.forEach((p, i) => {
      const t = tileCoord(p.lat, p.lng, z);
      const tx = Math.floor(t.x), ty = Math.floor(t.y);
      const key = tx + '/' + ty;
      if (!groups.has(key)) groups.set(key, { tx, ty, pts: [] });
      groups.get(key).pts.push({ i, px: (t.x - tx) * 256, py: (t.y - ty) * 256 });
    });
    const out = new Array(points.length).fill(null);
    const jobs = [...groups.values()];
    let done = 0, next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const g = jobs[next++];
        try {
          const tile = await loadDemTile(z, g.tx, g.ty);
          const sx = tile.w / 256, sy = tile.h / 256;
          g.pts.forEach((q) => { out[q.i] = Math.max(0, sampleTile(tile, q.px * sx, q.py * sy)); });
        } catch (_) { /* 這張抓不到：那些點留 null，交給備援 */ }
        done++;
        if (opts.onTile) opts.onTile(done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
    return out;
  }

  // Open-Meteo 是免費共用服務，短時間內連續丟幾十個請求會被回 429。
  // 這裡自己節流（請求之間留間隔）並在被限流時退避重試。
  const MIN_GAP_MS = 130;
  let lastReqAt = 0;

  /** 送出一個批次查詢，遇到 429/5xx/網路錯誤自動退避重試。 */
  async function requestChunk(url, opts = {}) {
    const maxRetry = opts.maxRetry != null ? opts.maxRetry : 4;
    for (let attempt = 0; ; attempt++) {
      const gap = MIN_GAP_MS - (Date.now() - lastReqAt);
      if (gap > 0) await sleep(gap);
      lastReqAt = Date.now();

      let res = null, netErr = null;
      try { res = await fetch(url); } catch (e) { netErr = e; }

      if (res && res.ok) return res.json();

      const status = res ? res.status : 0;
      const retriable = netErr || status === 429 || status >= 500;
      if (retriable && attempt < maxRetry) {
        // 伺服器有給 Retry-After 就聽它的，否則指數退避
        let wait = 800 * Math.pow(2, attempt);
        const ra = res && res.headers && res.headers.get ? Number(res.headers.get('Retry-After')) : NaN;
        if (isFinite(ra) && ra > 0) wait = Math.max(wait, ra * 1000);
        if (opts.onRetry) opts.onRetry(attempt + 1, wait, status);
        await sleep(wait);
        continue;
      }
      if (netErr) throw netErr;
      throw new Error(status === 429
        ? '高程服務請求過於頻繁（429），重試多次仍被限流；請等一分鐘再試'
        : `Elevation API ${status}`);
    }
  }

  /**
   * 批次查詢多點海拔。Open-Meteo 單次上限約 100 點，超過自動分批。
   * 回傳與輸入等長的海拔陣列 (m)；查不到的填 null。
   */
  async function fetchElevations(points, opts = {}) {
    const out = new Array(points.length).fill(null);
    let need = [];
    points.forEach((p, i) => {
      const k = keyOf(p);
      if (cache.has(k)) out[i] = cache.get(k);
      else need.push({ i, p, k });
    });
    const CHUNK = 100;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    if (onProgress) onProgress(points.length - need.length, points.length);

    // 1) DEM 圖磚（主要來源）
    if (need.length && demSupported() && opts.dem !== false) {
      const base = points.length - need.length;
      try {
        const vals = await demElevations(need.map((x) => x.p), {
          maxTiles: opts.maxTiles, zMax: opts.zMax, zMin: opts.zMin,
          onTile: onProgress ? (d, n) => onProgress(base + Math.round((need.length * d) / n), points.length) : null,
        });
        need = need.filter((x, j) => {
          const v = vals[j];
          if (v == null || !isFinite(v)) return true;
          cache.set(x.k, v);
          out[x.i] = v;
          return false;
        });
      } catch (_) { /* 整批失敗就全部交給備援 */ }
      if (!need.length) return out;
    }

    // 2) open-meteo（備援）
    let failed = 0;
    for (let s = 0; s < need.length; s += CHUNK) {
      const slice = need.slice(s, s + CHUNK);
      const lats = slice.map((x) => x.p.lat.toFixed(5)).join(',');
      const lngs = slice.map((x) => x.p.lng.toFixed(5)).join(',');
      const url = `${API}?latitude=${lats}&longitude=${lngs}`;
      try {
        const json = await requestChunk(url, { onRetry: opts.onRetry, maxRetry: opts.maxRetry });
        const arr = json.elevation || [];
        slice.forEach((x, j) => {
          const e = arr[j];
          if (typeof e === 'number') {
            cache.set(x.k, e);
            out[x.i] = e;
          }
        });
      } catch (err) {
        // tolerateFailures：拿到多少畫多少（天際線少幾個方位仍可用），
        // 其餘呼叫端（路徑分析）維持原本的直接拋出。
        if (!opts.tolerateFailures) throw err;
        failed += slice.length;
        if (opts.onChunkError) opts.onChunkError(err, failed);
      }
      if (onProgress) onProgress(points.length - need.length + Math.min(s + CHUNK, need.length), points.length);
    }
    return out;
  }

  /** 單點海拔 (m)，查不到回傳 null。 */
  async function elevationAt(point) {
    const [e] = await fetchElevations([point]);
    return e;
  }

  /**
   * 建立地形剖面：沿 a→b 取樣 n 段，回傳
   *   [{ lat, lng, dist(m from a), ground(m) }]
   */
  async function buildProfile(a, b, samples = 96) {
    const pts = Geo.samplePath(a, b, samples);
    const total = Geo.distance(a, b);
    const grounds = await fetchElevations(pts);
    return pts.map((p, i) => ({
      lat: p.lat,
      lng: p.lng,
      dist: p.frac * total,
      ground: grounds[i],
    }));
  }

  /**
   * Deygout 多重刀刃繞射損耗 (dB)。
   * 相較單一刀刃，能處理路徑上多道山脊：先找主邊（繞射參數最大者），
   * 再遞迴計算主邊兩側子路徑的繞射損耗並相加。
   *
   * @param profile  [{dist, ground}]（含端點）
   * @param h1,h2    兩端天線頂海拔 (m)
   * @param freqMHz  頻率 (MHz)
   * @param k        等效地球半徑係數
   */
  function deygoutLossDb(profile, h1, h2, freqMHz, k = Geo.K_DEFAULT, maxDepth = 1) {
    const dist = profile.map((p) => p.dist);
    const grd = profile.map((p) => p.ground);
    if (grd.some((g) => g == null)) return 0; // 高程不足，無法計算

    // maxDepth=1 → 主邊 + 兩側各一子邊 = 最多 3 道刀刃（Deygout 慣例上限）。
    // 不設上限會在平滑的地球曲率剖面上遞迴出大量假邊、嚴重高估損耗。
    function recurse(a, b, hA, hB, depth) {
      if (b - a < 2) return 0;               // 無中間點
      const D = dist[b] - dist[a];
      if (D <= 0) return 0;
      let mBest = -1, vBest = -Infinity;
      for (let m = a + 1; m < b; m++) {
        const d1 = dist[m] - dist[a];
        const d2 = dist[b] - dist[m];
        const bulge = Geo.earthBulge(d1, d2, k);
        const los = hA + ((hB - hA) * d1) / D;
        const clr = los - (grd[m] + bulge);
        const F1 = Geo.fresnelRadius(d1, d2, freqMHz, 1);
        const v = Geo.diffractionV(clr, F1);
        if (v > vBest) { vBest = v; mBest = m; }
      }
      if (vBest <= -0.78 || mBest < 0) return 0; // 此段無顯著阻擋
      const main = Geo.knifeEdgeLossDb(vBest);
      if (depth <= 0) return main;               // 達邊數上限，不再細分
      // 主邊頂 = 該點地面高，作為子路徑的終端
      return main
        + recurse(a, mBest, hA, grd[mBest], depth - 1)
        + recurse(mBest, b, grd[mBest], hB, depth - 1);
    }
    return recurse(0, profile.length - 1, h1, h2, maxDepth);
  }

  /**
   * 視線/無線電路徑遮蔽分析。
   *
   * @param profile   buildProfile() 的輸出（含端點）
   * @param opts.obsAntenna  觀測端天線離地高 (m)
   * @param opts.tgtAntenna  目標端天線離地高 (m)
   * @param opts.tgtTopAlt   目標端「真實高度」絕對海拔 (m)；有給則覆蓋 tgtAntenna
   * @param opts.freqMHz     頻率 (MHz)，用於菲涅耳區；預設 145 (2m 業餘)
   * @param opts.k           等效地球半徑係數，預設 4/3
   *
   * @returns {
   *   clear: boolean,          // 第一菲涅耳區 60% 是否淨空
   *   losClear: boolean,       // 純幾何視線是否通（不看菲涅耳）
   *   worst: {dist, clearance, ratio, ground, los, name},
   *   obstructions: [...],     // 所有 clearance<0 的地形點
   *   samples: [{dist, ground, los, bulge, clearance, fresnel, ratio}]
   * }
   */
  function analyzePath(profile, opts = {}) {
    const {
      obsAntenna = 3,
      tgtAntenna = 3,
      tgtTopAlt = null,
      freqMHz = 145,
      k = Geo.K_DEFAULT,
    } = opts;

    const first = profile[0];
    const last = profile[profile.length - 1];
    const D = last.dist;

    // 端點「天線頂」海拔；目標端若指定真實高度則直接採用（覆蓋天線推算）
    const h1 = (first.ground ?? 0) + obsAntenna;
    const h2 = (tgtTopAlt != null && isFinite(tgtTopAlt))
      ? Number(tgtTopAlt)
      : (last.ground ?? 0) + tgtAntenna;

    let worst = null;       // 淨空最小處
    let maxV = -Infinity;   // 繞射參數最大處（損耗最大）
    const obstructions = [];
    const samples = profile.map((p) => {
      const d1 = p.dist;
      const d2 = D - d1;
      // 兩端天線頂連成的直線在此距離的高度
      const los = h1 + ((h2 - h1) * d1) / D;
      // 地球曲率讓地面相對直線鼓起
      const bulge = Geo.earthBulge(d1, d2, k);
      const groundEff = (p.ground ?? 0) + bulge;
      const clearance = los - groundEff;           // >0 表示直線在地形之上
      const fresnel = Geo.fresnelRadius(d1, d2, freqMHz, 1);
      const ratio = fresnel > 0 ? clearance / fresnel : Infinity; // 淨空比
      const v = Geo.diffractionV(clearance, fresnel);
      const s = { dist: d1, ground: p.ground, los, bulge, clearance, fresnel, ratio, v, lat: p.lat, lng: p.lng };
      // 端點本身不列入遮蔽判斷
      const isEnd = p === first || p === last;
      if (!isEnd) {
        if (clearance < 0) obstructions.push(s);
        if (!worst || clearance < worst.clearance) worst = s;
        if (v > maxV) maxV = v;
      }
      return s;
    });

    const losClear = obstructions.length === 0;
    // 工程慣例：第一菲涅耳區至少淨空 60% 才視為「良好」
    const clear = losClear && (worst ? worst.ratio >= 0.6 : true);

    // 連結預算：自由空間損耗 + 繞射損耗
    const fspl = Geo.fsplDb(D, freqMHz);
    const diffractionSingle = Geo.knifeEdgeLossDb(maxV);      // 單一刀刃（最壞點）
    const diffractionMulti = deygoutLossDb(profile, h1, h2, freqMHz, k); // Deygout 多重刀刃
    // 採較保守（較大）者作為報告值
    const diffractionLoss = Math.max(diffractionSingle, diffractionMulti);
    const totalLoss = fspl + diffractionLoss;

    return {
      clear, losClear, worst, obstructions, samples, D, h1, h2, freqMHz,
      fspl, diffractionLoss, diffractionSingle, diffractionMulti, totalLoss, maxV,
    };
  }

  /**
   * 地形感知涵蓋多邊形：從中心站臺向四周發射 azimuths 條射線，
   * 每條找出「地面視線第一次被地形擋住」的距離，串成多邊形。
   * 假設接收端天線離地 rxHeight 公尺。回傳 [[lat,lng], ...]。
   */
  async function computeCoveragePolygon(center, opts = {}) {
    const {
      antenna = 6, rxHeight = 10, k = Geo.K_DEFAULT, topAlt = null,
      azimuths = 24, samples = 24, maxRangeKm = 150,
    } = opts;
    const centerTop = (topAlt != null && isFinite(topAlt)) ? Number(topAlt) : (center.alt || 0) + antenna;
    const maxRangeM = Math.min(
      maxRangeKm * 1000,
      (Geo.radioHorizonKm(centerTop, k) + Geo.radioHorizonKm(rxHeight, k)) * 1000
    );

    // 1) 佈點：每條射線由中心向外等距取樣
    const rays = [];
    for (let i = 0; i < azimuths; i++) {
      const az = (360 / azimuths) * i;
      const pts = [{ lat: center.lat, lng: center.lng, dist: 0 }];
      for (let s = 1; s <= samples; s++) {
        const d = (maxRangeM * s) / samples;
        const p = Geo.destination(center, az, d);
        pts.push({ lat: p.lat, lng: p.lng, dist: d });
      }
      rays.push({ az, pts });
    }

    // 2) 一次批次查詢所有點的高程
    const flat = rays.flatMap((r) => r.pts);
    const elevs = await fetchElevations(flat);
    let idx = 0;
    rays.forEach((r) => r.pts.forEach((p) => { p.ground = elevs[idx++]; }));

    // 3) 每條射線找第一次被擋的距離
    const centerGround = rays[0].pts[0].ground ?? (center.alt || 0);
    const h1 = (topAlt != null && isFinite(topAlt)) ? Number(topAlt) : centerGround + antenna;
    return rays.map((r) => {
      const P = r.pts;
      let covDist = 0;
      for (let ri = 1; ri < P.length; ri++) {
        const D = P[ri].dist;
        const hR = (P[ri].ground ?? 0) + rxHeight;
        let clear = true;
        for (let m = 1; m < ri; m++) {
          const d1 = P[m].dist, d2 = D - d1;
          const bulge = Geo.earthBulge(d1, d2, k);
          const los = h1 + ((hR - h1) * d1) / D;
          if (los - ((P[m].ground ?? 0) + bulge) < 0) { clear = false; break; }
        }
        if (clear) covDist = D; else break; // 第一次被擋 → 該方向涵蓋止於此
      }
      const v = Geo.destination(center, r.az, Math.max(covDist, maxRangeM * 0.02));
      return [v.lat, v.lng];
    });
  }

  // ---- 天際線（山稜線輪廓） ---------------------------------------------
  // 可見光折射的等效地球半徑係數。無線電用 4/3，肉眼/相機看到的地平線
  // 略低一些（約 1.13），AR 疊在相機畫面上時用這個才對得準。
  const K_OPTICAL = 1.13;

  /**
   * 由已取樣的射線資料算出天際線（每個方位「山稜頂」的仰角）。
   * 純函式，不碰網路，方便測試。
   *
   * 原理：沿著每條射線逐點算「從觀測者看該點地面」的仰角，取最大值。
   * 最大者就是這個方位擋住視線的稜線 —— 也就是天際線上的那一點。
   * 遠處地面因地球曲率往下沉，已用 drop 修正，所以遠山不會被高估。
   *
   * @param rays   [{az, pts:[{dist(m), ground(m)}]}]；pts 內 dist=0 者略過
   * @param obsAlt 觀測者眼睛/天線頂的海拔 (m)
   * @param k      等效地球半徑係數（預設可見光 1.13）
   * @returns [{az, elev(deg), dist(m), ground(m)}]，算不出來的方位 elev 為 null
   */
  function skylineFromRays(rays, obsAlt, k = K_OPTICAL) {
    return (rays || []).map((r) => {
      let best = null;
      (r.pts || []).forEach((p) => {
        if (!(p.dist > 0) || p.ground == null || !isFinite(p.ground)) return;
        // 遠處地面相對觀測者水平面的下沉量（地球曲率）
        const drop = (p.dist * p.dist) / (2 * k * Geo.R_EARTH);
        const elev = Geo.toDeg(Math.atan2(p.ground - obsAlt - drop, p.dist));
        if (!best || elev > best.elev) best = { az: r.az, elev, dist: p.dist, ground: p.ground };
      });
      return best || { az: r.az, elev: null, dist: null, ground: null };
    }).sort((a, b) => a.az - b.az);
  }

  // ---- 密集天際線：在 DEM 圖磚上沿射線逐像素掃描 -----------------------
  // 舊做法每條射線只取 22 點、只看到 90 km、方位每 3.75° 一條：稜線頂常落在
  // 兩個取樣點之間，與逐像素真值比對平均差 0.35–0.77°、最大 1.5–3.6°。
  // 現在改成圖磚一次抓好，在本地沿每條射線「每個像素都看」：近處用高解析
  // 圖磚、遠處用低解析圖磚，看到 150 km（從西部平原看中央山脈約 60–110 km），
  // 方位每 0.5°。台中實測：平均差 0.008°、最大 0.12°，約 53 張圖磚 / 3.5 MB。
  // 近環拉到 20 km 是因為前排丘陵（大坑、八卦山）多在 10–20 km，
  // 用 z10 會把稜線削矮 0.3°；遠環用 z8 與 z9 精度相同但流量少三成。
  const SKY_RINGS = [
    { from: 100, to: 20000, z: 12 },      // 近：~35 m/像素
    { from: 20000, to: 60000, z: 10 },    // 中：~140 m/像素
    { from: 60000, to: 150000, z: 8 },    // 遠：~560 m/像素（100 km 外 0.5° 方位間距就有 870 m）
  ];

  /** 圖磚一個像素代表的地面公尺數（Web Mercator，隨緯度變小） */
  function demPixelM(lat, z) {
    return 40075016.686 * Math.cos(Geo.toRad(lat)) / (256 * Math.pow(2, z));
  }

  /**
   * 列出涵蓋「以 center 為圓心、from～to 公尺環帶」所需的圖磚。
   * 在圖磚座標上以局部平面近似判斷相交（150 km 內誤差約 1%，另留 3% 餘裕）。
   */
  function ringTiles(center, from, to, z) {
    const c = tileCoord(center.lat, center.lng, z);
    const unit = demPixelM(center.lat, z) * 256;            // 一張圖磚幾公尺
    const rTo = (to / unit) * 1.03 + 0.01;
    const rFrom = Math.max(0, (from / unit) * 0.97 - 0.01);
    const n = Math.pow(2, z), out = [];
    for (let ty = Math.floor(c.y - rTo); ty <= Math.floor(c.y + rTo); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(c.x - rTo); tx <= Math.floor(c.x + rTo); tx++) {
        const nx = Math.max(tx, Math.min(tx + 1, c.x)) - c.x;      // 圖磚上離圓心最近的點
        const ny = Math.max(ty, Math.min(ty + 1, c.y)) - c.y;
        const fx = Math.max(Math.abs(tx - c.x), Math.abs(tx + 1 - c.x)); // 最遠的角
        const fy = Math.max(Math.abs(ty - c.y), Math.abs(ty + 1 - c.y));
        if (Math.hypot(nx, ny) <= rTo && Math.hypot(fx, fy) >= rFrom) {
          out.push({ z, x: ((tx % n) + n) % n, y: ty });
        }
      }
    }
    return out;
  }

  /**
   * 準備射線掃描：所有射線共用同一組距離刻度，sin/cos 先算好。
   *
   * @param o.observer {lat,lng}
   * @param o.obsAlt   觀測者眼睛海拔 (m)
   * @param o.azimuths 方位數（720 = 每 0.5°）
   * @param o.rings    [{from, to, step}]：各距離環帶與其取樣間距 (m)
   * @param o.sample   (sinLat, lngDeg, ringIndex) => 海拔 (m) 或 null
   * @param o.k        等效地球半徑係數（預設可見光 1.13）
   * @param o.bpMin    遮擋斷點的最小仰角增幅 (deg)，越大存得越少
   */
  function prepareMarch(o) {
    const k = o.k || K_OPTICAL, R = Geo.R_EARTH;
    const dist = [], ring = [];
    o.rings.forEach((r, ri) => {
      const last = ri === o.rings.length - 1;
      for (let d = r.from; last ? d <= r.to + 1e-6 : d < r.to; d += r.step) { dist.push(d); ring.push(ri); }
    });
    const n = dist.length;
    const sinD = new Float64Array(n), cosD = new Float64Array(n), drop = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const dl = dist[i] / R;
      sinD[i] = Math.sin(dl); cosD[i] = Math.cos(dl);
      drop[i] = (dist[i] * dist[i]) / (2 * k * R);   // 地球曲率造成的下沉
    }
    const phi = Geo.toRad(o.observer.lat);
    return {
      azimuths: o.azimuths, obsAlt: o.obsAlt, sample: o.sample,
      bpMin: o.bpMin != null ? o.bpMin : 0.05,
      // 腳邊的平地仰角會從 -2° 一路爬到 0°，每一小步都記的話斷點一半是廢的；
      // 500 m 內的遮擋併到第一筆斷點裡記（只是不細分距離）。
      bpFrom: o.bpFrom != null ? o.bpFrom : 500,
      dist, ring, sinD, cosD, drop, n, sp1: Math.sin(phi), cp1: Math.cos(phi), lng1: o.observer.lng,
    };
  }

  /**
   * 掃描第 ai 條射線，回傳該方位的稜線與「遮擋斷點」。
   *
   * 斷點 bp = [d1, e1, d2, e2, …]：沿射線往外走，「到目前為止的最高仰角」
   * 每上升 bpMin 度記一筆。查「距離 D 之前最高的地形仰角」只要找 D 之前的
   * 最後一筆 —— 用來判斷某座山是不是被更近的稜線擋住。
   */
  function marchRay(c, ai) {
    const az = (360 / c.azimuths) * ai;
    const th = Geo.toRad(az), st = Math.sin(th), ct = Math.cos(th);
    const toDeg = 180 / Math.PI;
    let best = -Infinity, bestI = -1, bestG = null, got = 0, lastBp = -Infinity;
    const bp = [];
    const rec = (d, t) => {
      const e = Math.atan(t) * toDeg;
      bp.push(Math.round(d), Math.round(e * 1000) / 1000); lastBp = e;
    };
    for (let i = 0; i < c.n; i++) {
      // 大圓公式求這一點的緯度（只需 sin）與經度
      const sp2 = c.sp1 * c.cosD[i] + c.cp1 * c.sinD[i] * ct;
      const lng = c.lng1 + Math.atan2(st * c.sinD[i] * c.cp1, c.cosD[i] - c.sp1 * sp2) * toDeg;
      const g = c.sample(sp2, lng, c.ring[i]);
      if (g == null || !isFinite(g)) continue;
      got++;
      const d = c.dist[i];
      if (d >= c.bpFrom && lastBp === -Infinity && bestI >= 0) rec(d, best);   // 第一筆：腳邊累積的遮擋
      // 比切線斜率即可（與仰角單調對應），只有創新高時才算 atan
      const t = (g - c.obsAlt - c.drop[i]) / d;
      if (t > best) {
        best = t; bestI = i; bestG = g;
        if (d >= c.bpFrom && Math.atan(t) * toDeg - lastBp >= c.bpMin) rec(d, t);
      }
    }
    if (bestI < 0) return { point: { az, elev: null, dist: null, ground: null }, bp: [], got };
    const elev = Math.atan(best) * toDeg;
    const dBest = Math.round(c.dist[bestI]);
    if (elev - lastBp > 1e-6) bp.push(dBest, Math.round(elev * 1000) / 1000);   // 稜線本身一定要記
    return { point: { az, elev, dist: c.dist[bestI], ground: bestG }, bp, got };
  }

  /** 同步版：一次掃完所有方位（純函式，測試用；App 用 computeSkyline 分段執行） */
  function marchSkyline(o) {
    const c = prepareMarch(o);
    const points = [], bp = [];
    for (let i = 0; i < o.azimuths; i++) {
      const r = marchRay(c, i);
      points.push(r.point); bp.push(r.bp);
    }
    return { points, bp, step: 360 / o.azimuths };
  }

  /** 建立圖磚取樣器：maps[ringIndex] 是 Map(x*1e5+y → 解好的圖磚) */
  function makeDemSampler(rings, maps) {
    let lastRi = -1, lastKey = -1, lastTile = null;
    return (sinLat, lng, ri) => {
      const nT = Math.pow(2, rings[ri].z);
      const x = ((lng + 180) / 360) * nT;
      const y = (1 - Math.atanh(Math.max(-0.9999, Math.min(0.9999, sinLat))) / Math.PI) / 2 * nT;
      const tx = Math.floor(x), ty = Math.floor(y);
      const key = tx * 1e5 + ty;
      if (key !== lastKey || ri !== lastRi) {   // 相鄰取樣點多半落在同一張，省掉 Map 查詢
        lastTile = maps[ri].get(key) || null; lastKey = key; lastRi = ri;
      }
      if (!lastTile) return null;
      return Math.max(0, sampleTile(lastTile, (x - tx) * lastTile.w, (y - ty) * lastTile.h));
    };
  }

  /**
   * 取得觀測者四周的天際線輪廓，供 AR 畫出「沿著山形的山體形狀」。
   * 主要用 DEM 圖磚逐像素掃描（computeSkylineDem）；瀏覽器不支援或圖磚
   * 完全抓不到時，退回舊的稀疏取樣（走 open-meteo 備援）。
   *
   * @param observer {lat,lng,alt}
   * @param opts.eyeHeight  觀測者離地高度 (m)，預設 2（站著的人）
   * @param opts.onProgress (done, total) 進度回呼
   * @returns { at, obsAlt, ground, step, points:[{az, elev, dist, ground}], bp, coverage, error, source }
   */
  async function computeSkyline(observer, opts = {}) {
    let demErr = null;
    if (opts.dem !== false && demSupported()) {
      try { return await computeSkylineDem(observer, opts); }
      catch (err) { demErr = err; }
    }
    try {
      return await computeSkylineSparse(observer, opts);
    } catch (err) {
      throw demErr || err;
    }
  }

  async function computeSkylineDem(observer, opts = {}) {
    const {
      eyeHeight = 2, azimuths = 720, maxRangeKm = 150, k = K_OPTICAL,
      onProgress = null, rings: ringDefs = SKY_RINGS,
    } = opts;
    const maxM = maxRangeKm * 1000;
    const rings = ringDefs.filter((r) => r.from < maxM).map((r) => ({
      ...r, to: Math.min(r.to, maxM),
      // 取樣間距 ≈ 0.8 像素：每個像素至少踩到一次，稜線頂不會漏掉
      step: r.step || Math.max(15, demPixelM(observer.lat, r.z) * 0.8),
    }));
    const report = (f) => { if (onProgress) onProgress(Math.round(f * 1000), 1000); };

    // 1) 抓這一圈要用的圖磚（6 條並行）
    const jobs = [];
    rings.forEach((r, ri) => ringTiles(observer, r.from, r.to, r.z).forEach((t) => jobs.push({ ...t, ri })));
    const maps = rings.map(() => new Map());
    let done = 0, next = 0, failed = 0, lastError = null;
    const worker = async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        try { maps[j.ri].set(j.x * 1e5 + j.y, await loadDemTile(j.z, j.x, j.y)); }
        catch (e) { failed++; lastError = e; }
        done++;
        report(0.9 * done / jobs.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
    if (failed === jobs.length) throw lastError || new Error('取不到地形圖磚');

    // 2) 觀測點自己的地面高
    const sample = makeDemSampler(rings, maps);
    const g0 = sample(Math.sin(Geo.toRad(observer.lat)), observer.lng, 0);
    const ground = g0 != null ? g0 : (observer.alt || 0);
    const obsAlt = ground + eyeHeight;

    // 3) 逐方位掃描；分段讓出主執行緒，畫面才不會卡住
    const c = prepareMarch({ observer, obsAlt, azimuths, rings, k, sample });
    const points = [], bp = [];
    let complete = 0;
    for (let i = 0; i < azimuths; i++) {
      const r = marchRay(c, i);
      points.push(r.point); bp.push(r.bp);
      if (r.got === c.n) complete++;
      if (i % 90 === 89) { report(0.9 + 0.1 * (i + 1) / azimuths); await sleep(0); }
    }
    if (!points.some((p) => p.elev != null)) throw lastError || new Error('取不到任何高程資料');
    return {
      at: { lat: observer.lat, lng: observer.lng }, obsAlt, ground, step: 360 / azimuths,
      rangeKm: maxRangeKm, points, bp,
      coverage: complete / azimuths,        // 資料完整的方位比例
      error: failed ? lastError : null,     // 部分圖磚失敗時保留原因供提示
      source: 'dem', tiles: jobs.length,
    };
  }

  /**
   * 備援：舊的稀疏取樣（等比距離、近密遠疏），透過 fetchElevations 取點，
   * 圖磚抓不到時會落到 open-meteo。點數直接決定請求數（每 100 點一個），
   * 而 open-meteo 會限流，所以只取「夠畫出輪廓」的量：96×22 ≈ 22 個請求。
   */
  async function computeSkylineSparse(observer, opts = {}) {
    const {
      eyeHeight = 2, sparseAzimuths: azimuths = 96, samples = 22,
      sparseRangeKm: maxRangeKm = 90, minRangeM = 250, k = K_OPTICAL,
      onProgress = null, onRetry = null,
    } = opts;
    const maxRangeM = maxRangeKm * 1000;

    // 等比距離刻度（近密遠疏）
    const dists = [];
    const ratio = Math.pow(maxRangeM / minRangeM, 1 / Math.max(1, samples - 1));
    for (let s = 0; s < samples; s++) dists.push(minRangeM * Math.pow(ratio, s));

    const rays = [];
    for (let i = 0; i < azimuths; i++) {
      const az = (360 / azimuths) * i;
      const pts = dists.map((d) => {
        const p = Geo.destination(observer, az, d);
        return { lat: p.lat, lng: p.lng, dist: d };
      });
      rays.push({ az, pts });
    }

    const flat = rays.flatMap((r) => r.pts);
    // 觀測者本身的地面高度也一起查（alt 可能還沒填）
    flat.push({ lat: observer.lat, lng: observer.lng, dist: 0 });
    let lastError = null;
    // 近處（≤12km）與遠處分兩批：近處範圍小，可用高解析圖磚（~40m），
    // 遠處範圍大但對解析度不敏感（~280m 在 50km 外只差 0.3°）。
    const NEAR = 12000;
    const nearIdx = [], farIdx = [];
    flat.forEach((p, i) => (p.dist <= NEAR ? nearIdx : farIdx).push(i));
    const elevs = new Array(flat.length).fill(null);
    const runBatch = async (idx, zMax, weight, offset) => {
      if (!idx.length) return;
      const vals = await fetchElevations(idx.map((i) => flat[i]), {
        zMax, maxTiles: 16, onRetry, tolerateFailures: true,
        onChunkError: (err) => { lastError = err; },
        onProgress: onProgress ? (d, n) => onProgress(Math.round(offset + weight * (d / n) * flat.length), flat.length) : null,
      });
      idx.forEach((i, j) => { elevs[i] = vals[j]; });
    };
    const wNear = nearIdx.length / flat.length;
    await runBatch(nearIdx, 12, wNear, 0);
    await runBatch(farIdx, 10, 1 - wNear, wNear * flat.length);
    let idx = 0;
    rays.forEach((r) => r.pts.forEach((p) => { p.ground = elevs[idx++]; }));
    const centerGround = elevs[idx] != null ? elevs[idx] : (observer.alt || 0);
    const obsAlt = centerGround + eyeHeight;

    const points = skylineFromRays(rays, obsAlt, k);
    const got = points.filter((p) => p.elev != null).length;
    if (!got) throw (lastError || new Error('取不到任何高程資料'));
    return {
      at: { lat: observer.lat, lng: observer.lng }, obsAlt, ground: centerGround,
      step: 360 / azimuths, rangeKm: maxRangeKm, points,
      coverage: got / points.length,      // 實際取到的方位比例
      error: lastError,                   // 部分失敗時保留原因供提示
      source: 'sparse',
    };
  }

  /**
   * 某方位的天際線仰角（度），相鄰兩個方位線性內插；沒有資料回傳 null。
   * points 一律是等間隔方位（第 i 筆 = i × step 度），直接用索引查，不必搜尋。
   */
  function skylineElevAt(sl, az) {
    const pts = sl && sl.points;
    if (!pts || !pts.length) return null;
    const n = pts.length, step = sl.step || 360 / n;
    const f = ((((az % 360) + 360) % 360) / step);
    const i0 = Math.floor(f) % n, i1 = (i0 + 1) % n, t = f - Math.floor(f);
    const a = pts[i0] && pts[i0].elev, b = pts[i1] && pts[i1].elev;
    if (a == null) return b == null ? null : b;
    if (b == null) return a;
    return a + (b - a) * t;
  }

  /**
   * 往 az 方位看，距離 dist 之前「最高的地形仰角」（度）。
   * 用天際線的遮擋斷點查；舊資料沒有斷點時回傳 null（無法判斷）。
   */
  function skylineBlockAt(sl, az, dist) {
    const bps = sl && sl.bp;
    if (!bps || !bps.length) return null;
    const n = bps.length, step = sl.step || 360 / n;
    const b = bps[Math.round((((az % 360) + 360) % 360) / step) % n];
    if (!b || !b.length) return null;
    let e = null;
    for (let j = 0; j < b.length; j += 2) {
      if (b[j] < dist) e = b[j + 1]; else break;
    }
    return e;
  }

  /**
   * 目標是否被更近的稜線擋住（看不到）。
   * 目標自己的山坡不算：只看目標前方 max(150m, 2%) 以外的地形。
   *
   * @param elev 從同一觀測高度（sl.obsAlt）看目標頂的仰角（度）
   * @returns true=被擋、false=看得到、null=資料不足無法判斷
   */
  function skylineHides(sl, az, dist, elev, tol = 0.05) {
    const block = skylineBlockAt(sl, az, dist - Math.max(150, dist * 0.02));
    if (block == null) return null;
    return block > elev + tol;
  }

  /**
   * 在天際線上找出局部最高點（山頭）。供 AR 把名稱掛在真正的峰頂上，
   * 而不是浮在半空中。
   *
   * @param points   skylineFromRays 的輸出
   * @param minProm  最小突起度（度）：比左右鄰谷高出這麼多才算一座山頭
   * @returns [{az, elev, dist, ground, prominence}]
   */
  function skylinePeaks(points, minProm = 0.35) {
    const p = (points || []).filter((x) => x.elev != null);
    const n = p.length;
    if (n < 3) return [];
    const out = [];
    for (let i = 0; i < n; i++) {
      const cur = p[i];
      const prev = p[(i - 1 + n) % n], next = p[(i + 1) % n];
      if (!(cur.elev > prev.elev && cur.elev >= next.elev)) continue;
      // 往兩側走到開始回升為止，取較高的那側鞍部當基準
      let l = cur.elev, r = cur.elev;
      for (let s = 1; s < n / 2; s++) {
        const v = p[(i - s + n) % n].elev;
        if (v > l && v > cur.elev) break;
        l = Math.min(l, v);
      }
      for (let s = 1; s < n / 2; s++) {
        const v = p[(i + s) % n].elev;
        if (v > r && v > cur.elev) break;
        r = Math.min(r, v);
      }
      const prominence = cur.elev - Math.max(l, r);
      if (prominence >= minProm) out.push({ ...cur, prominence });
    }
    return out.sort((a, b) => b.prominence - a.prominence);
  }

  global.Elevation = {
    fetchElevations, elevationAt, buildProfile, analyzePath, deygoutLossDb,
    computeCoveragePolygon, computeSkyline, skylineFromRays, skylinePeaks,
    skylineElevAt, skylineBlockAt, skylineHides,
    marchSkyline, ringTiles, demPixelM, despikeTile, SKY_RINGS,
    K_OPTICAL,
    // DEM 圖磚
    decodeTerrarium, decodeTerrariumPng, tileCoord, pickZoom, demElevations,
    setDemEnabled, demSupported, _demTiles: demTiles,
    _cache: cache,
  };
})(typeof window !== 'undefined' ? window : globalThis);
