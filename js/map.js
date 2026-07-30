/*
 * map.js — 地圖視角 (Leaflet)
 * ------------------------------------------------------------------
 * 顯示我的位置、無線電站台、參考山峰；
 * 支援拖曳我的位置、點選目標、點地圖新增站台，
 * 並把「我 → 目標」的路徑畫出來，被地形擋住的路段染成紅色。
 */
(function (global) {
  'use strict';

  const Geo = global.Geo;

  const ICONS = {
    me: '📍', station: '📡', peak: '⛰️',
  };

  function divIcon(L, entity, selected) {
    const cls = `mk mk-${entity.type}${selected ? ' mk-sel' : ''}`;
    return L.divIcon({
      className: 'mk-wrap',
      html: `<div class="${cls}"><span class="mk-ico">${ICONS[entity.type] || '•'}</span>` +
            `<span class="mk-lbl">${entity.name}</span></div>`,
      iconSize: null,
      iconAnchor: [0, 0],
    });
  }

  class MapView {
    constructor(elId, handlers = {}) {
      this.h = handlers;
      this.markers = new Map();
      this.pathLayer = null;
      this.coverageLayer = null;
      this.viewshedLayer = null;

      const L = global.L;
      this.L = L;
      this.map = L.map(elId, { zoomControl: true }).setView([23.5, 121.0], 8);
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
      const all = [state.me, ...state.stations, ...state.peaks];
      const seen = new Set();

      all.forEach((ent) => {
        seen.add(ent.id);
        const selected = ent.id === state.selectedId;
        let m = this.markers.get(ent.id);
        if (!m) {
          // 不可拖曳：避免在地圖上滑動時誤拖站台。移動位置請用定位/貼上座標/編輯移動。
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
      this.map.fitBounds(L.latLngBounds(latlngs).pad(0.3));
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
     * 顯示衛星（ISS）當前地表位置。傳 null 即清除。
     */
    setSatellite(pos) {
      if (this.satMarker) { this.map.removeLayer(this.satMarker); this.satMarker = null; }
      if (!pos) return;
      const L = this.L;
      this.satMarker = L.marker([pos.lat, pos.lng], {
        icon: L.divIcon({
          className: 'mk-wrap',
          html: `<div class="mk mk-sat"><span class="mk-ico">🛰</span>` +
                `<span class="mk-lbl">${pos.name || 'ISS'} (${pos.alt >= 0 ? '地平線上' : '地平線下'})</span></div>`,
          iconAnchor: [0, 0],
        }),
        interactive: false,
      }).addTo(this.map);
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
      this.map.fitBounds(this.viewshedLayer.getBounds().pad(0.2));
    }

    focus(ent) {
      this.map.panTo([ent.lat, ent.lng]);
    }
  }

  global.MapView = MapView;
})(typeof window !== 'undefined' ? window : globalThis);
