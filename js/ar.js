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
  const HFOV_DEFAULT = 70;    // 沒開相機時的水平視野角預設值 (deg)；實際值在 this.hfov
  const FOV_MIN = 20, FOV_MAX = 120;
  // 手機主鏡頭在影像「長邊」方向的視角。等效焦距 24–26 mm 的主鏡頭約 67–72°。
  // 開相機時的畫面視角由它與串流尺寸、視窗尺寸推算（見 camDisplayHfov），
  // 雙指縮放校正改的就是這個值，所以換方向、進出全螢幕都還是對得準。
  const CAM_FOV_DEFAULT = 68;
  // AR 疊加畫面「顯示」用的等效地球半徑：可見光 ≈1.13，與山稜線一致。
  // 無線電分析（遮蔽/連結預算）仍用設定裡的 4/3，兩者差異 <0.2°。
  const K_DISPLAY = (global.Elevation && global.Elevation.K_OPTICAL) || 1.13;
  // 可抬頭/低頭的範圍。上限必須到 90°（天頂）——星座常在 60° 以上
  // （獵戶座可到 70 幾度），上限訂在 60° 的話手機根本轉不過去。
  const PITCH_MAX = 90, PITCH_MIN = -60;
  const clampPitch = (p) => Math.max(PITCH_MIN, Math.min(PITCH_MAX, p));

  /**
   * 估算一段文字畫出來的寬度（px）。用來判斷 AR 標籤會不會互相疊到。
   * 中日韓字元約一個字高，其餘（英數、符號、空白）約半個字高。
   */
  function textWidth(text, fontPx) {
    let w = 0;
    for (const ch of String(text || '')) {
      w += /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿︰-﹏＀-｠]/.test(ch)
        ? fontPx : fontPx * 0.55;
    }
    return w;
  }

  /** 提示訊息。有 ui.js 就用浮動提示，沒有才退回 alert。 */
  function notify(msg, kind, ms) {
    if (global.UI && global.UI.toast) global.UI.toast(msg, kind, ms);
    else alert(msg);
  }

  /**
   * 稜線顏色：依距離由近到遠，暖褐 → 藍灰。
   * 這是空氣透視（遠處偏藍偏淡）的簡化版，用來分辨前後山稜。
   */
  function ridgeColor(distM) {
    const near = [0xb8, 0x8a, 0x5c];   // 近：暖褐
    const far = [0x8f, 0xb4, 0xd8];    // 遠：淡藍
    let t = Math.max(0, Math.min(1, ((distM || 0) / 1000 - 15) / 65)); // 15km→80km
    t = Math.round(t * 12) / 12;       // 分 13 階：同色的相鄰線段可併成一條折線
    const c = near.map((n, i) => Math.round(n + (far[i] - n) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  /**
   * 針孔相機投影：方位/仰角 → 螢幕座標，與手機相機的成像方式相同。
   *
   * 舊版把角度「線性」對應到像素：畫面中央被拉開、邊緣被壓縮，垂直方向
   * 還另外誇大，開相機對照實景時，離中心越遠的山偏得越多。透視投影下
   * 水平與垂直同一個比例尺，地平線是一條直線，與相機畫面一致。
   *
   * @returns proj(az, alt) → {x, y, front}；front=false 表示在背後看不到。
   *          另附 proj.f（焦距 px）、proj.horizonY、proj.vfov。
   */
  function makeProjection(heading, pitch, hfov, W, H) {
    const rad = Math.PI / 180;
    const h = heading * rad, p = pitch * rad;
    const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p);
    const f = (W / 2) / Math.tan((hfov * rad) / 2);
    // 相機三軸（以 東、北、上 表示）：F 正前方、R 右方、U 畫面上方
    const Fx = cp * sh, Fy = cp * ch, Fz = sp;
    const Rx = ch, Ry = -sh;
    const Ux = -sh * sp, Uy = -ch * sp, Uz = cp;
    const proj = (az, alt) => {
      const a = az * rad, e = alt * rad, ce = Math.cos(e);
      const vx = ce * Math.sin(a), vy = ce * Math.cos(a), vz = Math.sin(e);
      const zc = vx * Fx + vy * Fy + vz * Fz;           // 沿視線方向的深度
      if (zc < 0.02) return { x: NaN, y: NaN, front: false };
      return {
        x: W / 2 + (f * (vx * Rx + vy * Ry)) / zc,
        y: H / 2 - (f * (vx * Ux + vy * Uy + vz * Uz)) / zc,
        front: true,
      };
    };
    proj.f = f;
    proj.horizonY = H / 2 + f * Math.tan(Math.max(-89, Math.min(89, pitch)) * rad);
    proj.vfov = (2 * Math.atan(H / 2 / f)) / rad;
    return proj;
  }

  /**
   * 相機畫面在 AR 視窗裡實際呈現的水平視角 (deg)。
   * 影像用 object-fit: cover 鋪滿視窗：等比放大到蓋滿、多的裁掉。
   * 直拿手機時，串流是直的（例如 480×640），視窗也是直的，
   * 主鏡頭 68° 的長邊對應到畫面高度，水平只剩約 40°。
   *
   * @param vw,vh   串流解析度
   * @param W,H     AR 視窗大小 (CSS px)
   * @param longFov 鏡頭在串流長邊方向的視角 (deg)
   */
  function camDisplayHfov(vw, vh, W, H, longFov) {
    const s = Math.max(W / vw, H / vh);                                   // cover 縮放倍率
    const f = ((Math.max(vw, vh) / 2) / Math.tan((longFov * Math.PI) / 360)) * s; // 焦距 (CSS px)
    return (2 * Math.atan(W / 2 / f) * 180) / Math.PI;
  }

  /** camDisplayHfov 的反推：畫面視角被校正成 hfov 時，鏡頭長邊視角是多少 */
  function camLongFov(vw, vh, W, H, hfov) {
    const s = Math.max(W / vw, H / vh);
    const f = (W / 2) / Math.tan((hfov * Math.PI) / 360);
    return (2 * Math.atan(((Math.max(vw, vh) / 2) * s) / f) * 180) / Math.PI;
  }

  class ARView {
    constructor(rootId, handlers = {}) {
      this.h = handlers;
      this.root = document.getElementById(rootId);
      this.heading = 315;  // 初始朝西北
      this.pitch = 6;      // 略微抬頭
      this.baseHfov = HFOV_DEFAULT;  // 沒開相機時的視野（設定裡的「視野」）
      this.hfov = HFOV_DEFAULT;      // 目前實際使用的視野；開相機時由鏡頭推算
      this.vfov = HFOV_DEFAULT;      // 由 hfov 與畫面長寬比推得，每次重繪更新
      this._pinch = null;  // 雙指縮放校正視野中
      this.state = null;
      this.usingSensor = false;
      this._paintPending = false;  // rAF 節流用
      this._skyCache = null;       // 天文計算快取（見 _skyData）
      this._camBusy = false;       // 相機開關進行中，擋掉重複點擊
      this._build();
    }

    _build() {
      this.root.innerHTML = `
        <video class="ar-cam" playsinline autoplay muted style="display:none"></video>
        <div class="ar-sky"></div>
        <div class="ar-ground"></div>
        <div class="ar-horizon"></div>
        <svg class="ar-skyline" preserveAspectRatio="none"></svg>
        <div class="ar-compass"></div>
        <svg class="ar-ecliptic" preserveAspectRatio="none"></svg>
        <svg class="ar-constel" preserveAspectRatio="none"></svg>
        <div class="ar-labels"></div>
        <svg class="ar-aim" preserveAspectRatio="none"></svg>
        <div class="ar-crosshair">+</div>
        <div class="ar-aimhud" style="display:none"></div>
        <div class="ar-dir" style="display:none"></div>
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
      this.$skyline = this.root.querySelector('.ar-skyline');
      this.$constel = this.root.querySelector('.ar-constel');
      this.$aim = this.root.querySelector('.ar-aim');
      this.$readout = this.root.querySelector('.ar-readout');
      this.$aimhud = this.root.querySelector('.ar-aimhud');
      this.$dir = this.root.querySelector('.ar-dir');
      this.$cam = this.root.querySelector('.ar-cam');

      // 桌機拖曳 + 點擊對準
      // 控制列的按鈕也在 root 裡，若讓它們啟動拖曳，手指稍微移動就會被判成
      // 轉視角而吃掉點擊 —— 這正是「按相機/羅盤有時沒反應」的原因。
      const isUI = (e) => !!(e.target && e.target.closest && e.target.closest('.ar-controls'));
      let drag = null, moved = 0;
      const down = (x, y) => { drag = { x, y, h: this.heading, p: this.pitch }; moved = 0; };
      const move = (x, y) => {
        if (!drag) return;
        moved = Math.max(moved, Math.hypot(x - drag.x, y - drag.y));
        if (this.usingSensor) return;
        // 以畫面中央的比例尺換算（透視投影下每度像素數 = 焦距），
        // 手指拖多少、中央的景物就跟著移多少
        const f = (this.root.clientWidth / 2) / Math.tan((this.hfov * Math.PI) / 360);
        const k = 180 / Math.PI / f;
        this.heading = (drag.h - (x - drag.x) * k + 360) % 360;
        this.pitch = clampPitch(drag.p + (y - drag.y) * k);
        this._paint();
      };
      const up = (x, y) => {
        if (drag && moved < 8 && x != null) this._tap(x, y); // 幾乎沒移動 = 點擊
        drag = null;
      };
      this.root.addEventListener('mousedown', (e) => { if (isUI(e)) return; down(e.clientX, e.clientY); });
      window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
      window.addEventListener('mouseup', (e) => up(e.clientX, e.clientY));
      const pinchDist = (e) => Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
      this.root.addEventListener('touchstart', (e) => {
        if (isUI(e)) return;
        if (e.touches.length >= 2) {
          // 第二指按下 → 進入視野校正，取消單指拖曳
          drag = null;
          this._pinch = { d0: pinchDist(e), fov0: this.hfov };
          return;
        }
        const t = e.touches[0]; down(t.clientX, t.clientY);
      }, { passive: true });
      this.root.addEventListener('touchmove', (e) => {
        if (this._pinch && e.touches.length >= 2) {
          // 兩指拉開 = 放大（視野變窄）；捏合 = 縮小（視野變寬）。
          // 開相機時用這個把標籤位置校正到與實景對齊。
          const scale = this._pinch.d0 / pinchDist(e);
          this.setFov(this._pinch.fov0 * scale);
          this._showFovBadge();
          return;
        }
        if (!drag) return;
        const t = e.touches[0]; move(t.clientX, t.clientY);
      }, { passive: true });
      this.root.addEventListener('touchcancel', () => { drag = null; this._pinch = null; });
      this.root.addEventListener('touchend', (e) => {
        if (this._pinch) {
          if (e.touches.length < 2) {
            this._pinch = null;
            this._commitFov();   // 讓 app 存檔
          }
          return;
        }
        if (!drag) return;
        const t = e.changedTouches[0]; up(t.clientX, t.clientY);
      });

      // 控制列按鈕用 touchend 直接觸發（UI.bindTap），不能只靠 click ——
      // iOS 獨立模式的合成 click 不可靠，會變成「按了沒反應」。
      const bindBtn = (el, fn) => {
        if (global.UI && UI.bindTap) UI.bindTap(el, fn);
        else el.onclick = fn;
      };
      this.$sensorBtn = this.root.querySelector('[data-act="sensor"]');
      bindBtn(this.$sensorBtn, () => {
        if (this.usingSensor) this.disableSensor(); else this.enableSensor();
        setTimeout(() => this._syncControlState(), 50);
      });
      this.$camBtn = this.root.querySelector('[data-act="camera"]');
      bindBtn(this.$camBtn, () => this.toggleCamera());
      this.$fullBtn = this.root.querySelector('[data-act="full"]');
      bindBtn(this.$fullBtn, () => this.toggleFullscreen());
      document.addEventListener('fullscreenchange', () => {
        this._syncControlState();
        setTimeout(() => this._paint(), 100);
      });
      // 偽全螢幕沒有原生的 Esc 行為，自己補一個
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.root.classList.contains('ar-pseudo-full')) this._setPseudoFull(false);
      });
      // 尺寸/方向改變時重繪，避免殘留壞掉的版面。開相機時視窗長寬比
      // 變了，cover 裁切也跟著變，畫面視角要重算。
      const relayout = () => { if (this.camOn) this._applyCamFov(); this._paint(); };
      window.addEventListener('resize', relayout);
      window.addEventListener('orientationchange', () => { setTimeout(relayout, 250); });
      // 串流尺寸要等 metadata 才知道；轉向時串流也可能換成橫的
      this.$cam.addEventListener('loadedmetadata', () => { this._applyCamFov(); this._paint(); });
      this.$cam.addEventListener('resize', () => { this._applyCamFov(); this._paint(); });
    }

    /** 供外部（切回 AR 分頁時）重新繪製 */
    repaint() { this._paint(); }

    /** 設定目前的水平視野角（雙指縮放用）；垂直視野由畫面長寬比決定 */
    setFov(deg) {
      const v = Math.max(FOV_MIN, Math.min(FOV_MAX, Number(deg) || HFOV_DEFAULT));
      if (!this.camOn) this.baseHfov = v;
      if (v === this.hfov) return;
      this.hfov = v;
      this._paint();
    }

    /** 設定「沒開相機時」的視野（設定面板的數值）；開著相機時先記著 */
    setBaseFov(deg) {
      this.baseHfov = Math.max(FOV_MIN, Math.min(FOV_MAX, Number(deg) || HFOV_DEFAULT));
      if (!this.camOn) { this.hfov = this.baseHfov; this._paint(); }
    }

    /** 鏡頭長邊視角（設定值，可被雙指縮放校正） */
    _camLongFov() {
      const v = this.state && this.state.settings && Number(this.state.settings.camFov);
      return v > 10 && v < 170 ? v : CAM_FOV_DEFAULT;
    }

    /** 串流與視窗尺寸都已知時，回傳 {vw, vh, W, H}；否則 null */
    _camGeom() {
      const vw = this.$cam.videoWidth, vh = this.$cam.videoHeight;
      const W = this.root.clientWidth, H = this.root.clientHeight;
      return vw && vh && W && H ? { vw, vh, W, H } : null;
    }

    /**
     * 開相機時，把 AR 視野設成「相機畫面實際的視角」，標籤與山稜線
     * 才會疊在實景上。沒有這一步，預設 70° 會比真實畫面（直拿約 40°）
     * 寬將近一倍：偏離中心的山，標籤會往中間縮，對不上。
     */
    _applyCamFov() {
      if (!this.camOn) return;
      const g = this._camGeom();
      if (!g) return;
      this.hfov = Math.max(FOV_MIN, Math.min(FOV_MAX,
        camDisplayHfov(g.vw, g.vh, g.W, g.H, this._camLongFov())));
    }

    /** 雙指縮放結束：開相機時存成鏡頭視角，否則存成一般視野 */
    _commitFov() {
      const g = this.camOn && this._camGeom();
      if (g) {
        const L = camLongFov(g.vw, g.vh, g.W, g.H, this.hfov);
        if (this.h.onCamFov) this.h.onCamFov(L);
      } else if (this.h.onFov) {
        this.h.onFov(this.hfov);
      }
    }

    /** 外部改了鏡頭視角設定後呼叫 */
    refreshCamFov() { this._applyCamFov(); this._paint(); }

    /** 雙指縮放時短暫顯示目前視野角 */
    _showFovBadge() {
      if (!this.$fovBadge) {
        this.$fovBadge = document.createElement('div');
        this.$fovBadge.className = 'ar-fov-badge';
        this.root.appendChild(this.$fovBadge);
      }
      const g = this.camOn && this._camGeom();
      this.$fovBadge.textContent = g
        ? `相機視野 ${Math.round(this.hfov)}°（鏡頭 ${Math.round(camLongFov(g.vw, g.vh, g.W, g.H, this.hfov))}°）`
        : `視野 ${Math.round(this.hfov)}°`;
      this.$fovBadge.style.display = 'block';
      clearTimeout(this._fovBadgeTimer);
      this._fovBadgeTimer = setTimeout(() => { this.$fovBadge.style.display = 'none'; }, 1200);
    }

    /**
     * 重繪排程：把同一個 animation frame 內的多次要求合併成一次。
     * 羅盤事件約 60Hz，若每次都直接重繪，手機上會因為來不及畫而看起來卡住。
     */
    _paint() {
      if (this._paintPending) return;
      this._paintPending = true;
      const run = () => { this._paintPending = false; this._paintNow(); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 16);
    }

    /**
     * 天文計算快取。太陽/月亮/行星/星星的位置變化很慢，沒必要每一幀重算
     * （一次要跑 5 顆行星的 Kepler 迭代 + 50 幾顆星的座標轉換）。
     * 「現在」模式下每 20 秒換一次快取鍵，與 app.js 的天空更新節奏一致。
     */
    _skyData(st, me) {
      const timeKey = st.settings.skyTime || Math.floor(Date.now() / 20000);
      const key = [timeKey, me.lat.toFixed(3), me.lng.toFixed(3),
        st.settings.starMag, !!st.settings.showConstellations].join('|');
      if (this._skyCache && this._skyCache.key === key) return this._skyCache.val;
      const date = st.settings.skyTime ? new Date(st.settings.skyTime) : new Date();
      const val = {
        objs: Sky.skyObjects(date, me.lat, me.lng, {
          maxMag: st.settings.starMag != null ? st.settings.starMag : 2.2,
          constellations: !!st.settings.showConstellations,
        }),
        ecliptic: Sky.eclipticPath(date, me.lat, me.lng, 5),
        cons: st.settings.showConstellations ? Sky.constellationLines(date, me.lat, me.lng) : [],
      };
      this._skyCache = { key, val };
      return val;
    }

    /**
     * 全螢幕。iPhone Safari 沒有「元素」全螢幕 API（只有 video 能全螢幕），
     * 原本的寫法會被 `|| function(){}` 靜靜吞掉，按了完全沒反應。
     * 這裡在沒有原生 API（或呼叫被拒）時退回 CSS 偽全螢幕。
     */
    toggleFullscreen() {
      const el = this.root;
      const inNative = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (inNative) {
        (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
        return;
      }
      if (el.classList.contains('ar-pseudo-full')) { this._setPseudoFull(false); return; }

      // 獨立模式（加入主畫面）或明確不支援全螢幕的平台：直接走偽全螢幕。
      // iPhone 上 fullscreenEnabled 為 false，即使 API「存在」也不會動作。
      const standalone = navigator.standalone === true ||
        (global.matchMedia && matchMedia('(display-mode: standalone)').matches);
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (!req || standalone ||
          document.fullscreenEnabled === false || document.webkitFullscreenEnabled === false) {
        this._setPseudoFull(true);
        return;
      }
      let fell = false;
      const fallback = () => { if (!fell) { fell = true; this._setPseudoFull(true); } };
      try {
        const r = req.call(el);
        if (r && typeof r.catch === 'function') r.catch(fallback);
      } catch (_) { fallback(); return; }
      // 有些平台的 API 存在、呼叫也不報錯，但就是什麼都不發生（iPhone 對非
      // video 元素就是如此）。呼叫後驗證真的進了全螢幕，沒有就走偽全螢幕。
      setTimeout(() => {
        if (!document.fullscreenElement && !document.webkitFullscreenElement) fallback();
      }, 350);
    }

    _setPseudoFull(on) {
      this.root.classList.toggle('ar-pseudo-full', on);
      document.body.classList.toggle('ar-full-active', on);
      this._syncControlState();
      // 尺寸整個變了，等版面套用後再重繪
      setTimeout(() => this._paint(), 60);
    }

    /** 目前是否在全螢幕（原生或偽全螢幕皆算） */
    get isFullscreen() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement ||
        this.root.classList.contains('ar-pseudo-full'));
    }

    async enableSensor() {
      if (this.usingSensor) return;   // 已開啟就別重複註冊，否則每次事件都做兩份工
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          const p = await DeviceOrientationEvent.requestPermission();
          if (p !== 'granted') return notify('未授權方向感測器。請到 設定 → Safari → 動作與方向存取 開啟後重試。', 'warn');
        }
        // 兩種事件都要聽（iOS 只有 deviceorientation + webkitCompassHeading，
        // Android 多半是 deviceorientationabsolute），但只採用其中一種來源：
        // 絕對方位一旦到過就不再理會相對方位，否則兩邊互相覆蓋會左右跳動。
        // 只有在絕對方位「真的算得出方位角」時才切換到它。有些裝置會送出
        // alpha 為 null 的空事件，若無條件認定它可用，相對方位會被永久擋掉
        // ——羅盤就會完全不動。
        this._absSeen = false;
        this._onAbs = (e) => { if (this._onOrient(e)) this._absSeen = true; };
        this._onRel = (e) => { if (!this._absSeen) this._onOrient(e); };
        window.addEventListener('deviceorientationabsolute', this._onAbs, true);
        window.addEventListener('deviceorientation', this._onRel, true);
        this.usingSensor = true;
      } catch (err) { notify('此裝置不支援方向感測器', 'warn'); }
    }

    /** 關閉羅盤，回到拖曳操作 */
    disableSensor() {
      if (!this.usingSensor) return;
      window.removeEventListener('deviceorientationabsolute', this._onAbs, true);
      window.removeEventListener('deviceorientation', this._onRel, true);
      this.usingSensor = false;
      this._syncControlState();
      if (this.h.onSensorOff) this.h.onSensorOff();
      this._paint();
    }

    /** @returns {boolean} 這個事件是否真的提供了可用的方位角 */
    _onOrient(e) {
      // webkitCompassHeading（iOS）或 alpha（其他）
      let hd = (typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading))
        ? e.webkitCompassHeading
        : (e.alpha != null && isFinite(e.alpha) ? 360 - e.alpha : null);
      // 磁偏角修正：感測器給的是「磁北」方位，AR 的目標方位都是「真北」。
      // 台灣磁偏角約 -4.5°（西偏），不修正等於每個目標固定偏 4~5°。
      if (hd != null) {
        const decl = this.state && this.state.settings && isFinite(this.state.settings.declination)
          ? Number(this.state.settings.declination) : -4.5;
        hd = (hd + decl + 360) % 360;
      }
      // 圓周低通濾波，減少羅盤抖動（以 sin/cos 分量平滑角度）
      const A = 0.25;
      if (hd != null) {
        const rad = Geo.toRad((hd + 360) % 360);
        const prev = Geo.toRad(this.heading);
        const s = A * Math.sin(rad) + (1 - A) * Math.sin(prev);
        const c = A * Math.cos(rad) + (1 - A) * Math.cos(prev);
        this.heading = (Geo.toDeg(Math.atan2(s, c)) + 360) % 360;
      }
      if (e.beta != null && isFinite(e.beta)) {
        const target = clampPitch(e.beta - 90);
        this.pitch = A * target + (1 - A) * this.pitch; // 俯仰角低通
      }
      this._paint();
      // 地圖的方向跟隨也用同一個（已修正磁偏角、已濾波的）方位
      if (hd != null && this.h.onHeading) this.h.onHeading(this.heading);
      return hd != null;
    }

    /** 關閉相機並復原背景。開啟失敗時也走這裡收尾，避免卡在半開狀態。 */
    _stopCamera() {
      this.$cam.style.display = 'none';
      this.root.classList.remove('ar-cam-on');
      const s = this.$cam.srcObject;
      if (s && s.getTracks) s.getTracks().forEach((t) => t.stop());
      this.$cam.srcObject = null;
      this.camOn = false;
      this.hfov = this.baseHfov;      // 回到沒開相機時的視野
      this._syncControlState();
      this._paint();
    }

    async toggleCamera() {
      // 開關進行中就忽略，連點兩下會同時要到兩個串流、其中一個漏掉不會關
      if (this._camBusy) return;
      if (this.camOn) { this._stopCamera(); return; }
      this._camBusy = true;
      const standalone = navigator.standalone === true ||
        (global.matchMedia && matchMedia('(display-mode: standalone)').matches);
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          // 舊版 iOS 的「加入主畫面」獨立模式沒有 getUserMedia，
          // 這不是本 App 能繞過的 —— 給準確的替代路徑而不是泛泛的錯誤。
          throw new Error(standalone
            ? '此 iOS 版本在「加入主畫面」模式下不提供相機。請改用 Safari 直接開啟本網頁（相機在 Safari 中可用），或更新 iOS 後再試。'
            : '此瀏覽器不支援相機（請用 Safari/Chrome 並以 https 開啟）');
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
        this.camOn = true;
        try { await this.$cam.play(); } catch (_) { /* 部分瀏覽器 autoplay 屬性已接手 */ }
        this._applyCamFov();   // metadata 已到就馬上套用；還沒到的話 loadedmetadata 會再套一次
        this._syncControlState();
        this._paint();
      } catch (err) {
        this._stopCamera();   // 收乾淨，下次再按才不會以為已經開著
        const msg = (err && err.name === 'NotAllowedError')
          ? (standalone
              ? '相機權限被拒。iOS 的獨立模式每次啟動都會重新詢問相機權限——請再按一次「相機」並在跳出的詢問選「允許」；若沒有跳出詢問，請到 設定 → 隱私權與安全性 → 相機 檢查。'
              : '相機權限被拒。請在瀏覽器網址列的權限設定允許「相機」後再試。')
          : (err && (err.name === 'NotReadableError' || err.name === 'AbortError'))
            ? '相機被其它 App 佔用（或系統暫時鎖住）。請關掉其它使用相機的程式再試。'
            : (location.protocol !== 'https:'
                ? '相機需要 HTTPS。請用 https 的網址開啟。'
                : '無法開啟相機：' + (err && err.message ? err.message : err));
        // 用會停留的浮層說明原因——3 秒就消失的提示常常沒被看到，
        // 使用者只會留下「按了沒反應」的印象。
        if (global.UI && UI.alert) UI.alert('無法開啟相機', msg);
        else notify(msg, 'warn', 6000);
      } finally {
        this._camBusy = false;
      }
    }

    /** 讓控制列按鈕反映目前狀態（開著的用實心底色標示） */
    _syncControlState() {
      if (this.$sensorBtn) {
        this.$sensorBtn.classList.toggle('on', !!this.usingSensor);
        this.$sensorBtn.textContent = this.usingSensor ? '🧭 羅盤開' : '🧭 羅盤';
      }
      if (this.$camBtn) {
        this.$camBtn.classList.toggle('on', !!this.camOn);
        this.$camBtn.textContent = this.camOn ? '📷 相機開' : '📷 相機';
      }
      if (this.$fullBtn) {
        const f = this.isFullscreen;
        this.$fullBtn.classList.toggle('on', f);
        this.$fullBtn.textContent = f ? '✕ 離開全螢幕' : '⛶ 全螢幕';
      }
    }

    render(state) { this.state = state; this._paint(); }

    /**
     * 點擊 AR 畫面：選取點到的標籤，沒點中就選最近的。
     *
     * 標籤本身不接收觸控（pointer-events:none）—— 開羅盤時每秒重繪 60 次、
     * 標籤元素一直被換新，手指按下的那個元素放開前就被銷毀，事件會落在
     * 脫離 DOM 的節點上，點擊永遠不生效。所以一律由穩定的外層用座標判定。
     */
    _tap(clientX, clientY) {
      const r = this.root.getBoundingClientRect();
      const x = clientX - r.left, y = clientY - r.top;
      const targets = (this._placed || []).filter((c) => c.kind !== 'sky-con');
      // 先看有沒有直接點在標籤框內（標籤錨點在底部中央，往上約 40px）
      let hit = targets.find((c) =>
        Math.abs(x - c.xl) <= c.w / 2 + 6 && y <= c.y + 8 && y >= c.y - 46);
      if (!hit) {
        let bd = Infinity;
        targets.forEach((c) => {
          const d = Math.hypot(c.xl - x, (c.y - 20) - y);
          if (d < bd) { bd = d; hit = c; }
        });
        if (bd > 70) hit = null;
      }
      if (hit && this.h.onSelect) this.h.onSelect(hit.id);
    }

    /** 程式化轉向面對某方位/仰角（選取目標時用；感測器模式下不干預）。 */
    lookAt(bearingDeg, pitchDeg) {
      if (this.usingSensor) return;
      this.heading = (bearingDeg + 360) % 360;
      if (typeof pitchDeg === 'number') this.pitch = clampPitch(pitchDeg);
      this._paint();
    }

    _paintNow() {
      if (!this.state) return;
      // 視角被隱藏（切到地圖分頁）時尺寸為 0，若此時重繪會把版面算壞，
      // 導致切回來「一半黑」。直接略過，等重新可見時再繪。
      if (!this.root.clientWidth || !this.root.clientHeight) return;
      const st = this.state;
      const me = st.me;
      const H = this.root.clientHeight;
      const W = this.root.clientWidth;

      // 透視投影（與相機成像一致）；垂直視野由畫面長寬比決定
      const proj = makeProjection(this.heading, this.pitch, this.hfov, W, H);
      this.vfov = proj.vfov;

      // 天空/地面：地平線隨俯仰角上下移動（大幅低頭/抬頭時夾在合理範圍）
      const horizonY = Math.max(-4 * H, Math.min(5 * H, proj.horizonY));
      this.$sky.style.height = `${Math.max(0, horizonY)}px`;
      this.root.querySelector('.ar-horizon').style.top = `${horizonY}px`;
      this.root.querySelector('.ar-ground').style.top = `${horizonY}px`;

      this._paintCompass(proj, W, horizonY);

      const angDiff = (a) => ((a - this.heading + 540) % 360) - 180;
      const obsAlt = (me.alt || 0) + (me.antenna || 0);
      // 投影點是否在畫面內（含邊緣緩衝，讓剛好在邊上的標籤仍能夾進畫面）
      const onScreen = (p, mx, my) => p.front && p.x > -mx && p.x < W + mx && p.y > -my && p.y < H + my;
      let aim = null;
      const cand = [];

      // 0) 山體輪廓（天際線）：先畫，之後標籤的引線會落在稜線上而不是地平線
      const sl = st.skyline;
      const E = global.Elevation;
      this._paintSkyline(sl, angDiff, proj, W, H);
      // 標籤引線的落點：有輪廓就用稜線高度，沒有就退回地平線
      const groundYAt = (az) => {
        const e = E ? E.skylineElevAt(sl, az) : null;
        if (e == null) return horizonY;
        const p = proj(az, e);
        return p.front ? Math.min(H, p.y) : horizonY;
      };
      const canHide = !!(E && sl && sl.bp && isFinite(sl.obsAlt));

      // 1a) 陸地目標（山 / 站臺 / 自訂標註）；被隱藏的群組不畫
      const land = [...st.stations, ...st.peaks, ...(st.markers || [])];
      const hidden = (st.settings && st.settings.hiddenGroups) || [];
      (global.Groups ? Groups.visible(land, hidden) : land).forEach((t) => {
        const brg = Geo.bearing(me, t);
        if (Math.abs(angDiff(brg)) > 95) return;       // 在背後
        const dist = Geo.distance(me, t);
        const tgtTop = Geo.targetTopAlt(t, st.settings.tgtAntenna);
        const elev = Geo.elevationAngle(obsAlt, tgtTop, dist, st.settings.withCurvature, K_DISPLAY);
        const pt = proj(brg, elev);
        if (!onScreen(pt, 30, 60)) return;
        const selected = t.id === st.selectedId;
        const a = st.analysisById[t.id];
        const status = a ? (a.clear ? 'ok' : a.losClear ? 'marg' : 'bad') : '';
        const blocked = a && !a.losClear;
        const isMarker = t.type === 'marker';
        const gcolor = global.Groups ? Groups.colorOf(t) : '#9fb0c0';
        // 被更近的稜線擋住、肉眼看不到？用輪廓的觀測高度重算仰角，
        // 與稜線同一個基準比較才公平。
        const behind = canHide && E.skylineHides(sl, brg, dist,
          Geo.elevationAngle(sl.obsAlt, tgtTop, dist, true, K_DISPLAY)) === true;
        const sub = isMarker
          ? `${Geo.fmtDistance(dist)}${t.note ? ' · ' + t.note : ''}`
          : `${Math.round(tgtTop)} m · ${Geo.fmtDistance(dist)}`;
        cand.push({
          id: t.id, name: (isMarker && t.icon ? t.icon + ' ' : '') + t.name,
          kind: t.type, selected, status, stick: true, custom: !!t.custom, behind,
          x: pt.x, y: pt.y, stickTo: groundYAt(brg), gcolor,
          sub: behind ? '被山擋住 · ' + sub : sub,
          // 看得到的優先佔位置；被擋住的在擁擠時讓出來
          prio: (selected ? 1e9 : 0)
            + (t.type === 'station' ? 1e6 : isMarker ? 5e5 : 0)
            + (behind ? -4e5 : 0)
            + tgtTop - dist / 1000,
          readout: () => this._geoReadout(t, dist, brg, elev, blocked, behind),
          color: blocked ? '#e23b3b' : gcolor,
        });
      });

      // 1b) 天文層（太陽/月亮/行星/星星）+ 黃道線
      if (st.settings.showSky && global.Sky) {
        const sky = this._skyData(st, me);
        this._paintEcliptic(sky.ecliptic, proj, W, H);
        // 星座連線（北斗七星、獵戶座…）＋ 星座名稱標籤
        if (st.settings.showConstellations) {
          const cons = sky.cons;
          this._paintConstellations(cons, proj, W, H);
          cons.forEach((c) => {
            if (c.label.alt < 0) return;
            const pt = proj(c.label.az, c.label.alt);
            if (!onScreen(pt, 0, 0)) return;
            cand.push({
              id: 'con-' + c.id, name: c.name, kind: 'sky-con', selected: false, stick: false,
              x: pt.x, y: pt.y,
              // 排在所有恆星之上（亮星最高約 1.03e5）：星座名是整組的抬頭，
              // 被其中一顆星的名字擠掉的話就白畫了。行星(2e5)仍優先於它。
              sub: '星座', prio: 1.5e5,
              readout: () => `<div class="ro-name">${c.name}</div><div class="ro-line">星座 / 星群連線</div>`,
              color: '#9ad0ff',
            });
          });
        } else {
          this.$constel.innerHTML = '';
        }
        sky.objs.forEach((o) => {
          if (o.alt < -2) return;                        // 地平線下不畫
          const pt = proj(o.az, o.alt);
          if (!onScreen(pt, 30, 30)) return;
          const selected = o.id === st.selectedId;
          const pr = o.type === 'sun' || o.type === 'moon' ? 5e5 : o.type === 'planet' ? 2e5 : 1e5 - (o.mag || 0) * 1000;
          cand.push({
            id: o.id, name: o.name, kind: 'sky-' + o.type, selected, stick: false,
            x: pt.x, y: pt.y,
            sub: `方位 ${Math.round(o.az)}° · 仰角 ${o.alt.toFixed(0)}°`,
            prio: (selected ? 1e9 : 0) + pr,
            readout: () => this._skyReadout(o),
            color: '#ffd36b',
          });
        });
      } else {
        this.$ecliptic.innerHTML = '';
        this.$constel.innerHTML = '';
      }

      // 1c) 衛星（如 ISS）— 獨立於天空開關
      if (st.satellites && st.satellites.length) {
        st.satellites.forEach((o) => {
          if (o.alt < -2) return;
          const pt = proj(o.az, o.alt);
          if (!onScreen(pt, 30, 30)) return;
          const selected = o.id === st.selectedId;
          cand.push({
            id: o.id, name: o.name, kind: 'sky-sat', selected, stick: false,
            x: pt.x, y: pt.y,
            sub: o.orbit === 'GEO' ? `同步·固定 仰角 ${o.alt.toFixed(0)}°`
              : `仰角 ${o.alt.toFixed(0)}° · ${Math.round(o.rangeKm)} km${o.nakedEye ? ' · ✨可見' : ''}`,
            prio: (selected ? 1e9 : 0) + 3e5,
            readout: () => this._skyReadout(o), color: '#7dffcf',
          });
        });
      }

      // 2) 去重疊
      // 用「估算出來的標籤實際寬度」判斷，而不是固定的像素門檻——固定門檻是照
      // 桌面寬度調的，在手機上會讓一堆名字疊在一起。
      // 另外要用「夾到畫面內之後」的 x 來判斷：擠在邊緣的標籤會被夾到同一個
      // 位置，用夾擠前的座標判斷就看不出它們其實重疊了。
      cand.forEach((c) => {
        c.w = Math.max(textWidth(c.name, 15), textWidth(c.sub, 11)) + 16;
        // 依標籤自己的寬度夾進畫面：固定邊距的話，長的說明文字會被切掉一截
        const half = Math.min(c.w / 2 + 4, W / 2);
        c.xl = Math.max(half, Math.min(W - half, c.x));
      });
      const placed = [];
      cand.sort((a, b) => b.prio - a.prio).forEach((c) => {
        const hit = placed.some((p) =>
          Math.abs(p.xl - c.xl) < (p.w + c.w) / 2 && Math.abs(p.y - c.y) < 40);
        if (!c.selected && hit) return;
        placed.push(c);
        if (c.selected) aim = c;
      });

      // 3) 依 x 由左到右輸出
      // 標籤本體夾在畫面內（否則邊緣的名稱會被切掉或被迫換行），
      // 但引線仍畫在真正的方位上，指的還是同一座山。
      const html = placed.slice().sort((a, b) => a.x - b.x).map((c) => {
        const cls = `arlbl arlbl-${c.kind}${c.selected ? ' arlbl-sel' : ''}${c.status ? ' arlbl-' + c.status : ''}` +
          `${c.custom ? ' arlbl-custom' : ''}${c.behind ? ' arlbl-behind' : ''}`;
        const xl = c.xl;
        // 引線拉到該方位的稜線上（沒有輪廓資料時退回地平線）
        const foot = c.stickTo != null ? c.stickTo : horizonY;
        const dx = (c.x - xl).toFixed(1);
        // 被山擋住的目標：標籤就放在它真正的方向上（落在山體裡、半透明），
        // 不畫引線 —— 引線是「從稜線往上指到目標」，對它不成立。
        const stick = c.stick && !c.behind
          ? `<i class="arlbl-stick" style="height:${Math.max(8, foot - c.y)}px;` +
            `left:calc(50% + ${dx}px);background:${c.gcolor || 'rgba(255,255,255,.55)'}"></i>`
          : '';
        // 群組色點：站臺的「通/繞/擋」用名稱顏色表示，群組則用這個色點區分
        const dot = c.gcolor ? `<i class="arlbl-dot" style="background:${c.gcolor}"></i>` : '';
        return `<div class="${cls}" style="left:${xl}px;top:${c.y}px" data-id="${c.id}">` +
          `<span class="arlbl-name">${dot}${c.name}</span><span class="arlbl-sub">${c.sub}</span>${stick}</div>`;
      });

      this.$labels.innerHTML = html.join('');
      this._placed = placed; // 供點擊判定用（見 _tap）

      this._paintAim(aim, W, H);

      // 對準 HUD：手機當天線仰角/方位對準器
      const selTgt = [...st.stations, ...st.peaks, ...(st.markers || [])].find((t) => t.id === st.selectedId);
      this._paintAimHud(selTgt, me, st, proj);
    }

    // 對準 HUD：把手機當成天線對準器，即時比對「目前朝向」與「目標仰角/方位」
    _paintAimHud(target, me, st, proj) {
      if (!target) { this.$aimhud.style.display = 'none'; this.$dir.style.display = 'none'; return; }
      const brg = Geo.bearing(me, target);
      const dist = Geo.distance(me, target);
      const obsAlt = (me.alt || 0) + (me.antenna || 0);
      const elev = Geo.elevationAngle(obsAlt, Geo.targetTopAlt(target, st.settings.tgtAntenna), dist, st.settings.withCurvature, K_DISPLAY);
      const dAz = ((brg - this.heading + 540) % 360) - 180; // 正=目標在右
      const dEl = elev - this.pitch;                          // 正=需抬高
      const azOK = Math.abs(dAz) <= 3, elOK = Math.abs(dEl) <= 1;
      const elMsg = elOK ? '✅ 對準' : (dEl > 0 ? '抬高 ▲ ' + Math.abs(dEl).toFixed(1) + '°' : '壓低 ▼ ' + Math.abs(dEl).toFixed(1) + '°');
      const azMsg = azOK ? '✅ 對準' : (dAz > 0 ? '右轉 ▶ ' + Math.abs(Math.round(dAz)) + '°' : '左轉 ◀ ' + Math.abs(Math.round(dAz)) + '°');
      // 目標在螢幕上的方向向量（右、下為正），用來畫指向箭頭
      const W = this.root.clientWidth, H = this.root.clientHeight;
      const pt = proj ? proj(brg, elev) : { front: false };
      let vx, vy;
      if (pt.front) { vx = pt.x - W / 2; vy = pt.y - H / 2; }
      else {
        // 在背後：投影沒有意義，改用角度差決定箭頭方向，並確保判定為畫面外
        vx = (dAz / (this.hfov / 2)) * (W / 2);
        vy = (-dEl / (this.vfov / 2)) * (H / 2);
        const m = Math.max(Math.abs(vx) / (W / 2), Math.abs(vy) / (H / 2), 1e-6);
        if (m < 1.2) { vx *= 1.2 / m; vy *= 1.2 / m; }
      }
      const theta = Math.atan2(vy, vx) * 180 / Math.PI;      // 0°=右、90°=下
      const arrowRot = theta + 90;                            // 箭頭圖預設朝上
      const locked = azOK && elOK;
      const offscreen = Math.abs(vx) > W / 2 - 24 || Math.abs(vy) > H / 2 - 24;
      this._paintDirArrow(target, offscreen && !locked, theta, W, H, dAz, dEl);

      const hudArrow = locked ? '<span class="hud-arrow ok">●</span>'
        : `<svg class="hud-arrow" viewBox="-12 -12 24 24" style="transform:rotate(${arrowRot.toFixed(1)}deg)">` +
          `<path d="M0 -10 L7 4 L2 2 L2 10 L-2 10 L-2 2 L-7 4 Z" fill="#ffd36b" stroke="#1a1200" stroke-width="1"/></svg>`;

      this.$aimhud.style.display = 'block';
      this.$aimhud.innerHTML =
        `<div class="hud-name">${hudArrow}🎯 ${target.name} · ${Geo.fmtDistance(dist)}</div>` +
        `<div class="hud-row ${elOK ? 'hud-ok' : ''}"><span class="hud-k">仰角</span>` +
        `目前 <b>${this.pitch.toFixed(1)}°</b> → 目標 <b>${elev.toFixed(1)}°</b>` +
        `<span class="hud-d">${elMsg}</span></div>` +
        `<div class="hud-row ${azOK ? 'hud-ok' : ''}"><span class="hud-k">方位</span>` +
        `目前 <b>${Math.round(this.heading)}°</b> → 目標 <b>${Math.round(brg)}° ${Geo.compass8(brg)}</b>` +
        `<span class="hud-d">${azMsg}</span></div>` +
        (azOK && elOK ? `<div class="hud-locked">🔒 已對準目標！</div>` : '') +
        (!this.usingSensor ? `<div class="hud-note">桌機為模擬值；手機請按 🧭 羅盤，「目前」才是手機真實朝向</div>` : '');
    }

    /**
     * 目標不在畫面內時，在畫面邊緣畫一個大箭頭指向它（像導航 App 那樣），
     * 箭頭旁寫「右轉 127°」之類的提示。目標進到畫面內就收起來，改由瞄準圈標示。
     */
    _paintDirArrow(target, show, theta, W, H, dAz, dEl) {
      if (!show) { this.$dir.style.display = 'none'; return; }
      const rad = theta * Math.PI / 180;
      const rx = W / 2 - 46, ry = H / 2 - 70;
      // 沿橢圓放在邊緣附近；目標在正後方時（|dAz|>90）往左右邊緣靠
      const cx = W / 2 + rx * Math.cos(rad), cy = H / 2 + ry * Math.sin(rad);
      const turn = Math.abs(dAz) >= 3
        ? (dAz > 0 ? `右轉 ${Math.round(Math.abs(dAz))}°` : `左轉 ${Math.round(Math.abs(dAz))}°`) : '';
      const tilt = Math.abs(dEl) >= 1 ? (dEl > 0 ? `抬高 ${Math.abs(dEl).toFixed(0)}°` : `壓低 ${Math.abs(dEl).toFixed(0)}°`) : '';
      const hint = [turn, tilt].filter(Boolean).join('・');
      // 說明文字比箭頭寬，箭頭貼在左右邊緣時會被切掉：把文字往畫面內推
      const tw = Math.max(textWidth(target.name, 12), textWidth(hint, 12)) + 18;
      const shift = Math.max(6 - (cx - tw / 2), Math.min(0, W - 6 - (cx + tw / 2)));
      this.$dir.style.display = 'block';
      this.$dir.style.left = cx.toFixed(1) + 'px';
      this.$dir.style.top = cy.toFixed(1) + 'px';
      this.$dir.innerHTML =
        `<svg class="ar-dir-arrow" viewBox="-30 -30 60 60" style="transform:rotate(${(theta + 90).toFixed(1)}deg)">` +
        `<circle r="27" fill="rgba(8,12,20,.6)" stroke="#ffd36b" stroke-width="2"/>` +
        `<path d="M0 -20 L13 2 L4 0 L4 18 L-4 18 L-4 0 L-13 2 Z" fill="#ffd36b"/></svg>` +
        `<div class="ar-dir-txt" style="transform:translateX(${shift.toFixed(1)}px)">${target.name}<br>${hint}</div>`;
    }

    _paintCompass(proj, W, horizonY) {
      const ticks = [];
      for (let b = 0; b < 360; b += 15) {
        const p = proj(b, 0);
        if (!p.front || p.x < -10 || p.x > W + 10) continue;
        const x = p.x;
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

    _geoReadout(t, dist, brg, elev, blocked, behind) {
      const analyzed = this.state && this.state.analysisById[t.id];
      const los = analyzed
        ? (blocked ? '<div class="ro-line"><span class="ro-blocked">⛰️ 視線被地形遮蔽</span></div>'
                   : '<div class="ro-line"><span class="ro-clear">✓ 視線淨空</span></div>')
        : (behind ? '<div class="ro-line"><span class="ro-blocked">⛰️ 被前方山稜擋住，肉眼看不到</span></div>' : '');
      const top = Geo.targetTopAlt(t, (this.state && this.state.settings.tgtAntenna) || 0);
      const altTxt = Geo.usesTrueAlt(t)
        ? `真實高度：${Math.round(top).toLocaleString()} m`
        : `海拔：${Math.round(top).toLocaleString()} m`;
      const grp = global.Groups ? Groups.nameOf(t) : '';
      const meta = (grp ? `<div class="ro-line ro-meta">群組：${grp}` +
        (t.type === 'marker' && t.note ? `　${t.note}` : '') + '</div>' : '');
      return `<div class="ro-name">${(t.type === 'marker' && t.icon ? t.icon + ' ' : '')}${t.name}</div>` +
        `<div class="ro-line">${altTxt}　距離：${Geo.fmtDistance(dist)}</div>` +
        `<div class="ro-line">方位：${Math.round(brg)}° ${Geo.compass8(brg)}　仰角：${elev.toFixed(1)}°</div>` +
        los + meta;
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

    /**
     * 山體輪廓：沿著天際線（每個方位的稜線仰角）畫出山形，並填滿下方山體。
     * 稜線本身依「該稜線離我多遠」上色 —— 近的暖、遠的冷 —— 所以一眼看得出
     * 哪一道稜線在前、哪一道在後。
     */
    _paintSkyline(skyline, angDiff, proj, W, H) {
      const pts = skyline && skyline.points;
      if (!pts || !pts.length) { this.$skyline.innerHTML = ''; return; }

      // 取視野內（含左右緩衝）的點，依「相對視線的方位差」由左到右排好。
      // 稜線仰角都不高，透視投影下 ±(半視野+15°) 一定涵蓋整個畫面寬。
      const lim = this.hfov / 2 + 15;
      const vis = [];
      pts.forEach((p) => {
        if (p.elev == null) return;
        const d = angDiff(p.az);
        if (Math.abs(d) > lim) return;
        const q = proj(p.az, p.elev);
        if (q.front) vis.push({ d, x: q.x, y: q.y, dist: p.dist });
      });
      vis.sort((a, b) => a.d - b.d);
      if (vis.length < 2) { this.$skyline.innerHTML = ''; return; }
      const xy = (p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;

      // 山體：稜線 → 往下包到畫面底部，形成填滿的山塊
      const bottom = H + 4;
      const fill = vis.map(xy).join(' ') +
        ` ${vis[vis.length - 1].x.toFixed(1)},${bottom} ${vis[0].x.toFixed(1)},${bottom}`;

      // 稜線依距離上色（近 15km 暖色 → 遠 80km 冷色）。顏色分階，
      // 同色的相鄰線段併成一條折線 —— 720 個方位逐段畫的話每幀上百個元素。
      const runs = [];
      let cur = null;
      for (let i = 1; i < vis.length; i++) {
        const a = vis[i - 1], b = vis[i];
        const col = ridgeColor(((a.dist || 0) + (b.dist || 0)) / 2);
        if (!cur || cur.col !== col) { cur = { col, pts: [xy(a)] }; runs.push(cur); }
        cur.pts.push(xy(b));
      }

      this.$skyline.setAttribute('viewBox', `0 0 ${W} ${H}`);
      this.$skyline.innerHTML =
        `<defs><linearGradient id="sl-fill" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="#2b3546" stop-opacity="0.92"/>` +
        `<stop offset="100%" stop-color="#141a24" stop-opacity="0.98"/>` +
        `</linearGradient></defs>` +
        `<polygon points="${fill}" fill="url(#sl-fill)"/>` +
        runs.map((r) => `<polyline points="${r.pts.join(' ')}" fill="none" stroke="${r.col}" ` +
          `stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
    }

    /** 星座連線：把每組星座的線段畫出來，並在星點上加圈標示 */
    _paintConstellations(cons, proj, W, H) {
      if (!cons || !cons.length) { this.$constel.innerHTML = ''; return; }
      const near = (p, m) => p.front && p.x > -m && p.x < W + m && p.y > -m && p.y < H + m;
      const parts = [];
      cons.forEach((c) => {
        const dash = c.dashed ? ' stroke-dasharray="5 5"' : '';
        const stroke = c.dashed ? '#7fa8d8' : '#9ad0ff';
        c.segments.forEach((s) => {
          // 兩端都在地平線上、都在前方，且至少一端在畫面附近，才畫這一段
          if (s.a.alt < -1 || s.b.alt < -1) return;
          const a = proj(s.a.az, s.a.alt), b = proj(s.b.az, s.b.alt);
          if (!a.front || !b.front || (!near(a, W) && !near(b, W))) return;
          parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" ` +
            `x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" ` +
            `stroke="${stroke}" stroke-width="2" opacity="0.85"${dash}/>`);
        });
        c.stars.forEach((s) => {
          if (s.alt < -1) return;
          const p = proj(s.az, s.alt);
          if (!near(p, 10)) return;
          const r = Math.max(2.2, 4.8 - (s.mag || 2) * 0.7);
          parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" ` +
            `r="${r.toFixed(1)}" fill="#eaf4ff" opacity="0.95"/>`);
        });
      });
      this.$constel.setAttribute('viewBox', `0 0 ${W} ${H}`);
      this.$constel.innerHTML = parts.join('');
    }

    // 畫黃道線（在視野內的連續段）
    _paintEcliptic(pts, proj, W, H) {
      let d = '', pen = false;
      pts.forEach((p) => {
        const q = p.alt > -20 ? proj(p.az, p.alt) : { front: false };
        if (q.front && q.x > -W && q.x < 2 * W && q.y > -H && q.y < 2 * H) {
          d += (pen ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1) + ' ';
          pen = true;
        } else { pen = false; }
      });
      this.$ecliptic.setAttribute('viewBox', `0 0 ${W} ${H}`);
      this.$ecliptic.innerHTML = d ? `<path d="${d}" fill="none" stroke="#e0a94a" stroke-width="2" stroke-dasharray="2 4" opacity="0.8"/>` : '';
    }
  }

  // 純函式另外掛出來，方便單元測試
  ARView.makeProjection = makeProjection;
  ARView.camDisplayHfov = camDisplayHfov;
  ARView.camLongFov = camLongFov;
  ARView.CAM_FOV_DEFAULT = CAM_FOV_DEFAULT;
  global.ARView = ARView;
})(typeof window !== 'undefined' ? window : globalThis);
