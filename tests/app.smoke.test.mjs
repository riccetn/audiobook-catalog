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
                      storage = new Map(), api = null } = {}) {
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
  // `api(init)` stands in for `make serve`'s api/save and returns {status, body}; without it, a plain static server.
  const fetch = async (url, init = {}) => {
    if (url === 'api/save' && api) {
      const { status, body } = await api(init);
      return { ok: status < 300, status, json: async () => body };
    }
    return url in files
      ? { ok: true, status: 200, text: async () => files[url], json: async () => JSON.parse(files[url]) }
      : { ok: false, status: 404, text: async () => 'not found', json: async () => { throw new SyntaxError('not JSON'); } };
  };
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

test('dates read: shown on the card, edited in the form, and filterable by year', async () => {
  const { ctx, els, get } = await boot();
  ctx.setView('library');
  const dated = demoBooks.find(b => b.r && b.r.length > 1);
  assert.ok(dated, 'the demo data has a book read more than once');
  assert.ok(els.results.innerHTML.includes(`Read ${dated.r.join(', ')}`));

  // the read filter lists each year, newest first, and "no date"
  assert.match(els.readFilter.innerHTML, /Read in 2026.*Read in 2025.*Read in 2023/);
  assert.match(els.readFilter.innerHTML, /No date read/);
  els.readFilter.value = '2025';
  ctx.render();
  const inYear = demoBooks.filter(b => (b.r || []).some(d => d.startsWith('2025')));
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, inYear.length);
  els.readFilter.value = '__undated__';
  ctx.render();
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, demoBooks.filter(b => !b.r).length);
  els.readFilter.value = '';

  // edit: the form shows the dates; they are tidied, sorted and de-duplicated on save
  const i = demoBooks.indexOf(dated);
  ctx.openEditForm(i);
  assert.equal(els.f_r.value, dated.r.join(', '));
  els.f_r.value = '2026/9/1, 2021, 2026-09-01';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get(`DATA[${i}].r`), ['2021', '2026-09-01']);

  // "+ Read today" appends today's date once
  ctx.openEditForm(i);
  els.readTodayBtn.listeners.click[0]();
  els.readTodayBtn.listeners.click[0]();
  const today = get('today()');
  assert.equal(els.f_r.value, `2021, 2026-09-01, ${today}`);

  // a bad date is refused with a message, and nothing changes
  els.f_r.value = '2026-02-30';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.match(els.formError.textContent, /Not a date: 2026-02-30/);
  assert.deepEqual(get(`DATA[${i}].r`), ['2021', '2026-09-01']);

  // clearing the field removes the dates
  els.f_r.value = '';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.equal(get(`'r' in DATA[${i}]`), false);
});

test('ISBNs: shown on the card, searchable however typed, edited in the form', async () => {
  const mine = JSON.stringify([{ t: 'Boxed One', a: 'Ann Vale', isbn: ['9780306406157'] }, { t: 'Other', a: 'Ann Vale' }]);
  const { ctx, els, get } = await boot({ files: { 'data/books.json': mine } });
  ctx.setView('library');
  assert.match(els.results.innerHTML, /ISBN 9780306406157/);
  for (const q of ['9780306406157', '0-306-40615-2', '406157']) {
    els.q.value = q;
    ctx.render();
    assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 1, q);
  }
  els.q.value = '';

  ctx.openEditForm(0);
  assert.equal(els.f_isbn.value, '9780306406157');
  els.f_isbn.value = '9780306406157, 978-0-00-000000-2';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get('DATA[0].isbn'), ['9780306406157', '9780000000002']);

  // the same ISBN may go on another book (a boxed set)
  ctx.openEditForm(1);
  els.f_isbn.value = '0306406152';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get('DATA[1].isbn'), ['9780306406157']);

  // a mistyped ISBN is refused with a message, and nothing changes
  ctx.openEditForm(1);
  els.f_isbn.value = '9780306406158';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.match(els.formError.textContent, /Not an ISBN: 9780306406158/);
  assert.deepEqual(get('DATA[1].isbn'), ['9780306406157']);
  els.f_isbn.value = '';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.equal(get("'isbn' in DATA[1]"), false);
});

