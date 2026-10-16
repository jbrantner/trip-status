// Test kit for Trip Status: a local copy of the site plus stand-ins for GitHub and ntfy.sh, so every test runs
// offline with made-up trips. Nothing here ever talks to the real GitHub or ntfy.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { chromium } = require('playwright');

// APP_DIR lets the same tests run against another copy of the site (for example the version before a change).
const ROOT = path.resolve(process.env.APP_DIR || path.join(__dirname, '..'));
const BASE = '/trip-status/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

// Serves the site under /trip-status/ like GitHub Pages does, including its redirect for a missing trailing slash.
// root: another folder to serve (see siteCopy). The returned object can play a dead connection (down = true) or a
// slow one for the trip list (slowMs), for the offline copy tests where the page's requests go through sw.js.
function startServer(root) {
  const ROOT_DIR = root || ROOT;
  const ctl = {};
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (ctl.down) return req.socket.destroy();
    if (ctl.slowMs && /trips\.json$/.test(u.pathname)) return setTimeout(() => { ctl.slowMs = 0; server.emit('request', req, res); }, ctl.slowMs);
    if (u.pathname === '/trip-status') { res.writeHead(301, { Location: BASE + u.search }); return res.end(); }
    if (!u.pathname.startsWith(BASE)) { res.writeHead(404); return res.end('not found'); }
    let rel = decodeURIComponent(u.pathname.slice(BASE.length)) || 'index.html';
    const file = path.join(ROOT_DIR, rel);
    if (!file.startsWith(ROOT_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve(Object.assign(ctl, { origin: 'http://127.0.0.1:' + port, url: 'http://127.0.0.1:' + port + BASE, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) }));
  }));
}

// A copy of the site in a temporary folder with a made-up trips.json, for tests where the real files are served.
function siteCopy(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-status-site-'));
  fs.readdirSync(ROOT).filter((f) => /^(index\.html|sw\.js|manifest.*\.webmanifest|icon-.*\.png)$/.test(f)).forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)));
  fs.writeFileSync(path.join(dir, 'trips.json'), JSON.stringify(data, null, 1) + '\n');
  return { dir, write: (d) => fs.writeFileSync(path.join(dir, 'trips.json'), JSON.stringify(d, null, 1) + '\n'), remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const gitSha = (s) => crypto.createHash('sha1').update('blob ' + Buffer.byteLength(s) + '\0' + s).digest('hex');

// Stand-in for GitHub: the repo's trips.json, the contents API (read, write with sha checks) and the Pages copy
// that everyone's phone reads. A save lands in the repo at once and on "Pages" when publish() runs (or at once
// with autoPublish), which is how the real site behaves: Pages shows a save a minute or so later.
class FakeGitHub {
  constructor(initial, opts = {}) {
    this.tokens = Object.assign({ 'github_pat_GOOD': 'write', 'github_pat_OTHER': 'write', 'github_pat_READONLY': 'read' }, opts.tokens || {});
    this.setRepo(initial);
    this.pages = this.file;
    this.autoPublish = opts.autoPublish !== false;
    this.puts = []; this.gets = 0; this.repoChecks = 0;
    this.putQueue = []; // forced replies for the next PUTs, e.g. [{ status: 409 }]
    this.pagesDelay = 0; this.pagesFail = false; this.apiFail = false;
    this.pagesQueue = []; // per-request overrides for trips.json: { delay, body, status }
  }
  setRepo(obj) { this.file = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) + '\n'; this.sha = gitSha(this.file); }
  publish() { this.pages = this.file; }
  repoJson() { return JSON.parse(this.file); }
  pagesJson() { return JSON.parse(this.pages); }
  lastPut() { return this.puts[this.puts.length - 1]; }
  async attach(ctx) {
    await ctx.route('**/trips.json*', async (route) => {
      const o = this.pagesQueue.shift() || {};
      const delay = o.delay != null ? o.delay : this.pagesDelay;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (this.pagesFail || o.abort) return route.abort('internetdisconnected');
      return route.fulfill({ status: o.status || 200, contentType: 'application/json', body: o.body != null ? o.body : this.pages });
    });
    await ctx.route('https://api.github.com/**', async (route) => {
      const req = route.request();
      if (this.apiFail) return route.abort('internetdisconnected');
      const auth = (req.headers()['authorization'] || '').replace(/^Bearer\s+/i, '');
      const access = this.tokens[auth];
      const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
      const u = new URL(req.url());
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, PUT' } });
      if (!access) return json(401, { message: 'Bad credentials' });
      if (u.pathname === '/repos/jbrantner/trip-status') { this.repoChecks++; return json(200, { full_name: 'jbrantner/trip-status' }); }
      if (u.pathname !== '/repos/jbrantner/trip-status/contents/trips.json') return json(404, { message: 'Not Found' });
      if (req.method() === 'GET') {
        this.gets++;
        const content = b64(this.file).replace(/.{60}/g, '$&\n');
        return json(200, { sha: this.sha, encoding: 'base64', content });
      }
      if (req.method() === 'PUT') {
        const body = JSON.parse(req.postData() || '{}');
        const forced = this.putQueue.shift();
        if (forced && forced.beforeWrite) forced.beforeWrite(this);
        if (forced && forced.status) return json(forced.status, { message: forced.message || 'forced' });
        if (access !== 'write') return json(403, { message: 'Resource not accessible by personal access token' });
        if (this.sha && body.sha !== this.sha) return json(409, { message: 'trips.json does not match ' + body.sha });
        const text = Buffer.from(body.content, 'base64').toString('utf8');
        this.setRepo(text);
        this.puts.push({ message: body.message, json: JSON.parse(text), text });
        if (this.autoPublish) this.publish();
        return json(200, { content: { sha: this.sha }, commit: { sha: 'c' + this.sha.slice(0, 7) } });
      }
      return json(405, { message: 'no' });
    });
  }
}

