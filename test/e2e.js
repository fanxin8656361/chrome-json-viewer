'use strict';
/* 端到端测试：启动真实 Chrome（无头 + CDP 管道模式），加载未打包扩展，验证 JSON 自动美化。
 * 说明：Chrome 仅在 --remote-debugging-pipe 模式下开放 Extensions.loadUnpacked。
 * 依赖：Node 22+、本地测试服务器（test/server.js，端口 18080）。 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const EXT_DIR = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:18080';
const SHOTS = path.join(__dirname, 'shots');

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('chrome.exe not found');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* CDP 管道传输：JSON + '\0' 分帧。父进程写 fd3，读 fd4。 */
class PipeTransport {
  constructor(readStream, writeStream) {
    this.writeStream = writeStream;
    this.buf = Buffer.alloc(0);
    this.onmessage = null;
    readStream.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      let idx;
      while ((idx = this.buf.indexOf(0)) !== -1) {
        const msg = this.buf.slice(0, idx).toString('utf8');
        this.buf = this.buf.slice(idx + 1);
        if (msg && this.onmessage) this.onmessage(msg);
      }
    });
  }
  send(str) {
    this.writeStream.write(Buffer.from(str + '\0', 'utf8'));
  }
}

class CDP {
  constructor(transport) {
    this.transport = transport;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    transport.onmessage = (raw) => {
      const m = JSON.parse(raw);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.method + ': ' + JSON.stringify(m.error))) : resolve(m.result);
      } else {
        for (const fn of this.listeners) fn(m);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send(JSON.stringify(msg));
    });
  }
}

let cdp = null;

async function evalJS(session, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, session);
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result.value;
}

async function waitFor(session, expr, timeout = 10000, interval = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await evalJS(session, expr);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout: ' + expr);
    await sleep(interval);
  }
}