test('a Goodreads import adds the ISBNs of other editions to books already there', async () => {
  const mine = JSON.stringify([{ t: 'Old Favourite', a: 'Ann Vale', isbn: ['9780000000002'], r: ['2020'] }]);
  const { els, get } = await boot({ files: { 'data/books.json': mine } });
  const csv = 'Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf,Date Read\n'
    + 'Old Favourite,Ann Vale,"=""0306406152""","=""9780306406157""",Audible Audio,read,2023/11/04\n';
  els.importGoodreadsBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'goodreads.csv', text: csv }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /ISBNs added to existing books: 1/);
  assert.equal(els.importConfirm.textContent, 'Save ISBNs');
  els.importConfirm.listeners.click[0]();
  assert.deepEqual(get('DATA[0].isbn'), ['9780000000002', '9780306406157']);
  assert.match(els.ioStatus.textContent, /added ISBNs to 1 book/);
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

test('a date read written as a plain string loads, renders, and round-trips through Export / Import', async () => {
  const mine = JSON.stringify([{ t: 'Hand Edited', a: 'Ann Vale', r: '2024-03-15' }, { t: 'Odd', a: 'Ann Vale', r: 5 }]);
  const { ctx, els, get } = await boot({ files: { 'data/books.json': mine } });
  assert.deepEqual(get('DATA[0].r'), ['2024-03-15']);
  ctx.setView('library');
  assert.match(els.results.innerHTML, /Read 2024-03-15/);
  assert.match(els.readFilter.innerHTML, /Read in 2024/);

  const backup = JSON.stringify({ books: [{ t: 'From Backup', a: 'Ann Vale', r: '2023-01-05' }], seriesInfo: {} });
  els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: backup }], value: '' } });
  assert.doesNotMatch(els.ioStatus.textContent, /Couldn't read/);
  assert.deepEqual(get('DATA'), [{ t: 'From Backup', a: 'Ann Vale', r: ['2023-01-05'] }]);
  assert.match(els.results.innerHTML, /Read 2023-01-05/);
});

test('a Goodreads import fills in dates read on books that have none', async () => {
  const mine = JSON.stringify([{ t: 'Old Favourite', a: 'Ann Vale', id: 'B1' }]);
  const { els, get } = await boot({ files: { 'data/books.json': mine } });
  const csv = 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n'
    + 'Old Favourite,Ann Vale,,Audible Audio,read,,2023/11/04\n';
  els.importGoodreadsBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'goodreads.csv', text: csv }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /Dates read filled in on existing books: 1/);
  assert.equal(els.importConfirm.textContent, 'Save dates read');
  els.importConfirm.listeners.click[0]();
  assert.deepEqual(get('DATA'), [{ t: 'Old Favourite', a: 'Ann Vale', id: 'B1', r: ['2023-11-04'] }]);
  assert.match(els.ioStatus.textContent, /filled in dates read on 1 book/);
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
  assert.deepEqual(backup, { books: demoBooks, seriesInfo: JSON.parse(DEMO_INFO), excluded: [] });

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

// Press a book's remove button twice (the second press confirms), as in the library view.
function removeBook(ctx, i) {
  const btn = { dataset: { i: String(i) }, style: {}, innerHTML: '' };
  let handler;
  ctx.document.querySelectorAll = sel => (sel === '.iconbtn.del'
    ? [{ addEventListener: (type, fn) => { handler = fn; } }] : []);
  ctx.render();
  handler({ currentTarget: btn });
  handler({ currentTarget: btn });
}

