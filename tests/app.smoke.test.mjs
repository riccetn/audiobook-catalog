// Smoke test for the browser app. Runs the real index.html + app.js (and the modules it imports) in
// Node against a tiny fake DOM and a fake localStorage holding the demo data, so it needs no dependencies
// and no browser. The modules run as ES modules in node:vm, which needs --experimental-vm-modules.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeHardcover, hardcoverState } from './fake-hardcover.mjs';
import * as CatalogImport from '../public/importers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The app is the public/ folder, what a static server serves; the demo data stays outside it.
const site = path.join(root, 'public');
const read = file => fs.readFileSync(path.join(site, file), 'utf8');
const PAGES = ['index.html', 'import.html', 'duplicates.html', 'authors.html'];
const readData = file => fs.readFileSync(path.join(root, 'data', 'sample', file), 'utf8');
const DEMO_BOOKS = readData('books.json');
const DEMO_INFO = readData('series-info.json');
const DEMO_AUTHORS = readData('authors.json');

// The module a page loads with <script type="module">, and the modules it imports, in load order.
const entryOf = page => [...read(page).matchAll(/<script type="module" src="([^"]+)">/g)].map(m => m[1]);
function modulesOf(file, seen = new Set()) {
  seen.add(file);
  for (const [, dep] of read(file).matchAll(/^import [^;]* from '\.\/([^']+)';$/gm)) if (!seen.has(dep)) modulesOf(dep, seen);
  return [...seen];
}

/** Run the page's module and the modules it imports in `context`; returns their namespaces by file. */
async function runModules(entry, context) {
  if (!vm.SourceTextModule) throw new Error('the smoke test needs node --experimental-vm-modules (make test passes it)');
  const modules = new Map();
  const load = file => {
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(read(file), { context, identifier: file }));
    return modules.get(file);
  };
  const main = load(entry);
  await main.link(specifier => load(path.posix.normalize(specifier)));
  await main.evaluate();
  return new Map([...modules].map(([file, m]) => [file, m.namespace]));
}

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

const CATALOG_KEY = 'audiobook-catalog-device';
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
const DEMO = { 'books.json': DEMO_BOOKS, 'series-info.json': DEMO_INFO, 'authors.json': DEMO_AUTHORS };
// The catalogue in localStorage, made of data files ({'books.json': text, 'series-info.json': ..., 'excluded.txt': ...}) as written.
function stored(files) {
  const json = (name, empty) => JSON.parse(files[name] || empty);
  const catalogue = { books: json('books.json', '[]'), seriesInfo: json('series-info.json', '{}'), authors: json('authors.json', '{}'),
    excluded: CatalogImport.parseExclusions(files['excluded.txt'] || '').entries };
  return JSON.stringify(catalogue);
}
// What the page keeps in localStorage now.
const kept = storage => JSON.parse(storage.get(CATALOG_KEY));

/**
 * Load the page into a fresh fake browser. `storage` is a Map standing in for localStorage; unless it
 * holds a catalogue already, the catalogue is made of `files` (see stored(); default: the demo data), or
 * there is none when `files` is null.
 */
async function boot({ page = 'index.html', files = DEMO, storage = new Map(), hash = '', setTimeout = () => 0, hardcover = null } = {}) {
  if (files && !storage.has(CATALOG_KEY)) storage.set(CATALOG_KEY, stored(files));
  if (files && files['not-duplicates.txt'] && !storage.has(NOT_DUP_KEY)) {
    storage.set(NOT_DUP_KEY, JSON.stringify(CatalogImport.parseNotDuplicates(files['not-duplicates.txt'])));
  }
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
  // The page asks nothing of the server it came from; only Hardcover, when a test gives a fake of it.
  const fetch = async (url, init = {}) => {
    if (url.startsWith('https://api.hardcover.app/')) {
      if (!hardcover) throw new TypeError('Failed to fetch');
      return hardcover(url, init);
    }
    throw new Error(`the page fetched ${url}`);
  };
  // Files picked in a fake <input type="file"> are {name, text}; reading one completes at once.
  class FileReader { readAsText(file) { this.onload({ target: { result: file.text } }); } }
  // The session history: `entries` of {hash, state}, `at` the current one; back() and forward() fire popstate.
  const location = { href: page, hash, pathname: '/' + page };
  const windowListeners = {};
  const fire = (type, event = {}) => (windowListeners[type] || []).forEach(fn => fn(event));
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
  const context = vm.createContext({ document, localStorage, fetch, FileReader, location, history, addEventListener,
    console, setTimeout, clearTimeout() {}, setInterval: () => 0, clearInterval() {} });
  const [entry] = entryOf(page);
  const namespaces = await runModules(entry, context);
  // What the modules export (CatalogImport for importers.js), live: DATA is whatever store.js holds now.
  const exported = {};
  for (const [file, ns] of namespaces) {
    const names = file === 'importers.js' ? { CatalogImport: () => ns } : Object.fromEntries(Object.keys(ns).map(k => [k, () => ns[k]]));
    for (const [name, value] of Object.entries(names)) {
      const set = () => { throw new TypeError(`${name} is a module's binding: only ${file} can assign it`); };
      Object.defineProperty(exported, name, { get: value, set, enumerable: true });
    }
  }
  await exported.READY;
  // Test code runs in the page's context with the exports in scope; the modules themselves only see
  // what they import, so a missing import still fails here as it would in a browser.
  const inScope = vm.runInContext('(function (code) { with (this) return eval(code); })', context);
  const run = code => inScope.call(exported, code);
  // Values cross the VM boundary as JSON so deepEqual is not confused by a different Object.prototype.
  const get = expr => JSON.parse(run(`JSON.stringify(${expr})`));
  // ctx.render(), ctx.DATA etc. are the exports; anything else (ctx.location, ctx.Blob = ...) the page's globals.
  const ctx = new Proxy(context, { get: (target, key) => (key in exported ? exported[key] : target[key]) });
  return { ctx, els, storage, get, run, fire };
}

for (const page of PAGES) {
  const html = read(page);
  assert.equal(entryOf(page).length, 1, `${page} loads one module`);
  assert.ok(!/<script(?! type="module")/.test(html), `${page} loads no plain scripts`);
  for (const shared of ['importers.js', 'store.js']) assert.ok(modulesOf(entryOf(page)[0]).includes(shared), `${page} imports ${shared}`);
  assert.ok(html.includes('<link rel="stylesheet" href="styles.css">'), page);
  for (const other of PAGES) assert.ok(html.includes(`href="${other}"`), `${page} links to ${other}`);
}
const demoBooks = JSON.parse(DEMO_BOOKS);

// The book form's edition cards: what each card's fields hold, typing into one, adding and removing cards.
const formEditions = get => get('FORM_EDITIONS.map(x => x.fields)');
const typeEdition = (els, i, k, value) => els.f_editions.listeners.input[0]({ target: { dataset: { i: String(i), k }, value } });
const addEdition = els => els.addEditionBtn.listeners.click[0]({});
const removeEdition = (els, i) => els.f_editions.listeners.click[0]({ target: { closest: () => ({ dataset: { remove: String(i) } }) } });

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
  assert.equal((found.els.results.innerHTML.match(/class="book"/g) || []).length, 4);
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
  run("DATA[0].e = [{asin: { 'audible.com': 'TESTASIN01' }, gr: '4242', p: 'Gull Audio', len: 642}, {asin: { 'audible.com': 'TESTASIN02' }}]");
  ctx.setView('library');
  ctx.openEditForm(0);
  assert.equal(els.formTitle.textContent, 'Edit book');
  assert.deepEqual(formEditions(get), [{ 'asin:audible.com': 'TESTASIN01', gr: '4242', p: 'Gull Audio', len: '10h 42m' }, { 'asin:audible.com': 'TESTASIN02' }]);
  assert.match(els.f_editions.innerHTML, /Edition 2/);
  assert.match(els.f_editions.innerHTML, /<input data-i="0" data-k="len" value="10h 42m"/);
  els.f_t.value = 'Renamed In The App';
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.deepEqual(get('({t: DATA[0].t, e: DATA[0].e})'),
    { t: 'Renamed In The App', e: [{ asin: { 'audible.com': 'TESTASIN01' }, gr: '4242', p: 'Gull Audio', len: 642 }, { asin: { 'audible.com': 'TESTASIN02' } }] });
});

