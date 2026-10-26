'use strict';
/* JSON 树形渲染器：由 content.js（自动接管）和 manual.js（手动触发）共用。
 * 对外暴露 window.__JSON_VIEWER__：render / isActive / toggleRaw / notify。 */
(() => {
  if (window.__JSON_VIEWER__) return;

  const MAX_NODES = 60000;   // 展开渲染的节点上限，防止超大 JSON 卡死页面
  const MAX_STRING = 20000;  // 超长字符串先截断显示，可点击展开
  const DEFAULT_BUDGET = 25000; // 首屏默认展开的节点预算，超过则降低默认展开深度

  const state = {
    active: false,
    data: null,
    rawText: '',
    mode: 'tree',
    rootRec: null,
    pathMap: new Map(),
    nodeCount: 0,
    truncated: false,
    sizeBytes: 0,
    currentPath: '$',
    defaultDepth: 2,
    els: {},
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    switch (typeof v) {
      case 'object': return 'object';
      case 'string': return 'string';
      case 'number': return 'number';
      case 'boolean': return 'boolean';
      default: return 'undefined';
    }
  }

  function isContainerType(t) { return t === 'object' || t === 'array'; }

  function countEntries(v) {
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
    return 0;
  }

  // 按节点预算自适应默认展开深度：统计各层节点数，取累计不超预算的最大深度（上限 3 层）
  function computeDefaultDepth(data) {
    const counts = [];
    let frontier = [data];
    let scanned = 0;
    for (let d = 0; frontier.length && d <= 3; d++) {
      counts[d] = frontier.length;
      const next = [];
      for (const v of frontier) {
        if (Array.isArray(v)) for (const x of v) next.push(x);
        else if (v && typeof v === 'object') for (const k in v) next.push(v[k]);
      }
      scanned += next.length;
      frontier = next;
      if (scanned > 300000) break; // 足够判断即可
    }
    let acc = 0;
    let depth = 0;
    for (let d = 0; d < counts.length; d++) {
      if (acc + counts[d] > DEFAULT_BUDGET) break;
      acc += counts[d];
      depth = d;
    }
    return depth;
  }

  function pathToString(path) {
    let s = '$';
    for (const seg of path) {
      if (typeof seg === 'number') s += '[' + seg + ']';
      else if (/^[A-Za-z_$][\w$]*$/.test(seg)) s += '.' + seg;
      else s += '[' + JSON.stringify(seg) + ']';
    }
    return s;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) {
      const ta = el('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;top:-999px;opacity:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  function toast(msg) {
    let host = state.els.app;
    if (!host) {
      host = el('div');
      host.id = 'jv-root';
      document.body.appendChild(host);
      setTimeout(() => host.remove(), 1600);
    }
    const t = el('div', 'jv-toast', msg);
    host.appendChild(t);
    setTimeout(() => t.classList.add('jv-toast-out'), 1100);
    setTimeout(() => t.remove(), 1550);
  }

  function valueText(v) {
    const t = typeOf(v);
    if (t === 'string') return JSON.stringify(v);
    if (t === 'undefined') return 'undefined';
    return String(v);
  }

  function register(path, rec) {
    rec.path = path;
    rec.pathString = pathToString(path);
    state.pathMap.set(rec.pathString, rec);
    return rec;
  }

  /* ---------- 树构建 ---------- */

  function buildPrimitiveValue(value, type, hasComma) {
    const valEl = el('span', 'jv-value jv-' + type);
    const text = valueText(value);
    if (type === 'string' && text.length > MAX_STRING) {
      valEl.appendChild(document.createTextNode(text.slice(0, MAX_STRING)));
      const more = el('span', 'jv-more', '…（展开剩余 ' + (text.length - MAX_STRING) + ' 字符）');
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        valEl.textContent = text;
        if (hasComma) valEl.appendChild(el('span', 'jv-punc', ','));
      });
      valEl.appendChild(more);
    } else {
      valEl.appendChild(document.createTextNode(text));
    }
    if (hasComma) valEl.appendChild(el('span', 'jv-punc', ','));
    valEl.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const ok = await copyText(type === 'string' ? value : String(value));
      toast(ok ? '已复制值' : '复制失败');
    });
    return valEl;
  }

  function buildNode(key, value, path, hasComma, depth, keyIsIndex) {
    state.nodeCount++;
    const type = typeOf(value);
    const container = isContainerType(type);
    const emptyContainer = container && countEntries(value) === 0;

    const node = el('div', 'jv-node' + (container && !emptyContainer ? ' jv-container' : ''));
    const line = el('div', 'jv-line');
    node.appendChild(line);

    if (container && !emptyContainer) {
      line.appendChild(el('span', 'jv-arrow', '▶'));
    } else {
      line.appendChild(el('span', 'jv-arrow-spacer'));
    }

    let keyEl = null;
    if (key !== null) {
      keyEl = el('span', 'jv-key' + (keyIsIndex ? ' jv-index' : ''), String(key));
      line.appendChild(keyEl);
      line.appendChild(el('span', 'jv-colon', ':'));
    }

    if (!container) {
      const valEl = buildPrimitiveValue(value, type, hasComma);
      line.appendChild(valEl);
      register(path, { line, nodeEl: node, keyEl, valEl, value, type, depth });
      return node;
    }

    if (emptyContainer) {
      const close = el('span', 'jv-punc jv-brace', type === 'object' ? '{}' : '[]');
      line.appendChild(close);
      if (hasComma) close.appendChild(el('span', 'jv-punc', ','));
      register(path, { line, nodeEl: node, keyEl, valEl: null, value, type, depth });
      return node;
    }

    const openBrace = el('span', 'jv-punc jv-brace', type === 'object' ? '{' : '[');
    line.appendChild(openBrace);

    const n = countEntries(value);
    const preview = el('span', 'jv-preview');
    preview.appendChild(el('span', 'jv-punc', ' … '));
    preview.appendChild(el('span', 'jv-count', n + (type === 'object' ? ' 个字段' : ' 项')));
    preview.appendChild(el('span', 'jv-punc', type === 'object' ? ' }' : ' ]'));
    if (hasComma) preview.appendChild(el('span', 'jv-punc', ','));
    line.appendChild(preview);

    const children = el('div', 'jv-children');
    const closeLine = el('div', 'jv-line jv-close-line');
    const closeBrace = el('span', 'jv-punc jv-brace', type === 'object' ? '}' : ']');
    closeLine.appendChild(closeBrace);
    if (hasComma) closeBrace.appendChild(el('span', 'jv-punc', ','));
    node.appendChild(children);
    node.appendChild(closeLine);

    const rec = register(path, {
      line, nodeEl: node, keyEl, valEl: null, childrenEl: children,
      value, type, depth, open: false, rendered: false, childRecs: null,
    });

    line.addEventListener('click', () => {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.type === 'Range') return; // 用户正在选择文本
      showPath(rec);
      setOpen(rec, !rec.open);
    });
    closeLine.addEventListener('click', () => showPath(rec));

    return node;
  }

  function setOpen(rec, open) {
    if (!rec || rec.open === open) return;
    rec.open = open;
    rec.nodeEl.classList.toggle('jv-open', open);
    if (open && !rec.rendered) renderChildren(rec);
  }

  function renderChildren(rec) {
    rec.rendered = true;
    rec.childRecs = [];
    const frag = document.createDocumentFragment();
    if (rec.type === 'array') {
      const arr = rec.value;
      for (let i = 0; i < arr.length; i++) {
        const p = rec.path.concat(i);
        frag.appendChild(buildNode(i, arr[i], p, i < arr.length - 1, rec.depth + 1, true));
        rec.childRecs.push(state.pathMap.get(pathToString(p)));
        if (state.nodeCount > MAX_NODES) { state.truncated = true; break; }
      }
    } else {
      const keys = Object.keys(rec.value);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const p = rec.path.concat(k);
        frag.appendChild(buildNode(k, rec.value[k], p, i < keys.length - 1, rec.depth + 1, false));
        rec.childRecs.push(state.pathMap.get(pathToString(p)));
        if (state.nodeCount > MAX_NODES) { state.truncated = true; break; }
      }
    }
    rec.childrenEl.appendChild(frag);
  }

  function expandTo(rec, maxDepth) {
    if (!rec || !isContainerType(rec.type) || countEntries(rec.value) === 0) return;
    if (rec.depth >= maxDepth) return;
    setOpen(rec, true);
    if (rec.childRecs) for (const c of rec.childRecs) expandTo(c, maxDepth);
  }

  function openAll(rec) {
    if (!rec || !isContainerType(rec.type) || countEntries(rec.value) === 0) return;
    setOpen(rec, true);
    if (state.truncated || !rec.childRecs) return;
    for (const c of rec.childRecs) {
      openAll(c);
      if (state.truncated) return;
    }
  }

  function collapseAll(rec) {
    if (!rec || !rec.childRecs) return;
    for (const c of rec.childRecs) {
      if (isContainerType(c.type)) {
        setOpen(c, false);
        collapseAll(c);
      }
    }
  }

  function showPath(rec) {
    state.currentPath = rec.pathString;
    if (state.els.pathText) state.els.pathText.textContent = rec.pathString;
  }

  function updateStats() {
    const e = state.els;
    if (!e.stats) return;
    e.stats.classList.toggle('jv-warn', state.truncated);
    e.stats.textContent = state.nodeCount + ' 个节点 · ' + formatSize(state.sizeBytes) +
      (state.truncated ? ' · 节点过多，部分内容未展开' : '');
  }

  /* ---------- 搜索 ---------- */

  function isMatch(hay, q) { return !!hay && hay.toLowerCase().includes(q); }

  function wrapMatches(rootEl, q) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      const t = node.textContent;
      const lower = t.toLowerCase();
      if (!lower.includes(q)) continue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      let idx = lower.indexOf(q);
      while (idx !== -1) {
        if (idx > pos) frag.appendChild(document.createTextNode(t.slice(pos, idx)));
        frag.appendChild(el('mark', 'jv-mark', t.slice(idx, idx + q.length)));
        pos = idx + q.length;
        idx = lower.indexOf(q, pos);
      }
      if (pos < t.length) frag.appendChild(document.createTextNode(t.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  function runSearch(qRaw) {
    const q = qRaw.trim().toLowerCase();
    rebuildTree();
    let matches = 0;
    if (q) {
      const visit = (rec) => {
        if (state.truncated || !rec.childRecs) return;
        for (const c of rec.childRecs) {
          if (state.truncated) return;
          const ct = typeOf(c.value);
          if (c.keyEl && isMatch(c.keyEl.textContent, q)) {
            matches++;
            wrapMatches(c.keyEl, q);
          }
          if (isContainerType(ct)) {
            if (countEntries(c.value) > 0) {
              setOpen(c, true);
              if (state.truncated) return;
              visit(c);
            }
          } else if (c.valEl && isMatch(valueText(c.value), q)) {
            matches++;
            wrapMatches(c.valEl, q);
          }
        }
      };
      visit(state.rootRec);
    }
    state.els.searchInfo.textContent = q
      ? (matches + ' 处匹配' + (state.truncated ? ' · 已达展开上限' : ''))
      : '';
    updateStats();
  }

  function rebuildTree() {
    state.nodeCount = 0;
    state.truncated = false;
    state.pathMap.clear();
    state.els.main.textContent = '';
    state.els.main.appendChild(buildNode(null, state.data, [], false, 0, false));
    state.rootRec = state.pathMap.get('$');
    expandTo(state.rootRec, state.defaultDepth);
  }

  /* ---------- 对外 API ---------- */

  const API = {};

  API.isActive = () => state.active;

  API.notify = (msg) => toast(msg);

  API.toggleRaw = function () {
    if (!state.active) return;
    const { main, raw, btnRaw } = state.els;
    if (state.mode === 'tree') {
      state.mode = 'raw';
      main.style.display = 'none';
      raw.style.display = 'block';
      btnRaw.textContent = '树形视图';
    } else {
      state.mode = 'tree';
      raw.style.display = 'none';
      main.style.display = 'block';
      btnRaw.textContent = '原始数据';
    }
  };

  API.render = function ({ data, rawText }) {
    if (state.active) return;
    state.active = true;
    state.data = data;
    state.rawText = rawText != null && rawText !== '' ? rawText : JSON.stringify(data, null, 2);
    try { state.sizeBytes = new Blob([state.rawText]).size; } catch (_) { state.sizeBytes = state.rawText.length; }
    state.defaultDepth = computeDefaultDepth(data);

    document.body.textContent = '';
    document.body.style.cssText = 'margin:0;padding:0;';
    document.documentElement.style.overflow = 'hidden';

    const root = el('div');
    root.id = 'jv-root';
    const app = el('div', 'jv-app');
    root.appendChild(app);

    // 工具栏
    const bar = el('div', 'jv-toolbar');
    bar.appendChild(el('span', 'jv-brand', 'JSON'));
    const search = el('input', 'jv-search');
    search.type = 'text';
    search.placeholder = '搜索键或值…（Esc 清除）';
    search.spellcheck = false;
    bar.appendChild(search);
    const searchInfo = el('span', 'jv-search-info', '');
    bar.appendChild(searchInfo);
    const btnExpand = el('button', 'jv-btn', '展开全部');
    const btnCollapse = el('button', 'jv-btn', '折叠全部');
    const btnCopy = el('button', 'jv-btn', '复制 JSON');
    const btnRaw = el('button', 'jv-btn', '原始数据');
    bar.appendChild(btnExpand);
    bar.appendChild(btnCollapse);
    bar.appendChild(btnCopy);
    bar.appendChild(btnRaw);
    app.appendChild(bar);

    // 主体：树 / 原始
    const main = el('div', 'jv-main');
    const raw = el('div', 'jv-raw');
    raw.textContent = state.rawText;
    raw.style.display = 'none';
    app.appendChild(main);
    app.appendChild(raw);

    // 状态栏
    const status = el('div', 'jv-status');
    status.appendChild(el('span', 'jv-status-label', '路径'));
    const pathText = el('span', 'jv-path', '$');
    pathText.title = '点击页面中的键或值可查看其路径；双击值可复制';
    status.appendChild(pathText);
    const btnCopyPath = el('button', 'jv-btn jv-btn-sm', '复制路径');
    status.appendChild(btnCopyPath);
    const stats = el('span', 'jv-stats', '');
    status.appendChild(stats);
    app.appendChild(status);

    document.body.appendChild(root);
    state.els = { root, app, main, raw, search, searchInfo, pathText, stats, btnRaw };

    let debounce = 0;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => runSearch(search.value), 250);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        search.value = '';
        runSearch('');
      }
      e.stopPropagation();
    });
    btnExpand.addEventListener('click', () => { openAll(state.rootRec); updateStats(); });
    btnCollapse.addEventListener('click', () => { collapseAll(state.rootRec); });
    btnCopy.addEventListener('click', async () => {
      const ok = await copyText(JSON.stringify(state.data, null, 2));
      toast(ok ? '已复制格式化 JSON' : '复制失败');
    });
    btnRaw.addEventListener('click', () => API.toggleRaw());
    btnCopyPath.addEventListener('click', async () => {
      const ok = await copyText(state.currentPath || '$');
      toast(ok ? '已复制路径' : '复制失败');
    });

    rebuildTree();
    updateStats();
  };

  window.__JSON_VIEWER__ = API;
})();