// Stand-in for the ntfy.sh mailbox used for profile requests.
class FakeNtfy {
  constructor() { this.posted = []; this.messages = []; this.fail = false; }
  add(text, ageSeconds = 0) {
    const id = Math.random().toString(36).slice(2, 14);
    this.messages.push({ id, time: Math.floor(Date.now() / 1000) - ageSeconds, event: 'message', topic: 'trip-status-1e4522bd34bd56bb', message: text });
    return id;
  }
  async attach(ctx) {
    await ctx.route('https://ntfy.sh/**', async (route) => {
      const req = route.request();
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (this.fail) return route.abort('internetdisconnected');
      if (req.method() === 'POST') { this.posted.push(req.postData()); return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{}' }); }
      const lines = [{ id: 'open1', event: 'open' }].concat(this.messages).map((m) => JSON.stringify(m)).join('\n') + '\n';
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/x-ndjson', body: lines });
    });
  }
}

// One browser for the whole run; each test gets a fresh, phone-sized context with its own storage.
let browser = null;
async function getBrowser() { if (!browser) browser = await chromium.launch(); return browser; }
async function closeBrowser() { if (browser) await browser.close(); browser = null; }

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// Opens the app. opts: data (trips.json), storage (localStorage before load), hash, now (fixed clock), size,
// serviceWorkers ('block' by default), gh/ntfy options, path (extra path/query after /trip-status/).
async function open(server, opts = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext(Object.assign({}, PHONE, opts.size ? { viewport: opts.size } : {}, {
    serviceWorkers: opts.serviceWorkers || 'block', timezoneId: 'America/New_York', locale: 'en-US', colorScheme: opts.colorScheme || 'light',
  }, opts.context || {}));
  // Anything else on the internet is blocked so a test can never reach a real service. (Routes added later win,
  // so this catch-all goes first and the GitHub and ntfy stand-ins below take their own addresses.)
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  const gh = opts.gh instanceof FakeGitHub ? opts.gh : new FakeGitHub(opts.data || sampleData(), opts.gh || {});
  const ntfy = opts.ntfy instanceof FakeNtfy ? opts.ntfy : new FakeNtfy();
  await gh.attach(ctx); await ntfy.attach(ctx);
  // Tabs that close themselves after saving only pretend to here, so the test can still look at them.
  await ctx.addInitScript(() => { window.close = () => { window.__closed = true; }; });
  if (opts.storage) {
    await ctx.addInitScript((s) => { if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); for (const k in s) localStorage.setItem(k, s[k]); } }, opts.storage);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
  if (opts.now) await page.clock.install({ time: new Date(opts.now) });
  await page.goto(server.url + (opts.path || '') + (opts.hash || ''));
  if (opts.wait !== false) await page.waitForFunction(() => !document.querySelector('#days .empty') || !/Loading/.test(document.querySelector('#days').textContent), null, { timeout: 5000 }).catch(() => {});
  return { ctx, page, gh, ntfy, errors, close: () => ctx.close() };
}

