'use strict';
/* 自动检测 JSON 页面并接管渲染（模拟 Firefox 内置 JSON 查看器）。 */
(() => {
  if (window.__JV_CONTENT_LOADED__) return;
  window.__JV_CONTENT_LOADED__ = true;
  if (window.top !== window) return;

  const JV = window.__JSON_VIEWER__;
  if (!JV || JV.isActive()) return;

  const FORCE = (location.hash || '').indexOf('__jv_force') !== -1; // 测试钩子
  const ct = (document.contentType || '').toLowerCase();
  const jsonType = FORCE ||
    ct === 'application/json' ||
    ct === 'text/json' ||
    /^application\/[\w.+-]+\+json$/.test(ct);

  function findJsonText() {
    let best = '';
    const pres = document.querySelectorAll('pre');
    for (const p of pres) {
      const t = p.textContent || '';
      if (t.trim().length > best.trim().length) best = t;
    }
    if (jsonType) {
      if (best.trim()) return best;
      const bt = document.body ? (document.body.textContent || '') : '';
      return bt.trim() ? bt : null;
    }
    if (ct === 'text/plain') {
      // 仅当页面几乎只有一个 <pre> 时才认为是 JSON 文本
      if (!best.trim() || !document.body) return null;
      for (const child of document.body.children) {
        if (child.tagName === 'PRE') continue;
        if ((child.textContent || '').trim() !== '') return null;
      }
      return best;
    }
    return null;
  }

  function attempt() {
    const raw = findJsonText();
    if (raw == null) return 'wait';
    const t = raw.trim();
    if (!t) return 'wait';
    if (!jsonType && !/^[[{]/.test(t)) return 'fail';
    let data;
    try { data = JSON.parse(t); } catch (e) { return 'fail'; }
    JV.render({ data, rawText: t });
    return 'ok';
  }

  let res = attempt();
  if (res === 'wait') {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const r = attempt();
      if (r !== 'wait' || tries >= 30) clearInterval(timer);
    }, 100);
  }
})();
