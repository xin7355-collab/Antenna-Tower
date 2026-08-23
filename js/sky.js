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

  /*
   * 亮星表（J2000，RA/Dec 度，視星等）
   * key 供星座連線引用；星等超過顯示上限的星，若被星座用到仍會畫出來，
   * 否則北斗七星會因為天權(3.31等)較暗而缺一角。
   */
  const STARS = [
    { key: 'sirius', name: '天狼星 Sirius', ra: 101.287, dec: -16.716, mag: -1.46 },
    { key: 'canopus', name: '老人星 Canopus', ra: 95.988, dec: -52.696, mag: -0.74 },
    { key: 'arcturus', name: '大角 Arcturus', ra: 213.915, dec: 19.182, mag: -0.05 },
    { key: 'vega', name: '織女星 Vega', ra: 279.234, dec: 38.784, mag: 0.03 },
    { key: 'capella', name: '五車二 Capella', ra: 79.172, dec: 45.998, mag: 0.08 },
    { key: 'rigel', name: '參宿七 Rigel', ra: 78.634, dec: -8.202, mag: 0.13 },
    { key: 'procyon', name: '南河三 Procyon', ra: 114.825, dec: 5.225, mag: 0.34 },
    { key: 'betelgeuse', name: '參宿四 Betelgeuse', ra: 88.793, dec: 7.407, mag: 0.50 },
    { key: 'achernar', name: '水委一 Achernar', ra: 24.429, dec: -57.237, mag: 0.46 },
    { key: 'altair', name: '牛郎星 Altair', ra: 297.696, dec: 8.868, mag: 0.77 },
    { key: 'aldebaran', name: '畢宿五 Aldebaran', ra: 68.980, dec: 16.509, mag: 0.85 },
    { key: 'antares', name: '心宿二 Antares', ra: 247.352, dec: -26.432, mag: 1.09 },
    { key: 'spica', name: '角宿一 Spica', ra: 201.298, dec: -11.161, mag: 1.04 },
    { key: 'pollux', name: '北河三 Pollux', ra: 116.329, dec: 28.026, mag: 1.14 },
    { key: 'fomalhaut', name: '北落師門 Fomalhaut', ra: 344.413, dec: -29.622, mag: 1.16 },
    { key: 'deneb', name: '天津四 Deneb', ra: 310.358, dec: 45.280, mag: 1.25 },
    { key: 'regulus', name: '軒轅十四 Regulus', ra: 152.093, dec: 11.967, mag: 1.35 },
    { key: 'castor', name: '北河二 Castor', ra: 113.650, dec: 31.888, mag: 1.58 },
    { key: 'polaris', name: '北極星 Polaris', ra: 37.954, dec: 89.264, mag: 1.98 },
    { key: 'hamal', name: '婁宿三 Hamal', ra: 31.793, dec: 23.462, mag: 2.00 },
    { key: 'markab', name: '室宿一 Markab', ra: 346.190, dec: 15.205, mag: 2.49 },
    // 北斗七星（大熊座斗杓）
    { key: 'dubhe', name: '天樞 Dubhe', ra: 165.932, dec: 61.751, mag: 1.79 },
    { key: 'merak', name: '天璇 Merak', ra: 165.460, dec: 56.382, mag: 2.37 },
    { key: 'phecda', name: '天璣 Phecda', ra: 178.458, dec: 53.695, mag: 2.44 },
    { key: 'megrez', name: '天權 Megrez', ra: 183.857, dec: 57.033, mag: 3.31 },
    { key: 'alioth', name: '玉衡 Alioth', ra: 193.507, dec: 55.960, mag: 1.76 },
    { key: 'mizar', name: '開陽 Mizar', ra: 200.981, dec: 54.925, mag: 2.04 },
    { key: 'alkaid', name: '搖光 Alkaid', ra: 206.885, dec: 49.313, mag: 1.86 },
    // 獵戶座
    { key: 'bellatrix', name: '參宿五 Bellatrix', ra: 81.283, dec: 6.350, mag: 1.64 },
    { key: 'alnitak', name: '參宿一 Alnitak', ra: 85.190, dec: -1.943, mag: 1.74 },
    { key: 'alnilam', name: '參宿二 Alnilam', ra: 84.053, dec: -1.202, mag: 1.69 },
    { key: 'mintaka', name: '參宿三 Mintaka', ra: 83.002, dec: -0.299, mag: 2.23 },
    { key: 'saiph', name: '參宿六 Saiph', ra: 86.939, dec: -9.670, mag: 2.06 },
    // 仙后座（W 形）
    { key: 'schedar', name: '王良四 Schedar', ra: 10.127, dec: 56.537, mag: 2.24 },
    { key: 'caph', name: '王良一 Caph', ra: 2.294, dec: 59.150, mag: 2.27 },
    { key: 'gammacas', name: '策 γ Cas', ra: 14.177, dec: 60.717, mag: 2.47 },
    { key: 'ruchbah', name: '閣道三 Ruchbah', ra: 21.454, dec: 60.235, mag: 2.68 },
    { key: 'segin', name: '閣道二 Segin', ra: 28.599, dec: 63.670, mag: 3.38 },
    // 南十字座
    { key: 'acrux', name: '十字架二 Acrux', ra: 186.650, dec: -63.099, mag: 0.77 },
    { key: 'mimosa', name: '十字架三 Mimosa', ra: 191.930, dec: -59.689, mag: 1.25 },
    { key: 'gacrux', name: '十字架一 Gacrux', ra: 187.791, dec: -57.113, mag: 1.63 },
    { key: 'imai', name: '十字架四 Imai', ra: 183.786, dec: -58.749, mag: 2.79 },
    // 天蠍座
    { key: 'graffias', name: '房宿四 Graffias', ra: 241.359, dec: -19.805, mag: 2.62 },
    { key: 'dschubba', name: '房宿三 Dschubba', ra: 240.083, dec: -22.622, mag: 2.29 },
    { key: 'pisco', name: '房宿一 π Sco', ra: 239.713, dec: -26.114, mag: 2.89 },
    { key: 'tausco', name: '心宿三 τ Sco', ra: 248.971, dec: -28.216, mag: 2.82 },
    { key: 'epssco', name: '尾宿二 ε Sco', ra: 252.541, dec: -34.293, mag: 2.29 },
    { key: 'musco', name: '尾宿一 μ¹ Sco', ra: 253.084, dec: -38.047, mag: 3.00 },
    { key: 'zetasco', name: '尾宿三 ζ Sco', ra: 253.646, dec: -42.362, mag: 3.62 },
    { key: 'etasco', name: '尾宿四 η Sco', ra: 258.038, dec: -43.239, mag: 3.33 },
    { key: 'thetasco', name: '尾宿五 θ Sco', ra: 264.330, dec: -42.998, mag: 1.86 },
    { key: 'kappasco', name: '尾宿七 κ Sco', ra: 265.622, dec: -39.030, mag: 2.41 },
    { key: 'shaula', name: '尾宿八 Shaula', ra: 263.402, dec: -37.104, mag: 1.63 },
  ];

  const STAR_BY_KEY = new Map(STARS.map((s) => [s.key, s]));

  /*
   * 星座 / 星群連線。lines 為成對的星 key，畫成折線。
   * dashed=true 者為「想像出來的輔助線」（大三角、指極線），以虛線區別，
   * 免得跟真正的星座連線混淆。
   */
  const CONSTELLATIONS = [
    {
      id: 'bigdipper', name: '北斗七星',
      lines: [['alkaid', 'mizar'], ['mizar', 'alioth'], ['alioth', 'megrez'],
        ['megrez', 'phecda'], ['phecda', 'merak'], ['merak', 'dubhe'], ['dubhe', 'megrez']],
    },
    {
      id: 'pointer', name: '指極線→北極星', dashed: true,
      lines: [['merak', 'dubhe'], ['dubhe', 'polaris']],
    },
    {
      id: 'orion', name: '獵戶座',
      lines: [['betelgeuse', 'bellatrix'], ['bellatrix', 'mintaka'], ['mintaka', 'alnilam'],
        ['alnilam', 'alnitak'], ['betelgeuse', 'alnitak'], ['alnitak', 'saiph'],
        ['mintaka', 'rigel'], ['rigel', 'saiph']],
    },
    {
      id: 'cassiopeia', name: '仙后座',
      lines: [['caph', 'schedar'], ['schedar', 'gammacas'], ['gammacas', 'ruchbah'], ['ruchbah', 'segin']],
    },
    {
      id: 'scorpius', name: '天蠍座',
      lines: [['graffias', 'dschubba'], ['dschubba', 'pisco'], ['dschubba', 'antares'],
        ['antares', 'tausco'], ['tausco', 'epssco'], ['epssco', 'musco'], ['musco', 'zetasco'],
        ['zetasco', 'etasco'], ['etasco', 'thetasco'], ['thetasco', 'kappasco'], ['kappasco', 'shaula']],
    },
    {
      id: 'crux', name: '南十字座',
      lines: [['acrux', 'gacrux'], ['mimosa', 'imai']],
    },
    {
      id: 'summer', name: '夏季大三角', dashed: true,
      lines: [['vega', 'deneb'], ['deneb', 'altair'], ['altair', 'vega']],
    },
    {
      id: 'winter', name: '冬季大三角', dashed: true,
      lines: [['betelgeuse', 'sirius'], ['sirius', 'procyon'], ['procyon', 'betelgeuse']],
    },
  ];

  // 被任一星座用到的星 key（這些星即使較暗也要畫，否則連線會斷點）
  const CONSTELLATION_KEYS = new Set(
    CONSTELLATIONS.flatMap((c) => c.lines.flat())
  );

  /**
   * 回傳所有天體的地平座標。
   * @param date JS Date（UTC 內部處理）
   * @param lat,lng 觀測者經緯度
   * @param opts.stars         是否含亮星（預設 true）
   * @param opts.maxMag        顯示星等上限（預設 2.5）
   * @param opts.constellations 是否畫星座連線；true 時星座用到的星
   *                            即使暗於 maxMag 也一併回傳，避免連線斷點
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
      const wantCon = !!opts.constellations;
      STARS.forEach((st) => {
        if (st.mag > maxMag && !(wantCon && CONSTELLATION_KEYS.has(st.key))) return;
        add('star-' + st.key, st.name, 'star', st.ra, st.dec, { mag: st.mag, starKey: st.key });
      });
    }
    return out;
  }

  /**
   * 星座 / 星群連線的地平座標。
   *
   * 回傳 [{ id, name, dashed, segments:[{a,b}], stars:[{key,name,az,alt,mag}], label:{az,alt}, maxAlt }]
   * 其中 a/b 皆為 {key, az, alt}。連線與星點都直接給地平座標，
   * 呼叫端（AR）只要投影即可，不需要再碰天文計算。
   *
   * @param opts.minAlt 整個星座最高星低於此仰角就略過（預設 -10，即幾乎全沉入地平線下才不畫）
   */
  function constellationLines(date, lat, lng, opts = {}) {
    const jd = julianDate(date);
    const minAlt = opts.minAlt != null ? opts.minAlt : -10;
    const only = opts.only && opts.only.length ? new Set(opts.only) : null;
    const horiz = new Map();
    const at = (key) => {
      if (horiz.has(key)) return horiz.get(key);
      const st = STAR_BY_KEY.get(key);
      if (!st) return null;
      const h = equToHor(st.ra, st.dec, jd, lat, lng);
      const v = { key, name: st.name, mag: st.mag, az: h.az, alt: h.alt };
      horiz.set(key, v);
      return v;
    };

    const out = [];
    CONSTELLATIONS.forEach((c) => {
      if (only && !only.has(c.id)) return;
      const segments = [];
      const members = new Map();
      c.lines.forEach(([ka, kb]) => {
        const a = at(ka), b = at(kb);
        if (!a || !b) return;
        members.set(ka, a); members.set(kb, b);
        segments.push({ a, b });
      });
      if (!segments.length) return;
      const stars = [...members.values()];
      const maxAlt = Math.max(...stars.map((s) => s.alt));
      if (maxAlt < minAlt) return;   // 整組沉在地平線下，不畫
      out.push({ id: c.id, name: c.name, dashed: !!c.dashed, segments, stars, maxAlt, label: centroid(stars) });
    });
    return out;
  }

  /** 一群天體的方位/仰角中心（方位以向量平均，避免 0°/360° 接縫問題） */
  function centroid(pts) {
    let sx = 0, sy = 0, sa = 0;
    pts.forEach((p) => { sx += cos(p.az); sy += sin(p.az); sa += p.alt; });
    return { az: norm360(atan2(sy, sx)), alt: sa / pts.length };
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

  // 地理座標(WGS84) → ECEF (m)
  function geodeticToEcef(lat, lng, h) {
    const a = 6378137, e2 = 0.00669437999014;
    const N = a / Math.sqrt(1 - e2 * sin(lat) * sin(lat));
    return {
      x: (N + h) * cos(lat) * cos(lng),
      y: (N + h) * cos(lat) * sin(lng),
      z: (N * (1 - e2) + h) * sin(lat),
    };
  }

  /**
   * 從觀測者看目標（如衛星）的方位/仰角。
   * @param obs {lat,lng,alt(m)}   @param tgt {lat,lng,altKm}
   * @returns {az, el, rangeKm}
   */
  function lookAngles(obs, tgt) {
    const o = geodeticToEcef(obs.lat, obs.lng, obs.alt || 0);
    const t = geodeticToEcef(tgt.lat, tgt.lng, (tgt.altKm || 0) * 1000);
    const dx = t.x - o.x, dy = t.y - o.y, dz = t.z - o.z;
    const φ = obs.lat, λ = obs.lng;
    const e = -sin(λ) * dx + cos(λ) * dy;
    const n = -sin(φ) * cos(λ) * dx - sin(φ) * sin(λ) * dy + cos(φ) * dz;
    const u = cos(φ) * cos(λ) * dx + cos(φ) * sin(λ) * dy + sin(φ) * dz;
    const range = Math.sqrt(e * e + n * n + u * u);
    return {
      az: norm360(atan2(e, n)),
      el: asin(u / range),
      rangeKm: range / 1000,
    };
  }

  global.Sky = {
    skyObjects, eclipticPath, constellationLines, centroid,
    julianDate, gmst, lst, obliquity,
    sunEqu, moonEqu, planetEqu, equToHor, eclToEqu, geodeticToEcef, lookAngles,
    PLANETS, STARS, STAR_BY_KEY, CONSTELLATIONS, CONSTELLATION_KEYS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
