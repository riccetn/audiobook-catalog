// Smoke test for the browser app. Runs the real index.html + app.js in Node against a tiny fake
// DOM and a fake fetch serving the demo data, so it needs no dependencies and no browser.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const PAGES = ['index.html', 'import.html', 'duplicates.html'];
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
    // where an element was last moved to, as 'before <id>' or 'after <id>'
    before(node) { node.place = `before ${id}`; }, after(node) { node.place = `after ${id}`; },
  };
}

/**
 * Load the page into a fresh fake browser. `files` maps URLs to what the fake server returns
 * (default: no data/books.json yet, so the demo). `storage` is a Map standing in for localStorage.
 */
async function boot({ page = 'index.html', files = { 'data/sample/books.json': DEMO_BOOKS, 'data/sample/series-info.json': DEMO_INFO },
                      storage = new Map(), api = null, hash = '', setTimeout = () => 0 } = {}) {
  const html = read(page);
  const els = {};
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) els[id] = makeElement(id);
  const document = {
    getElementById: id => els[id],
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => makeElement('created'),
    body: { appendChild() {}, removeChild() {} },
    title: '',
  };
  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  };
  // `api(init, url)` stands in for `make serve`'s api/ endpoints and returns {status, body}; without it, a plain static server.
  const fetch = async (url, init = {}) => {
    if (url.startsWith('api/') && api) {
      const { status, body } = await api(init, url);
      return { ok: status < 300, status, json: async () => body };
    }
    return url in files
      ? { ok: true, status: 200, text: async () => files[url], json: async () => JSON.parse(files[url]) }
      : { ok: false, status: 404, text: async () => 'not found', json: async () => { throw new SyntaxError('not JSON'); } };
  };
  // Files picked in a fake <input type="file"> are {name, text}; reading one completes at once.
  class FileReader { readAsText(file) { this.onload({ target: { result: file.text } }); } }
  // The session history: `entries` of {hash, state}, `at` the current one; back() and forward() fire popstate.
  const location = { href: page, hash, pathname: '/' + page };
  const windowListeners = {};
  const fire = type => (windowListeners[type] || []).forEach(fn => fn({}));
  const entries = [{ hash, state: null }];
  let at = 0;
  const hashOf = url => (String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : '');
  const history = {
    entries,
    get state() { return entries[at].state; },
    get at() { return at; },
    pushState(state, title, url) { entries.splice(at + 1); entries.push({ hash: hashOf(url), state }); at++; location.hash = hashOf(url); },
    replaceState(state, title, url) { entries[at] = { hash: hashOf(url), state }; location.hash = hashOf(url); },
    go(n) { at += n; location.hash = entries[at].hash; fire('popstate'); fire('hashchange'); },
    back() { this.go(-1); }, forward() { this.go(1); },
  };
  const addEventListener = (type, fn) => (windowListeners[type] ||= []).push(fn);
  const ctx = vm.createContext({ document, localStorage, fetch, FileReader, location, history, addEventListener,
    console, setTimeout, clearTimeout() {} });
  // the page's own scripts, in order
  for (const [, src] of html.matchAll(/<script src="([^"]+)">/g)) vm.runInContext(read(src), ctx);
  await vm.runInContext('READY', ctx);
  const run = code => vm.runInContext(code, ctx);
  // Values cross the VM boundary as JSON so deepEqual is not confused by a different Object.prototype.
  const get = expr => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
  return { ctx, els, storage, get, run };
}

for (const page of PAGES) {
  const html = read(page);
  const scripts = [...html.matchAll(/<script src="([^"]+)">/g)].map(m => m[1]);
  assert.deepEqual(scripts.slice(0, 2), ['importers.js', 'store.js'], page);
  assert.ok(html.includes('<link rel="stylesheet" href="styles.css">'), page);
  for (const other of PAGES) assert.ok(html.includes(`href="${other}"`), `${page} links to ${other}`);
}
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

test('the address names the view, so a series, a book or a search can be linked to', async () => {
  const { ctx, els } = await boot();
  assert.equal(ctx.location.hash, '');
  ctx.openSeries('Halloway & Finch');
  assert.equal(ctx.location.hash, '#series=Halloway+%26+Finch');
  assert.equal(ctx.document.title, 'Halloway & Finch — Audiobook Catalogue');
  // the overview links each series to that address, and book cards link to their own
  ctx.setView('series');
  assert.match(els.results.innerHTML, /<a class="srow-title" href="#series=Halloway\+%26\+Finch">Halloway &amp; Finch<\/a>/);
  assert.match(els.results.innerHTML, /<a class="srow-title" href="#standalone">Standalone<\/a>/);
  ctx.openSeries('The Lantern Coast');
  assert.match(els.results.innerHTML, /<div class="title"><a href="#book=The\+Salt\+Road">The Salt Road<\/a><\/div>/);

  // opening one of those addresses shows the same thing
  const series = await boot({ hash: '#series=Halloway+%26+Finch' });
  assert.deepEqual(series.get('[VIEW, SERIES_FILTER]'), ['library', 'Halloway & Finch']);
  assert.equal((series.els.results.innerHTML.match(/class="book"/g) || []).length, 2);
  assert.equal(series.els.crumbLabel.textContent, 'Halloway & Finch');
  const book = await boot({ hash: '#book=The+Salt+Road' });
  assert.equal((book.els.results.innerHTML.match(/class="book"/g) || []).length, 1);
  assert.match(book.els.results.innerHTML, /The Salt Road/);
  assert.equal(book.els.crumbLabel.textContent, 'The Salt Road');
  const standalone = await boot({ hash: '#standalone' });
  assert.equal(standalone.els.crumbLabel.textContent, 'Standalone books');
  assert.equal((standalone.els.results.innerHTML.match(/class="book"/g) || []).length, 3);

  // a search and the filters
  const found = await boot({ hash: '#books&q=ashcombe&read=undated&genre=Science+Fiction' });
  assert.deepEqual(found.get('[VIEW, SERIES_FILTER]'), ['library', null]);
  assert.equal(found.els.q.value, 'ashcombe');
  assert.equal(found.els.readFilter.value, '__undated__');
  assert.equal((found.els.results.innerHTML.match(/class="book"/g) || []).length, 3);
  assert.equal(found.ctx.location.hash, '#books&q=ashcombe&genre=Science+Fiction&read=undated');
  const gaps = await boot({ hash: '#q=coast&missing' });
  assert.equal(gaps.get('VIEW'), 'series');
  assert.equal(gaps.els.missingFilter.value, 'missing');
  assert.equal(gaps.els.q.value, 'coast');
  // an address it does not understand shows the series overview
  const odd = await boot({ hash: '#nothing=here&%E0%A4%A' });
  assert.equal(odd.get('VIEW'), 'series');
  assert.equal(odd.ctx.location.hash, '');
});

