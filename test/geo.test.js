/*
 * geo.test.js — 無相依單元測試
 * 執行： node test/geo.test.js
 * 涵蓋 geo 數學、遮蔽/連結分析、Deygout、涵蓋多邊形、匯入解析。
 */
'use strict';
require('../js/geo.js');
require('../js/elevation.js');
require('../js/parse.js');
require('../js/sky.js');
require('../js/groups.js');
globalThis.satellite = require('../vendor/satellite/satellite.min.js');
require('../js/sats.js');
require('../js/ar.js');
const { Geo, Elevation, Parse, Sky, Groups, Sats, ARView } = globalThis;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log('geo — 距離/方位/座標');
{
  const a = { lat: 25.0330, lng: 121.5654 }; // 台北
  const b = { lat: 22.6273, lng: 120.3014 }; // 高雄
  const d = Geo.distance(a, b) / 1000;
  ok('台北-高雄距離 ~296 km', approx(d, 296, 8));
  const br = Geo.bearing(a, b);
  ok('台北→高雄方位偏西南 (200-215°)', br > 200 && br < 215);
  // destination 往返
  const p = Geo.destination(a, 90, 10000);
  ok('destination 10km 後距離回推 ~10km', approx(Geo.distance(a, p), 10000, 5));
  ok('compass8(90)=東', Geo.compass8(90) === '東');
  ok('compass8(315)=西北', Geo.compass8(315) === '西北');
}

console.log('geo — 仰角/曲率/視距/菲涅耳');
{
  ok('目標較高 → 仰角為正', Geo.elevationAngle(100, 2000, 20000, true) > 0);
  ok('含曲率仰角 < 不含曲率', Geo.elevationAngle(0, 0, 100000, true) < Geo.elevationAngle(0, 0, 100000, false));
  ok('30m 天線視距 ~22.6 km', approx(Geo.radioHorizonKm(30), 22.6, 1.5));
  ok('菲涅耳半徑為正', Geo.fresnelRadius(25000, 25000, 145) > 0);
}

console.log('geo — 連結預算');
{
  ok('FSPL 50km@145MHz ~109.6 dB', approx(Geo.fsplDb(50000, 145), 109.6, 0.5));
  ok('knifeEdge v=-1 → 0 dB', Geo.knifeEdgeLossDb(-1) === 0);
  ok('knifeEdge v=0 → ~6 dB', approx(Geo.knifeEdgeLossDb(0), 6, 0.3));
  ok('knifeEdge v=1 → ~14 dB', approx(Geo.knifeEdgeLossDb(1), 14, 0.5));
  ok('diffractionV：淨空為負', Geo.diffractionV(100, 50) < 0);
  ok('diffractionV：阻擋為正', Geo.diffractionV(-100, 50) > 0);
}

console.log('elevation — 遮蔽分析');
{
  const D = 50000, N = 50, prof = [];
  for (let i = 0; i <= N; i++) {
    let g = 100;
    if (i === N) g = 1500;
    if (i >= 24 && i <= 26) g = 2200; // 中間高山
    prof.push({ dist: (D * i) / N, ground: g });
  }
  const a = Elevation.analyzePath(prof, { obsAntenna: 3, tgtAntenna: 6, freqMHz: 145 });
  ok('偵測到被地形擋住 (losClear=false)', a.losClear === false);
  ok('有障礙點', a.obstructions.length > 0);
  ok('最緊要處淨空為負', a.worst.clearance < 0);
  ok('總損耗 = FSPL + 繞射', approx(a.totalLoss, a.fspl + a.diffractionLoss, 0.01));

  // 視距內淨空路徑
  const clr = [];
  for (let i = 0; i <= N; i++) clr.push({ dist: (10000 * i) / N, ground: i === N ? 50 : 20 });
  const b = Elevation.analyzePath(clr, { obsAntenna: 30, tgtAntenna: 30, freqMHz: 145 });
  ok('淨空路徑 losClear=true', b.losClear === true);
  ok('淨空路徑 Deygout ~0 dB', approx(b.diffractionMulti, 0, 0.01));
}

console.log('elevation — Deygout 多重刀刃');
{
  const D = 60000, N = 120, prof = [];
  for (let i = 0; i <= N; i++) {
    let g = 100;
    if (i === N) g = 1200;
    if (i >= 30 && i <= 33) g = 1800;
    if (i >= 70 && i <= 73) g = 1600;
    prof.push({ dist: (D * i) / N, ground: g });
  }
  const single = Elevation.analyzePath(prof, { obsAntenna: 3, tgtAntenna: 6, freqMHz: 145 });
  ok('兩山脊：Deygout ≥ 單刃', single.diffractionMulti >= single.diffractionSingle);
  ok('Deygout 有界 (<150 dB)', single.diffractionMulti < 150);
}

// 下列既有測試以 open-meteo 的 mock 驗證；DEM 圖磚另有專屬測試（runParseTests 內）
Elevation.setDemEnabled(false);

console.log('elevation — 地形涵蓋多邊形 (mock fetch)');
{
  const savedFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(url);
    const lats = u.searchParams.get('latitude').split(',').map(Number);
    const lngs = u.searchParams.get('longitude').split(',').map(Number);
    const elevation = lats.map((la, i) => {
      const dLng = lngs[i] - 121.0;
      return (dLng > 0.15 && dLng < 0.25) ? 3000 : 200; // 東側高牆
    });
    return { ok: true, json: async () => ({ elevation }) };
  };
  const center = { lat: 23.0, lng: 121.0, alt: 1500, antenna: 10 };
  return Elevation.computeCoveragePolygon(center, { antenna: 10, rxHeight: 10, azimuths: 24, samples: 24 })
    .then((poly) => {
      ok('多邊形 24 頂點', poly.length === 24);
      const dE = Geo.distance(center, { lat: poly[6][0], lng: poly[6][1] });
      const dW = Geo.distance(center, { lat: poly[18][0], lng: poly[18][1] });
      ok('東側(高牆)涵蓋 < 西側(淨空)', dE < dW);
      global.fetch = savedFetch;
      runParseTests();
    });
}

