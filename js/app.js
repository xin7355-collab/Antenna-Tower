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
    markers: (S.markers || []).map((m) => ({ ...m })),   // 自訂位置標註
    selectedId: null,
    satellites: [],            // 即時衛星（ISS）方位仰角
    analysisById: {},          // id -> analyzePath 結果（快取）
    skyline: null,             // 天際線輪廓 { at, obsAlt, points }
    settings: {
      freqMHz: 145.7, obsAntenna: 3, tgtAntenna: 6, k: Geo.K_DEFAULT, withCurvature: true,
      eirpDbm: 37,      // 等效全向輻射功率（約 5 W）
      rxGainDbi: 3,     // 接收天線增益
      rxSensDbm: -110,  // 接收機靈敏度
      showSky: false,   // 天文疊加層
      skyTime: null,    // null=現在；否則 ISO 字串
      starMag: 2.2,     // 顯示星等上限
      showSat: false,   // 衛星（ISS）
      showConstellations: true, // 星座連線（北斗七星等）
      hiddenGroups: [], // 被隱藏的群組 id
      declination: -4.5, // 磁偏角（°，東偏為正）；羅盤讀到的是磁北，台灣約 -4.5
      sats: ['iss'],    // 追蹤中的衛星（js/sats.js 目錄 id 或 norad-XXXXX）
      hfov: 70,         // AR 水平視野角（°），開相機時可用雙指縮放校正
    },
  };

  let mapView, arView;
  const LS_KEY = 'vrmap.state.v1';

  /** 所有可選取的地面實體（不含「我的位置」） */
  function allTargets() {
    return [...state.stations, ...state.peaks, ...state.markers];
  }

  function findEntity(id) {
    return [state.me, ...allTargets()].find((e) => e.id === id) || null;
  }

  /** 讓 groups.js 認得資料裡出現的所有群組（含匯入進來的新群組） */
  function learnGroups() {
    if (global.Groups) Groups.learn(allTargets());
  }

  // 設定我的位置：立即更新畫面，高程與遮蔽在背景補上（不卡 UI）
  function setMyLocation(lat, lng) {
    state.me.lat = lat;
    state.me.lng = lng;
    state.analysisById = {};
    state.skyline = null;   // 換位置了，舊的山體輪廓不再適用（saveState 在下面）
    const slEl = document.getElementById('skyline-status');
    if (slEl) slEl.textContent = '';
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
        me: state.me, stations: state.stations, markers: state.markers, settings: state.settings,
        // 輪廓一併存起來：重開 App 不必再跟高程服務要一次（那是被限流的主因）
        skyline: state.skyline ? { at: state.skyline.at, obsAlt: state.skyline.obsAlt,
          points: state.skyline.points, coverage: state.skyline.coverage } : null,
      }));
    } catch (_) { /* localStorage 可能被停用，忽略 */ }
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.me) Object.assign(state.me, d.me);
      if (Array.isArray(d.stations)) {
        state.stations = d.stations;
        // 群組功能加入前存下的站臺沒有 group 欄位，會全部掉進「自訂站臺」。
        // 內建範例站臺（id 對得上）補回原本的地區群組。
        const sample = new Map(S.stations.map((x) => [x.id, x]));
        state.stations.forEach((st) => {
          const src = sample.get(st.id);
          if (src && (st.group == null || st.group === '')) st.group = src.group;
        });
      }
      if (Array.isArray(d.markers)) state.markers = d.markers;
      if (d.settings) Object.assign(state.settings, d.settings);
      // 只有在「還站在同一個地方」時才沿用舊輪廓；移動超過 300m 就作廢
      if (d.skyline && d.skyline.at && Array.isArray(d.skyline.points)) {
        const moved = Geo.distance(d.skyline.at, state.me);
        if (moved < 300) state.skyline = d.skyline;
      }
    } catch (_) { /* 資料毀損則忽略 */ }
  }

  function render() {
    learnGroups();
    mapView.render(state);
    arView.render(state);
    renderPanel();
    renderEditor();
    renderGroupFilter();
    updateCoverage();
  }

  // ---- 站臺編輯器 --------------------------------------------------------
  /** 群組下拉選單的 <option>；最後一項可即時建立新群組 */
  function groupOptionsHtml(selectedId) {
    const gs = global.Groups ? Groups.all() : [];
    return gs.map((g) =>
      `<option value="${g.id}"${g.id === selectedId ? ' selected' : ''}>${g.name}</option>`
    ).join('') + '<option value="__new__">＋ 新增群組…</option>';
  }

  /** 群組欄位變更：選到「新增群組」就問名稱並即時註冊 */
  async function applyGroupChange(t, sel) {
    if (sel.value === '__new__') {
      const name = await UI.ask('新增群組', '', '例如：南橫線、私人中繼');
      if (!name || !name.trim()) { sel.value = Groups.groupIdOf(t) || ''; return false; }
      Groups.register(name.trim(), name.trim());
      t.group = name.trim();
    } else {
      t.group = sel.value;
    }
    return true;
  }

  /** 新增項目後把游標放到名稱欄，直接就能改名（取代跳出來問名字） */
  function focusEditorName() {
    setTimeout(() => {
      const inp = document.querySelector('#editor input[data-f="name"], #editor input[data-mf="name"]');
      if (!inp) return;
      inp.focus();
      if (inp.select) inp.select();
    }, 60);
  }

  function renderEditor() {
    const el = document.getElementById('editor');
    const t = findEntity(state.selectedId);
    if (t && t.type === 'marker') return renderMarkerEditor(el, t);
    if (!t || t.type !== 'station') { el.innerHTML = ''; el.dataset.eid = ''; return; }

    // 同一站臺且編輯器已存在：就地更新欄位值，且「不碰使用者正在編輯的欄位」，
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
      const eff = el.querySelector('.ed-eff');
      if (eff) {
        eff.innerHTML = `目前採用高度：<b>${Math.round(Geo.targetTopAlt(t, state.settings.tgtAntenna))} m</b>` +
          `（${Geo.usesTrueAlt(t) ? '真實高度優先' : `海拔 ${t.alt || 0} + 天線 ${t.antenna || 0}`}）`;
      }
      return;
    }

    el.dataset.eid = t.id;
    el.innerHTML =
      `<div class="ed-title">✏️ 編輯站臺</div>` +
      `<div class="ed-grid">` +
      `<label>名稱<input data-f="name" type="text" value="${t.name.replace(/"/g, '&quot;')}"></label>` +
      `<label>海拔(m)<input data-f="alt" type="number" value="${t.alt}"></label>` +
      `<label>天線(m)<input data-f="antenna" type="number" value="${t.antenna || 0}"></label>` +
      `<label>頻率(MHz)<input data-f="freqMHz" type="number" step="0.001" value="${t.freqMHz || ''}"></label>` +
      `<label>緯度<input data-f="lat" type="number" step="0.0001" value="${t.lat.toFixed(5)}"></label>` +
      `<label>經度<input data-f="lng" type="number" step="0.0001" value="${t.lng.toFixed(5)}"></label>` +
      `<label class="ed-wide">群組<select id="ed-group">${groupOptionsHtml(Groups.groupIdOf(t))}</select></label>` +
      `<label class="ed-wide">目標真實高度(m)　<small>填了就以此為準（覆蓋 海拔+天線）；留空則用 海拔+天線</small>` +
      `<input data-f="trueAlt" type="number" step="1" placeholder="留空＝不使用" value="${t.trueAlt != null && t.trueAlt !== '' ? t.trueAlt : ''}"></label>` +
      `</div>` +
      `<div class="ed-eff">目前採用高度：<b>${Math.round(Geo.targetTopAlt(t, state.settings.tgtAntenna))} m</b>` +
      `（${Geo.usesTrueAlt(t) ? '真實高度優先' : `海拔 ${t.alt || 0} + 天線 ${t.antenna || 0}`}）</div>` +
      `<div class="ed-move">` +
      `<input id="ed-movecoord" type="text" placeholder="貼座標把此站臺移過去（如 24.28,121.03）" />` +
      `<button id="ed-movebtn">移動</button></div>` +
      `<div class="ed-btns">` +
      `<button id="ed-viewshed">🗺️ 計算地形涵蓋</button>` +
      `<button id="ed-del" class="danger">刪除此站臺</button></div>` +
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
        } else if (f === 'trueAlt') {
          // 留空＝取消覆蓋，回到「海拔 + 天線」
          const raw = inp.value.trim();
          if (raw === '') delete t.trueAlt;
          else { const v = parseFloat(raw); if (isFinite(v)) t.trueAlt = v; }
        } else {
          t[f] = parseFloat(inp.value);
        }
        state.analysisById = {};        // 資料改變，重算
        saveState();
        render();
        if (t.type !== 'me') select(t.id);
      };
    });
    const grpSel = document.getElementById('ed-group');
    if (grpSel) grpSel.onchange = async () => {
      if (!await applyGroupChange(t, grpSel)) return;
      saveState(); render(); select(t.id);
    };
    // 貼座標把此站臺移過去
    const moveBtn = document.getElementById('ed-movebtn');
    const moveInp = document.getElementById('ed-movecoord');
    const doMove = () => {
      const ll = Parse.parseLatLng(moveInp.value);
      if (!ll) { UI.toast('無法辨識座標，請確認格式（如 24.28,121.03 或 24°17′N 121°02′E）', 'warn'); return; }
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
    document.getElementById('ed-del').onclick = async () => {
      if (!await UI.confirm('刪除站臺', `確定刪除「${t.name}」？此動作無法復原。`, '刪除', true)) return;
      state.stations = state.stations.filter((s) => s.id !== t.id);
      delete state.analysisById[t.id];
      state.selectedId = null;
      saveState();
      mapView.clearPath();
      render();
      UI.toast(`已刪除「${t.name}」`, 'ok');
    };
  }

  // ---- 自訂位置標註編輯器 ------------------------------------------------
  // 常用圖示；也可自行輸入任意 emoji。
  const MARKER_ICONS = ['📌', '🚩', '⭐', '🏠', '⛺', '🚗', '🅿️', '🥾', '💧', '⚠️', '📷', '🎯'];

  function renderMarkerEditor(el, t) {
    // 同一標註且已渲染：就地更新，別把正在輸入的欄位沖掉
    if (el.dataset.eid === t.id && el.querySelector('[data-mf]')) {
      el.querySelectorAll('[data-mf]').forEach((inp) => {
        if (inp === document.activeElement) return;
        const f = inp.dataset.mf;
        const val = (f === 'lat' || f === 'lng') ? Number(t[f]).toFixed(5) : (t[f] != null ? t[f] : '');
        if (String(inp.value) !== String(val)) inp.value = val;
      });
      // 目前選用的圖示也要跟著換高亮，否則按了圖示卻看不出哪個被選中
      el.querySelectorAll('.ed-ico').forEach((b) => {
        b.classList.toggle('on', b.dataset.ico === (t.icon || '📌'));
      });
      return;
    }
    el.dataset.eid = t.id;
    el.innerHTML =
      `<div class="ed-title">📌 編輯標註</div>` +
      `<div class="ed-grid">` +
      `<label>名稱<input data-mf="name" type="text" value="${String(t.name).replace(/"/g, '&quot;')}"></label>` +
      `<label>圖示<input data-mf="icon" type="text" maxlength="4" value="${t.icon || '📌'}"></label>` +
      `<label>緯度<input data-mf="lat" type="number" step="0.0001" value="${t.lat.toFixed(5)}"></label>` +
      `<label>經度<input data-mf="lng" type="number" step="0.0001" value="${t.lng.toFixed(5)}"></label>` +
      `<label class="ed-wide">群組<select id="ed-mgroup">${groupOptionsHtml(Groups.groupIdOf(t))}</select></label>` +
      `<label class="ed-wide">備註<input data-mf="note" type="text" placeholder="例如：空曠、南向無遮蔽" value="${String(t.note || '').replace(/"/g, '&quot;')}"></label>` +
      `</div>` +
      `<div class="ed-icons">${MARKER_ICONS.map((i) =>
        `<button class="ed-ico${i === (t.icon || '📌') ? ' on' : ''}" data-ico="${i}">${i}</button>`).join('')}</div>` +
      `<div class="ed-eff">海拔 ${Math.round(t.alt || 0)} m　·　距我 ${Geo.fmtDistance(Geo.distance(state.me, t))}</div>` +
      `<div class="ed-move">` +
      `<input id="ed-mmovecoord" type="text" placeholder="貼座標把此標註移過去" />` +
      `<button id="ed-mmovebtn">移動</button></div>` +
      `<div class="ed-btns">` +
      `<button id="ed-mdel" class="danger">刪除此標註</button></div>`;

    el.querySelectorAll('[data-mf]').forEach((inp) => {
      inp.onchange = () => {
        const f = inp.dataset.mf;
        if (f === 'lat' || f === 'lng') {
          const raw = inp.value.trim();
          const v = /[°'"nsewNSEW]/.test(raw) ? Parse.parseCoordComponent(raw) : parseFloat(raw);
          const limit = f === 'lat' ? 90 : 180;
          if (v != null && isFinite(v) && Math.abs(v) <= limit) t[f] = v;
        } else {
          t[f] = inp.value;
        }
        state.analysisById = {};
        saveState(); render(); select(t.id);
      };
    });
    el.querySelectorAll('.ed-ico').forEach((b) => {
      b.onclick = () => { t.icon = b.dataset.ico; saveState(); render(); select(t.id); };
    });
    const mg = document.getElementById('ed-mgroup');
    if (mg) mg.onchange = async () => {
      if (!await applyGroupChange(t, mg)) return;
      saveState(); render(); select(t.id);
    };
    const mInp = document.getElementById('ed-mmovecoord');
    const doMove = () => {
      const ll = Parse.parseLatLng(mInp.value);
      if (!ll) { UI.toast('無法辨識座標，請確認格式（如 24.28,121.03 或 24°17′N 121°02′E）', 'warn'); return; }
      t.lat = ll.lat; t.lng = ll.lng; t.alt = 0;
      state.analysisById = {};
      mInp.value = '';
      saveState(); render(); select(t.id);
      if (mapView.focus) mapView.focus(t);
      Elevation.elevationAt(t).then((e) => {
        if (e != null) { t.alt = Math.round(e); saveState(); render(); }
      }).catch(() => {});
    };
    document.getElementById('ed-mmovebtn').onclick = doMove;
    mInp.onkeydown = (e) => { if (e.key === 'Enter') doMove(); };
    document.getElementById('ed-mdel').onclick = async () => {
      if (!await UI.confirm('刪除標註', `確定刪除「${t.name}」？此動作無法復原。`, '刪除', true)) return;
      state.markers = state.markers.filter((m) => m.id !== t.id);
      delete state.analysisById[t.id];
      state.selectedId = null;
      saveState();
      mapView.clearPath();
      render();
      UI.toast(`已刪除「${t.name}」`, 'ok');
    };
  }

  // ---- 群組過濾器 --------------------------------------------------------
  function renderGroupFilter() {
    const el = document.getElementById('group-filter');
    if (!el || !global.Groups) return;
    const counts = new Map();
    allTargets().forEach((t) => {
      const id = Groups.groupIdOf(t);
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    const hidden = state.settings.hiddenGroups || [];
    const rows = Groups.all()
      .filter((g) => counts.has(g.id))
      .map((g) => {
        const off = hidden.indexOf(g.id) >= 0;
        return `<button class="gf${off ? ' gf-off' : ''}" data-g="${g.id}" ` +
          `title="${off ? '點一下顯示' : '點一下隱藏'}「${g.name}」">` +
          `<i style="background:${g.color}"></i>${g.name}<b>${counts.get(g.id)}</b></button>`;
      });
    el.innerHTML = rows.join('') ||
      '<span class="gf-empty">尚無資料</span>';
    el.querySelectorAll('.gf').forEach((b) => {
      b.onclick = () => toggleGroup(b.dataset.g);
    });
  }

  function toggleGroup(id) {
    const h = state.settings.hiddenGroups || (state.settings.hiddenGroups = []);
    const i = h.indexOf(id);
    if (i >= 0) h.splice(i, 1); else h.push(id);
    // 選取中的目標若被藏起來，一併取消選取，免得面板還停在看不見的東西上
    const sel = findEntity(state.selectedId);
    if (sel && Groups.isHidden(sel, h)) {
      state.selectedId = null;
      mapView.clearPath();
      const info = document.getElementById('los-status');
      if (info) info.textContent = '選一個站臺開始…';
    }
    saveState();
    render();
  }

  // 依無線電視距畫各站臺涵蓋圈（假設對方天線高 RX_H 公尺）
  const RX_H = 10;
  function updateCoverage() {
    if (!mapView.setCoverage) return;
    if (!state.settings.showCoverage) { mapView.setCoverage([]); return; }
    const circles = state.stations.map((st) => ({
      lat: st.lat, lng: st.lng,
      radiusM: (Geo.radioHorizonKm(Geo.targetTopAlt(st, state.settings.tgtAntenna)) + Geo.radioHorizonKm(RX_H)) * 1000,
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
      const tgtTop = Geo.targetTopAlt(target, state.settings.tgtAntenna);
      // 顯示/對準用光學等效地球半徑，跟 AR 標籤與山稜線一致（分析仍用 4/3）
      const elev = Geo.elevationAngle(obsAlt, tgtTop, dist, state.settings.withCurvature, Elevation.K_OPTICAL);
      arView.lookAt(brg, Math.max(0, elev));
      if (aimEl) aimEl.innerHTML =
        `🎯 <b>${target.name}</b>：AR 中往 <b>方位 ${Math.round(brg)}° ${Geo.compass8(brg)}</b>、` +
        `仰角 ${elev.toFixed(1)}° 看　·　距離 ${Geo.fmtDistance(dist)}`;
    } else if (aimEl) {
      aimEl.innerHTML = '';
    }
    if (mapView.setTargetLine) mapView.setTargetLine(target && target.type !== 'me' ? state.me : null, target);
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
        tgtTopAlt: Geo.usesTrueAlt(target) ? Geo.targetTopAlt(target) : null,
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
                  + Geo.radioHorizonKm(Geo.targetTopAlt(target, state.settings.tgtAntenna), state.settings.k);
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
        topAlt: Geo.usesTrueAlt(station) ? Geo.targetTopAlt(station) : null,
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

  // ---- 山體輪廓（天際線） ------------------------------------------------
  // 沿著我的位置四周取地形，算出每個方位的稜線仰角，AR 就能把山形畫出來。
  let computingSky = false;
  async function computeSkyline() {
    if (computingSky) return;
    computingSky = true;
    const btn = document.getElementById('btn-skyline');
    const el = document.getElementById('skyline-status');
    if (btn) btn.disabled = true;
    try {
      let retrying = '';
      const sl = await Elevation.computeSkyline(state.me, {
        eyeHeight: state.me.antenna || 2,
        onProgress: (done, total) => {
          if (el) el.textContent = `⏳ 取地形中… ${Math.round((done / total) * 100)}%${retrying}`;
        },
        onRetry: (n, waitMs, status) => {
          retrying = status === 429
            ? `（服務忙碌，${Math.round(waitMs / 1000)} 秒後自動重試 ${n}）`
            : `（連線不順，重試 ${n}）`;
          if (el) el.textContent = `⏳ 取地形中…${retrying}`;
        },
      });
      state.skyline = sl;
      saveState();          // 存起來，下次開 App 不必再跟高程服務要一次
      const peaks = Elevation.skylinePeaks(sl.points);
      const partial = sl.coverage < 0.999;
      if (el) el.innerHTML = partial
        ? `<span class="warn">◐ 已畫出部分輪廓（取到 ${Math.round(sl.coverage * 100)}% 方位、` +
          `${peaks.length} 座山頭）。稍後再按一次可補齊剩下的。</span>`
        : `<span class="ok">✓ 已畫出山體輪廓（${sl.points.length} 個方位、` +
          `找到 ${peaks.length} 座山頭）</span>`;
      showARTab();
      arView.render(state);
    } catch (err) {
      const rate = /429|過於頻繁/.test(err.message);
      if (el) el.innerHTML = `<span class="warn">⚠️ ${err.message}${rate ? '' : '（需連線 open-meteo.com）'}</span>`;
    }
    if (btn) btn.disabled = false;
    computingSky = false;
  }

  function clearSkyline() {
    state.skyline = null;
    saveState();
    const el = document.getElementById('skyline-status');
    if (el) el.textContent = '';
    arView.render(state);
  }

  // ---- 一鍵分析全部站臺 --------------------------------------------------
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
          tgtTopAlt: Geo.usesTrueAlt(st) ? Geo.targetTopAlt(st) : null,
          freqMHz: st.freqMHz || state.settings.freqMHz,
          k: state.settings.k,
        });
      } catch (err) { failed++; }
      done++;
      renderPanel();
    }
    prog.textContent = failed
      ? `完成，但 ${failed} 個站臺無法取得高程（需連線 open-meteo.com）`
      : `✓ 已分析 ${done} 個站臺，依路徑品質排序`;
    analyzing = false;
  }

  // ---- 資訊面板 ----------------------------------------------------------
  function renderPanel() {
    const listEl = document.getElementById('target-list');
    const hidden = state.settings.hiddenGroups || [];
    const visible = global.Groups ? Groups.visible(allTargets(), hidden) : allTargets();

    // 找出最佳可通站臺（可通且餘裕最大）
    let best = null, bestM = -Infinity;
    state.stations.forEach((t) => {
      const a = state.analysisById[t.id];
      if (a && a.losClear) { const m = linkMargin(a); if (m > bestM) { bestM = m; best = t.id; } }
    });

    // 群組內：站臺依路徑品質排序（已分析者），山峰/標註依距離
    const sortInGroup = (a, b) => {
      if (a.type === 'station' && b.type === 'station') return rankScore(b) - rankScore(a);
      if (a.type === 'station') return -1;
      if (b.type === 'station') return 1;
      return Geo.distance(state.me, a) - Geo.distance(state.me, b);
    };

    const rowHtml = (t) => {
      const dist = Geo.distance(state.me, t);
      const brg = Geo.bearing(state.me, t);
      const a = state.analysisById[t.id];
      const badge = a ? (a.clear ? '<b class="b-ok">通</b>' : a.losClear ? '<b class="b-marg">繞</b>' : '<b class="b-bad">擋</b>') : '';
      const star = t.id === best ? '<span class="star" title="最佳可通站臺">⭐</span>' : '';
      const m = a ? linkMargin(a) : null;
      const marginTxt = m != null ? ` · 餘裕 ${m >= 0 ? '+' : ''}${m.toFixed(0)}dB` : '';
      const sel = t.id === state.selectedId ? ' sel' : '';
      const ico = t.type === 'station' ? '📡' : t.type === 'marker' ? (t.icon || '📌') : '⛰️';
      const customCls = t.custom ? ' tgt-custom' : '';
      const customBadge = t.custom ? '<b class="b-custom">自訂</b>' : '';
      const sub = t.type === 'marker'
        ? `${Geo.fmtDistance(dist)} · ${Math.round(brg)}° ${Geo.compass8(brg)}${t.note ? ' · ' + t.note : ''}`
        : `${Geo.fmtDistance(dist)} · ${Math.round(brg)}° ${Geo.compass8(brg)} · ` +
          `${Math.round(Geo.targetTopAlt(t, state.settings.tgtAntenna))}m${Geo.usesTrueAlt(t) ? '✎' : ''}${marginTxt}`;
      return `<li class="tgt${sel}${customCls}" data-id="${t.id}">` +
        `<span class="t-ico">${ico}</span>` +
        `<span class="t-main"><b>${t.name}</b> ${badge}${star}${customBadge}` +
        `<small>${sub}</small></span></li>`;
    };

    const listHtml = !global.Groups
      ? visible.slice().sort(sortInGroup).map(rowHtml).join('')
      : Groups.partition(visible).map(({ group, items }) =>
        `<li class="tgt-group"><i style="background:${group.color}"></i>${group.name}` +
        `<b>${items.length}</b></li>` +
        items.slice().sort(sortInGroup).map(rowHtml).join('')
      ).join('');
    // 內容沒變就不重建：手指按著某一列時若整份清單被換新，
    // 那一列的觸控事件會落在已脫離畫面的元素上，點選就失效了。
    if (listEl._html !== listHtml) { listEl.innerHTML = listHtml; listEl._html = listHtml; }


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
    chk('opt-constel', !!state.settings.showConstellations);
    set('opt-clickadds', state.settings.mapClickAdds || 'station');
    set('opt-decl', state.settings.declination != null ? state.settings.declination : -4.5);
    set('opt-hfov', state.settings.hfov || 70);
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

  // 衛星追蹤：TLE + SGP4 本地傳播（js/sats.js + vendor/satellite）。
  // 勾選的衛星在啟用時抓一次 TLE（快取 12 小時），之後每 5 秒在本地算
  // 方位/仰角 —— 不管勾幾顆都不需要對每顆衛星輪詢網路。
  // ISS 的 TLE 抓不到時退回 wheretheiss 即時 API（僅此一顆有此備援）。
  let satTimer = null, satJustOn = false;
  let satWasUp = {};          // id -> 上一刻是否在地平線上（升起偵測）
  let satPassCache = {};      // id -> { at, me:{lat,lng}, pass }
  let satPrev = null, satPred = null, satFallbackBusy = false;   // ISS 備援用

  function selectedSatIds() {
    const ids = (state.settings.sats && state.settings.sats.length) ? state.settings.sats : ['iss'];
    return global.Sats ? ids.filter((id) => Sats.entryOf(id)) : ['iss'];
  }

  const passHHMM = (t) => new Date(t).toTimeString().slice(0, 5);
  function passRel(start, now) {
    const mins = Math.round((start - now) / 60000);
    return mins <= 1 ? '即將升起' : mins < 90 ? `約 ${mins} 分鐘後` : `約 ${(mins / 60).toFixed(1)} 小時後`;
  }

  /** 勾選衛星中最快的下一次過境（每顆快取 30 分鐘） */
  function soonestPass(ids, now) {
    let best = null;
    for (const id of ids) {
      const c = satPassCache[id];
      const fresh = c && (now - c.at) < 30 * 60000 && c.pass && c.pass.end > now &&
        Geo.distance(c.me, state.me) < 50000;
      if (!fresh) {
        satPassCache[id] = {
          at: now, me: { lat: state.me.lat, lng: state.me.lng },
          pass: Sats.nextPass(id, state.me, { hours: 24, minEl: 10, from: now }),
        };
      }
      const p = satPassCache[id].pass;
      if (p && p.start > now && (!best || p.start < best.pass.start)) {
        best = { id, name: (Sats.entryOf(id) || {}).name || id, pass: p };
      }
    }
    return best;
  }

  function satTick() {
    if (!state.settings.showSat) return;
    const ids = selectedSatIds();
    const withTle = global.Sats ? ids.filter((id) => Sats.hasTle(id)) : [];
    const now = Date.now();

    const pos = global.Sats ? Sats.positions(withTle, state.me, new Date(now)) : [];
    state.satellites = pos.map((p) => ({
      id: 'sat-' + p.id, satId: p.id, name: '🛰 ' + p.short, fullName: p.name, type: 'sat',
      az: p.az, alt: p.alt, rangeKm: p.rangeKm, subLat: p.subLat, subLng: p.subLng,
      orbit: p.orbit, sunlit: p.sunlit, nakedEye: p.nakedEye,
    }));

    // ISS 備援：有勾但 TLE 抓不到
    if (ids.indexOf('iss') >= 0 && (!global.Sats || !Sats.hasTle('iss'))) fetchISSFallback();

    // 升起偵測（每顆獨立）
    state.satellites.forEach((sx) => {
      if (sx.orbit !== 'GEO' && sx.alt >= 0 && satWasUp[sx.satId] === false && global.UI) {
        UI.toast(`🛰 ${sx.fullName} 升起了！`, 'ok', 5000);
      }
      satWasUp[sx.satId] = sx.alt >= 0;
    });

    const geo = state.satellites.filter((sx) => sx.orbit === 'GEO');
    const leoUp = state.satellites.filter((sx) => sx.orbit !== 'GEO' && sx.alt >= 0)
      .sort((a, b) => b.alt - a.alt);
    const geoUp = geo.filter((sx) => sx.alt >= 0);
    const leoIds = withTle.filter((id) => !state.satellites.some((sx) => sx.satId === id && sx.orbit === 'GEO'));
    const parts = [];
    if (leoUp.length) {
      parts.push('🛰 低軌在地平線上：' + leoUp.map((sx) =>
        `${sx.fullName} 仰角${Math.round(sx.alt)}° ${Geo.compass8(sx.az)}` +
        (sx.nakedEye ? '（✨肉眼可見）' : sx.sunlit === false ? '（地影中，肉眼看不到）' : '')).join('、'));
    } else if (leoIds.length) {
      const nx = soonestPass(leoIds, now);
      parts.push(nx
        ? `🛰 低軌 ${leoIds.length} 顆都在地平線下；最快過境：${nx.name} 約 ${passHHMM(nx.pass.start)}` +
          `（${passRel(nx.pass.start, now)}，最高仰角 ${Math.round(nx.pass.maxEl)}°、方位 ${Math.round(nx.pass.maxAz)}° ${Geo.compass8(nx.pass.maxAz)}` +
          (nx.pass.visible ? '，✨肉眼可見' : nx.pass.sunlit === false ? '，屆時在地影中、肉眼看不到' : nx.pass.dark === false ? '，屆時天還亮、肉眼看不到' : '') + '）'
        : `🛰 低軌 ${leoIds.length} 顆 24 小時內無仰角 10° 以上的過境`);
    }
    if (geoUp.length) {
      parts.push('📡 同步衛星（固定不動）：' + geoUp.map((sx) =>
        `${sx.fullName} 方位${Math.round(sx.az)}° ${Geo.compass8(sx.az)}、仰角${Math.round(sx.alt)}°`).join('、'));
    }
    if (parts.length) setSkyHint(parts.join('　'));
    const best = leoUp[0] || geoUp[0];
    if (satJustOn && best) { showARTab(); if (arView) arView.lookAt(best.az, Math.max(0, best.alt)); }
    satJustOn = false;

    if (mapView.setSatellites) {
      mapView.setSatellites(state.satellites.map((sx) => ({
        id: sx.satId, name: (sx.fullName || sx.name).replace('🛰 ', ''), lat: sx.subLat, lng: sx.subLng, alt: sx.alt,
      })));
    }
    if (arView) arView.render(state);
  }

  // ---- ISS 備援（wheretheiss 即時 API + 圓軌道近似過境預測）--------------
  function nextPassText(now) {
    if (!satPred) return '';
    const upcoming = satPred.passes.filter((x) => x.end > now);
    const p = upcoming.find((x) => x.maxEl >= 10) || upcoming[0];
    if (!p) return '；未來 12 小時內無過境';
    return `；下次過境約 ${passHHMM(p.start)}（${passRel(p.start, now)}，最高仰角 ${Math.round(p.maxEl)}°、方位 ${Math.round(p.maxAz)}° ${Geo.compass8(p.maxAz)}）`;
  }

  async function fetchISSFallback() {
    if (satFallbackBusy) return;
    satFallbackBusy = true;
    try {
      const r = await fetch('https://api.wheretheiss.at/v1/satellites/25544');
      if (!r.ok) throw new Error('ISS API ' + r.status);
      const j = await r.json();
      const la = Sky.lookAngles(state.me, { lat: j.latitude, lng: j.longitude, altKm: j.altitude });
      const entry = {
        id: 'sat-iss', satId: 'iss', name: '🛰 ISS', fullName: 'ISS 國際太空站', type: 'sat',
        az: la.az, alt: la.el, rangeKm: la.rangeKm, subLat: j.latitude, subLng: j.longitude,
      };
      state.satellites = state.satellites.filter((sx) => sx.satId !== 'iss').concat([entry]);

      const cur = { lat: j.latitude, lng: j.longitude, altKm: j.altitude,
        t: j.timestamp ? j.timestamp * 1000 : Date.now() };
      const now = Date.now();
      const stale = !satPred || (now - satPred.at) > 30 * 60000 ||
        Geo.distance(satPred.me, state.me) > 50000 ||
        !satPred.passes.some((p) => p.end > now);
      if (satPrev && satPrev.t < cur.t && stale) {
        satPred = { at: now, me: { lat: state.me.lat, lng: state.me.lng },
          passes: Sky.predictPasses(satPrev, cur, state.me, { hours: 12 }) };
      }
      satPrev = cur;

      // 只有在沒有任何 TLE 衛星接手提示時，才由備援路徑寫提示
      const othersWithTle = global.Sats ? selectedSatIds().filter((id) => id !== 'iss' && Sats.hasTle(id)) : [];
      if (state.settings.showSat && !othersWithTle.length) {
        if (la.el >= 0) {
          setSkyHint(`🛰 ISS 在地平線上！往 方位 ${Math.round(la.az)}° ${Geo.compass8(la.az)}、仰角 ${la.el.toFixed(0)}° 看（距離 ${Math.round(la.rangeKm)} km）`);
          if (satJustOn || satWasUp.iss === false) {
            showARTab();
            if (arView) arView.lookAt(la.az, Math.max(0, la.el));
            if (satWasUp.iss === false && global.UI) UI.toast('🛰 ISS 升起了！AR 已轉向它', 'ok', 5000);
            satJustOn = false;
          }
        } else {
          setSkyHint(`🛰 ISS 目前在地平線下（方位 ${Math.round(la.az)}° ${Geo.compass8(la.az)}、仰角 ${la.el.toFixed(0)}°）${nextPassText(now)}`);
          satJustOn = false;
        }
      }
      satWasUp.iss = la.el >= 0;
      if (mapView.setSatellites) {
        mapView.setSatellites(state.satellites.map((sx) => ({
          id: sx.satId, name: (sx.fullName || sx.name).replace('🛰 ', ''), lat: sx.subLat, lng: sx.subLng, alt: sx.alt,
        })));
      }
    } catch (_) {
      if (state.settings.showSat && !state.satellites.length) {
        setSkyHint('🛰 無法取得衛星軌道資料（網路或服務暫時擋住），稍後會自動再試');
      }
    }
    satFallbackBusy = false;
    if (arView) arView.render(state);
  }

  async function satStart() {
    satJustOn = true;
    setSkyHint('🛰 取得衛星軌道資料中…');
    if (global.Sats && Sats.available) {
      await Sats.ensureTles(selectedSatIds(), { onStatus: () => renderSatList() });
      renderSatList();
    }
    satTick();
    // 位置是本地算的，5 秒一拍很便宜；ISS 備援自己有 in-flight 防護
    satTimer = setInterval(() => { if (!document.hidden) satTick(); }, 5000);
  }

  function satTicker() {
    if (state.settings.showSat && !satTimer) satStart();
    if (!state.settings.showSat && satTimer) {
      clearInterval(satTimer); satTimer = null; state.satellites = [];
      if (mapView.setSatellites) mapView.setSatellites([]);
      if (arView) arView.render(state);
    }
  }

  /** 勾選清單變更（衛星開著時重新抓缺的 TLE 並立即重算） */
  function satSelectionChanged() {
    saveState();
    renderSatList();
    satPassCache = {};
    if (state.settings.showSat && global.Sats && Sats.available) {
      Sats.ensureTles(selectedSatIds(), { onStatus: () => renderSatList() })
        .then(() => { renderSatList(); satTick(); });
    }
  }

  // ---- 衛星清單 UI -------------------------------------------------------
  function renderSatList() {
    const el = document.getElementById('sat-list');
    if (!el || !global.Sats) return;
    const sel = new Set(selectedSatIds());
    const customs = [...sel].filter((id) => /^norad-/.test(id));
    const rows = Sats.CATALOG.concat(customs.map((id) => Sats.entryOf(id))).map((e) => {
      const st = Sats.getStatus(e.id);
      const tle = Sats.getTle(e.id);
      const badge = st.state === 'loading' ? '<i class="sat-st">⏳</i>'
        : st.state === 'error' ? '<i class="sat-st warn" title="抓不到軌道資料">✗</i>'
        : tle ? `<i class="sat-st ok" title="軌道資料 ${Math.round((Date.now() - tle.at) / 3600000)} 小時前">✓</i>` : '';
      return `<label class="sat-row"><input type="checkbox" data-sat="${e.id}"${sel.has(e.id) ? ' checked' : ''}>` +
        `<span class="sat-name">${e.name}</span><b class="sat-grp">${e.group}</b>${badge}</label>`;
    });
    el.innerHTML = rows.join('');
    el.querySelectorAll('input[data-sat]').forEach((inp) => {
      inp.onchange = () => {
        const id = inp.dataset.sat;
        let ids = selectedSatIds().filter((x) => x !== id);
        if (inp.checked) ids.push(id);
        state.settings.sats = ids;
        satSelectionChanged();
      };
    });
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
    document.getElementById('opt-constel').onchange = (e) => {
      state.settings.showConstellations = e.target.checked;
      saveState();
      if (e.target.checked && !state.settings.showSky) {
        // 星座畫在天文層上，天空沒開就看不到 —— 直接幫他開起來
        state.settings.showSky = true;
        const sky = document.getElementById('opt-sky');
        if (sky) sky.checked = true;
        skyTicker();
        showARTab();
        faceBestSky();
      }
      render();
    };

    // AR 校正：磁偏角 / 視野
    document.getElementById('opt-decl').onchange = (e) => {
      const v = parseFloat(e.target.value);
      state.settings.declination = isFinite(v) ? v : -4.5;
      saveState();
    };
    document.getElementById('opt-hfov').onchange = (e) => {
      const v = parseFloat(e.target.value);
      if (isFinite(v)) { arView.setFov(v); state.settings.hfov = Math.round(arView.hfov); e.target.value = state.settings.hfov; saveState(); }
    };

    // 山體輪廓
    document.getElementById('btn-skyline').onclick = () => computeSkyline();
    document.getElementById('btn-skyline-clear').onclick = () => clearSkyline();
    document.getElementById('opt-sat').onchange = (e) => {
      state.settings.showSat = e.target.checked;
      saveState(); satTicker(); render();
      if (e.target.checked) { showARTab(); }
      else setSkyHint('');
    };
    // 衛星清單
    document.getElementById('btn-sat-tw').onclick = () => {
      state.settings.sats = ['iss', ...Sats.TAIWAN_IDS];
      satSelectionChanged();
      UI.toast(`已加入台灣在軌衛星 ${Sats.TAIWAN_IDS.length} 顆（AR 只會顯示當下在地平線上的）`, 'ok', 4500);
    };
    document.getElementById('btn-sat-geo').onclick = () => {
      const ids = selectedSatIds();
      Sats.GEO_IDS.forEach((id) => { if (ids.indexOf(id) < 0) ids.push(id); });
      state.settings.sats = ids;
      satSelectionChanged();
      UI.toast('已加入同步衛星（ST-2、向日葵9號、Inmarsat）：固定在天空同一位置，24 小時都看得到方向', 'ok', 5000);
    };
    document.getElementById('btn-sat-iss').onclick = () => {
      state.settings.sats = ['iss'];
      satSelectionChanged();
    };
    const satAdd = () => {
      const inp = document.getElementById('opt-sat-norad');
      const n = parseInt(String(inp.value).replace(/\D/g, ''), 10);
      if (!n) { UI.toast('請輸入 NORAD 編目編號（純數字，如 25544）', 'warn'); return; }
      const id = 'norad-' + n;
      const ids = selectedSatIds();
      if (ids.indexOf(id) < 0) ids.push(id);
      state.settings.sats = ids;
      inp.value = '';
      satSelectionChanged();
    };
    document.getElementById('btn-sat-add').onclick = satAdd;
    document.getElementById('opt-sat-norad').onkeydown = (e) => { if (e.key === 'Enter') satAdd(); };
    document.getElementById('opt-clickadds').onchange = (e) => {
      state.settings.mapClickAdds = e.target.value;
      saveState();
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
      const data = JSON.stringify({
        me: state.me, stations: state.stations, markers: state.markers,
        groups: global.Groups ? Groups.all() : undefined, settings: state.settings,
      }, null, 2);
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
          const nMk = (d.markers || []).length;
          if ((!d.stations || !d.stations.length) && !nMk) throw new Error('找不到可匯入的站臺或標註');
          // 檔案自帶群組定義（顏色/名稱）先註冊，資料才會用對顏色
          if (global.Groups && Array.isArray(d.groups)) {
            d.groups.forEach((g) => g && g.id && Groups.register(g.id, g.name, g.color));
          }
          if (d.mode === 'replace') {
            if (d.me) Object.assign(state.me, d.me);
            state.stations = d.stations || [];
            state.markers = d.markers || [];
            if (d.settings) Object.assign(state.settings, d.settings);
          } else {
            state.stations = state.stations.concat(d.stations || []); // CSV/GPX 追加
            if (nMk) state.markers = state.markers.concat(d.markers);
          }
          state.analysisById = {};
          state.selectedId = null;
          state.skyline = null;
          learnGroups();
          saveState();
          syncControls();
          mapView.clearPath();
          render();
          if (mapView.focus) mapView.focus(state.me);
          UI.toast(`已匯入 ${(d.stations || []).length} 個站臺` +
            (nMk ? `、${nMk} 個標註` : '') +
            `（${d.mode === 'replace' ? '取代' : '追加'}）`, 'ok');
        } catch (err) { UI.alert('匯入失敗', err.message); }
      };
      reader.readAsText(file);
      fileInput.value = '';
    };
    document.getElementById('btn-reset').onclick = () => {
      if (!confirm('還原為預設站臺資料？（會清除你的變更）')) return;
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
      state.me = { ...S.me };
      state.stations = S.stations.map((s) => ({ ...s }));
      state.peaks = S.peaks.map((p) => ({ ...p }));
      state.markers = (S.markers || []).map((m) => ({ ...m }));
      state.analysisById = {};
      state.selectedId = null;
      state.skyline = null;
      state.settings.hiddenGroups = [];
      syncControls();
      mapView.clearPath();
      render();
    };

    document.getElementById('btn-analyze-all').onclick = () => analyzeAll();

    // 清單點選：委派到外層、用 touchend 直接觸發（iOS 獨立模式的合成 click 不可靠）
    const tgtOf = (e) => (e.target && e.target.closest ? e.target.closest('.tgt') : null);
    UI.bindTap(document.getElementById('target-list'), (e) => {
      const li = tgtOf(e);
      if (li && li.dataset.id) select(li.dataset.id);
    }, (e) => !!tgtOf(e));

    // 萬用座標：貼上任何格式套用到我的位置（立即反應，高程在背景補上）
    const applyPaste = () => {
      const inp = document.getElementById('paste-coord');
      const ll = Parse.parseLatLng(inp.value);
      if (!ll) { UI.toast('無法辨識座標格式，請再確認', 'warn'); return; }
      inp.value = '';                       // 先清空，立刻給回饋
      setMyLocation(ll.lat, ll.lng);
    };
    document.getElementById('btn-paste').onclick = applyPaste;
    document.getElementById('paste-coord').onkeydown = (e) => { if (e.key === 'Enter') applyPaste(); };

    // 用座標新增一個標點/站臺（不動我的位置）
    document.getElementById('btn-addstation').onclick = () => {
      const inp = document.getElementById('paste-coord');
      const ll = Parse.parseLatLng(inp.value);
      if (!ll) { UI.toast('請先在上面貼上座標（任何格式），再按「新增站臺」', 'warn'); return; }
      inp.value = '';
      addStation(ll.lat, ll.lng);
    };

    // 用座標新增一個自訂標註（純標記，不是通聯對象）
    document.getElementById('btn-addmarker').onclick = () => {
      const inp = document.getElementById('paste-coord');
      const ll = Parse.parseLatLng(inp.value);
      if (!ll) { UI.toast('請先在上面貼上座標（任何格式），再按「新增標註」', 'warn'); return; }
      inp.value = '';
      addMarker(ll.lat, ll.lng);
    };

    document.getElementById('btn-locate').onclick = () => {
      if (!navigator.geolocation) return UI.toast('此裝置不支援定位', 'warn');
      navigator.geolocation.getCurrentPosition(
        (pos) => setMyLocation(pos.coords.latitude, pos.coords.longitude),
        () => UI.toast('定位失敗。請確認已允許此網站取得位置（iOS：設定 → 隱私權 → 定位服務 → Safari）', 'warn', 5000)
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
        if (b.dataset.view === 'view-map') setTimeout(() => mapView.onShown(state.me), 60);
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

  /**
   * 新增站臺。不再跳出對話框問名字 —— 直接用預設名建立、選取並把游標
   * 放到編輯器的名稱欄，少一次打斷（iOS 獨立模式下 prompt 還可能無效）。
   */
  function addStation(lat, lng) {
    const st = {
      id: `st-${Date.now()}`, type: 'station', name: `站臺 ${state.stations.length + 1}`,
      lat, lng, alt: 0, antenna: 6, freqMHz: state.settings.freqMHz, custom: true,
    };
    state.stations.push(st);
    saveState();
    render();
    select(st.id);
    if (mapView.focus) mapView.focus(st);
    focusEditorName();
    UI.toast(`已新增「${st.name}」，可直接改名`, 'ok');
    Elevation.elevationAt(st).then((e) => {
      if (e != null) { st.alt = Math.round(e); saveState(); render(); if (state.selectedId === st.id) select(st.id); }
    }).catch(() => {});
    return st;
  }

  /** 新增一個自訂位置標註；高程在背景補上 */
  function addMarker(lat, lng, presetName) {
    const mk = {
      id: `mk-${Date.now()}`, type: 'marker', group: 'mark', icon: '📌',
      name: presetName || `標註 ${state.markers.length + 1}`,
      lat, lng, alt: 0, note: '', custom: true,
    };
    state.markers.push(mk);
    saveState();
    render();
    select(mk.id);
    if (mapView.focus) mapView.focus(mk);
    focusEditorName();
    UI.toast(`已新增「${mk.name}」，可直接改名`, 'ok');
    Elevation.elevationAt(mk).then((e) => {
      if (e != null) { mk.alt = Math.round(e); saveState(); render(); }
    }).catch(() => {});
    return mk;
  }

  // ---- 地圖回呼 ----------------------------------------------------------
  const handlers = {
    onSelect: (id) => select(id),
    // 羅盤方位 → 地圖（我的位置扇形、方向跟隨旋轉）
    onHeading: (h) => { if (mapView.setHeading) mapView.setHeading(h); },
    onSensorOff: () => { if (mapView.setFollow) mapView.setFollow(false); },
    // 地圖上的指北針：北朝上 ⇄ 方向跟隨（需要羅盤，沒開就順便開）
    onCompassTap: async () => {
      if (mapView.follow) { mapView.setFollow(false); UI.toast('北朝上', '', 1800); return; }
      if (!arView.usingSensor) {
        await arView.enableSensor();
        arView._syncControlState();
        if (!arView.usingSensor) return;   // 權限被拒，enableSensor 已提示原因
      }
      mapView.setFollow(true);
      UI.toast('🧭 方向跟隨：地圖隨手機朝向旋轉（拖動地圖可離開）', 'ok', 3200);
    },
    onFollowExit: () => UI.toast('已離開方向跟隨，回到北朝上', '', 2200),
    onFov: (v) => {
      state.settings.hfov = Math.round(v);
      saveState();
      const el = document.getElementById('opt-hfov');
      if (el) el.value = state.settings.hfov;
    },
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
      // 點地圖要新增什麼，由面板的「地圖點擊新增」決定
      if (state.settings.mapClickAdds === 'marker') { addMarker(lat, lng); return; }
      addStation(lat, lng);
    },
  };

  function init() {
    loadState();  // 還原上次的站臺/設定（若有）
    // 地圖若載入失敗（例如缺 Leaflet），不應中斷 AR 視角與面板。
    try {
      if (global.L) {
        global.L.Icon.Default.imagePath = 'vendor/leaflet/images/';
        // 一開啟地圖就落在「我的位置」附近，而不是整個台灣的遠景
        mapView = new MapView('map', handlers, { center: state.me, zoom: 11 });
      } else {
        throw new Error('Leaflet 未載入');
      }
    } catch (err) {
      mapView = { render() {}, drawPath() {}, clearPath() {}, setCoverage() {}, setViewshed() {}, setSatellite() {},
        setSatellites() {}, setHeading() {}, setFollow() {}, setTargetLine() {}, follow: false,
        focus() {}, onShown() {}, map: { invalidateSize() {} } };
      const el = document.getElementById('map');
      if (el) el.innerHTML = `<div class="map-fallback">⚠️ 地圖元件未載入（${err.message}）<br>AR 視角與路徑分析仍可使用。</div>`;
    }
    arView = new ARView('view-ar', handlers);
    renderSatList();
    if (state.settings.hfov && state.settings.hfov !== 70) arView.setFov(state.settings.hfov);
    bindControls();
    render();
    // 沿用上次存下來的輪廓時要講清楚，免得以為是這次算的
    if (state.skyline) {
      const el = document.getElementById('skyline-status');
      if (el) el.innerHTML = `<span class="ok">✓ 已沿用上次算好的山體輪廓` +
        `（${state.skyline.points.length} 個方位）。位置有變或想重算就按「畫出輪廓」。</span>`;
    }
    // 預設選第一個站臺展示
    if (state.stations[0]) select(state.stations[0].id);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.App = { state, select, getArView: () => arView, getMapView: () => mapView, render };
})(typeof window !== 'undefined' ? window : globalThis);