test('back and forward step through series, books, filters and searches', async () => {
  const { ctx, els, get } = await boot();
  const { history } = ctx;
  ctx.openSeries('The Lantern Coast');
  // a click on a book link opens it here, with a history entry; filters that would hide it are cleared
  els.authorFilter.value = 'Somebody Else';
  const link = { getAttribute: () => '#book=Beacons+at+Low+Tide' };
  let prevented = false;
  els.results.listeners.click[0]({ target: { closest: () => link }, button: 0, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(ctx.location.hash, '#book=Beacons+at+Low+Tide');
  assert.equal(els.authorFilter.value, '');
  // a click with a modifier key is left to the browser (a new tab)
  els.results.listeners.click[0]({ target: { closest: () => link }, button: 0, ctrlKey: true, preventDefault() { assert.fail('prevented'); } });

  els.btnLibraryView.listeners.click[0]();
  els.genreFilter.value = 'Mystery';
  els.genreFilter.listeners.change[0]();
  // typing a search is one entry, however many letters
  for (const q of ['p', 'pr', 'priya']) { els.q.value = q; els.q.listeners.input[0](); }
  assert.deepEqual(history.entries.map(e => e.hash),
    ['', '#series=The+Lantern+Coast', '#book=Beacons+at+Low+Tide', '#books', '#books&genre=Mystery', '#books&q=priya&genre=Mystery']);

  history.back();
  assert.equal(els.q.value, '');
  assert.equal(els.genreFilter.value, 'Mystery');
  history.back(); history.back();
  assert.deepEqual(get('[VIEW, BOOK_FILTER]'), ['library', 'Beacons at Low Tide']);
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 1);
  history.back();
  assert.deepEqual(get('[VIEW, SERIES_FILTER, BOOK_FILTER]'), ['library', 'The Lantern Coast', null]);
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 4);
  history.back();
  assert.deepEqual(get('[VIEW, SERIES_FILTER]'), ['series', null]);
  history.forward();
  assert.equal(get('SERIES_FILTER'), 'The Lantern Coast');

  // a space typed in the search box stays there (the address carries the search without it)
  els.q.value = 'beacons '; els.q.listeners.input[0]();
  assert.equal(els.q.value, 'beacons ');
  els.q.value = 'beacons at'; els.q.listeners.input[0]();
  assert.equal(ctx.location.hash, '#series=The+Lantern+Coast&q=beacons+at');
  history.back();

  // a new search after going back starts a new entry instead of rewriting an old one
  els.q.value = 'salt'; els.q.listeners.input[0]();
  assert.deepEqual(history.entries.map(e => e.hash), ['', '#series=The+Lantern+Coast', '#series=The+Lantern+Coast&q=salt']);
  // leaving a series closes a form left open on it
  ctx.openEditForm(0);
  history.back();
  assert.ok(els.addForm.classList.contains('open'), 'only the search changed');
  history.back();
  assert.ok(!els.addForm.classList.contains('open'));
});

test('editing a book keeps its editions', async () => {
  const { ctx, els, get, run } = await boot();
  run("DATA[0].e = [{id: 'TESTASIN01', gr: '4242', p: 'Gull Audio', len: 642}, {id: 'TESTASIN02'}]");
  ctx.setView('library');
  ctx.openEditForm(0);
  assert.equal(els.formTitle.textContent, 'Edit book');
  assert.equal(els.f_e.value, 'ASIN TESTASIN01; Goodreads 4242; Publisher Gull Audio; Length 10h 42m\nASIN TESTASIN02');
  els.f_t.value = 'Renamed In The App';
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.deepEqual(get('({t: DATA[0].t, e: DATA[0].e})'),
    { t: 'Renamed In The App', e: [{ id: 'TESTASIN01', gr: '4242', p: 'Gull Audio', len: 642 }, { id: 'TESTASIN02' }] });
});

test('book cards link an edition\'s ASIN to Audible and its Goodreads id to Goodreads', async () => {
  const { ctx, els, run } = await boot();
  run("DATA[0].e = [{id: 'TESTASIN01', gr: '4242', p: 'Gull Audio', len: 642}, {isbn: '9780000000002'}]");
  ctx.setView('library');
  ctx.render();
  const html = els.results.innerHTML;
  assert.match(html, /ASIN <a href="https:\/\/www\.audible\.com\/pd\/TESTASIN01" target="_blank" rel="noopener">TESTASIN01<\/a>; Goodreads <a href="https:\/\/www\.goodreads\.com\/book\/show\/4242" target="_blank" rel="noopener">4242<\/a>; Publisher Gull Audio; Length 10h 42m/);
  // an edition without either id has no links
  assert.match(html, /<div class="edition">ISBN 9780000000002<\/div>/);
});

test('book cards link the Hardcover book and an edition\'s Hardcover id to Hardcover, and the edit form keeps them', async () => {
  const { ctx, els, get, run } = await boot();
  run("DATA[0].hcb = '808'; DATA[0].e = [{id: 'TESTASIN01', hc: '31337'}]");
  ctx.setView('library');
  ctx.render();
  assert.match(els.results.innerHTML, /<div class="ids">Hardcover book <a href="https:\/\/hardcover\.app\/id\/book\/808" target="_blank" rel="noopener">808<\/a><\/div>/);
  assert.match(els.results.innerHTML, /ASIN <a [^>]*>TESTASIN01<\/a>; Hardcover <a href="https:\/\/hardcover\.app\/id\/edition\/31337" target="_blank" rel="noopener">31337<\/a><\/div>/);
  els.q.value = '808';
  ctx.render();
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 1, 'searchable by its Hardcover book id');
  els.q.value = '';
  ctx.openEditForm(0);
  assert.equal(els.f_hcb.value, '808');
  assert.equal(els.f_e.value, 'ASIN TESTASIN01; Hardcover 31337');
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.deepEqual(get('[DATA[0].hcb, DATA[0].e]'), ['808', [{ id: 'TESTASIN01', hc: '31337' }]]);

  // a Hardcover book id is a number; one typed on an edition line, as editions used to show it, goes on the book
  ctx.openEditForm(0);
  els.f_hcb.value = 'abc';
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.match(els.formError.textContent, /Not a Hardcover book id: abc/);
  els.f_hcb.value = '';
  els.f_e.value = 'ASIN TESTASIN01; Hardcover 31337; Hardcover book 909';
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.deepEqual(get('[DATA[0].hcb, DATA[0].e]'), ['909', [{ id: 'TESTASIN01', hc: '31337' }]]);
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
  assert.deepEqual(get('DATA[DATA.length-1]'), { t: 'Brand New', a: ['Some Author'], g: ['Fantasy', 'Cozy'] });
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
  // written before editions: read as the book's first edition
  const mine = JSON.stringify([{ t: 'Boxed One', a: ['Ann Vale'], isbn: ['9780306406157'] }, { t: 'Other', a: ['Ann Vale'] }]);
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
  assert.equal(els.f_e.value, 'ISBN 9780306406157');
  // another ISBN is another edition
  els.f_e.value = 'ISBN 9780306406157, 978-0-00-000000-2';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get('DATA[0].e'), [{ isbn: '9780306406157' }, { isbn: '9780000000002' }]);

  // the same ISBN may go on another book (a boxed set); the cards then say so
  ctx.openEditForm(1);
  els.f_e.value = '0306406152';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get('DATA[1].e'), [{ isbn: '9780306406157' }]);
  assert.match(els.results.innerHTML, /Also in this edition: <a href="#book=Boxed\+One">Boxed One<\/a>/);

  // a mistyped ISBN is refused with a message, and nothing changes
  ctx.openEditForm(1);
  els.f_e.value = 'ISBN 9780306406158';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.match(els.formError.textContent, /Not understood in editions: ISBN 9780306406158/);
  assert.deepEqual(get('DATA[1].e'), [{ isbn: '9780306406157' }]);
  els.f_e.value = 'Goodreads 12; second note; third note';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.match(els.formError.textContent, /Not understood in editions: third note/);
  els.f_e.value = '';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.equal(get("'e' in DATA[1]"), false);
});

test('narrators and descriptions live on editions: shown on the card, searchable, edited in the form', async () => {
  const { ctx, els, get } = await boot();
  ctx.setView('library');
  const salt = demoBooks.findIndex(b => b.t === 'The Salt Road');
  assert.ok(demoBooks[salt].e.some(ed => ed.desc), 'the demo data has an edition with a description');
  // both narrators on the book; with different narrators each edition names its own
  assert.match(els.results.innerHTML, /narr\. Tobias Frane \/ Hollis Marr/);
  assert.match(els.results.innerHTML, /UK edition; Narrated by Hollis Marr; ASIN/);
  assert.doesNotMatch(els.results.innerHTML, /Narrated by Ingrid Voss/, 'a single narrator is not repeated on the edition');
  for (const q of ['hollis marr', 'uk edition']) {
    els.q.value = q;
    ctx.render();
    assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 1, q);
  }
  els.q.value = '';

  ctx.openEditForm(salt);
  assert.match(els.f_e.value, /^Narrated by Tobias Frane; ASIN SAMPLE0001/);
  els.f_e.value += '\nDramatized adaptation; Narrated by A full cast; Goodreads 777';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get(`DATA[${salt}].e[2]`), { gr: '777', n: ['A full cast'], desc: 'Dramatized adaptation' });
});

