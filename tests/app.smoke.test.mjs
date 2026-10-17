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
import { Book } from '../public/modules/book.js';
import { Exclusions } from '../public/modules/exclusions.js';
import { Duplicates } from '../public/modules/duplicates.js';
import { CatalogRecords } from '../public/modules/catalog-records.js';
import { FakeIndexedDB, FakeKeyRange } from './fake-indexeddb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The app is the public/ folder, what a static server serves; the demo data stays outside it.
const site = path.join(root, 'public');
const read = file => fs.readFileSync(path.join(site, file), 'utf8');
const PAGES = ['index.html', 'import.html', 'duplicates.html', 'authors.html', 'narrators.html', 'publishers.html'];
const readData = file => fs.readFileSync(path.join(root, 'sample', file), 'utf8');
const DEMO_BOOKS = readData('books.json');
const DEMO_INFO = readData('series-info.json');
const DEMO_AUTHORS = readData('authors.json');
const DEMO_NARRATORS = readData('narrators.json');
const DEMO_PUBLISHERS = readData('publishers.json');

// The module a page loads with <script type="module">, and the modules it imports, in load order.
const entryOf = page => [...read(page).matchAll(/<script type="module" src="([^"]+)">/g)].map(m => m[1]);
function modulesOf(file, seen = new Set()) {
	seen.add(file);
	for (const [, dep] of read(file).matchAll(/^import [^;]* from '(\.\.?\/[^']+)';$/gm)) {
		const found = path.posix.join(path.posix.dirname(file), dep);
		if (!seen.has(found)) modulesOf(found, seen);
	}
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
	// a specifier is relative to the module that imports it (modules/book.js imports './edition.js')
	await main.link((specifier, from) => load(path.posix.join(path.posix.dirname(from.identifier), specifier)));
	await main.evaluate();
	return new Map([...modules].map(([file, m]) => [file, m.namespace]));
}

// A small DOM: elements with attributes and children, built by the page with createElement/append and
// read back by the tests as innerHTML, written the way a browser writes it. Setting innerHTML throws: the
// page builds its elements, it never parses HTML.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', larr: '←', rarr: '→',
	times: '×', mdash: '—', ndash: '–', middot: '·', bull: '•', check: '✓' };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
	if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
	if (!(e in ENTITIES)) throw new Error(`the fake DOM doesn't know ${m}`);
	return ENTITIES[e];
});
const escText = text => text.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = text => text.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/"/g, '&quot;');
const dataName = key => 'data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

class FakeText {
	constructor(text) { this.nodeType = 3; this.nodeValue = String(text); this.parentNode = null; }
	get textContent() { return this.nodeValue; }
	set textContent(text) { this.nodeValue = String(text); }
	get outerHTML() { return escText(this.nodeValue); }
}

/** Does `el` match a simple selector: tag, .class, #id, [attr], [attr="value"] and [attr^="start"], combined (no descendants)? */
function matches(el, selector) {
	const parts = selector.match(/^[a-z0-9]+|\.[\w-]+|#[\w-]+|\[[\w-]+(?:\^?="[^"]*")?\]/gi) || [];
	if (parts.join('') !== selector) throw new Error(`the fake DOM can't match ${selector}`);
	return parts.every(part => {
		if (part[0] === '.') return el.classList.contains(part.slice(1));
		if (part[0] === '#') return el.getAttribute('id') === part.slice(1);
		if (part[0] === '[') {
			const [, name, op, value] = /^\[([\w-]+)(?:(\^?)="([^"]*)")?\]$/.exec(part);
			const actual = el.getAttribute(name);
			if (value === undefined) return actual !== null;
			return op ? actual !== null && actual.startsWith(value) : actual === value;
		}
		return el.localName === part.toLowerCase();
	});
}

class FakeElement {
	constructor(tag, id) {
		this.nodeType = 1;
		this.localName = tag.toLowerCase();
		this.tagName = tag.toUpperCase();
		this.attributes = new Map();
		this.childNodes = [];
		this.parentNode = null;
		this.listeners = {};
		this.style = {};
		this.value = '';
		if (id) this.setAttribute('id', id);
		const el = this;
		this.dataset = new Proxy({}, {
			get: (t, key) => (typeof key === 'string' && el.hasAttribute(dataName(key)) ? el.getAttribute(dataName(key)) : undefined),
			set: (t, key, value) => { el.setAttribute(dataName(key), value); return true; },
			has: (t, key) => el.hasAttribute(dataName(key)),
		});
		const classes = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
		const setClasses = list => el.setAttribute('class', list.join(' '));
		this.classList = {
			contains: c => classes().includes(c),
			add: c => { if (!classes().includes(c)) setClasses([...classes(), c]); },
			remove: c => setClasses(classes().filter(x => x !== c)),
			toggle(c, force) { const on = force === undefined ? !this.contains(c) : !!force; on ? this.add(c) : this.remove(c); return on; },
		};
	}
	get id() { return this.getAttribute('id') || ''; }
	set id(v) { this.setAttribute('id', v); }
	get className() { return this.getAttribute('class') || ''; }
	set className(v) { this.setAttribute('class', v); }
	get title() { return this.getAttribute('title') || ''; }
	set title(v) { this.setAttribute('title', v); }
	getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
	setAttribute(name, value) { this.attributes.set(name, String(value)); }
	hasAttribute(name) { return this.attributes.has(name); }
	removeAttribute(name) { this.attributes.delete(name); }
	append(...nodes) {
		for (const node of nodes) {
			const child = typeof node === 'string' ? new FakeText(node) : node;
			if (child.parentNode) child.parentNode.childNodes.splice(child.parentNode.childNodes.indexOf(child), 1);
			child.parentNode = this;
			this.childNodes.push(child);
		}
	}
	appendChild(node) { this.append(node); return node; }
	removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
	replaceChildren(...nodes) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; this.append(...nodes); }
	hasChildNodes() { return this.childNodes.length > 0; }
	get children() { return this.childNodes.filter(c => c.nodeType === 1); }
	get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
	set textContent(text) { this.replaceChildren(...(String(text) ? [String(text)] : [])); }
	get innerHTML() { return this.childNodes.map(c => c.outerHTML).join(''); }
	set innerHTML(html) { throw new Error(`the page set innerHTML of #${this.id}`); }
	get outerHTML() {
		const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
		return `<${this.localName}${attrs}>` + (VOID.has(this.localName) ? '' : `${this.innerHTML}</${this.localName}>`);
	}
	/** Elements below this one matching `selector` (simple selectors, or several separated by spaces for descendants). */
	querySelectorAll(selector) {
		const [first, ...rest] = selector.trim().split(/\s+/);
		const found = [];
		const walk = el => el.children.forEach(c => { if (matches(c, first)) found.push(c); walk(c); });
		walk(this);
		return rest.length ? [...new Set(found.flatMap(el => el.querySelectorAll(rest.join(' '))))] : found;
	}
	querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
	closest(selector) { for (let el = this; el && el.nodeType === 1; el = el.parentNode) if (matches(el, selector)) return el; return null; }
	addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
	/** Run the listeners for `type` as a browser would for an event on this element. */
	dispatch(type, event = {}) {
		for (let el = this; el && el.nodeType === 1; el = el.parentNode) {
			(el.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event, target: this, currentTarget: el }));
		}
	}
	reset() {} scrollIntoView() {} click() {} focus() {}
	// where an element was last moved to, as 'before <id>' or 'after <id>'
	before(node) { node.place = `before ${this.id}`; }
	after(node) { node.place = `after ${this.id}`; }
}
const makeElement = id => new FakeElement('div', id);

/** The page's <body>, parsed: tags, attributes, text and entities, as the pages write them. */
function parseBody(html) {
	const body = new FakeElement('body');
	const open = [body];
	const at = () => open[open.length - 1];
	const source = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.indexOf('</body>'));
	for (const [, text, close, tag, attrs] of source.matchAll(/([^<]+)|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
		if (text !== undefined) at().append(decode(text));
		else if (close) {
			if (at().localName !== close.toLowerCase()) throw new Error(`</${close}> closes <${at().localName}>`);
			open.pop();
		} else {
			const el = new FakeElement(tag);
			for (const [, name, value] of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.setAttribute(name, decode(value ?? ''));
			at().append(el);
			if (!VOID.has(el.localName)) open.push(el);
		}
	}
	if (open.length !== 1) throw new Error(`<${at().localName}> is never closed`);
	return body;
}

const CATALOG_KEY = 'audiobook-catalog-device';
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
const DEMO = { 'books.json': DEMO_BOOKS, 'series-info.json': DEMO_INFO, 'authors.json': DEMO_AUTHORS, 'narrators.json': DEMO_NARRATORS, 'publishers.json': DEMO_PUBLISHERS };
// The catalog in localStorage, made of data files ({'books.json': text, 'series-info.json': ..., 'excluded.txt': ...}) as written.
function stored(files) {
	const json = (name, empty) => JSON.parse(files[name] || empty);
	const catalog = { books: json('books.json', '[]'), seriesInfo: json('series-info.json', '{}'), authors: json('authors.json', '{}'),
		narrators: json('narrators.json', '{}'), publishers: json('publishers.json', '{}'), excluded: Exclusions.parse(files['excluded.txt'] || '').entries };
	return JSON.stringify(catalog);
}
// A backup (or anything else) without the ids books, editions, series and people are stored under.
const withoutIds = json => JSON.parse(JSON.stringify(json), (k, v) => (k === 'uid' || k === 'ids' ? undefined : v));
// The browser's IndexedDB that goes with a localStorage (a Map), so pages booted with the same storage are
// tabs of one browser. Its ids are numbered, so tests can name them.
const DATABASES = new WeakMap();
function databaseOf(storage) {
	if (!DATABASES.has(storage)) {
		const database = new FakeIndexedDB();
		let n = 0;
		database.newId = () => `id-${++n}`;
		DATABASES.set(storage, database);
	}
	return DATABASES.get(storage);
}
// Every page booted, so idle() can wait for all of them.
const BOOTED = [];
// Once every page has drawn what it was asked to show, and saved what it was asked to save (a page reads
// what it shows from IndexedDB, after the saves before it, so a step that changes the view needs this).
async function idle() {
	for (let i = 0; i < 3; i++) {
		await Promise.all(BOOTED.map(page => page.saved()));
		await new Promise(resolve => setImmediate(resolve));
	}
}
// Once the saves of every page of this browser are done.
const settled = storage => Promise.all((databaseOf(storage).pages || []).map(page => page.saved()));
// What the pages keep in IndexedDB, once their saves are done, as a backup has it (without the ids); null when nothing was saved.
async function kept(storage) {
	await settled(storage);
	const database = databaseOf(storage);
	if (!database.records('meta').length) return null;
	const records = Object.fromEntries(CatalogRecords.STORE_NAMES.map(store => [store, database.records(store)]));
	return JSON.parse(JSON.stringify(CatalogRecords.toCatalog(records), (k, v) => (k === 'uid' || k === 'ids' ? undefined : v)));
}

/**
 * Load the page into a fresh fake browser. `storage` is a Map standing in for localStorage; unless it
 * holds a catalog already, the catalog is made of `files` (see stored(); default: the demo data), or
 * there is none when `files` is null.
 */
async function boot({ page = 'index.html', files = DEMO, storage = new Map(), hash = '', setTimeout = () => 0, hardcover = null, languages = ['en-US', 'en'] } = {}) {
	await settled(storage);   // a page loaded after another saved reads what it saved
	if (files && !storage.has(CATALOG_KEY)) storage.set(CATALOG_KEY, stored(files));
	if (files && files['not-duplicates.txt'] && !storage.has(NOT_DUP_KEY)) {
		storage.set(NOT_DUP_KEY, JSON.stringify(Duplicates.parseMarks(files['not-duplicates.txt'])));
	}
	const html = read(page);
	const body = parseBody(html);
	// the page's elements by id, the ones the page makes (form fields drawn from code) included
	const byId = id => body.querySelectorAll('[id]').find(el => el.id === id) || null;
	const els = new Proxy({}, { get: (_, id) => (typeof id === 'string' ? byId(id) || undefined : undefined) });
	const document = {
		getElementById: byId,
		querySelectorAll: selector => body.querySelectorAll(selector),
		querySelector: selector => body.querySelector(selector),
		createElement: tag => new FakeElement(tag),
		body,
		title: decode(html.match(/<title>([^<]*)<\/title>/)[1]),
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
	const navigator = { languages };
	const Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
	const database = databaseOf(storage);
	const crypto = { randomUUID: () => database.newId() };
	const context = vm.createContext({ document, Node, navigator, localStorage, indexedDB: database, IDBKeyRange: FakeKeyRange, structuredClone, crypto, fetch, FileReader, location, history,
		addEventListener, console, setTimeout, clearTimeout() {}, setInterval: () => 0, clearInterval() {} });
	const [entry] = entryOf(page);
	const namespaces = await runModules(entry, context);
	// What the modules export, live: CATALOG is whatever store.js holds now, and Book, Edition etc. the page's own classes.
	const exported = {};
	for (const [file, ns] of namespaces) {
		const names = Object.fromEntries(Object.keys(ns).map(k => [k, () => ns[k]]));
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
	// Values cross the VM boundary as JSON so deepEqual is not confused by a different Object.prototype. The ids
	// books and editions are stored under (`uid`) are left out, as most tests compare values; withIds() keeps them.
	const get = expr => JSON.parse(run(`JSON.stringify(${expr})`), (k, v) => (k === 'uid' ? undefined : v));
	const withIds = expr => JSON.parse(run(`JSON.stringify(${expr})`));
	// ctx.render(), ctx.CATALOG etc. are the exports; anything else (ctx.location, ctx.Blob = ...) the page's globals.
	const ctx = new Proxy(context, { get: (target, key) => (key in exported ? exported[key] : target[key]) });
	// what the page saves, saved: persist() writes in the background
	const saved = () => run('whenSaved()');
	// The page's links, with the ids in them read as names (#a=id-4 -> #a=Priya+Ostrander, #book=id-11 -> #book=The+Ledger+...),
	// so a test can say which book, series or person a link is to.
	const readable = html => {
		// by what this browser stores, and what the page holds (a book it added and has not saved yet)
		const records = store => database.records(store);
		const heldNames = kind => JSON.parse(run(`JSON.stringify([...CATALOG.nameIds.${kind}].map(([name, id]) => [id, name]))`));
		const people = kind => [...records('contributors').filter(c => c.kind === kind).map(c => [c.id, c.name]), ...heldNames(kind + 's')];
		const held = JSON.parse(run(`JSON.stringify(CATALOG.books.map(b => [b.id, b.title]))`));
		const named = { book: [...records('books').map(b => [b.id, b.title]), ...held], series: [...records('series').map(x => [x.id, x.name]), ...heldNames('series')],
			a: people('author'), n: people('narrator'), p: people('publisher') };
		const enc = v => encodeURIComponent(v).replace(/%20/g, '+');
		return html.replace(/#(book|series|a|n|p)=([^"&]+)/g, (m, k, id) => {
			const name = new Map(named[k]).get(decodeURIComponent(id));
			return name === undefined ? m : `#${k}=${enc(name)}`;
		});
	};
	get.database = database;
	const booted = { ctx, els, storage, database, get, withIds, run, fire, saved, readable };
	(database.pages ||= []).push(booted);
	BOOTED.push(booted);
	return booted;
}

// Pages know books, series and people by the ids they are stored under: the id of the book at `i` in the
// catalog's order, and of the series or person by their name, as the page's browser stores them. (A page
// holds only what it shows, so these are read from what is stored.)
const bookIdOf = (get, title) => (get.database.records('books').find(b => b.title === title) || {}).id;
const bookIdAt = (get, i) => [...get.database.records('books')].sort((x, y) => x.position - y.position)[i].id;
const seriesIdOf = (get, name) => (get.database.records('series').find(x => x.name === name) || {}).id;
const personIdOf = (get, kind, name) => (get.database.records('contributors').find(x => x.kind === kind.replace(/s$/, '') && x.name === name) || {}).id;

for (const page of PAGES) {
	const html = read(page);
	assert.equal(entryOf(page).length, 1, `${page} loads one module`);
	assert.ok(!/<script(?! type="module")/.test(html), `${page} loads no plain scripts`);
	for (const shared of ['store.js', 'modules/catalog.js']) assert.ok(modulesOf(entryOf(page)[0]).includes(shared), `${page} imports ${shared}`);
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
	ctx.openSeries(seriesIdOf(get, series));
	await idle();
	assert.equal(get('VIEW'), 'library');
	assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, counts[series]);
	assert.ok(els.crumb.classList.contains('show'));
	assert.equal(els.crumbLabel.textContent, series);
});

test('search narrows the library view', async () => {
	const { ctx, els } = await boot();
	ctx.setView('library');
	await idle();
	const target = demoBooks[0];
	els.q.value = target.t;
	await ctx.refreshView();
	await idle();
	assert.ok(els.results.innerHTML.includes('class="book"'));
	assert.ok((els.results.innerHTML.match(/class="book"/g) || []).length < demoBooks.length);
	els.q.value = 'zzzz-no-such-book-zzzz';
	await ctx.refreshView();
	await idle();
	assert.match(els.results.innerHTML, /No books match/);
});

