'use strict';
/* 工具栏图标触发：未美化时强制美化当前页；已美化时切换 树形/原始 视图。 */
(() => {
  const JV = window.__JSON_VIEWER__;
  if (!JV) return;
  if (JV.isActive()) {
    JV.toggleRaw();
    return;
  }

  let text = '';
  const pre = document.querySelector('pre');
  if (pre && pre.textContent && pre.textContent.trim()) text = pre.textContent;
  if (!text && document.body) text = document.body.innerText || '';
  const t = text.trim();
  if (!/^[[{]/.test(t)) {
    JV.notify('未检测到 JSON 内容');
    return;
  }
  let data;
  try {
    data = JSON.parse(t);
  } catch (e) {
    JV.notify('JSON 解析失败：' + e.message);
    return;
  }
  try {
    JV.render({ data, rawText: t });
  } catch (e) {
    JV.notify('渲染失败：' + e.message);
  }
})();
