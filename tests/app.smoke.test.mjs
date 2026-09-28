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
const IMPORTERS_JS = read('importers.js');
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
  // Files picked in a fake <input type="file"> are {name, text}; reading one completes at once.
  class FileReader { readAsText(file) { this.onload({ target: { result: file.text } }); } }
  const ctx = vm.createContext({ document, localStorage, fetch, FileReader, console, setTimeout: () => 0, clearTimeout() {} });
  vm.runInContext(IMPORTERS_JS, ctx);
  vm.runInContext(APP_JS, ctx);
  await vm.runInContext('READY', ctx);
  const run = code => vm.runInContext(code, ctx);
  // Values cross the VM boundary as JSON so deepEqual is not confused by a different Object.prototype.
  const get = expr => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
  return { ctx, els, storage, get, run };
}

assert.ok(HTML.indexOf('<script src="importers.js">') >= 0 && HTML.indexOf('<script src="importers.js">') < HTML.indexOf('<script src="app.js">'));
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

test('importing an Audible CSV previews first, then adds only new books', async () => {
  const mine = JSON.stringify([{ t: 'A Spark of Dawn', a: 'Ilse Marlowe', s: 'A Crown of Embers', sn: '5' }]);
  const { els, get } = await boot({ files: { 'data/books.json': mine, 'data/excluded.txt': 'BGONE\n' } });
  const csv = 'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\n'
    + 'x,A Crown of Embers 5: A Spark of Dawn,A Crown of Embers Series (book 5),Ilse Marlowe,,Finished,B5\n'
    + 'x,A Crown of Embers 6: Ashfall,A Crown of Embers Series (book 6),Ilse Marlowe,A.B. Quill,Finished,B6\n'
    + 'x,Removed,,Ilse Marlowe,,Finished,BGONE\n'
    + 'x,Half Way,,Ilse Marlowe,,2h left,B7\n';
  els.importAudibleBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'library.csv', text: csv }], value: '' } });

  // preview: nothing changed yet
  assert.ok(els.importPreview.classList.contains('open'));
  assert.equal(els.importPreviewTitle.textContent, 'Audible import');
  assert.match(els.importPreviewBody.innerHTML, /Already in the catalogue: 1/);
  assert.match(els.importPreviewBody.innerHTML, /Audible ids filled in on existing books: 1/);
  assert.match(els.importPreviewBody.innerHTML, /excluded\.txt\): 1/);
  assert.match(els.importPreviewBody.innerHTML, /New: 1/);
  assert.match(els.importPreviewBody.innerHTML, /Ashfall/);
  assert.equal(els.importConfirm.textContent, 'Add 1 book');
  assert.equal(get('DATA.length'), 1);

  els.importConfirm.listeners.click[0]();
  assert.ok(!els.importPreview.classList.contains('open'));
  assert.deepEqual(get('DATA'), [
    { t: 'A Spark of Dawn', a: 'Ilse Marlowe', s: 'A Crown of Embers', sn: '5', id: 'B5' },
    { t: 'A Crown of Embers 6: Ashfall', a: 'Ilse Marlowe', n: 'A. B. Quill', s: 'A Crown of Embers', sn: '6', id: 'B6' },
  ]);
  assert.match(els.ioStatus.textContent, /Added 1 book, filled in 1 Audible id/);

  // the same file again: nothing to add, nothing to confirm
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'library.csv', text: csv }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /Nothing new to add/);
  assert.equal(els.importConfirm.style.display, 'none');
});

test('importing a Goodreads CSV can be cancelled', async () => {
  const { els, get } = await boot();
  const before = get('DATA.length');
  const csv = 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\n'
    + '"Zzz New Book (Zzz Saga, #2)",Nobody Yet,,Audible Audio,read,fantasy\n';
  els.importGoodreadsBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'goodreads.csv', text: csv }], value: '' } });
  assert.equal(els.importPreviewTitle.textContent, 'Goodreads import');
  assert.match(els.importPreviewBody.innerHTML, /Zzz New Book &mdash; Nobody Yet  \[Zzz Saga #2\]/);
  els.importCancel.listeners.click[0]();
  assert.ok(!els.importPreview.classList.contains('open'));
  assert.equal(get('DATA.length'), before);
  els.importConfirm.listeners.click[0]();             // a stale click after cancelling does nothing
  assert.equal(get('DATA.length'), before);
});

test('Export includes series info, and Import brings it back', async () => {
  const first = await boot();
  const blobs = [];
  first.ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
  first.ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  first.els.exportBtn.listeners.click[0]();
  const backup = JSON.parse(blobs[0]);
  assert.deepEqual(backup, { books: demoBooks, seriesInfo: JSON.parse(DEMO_INFO) });

  // into a page that has no series info: it comes back, and survives a reload
  const mine = JSON.stringify([{ t: 'Mine', a: 'Me' }]);
  const files = { 'data/books.json': mine };
  const other = await boot({ files });
  assert.deepEqual(other.get('SERIES_INFO'), {});
  other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
  assert.deepEqual(other.get('DATA'), demoBooks);
  assert.deepEqual(other.get('SERIES_INFO'), backup.seriesInfo);
  const reloaded = await boot({ files, storage: new Map(other.storage) });
  assert.deepEqual(reloaded.get('SERIES_INFO'), backup.seriesInfo);

  // an older backup (a plain list of books) still imports and keeps the current series info
  const legacy = await boot();
  legacy.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: mine }], value: '' } });
  assert.deepEqual(legacy.get('DATA'), [{ t: 'Mine', a: 'Me' }]);
  assert.deepEqual(legacy.get('SERIES_INFO'), JSON.parse(DEMO_INFO));

  // locally saved series info is set aside when series-info.json changes on disk
  const changedInfo = await boot({ files: { 'data/books.json': mine, 'data/series-info.json': '{}\n' }, storage: new Map(other.storage) });
  assert.deepEqual(changedInfo.get('SERIES_INFO'), {});
  assert.ok(changedInfo.storage.has('audiobook-catalog-data.backup'));
});