test('text from the catalog is shown as text, never read as HTML', async () => {
	const odd = '<img src=x onerror=alert(1)> & "Co"';
	// twice, so the duplicates page shows it too
	const mine = JSON.stringify([{ t: odd, a: [odd], s: odd, sn: '1', g: [odd], e: [{ desc: odd, n: [odd] }] }, { t: odd, a: [odd], e: [{ ext: { goodreads: '42' } }] }]);
	const info = JSON.stringify({ [odd]: { total: 2, status: 'ongoing', note: odd } });
	const authors = JSON.stringify({ [odd]: { bio: odd } });
	const files = { 'books.json': mine, 'series-info.json': info, 'authors.json': authors };
	const pages = [['index.html', 'results'], ['index.html', 'results', 'library'], ['authors.html', 'creditBody'], ['duplicates.html', 'dupBody']];
	for (const [page, id, view] of pages) {
		const { ctx, els } = await boot({ page, files, hash: page === 'authors.html' ? '#a=' + encodeURIComponent(odd) : '' });
		if (view) ctx.setView(view);
		await idle();
		const shown = els[id].innerHTML;
		assert.equal(els[id].querySelectorAll('img').length, 0, `${page} ${view || ''}: no element made of the text`);
		assert.match(shown, /&lt;img src=x onerror=alert\(1\)&gt; &amp; "Co"/, page);
	}
});

test('the address names the view, so a series, a book or a search can be linked to', async () => {
	const { ctx, els, get, storage } = await boot();
	assert.equal(ctx.location.hash, '');
	// by the ids they are stored under, so a link holds when a series or book is renamed
	const halloway = seriesIdOf(get, 'Halloway & Finch');
	ctx.openSeries(halloway);
	await idle();
	assert.equal(ctx.location.hash, `#series=${halloway}`);
	assert.equal(ctx.document.title, 'Halloway & Finch — Audiobook Catalog');
	// the overview links each series to that address, and book cards link to their own
	ctx.setView('series');
	await idle();
	assert.ok(els.results.innerHTML.includes(`<a class="srow-title" href="#series=${halloway}">Halloway &amp; Finch</a>`));
	assert.match(els.results.innerHTML, /<a class="srow-title" href="#standalone">Standalone<\/a>/);
	ctx.openSeries(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	const saltRoad = bookIdOf(get, 'The Salt Road');
	assert.ok(els.results.innerHTML.includes(`<div class="title"><a href="#book=${saltRoad}">The Salt Road</a></div>`));

	// opening one of those addresses shows the same thing, in another tab too
	for (const hash of [`#series=${halloway}`, '#series=Halloway+%26+Finch']) {
		const series = await boot({ hash, storage });
		assert.deepEqual(series.get('[VIEW, SERIES_FILTER]'), ['library', halloway], 'by its id, or by its name (an address from before)');
		assert.equal((series.els.results.innerHTML.match(/class="book"/g) || []).length, 2);
		assert.equal(series.els.crumbLabel.textContent, 'Halloway & Finch');
	}
	for (const hash of [`#book=${saltRoad}`, '#book=The+Salt+Road']) {
		const book = await boot({ hash, storage });
		assert.equal(book.get('BOOK_FILTER'), saltRoad);
		assert.equal((book.els.results.innerHTML.match(/class="book"/g) || []).length, 1);
		assert.match(book.els.results.innerHTML, /The Salt Road/);
		assert.equal(book.els.crumbLabel.textContent, 'The Salt Road');
	}
	const gone = await boot({ hash: '#book=no-such-id', storage });
	assert.equal(gone.els.crumbLabel.textContent, 'No such book');
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
	const lantern = seriesIdOf(get, 'The Lantern Coast'), beacons = bookIdOf(get, 'Beacons at Low Tide');
	ctx.openSeries(lantern);
	await idle();
	// a click on a book link opens it here, with a history entry; filters that would hide it are cleared
	els.authorFilter.value = 'Somebody Else';
	const link = { getAttribute: () => `#book=${beacons}` };
	let prevented = false;
	els.results.listeners.click[0]({ target: { closest: () => link }, button: 0, preventDefault() { prevented = true; } });
	await idle();
	assert.ok(prevented);
	assert.equal(ctx.location.hash, `#book=${beacons}`);
	assert.equal(els.authorFilter.value, '');
	// a click with a modifier key is left to the browser (a new tab)
	els.results.listeners.click[0]({ target: { closest: () => link }, button: 0, ctrlKey: true, preventDefault() { assert.fail('prevented'); } });
	await idle();

	els.btnLibraryView.listeners.click[0]();
	await idle();
	els.genreFilter.value = 'Mystery';
	els.genreFilter.listeners.change[0]();
	await idle();
	// typing a search is one entry, however many letters
	for (const q of ['p', 'pr', 'priya']) { els.q.value = q; els.q.listeners.input[0](); }
	await idle();
	assert.deepEqual(history.entries.map(e => e.hash),
		['', `#series=${lantern}`, `#book=${beacons}`, '#books', '#books&genre=Mystery', '#books&q=priya&genre=Mystery']);

	history.back();
	await idle();
	assert.equal(els.q.value, '');
	assert.equal(els.genreFilter.value, 'Mystery');
	history.back(); history.back();
	await idle();
	assert.deepEqual(get('[VIEW, BOOK_FILTER]'), ['library', beacons]);
	assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 1);
	history.back();
	await idle();
	assert.deepEqual(get('[VIEW, SERIES_FILTER, BOOK_FILTER]'), ['library', lantern, null]);
	assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 4);
	history.back();
	await idle();
	assert.deepEqual(get('[VIEW, SERIES_FILTER]'), ['series', null]);
	history.forward();
	await idle();
	assert.equal(get('SERIES_FILTER'), lantern);

	// a space typed in the search box stays there (the address carries the search without it)
	els.q.value = 'beacons '; els.q.listeners.input[0]();
	await idle();
	assert.equal(els.q.value, 'beacons ');
	els.q.value = 'beacons at'; els.q.listeners.input[0]();
	await idle();
	assert.equal(ctx.location.hash, `#series=${lantern}&q=beacons+at`);
	history.back();
	await idle();

	// a new search after going back starts a new entry instead of rewriting an old one
	els.q.value = 'salt'; els.q.listeners.input[0]();
	await idle();
	assert.deepEqual(history.entries.map(e => e.hash), ['', `#series=${lantern}`, `#series=${lantern}&q=salt`]);
	// leaving a series closes a form left open on it
	ctx.openEditForm(bookIdAt(get, 0));
	history.back();
	await idle();
	assert.ok(els.addForm.classList.contains('open'), 'only the search changed');
	history.back();
	await idle();
	assert.ok(!els.addForm.classList.contains('open'));
});

test('editing a book keeps its editions', async () => {
	const { ctx, els, get, run } = await boot();
	ctx.setView('library');
	await idle();
	run("CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', goodreads: '4242' }, p: 'Gull Audio', len: 642}, {ext: { 'audible.com': 'TESTASIN02' }}].map(e => Edition.fromJSON(e))");
	ctx.openEditForm(bookIdAt(get, 0));
	assert.equal(els.formTitle.textContent, 'Edit book');
	assert.deepEqual(formEditions(get), [{ 'ext:audible.com': 'TESTASIN01', 'ext:goodreads': '4242', p: 'Gull Audio', len: '10h 42m' }, { 'ext:audible.com': 'TESTASIN02' }]);
	assert.match(els.f_editions.innerHTML, /Edition 2/);
	assert.match(els.f_editions.innerHTML, /<input data-i="0" data-k="len" value="10h 42m"/);
	els.f_t.value = 'Renamed In The App';
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.deepEqual(get('({t: CATALOG.books[0].title, e: CATALOG.books[0].editions})'),
		{ t: 'Renamed In The App', e: [{ ext: { 'audible.com': 'TESTASIN01', goodreads: '4242' }, p: 'Gull Audio', len: 642 }, { ext: { 'audible.com': 'TESTASIN02' } }] });
});

test('book cards link an edition\'s ASIN to Audible and its Goodreads id to Goodreads', async () => {
	const { ctx, els, run, readable } = await boot();
	ctx.setView('library');
	await idle();
	run("CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', goodreads: '4242' }, p: 'Gull Audio', len: 642}, {isbn: '9780000000002'}].map(e => Edition.fromJSON(e))");
	await ctx.refreshView();
	await idle();
	const html = readable(els.results.innerHTML);
	assert.match(html, /ASIN audible\.com <a href="https:\/\/www\.audible\.com\/pd\/TESTASIN01" target="_blank" rel="noopener">TESTASIN01<\/a>; Goodreads <a href="https:\/\/www\.goodreads\.com\/book\/show\/4242" target="_blank" rel="noopener">4242<\/a>; Publisher <a href="publishers\.html#p=Gull\+Audio">Gull Audio<\/a>; Length 10h 42m/);
	// an edition without either id has no links
	assert.match(html, /<div class="edition">ISBN 9780000000002<\/div>/);
	// each site's ASIN links to the book on that site
	run("CATALOG.books[0].editions = [{ext: { 'audible.co.uk': 'TESTASIN02', 'amazon.com': 'TESTASIN03' }}].map(e => Edition.fromJSON(e))");
	await ctx.refreshView();
	await idle();
	assert.match(readable(els.results.innerHTML), /ASIN audible\.co\.uk <a href="https:\/\/www\.audible\.co\.uk\/pd\/TESTASIN02"[^>]*>TESTASIN02<\/a>, amazon\.com <a href="https:\/\/www\.amazon\.com\/dp\/TESTASIN03"[^>]*>TESTASIN03<\/a><\/div>/);
});

test('a book edited in the form keeps its id, and so do its editions, a box set\'s shared one included', async () => {
	const box = { ext: { 'audible.com': 'B0BOX00001' } };
	const books = [{ t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [box, { ext: { goodreads: '4001' } }] }, { t: 'Gull Light', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [box] }];
	const { ctx, els, withIds, database, saved, get } = await boot({ files: { 'books.json': JSON.stringify(books) } });
	await saved();
	assert.deepEqual(database.records('editions').map(ed => ed.bookIds.length), [2, 1], 'the box set\'s edition is one record');
	ctx.setView('library');
	await idle();
	const before = withIds('CATALOG.books');
	ctx.openEditForm(bookIdAt(get, 0));
	Object.assign(els.f_t, { value: 'Tidewater Rising' });
	typeEdition(els, 0, 'p', 'Gull Audio');
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	await saved();
	const after = withIds('CATALOG.books');
	assert.equal(after[0].t, 'Tidewater Rising');
	assert.deepEqual(after.map(b => [b.uid, b.e.map(ed => ed.uid)]), before.map(b => [b.uid, b.e.map(ed => ed.uid)]));
	assert.equal(after[1].e[0].p, 'Gull Audio', 'the edit reached the other title');
	const records = database.records('editions');
	assert.deepEqual(records.map(ed => [ed.id, ed.bookIds.length]), [[before[0].e[0].uid, 2], [before[0].e[1].uid, 1]], 'still one record each');
	assert.ok(records[0].publisherId);
	assert.deepEqual(database.records('books').map(b => b.title), ['Tidewater Rising', 'Gull Light']);
});

test('the book form has a field for each site an edition has an ASIN on, and adds one for another site', async () => {
	const { ctx, els, get, run } = await boot();
	ctx.setView('library');
	await idle();
	run("CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', 'amazon.co.uk': 'TESTASIN02' }}, {ext: { goodreads: '4242' }}].map(e => Edition.fromJSON(e))");
	ctx.openEditForm(bookIdAt(get, 0));
	// audible.com and the sites in use have a field; the others wait in the list
	assert.match(els.f_editions.innerHTML, /<label>audible\.com<\/label><input data-i="0" data-k="ext:audible\.com" value="TESTASIN01"/);
	assert.match(els.f_editions.innerHTML, /data-k="ext:amazon\.co\.uk" value="TESTASIN02"/);
	assert.match(els.f_editions.innerHTML, /<label>audible\.com<\/label><input data-i="1" data-k="ext:audible\.com" value=""/);
	assert.doesNotMatch(els.f_editions.innerHTML, /data-k="ext:amazon\.com"/);
	assert.match(els.f_editions.innerHTML, /<select data-add-site="0"[^>]*><option value="">\+ Another site<\/option><option value="amazon\.com">/);
	// picking a site from the list gives it a field
	els.f_editions.listeners.change[0]({ target: { dataset: { addSite: '0' }, value: 'amazon.com' } });
	await idle();
	assert.match(els.f_editions.innerHTML, /data-i="0" data-k="ext:amazon\.com" value=""/);
	typeEdition(els, 0, 'ext:amazon.com', 'https://www.amazon.com/dp/TESTASIN03?ref=x');
	typeEdition(els, 1, 'ext:audible.com', 'testasin04');
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.deepEqual(get('CATALOG.books[0].editions'), [{ ext: { 'audible.com': 'TESTASIN01', 'amazon.co.uk': 'TESTASIN02', 'amazon.com': 'TESTASIN03' } },
		{ ext: { 'audible.com': 'TESTASIN04', goodreads: '4242' } }]);
	// emptying a site's field drops that ASIN; something that isn't an ASIN is named
	ctx.openEditForm(bookIdAt(get, 0));
	typeEdition(els, 0, 'ext:amazon.co.uk', '');
	typeEdition(els, 1, 'ext:audible.com', 'not an asin');
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.match(els.formError.textContent, /Not understood: edition 2: ASIN audible\.com not an asin/);
	typeEdition(els, 1, 'ext:audible.com', 'TESTASIN04');
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.deepEqual(get('CATALOG.books[0].editions[0]'), { ext: { 'audible.com': 'TESTASIN01', 'amazon.com': 'TESTASIN03' } });
});

test('book cards link the Hardcover book and an edition\'s Hardcover id to Hardcover, and the edit form keeps them', async () => {
	const { ctx, els, get, run } = await boot();
	ctx.setView('library');
	await idle();
	run("CATALOG.books[0].external = { hardcover: '808' }; CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', hardcover: '31337' }}].map(e => Edition.fromJSON(e)); persist()");
	await ctx.refreshView();
	await idle();
	assert.match(els.results.innerHTML, /<div class="ids">Hardcover book <a href="https:\/\/hardcover\.app\/id\/book\/808" target="_blank" rel="noopener">808<\/a><\/div>/);
	assert.match(els.results.innerHTML, /ASIN audible\.com <a [^>]*>TESTASIN01<\/a>; Hardcover <a href="https:\/\/hardcover\.app\/id\/edition\/31337" target="_blank" rel="noopener">31337<\/a><\/div>/);
	els.q.value = '808';
	await ctx.refreshView();
	await idle();
	assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 1, 'searchable by its Hardcover book id');
	els.q.value = '';
	ctx.openEditForm(bookIdAt(get, 0));
	assert.equal(els.f_hcb.value, '808');
	assert.deepEqual(formEditions(get), [{ 'ext:audible.com': 'TESTASIN01', 'ext:hardcover': '31337' }]);
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.deepEqual(get("[CATALOG.books[0].idOn('hardcover'), CATALOG.books[0].editions]"), ['808', [{ ext: { 'audible.com': 'TESTASIN01', hardcover: '31337' } }]]);

	// a Hardcover book id is a number; a book's address in an edition's Hardcover field goes on the book
	ctx.openEditForm(bookIdAt(get, 0));
	els.f_hcb.value = 'abc';
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.match(els.formError.textContent, /Not a Hardcover book id: abc/);
	els.f_hcb.value = '';
	addEdition(els);
	typeEdition(els, 1, 'ext:hardcover', 'https://hardcover.app/id/book/909');
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.deepEqual(get("[CATALOG.books[0].idOn('hardcover'), CATALOG.books[0].editions]"), ['909', [{ ext: { 'audible.com': 'TESTASIN01', hardcover: '31337' } }]]);
});

test('the Hardcover book field takes the address of a book or edition on Hardcover, and looks up its id', async () => {
	// the page asks Hardcover, with the token saved in this browser
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn, ms) => { if (ms === 1000) Promise.resolve().then(fn); return 0; };   // the pause between requests
	const storage = new Map();
	const { ctx, els, get } = await boot({ hardcover: hc.fetch, setTimeout, storage });
	const submit = () => els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	ctx.setView('library');
	await idle();
	ctx.openEditForm(bookIdAt(get, 0));
	els.f_hcb.value = 'https://hardcover.app/books/tidewater';
	await submit();
	assert.match(els.formError.textContent, /Couldn't find the Hardcover book: to look it up on Hardcover, save your Hardcover API token/);
	assert.equal(get("CATALOG.books[0].idOn('hardcover') || null"), null);
	assert.equal(hc.sent.length, 0);

	storage.set('audiobook-catalog-hardcover-token', 'tok-123');
	await submit();
	assert.equal(get("CATALOG.books[0].idOn('hardcover')"), '77');
	assert.match(els.ioStatus.textContent, /Found on Hardcover: Tidewater \(book 77\)/);
	// pasting an edition's address fills in its book's id as soon as the field is left
	ctx.openEditForm(bookIdAt(get, 0));
	els.f_hcb.value = 'https://hardcover.app/books/lantern-hours/editions/801';
	await els.f_hcb.listeners.change[0]();
	await idle();
	await settle(); await settle();
	assert.equal(els.f_hcb.value, '80');
	// a book's /id/ address holds its id: nothing to ask
	els.f_hcb.value = 'hardcover.app/id/book/81';
	const asked = hc.sent.length;
	await submit();
	assert.equal(get("CATALOG.books[0].idOn('hardcover')"), '81');
	assert.equal(hc.sent.length, asked);

});

