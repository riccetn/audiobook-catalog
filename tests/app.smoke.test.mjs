// Smoke test for the browser app. Runs the real index.html + app.js in Node against a tiny fake
// DOM and a fake fetch serving the demo data, so it needs no dependencies and no browser.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const HTML = read('index.html');
const APP_JS = read('app.js');
const DEMO_BOOKS = read('data/sample/books.json');
const DEMO_INFO = read('data/sample/series-info.json');

function makeElement(id) {
  const classes = new Set();
  const listeners = {};
  return {
    id, textContent: '', innerHTML: '', value: '', style: {}, dataset: {}, listeners,
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle(c, force) { const on = force === undefined ? !classes.has(c) : !!force; on ? classes.add(c) : classes.delete(c); return on; },
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    reset() {}, scrollIntoView() {}, click() {},
  };
}

/**
 * Load the page into a fresh fake browser. `files` maps URLs to what the fake server returns
 * (default: no data/books.json yet, so the demo). `storage` is a Map standing in for localStorage.
 */
async function boot({ files = { 'data/sample/books.json': DEMO_BOOKS, 'data/sample/series-info.json': DEMO_INFO },
                      storage = new Map() } = {}) {
  const els = {};
  for (const [, id] of HTML.matchAll(/id="([^"]+)"/g)) els[id] = makeElement(id);
  const document = {
    getElementById: id => els[id],
    querySelectorAll: () => [],
    createElement: () => makeElement('created'),
    body: { appendChild() {}, removeChild() {} },
  };
  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  };
  const fetch = async url => (url in files
    ? { ok: true, status: 200, text: async () => files[url] }
    : { ok: false, status: 404, text: async () => 'not found' });
  const ctx = vm.createContext({ document, localStorage, fetch, console, setTimeout: () => 0, clearTimeout() {} });
  vm.runInContext(APP_JS, ctx);
  await vm.runInContext('READY', ctx);
  const run = code => vm.runInContext(code, ctx);
  // Values cross the VM boundary as JSON so deepEqual is not confused by a different Object.prototype.
  const get = expr => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
  return { ctx, els, storage, get, run };
}

assert.ok(HTML.includes('<script src="app.js">') && HTML.includes('<link rel="stylesheet" href="styles.css">'));
const demoBooks = JSON.parse(DEMO_BOOKS);

test('opens on the series overview, with a row per series', async () => {
  const { els, get } = await boot();
  assert.equal(get('VIEW'), 'series');
  const seriesCount = new Set(demoBooks.filter(b => b.s).map(b => b.s)).size;
  assert.match(els.subtitle.textContent, new RegExp(`^${seriesCount} series across ${demoBooks.length} audiobooks`));
  assert.equal((els.results.innerHTML.match(/class="srow-title"/g) || []).length, seriesCount + 1); // + "Standalone"
});

test('opening a series shows exactly that series', async () => {
  const { ctx, els, get } = await boot();
  const counts = {};
  demoBooks.forEach(b => b.s && (counts[b.s] = (counts[b.s] || 0) + 1));
  const [series] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  ctx.openSeries(series);
  assert.equal(get('VIEW'), 'library');
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, counts[series]);
  assert.ok(els.crumb.classList.contains('show'));
  assert.equal(els.crumbLabel.textContent, series);
});

test('search narrows the library view', async () => {
  const { ctx, els } = await boot();
  ctx.setView('library');
  const target = demoBooks[0];
  els.q.value = target.t;
  ctx.render();
  assert.ok(els.results.innerHTML.includes('class="book"'));
  assert.ok((els.results.innerHTML.match(/class="book"/g) || []).length < demoBooks.length);
  els.q.value = 'zzzz-no-such-book-zzzz';
  ctx.render();
  assert.match(els.results.innerHTML, /No books match/);
});

test('editing a book keeps its Audible id', async () => {
  const { ctx, els, get, run } = await boot();
  run("DATA[0].id = 'TESTASIN01'");
  ctx.setView('library');
  ctx.openEditForm(0);
  assert.equal(els.formTitle.textContent, 'Edit book');
  els.f_t.value = 'Renamed In The App';
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.deepEqual(get('({t: DATA[0].t, id: DATA[0].id})'), { t: 'Renamed In The App', id: 'TESTASIN01' });
});

test('adding a book appends it', async () => {
  const { ctx, els, get } = await boot();
  const before = get('DATA.length');
  ctx.setView('library');
  els.toggleAdd.listeners.click[0]();
  Object.assign(els.f_t, { value: 'Brand New' });
  Object.assign(els.f_a, { value: 'Some Author' });
  Object.assign(els.f_g, { value: 'Fantasy, Cozy' });
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.equal(get('DATA.length'), before + 1);
  assert.deepEqual(get('DATA[DATA.length-1]'), { t: 'Brand New', a: 'Some Author', g: ['Fantasy', 'Cozy'] });
});

test('your own data/books.json wins over the demo', async () => {
  const mine = JSON.stringify([{ t: 'Mine', a: 'Me' }]);
  const { get } = await boot({ files: { 'data/books.json': mine, 'data/sample/books.json': DEMO_BOOKS } });
  assert.deepEqual(get('DATA'), [{ t: 'Mine', a: 'Me' }]);
  assert.deepEqual(get('SERIES_INFO'), {});
});

test('without the data (e.g. opened as a file) it says how to serve it', async () => {
  const { els } = await boot({ files: {} });
  assert.match(els.subtitle.textContent, /make serve/);
});

test('local edits are kept for the same data, and set aside when books.json changes', async () => {
  // 1. edit in the browser: the change lands in localStorage, tagged with this books.json's baseline
  const first = await boot();
  first.run("DATA[0].t = 'Edited Locally'");
  first.run('persist()');
  assert.ok(first.storage.has('audiobook-catalog-data'));

  // 2. reload with the same data: the edit is still there
  const same = await boot({ storage: new Map(first.storage) });
  assert.equal(same.get('DATA[0].t'), 'Edited Locally');

  // 3. reload after books.json changed: show the new data, keep the old edits aside
  const changed = { 'data/sample/books.json': DEMO_BOOKS + '\n', 'data/sample/series-info.json': DEMO_INFO };
  const newer = await boot({ files: changed, storage: new Map(first.storage) });
  assert.equal(newer.get('DATA[0].t'), demoBooks[0].t);
  assert.ok(newer.storage.has('audiobook-catalog-data.backup'));
  assert.ok(!newer.storage.has('audiobook-catalog-data'));
  assert.match(newer.els.ioStatus.textContent, /set aside/);

  // 4. a save from the old, pre-baseline format is also treated as stale, never trusted blindly
  const legacy = await boot({ storage: new Map([['audiobook-catalog-data', JSON.stringify([{ t: 'Old', a: 'Format' }])]]) });
  assert.equal(legacy.get('DATA[0].t'), demoBooks[0].t);
  assert.ok(legacy.storage.has('audiobook-catalog-data.backup'));
});
