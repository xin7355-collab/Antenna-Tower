/*
 * map.js — 地圖視角 (Leaflet)
 * ------------------------------------------------------------------
 * 顯示我的位置、無線電站臺、參考山峰；
 * 支援拖曳我的位置、點選目標、點地圖新增站臺，
 * 並把「我 → 目標」的路徑畫出來，被地形擋住的路段染成紅色。
 *
 * 方向跟隨（像 Google 地圖）：用羅盤方位把整張地圖旋轉成「手機朝向朝上」。
 * Leaflet 本身不支援旋轉；現成外掛 leaflet-rotate 是 GPL-3.0，會讓整個 App
 * 受 GPL 約束，所以這裡自己做：把地圖容器放大到對角線長度、置中，再以
 * CSS 旋轉。旋轉時停用單指拖曳（地圖固定以我為中心，像導航模式），
 * 點擊換算經緯度時把旋轉轉回來；標籤反向旋轉以維持正立可讀。
 */
(function (global) {
  'use strict';

  const Geo = global.Geo;

  const ICONS = {
    me: '📍', station: '📡', peak: '⛰️', marker: '📌',
  };

  // 「我的位置」：藍點 + 手機朝向扇形（像 Google 地圖）。扇形角度由
  // setHeading 直接改 DOM，不重建 icon。
  function meIconHtml() {
    return `<div class="me-loc"><svg class="me-cone" viewBox="-40 -40 80 80" style="display:none">` +
      `<defs><radialGradient id="meConeG" cx="0" cy="0" r="40" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#2f6fff" stop-opacity=".55"/><stop offset="1" stop-color="#2f6fff" stop-opacity="0"/>` +
      `</radialGradient></defs><path d="M0 0 L-17 -36 A40 40 0 0 1 17 -36 Z" fill="url(#meConeG)"/></svg>` +
      `<i class="me-dot"></i></div>`;
  }

  function iconHtml(entity, selected) {
    const cls = `mk mk-${entity.type}${selected ? ' mk-sel' : ''}${entity.custom ? ' mk-custom' : ''}`;
    const ico = (entity.type === 'marker' && entity.icon) ? entity.icon : (ICONS[entity.type] || '•');
    const gc = (global.Groups && entity.type !== 'me') ? Groups.colorOf(entity) : null;
    const style = gc ? ` style="--gc:${gc}"` : '';
    return `<div class="${cls}"${style}><span class="mk-ico">${ico}</span>` +
      `<span class="mk-lbl">${entity.name}</span></div>`;
  }

  function divIcon(L, entity, selected) {
    if (entity.type === 'me') {
      return L.divIcon({ className: 'mk-wrap', html: meIconHtml(), iconSize: null, iconAnchor: [0, 0] });
    }
    const cls = `mk mk-${entity.type}${selected ? ' mk-sel' : ''}${entity.custom ? ' mk-custom' : ''}`;
    // 自訂標註可自選圖示；其餘依 type 用固定圖示
    const ico = (entity.type === 'marker' && entity.icon) ? entity.icon : (ICONS[entity.type] || '•');
    // 群組色以標籤左側色條呈現（「我的位置」不分群組）
    const gc = (global.Groups && entity.type !== 'me') ? Groups.colorOf(entity) : null;
    const style = gc ? ` style="--gc:${gc}"` : '';
    return L.divIcon({
      className: 'mk-wrap',
      html: `<div class="${cls}"${style}><span class="mk-ico">${ico}</span>` +
            `<span class="mk-lbl">${entity.name}</span></div>`,
      iconSize: null,
      iconAnchor: [0, 0],
    });
  }

  class MapView {
    constructor(elId, handlers = {}, opts = {}) {
      this.h = handlers;
      this.markers = new Map();
      this.pathLayer = null;
      this.coverageLayer = null;
      this.viewshedLayer = null;
      // 地圖是在分頁隱藏（尺寸 0）時建立的，此時任何 fitBounds 都算不準。
      // 等第一次真的顯示出來，再定位到我的位置。
      this._needsInitialView = true;
      this._pendingFit = null;
      this.initialZoom = opts.zoom != null ? opts.zoom : 11;

      const L = global.L;
      this.L = L;
      const c = opts.center || { lat: 23.5, lng: 121.0 };
      // 內建的縮放鈕與版權列放在地圖容器裡，旋轉時會跟著轉歪；
      // 改用 #view-map 上的疊加控制（不旋轉），版權聲明也一併移出去。
      this.map = L.map(elId, { zoomControl: false, attributionControl: false })
        .setView([c.lat, c.lng], this.initialZoom);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(this.map);

      this.$el = document.getElementById(elId);
      this.$view = this.$el.parentElement;            // #view-map（不旋轉的外框）
      this.heading = null;                            // 最近一次羅盤方位（真北）
      this.follow = false;                            // 方向跟隨中
      this._me = null;
      this._hdPending = false;
      this._buildOverlay();
      this._patchClickForRotation();

      this.map.on('click', (e) => {
        if (this.h.onAddStation) this.h.onAddStation(e.latlng.lat, e.latlng.lng);
      });
      window.addEventListener('resize', () => { if (this.follow) this._layoutRotated(); });
    }

    // ---- 疊加控制（不隨地圖旋轉）--------------------------------------------
    _buildOverlay() {
      const ov = document.createElement('div');
      ov.className = 'map-ov';
      ov.innerHTML =
        `<button class="map-btn map-compass" title="方向跟隨：地圖隨手機朝向旋轉">` +
        `<svg viewBox="-20 -20 40 40"><g class="needle">` +
        `<path d="M0 -15 L5 0 L-5 0 Z" fill="#ff4d4d"/><path d="M0 15 L5 0 L-5 0 Z" fill="#e8ecf1"/></g>` +
        `<text y="-12" text-anchor="middle" font-size="7" fill="#fff" class="nlab"></text></svg></button>` +
        `<button class="map-btn map-me" title="回到我的位置">◎</button>` +
        `<button class="map-btn map-zin" title="放大">＋</button>` +
        `<button class="map-btn map-zout" title="縮小">－</button>`;
      this.$view.appendChild(ov);
      const at = document.createElement('div');
      at.className = 'map-attrib';
      at.innerHTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
      this.$view.appendChild(at);
      const hint = document.createElement('div');
      hint.className = 'map-follow-hint';
      hint.textContent = '方向跟隨中・拖動地圖可離開';
      this.$view.appendChild(hint);

      this.$compass = ov.querySelector('.map-compass');
      this.$needle = ov.querySelector('.needle');
      const tap = (el, fn) => (global.UI && UI.bindTap ? UI.bindTap(el, fn) : (el.onclick = fn));
      tap(this.$compass, () => { if (this.h.onCompassTap) this.h.onCompassTap(); });
      tap(ov.querySelector('.map-me'), () => { if (this._me) this.map.setView([this._me.lat, this._me.lng], Math.max(this.map.getZoom(), 13)); });
      tap(ov.querySelector('.map-zin'), () => this.map.zoomIn());
      tap(ov.querySelector('.map-zout'), () => this.map.zoomOut());

      // 方向跟隨時單指拖動 = 想自己看別處 → 離開跟隨、回到北朝上
      let sx = 0, sy = 0, tracking = false;
      const start = (x, y) => { if (this.follow) { sx = x; sy = y; tracking = true; } };
      const move = (x, y) => {
        if (!tracking || !this.follow) return;
        if (Math.hypot(x - sx, y - sy) > 18) {
          tracking = false;
          this.setFollow(false);
          if (this.h.onFollowExit) this.h.onFollowExit();
        }
      };
      this.$el.addEventListener('touchstart', (e) => { if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY); else tracking = false; }, { passive: true });
      this.$el.addEventListener('touchmove', (e) => { if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
      this.$el.addEventListener('touchend', () => { tracking = false; }, { passive: true });
      this.$el.addEventListener('mousedown', (e) => start(e.clientX, e.clientY));
      window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
      window.addEventListener('mouseup', () => { tracking = false; });
    }

    /**
     * 旋轉中點擊地圖時，Leaflet 會用「旋轉後的外接矩形」換算座標而算錯。
     * 這裡把點擊位置相對外框中心反向旋轉回地圖容器座標。
     */
    _patchClickForRotation() {
      const map = this.map, L = this.L;
      const orig = map.mouseEventToContainerPoint.bind(map);
      map.mouseEventToContainerPoint = (e) => {
        if (!this.follow || this.heading == null) return orig(e);
        const r = this.$view.getBoundingClientRect();
        const sx = e.clientX - (r.left + r.width / 2), sy = e.clientY - (r.top + r.height / 2);
        const th = this.heading * Math.PI / 180;
        const x = sx * Math.cos(th) - sy * Math.sin(th);
        const y = sx * Math.sin(th) + sy * Math.cos(th);
        const size = map.getSize();
        return L.point(size.x / 2 + x, size.y / 2 + y);
      };
    }

    /** 方向跟隨的版面：容器放大到對角線長度並置中，旋轉後四角才不會露白 */
    _layoutRotated() {
      const W = this.$view.clientWidth, H = this.$view.clientHeight;
      if (!W || !H) return;
      const D = Math.ceil(Math.hypot(W, H)) + 4;
      const st = this.$el.style;
      st.position = 'absolute';
      st.width = D + 'px'; st.height = D + 'px';
      st.left = ((W - D) / 2) + 'px'; st.top = ((H - D) / 2) + 'px';
      this.map.invalidateSize({ pan: false });
      if (this._me) this.map.setView([this._me.lat, this._me.lng], this.map.getZoom(), { animate: false });
      this._applyHeading();
    }

    /** 開關方向跟隨 */
    setFollow(on) {
      on = !!on;
      if (on === this.follow) return;
      this.follow = on;
      const map = this.map;
      this.$view.classList.toggle('map-rotated', on);
      if (on) {
        map.dragging.disable();
        // 縮放一律以中心（我的位置）為基準，地圖始終以我為中心
        map.options.touchZoom = 'center';
        map.options.scrollWheelZoom = 'center';
        map.options.doubleClickZoom = 'center';
        this._layoutRotated();
      } else {
        const st = this.$el.style;
        st.position = ''; st.width = ''; st.height = ''; st.left = ''; st.top = '';
        st.transform = '';
        this.$el.style.removeProperty('--mk-rot');
        map.options.touchZoom = true;
        map.options.scrollWheelZoom = true;
        map.options.doubleClickZoom = true;
        map.dragging.enable();
        map.invalidateSize({ pan: false });
        if (this._me) map.setView([this._me.lat, this._me.lng], map.getZoom(), { animate: false });
      }
      this._applyHeading();
    }

    /** 收到羅盤方位（真北，度）。同一幀內只套用一次。 */
    setHeading(deg) {
      if (deg == null || !isFinite(deg)) return;
      this.heading = ((deg % 360) + 360) % 360;
      if (this._hdPending) return;
      this._hdPending = true;
      const run = () => { this._hdPending = false; this._applyHeading(); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16);
    }

    _applyHeading() {
      const h = this.heading;
      // 地圖旋轉：手機朝向 h 轉到畫面正上方 → 整張圖逆時針轉 h
      if (this.follow && h != null) {
        this.$el.style.transform = `rotate(${-h}deg)`;
        this.$el.style.setProperty('--mk-rot', `${h}deg`);   // 標籤反轉回正立
      }
      // 指北針：指向畫面上的「北」
      if (this.$needle) {
        const r = this.follow && h != null ? -h : 0;
        this.$needle.setAttribute('transform', `rotate(${r})`);
      }
      if (this.$compass) this.$compass.classList.toggle('on', this.follow);
      // 我的位置扇形：指向手機朝向（地圖座標下）
      const meM = this.markers.get('me');
      const cone = meM && meM.getElement() && meM.getElement().querySelector('.me-cone');
      if (cone) {
        if (h == null) { cone.style.display = 'none'; }
        else { cone.style.display = 'block'; cone.style.transform = `translate(-50%,-50%) rotate(${h}deg)`; }
      }
    }

    /** 選取目標時立刻畫一條「我 → 目標」的方向虛線（地形剖面算好前就有方向感） */
    setTargetLine(me, target) {
      if (this.targetLine) { this.map.removeLayer(this.targetLine); this.targetLine = null; }
      if (!me || !target) return;
      const L = this.L;
      const pts = Geo.samplePath(me, target, 32).map((p) => [p.lat, p.lng]);
      const line = L.polyline(pts, { color: '#ffd36b', weight: 3, opacity: 0.95, dashArray: '8 7', interactive: false });
      const ring = L.circleMarker([target.lat, target.lng], {
        radius: 13, color: '#ffd36b', weight: 3, fill: false, interactive: false,
      });
      this.targetLine = L.layerGroup([line, ring]).addTo(this.map);
    }

    render(state) {
      const L = this.L;
      const hidden = (state.settings && state.settings.hiddenGroups) || [];
      const pins = [...state.stations, ...state.peaks, ...(state.markers || [])];
      const all = [state.me, ...(global.Groups ? Groups.visible(pins, hidden) : pins)];
      const seen = new Set();

      this._me = state.me;
      all.forEach((ent) => {
        seen.add(ent.id);
        const selected = ent.id === state.selectedId;
        const html = ent.type === 'me' ? 'me' : iconHtml(ent, selected);
        let m = this.markers.get(ent.id);
        if (!m) {
          // 不可拖曳：避免在地圖上滑動時誤拖站臺。移動位置請用定位/貼上座標/編輯移動。
          m = L.marker([ent.lat, ent.lng], {
            icon: divIcon(L, ent, selected),
            draggable: false,
            zIndexOffset: ent.type === 'me' ? 1000 : 0,
          }).addTo(this.map);
          m._html = html;
          if (ent.type !== 'me') {
            m.on('click', (e) => {
              L.DomEvent.stopPropagation(e);
              if (this.h.onSelect) this.h.onSelect(ent.id);
            });
          }
          this.markers.set(ent.id, m);
          if (ent.type === 'me') this._applyHeading();
        } else {
          m.setLatLng([ent.lat, ent.lng]);
          // 內容沒變就不換 icon：換 icon 會重建元素，手指按著時點擊會失效
          if (m._html !== html) { m.setIcon(divIcon(L, ent, selected)); m._html = html; }
        }
      });
      if (this.follow && this._me) {
        const c = this.map.getCenter();
        if (Math.abs(c.lat - this._me.lat) > 1e-6 || Math.abs(c.lng - this._me.lng) > 1e-6) {
          this.map.setView([this._me.lat, this._me.lng], this.map.getZoom(), { animate: false });
        }
      }

      // 移除已不存在的 marker
      for (const [id, m] of this.markers) {
        if (!seen.has(id)) { this.map.removeLayer(m); this.markers.delete(id); }
      }
    }

    /**
     * 畫出「我 → 目標」路徑；analysis 為 Elevation.analyzePath() 結果。
     */
    drawPath(me, target, profile, analysis) {
      this.clearPath();
      const L = this.L;
      const latlngs = profile.map((p) => [p.lat, p.lng]);

      // 底線（整段）
      const base = L.polyline(latlngs, { color: '#2f6fff', weight: 3, opacity: 0.9 });
      const layers = [base];

      // 被地形擋住的路段（clearance<0）染紅
      let run = [];
      analysis.samples.forEach((s, i) => {
        if (s.clearance < 0) {
          run.push([profile[i].lat, profile[i].lng]);
        } else if (run.length) {
          layers.push(L.polyline(run, { color: '#e23b3b', weight: 6, opacity: 0.95 }));
          run = [];
        }
      });
      if (run.length) layers.push(L.polyline(run, { color: '#e23b3b', weight: 6, opacity: 0.95 }));

      this.pathLayer = L.layerGroup(layers).addTo(this.map);
      this._fitOrDefer(L.latLngBounds(latlngs).pad(0.3));
    }

    /** 地圖還沒有實際尺寸時（分頁隱藏中）先記下來，顯示後再套用。 */
    _fitOrDefer(bounds) {
      if (this.map.getSize().x > 0) this.map.fitBounds(bounds);
      else this._pendingFit = bounds;
    }

    /**
     * 分頁切到地圖時呼叫：重算尺寸，並在「第一次顯示」時定位到我的位置。
     * 之後再進來就沿用使用者目前的視野，不會把他拉走。
     */
    onShown(me) {
      this.map.invalidateSize();
      if (this._needsInitialView) {
        this._needsInitialView = false;
        this._pendingFit = null;      // 初次進來以「我的位置」為準
        if (me) this.map.setView([me.lat, me.lng], this.initialZoom);
        return;
      }
      if (this._pendingFit) { this.map.fitBounds(this._pendingFit); this._pendingFit = null; }
    }

    clearPath() {
      if (this.pathLayer) { this.map.removeLayer(this.pathLayer); this.pathLayer = null; }
    }

    /**
     * 顯示涵蓋範圍圈。circles = [{lat, lng, radiusM, color}]；傳空陣列即清除。
     */
    setCoverage(circles) {
      if (this.coverageLayer) { this.map.removeLayer(this.coverageLayer); this.coverageLayer = null; }
      if (!circles || !circles.length) return;
      const L = this.L;
      const layers = circles.map((c) =>
        L.circle([c.lat, c.lng], {
          radius: c.radiusM,
          color: c.color || '#35d07f',
          weight: 1,
          fillColor: c.color || '#35d07f',
          fillOpacity: 0.08,
        })
      );
      this.coverageLayer = L.layerGroup(layers).addTo(this.map);
    }

    /**
     * 顯示多顆衛星當前地表位置（星下點）。傳空陣列或 null 即清除。
     * sats = [{id, name, lat, lng, alt(仰角deg)}]
     */
    setSatellites(sats) {
      if (!this.satMarkers) this.satMarkers = new Map();
      const want = new Set((sats || []).map((s) => s.id));
      for (const [id, m] of this.satMarkers) {
        if (!want.has(id)) { this.map.removeLayer(m); this.satMarkers.delete(id); }
      }
      const L = this.L;
      (sats || []).forEach((s) => {
        const html = `<div class="mk mk-sat"><span class="mk-ico">🛰</span>` +
          `<span class="mk-lbl">${s.name}${s.alt >= 0 ? '（地平線上）' : ''}</span></div>`;
        const icon = L.divIcon({ className: 'mk-wrap', html, iconAnchor: [0, 0] });
        let m = this.satMarkers.get(s.id);
        if (!m) {
          m = L.marker([s.lat, s.lng], { icon, interactive: false }).addTo(this.map);
          this.satMarkers.set(s.id, m);
        } else {
          m.setLatLng([s.lat, s.lng]);
          m.setIcon(icon);
        }
      });
    }

    /** 相容舊介面：單顆（ISS）。 */
    setSatellite(pos) {
      this.setSatellites(pos ? [{ id: 'iss', name: pos.name || 'ISS', lat: pos.lat, lng: pos.lng, alt: pos.alt }] : []);
    }

    /**
     * 顯示地形感知涵蓋多邊形。latlngs = [[lat,lng],...]；傳 null 即清除。
     */
    setViewshed(latlngs, color = '#f5b942') {
      if (this.viewshedLayer) { this.map.removeLayer(this.viewshedLayer); this.viewshedLayer = null; }
      if (!latlngs || latlngs.length < 3) return;
      const L = this.L;
      this.viewshedLayer = L.polygon(latlngs, {
        color, weight: 2, fillColor: color, fillOpacity: 0.18, dashArray: '4 3',
      }).addTo(this.map);
      this._fitOrDefer(this.viewshedLayer.getBounds().pad(0.2));
    }

    focus(ent) {
      this.map.panTo([ent.lat, ent.lng]);
    }
  }

  global.MapView = MapView;
})(typeof window !== 'undefined' ? window : globalThis);