test('adding a book appends it', async () => {
	const { ctx, els, get } = await boot();
	ctx.setView('library');
	await idle();
	const before = get('CATALOG.books.length');
	els.toggleAdd.listeners.click[0]();
	await idle();
	Object.assign(els.f_t, { value: 'Brand New' });
	Object.assign(els.f_a, { value: 'Some Author' });
	Object.assign(els.f_g, { value: 'Fantasy, Cozy' });
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.equal(get('CATALOG.books.length'), before + 1);
	assert.deepEqual(get('CATALOG.books[CATALOG.books.length-1]'), { t: 'Brand New', a: ['Some Author'], g: ['Fantasy', 'Cozy'] });
});

test('a new book starts with the series shown and the author picked', async () => {
	const { ctx, els, get } = await boot();
	const open = () => { els.cancelAdd.listeners.click[0](); els.toggleAdd.listeners.click[0](); return [els.f_s.value, els.f_a.value]; };
	// a series: its name, and the authors of all its books
	ctx.openSeries(seriesIdOf(get, 'The Orchard Cycle'));
	await idle();
	assert.deepEqual(open(), ['The Orchard Cycle', 'Wendell Ashcombe']);
	// all books: nothing, unless an author is picked
	ctx.setView('library');
	await idle();
	assert.deepEqual(open(), ['', '']);
	els.authorFilter.value = 'Priya Ostrander';
	assert.deepEqual(open(), ['', 'Priya Ostrander']);
});

test('an address pasted in an edition id field becomes the id when the field is left', async () => {
	const { ctx, els, get } = await boot();
	ctx.setView('library');
	await idle();
	els.toggleAdd.listeners.click[0]();
	await idle();
	const field = k => els.f_editions.querySelector(`input[data-i="0"][data-k="${k}"]`);
	const leave = (k, value) => { const input = field(k); input.value = value; typeEdition(els, 0, k, value); input.dispatch('focusout', { relatedTarget: field('isbn') }); return input; };
	// the field's own id
	assert.equal(leave('ext:goodreads', 'https://www.goodreads.com/book/show/4242-the-salt-road').value, '4242');
	assert.equal(leave('ext:hardcover', 'https://hardcover.app/books/the-salt-road/editions/501').value, '501');
	assert.equal(leave('ext:audible.com', 'https://www.audible.com/pd/The-Salt-Road-Audiobook/B0SALTROAD?qid=1').value, 'B0SALTROAD');
	// another site's page: its ASIN goes to that site's field, which is added
	assert.equal(leave('ext:audible.com', 'https://www.amazon.co.uk/dp/B0SALTUK01').value, '');
	assert.equal(field('ext:amazon.co.uk').getAttribute('value'), 'B0SALTUK01');
	assert.deepEqual(get('FORM_EDITIONS[0].fields'), { 'ext:goodreads': '4242', 'ext:hardcover': '501', 'ext:audible.com': '', 'ext:amazon.co.uk': 'B0SALTUK01' });
	// a site whose field holds another ASIN keeps the address, for Save to report
	assert.equal(leave('ext:audible.com', 'https://www.amazon.co.uk/dp/B0OTHER001').value, 'https://www.amazon.co.uk/dp/B0OTHER001');
	// anything else is left as typed
	assert.equal(leave('ext:goodreads', 'not an address').value, 'not an address');
});

test('dates read: shown on the card, edited in the form, and filterable by year', async () => {
	const { ctx, els, get } = await boot();
	ctx.setView('library');
	await idle();
	const dated = demoBooks.find(b => b.r && b.r.length > 1);
	assert.ok(dated, 'the demo data has a book read more than once');
	assert.ok(els.results.innerHTML.includes(`Read ${dated.r.join(', ')}`));

	// the read filter lists each year, newest first, and "no date"
	assert.match(els.readFilter.innerHTML, /Read in 2026.*Read in 2025.*Read in 2023/);
	assert.match(els.readFilter.innerHTML, /No date read/);
	els.readFilter.value = '2025';
	await ctx.refreshView();
	await idle();
	const inYear = demoBooks.filter(b => (b.r || []).some(d => d.startsWith('2025')));
	assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, inYear.length);
	els.readFilter.value = '__undated__';
	await ctx.refreshView();
	await idle();
	assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, demoBooks.filter(b => !b.r).length);
	els.readFilter.value = '';

	// edit: the form shows the dates; they are tidied, sorted and de-duplicated on save
	const i = demoBooks.indexOf(dated);
	ctx.openEditForm(bookIdAt(get, i));
	assert.equal(els.f_r.value, dated.r.join(', '));
	els.f_r.value = '2026/9/1, 2021, 2026-09-01';
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.deepEqual(get(`CATALOG.books[${i}].read`), ['2021', '2026-09-01']);

	// "+ Read today" appends today's date once
	ctx.openEditForm(bookIdAt(get, i));
	els.readTodayBtn.listeners.click[0]();
	await idle();
	els.readTodayBtn.listeners.click[0]();
	await idle();
	const today = get('today()');
	assert.equal(els.f_r.value, `2021, 2026-09-01, ${today}`);

	// a bad date is refused with a message, and nothing changes
	els.f_r.value = '2026-02-30';
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.match(els.formError.textContent, /Not a date: 2026-02-30/);
	assert.deepEqual(get(`CATALOG.books[${i}].read`), ['2021', '2026-09-01']);

	// clearing the field removes the dates
	els.f_r.value = '';
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.equal(get(`CATALOG.books[${i}].read.length > 0`), false);
});

test('ISBNs: shown on the card, searchable however typed, edited in the form', async () => {
	// written before editions: read as the book's first edition
	const mine = JSON.stringify([{ t: 'Boxed One', a: ['Ann Vale'], isbn: ['9780306406157'] }, { t: 'Other', a: ['Ann Vale'] }]);
	const { ctx, els, get, readable } = await boot({ files: { 'books.json': mine } });
	ctx.setView('library');
	await idle();
	assert.match(readable(els.results.innerHTML), /ISBN 9780306406157/);
	for (const q of ['9780306406157', '0-306-40615-2', '406157']) {
		els.q.value = q;
		await ctx.refreshView();
		await idle();
		assert.equal((readable(els.results.innerHTML).match(/class="book"/g) || []).length, 1, q);
	}
	els.q.value = '';

	ctx.openEditForm(bookIdAt(get, 0));
	assert.deepEqual(formEditions(get), [{ isbn: '9780306406157' }]);
	// another ISBN is another edition
	typeEdition(els, 0, 'isbn', '9780306406157, 978-0-00-000000-2');
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.deepEqual(get('CATALOG.books[0].editions'), [{ isbn: '9780306406157' }, { isbn: '9780000000002' }]);

	// the same ISBN may go on another book (a boxed set); the cards then say so
	ctx.openEditForm(bookIdAt(get, 1));
	typeEdition(els, 0, 'isbn', '0306406152');
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.deepEqual(get('CATALOG.books[1].editions'), [{ isbn: '9780306406157' }]);
	assert.match(readable(els.results.innerHTML), /Also in this edition: <a href="#book=Boxed\+One">Boxed One<\/a>/);

	// a mistyped ISBN is refused with a message, and nothing changes
	ctx.openEditForm(bookIdAt(get, 1));
	typeEdition(els, 0, 'isbn', '9780306406158');
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.match(els.formError.textContent, /Not understood: edition 1: ISBN 9780306406158/);
	assert.deepEqual(get('CATALOG.books[1].editions'), [{ isbn: '9780306406157' }]);
	typeEdition(els, 0, 'isbn', '');
	typeEdition(els, 0, 'ext:goodreads', 'twelve');
	typeEdition(els, 0, 'd', 'someday');
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.match(els.formError.textContent, /Not understood: edition 1: Goodreads edition twelve; edition 1: Released someday/);
	// removing the only card leaves an empty one, which is no edition
	removeEdition(els, 0);
	assert.deepEqual(formEditions(get), [{}]);
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.equal(get("CATALOG.books[1].editions.length > 0"), false);
});

test('narrators and descriptions live on editions: shown on the card, searchable, edited in the form', async () => {
	const { ctx, els, get, readable } = await boot();
	ctx.setView('library');
	await idle();
	const salt = demoBooks.findIndex(b => b.t === 'The Salt Road');
	assert.ok(demoBooks[salt].e.some(ed => ed.desc), 'the demo data has an edition with a description');
	// both narrators on the book; with different narrators each edition names its own
	assert.match(readable(els.results.innerHTML), /narr\. <a href="narrators\.html#n=Tobias\+Frane">Tobias Frane<\/a> \/ <a href="narrators\.html#n=Hollis\+Marr">Hollis Marr<\/a>/);
	assert.match(readable(els.results.innerHTML), /UK edition; Narrated by <a href="narrators\.html#n=Hollis\+Marr">Hollis Marr<\/a>; ASIN/);
	assert.doesNotMatch(readable(els.results.innerHTML), /Narrated by Ingrid Voss/, 'a single narrator is not repeated on the edition');
	for (const q of ['hollis marr', 'uk edition']) {
		els.q.value = q;
		await ctx.refreshView();
		await idle();
		assert.equal((readable(els.results.innerHTML).match(/class="book"/g) || []).length, 1, q);
	}
	els.q.value = '';

	ctx.openEditForm(bookIdAt(get, salt));
	assert.equal(formEditions(get)[0].n, 'Tobias Frane');
	assert.equal(formEditions(get)[0]['ext:audible.com'], 'SAMPLE0001');
	assert.equal(formEditions(get)[0]['ext:amazon.com'], 'SAMPLE0201');
	addEdition(els);
	typeEdition(els, 2, 'desc', 'Dramatized adaptation; unabridged');
	typeEdition(els, 2, 'n', 'A full cast');
	typeEdition(els, 2, 'ext:goodreads', '777');
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.deepEqual(get(`CATALOG.books[${salt}].editions[2]`), { ext: { goodreads: '777' }, n: ['A full cast'], desc: 'Dramatized adaptation; unabridged' });
});

test('box sets: kept as their own book, last in the series, and not counted as one more title', async () => {
	const { ctx, els, get } = await boot();
	ctx.openSeries(seriesIdOf(get, 'The Orchard Cycle'));
	await idle();
	const titles = [...els.results.innerHTML.matchAll(/<div class="title"><a [^>]*>([^<]+)<\/a>/g)].map(m => m[1]);
	assert.deepEqual(titles, ['The Brass Orchard', 'The Copper Graft', 'Harvest of Gears', 'The Orchard Cycle: Books 2-3']);
	assert.match(els.results.innerHTML, /<span class="n">3 owned \+ 1 box set<\/span>/);
	ctx.setView('series');
	await idle();
	assert.match(els.results.innerHTML, /The Orchard Cycle<\/a>\s*<span class="srow-owned">3 owned<\/span>/);
});

test('box sets: the edition shows on each of its books, and editing it on one edits it on all', async () => {
	const { ctx, els, get, readable } = await boot();
	ctx.setView('library');
	await idle();
	const two = demoBooks.findIndex(b => b.t === 'The Copper Graft'), three = demoBooks.findIndex(b => b.t === 'Harvest of Gears');
	assert.ok(two >= 0 && three >= 0, 'the demo data has a box set');
	assert.match(readable(els.results.innerHTML), /ASIN audible.com <a [^>]*>SAMPLE0008<\/a>; ISBN 9780306406157; Publisher <a [^>]*>Kestrel Row Audio<\/a>; Released 2022-11; Length 23h 5m/);
	assert.match(readable(els.results.innerHTML), /Also in this edition: <a href="#book=Harvest\+of\+Gears">Harvest of Gears #3<\/a>/);
	assert.match(readable(els.results.innerHTML), /Also in this edition: <a href="#book=The\+Copper\+Graft">The Copper Graft #2<\/a>/);
	els.q.value = 'kestrel row';
	await ctx.refreshView();
	await idle();
	assert.equal((readable(els.results.innerHTML).match(/class="book"/g) || []).length, 3, 'search finds a publisher (the box set\'s own book too)');
	els.q.value = '';

	ctx.openEditForm(bookIdAt(get, two));
	assert.match(readable(els.f_editions.innerHTML), /Also on Harvest of Gears, The Orchard Cycle: Books 2-3: changes here change it there too/);
	typeEdition(els, 0, 'p', 'Merlin Lane Audio');
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.equal(get(`CATALOG.books[${three}].editions[0].publisher`), 'Merlin Lane Audio');
	assert.match(els.ioStatus.textContent, /Also updated the shared edition on 2 other books/);
});

test('a Goodreads import adds the ISBN to the edition of books already there', async () => {
	const mine = JSON.stringify([{ t: 'Old Favorite', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'B1' } }], r: ['2020'] }]);
	const { els, get } = await boot({ page: 'import.html', files: { 'books.json': mine } });
	const csv = 'Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf,Date Read\n'
		+ 'Old Favorite,Ann Vale,"=""0306406152""","=""9780306406157""",Audible Audio,read,2023/11/04\n';
	els.importGoodreadsBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'goodreads.csv', text: csv }], value: '' } });
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /ISBNs added to existing books: 1/);
	assert.equal(els.importConfirm.textContent, 'Save ISBNs');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books[0].editions'), [{ ext: { 'audible.com': 'B1' }, isbn: '9780306406157' }]);
	assert.match(els.ioStatus.textContent, /added ISBNs to 1 book/);
});

test('authors are lists: the author filter offers each author on its own, and the form edits them as text', async () => {
	const { ctx, els, get, readable } = await boot();
	ctx.setView('library');
	await idle();
	const nine = demoBooks.findIndex(b => b.t === 'Nine Ways to Lose a Kingdom');
	assert.deepEqual(demoBooks[nine].a, ['Ferran Doyle', 'Priya Ostrander'], 'the demo data has a book with two authors');
	assert.match(readable(els.authorFilter.innerHTML), /<option value="Priya Ostrander">Priya Ostrander<\/option>/);
	assert.doesNotMatch(readable(els.authorFilter.innerHTML), /Ferran Doyle, Priya Ostrander/);
	assert.equal((readable(els.authorFilter.innerHTML).match(/<option value="Priya Ostrander">/g) || []).length, 1);
	// each author's name links to their page
	assert.match(readable(els.results.innerHTML), /<div class="meta"><a href="authors\.html#a=Ferran\+Doyle">Ferran Doyle<\/a>, <a href="authors\.html#a=Priya\+Ostrander">Priya Ostrander<\/a><\/div>/);
	els.authorFilter.value = 'Priya Ostrander';
	await ctx.refreshView();
	await idle();
	assert.equal((readable(els.results.innerHTML).match(/class="book"/g) || []).length, 3, 'her two books and the one she co-wrote');
	els.authorFilter.value = '';

	ctx.openEditForm(bookIdAt(get, nine));
	assert.equal(els.f_a.value, 'Ferran Doyle, Priya Ostrander');
	els.f_a.value = 'Ferran Doyle & Cass Merriweather';
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.deepEqual(get(`CATALOG.books[${nine}].authors`), ['Ferran Doyle', 'Cass Merriweather']);
});

test('authors and narrators written as comma separated text load as lists', async () => {
	const mine = JSON.stringify([{ t: 'Old Style', a: 'Ann Vale, Bo Reed', e: [{ ext: { 'audible.com': 'B1' }, n: 'Cy Hale, Di Moss' }] }]);
	const { ctx, els, readable, storage } = await boot({ files: { 'books.json': mine } });
	assert.deepEqual((await kept(storage)).books, [{ t: 'Old Style', a: ['Ann Vale', 'Bo Reed'], e: [{ ext: { 'audible.com': 'B1' }, n: ['Cy Hale', 'Di Moss'] }] }]);
	ctx.setView('library');
	await idle();
	assert.match(readable(els.authorFilter.innerHTML), /<option value="Bo Reed">/);
	assert.match(readable(els.results.innerHTML), /Ann Vale<\/a>, <a [^>]*>Bo Reed<\/a> — narr\. <a href="narrators\.html#n=Cy\+Hale">Cy Hale<\/a>, <a href="narrators\.html#n=Di\+Moss">Di Moss<\/a><\/div>/);
});

test('with no catalog in this browser it starts empty, not with the demo, and says where books come from', async () => {
	const { els, get, run, storage } = await boot({ files: null });
	await idle();
	assert.deepEqual(get('CATALOG.books'), []);
	assert.deepEqual(get('CATALOG.toJSON().seriesInfo'), {});
	assert.equal(els.subtitle.textContent, 'Your catalog is empty');
	assert.match(els.results.innerHTML, /No books yet\. .*<a href="import\.html">Import &amp; export<\/a>/);
	assert.equal((await kept(storage)), null, 'nothing is stored before the first edit');
	run("CATALOG.books.push(new Book({ title: 'First', authors: ['Me'] }))");
	await run('persist()');
	assert.deepEqual((await kept(storage)), { books: [{ t: 'First', a: ['Me'] }], seriesInfo: {}, authors: {}, narrators: {}, publishers: {}, excluded: [], notDuplicates: [] });
});

