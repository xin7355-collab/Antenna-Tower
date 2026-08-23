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
const { Geo, Elevation, Parse, Sky, Groups } = globalThis;

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

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