test('book cards link an edition\'s ASIN to Audible and its Goodreads id to Goodreads', async () => {
  const { ctx, els, run } = await boot();
  run("DATA[0].e = [{asin: { 'audible.com': 'TESTASIN01' }, gr: '4242', p: 'Gull Audio', len: 642}, {isbn: '9780000000002'}]");
  ctx.setView('library');
  ctx.render();
  const html = els.results.innerHTML;
  assert.match(html, /ASIN audible\.com <a href="https:\/\/www\.audible\.com\/pd\/TESTASIN01" target="_blank" rel="noopener">TESTASIN01<\/a>; Goodreads <a href="https:\/\/www\.goodreads\.com\/book\/show\/4242" target="_blank" rel="noopener">4242<\/a>; Publisher Gull Audio; Length 10h 42m/);
  // an edition without either id has no links
  assert.match(html, /<div class="edition">ISBN 9780000000002<\/div>/);
  // each site's ASIN links to the book on that site
  run("DATA[0].e = [{asin: { 'audible.co.uk': 'TESTASIN02', 'amazon.com': 'TESTASIN03' }}]");
  ctx.render();
  assert.match(els.results.innerHTML, /ASIN audible\.co\.uk <a href="https:\/\/www\.audible\.co\.uk\/pd\/TESTASIN02"[^>]*>TESTASIN02<\/a>, amazon\.com <a href="https:\/\/www\.amazon\.com\/dp\/TESTASIN03"[^>]*>TESTASIN03<\/a><\/div>/);
});

test('the book form has a field for each site an edition has an ASIN on, and adds one for another site', async () => {
  const { ctx, els, get, run } = await boot();
  run("DATA[0].e = [{asin: { 'audible.com': 'TESTASIN01', 'amazon.co.uk': 'TESTASIN02' }}, {gr: '4242'}]");
  ctx.setView('library');
  ctx.openEditForm(0);
  // audible.com and the sites in use have a field; the others wait in the list
  assert.match(els.f_editions.innerHTML, /<label>audible\.com<\/label><input data-i="0" data-k="asin:audible\.com" value="TESTASIN01"/);
  assert.match(els.f_editions.innerHTML, /data-k="asin:amazon\.co\.uk" value="TESTASIN02"/);
  assert.match(els.f_editions.innerHTML, /<label>audible\.com<\/label><input data-i="1" data-k="asin:audible\.com" value=""/);
  assert.doesNotMatch(els.f_editions.innerHTML, /data-k="asin:amazon\.com"/);
  assert.match(els.f_editions.innerHTML, /<select data-add-site="0"[^>]*><option value="">\+ Another site<\/option><option value="amazon\.com">/);
  // picking a site from the list gives it a field
  els.f_editions.listeners.change[0]({ target: { dataset: { addSite: '0' }, value: 'amazon.com' } });
  assert.match(els.f_editions.innerHTML, /data-i="0" data-k="asin:amazon\.com" value=""/);
  typeEdition(els, 0, 'asin:amazon.com', 'https://www.amazon.com/dp/TESTASIN03?ref=x');
  typeEdition(els, 1, 'asin:audible.com', 'testasin04');
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.deepEqual(get('DATA[0].e'), [{ asin: { 'audible.com': 'TESTASIN01', 'amazon.co.uk': 'TESTASIN02', 'amazon.com': 'TESTASIN03' } },
    { asin: { 'audible.com': 'TESTASIN04' }, gr: '4242' }]);
  // emptying a site's field drops that ASIN; something that isn't an ASIN is named
  ctx.openEditForm(0);
  typeEdition(els, 0, 'asin:amazon.co.uk', '');
  typeEdition(els, 1, 'asin:audible.com', 'not an asin');
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.match(els.formError.textContent, /Not understood: edition 2: ASIN audible\.com not an asin/);
  typeEdition(els, 1, 'asin:audible.com', 'TESTASIN04');
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.deepEqual(get('DATA[0].e[0]'), { asin: { 'audible.com': 'TESTASIN01', 'amazon.com': 'TESTASIN03' } });
});

test('book cards link the Hardcover book and an edition\'s Hardcover id to Hardcover, and the edit form keeps them', async () => {
  const { ctx, els, get, run } = await boot();
  run("DATA[0].hcb = '808'; DATA[0].e = [{asin: { 'audible.com': 'TESTASIN01' }, hc: '31337'}]");
  ctx.setView('library');
  ctx.render();
  assert.match(els.results.innerHTML, /<div class="ids">Hardcover book <a href="https:\/\/hardcover\.app\/id\/book\/808" target="_blank" rel="noopener">808<\/a><\/div>/);
  assert.match(els.results.innerHTML, /ASIN audible\.com <a [^>]*>TESTASIN01<\/a>; Hardcover <a href="https:\/\/hardcover\.app\/id\/edition\/31337" target="_blank" rel="noopener">31337<\/a><\/div>/);
  els.q.value = '808';
  ctx.render();
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 1, 'searchable by its Hardcover book id');
  els.q.value = '';
  ctx.openEditForm(0);
  assert.equal(els.f_hcb.value, '808');
  assert.deepEqual(formEditions(get), [{ 'asin:audible.com': 'TESTASIN01', hc: '31337' }]);
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.deepEqual(get('[DATA[0].hcb, DATA[0].e]'), ['808', [{ asin: { 'audible.com': 'TESTASIN01' }, hc: '31337' }]]);

  // a Hardcover book id is a number; a book's address in an edition's Hardcover field goes on the book
  ctx.openEditForm(0);
  els.f_hcb.value = 'abc';
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.match(els.formError.textContent, /Not a Hardcover book id: abc/);
  els.f_hcb.value = '';
  addEdition(els);
  typeEdition(els, 1, 'hc', 'https://hardcover.app/id/book/909');
  els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  assert.deepEqual(get('[DATA[0].hcb, DATA[0].e]'), ['909', [{ asin: { 'audible.com': 'TESTASIN01' }, hc: '31337' }]]);
});

