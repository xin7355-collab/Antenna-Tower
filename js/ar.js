/*
 * ar.js — AR / VR 全景視角
 * ------------------------------------------------------------------
 * 重現照片中的「抬頭看山」概念：把每個站臺/山峰依「方位角、仰角」
 * 疊在地平線上，顯示名稱、海拔、直線距離，並對選定目標畫一條
 * 藍色瞄準線（含遮蔽狀態）。
 *
 * 方向來源：
 *   - 手機（HTTPS）：DeviceOrientation 羅盤 + 俯仰角
 *   - 桌機：滑鼠/觸控左右拖曳改變視向（heading），上下拖曳改變俯仰
 * 相機背景（選用）：getUserMedia，若不可用則以漸層天空取代。
 */
(function (global) {
  'use strict';

  const Geo = global.Geo;
  const HFOV = 70;   // 水平視野角 (deg)
  const VFOV = 100;  // 垂直視野角 (deg)

  class ARView {
    constructor(rootId, handlers = {}) {
      this.h = handlers;
      this.root = document.getElementById(rootId);
      this.heading = 315;  // 初始朝西北
      this.pitch = 6;      // 略微抬頭
      this.state = null;
      this.usingSensor = false;
      this._build();
    }

    _build() {
      this.root.innerHTML = `
        <video class="ar-cam" playsinline autoplay muted style="display:none"></video>
        <div class="ar-sky"></div>
        <div class="ar-ground"></div>
        <div class="ar-horizon"></div>
        <div class="ar-compass"></div>
        <svg class="ar-ecliptic" preserveAspectRatio="none"></svg>
        <div class="ar-labels"></div>
        <svg class="ar-aim" preserveAspectRatio="none"></svg>
        <div class="ar-crosshair">+</div>
        <div class="ar-aimhud" style="display:none"></div>
        <div class="ar-readout"></div>
        <div class="ar-controls">
          <button data-act="sensor" title="使用手機羅盤">🧭 羅盤</button>
          <button data-act="camera" title="開啟相機背景">📷 相機</button>
          <button data-act="full" title="全螢幕">⛶ 全螢幕</button>
          <span class="ar-hint">拖曳轉視角・點山對準</span>
        </div>`;
      this.$sky = this.root.querySelector('.ar-sky');
      this.$labels = this.root.querySelector('.ar-labels');
      this.$compass = this.root.querySelector('.ar-compass');
      this.$ecliptic = this.root.querySelector('.ar-ecliptic');
      this.$aim = this.root.querySelector('.ar-aim');
      this.$readout = this.root.querySelector('.ar-readout');
      this.$aimhud = this.root.querySelector('.ar-aimhud');
      this.$cam = this.root.querySelector('.ar-cam');

      // 桌機拖曳 + 點擊對準
      let drag = null, moved = 0;
      const down = (x, y) => { drag = { x, y, h: this.heading, p: this.pitch }; moved = 0; };
      const move = (x, y) => {
        if (!drag) return;
        moved = Math.max(moved, Math.hypot(x - drag.x, y - drag.y));
        if (this.usingSensor) return;
        const w = this.root.clientWidth, hgt = this.root.clientHeight;
        this.heading = (drag.h - ((x - drag.x) / w) * HFOV + 360) % 360;
        this.pitch = Math.max(-40, Math.min(60, drag.p + ((y - drag.y) / hgt) * VFOV));
        this._paint();
      };
      const up = (x, y) => {
        if (drag && moved < 8 && x != null) this._tap(x, y); // 幾乎沒移動 = 點擊
        drag = null;
      };
      this.root.addEventListener('mousedown', (e) => down(e.clientX, e.clientY));
      window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
      window.addEventListener('mouseup', (e) => up(e.clientX, e.clientY));
      this.root.addEventListener('touchstart', (e) => { const t = e.touches[0]; down(t.clientX, t.clientY); }, { passive: true });
      this.root.addEventListener('touchmove', (e) => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
      this.root.addEventListener('touchend', (e) => { const t = e.changedTouches[0]; up(t.clientX, t.clientY); });

      this.root.querySelector('[data-act="sensor"]').onclick = () => this.enableSensor();
      this.root.querySelector('[data-act="camera"]').onclick = () => this.toggleCamera();
      this.root.querySelector('[data-act="full"]').onclick = () => this.toggleFullscreen();
      document.addEventListener('fullscreenchange', () => setTimeout(() => this._paint(), 100));
      // 尺寸/方向改變時重繪，避免殘留壞掉的版面
      window.addEventListener('resize', () => this._paint());
      window.addEventListener('orientationchange', () => { setTimeout(() => this._paint(), 250); });
    }

    /** 供外部（切回 AR 分頁時）重新繪製 */
    repaint() { this._paint(); }

    toggleFullscreen() {
      const el = this.root;
      if (!document.fullscreenElement) {
        (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
      }
    }

    async enableSensor() {
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          const p = await DeviceOrientationEvent.requestPermission();
          if (p !== 'granted') return alert('未授權方向感測器');
        }
        window.addEventListener('deviceorientationabsolute', (e) => this._onOrient(e), true);
        window.addEventListener('deviceorientation', (e) => this._onOrient(e), true);
        this.usingSensor = true;
      } catch (err) { alert('此裝置不支援方向感測器'); }
    }

    _onOrient(e) {
      // webkitCompassHeading（iOS）或 alpha（其他）
      let hd = (typeof e.webkitCompassHeading === 'number')
        ? e.webkitCompassHeading
        : (e.alpha != null ? 360 - e.alpha : null);
      // 圓周低通濾波，減少羅盤抖動（以 sin/cos 分量平滑角度）
      const A = 0.25;
      if (hd != null) {
        const rad = Geo.toRad((hd + 360) % 360);
        const prev = Geo.toRad(this.heading);
        const s = A * Math.sin(rad) + (1 - A) * Math.sin(prev);
        const c = A * Math.cos(rad) + (1 - A) * Math.cos(prev);
        this.heading = (Geo.toDeg(Math.atan2(s, c)) + 360) % 360;
      }
      if (e.beta != null) {
        const target = Math.max(-40, Math.min(60, e.beta - 90));
        this.pitch = A * target + (1 - A) * this.pitch; // 俯仰角低通
      }
      this._paint();
    }

    async toggleCamera() {
      // 關閉相機：停止串流、恢復天空/地面背景
      if (this.$cam.style.display !== 'none') {
        this.$cam.style.display = 'none';
        this.root.classList.remove('ar-cam-on');
        if (this.$cam.srcObject) this.$cam.srcObject.getTracks().forEach((t) => t.stop());
        return;
      }
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('此瀏覽器不支援相機（請用 Safari/Chrome 並以 https 開啟）');
        }
        // 優先用後鏡頭；不支援時退回任一相機
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } }, audio: false,
          });
        } catch (_) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        // iOS 需要這些屬性才能行內自動播放
        this.$cam.setAttribute('playsinline', '');
        this.$cam.setAttribute('webkit-playsinline', '');
        this.$cam.muted = true;
        this.$cam.srcObject = stream;
        this.$cam.style.display = 'block';
        this.root.classList.add('ar-cam-on'); // 隱藏天空/地面漸層讓鏡頭透出
        try { await this.$cam.play(); } catch (_) { /* 部分瀏覽器 autoplay 屬性已接手 */ }
        this._paint();
      } catch (err) {
        const msg = (err && err.name === 'NotAllowedError')
          ? '相機權限被拒。請在瀏覽器網址列的權限設定允許「相機」後再試。'
          : (location.protocol !== 'https:'
              ? '相機需要 HTTPS。請用 https 的網址開啟。'
              : '無法開啟相機：' + (err && err.message ? err.message : err));
        alert(msg);
      }
    }

    render(state) { this.state = state; this._paint(); }

    /** 點擊 AR 畫面：選取離觸點最近的可見目標並對準它。 */
    _tap(clientX, clientY) {
      const r = this.root.getBoundingClientRect();
      const x = clientX - r.left, y = clientY - r.top;
      let best = null, bd = Infinity;
      (this._placed || []).forEach((c) => {
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < bd) { bd = d; best = c; }
      });
      if (best && bd < 110 && this.h.onSelect) this.h.onSelect(best.t.id);
    }

    /** 程式化轉向面對某方位/仰角（選取目標時用；感測器模式下不干預）。 */
    lookAt(bearingDeg, pitchDeg) {
      if (this.usingSensor) return;
      this.heading = (bearingDeg + 360) % 360;
      if (typeof pitchDeg === 'number') this.pitch = Math.max(-40, Math.min(60, pitchDeg));
      this._paint();
    }

    _paint() {
      if (!this.state) return;
      // 視角被隱藏（切到地圖分頁）時尺寸為 0，若此時重繪會把版面算壞，
      // 導致切回來「一半黑」。直接略過，等重新可見時再繪。
      if (!this.root.clientWidth || !this.root.clientHeight) return;
      const st = this.state;
      const me = st.me;
      const H = this.root.clientHeight;
      const W = this.root.clientWidth;

      // 天空/地面：地平線隨俯仰角上下移動
      const horizonY = H / 2 + (this.pitch / (VFOV / 2)) * (H / 2);
      this.$sky.style.height = `${horizonY}px`;
      this.root.querySelector('.ar-horizon').style.top = `${horizonY}px`;
      this.root.querySelector('.ar-ground').style.top = `${horizonY}px`;

      this._paintCompass(W, horizonY);

      const angDiff = (a) => ((a - this.heading + 540) % 360) - 180;
      const obsAlt = (me.alt || 0) + (me.antenna || 0);
      const projX = (az) => W / 2 + (angDiff(az) / (HFOV / 2)) * (W / 2);
      const projY = (alt) => horizonY - ((alt - this.pitch) / (VFOV / 2)) * (H / 2);
      let aim = null;
      const cand = [];

      // 1a) 陸地目標（山/站臺）
      [...st.stations, ...st.peaks].forEach((t) => {
        const brg = Geo.bearing(me, t);
        if (Math.abs(angDiff(brg)) > HFOV / 2 + 4) return;
        const dist = Geo.distance(me, t);
        const tgtTop = Geo.targetTopAlt(t, st.settings.tgtAntenna);
        const elev = Geo.elevationAngle(obsAlt, tgtTop, dist, st.settings.withCurvature, st.settings.k);
        const selected = t.id === st.selectedId;
        const a = st.analysisById[t.id];
        const status = a ? (a.clear ? 'ok' : a.losClear ? 'marg' : 'bad') : '';
        const blocked = a && !a.losClear;
        cand.push({
          id: t.id, name: t.name, kind: t.type, selected, status, stick: true, custom: !!t.custom,
          x: projX(brg), y: projY(elev),
          sub: `${Math.round(tgtTop)} m · ${Geo.fmtDistance(dist)}`,
          prio: (selected ? 1e9 : 0) + (t.type === 'station' ? 1e6 : 0) + tgtTop - dist / 1000,
          readout: () => this._geoReadout(t, dist, brg, elev, blocked),
          color: blocked ? '#e23b3b' : '#2f6fff',
        });
      });

      // 1b) 天文層（太陽/月亮/行星/星星）+ 黃道線
      if (st.settings.showSky && global.Sky) {
        const date = st.settings.skyTime ? new Date(st.settings.skyTime) : new Date();
        this._paintEcliptic(Sky.eclipticPath(date, me.lat, me.lng, 5), angDiff, projX, projY, W, H);
        const objs = Sky.skyObjects(date, me.lat, me.lng, { maxMag: st.settings.starMag != null ? st.settings.starMag : 2.2 });
        objs.forEach((o) => {
          if (o.alt < -2) return;                        // 地平線下不畫
          if (Math.abs(angDiff(o.az)) > HFOV / 2 + 4) return;
          const selected = o.id === st.selectedId;
          const pr = o.type === 'sun' || o.type === 'moon' ? 5e5 : o.type === 'planet' ? 2e5 : 1e5 - (o.mag || 0) * 1000;
          cand.push({
            id: o.id, name: o.name, kind: 'sky-' + o.type, selected, stick: false,
            x: projX(o.az), y: projY(o.alt),
            sub: `方位 ${Math.round(o.az)}° · 仰角 ${o.alt.toFixed(0)}°`,
            prio: (selected ? 1e9 : 0) + pr,
            readout: () => this._skyReadout(o),
            color: '#ffd36b',
          });
        });
      } else {
        this.$ecliptic.innerHTML = '';
      }

      // 1c) 衛星（如 ISS）— 獨立於天空開關
      if (st.satellites && st.satellites.length) {
        st.satellites.forEach((o) => {
          if (o.alt < -2 || Math.abs(angDiff(o.az)) > HFOV / 2 + 4) return;
          const selected = o.id === st.selectedId;
          cand.push({
            id: o.id, name: o.name, kind: 'sky-sat', selected, stick: false,
            x: projX(o.az), y: projY(o.alt),
            sub: `仰角 ${o.alt.toFixed(0)}° · ${Math.round(o.rangeKm)} km`,
            prio: (selected ? 1e9 : 0) + 3e5,
            readout: () => this._skyReadout(o), color: '#7dffcf',
          });
        });
      }

      // 2) 去重疊：依優先權放置，水平與垂直都接近才視為重疊
      const placed = [];
      cand.sort((a, b) => b.prio - a.prio).forEach((c) => {
        if (!c.selected && placed.some((p) => Math.abs(p.x - c.x) < 62 && Math.abs(p.y - c.y) < 26)) return;
        placed.push(c);
        if (c.selected) aim = c;
      });

      // 3) 依 x 由左到右輸出
      const html = placed.slice().sort((a, b) => a.x - b.x).map((c) => {
        const cls = `arlbl arlbl-${c.kind}${c.selected ? ' arlbl-sel' : ''}${c.status ? ' arlbl-' + c.status : ''}${c.custom ? ' arlbl-custom' : ''}`;
        const stick = c.stick ? `<i class="arlbl-stick" style="height:${Math.max(8, horizonY - c.y)}px"></i>` : '';
        return `<div class="${cls}" style="left:${c.x}px;top:${c.y}px" data-id="${c.id}">` +
          `<span class="arlbl-name">${c.name}</span><span class="arlbl-sub">${c.sub}</span>${stick}</div>`;
      });

      this.$labels.innerHTML = html.join('');
      this.$labels.querySelectorAll('.arlbl').forEach((el) => {
        el.onclick = () => this.h.onSelect && this.h.onSelect(el.dataset.id);
      });
      this._placed = placed; // 供點擊對準用

      this._paintAim(aim, W, H);

      // 對準 HUD：手機當天線仰角/方位對準器
      const selTgt = [...st.stations, ...st.peaks].find((t) => t.id === st.selectedId);
      this._paintAimHud(selTgt, me, st);
    }

    // 對準 HUD：把手機當成天線對準器，即時比對「目前朝向」與「目標仰角/方位」
    _paintAimHud(target, me, st) {
      if (!target) { this.$aimhud.style.display = 'none'; return; }
      const brg = Geo.bearing(me, target);
      const dist = Geo.distance(me, target);
      const obsAlt = (me.alt || 0) + (me.antenna || 0);
      const elev = Geo.elevationAngle(obsAlt, Geo.targetTopAlt(target, st.settings.tgtAntenna), dist, st.settings.withCurvature, st.settings.k);
      const dAz = ((brg - this.heading + 540) % 360) - 180; // 正=目標在右
      const dEl = elev - this.pitch;                          // 正=需抬高
      const azOK = Math.abs(dAz) <= 3, elOK = Math.abs(dEl) <= 1;
      const elMsg = elOK ? '✅ 對準' : (dEl > 0 ? '抬高 ▲ ' + Math.abs(dEl).toFixed(1) + '°' : '壓低 ▼ ' + Math.abs(dEl).toFixed(1) + '°');
      const azMsg = azOK ? '✅ 對準' : (dAz > 0 ? '右轉 ▶ ' + Math.abs(Math.round(dAz)) + '°' : '左轉 ◀ ' + Math.abs(Math.round(dAz)) + '°');
      this.$aimhud.style.display = 'block';
      this.$aimhud.innerHTML =
        `<div class="hud-name">🎯 ${target.name} · ${Geo.fmtDistance(dist)}</div>` +
        `<div class="hud-row ${elOK ? 'hud-ok' : ''}"><span class="hud-k">仰角</span>` +
        `目前 <b>${this.pitch.toFixed(1)}°</b> → 目標 <b>${elev.toFixed(1)}°</b>` +
        `<span class="hud-d">${elMsg}</span></div>` +
        `<div class="hud-row ${azOK ? 'hud-ok' : ''}"><span class="hud-k">方位</span>` +
        `目前 <b>${Math.round(this.heading)}°</b> → 目標 <b>${Math.round(brg)}° ${Geo.compass8(brg)}</b>` +
        `<span class="hud-d">${azMsg}</span></div>` +
        (azOK && elOK ? `<div class="hud-locked">🔒 已對準目標！</div>` : '') +
        (!this.usingSensor ? `<div class="hud-note">桌機為模擬值；手機請按 🧭 羅盤，「目前」才是手機真實朝向</div>` : '');
    }

    _paintCompass(W, horizonY) {
      const ticks = [];
      for (let b = 0; b < 360; b += 15) {
        let d = ((b - this.heading + 540) % 360) - 180;
        if (Math.abs(d) > HFOV / 2) continue;
        const x = W / 2 + (d / (HFOV / 2)) * (W / 2);
        const major = b % 45 === 0;
        const label = major ? Geo.compass8(b) : '';
        ticks.push(
          `<div class="ar-tick${major ? ' major' : ''}" style="left:${x}px;top:${horizonY}px">` +
          `<i></i>${label ? `<b>${label}</b>` : ''}</div>`
        );
      }
      this.$compass.innerHTML = ticks.join('');
    }

    _paintAim(aim, W, H) {
      if (!aim) { this.$aim.innerHTML = ''; this.$readout.innerHTML = ''; return; }
      const color = aim.color || '#2f6fff';
      // 從畫面底部中央拉一條瞄準線到目標（照片中的藍線）
      this.$aim.setAttribute('viewBox', `0 0 ${W} ${H}`);
      this.$aim.innerHTML =
        `<line x1="${W / 2}" y1="${H}" x2="${aim.x}" y2="${aim.y}" stroke="${color}" stroke-width="3"/>` +
        `<circle cx="${aim.x}" cy="${aim.y}" r="8" fill="none" stroke="${color}" stroke-width="3"/>`;
      this.$readout.innerHTML = aim.readout ? aim.readout() : `<div class="ro-name">${aim.name}</div>`;
    }

    _geoReadout(t, dist, brg, elev, blocked) {
      const analyzed = this.state && this.state.analysisById[t.id];
      const los = !analyzed ? '' :
        (blocked ? '<div class="ro-line"><span class="ro-blocked">⛰️ 視線被地形遮蔽</span></div>'
                 : '<div class="ro-line"><span class="ro-clear">✓ 視線淨空</span></div>');
      const top = Geo.targetTopAlt(t, (this.state && this.state.settings.tgtAntenna) || 0);
      const altTxt = Geo.usesTrueAlt(t)
        ? `真實高度：${Math.round(top).toLocaleString()} m`
        : `海拔：${Math.round(top).toLocaleString()} m`;
      return `<div class="ro-name">${t.name}</div>` +
        `<div class="ro-line">${altTxt}　距離：${Geo.fmtDistance(dist)}</div>` +
        `<div class="ro-line">方位：${Math.round(brg)}° ${Geo.compass8(brg)}　仰角：${elev.toFixed(1)}°</div>` + los;
    }

    _skyReadout(o) {
      const typeName = { sun: '太陽', moon: '月亮', planet: '行星', star: '恆星', sat: '衛星' }[o.type] || '';
      const extra = (o.type === 'moon' && o.illum != null) ? `　照明 ${Math.round(o.illum * 100)}%`
        : (o.type === 'sat' && o.rangeKm != null) ? `　距離 ${Math.round(o.rangeKm)} km`
        : (o.mag != null ? `　星等 ${o.mag}` : '');
      return `<div class="ro-name">${o.name}</div>` +
        `<div class="ro-line">方位：${Math.round(o.az)}° ${Geo.compass8(o.az)}　仰角：${o.alt.toFixed(1)}°</div>` +
        `<div class="ro-line">天體：${typeName}${extra}</div>`;
    }

    // 畫黃道線（在視野內的連續段）
    _paintEcliptic(pts, angDiff, projX, projY, W, H) {
      let d = '', pen = false;
      pts.forEach((p) => {
        if (Math.abs(angDiff(p.az)) < HFOV / 2 + 8 && p.alt > -20) {
          const x = projX(p.az), y = projY(p.alt);
          d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
          pen = true;
        } else { pen = false; }
      });
      this.$ecliptic.setAttribute('viewBox', `0 0 ${W} ${H}`);
      this.$ecliptic.innerHTML = d ? `<path d="${d}" fill="none" stroke="#e0a94a" stroke-width="2" stroke-dasharray="2 4" opacity="0.8"/>` : '';
    }
  }

  global.ARView = ARView;
})(typeof window !== 'undefined' ? window : globalThis);