async function shot(session, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
  console.log('  screenshot:', name);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const profile = path.join(os.tmpdir(), 'jv-e2e-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = findChrome();
  console.log('chrome:', chrome);
  const proc = spawn(chrome, [
    '--user-data-dir=' + profile,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1280,900',
    '--headless',
    'about:blank',
  ], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });

  const results = {};
  try {
    const transport = new PipeTransport(proc.stdio[4], proc.stdio[3]);
    cdp = new CDP(transport);

    const newTab = async (url) => {
      const t = await cdp.send('Target.createTarget', { url });
      const s = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      await cdp.send('Page.enable', {}, s);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, s);
      return { targetId: t.targetId, sessionId: s };
    };
    const nav = async (tab, url) => {
      await cdp.send('Page.navigate', { url }, tab.sessionId);
      await sleep(400);
    };

    // ---- 0) 扩展加载前：观察 Chrome 内置 JSON 页面 DOM ----
    const tab = await newTab('about:blank');
    await nav(tab, BASE + '/sample.json');
    await sleep(1200);
    results.builtinDom = await evalJS(tab.sessionId,
      `JSON.stringify({contentType: document.contentType, preCount: document.querySelectorAll('pre').length, bodyHead: document.body.innerHTML.slice(0, 200)})`);
    console.log('Chrome 内置 JSON DOM:', results.builtinDom);
    await shot(tab.sessionId, '0-chrome-builtin.png');

    // ---- 1) 加载扩展 ----
    try {
      const ext = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
      results.extensionId = ext.id;
      console.log('extension loaded:', ext.id);
    } catch (e) {
      results.loadUnpackedError = String(e.message || e);
      console.log('loadUnpacked failed:', results.loadUnpackedError);
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    // ---- 2) application/json 自动接管 ----
    await nav(tab, BASE + '/sample.json');
    await waitFor(tab.sessionId, `!!document.querySelector('#jv-root')`);
    results.sample = await evalJS(tab.sessionId, `(() => {
      const q = (s) => document.querySelector(s);
      const key = q('.jv-key');
      const str = q('.jv-string');
      return {
        rendered: true,
        lines: document.querySelectorAll('.jv-line').length,
        openCount: document.querySelectorAll('.jv-open').length,
        keyColor: key ? getComputedStyle(key).color : null,
        stringColor: str ? getComputedStyle(str).color : null,
        stats: q('.jv-stats').textContent,
        chromePreGone: !q('body > pre'),
      };
    })()`);
    console.log('sample.json:', JSON.stringify(results.sample, null, 2));
    await shot(tab.sessionId, '1-sample-tree.png');

    // ---- 3) 折叠全部 / 展开全部 ----
    await evalJS(tab.sessionId, `document.querySelectorAll('.jv-btn')[1].click()`);
    await sleep(200);
    results.afterCollapse = await evalJS(tab.sessionId, `document.querySelectorAll('.jv-open').length`);
    await shot(tab.sessionId, '2-collapsed.png');
    await evalJS(tab.sessionId, `document.querySelectorAll('.jv-btn')[0].click()`);
    await sleep(200);
    results.afterExpand = await evalJS(tab.sessionId, `document.querySelectorAll('.jv-open').length`);

    // ---- 4) 路径显示 ----
    results.pathAfterClick = await evalJS(tab.sessionId, `(() => {
      document.querySelector('.jv-children .jv-line').click();
      return document.querySelector('.jv-path').textContent;
    })()`);

    // ---- 5) 搜索高亮 ----
    await evalJS(tab.sessionId, `(() => {
      const i = document.querySelector('.jv-search');
      i.value = 'appkey';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(600);
    results.search = await evalJS(tab.sessionId, `({
      marks: document.querySelectorAll('.jv-mark').length,
      info: document.querySelector('.jv-search-info').textContent,
    })`);
    console.log('search:', JSON.stringify(results.search));
    await shot(tab.sessionId, '3-search.png');
    await evalJS(tab.sessionId, `(() => {
      const i = document.querySelector('.jv-search');
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(400);

    // ---- 6) 原始数据视图 ----
    await evalJS(tab.sessionId, `document.querySelectorAll('.jv-btn')[3].click()`);
    await sleep(150);
    results.rawVisible = await evalJS(tab.sessionId, `document.querySelector('.jv-raw').style.display`);
    await shot(tab.sessionId, '4-raw.png');
    await evalJS(tab.sessionId, `document.querySelectorAll('.jv-btn')[3].click()`);

    // ---- 7) text/plain 自动接管 ----
    await nav(tab, BASE + '/sample.txt');
    const txtOk = await waitFor(tab.sessionId, `!!document.querySelector('#jv-root')`, 6000).then(() => true).catch(() => false);
    results.textPlainAuto = txtOk;
    await shot(tab.sessionId, '5-textplain.png');

    // ---- 8) 非 JSON 不接管 ----
    await nav(tab, BASE + '/notjson.txt');
    await sleep(1200);
    results.notJsonUntouched = await evalJS(tab.sessionId, `!document.querySelector('#jv-root')`);

    // ---- 9) 大文件性能 ----
    await nav(tab, BASE + '/big.json');
    const t0 = Date.now();
    await waitFor(tab.sessionId, `!!document.querySelector('#jv-root')`, 20000);
    results.bigJson = await evalJS(tab.sessionId, `({
      lines: document.querySelectorAll('.jv-line').length,
      stats: document.querySelector('.jv-stats').textContent,
    })`);
    results.bigJson.firstPaintMs = Date.now() - t0;
    await shot(tab.sessionId, '6-big.png');
    const t1 = Date.now();
    await evalJS(tab.sessionId, `document.querySelectorAll('.jv-btn')[0].click()`);
    results.bigJson.expandAllMs = Date.now() - t1;
    results.bigJson.afterExpandStats = await evalJS(tab.sessionId, `document.querySelector('.jv-stats').textContent`);
    await shot(tab.sessionId, '7-big-expanded.png');

    // ---- 10) 深色模式 ----
    await nav(tab, BASE + '/sample.json');
    await waitFor(tab.sessionId, `!!document.querySelector('#jv-root')`);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    }, tab.sessionId);
    await sleep(300);
    await shot(tab.sessionId, '8-dark.png');

    console.log('\n===== E2E RESULTS =====');
    console.log(JSON.stringify(results, null, 2));
  } finally {
    try { proc.kill(); } catch (_) { /* ignore */ }
  }
}

main().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
