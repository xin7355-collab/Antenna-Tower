/*
 * sky.js — 天文層：太陽/月亮/行星/亮星 的方位與仰角
 * ------------------------------------------------------------------
 * 純函式、無外部相依、可獨立測試。由「日期時間 + 觀測者經緯度」算出
 * 各天體的地平座標（方位角 az、仰角 alt），供 AR 疊加。
 *
 * 演算法：Meeus 低精度太陽/月亮 + JPL 近似 Keplerian 行星（Standish
 * 1800–2050），精度約 0.1–1°，對 AR 顯示足夠。
 */
(function (global) {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const sin = (d) => Math.sin(d * D2R), cos = (d) => Math.cos(d * D2R), tan = (d) => Math.tan(d * D2R);
  const asin = (x) => Math.asin(x) * R2D, atan2 = (y, x) => Math.atan2(y, x) * R2D;
  const norm360 = (d) => ((d % 360) + 360) % 360;
  const norm180 = (d) => { d = norm360(d); return d > 180 ? d - 360 : d; };

  // 儒略日（UTC）
  function julianDate(date) { return date.getTime() / 86400000 + 2440587.5; }
  function centuries(jd) { return (jd - 2451545.0) / 36525; }

  // 平均恆星時（格林威治，度）
  function gmst(jd) {
    const T = centuries(jd);
    let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000;
    return norm360(g);
  }
  // 地方恆星時（度）；lng 東經為正
  function lst(jd, lng) { return norm360(gmst(jd) + lng); }

  // 黃赤交角（度）
  function obliquity(T) { return 23.439291 - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T; }

  // 黃道 (λ,β) → 赤道 (RA,Dec)，單位度
  function eclToEqu(lam, beta, eps) {
    const ra = atan2(sin(lam) * cos(eps) - tan(beta) * sin(eps), cos(lam));
    const dec = asin(sin(beta) * cos(eps) + cos(beta) * sin(eps) * sin(lam));
    return { ra: norm360(ra), dec };
  }

  // 赤道 (RA,Dec) → 地平 (az 由北順時針, alt)，單位度
  function equToHor(ra, dec, jd, lat, lng) {
    const H = norm180(lst(jd, lng) - ra); // 時角
    const alt = asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H));
    const az = atan2(-cos(dec) * sin(H), sin(dec) * cos(lat) - cos(dec) * sin(lat) * cos(H));
    return { az: norm360(az), alt };
  }

  // 太陽（Meeus 低精度）→ 赤道
  function sunEqu(jd) {
    const T = centuries(jd);
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M)
      + (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
    const lam = L0 + C;
    return { ...eclToEqu(norm360(lam), 0, obliquity(T)), lam: norm360(lam) };
  }

  // 月亮（Meeus 簡化，主要項）→ 赤道 + 相位
  function moonEqu(jd) {
    const T = centuries(jd);
    const Lp = 218.3164477 + 481267.88123421 * T;
    const D = 297.8501921 + 445267.1114034 * T;
    const M = 357.5291092 + 35999.0502909 * T;
    const Mp = 134.9633964 + 477198.8675055 * T;
    const F = 93.2720950 + 483202.0175233 * T;
    const lam = Lp
      + 6.289 * sin(Mp) + 1.274 * sin(2 * D - Mp) + 0.658 * sin(2 * D)
      + 0.214 * sin(2 * Mp) - 0.186 * sin(M) - 0.114 * sin(2 * F)
      + 0.059 * sin(2 * D - 2 * Mp) + 0.057 * sin(2 * D - M - Mp)
      + 0.053 * sin(2 * D + Mp) + 0.046 * sin(2 * D - M) - 0.041 * sin(M - Mp)
      - 0.035 * sin(D) - 0.031 * sin(M + Mp);
    const beta = 5.128 * sin(F) + 0.281 * sin(Mp + F) + 0.278 * sin(F - Mp)
      + 0.173 * sin(2 * D - F) + 0.055 * sin(2 * D - Mp + F) + 0.046 * sin(2 * D - Mp - F)
      + 0.033 * sin(2 * D + F) + 0.017 * sin(2 * Mp + F);
    const eq = eclToEqu(norm360(lam), beta, obliquity(T));
    // 相位（照明比例）
    const elong = norm360(lam - sunEqu(jd).lam);
    const illum = (1 - cos(elong)) / 2;
    return { ...eq, lam: norm360(lam), illum, elong };
  }

  // JPL 近似行星元素（a[au] e I[deg] L[deg] ϖ[deg] Ω[deg]；及每世紀變率）
  const PLANETS = {
    水星: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
      0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
    金星: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
      0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
    火星: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
      0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
    木星: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
      -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
    土星: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
      -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  };
  const EARTH = [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
    0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0];

  function heliocentric(el, T) {
    const a = el[0] + el[6] * T, e = el[1] + el[7] * T, I = el[2] + el[8] * T;
    const L = el[3] + el[9] * T, w = el[4] + el[10] * T, O = el[5] + el[11] * T;
    let M = norm180(L - w);
    // Kepler（度）
    let E = M + (57.29578 * e) * sin(M);
    for (let k = 0; k < 8; k++) {
      const dM = M - (E - 57.29578 * e * sin(E));
      const dE = dM / (1 - e * cos(E));
      E += dE;
      if (Math.abs(dE) < 1e-7) break;
    }
    const xp = a * (cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * sin(E);
    const om = w - O; // 近點幅角
    const xe = (cos(om) * cos(O) - sin(om) * sin(O) * cos(I)) * xp + (-sin(om) * cos(O) - cos(om) * sin(O) * cos(I)) * yp;
    const ye = (cos(om) * sin(O) + sin(om) * cos(O) * cos(I)) * xp + (-sin(om) * sin(O) + cos(om) * cos(O) * cos(I)) * yp;
    const ze = (sin(om) * sin(I)) * xp + (cos(om) * sin(I)) * yp;
    return { xe, ye, ze };
  }

  function planetEqu(name, jd) {
    const T = centuries(jd);
    const p = heliocentric(PLANETS[name], T);
    const earth = heliocentric(EARTH, T);
    const x = p.xe - earth.xe, y = p.ye - earth.ye, z = p.ze - earth.ze; // 地心黃道(J2000)
    const eps = 23.43928;
    const xeq = x, yeq = cos(eps) * y - sin(eps) * z, zeq = sin(eps) * y + cos(eps) * z;
    return { ra: norm360(atan2(yeq, xeq)), dec: atan2(zeq, Math.sqrt(xeq * xeq + yeq * yeq)) };
  }

  // 亮星表（J2000，RA/Dec 度，視星等）
  const STARS = [
    ['天狼星 Sirius', 101.287, -16.716, -1.46], ['老人星 Canopus', 95.988, -52.696, -0.74],
    ['大角 Arcturus', 213.915, 19.182, -0.05], ['織女星 Vega', 279.234, 38.784, 0.03],
    ['五車二 Capella', 79.172, 45.998, 0.08], ['參宿七 Rigel', 78.634, -8.202, 0.13],
    ['南河三 Procyon', 114.825, 5.225, 0.34], ['參宿四 Betelgeuse', 88.793, 7.407, 0.5],
    ['水委一 Achernar', 24.429, -57.237, 0.46], ['牛郎星 Altair', 297.696, 8.868, 0.77],
    ['畢宿五 Aldebaran', 68.980, 16.509, 0.85], ['心宿二 Antares', 247.352, -26.432, 1.09],
    ['角宿一 Spica', 201.298, -11.161, 1.04], ['北河三 Pollux', 116.329, 28.026, 1.14],
    ['北落師門 Fomalhaut', 344.413, -29.622, 1.16], ['天津四 Deneb', 310.358, 45.280, 1.25],
    ['軒轅十四 Regulus', 152.093, 11.967, 1.35], ['北河二 Castor', 113.650, 31.888, 1.58],
    ['北極星 Polaris', 37.954, 89.264, 1.98], ['參宿五 Bellatrix', 81.283, 6.350, 1.64],
    ['參宿一 Alnitak', 85.190, -1.943, 1.74], ['參宿二 Alnilam', 84.053, -1.202, 1.69],
    ['參宿三 Mintaka', 83.002, -0.299, 2.23], ['天樞 Dubhe', 165.932, 61.751, 1.79],
    ['搖光 Alkaid', 206.885, 49.313, 1.86], ['玉衡 Alioth', 193.507, 55.960, 1.76],
    ['開陽 Mizar', 200.981, 54.925, 2.04], ['王良四 Schedar', 10.127, 56.537, 2.24],
    ['婁宿三 Hamal', 31.793, 23.462, 2.00], ['室宿一 Markab', 346.190, 15.205, 2.49],
  ];

  /**
   * 回傳所有天體的地平座標。
   * @param date JS Date（UTC 內部處理）
   * @param lat,lng 觀測者經緯度
   * @param opts.stars 是否含亮星（預設 true）
   */
  function skyObjects(date, lat, lng, opts = {}) {
    const jd = julianDate(date);
    const out = [];
    const add = (id, name, type, ra, dec, extra) => {
      const h = equToHor(ra, dec, jd, lat, lng);
      out.push({ id, name, type, az: h.az, alt: h.alt, ...extra });
    };
    const s = sunEqu(jd); add('sun', '☀ 太陽', 'sun', s.ra, s.dec);
    const m = moonEqu(jd); add('moon', moonEmoji(m.illum, m.elong) + ' 月亮', 'moon', m.ra, m.dec, { illum: m.illum });
    for (const name in PLANETS) { const p = planetEqu(name, jd); add('pl-' + name, name, 'planet', p.ra, p.dec); }
    if (opts.stars !== false) {
      const maxMag = opts.maxMag != null ? opts.maxMag : 2.5;
      STARS.forEach((st, i) => { if (st[3] <= maxMag) add('star-' + i, st[0], 'star', st[1], st[2], { mag: st[3] }); });
    }
    return out;
  }

  // 黃道線取樣（β=0）→ 地平座標，供畫「黃道」用
  function eclipticPath(date, lat, lng, step = 6) {
    const jd = julianDate(date), eps = obliquity(centuries(jd)), pts = [];
    for (let lam = 0; lam <= 360; lam += step) {
      const e = eclToEqu(lam, 0, eps);
      pts.push(equToHor(e.ra, e.dec, jd, lat, lng));
    }
    return pts;
  }

  function moonEmoji(illum, elong) {
    const waxing = elong < 180;
    if (illum < 0.06) return '🌑';
    if (illum > 0.94) return '🌕';
    if (Math.abs(illum - 0.5) < 0.1) return waxing ? '🌓' : '🌗';
    if (illum < 0.5) return waxing ? '🌒' : '🌘';
    return waxing ? '🌔' : '🌖';
  }

  global.Sky = {
    skyObjects, eclipticPath, julianDate, gmst, lst, obliquity,
    sunEqu, moonEqu, planetEqu, equToHor, eclToEqu, PLANETS, STARS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
