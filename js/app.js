/*
 * app.js — 主控制器
 * ------------------------------------------------------------------
 * 管理狀態、串接地圖與 AR 視角、計算直線距離/方位/遮蔽，
 * 並繪製地形剖面圖。
 */
(function (global) {
  'use strict';

  const Geo = global.Geo;
  const Elevation = global.Elevation;
  const S = global.SampleData;

  const state = {
    me: { ...S.me },
    stations: S.stations.map((s) => ({ ...s })),
    peaks: S.peaks.map((p) => ({ ...p })),
    selectedId: null,
    satellites: [],            // 即時衛星（ISS）方位仰角
    analysisById: {},          // id -> analyzePath 結果（快取）
    settings: {
      freqMHz: 145.7, obsAntenna: 3, tgtAntenna: 6, k: Geo.K_DEFAULT, withCurvature: true,
      eirpDbm: 37,      // 等效全向輻射功率（約 5 W）
      rxGainDbi: 3,     // 接收天線增益
      rxSensDbm: -110,  // 接收機靈敏度
      showSky: false,   // 天文疊加層
      skyTime: null,    // null=現在；否則 ISO 字串
      starMag: 2.2,     // 顯示星等上限
      showSat: false,   // 衛星（ISS）
    },
  };

  let mapView, arView;
  const LS_KEY = 'vrmap.state.v1';

  function findEntity(id) {
    return [state.me, ...state.stations, ...state.peaks].find((e) => e.id === id) || null;
  }

  // 設定我的位置：立即更新畫面，高程與遮蔽在背景補上（不卡 UI）
  function setMyLocation(lat, lng) {
    state.me.lat = lat;
    state.me.lng = lng;
    state.analysisById = {};
    saveState();
    if (mapView.focus) mapView.focus(state.me);
    render();                               // 立刻反應
    Elevation.elevationAt(state.me).then((e) => {
      if (e != null) { state.me.alt = Math.round(e); saveState(); renderPanel(); if (state.selectedId) select(state.selectedId); }
    }).catch(() => {});
  }

  // ---- 本機儲存 ----------------------------------------------------------
  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        me: state.me, stations: state.stations, settings: state.settings,
      }));
    } catch (_) { /* localStorage 可能被停用，忽略 */ }
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.me) Object.assign(state.me, d.me);
      if (Array.isArray(d.stations)) state.stations = d.stations;
      if (d.settings) Object.assign(state.settings, d.settings);
    } catch (_) { /* 資料毀損則忽略 */ }
  }

  function render() {
    mapView.render(state);
    arView.render(state);
    renderPanel();
    renderEditor();
    updateCoverage();
  }

  // ---- 站台編輯器 --------------------------------------------------------
  function renderEditor() {
    const el = document.getElementById('editor');
    const t = findEntity(state.selectedId);
    if (!t || t.type !== 'station') { el.innerHTML = ''; el.dataset.eid = ''; return; }

    // 同一站台且編輯器已存在：就地更新欄位值，且「不碰使用者正在編輯的欄位」，
    // 避免背景重繪（衛星/天空每幾秒更新）把你正在輸入的座標沖掉。
    if (el.dataset.eid === t.id && el.querySelector('input[data-f]')) {
      el.querySelectorAll('input[data-f]').forEach((inp) => {
        if (inp === document.activeElement) return; // 正在打字的欄位保持不動
        const f = inp.dataset.f;
        const val = f === 'name' ? t.name
          : (f === 'lat' || f === 'lng') ? Number(t[f]).toFixed(5)
          : (t[f] != null ? t[f] : '');
        if (String(inp.value) !== String(val)) inp.value = val;
      });
      return;
    }

    el.dataset.eid = t.id;
    el.innerHTML =
      `<div class="ed-title">✏️ 編輯站台</div>` +
      `<div class="ed-grid">` +
      `<label>名稱<input data-f="name" type="text" value="${t.name.replace(/"/g, '&quot;')}"></label>` +
      `<label>海拔(m)<input data-f="alt" type="number" value="${t.alt}"></label>` +
      `<label>天線(m)<input data-f="antenna" type="number" value="${t.antenna || 0}"></label>` +
      `<label>頻率(MHz)<input data-f="freqMHz" type="number" step="0.001" value="${t.freqMHz || ''}"></label>` +
      `<label>緯度<input data-f="lat" type="number" step="0.0001" value="${t.lat.toFixed(5)}"></label>` +
      `<label>經度<input data-f="lng" type="number" step="0.0001" value="${t.lng.toFixed(5)}"></label>` +
      `</div>` +
      `<div class="ed-move">` +
      `<input id="ed-movecoord" type="text" placeholder="貼座標把此站台移過去（如 24.28,121.03）" />` +
      `<button id="ed-movebtn">移動</button></div>` +
      `<div class="ed-btns">` +
      `<button id="ed-viewshed">🗺️ 計算地形涵蓋</button>` +
      `<button id="ed-del" class="danger">刪除此站台</button></div>` +
      `<div id="ed-vs-status" class="ed-vs-status"></div>`;

    el.querySelectorAll('input[data-f]').forEach((inp) => {
      inp.onchange = () => {
        const f = inp.dataset.f;
        if (f === 'name') {
          t.name = inp.value;
        } else if (f === 'lat' || f === 'lng') {
          const raw = inp.value.trim();
          // 只有「明確是一整對」時才兩欄一起設：含逗號，或同時有 N/S 與 E/W
          const isPair = /,/.test(raw) || (/[ns]/i.test(raw) && /[ew]/i.test(raw));
          const pair = isPair ? Parse.parseLatLng(raw) : null;
          if (pair) {
            t.lat = pair.lat; t.lng = pair.lng;
          } else {
            // 單一數值：有度分秒符號/字母才用 DMS，否則當純小數
            const v = /[°'"nsewNSEW]/.test(raw) ? Parse.parseCoordComponent(raw) : parseFloat(raw);
            const limit = f === 'lat' ? 90 : 180;
            if (v != null && isFinite(v) && Math.abs(v) <= limit) t[f] = v;
          }
        } else {
          t[f] = parseFloat(inp.value);
        }
        state.analysisById = {};        // 資料改變，重算
        saveState();
        render();
        if (t.type !== 'me') select(t.id);
      };
    });
    // 貼座標把此站台移過去
    const moveBtn = document.getElementById('ed-movebtn');
    const moveInp = document.getElementById('ed-movecoord');
    const doMove = () => {
      const ll = Parse.parseLatLng(moveInp.value);
      if (!ll) { alert('無法辨識座標，請確認格式（如 24.28,121.03 或 24°17′N 121°02′E）'); return; }
      t.lat = ll.lat; t.lng = ll.lng;
      t.alt = 0;                         // 高度重抓
      state.analysisById = {};
      moveInp.value = '';
      saveState();
      render();
      select(t.id);
      if (mapView.focus) mapView.focus(t);
      Elevation.elevationAt(t).then((e) => {
        if (e != null) { t.alt = Math.round(e); saveState(); render(); if (state.selectedId === t.id) select(t.id); }
      }).catch(() => {});
    };
    moveBtn.onclick = doMove;
    moveInp.onkeydown = (e) => { if (e.key === 'Enter') doMove(); };

    document.getElementById('ed-viewshed').onclick = () => computeViewshed(t);
    document.getElementById('ed-del').onclick = () => {
      if (!confirm(`確定刪除「${t.name}」？`)) return;
      state.stations = state.stations.filter((s) => s.id !== t.id);
      delete state.analysisById[t.id];
      state.selectedId = null;
      saveState();
      mapView.clearPath();
      render();
    };
  }

  // 依無線電視距畫各站台涵蓋圈（假設對方天線高 RX_H 公尺）
  const RX_H = 10;
  function updateCoverage() {
    if (!mapView.setCoverage) return;
    if (!state.settings.showCoverage) { mapView.setCoverage([]); return; }
    const circles = state.stations.map((st) => ({
      lat: st.lat, lng: st.lng,
      radiusM: (Geo.radioHorizonKm((st.alt || 0) + (st.antenna || 0)) + Geo.radioHorizonKm(RX_H)) * 1000,
      color: st.id === state.selectedId ? '#2f6fff' : '#35d07f',
    }));
    mapView.setCoverage(circles);
  }

  // ---- 選取目標並計算 ----------------------------------------------------
  async function select(id) {
    state.selectedId = id;
    const target = findEntity(id);
    // AR 視角轉向面對選定目標，並顯示「往哪個方位/仰角看」的對準提示
    const aimEl = document.getElementById('aim-hint');
    if (target && target.type !== 'me' && arView) {
      const brg = Geo.bearing(state.me, target);
      const dist = Geo.distance(state.me, target);
      const obsAlt = (state.me.alt || 0) + (state.me.antenna || 0);
      const elev = Geo.elevationAngle(obsAlt, target.alt, dist, state.settings.withCurvature, state.settings.k);
      arView.lookAt(brg, Math.max(0, elev));
      if (aimEl) aimEl.innerHTML =
        `🎯 <b>${target.name}</b>：AR 中往 <b>方位 ${Math.round(brg)}° ${Geo.compass8(brg)}</b>、` +
        `仰角 ${elev.toFixed(1)}° 看　·　距離 ${Geo.fmtDistance(dist)}`;
    } else if (aimEl) {
      aimEl.innerHTML = '';
    }
    render();
    if (!target || target.type === 'me') return;

    const info = document.getElementById('los-status');
    // 目標與我幾乎重疊：距離趨近 0，路徑分析無意義（會算出 NaN），直接提示
    if (Geo.distance(state.me, target) < 30) {
      info.innerHTML = '<span class="warn">此目標幾乎就在我的位置上（距離趨近 0），無法做路徑分析。<br>' +
        '請用「移動」把它移到別處，或選其他目標。</span>';
      mapView.clearPath();
      return;
    }
    info.textContent = '⏳ 取得地形剖面中…';
    try {
      const profile = await Elevation.buildProfile(state.me, target, 96);
      const analysis = Elevation.analyzePath(profile, {
        obsAntenna: state.me.antenna || state.settings.obsAntenna,
        tgtAntenna: target.antenna || state.settings.tgtAntenna,
        freqMHz: target.freqMHz || state.settings.freqMHz,
        k: state.settings.k,
      });
      state.analysisById[id] = analysis;
      state._lastProfile = profile;
      mapView.drawPath(state.me, target, profile, analysis);
      drawProfile(profile, analysis, target);
      arView.render(state);
      renderLosStatus(target, analysis);
    } catch (err) {
      info.innerHTML = `<span class="warn">⚠️ 無法取得高程資料：${err.message}<br>` +
        `（需連線至 open-meteo.com；離線時僅能顯示距離/方位）</span>`;
      // 仍畫出直線（無遮蔽判斷）
      const profile = Geo.samplePath(state.me, target, 64).map((p) => ({ ...p, dist: p.frac * Geo.distance(state.me, target), ground: null }));
      mapView.drawPath(state.me, target, profile, { samples: profile.map(() => ({ clearance: 1 })) });
    }
  }

  // 連結餘裕 (dB)：接收功率 − 靈敏度
  function linkMargin(a) {
    if (!a) return null;
    const rxPower = state.settings.eirpDbm + state.settings.rxGainDbi - a.totalLoss;
    return rxPower - state.settings.rxSensDbm;
  }

  // 排序權重：可通且餘裕大者優先；未分析者排在對應區塊之後。
  function rankScore(t) {
    const a = state.analysisById[t.id];
    if (!a) return -1e9 + -Geo.distance(state.me, t) / 1000; // 未分析：以距離近者略優
    const m = linkMargin(a);
    const base = a.clear ? 3e6 : a.losClear ? 2e6 : 1e6;
    return base + m * 1000;
  }

  function renderLosStatus(target, a) {
    const info = document.getElementById('los-status');
    const horizon = Geo.radioHorizonKm((state.me.alt || 0) + (state.me.antenna || 0), state.settings.k)
                  + Geo.radioHorizonKm(target.alt + (target.antenna || 0), state.settings.k);
    const worst = a.worst;
    const rows = [];
    if (a.clear) {
      rows.push(`<div class="ok">✓ 路徑淨空良好（第一菲涅耳區淨空 ≥ 60%）</div>`);
    } else if (a.losClear) {
      rows.push(`<div class="marg">△ 視線可通，但菲涅耳區未完全淨空（會有繞射損耗）</div>`);
    } else {
      rows.push(`<div class="bad">✗ 中間有山擋住！視線被地形遮蔽</div>`);
    }
    if (worst) {
      rows.push(`<div class="sub">最緊要處：距我 ${Geo.fmtDistance(worst.dist)}，` +
        `地面 ${Math.round(worst.ground)} m，淨空 ${worst.clearance >= 0 ? '+' : ''}${Math.round(worst.clearance)} m` +
        `（菲涅耳比 ${isFinite(worst.ratio) ? worst.ratio.toFixed(2) : '—'}）</div>`);
    }
    // 連結預算
    const sens = state.settings.rxSensDbm;
    const rxPower = state.settings.eirpDbm + state.settings.rxGainDbi - a.totalLoss;
    const margin = linkMargin(a);                   // 連結餘裕 (dB)
    const marginCls = margin >= 10 ? 'ok' : margin >= 0 ? 'marg' : 'bad';
    rows.push(`<div class="sub">路徑損耗：${a.totalLoss.toFixed(1)} dB` +
      `（自由空間 ${a.fspl.toFixed(1)} + 繞射 ${a.diffractionLoss.toFixed(1)}）</div>`);
    if (a.diffractionMulti != null) {
      rows.push(`<div class="sub">繞射：單刃 ${a.diffractionSingle.toFixed(1)} dB / ` +
        `Deygout多刃 ${a.diffractionMulti.toFixed(1)} dB</div>`);
    }
    rows.push(`<div class="sub ${marginCls}">連結餘裕：${margin >= 0 ? '+' : ''}${margin.toFixed(1)} dB` +
      `（接收約 ${rxPower.toFixed(0)} dBm / 靈敏度 ${sens} dBm）</div>`);
    rows.push(`<div class="sub">理論無線電視距上限：約 ${horizon.toFixed(0)} km</div>`);
    info.innerHTML = rows.join('');
  }

  // ---- 地形感知涵蓋多邊形 ------------------------------------------------
  let computingVs = false;
  async function computeViewshed(station) {
    if (computingVs || !mapView.setViewshed) return;
    computingVs = true;
    const el = document.getElementById('ed-vs-status');
    if (el) el.textContent = '⏳ 發射射線、計算地形遮蔽中…';
    try {
      const poly = await Elevation.computeCoveragePolygon(station, {
        antenna: station.antenna || state.settings.tgtAntenna,
        rxHeight: RX_H,
        freqMHz: station.freqMHz || state.settings.freqMHz,
        k: state.settings.k,
      });
      mapView.setViewshed(poly, '#f5b942');
      if (el) el.innerHTML = `<span class="ok">✓ 已畫出「${station.name}」地形涵蓋（黃色虛線）</span>`;
      // 切到地圖分頁以便看到結果
      const mapTab = document.querySelector('.tab[data-view="view-map"]');
      if (mapTab) mapTab.click();
    } catch (err) {
      if (el) el.innerHTML = `<span class="warn">⚠️ 計算失敗：${err.message}（需連線 open-meteo.com）</span>`;
    }
    computingVs = false;
  }

  // ---- 一鍵分析全部站台 --------------------------------------------------
  let analyzing = false;
  async function analyzeAll() {
    if (analyzing) return;
    analyzing = true;
    const prog = document.getElementById('analyze-progress');
    const list = state.stations;
    let done = 0, failed = 0;
    for (const st of list) {
      prog.textContent = `分析中… ${done + 1}/${list.length}（${st.name}）`;
      try {
        const profile = await Elevation.buildProfile(state.me, st, 96);
        state.analysisById[st.id] = Elevation.analyzePath(profile, {
          obsAntenna: state.me.antenna || state.settings.obsAntenna,
          tgtAntenna: st.antenna || state.settings.tgtAntenna,
          freqMHz: st.freqMHz || state.settings.freqMHz,
          k: state.settings.k,
        });
      } catch (err) { failed++; }
      done++;
      renderPanel();
    }
    prog.textContent = failed
      ? `完成，但 ${failed} 個站台無法取得高程（需連線 open-meteo.com）`
      : `✓ 已分析 ${done} 個站台，依路徑品質排序`;
    analyzing = false;
  }

  // ---- 資訊面板 ----------------------------------------------------------
  function renderPanel() {
    const listEl = document.getElementById('target-list');
    // 站台依路徑品質排序（已分析者），山峰依距離
    const stations = [...state.stations].sort((a, b) => rankScore(b) - rankScore(a));
    const peaks = [...state.peaks].sort((a, b) => Geo.distance(state.me, a) - Geo.distance(state.me, b));
    const targets = [...stations, ...peaks];

    // 找出最佳可通站台（可通且餘裕最大）
    let best = null, bestM = -Infinity;
    stations.forEach((t) => {
      const a = state.analysisById[t.id];
      if (a && a.losClear) { const m = linkMargin(a); if (m > bestM) { bestM = m; best = t.id; } }
    });

    listEl.innerHTML = targets.map((t) => {
      const dist = Geo.distance(state.me, t);
      const brg = Geo.bearing(state.me, t);
      const a = state.analysisById[t.id];
      const badge = a ? (a.clear ? '<b class="b-ok">通</b>' : a.losClear ? '<b class="b-marg">繞</b>' : '<b class="b-bad">擋</b>') : '';
      const star = t.id === best ? '<span class="star" title="最佳可通站台">⭐</span>' : '';
      const m = a ? linkMargin(a) : null;
      const marginTxt = m != null ? ` · 餘裕 ${m >= 0 ? '+' : ''}${m.toFixed(0)}dB` : '';
      const sel = t.id === state.selectedId ? ' sel' : '';
      const ico = t.type === 'station' ? '📡' : '⛰️';
      return `<li class="tgt${sel}" data-id="${t.id}">` +
        `<span class="t-ico">${ico}</span>` +
        `<span class="t-main"><b>${t.name}</b> ${badge}${star}` +
        `<small>${Geo.fmtDistance(dist)} · ${Math.round(brg)}° ${Geo.compass8(brg)} · ${t.alt}m${marginTxt}</small></span>` +
        `</li>`;
    }).join('');
    listEl.querySelectorAll('.tgt').forEach((el) => {
      el.onclick = () => select(el.dataset.id);
    });

    document.getElementById('me-coord').textContent =
      `${state.me.lat.toFixed(4)}, ${state.me.lng.toFixed(4)} · 海拔 ${state.me.alt}m · 天線 ${state.me.antenna}m`;
  }

  // ---- 地形剖面圖 (canvas) ----------------------------------------------
  function drawProfile(profile, analysis, target) {
    const cv = document.getElementById('profile');
    const ctx = cv.getContext('2d');
    const W = cv.width = cv.clientWidth * (global.devicePixelRatio || 1);
    const H = cv.height = cv.clientHeight * (global.devicePixelRatio || 1);
    ctx.clearRect(0, 0, W, H);
    const pad = 26 * (global.devicePixelRatio || 1);

    const D = analysis.D;
    const maxH = Math.max(...analysis.samples.map((s) => Math.max(s.ground || 0, s.los))) * 1.1 + 50;
    const x = (d) => pad + (d / D) * (W - 2 * pad);
    const y = (h) => H - pad - (h / maxH) * (H - 2 * pad);

    // 地面填色（含曲率鼓起）
    ctx.beginPath();
    ctx.moveTo(x(0), y(0));
    analysis.samples.forEach((s) => ctx.lineTo(x(s.dist), y((s.ground || 0) + s.bulge)));
    ctx.lineTo(x(D), y(0));
    ctx.closePath();
    ctx.fillStyle = '#7a5b3a';
    ctx.fill();

    // 第一菲涅耳區（半透明橢圓帶）
    ctx.beginPath();
    analysis.samples.forEach((s, i) => { const p = i ? 'lineTo' : 'moveTo'; ctx[p](x(s.dist), y(s.los + s.fresnel)); });
    for (let i = analysis.samples.length - 1; i >= 0; i--) { const s = analysis.samples[i]; ctx.lineTo(x(s.dist), y(s.los - s.fresnel)); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(47,111,255,0.15)';
    ctx.fill();

    // 視線直線
    ctx.strokeStyle = analysis.losClear ? '#2f6fff' : '#e23b3b';
    ctx.lineWidth = 2 * (global.devicePixelRatio || 1);
    ctx.beginPath();
    ctx.moveTo(x(0), y(analysis.h1));
    ctx.lineTo(x(D), y(analysis.h2));
    ctx.stroke();

    // 端點標示
    ctx.fillStyle = '#fff';
    ctx.font = `${12 * (global.devicePixelRatio || 1)}px system-ui`;
    ctx.fillText('我', x(0), y(analysis.h1) - 6);
    ctx.fillText(target.name, x(D) - 40, y(analysis.h2) - 6);
  }

  // 讓表單欄位反映目前 state（載入/匯入/還原後呼叫）
  function syncControls() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
    set('opt-freq', state.settings.freqMHz);
    set('opt-ant', state.me.antenna);
    set('opt-eirp', state.settings.eirpDbm);
    set('opt-rxg', state.settings.rxGainDbi);
    set('opt-sens', state.settings.rxSensDbm);
    set('opt-starmag', state.settings.starMag);
    chk('opt-curv', state.settings.withCurvature);
    chk('opt-cov', !!state.settings.showCoverage);
    chk('opt-sky', !!state.settings.showSky);
    chk('opt-sat', !!state.settings.showSat);
    skyTicker();
    satTicker();
  }

  // 天空顯示「現在」時，每 20 秒自動更新一次天體位置
  let skyTimer = null;
  function skyTicker() {
    const live = state.settings.showSky && !state.settings.skyTime;
    if (live && !skyTimer) skyTimer = setInterval(() => arView && arView.render(state), 20000);
    if (!live && skyTimer) { clearInterval(skyTimer); skyTimer = null; }
  }

  // 衛星（ISS）：每 5 秒抓即時位置換算方位/仰角
  let satTimer = null, satJustOn = false;
  async function fetchISS() {
    try {
      const r = await fetch('https://api.wheretheiss.at/v1/satellites/25544');
      if (!r.ok) throw new Error('ISS API ' + r.status);
      const j = await r.json();
      const la = Sky.lookAngles(state.me, { lat: j.latitude, lng: j.longitude, altKm: j.altitude });
      state.satellites = [{
        id: 'iss', name: '🛰 ISS', type: 'sat',
        az: la.az, alt: la.el, rangeKm: la.rangeKm,
        subLat: j.latitude, subLng: j.longitude,
      }];
      // 狀態提示：即使在地平線下也告訴使用者它在哪
      if (state.settings.showSat) {
        if (la.el >= 0) {
          setSkyHint(`🛰 ISS 在地平線上！往 方位 ${Math.round(la.az)}° ${Geo.compass8(la.az)}、仰角 ${la.el.toFixed(0)}° 看（距離 ${Math.round(la.rangeKm)} km）`);
          if (satJustOn) { showARTab(); if (arView) arView.lookAt(la.az, Math.max(0, la.el)); satJustOn = false; }
        } else {
          setSkyHint(`🛰 ISS 目前在地平線下（方位 ${Math.round(la.az)}° ${Geo.compass8(la.az)}、仰角 ${la.el.toFixed(0)}°）——過境時才看得到；地圖上有它現在的地表位置`);
          satJustOn = false;
        }
      }
      if (mapView.setSatellite) mapView.setSatellite({ lat: j.latitude, lng: j.longitude, name: '🛰 ISS', alt: la.el });
    } catch (_) {
      state.satellites = [];
      if (state.settings.showSat) setSkyHint('🛰 無法取得 ISS 位置（網路或服務暫時擋住），稍後會自動再試');
    }
    if (arView) arView.render(state);
  }
  function satTicker() {
    if (state.settings.showSat && !satTimer) { satJustOn = true; fetchISS(); satTimer = setInterval(fetchISS, 5000); }
    if (!state.settings.showSat && satTimer) {
      clearInterval(satTimer); satTimer = null; state.satellites = [];
      if (mapView.setSatellite) mapView.setSatellite(null);
      if (arView) arView.render(state);
    }
  }

  // ---- 設定與工具列 ------------------------------------------------------
  function bindControls() {
    document.getElementById('opt-curv').onchange = (e) => { state.settings.withCurvature = e.target.checked; render(); };
    document.getElementById('opt-cov').onchange = (e) => { state.settings.showCoverage = e.target.checked; updateCoverage(); };

    // 天文層
    document.getElementById('opt-sky').onchange = (e) => {
      state.settings.showSky = e.target.checked;
      saveState(); skyTicker(); render();
      if (e.target.checked) { showARTab(); faceBestSky(); }
      else setSkyHint('');
    };
    document.getElementById('opt-skytime').onchange = (e) => {
      state.settings.skyTime = e.target.value ? new Date(e.target.value).toISOString() : null;
      saveState(); render();
    };
    document.getElementById('btn-skynow').onclick = () => {
      state.settings.skyTime = null;
      document.getElementById('opt-skytime').value = '';
      saveState(); render();
    };
    document.getElementById('opt-starmag').onchange = (e) => { state.settings.starMag = parseFloat(e.target.value); saveState(); render(); };
    document.getElementById('opt-sat').onchange = (e) => {
      state.settings.showSat = e.target.checked;
      saveState(); satTicker(); render();
      if (e.target.checked) { showARTab(); setSkyHint('🛰 取得 ISS 位置中…（若在地平線下會顯示於地面方向）'); }
      else setSkyHint('');
    };
    document.getElementById('opt-freq').onchange = (e) => {
      state.settings.freqMHz = parseFloat(e.target.value) || 145.7;
      if (state.selectedId) select(state.selectedId);
    };
    document.getElementById('opt-ant').onchange = (e) => {
      state.me.antenna = parseFloat(e.target.value) || 0;
      renderPanel();
      if (state.selectedId) select(state.selectedId);
    };
    const reselect = () => { saveState(); if (state.selectedId) select(state.selectedId); };
    document.getElementById('opt-eirp').onchange = (e) => { state.settings.eirpDbm = parseFloat(e.target.value) || 0; reselect(); };
    document.getElementById('opt-rxg').onchange = (e) => { state.settings.rxGainDbi = parseFloat(e.target.value) || 0; reselect(); };
    document.getElementById('opt-sens').onchange = (e) => { state.settings.rxSensDbm = parseFloat(e.target.value) || 0; reselect(); };

    // 匯出 / 匯入 / 還原
    document.getElementById('btn-export').onclick = () => {
      const data = JSON.stringify({ me: state.me, stations: state.stations, settings: state.settings }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vrmap-stations.json';
      a.click();
      URL.revokeObjectURL(a.href);
    };
    const fileInput = document.getElementById('file-import');
    document.getElementById('btn-import').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const d = Parse.parseStations(reader.result, file.name);
          if (!d.stations || !d.stations.length) throw new Error('找不到可匯入的站台');
          if (d.mode === 'replace') {
            if (d.me) Object.assign(state.me, d.me);
            state.stations = d.stations;
            if (d.settings) Object.assign(state.settings, d.settings);
          } else {
            state.stations = state.stations.concat(d.stations); // CSV/GPX 追加
          }
          state.analysisById = {};
          state.selectedId = null;
          saveState();
          syncControls();
          mapView.clearPath();
          render();
          if (mapView.focus) mapView.focus(state.me);
          alert(`已匯入 ${d.stations.length} 個站台（${d.mode === 'replace' ? '取代' : '追加'}）`);
        } catch (err) { alert('匯入失敗：' + err.message); }
      };
      reader.readAsText(file);
      fileInput.value = '';
    };
    document.getElementById('btn-reset').onclick = () => {
      if (!confirm('還原為預設站台資料？（會清除你的變更）')) return;
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      state.me = { ...S.me };
      state.stations = S.stations.map((s) => ({ ...s }));
      state.peaks = S.peaks.map((p) => ({ ...p }));
      state.analysisById = {};
      state.selectedId = null;
      syncControls();
      mapView.clearPath();
      render();
    };

    document.getElementById('btn-analyze-all').onclick = () => analyzeAll();

    // 萬用座標：貼上任何格式套用到我的位置（立即反應，高程在背景補上）
    const applyPaste = () => {
      const inp = document.getElementById('paste-coord');
      const ll = Parse.parseLatLng(inp.value);
      if (!ll) { alert('無法辨識座標格式，請再確認'); return; }
      inp.value = '';                       // 先清空，立刻給回饋
      setMyLocation(ll.lat, ll.lng);
    };
    document.getElementById('btn-paste').onclick = applyPaste;
    document.getElementById('paste-coord').onkeydown = (e) => { if (e.key === 'Enter') applyPaste(); };

    // 用座標新增一個標點/站台（不動我的位置）
    document.getElementById('btn-addstation').onclick = () => {
      const inp = document.getElementById('paste-coord');
      const ll = Parse.parseLatLng(inp.value);
      if (!ll) { alert('請先在上面貼上座標（任何格式），再按「新增站台」'); return; }
      const name = prompt('新站台名稱：', '新標點');
      if (name == null) return;
      const st = { id: `st-${Date.now()}`, type: 'station', name: name || '新標點', lat: ll.lat, lng: ll.lng, alt: 0, antenna: 6, freqMHz: state.settings.freqMHz };
      state.stations.push(st);
      inp.value = '';
      saveState();
      render();
      select(st.id);              // 選取並對準
      if (mapView.focus) mapView.focus(st);
      Elevation.elevationAt(st).then((e) => {
        if (e != null) { st.alt = Math.round(e); saveState(); render(); if (state.selectedId === st.id) select(st.id); }
      }).catch(() => {});
    };

    document.getElementById('btn-locate').onclick = () => {
      if (!navigator.geolocation) return alert('此裝置不支援定位');
      navigator.geolocation.getCurrentPosition(
        (pos) => setMyLocation(pos.coords.latitude, pos.coords.longitude),
        () => alert('定位失敗')
      );
    };

    syncControls();

    // 分頁切換
    document.querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
        document.querySelectorAll('.view').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        document.getElementById(b.dataset.view).classList.add('on');
        if (b.dataset.view === 'view-map') setTimeout(() => mapView.map.invalidateSize(), 60);
        else if (b.dataset.view === 'view-ar' && arView) setTimeout(() => arView.repaint(), 60);
      };
    });
  }

  // ---- 天空輔助：切到 AR、自動轉向可見天體、提示方向 --------------------
  function setSkyHint(txt) {
    const el = document.getElementById('sky-hint');
    if (el) el.textContent = txt || '';
  }
  function showARTab() {
    const arTab = document.querySelector('.tab[data-view="view-ar"]');
    if (arTab && !arTab.classList.contains('on')) arTab.click();
  }
  function faceBestSky() {
    if (!state.settings.showSky || !global.Sky || !arView) return;
    const date = state.settings.skyTime ? new Date(state.settings.skyTime) : new Date();
    const objs = Sky.skyObjects(date, state.me.lat, state.me.lng,
      { maxMag: state.settings.starMag != null ? state.settings.starMag : 2.2 });
    const up = objs.filter((o) => o.alt > 3);
    if (!up.length) { setSkyHint('目前沒有明顯天體在地平線以上——試著在「天空」進階裡改「時間」到夜晚。'); return; }
    // 優先：太陽 > 月亮 > 最亮者
    const pick = up.find((o) => o.type === 'sun') || up.find((o) => o.type === 'moon')
      || up.slice().sort((a, b) => (a.mag == null ? 9 : a.mag) - (b.mag == null ? 9 : b.mag))[0];
    arView.lookAt(pick.az, Math.max(0, pick.alt)); // 桌機轉向；手機感測器模式不干預
    setSkyHint(`👉 ${pick.name}：往 方位 ${Math.round(pick.az)}° ${Geo.compass8(pick.az)}、仰角 ${Math.round(pick.alt)}° 看（共 ${up.length} 個天體在地平線上）`);
  }

  // ---- 地圖回呼 ----------------------------------------------------------
  const handlers = {
    onSelect: (id) => select(id),
    onMove: (id, lat, lng) => {
      const ent = findEntity(id);
      if (!ent) return;
      ent.lat = lat; ent.lng = lng;
      state.analysisById = {}; // 位置變了，重算
      saveState();
      render();                 // 立刻反應
      if (state.selectedId) select(state.selectedId);
      // 高程在背景補上
      Elevation.elevationAt(ent).then((e) => {
        if (e != null) { ent.alt = Math.round(e); saveState(); renderPanel(); if (state.selectedId) select(state.selectedId); }
      }).catch(() => {});
    },
    onAddStation: (lat, lng) => {
      const name = prompt('新增無線電站台名稱：', `站台 ${state.stations.length + 1}`);
      if (name == null) return;
      const st = { id: `st-${Date.now()}`, type: 'station', name, lat, lng, alt: 0, antenna: 6, freqMHz: state.settings.freqMHz };
      state.stations.push(st);
      saveState();
      render();
      select(st.id);
      // 高程在背景補上
      Elevation.elevationAt(st).then((e) => {
        if (e != null) { st.alt = Math.round(e); saveState(); render(); if (state.selectedId === st.id) select(st.id); }
      }).catch(() => {});
    },
  };

  function init() {
    loadState();  // 還原上次的站台/設定（若有）
    // 地圖若載入失敗（例如缺 Leaflet），不應中斷 AR 視角與面板。
    try {
      if (global.L) {
        global.L.Icon.Default.imagePath = 'vendor/leaflet/images/';
        mapView = new MapView('map', handlers);
      } else {
        throw new Error('Leaflet 未載入');
      }
    } catch (err) {
      mapView = { render() {}, drawPath() {}, clearPath() {}, setCoverage() {}, setViewshed() {}, setSatellite() {}, focus() {}, map: { invalidateSize() {} } };
      const el = document.getElementById('map');
      if (el) el.innerHTML = `<div class="map-fallback">⚠️ 地圖元件未載入（${err.message}）<br>AR 視角與路徑分析仍可使用。</div>`;
    }
    arView = new ARView('view-ar', handlers);
    bindControls();
    render();
    // 預設選第一個站台展示
    if (state.stations[0]) select(state.stations[0].id);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.App = { state, select, getArView: () => arView, render };
})(typeof window !== 'undefined' ? window : globalThis);
