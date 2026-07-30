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
  async function fetchElevations(points) {
    const out = new Array(points.length).fill(null);
    const need = [];
    points.forEach((p, i) => {
      const k = keyOf(p);
      if (cache.has(k)) out[i] = cache.get(k);
      else need.push({ i, p, k });
    });
    const CHUNK = 100;
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
   * 視線/無線電路徑遮蔽分析。
   *
   * @param profile   buildProfile() 的輸出（含端點）
   * @param opts.obsAntenna  觀測端天線離地高 (m)
   * @param opts.tgtAntenna  目標端天線離地高 (m)
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
      freqMHz = 145,
      k = Geo.K_DEFAULT,
    } = opts;

    const first = profile[0];
    const last = profile[profile.length - 1];
    const D = last.dist;

    // 端點「天線頂」海拔
    const h1 = (first.ground ?? 0) + obsAntenna;
    const h2 = (last.ground ?? 0) + tgtAntenna;

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

    // 連結預算：自由空間損耗 + 單一刀刃繞射損耗（取最壞點近似）
    const fspl = Geo.fsplDb(D, freqMHz);
    const diffractionLoss = Geo.knifeEdgeLossDb(maxV);
    const totalLoss = fspl + diffractionLoss;

    return {
      clear, losClear, worst, obstructions, samples, D, h1, h2, freqMHz,
      fspl, diffractionLoss, totalLoss, maxV,
    };
  }

  global.Elevation = {
    fetchElevations, elevationAt, buildProfile, analyzePath,
    _cache: cache,
  };
})(typeof window !== 'undefined' ? window : globalThis);