test('removing a book excludes it from imports, and Export / Import carry the exclusions', async () => {
  const mine = JSON.stringify([{ t: 'Keep', a: 'Ann Vale' }, { t: 'Gone', a: 'Ann Vale', id: 'BGONE2' }]);
  const files = { 'data/books.json': mine, 'data/excluded.txt': '# header\nBOLD\n' };
  const { ctx, els, get, storage } = await boot({ files });
  ctx.setView('library');
  removeBook(ctx, 1);
  assert.deepEqual(get('DATA'), [{ t: 'Keep', a: 'Ann Vale' }]);
  assert.deepEqual(get('NEW_EXCLUDED'), ['BGONE2', 'Gone | Ann Vale']);
  assert.match(els.ioStatus.textContent, /Removed Gone; imports will skip it\. Export and run sync-export/);
  assert.deepEqual(JSON.parse(storage.get('audiobook-catalog-data')).excluded, ['BGONE2', 'Gone | Ann Vale']);

  // an import (Audible by id, or Goodreads by title) does not bring it back
  els.importAudibleBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'l.csv', text:
    'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\nx,Gone,,Ann Vale,,Finished,BGONE2\n' }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /excluded\.txt\): 1/);
  els.importGoodreadsBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'g.csv', text:
    'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\nGone,Ann Vale,,Audible Audio,read,\n' }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /excluded\.txt\): 1/);

  // a reload keeps the exclusions along with the edit
  const reloaded = await boot({ files, storage: new Map(storage) });
  assert.deepEqual(reloaded.get('EXCLUSIONS.entries'), ['BOLD', 'BGONE2', 'Gone | Ann Vale']);

  // Export has the whole list; Import adds it to another page's list
  const blobs = [];
  ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
  ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  els.exportBtn.listeners.click[0]();
  const backup = JSON.parse(blobs[0]);
  assert.deepEqual(backup.excluded, ['BOLD', 'BGONE2', 'Gone | Ann Vale']);
  const other = await boot({ files: { 'data/books.json': '[]', 'data/excluded.txt': 'BOLD\nOther\n' } });
  other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
  assert.deepEqual(other.get('EXCLUSIONS.entries'), ['BOLD', 'Other', 'BGONE2', 'Gone | Ann Vale']);
  assert.deepEqual(other.get('NEW_EXCLUDED'), ['BGONE2', 'Gone | Ann Vale']);
  assert.match(other.els.ioStatus.textContent, /2 more excluded from imports/);
});