test('the Hardcover book field takes the address of a book or edition on Hardcover, and looks up its id', async () => {
  // the page asks Hardcover, with the token saved in this browser
  const hc = fakeHardcover(hardcoverState());
  const setTimeout = (fn, ms) => { if (ms === 1000) Promise.resolve().then(fn); return 0; };   // the pause between requests
  const storage = new Map();
  const { ctx, els, get } = await boot({ hardcover: hc.fetch, setTimeout, storage });
  const submit = () => els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
  ctx.openEditForm(0);
  els.f_hcb.value = 'https://hardcover.app/books/tidewater';
  await submit();
  assert.match(els.formError.textContent, /Couldn't find the Hardcover book: to look it up on Hardcover, save your Hardcover API token/);
  assert.equal(get("DATA[0].hcb || null"), null);
  assert.equal(hc.sent.length, 0);

  storage.set('audiobook-catalog-hardcover-token', 'tok-123');
  await submit();
  assert.equal(get('DATA[0].hcb'), '77');
  assert.match(els.ioStatus.textContent, /Found on Hardcover: Tidewater \(book 77\)/);
  // pasting an edition's address fills in its book's id as soon as the field is left
  ctx.openEditForm(0);
  els.f_hcb.value = 'https://hardcover.app/books/lantern-hours/editions/801';
  await els.f_hcb.listeners.change[0]();
  await settle(); await settle();
  assert.equal(els.f_hcb.value, '80');
  // a book's /id/ address holds its id: nothing to ask
  els.f_hcb.value = 'hardcover.app/id/book/81';
  const asked = hc.sent.length;
  await submit();
  assert.equal(get('DATA[0].hcb'), '81');
  assert.equal(hc.sent.length, asked);

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
  const { ctx, els, get } = await boot({ files: { 'books.json': mine } });
  ctx.setView('library');
  assert.match(els.results.innerHTML, /ISBN 9780306406157/);
  for (const q of ['9780306406157', '0-306-40615-2', '406157']) {
    els.q.value = q;
    ctx.render();
    assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 1, q);
  }
  els.q.value = '';

  ctx.openEditForm(0);
  assert.deepEqual(formEditions(get), [{ isbn: '9780306406157' }]);
  // another ISBN is another edition
  typeEdition(els, 0, 'isbn', '9780306406157, 978-0-00-000000-2');
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get('DATA[0].e'), [{ isbn: '9780306406157' }, { isbn: '9780000000002' }]);

  // the same ISBN may go on another book (a boxed set); the cards then say so
  ctx.openEditForm(1);
  typeEdition(els, 0, 'isbn', '0306406152');
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get('DATA[1].e'), [{ isbn: '9780306406157' }]);
  assert.match(els.results.innerHTML, /Also in this edition: <a href="#book=Boxed\+One">Boxed One<\/a>/);

  // a mistyped ISBN is refused with a message, and nothing changes
  ctx.openEditForm(1);
  typeEdition(els, 0, 'isbn', '9780306406158');
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.match(els.formError.textContent, /Not understood: edition 1: ISBN 9780306406158/);
  assert.deepEqual(get('DATA[1].e'), [{ isbn: '9780306406157' }]);
  typeEdition(els, 0, 'isbn', '');
  typeEdition(els, 0, 'gr', 'twelve');
  typeEdition(els, 0, 'd', 'someday');
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.match(els.formError.textContent, /Not understood: edition 1: Goodreads id twelve; edition 1: Released someday/);
  // removing the only card leaves an empty one, which is no edition
  removeEdition(els, 0);
  assert.deepEqual(formEditions(get), [{}]);
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
  assert.equal(formEditions(get)[0].n, 'Tobias Frane');
  assert.equal(formEditions(get)[0]['asin:audible.com'], 'SAMPLE0001');
  assert.equal(formEditions(get)[0]['asin:amazon.com'], 'SAMPLE0201');
  addEdition(els);
  typeEdition(els, 2, 'desc', 'Dramatized adaptation; unabridged');
  typeEdition(els, 2, 'n', 'A full cast');
  typeEdition(els, 2, 'gr', '777');
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(get(`DATA[${salt}].e[2]`), { gr: '777', n: ['A full cast'], desc: 'Dramatized adaptation; unabridged' });
});

test('box sets: kept as their own book, last in the series, and not counted as one more title', async () => {
  const { ctx, els } = await boot();
  ctx.openSeries('The Orchard Cycle');
  const titles = [...els.results.innerHTML.matchAll(/<div class="title"><a [^>]*>([^<]+)<\/a>/g)].map(m => m[1]);
  assert.deepEqual(titles, ['The Brass Orchard', 'The Copper Graft', 'Harvest of Gears', 'The Orchard Cycle: Books 2-3']);
  assert.match(els.results.innerHTML, /<span class="n">3 owned \+ 1 box set<\/span>/);
  ctx.setView('series');
  assert.match(els.results.innerHTML, /The Orchard Cycle<\/a>\s*<span class="srow-owned">3 owned<\/span>/);
});