// Made-up trips around a fixed "today" of Monday 2026-10-19 (no real names, places or riders).
const TODAY = '2026-10-19';
const NOW = '2026-10-19T09:00:00-04:00';
function sampleData() {
  return {
    updated: '2026-10-19T12:30:00.000Z',
    trips: [
      { date: '2026-10-18', time: '10:00', status: 'Assigned' },
      { date: '2026-10-19', time: '10:00', status: 'Assigned', label: 'Group A' },
      { date: '2026-10-19', time: '13:30', status: 'Pending' },
      { date: '2026-10-20', time: '09:15', status: 'Assigned' },
      { date: '2026-10-21', time: '', status: 'Pending', label: 'Lunch outing' },
      { date: '2026-10-22', time: '09:45', status: 'Pending', drivers: ['Assigned', 'Pending'], label: 'Fall trip' },
      { date: '2026-10-24', time: '08:30', status: 'Assigned', drivers: ['Assigned', 'Assigned'] },
      { date: '2027-01-14', time: '14:15', status: 'Assigned' },
    ],
    profiles: [{ id: 'pq1zz0001', initials: 'Q.Z.', icon: '🦉' }, { id: 'pxy00002', initials: 'X.Y.', icon: '🍀' }],
  };
}

// Helper's Update link for an export object, encoded exactly like Helper does it.
function helperHash(obj) {
  return '#helper=' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A tiny test runner: test(name, fn), run() prints results and a summary.
const tests = [];
function test(name, fn, opts = {}) { tests.push({ name, fn, opts }); }
async function run(filter) {
  const server = await startServer();
  const results = [];
  for (const t of tests) {
    if (filter && !t.name.toLowerCase().includes(filter.toLowerCase())) continue;
    const t0 = Date.now();
    try { await t.fn(server); results.push({ name: t.name, ok: true, ms: Date.now() - t0 }); process.stdout.write('  ok   ' + t.name + '\n'); }
    catch (e) { results.push({ name: t.name, ok: false, ms: Date.now() - t0, error: String(e && e.message || e).split('\n').slice(0, 6).join('\n') }); process.stdout.write('  FAIL ' + t.name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 6).join('\n       ') + '\n'); }
  }
  await closeBrowser(); await server.close();
  const failed = results.filter((r) => !r.ok);
  process.stdout.write('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed\n');
  if (process.env.RESULTS_JSON) fs.writeFileSync(process.env.RESULTS_JSON, JSON.stringify(results, null, 1));
  return failed.length;
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error((msg ? msg + ': ' : '') + 'expected ' + B + ' but got ' + A); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startServer, siteCopy, FakeGitHub, FakeNtfy, open, sampleData, helperHash, test, run, assert, eq, sleep, TODAY, NOW, ROOT, BASE, getBrowser, closeBrowser, PHONE, gitSha };
