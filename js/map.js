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
          m = L.marker([ent.lat, ent.lng], {
            icon: divIcon(L, ent, selected),
            draggable: ent.type !== 'peak',
          }).addTo(this.map);
          m.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            if (this.h.onSelect) this.h.onSelect(ent.id);
          });
          m.on('dragend', () => {
            const ll = m.getLatLng();
            if (this.h.onMove) this.h.onMove(ent.id, ll.lat, ll.lng);
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

    focus(ent) {
      this.map.panTo([ent.lat, ent.lng]);
    }
  }

  global.MapView = MapView;
})(typeof window !== 'undefined' ? window : globalThis);