test('box sets: the edition shows on each of its books, and editing it on one edits it on all', async () => {
  const { ctx, els, get } = await boot();
  ctx.setView('library');
  const two = demoBooks.findIndex(b => b.t === 'The Copper Graft'), three = demoBooks.findIndex(b => b.t === 'Harvest of Gears');
  assert.ok(two >= 0 && three >= 0, 'the demo data has a box set');
  assert.match(els.results.innerHTML, /ASIN <a [^>]*>SAMPLE0008<\/a>; ISBN 9780306406157; Publisher Kestrel Row Audio; Released 2022-11; Length 23h 5m/);
  assert.match(els.results.innerHTML, /Also in this edition: <a href="#book=Harvest\+of\+Gears">Harvest of Gears #3<\/a>/);
  assert.match(els.results.innerHTML, /Also in this edition: <a href="#book=The\+Copper\+Graft">The Copper Graft #2<\/a>/);
  els.q.value = 'kestrel row';
  ctx.render();
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 2, 'search finds a publisher');
  els.q.value = '';

  ctx.openEditForm(two);
  els.f_e.value = els.f_e.value.replace('Kestrel Row Audio', 'Merlin Lane Audio');
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.equal(get(`DATA[${three}].e[0].p`), 'Merlin Lane Audio');
  assert.match(els.ioStatus.textContent, /Also updated the shared edition on 1 other book/);
});

test('a Goodreads import adds the ISBN to the edition of books already there', async () => {
  const mine = JSON.stringify([{ t: 'Old Favourite', a: ['Ann Vale'], e: [{ id: 'B1' }], r: ['2020'] }]);
  const { els, get } = await boot({ page: 'import.html', files: { 'data/books.json': mine } });
  const csv = 'Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf,Date Read\n'
    + 'Old Favourite,Ann Vale,"=""0306406152""","=""9780306406157""",Audible Audio,read,2023/11/04\n';
  els.importGoodreadsBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'goodreads.csv', text: csv }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /ISBNs added to existing books: 1/);
  assert.equal(els.importConfirm.textContent, 'Save ISBNs');
  els.importConfirm.listeners.click[0]();
  assert.deepEqual(get('DATA[0].e'), [{ id: 'B1', isbn: '9780306406157' }]);
  assert.match(els.ioStatus.textContent, /added ISBNs to 1 book/);
});

test('authors are lists: the author filter offers each author on its own, and the form edits them as text', async () => {
  const { ctx, els, get } = await boot();
  ctx.setView('library');
  const nine = demoBooks.findIndex(b => b.t === 'Nine Ways to Lose a Kingdom');
  assert.deepEqual(demoBooks[nine].a, ['Ferran Doyle', 'Priya Ostrander'], 'the demo data has a book with two authors');
  assert.match(els.authorFilter.innerHTML, /<option value="Priya Ostrander">Priya Ostrander<\/option>/);
  assert.doesNotMatch(els.authorFilter.innerHTML, /Ferran Doyle, Priya Ostrander/);
  assert.equal((els.authorFilter.innerHTML.match(/<option value="Priya Ostrander">/g) || []).length, 1);
  assert.match(els.results.innerHTML, /<div class="meta">Ferran Doyle, Priya Ostrander<\/div>/);
  els.authorFilter.value = 'Priya Ostrander';
  ctx.render();
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 3, 'her two books and the one she co-wrote');
  els.authorFilter.value = '';

  ctx.openEditForm(nine);
  assert.equal(els.f_a.value, 'Ferran Doyle, Priya Ostrander');
  els.f_a.value = 'Ferran Doyle & Cass Merriweather';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get(`DATA[${nine}].a`), ['Ferran Doyle', 'Cass Merriweather']);
});

test('authors and narrators written as comma separated text load as lists', async () => {
  const mine = JSON.stringify([{ t: 'Old Style', a: 'Ann Vale, Bo Reed', e: [{ id: 'B1', n: 'Cy Hale, Di Moss' }] }]);
  const { ctx, els, get } = await boot({ files: { 'data/books.json': mine } });
  assert.deepEqual(get('DATA'), [{ t: 'Old Style', a: ['Ann Vale', 'Bo Reed'], e: [{ id: 'B1', n: ['Cy Hale', 'Di Moss'] }] }]);
  ctx.setView('library');
  assert.match(els.authorFilter.innerHTML, /<option value="Bo Reed">/);
  assert.match(els.results.innerHTML, /Ann Vale, Bo Reed — narr\. Cy Hale, Di Moss/);
});

test('your own data/books.json wins over the demo', async () => {
  const mine = JSON.stringify([{ t: 'Mine', a: ['Me'] }]);
  const { get } = await boot({ files: { 'data/books.json': mine, 'data/sample/books.json': DEMO_BOOKS } });
  assert.deepEqual(get('DATA'), [{ t: 'Mine', a: ['Me'] }]);
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
  const legacy = await boot({ storage: new Map([['audiobook-catalog-data', JSON.stringify([{ t: 'Old', a: ['Format'] }])]]) });
  assert.equal(legacy.get('DATA[0].t'), demoBooks[0].t);
  assert.ok(legacy.storage.has('audiobook-catalog-data.backup'));
});

test('importing an Audible CSV previews first, then adds only new books', async () => {
  const mine = JSON.stringify([{ t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5' }]);
  const { els, get } = await boot({ page: 'import.html', files: { 'data/books.json': mine, 'data/excluded.txt': 'BGONE\n' } });
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
    { t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5', e: [{ id: 'B5' }] },
    { t: 'A Crown of Embers 6: Ashfall', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '6', e: [{ id: 'B6', n: ['A. B. Quill'] }] },
  ]);
  assert.match(els.ioStatus.textContent, /Added 1 book, filled in 1 Audible id/);

  // the same file again: nothing to add, nothing to confirm
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'library.csv', text: csv }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /Nothing new to add/);
  assert.equal(els.importConfirm.style.display, 'none');
});

test('a date read written as a plain string loads, renders, and round-trips through Export / Import', async () => {
  const mine = JSON.stringify([{ t: 'Hand Edited', a: ['Ann Vale'], r: '2024-03-15' }, { t: 'Odd', a: ['Ann Vale'], r: 5 }]);
  const { ctx, els, get } = await boot({ files: { 'data/books.json': mine } });
  assert.deepEqual(get('DATA[0].r'), ['2024-03-15']);
  ctx.setView('library');
  assert.match(els.results.innerHTML, /Read 2024-03-15/);
  assert.match(els.readFilter.innerHTML, /Read in 2024/);

  const backup = JSON.stringify({ books: [{ t: 'From Backup', a: ['Ann Vale'], r: '2023-01-05' }], seriesInfo: {} });
  const storage = new Map();
  const imp = await boot({ page: 'import.html', files: { 'data/books.json': mine }, storage });
  imp.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: backup }], value: '' } });
  assert.doesNotMatch(imp.els.ioStatus.textContent, /Couldn't read/);
  assert.deepEqual(imp.get('DATA'), [{ t: 'From Backup', a: ['Ann Vale'], r: ['2023-01-05'] }]);
  // back on the catalogue page
  const back = await boot({ files: { 'data/books.json': mine }, storage });
  back.ctx.setView('library');
  assert.match(back.els.results.innerHTML, /Read 2023-01-05/);
});

