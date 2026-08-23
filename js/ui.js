/*
 * ui.js — 輕量對話框與提示
 * ------------------------------------------------------------------
 * 取代瀏覽器內建的 alert / confirm / prompt。
 *
 * 為什麼要自己做：本 App 支援「加入主畫面」以獨立模式執行，而 iOS 在
 * 獨立模式下對這三個內建對話框的支援一向不可靠（可能直接被忽略，按了
 * 就像沒反應）。改用自繪的浮層才能保證在手機上一定看得到、按得到。
 *
 * 全部回傳 Promise，呼叫端用 await 即可。
 */
(function (global) {
  'use strict';

  const doc = global.document;
  let host = null;

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = doc.createElement('div');
    host.className = 'ui-host';
    doc.body.appendChild(host);
    return host;
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /**
   * 顯示一個浮層。resolve 由 buttons 的 value 決定，點背景等同取消。
   * @param opts.title   標題
   * @param opts.body    說明文字（可省）
   * @param opts.input   有給就顯示輸入框，值為預設內容
   * @param opts.placeholder 輸入框提示
   * @param opts.buttons [{ label, value, kind }]，kind: 'primary'|'danger'|''
   * @param opts.cancelValue 點背景/Esc 時回傳的值
   */
  function modal(opts) {
    const h = ensureHost();
    return new Promise((resolve) => {
      const wrap = doc.createElement('div');
      wrap.className = 'ui-modal';
      const hasInput = opts.input !== undefined && opts.input !== null;
      wrap.innerHTML =
        `<div class="ui-card" role="dialog" aria-modal="true">` +
        `<div class="ui-title">${esc(opts.title)}</div>` +
        (opts.body ? `<div class="ui-body">${esc(opts.body)}</div>` : '') +
        (hasInput ? `<input class="ui-input" type="text" value="${esc(opts.input)}" ` +
          `placeholder="${esc(opts.placeholder || '')}" />` : '') +
        `<div class="ui-btns">` +
        (opts.buttons || []).map((b, i) =>
          `<button data-i="${i}" class="ui-btn ${b.kind || ''}">${esc(b.label)}</button>`).join('') +
        `</div></div>`;
      h.appendChild(wrap);

      const input = wrap.querySelector('.ui-input');
      const done = (v) => {
        doc.removeEventListener('keydown', onKey, true);
        wrap.remove();
        resolve(v);
      };
      const cancel = () => done(opts.cancelValue !== undefined ? opts.cancelValue : null);

      wrap.querySelectorAll('.ui-btn').forEach((b) => {
        b.onclick = () => {
          const spec = opts.buttons[Number(b.dataset.i)];
          done(spec.value !== undefined ? spec.value : (input ? input.value : true));
        };
      });
      // 點卡片外面 = 取消
      wrap.addEventListener('click', (e) => { if (e.target === wrap) cancel(); });
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        else if (e.key === 'Enter' && input) {
          e.preventDefault();
          const primary = (opts.buttons || []).find((b) => b.kind === 'primary');
          done(primary && primary.value !== undefined ? primary.value : input.value);
        }
      };
      doc.addEventListener('keydown', onKey, true);

      if (input) {
        // iOS 需要在浮層真的顯示後才 focus 得起來
        setTimeout(() => { input.focus(); input.select(); }, 40);
      }
    });
  }

  /** 詢問一段文字，取消回傳 null */
  function ask(title, defaultValue = '', placeholder = '') {
    return modal({
      title, input: defaultValue, placeholder, cancelValue: null,
      buttons: [{ label: '取消', value: null }, { label: '確定', kind: 'primary' }],
    });
  }

  /** 是/否確認 */
  function confirm(title, body = '', okLabel = '確定', danger = false) {
    return modal({
      title, body, cancelValue: false,
      buttons: [{ label: '取消', value: false },
        { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' }],
    });
  }

  /** 只是告知一件事 */
  function alert(title, body = '') {
    return modal({ title, body, cancelValue: true, buttons: [{ label: '知道了', value: true, kind: 'primary' }] });
  }

  /** 短暫提示，不打斷操作。kind: '' | 'ok' | 'warn' */
  function toast(msg, kind = '', ms = 3200) {
    const h = ensureHost();
    const el = doc.createElement('div');
    el.className = `ui-toast ${kind}`;
    el.textContent = msg;
    h.appendChild(el);
    setTimeout(() => el.classList.add('out'), Math.max(400, ms - 300));
    setTimeout(() => el.remove(), ms);
    return el;
  }

  global.UI = { modal, ask, confirm, alert, toast };
})(typeof window !== 'undefined' ? window : globalThis);