test('the catalog is kept in this browser, from one page load to the next', async () => {
	// (on the Duplicates page, which holds the whole catalog)
	const first = await boot({ page: 'duplicates.html' });
	first.run("CATALOG.books[0].title = 'Edited Locally'");
	await first.run('persist()');
	const again = await boot({ storage: first.storage, page: 'duplicates.html' });
	assert.equal(again.get('CATALOG.books[0].title'), 'Edited Locally');
	assert.equal(again.get('CATALOG.books.length'), demoBooks.length);
	assert.deepEqual(again.withIds('CATALOG.books.map(b => b.id)'), first.withIds('CATALOG.books.map(b => b.id)'), 'each book keeps its id');
});

test('records saved before ids were kept by external catalog are read, and saved again the current way', async () => {
	const storage = new Map();
	const { database } = await boot({ storage });
	await kept(storage);
	// make the stored records look as the app before this one wrote them
	const stores = database.data.get('audiobook-catalog').stores;
	for (const { value } of stores.get('editions').records.values()) {
		const { external = {} } = value;
		delete value.external;
		value.asins = Object.fromEntries(Object.entries(external).filter(([k]) => k.includes('.')));
		if (external.goodreads) value.goodreadsId = external.goodreads;
	}
	for (const { value } of stores.get('contributors').records.values()) {
		if (value.external && value.external.hardcover) value.hardcover = `https://hardcover.app/authors/${value.external.hardcover}`;
		delete value.external; delete value.externalKeys;
	}
	for (const { value } of stores.get('books').records.values()) delete value.externalKeys;
	const revision = database.records('meta').find(m => m.key === 'revision').value;
	const again = await boot({ storage, page: 'duplicates.html' });
	await kept(storage);
	assert.ok(database.records('meta').find(m => m.key === 'revision').value > revision, 'saved again at once');
	assert.ok(database.records('editions').every(ed => ed.external && !ed.asins));
	assert.ok(database.records('books').every(b => Array.isArray(b.externalKeys)));
	assert.deepEqual(again.get('CATALOG.books'), demoBooks);
	assert.deepEqual(again.get("CATALOG.infoByName('authors').get('Marisol Quenby').external.hardcover"), 'marisol-quenby-sample');
});

test('the catalog localStorage kept is moved to IndexedDB on the first load, and kept aside as it was', async () => {
	const storage = new Map();
	const { get, withIds, database } = await boot({ storage, page: 'duplicates.html', files: { ...DEMO, 'not-duplicates.txt': 'x\n' } });
	const before = storage.get(CATALOG_KEY + '.moved-to-indexeddb');
	assert.ok(before, 'the old copy is renamed, not deleted');
	assert.equal(storage.has(CATALOG_KEY), false);
	assert.equal(storage.get(NOT_DUP_KEY + '.moved-to-indexeddb'), '["x"]');
	assert.deepEqual((await kept(storage)).books, demoBooks, 'IndexedDB holds the same books');
	assert.deepEqual((await kept(storage)).notDuplicates, ['x'], 'a mark that matches no book is kept as its text');
	assert.equal(database.records('books').length, demoBooks.length);
	// a box set's titles share one edition record, which lists them all
	const shared = database.records('editions').filter(ed => ed.bookIds.length > 1);
	assert.ok(shared.length, 'the demo has a box set');
	for (const ed of shared) for (const id of ed.bookIds) assert.ok(database.records('books').find(b => b.id === id).editionIds.includes(ed.id));
	assert.deepEqual(get('CATALOG.books'), demoBooks);
	assert.ok(withIds('CATALOG.books').every(b => b.uid), 'every book has its id');
	// a second load reads IndexedDB, not what localStorage has now
	storage.set(CATALOG_KEY, JSON.stringify({ books: [{ t: 'Not this', a: ['Me'] }] }));
	const again = await boot({ storage, page: 'duplicates.html' });
	assert.equal(again.get('CATALOG.books.length'), demoBooks.length);
});

test('a catalog with values that are not what their field holds is shown but not moved, until fixed', async () => {
	const storage = new Map([[CATALOG_KEY, JSON.stringify({ books: [{ t: 'Odd', a: ['Me'], g: 5, x: 1 }] })]]);
	const { get, els } = await boot({ storage, files: null });
	assert.equal(get('CATALOG.books[0].title'), 'Odd', 'the page shows it');
	assert.equal((await kept(storage)), null, 'nothing is written');
	assert.ok(storage.has(CATALOG_KEY), 'localStorage still has it');
	assert.match(els.ioStatus.textContent, /^Not saved: these values can't be kept.*book #0 \('Odd'\): 'g', 'x'/);
});

test('without IndexedDB the page shows the catalog localStorage has, and says nothing is saved', async () => {
	const storage = new Map();
	databaseOf(storage).broken = true;
	const { get, els, run } = await boot({ storage });
	assert.deepEqual(get('CATALOG.books'), demoBooks);
	assert.match(els.ioStatus.textContent, /^Not saved: this browser won't keep the catalog/);
	await run('persist()');
	assert.match(els.ioStatus.textContent, /^Not saved/);
	assert.ok(storage.has(CATALOG_KEY), 'what localStorage has stays');
});

test('a stored catalog that does not fit together is set aside, and the catalog starts empty', async () => {
	const storage = new Map();
	const first = await boot({ storage });
	await first.saved();
	// a book that lists an edition there is no record of
	const { db } = await new Promise(resolve => { const req = first.database.open('audiobook-catalog', 3); req.onsuccess = () => resolve({ db: req.result }); });
	await new Promise(resolve => { const tx = db.transaction('editions', 'readwrite'); tx.objectStore('editions').clear(); tx.oncomplete = resolve; });
	// (a page that reads all of it finds out)
	const { get, els, database } = await boot({ storage, page: 'duplicates.html' });
	assert.deepEqual(get('CATALOG.books'), []);
	assert.match(els.ioStatus.textContent, /set aside/);
	const aside = database.records('meta').find(m => m.key === 'unreadable');
	assert.equal(aside.value.books.length, demoBooks.length, 'what was stored is kept');
	assert.equal(database.records('books').length, 0);
});

test('edits from before, which waited for make serve to save them, become the catalog', async () => {
	const old = { base: 'x', data: [{ t: 'Waiting', a: ['Me'] }], infoBase: 'y', info: { S: { total: 2, status: 'ongoing' } }, excluded: ['BGONE'] };
	const { get, storage } = await boot({ files: null, storage: new Map([['audiobook-catalog-data', JSON.stringify(old)]]) });
	assert.deepEqual((await kept(storage)).books, old.data);
	assert.deepEqual((await kept(storage)).seriesInfo, old.info);
	assert.deepEqual((await kept(storage)).excluded, ['BGONE']);
	assert.equal(storage.has(CATALOG_KEY), false);
	assert.equal(storage.has('audiobook-catalog-data'), false, 'moved to IndexedDB');
	assert.deepEqual((await kept(storage)).books, old.data);
});

test('a catalog this browser can\'t read is set aside, not overwritten', async () => {
	const { get, els, storage } = await boot({ storage: new Map([[CATALOG_KEY, '{not json']]) });
	assert.deepEqual(get('CATALOG.books'), []);
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
	await idle();
	els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'library.csv', text: csv }], value: '' } });
	await idle();

	// preview: nothing changed yet
	assert.ok(els.importPreview.classList.contains('open'));
	assert.equal(els.importPreviewTitle.textContent, 'Audible import');
	assert.match(els.importPreviewBody.innerHTML, /Already in the catalog: 1/);
	assert.match(els.importPreviewBody.innerHTML, /ASINs filled in on existing books: 1/);
	assert.match(els.importPreviewBody.innerHTML, /excluded from imports\): 1/);
	assert.match(els.importPreviewBody.innerHTML, /New: 1/);
	assert.match(els.importPreviewBody.innerHTML, /Ashfall/);
	assert.equal(els.importConfirm.textContent, 'Add 1 book');
	assert.equal(get('CATALOG.books.length'), 1);

	els.importConfirm.listeners.click[0]();
	await idle();
	assert.ok(!els.importPreview.classList.contains('open'));
	assert.deepEqual(get('CATALOG.books'), [
		{ t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5', e: [{ ext: { 'audible.com': 'B5' } }] },
		{ t: 'A Crown of Embers 6: Ashfall', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '6', e: [{ ext: { 'audible.com': 'B6' }, n: ['A. B. Quill'] }] },
	]);
	assert.match(els.ioStatus.textContent, /Added 1 book, filled in 1 ASIN/);

	// the same file again: nothing to add, nothing to confirm
	els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'library.csv', text: csv }], value: '' } });
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /Nothing new to add/);
	assert.equal(els.importConfirm.style.display, 'none');
});

test('a date read written as a plain string loads, renders, and round-trips through Export / Import', async () => {
	const mine = JSON.stringify([{ t: 'Hand Edited', a: ['Ann Vale'], r: '2024-03-15' }, { t: 'Odd', a: ['Ann Vale'], r: 5 }]);
	const { ctx, els, get } = await boot({ files: { 'books.json': mine } });
	assert.deepEqual(get('CATALOG.books[0].read'), ['2024-03-15']);
	ctx.setView('library');
	await idle();
	assert.match(els.results.innerHTML, /Read 2024-03-15/);
	assert.match(els.readFilter.innerHTML, /Read in 2024/);

	const backup = JSON.stringify({ books: [{ t: 'From Backup', a: ['Ann Vale'], r: '2023-01-05' }], seriesInfo: {} });
	const storage = new Map();
	const imp = await boot({ page: 'import.html', files: { 'books.json': mine }, storage });
	await imp.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: backup }], value: '' } });
	await idle();
	assert.doesNotMatch(imp.els.ioStatus.textContent, /Couldn't read/);
	assert.deepEqual(imp.get('CATALOG.books'), [{ t: 'From Backup', a: ['Ann Vale'], r: ['2023-01-05'] }]);
	await imp.saved();
	// back on the catalog page
	const back = await boot({ files: { 'books.json': mine }, storage });
	back.ctx.setView('library');
	await idle();
	assert.match(back.els.results.innerHTML, /Read 2023-01-05/);
});

test('a Goodreads import fills in dates read on books that have none', async () => {
	const mine = JSON.stringify([{ t: 'Old Favorite', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'B1' } }] }]);
	const { els, get } = await boot({ page: 'import.html', files: { 'books.json': mine } });
	const csv = 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n'
		+ 'Old Favorite,Ann Vale,,Audible Audio,read,,2023/11/04\n';
	els.importGoodreadsBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'goodreads.csv', text: csv }], value: '' } });
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /Dates read filled in on existing books: 1/);
	assert.equal(els.importConfirm.textContent, 'Save dates read');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books'), [{ t: 'Old Favorite', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'B1' } }], r: ['2023-11-04'] }]);
	assert.match(els.ioStatus.textContent, /filled in dates read on 1 book/);
});

test('importing a Goodreads CSV can be canceled', async () => {
	const { els, get } = await boot({ page: 'import.html' });
	const before = demoBooks.length;
	const csv = 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\n'
		+ '"Zzz New Book (Zzz Saga, #2)",Nobody Yet,,Audible Audio,read,fantasy\n';
	els.importGoodreadsBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'goodreads.csv', text: csv }], value: '' } });
	await idle();
	assert.equal(els.importPreviewTitle.textContent, 'Goodreads import');
	assert.match(els.importPreviewBody.innerHTML, /Zzz New Book — Nobody Yet  \[Zzz Saga #2\]/);
	els.importCancel.listeners.click[0]();
	await idle();
	assert.ok(!els.importPreview.classList.contains('open'));
	assert.equal(get('CATALOG.books.length'), before);
	els.importConfirm.listeners.click[0]();             // a stale click after cancelling does nothing
	assert.equal(get('CATALOG.books.length'), before);
});

test('Goodreads CSV downloads every book for Goodreads\' import', async () => {
	const { ctx, els, get } = await boot({ page: 'import.html' });
	const blobs = [];
	ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
	ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
	els.exportGoodreadsBtn.listeners.click[0]();
	await idle();
	assert.equal(blobs[0], get('new GoodreadsExporter().write(CATALOG.books).csv'));
	assert.match(blobs[0], /^Book Id,Title,Author,/);
	assert.match(els.ioStatus.textContent, new RegExp(`Goodreads CSV with ${demoBooks.length} books downloaded`));
});

test('Export includes series and author info, and Import brings them back', async () => {
	const first = await boot({ page: 'import.html' });
	const blobs = [];
	first.ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
	first.ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
	first.els.exportBtn.listeners.click[0]();
	await idle();
	const backup = JSON.parse(blobs[0]);
	assert.deepEqual(withoutIds(backup), { books: demoBooks, seriesInfo: JSON.parse(DEMO_INFO), authors: JSON.parse(DEMO_AUTHORS),
		narrators: JSON.parse(DEMO_NARRATORS), publishers: JSON.parse(DEMO_PUBLISHERS), excluded: [], notDuplicates: [] });
	// with the ids everything is stored under, so a Restore keeps them
	assert.equal(backup.books[0].uid, first.get('CATALOG.books[0].id'));
	assert.ok(backup.books.every(b => b.uid && (b.e || []).every(ed => ed.uid)));
	assert.equal(Object.keys(backup.ids.series).length, new Set(demoBooks.map(b => b.s).filter(Boolean)).size);
	assert.ok(Object.keys(backup.ids.narrators).length);

	// into a page that has no series info: it comes back, and survives a reload
	const mine = JSON.stringify([{ t: 'Mine', a: ['Me'] }]);
	const files = { 'books.json': mine };
	const other = await boot({ page: 'import.html', files });
	assert.deepEqual(other.get('[CATALOG.toJSON().seriesInfo, CATALOG.toJSON().authors]'), [{}, {}]);
	await other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
	await idle();
	assert.deepEqual(other.get('CATALOG.books'), demoBooks);
	assert.deepEqual(other.get('CATALOG.toJSON().seriesInfo'), backup.seriesInfo);
	assert.deepEqual(other.get('CATALOG.toJSON().authors'), backup.authors);
	assert.deepEqual(other.get('[CATALOG.toJSON().narrators, CATALOG.toJSON().publishers]'), [backup.narrators, backup.publishers]);
	await other.saved();
	assert.deepEqual(other.database.records('books').map(b => b.id).sort(), backup.books.map(b => b.uid).sort(), 'the books keep their ids');
	assert.deepEqual(other.database.records('series').map(x => x.id).sort(), Object.values(backup.ids.series).sort());
	await boot({ files, storage: other.storage });
	assert.deepEqual((await kept(other.storage)).seriesInfo, backup.seriesInfo);
	const reloaded = await kept(other.storage);
	assert.deepEqual(reloaded.authors, backup.authors);
	assert.deepEqual([reloaded.narrators, reloaded.publishers], [backup.narrators, backup.publishers]);

	// an older backup (a plain list of books) still imports and keeps the current series and author info
	const legacy = await boot({ page: 'import.html' });
	await legacy.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: mine }], value: '' } });
	await idle();
	assert.deepEqual(legacy.get('CATALOG.books'), [{ t: 'Mine', a: ['Me'] }]);
	assert.deepEqual(legacy.get('CATALOG.toJSON().seriesInfo'), JSON.parse(DEMO_INFO));
	assert.deepEqual(legacy.get('CATALOG.toJSON().authors'), JSON.parse(DEMO_AUTHORS));
	assert.deepEqual(legacy.get('CATALOG.toJSON().narrators'), JSON.parse(DEMO_NARRATORS));
});

