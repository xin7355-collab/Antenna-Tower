/*
 * elevation.js — 高程資料 + 視線/無線電路徑遮蔽分析
 * ------------------------------------------------------------------
 * 「中間有沒有山擋住？」的核心邏輯。
 *
 * 1. 透過 Open-Meteo Elevation API 取得任意座標的地面海拔（免金鑰）。
 * 2. 沿兩點大圓路徑取樣，組出「地形剖面」。
 * 3. 以地球曲率 + 菲涅耳區判斷無線電/視線路徑是否被地形擋住。
 *
 * 若無網路（離線），可退回使用資料集中已知山峰高程做粗略估計。
 */
(function (global) {
  'use strict';

  const Geo = global.Geo;
  const API = 'https://api.open-meteo.com/v1/elevation';
  const cache = new Map(); // key: "lat,lng"(4dp) -> elevation(m)

  const keyOf = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

  /**
   * 批次查詢多點海拔。Open-Meteo 單次上限約 100 點，超過自動分批。
   * 回傳與輸入等長的海拔陣列 (m)；查不到的填 null。
   */
  async function fetchElevations(points, opts = {}) {
    const out = new Array(points.length).fill(null);
    const need = [];
    points.forEach((p, i) => {
      const k = keyOf(p);
      if (cache.has(k)) out[i] = cache.get(k);
      else need.push({ i, p, k });
    });
    const CHUNK = 100;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    if (onProgress) onProgress(points.length - need.length, points.length);
    for (let s = 0; s < need.length; s += CHUNK) {
      const slice = need.slice(s, s + CHUNK);
      const lats = slice.map((x) => x.p.lat.toFixed(5)).join(',');
      const lngs = slice.map((x) => x.p.lng.toFixed(5)).join(',');
      const url = `${API}?latitude=${lats}&longitude=${lngs}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Elevation API ${res.status}`);
      const json = await res.json();
      const arr = json.elevation || [];
      slice.forEach((x, j) => {
        const e = arr[j];
        if (typeof e === 'number') {
          cache.set(x.k, e);
          out[x.i] = e;
        }
      });
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

  /**
   * 取得觀測者四周的天際線輪廓，供 AR 畫出「沿著山形的山體形狀」。
   *
   * 取樣距離採等比（對數）間隔：近處密、遠處疏。天際線多半由近中距離的
   * 稜線決定，等比間隔能用少得多的點數換到同樣的輪廓精度。
   *
   * @param observer {lat,lng,alt}
   * @param opts.eyeHeight  觀測者離地高度 (m)，預設 2（站著的人）
   * @param opts.azimuths   方位取樣數，預設 120（每 3°）
   * @param opts.samples    每條射線的取樣點數，預設 28
   * @param opts.maxRangeKm 最遠取樣距離，預設 90 km
   * @param opts.minRangeM  最近取樣距離，預設 250 m
   * @param opts.onProgress (done, total) 進度回呼
   * @returns { at:{lat,lng}, obsAlt, points:[{az, elev, dist, ground}] }
   */
  async function computeSkyline(observer, opts = {}) {
    const {
      eyeHeight = 2, azimuths = 120, samples = 28,
      maxRangeKm = 90, minRangeM = 250, k = K_OPTICAL, onProgress = null,
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
    const elevs = await fetchElevations(flat, { onProgress });
    let idx = 0;
    rays.forEach((r) => r.pts.forEach((p) => { p.ground = elevs[idx++]; }));
    const centerGround = elevs[idx] != null ? elevs[idx] : (observer.alt || 0);
    const obsAlt = centerGround + eyeHeight;

    return { at: { lat: observer.lat, lng: observer.lng }, obsAlt, points: skylineFromRays(rays, obsAlt, k) };
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
    K_OPTICAL,
    _cache: cache,
  };
})(typeof window !== 'undefined' ? window : globalThis);