test('box sets: the edition shows on each of its books, and editing it on one edits it on all', async () => {
  const { ctx, els, get } = await boot();
  ctx.setView('library');
  const two = demoBooks.findIndex(b => b.t === 'The Copper Graft'), three = demoBooks.findIndex(b => b.t === 'Harvest of Gears');
  assert.ok(two >= 0 && three >= 0, 'the demo data has a box set');
  assert.match(els.results.innerHTML, /ASIN audible.com <a [^>]*>SAMPLE0008<\/a>; ISBN 9780306406157; Publisher Kestrel Row Audio; Released 2022-11; Length 23h 5m/);
  assert.match(els.results.innerHTML, /Also in this edition: <a href="#book=Harvest\+of\+Gears">Harvest of Gears #3<\/a>/);
  assert.match(els.results.innerHTML, /Also in this edition: <a href="#book=The\+Copper\+Graft">The Copper Graft #2<\/a>/);
  els.q.value = 'kestrel row';
  ctx.render();
  assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 3, 'search finds a publisher (the box set\'s own book too)');
  els.q.value = '';

  ctx.openEditForm(two);
  assert.match(els.f_editions.innerHTML, /Also on Harvest of Gears, The Orchard Cycle: Books 2-3: changes here change it there too/);
  typeEdition(els, 0, 'p', 'Merlin Lane Audio');
  els.addForm.listeners.submit[0]({ preventDefault() {} });
  assert.equal(get(`DATA[${three}].e[0].p`), 'Merlin Lane Audio');
  assert.match(els.ioStatus.textContent, /Also updated the shared edition on 2 other books/);
});

test('a Goodreads import adds the ISBN to the edition of books already there', async () => {
  const mine = JSON.stringify([{ t: 'Old Favourite', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B1' } }], r: ['2020'] }]);
  const { els, get } = await boot({ page: 'import.html', files: { 'books.json': mine } });
  const csv = 'Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf,Date Read\n'
    + 'Old Favourite,Ann Vale,"=""0306406152""","=""9780306406157""",Audible Audio,read,2023/11/04\n';
  els.importGoodreadsBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'goodreads.csv', text: csv }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /ISBNs added to existing books: 1/);
  assert.equal(els.importConfirm.textContent, 'Save ISBNs');
  els.importConfirm.listeners.click[0]();
  assert.deepEqual(get('DATA[0].e'), [{ asin: { 'audible.com': 'B1' }, isbn: '9780306406157' }]);
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
  // each author's name links to their page
  assert.match(els.results.innerHTML, /<div class="meta"><a href="authors\.html#a=Ferran\+Doyle">Ferran Doyle<\/a>, <a href="authors\.html#a=Priya\+Ostrander">Priya Ostrander<\/a><\/div>/);
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
  const mine = JSON.stringify([{ t: 'Old Style', a: 'Ann Vale, Bo Reed', e: [{ asin: { 'audible.com': 'B1' }, n: 'Cy Hale, Di Moss' }] }]);
  const { ctx, els, get } = await boot({ files: { 'books.json': mine } });
  assert.deepEqual(get('DATA'), [{ t: 'Old Style', a: ['Ann Vale', 'Bo Reed'], e: [{ asin: { 'audible.com': 'B1' }, n: ['Cy Hale', 'Di Moss'] }] }]);
  ctx.setView('library');
  assert.match(els.authorFilter.innerHTML, /<option value="Bo Reed">/);
  assert.match(els.results.innerHTML, /Ann Vale<\/a>, <a [^>]*>Bo Reed<\/a> — narr\. Cy Hale, Di Moss/);
});

test('with no catalogue in this browser it starts empty, not with the demo, and says where books come from', async () => {
  const { els, get, run, storage } = await boot({ files: null });
  assert.deepEqual(get('DATA'), []);
  assert.deepEqual(get('SERIES_INFO'), {});
  assert.equal(els.subtitle.textContent, 'Your catalogue is empty');
  assert.match(els.results.innerHTML, /No books yet\. .*<a href="import\.html">Import &amp; export<\/a>/);
  assert.equal(storage.has(CATALOG_KEY), false, 'nothing is stored before the first edit');
  run("DATA.push({ t: 'First', a: ['Me'] })");
  run('persist()');
  assert.deepEqual(kept(storage), { books: [{ t: 'First', a: ['Me'] }], seriesInfo: {}, authors: {}, excluded: [] });
});

test('the catalogue is kept in this browser, from one page load to the next', async () => {
  const first = await boot();
  first.run("DATA[0].t = 'Edited Locally'");
  first.run('persist()');
  const again = await boot({ storage: new Map(first.storage) });
  assert.equal(again.get('DATA[0].t'), 'Edited Locally');
  assert.equal(again.get('DATA.length'), demoBooks.length);
});

test('edits from before, which waited for make serve to save them, become the catalogue', async () => {
  const old = { base: 'x', data: [{ t: 'Waiting', a: ['Me'] }], infoBase: 'y', info: { S: { total: 2, status: 'ongoing' } }, excluded: ['BGONE'] };
  const { get, storage } = await boot({ files: null, storage: new Map([['audiobook-catalog-data', JSON.stringify(old)]]) });
  assert.deepEqual(get('DATA'), old.data);
  assert.deepEqual(get('SERIES_INFO'), old.info);
  assert.deepEqual(get('EXCLUSIONS.entries'), ['BGONE']);
  assert.equal(storage.has(CATALOG_KEY), false);
});

test('a catalogue this browser can\'t read is set aside, not overwritten', async () => {
  const { get, els, storage } = await boot({ storage: new Map([[CATALOG_KEY, '{not json']]) });
  assert.deepEqual(get('DATA'), []);
  assert.equal(storage.get(CATALOG_KEY + '.unreadable'), '{not json');
  assert.equal(storage.has(CATALOG_KEY), false);
  assert.match(els.ioStatus.textContent, /set aside/);
});

test('importing an Audible CSV previews first, then adds only new books', async () => {
  const mine = JSON.stringify([{ t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5' }]);
  const { els, get } = await boot({ page: 'import.html', files: { 'books.json': mine, 'excluded.txt': 'BGONE\n' } });
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
  assert.match(els.importPreviewBody.innerHTML, /ASINs filled in on existing books: 1/);
  assert.match(els.importPreviewBody.innerHTML, /excluded from imports\): 1/);
  assert.match(els.importPreviewBody.innerHTML, /New: 1/);
  assert.match(els.importPreviewBody.innerHTML, /Ashfall/);
  assert.equal(els.importConfirm.textContent, 'Add 1 book');
  assert.equal(get('DATA.length'), 1);

  els.importConfirm.listeners.click[0]();
  assert.ok(!els.importPreview.classList.contains('open'));
  assert.deepEqual(get('DATA'), [
    { t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5', e: [{ asin: { 'audible.com': 'B5' } }] },
    { t: 'A Crown of Embers 6: Ashfall', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '6', e: [{ asin: { 'audible.com': 'B6' }, n: ['A. B. Quill'] }] },
  ]);
  assert.match(els.ioStatus.textContent, /Added 1 book, filled in 1 ASIN/);

  // the same file again: nothing to add, nothing to confirm
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'library.csv', text: csv }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /Nothing new to add/);
  assert.equal(els.importConfirm.style.display, 'none');
});

test('a date read written as a plain string loads, renders, and round-trips through Export / Import', async () => {
  const mine = JSON.stringify([{ t: 'Hand Edited', a: ['Ann Vale'], r: '2024-03-15' }, { t: 'Odd', a: ['Ann Vale'], r: 5 }]);
  const { ctx, els, get } = await boot({ files: { 'books.json': mine } });
  assert.deepEqual(get('DATA[0].r'), ['2024-03-15']);
  ctx.setView('library');
  assert.match(els.results.innerHTML, /Read 2024-03-15/);
  assert.match(els.readFilter.innerHTML, /Read in 2024/);

  const backup = JSON.stringify({ books: [{ t: 'From Backup', a: ['Ann Vale'], r: '2023-01-05' }], seriesInfo: {} });
  const storage = new Map();
  const imp = await boot({ page: 'import.html', files: { 'books.json': mine }, storage });
  await imp.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: backup }], value: '' } });
  assert.doesNotMatch(imp.els.ioStatus.textContent, /Couldn't read/);
  assert.deepEqual(imp.get('DATA'), [{ t: 'From Backup', a: ['Ann Vale'], r: ['2023-01-05'] }]);
  // back on the catalogue page
  const back = await boot({ files: { 'books.json': mine }, storage });
  back.ctx.setView('library');
  assert.match(back.els.results.innerHTML, /Read 2023-01-05/);
});

