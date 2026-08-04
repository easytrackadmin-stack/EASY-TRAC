'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const puppeteer = require('puppeteer');

const root = path.join(__dirname, '..');
const screenshotDir = process.env.ET_SMOKE_SCREENSHOT_DIR || path.join(root, '.smoke-evidence');
const chrome = process.env.ET_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const mime = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function staticServer() {
  return http.createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/' || pathname === '/dashboard' || pathname === '/tool') pathname = '/tool.html';
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const server = staticServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = 'http://127.0.0.1:' + port;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  const evidence = [];

  async function newPage({ shell, direction = 'rtl', mode = 'empty', delayMs = 0 }) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', error => consoleErrors.push(error.message));
    await page.evaluateOnNewDocument((enabled, dir) => {
      localStorage.clear();
      if (enabled) localStorage.setItem('et_shell_v2', 'on');
      const setDirection = () => document.documentElement && document.documentElement.setAttribute('dir', dir);
      new MutationObserver(setDirection).observe(document, { childList: true, subtree: true });
      const user = { getIdToken: async () => 'browser-smoke-token' };
      const auth = {
        currentUser: user,
        onAuthStateChanged(callback) { setTimeout(() => callback(user), 700); },
        signOut: async () => {},
      };
      window.firebase = {
        apps: [],
        auth: () => auth,
        initializeApp() { this.apps.push({}); return {}; },
        firestore: () => ({ enablePersistence: () => Promise.resolve() }),
      };
    }, shell, direction);

    await page.setRequestInterception(true);
    page.on('request', async request => {
      const url = request.url();
      if (url.includes('/api/v1/clients/dev-local/events/summary')) {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        if (mode === 'disabled') return request.respond({ status: 503, contentType: 'application/json', body: '{"error":"disabled"}' });
        if (mode === 'error') return request.respond({ status: 500, contentType: 'application/json', body: '{"error":"test error"}' });
        if (mode === 'empty') return request.respond({ status: 200, contentType: 'application/json', body: '{"telemetryEnabled":true,"rows":[],"live":[]}' });
        if (mode === 'data') {
          const now = Date.now();
          const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
          const body = JSON.stringify({ telemetryEnabled: true, rows: [{
            eventName: 'purchase', destination: 'ga4', accepted: 12,
            dayStart: { _seconds: (today - 86400000) / 1000, _nanoseconds: 0 },
            updatedAt: { _seconds: Math.floor((now - 60000) / 1000), _nanoseconds: 0 }
          }], live: [{
            eventName: 'purchase', destination: 'ga4', accepted: 12,
            bucketStart: { _seconds: Math.floor((now - 120000) / 1000), _nanoseconds: 0 }
          }] });
          return request.respond({ status: 200, contentType: 'application/json', body });
        }
      }
      if (url.startsWith(origin)) return request.continue();
      return request.abort();
    });
    return { page, consoleErrors };
  }

  async function shot(page, name) {
    const file = path.join(screenshotDir, name + '.png');
    // Viewport evidence avoids including the legacy off-canvas history panel
    // that full-page capture expands into under RTL.
    await page.screenshot({ path: file, fullPage: false });
    evidence.push(file);
  }

  try {
    const off = await newPage({ shell: false });
    await off.page.goto(origin + '/dashboard', { waitUntil: 'networkidle0' });
    await off.page.waitForSelector('#view-overview');
    assert.equal(await off.page.$('#sbEvents'), null);
    assert.equal(await off.page.$eval('#appShellV2Root', el => el.children.length), 0);
    assert.ok(await off.page.$('#overviewPixels'));
    await shot(off.page, '01-shell-off'); await off.page.close();

    const on = await newPage({ shell: true, direction: 'rtl', mode: 'data' });
    await on.page.goto(origin + '/dashboard', { waitUntil: 'networkidle0' });
    await on.page.waitForFunction(() => window.__etShellV2 && window.__etShellV2.eventsExplorer && window.currentUser);
    assert.equal(await on.page.$eval('html', el => el.dir), 'rtl');
    assert.ok(await on.page.$('#sbEvents'));
    await on.page.waitForFunction(() => document.querySelector('#trackingContinuity')?.textContent.includes('Container ingestions'));
    const continuity = await on.page.$eval('#trackingContinuity', el => el.textContent);
    assert.match(continuity, /12/); assert.match(continuity, /does not confirm destination delivery/i);
    await shot(on.page, '02-shell-on-rtl-continuity');

    await on.page.evaluate(() => window.__etShellV2.eventsExplorer.button.click());
    await on.page.waitForSelector('#view-events.active');
    await on.page.waitForFunction(() => document.querySelector('#view-events')?.textContent.includes('12'));
    const dataText = await on.page.$eval('#view-events', el => el.textContent);
    assert.match(dataText, /purchase/); assert.match(dataText, /GA4/); assert.match(dataText, /days without events/i);
    assert.doesNotMatch(dataText, /accepted by|delivered to|rejected by|match rate|response code/i);
    await shot(on.page, '03-data-state'); await on.page.close();

    for (const [index, mode, expected] of [
      ['04', 'disabled', 'Telemetry disabled'],
      ['05', 'empty', 'No events observed'],
      ['06', 'error', 'Could not load aggregate telemetry'],
    ]) {
      const state = await newPage({ shell: true, mode });
      await state.page.goto(origin + '/dashboard', { waitUntil: 'networkidle0' });
      await state.page.waitForFunction(() => window.__etShellV2?.eventsExplorer && window.currentUser);
      await state.page.evaluate(() => window.__etShellV2.eventsExplorer.button.click());
      await state.page.waitForFunction(text => document.querySelector('#view-events')?.textContent.includes(text), {}, expected);
      await shot(state.page, index + '-' + mode + '-state'); await state.page.close();
    }

    const loading = await newPage({ shell: true, mode: 'data', delayMs: 1500 });
    await loading.page.goto(origin + '/dashboard', { waitUntil: 'domcontentloaded' });
    await loading.page.waitForFunction(() => window.__etShellV2?.eventsExplorer && window.currentUser);
    await loading.page.evaluate(() => window.__etShellV2.eventsExplorer.button.click());
    await loading.page.waitForFunction(() => document.querySelector('#view-events')?.textContent.includes('Loading telemetry'));
    await shot(loading.page, '07-loading-state');
    await loading.page.waitForFunction(() => document.querySelector('#view-events')?.textContent.includes('12'));
    await loading.page.close();

    const ltr = await newPage({ shell: true, direction: 'ltr', mode: 'data' });
    await ltr.page.goto(origin + '/dashboard', { waitUntil: 'networkidle0' });
    await ltr.page.waitForFunction(() => window.__etShellV2?.eventsExplorer && window.currentUser);
    assert.equal(await ltr.page.$eval('html', el => el.dir), 'ltr');
    await ltr.page.evaluate(() => window.__etShellV2.eventsExplorer.button.click());
    await ltr.page.waitForFunction(() => document.querySelector('#view-events')?.textContent.includes('12'));
    await shot(ltr.page, '08-ltr-data-state'); await ltr.page.close();

    process.stdout.write(JSON.stringify({ ok: true, evidence }, null, 2) + '\n');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