async function runParseTests() {
  console.log('parse — CSV/GPX/JSON');
  const csv = 'name,lat,lng,alt,antenna,freq\nA,23.4,120.9,3000,10,145.5\n壞,,,\n';
  const r1 = Parse.parseStations(csv, 'x.csv');
  ok('CSV 追加模式、略過壞列 (1 筆)', r1.mode === 'append' && r1.stations.length === 1);
  ok('CSV 欄位對應正確', r1.stations[0].alt === 3000 && r1.stations[0].freqMHz === 145.5);

  const gpx = '<gpx><wpt lon="121.5" lat="25.2"><ele>1103</ele><name>竹子山</name></wpt><wpt lat="24.6" lon="121.1"/></gpx>';
  const r2 = Parse.parseStations(gpx, 'x.gpx');
  ok('GPX 解析 2 航點（含自封閉、屬性順序不定）', r2.stations.length === 2);
  ok('GPX 名稱/高度正確', r2.stations[0].name === '竹子山' && r2.stations[0].alt === 1103);

  const json = JSON.stringify({ stations: [{ id: 'j', type: 'station', name: 'J', lat: 23, lng: 121, alt: 0 }] });
  const r3 = Parse.parseStations(json, 'x.json');
  ok('JSON 取代模式', r3.mode === 'replace' && r3.stations.length === 1);

  console.log('parse — 萬用座標');
  const coordCases = [
    ['23.47, 120.957', 23.47, 120.957],
    ['N23.47 E120.957', 23.47, 120.957],
    ['23.47N, 120.957E', 23.47, 120.957],
    ["23°28'12\"N 120°57'25\"E", 23.47, 120.9569],
    ['23 28 12 N, 120 57 25 E', 23.47, 120.9569],
    ['S23.47 W120.957', -23.47, -120.957],
  ];
  coordCases.forEach(([s, la, lo]) => {
    const r = Parse.parseLatLng(s);
    ok('座標 ' + s, r && approx(r.lat, la, 0.01) && approx(r.lng, lo, 0.01));
  });
  ok('無效座標回傳 null', Parse.parseLatLng('abc') === null && Parse.parseLatLng('999,999') === null);

  console.log('geo/elevation — 目標真實高度覆蓋');
  ok('無 trueAlt → 海拔+天線', Geo.targetTopAlt({ alt: 1000, antenna: 30 }) === 1030);
  ok('有 trueAlt → 覆蓋為優先高度', Geo.targetTopAlt({ alt: 1000, antenna: 30, trueAlt: 3080 }) === 3080);
  ok('trueAlt 空字串視為未填', Geo.targetTopAlt({ alt: 1000, antenna: 30, trueAlt: '' }) === 1030);
  ok('usesTrueAlt 判斷正確',
    Geo.usesTrueAlt({ trueAlt: 3080 }) && !Geo.usesTrueAlt({ trueAlt: '' }) && !Geo.usesTrueAlt({}));
  {
    const D = 50000, N = 50, prof = [];
    for (let i = 0; i <= N; i++) prof.push({ dist: (D * i) / N, ground: i === N ? 500 : 100 });
    const noOv = Elevation.analyzePath(prof, { obsAntenna: 3, tgtAntenna: 10, freqMHz: 145 });
    const ov = Elevation.analyzePath(prof, { obsAntenna: 3, tgtAntenna: 10, tgtTopAlt: 3000, freqMHz: 145 });
    ok('analyzePath 無覆蓋 h2 = 地面+天線', noOv.h2 === 510);
    ok('analyzePath tgtTopAlt 覆蓋 h2', ov.h2 === 3000);
  }
  {
    const r = Parse.parseStations('name,lat,lng,alt,真實高度\nA,23.4,120.9,1000,3080\nB,23.5,120.8,900,\n', 'x.csv');
    ok('CSV 匯入真實高度', r.stations[0].trueAlt === 3080);
    ok('CSV 真實高度留空則不設', r.stations[1].trueAlt === undefined);
  }

  console.log('sky — 天文位置');
  const jd0 = Sky.julianDate(new Date(Date.UTC(2000, 0, 1, 12, 0, 0)));
  const sun0 = Sky.sunEqu(jd0);
  ok('太陽@J2000 RA ~281.3°', approx(sun0.ra, 281.3, 0.5));
  ok('太陽@J2000 Dec ~-23.0°', approx(sun0.dec, -23.0, 0.3));
  const objs = Sky.skyObjects(new Date(Date.UTC(2026, 5, 21, 4, 0, 0)), 25.03, 121.56);
  const pol = objs.find((o) => o.name.includes('Polaris'));
  ok('北極星仰角 ≈ 緯度', approx(pol.alt, 25.03, 1.0));
  ok('北極星方位 ≈ 北', pol.az < 3 || pol.az > 357);
  ok('五大行星皆計算', objs.filter((o) => o.type === 'planet').length === 5);
  ok('所有天體 alt/az 在範圍內', objs.every((o) => o.alt >= -90 && o.alt <= 90 && o.az >= 0 && o.az <= 360));

  console.log('sky — 衛星視角');
  const over = Sky.lookAngles({ lat: 25, lng: 121, alt: 0 }, { lat: 25, lng: 121, altKm: 420 });
  ok('衛星正上方 → 仰角 ~90°', approx(over.el, 90, 0.5));
  ok('衛星正上方 → 距離 ~420 km', approx(over.rangeKm, 420, 5));
  const north = Sky.lookAngles({ lat: 25, lng: 121, alt: 0 }, { lat: 28, lng: 121, altKm: 420 });
  ok('衛星偏北 → 方位 ~0°(北)', north.az < 3 || north.az > 357);
  ok('lookAnglesEcef 與 lookAngles 一致', (() => {
    const o = { lat: 23.5, lng: 120.8, alt: 100 };
    const g = { lat: 25.2, lng: 122.1, altKm: 420 };
    const a = Sky.lookAngles(o, g);
    const b = Sky.lookAnglesEcef(o, Sky.geodeticToEcef(g.lat, g.lng, g.altKm * 1000));
    return approx(a.az, b.az, 1e-9) && approx(a.el, b.el, 1e-9);
  })());

  console.log('sky — 衛星過境預測');
  {
    // 赤道圓軌道有解析解可對照：
    // 軌道角速度 ω = √(μ/r³)，地面軌跡相對地表東移 ω − 地球自轉率。
    const R_EQ = 6378137, H = 420000, r = R_EQ + H;
    const wSat = Math.sqrt(3.986004418e14 / (r * r * r)) * 180 / Math.PI;  // °/s
    const wRel = wSat - 360.9856 / 86400;                                   // 相對地表 °/s
    const T0 = Date.UTC(2026, 9, 10, 0, 0, 0);
    const obs = { lat: 0, lng: 121, alt: 0 };
    // 衛星現在在觀測者西方 60°，往東飛 → 預計 60/wRel 秒後從頭頂通過
    const mk = (dt) => ({ lat: 0, lng: 61 + wRel * dt, altKm: 420, t: T0 + dt * 1000 });
    // 正頭頂通過時仰角在尖峰附近每秒變化數度，取樣細一點才能驗證最大仰角
    const passes = Sky.predictPasses(mk(0), mk(10), obs, { hours: 2, stepS: 5 });
    ok('找到過境', passes.length >= 1);
    const p = passes[0];
    const expectT = T0 + (60 / wRel) * 1000;
    ok('過境最高點時間與解析解相符 (±60s)', Math.abs(p.maxT - expectT) < 60000);
    ok('正頭頂通過 → 最大仰角 >85°', p.maxEl > 85);
    // 仰角 0° 的覆蓋半角 = acos(R/r) ≈ 20.24° → 全程約 670 秒
    const durS = (p.end - p.start) / 1000;
    ok('過境時長 ~670s（500–800s）', durS > 500 && durS < 800);
    ok('start < maxT < end', p.start <= p.maxT && p.maxT <= p.end);

    // 觀測者緯度 25° > 赤道軌道覆蓋半角 20.24° → 永遠不過境
    const far = Sky.predictPasses(mk(0), mk(10), { lat: 25, lng: 121, alt: 0 }, { hours: 6 });
    ok('軌道覆蓋不到的緯度 → 無過境', far.length === 0);

    ok('兩筆資料時間相同 → 回傳空陣列',
      Sky.predictPasses(mk(0), mk(0), obs, { hours: 1 }).length === 0);
    ok('缺資料 → 回傳空陣列', Sky.predictPasses(null, mk(10), obs).length === 0);
  }

  console.log('groups — 群組分類與配色');
  {
    ok('內建群組取得顏色', Groups.resolve('north').color === '#4da3ff');
    ok('依 type 落到預設群組',
      Groups.groupIdOf({ type: 'peak' }) === 'peak' && Groups.groupIdOf({ type: 'marker' }) === 'mark');
    ok('明確 group 優先於 type', Groups.groupIdOf({ type: 'peak', group: 'north' }) === 'north');
    // 沒看過的群組自動註冊，且同名永遠同色
    const c1 = Groups.colorOf({ type: 'station', group: '花東線' });
    const c2 = Groups.colorOf({ type: 'station', group: '花東線' });
    ok('未知群組自動註冊且顏色穩定', c1 === c2 && /^#[0-9a-f]{6}$/i.test(c1));
    ok('不同群組通常不同色', Groups.autoColor('甲線') !== Groups.autoColor('乙線'));

    const ents = [
      { id: 'a', type: 'station', group: 'north' },
      { id: 'b', type: 'station', group: 'south' },
      { id: 'c', type: 'peak' },
      { id: 'd', type: 'station', group: 'north' },
    ];
    ok('isHidden 只認被藏的群組',
      Groups.isHidden(ents[0], ['north']) && !Groups.isHidden(ents[1], ['north']));
    ok('visible 過濾掉隱藏群組', Groups.visible(ents, ['north']).length === 2);
    ok('visible 空隱藏清單 → 全數保留', Groups.visible(ents, []).length === 4);
    const parts = Groups.partition(ents);
    ok('partition 分成 3 組', parts.length === 3);
    ok('partition 內建群組排序在前（北部先於南部）',
      parts[0].group.id === 'north' && parts[1].group.id === 'south');
    ok('partition 各組數量正確', parts[0].items.length === 2 && parts[2].items.length === 1);
    ok('learn 後新群組出現在 all()',
      Groups.learn([{ type: 'station', group: '南橫線' }]).some((g) => g.id === '南橫線'));
  }

  console.log('sky — 星座連線');
  {
    const dipper = Sky.CONSTELLATIONS.find((c) => c.id === 'bigdipper');
    ok('有北斗七星', !!dipper);
    const keys = new Set(dipper.lines.flat());
    ok('北斗七星剛好 7 顆星', keys.size === 7);
    ok('北斗七星含天樞與搖光', keys.has('dubhe') && keys.has('alkaid'));
    // 每條連線的兩端都必須在星表裡，否則畫出來會斷線
    const missing = [];
    Sky.CONSTELLATIONS.forEach((c) => c.lines.flat().forEach((k) => {
      if (!Sky.STAR_BY_KEY.has(k)) missing.push(c.id + ':' + k);
    }));
    ok('所有星座引用的星都存在於星表 (' + (missing.join(',') || '無缺漏') + ')', missing.length === 0);
    ok('星表 key 不重複', new Set(Sky.STARS.map((s) => s.key)).size === Sky.STARS.length);

    const date = new Date(Date.UTC(2026, 2, 15, 14, 0, 0)); // 台灣時間深夜
    const cons = Sky.constellationLines(date, 25.03, 121.56);
    ok('回傳若干星座', cons.length > 0);
    ok('每組都有線段與星點', cons.every((c) => c.segments.length > 0 && c.stars.length > 0));
    ok('線段端點 az/alt 在合理範圍', cons.every((c) => c.segments.every((s) =>
      s.a.az >= 0 && s.a.az <= 360 && s.a.alt >= -90 && s.a.alt <= 90 &&
      s.b.az >= 0 && s.b.az <= 360 && s.b.alt >= -90 && s.b.alt <= 90)));
    ok('label 方位在 0..360', cons.every((c) => c.label.az >= 0 && c.label.az <= 360));
    ok('only 選項可只取單一星座',
      Sky.constellationLines(date, 25.03, 121.56, { only: ['orion'], minAlt: -90 }).length === 1);

    // 天權 3.31 等：星等上限 2.2 時本來看不到，開星座連線才會補進來
    const plain = Sky.skyObjects(date, 25.03, 121.56, { maxMag: 2.2 });
    const withCon = Sky.skyObjects(date, 25.03, 121.56, { maxMag: 2.2, constellations: true });
    ok('一般模式不含天權(3.31等)', !plain.some((o) => o.starKey === 'megrez'));
    ok('開星座連線時補上天權，避免斗杓缺角', withCon.some((o) => o.starKey === 'megrez'));
    ok('開星座連線不影響亮星', withCon.some((o) => o.starKey === 'vega'));

    // 方位向量平均：0° 與 360° 附近的星不該平均成 180°
    const c = Sky.centroid([{ az: 350, alt: 10 }, { az: 10, alt: 20 }]);
    ok('centroid 跨 0° 接縫正確 (~0°)', c.az < 3 || c.az > 357);
    ok('centroid 仰角取平均', approx(c.alt, 15, 0.001));
  }

  console.log('elevation — 天際線（山體輪廓）');
  {
    // 單一射線：近處高山應勝過遠處矮丘
    const rays = [
      { az: 0, pts: [{ dist: 1000, ground: 600 }, { dist: 20000, ground: 900 }] },
      { az: 90, pts: [{ dist: 5000, ground: 100 }] },
      { az: 180, pts: [{ dist: 5000, ground: null }] },   // 沒有高程資料
    ];
    const sl = Elevation.skylineFromRays(rays, 100);
    ok('每個方位各一筆', sl.length === 3);
    ok('依方位排序', sl[0].az === 0 && sl[1].az === 90 && sl[2].az === 180);
    ok('近山(1km/600m)勝過遠丘(20km/900m)', sl[0].dist === 1000);
    ok('稜線仰角 ~26.6°', approx(sl[0].elev, 26.57, 0.2));
    ok('與觀測者同高的遠處地面 → 仰角為負（地球曲率）', sl[1].elev < 0);
    ok('無高程資料的方位 elev 為 null', sl[2].elev === null);

    // 曲率修正：同樣高度的地面，越遠仰角越低
    const flat = [{ az: 0, pts: [{ dist: 5000, ground: 500 }] }, { az: 1, pts: [{ dist: 50000, ground: 500 }] }];
    const f = Elevation.skylineFromRays(flat, 0);
    ok('同高地面：遠者仰角較低', f[1].elev < f[0].elev);

    // 山頭偵測：兩個明顯突起
    const ring = [];
    for (let i = 0; i < 36; i++) {
      const e = 5 + 10 * Math.exp(-((i - 6) ** 2) / 4) + 6 * Math.exp(-((i - 24) ** 2) / 4);
      ring.push({ az: i * 10, elev: e, dist: 10000, ground: 1000 });
    }
    const peaks = Elevation.skylinePeaks(ring);
    ok('找出 2 座山頭', peaks.length === 2);
    ok('最突出者排第一且突起度最大',
      peaks[0].prominence >= peaks[1].prominence && approx(peaks[0].az, 60, 1));
    ok('平坦天際線沒有山頭',
      Elevation.skylinePeaks(ring.map((p) => ({ ...p, elev: 5 }))).length === 0);
    ok('點數不足時回傳空陣列', Elevation.skylinePeaks([{ az: 0, elev: 1 }]).length === 0);
  }

  console.log('elevation — 高程服務限流處理 (429)');
  {
    const savedFetch = global.fetch;
    const pt = [{ lat: 10.1234, lng: 20.1234 }];

    // 1) 被限流且不重試 + tolerateFailures → 回 null，不整個失敗
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 429, headers: { get: () => null } }; };
    let chunkErr = null;
    const soft = await Elevation.fetchElevations(pt, {
      maxRetry: 0, tolerateFailures: true, onChunkError: (e) => { chunkErr = e; },
    });
    ok('429 且容忍失敗 → 該點為 null', soft.length === 1 && soft[0] === null);
    ok('429 訊息說明是限流', /429|頻繁/.test(chunkErr.message));
    ok('maxRetry=0 只送一次', calls === 1);

    // 2) 不容忍失敗時要拋出（路徑分析仍需要明確失敗）
    calls = 0;
    let threw = null;
    try {
      await Elevation.fetchElevations([{ lat: 11.5, lng: 21.5 }], { maxRetry: 0 });
    } catch (e) { threw = e; }
    ok('未開容忍時 429 會拋出', threw !== null && /429|頻繁/.test(threw.message));

    // 3) 第一次 429、第二次成功 → 自動重試後拿到資料
    calls = 0;
    const retries = [];
    global.fetch = async (url) => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, headers: { get: (h) => (h === 'Retry-After' ? '0' : null) } };
      const u = new URL(url);
      const n = u.searchParams.get('latitude').split(',').length;
      return { ok: true, json: async () => ({ elevation: Array(n).fill(1234) }) };
    };
    const retried = await Elevation.fetchElevations([{ lat: 12.75, lng: 22.75 }], {
      maxRetry: 2, onRetry: (n, wait, status) => retries.push({ n, status }),
    });
    ok('429 後自動重試並成功取得高程', retried[0] === 1234);
    ok('重試了一次且回報狀態碼', retries.length === 1 && retries[0].status === 429);

    global.fetch = savedFetch;
  }

  console.log('parse — 標註與群組欄位');
  {
    const csv = 'name,lat,lng,alt,type,群組,icon,備註\n' +
      '甲台,23.4,120.9,3000,station,南橫線,,主力中繼\n' +
      '停車場,23.5,120.8,2300,標註,登山,🚗,可停十輛\n';
    const r = Parse.parseStations(csv, 'x.csv');
    ok('CSV 站臺與標註分流', r.stations.length === 1 && r.markers.length === 1);
    ok('CSV 站臺帶入群組', r.stations[0].group === '南橫線');
    ok('CSV 站臺帶入備註', r.stations[0].note === '主力中繼');
    ok('CSV 標註型別/圖示/備註正確',
      r.markers[0].type === 'marker' && r.markers[0].icon === '🚗' && r.markers[0].note === '可停十輛');
    ok('CSV 標註帶入群組', r.markers[0].group === '登山');

    const noType = Parse.parseStations('name,lat,lng\nA,23,121\n', 'x.csv');
    ok('沒有 type 欄時全部視為站臺', noType.stations.length === 1 && noType.markers.length === 0);

    const json = JSON.stringify({
      stations: [{ id: 's1', type: 'station', name: 'S', lat: 23, lng: 121, alt: 0 }],
      markers: [{ id: 'm1', type: 'marker', name: 'M', lat: 23.1, lng: 121.1, alt: 0, icon: '⭐' }],
      groups: [{ id: 'g1', name: '自訂線', color: '#123456' }],
    });
    const rj = Parse.parseStations(json, 'x.json');
    ok('JSON 一併還原標註', rj.markers.length === 1 && rj.markers[0].icon === '⭐');
    ok('JSON 一併還原群組定義', rj.groups[0].color === '#123456');
    ok('JSON 無 markers 欄位時為空陣列',
      Parse.parseStations('{"stations":[]}', 'x.json').markers.length === 0);
    ok('GPX 回傳空標註陣列',
      Parse.parseStations('<gpx><wpt lat="24" lon="121"/></gpx>', 'x.gpx').markers.length === 0);
  }

  console.log('elevation — DEM 地形圖磚（Terrarium PNG）');
  {
    const zlib = require('zlib');
    ok('Terrarium 解碼：海平面', Elevation.decodeTerrarium(128, 0, 0) === 0);
    ok('Terrarium 解碼：3952m', Elevation.decodeTerrarium(143, 112, 0) === 3952);
    ok('Terrarium 解碼：小數（B 通道）', Elevation.decodeTerrarium(128, 10, 128) === 10.5);

    // 圖磚座標：玉山 z10 應落在 x=856、y=456 附近（已用實際圖磚對照過）
    const t = Elevation.tileCoord(23.47, 120.9573, 10);
    ok('tileCoord 玉山 z10 → x≈856.06', approx(t.x, 856.06, 0.01));
    ok('tileCoord 緯度越北 y 越小', Elevation.tileCoord(25, 121, 10).y < Elevation.tileCoord(23, 121, 10).y);

    // pickZoom：點越分散，層級越低（圖磚數維持上限內）
    const ring = [];
    for (let i = 0; i < 96; i++) ring.push(Geo.destination({ lat: 24.1, lng: 120.7 }, i * 3.75, 90000));
    const zFar = Elevation.pickZoom(ring, { maxTiles: 16 });
    const zOne = Elevation.pickZoom([{ lat: 24.1, lng: 120.7 }], { maxTiles: 16 });
    ok('pickZoom 單點取最高層級 (12)', zOne === 12);
    ok('pickZoom 90km 環 → 較低層級且圖磚 ≤16', zFar <= 10 && (() => {
      const set = new Set(ring.map((p) => { const c = Elevation.tileCoord(p.lat, p.lng, zFar); return Math.floor(c.x) + '/' + Math.floor(c.y); }));
      return set.size <= 16;
    })());

    // 自己編一張 Terrarium PNG：海拔 = 1000 + 10·x − 5·y，五種濾波器輪流用
    function makePng(w, h, elevAt) {
      const bpp = 3, stride = w * bpp;
      const rows = [];
      for (let y = 0; y < h; y++) {
        const r = Buffer.alloc(stride);
        for (let x = 0; x < w; x++) {
          const v = elevAt(x, y) + 32768;
          r[x * 3] = Math.floor(v / 256); r[x * 3 + 1] = Math.floor(v) % 256; r[x * 3 + 2] = Math.round((v % 1) * 256);
        }
        rows.push(r);
      }
      const out = [];
      for (let y = 0; y < h; y++) {
        const f = y % 5, cur = rows[y], prev = y ? rows[y - 1] : Buffer.alloc(stride);
        const enc = Buffer.alloc(stride + 1); enc[0] = f;
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
          let pr = 0;
          if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1;
          else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
          enc[i + 1] = (cur[i] - pr) & 255;
        }
        out.push(enc);
      }
      const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : 0);
        return Buffer.concat([len, td, crc]);
      };
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
      ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
      return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(out))), chunk('IEND', Buffer.alloc(0))]);
    }
    const plane = (x, y) => 1000 + 10 * x - 5 * y;
    const png = makePng(256, 256, plane);
    const dec = await Elevation.decodeTerrariumPng(png);
    let maxErr = 0;
    for (let y = 0; y < 256; y += 7) for (let x = 0; x < 256; x += 7) {
      maxErr = Math.max(maxErr, Math.abs(dec.data[y * 256 + x] - plane(x, y)));
    }
    ok('PNG 解碼尺寸 256×256', dec.w === 256 && dec.h === 256);
    ok('PNG 解碼（五種濾波器）與原值一致 <0.01m', maxErr < 0.01);
    let bad = null;
    try { await Elevation.decodeTerrariumPng(Buffer.from('not a png')); } catch (e) { bad = e; }
    ok('非 PNG 會拋錯（交給備援）', bad !== null);

    // fetchElevations 走 DEM：mock S3 回傳上面那張圖磚
    const savedFetch = global.fetch;
    let s3 = 0, meteo = 0;
    global.fetch = async (url) => {
      if (/elevation-tiles-prod/.test(url)) {
        s3++;
        return { ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length) };
      }
      meteo++;
      return { ok: false, status: 500, headers: { get: () => null } };
    };
    Elevation.setDemEnabled(true);
    Elevation._cache.clear();
    Elevation._demTiles.clear();
    // 取 z12 某圖磚內的已知像素中心位置，反推經緯度
    const z = 12, tx = 3425, ty = 1752;
    const px = 100.5, py = 60.5;   // 像素中心 → 應精確取到 plane(100, 60)
    const n = Math.pow(2, z);
    const lng = (tx + px / 256) / n * 360 - 180;
    const yy = (ty + py / 256) / n;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180 / Math.PI;
    const vals = await Elevation.fetchElevations([{ lat, lng }], { zMax: 12, dem: true });
    ok('DEM 取樣值正確（像素中心 = 1000+10·100−5·60 = 1700）', approx(vals[0], 1700, 0.5));
    ok('有走 DEM、沒去問 open-meteo', s3 >= 1 && meteo === 0);
    // 同一張圖磚再查不重抓
    const s3Before = s3;
    await Elevation.fetchElevations([{ lat: lat + 0.001, lng: lng + 0.001 }], { zMax: 12 });
    ok('同一張圖磚命中記憶體快取（不重抓）', s3 === s3Before);

    // 圖磚抓不到 → 自動退回 open-meteo
    Elevation._cache.clear(); Elevation._demTiles.clear();
    s3 = 0; meteo = 0;
    global.fetch = async (url) => {
      if (/elevation-tiles-prod/.test(url)) { s3++; return { ok: false, status: 403 }; }
      meteo++;
      const u = new URL(url);
      const k = u.searchParams.get('latitude').split(',').length;
      return { ok: true, json: async () => ({ elevation: Array(k).fill(321) }) };
    };
    const fb = await Elevation.fetchElevations([{ lat: 23.1, lng: 121.1 }], { maxRetry: 0 });
    ok('DEM 失敗 → 退回 open-meteo 取得 321m', fb[0] === 321 && s3 >= 1 && meteo === 1);

    // 海底地形一律視為海面 0m（視線看到的是海面）
    const sea = makePng(256, 256, () => -150);
    global.fetch = async (url) => ({ ok: true, status: 200,
      arrayBuffer: async () => sea.buffer.slice(sea.byteOffset, sea.byteOffset + sea.length) });
    Elevation._cache.clear(); Elevation._demTiles.clear();
    const sv = await Elevation.fetchElevations([{ lat: 22.0, lng: 119.0 }]);
    ok('海底 −150m 夾為 0m', sv[0] === 0);

    // 去雜訊：海岸線上的單點尖刺（實際圖磚就有 +2567m 夾在 −792m 旁邊）
    {
      const W = 7, d = new Float32Array(W * W).fill(100);
      d[3 * W + 3] = 2600;                       // 孤立尖刺
      d[1 * W + 1] = 1400; d[1 * W + 2] = 2500;  // 成對尖刺
      const out = Elevation.despikeTile({ w: W, h: W, data: d }, 35).data;
      ok('despike：孤立尖刺被壓回四周高度', approx(out[3 * W + 3], 100, 1));
      ok('despike：成對尖刺也壓得掉', out[1 * W + 1] < 200 && out[1 * W + 2] < 200);
      // 一道陡稜線（35m 像素、兩側每格掉 80 m ≈ 66°）與稜線上的山頭
      const r = new Float32Array(W * W).fill(1300);
      for (let x = 0; x < W; x++) { r[2 * W + x] = 1420; r[3 * W + x] = 1500; r[4 * W + x] = 1420; }
      r[3 * W + 3] = 1580;
      const ro = Elevation.despikeTile({ w: W, h: W, data: r }, 35).data;
      ok('despike：陡稜線與稜線上的山頭不受影響',
        ro[3 * W + 3] === 1580 && ro[3 * W + 0] === 1500 && ro[2 * W + 2] === 1420);
    }

    // computeSkyline 走 DEM：每張圖磚都是 500m 高台
    {
      const flat500 = makePng(256, 256, () => 500);
      let tiles = 0;
      global.fetch = async (url) => {
        if (!/elevation-tiles-prod/.test(url)) return { ok: false, status: 500, headers: { get: () => null } };
        tiles++;
        return { ok: true, status: 200, arrayBuffer: async () => flat500.buffer.slice(flat500.byteOffset, flat500.byteOffset + flat500.length) };
      };
      Elevation.setDemEnabled(true);
      Elevation._cache.clear(); Elevation._demTiles.clear();
      let lastPct = 0;
      const sl = await Elevation.computeSkyline({ lat: 24.1, lng: 120.7 }, {
        eyeHeight: 3, onProgress: (d, n) => { lastPct = d / n; },
      });
      ok('DEM 天際線：720 個方位、每 0.5°', sl.points.length === 720 && sl.step === 0.5 && sl.source === 'dem');
      ok('DEM 天際線：觀測高度 = 地面 500 + 眼高 3', approx(sl.obsAlt, 503, 0.01));
      ok('DEM 天際線：資料完整、進度跑到 100%', sl.coverage === 1 && lastPct === 1);
      ok('DEM 天際線：圖磚數合理（< 80，不超過記憶體快取）', tiles > 20 && tiles < 80 && sl.tiles === tiles);
      // 高台上眼高 3m：最遠的「地平線」約在 √(2kR·3) ≈ 6.5 km，仰角 ≈ −0.06°
      ok('DEM 天際線：平地的天際線略低於水平', sl.points.every((p) => p.elev < 0 && p.elev > -0.2));
      ok('DEM 天際線：附遮擋斷點', Array.isArray(sl.bp) && sl.bp.length === 720);

      // 圖磚全部抓不到 → 退回稀疏取樣（open-meteo）
      global.fetch = async (url) => {
        if (/elevation-tiles-prod/.test(url)) return { ok: false, status: 403 };
        const k = new URL(url).searchParams.get('latitude').split(',').length;
        return { ok: true, json: async () => ({ elevation: Array(k).fill(80) }) };
      };
      Elevation._cache.clear(); Elevation._demTiles.clear();
      const sp = await Elevation.computeSkyline({ lat: 23.5, lng: 120.5 }, { eyeHeight: 2, maxRetry: 0 });
      ok('圖磚失敗 → 退回稀疏取樣（96 方位）', sp.source === 'sparse' && sp.points.length === 96 && sp.step === 3.75);
    }

    global.fetch = savedFetch;
    Elevation._cache.clear(); Elevation._demTiles.clear();
    Elevation.setDemEnabled(false);
  }

  console.log('elevation — 密集天際線掃描（合成地形）');
  {
    // 平地上一座高斯山：正東 20 km、高 2000 m、半寬 ~1 km
    const obs = { lat: 24.0, lng: 121.0 };
    const peak = Geo.destination(obs, 90, 20000);
    const sample = (sinLat, lng) => {
      const d = Geo.distance(peak, { lat: Math.asin(sinLat) * 180 / Math.PI, lng });
      return 2000 * Math.exp(-(d * d) / (2 * 1000 * 1000));
    };
    const sl = Elevation.marchSkyline({
      observer: obs, obsAlt: 10, azimuths: 360, k: Elevation.K_OPTICAL, sample,
      rings: [{ from: 100, to: 10000, step: 30 }, { from: 10000, to: 60000, step: 100 }],
    });
    const east = sl.points[90];
    const drop = 20000 * 20000 / (2 * Elevation.K_OPTICAL * Geo.R_EARTH);
    const expect = Math.atan((2000 - 10 - drop) / 20000) * 180 / Math.PI;
    ok('合成山：稜線落在 ~20 km', Math.abs(east.dist - 20000) < 400);
    ok('合成山：稜線仰角 ≈ 理論值 (5.6°)', approx(east.elev, expect, 0.05));
    // 平地：最高點在 √(2kR·10) ≈ 12 km，仰角約 −0.095°
    ok('平地方位：仰角約 −0.1°（地球曲率）', approx(sl.points[270].elev, -0.0955, 0.01));
    ok('step = 1°', sl.step === 1);

    const top = (d, h) => Math.atan((h - 10 - d * d / (2 * Elevation.K_OPTICAL * Geo.R_EARTH)) / d) * 180 / Math.PI;
    ok('山後 40 km 的 2000 m 目標被擋住', Elevation.skylineHides(sl, 90, 40000, top(40000, 2000)) === true);
    ok('山前 10 km 的 500 m 目標沒被擋', Elevation.skylineHides(sl, 90, 10000, top(10000, 500)) === false);
    ok('山頂本身不算被自己的山坡擋住', Elevation.skylineHides(sl, 90, 20000, top(20000, 2000)) === false);
    ok('平地方位 30 km 外的 100 m 目標看得到', Elevation.skylineHides(sl, 270, 30000, top(30000, 100)) === false);
    ok('舊版輪廓（無斷點）→ 無法判斷回傳 null',
      Elevation.skylineHides({ points: sl.points, step: 1 }, 90, 40000, 0) === null);

    // 等間隔方位內插、跨 0°/360° 接縫
    const pts = [];
    for (let i = 0; i < 720; i++) pts.push({ az: i * 0.5, elev: i === 0 ? 2 : (i === 719 ? 1 : 0) });
    const S = { points: pts, step: 0.5 };
    ok('skylineElevAt 落在取樣點上', Elevation.skylineElevAt(S, 0) === 2);
    ok('skylineElevAt 跨接縫內插 (359.75° → 1.5)', approx(Elevation.skylineElevAt(S, 359.75), 1.5, 1e-9));
    ok('skylineElevAt 負方位也能用', approx(Elevation.skylineElevAt(S, -0.25), 1.5, 1e-9));
    ok('skylineElevAt 舊版 96 方位（無 step）', approx(Elevation.skylineElevAt(
      { points: Array.from({ length: 96 }, (_, i) => ({ az: i * 3.75, elev: i })) }, 5.625), 1.5, 1e-9));

    // ringTiles：環帶內任一點都要落在清單裡的圖磚上，且比整個方框少
    const c = { lat: 24.1, lng: 120.7 };
    const tl = Elevation.ringTiles(c, 20000, 60000, 10);
    const set = new Set(tl.map((t) => t.x + '/' + t.y));
    let miss = 0;
    for (let i = 0; i < 2000; i++) {
      const p = Geo.destination(c, Math.random() * 360, 20000 + Math.random() * 40000);
      const q = Elevation.tileCoord(p.lat, p.lng, 10);
      if (!set.has(Math.floor(q.x) + '/' + Math.floor(q.y))) miss++;
    }
    ok('ringTiles 涵蓋環帶內所有點', miss === 0);
    const inner = Elevation.ringTiles(c, 100, 20000, 12).length;
    ok('ringTiles 數量合理（近環 z12 ≤ 30 張）', inner > 4 && inner <= 30);
  }

  console.log('ar — 透視投影與相機視角');
  {
    const P = ARView.makeProjection;
    const W = 390, H = 700;
    const p0 = P(117, 0, 40, W, H);
    const c0 = p0(117, 0);
    ok('視線正中 → 畫面中心', approx(c0.x, W / 2, 1e-9) && approx(c0.y, H / 2, 1e-9));
    ok('方位 +半視野 → 畫面右緣', approx(p0(137, 0).x, W, 1e-9));
    ok('背後的方位不可見', p0(297, 0).front === false);
    ok('水平垂直同比例尺（仰角 10° 在中心上方 f·tan10°）',
      approx(H / 2 - p0(117, 10).y, p0.f * Math.tan(10 * Math.PI / 180), 1e-9));
    const p1 = P(117, 12, 40, W, H);
    ok('抬頭時地平線是一條水平直線', approx(p1(100, 0).y, p1.horizonY, 1e-9) && approx(p1(130, 0).y, p1.horizonY, 1e-9));
    ok('抬頭 12° → 地平線在中心下方 f·tan12°', approx(p1.horizonY - H / 2, p1.f * Math.tan(12 * Math.PI / 180), 1e-9));
    ok('垂直視野由長寬比推得', approx(p0.vfov, 2 * Math.atan(Math.tan(20 * Math.PI / 180) * H / W) * 180 / Math.PI, 1e-9));
    // 舊版：預設 70° 線性投影；相機實際約 40° 透視。偏 15° 的山差了一大截
    const lin = W / 2 + (15 / 35) * (W / 2), persp = p0(132, 0).x;
    ok('舊預設（70° 線性）與相機（40° 透視）在偏 15° 處差 >50px', persp - lin > 50);

    const hf = ARView.camDisplayHfov(480, 640, W, H, 68);
    ok('直拿手機 4:3 串流 → 畫面視角約 40°', hf > 37 && hf < 44);
    const hf169 = ARView.camDisplayHfov(720, 1280, W, H, 68);
    ok('直拿手機 16:9 串流 → 同樣約 40°（長邊視角相同）', approx(hf169, hf, 2));
    ok('橫拿 4:3 串流塞滿寬螢幕 → 約等於鏡頭長邊視角', approx(ARView.camDisplayHfov(640, 480, 844, 390, 68), 68, 0.5));
    ok('鏡頭視角 ⇄ 畫面視角可互推',
      approx(ARView.camLongFov(480, 640, W, H, ARView.camDisplayHfov(480, 640, W, H, 71)), 71, 1e-9));
  }

  console.log('sats — 多衛星追蹤（TLE + SGP4）');
  {
    ok('SGP4 引擎已載入', Sats.available === true);
    const ids = Sats.CATALOG.map((c) => c.id);
    ok('目錄 13 顆（台灣 9 + ISS + 同步 3）', ids.length === 13 && Sats.TAIWAN_IDS.length === 9);
    ok('目錄 id 不重複', new Set(ids).size === ids.length);
    ok('自訂 NORAD 動態項目', (Sats.entryOf('norad-43013') || {}).norad === 43013);
    ok('非法 id 回傳 null', Sats.entryOf('xx-123') == null && Sats.entryOf('norad-abc') == null);

    const txt = 'ISS (ZARYA)\n1 25544U 98067A   24001.50000000  .00016717  00000-0  30777-3 0  9992\n' +
      '2 25544  51.6416 339.5000 0003500  83.0000 277.0000 15.49500000430000\n' +
      'FORMOSAT 5\n1 42920U 17049A   24001.00000000  .00000100  00000-0  10000-3 0  9999\n' +
      '2 42920  98.2800 100.0000 0001000  90.0000 270.0000 14.55000000330000';
    const parsed = Sats.parseTleText(txt);
    ok('TLE 文字解析出 2 組', parsed.length === 2 && parsed[1].name === 'FORMOSAT 5');

    // 注入固定 ISS TLE，於 epoch 時刻驗證位置
    Sats._setTle('iss', 'ISS (ZARYA)',
      '1 25544U 98067A   24001.50000000  .00016717  00000-0  30777-3 0  9992',
      '2 25544  51.6416 339.5000 0003500  83.0000 277.0000 15.49500000430000');
    ok('注入後 hasTle', Sats.hasTle('iss'));
    const obs = { lat: 25.03, lng: 121.56, alt: 10 };
    const when = new Date(Date.UTC(2024, 0, 1, 12, 0, 0));
    const posn = Sats.positions(['iss', 'fs5'], obs, when);   // fs5 無 TLE 應被略過
    ok('只回傳有 TLE 的衛星', posn.length === 1 && posn[0].id === 'iss');
    const p0 = posn[0];
    ok('軌道高度 ~420km（400–440）', p0.heightKm > 400 && p0.heightKm < 440);
    ok('方位/仰角/距離皆為有效數值',
      p0.az >= 0 && p0.az < 360 && p0.alt >= -90 && p0.alt <= 90 && isFinite(p0.rangeKm));

    // 交叉驗證：SGP4 的視角 vs Sky.lookAngles（兩套獨立實作）
    const la = Sky.lookAngles(obs, { lat: p0.subLat, lng: p0.subLng, altKm: p0.heightKm });
    const dAz = Math.abs(((la.az - p0.az + 540) % 360) - 180);
    ok('與 Sky.lookAngles 交叉驗證（方位差 <1°、仰角差 <0.5°）',
      dAz < 1 && Math.abs(la.el - p0.alt) < 0.5);

    // 過境預測：台北 24 小時內必有 ISS 過境
    const np = Sats.nextPass('iss', obs, { hours: 24, minEl: 5, from: when.getTime() });
    ok('24 小時內找到過境', !!np);
    ok('過境時間順序正確', np.start <= np.maxT && np.maxT <= np.end && np.start > when.getTime() - 1);
    ok('最大仰角 ≥ 門檻 5°', np.maxEl >= 5);
    const durMin = (np.end - np.start) / 60000;
    ok('過境時長合理（1–12 分鐘）', durMin >= 1 && durMin <= 12);
    ok('過境結果含肉眼可見性欄位', typeof np.visible === 'boolean' && 'sunlit' in np && 'dark' in np);

    // ---- 同步衛星 ----
    ok('目錄含 3 顆同步衛星', Sats.GEO_IDS.length === 3 && Sats.GEO_IDS.indexOf('st2') >= 0);
    ok('「台灣在軌」不含同步/國際', Sats.TAIWAN_IDS.every((id) => ['st2', 'himawari9', 'inmarsat4f1', 'iss'].indexOf(id) < 0));
    const perDay = (r) => ({ no: r * 2 * Math.PI / 1440 });
    ok('軌道分類：1.0027 圈/日 → GEO', Sats.orbitClass(perDay(1.0027)) === 'GEO');
    ok('軌道分類：15.5 圈/日 → LEO', Sats.orbitClass(perDay(15.5)) === 'LEO');
    ok('軌道分類：2 圈/日 → MEO', Sats.orbitClass(perDay(2.0)) === 'MEO');

    // 造一組 GEO 的 TLE（含校驗碼），驗證「天上固定不動」
    const cks = (l) => { let s = 0; for (const ch of l) { if (/\d/.test(ch)) s += +ch; else if (ch === '-') s += 1; } return s % 10; };
    let g1 = '1 37606U 11022B   24001.50000000 -.00000300  00000-0  00000-0 0  999'; g1 += cks(g1);
    let g2 = '2 37606   0.0200 280.0000 0002000 200.0000 100.0000  1.00270000 47000'; g2 += cks(g2);
    Sats._setTle('st2', 'ST-2', g1, g2);
    const t1 = new Date(Date.UTC(2024, 0, 1, 12, 0, 0));
    const t2 = new Date(t1.getTime() + 6 * 3600e3);
    const a1 = Sats.positions(['st2'], obs, t1)[0], a2 = Sats.positions(['st2'], obs, t2)[0];
    ok('GEO 被辨識為同步軌道', a1.orbit === 'GEO');
    ok('GEO 高度 ~35786km', Math.abs(a1.heightKm - 35786) < 300);
    const dA = Math.abs(((a1.az - a2.az + 540) % 360) - 180);
    ok('GEO 6 小時後方位/仰角幾乎不變（<0.5°）', dA < 0.5 && Math.abs(a1.alt - a2.alt) < 0.5);
    ok('GEO 沒有「過境」（nextPass 回傳 null）', Sats.nextPass('st2', obs, { from: t1.getTime() }) === null);
    ok('GEO 一律標記肉眼看不到', a1.nakedEye === false);

    // ---- 地影（圓柱模型）----
    const sunX = { x: 1, y: 0, z: 0 };
    ok('朝太陽一側 → 照得到', Sats.isSunlit({ x: 7000, y: 0, z: 0 }, sunX) === true);
    ok('正背面低軌 → 在地影中', Sats.isSunlit({ x: -6800, y: 0, z: 0 }, sunX) === false);
    ok('背面但偏出地球半徑 → 照得到', Sats.isSunlit({ x: -6800, y: 6500, z: 0 }, sunX) === true);
    ok('背面高軌偏離 → 照得到', Sats.isSunlit({ x: -42000, y: 7000, z: 0 }, sunX) === true);
  }

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