test('a Goodreads import fills in dates read on books that have none', async () => {
  const mine = JSON.stringify([{ t: 'Old Favourite', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B1' } }] }]);
  const { els, get } = await boot({ page: 'import.html', files: { 'books.json': mine } });
  const csv = 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n'
    + 'Old Favourite,Ann Vale,,Audible Audio,read,,2023/11/04\n';
  els.importGoodreadsBtn.listeners.click[0]();
  els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'goodreads.csv', text: csv }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /Dates read filled in on existing books: 1/);
  assert.equal(els.importConfirm.textContent, 'Save dates read');
  els.importConfirm.listeners.click[0]();
  assert.deepEqual(get('DATA'), [{ t: 'Old Favourite', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B1' } }], r: ['2023-11-04'] }]);
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

test('Export includes series and author info, and Import brings them back', async () => {
  const first = await boot({ page: 'import.html' });
  const blobs = [];
  first.ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
  first.ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  first.els.exportBtn.listeners.click[0]();
  const backup = JSON.parse(blobs[0]);
  assert.deepEqual(backup, { books: demoBooks, seriesInfo: JSON.parse(DEMO_INFO), authors: JSON.parse(DEMO_AUTHORS), excluded: [], notDuplicates: [] });

  // into a page that has no series info: it comes back, and survives a reload
  const mine = JSON.stringify([{ t: 'Mine', a: ['Me'] }]);
  const files = { 'books.json': mine };
  const other = await boot({ page: 'import.html', files });
  assert.deepEqual(other.get('[SERIES_INFO, AUTHORS]'), [{}, {}]);
  await other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
  assert.deepEqual(other.get('DATA'), demoBooks);
  assert.deepEqual(other.get('SERIES_INFO'), backup.seriesInfo);
  assert.deepEqual(other.get('AUTHORS'), backup.authors);
  const reloaded = await boot({ files, storage: new Map(other.storage) });
  assert.deepEqual(reloaded.get('SERIES_INFO'), backup.seriesInfo);
  assert.deepEqual(reloaded.get('AUTHORS'), backup.authors);

  // an older backup (a plain list of books) still imports and keeps the current series and author info
  const legacy = await boot({ page: 'import.html' });
  await legacy.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: mine }], value: '' } });
  assert.deepEqual(legacy.get('DATA'), [{ t: 'Mine', a: ['Me'] }]);
  assert.deepEqual(legacy.get('SERIES_INFO'), JSON.parse(DEMO_INFO));
  assert.deepEqual(legacy.get('AUTHORS'), JSON.parse(DEMO_AUTHORS));
});

test('Restore takes the data files of a catalogue from before it lived in the browser, picked together', async () => {
  const { els, get, storage } = await boot({ page: 'import.html', files: null });
  const books = [{ t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1' }, { t: 'Tide Water', a: ['Ann Vale'] }];
  const pair = CatalogImport.duplicatePairKey(books[0], books[1]);
  await els.importFile.listeners.change[0]({ target: { value: '', files: [
    { name: 'books.json', text: JSON.stringify(books) },
    { name: 'series-info.json', text: '{"Gull Isle":{"total":3,"status":"ongoing"}}' },
    { name: 'authors.json', text: '{"Ann Vale":{"bio":"Writes about the sea."}}' },
    { name: 'excluded.txt', text: '# books imports skip\nBGONE\n' },
    { name: 'not-duplicates.txt', text: pair + '\n' },
  ] } });
  assert.match(els.ioStatus.textContent, /^Restored 2 books and info for 1 series; 1 more excluded from imports\.$/);
  assert.deepEqual(kept(storage), { books, seriesInfo: { 'Gull Isle': { total: 3, status: 'ongoing' } },
    authors: { 'Ann Vale': { bio: 'Writes about the sea.' } }, excluded: ['BGONE'] });
  assert.deepEqual(get('[...NOT_DUPLICATES]'), [pair]);
  assert.equal(els.dupCount.textContent, '');

  // without books.json, or with a file that is none of these, nothing changes
  for (const files of [[{ name: 'series-info.json', text: '{}' }], [{ name: 'books.json', text: '[]' }, { name: 'notes.txt', text: 'hi' }]]) {
    await els.importFile.listeners.change[0]({ target: { value: '', files } });
    assert.match(els.ioStatus.textContent, /Couldn't read that/);
    assert.equal(get('DATA.length'), 2);
  }
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
  const files = { 'books.json': mine, 'excluded.txt': '# header\nBOLD\n' };
  const { ctx, els, get, storage } = await boot({ files });
  ctx.setView('library');
  removeBook(ctx, 1);
  assert.deepEqual(get('DATA'), [{ t: 'Keep', a: ['Ann Vale'] }]);
  assert.equal(els.ioStatus.textContent, 'Removed Gone; imports will skip it.');
  assert.deepEqual(kept(storage).excluded, ['BOLD', 'BGONE2', 'Gone | Ann Vale']);

  // on the import page, an import (Audible by id, or Goodreads by title) does not bring it back
  const imp = await boot({ page: 'import.html', files, storage });
  imp.els.importAudibleBtn.listeners.click[0]();
  imp.els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'l.csv', text:
    'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\nx,Gone,,Ann Vale,,Finished,BGONE2\n' }], value: '' } });
  assert.match(imp.els.importPreviewBody.innerHTML, /excluded from imports\): 1/);
  imp.els.importGoodreadsBtn.listeners.click[0]();
  imp.els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'g.csv', text:
    'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\nGone,Ann Vale,,Audible Audio,read,\n' }], value: '' } });
  assert.match(imp.els.importPreviewBody.innerHTML, /excluded from imports\): 1/);

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
  const other = await boot({ page: 'import.html', files: { 'books.json': '[]', 'excluded.txt': 'BOLD\nOther\n' } });
  await other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
  assert.deepEqual(other.get('EXCLUSIONS.entries'), ['BOLD', 'Other', 'BGONE2', 'Gone | Ann Vale']);
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
  const { ctx, els, get } = await boot({ files: { 'books.json': mine } });
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
  assert.deepEqual(kept(storage).seriesInfo[name].total, 7);

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

test('a series can be renamed from its series info form, on every book in it', async () => {
  const { ctx, els, get, storage } = await boot();
  const info = JSON.parse(DEMO_INFO);
  const [name] = Object.keys(info);
  const count = demoBooks.filter(b => b.s === name).length;
  assert.ok(count > 0);

  // shown from the series itself: the page follows the new name
  ctx.openSeries(name);
  ctx.openSeriesForm(name);
  assert.equal(els.sf_name.value, name);
  Object.assign(els.sf_name, { value: '  The Renamed   Saga ' });
  els.seriesForm.listeners.submit[0]({ preventDefault() {} });
  assert.ok(!els.seriesForm.classList.contains('open'));
  assert.equal(get(`DATA.filter(b => b.s === 'The Renamed Saga').length`), count);
  assert.equal(get(`DATA.some(b => b.s === ${JSON.stringify(name)})`), false);
  assert.deepEqual(get(`SERIES_INFO['The Renamed Saga']`), info[name]);
  assert.equal(get(`${JSON.stringify(name)} in SERIES_INFO`), false);
  assert.equal(get('SERIES_FILTER'), 'The Renamed Saga');
  assert.match(els.ioStatus.textContent, new RegExp(`Renamed .* on ${count} book`));
  const saved = kept(storage);
  assert.ok(saved.seriesInfo['The Renamed Saga']);
  assert.equal(saved.books.filter(b => b.s === 'The Renamed Saga').length, count);

  // a series without info is renamed without having to add some
  const bare = demoBooks.map(b => b.s).find(s => s && !(s in info));
  const bareCount = demoBooks.filter(b => b.s === bare).length;
  ctx.openSeriesForm(bare);
  Object.assign(els.sf_name, { value: 'Plain Renamed' });
  els.seriesForm.listeners.submit[0]({ preventDefault() {} });
  assert.equal(els.seriesFormError.textContent, '');
  assert.equal(get(`DATA.filter(b => b.s === 'Plain Renamed').length`), bareCount);
  assert.equal(get(`'Plain Renamed' in SERIES_INFO`), false);

  // an empty name is refused
  ctx.openSeriesForm('Plain Renamed');
  Object.assign(els.sf_name, { value: '   ' });
  els.seriesForm.listeners.submit[0]({ preventDefault() {} });
  assert.match(els.seriesFormError.textContent, /Give the series a name/);
  els.cancelSeries.listeners.click[0]();

  // joining another series takes a second Save, and its info gives way to this form's
  ctx.openSeriesForm('Plain Renamed');
  Object.assign(els.sf_name, { value: 'The Renamed Saga' });
  els.seriesForm.listeners.submit[0]({ preventDefault() {} });
  assert.ok(els.seriesForm.classList.contains('open'));
  assert.match(els.seriesFormError.textContent, /already a series called The Renamed Saga\. Press Save again/);
  assert.equal(get(`DATA.filter(b => b.s === 'Plain Renamed').length`), bareCount);
  els.seriesForm.listeners.submit[0]({ preventDefault() {} });
  assert.ok(!els.seriesForm.classList.contains('open'));
  assert.equal(get(`DATA.filter(b => b.s === 'The Renamed Saga').length`), count + bareCount);
  assert.deepEqual(get(`SERIES_INFO['The Renamed Saga']`), info[name]);
});

// Lets pending promises (a save on its way to the fake server) settle.
const settle = () => new Promise(resolve => setImmediate(resolve));

test('duplicates page: found, merged with the picked title, or kept apart', async () => {
  const mine = JSON.stringify([
    { t: 'The Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', g: ['Fantasy'], e: [{ asin: { 'audible.com': 'B1' } }] },
    { t: 'Beacons', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '2', e: [{ asin: { 'audible.com': 'BBOX' }, p: 'Gull Audio' }] },
    { t: 'Salt Road', a: ['Marisol Quenby'], n: ['Tobias Frane'], s: 'Lantern Coast', sn: '1', r: ['2023-06-02'], e: [{ gr: '4242' }] },
    { t: 'The Drowned Chart', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '3', e: [{ asin: { 'audible.com': 'BBOX' }, p: 'Gull Audio' }] },
    { t: 'The Ledger', a: ['Priya Ostrander'] },
    { t: 'The Ledger, Book 1', a: ['Priya Ostrander'] },
  ]);
  const files = { 'books.json': mine };
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
    g: ['Fantasy'], r: ['2023-06-02'], e: [{ asin: { 'audible.com': 'B1' }, gr: '4242', n: ['Tobias Frane'] }] });   // Audible's and Goodreads' records of one edition
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
  const files = { 'books.json': mine };
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
  const files = { 'books.json': JSON.stringify([{ t: 'Mine', a: ['Me'] }, { t: 'Yours', a: ['You'] }]) };
  const storage = new Map();
  const one = await boot({ files, storage });
  const two = await boot({ page: 'duplicates.html', files, storage });
  one.run("DATA[0].t = 'Edited Here'; persist();");
  two.run("DATA[1].t = 'Edited There'; persist();");
  assert.match(two.els.ioStatus.textContent, /changed in another tab/);
  assert.equal(kept(storage).books[0].t, 'Edited Here');
  one.run("DATA[1].t = 'Again Here'; persist();");      // the tab that saved last can keep going
  assert.equal(kept(storage).books[1].t, 'Again Here');
});