test('a Goodreads import fills in dates read on books that have none', async () => {
  const mine = JSON.stringify([{ t: 'Old Favourite', a: ['Ann Vale'], e: [{ id: 'B1' }] }]);
  const { els, get } = await boot({ page: 'import.html', files: { 'data/books.json': mine } });
  const csv = 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n'
    + 'Old Favourite,Ann Vale,,Audible Audio,read,,2023/11/04\n';
  els.importGoodreadsBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'goodreads.csv', text: csv }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /Dates read filled in on existing books: 1/);
  assert.equal(els.importConfirm.textContent, 'Save dates read');
  els.importConfirm.listeners.click[0]();
  assert.deepEqual(get('DATA'), [{ t: 'Old Favourite', a: ['Ann Vale'], e: [{ id: 'B1' }], r: ['2023-11-04'] }]);
  assert.match(els.ioStatus.textContent, /filled in dates read on 1 book/);
});

test('importing a Goodreads CSV can be cancelled', async () => {
  const { els, get } = await boot({ page: 'import.html' });
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

test('Goodreads CSV downloads every book for Goodreads\' import', async () => {
  const { ctx, els, get } = await boot({ page: 'import.html' });
  const blobs = [];
  ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
  ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  els.exportGoodreadsBtn.listeners.click[0]();
  assert.equal(blobs[0], get('CatalogImport.goodreadsCsv(DATA).csv'));
  assert.match(blobs[0], /^Book Id,Title,Author,/);
  assert.match(els.ioStatus.textContent, new RegExp(`Goodreads CSV with ${demoBooks.length} books downloaded`));
});

test('Export includes series info, and Import brings it back', async () => {
  const first = await boot({ page: 'import.html' });
  const blobs = [];
  first.ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
  first.ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  first.els.exportBtn.listeners.click[0]();
  const backup = JSON.parse(blobs[0]);
  assert.deepEqual(backup, { books: demoBooks, seriesInfo: JSON.parse(DEMO_INFO), excluded: [], notDuplicates: [] });

  // into a page that has no series info: it comes back, and survives a reload
  const mine = JSON.stringify([{ t: 'Mine', a: ['Me'] }]);
  const files = { 'data/books.json': mine };
  const other = await boot({ page: 'import.html', files });
  assert.deepEqual(other.get('SERIES_INFO'), {});
  other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
  assert.deepEqual(other.get('DATA'), demoBooks);
  assert.deepEqual(other.get('SERIES_INFO'), backup.seriesInfo);
  const reloaded = await boot({ files, storage: new Map(other.storage) });
  assert.deepEqual(reloaded.get('SERIES_INFO'), backup.seriesInfo);

  // an older backup (a plain list of books) still imports and keeps the current series info
  const legacy = await boot({ page: 'import.html' });
  legacy.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: mine }], value: '' } });
  assert.deepEqual(legacy.get('DATA'), [{ t: 'Mine', a: ['Me'] }]);
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
  const mine = JSON.stringify([{ t: 'Keep', a: ['Ann Vale'] }, { t: 'Gone', a: ['Ann Vale'], id: 'BGONE2' }]);
  const files = { 'data/books.json': mine, 'data/excluded.txt': '# header\nBOLD\n' };
  const { ctx, els, get, storage } = await boot({ files });
  ctx.setView('library');
  removeBook(ctx, 1);
  assert.deepEqual(get('DATA'), [{ t: 'Keep', a: ['Ann Vale'] }]);
  assert.deepEqual(get('NEW_EXCLUDED'), ['BGONE2', 'Gone | Ann Vale']);
  assert.match(els.ioStatus.textContent, /Removed Gone; imports will skip it\. Export it on the Import & export page and run sync-export/);
  assert.deepEqual(JSON.parse(storage.get('audiobook-catalog-data')).excluded, ['BGONE2', 'Gone | Ann Vale']);

  // on the import page, an import (Audible by id, or Goodreads by title) does not bring it back
  const imp = await boot({ page: 'import.html', files, storage });
  imp.els.importAudibleBtn.listeners.click[0]();
  imp.els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'l.csv', text:
    'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\nx,Gone,,Ann Vale,,Finished,BGONE2\n' }], value: '' } });
  assert.match(imp.els.importPreviewBody.innerHTML, /excluded\.txt\): 1/);
  imp.els.importGoodreadsBtn.listeners.click[0]();
  imp.els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'g.csv', text:
    'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\nGone,Ann Vale,,Audible Audio,read,\n' }], value: '' } });
  assert.match(imp.els.importPreviewBody.innerHTML, /excluded\.txt\): 1/);

  // a reload keeps the exclusions along with the edit
  const reloaded = await boot({ files, storage: new Map(storage) });
  assert.deepEqual(reloaded.get('EXCLUSIONS.entries'), ['BOLD', 'BGONE2', 'Gone | Ann Vale']);

  // Export has the whole list; Import adds it to another page's list
  const blobs = [];
  imp.ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
  imp.ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  imp.els.exportBtn.listeners.click[0]();
  const backup = JSON.parse(blobs[0]);
  assert.deepEqual(backup.excluded, ['BOLD', 'BGONE2', 'Gone | Ann Vale']);
  const other = await boot({ page: 'import.html', files: { 'data/books.json': '[]', 'data/excluded.txt': 'BOLD\nOther\n' } });
  other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
  assert.deepEqual(other.get('EXCLUSIONS.entries'), ['BOLD', 'Other', 'BGONE2', 'Gone | Ann Vale']);
  assert.deepEqual(other.get('NEW_EXCLUDED'), ['BGONE2', 'Gone | Ann Vale']);
  assert.match(other.els.ioStatus.textContent, /2 more excluded from imports/);
});

test('the edit form takes the place of the book card, and adding a book opens it at the top', async () => {
  const { ctx, els } = await boot();
  ctx.setView('library');
  // the list as drawn: a card for each book, found by its data-i
  const cards = {};
  ctx.document.querySelector = sel => {
    const m = /^#results \.book\[data-i="(\d+)"\]$/.exec(sel);
    return m ? (cards[m[1]] ||= makeElement(`card${m[1]}`)) : null;
  };
  ctx.openEditForm(2);
  assert.equal(els.addForm.place, 'after card2');
  assert.ok(cards[2].classList.contains('editing'), 'the card is hidden while its form is open');
  ctx.render();
  assert.equal(els.addForm.place, 'after card2', 'redrawing the list keeps the form on its book');
  els.cancelAdd.listeners.click[0]();
  assert.equal(els.addForm.place, 'before seriesForm');

  els.toggleAdd.listeners.click[0]();
  assert.ok(els.addForm.classList.contains('open'));
  assert.equal(els.addForm.place, 'before seriesForm');

  // a book not shown in the list is edited at the top
  ctx.document.querySelector = () => null;
  ctx.openEditForm(1);
  assert.equal(els.addForm.place, 'before seriesForm');
  assert.equal(els.formTitle.textContent, 'Edit book');
});

