/*
 * ar.js — AR / VR 全景視角
 * ------------------------------------------------------------------
 * 重現照片中的「抬頭看山」概念：把每個站台/山峰依「方位角、仰角」
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
        <video class="ar-cam" playsinline muted style="display:none"></video>
        <div class="ar-sky"></div>
        <div class="ar-ground"></div>
        <div class="ar-horizon"></div>
        <div class="ar-compass"></div>
        <div class="ar-labels"></div>
        <svg class="ar-aim" preserveAspectRatio="none"></svg>
        <div class="ar-readout"></div>
        <div class="ar-controls">
          <button data-act="sensor" title="使用手機羅盤">🧭 羅盤</button>
          <button data-act="camera" title="開啟相機背景">📷 相機</button>
          <span class="ar-hint">桌機：拖曳畫面轉動視角</span>
        </div>`;
      this.$sky = this.root.querySelector('.ar-sky');
      this.$labels = this.root.querySelector('.ar-labels');
      this.$compass = this.root.querySelector('.ar-compass');
      this.$aim = this.root.querySelector('.ar-aim');
      this.$readout = this.root.querySelector('.ar-readout');
      this.$cam = this.root.querySelector('.ar-cam');

      // 桌機拖曳
      let drag = null;
      const down = (x, y) => (drag = { x, y, h: this.heading, p: this.pitch });
      const move = (x, y) => {
        if (!drag || this.usingSensor) return;
        const w = this.root.clientWidth, hgt = this.root.clientHeight;
        this.heading = (drag.h - ((x - drag.x) / w) * HFOV + 360) % 360;
        this.pitch = Math.max(-40, Math.min(60, drag.p + ((y - drag.y) / hgt) * VFOV));
        this._paint();
      };
      const up = () => (drag = null);
      this.root.addEventListener('mousedown', (e) => down(e.clientX, e.clientY));
      window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
      window.addEventListener('mouseup', up);
      this.root.addEventListener('touchstart', (e) => { const t = e.touches[0]; down(t.clientX, t.clientY); }, { passive: true });
      this.root.addEventListener('touchmove', (e) => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
      this.root.addEventListener('touchend', up);

      this.root.querySelector('[data-act="sensor"]').onclick = () => this.enableSensor();
      this.root.querySelector('[data-act="camera"]').onclick = () => this.toggleCamera();
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
      if (hd != null) this.heading = (hd + 360) % 360;
      if (e.beta != null) this.pitch = Math.max(-40, Math.min(60, e.beta - 90));
      this._paint();
    }

    async toggleCamera() {
      if (this.$cam.style.display !== 'none') {
        this.$cam.style.display = 'none';
        if (this.$cam.srcObject) this.$cam.srcObject.getTracks().forEach((t) => t.stop());
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }, audio: false,
        });
        this.$cam.srcObject = stream;
        await this.$cam.play();
        this.$cam.style.display = 'block';
      } catch (err) { alert('無法開啟相機（需 HTTPS 與授權）'); }
    }

    render(state) { this.state = state; this._paint(); }

    /** 程式化轉向面對某方位/仰角（選取目標時用；感測器模式下不干預）。 */
    lookAt(bearingDeg, pitchDeg) {
      if (this.usingSensor) return;
      this.heading = (bearingDeg + 360) % 360;
      if (typeof pitchDeg === 'number') this.pitch = Math.max(-40, Math.min(60, pitchDeg));
      this._paint();
    }

    _paint() {
      if (!this.state) return;
      const st = this.state;
      const me = st.me;
      const W = this.root.clientWidth, H = this.root.clientHeight;

      // 天空/地面：地平線隨俯仰角上下移動
      const horizonY = H / 2 + (this.pitch / (VFOV / 2)) * (H / 2);
      this.$sky.style.height = `${horizonY}px`;
      this.root.querySelector('.ar-horizon').style.top = `${horizonY}px`;
      this.root.querySelector('.ar-ground').style.top = `${horizonY}px`;

      this._paintCompass(W, horizonY);

      // 計算每個目標的螢幕位置
      const targets = [...st.stations, ...st.peaks];
      const angDiff = (a) => { let d = ((a - this.heading + 540) % 360) - 180; return d; };
      const obsAlt = (me.alt || 0) + (me.antenna || 0);
      let aim = null;

      // 1) 收集視野內的候選標籤
      const cand = [];
      targets.forEach((t) => {
        const dh = angDiff(Geo.bearing(me, t));
        if (Math.abs(dh) > HFOV / 2 + 4) return; // 視野外
        const dist = Geo.distance(me, t);
        const brg = Geo.bearing(me, t);
        const elev = Geo.elevationAngle(obsAlt, t.alt, dist, st.settings.withCurvature, st.settings.k);
        const x = W / 2 + (dh / (HFOV / 2)) * (W / 2);
        const y = horizonY - ((elev - this.pitch) / (VFOV / 2)) * (H / 2);
        const selected = t.id === st.selectedId;
        // 優先權：選定 > 站台 > 高/近的山峰
        const prio = (selected ? 1e9 : 0) + (t.type === 'station' ? 1e6 : 0) + t.alt - dist / 1000;
        cand.push({ t, dist, brg, elev, x, y, selected, prio,
          blocked: st.analysisById[t.id] && !st.analysisById[t.id].losClear });
        if (selected) aim = { x, y, t, dist, brg, elev, blocked: st.analysisById[t.id] && !st.analysisById[t.id].losClear };
      });

      // 2) 去重疊：依優先權放置，若與已放置標籤水平太近則跳過
      const MIN_GAP = 62;
      const placed = [];
      cand.sort((a, b) => b.prio - a.prio).forEach((c) => {
        if (!c.selected && placed.some((p) => Math.abs(p.x - c.x) < MIN_GAP)) return;
        placed.push(c);
      });

      // 3) 依 x 由左到右輸出
      const html = placed.sort((a, b) => a.x - b.x).map((c) => {
        const cls = `arlbl arlbl-${c.t.type}${c.selected ? ' arlbl-sel' : ''}${c.blocked ? ' arlbl-blocked' : ''}`;
        return `<div class="${cls}" style="left:${c.x}px;top:${c.y}px" data-id="${c.t.id}">` +
          `<span class="arlbl-name">${c.t.name}</span>` +
          `<span class="arlbl-sub">${c.t.alt} m · ${Geo.fmtDistance(c.dist)}</span>` +
          `<i class="arlbl-stick" style="height:${Math.max(8, horizonY - c.y)}px"></i>` +
          `</div>`;
      });

      this.$labels.innerHTML = html.join('');
      this.$labels.querySelectorAll('.arlbl').forEach((el) => {
        el.onclick = () => this.h.onSelect && this.h.onSelect(el.dataset.id);
      });

      this._paintAim(aim, W, H, horizonY);
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

    _paintAim(aim, W, H, horizonY) {
      if (!aim) { this.$aim.innerHTML = ''; this.$readout.innerHTML = ''; return; }
      const color = aim.blocked ? '#e23b3b' : '#2f6fff';
      // 從畫面底部中央拉一條瞄準線到目標（照片中的藍線）
      this.$aim.setAttribute('viewBox', `0 0 ${W} ${H}`);
      this.$aim.innerHTML =
        `<line x1="${W / 2}" y1="${H}" x2="${aim.x}" y2="${aim.y}" ` +
        `stroke="${color}" stroke-width="3"/>` +
        `<circle cx="${aim.x}" cy="${aim.y}" r="7" fill="none" stroke="${color}" stroke-width="3"/>`;

      const blockedTxt = aim.blocked
        ? `<span class="ro-blocked">⛰️ 視線被地形遮蔽</span>`
        : `<span class="ro-clear">✓ 視線淨空</span>`;
      this.$readout.innerHTML =
        `<div class="ro-name">${aim.t.name}</div>` +
        `<div class="ro-line">海拔：${aim.t.alt.toLocaleString()} m　距離：${Geo.fmtDistance(aim.dist)}</div>` +
        `<div class="ro-line">方位：${Math.round(aim.brg)}° ${Geo.compass8(aim.brg)}　仰角：${aim.elev.toFixed(1)}°</div>` +
        `<div class="ro-line">${blockedTxt}</div>`;
    }
  }

  global.ARView = ARView;
})(typeof window !== 'undefined' ? window : globalThis);