test('merging keeps editions apart when asked, and books merged that way can be joined later', async () => {
  const mine = JSON.stringify([
    { t: 'The Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', e: [{ asin: { 'audible.com': 'B1' }, len: 642 }] },
    { t: 'Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', e: [{ gr: '4242', p: 'Gull Audio' }] },
    { t: 'Beacons', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '2', e: [{ asin: { 'audible.com': 'B2' } }, { gr: '777', isbn: '9780306406157' }] },
    { t: 'The Drowned Chart', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '3', e: [{ asin: { 'audible.com': 'B3' } }, { asin: { 'audible.com': 'B3X' } }] },
    { t: 'Box Set', a: ['Marisol Quenby'], e: [{ asin: { 'audible.com': 'BBOX' } }, { gr: '888' }] },
    { t: 'Other In Box', a: ['Marisol Quenby'], e: [{ asin: { 'audible.com': 'BBOX' } }] },
  ]);
  const files = { 'books.json': mine };
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
  assert.deepEqual(get('DATA[0].e'), [{ asin: { 'audible.com': 'B1' }, len: 642 }, { gr: '4242', p: 'Gull Audio' }]);
  // ...and the merged book is now offered for joining, like Beacons
  assert.deepEqual(get('SPLIT'), [0, 1]);
  ctx.joinBookEditions(0);
  assert.deepEqual(get('DATA[0].e'), [{ asin: { 'audible.com': 'B1' }, gr: '4242', p: 'Gull Audio', len: 642 }]);
  assert.match(els.ioStatus.textContent, /^The Salt Road now has one edition\./);
  // "Keep separate" is remembered in this browser
  ctx.keepEditionsApart(get('SPLIT[0]'));
  assert.deepEqual(get('SPLIT'), []);
  const again = await boot({ page: 'duplicates.html', files: { 'books.json': JSON.stringify(get('DATA')) }, storage: new Map([...storage].filter(([k]) => k !== CATALOG_KEY)) });
  assert.deepEqual(again.get('SPLIT'), []);
  assert.equal(again.els.dupCount.textContent, '');
});

test('the app can be installed: the manifest\'s icons and everything the service worker caches exist', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(site, icon.src)), icon.src);
  assert.ok(manifest.icons.some(i => i.sizes === '512x512') && manifest.icons.some(i => i.sizes === '192x192'));
  const cached = JSON.parse(read('sw.js').match(/const APP = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const file of cached.filter(f => f !== './')) assert.ok(fs.existsSync(path.join(site, file)), file);
  for (const page of PAGES) {
    assert.ok(cached.includes(page), `sw.js caches ${page}`);
    assert.ok(read(page).includes('<link rel="manifest" href="manifest.webmanifest">'), page);
    for (const file of modulesOf(entryOf(page)[0])) assert.ok(cached.includes(file), `sw.js caches ${file}`);
  }
  // public/ is what gets served, so it holds the app and nothing else (no catalogue files, no notes).
  const served = fs.readdirSync(site, { recursive: true }).filter(f => fs.statSync(path.join(site, f)).isFile()).map(f => f.split(path.sep).join('/'));
  for (const file of served) assert.ok(file === 'sw.js' || cached.includes(file), `public/${file} is part of the app (add it to sw.js's APP list)`);
});

test('"Not duplicates" marks are kept in this browser and travel in backups', async () => {
  const books = [{ t: 'The Ledger', a: ['Priya Ostrander'] }, { t: 'The Ledger, Book 1', a: ['Priya Ostrander'] },
    { t: 'Salt Road', a: ['Marisol Quenby'] }, { t: 'Salt Road, Book 1', a: ['Marisol Quenby'] }];
  const pairKey = (x, y) => CatalogImport.duplicatePairKey(books[x], books[y]);
  const ledger = pairKey(0, 1);
  const files = { 'books.json': JSON.stringify(books), 'not-duplicates.txt': '# header\n' + ledger + '\n' };
  const { ctx, get, els, storage } = await boot({ page: 'duplicates.html', files });
  // the marks kept hide that pair
  assert.deepEqual(get('DUP_GROUPS'), [[2, 3]]);

  // marking the other pair keeps it too
  ctx.keepApart(0);
  assert.deepEqual(JSON.parse(storage.get(NOT_DUP_KEY)), [ledger, pairKey(2, 3)]);
  assert.deepEqual(get('DUP_GROUPS'), []);
  assert.equal(els.dupCount.textContent, '');

  // Export carries every mark; Restore elsewhere brings them back
  const imp = await boot({ page: 'import.html', files: { ...files, 'not-duplicates.txt': ledger } });
  const blobs = [];
  imp.ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
  imp.ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  imp.els.exportBtn.listeners.click[0]();
  assert.deepEqual(JSON.parse(blobs[0]).notDuplicates, [ledger]);
  const backup = { books, seriesInfo: {}, notDuplicates: [ledger, pairKey(2, 3)] };
  const other = await boot({ page: 'import.html', files: { 'books.json': JSON.stringify(books) } });
  await other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
  const after = await boot({ page: 'duplicates.html', storage: other.storage });
  assert.deepEqual(after.get('DUP_GROUPS'), []);
});