test('removing a book while another is being edited saves the edit to the right book', async () => {
  const mine = JSON.stringify([{ t: 'First', a: ['Ann Vale'] }, { t: 'Second', a: ['Ann Vale'] }, { t: 'Third', a: ['Ann Vale'] }]);
  const { ctx, els, get } = await boot({ files: { 'data/books.json': mine } });
  ctx.setView('library');
  ctx.openEditForm(1);
  removeBook(ctx, 0);
  assert.ok(els.addForm.classList.contains('open'), 'the form stays open on its book');
  els.f_t.value = 'Second, Edited';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get('DATA.map(b => b.t)'), ['Second, Edited', 'Third']);

  // removing the book being edited closes the form, and removing a later one leaves it be
  ctx.openEditForm(0);
  removeBook(ctx, 1);
  els.f_t.value = 'Second, Again';
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get('DATA.map(b => b.t)'), ['Second, Again']);
  ctx.openEditForm(0);
  removeBook(ctx, 0);
  assert.ok(!els.addForm.classList.contains('open'));
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
  const mine = JSON.stringify([{ t: 'Mine', a: ['Me'] }]);
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
  assert.deepEqual(saves[0].body.books, [{ t: 'Mine', a: ['Me'] }, { t: 'New', a: ['Me'], s: 'Mine Saga' }]);
  assert.equal(saves[0].body.base, get('CatalogImport.fingerprint(' + JSON.stringify(mine) + ')'));
  assert.deepEqual(saves[0].body.seriesInfo, {});
  assert.equal(get('BASELINE'), 'b1');                  // the next save starts from the file just written
  assert.deepEqual(get('DATA[1]'), { t: 'New', a: ['Me'], s: 'Mine Saga' });
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
  const mine = JSON.stringify([{ t: 'Keep', a: ['Me'] }, { t: 'Gone', a: ['Me'] }]);
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
  const mine = JSON.stringify([{ t: 'Mine', a: ['Me'] }]);
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
  const mine = JSON.stringify([{ t: 'Mine', a: ['Me'] }]);
  let answer = { status: 409, body: { error: 'changed', conflict: true } };
  const api = async init => (init.method ? answer : { status: 200, body: { writable: true } });
  const { get, run, els, storage } = await boot({ files: { 'data/books.json': mine }, api });
  run("DATA[0].t = 'Edited'; persist();");
  await settle();
  assert.match(els.ioStatus.textContent, /Not saved to disk: data\/books\.json changed on disk/);
  assert.equal(JSON.parse(storage.get('audiobook-catalog-data')).data[0].t, 'Edited');

  // after a reload against the same file, the kept edits are saved again
  let saved = null;
  answer = { status: 200, body: { base: 'b', infoBase: 'i', books: [{ t: 'Edited', a: ['Me'] }] } };
  const again = await boot({ files: { 'data/books.json': mine }, storage: new Map(storage),
    api: async init => { if (init.method) saved = JSON.parse(init.body); return init.method ? answer : { status: 200, body: { writable: true } }; } });
  await settle();
  assert.equal(saved.books[0].t, 'Edited');
  assert.ok(!again.storage.has('audiobook-catalog-data'));
  assert.equal(again.get('DATA[0].t'), 'Edited');
});

test('with make serve, series can be looked up on Audible, previewed, then saved', async () => {
  const mine = JSON.stringify([
    { t: 'Loose', a: ['Ann Vale'], e: [{ id: 'B0LOOSE001' }] },
    { t: 'Gull 2', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [{ id: 'B0GULL0002' }] },
  ]);
  const lookups = [], saves = [];
  const api = async (init, url) => {
    if (!init.method) return { status: 200, body: { writable: true, audible: true } };
    const body = JSON.parse(init.body);
    if (url === 'api/save') { saves.push(body); return { status: 200, body: { base: 'b', infoBase: 'i', books: body.books } }; }
    lookups.push(body);
    const series = asin => [{ name: 'The Gull Isle Series', number: asin === 'B0LOOSE001' ? '1' : '2', asin: 'B0GULLISLE' }];
    const results = Object.fromEntries(body.asins.map(a => [a, body.groups === 'series' ? series(a) : 4]));
    return { status: 200, body: { results } };
  };
  const { els, get } = await boot({ page: 'import.html', files: { 'data/books.json': mine }, api });
  assert.equal(els.audiblePanel.style.display, '');
  els.audibleStore.value = 'uk';
  await els.audibleSeriesBtn.listeners.click[0]();
  assert.deepEqual(lookups, [
    { store: 'uk', groups: 'series', asins: ['B0LOOSE001', 'B0GULL0002'] },
    { store: 'uk', groups: 'relationships', asins: ['B0GULLISLE'] },
  ]);
  assert.equal(els.importPreviewTitle.textContent, 'Series from Audible');
  assert.match(els.importPreviewBody.innerHTML, /Series or number filled in: 1/);
  assert.match(els.importPreviewBody.innerHTML, /Loose &mdash; Ann Vale {2}\[Gull Isle #1\]/);
  assert.match(els.importPreviewBody.innerHTML, /Gull Isle: 4/);
  assert.equal(els.importConfirm.textContent, 'Save series');
  assert.equal(get('"s" in DATA[0]'), false);             // nothing changed before confirming

  els.importConfirm.listeners.click[0]();
  await settle();
  assert.deepEqual(get('DATA[0]'), { t: 'Loose', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [{ id: 'B0LOOSE001' }] });
  assert.equal(get('SERIES_INFO["Gull Isle"].total'), 4);
  assert.equal(get('SERIES_INFO["Gull Isle"].status'), 'ongoing');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].seriesInfo['Gull Isle'].total, 4);
  assert.match(els.ioStatus.textContent, /Filled in the series of 1 book and released totals for 1 series/);

  // without make serve there is no lookup to offer
  const plain = await boot({ page: 'import.html', files: { 'data/books.json': mine } });
  assert.equal(plain.els.audiblePanel.style.display, 'none');
});

test('with make serve, an Audible import can go on to look up the new books\' series', async () => {
  const mine = JSON.stringify([{ t: 'Old Standalone', a: ['Ann Vale'], e: [{ id: 'B0OLD00001' }] }]);
  const lookups = [];
  const api = async (init, url) => {
    if (!init.method) return { status: 200, body: { writable: true, audible: true } };
    const body = JSON.parse(init.body);
    if (url === 'api/save') return { status: 200, body: { base: 'b', infoBase: 'i', books: body.books } };
    lookups.push(body);
    const results = Object.fromEntries(body.asins.map(a => [a, body.groups === 'series'
      ? [{ name: 'Gull Isle', number: '1', asin: 'B0GULLISLE' }] : 2]));
    return { status: 200, body: { results } };
  };
  const storage = new Map();
  const { els, get } = await boot({ page: 'import.html', files: { 'data/books.json': mine }, api, storage });
  assert.equal(els.importSeriesOption.style.display, '');
  els.importSeries.checked = true;
  els.importSeries.listeners.change[0]({ target: els.importSeries });
  assert.equal(storage.get('audiobook-catalog-import-series'), '1');

  els.importAudibleBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'library.csv',
    text: 'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\nx,Tidewater,,Ann Vale,,Finished,B0NEW00001\n' }], value: '' } });
  await els.importConfirm.listeners.click[0]();
  assert.deepEqual(lookups.map(l => l.asins), [['B0NEW00001'], ['B0GULLISLE']]);   // only the new book
  assert.equal(els.importPreviewTitle.textContent, 'Series from Audible');
  assert.match(els.importPreviewBody.innerHTML, /Added 1 book\. Their series:/);
  assert.match(els.importPreviewBody.innerHTML, /Tidewater &mdash; Ann Vale {2}\[Gull Isle #1\]/);
  els.importConfirm.listeners.click[0]();
  await settle();
  assert.deepEqual(get('DATA[1]'), { t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [{ id: 'B0NEW00001' }] });
  assert.equal(get('SERIES_INFO["Gull Isle"].total'), 2);

  // the choice is remembered in this browser
  const again = await boot({ page: 'import.html', files: { 'data/books.json': mine }, api, storage });
  assert.equal(again.els.importSeries.checked, true);
});

test('without make serve (or with the demo data) edits stay in the browser', async () => {
  let calls = 0;
  const api = async init => { calls++; assert.equal(init.method, undefined); return { status: 200, body: { writable: true } }; };
  const demo = await boot({ api });                     // demo data: only asks what the server can do, never saves
  assert.equal(demo.get('DISK_SAVE'), false);
  demo.run("DATA[0].t = 'Edited'; persist();");
  await settle();
  assert.equal(calls, 1);
  const plain = await boot({ files: { 'data/books.json': JSON.stringify([{ t: 'Mine', a: ['Me'] }]) } });
  assert.equal(plain.get('DISK_SAVE'), false);
  plain.run("DATA[0].t = 'Edited'; persist();");
  await settle();
  assert.ok(plain.storage.has('audiobook-catalog-data'));
});

