// Smoke test for the browser app. Runs the built page's real <script> in Node against a tiny
// fake DOM, so it needs no dependencies and no browser.  Run with:  make test   (builds first)
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distFile = path.join(root, 'dist', 'audiobook-catalog.html');
assert.ok(fs.existsSync(distFile), 'dist/audiobook-catalog.html is missing: run `make build` first');
const HTML = fs.readFileSync(distFile, 'utf8');

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

/** Load `html` into a fresh fake browser. `storage` is a Map standing in for localStorage. */
function boot(html = HTML, storage = new Map()) {
  const body = html.slice(html.indexOf('<body'), html.indexOf('<script'));
  const els = {};
  for (const [, id] of body.matchAll(/id="([^"]+)"/g)) els[id] = makeElement(id);
  for (const [, id, text] of html.matchAll(/<script type="application\/json" id="([\w-]+)">([\s\S]*?)<\/script>/g)) {
    els[id] = makeElement(id);
    els[id].textContent = text;
  }
  const mainJs = html.match(/<script>\n([\s\S]*)\n<\/script>/)[1];
  const document = {
    getElementById: id => els[id],
    querySelectorAll: () => [],
    createElement: () => makeElement('created'),
    body: { appendChild() {}, removeChild() {} },
    documentElement: { outerHTML: '<html></html>' },
  };
  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  };
  // `claude` is deliberately undefined: this is what an offline copy sees.
  const ctx = vm.createContext({ document, localStorage, console, setTimeout: () => 0, clearTimeout() {} });
  vm.runInContext(mainJs, ctx);
  const run = code => vm.runInContext(code, ctx);
  // Values cross the VM boundary as JSON so deepEqual is not confused by a different Object.prototype.
  const get = expr => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
  return { ctx, els, storage, get, run };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const embeddedBooks = JSON.parse(HTML.match(/id="book-data">([\s\S]*?)<\/script>/)[1]);

test('opens on the series overview, with a row per series', () => {
  const { els, get } = boot();
  assert.equal(get('VIEW'), 'series');
  const seriesCount = new Set(embeddedBooks.filter(b => b.s).map(b => b.s)).size;
  assert.match(els.subtitle.textContent, new RegExp(`^${seriesCount} series across ${embeddedBooks.length} audiobooks`));
  assert.equal((els.results.innerHTML.match(/class="srow-title"/g) || []).length, seriesCount + 1); // + "Standalone"
});

test('opening a series shows exactly that series', () => {
  const { ctx, els, get } = boot();
  const counts = {};
  embeddedBooks.forEach(b => b.s && (counts[b.s] = (counts[b.s] || 0) + 1));
  const [series] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  ctx.openSeries(series);
  assert.equal(get('VIEW'), 'library');
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, counts[series]);
  assert.ok(els.crumb.classList.contains('show'));
  assert.equal(els.crumbLabel.textContent, series);
});

test('search narrows the library view', () => {
  const { ctx, els } = boot();
  ctx.setView('library');
  const target = embeddedBooks[0];
  els.q.value = target.t;
  ctx.render();
  assert.ok(els.results.innerHTML.includes('class="book"'));
  assert.ok((els.results.innerHTML.match(/class="book"/g) || []).length < embeddedBooks.length);
  els.q.value = 'zzzz-no-such-book-zzzz';
  ctx.render();
  assert.match(els.results.innerHTML, /No books match/);
});

test('editing a book keeps its Audible id', () => {
  const { ctx, els, get, run } = boot();
  run("DATA[0].id = 'TESTASIN01'");
  ctx.setView('library');
  ctx.openEditForm(0);
  assert.equal(els.formTitle.textContent, 'Edit book');
  els.f_t.value = 'Renamed In The App';
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.deepEqual(get('({t: DATA[0].t, id: DATA[0].id})'), { t: 'Renamed In The App', id: 'TESTASIN01' });
});

test('adding a book appends it', () => {
  const { ctx, els, get } = boot();
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

test('offline edits are kept for the same build, and set aside after a rebuild', async () => {
  // 1. edit offline: the change lands in localStorage, tagged with this build's baseline
  const first = boot();
  first.run("DATA[0].t = 'Edited Offline'");
  first.run('persist()');
  await tick();
  assert.ok(first.storage.has('audiobook-catalog-data'));

  // 2. reopen the same file: the edit is still there
  const same = boot(HTML, new Map(first.storage));
  assert.equal(same.get('DATA[0].t'), 'Edited Offline');

  // 3. open a *rebuilt* file (different embedded data): show the new data, keep the old edits aside
  const rebuilt = HTML.replace('id="book-data">[', 'id="book-data">[ ');
  const newer = boot(rebuilt, new Map(first.storage));
  assert.equal(newer.get('DATA[0].t'), embeddedBooks[0].t);
  assert.ok(newer.storage.has('audiobook-catalog-data.backup'));
  assert.ok(!newer.storage.has('audiobook-catalog-data'));
  assert.match(newer.els.ioStatus.textContent, /set aside/);

  // 4. a save from the old, pre-baseline format is also treated as stale, never trusted blindly
  const legacy = boot(HTML, new Map([['audiobook-catalog-data', JSON.stringify([{ t: 'Old', a: 'Format' }])]]));
  assert.equal(legacy.get('DATA[0].t'), embeddedBooks[0].t);
  assert.ok(legacy.storage.has('audiobook-catalog-data.backup'));
});