test('series show which books are missing, and can be filtered to those', async () => {
  const { els, get } = await boot();
  const info = JSON.parse(DEMO_INFO);
  const gaps = Object.keys(info).filter(name =>
    get(`CatalogImport.missingNumbers(DATA.filter(b => b.s === ${JSON.stringify(name)}), ${info[name].total})`).length);
  assert.ok(gaps.length > 0 && gaps.length < Object.keys(info).length, 'the demo data should have a series with gaps and one without');
  assert.match(els.results.innerHTML, /class="missing">missing #/);

  els.missingFilter.value = 'missing';
  els.missingFilter.listeners.change[0]();
  assert.equal((els.results.innerHTML.match(/class="srow-title"/g) || []).length, gaps.length);  // no Standalone row either
  assert.equal(els.resultCount.textContent, `${gaps.length} series shown`);
  assert.equal(els.missingFilter.style.display, '');

  els.btnLibraryView.listeners.click[0]();
  assert.equal(els.missingFilter.style.display, 'none');

  const { ctx: ctx2, els: els2 } = await boot();
  ctx2.openSeries(gaps[0]);
  assert.match(els2.results.innerHTML, /class="series-note">[^<]*missing #/);
});

test('series info can be edited, added and removed in the page', async () => {
  const { ctx, els, get, storage } = await boot();
  const info = JSON.parse(DEMO_INFO);
  const [name] = Object.keys(info);
  assert.match(els.results.innerHTML, /class="iconbtn sedit"/);

  // edit: the form starts from the current entry
  ctx.openSeriesForm(name);
  assert.ok(els.seriesForm.classList.contains('open'));
  assert.equal(els.sf_total.value, String(info[name].total));
  assert.equal(els.sf_status.value, info[name].status);
  assert.equal(els.sf_note.value, info[name].note);
  assert.equal(els.seriesRemoveBtn.style.display, '');
  Object.assign(els.sf_total, { value: '7' });
  Object.assign(els.sf_status, { value: 'ongoing' });
  Object.assign(els.sf_note, { value: '  book 8   is announced ' });
  Object.assign(els.sf_url, { value: 'https://example.com/author' });
  els.seriesForm.listeners.submit[0]({ preventDefault() {} });
  assert.ok(!els.seriesForm.classList.contains('open'));
  assert.deepEqual(get(`SERIES_INFO[${JSON.stringify(name)}]`),
    { total: 7, status: 'ongoing', note: 'book 8 is announced', url: 'https://example.com/author' });
  assert.match(els.results.innerHTML, /7 owned|owned of 7/);
  assert.deepEqual(JSON.parse(storage.get('audiobook-catalog-data')).info[name].total, 7);

  // invalid input is refused with a message, and nothing changes
  ctx.openSeriesForm(name);
  Object.assign(els.sf_total, { value: 'lots' });
  Object.assign(els.sf_note, { value: '' });
  Object.assign(els.sf_url, { value: 'example.com' });
  els.seriesForm.listeners.submit[0]({ preventDefault() {} });
  assert.ok(els.seriesForm.classList.contains('open'));
  assert.match(els.seriesFormError.textContent, /total must be a positive integer/);
  assert.match(els.seriesFormError.textContent, /url must start with/);
  assert.equal(get(`SERIES_INFO[${JSON.stringify(name)}].total`), 7);
  els.cancelSeries.listeners.click[0]();
  assert.ok(!els.seriesForm.classList.contains('open'));

  // add: a series without info gets a fresh entry ("many" is allowed)
  const bare = demoBooks.map(b => b.s).find(s => s && !(s in info));
  assert.ok(bare, 'the demo data has a series without info');
  ctx.openSeriesForm(bare);
  assert.equal(els.sf_total.value, '');
  assert.equal(els.seriesRemoveBtn.style.display, 'none');
  Object.assign(els.sf_total, { value: 'Many' });
  Object.assign(els.sf_status, { value: 'complete' });
  Object.assign(els.sf_note, { value: 'finished' });
  els.seriesForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get(`SERIES_INFO[${JSON.stringify(bare)}]`), { total: 'many', status: 'complete', note: 'finished' });

  // remove
  ctx.openSeriesForm(name);
  els.seriesRemoveBtn.listeners.click[0]();
  assert.equal(get(`${JSON.stringify(name)} in SERIES_INFO`), false);
  assert.equal(get(`${JSON.stringify(bare)} in SERIES_INFO`), true);
});

// Lets pending promises (a save on its way to the fake server) settle.
const settle = () => new Promise(resolve => setImmediate(resolve));

test('with make serve, edits are saved to disk and the browser copy is dropped', async () => {
  const mine = JSON.stringify([{ t: 'Mine', a: 'Me' }]);
  const saves = [];
  const api = async init => {
    if (!init.method) return { status: 200, body: { writable: true } };
    const body = JSON.parse(init.body);
    saves.push({ method: init.method, headers: init.headers, body });
    const books = body.books.map(b => ({ ...b, t: b.t.trim() }));   // the server tidies
    return { status: 200, body: { base: 'b' + saves.length, infoBase: 'i' + saves.length, books } };
  };
  const { ctx, els, get, storage } = await boot({ files: { 'data/books.json': mine }, api });
  assert.equal(get('DISK_SAVE'), true);
  ctx.setView('library');
  els.toggleAdd.listeners.click[0]();
  Object.assign(els.f_t, { value: 'New  ' });
  Object.assign(els.f_a, { value: 'Me' });
  Object.assign(els.f_s, { value: 'Mine Saga' });
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].method, 'PUT');
  assert.equal(saves[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(saves[0].body.books, [{ t: 'Mine', a: 'Me' }, { t: 'New', a: 'Me', s: 'Mine Saga' }]);
  assert.equal(saves[0].body.base, get('CatalogImport.fingerprint(' + JSON.stringify(mine) + ')'));
  assert.deepEqual(saves[0].body.seriesInfo, {});
  assert.equal(get('BASELINE'), 'b1');                  // the next save starts from the file just written
  assert.deepEqual(get('DATA[1]'), { t: 'New', a: 'Me', s: 'Mine Saga' });
  assert.ok(!storage.has('audiobook-catalog-data'));
  assert.equal(els.ioStatus.textContent, 'Saved.');

  // series info goes along, and the status message no longer asks for Export + sync-export
  ctx.openSeriesForm('Mine Saga');
  Object.assign(els.sf_total, { value: '3' });
  Object.assign(els.sf_status, { value: 'ongoing' });
  els.seriesForm.listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.equal(saves.length, 2);
  assert.equal(saves[1].body.base, 'b1');
  assert.equal(saves[1].body.seriesInfo['Mine Saga'].total, 3);
  assert.doesNotMatch(els.ioStatus.textContent, /sync-export/);
});

test('with make serve, a removed book\'s exclusions are sent with the save, once', async () => {
  const mine = JSON.stringify([{ t: 'Keep', a: 'Me' }, { t: 'Gone', a: 'Me' }]);
  const saves = [];
  const api = async init => {
    if (!init.method) return { status: 200, body: { writable: true } };
    const body = JSON.parse(init.body);
    saves.push(body);
    return { status: 200, body: { base: 'b' + saves.length, infoBase: 'i', books: body.books } };
  };
  const { ctx, get, run } = await boot({ files: { 'data/books.json': mine }, api });
  ctx.setView('library');
  removeBook(ctx, 1);
  await settle();
  assert.deepEqual(saves[0].excluded, ['Gone | Me']);
  assert.deepEqual(get('NEW_EXCLUDED'), []);
  assert.deepEqual(get('EXCLUSIONS.entries'), ['Gone | Me']);
  run("DATA[0].t = 'Kept'; persist();");
  await settle();
  assert.deepEqual(saves[1].excluded, []);
});

test('edits made while a save is on its way are saved right after it', async () => {
  const mine = JSON.stringify([{ t: 'Mine', a: 'Me' }]);
  const saves = [];
  let release;
  const api = async init => {
    if (!init.method) return { status: 200, body: { writable: true } };
    const body = JSON.parse(init.body);
    saves.push(body);
    if (saves.length === 1) await new Promise(resolve => { release = resolve; });
    return { status: 200, body: { base: 'b' + saves.length, infoBase: 'i', books: body.books } };
  };
  const { get, run } = await boot({ files: { 'data/books.json': mine }, api });
  run("DATA[0].t = 'One'; persist(); DATA[0].t = 'Two'; persist();");
  await settle();
  assert.equal(saves.length, 1);
  release();
  await settle(); await settle();
  assert.equal(saves.length, 2);
  assert.equal(saves[1].books[0].t, 'Two');
  assert.equal(saves[1].base, 'b1');
  assert.equal(get('DATA[0].t'), 'Two');
});

test('a refused save keeps the edits in the browser and says why', async () => {
  const mine = JSON.stringify([{ t: 'Mine', a: 'Me' }]);
  let answer = { status: 409, body: { error: 'changed', conflict: true } };
  const api = async init => (init.method ? answer : { status: 200, body: { writable: true } });
  const { get, run, els, storage } = await boot({ files: { 'data/books.json': mine }, api });
  run("DATA[0].t = 'Edited'; persist();");
  await settle();
  assert.match(els.ioStatus.textContent, /Not saved to disk: data\/books\.json changed on disk/);
  assert.equal(JSON.parse(storage.get('audiobook-catalog-data')).data[0].t, 'Edited');

  // after a reload against the same file, the kept edits are saved again
  let saved = null;
  answer = { status: 200, body: { base: 'b', infoBase: 'i', books: [{ t: 'Edited', a: 'Me' }] } };
  const again = await boot({ files: { 'data/books.json': mine }, storage: new Map(storage),
    api: async init => { if (init.method) saved = JSON.parse(init.body); return init.method ? answer : { status: 200, body: { writable: true } }; } });
  await settle();
  assert.equal(saved.books[0].t, 'Edited');
  assert.ok(!again.storage.has('audiobook-catalog-data'));
  assert.equal(again.get('DATA[0].t'), 'Edited');
});

test('without make serve (or with the demo data) edits stay in the browser', async () => {
  let calls = 0;
  const api = async () => { calls++; return { status: 200, body: { writable: true } }; };
  const demo = await boot({ api });                     // demo data: never asks the server
  assert.equal(demo.get('DISK_SAVE'), false);
  assert.equal(calls, 0);
  const plain = await boot({ files: { 'data/books.json': JSON.stringify([{ t: 'Mine', a: 'Me' }]) } });
  assert.equal(plain.get('DISK_SAVE'), false);
  plain.run("DATA[0].t = 'Edited'; persist();");
  await settle();
  assert.ok(plain.storage.has('audiobook-catalog-data'));
});