test('duplicates page: found, merged with the picked title, or kept apart', async () => {
  const mine = JSON.stringify([
    { t: 'The Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', g: ['Fantasy'], e: [{ id: 'B1' }] },
    { t: 'Beacons', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '2', e: [{ id: 'BBOX', p: 'Gull Audio' }] },
    { t: 'Salt Road', a: ['Marisol Quenby'], n: ['Tobias Frane'], s: 'Lantern Coast', sn: '1', r: ['2023-06-02'], e: [{ gr: '4242' }] },
    { t: 'The Drowned Chart', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '3', e: [{ id: 'BBOX', p: 'Gull Audio' }] },
    { t: 'The Ledger', a: ['Priya Ostrander'] },
    { t: 'The Ledger, Book 1', a: ['Priya Ostrander'] },
  ]);
  const files = { 'data/books.json': mine };
  // every page's link says how many there are; a box set's titles share an edition but are not duplicates
  const home = await boot({ files });
  assert.equal(home.els.dupCount.textContent, ' (2)');

  const { ctx, els, get, run, storage } = await boot({ page: 'duplicates.html', files });
  assert.deepEqual(get('DUP_GROUPS'), [[0, 2], [4, 5]]);
  assert.match(els.subtitle.textContent, /^2 possible duplicates among 6 audiobooks/);
  assert.match(els.dupBody.innerHTML, /name="dup-0-t"[^>]*checked> <span class="dup-label">Title<\/span> The Salt Road/);
  assert.match(els.dupBody.innerHTML, /Becomes: The Salt Road/);

  // pick the second entry's title, then merge: one book with both editions, the narrator and the date read
  run('DUP_PICKS[0].t = 1; renderDuplicates()');
  assert.match(els.dupBody.innerHTML, /Becomes: Salt Road/);
  ctx.mergeGroup(0);
  assert.equal(get('DATA.length'), 5);
  assert.deepEqual(get('DATA[0]'), { t: 'Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1',
    g: ['Fantasy'], r: ['2023-06-02'], e: [{ id: 'B1', gr: '4242', n: ['Tobias Frane'] }] });   // Audible's and Goodreads' records of one edition
  assert.match(els.ioStatus.textContent, /^Merged 2 entries into Salt Road\./);
  assert.equal(get('EXCLUSIONS.size'), 0);              // the removed entry's ids live on in the kept book
  assert.deepEqual(get('DUP_GROUPS'), [[3, 4]]);
  assert.equal(els.dupCount.textContent, ' (1)');

  // "Not duplicates" is remembered in this browser, also after a reload
  ctx.keepApart(0);
  assert.match(els.dupBody.innerHTML, /No books look like duplicates/);
  assert.equal(els.dupCount.textContent, '');
  const again = await boot({ page: 'duplicates.html', files, storage });
  assert.deepEqual(again.get('DUP_GROUPS'), []);
  assert.equal(again.get('DATA.length'), 5);            // the merge was kept in this browser
});

test('the merge button pairs two books by hand and opens them on the duplicates page', async () => {
  const mine = JSON.stringify([{ t: 'Ledger', a: ['Priya Ostrander'] }, { t: 'Other', a: ['Ann Vale'] }, { t: 'The Ledger', a: ['P. Ostrander'], r: ['2024'] }]);
  const files = { 'data/books.json': mine };
  const home = await boot({ files });
  home.ctx.setView('library');
  home.ctx.pickMergeBook(2);
  assert.match(home.els.results.innerHTML, /class="book picked"/);
  assert.match(home.els.ioStatus.textContent, /Now press .* The Ledger with/);
  home.ctx.pickMergeBook(0);
  assert.equal(home.ctx.location.href, 'duplicates.html#merge=0,2');

  const { ctx, els, get } = await boot({ page: 'duplicates.html', files, hash: '#merge=0,2' });
  assert.deepEqual(get('DUP_GROUPS'), [[0, 2]]);
  assert.match(els.dupBody.innerHTML, /Picked by hand/);
  ctx.mergeGroup(0);
  assert.deepEqual(get('DATA'), [{ t: 'Ledger', a: ['Priya Ostrander'], r: ['2024'] }, { t: 'Other', a: ['Ann Vale'] }]);
  assert.equal(get('DUP_MANUAL'), null);
  assert.equal(ctx.location.hash, '');

  // an address naming no such books shows only what was found
  const stale = await boot({ page: 'duplicates.html', files, hash: '#merge=0,9' });
  assert.deepEqual(stale.get('DUP_GROUPS'), []);
});

test('an edit is not saved over changes another tab made meanwhile', async () => {
  const files = { 'data/books.json': JSON.stringify([{ t: 'Mine', a: ['Me'] }, { t: 'Yours', a: ['You'] }]) };
  const storage = new Map();
  const one = await boot({ files, storage });
  const two = await boot({ page: 'duplicates.html', files, storage });
  one.run("DATA[0].t = 'Edited Here'; persist();");
  two.run("DATA[1].t = 'Edited There'; persist();");
  assert.match(two.els.ioStatus.textContent, /changed in another tab/);
  assert.equal(JSON.parse(storage.get('audiobook-catalog-data')).data[0].t, 'Edited Here');
  one.run("DATA[1].t = 'Again Here'; persist();");      // the tab that saved last can keep going
  assert.equal(JSON.parse(storage.get('audiobook-catalog-data')).data[1].t, 'Again Here');
});

test('merging keeps editions apart when asked, and books merged that way can be joined later', async () => {
  const mine = JSON.stringify([
    { t: 'The Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', e: [{ id: 'B1', len: 642 }] },
    { t: 'Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', e: [{ gr: '4242', p: 'Gull Audio' }] },
    { t: 'Beacons', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '2', e: [{ id: 'B2' }, { gr: '777', isbn: '9780306406157' }] },
    { t: 'The Drowned Chart', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '3', e: [{ id: 'B3' }, { id: 'B3X' }] },
    { t: 'Box Set', a: ['Marisol Quenby'], e: [{ id: 'BBOX' }, { gr: '888' }] },
    { t: 'Other In Box', a: ['Marisol Quenby'], e: [{ id: 'BBOX' }] },
  ]);
  const files = { 'data/books.json': mine };
  const { ctx, els, get, run, storage } = await boot({ page: 'duplicates.html', files });
  // Beacons (an ASIN edition and a Goodreads one) is listed; two ASINs, or a box set's shared edition, are not
  assert.deepEqual(get('SPLIT'), [2]);
  assert.match(els.subtitle.textContent, /1 book with editions that look like one/);
  assert.equal(els.dupCount.textContent, ' (2)');
  assert.match(els.dupBody.innerHTML, /class="dup-joinbox" data-g="0" checked/);

  // untick "Make the editions one edition": the merge keeps both
  run('DUP_PICKS[0].joinEditions = false; renderDuplicates()');
  assert.match(els.dupBody.innerHTML, /class="dup-joinbox" data-g="0">/);
  ctx.mergeGroup(0);
  assert.deepEqual(get('DATA[0].e'), [{ id: 'B1', len: 642 }, { gr: '4242', p: 'Gull Audio' }]);
  // ...and the merged book is now offered for joining, like Beacons
  assert.deepEqual(get('SPLIT'), [0, 1]);
  ctx.joinBookEditions(0);
  assert.deepEqual(get('DATA[0].e'), [{ id: 'B1', gr: '4242', p: 'Gull Audio', len: 642 }]);
  assert.match(els.ioStatus.textContent, /^The Salt Road now has one edition\./);
  // "Keep separate" is remembered in this browser
  ctx.keepEditionsApart(get('SPLIT[0]'));
  assert.deepEqual(get('SPLIT'), []);
  const again = await boot({ page: 'duplicates.html', files: { 'data/books.json': JSON.stringify(get('DATA')) }, storage: new Map([...storage].filter(([k]) => k !== 'audiobook-catalog-data')) });
  assert.deepEqual(again.get('SPLIT'), []);
  assert.equal(again.els.dupCount.textContent, '');
});

