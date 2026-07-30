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
const { Geo, Elevation, Parse, Sky } = globalThis;

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

function runParseTests() {
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

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
