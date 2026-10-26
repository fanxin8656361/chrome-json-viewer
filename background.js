// 点击工具栏图标：未美化的页面强制美化；已美化的页面切换 树形/原始 视图。
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/viewer.css'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/viewer.js', 'src/manual.js'],
    });
  } catch (e) {
    // chrome:// 等受限页面无法注入，忽略
    console.warn('JSON Beautifier inject failed:', e);
  }
});