test('Restore takes the data files of a catalog from before it lived in the browser, picked together', async () => {
	const { els, get, storage } = await boot({ page: 'import.html', files: null });
	const books = [{ t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1' }, { t: 'Tide Water', a: ['Ann Vale'] }];
	const pair = Duplicates.pairKey(Book.fromJSON(books[0]), Book.fromJSON(books[1]));
	await els.importFile.listeners.change[0]({ target: { value: '', files: [
		{ name: 'books.json', text: JSON.stringify(books) },
		{ name: 'series-info.json', text: '{"Gull Isle":{"total":3,"status":"ongoing"}}' },
		{ name: 'authors.json', text: '{"Ann Vale":{"bio":"Writes about the sea."}}' },
		{ name: 'narrators.json', text: '{"Cy Hale":{"bio":"Reads sea stories."}}' },
		{ name: 'excluded.txt', text: '# books imports skip\nBGONE\n' },
		{ name: 'not-duplicates.txt', text: pair + '\n' },
	] } });
	assert.match(els.ioStatus.textContent, /^Restored 2 books and info for 1 series; 1 more excluded from imports\.$/);
	assert.deepEqual((await kept(storage)), { books, seriesInfo: { 'Gull Isle': { total: 3, status: 'ongoing' } },
		authors: { 'Ann Vale': { bio: 'Writes about the sea.' } }, narrators: { 'Cy Hale': { bio: 'Reads sea stories.' } }, publishers: {}, excluded: ['BGONE'],
		notDuplicates: [pair] });
	assert.deepEqual(get('CATALOG.markTexts()'), [pair]);
	assert.deepEqual(get('[...CATALOG.marks.values()].map(m => [m.kind, m.bookIds])'), [['notDuplicates', get('CATALOG.books.map(b => b.id).sort()')]], 'pointing at the books restored');
	assert.equal(els.dupCount.textContent, '');

	// without books.json, or with a file that is none of these, nothing changes
	for (const files of [[{ name: 'series-info.json', text: '{}' }], [{ name: 'books.json', text: '[]' }, { name: 'notes.txt', text: 'hi' }]]) {
		await els.importFile.listeners.change[0]({ target: { value: '', files } });
		await idle();
		assert.match(els.ioStatus.textContent, /Couldn't read that/);
		assert.equal(get('CATALOG.books.length'), 2);
	}
	// nor with a value the catalog has no place for, which is named
	await els.importFile.listeners.change[0]({ target: { value: '', files: [{ name: 'b.json', text: JSON.stringify({ books: [{ t: 'Odd', a: ['Me'], g: 5 }] }) }] } });
	await idle();
	assert.equal(els.ioStatus.textContent, "Not restored: fix these values in the backup first (they aren't what their field holds): book #0 ('Odd'): 'g'.");
	assert.equal(get('CATALOG.books.length'), 2);
});

// Press a book's remove button twice (the second press confirms), as in the library view.
// `i` is the book's place in the catalog's order.
async function removeBook(ctx, i) {
	ctx.setView('library');
	await idle();
	const id = [...ctx.indexedDB.records('books')].sort((x, y) => x.position - y.position)[i].id;
	const btn = ctx.document.getElementById('results').querySelector(`.iconbtn.del[data-id="${id}"]`);
	btn.dispatch('click');
	assert.equal(btn.textContent, '\u2713', 'the first press asks to confirm');
	btn.dispatch('click');
}

test('removing a book excludes it from imports, and Export / Import carry the exclusions', async () => {
	const mine = JSON.stringify([{ t: 'Keep', a: ['Ann Vale'] }, { t: 'Gone', a: ['Ann Vale'], id: 'BGONE2' }]);
	const files = { 'books.json': mine, 'excluded.txt': '# header\nBOLD\n' };
	const { ctx, els, get, storage } = await boot({ files });
	ctx.setView('library');
	await idle();
	await removeBook(ctx, 1);
	assert.deepEqual(get('CATALOG.books'), [{ t: 'Keep', a: ['Ann Vale'] }]);
	assert.equal(els.ioStatus.textContent, 'Removed Gone; imports will skip it.');
	assert.deepEqual((await kept(storage)).excluded, ['BOLD', 'BGONE2', 'Gone | Ann Vale']);

	// on the import page, an import (Audible by id, or Goodreads by title) does not bring it back
	const imp = await boot({ page: 'import.html', files, storage });
	imp.els.importAudibleBtn.listeners.click[0]();
	await idle();
	imp.els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'l.csv', text:
		'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\nx,Gone,,Ann Vale,,Finished,BGONE2\n' }], value: '' } });
	await idle();
	assert.match(imp.els.importPreviewBody.innerHTML, /excluded from imports\): 1/);
	imp.els.importGoodreadsBtn.listeners.click[0]();
	await idle();
	imp.els.importCsvFile.listeners.change[0]({ target: { files: [{ name: 'g.csv', text:
		'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\nGone,Ann Vale,,Audible Audio,read,\n' }], value: '' } });
	await idle();
	assert.match(imp.els.importPreviewBody.innerHTML, /excluded from imports\): 1/);

	// a reload keeps the exclusions along with the edit
	await boot({ files, storage });
	assert.deepEqual((await kept(storage)).excluded, ['BOLD', 'BGONE2', 'Gone | Ann Vale']);

	// Export has the whole list; Import adds it to another page's list
	const blobs = [];
	imp.ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
	imp.ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
	imp.els.exportBtn.listeners.click[0]();
	await idle();
	const backup = JSON.parse(blobs[0]);
	assert.deepEqual(backup.excluded, ['BOLD', 'BGONE2', 'Gone | Ann Vale']);
	const other = await boot({ page: 'import.html', files: { 'books.json': '[]', 'excluded.txt': 'BOLD\nOther\n' } });
	await other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
	await idle();
	assert.deepEqual(other.get('CATALOG.exclusions.entries'), ['BOLD', 'Other', 'BGONE2', 'Gone | Ann Vale']);
	assert.match(other.els.ioStatus.textContent, /2 more excluded from imports/);
});

test('the edit form takes the place of the book card, and adding a book opens it at the top', async () => {
	const { ctx, els, get } = await boot();
	ctx.setView('library');
	await idle();
	// the list as drawn: a card for each book, found by its data-id
	const cards = {};
	ctx.document.querySelector = sel => {
		const m = /^#results \.book\[data-id="([^"]+)"\]$/.exec(sel);
		return m ? (cards[m[1]] ||= makeElement(`card-${m[1]}`)) : null;
	};
	const third = bookIdAt(get, 2);
	ctx.openEditForm(third);
	assert.equal(els.addForm.place, `after card-${third}`);
	assert.ok(cards[third].classList.contains('editing'), 'the card is hidden while its form is open');
	await ctx.refreshView();
	await idle();
	assert.equal(els.addForm.place, `after card-${third}`, 'redrawing the list keeps the form on its book');
	els.cancelAdd.listeners.click[0]();
	await idle();
	assert.equal(els.addForm.place, 'before seriesForm');

	els.toggleAdd.listeners.click[0]();
	await idle();
	assert.ok(els.addForm.classList.contains('open'));
	assert.equal(els.addForm.place, 'before seriesForm');

	// a book not shown in the list is edited at the top
	ctx.document.querySelector = () => null;
	ctx.openEditForm(bookIdAt(get, 1));
	assert.equal(els.addForm.place, 'before seriesForm');
	assert.equal(els.formTitle.textContent, 'Edit book');
});

test('removing a book while another is being edited saves the edit to the right book', async () => {
	const mine = JSON.stringify([{ t: 'First', a: ['Ann Vale'] }, { t: 'Second', a: ['Ann Vale'] }, { t: 'Third', a: ['Ann Vale'] }]);
	const { ctx, els, get } = await boot({ files: { 'books.json': mine } });
	ctx.setView('library');
	await idle();
	ctx.openEditForm(bookIdAt(get, 1));
	await removeBook(ctx, 0);
	assert.ok(els.addForm.classList.contains('open'), 'the form stays open on its book');
	els.f_t.value = 'Second, Edited';
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Second, Edited', 'Third']);

	// removing the book being edited closes the form, and removing a later one leaves it be
	ctx.openEditForm(bookIdAt(get, 0));
	await removeBook(ctx, 1);
	els.f_t.value = 'Second, Again';
	els.addForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Second, Again']);
	ctx.openEditForm(bookIdAt(get, 0));
	await removeBook(ctx, 0);
	assert.ok(!els.addForm.classList.contains('open'));
});