test('restoring a backup where only the demo is served makes it this device\'s own catalogue', async () => {
  const backup = { books: [{ t: 'Pocket Edition', a: ['Ann Vale'], r: ['2025-06-01'] }], seriesInfo: {}, excluded: ['BGONE3'] };
  const imp = await boot({ page: 'import.html' });
  imp.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
  assert.equal(imp.get('ON_DEVICE'), true);
  assert.match(imp.els.ioStatus.textContent, /This device now keeps its own catalogue\./);
  assert.deepEqual(JSON.parse(imp.storage.get('audiobook-catalog-device')), backup);

  // it loads instead of the demo, even after the demo data changes, and edits are kept with it
  const files = { 'data/sample/books.json': '[{"t":"Another Demo","a":"Nobody"}]', 'data/sample/series-info.json': '{}' };
  const { ctx, els, get, storage } = await boot({ files, storage: new Map(imp.storage) });
  assert.deepEqual(get('DATA'), backup.books);
  assert.deepEqual(get('EXCLUSIONS.entries'), ['BGONE3']);
  ctx.setView('library');
  removeBook(ctx, 0);
  assert.equal(els.ioStatus.textContent, 'Removed Pocket Edition; imports will skip it.');
  const kept = JSON.parse(storage.get('audiobook-catalog-device'));
  assert.deepEqual(kept.books, []);
  assert.deepEqual(kept.excluded, ['BGONE3', 'Pocket Edition | Ann Vale']);

  // a page served with its own data/books.json ignores it, and a restore there does not switch
  const mine = JSON.stringify([{ t: 'Mine', a: ['Me'] }]);
  const served = await boot({ page: 'import.html', files: { 'data/books.json': mine }, storage: new Map(storage) });
  assert.deepEqual(served.get('DATA'), [{ t: 'Mine', a: ['Me'] }]);
  served.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
  assert.equal(served.get('ON_DEVICE'), false);
  assert.doesNotMatch(served.els.ioStatus.textContent, /own catalogue/);
});

test('the app can be installed: the manifest\'s icons and everything the service worker caches exist', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(root, icon.src)), icon.src);
  assert.ok(manifest.icons.some(i => i.sizes === '512x512') && manifest.icons.some(i => i.sizes === '192x192'));
  const cached = JSON.parse(read('sw.js').match(/const APP = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const file of cached.filter(f => f !== './')) assert.ok(fs.existsSync(path.join(root, file)), file);
  for (const page of PAGES) {
    assert.ok(cached.includes(page), `sw.js caches ${page}`);
    assert.ok(read(page).includes('<link rel="manifest" href="manifest.webmanifest">'), page);
    for (const [, src] of read(page).matchAll(/<script src="([^"]+)">/g)) assert.ok(cached.includes(src), `sw.js caches ${src}`);
  }
  assert.ok(!cached.some(f => f.startsWith('data/') && !f.startsWith('data/sample/')), 'never your own data');
});

test('"Not duplicates" marks come from data/not-duplicates.txt, are saved there by make serve, and travel in backups', async () => {
  const books = [{ t: 'The Ledger', a: ['Priya Ostrander'] }, { t: 'The Ledger, Book 1', a: ['Priya Ostrander'] },
    { t: 'Salt Road', a: ['Marisol Quenby'] }, { t: 'Salt Road, Book 1', a: ['Marisol Quenby'] }];
  const pairKey = (x, y) => createRequire(import.meta.url)('../importers.js').duplicatePairKey(books[x], books[y]);
  const saves = [];
  const api = async init => {
    if (!init.method) return { status: 200, body: { writable: true } };
    const body = JSON.parse(init.body);
    saves.push(body);
    return { status: 200, body: { base: 'b' + saves.length, infoBase: 'i' + saves.length, books: body.books } };
  };
  const ledger = pairKey(0, 1);
  const files = { 'data/books.json': JSON.stringify(books), 'data/not-duplicates.txt': '# header\n' + ledger + '\n' };
  const { ctx, get, els } = await boot({ page: 'duplicates.html', files, api });
  // the file's marks hide that pair; nothing to save yet
  assert.deepEqual(get('DUP_GROUPS'), [[2, 3]]);
  assert.equal(saves.length, 0);

  // marking the other pair saves it, and only it, to the file
  ctx.keepApart(0);
  await settle();
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].notDuplicates, [pairKey(2, 3)]);
  assert.deepEqual(get('DUP_GROUPS'), []);
  assert.equal(els.dupCount.textContent, '');

  // Export carries every mark; Restore elsewhere brings them back
  const imp = await boot({ page: 'import.html', files });
  const blobs = [];
  imp.ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
  imp.ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  imp.els.exportBtn.listeners.click[0]();
  assert.deepEqual(JSON.parse(blobs[0]).notDuplicates, [ledger]);
  const backup = { books, seriesInfo: {}, notDuplicates: [ledger, pairKey(2, 3)] };
  const other = await boot({ page: 'import.html', files: { 'data/books.json': JSON.stringify(books) } });
  other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
  const after = await boot({ page: 'duplicates.html', files: { 'data/books.json': JSON.stringify(books) }, storage: other.storage });
  assert.deepEqual(after.get('DUP_GROUPS'), []);

  // marks made before they could be saved to the file are saved when the page loads under make serve
  const early = await boot({ page: 'duplicates.html', files: { 'data/books.json': JSON.stringify(books) }, storage: other.storage, api });
  await settle();
  assert.deepEqual(saves[saves.length - 1].notDuplicates, [ledger, pairKey(2, 3)]);
  assert.equal(early.get('pendingNotDuplicates().length'), 0);
});

