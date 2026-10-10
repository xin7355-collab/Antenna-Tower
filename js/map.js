/*
 * map.js — 地圖視角 (Leaflet)
 * ------------------------------------------------------------------
 * 顯示我的位置、無線電站臺、參考山峰；
 * 支援拖曳我的位置、點選目標、點地圖新增站臺，
 * 並把「我 → 目標」的路徑畫出來，被地形擋住的路段染成紅色。
 */
(function (global) {
  'use strict';

  const Geo = global.Geo;

  const ICONS = {
    me: '📍', station: '📡', peak: '⛰️', marker: '📌',
  };

  function divIcon(L, entity, selected) {
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
      this.map = L.map(elId, { zoomControl: true }).setView([c.lat, c.lng], this.initialZoom);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
      }).addTo(this.map);

      this.map.on('click', (e) => {
        if (this.h.onAddStation) this.h.onAddStation(e.latlng.lat, e.latlng.lng);
      });
    }

    render(state) {
      const L = this.L;
      const hidden = (state.settings && state.settings.hiddenGroups) || [];
      const pins = [...state.stations, ...state.peaks, ...(state.markers || [])];
      const all = [state.me, ...(global.Groups ? Groups.visible(pins, hidden) : pins)];
      const seen = new Set();

      all.forEach((ent) => {
        seen.add(ent.id);
        const selected = ent.id === state.selectedId;
        let m = this.markers.get(ent.id);
        if (!m) {
          // 不可拖曳：避免在地圖上滑動時誤拖站臺。移動位置請用定位/貼上座標/編輯移動。
          m = L.marker([ent.lat, ent.lng], {
            icon: divIcon(L, ent, selected),
            draggable: false,
          }).addTo(this.map);
          m.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            if (this.h.onSelect) this.h.onSelect(ent.id);
          });
          this.markers.set(ent.id, m);
        } else {
          m.setLatLng([ent.lat, ent.lng]);
          m.setIcon(divIcon(L, ent, selected));
        }
      });

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