test('series show which books are missing, and can be filtered to those', async () => {
	const { els, storage } = await boot();
	await idle();
	// (worked out on the Duplicates page, which holds the whole catalog)
	const whole = await boot({ page: 'duplicates.html', storage });
	const info = JSON.parse(DEMO_INFO);
	const gaps = Object.keys(info).filter(name =>
		whole.get(`CATALOG.missing(${JSON.stringify(name)})`).length);
	assert.ok(gaps.length > 0 && gaps.length < Object.keys(info).length, 'the demo data should have a series with gaps and one without');
	assert.match(els.results.innerHTML, /class="missing">missing #/);

	els.missingFilter.value = 'missing';
	els.missingFilter.listeners.change[0]();
	await idle();
	assert.equal((els.results.innerHTML.match(/class="srow-title"/g) || []).length, gaps.length);  // no Standalone row either
	assert.equal(els.resultCount.textContent, `${gaps.length} series shown`);
	assert.equal(els.missingFilter.style.display, '');

	els.btnLibraryView.listeners.click[0]();
	await idle();
	assert.equal(els.missingFilter.style.display, 'none');

	const { ctx: ctx2, els: els2, get: get2 } = await boot();
	ctx2.openSeries(seriesIdOf(get2, gaps[0]));
	await idle();
	assert.match(els2.results.innerHTML, /class="series-note">[^<]*missing #/);
});

test('a series and a book keep their ids in external catalogs, typed as an id or pasted as an address', async () => {
	const { ctx, els, get, storage } = await boot();
	ctx.openSeriesForm(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	assert.equal(els.sf_ext_goodreads.value, '90001');
	assert.equal(els.sf_ext_hardcover.value, 'the-lantern-coast-sample');
	els.sf_ext_audible.value = 'https://www.audible.com/series/The-Lantern-Coast-Audiobooks/B0LANTERN1?ref=x';
	els.sf_ext_goodreads.value = '';
	await els.seriesForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	// Hardcover's series by the name in its address, as no token is saved to look up its number
	assert.deepEqual(get("CATALOG.infoByName('series').get('The Lantern Coast').external"), { 'audible.com': 'B0LANTERN1', hardcover: 'the-lantern-coast-sample' });
	assert.match(els.ioStatus.textContent, /^Saved series info for The Lantern Coast\. Kept Hardcover's series by the name in its address, as no Hardcover API token is saved/);
	assert.deepEqual((await kept(storage)).seriesInfo['The Lantern Coast'].ext, { 'audible.com': 'B0LANTERN1', hardcover: 'the-lantern-coast-sample' });
	assert.match(els.results.innerHTML, /<a class="authorlink" href="https:\/\/www\.audible\.com\/series\/B0LANTERN1" target="_blank" rel="noopener">Audible ↗<\/a>/);
	// something that is neither is refused
	ctx.openSeriesForm(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	els.sf_ext_goodreads.value = 'https://www.goodreads.com/book/show/4242';
	await els.seriesForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.match(els.seriesFormError.textContent, /Goodreads: https:\/\/www\.goodreads\.com\/book\/show\/4242/);
	els.cancelSeries.listeners.click[0]();
	await idle();

	// a book's Goodreads work, by its address
	ctx.setView('library');
	await idle();
	ctx.openEditForm(bookIdAt(get, 0));
	els.f_ext_goodreads.value = 'https://www.goodreads.com/work/editions/990001-the-salt-road';
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.equal(get("CATALOG.books[0].idOn('goodreads')"), '990001');
	assert.match(els.results.innerHTML, /Goodreads book <a href="https:\/\/www\.goodreads\.com\/work\/editions\/990001" target="_blank" rel="noopener">990001<\/a>/);

	// and its work on Open Library, and its item on Wikidata
	ctx.openEditForm(bookIdAt(get, 0));
	els.f_ext_openlibrary.value = 'https://openlibrary.org/works/OL123W/The_Salt_Road';
	els.f_ext_wikidata.value = 'q1001';
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.deepEqual(get('CATALOG.books[0].external'), { goodreads: '990001', openlibrary: 'OL123W', wikidata: 'Q1001' });
});

test('an edition has fields for Goodreads and Hardcover, and one for another catalog once it is picked or used', async () => {
	const { ctx, els, get } = await boot();
	ctx.setView('library');
	await idle();
	ctx.openEditForm(bookIdAt(get, 0));
	assert.match(els.f_editions.innerHTML, /data-i="0" data-k="ext:goodreads"/);
	assert.match(els.f_editions.innerHTML, /data-i="0" data-k="ext:hardcover"/);
	assert.doesNotMatch(els.f_editions.innerHTML, /data-k="ext:openlibrary"/);
	assert.match(els.f_editions.innerHTML, /<select data-add-site="0"[^>]*><option value="">\+ Another catalog<\/option><option value="openlibrary">Open Library<\/option><option value="isfdb">ISFDB<\/option><option value="bookbrainz">BookBrainz<\/option><\/select>/);
	els.f_editions.listeners.change[0]({ target: { dataset: { addSite: '0' }, value: 'isfdb' } });
	await idle();
	assert.match(els.f_editions.innerHTML, /<label>ISFDB edition<\/label><input data-i="0" data-k="ext:isfdb" value="" placeholder="id or isfdb\.org address"/);
	typeEdition(els, 0, 'ext:isfdb', 'https://www.isfdb.org/cgi-bin/pl.cgi?1039718=');
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	assert.equal(get("CATALOG.books[0].editions[0].idOn('isfdb')"), '1039718');
	// an edition with an id there shows its field
	ctx.openEditForm(bookIdAt(get, 0));
	assert.match(els.f_editions.innerHTML, /data-i="0" data-k="ext:isfdb" value="1039718"/);
	assert.match(els.f_editions.innerHTML, /<select data-add-site="0"[^>]*><option value="">\+ Another catalog<\/option><option value="openlibrary">Open Library<\/option><option value="bookbrainz">BookBrainz<\/option><\/select>/);
});

test('series info can be edited, added and removed in the page', async () => {
	const { ctx, els, get, storage } = await boot();
	const info = JSON.parse(DEMO_INFO);
	const [name] = Object.keys(info);
	assert.match(els.results.innerHTML, /class="iconbtn sedit"/);

	// edit: the form starts from the current entry
	ctx.openSeriesForm(seriesIdOf(get, name));
	await idle();
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
	await idle();
	assert.ok(!els.seriesForm.classList.contains('open'));
	assert.deepEqual(get(`CATALOG.infoByName('series').get(${JSON.stringify(name)})`),
		{ total: 7, status: 'ongoing', note: 'book 8 is announced', url: 'https://example.com/author' });
	assert.match(els.results.innerHTML, /7 owned|owned of 7/);
	assert.deepEqual((await kept(storage)).seriesInfo[name].total, 7);

	// invalid input is refused with a message, and nothing changes
	ctx.openSeriesForm(seriesIdOf(get, name));
	await idle();
	Object.assign(els.sf_total, { value: 'lots' });
	Object.assign(els.sf_note, { value: '' });
	Object.assign(els.sf_url, { value: 'example.com' });
	els.seriesForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.ok(els.seriesForm.classList.contains('open'));
	assert.match(els.seriesFormError.textContent, /total must be a positive integer/);
	assert.match(els.seriesFormError.textContent, /url must start with/);
	assert.equal(get(`CATALOG.infoByName('series').get(${JSON.stringify(name)}).total`), 7);
	els.cancelSeries.listeners.click[0]();
	await idle();
	assert.ok(!els.seriesForm.classList.contains('open'));

	// add: a series without info gets a fresh entry ("many" is allowed)
	const bare = demoBooks.map(b => b.s).find(s => s && !(s in info));
	assert.ok(bare, 'the demo data has a series without info');
	ctx.openSeriesForm(seriesIdOf(get, bare));
	await idle();
	assert.equal(els.sf_total.value, '');
	assert.equal(els.seriesRemoveBtn.style.display, 'none');
	Object.assign(els.sf_total, { value: 'Many' });
	Object.assign(els.sf_status, { value: 'complete' });
	Object.assign(els.sf_note, { value: 'finished' });
	els.seriesForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.deepEqual(get(`CATALOG.infoByName('series').get(${JSON.stringify(bare)})`), { total: 'many', status: 'complete', note: 'finished' });

	// remove
	ctx.openSeriesForm(seriesIdOf(get, name));
	await idle();
	els.seriesRemoveBtn.listeners.click[0]();
	await idle();
	assert.equal(get(`CATALOG.infoByName('series').has(${JSON.stringify(name)})`), false);
	assert.equal(get(`CATALOG.infoByName('series').has(${JSON.stringify(bare)})`), true);
});

test('a series can be renamed from its series info form, on every book in it', async () => {
	const { ctx, els, get, storage } = await boot();
	const info = JSON.parse(DEMO_INFO);
	const [name] = Object.keys(info);
	const count = demoBooks.filter(b => b.s === name).length;
	assert.ok(count > 0);

	await kept(storage);
	const seriesId = databaseOf(storage).records('series').find(x => x.name === name).id;
	// shown from the series itself: the page follows the new name
	ctx.openSeries(seriesIdOf(get, name));
	await idle();
	ctx.openSeriesForm(seriesIdOf(get, name));
	await idle();
	assert.equal(els.sf_name.value, name);
	Object.assign(els.sf_name, { value: '  The Renamed   Saga ' });
	els.seriesForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.ok(!els.seriesForm.classList.contains('open'));
	assert.equal(get(`CATALOG.books.filter(b => b.series === 'The Renamed Saga').length`), count);
	assert.equal(get(`CATALOG.books.some(b => b.series === ${JSON.stringify(name)})`), false);
	assert.deepEqual(get(`CATALOG.infoByName('series').get('The Renamed Saga')`), info[name]);
	assert.equal(get(`CATALOG.infoByName('series').has(${JSON.stringify(name)})`), false);
	assert.equal(get('SERIES_FILTER'), seriesId, 'still the series shown, by its id');
	assert.equal(ctx.location.hash, `#series=${seriesId}`);
	assert.equal(els.crumbLabel.textContent, 'The Renamed Saga');
	assert.match(els.ioStatus.textContent, new RegExp(`Renamed .* on ${count} book`));
	const saved = (await kept(storage));
	assert.ok(saved.seriesInfo['The Renamed Saga']);
	assert.deepEqual(databaseOf(storage).records('series').filter(x => x.name === 'The Renamed Saga').map(x => x.id), [seriesId], 'it keeps its id');
	assert.equal(saved.books.filter(b => b.s === 'The Renamed Saga').length, count);

	// a series without info is renamed without having to add some
	const bare = demoBooks.map(b => b.s).find(s => s && !(s in info));
	const bareCount = demoBooks.filter(b => b.s === bare).length;
	ctx.openSeriesForm(seriesIdOf(get, bare));
	await idle();
	Object.assign(els.sf_name, { value: 'Plain Renamed' });
	els.seriesForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.equal(els.seriesFormError.textContent, '');
	assert.equal(get(`CATALOG.books.filter(b => b.series === 'Plain Renamed').length`), bareCount);
	assert.equal(get(`CATALOG.infoByName('series').has('Plain Renamed')`), false);

	// an empty name is refused
	ctx.openSeriesForm(seriesIdOf(get, 'Plain Renamed'));
	await idle();
	Object.assign(els.sf_name, { value: '   ' });
	els.seriesForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.match(els.seriesFormError.textContent, /Give the series a name/);
	els.cancelSeries.listeners.click[0]();
	await idle();

	// joining another series takes a second Save, and its info gives way to this form's
	ctx.openSeriesForm(seriesIdOf(get, 'Plain Renamed'));
	await idle();
	Object.assign(els.sf_name, { value: 'The Renamed Saga' });
	els.seriesForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.ok(els.seriesForm.classList.contains('open'));
	assert.match(els.seriesFormError.textContent, /already a series called The Renamed Saga\. Press Save again/);
	assert.equal(get(`CATALOG.books.filter(b => b.series === 'Plain Renamed').length`), bareCount);
	els.seriesForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.ok(!els.seriesForm.classList.contains('open'));
	assert.equal(get(`CATALOG.books.filter(b => b.series === 'The Renamed Saga').length`), count + bareCount);
	assert.deepEqual(get(`CATALOG.infoByName('series').get('The Renamed Saga')`), info[name]);
});

// Lets pending promises (a save on its way to the fake server) settle.
const settle = () => new Promise(resolve => setImmediate(resolve));

test('duplicates page: found, merged with the picked title, or kept apart', async () => {
	const mine = JSON.stringify([
		{ t: 'The Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', g: ['Fantasy'], e: [{ ext: { 'audible.com': 'B1' } }] },
		{ t: 'Beacons', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '2', e: [{ ext: { 'audible.com': 'BBOX' }, p: 'Gull Audio' }] },
		{ t: 'Salt Road', a: ['Marisol Quenby'], n: ['Tobias Frane'], s: 'Lantern Coast', sn: '1', r: ['2023-06-02'], e: [{ ext: { goodreads: '4242' } }] },
		{ t: 'The Drowned Chart', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '3', e: [{ ext: { 'audible.com': 'BBOX' }, p: 'Gull Audio' }] },
		{ t: 'The Ledger', a: ['Priya Ostrander'] },
		{ t: 'The Ledger, Book 1', a: ['Priya Ostrander'] },
	]);
	const files = { 'books.json': mine };
	// every page's link says how many there are; a box set's titles share an edition but are not duplicates
	const home = await boot({ files });
	assert.equal(home.els.dupCount.textContent, ' (2)');

	const { ctx, els, get, run, storage } = await boot({ page: 'duplicates.html', files });
	// the books by the ids they are stored under
	const at = get('CATALOG.books.map(b => b.id)');
	assert.deepEqual(get('DUP_GROUPS'), [[at[0], at[2]], [at[4], at[5]]]);
	assert.match(els.subtitle.textContent, /^2 possible duplicates among 6 audiobooks/);
	assert.match(els.dupBody.innerHTML, /name="dup-0-title"[^>]*checked=""> <span class="dup-label">Title<\/span> The Salt Road/);
	assert.match(els.dupBody.innerHTML, /Becomes: The Salt Road/);

	// pick the second entry's title, then merge: one book with both editions, the narrator and the date read
	run('DUP_PICKS[0].title = 1; renderDuplicates()');
	assert.match(els.dupBody.innerHTML, /Becomes: Salt Road/);
	ctx.mergeGroup(0);
	assert.equal(get('CATALOG.books.length'), 5);
	assert.deepEqual(get('CATALOG.books[0]'), { t: 'Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1',
		g: ['Fantasy'], r: ['2023-06-02'], e: [{ ext: { 'audible.com': 'B1', goodreads: '4242' }, n: ['Tobias Frane'] }] });   // Audible's and Goodreads' records of one edition
	assert.match(els.ioStatus.textContent, /^Merged 2 entries into Salt Road\./);
	assert.equal(get('CATALOG.exclusions.size'), 0);              // the removed entry's ids live on in the kept book
	assert.deepEqual(get('CATALOG.books.map(b => b.id)'), [at[0], at[1], at[3], at[4], at[5]], 'the book that came first is the one kept');
	assert.deepEqual(get('DUP_GROUPS'), [[at[4], at[5]]]);
	assert.equal(els.dupCount.textContent, ' (1)');

	// "Not duplicates" is remembered in this browser, also after a reload
	ctx.keepApart(0);
	assert.match(els.dupBody.innerHTML, /No books look like duplicates/);
	assert.equal(els.dupCount.textContent, '');
	const again = await boot({ page: 'duplicates.html', files, storage });
	assert.deepEqual(again.get('DUP_GROUPS'), []);
	assert.equal(again.get('CATALOG.books.length'), 5);            // the merge was kept in this browser
});

test('the merge button pairs two books by hand and opens them on the duplicates page', async () => {
	const mine = JSON.stringify([{ t: 'Ledger', a: ['Priya Ostrander'] }, { t: 'Other', a: ['Ann Vale'] }, { t: 'The Ledger', a: ['P. Ostrander'], r: ['2024'] }]);
	const files = { 'books.json': mine };
	const home = await boot({ files });
	home.ctx.setView('library');
	await idle();
	const at = home.get('CATALOG.books.map(b => b.id)');
	home.ctx.pickMergeBook(at[2]);
	await idle();
	assert.match(home.els.results.innerHTML, /class="book picked"/);
	assert.match(home.els.ioStatus.textContent, /Now press .* The Ledger with/);
	home.ctx.pickMergeBook(at[0]);
	await idle();
	assert.equal(home.ctx.location.href, `duplicates.html#merge=${at[2]},${at[0]}`);

	const { ctx, els, get } = await boot({ page: 'duplicates.html', storage: home.storage, hash: `#merge=${at[2]},${at[0]}` });
	assert.deepEqual(get('DUP_GROUPS'), [[at[0], at[2]]], 'in the order the catalog has them');
	assert.match(els.dupBody.innerHTML, /Picked by hand/);
	ctx.mergeGroup(0);
	assert.deepEqual(get('CATALOG.books'), [{ t: 'Ledger', a: ['Priya Ostrander'], r: ['2024'] }, { t: 'Other', a: ['Ann Vale'] }]);
	assert.equal(get('DUP_MANUAL'), null);
	assert.equal(ctx.location.hash, '');

	// an address naming no such books shows only what was found
	const stale = await boot({ page: 'duplicates.html', storage: home.storage, hash: `#merge=${at[1]},no-such-book` });
	assert.deepEqual(stale.get('DUP_GROUPS'), []);
});

test('edits of different books in two tabs are both saved, and the same book edited in both is not', async () => {
	const files = { 'books.json': JSON.stringify([{ t: 'Mine', a: ['Me'] }, { t: 'Yours', a: ['You'] }, { t: 'Theirs', a: ['Them'] }]) };
	const storage = new Map();
	const one = await boot({ files, storage });
	one.ctx.setView('library');
	await idle();
	const two = await boot({ page: 'duplicates.html', files, storage });
	await one.run("CATALOG.books[0].title = 'Edited Here'; persist();");
	await two.run("CATALOG.books[1].title = 'Edited There'; persist();");
	assert.equal(two.els.ioStatus.textContent, '');
	assert.deepEqual((await kept(storage)).books.map(b => b.t), ['Edited Here', 'Edited There', 'Theirs']);
	assert.equal(two.get('CATALOG.books[0].title'), 'Edited Here', 'the tab saving second took in the first one\'s edit');

	// one tab removes a book and adds one; the other tab's page shows that once it saves an edit of its own
	await two.run("CATALOG.books.splice(0, 1); CATALOG.books.push(new Book({title: 'Added There', authors: ['Them']})); persist();");
	const retitled = bookIdOf(one.get, 'Theirs');
	one.ctx.openEditForm(retitled);
	await one.run("CATALOG.books[2].title = 'Retitled Here'; persist();");
	assert.deepEqual((await kept(storage)).books.map(b => b.t), ['Edited There', 'Retitled Here', 'Added There']);
	assert.deepEqual(one.get('CATALOG.books').map(b => b.t), ['Edited There', 'Retitled Here', 'Added There']);
	assert.equal(one.get('EDIT_ID'), retitled, 'the form still edits the book it was opened on');
	assert.ok(one.els.addForm.classList.contains('open'));

	// both tabs change one book: the second save is refused, and nothing it held is written
	await one.run("CATALOG.books[0].title = 'Both Here'; persist();");
	await two.run("CATALOG.books[0].title = 'Both There'; CATALOG.books[2].title = 'Also There'; persist();");
	assert.match(two.els.ioStatus.textContent, /"Both There" changed in another tab too/);
	assert.deepEqual((await kept(storage)).books.map(b => b.t), ['Both Here', 'Retitled Here', 'Added There']);
	await one.run("CATALOG.books[1].title = 'Again Here'; persist();");      // the tab that saved last can keep going
	assert.equal((await kept(storage)).books[1].t, 'Again Here');
});

test('merging keeps editions apart when asked, and books merged that way can be joined later', async () => {
	const mine = JSON.stringify([
		{ t: 'The Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', e: [{ ext: { 'audible.com': 'B1' }, len: 642 }] },
		{ t: 'Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', e: [{ ext: { goodreads: '4242' }, p: 'Gull Audio' }] },
		{ t: 'Beacons', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '2', e: [{ ext: { 'audible.com': 'B2' } }, { ext: { goodreads: '777' }, isbn: '9780306406157' }] },
		{ t: 'The Drowned Chart', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '3', e: [{ ext: { 'audible.com': 'B3' } }, { ext: { 'audible.com': 'B3X' } }] },
		{ t: 'Box Set', a: ['Marisol Quenby'], e: [{ ext: { 'audible.com': 'BBOX' } }, { ext: { goodreads: '888' } }] },
		{ t: 'Other In Box', a: ['Marisol Quenby'], e: [{ ext: { 'audible.com': 'BBOX' } }] },
	]);
	const files = { 'books.json': mine };
	const { ctx, els, get, run, storage } = await boot({ page: 'duplicates.html', files });
	const at = get('CATALOG.books.map(b => b.id)');
	// Beacons (an ASIN edition and a Goodreads one) is listed; two ASINs, or a box set's shared edition, are not
	assert.deepEqual(get('SPLIT'), [at[2]]);
	assert.match(els.subtitle.textContent, /1 book with editions that look like one/);
	assert.equal(els.dupCount.textContent, ' (2)');
	assert.match(els.dupBody.innerHTML, /class="dup-joinbox" data-g="0" checked=""/);

	// untick "Make the editions one edition": the merge keeps both
	run('DUP_PICKS[0].joinEditions = false; renderDuplicates()');
	assert.match(els.dupBody.innerHTML, /class="dup-joinbox" data-g="0">/);
	ctx.mergeGroup(0);
	assert.deepEqual(get('CATALOG.books[0].editions'), [{ ext: { 'audible.com': 'B1' }, len: 642 }, { ext: { goodreads: '4242' }, p: 'Gull Audio' }]);
	// ...and the merged book is now offered for joining, like Beacons
	assert.deepEqual(get('SPLIT'), [at[0], at[2]]);
	ctx.joinBookEditions(at[0]);
	assert.deepEqual(get('CATALOG.books[0].editions'), [{ ext: { 'audible.com': 'B1', goodreads: '4242' }, p: 'Gull Audio', len: 642 }]);
	assert.match(els.ioStatus.textContent, /^The Salt Road now has one edition\./);
	// "Keep separate" is remembered in this browser
	ctx.keepEditionsApart(get('SPLIT[0]'));
	assert.deepEqual(get('SPLIT'), []);
	const again = await boot({ page: 'duplicates.html', storage });
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
	// public/ is what gets served, so it holds the app and nothing else (no catalog files, no notes).
	const served = fs.readdirSync(site, { recursive: true }).filter(f => fs.statSync(path.join(site, f)).isFile()).map(f => f.split(path.sep).join('/'));
	for (const file of served) assert.ok(file === 'sw.js' || cached.includes(file), `public/${file} is part of the app (add it to sw.js's APP list)`);
});

test('"Not duplicates" marks are kept in this browser and travel in backups', async () => {
	const books = [{ t: 'The Ledger', a: ['Priya Ostrander'] }, { t: 'The Ledger, Book 1', a: ['Priya Ostrander'] },
		{ t: 'Salt Road', a: ['Marisol Quenby'] }, { t: 'Salt Road, Book 1', a: ['Marisol Quenby'] }];
	const pairKey = (x, y) => Duplicates.pairKey(Book.fromJSON(books[x]), Book.fromJSON(books[y]));
	const ledger = pairKey(0, 1);
	const files = { 'books.json': JSON.stringify(books), 'not-duplicates.txt': '# header\n' + ledger + '\n' };
	const { ctx, get, run, els, storage } = await boot({ page: 'duplicates.html', files });
	const at = get('CATALOG.books.map(b => b.id)');
	// the marks kept hide that pair
	assert.deepEqual(get('DUP_GROUPS'), [[at[2], at[3]]]);

	// marking the other pair keeps it too, by the books' ids
	ctx.keepApart(0);
	assert.deepEqual((await kept(storage)).notDuplicates, [ledger, pairKey(2, 3)]);
	assert.deepEqual(get('[...CATALOG.marks.values()].map(m => m.bookIds)'), [[at[0], at[1]].sort(), [at[2], at[3]].sort()]);
	assert.deepEqual(get('DUP_GROUPS'), []);
	assert.equal(els.dupCount.textContent, '');
	// so a book retitled is still marked, and a backup has the mark by its new title
	await run("CATALOG.books[3].title = 'Salt Road, Volume 1'; persist()");
	assert.equal(get('CATALOG.duplicates().markedNotSame(CATALOG.books[2], CATALOG.books[3])'), true);
	assert.deepEqual(get('CATALOG.markTexts()')[1], get('Duplicates.pairKey(CATALOG.books[2], CATALOG.books[3])'));
	await run("CATALOG.books[3].title = 'Salt Road, Book 1'; persist()");

	// Export carries every mark; Restore elsewhere brings them back
	const imp = await boot({ page: 'import.html', files: { ...files, 'not-duplicates.txt': ledger } });
	const blobs = [];
	imp.ctx.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
	imp.ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
	imp.els.exportBtn.listeners.click[0]();
	await idle();
	assert.deepEqual(JSON.parse(blobs[0]).notDuplicates, [ledger]);
	const backup = { books, seriesInfo: {}, notDuplicates: [ledger, pairKey(2, 3)] };
	const other = await boot({ page: 'import.html', files: { 'books.json': JSON.stringify(books) } });
	await other.els.importFile.listeners.change[0]({ target: { files: [{ name: 'b.json', text: JSON.stringify(backup) }], value: '' } });
	await idle();
	const after = await boot({ page: 'duplicates.html', storage: other.storage });
	assert.deepEqual(after.get('DUP_GROUPS'), []);
});

test('Merge previews a backup from another device and keeps both sides\' changes', async () => {
	const mine = JSON.stringify([{ t: 'Here', a: ['Ann Vale'] }, { t: 'Renamed', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'B1' } }] }]);
	const backup = { books: [{ t: 'Here', a: ['Ann Vale'], r: ['2025-06-01'] }, { t: 'Renamed Twice', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'B1' } }] },
		{ t: 'New There', a: ['Ann Vale'] }], seriesInfo: {}, excluded: ['BGONE9'], notDuplicates: ['["editions","id B1"]'] };
	const { els, get, storage } = await boot({ page: 'import.html', files: { 'books.json': mine } });
	els.mergeFile.listeners.change[0]({ target: { files: [{ name: 'phone.json', text: JSON.stringify(backup) }], value: '' } });
	await idle();
	assert.equal(els.importPreviewTitle.textContent, 'Merge a backup');
	assert.ok(els.mergePrefer.classList.contains('show'));
	assert.match(els.importPreviewBody.innerHTML, /New from the backup: 1<\/p><ul><li>New There — Ann Vale/);
	assert.match(els.importPreviewBody.innerHTML, /keeping this catalog's: 1<\/p><ul><li>Renamed — Ann Vale \/ backup: Renamed Twice/);
	assert.match(els.importPreviewBody.innerHTML, /More books marked "Not duplicates": 1/);
	assert.equal(get('CATALOG.books.length'), 2, 'nothing changes before it is confirmed');

	// preferring the backup's version redraws the preview, and confirming applies it
	els.mergePreferSelect.value = 'backup';
	els.mergePreferSelect.listeners.change[0]();
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /keeping the backup's: 1/);
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books'), backup.books);
	assert.deepEqual(get('CATALOG.exclusions.entries'), ['BGONE9']);
	assert.deepEqual(get('CATALOG.markTexts()'), ['["editions","id B1"]']);
	assert.deepEqual((await kept(storage)).notDuplicates, ['["editions","id B1"]']);
	assert.match(els.ioStatus.textContent, /^Merged: 1 added, 2 updated, 0 removed\./);
	assert.deepEqual((await kept(storage)).books, backup.books);
	assert.ok(!els.importPreview.classList.contains('open'));

	// merging the same backup again has nothing to do
	els.mergeFile.listeners.change[0]({ target: { files: [{ name: 'phone.json', text: JSON.stringify(backup) }], value: '' } });
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /Nothing to merge/);
	assert.equal(els.importConfirm.style.display, 'none');
});