test('Merge previews a backup from another device and keeps both sides\' changes', async () => {
  const mine = JSON.stringify([{ t: 'Here', a: ['Ann Vale'] }, { t: 'Renamed', a: ['Ann Vale'], e: [{ id: 'B1' }] }]);
  const backup = { books: [{ t: 'Here', a: ['Ann Vale'], r: ['2025-06-01'] }, { t: 'Renamed Twice', a: ['Ann Vale'], e: [{ id: 'B1' }] },
    { t: 'New There', a: ['Ann Vale'] }], seriesInfo: {}, excluded: ['BGONE9'], notDuplicates: ['["editions","id B1"]'] };
  const { els, get, storage } = await boot({ page: 'import.html', files: { 'data/books.json': mine } });
  els.mergeFile.listeners.change[0]({ target: { files: [{ name: 'phone.json', text: JSON.stringify(backup) }], value: '' } });
  assert.equal(els.importPreviewTitle.textContent, 'Merge a backup');
  assert.ok(els.mergePrefer.classList.contains('show'));
  assert.match(els.importPreviewBody.innerHTML, /New from the backup: 1<\/p><ul><li>New There &mdash; Ann Vale/);
  assert.match(els.importPreviewBody.innerHTML, /keeping this catalogue's: 1<\/p><ul><li>Renamed &mdash; Ann Vale \/ backup: Renamed Twice/);
  assert.match(els.importPreviewBody.innerHTML, /More books marked "Not duplicates": 1/);
  assert.equal(get('DATA.length'), 2, 'nothing changes before it is confirmed');

  // preferring the backup's version redraws the preview, and confirming applies it
  els.mergePreferSelect.value = 'backup';
  els.mergePreferSelect.listeners.change[0]();
  assert.match(els.importPreviewBody.innerHTML, /keeping the backup's: 1/);
  els.importConfirm.listeners.click[0]();
  assert.deepEqual(get('DATA'), backup.books);
  assert.deepEqual(get('NEW_EXCLUDED'), ['BGONE9']);
  assert.deepEqual(get('[...NOT_DUPLICATES]'), ['["editions","id B1"]']);
  assert.deepEqual(JSON.parse(storage.get('audiobook-catalog-not-duplicates')), ['["editions","id B1"]']);
  assert.match(els.ioStatus.textContent, /^Merged: 1 added, 2 updated, 0 removed\./);
  assert.deepEqual(JSON.parse(storage.get('audiobook-catalog-data')).data, backup.books);
  assert.ok(!els.importPreview.classList.contains('open'));

  // merging the same backup again has nothing to do
  els.mergeFile.listeners.change[0]({ target: { files: [{ name: 'phone.json', text: JSON.stringify(backup) }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /Nothing to merge/);
  assert.equal(els.importConfirm.style.display, 'none');
});

/**
 * A stand-in for `make serve`'s Hardcover endpoints: POST api/hardcover starts a run, and each GET after
 * that answers with the next of `steps` (progress updates, then the finished run). `ticks` holds the page's
 * pending polls (its setTimeout(…, 1000)); tick() runs them, as time passing would.
 */
function fakeHardcoverServer(steps) {
  const calls = [], ticks = [];
  let token = false, job = null, queue = [];
  const api = async (init, url) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([url, init.method || 'GET', body]);
    if (url === 'api/save') return { status: 200, body: { writable: true, audible: true, hardcover: true } };
    if (url === 'api/hardcover/token') {
      if (init.method === 'PUT') token = true;
      if (init.method === 'DELETE') token = false;
      return { status: 200, body: { token } };
    }
    if (init.method === 'POST') {
      job = { id: calls.length, mode: body.mode, dryRun: body.dryRun, running: true, elapsed: 0, step: 'Starting' };
      queue = steps(body).map(x => ({ ...job, ...x }));
      return { status: 202, body: { job } };
    }
    if (queue.length) job = queue.shift();
    return { status: 200, body: { job } };
  };
  const setTimeout = (fn, ms) => { if (ms === 1000) ticks.push(fn); return 0; };
  const tick = async () => { while (ticks.length) { ticks.shift()(); await settle(); await settle(); } };
  return { api, calls, ticks, setTimeout, tick };
}

test('with make serve, the Hardcover panel saves the token and previews, then runs, an import in the background', async () => {
  const mine = JSON.stringify([{ t: 'Lantern Hours', a: ['R. T. Hale'] }]);
  const files = { 'data/books.json': mine };
  const server = fakeHardcoverServer(body => body.dryRun
    ? [{ running: false, elapsed: 2000, step: 'Done', code: 0, out: 'Hardcover: 1 books on your Read shelf\n  new: 1\n    + Tidewater - Ann Vale\n(dry run: nothing written)', err: '' }]
    : [{ step: 'Putting books on your Hardcover Read shelf', done: 3, total: 10, elapsed: 65000 },
       (files['data/books.json'] = JSON.stringify([...JSON.parse(mine), { t: 'Tidewater', a: ['Ann Vale'] }]),
        { running: false, elapsed: 70000, step: 'Done', code: 0, out: 'wrote data/books.json', err: '', base: 'new' })]);
  const { els, get } = await boot({ page: 'import.html', files, api: server.api, setTimeout: server.setTimeout });
  await settle();
  assert.equal(els.hardcoverPanel.style.display, '');
  assert.match(els.hardcoverTokenState.textContent, /Paste an API token/);
  els.hardcoverToken.value = 'Bearer tok-123';
  await els.hardcoverTokenSave.listeners.click[0]();
  assert.deepEqual(server.calls.find(c => c[1] === 'PUT'), ['api/hardcover/token', 'PUT', { token: 'Bearer tok-123' }]);
  assert.equal(els.hardcoverToken.value, '', 'the token is not left in the page');
  assert.match(els.hardcoverTokenState.textContent, /saved with your catalogue/);

  // the preview runs in the background too: the banner shows it, the buttons wait
  const previewing = els.hardcoverImportBtn.listeners.click[0]();
  await settle(); await settle();
  const preview = server.calls.find(c => c[0] === 'api/hardcover' && c[1] === 'POST');
  assert.deepEqual([preview[2].mode, preview[2].dryRun, preview[2].base], ['import', true, get('BASELINE')]);
  assert.ok(els.bgTask.classList.contains('show'));
  assert.match(els.bgTask.innerHTML, /<span class="spinner" aria-hidden="true"><\/span>.*<strong>Checking what a Hardcover import would do<\/strong> <span class="bgTaskTime">0:00<\/span><br>Starting/);
  assert.doesNotMatch(els.bgTask.innerHTML, /Details/, 'no link to the page it is on');
  assert.equal(els.hardcoverSyncBtn.disabled, true);
  await server.tick();
  await previewing;
  assert.ok(!els.bgTask.classList.contains('show'));
  assert.equal(els.hardcoverSyncBtn.disabled, false);
  assert.equal(els.importPreviewTitle.textContent, 'Import from Hardcover: preview');
  assert.match(els.importPreviewBody.innerHTML, /<pre>Hardcover: 1 books on your Read shelf\n {2}new: 1\n {4}\+ Tidewater - Ann Vale\n?<\/pre>/);
  assert.equal(els.importConfirm.textContent, 'Import');
  assert.equal(get('DATA.length'), 1);

  // the real run: the banner counts along, then the page picks up what it wrote
  const applying = els.importConfirm.listeners.click[0]();
  await settle(); await settle();
  assert.equal(server.calls.filter(c => c[1] === 'POST' && c[0] === 'api/hardcover').at(-1)[2].dryRun, false);
  assert.match(els.bgTask.innerHTML, /<strong>Importing from Hardcover<\/strong>.*Please don't edit the catalogue until it is done/);
  server.ticks.splice(1);   // just the next poll
  const first = server.ticks.shift(); first(); await settle(); await settle();
  assert.match(els.bgTask.innerHTML, /<span class="bgTaskTime">1:05<\/span><br>Putting books on your Hardcover Read shelf: 3 of 10 <progress max="10" value="3"><\/progress>/);
  await server.tick();
  await applying;
  await settle();
  assert.ok(!els.bgTask.classList.contains('show'));
  assert.equal(get('DATA.length'), 2, 'the page reloads the catalogue the server wrote');
  assert.equal(els.importPreviewTitle.textContent, 'Import from Hardcover (took 1:10)');
  assert.match(els.ioStatus.textContent, /Import from Hardcover: done\./);

  // without make serve, or with the demo data, there is nothing to show
  const plain = await boot({ page: 'import.html', files: { 'data/books.json': mine } });
  assert.equal(plain.els.hardcoverPanel.style.display, 'none');
});

test('every page shows a Hardcover run already going, and picks up what it wrote', async () => {
  const mine = JSON.stringify([{ t: 'Lantern Hours', a: ['R. T. Hale'] }]);
  const files = { 'data/books.json': mine };
  const server = fakeHardcoverServer(() => []);
  let gets = 0;
  const api = async (init, url) => {
    if (url !== 'api/hardcover') return server.api(init, url);
    gets++;
    if (gets === 1) return { status: 200, body: { job: { id: 7, mode: 'sync', dryRun: false, running: true, elapsed: 3000, step: 'Finding your books on Hardcover', done: 50, total: 200 } } };
    files['data/books.json'] = JSON.stringify([...JSON.parse(mine), { t: 'Tidewater', a: ['Ann Vale'] }]);
    return { status: 200, body: { job: { id: 7, mode: 'sync', dryRun: false, running: false, elapsed: 9000, step: 'Done', code: 0, out: '', err: '', base: 'new' } } };
  };
  const { els, get } = await boot({ files, api, setTimeout: server.setTimeout });
  await settle(); await settle();
  assert.ok(els.bgTask.classList.contains('show'));
  assert.match(els.bgTask.innerHTML, /<strong>Syncing with Hardcover<\/strong> <span class="bgTaskTime">0:03<\/span><br>Finding your books on Hardcover: 50 of 200/);
  assert.match(els.bgTask.innerHTML, /<a href="import.html">Details<\/a>/);
  await server.tick();
  await settle();
  assert.ok(!els.bgTask.classList.contains('show'));
  assert.equal(get('DATA.length'), 2);
  assert.match(els.ioStatus.textContent, /Syncing with Hardcover: done\./);

  // a run that ended before the page loaded shows nothing
  const later = await boot({ files, api: async (init, url) => url === 'api/hardcover'
    ? { status: 200, body: { job: { id: 7, mode: 'sync', running: false, code: 0 } } } : server.api(init, url) });
  await settle();
  assert.ok(!later.els.bgTask.classList.contains('show'));
});