test('Merge previews a backup from another device and keeps both sides\' changes', async () => {
  const mine = JSON.stringify([{ t: 'Here', a: ['Ann Vale'] }, { t: 'Renamed', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B1' } }] }]);
  const backup = { books: [{ t: 'Here', a: ['Ann Vale'], r: ['2025-06-01'] }, { t: 'Renamed Twice', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B1' } }] },
    { t: 'New There', a: ['Ann Vale'] }], seriesInfo: {}, excluded: ['BGONE9'], notDuplicates: ['["editions","id B1"]'] };
  const { els, get, storage } = await boot({ page: 'import.html', files: { 'books.json': mine } });
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
  assert.deepEqual(get('EXCLUSIONS.entries'), ['BGONE9']);
  assert.deepEqual(get('[...NOT_DUPLICATES]'), ['["editions","id B1"]']);
  assert.deepEqual(JSON.parse(storage.get('audiobook-catalog-not-duplicates')), ['["editions","id B1"]']);
  assert.match(els.ioStatus.textContent, /^Merged: 1 added, 2 updated, 0 removed\./);
  assert.deepEqual(kept(storage).books, backup.books);
  assert.ok(!els.importPreview.classList.contains('open'));

  // merging the same backup again has nothing to do
  els.mergeFile.listeners.change[0]({ target: { files: [{ name: 'phone.json', text: JSON.stringify(backup) }], value: '' } });
  assert.match(els.importPreviewBody.innerHTML, /Nothing to merge/);
  assert.equal(els.importConfirm.style.display, 'none');
});

test('the page runs a Hardcover sync itself, with a token kept in this browser', async () => {
  const mine = [{ t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ asin: { 'audible.com': 'B0LANTERN1' } }] }];
  const state = hardcoverState();
  const hc = fakeHardcover(state);
  let leaving = null;   // what leaving the page during the run would do
  const hardcover = async (url, init) => {
    if (JSON.parse(init.body).query.startsWith('mutation') && !leaving) {
      leaving = { preventDefault() { this.prevented = true; } };
      page.fire('beforeunload', leaving);
    }
    return hc.fetch(url, init);
  };
  const setTimeout = (fn, ms) => { if (ms === 1000) Promise.resolve().then(fn); return 0; };   // the pause between requests
  const page = await boot({ page: 'import.html', files: { 'books.json': JSON.stringify(mine) }, hardcover, setTimeout });
  const { els, get, storage } = page;
  assert.notEqual(els.hardcoverPanel.style.display, 'none');
  assert.match(els.hardcoverTokenState.textContent, /Paste an API token .* kept in this browser only/);
  await els.hardcoverSyncBtn.listeners.click[0]();
  assert.match(els.ioStatus.textContent, /Save your Hardcover API token first/);
  assert.equal(hc.sent.length, 0);

  els.hardcoverToken.value = 'Bearer tok-123';
  await els.hardcoverTokenSave.listeners.click[0]();
  assert.equal(storage.get('audiobook-catalog-hardcover-token'), 'tok-123');
  assert.equal(els.hardcoverToken.value, '', 'the token is not left in the page');
  assert.match(els.hardcoverTokenState.textContent, /saved in this browser only/);

  // the preview: asked from the page, nothing changed anywhere
  await els.hardcoverSyncBtn.listeners.click[0]();
  assert.ok(hc.sent.every(s => s.auth === 'Bearer tok-123' && s.url === 'https://api.hardcover.app/v1/graphql'));
  assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));
  assert.ok(!els.bgTask.classList.contains('show'));
  assert.equal(els.importPreviewTitle.textContent, 'Sync with Hardcover: preview');
  assert.match(els.importPreviewBody.innerHTML, /\+ Tidewater - Ann Vale/);
  assert.match(els.importPreviewBody.innerHTML, /books to put on your Read shelf: 1\n {4}\+ Lantern Hours - R\. T\. Hale/);
  assert.doesNotMatch(els.importPreviewBody.innerHTML, /dry run/);
  assert.equal(get('DATA.length'), 1);
  assert.equal(state.shelf.length, 2);

  // the real run keeps the catalogue before sending, and the browser asks before leaving the page meanwhile
  await els.importConfirm.listeners.click[0]();
  assert.deepEqual(get('DATA.map(b => b.t)'), ['Lantern Hours', 'Tidewater']);
  assert.deepEqual(kept(storage).books.map(b => b.t), ['Lantern Hours', 'Tidewater']);
  assert.equal(get('DATA[0].hcb'), '80', 'the Hardcover ids found are kept');
  assert.deepEqual(state.shelf.at(-1), { id: 102, book_id: 80, edition_id: 801, status_id: 3, user_book_reads: [{ finished_at: '2024-05-01', edition_id: 801 }] });
  assert.ok(leaving.prevented, 'leaving during the run is asked about');
  const after = { preventDefault() { this.prevented = true; } };
  page.fire('beforeunload', after);
  assert.ok(!after.prevented, 'not once it is done');
  assert.match(els.importPreviewBody.innerHTML, /put 1 book\(s\) on your Hardcover Read shelf and added 1 read\(s\)/);
  assert.match(els.ioStatus.textContent, /Sync with Hardcover: done\./);
  assert.ok(!JSON.stringify(get('DATA')).includes('tok-123') && ![...storage.entries()].some(([k, v]) => k !== 'audiobook-catalog-hardcover-token' && v.includes('tok-123')));
});

test('a Hardcover run in the page writes and sends nothing when the catalogue is edited meanwhile, or Hardcover cannot be reached', async () => {
  const mine = [{ t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ asin: { 'audible.com': 'B0LANTERN1' } }] }];
  const state = hardcoverState();
  const hc = fakeHardcover(state);
  let edit = false;
  const hardcover = async (url, init) => {
    if (edit && JSON.parse(init.body).query.startsWith('query Find')) { edit = false; page.run("DATA[0].g = ['Fantasy']"); }
    return hc.fetch(url, init);
  };
  const setTimeout = (fn, ms) => { if (ms === 1000) Promise.resolve().then(fn); return 0; };
  const storage = new Map([['audiobook-catalog-hardcover-token', 'tok-123']]);
  const page = await boot({ page: 'import.html', files: { 'books.json': JSON.stringify(mine) }, hardcover, setTimeout, storage });
  const { els, get } = page;
  assert.match(els.hardcoverTokenState.textContent, /saved in this browser only/);
  await els.hardcoverExportBtn.listeners.click[0]();   // the preview, then the run, edited while it goes
  assert.equal(get('PENDING_HARDCOVER'), 'export');
  edit = true;
  await els.importConfirm.listeners.click[0]();
  assert.match(els.importPreviewBody.innerHTML, /the catalogue was edited while this ran .*nothing written, nothing sent to Hardcover/);
  assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));
  assert.equal(get('DATA[0].hcb || null'), null);
  assert.match(els.ioStatus.textContent, /Not everything went through/);

  const offline = await boot({ page: 'import.html', files: { 'books.json': JSON.stringify(mine) }, setTimeout, storage });
  await offline.els.hardcoverImportBtn.listeners.click[0]();
  assert.match(offline.els.importPreviewBody.innerHTML, /this browser could not reach Hardcover \(offline/);
  assert.equal(offline.els.importConfirm.style.display, 'none');
});

// ------------------------------------------------------------------ the authors page
test('the authors page lists every author, with their books and series, and a search narrows it', async () => {
  const { els } = await boot({ page: 'authors.html' });
  const authors = new Set(demoBooks.flatMap(b => b.a));
  assert.equal((els.authorBody.innerHTML.match(/class="srow-title"/g) || []).length, authors.size);
  assert.match(els.subtitle.textContent, new RegExp(`^${authors.size} authors across ${demoBooks.length} audiobooks`));
  assert.match(els.authorBody.innerHTML, /<a class="srow-title" href="authors\.html#a=Priya\+Ostrander">Priya Ostrander<\/a>\s*<span class="srow-owned">3 books, 1 series<\/span>/);
  // the first line of a bio, when there is one
  assert.match(els.authorBody.innerHTML, /Priya Ostrander writes cozy mysteries/);
  assert.ok(!els.crumb.classList.contains('show'));
  els.q.value = 'ferran';
  els.q.listeners.input[0]();
  assert.equal((els.authorBody.innerHTML.match(/class="srow-title"/g) || []).length, 1);
  els.q.value = 'zzzz';
  els.q.listeners.input[0]();
  assert.match(els.authorBody.innerHTML, /No authors match/);
});