test('the page runs a Hardcover sync itself, with a token kept in this browser', async () => {
	const mine = [{ t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ ext: { 'audible.com': 'B0LANTERN1' } }] }];
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
	await idle();
	assert.match(els.ioStatus.textContent, /Save your Hardcover API token first/);
	assert.equal(hc.sent.length, 0);

	els.hardcoverToken.value = 'Bearer tok-123';
	await els.hardcoverTokenSave.listeners.click[0]();
	await idle();
	assert.equal(storage.get('audiobook-catalog-hardcover-token'), 'tok-123');
	assert.equal(els.hardcoverToken.value, '', 'the token is not left in the page');
	assert.match(els.hardcoverTokenState.textContent, /saved in this browser only/);

	// the preview: asked from the page, nothing changed anywhere
	await els.hardcoverSyncBtn.listeners.click[0]();
	await idle();
	assert.ok(hc.sent.every(s => s.auth === 'Bearer tok-123' && s.url === 'https://api.hardcover.app/v1/graphql'));
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));
	assert.ok(!els.bgTask.classList.contains('show'));
	assert.equal(els.importPreviewTitle.textContent, 'Sync with Hardcover: preview');
	assert.match(els.importPreviewBody.innerHTML, /\+ Tidewater - Ann Vale/);
	assert.match(els.importPreviewBody.innerHTML, /books to put on your Read shelf: 1\n {4}\+ Lantern Hours - R\. T\. Hale/);
	assert.doesNotMatch(els.importPreviewBody.innerHTML, /dry run/);
	assert.equal(get('CATALOG.books.length'), 1);
	assert.equal(state.shelf.length, 2);

	// the real run keeps the catalog before sending, and the browser asks before leaving the page meanwhile
	await els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Lantern Hours', 'Tidewater']);
	assert.deepEqual((await kept(storage)).books.map(b => b.t), ['Lantern Hours', 'Tidewater']);
	assert.equal(get("CATALOG.books[0].idOn('hardcover')"), '80', 'the Hardcover ids found are kept');
	assert.deepEqual(state.shelf.at(-1), { id: 102, book_id: 80, edition_id: 801, status_id: 3, user_book_reads: [{ finished_at: '2024-05-01', edition_id: 801 }] });
	assert.ok(leaving.prevented, 'leaving during the run is asked about');
	const after = { preventDefault() { this.prevented = true; } };
	page.fire('beforeunload', after);
	assert.ok(!after.prevented, 'not once it is done');
	assert.match(els.importPreviewBody.innerHTML, /put 1 book\(s\) on your Hardcover Read shelf and added 1 read\(s\)/);
	assert.match(els.ioStatus.textContent, /Sync with Hardcover: done\./);
	assert.ok(!JSON.stringify(get('CATALOG.books')).includes('tok-123') && ![...storage.entries()].some(([k, v]) => k !== 'audiobook-catalog-hardcover-token' && v.includes('tok-123')));
});

test('a Hardcover run in the page writes and sends nothing when the catalog is edited meanwhile, or Hardcover cannot be reached', async () => {
	const mine = [{ t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ ext: { 'audible.com': 'B0LANTERN1' } }] }];
	const state = hardcoverState();
	const hc = fakeHardcover(state);
	let edit = false;
	const hardcover = async (url, init) => {
		if (edit && JSON.parse(init.body).query.startsWith('query Find')) { edit = false; page.run("CATALOG.books[0].genres = ['Fantasy']"); }
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
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /the catalog was edited while this ran .*nothing written, nothing sent to Hardcover/);
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));
	assert.equal(get("CATALOG.books[0].idOn('hardcover') || null"), null);
	assert.match(els.ioStatus.textContent, /Not everything went through/);

	const offline = await boot({ page: 'import.html', files: { 'books.json': JSON.stringify(mine) }, setTimeout, storage });
	await offline.els.hardcoverImportBtn.listeners.click[0]();
	await idle();
	assert.match(offline.els.importPreviewBody.innerHTML, /this browser could not reach Hardcover \(offline/);
	assert.equal(offline.els.importConfirm.style.display, 'none');
});

// ------------------------------------------------------------------ the authors page
test('the authors page lists every author, with their books and series, and a search narrows it', async () => {
	const { els, readable } = await boot({ page: 'authors.html' });
	const authors = new Set(demoBooks.flatMap(b => b.a));
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, authors.size);
	assert.match(els.subtitle.textContent, new RegExp(`^${authors.size} authors across ${demoBooks.length} audiobooks`));
	assert.match(readable(els.creditBody.innerHTML), /<a class="srow-title" href="authors\.html#a=Priya\+Ostrander">Priya Ostrander<\/a>\s*<span class="srow-owned">3 books, 1 series<\/span>/);
	// the first line of a bio, when there is one
	assert.match(readable(els.creditBody.innerHTML), /Priya Ostrander writes cozy mysteries/);
	assert.ok(!els.crumb.classList.contains('show'));
	els.q.value = 'ferran';
	els.q.listeners.input[0]();
	await idle();
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, 1);
	els.q.value = 'zzzz';
	els.q.listeners.input[0]();
	await idle();
	assert.match(readable(els.creditBody.innerHTML), /No authors match/);
});

test('an author\'s page shows their bio, their links, and their series and titles from the catalog', async () => {
	const { ctx, els, fire, readable } = await boot({ page: 'authors.html', hash: '#a=Marisol+Quenby' });
	const html = readable(els.creditBody.innerHTML);
	assert.equal(ctx.document.title, 'Marisol Quenby · Audiobook Catalog');
	assert.ok(els.crumb.classList.contains('show'));
	assert.equal(els.creditControls.style.display, 'none');
	assert.match(html, /<h2 class="author-name">Marisol Quenby<\/h2>/);
	assert.match(html, /<div class="author-bio"><p>Marisol Quenby writes seafaring fantasy[^<]*<\/p><p>The Lantern Coast began/);
	for (const [label, url] of [['Website', 'https://example.com/'], ['Audible', 'https://www.audible.com/author/'], ['Goodreads', 'https://www.goodreads.com/author/show/'], ['Hardcover', 'https://hardcover.app/authors/']]) {
		assert.match(html, new RegExp(`<a class="authorlink" href="${url.replace(/[./]/g, '\\$&')}[^"]*" target="_blank" rel="noopener">${label} ↗</a>`));
	}
	// the series, with how many are owned of the released total, its books in order, each a link to it in the catalog
	assert.match(html, /<a href="index\.html#series=The\+Lantern\+Coast">The Lantern Coast<\/a> <span class="n">4 owned of 5<\/span> <span class="status ongoing">ongoing<\/span>/);
	assert.match(html, /#1<\/span> <a href="index\.html#book=The\+Salt\+Road">The Salt Road<\/a><\/li><li>.*#2<\/span> <a href="index\.html#book=Beacons\+at\+Low\+Tide">/);
	assert.equal(els.subtitle.textContent, '4 audiobooks in 1 series');

	// another author's page, by its address: her series, and a book outside it she wrote with someone else
	ctx.location.hash = '#a=Priya+Ostrander';
	fire('hashchange');
	await idle();
	const priya = readable(els.creditBody.innerHTML);
	assert.match(priya, /Halloway &amp; Finch<\/a> <span class="n">2 owned of 2<\/span> <span class="status complete">/);
	assert.match(priya, /Outside a series <span class="n">1 book<\/span>/);
	assert.match(priya, /Nine Ways to Lose a Kingdom<\/a> <span class="with">with <a href="authors\.html#a=Ferran\+Doyle">Ferran Doyle<\/a><\/span>/);
	assert.equal(els.subtitle.textContent, '3 audiobooks in 1 series and 1 outside a series');

	// an author without info or series
	ctx.location.hash = '#a=Odalys+Rennick';
	fire('hashchange');
	await idle();
	assert.match(readable(els.creditBody.innerHTML), /No bio or links yet/);
	assert.match(readable(els.creditBody.innerHTML), /Titles <span class="n">1 book<\/span>/);
	ctx.location.hash = '#a=Nobody+Here';
	fire('hashchange');
	await idle();
	assert.equal(els.subtitle.textContent, 'No books by this author in the catalog.');
	ctx.location.hash = '';
	fire('hashchange');
	await idle();
	assert.equal(ctx.SHOWN, null);
	assert.match(readable(els.creditBody.innerHTML), /class="srow-title"/);
});

// ------------------------------------------------------------------ the narrators and publishers pages
test('the narrators page lists every narrator of the editions, with their bio or the authors they read, and a search narrows it', async () => {
	const { ctx, els, readable } = await boot({ page: 'narrators.html' });
	const narrators = new Set(demoBooks.flatMap(b => (b.e || []).flatMap(ed => ed.n || [])));
	assert.equal(ctx.document.title, 'Narrators · Audiobook Catalog');
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, narrators.size);
	assert.match(els.subtitle.textContent, new RegExp(`^${narrators.size} narrators across ${demoBooks.length} audiobooks`));
	assert.match(readable(els.creditBody.innerHTML), /<a class="srow-title" href="narrators\.html#n=Ingrid\+Voss">Ingrid Voss<\/a>\s*<span class="srow-owned">5 books, 1 series<\/span><\/div><p class="srow-note">Ingrid Voss narrates fantasy/, 'the first line of a bio, when there is one');
	// else the authors they read most, the most first
	assert.match(readable(els.creditBody.innerHTML), /Dana Whitlock<\/a>\s*<span class="srow-owned">2 books, 1 series<\/span><\/div><p class="srow-note">Books by Priya Ostrander<\/p>/);
	els.q.value = 'tobias';
	els.q.listeners.input[0]();
	await idle();
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, 1);
	els.q.value = 'zzzz';
	els.q.listeners.input[0]();
	await idle();
	assert.match(readable(els.creditBody.innerHTML), /No narrators match/);
});

test('a narrator\'s page shows the series and titles they read, with their authors and the other narrators', async () => {
	const books = JSON.stringify([
		{ t: 'Tide One', a: ['Ann Vale'], s: 'Tide Saga', sn: '1', e: [{ n: ['Cy Hale', 'Di Moss'] }] },
		{ t: 'Tide Two', a: ['Ann Vale'], s: 'Tide Saga', sn: '2', e: [{ n: ['Cy Hale'] }, { n: ['Ed Lund'] }] },
		{ t: 'Apple Hill', a: ['Bo Reed', 'Ann Vale'], e: [{ n: ['Cy Hale'], p: 'Gull Audio' }] },
	]);
	const { ctx, els, fire, readable } = await boot({ page: 'narrators.html', hash: '#n=Cy+Hale', files: { 'books.json': books } });
	const html = readable(els.creditBody.innerHTML);
	assert.equal(ctx.document.title, 'Cy Hale · Audiobook Catalog');
	assert.ok(els.crumb.classList.contains('show'));
	assert.equal(els.creditControls.style.display, 'none');
	assert.equal(els.subtitle.textContent, '3 audiobooks in 1 series and 1 outside a series');
	assert.match(html, /<h2 class="author-name">Cy Hale<\/h2>/);
	assert.match(html, /<a href="index\.html#series=Tide\+Saga">Tide Saga<\/a> <span class="n">2 books<\/span>/);
	// who else reads the editions Cy Hale reads, not the other editions
	assert.match(html, /Tide One<\/a> <span class="with">by <a href="authors\.html#a=Ann\+Vale">Ann Vale<\/a><\/span> <span class="with">with <a href="narrators\.html#n=Di\+Moss">Di Moss<\/a><\/span><\/li>/);
	assert.match(html, /Tide Two<\/a> <span class="with">by <a [^>]*>Ann Vale<\/a><\/span><\/li>/);
	assert.match(html, /Outside a series <span class="n">1 book<\/span>.*Apple Hill<\/a> <span class="with">by <a [^>]*>Bo Reed<\/a>, <a [^>]*>Ann Vale<\/a>/);
	ctx.location.hash = '#n=Nobody+Here';
	fire('hashchange');
	await idle();
	assert.equal(els.subtitle.textContent, 'No books narrated by them in the catalog.');
	ctx.location.hash = '';
	fire('hashchange');
	await idle();
	assert.equal(ctx.SHOWN, null);
	assert.match(readable(els.creditBody.innerHTML), /class="srow-title"/);
});

test('the publishers page lists the editions\' publishers, and a publisher\'s page their books', async () => {
	const { ctx, els, fire, readable } = await boot({ page: 'publishers.html' });
	assert.equal(ctx.document.title, 'Publishers · Audiobook Catalog');
	assert.match(els.subtitle.textContent, new RegExp(`^3 publishers across ${demoBooks.length} audiobooks`));
	assert.match(readable(els.creditBody.innerHTML), /<a class="srow-title" href="publishers\.html#p=Kestrel\+Row\+Audio">Kestrel Row Audio<\/a>\s*<span class="srow-owned">3 books, 1 series<\/span>/);
	ctx.location.hash = '#p=Kestrel+Row+Audio';
	fire('hashchange');
	await idle();
	assert.equal(els.subtitle.textContent, '3 audiobooks in 1 series');
	assert.match(readable(els.creditBody.innerHTML), /The Orchard Cycle<\/a> <span class="n">3 books<\/span>/);
	assert.doesNotMatch(readable(els.creditBody.innerHTML), /class="with">with/, 'a publisher\'s page names no other publishers');
});

test('the narrators and publishers on a book card link to their pages', async () => {
	const { ctx, els, readable } = await boot();
	ctx.setView('library');
	await idle();
	assert.match(readable(els.results.innerHTML), /narr\. <a href="narrators\.html#n=Ingrid\+Voss">Ingrid Voss<\/a>/);
	assert.match(readable(els.results.innerHTML), /Publisher <a href="publishers\.html#p=Kestrel\+Row\+Audio">Kestrel Row Audio<\/a>/);
});

test('author info can be added, edited and removed on the author\'s page, and links are checked', async () => {
	const { els, get, storage } = await boot({ page: 'authors.html', hash: '#a=Wendell+Ashcombe' });
	const editClick = () => els.creditBody.querySelector('.aedit').listeners.click[0]();
	const submit = () => els.creditForm.listeners.submit[0]({ preventDefault() {} });
	editClick();
	assert.ok(els.creditForm.classList.contains('open'));
	assert.equal(els.creditFormTitle.textContent, 'Add author info: Wendell Ashcombe');
	assert.equal(els.creditRemoveBtn.style.display, 'none');
	els.cf_bio.value = '  Builds   clockwork worlds.\n\nLives by a canal. ';
	els.cf_url.value = 'wendell.example';
	submit();
	assert.match(els.creditFormError.textContent, /'url' must be a web address/);
	els.cf_url.value = 'https://wendell.example/';
	els.cf_ext_goodreads.value = 'https://hardcover.app/authors/wendell';   // pasted into the wrong field
	submit();
	assert.equal(els.creditFormError.textContent, 'Not an id or address there: Goodreads: https://hardcover.app/authors/wendell.');
	assert.equal(get("CATALOG.infoByName('authors').get('Wendell Ashcombe') || null"), null);
	els.cf_ext_goodreads.value = '';
	// an address gives the id; an Audible address names its site
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/wendell';
	els.cf_ext_audible.value = 'https://www.audible.co.uk/author/Wendell-Ashcombe/B0WENDELL1?ref=x';
	await submit();
	assert.ok(!els.creditForm.classList.contains('open'));
	const entry = { bio: 'Builds clockwork worlds.\n\nLives by a canal.', url: 'https://wendell.example/', ext: { 'audible.co.uk': 'B0WENDELL1', hardcover: 'wendell' } };
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe')"), entry);
	assert.match(els.creditBody.innerHTML, /<p>Builds clockwork worlds\.<\/p><p>Lives by a canal\.<\/p>/);
	assert.match(els.creditBody.innerHTML, /<a class="authorlink" href="https:\/\/www\.audible\.co\.uk\/author\/B0WENDELL1" target="_blank" rel="noopener">Audible \(audible\.co\.uk\) ↗<\/a> <a class="authorlink" href="https:\/\/hardcover\.app\/authors\/wendell" target="_blank" rel="noopener">Hardcover ↗<\/a>/);
	assert.match(els.ioStatus.textContent, /^Saved author info for Wendell Ashcombe\. Kept Hardcover's author by the name in its address/);
	// kept in this browser, and loaded again with the page
	assert.deepEqual((await kept(storage)).authors['Wendell Ashcombe'], entry);
	const again = await boot({ page: 'authors.html', hash: '#a=Wendell+Ashcombe', storage });
	assert.deepEqual(again.get("CATALOG.infoByName('authors').get('Wendell Ashcombe')"), entry);

	// editing shows what is there; emptying every field, or Remove, removes the entry
	editClick();
	assert.equal(els.creditFormTitle.textContent, 'Author info: Wendell Ashcombe');
	assert.equal(els.cf_ext_hardcover.value, 'wendell');
	assert.equal(els.cf_ext_audible.value, 'https://www.audible.co.uk/author/B0WENDELL1', 'the address, so the site is kept');
	assert.equal(els.creditRemoveBtn.style.display, '');
	els.creditRemoveBtn.listeners.click[0]();
	await idle();
	assert.equal(get("CATALOG.infoByName('authors').get('Wendell Ashcombe') || null"), null);
	assert.match(els.ioStatus.textContent, /Removed author info for Wendell Ashcombe/);
	assert.ok((await kept(storage)).authors['Marisol Quenby'], 'the other authors keep theirs');
});

test('a Hardcover address in the series or info form is looked up for its number, and kept as it is when Hardcover can\'t be asked', async () => {
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn, ms) => { if (ms === 1000) Promise.resolve().then(fn); return 0; };   // the pause between requests
	const storage = new Map([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const { els, get } = await boot({ page: 'authors.html', hash: '#a=Wendell+Ashcombe', hardcover: hc.fetch, setTimeout, storage });
	const edit = () => els.creditBody.querySelector('.aedit').listeners.click[0]();
	const submit = () => els.creditForm.listeners.submit[0]({ preventDefault() {} });
	edit();
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/wendell-ashcombe/books';
	await submit();
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), { hardcover: '4101' });
	assert.equal(els.ioStatus.textContent, 'Saved author info for Wendell Ashcombe. Found on Hardcover: Wendell Ashcombe (author 4101).');
	assert.match(els.creditBody.innerHTML, /<a class="authorlink" href="https:\/\/hardcover\.app\/id\/author\/4101" target="_blank" rel="noopener">Hardcover ↗<\/a>/);
	assert.deepEqual(hc.sent.at(-1).variables, { slug: 'wendell-ashcombe' });

	// as soon as the field is left; one merged into another is that one
	edit();
	els.cf_ext_hardcover.value = 'w-ashcombe';
	await els.cf_ext_hardcover.listeners.change[0]();
	await idle();
	assert.equal(els.cf_ext_hardcover.value, '4101');
	// a number, or an address by number, is not looked up
	const asked = hc.sent.length;
	els.cf_ext_hardcover.value = 'https://hardcover.app/id/authors/4102';
	await submit();
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), { hardcover: '4102' });
	assert.equal(hc.sent.length, asked);

	// a name Hardcover has no page for is refused
	edit();
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/nobody-here';
	await submit();
	assert.equal(els.creditFormError.textContent, 'Hardcover has no author at https://hardcover.app/authors/nobody-here.');
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), { hardcover: '4102' });
	// when Hardcover can't be asked, the name in the address is kept, and still links to its page
	storage.set('audiobook-catalog-hardcover-token', 'expired');
	await submit();
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), { hardcover: 'nobody-here' });
	assert.match(els.ioStatus.textContent, /Kept Hardcover's author by the name in its address, as Hardcover couldn't be asked for its number \(Hardcover refused your token/);
	assert.match(els.creditBody.innerHTML, /href="https:\/\/hardcover\.app\/authors\/nobody-here"/);

	// a series' and a publisher's likewise
	storage.set('audiobook-catalog-hardcover-token', 'tok-123');
	const index = await boot({ hardcover: hc.fetch, setTimeout, storage });
	index.ctx.openSeriesForm(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	index.els.sf_ext_hardcover.value = 'hardcover.app/series/the-lantern-coast';
	await index.els.seriesForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.equal(index.get("CATALOG.infoByName('series').get('The Lantern Coast').external.hardcover"), '3101');
	const pub = await boot({ page: 'publishers.html', hash: '#p=Kestrel+Row+Audio', hardcover: hc.fetch, setTimeout, storage });
	pub.els.creditBody.querySelector('.aedit').listeners.click[0]();
	await idle();
	assert.equal(pub.els.cf_ext_hardcover.value, 'kestrel-row-audio-sample', 'a name kept before stays until the form is saved');
	pub.els.cf_ext_hardcover.value = 'kestrel-row-audio';
	await pub.els.creditForm.listeners.submit[0]({ preventDefault() {} });
	await idle();
	assert.equal(pub.get("CATALOG.infoByName('publishers').get('Kestrel Row Audio').external.hardcover"), '5101');
});

