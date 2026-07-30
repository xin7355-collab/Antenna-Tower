/*
 * geo.js — 地理與無線電路徑數學核心 (Geographic & RF path math)
 * ------------------------------------------------------------------
 * 純函式，無外部相依，可獨立測試。
 * 提供：直線距離、方位角、目標仰角、地球曲率隆起、無線電視距、
 *       菲涅耳區半徑、大圓路徑取樣等。
 *
 * 座標一律使用 {lat, lng} (十進位度數 WGS84)，高度單位公尺。
 */
(function (global) {
  'use strict';

  const R_EARTH = 6371008.8;   // 地球平均半徑 (m)
  const C_LIGHT = 299792458;   // 光速 (m/s)
  // 無線電折射修正：等效地球半徑係數 k，標準大氣約 4/3。
  const K_DEFAULT = 4 / 3;

  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  /**
   * Haversine 直線（大圓）距離，回傳公尺。
   */
  function distance(a, b) {
    const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
    const dφ = toRad(b.lat - a.lat);
    const dλ = toRad(b.lng - a.lng);
    const s =
      Math.sin(dφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /**
   * 從 a 指向 b 的初始方位角 (0..360，正北為 0，順時針)。
   */
  function bearing(a, b) {
    const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
    const dλ = toRad(b.lng - a.lng);
    const y = Math.sin(dλ) * Math.cos(φ2);
    const x =
      Math.cos(φ1) * Math.sin(φ2) -
      Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /**
   * 把方位角轉成 8 方位中文字（用在照片中的「南東」那種標示）。
   */
  function compass8(deg) {
    const names = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
    return names[Math.round(((deg % 360) / 45)) % 8];
  }
  function compass16(deg) {
    const n = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
               'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return n[Math.round(((deg % 360) / 22.5)) % 16];
  }

  /**
   * 從起點沿方位角前進 distance 公尺後的座標（大圓）。
   */
  function destination(a, bearingDeg, distanceM) {
    const δ = distanceM / R_EARTH;
    const θ = toRad(bearingDeg);
    const φ1 = toRad(a.lat), λ1 = toRad(a.lng);
    const φ2 = Math.asin(
      Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
    );
    const λ2 =
      λ1 +
      Math.atan2(
        Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
      );
    return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 };
  }

  /**
   * 在 a、b 之間沿大圓取樣 n+1 個點（含端點）。
   */
  function samplePath(a, b, n) {
    const φ1 = toRad(a.lat), λ1 = toRad(a.lng);
    const φ2 = toRad(b.lat), λ2 = toRad(b.lng);
    const d = distance(a, b) / R_EARTH; // 角距離
    const pts = [];
    if (d === 0) return [{ ...a }];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const A = Math.sin((1 - f) * d) / Math.sin(d);
      const B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
      const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
      const z = A * Math.sin(φ1) + B * Math.sin(φ2);
      pts.push({
        lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
        lng: toDeg(Math.atan2(y, x)),
        frac: f,
      });
    }
    return pts;
  }

  /**
   * 地球曲率隆起：在距觀測者 d1、距目標 d2 的中間點，地面相對於
   * 兩端連線「鼓起」的高度 (m)。k 為等效地球半徑係數。
   *   bulge = d1 * d2 / (2 * k * R)
   */
  function earthBulge(d1, d2, k = K_DEFAULT) {
    return (d1 * d2) / (2 * k * R_EARTH);
  }

  /**
   * 無線電視距（地平線距離，km）：h 為天線海拔高度 (m)。
   *   d ≈ sqrt(2 * k * R * h)
   * 兩端相加即為理論最大通聯距離。
   */
  function radioHorizonKm(hMeters, k = K_DEFAULT) {
    return Math.sqrt(2 * k * R_EARTH * Math.max(0, hMeters)) / 1000;
  }

  /**
   * 第 n 菲涅耳區半徑 (m)：
   *   Fn = sqrt( n * λ * d1 * d2 / (d1 + d2) )
   * freqMHz 頻率 (MHz)，d1/d2 為到兩端距離 (m)。
   */
  function fresnelRadius(d1, d2, freqMHz, n = 1) {
    const λ = C_LIGHT / (freqMHz * 1e6);
    const D = d1 + d2;
    if (D === 0) return 0;
    return Math.sqrt((n * λ * d1 * d2) / D);
  }

  /**
   * 目標仰角 (度)：觀測者海拔 obsAlt，目標海拔 tgtAlt，
   * 水平直線距離 distM。含地球曲率修正（withCurvature=true）。
   * 正值代表要抬頭，負值代表要低頭。
   */
  function elevationAngle(obsAlt, tgtAlt, distM, withCurvature = true, k = K_DEFAULT) {
    const drop = withCurvature ? (distM * distM) / (2 * k * R_EARTH) : 0;
    return toDeg(Math.atan2(tgtAlt - obsAlt - drop, distM));
  }

  /**
   * 把公尺距離格式化為易讀字串。
   */
  function fmtDistance(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    if (m < 100000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m / 1000)} km`;
  }

  global.Geo = {
    R_EARTH, C_LIGHT, K_DEFAULT,
    toRad, toDeg,
    distance, bearing, compass8, compass16,
    destination, samplePath,
    earthBulge, radioHorizonKm, fresnelRadius, elevationAngle,
    fmtDistance,
  };
})(typeof window !== 'undefined' ? window : globalThis);