test('an author\'s page shows their bio, their links, and their series and titles from the catalogue', async () => {
  const { ctx, els, fire } = await boot({ page: 'authors.html', hash: '#a=Marisol+Quenby' });
  const html = els.authorBody.innerHTML;
  assert.equal(ctx.document.title, 'Marisol Quenby · Audiobook Catalogue');
  assert.ok(els.crumb.classList.contains('show'));
  assert.equal(els.authorControls.style.display, 'none');
  assert.match(html, /<h2 class="author-name">Marisol Quenby<\/h2>/);
  assert.match(html, /<div class="author-bio"><p>Marisol Quenby writes seafaring fantasy[^<]*<\/p><p>The Lantern Coast began/);
  for (const [label, url] of [['Website', 'https://example.com/'], ['Audible', 'https://www.audible.com/author/'], ['Goodreads', 'https://www.goodreads.com/author/show/'], ['Hardcover', 'https://hardcover.app/authors/']]) {
    assert.match(html, new RegExp(`<a class="authorlink" href="${url.replace(/[./]/g, '\\$&')}[^"]*" target="_blank" rel="noopener">${label} ↗</a>`));
  }
  // the series, with how many are owned of the released total, its books in order, each a link to it in the catalogue
  assert.match(html, /<a href="index\.html#series=The\+Lantern\+Coast">The Lantern Coast<\/a> <span class="n">4 owned of 5<\/span> <span class="status ongoing">ongoing<\/span>/);
  assert.match(html, /#1<\/span> <a href="index\.html#book=The\+Salt\+Road">The Salt Road<\/a><\/li><li>.*#2<\/span> <a href="index\.html#book=Beacons\+at\+Low\+Tide">/);
  assert.equal(els.subtitle.textContent, '4 audiobooks in 1 series');

  // another author's page, by its address: her series, and a book outside it she wrote with someone else
  ctx.location.hash = '#a=Priya+Ostrander';
  fire('hashchange');
  const priya = els.authorBody.innerHTML;
  assert.match(priya, /Halloway &amp; Finch<\/a> <span class="n">2 owned of 2<\/span> <span class="status complete">/);
  assert.match(priya, /Outside a series <span class="n">1 book<\/span>/);
  assert.match(priya, /Nine Ways to Lose a Kingdom<\/a> <span class="with">with <a href="authors\.html#a=Ferran\+Doyle">Ferran Doyle<\/a><\/span>/);
  assert.equal(els.subtitle.textContent, '3 audiobooks in 1 series and 1 outside a series');

  // an author without info or series
  ctx.location.hash = '#a=Odalys+Rennick';
  fire('hashchange');
  assert.match(els.authorBody.innerHTML, /No bio or links yet/);
  assert.match(els.authorBody.innerHTML, /Titles <span class="n">1 book<\/span>/);
  ctx.location.hash = '#a=Nobody+Here';
  fire('hashchange');
  assert.equal(els.subtitle.textContent, 'No books by this author in the catalogue.');
  ctx.location.hash = '';
  fire('hashchange');
  assert.equal(ctx.AUTHOR, null);
  assert.match(els.authorBody.innerHTML, /class="srow-title"/);
});

test('author info can be added, edited and removed on the author\'s page, and links are checked', async () => {
  const { els, get, storage } = await boot({ page: 'authors.html', hash: '#a=Wendell+Ashcombe' });
  const editClick = () => els.authorBody.listeners.click[0]({ target: { closest: sel => (sel === '[data-edit-author]' ? {} : null) } });
  const submit = () => els.authorForm.listeners.submit[0]({ preventDefault() {} });
  editClick();
  assert.ok(els.authorForm.classList.contains('open'));
  assert.equal(els.authorFormTitle.textContent, 'Add author info: Wendell Ashcombe');
  assert.equal(els.authorRemoveBtn.style.display, 'none');
  els.af_bio.value = '  Builds   clockwork worlds.\n\nLives by a canal. ';
  els.af_url.value = 'wendell.example';
  submit();
  assert.match(els.authorFormError.textContent, /'url' must be a web address/);
  els.af_url.value = 'https://wendell.example/';
  els.af_goodreads.value = 'https://hardcover.app/authors/wendell';   // pasted into the wrong field
  submit();
  assert.match(els.authorFormError.textContent, /'goodreads' should be an address on Goodreads/);
  assert.equal(get("AUTHORS['Wendell Ashcombe'] || null"), null);
  els.af_goodreads.value = '';
  els.af_hardcover.value = 'https://hardcover.app/authors/wendell';
  submit();
  assert.ok(!els.authorForm.classList.contains('open'));
  const entry = { bio: 'Builds clockwork worlds.\n\nLives by a canal.', url: 'https://wendell.example/', hardcover: 'https://hardcover.app/authors/wendell' };
  assert.deepEqual(get("AUTHORS['Wendell Ashcombe']"), entry);
  assert.match(els.authorBody.innerHTML, /<p>Builds clockwork worlds\.<\/p><p>Lives by a canal\.<\/p>/);
  assert.match(els.ioStatus.textContent, /^Saved author info for Wendell Ashcombe\.$/);
  // kept in this browser, and loaded again with the page
  assert.deepEqual(kept(storage).authors['Wendell Ashcombe'], entry);
  const again = await boot({ page: 'authors.html', hash: '#a=Wendell+Ashcombe', storage: new Map(storage) });
  assert.deepEqual(again.get("AUTHORS['Wendell Ashcombe']"), entry);

  // editing shows what is there; emptying every field, or Remove, removes the entry
  editClick();
  assert.equal(els.authorFormTitle.textContent, 'Author info: Wendell Ashcombe');
  assert.equal(els.af_hardcover.value, entry.hardcover);
  assert.equal(els.authorRemoveBtn.style.display, '');
  els.authorRemoveBtn.listeners.click[0]();
  assert.equal(get("AUTHORS['Wendell Ashcombe'] || null"), null);
  assert.match(els.ioStatus.textContent, /Removed author info for Wendell Ashcombe/);
  assert.ok(get("'Marisol Quenby' in AUTHORS"), 'the other authors keep theirs');
});

test('Check on the import page lists problems and older formats, and saves the catalogue in the current one', async () => {
  const mine = JSON.stringify([{ t: 'Old Favourite', a: 'Ann Vale', id: 'B0OLD00001' }]);
  const info = JSON.stringify({ Nowhere: { total: 3, status: 'ongoing' } });
  const { els, storage } = await boot({ page: 'import.html', files: { 'books.json': mine, 'series-info.json': info } });
  els.checkBtn.listeners.click[0]();
  const report = els.importPreviewBody.innerHTML;
  assert.match(report, /1 books, 0 series, 1 with release info, 0 authors with info/);
  assert.match(report, /Errors \(1\):.*&#39;Nowhere&#39; matches no series/s);
  assert.match(report, /some books keep their ids, ISBNs or narrator on the book/);
  assert.equal(els.importConfirm.style.display, '');
  assert.equal(els.importConfirm.textContent, 'Save in the current format');
  els.importConfirm.listeners.click[0]();
  assert.deepEqual(kept(storage).books, [{ t: 'Old Favourite', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B0OLD00001' } }] }]);
  assert.equal(els.ioStatus.textContent, 'Saved in the current format.');
  els.checkBtn.listeners.click[0]();
  assert.doesNotMatch(els.importPreviewBody.innerHTML, /older format/, 'the save wrote the current format');
  assert.equal(els.importConfirm.style.display, 'none');
});

test('Box sets on the import page adds a set beside the titles sharing its edition, once confirmed', async () => {
  const set = { asin: { 'audible.com': 'B0SET00001' } };
  const mine = JSON.stringify([
    { t: 'Gull Isle', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [set] },
    { t: 'Second Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [set] },
  ]);
  const { els, get } = await boot({ page: 'import.html', files: { 'books.json': mine } });
  els.boxSetsBtn.listeners.click[0]();
  assert.match(els.importPreviewBody.innerHTML, /Gull Isle, Books 1-2 &mdash; Ann Vale: 2 titles already here/);
  assert.match(els.importPreviewBody.innerHTML, /New: 1/);
  assert.equal(get('DATA.length'), 2, 'nothing changes before it is confirmed');
  assert.equal(els.importConfirm.textContent, 'Add 1 book');
  els.importConfirm.listeners.click[0]();
  assert.deepEqual(get('DATA[2]'), { t: 'Gull Isle, Books 1-2', a: ['Ann Vale'], s: 'Gull Isle', sn: '1-2', e: [set] });
  assert.match(els.ioStatus.textContent, /Added 1 book for box sets/);
  els.boxSetsBtn.listeners.click[0]();
  assert.match(els.importPreviewBody.innerHTML, /already kept both as its own book and as its titles/);
  assert.equal(els.importConfirm.style.display, 'none');
});