test('narrator and publisher info can be added on their pages, with links checked', async () => {
	const { els, get, storage } = await boot({ page: 'narrators.html', hash: '#n=Tobias+Frane' });
	const submit = () => els.creditForm.listeners.submit[0]({ preventDefault() {} });
	assert.match(els.creditBody.innerHTML, /No bio or links yet/);
	els.creditBody.querySelector('.aedit').listeners.click[0]();
	await idle();
	assert.equal(els.creditFormTitle.textContent, 'Add narrator info: Tobias Frane');
	assert.equal(els.creditSaveBtn.textContent, 'Save narrator info');
	els.cf_bio.value = 'Reads sea stories.';
	els.cf_ext_audible.value = 'https://www.goodreads.com/author/show/1.Tobias';
	submit();
	assert.match(els.creditFormError.textContent, /Not an id or address there: Audible: https:\/\/www\.goodreads\.com/);
	els.cf_ext_audible.value = 'https://www.audible.com/search?searchNarrator=Tobias+Frane';
	submit();
	assert.deepEqual(get("CATALOG.infoByName('narrators').get('Tobias Frane')"), { bio: 'Reads sea stories.', ext: { 'audible.com': 'Tobias Frane' } });
	assert.deepEqual((await kept(storage)).narrators['Tobias Frane'], { bio: 'Reads sea stories.', ext: { 'audible.com': 'Tobias Frane' } });
	assert.match(els.creditBody.innerHTML, /<div class="author-bio"><p>Reads sea stories\.<\/p><\/div><p class="author-links"><a class="authorlink" href="https:\/\/www\.audible\.com\/search\?searchNarrator=Tobias%20Frane" target="_blank" rel="noopener">Audible ↗<\/a><\/p>/);
	assert.equal(els.ioStatus.textContent, 'Saved narrator info for Tobias Frane.');

	// a publisher's page shows what the demo data keeps about it
	const pub = await boot({ page: 'publishers.html', hash: '#p=Kestrel+Row+Audio' });
	assert.match(pub.els.creditBody.innerHTML, /Kestrel Row Audio is a small audiobook studio/);
	assert.match(pub.els.creditBody.innerHTML, /<a class="authorlink" href="https:\/\/hardcover\.app\/publishers\/[^"]*" target="_blank" rel="noopener">Hardcover ↗<\/a>/);
	assert.equal(pub.els.cf_ext_hardcover.getAttribute('placeholder'), 'id, or its address on hardcover.app');
	assert.ok(!pub.els.cf_ext.innerHTML.includes('cf_ext_goodreads'), 'Goodreads has no publisher pages');
});

test('Check on the import page lists problems; a catalog in an older format is kept in the current one at once', async () => {
	const mine = JSON.stringify([{ t: 'Old Favorite', a: 'Ann Vale', id: 'B0OLD00001' }]);
	const info = JSON.stringify({ Nowhere: { total: 3, status: 'ongoing' } });
	const { els, storage } = await boot({ page: 'import.html', files: { 'books.json': mine, 'series-info.json': info } });
	// moving it to IndexedDB wrote it the current way
	assert.deepEqual((await kept(storage)).books, [{ t: 'Old Favorite', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'B0OLD00001' } }] }]);
	els.checkBtn.listeners.click[0]();
	await idle();
	const report = els.importPreviewBody.innerHTML;
	assert.match(report, /1 books, 0 series, 1 with release info, 0 authors, 0 narrators, 0 publishers with info/);
	assert.match(report, /Errors \(1\):.*'Nowhere' matches no series/s);
	assert.equal(els.importConfirm.style.display, 'none');
	assert.equal(els.importCancel.textContent, 'Close');
});

test('Box sets on the import page adds a set beside the titles sharing its edition, once confirmed', async () => {
	const set = { ext: { 'audible.com': 'B0SET00001' } };
	const mine = JSON.stringify([
		{ t: 'Gull Isle', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [set] },
		{ t: 'Second Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [set] },
	]);
	const { els, get } = await boot({ page: 'import.html', files: { 'books.json': mine } });
	els.boxSetsBtn.listeners.click[0]();
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /Gull Isle, Books 1-2 — Ann Vale: 2 titles already here/);
	assert.match(els.importPreviewBody.innerHTML, /New: 1/);
	assert.equal(get('CATALOG.books.length'), 2, 'nothing changes before it is confirmed');
	assert.equal(els.importConfirm.textContent, 'Add 1 book');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books[2]'), { t: 'Gull Isle, Books 1-2', a: ['Ann Vale'], s: 'Gull Isle', sn: '1-2', e: [set] });
	assert.match(els.ioStatus.textContent, /Added 1 book for box sets/);
	els.boxSetsBtn.listeners.click[0]();
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /already kept both as its own book and as its titles/);
	assert.equal(els.importConfirm.style.display, 'none');
});


test('Series info without note should not be rendered as "undefined"', async() => {
	const mine = JSON.stringify([{ t: 'Lol', a: ['Jonathan Smith'], s: 'Pop', sn: '1', e: [{'n':'Michel Reed'}] }]);
	const info = JSON.stringify({ 'Pop': { total: 5, status: 'ongoing' }});
	const { els, storage } = await boot({ files: { 'books.json': mine, 'series-info.json': info } });
	assert.doesNotMatch(els.results.innerHTML, /undefined/);
});

test('a browser that prefers British English sees "catalogue"; any other sees "catalog", and the data is never respelled', async () => {
	const titled = JSON.stringify([{ t: 'The Catalog of Stars', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'B1' } }] }]);
	for (const page of PAGES) {
		const { ctx } = await boot({ page, languages: ['sv-SE', 'en-GB'], files: { 'books.json': titled } });
		await idle();
		assert.match(ctx.document.title, /Audiobook Catalogue$/, page);
		// (the body holds what the page drew too; the Hardcover scope read:catalog is a name, and stays)
		assert.ok(!/(?<!:)\b[Cc]atalog\b/.test(ctx.document.body.innerHTML), `${page} has no American spelling left`);
		assert.match(ctx.document.body.innerHTML, /<h1>Audiobook Catalogue<\/h1>/, page);
	}
	const uk = await boot({ page: 'import.html', languages: ['en-AU'], files: { 'books.json': titled } });
	await idle();
	assert.equal(uk.els.subtitle.textContent, '1 audiobooks in the catalogue');
	const app = await boot({ languages: ['en-GB'], files: { 'books.json': titled } });
	app.ctx.setView('library');
	await idle();
	assert.match(app.els.results.innerHTML, /The Catalog of Stars/);
	assert.equal(app.ctx.document.title, 'All books — Audiobook Catalogue');

	const us = await boot({ page: 'import.html', languages: ['fr-FR', 'fr'], files: { 'books.json': titled } });
	await idle();
	assert.equal(us.els.subtitle.textContent, '1 audiobooks in the catalog');
	assert.match(us.ctx.document.title, /Audiobook Catalog$/);
	assert.match(us.ctx.document.body.innerHTML, /<h1>Audiobook Catalog<\/h1>/);
});

// ------------------------------------------------------------------ a page holds only what it shows
const SAGAS = JSON.stringify([
	...['1', '2', '3'].map(n => ({ t: `Gull ${n}`, a: ['Ann Vale'], s: 'Gull Isle', sn: n, e: [{ n: ['Cy Hale'] }] })),
	...['1', '2', '3', '4', '5'].map(n => ({ t: `Fern ${n}`, a: ['Bo Reed'], s: 'Fern Saga', sn: n })),
]);
// A browser that has the catalog in IndexedDB already, and a page booted on it that has read nothing yet.
async function movedIn(files, options = {}) {
	const storage = new Map();
	await boot({ storage, files });
	await kept(storage);
	databaseOf(storage).resetReads();
	return boot({ storage, files: null, ...options });
}

test('the series overview reads no book, and a series page only the books of that series', async () => {
	const { ctx, get, database } = await movedIn({ 'books.json': SAGAS });
	await idle();
	assert.match(ctx.document.getElementById('results').innerHTML, /Gull Isle/);
	assert.equal(database.reads('books'), 0, 'the overview is drawn from the series records');
	assert.equal(get('CATALOG.books.length'), 0);
	ctx.openSeries(seriesIdOf(get, 'Gull Isle'));
	await idle();
	assert.equal(database.reads('books'), 3);
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Gull 1', 'Gull 2', 'Gull 3']);
});

test('all books shows 50 at a time, and Show more reads the next ones', async () => {
	const books = Array.from({ length: 60 }, (_, i) => ({ t: `Pebble ${String(i + 1).padStart(2, '0')}`, a: ['Ann Vale'] }));
	const { ctx, els, get, database } = await movedIn({ 'books.json': JSON.stringify(books) });
	ctx.setView('library');
	await idle();
	assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 50);
	assert.equal(els.resultCount.textContent, '50 of 60 shown');
	assert.equal(get('CATALOG.books.length'), 50, 'the page holds only the books it shows');
	assert.equal(database.reads('books'), 50);
	const more = els.results.querySelector('#showMore');
	assert.equal(more.textContent, 'Show 10 more');
	more.dispatch('click');
	await idle();
	assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 60);
	assert.equal(els.resultCount.textContent, '60 shown');
	assert.equal(els.results.querySelector('#showMore'), null);
	assert.equal(database.reads('books'), 60, 'only the books not read yet');
});

test('an edit on a page that holds some books keeps every other record, and the counts follow', async () => {
	const { ctx, els, get, storage, database } = await movedIn({ 'books.json': SAGAS });
	ctx.openSeries(seriesIdOf(get, 'Gull Isle'));
	await idle();
	ctx.openEditForm(bookIdOf(get, 'Gull 3'));
	els.f_s.value = 'Fern Saga';
	els.f_sn.value = '6';
	els.addForm.listeners.submit[0]({ preventDefault() {}, target: els.addForm });
	await idle();
	const books = (await kept(storage)).books;
	assert.equal(books.length, 8);
	assert.deepEqual(books.find(b => b.t === 'Fern 4'), { t: 'Fern 4', a: ['Bo Reed'], s: 'Fern Saga', sn: '4' }, 'a book the page never read');
	assert.deepEqual(books.find(b => b.t === 'Gull 3').s, 'Fern Saga');
	const count = store => Object.fromEntries(database.records(store).map(x => [x.name, [x.bookCount, x.seriesCount]]));
	assert.deepEqual(count('series'), { 'Fern Saga': [6, undefined], 'Gull Isle': [2, undefined] });
	assert.deepEqual(count('contributors'), { 'Ann Vale': [3, 2], 'Bo Reed': [5, 1], 'Cy Hale': [3, 2] });
	assert.equal(database.records('credits').length, 8 + 3);

	// removing the last books of a series drops it, and a person left without books
	for (const title of ['Gull 1', 'Gull 2']) {
		const btn = els.results.querySelector(`.iconbtn.del[data-id="${bookIdOf(get, title)}"]`);
		btn.dispatch('click');
		btn.dispatch('click');
		await idle();
	}
	assert.deepEqual(count('series'), { 'Fern Saga': [6, undefined] });
	assert.deepEqual(count('contributors'), { 'Ann Vale': [1, 1], 'Bo Reed': [5, 1], 'Cy Hale': [1, 1] });
	assert.equal((await kept(storage)).books.length, 6);
});

test('the Duplicates count is kept with the revision it was counted at, and counted again once the catalog changed', async () => {
	const books = JSON.stringify([{ t: 'Ledger', a: ['Priya Ostrander'] }, { t: 'Ledger', a: ['Priya Ostrander'], r: ['2024'] }, { t: 'Other', a: ['Ann Vale'] }]);
	const { els, run, storage, database } = await movedIn({ 'books.json': books });
	await idle();
	assert.equal(els.dupCount.textContent, ' (1)');
	assert.equal(database.reads('books'), 0, 'the count kept is shown without reading the books');
	const revision = () => database.records('meta').find(m => m.key === 'revision').value;
	assert.equal(database.records('meta').find(m => m.key === 'duplicates').revision, revision());

	// a page holding the whole catalog keeps the count with each save; one that holds some counts it after
	const dup = await boot({ page: 'duplicates.html', storage });
	await dup.run("CATALOG.books.push(new Book({ title: 'Other', authors: ['Ann Vale'] })); persist();");
	assert.deepEqual(database.records('meta').find(m => m.key === 'duplicates'), { key: 'duplicates', value: 2, revision: revision() });
	await run('updateNav()');
	await idle();
	assert.equal(els.dupCount.textContent, ' (2)');
	// a page that holds some books counts again after its save, reading every book, and keeps the count
	const home = await boot({ storage });
	home.ctx.setView('library');
	await idle();
	database.resetReads();
	await home.run("CATALOG.books.push(new Book({ title: 'Ledger', authors: ['Ann Vale'] }), new Book({ title: 'Ledger', authors: ['Ann Vale'] })); persist();");
	await idle();
	assert.equal(home.els.dupCount.textContent, ' (3)');
	assert.ok(database.reads('books') >= 6, 'every book was read to count them');
	assert.deepEqual(database.records('meta').find(m => m.key === 'duplicates'), { key: 'duplicates', value: 3, revision: revision() });
	database.resetReads();
	const next = await boot({ storage });
	await idle();
	assert.equal(next.els.dupCount.textContent, ' (3)');
	assert.equal(database.reads('books'), 0);
});

test('the authors list reads no book, and an author\'s page only their books', async () => {
	const { els, fire, ctx, database, readable } = await movedIn({ 'books.json': SAGAS }, { page: 'authors.html' });
	await idle();
	assert.match(readable(els.creditBody.innerHTML), /Ann Vale<\/a>\s*<span class="srow-owned">3 books, 1 series<\/span>/);
	assert.equal(els.subtitle.textContent, '2 authors across 8 audiobooks');
	assert.equal(database.reads('books'), 0);
	ctx.location.hash = '#a=Bo+Reed';
	fire('hashchange');
	await idle();
	assert.equal(els.subtitle.textContent, '5 audiobooks in 1 series');
	assert.equal(database.reads('books'), 5);
});
