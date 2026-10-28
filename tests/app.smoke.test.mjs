// Smoke test for the browser app. Runs the real pages (index.html + series.js, and the modules it imports, ...) in
// Node against a tiny fake DOM and a fake localStorage holding the demo data, so it needs no dependencies
// and no browser. The modules run as ES modules in node:vm, which needs --experimental-vm-modules.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fakeHardcover, hardcoverState} from './fake-hardcover.mjs';
import {fakeCatalogs, fakeProxyCatalogs, fakeAudiobookdb, audiobookdbState} from './fake-catalogs.mjs';
import {handle as handleProxy} from '../proxy/worker.js';
import {Book} from '../public/modules/book.js';
import {Exclusions} from '../public/modules/exclusions.js';
import {Duplicates} from '../public/modules/duplicates.js';
import {CatalogRecords} from '../public/modules/catalog-records.js';
import {Catalog} from '../public/modules/catalog.js';
import {FakeIndexedDB, FakeKeyRange} from './fake-indexeddb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The app is the public/ folder, what a static server serves; the demo data stays outside it.
const site = path.join(root, 'public');
const read = file => fs.readFileSync(path.join(site, file), 'utf8');
// the pages in the nav bar, and the pages they link to: a book's (book.html), an author's, a narrator's and a publisher's
const PAGES = [
	'index.html',
	'books.html',
	'import.html',
	'duplicates.html',
	'authors.html',
	'narrators.html',
	'publishers.html',
	'stats.html',
];
const ALL_PAGES = [...PAGES, 'book.html', 'author.html', 'narrator.html', 'publisher.html'];
// someone's page shows the one its address names; without one it goes to the list
const PAGE_HASH = {'author.html': '#a=Ann+Vale', 'narrator.html': '#n=Cy+Hale', 'publisher.html': '#p=Tern+Press'};
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
	if (!vm.SourceTextModule)
		throw new Error('the smoke test needs node --experimental-vm-modules (make test passes it)');
	const modules = new Map();
	const load = file => {
		if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(read(file), {context, identifier: file}));
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
const VOID = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'source',
	'track',
	'wbr',
]);
const ENTITIES = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	hellip: '…',
	larr: '←',
	rarr: '→',
	times: '×',
	mdash: '—',
	ndash: '–',
	middot: '·',
	bull: '•',
	check: '✓',
};
const decode = text =>
	text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
		if (e[0] === '#')
			return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
		if (!(e in ENTITIES)) throw new Error(`the fake DOM doesn't know ${m}`);
		return ENTITIES[e];
	});
const escText = text =>
	text
		.replace(/&/g, '&amp;')
		.replace(/\u00A0/g, '&nbsp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
const escAttr = text =>
	text
		.replace(/&/g, '&amp;')
		.replace(/\u00A0/g, '&nbsp;')
		.replace(/"/g, '&quot;');
const dataName = key => 'data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

class FakeText {
	constructor(text) {
		this.nodeType = 3;
		this.nodeValue = String(text);
		this.parentNode = null;
	}
	get textContent() {
		return this.nodeValue;
	}
	set textContent(text) {
		this.nodeValue = String(text);
	}
	get outerHTML() {
		return escText(this.nodeValue);
	}
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
		this.dataset = new Proxy(
			{},
			{
				get: (t, key) =>
					typeof key === 'string' && el.hasAttribute(dataName(key))
						? el.getAttribute(dataName(key))
						: undefined,
				set: (t, key, value) => {
					el.setAttribute(dataName(key), value);
					return true;
				},
				has: (t, key) => el.hasAttribute(dataName(key)),
			},
		);
		const classes = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
		const setClasses = list => el.setAttribute('class', list.join(' '));
		this.classList = {
			contains: c => classes().includes(c),
			add: c => {
				if (!classes().includes(c)) setClasses([...classes(), c]);
			},
			remove: c => setClasses(classes().filter(x => x !== c)),
			toggle(c, force) {
				const on = force === undefined ? !this.contains(c) : !!force;
				on ? this.add(c) : this.remove(c);
				return on;
			},
		};
	}
	get id() {
		return this.getAttribute('id') || '';
	}
	set id(v) {
		this.setAttribute('id', v);
	}
	get className() {
		return this.getAttribute('class') || '';
	}
	set className(v) {
		this.setAttribute('class', v);
	}
	get title() {
		return this.getAttribute('title') || '';
	}
	set title(v) {
		this.setAttribute('title', v);
	}
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}
	hasAttribute(name) {
		return this.attributes.has(name);
	}
	removeAttribute(name) {
		this.attributes.delete(name);
	}
	append(...nodes) {
		for (const node of nodes) {
			const child = typeof node === 'string' ? new FakeText(node) : node;
			if (child.parentNode) child.parentNode.childNodes.splice(child.parentNode.childNodes.indexOf(child), 1);
			child.parentNode = this;
			this.childNodes.push(child);
		}
	}
	appendChild(node) {
		this.append(node);
		return node;
	}
	removeChild(node) {
		this.childNodes.splice(this.childNodes.indexOf(node), 1);
		node.parentNode = null;
		return node;
	}
	replaceChildren(...nodes) {
		this.childNodes.forEach(c => {
			c.parentNode = null;
		});
		this.childNodes = [];
		this.append(...nodes);
	}
	hasChildNodes() {
		return this.childNodes.length > 0;
	}
	get children() {
		return this.childNodes.filter(c => c.nodeType === 1);
	}
	get textContent() {
		return this.childNodes.map(c => c.textContent).join('');
	}
	set textContent(text) {
		this.replaceChildren(...(String(text) ? [String(text)] : []));
	}
	get innerHTML() {
		return this.childNodes.map(c => c.outerHTML).join('');
	}
	set innerHTML(html) {
		throw new Error(`the page set innerHTML of #${this.id}`);
	}
	get outerHTML() {
		const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
		return (
			`<${this.localName}${attrs}>` + (VOID.has(this.localName) ? '' : `${this.innerHTML}</${this.localName}>`)
		);
	}
	/** Elements below this one matching `selector` (simple selectors, or several separated by spaces for descendants). */
	querySelectorAll(selector) {
		const [first, ...rest] = selector.trim().split(/\s+/);
		const found = [];
		const walk = el =>
			el.children.forEach(c => {
				if (matches(c, first)) found.push(c);
				walk(c);
			});
		walk(this);
		return rest.length ? [...new Set(found.flatMap(el => el.querySelectorAll(rest.join(' '))))] : found;
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] || null;
	}
	closest(selector) {
		for (let el = this; el && el.nodeType === 1; el = el.parentNode) if (matches(el, selector)) return el;
		return null;
	}
	addEventListener(type, fn) {
		(this.listeners[type] ||= []).push(fn);
	}
	/** Run the listeners for `type` as a browser would for an event on this element. */
	dispatch(type, event = {}) {
		for (let el = this; el && el.nodeType === 1; el = el.parentNode) {
			(el.listeners[type] || []).forEach(fn =>
				fn({preventDefault() {}, ...event, target: this, currentTarget: el}),
			);
		}
	}
	reset() {}
	scrollIntoView() {}
	click() {}
	focus() {}
	// where an element was last moved to, as 'before <id>' or 'after <id>'
	before(node) {
		node.place = `before ${this.id}`;
	}
	after(node) {
		node.place = `after ${this.id}`;
	}
}

/** The page's <body>, parsed: tags, attributes, text and entities, as the pages write them. */
function parseBody(html) {
	const body = new FakeElement('body');
	const open = [body];
	const at = () => open[open.length - 1];
	const source = html.slice(html.indexOf('>', html.indexOf('<body')) + 1, html.indexOf('</body>'));
	for (const [, text, close, tag, attrs] of source.matchAll(
		/([^<]+)|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/gi,
	)) {
		if (text !== undefined) at().append(decode(text));
		else if (close) {
			if (at().localName !== close.toLowerCase()) throw new Error(`</${close}> closes <${at().localName}>`);
			open.pop();
		} else {
			const el = new FakeElement(tag);
			for (const [, name, value] of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g))
				el.setAttribute(name, decode(value ?? ''));
			at().append(el);
			if (!VOID.has(el.localName)) open.push(el);
		}
	}
	if (open.length !== 1) throw new Error(`<${at().localName}> is never closed`);
	return body;
}

const CATALOG_KEY = 'audiobook-catalog-device';
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
const DEMO = {
	'books.json': DEMO_BOOKS,
	'series-info.json': DEMO_INFO,
	'authors.json': DEMO_AUTHORS,
	'narrators.json': DEMO_NARRATORS,
	'publishers.json': DEMO_PUBLISHERS,
};
// The catalog in localStorage, made of data files ({'books.json': text, 'series-info.json': ..., 'excluded.txt': ...}) as written.
function stored(files) {
	const json = (name, empty) => JSON.parse(files[name] || empty);
	const catalog = {
		books: json('books.json', '[]'),
		seriesInfo: json('series-info.json', '{}'),
		authors: json('authors.json', '{}'),
		narrators: json('narrators.json', '{}'),
		publishers: json('publishers.json', '{}'),
		excluded: Exclusions.parse(files['excluded.txt'] || '').entries,
	};
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
	return JSON.parse(
		JSON.stringify(CatalogRecords.toCatalog(records), (k, v) => (k === 'uid' || k === 'ids' ? undefined : v)),
	);
}

/**
 * Load the page into a fresh fake browser. `storage` is a Map standing in for localStorage; unless it
 * holds a catalog already, the catalog is made of `files` (see stored(); default: the demo data), or
 * there is none when `files` is null.
 */
async function boot({
	page = 'index.html',
	files = DEMO,
	storage = new Map(),
	hash = '',
	setTimeout = () => 0,
	hardcover = null,
	catalogs = null,
	proxy = null,
	languages = ['en-US', 'en'],
	session = new Map(),
} = {}) {
	await settled(storage); // a page loaded after another saved reads what it saved
	if (files && !storage.has(CATALOG_KEY)) storage.set(CATALOG_KEY, stored(files));
	if (files && files['not-duplicates.txt'] && !storage.has(NOT_DUP_KEY)) {
		storage.set(NOT_DUP_KEY, JSON.stringify(Duplicates.parseMarks(files['not-duplicates.txt'])));
	}
	const html = read(page);
	const body = parseBody(html);
	// the page's elements by id, the ones the page makes (form fields drawn from code) included
	const byId = id => body.querySelectorAll('[id]').find(el => el.id === id) || null;
	const els = new Proxy({}, {get: (_, id) => (typeof id === 'string' ? byId(id) || undefined : undefined)});
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
	// this tab's sessionStorage: a Map too, which a page opened from this one is booted with
	const sessionStorage = {
		getItem: k => (session.has(k) ? session.get(k) : null),
		setItem: (k, v) => session.set(k, String(v)),
		removeItem: k => session.delete(k),
	};
	// The page asks nothing of the server it came from; only Hardcover, Open Library, Wikidata and the
	// catalog proxy (a workers.dev address), when a test gives a fake of them.
	const fetch = async (url, init = {}) => {
		if (url.startsWith('https://api.hardcover.app/')) {
			if (!hardcover) throw new TypeError('Failed to fetch');
			return hardcover(url, init);
		}
		if (/^https:\/\/(openlibrary\.org|www\.wikidata\.org)\//.test(url)) {
			if (!catalogs) throw new TypeError('Failed to fetch');
			return catalogs(url, init);
		}
		if (/^https:\/\/[^/]+\.workers\.dev\//.test(url)) {
			if (!proxy) throw new TypeError('Failed to fetch');
			return proxy(url, init);
		}
		throw new Error(`the page fetched ${url}`);
	};
	// Files picked in a fake <input type="file"> are {name, text}; reading one completes at once.
	class FileReader {
		readAsText(file) {
			this.onload({target: {result: file.text}});
		}
	}
	// The session history: `entries` of {hash, state}, `at` the current one; back() and forward() fire popstate.
	// a page sent elsewhere (location.replace) says where in `replaced`, one it opens (location.assign) in `assigned`
	const location = {
		href: page,
		hash,
		pathname: '/' + page,
		replaced: null,
		assigned: null,
		replace(url) {
			this.replaced = url;
		},
		assign(url) {
			this.assigned = url;
		},
	};
	const windowListeners = {};
	const fire = (type, event = {}) => (windowListeners[type] || []).forEach(fn => fn(event));
	const entries = [{hash, state: null}];
	let at = 0;
	const hashOf = url => (String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : '');
	const history = {
		entries,
		get state() {
			return entries[at].state;
		},
		get at() {
			return at;
		},
		pushState(state, title, url) {
			entries.splice(at + 1);
			entries.push({hash: hashOf(url), state});
			at++;
			location.hash = hashOf(url);
		},
		replaceState(state, title, url) {
			entries[at] = {hash: hashOf(url), state};
			location.hash = hashOf(url);
		},
		go(n) {
			at += n;
			location.hash = entries[at].hash;
			fire('popstate');
			fire('hashchange');
		},
		back() {
			this.go(-1);
		},
		forward() {
			this.go(1);
		},
	};
	const addEventListener = (type, fn) => (windowListeners[type] ||= []).push(fn);
	const navigator = {languages};
	const Node = {ELEMENT_NODE: 1, TEXT_NODE: 3};
	const database = databaseOf(storage);
	const crypto = {randomUUID: () => database.newId()};
	const context = vm.createContext({
		document,
		Node,
		navigator,
		localStorage,
		sessionStorage,
		indexedDB: database,
		IDBKeyRange: FakeKeyRange,
		structuredClone,
		crypto,
		fetch,
		FileReader,
		URL,
		URLSearchParams,
		location,
		history,
		addEventListener,
		console,
		setTimeout,
		clearTimeout() {},
		setInterval: () => 0,
		clearInterval() {},
	});
	const [entry] = entryOf(page);
	const namespaces = await runModules(entry, context);
	// What the modules export, live: CATALOG is whatever store.js holds now, and Book, Edition etc. the page's own classes.
	const exported = {};
	for (const [file, ns] of namespaces) {
		const names = Object.fromEntries(Object.keys(ns).map(k => [k, () => ns[k]]));
		for (const [name, value] of Object.entries(names)) {
			const set = () => {
				throw new TypeError(`${name} is a module's binding: only ${file} can assign it`);
			};
			Object.defineProperty(exported, name, {get: value, set, enumerable: true});
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
	const ctx = new Proxy(context, {get: (target, key) => (key in exported ? exported[key] : target[key])});
	// what the page saves, saved: persist() writes in the background
	const saved = () => run('whenSaved()');
	// The page's links, with the ids in them read as names (#a=id-4 -> #a=Priya+Ostrander, #book=id-11 -> #book=The+Ledger+...),
	// so a test can say which book, series or person a link is to.
	const readable = html => {
		// by what this browser stores, and what the page holds (a book it added and has not saved yet)
		const records = store => database.records(store);
		const heldNames = kind =>
			JSON.parse(run(`JSON.stringify([...CATALOG.nameIds.${kind}].map(([name, id]) => [id, name]))`));
		const people = kind => [
			...records('contributors')
				.filter(c => c.kind === kind)
				.map(c => [c.id, c.name]),
			...heldNames(kind + 's'),
		];
		const held = JSON.parse(run(`JSON.stringify(CATALOG.books.map(b => [b.id, b.title]))`));
		const named = {
			book: [...records('books').map(b => [b.id, b.title]), ...held],
			series: [...records('series').map(x => [x.id, x.name]), ...heldNames('series')],
			a: people('author'),
			n: people('narrator'),
			p: people('publisher'),
		};
		const enc = v => encodeURIComponent(v).replace(/%20/g, '+');
		return html.replace(/#(book|series|a|n|p)=([^"&]+)/g, (m, k, id) => {
			const name = new Map(named[k]).get(decodeURIComponent(id));
			return name === undefined ? m : `#${k}=${enc(name)}`;
		});
	};
	get.database = database;
	// a link on the page to another place on it (#...) followed: a new history entry, and the page shows it
	const follow = hash => {
		history.pushState(null, '', hash);
		fire('hashchange');
	};
	const booted = {ctx, els, storage, database, get, withIds, run, fire, follow, saved, readable};
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
// A book's page, by its title (as an address from before has it, which the page turns into its id).
const hashValue = v => encodeURIComponent(v).replace(/%20/g, '+');
const bootBook = (title, options = {}) => boot({...options, page: 'book.html', hash: '#book=' + hashValue(title)});
// the first of the demo books
const SALT_ROAD = JSON.parse(DEMO_BOOKS)[0].t;
// The book cards in a list.
const cards = html => (html.match(/class="book"/g) || []).length;

for (const page of ALL_PAGES) {
	const html = read(page);
	assert.equal(entryOf(page).length, 1, `${page} loads one module`);
	assert.ok(!/<script(?! type="module")/.test(html), `${page} loads no plain scripts`);
	for (const shared of ['store.js', 'modules/catalog.js'])
		assert.ok(modulesOf(entryOf(page)[0]).includes(shared), `${page} imports ${shared}`);
	assert.ok(html.includes('<link rel="stylesheet" href="styles.css">'), page);
	for (const other of PAGES) assert.ok(html.includes(`href="${other}"`), `${page} links to ${other}`);
	assert.doesNotMatch(html, /Catalog<\/a>/, `${page}: Series and Books in the nav bar instead`);
}
const demoBooks = JSON.parse(DEMO_BOOKS);

// The book form's edition cards: what each card's fields hold, typing into one, adding and removing cards.
const formEditions = get => get('FORM_EDITIONS.map(x => x.fields)');
const typeEdition = (els, i, k, value) =>
	els.f_editions.listeners.input[0]({target: {dataset: {i: String(i), k}, value}});
const addEdition = els => els.addEditionBtn.listeners.click[0]({});
const removeEdition = (els, i) =>
	els.f_editions.listeners.click[0]({
		target: {closest: s => (s === '[data-remove]' ? {dataset: {remove: String(i)}} : null)},
	});
// an edition card's "Use as the book's title"
const useEditionTitle = (els, i) =>
	els.f_editions.listeners.click[0]({
		target: {closest: s => (s === '[data-use-title]' ? {dataset: {useTitle: String(i)}} : null)},
	});

test("a form's Cancel sits next to its Save, and a Remove button comes after both, apart from them", () => {
	let forms = 0;
	for (const page of ALL_PAGES) {
		for (const [, row] of read(page).matchAll(/<div class="formbtns">([\s\S]*?)<\/div>/g)) {
			const buttons = [...row.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, label]) => ({
				save: /class="save"/.test(attrs),
				label,
			}));
			const remove = buttons.findIndex(b => b.label.startsWith('Remove'));
			if (remove < 0) continue;
			forms++;
			const save = buttons.findIndex(b => b.save),
				cancel = buttons.findIndex(b => b.label === 'Cancel');
			assert.equal(cancel, save + 1, `${page}: Cancel follows Save`);
			assert.equal(remove, buttons.length - 1, `${page}: Remove comes last`);
		}
	}
	assert.equal(forms, 5, 'the book, series, author, narrator and publisher forms');
});

test('opens on the series overview, with a row per series', async () => {
	const {els, get} = await boot();
	assert.equal(get('SERIES_FILTER'), null);
	const seriesCount = new Set(demoBooks.filter(b => b.s).map(b => b.s)).size;
	assert.match(els.subtitle.textContent, new RegExp(`^${seriesCount} series across ${demoBooks.length} audiobooks`));
	assert.equal((els.results.innerHTML.match(/class="srow-title"/g) || []).length, seriesCount + 1); // + "Standalone"
	assert.ok(!els.crumb.classList.contains('show'));
	assert.equal(els.toggleAdd.style.display, 'none', "books are added on a series' page or the books page");
});

test('opening a series shows exactly that series, and its books can be added to', async () => {
	const {ctx, els, get} = await boot();
	const counts = {};
	demoBooks.forEach(b => b.s && (counts[b.s] = (counts[b.s] || 0) + 1));
	const [series] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	ctx.openSeries(seriesIdOf(get, series));
	await idle();
	assert.equal(cards(els.results.innerHTML), counts[series]);
	assert.ok(els.crumb.classList.contains('show'));
	assert.equal(els.crumbLabel.textContent, series);
	assert.equal(els.controls.style.display, 'none', 'nothing to search');
	assert.equal(els.resultCount.textContent, '', 'its books are not counted again');
	assert.equal(els.toggleAdd.style.display, '');
	assert.equal(els.toggleAdd.getAttribute('href'), `book.html#add&series=${seriesIdOf(get, series)}`);
});

test('search narrows the books page', async () => {
	const {ctx, els} = await boot({page: 'books.html'});
	// says what the catalog holds, not where it came from
	assert.equal(els.subtitle.textContent, `${demoBooks.length} audiobooks in the catalog`);
	assert.equal(els.resultCount.textContent, `${demoBooks.length} shown`);
	const target = demoBooks[0];
	els.q.value = target.t;
	await ctx.refreshView();
	await idle();
	assert.ok(els.results.innerHTML.includes('class="book"'));
	assert.ok(cards(els.results.innerHTML) < demoBooks.length);
	els.q.value = 'zzzz-no-such-book-zzzz';
	await ctx.refreshView();
	await idle();
	assert.match(els.results.innerHTML, /No books match/);
});

test('the books page can be sorted by when they were read or added, newest first, as one list', async () => {
	const {ctx, els, storage} = await boot({page: 'books.html'});
	const titles = () =>
		[...els.results.innerHTML.matchAll(/<div class="title"><a href="[^"]+">([^<]+)<\/a>/g)].map(m => m[1]);
	const latest = b => (b.r || []).slice().sort().pop() || '';
	const byRead = [...demoBooks].filter(b => latest(b)).sort((x, y) => latest(y).localeCompare(latest(x)));

	els.sortBy.value = 'read';
	els.sortBy.listeners.change[0]();
	await idle();
	assert.equal(ctx.location.hash, '#sort=read');
	assert.doesNotMatch(els.results.innerHTML, /class="series-group"/, 'not grouped by series');
	assert.equal(titles()[0], byRead[0].t);
	assert.deepEqual(
		titles()
			.slice(0, byRead.length)
			.map(t => demoBooks.find(b => b.t === t))
			.every(b => latest(b)),
		true,
		'books read come first',
	);
	// each book says its series
	const inSeries = demoBooks.find(b => b.t === titles()[0]);
	if (inSeries.s)
		assert.match(
			els.results.innerHTML,
			new RegExp(`<div class="meta"><a href="index\\.html#series=[^"]+">${inSeries.s}</a>`),
		);

	els.sortBy.value = 'added';
	els.sortBy.listeners.change[0]();
	await idle();
	assert.equal(titles()[0], demoBooks[demoBooks.length - 1].t);

	// the address keeps it
	const again = await boot({page: 'books.html', hash: '#sort=added', storage});
	assert.equal(again.els.sortBy.value, 'added');
	assert.equal(
		[...again.els.results.innerHTML.matchAll(/<div class="title"><a href="[^"]+">([^<]+)<\/a>/g)][0][1],
		demoBooks[demoBooks.length - 1].t,
	);
});

test("the Filters button (a phone's) opens the filters and counts those on; a book's page has no search or filters", async () => {
	const {els} = await boot({page: 'books.html'});
	assert.equal(els.filtersBtn.textContent, 'Filters');
	els.filtersBtn.listeners.click[0]();
	assert.ok(els.controls.classList.contains('filtersOpen'));
	assert.equal(els.filtersBtn.getAttribute('aria-expanded'), 'true');
	els.genreFilter.value = 'Mystery';
	els.genreFilter.listeners.change[0]();
	await idle();
	assert.equal(els.filtersBtn.textContent, 'Filters · 1');
	const series = await boot();
	series.els.missingFilter.value = 'missing';
	series.els.missingFilter.listeners.change[0]();
	await idle();
	assert.equal(series.els.filtersBtn.textContent, 'Filters · 1');
	const book = await bootBook(SALT_ROAD);
	assert.equal(book.els.controls, undefined);
	assert.equal(book.els.q, undefined);
});

test('text from the catalog is shown as text, never read as HTML', async () => {
	const odd = '<img src=x onerror=alert(1)> & "Co"';
	// twice, so the duplicates page shows it too
	const mine = JSON.stringify([
		{t: odd, a: [odd], s: odd, sn: '1', g: [odd], e: [{desc: odd, n: [odd]}]},
		{t: odd, a: [odd], e: [{ext: {goodreads: '42'}}]},
	]);
	const info = JSON.stringify({[odd]: {total: 2, status: 'ongoing', note: odd}});
	const authors = JSON.stringify({[odd]: {bio: odd}});
	const files = {'books.json': mine, 'series-info.json': info, 'authors.json': authors};
	const pages = [
		['index.html', 'results', ''],
		['index.html', 'results', '#series=' + encodeURIComponent(odd)],
		['books.html', 'results', ''],
		['book.html', 'results', '#book=' + encodeURIComponent(odd)],
		['author.html', 'creditBody', '#a=' + encodeURIComponent(odd)],
		['duplicates.html', 'dupBody', ''],
	];
	for (const [page, id, hash] of pages) {
		const {els} = await boot({page, files, hash});
		await idle();
		const shown = els[id].innerHTML;
		assert.equal(els[id].querySelectorAll('img').length, 0, `${page}${hash}: no element made of the text`);
		assert.match(shown, /&lt;img src=x onerror=alert\(1\)&gt; &amp; "Co"/, page + hash);
	}
});

test('the address names what is shown, so a series, a book or a search can be linked to', async () => {
	const {ctx, els, get, storage} = await boot();
	assert.equal(ctx.location.hash, '');
	// by the ids they are stored under, so a link holds when a series or book is renamed
	const halloway = seriesIdOf(get, 'Halloway & Finch');
	ctx.openSeries(halloway);
	await idle();
	assert.equal(ctx.location.hash, `#series=${halloway}`);
	assert.equal(ctx.document.title, 'Halloway & Finch — Audiobook Catalog');
	// the overview links each series to that address (on this page), and book cards to their own page
	ctx.openSeries(null);
	await idle();
	assert.ok(
		els.results.innerHTML.includes(`<a class="srow-title" href="#series=${halloway}">Halloway &amp; Finch</a>`),
	);
	assert.match(els.results.innerHTML, /<a class="srow-title" href="#standalone">Standalone<\/a>/);
	ctx.openSeries(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	const saltRoad = bookIdOf(get, 'The Salt Road');
	assert.ok(
		els.results.innerHTML.includes(
			`<div class="title"><a href="book.html#book=${saltRoad}">The Salt Road</a></div>`,
		),
	);

	// opening one of those addresses shows the same thing, in another tab too
	for (const hash of [`#series=${halloway}`, '#series=Halloway+%26+Finch']) {
		const series = await boot({hash, storage});
		assert.equal(series.get('SERIES_FILTER'), halloway, 'by its id, or by its name (an address from before)');
		assert.equal(series.ctx.location.hash, `#series=${halloway}`);
		assert.equal(cards(series.els.results.innerHTML), 2);
		assert.equal(series.els.crumbLabel.textContent, 'Halloway & Finch');
	}
	for (const hash of [`#book=${saltRoad}`, '#book=The+Salt+Road']) {
		const book = await boot({page: 'book.html', hash, storage});
		assert.equal(book.get('BOOK_FILTER'), saltRoad);
		assert.equal(book.ctx.location.hash, `#book=${saltRoad}`);
		assert.equal((book.els.results.innerHTML.match(/class="book book-details"/g) || []).length, 1);
		assert.match(book.els.results.innerHTML, /<h2 class="title">The Salt Road<\/h2>/);
		assert.equal(book.ctx.document.title, 'The Salt Road — Audiobook Catalog');
		// with a way back to its series, and no count of the one book shown
		assert.equal(book.els.crumbLabel.textContent, 'The Lantern Coast › The Salt Road');
		assert.match(book.els.crumbLabel.innerHTML, /^<a href="index\.html#series=[^"]+">The Lantern Coast<\/a>/);
		assert.equal(book.els.resultCount, undefined);
		assert.doesNotMatch(book.ctx.document.body.innerHTML, /shown/);
	}
	const gone = await boot({page: 'book.html', hash: '#book=no-such-id', storage});
	assert.equal(gone.els.crumbLabel.textContent, 'No such book');
	assert.match(gone.els.results.innerHTML, /This book is not in the catalog/);
	const standalone = await boot({hash: '#standalone'});
	assert.equal(standalone.els.crumbLabel.textContent, 'Standalone books');
	assert.equal(cards(standalone.els.results.innerHTML), 3);

	// a search and the filters
	const found = await boot({page: 'books.html', hash: '#q=ashcombe&read=undated&genre=Science+Fiction'});
	assert.equal(found.els.q.value, 'ashcombe');
	assert.equal(found.els.readFilter.value, '__undated__');
	assert.equal(cards(found.els.results.innerHTML), 4);
	assert.equal(found.ctx.location.hash, '#q=ashcombe&genre=Science+Fiction&read=undated');
	const gaps = await boot({hash: '#q=coast&missing'});
	assert.equal(gaps.get('SERIES_FILTER'), null);
	assert.equal(gaps.els.missingFilter.value, 'missing');
	assert.equal(gaps.els.q.value, 'coast');
	// an address it does not understand shows the series overview
	const odd = await boot({hash: '#nothing=here&%E0%A4%A'});
	assert.equal(odd.get('SERIES_FILTER'), null);
	assert.equal(odd.ctx.location.hash, '');
});

test("addresses from when one page showed the series, the books and a book go to the books page and the book's page", async () => {
	for (const [hash, to] of [
		['#books', 'books.html'],
		['#books&q=salt+road&genre=Fantasy&sort=read', 'books.html#q=salt+road&genre=Fantasy&sort=read'],
		['#book=The+Salt+Road', 'book.html#book=The+Salt+Road'],
		['#book=id-3&q=x', 'book.html#book=id-3'],
	]) {
		const {ctx} = await boot({hash});
		assert.equal(ctx.location.replaced, to, hash);
	}
	for (const hash of ['', '#series=The+Lantern+Coast', '#q=coast&missing']) {
		const {ctx} = await boot({hash});
		assert.equal(ctx.location.replaced, null, hash);
	}
});

test('back and forward step through series, searches and filters, and books', async () => {
	const {ctx, els, get, follow, storage} = await boot();
	const {history} = ctx;
	const lantern = seriesIdOf(get, 'The Lantern Coast'),
		saltRoad = bookIdOf(get, 'The Salt Road'),
		beacons = bookIdOf(get, 'Beacons at Low Tide');
	// the series' links are on this page: following one shows it here
	follow(`#series=${lantern}`);
	await idle();
	assert.equal(get('SERIES_FILTER'), lantern);
	assert.equal(cards(els.results.innerHTML), 4);
	follow('#standalone');
	await idle();
	assert.equal(cards(els.results.innerHTML), 3);
	history.back();
	await idle();
	assert.equal(get('SERIES_FILTER'), lantern);
	assert.equal(cards(els.results.innerHTML), 4);
	// leaving a series closes its form
	await ctx.openSeriesForm(lantern);
	assert.ok(els.seriesForm.classList.contains('open'));
	history.back();
	await idle();
	assert.equal(get('SERIES_FILTER'), null);
	assert.ok(!els.seriesForm.classList.contains('open'));
	// typing a search is one entry, however many letters
	for (const q of ['c', 'co', 'coast']) {
		els.q.value = q;
		els.q.listeners.input[0]();
	}
	await idle();
	assert.deepEqual(
		history.entries.map(e => e.hash),
		['', '#q=coast'],
	);
	assert.equal((els.results.innerHTML.match(/class="srow-title"/g) || []).length, 1);
	history.back();
	await idle();
	assert.equal(els.q.value, '');
	assert.ok((els.results.innerHTML.match(/class="srow-title"/g) || []).length > 1);

	const books = await boot({page: 'books.html', storage});
	const b = books.els;
	b.genreFilter.value = 'Mystery';
	b.genreFilter.listeners.change[0]();
	await idle();
	for (const q of ['p', 'pr', 'priya']) {
		b.q.value = q;
		b.q.listeners.input[0]();
	}
	await idle();
	assert.deepEqual(
		books.ctx.history.entries.map(e => e.hash),
		['', '#genre=Mystery', '#q=priya&genre=Mystery'],
	);
	books.ctx.history.back();
	await idle();
	assert.equal(b.q.value, '');
	assert.equal(b.genreFilter.value, 'Mystery');
	books.ctx.history.back();
	await idle();
	assert.equal(b.genreFilter.value, '');
	assert.equal(cards(b.results.innerHTML), demoBooks.length);
	// a space typed in the search box stays there (the address carries the search without it)
	b.q.value = 'beacons ';
	b.q.listeners.input[0]();
	await idle();
	assert.equal(b.q.value, 'beacons ');
	b.q.value = 'beacons at';
	b.q.listeners.input[0]();
	await idle();
	assert.equal(books.ctx.location.hash, '#q=beacons+at');
	books.ctx.history.back();
	await idle();
	// a new search after going back starts a new entry instead of rewriting an old one
	b.q.value = 'salt';
	b.q.listeners.input[0]();
	await idle();
	assert.deepEqual(
		books.ctx.history.entries.map(e => e.hash),
		['', '#q=salt'],
	);

	// a link to another book (a box set's) on a book's page shows it there; Back the one before, its form closed
	const book = await bootBook('The Salt Road', {storage});
	book.ctx.openEditForm(saltRoad);
	book.follow(`#book=${beacons}`);
	await idle();
	assert.equal(book.get('BOOK_FILTER'), beacons);
	assert.ok(!book.els.addForm.classList.contains('open'));
	assert.match(book.els.results.innerHTML, /<h2 class="title">Beacons at Low Tide<\/h2>/);
	book.ctx.history.back();
	await idle();
	assert.equal(book.get('BOOK_FILTER'), saltRoad);
	assert.match(book.els.results.innerHTML, /<h2 class="title">The Salt Road<\/h2>/);
});

test('editing a book keeps its editions, and their covers', async () => {
	const {ctx, els, get, run} = await bootBook(SALT_ROAD);
	const cover = 'e3'.repeat(32);
	run(
		`CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', goodreads: '4242' }, p: 'Gull Audio', len: 642, img: {audiobookdb: '${cover}'}}, {ext: { 'audible.com': 'TESTASIN02' }}].map(e => Edition.fromJSON(e))`,
	);
	ctx.openEditForm(get('BOOK_FILTER'));
	assert.equal(els.formTitle.textContent, 'Edit book');
	assert.deepEqual(formEditions(get), [
		{
			'ext:audible.com': 'TESTASIN01',
			'ext:goodreads': '4242',
			p: 'Gull Audio',
			len: '10h 42m',
			'img:audiobookdb': cover,
		},
		{'ext:audible.com': 'TESTASIN02'},
	]);
	assert.doesNotMatch(els.f_editions.innerHTML, /img:|e3e3/, 'the form shows no cover key');
	assert.match(els.f_editions.innerHTML, /Edition 2/);
	assert.match(els.f_editions.innerHTML, /<input data-i="0" data-k="len" value="10h 42m"/);
	els.f_t.value = 'Renamed In The App';
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	assert.deepEqual(get('({t: CATALOG.books[0].title, e: CATALOG.books[0].editions})'), {
		t: 'Renamed In The App',
		e: [
			{
				ext: {'audible.com': 'TESTASIN01', goodreads: '4242'},
				p: 'Gull Audio',
				len: 642,
				img: {audiobookdb: cover},
			},
			{ext: {'audible.com': 'TESTASIN02'}},
		],
	});
	assert.match(els.results.innerHTML, /<h2 class="title">Renamed In The App<\/h2>/);
	// AudiobookDB's cover comes first, at the details' size
	assert.match(
		els.results.innerHTML,
		new RegExp(`<img class="cover large" src="https://cdn\\.audiobookdb\\.org/${cover}/large\\.jpg"`),
	);
});

test("the book form's author, series, narrator and publisher fields offer the names the catalog has as they are typed, and say which are new", async () => {
	const {ctx, els, get, run} = await bootBook(SALT_ROAD);
	ctx.openEditForm(get('BOOK_FILTER'));
	await ctx.loadFormNames();
	assert.deepEqual(get('FORM_NAMES.publisher').sort(), ['Gullwing Audio', 'Harbourlight Sound', 'Kestrel Row Audio']);
	const options = list => [...list.innerHTML.matchAll(/<li [^>]*>([^<]*)<\/li>/g)].map(m => m[1]);
	// the authors: the name the cursor is in is looked up, leaving out the ones the field has
	assert.equal(els.f_a.getAttribute('role'), 'combobox');
	assert.equal(els.f_a.value, 'Marisol Quenby');
	els.f_a.value = 'Marisol Quenby, ren';
	els.f_a.dispatch('input');
	assert.deepEqual(options(els.f_aList), ['Odalys Rennick']);
	assert.equal(els.f_a.getAttribute('aria-expanded'), 'true');
	els.f_a.value = 'Marisol Quenby, o';
	els.f_a.dispatch('input');
	assert.deepEqual(
		options(els.f_aList),
		['Odalys Rennick', 'Priya Ostrander', 'Ferran Doyle', 'Wendell Ashcombe'],
		'names starting with it first, then a word, then anywhere',
	);
	// picked with the arrow keys and Enter, which doesn't save the form
	let prevented = false;
	els.f_a.dispatch('keydown', {key: 'ArrowDown'});
	els.f_a.dispatch('keydown', {key: 'ArrowDown'});
	assert.equal(els.f_a.getAttribute('aria-activedescendant'), 'f_aList-1');
	assert.match(
		els.f_aList.innerHTML,
		/<li id="f_aList-1" role="option" aria-selected="true" class="active">Priya Ostrander<\/li>/,
	);
	els.f_a.dispatch('keydown', {
		key: 'Enter',
		preventDefault() {
			prevented = true;
		},
	});
	assert.ok(prevented);
	assert.equal(els.f_a.value, 'Marisol Quenby, Priya Ostrander, ');
	assert.equal(els.f_aList.innerHTML, '');
	assert.equal(els.f_a.getAttribute('aria-expanded'), 'false');
	// Escape closes the list, leaving what was typed
	els.f_a.value = 'Wen';
	els.f_a.dispatch('input');
	assert.deepEqual(options(els.f_aList), ['Wendell Ashcombe']);
	els.f_a.dispatch('keydown', {key: 'Escape'});
	assert.equal(els.f_aList.innerHTML, '');
	assert.equal(els.f_a.value, 'Wen');
	assert.equal(els.f_aNew.textContent, 'New author: Wen, added to the catalog when this is saved.');
	els.f_a.value = 'Marisol Quenby, Priya Ostrander, ';
	// an edition's narrators and publisher: a click picks one, and the edition has it
	const narrators = els.f_e0_n,
		publisher = els.f_e0_p;
	assert.equal(narrators.getAttribute('value'), 'Tobias Frane');
	narrators.value = 'Tobias Frane, ing';
	narrators.dispatch('input');
	assert.deepEqual(options(els.f_e0_nList), ['Ingrid Voss']);
	els.f_e0_nList.children[0].dispatch('click');
	assert.equal(narrators.value, 'Tobias Frane, Ingrid Voss, ');
	assert.equal(formEditions(get)[0].n, 'Tobias Frane, Ingrid Voss, ');
	publisher.value = 'kes';
	publisher.dispatch('input');
	assert.deepEqual(options(els.f_e0_pList), ['Kestrel Row Audio']);
	els.f_e0_pList.children[0].dispatch('click');
	assert.equal(publisher.value, 'Kestrel Row Audio', 'one publisher, so no comma after it');
	assert.equal(formEditions(get)[0].p, 'Kestrel Row Audio');
	assert.equal(els.f_e0_pNew.hidden, true, 'a name the catalog has is not new');
	els.f_a.dispatch('input');
	assert.equal(els.f_aNew.hidden, true);
	// a name the catalog doesn't have is typed as before, and the field says it is new
	publisher.value = 'New Sound';
	typeEdition(els, 0, 'p', 'New Sound');
	publisher.dispatch('input');
	assert.equal(els.f_e0_pList.innerHTML, '');
	assert.equal(els.f_e0_pNew.hidden, false);
	assert.equal(els.f_e0_pNew.textContent, 'New publisher: New Sound, added to the catalog when this is saved.');
	els.f_s.value = 'Brand New Saga';
	els.f_s.dispatch('input');
	assert.equal(els.f_sNew.textContent, 'New series: Brand New Saga, added to the catalog when this is saved.');
	els.f_s.value = get('CATALOG.books[0].series');
	els.f_s.dispatch('input');
	assert.equal(els.f_sNew.hidden, true);
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	assert.equal(
		els.ioStatus.textContent,
		`Saved ${get('CATALOG.books[0].title')}. New in the catalog: the publisher New Sound.`,
	);
	assert.deepEqual(get('CATALOG.books[0].authors'), ['Marisol Quenby', 'Priya Ostrander']);
	assert.deepEqual(get('[CATALOG.books[0].editions[0].narrators, CATALOG.books[0].editions[0].publisher]'), [
		['Tobias Frane', 'Ingrid Voss'],
		'New Sound',
	]);
	assert.ok(run('FORM_NAMES.author.length') > 0);
});

test("a book's details link an edition's ASIN to Audible and its Goodreads id to Goodreads; its card leaves editions out", async () => {
	const {run, storage} = await bootBook(SALT_ROAD);
	run(
		"CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', goodreads: '4242' }, p: 'Gull Audio', len: 642}, {isbn: '9780000000002'}].map(e => Edition.fromJSON(e)); persist()",
	);
	const list = await boot({page: 'books.html', storage});
	// (only its cover's address has its ids)
	assert.doesNotMatch(list.els.results.innerHTML.replace(/<img [^>]*>/g, ''), /TESTASIN01|Gull Audio|9780000000002/);
	const {els, readable} = await bootBook(SALT_ROAD, {storage});
	const html = readable(els.results.innerHTML);
	assert.match(
		html,
		/<h3>Edition 1<\/h3><dl class="details"><dt>ASIN<\/dt><dd>audible\.com <a href="https:\/\/www\.audible\.com\/pd\/TESTASIN01" target="_blank" rel="noopener">TESTASIN01<\/a><\/dd><dt>Goodreads<\/dt><dd><a href="https:\/\/www\.goodreads\.com\/book\/show\/4242" target="_blank" rel="noopener">4242<\/a><\/dd><dt>Publisher<\/dt><dd><a href="publisher\.html#p=Gull\+Audio">Gull Audio<\/a><\/dd><dt>Length<\/dt><dd>10h 42m<\/dd><\/dl>/,
	);
	// an edition without either id has no links
	assert.match(html, /<h3>Edition 2<\/h3><dl class="details"><dt>ISBN<\/dt><dd>9780000000002<\/dd><\/dl>/);
	// each site's ASIN links to the book on that site
	const page = await bootBook(SALT_ROAD, {storage});
	page.run(
		"CATALOG.books[0].editions = [{ext: { 'audible.co.uk': 'TESTASIN02', 'amazon.com': 'TESTASIN03' }}].map(e => Edition.fromJSON(e)); persist()",
	);
	await page.ctx.refreshView();
	await idle();
	assert.match(
		page.readable(page.els.results.innerHTML),
		/<h3>Edition<\/h3><dl class="details"><dt>ASIN<\/dt><dd>audible\.co\.uk <a href="https:\/\/www\.audible\.co\.uk\/pd\/TESTASIN02"[^>]*>TESTASIN02<\/a>, amazon\.com <a href="https:\/\/www\.amazon\.com\/dp\/TESTASIN03"[^>]*>TESTASIN03<\/a><\/dd>/,
	);
});

test("a book edited in the form keeps its id, and so do its editions, a box set's shared one included", async () => {
	const box = {ext: {'audible.com': 'B0BOX00001'}};
	const books = [
		{t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [box, {ext: {goodreads: '4001'}}]},
		{t: 'Gull Light', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [box]},
	];
	const {ctx, els, withIds, database, saved, get} = await bootBook('Tidewater', {
		files: {'books.json': JSON.stringify(books)},
	});
	await saved();
	assert.deepEqual(
		database.records('editions').map(ed => ed.bookIds.length),
		[2, 1],
		"the box set's edition is one record",
	);
	const before = withIds('CATALOG.books');
	assert.deepEqual(
		before.map(b => b.t),
		['Tidewater', 'Gull Light'],
		"the other book of the box set's edition is loaded with it",
	);
	ctx.openEditForm(get('BOOK_FILTER'));
	Object.assign(els.f_t, {value: 'Tidewater Rising'});
	typeEdition(els, 0, 'p', 'Gull Audio');
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	await saved();
	const after = withIds('CATALOG.books');
	assert.equal(after[0].t, 'Tidewater Rising');
	assert.deepEqual(
		after.map(b => [b.uid, b.e.map(ed => ed.uid)]),
		before.map(b => [b.uid, b.e.map(ed => ed.uid)]),
	);
	assert.equal(after[1].e[0].p, 'Gull Audio', 'the edit reached the other title');
	const records = database.records('editions');
	assert.deepEqual(
		records.map(ed => [ed.id, ed.bookIds.length]),
		[
			[before[0].e[0].uid, 2],
			[before[0].e[1].uid, 1],
		],
		'still one record each',
	);
	assert.ok(records[0].publisherId);
	assert.deepEqual(
		database.records('books').map(b => b.title),
		['Tidewater Rising', 'Gull Light'],
	);
});

test('the book form has a field for each site an edition has an ASIN on, and adds one for another site', async () => {
	const {ctx, els, get, run} = await bootBook(SALT_ROAD);
	const id = get('BOOK_FILTER');
	run(
		"CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', 'amazon.co.uk': 'TESTASIN02' }}, {ext: { goodreads: '4242' }}].map(e => Edition.fromJSON(e))",
	);
	ctx.openEditForm(id);
	// audible.com and the sites in use have a field; the others wait in the list
	assert.match(
		els.f_editions.innerHTML,
		/<label>audible\.com<\/label><input data-i="0" data-k="ext:audible\.com" value="TESTASIN01"/,
	);
	assert.match(els.f_editions.innerHTML, /data-k="ext:amazon\.co\.uk" value="TESTASIN02"/);
	assert.match(
		els.f_editions.innerHTML,
		/<label>audible\.com<\/label><input data-i="1" data-k="ext:audible\.com" value=""/,
	);
	assert.doesNotMatch(els.f_editions.innerHTML, /data-k="ext:amazon\.com"/);
	assert.match(
		els.f_editions.innerHTML,
		/<select data-add-site="0"[^>]*><option value="">\+ Another site<\/option><option value="amazon\.com">/,
	);
	// picking a site from the list gives it a field
	els.f_editions.listeners.change[0]({target: {dataset: {addSite: '0'}, value: 'amazon.com'}});
	await idle();
	assert.match(els.f_editions.innerHTML, /data-i="0" data-k="ext:amazon\.com" value=""/);
	typeEdition(els, 0, 'ext:amazon.com', 'https://www.amazon.com/dp/TESTASIN03?ref=x');
	typeEdition(els, 1, 'ext:audible.com', 'testasin04');
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	assert.deepEqual(get('CATALOG.books[0].editions'), [
		{ext: {'audible.com': 'TESTASIN01', 'amazon.co.uk': 'TESTASIN02', 'amazon.com': 'TESTASIN03'}},
		{ext: {'audible.com': 'TESTASIN04', goodreads: '4242'}},
	]);
	// emptying a site's field drops that ASIN; something that isn't an ASIN is named
	ctx.openEditForm(id);
	typeEdition(els, 0, 'ext:amazon.co.uk', '');
	typeEdition(els, 1, 'ext:audible.com', 'not an asin');
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	assert.match(els.formError.textContent, /Not understood: edition 2: ASIN audible\.com not an asin/);
	typeEdition(els, 1, 'ext:audible.com', 'TESTASIN04');
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	assert.deepEqual(get('CATALOG.books[0].editions[0]'), {
		ext: {'audible.com': 'TESTASIN01', 'amazon.com': 'TESTASIN03'},
	});
});

test('a book card shows its title, authors, narrators and read dates; its page shows the rest', async () => {
	const {ctx, get, readable, els, storage} = await boot();
	ctx.openSeries(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	const card = readable(els.results.innerHTML).match(
		/<div class="book" data-id="[^"]+"><div class="num">1<\/div>.*?<div class="read">[^<]*<\/div><\/div><\/div>/,
	)[0];
	// its cover from its first ASIN, hidden until it loads
	assert.match(
		card,
		/<div class="num">1<\/div><img class="cover small" src="https:\/\/m\.media-amazon\.com\/images\/P\/SAMPLE0001\.01\.MZZZZZZZ\.jpg" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"><div class="info">/,
	);
	assert.match(
		card,
		/<div class="title"><a href="book\.html#book=The\+Salt\+Road">The Salt Road<\/a><\/div><div class="meta"><a href="author\.html#a=Marisol\+Quenby">Marisol Quenby<\/a> — narr\. /,
	);
	assert.match(card, /<div class="read">Read 2023-06-02, 2025-11-20<\/div><\/div><\/div>$/);
	assert.doesNotMatch(card, /Fantasy|Goodreads|ISBN|Gullwing|<button/, 'nothing to edit, merge or remove it with');

	const book = await bootBook('The Salt Road', {storage});
	const details = book.readable(book.els.results.innerHTML);
	assert.match(
		details,
		/^<div class="book book-details" data-id="[^"]+"><div class="num">1<\/div><div class="head"><h2 class="title">The Salt Road<\/h2><div class="meta"><a href="author\.html#a=Marisol\+Quenby">Marisol Quenby<\/a> — narr\. /,
	);
	assert.match(
		details,
		/<dl class="details"><dt>Series<\/dt><dd><a href="index\.html#series=The\+Lantern\+Coast">The Lantern Coast<\/a> #1<\/dd><dt>Read<\/dt><dd>2023-06-02, 2025-11-20 <button type="button" class="readToday">\+ Read today<\/button><\/dd><dt>Genres<\/dt><dd><span class="genres"><span class="tag">Fantasy<\/span><span class="tag">Adventure<\/span><\/span><\/dd><\/dl>/,
	);
	assert.match(
		details,
		/<dt>Goodreads<\/dt><dd><a [^>]*>9001<\/a><\/dd><dt>ISBN<\/dt><dd>9780000000002<\/dd><dt>Publisher<\/dt><dd><a href="publisher\.html#p=Gullwing\+Audio">Gullwing Audio<\/a><\/dd><dt>Released<\/dt><dd>2019-04-02<\/dd><dt>Length<\/dt><dd>10h 42m<\/dd>/,
	);
	// Edit and Merge, spelled out, come after everything else
	assert.match(
		details,
		/<\/div><div class="book-actions"><button type="button" class="edit">Edit<\/button><button type="button" class="merge" aria-expanded="false">Merge<\/button><\/div><\/div><\/div>$/,
	);
	// the cover comes after the title (beside the rest, or across the card on a phone), then the rest
	assert.match(
		details,
		/<\/div><\/div><img class="cover large" src="https:\/\/m\.media-amazon\.com\/images\/P\/SAMPLE0001\.01\.LZZZZZZZ\.jpg"[^>]*><div class="info"><dl class="details"><dt>Series/,
	);
	// editing it there puts the form in its place
	book.ctx.openEditForm(book.get('BOOK_FILTER'));
	assert.match(book.els.results.innerHTML, /class="book book-details editing"/);
	assert.equal(book.els.addForm.place, 'after ', 'after the details');
});

test('a cover tries the next address when one fails or is blank, and can be turned off', async () => {
	const storage = new Map();
	const {els, run} = await bootBook(SALT_ROAD, {storage});
	run(
		"CATALOG.books[0].editions = [{ext: { 'audible.com': 'B0COVER001' }, isbn: '9780000000002'}].map(e => Edition.fromJSON(e)); persist(); render()",
	);
	const cover = () => els.results.querySelector('.cover');
	assert.equal(cover().getAttribute('src'), 'https://m.media-amazon.com/images/P/B0COVER001.01.LZZZZZZZ.jpg');
	// Amazon answers with a blank picture: Open Library is asked next
	Object.assign(cover(), {naturalWidth: 1, naturalHeight: 1}).dispatch('load');
	assert.equal(
		cover().getAttribute('src'),
		'https://covers.openlibrary.org/b/isbn/9780000000002-L.jpg?default=false',
	);
	assert.ok(!cover().classList.contains('loaded'));
	Object.assign(cover(), {naturalWidth: 120, naturalHeight: 180}).dispatch('load');
	assert.ok(cover().classList.contains('loaded'));
	// when the last one fails too, it is hidden
	cover().dispatch('error');
	assert.ok(cover().classList.contains('missing'));
	// turned off on a list, no book asks for one, and it stays off in this browser, on a book's page too
	const list = await boot({page: 'books.html', storage});
	assert.ok(list.els.results.querySelector('.cover'));
	list.els.showCovers.checked = false;
	list.els.showCovers.dispatch('change');
	assert.equal(list.els.results.querySelector('.cover'), null);
	assert.ok(list.els.results.querySelector('.book'));
	const again = await boot({storage, hash: '#series=The+Lantern+Coast'});
	assert.equal(again.els.showCovers.checked, false);
	assert.equal(again.els.results.querySelector('.cover'), null);
	const page = await bootBook(SALT_ROAD, {storage});
	assert.equal(page.els.results.querySelector('.cover'), null);
});

test("a book's details link the Hardcover book and an edition's Hardcover id to Hardcover, and the edit form keeps them", async () => {
	const {ctx, els, get, run, storage} = await bootBook(SALT_ROAD);
	const id = get('BOOK_FILTER');
	run(
		"CATALOG.books[0].external = { hardcover: '808' }; CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', hardcover: '31337' }}].map(e => Edition.fromJSON(e)); persist(); render()",
	);
	assert.match(
		els.results.innerHTML,
		/<dt>Hardcover book<\/dt><dd><a href="https:\/\/hardcover\.app\/id\/book\/808" target="_blank" rel="noopener">808<\/a><\/dd>/,
	);
	assert.match(
		els.results.innerHTML,
		/<dt>ASIN<\/dt><dd>audible\.com <a [^>]*>TESTASIN01<\/a><\/dd><dt>Hardcover<\/dt><dd><a href="https:\/\/hardcover\.app\/id\/edition\/31337" target="_blank" rel="noopener">31337<\/a><\/dd>/,
	);
	const list = await boot({page: 'books.html', storage, hash: '#q=808'});
	assert.equal(cards(list.els.results.innerHTML), 1, 'searchable by its Hardcover book id');
	ctx.openEditForm(id);
	assert.equal(els.f_hcb.value, '808');
	// folded away, with the catalogs it has an id in named
	assert.equal(els.f_ids.open, false);
	assert.equal(els.f_idsNote.textContent, '(Hardcover)');
	assert.deepEqual(formEditions(get), [{'ext:audible.com': 'TESTASIN01', 'ext:hardcover': '31337'}]);
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	assert.deepEqual(get("[CATALOG.books[0].idOn('hardcover'), CATALOG.books[0].editions]"), [
		'808',
		[{ext: {'audible.com': 'TESTASIN01', hardcover: '31337'}}],
	]);

	// a Hardcover book id is a number; a book's address in an edition's Hardcover field goes on the book
	ctx.openEditForm(id);
	els.f_hcb.value = 'abc';
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	assert.match(els.formError.textContent, /Not a Hardcover book id: abc/);
	assert.equal(els.f_ids.open, true, 'opened to show the field');
	els.f_hcb.value = '';
	addEdition(els);
	typeEdition(els, 1, 'ext:hardcover', 'https://hardcover.app/id/book/909');
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	assert.deepEqual(get("[CATALOG.books[0].idOn('hardcover'), CATALOG.books[0].editions]"), [
		'909',
		[{ext: {'audible.com': 'TESTASIN01', hardcover: '31337'}}],
	]);
});

test('an edition added in the book form takes its place by release date, earliest first, undated last', async () => {
	const storage = new Map();
	const {ctx, els, get} = await bootBook(SALT_ROAD, {storage});
	ctx.openEditForm(get('BOOK_FILTER'));
	addEdition(els);
	typeEdition(els, 2, 'p', 'Undated Audio');
	addEdition(els);
	typeEdition(els, 3, 'p', 'Early Audio');
	typeEdition(els, 3, 'd', '2018-01');
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	assert.equal(els.formError.textContent, '');
	const order = ['Early Audio', 'Gullwing Audio', 'Harbourlight Sound', 'Undated Audio'];
	assert.deepEqual(get('CATALOG.books[0].editions.map(ed => ed.publisher)'), order);
	const stored = (await kept(storage)).books.find(b => b.t === SALT_ROAD);
	assert.deepEqual(
		stored.e.map(ed => ed.p),
		order,
	);
});

test('the Hardcover book field takes the address of a book or edition on Hardcover, and looks up its id', async () => {
	// the page asks Hardcover, with the token saved in this browser
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn, ms) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	}; // the pause between requests
	const storage = new Map();
	const {ctx, els, get} = await bootBook(SALT_ROAD, {hardcover: hc.fetch, setTimeout, storage});
	const submit = () => els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	const id = get('BOOK_FILTER');
	ctx.openEditForm(id);
	els.f_hcb.value = 'https://hardcover.app/books/tidewater';
	await submit();
	assert.match(
		els.formError.textContent,
		/Couldn't find the Hardcover book: to look it up on Hardcover, save your Hardcover API token/,
	);
	assert.equal(get("CATALOG.books[0].idOn('hardcover') || null"), null);
	assert.equal(hc.sent.length, 0);

	storage.set('audiobook-catalog-hardcover-token', 'tok-123');
	await submit();
	assert.equal(get("CATALOG.books[0].idOn('hardcover')"), '77');
	assert.match(els.ioStatus.textContent, /Found on Hardcover: Tidewater \(book 77\)/);
	// pasting an edition's address fills in its book's id as soon as the field is left
	ctx.openEditForm(id);
	els.f_hcb.value = 'https://hardcover.app/books/lantern-hours/editions/801';
	await els.f_hcb.listeners.change[0]();
	await idle();
	await settle();
	await settle();
	assert.equal(els.f_hcb.value, '80');
	// a book's /id/ address holds its id: nothing to ask
	els.f_hcb.value = 'hardcover.app/id/book/81';
	const asked = hc.sent.length;
	await submit();
	assert.equal(get("CATALOG.books[0].idOn('hardcover')"), '81');
	assert.equal(hc.sent.length, asked);
});

test("adding a book: the form on a book's page, which then shows the book", async () => {
	const {ctx, els, get, database, saved} = await boot({page: 'book.html', hash: '#add'});
	assert.ok(els.addForm.classList.contains('open'));
	assert.equal(els.formTitle.textContent, 'Add a book');
	assert.equal(els.formRemoveBtn.style.display, 'none');
	assert.equal(els.crumbLabel.textContent, 'Add a book');
	assert.equal(els.results.innerHTML, '');
	const before = database.records('books').length;
	Object.assign(els.f_t, {value: 'Brand New'});
	Object.assign(els.f_a, {value: 'Some Author'});
	Object.assign(els.f_g, {value: 'Fantasy, Cozy'});
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	await saved();
	assert.equal(database.records('books').length, before + 1);
	const added = database.records('books').find(b => b.title === 'Brand New');
	assert.deepEqual(get(`CATALOG.book(${JSON.stringify(added.id)})`), {
		t: 'Brand New',
		a: ['Some Author'],
		g: ['Fantasy', 'Cozy'],
	});
	// in place of the form, so Back doesn't open it again
	assert.equal(ctx.location.hash, `#book=${added.id}`);
	assert.equal(ctx.history.entries.length, 1);
	assert.ok(!els.addForm.classList.contains('open'));
	assert.match(els.results.innerHTML, /<h2 class="title">Brand New<\/h2>/);
	assert.match(els.ioStatus.textContent, /Added Brand New/);
	// Cancel goes back to where the new book was to go
	const cancel = await boot({page: 'book.html', hash: '#add&series=id-x'});
	cancel.els.cancelAdd.listeners.click[0]();
	assert.equal(cancel.ctx.location.replaced, 'index.html#series=id-x');
	const plain = await boot({page: 'book.html', hash: '#add'});
	plain.els.cancelAdd.listeners.click[0]();
	assert.equal(plain.ctx.location.replaced, 'books.html');
});

test('with a catalog proxy saved, a new book is filled in from Audible and AudiobookDB through it, with its key', async () => {
	const behind = fakeProxyCatalogs();
	const asked = [];
	const proxy = async (url, init) => {
		asked.push({url, key: init.headers['X-Proxy-Key']});
		return behind.route(url.replace('https://catalog-proxy.example.workers.dev/', ''));
	};
	const storage = new Map([
		[
			'audiobook-catalog-proxy',
			JSON.stringify({url: 'https://catalog-proxy.example.workers.dev', key: 'right-key'}),
		],
	]);
	const {ctx, els, get} = await boot({page: 'book.html', hash: '#add', proxy, storage});
	els.f_from.value = 'https://www.audible.com/pd/The-Lantern-Keeper-Audiobook/B0LANTERN2';
	await ctx.fillFromCatalog();
	assert.equal(els.formError.textContent, '');
	assert.equal(els.f_t.value, 'The Lantern Keeper');
	assert.equal(els.f_a.value, 'Ann Vale');
	assert.equal(els.f_s.value, 'Gull Isle');
	assert.equal(els.f_sn.value, '2');
	assert.equal(els.f_g.value, 'Fantasy, Literary Fiction');
	assert.equal(els.f_ext_audiobookdb.value, 'LnTrnKpr2xYz');
	assert.deepEqual(formEditions(get), [
		{
			n: 'Hollis Marr, Dana Fenwick',
			'ext:audible.com': 'B0LANTERN2',
			'ext:audiobookdb': 'RlsLntrnUS01',
			isbn: '9780000000019',
			p: 'Gullwing Audio',
			d: '2021-03-04',
			len: '10h 12m',
			'img:audiobookdb': 'c1'.repeat(32),
		},
	]);
	assert.match(
		els.ioStatus.textContent,
		/^Filled in from Audible and AudiobookDB: title, authors, series, number in the series, genres, the book's id in another catalog, an edition\.$/,
	);
	assert.ok(
		asked.length &&
			asked.every(a => a.key === 'right-key' && a.url.startsWith('https://catalog-proxy.example.workers.dev/')),
	);
	// an ASIN the form already has fills in that edition's gaps, even where it says something else, rather than adding one
	const again = await boot({page: 'book.html', hash: '#add', proxy, storage});
	typeEdition(again.els, 0, 'ext:audible.com', 'B0OTHERED1');
	addEdition(again.els);
	typeEdition(again.els, 1, 'ext:audible.com', 'B0LANTERN2');
	typeEdition(again.els, 1, 'p', 'Gullwing Audio Ltd');
	again.els.f_from.value = 'B0LANTERN2';
	await again.ctx.fillFromCatalog();
	assert.equal(again.els.formError.textContent, '');
	assert.deepEqual(formEditions(again.get), [
		{'ext:audible.com': 'B0OTHERED1'},
		{
			n: 'Hollis Marr, Dana Fenwick',
			'ext:audible.com': 'B0LANTERN2',
			'ext:audiobookdb': 'RlsLntrnUS01',
			isbn: '9780000000019',
			p: 'Gullwing Audio Ltd',
			d: '2021-03-04',
			len: '10h 12m',
			'img:audiobookdb': 'c1'.repeat(32),
		},
	]);
	// a title is looked up on AudiobookDB: by the authors typed, when it has several of that title
	const titled = await boot({page: 'book.html', hash: '#add', proxy, storage});
	titled.els.f_from.value = 'the lantern keeper';
	await titled.ctx.fillFromCatalog();
	assert.match(
		titled.els.formError.textContent,
		/AudiobookDB has 2 books titled the lantern keeper: The Lantern Keeper by Ann Vale \(https:\/\/audiobookdb\.org\/books\/LnTrnKpr2xYz\); The Lantern Keeper by Bo Reed .*type the author first/,
	);
	titled.els.f_a.value = 'Ann Vale';
	await titled.ctx.fillFromCatalog();
	assert.equal(titled.els.formError.textContent, '');
	assert.equal(titled.els.f_ext_audiobookdb.value, 'LnTrnKpr2xYz');
	assert.equal(titled.els.f_s.value, 'Gull Isle');
	assert.match(
		titled.els.ioStatus.textContent,
		/^Filled in from AudiobookDB: title, series, number in the series, genres, the book's id in another catalog\. \(AudiobookDB has 2 releases of it/,
	);
	titled.els.f_from.value = 'The Salt Harbor';
	await titled.ctx.fillFromCatalog();
	assert.match(
		titled.els.formError.textContent,
		/AudiobookDB has no book titled The Salt Harbor by Ann Vale; paste its address instead/,
	);
	// without the proxy, AudiobookDB says how it could be asked
	const without = await boot({page: 'book.html', hash: '#add'});
	without.els.f_from.value = 'https://audiobookdb.org/releases/RlsLntrnUS01';
	await without.ctx.fillFromCatalog();
	assert.match(
		without.els.formError.textContent,
		/AudiobookDB can't be read from a web page; to ask it through your own proxy, save a catalog proxy on the Import & export page first\.$/,
	);
});

test('a new book is filled in from another catalog: only its empty fields, and the edition', async () => {
	const catalogs = fakeCatalogs();
	const storage = new Map();
	const {ctx, els, get} = await boot({page: 'book.html', hash: '#add', catalogs: catalogs.fetch, storage});
	// what was typed stays
	els.f_t.value = 'My Own Title';
	typeEdition(els, 0, 'desc', 'UK edition');
	els.f_from.value = 'https://openlibrary.org/books/OL901M/The_lantern_keeper';
	let prevented = false;
	els.f_from.dispatch('keydown', {
		key: 'Enter',
		preventDefault() {
			prevented = true;
		},
	});
	assert.ok(prevented, 'Enter looks it up, and does not save the book');
	await idle();
	await settle();
	await settle();
	assert.equal(els.f_t.value, 'My Own Title');
	assert.equal(els.f_a.value, 'Ann Vale');
	assert.equal(els.f_s.value, 'Gull Isle');
	assert.equal(els.f_sn.value, '2');
	assert.equal(els.f_ext_openlibrary.value, 'OL900W');
	assert.equal(els.f_idsNote.textContent, '(Open Library)');
	assert.deepEqual(formEditions(get), [
		{
			desc: 'UK edition',
			n: 'Hollis Marr',
			'ext:amazon.com': 'B0LANTERN2',
			'ext:goodreads': '5151',
			'ext:openlibrary': 'OL901M',
			isbn: '9780000000019',
			p: 'Gullwing Audio',
			d: '2021-03-04',
		},
	]);
	assert.match(
		els.ioStatus.textContent,
		/^Filled in from Open Library: authors, series, number in the series, the book's id in another catalog, an edition\. \(to fill in narrators and length from Hardcover too/,
	);
	assert.equal(els.f_from.value, '');
	assert.equal(els.formError.textContent, '');
	// Wikidata adds what is still missing, and its ids where the form has none
	els.f_from.value = 'Q9001';
	await ctx.fillFromCatalog();
	assert.equal(els.formError.textContent, '');
	assert.equal(els.f_g.value, 'fantasy');
	assert.equal(els.f_ext_wikidata.value, 'Q9001');
	assert.equal(els.f_ext_goodreads.value, '7171');
	assert.equal(els.f_ext_openlibrary.value, 'OL900W');
	assert.match(els.ioStatus.textContent, /^Filled in from Wikidata: genres, the book's ids in other catalogs\.$/);
	// again, nothing is left to fill in
	els.f_from.value = 'Q9001';
	await ctx.fillFromCatalog();
	assert.match(els.ioStatus.textContent, /^Found on Wikidata, but the form already has all it gives\./);
	// what can't be looked up says why, and keeps what was pasted
	els.f_from.value = 'https://www.audible.com/pd/B0TIDEWAT1';
	await ctx.fillFromCatalog();
	assert.match(
		els.formError.textContent,
		/^Couldn't fill in the book: Audible and AudiobookDB can't be read from a web page; to look it up on Hardcover, save your Hardcover API token/,
	);
	assert.equal(els.f_from.value, 'https://www.audible.com/pd/B0TIDEWAT1');
	// saved, the book has it all
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	const [added] = get('CATALOG.books');
	assert.deepEqual(JSON.parse(JSON.stringify(added)).ext, {
		goodreads: '7171',
		openlibrary: 'OL900W',
		wikidata: 'Q9001',
	});
	assert.equal(added.e[0].isbn, '9780000000019');
	assert.ok(catalogs.sent.length > 0);
});

test("the book form fills in from Hardcover with the token saved, by an Audible page's ASIN", async () => {
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn, ms) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const {ctx, els, get} = await boot({
		page: 'book.html',
		hash: '#add',
		hardcover: hc.fetch,
		catalogs: fakeCatalogs().fetch,
		setTimeout,
		storage,
	});
	els.f_from.value = 'https://www.audible.com/pd/Tidewater-Audiobook/B0TIDEWAT1';
	await ctx.fillFromCatalog();
	assert.equal(els.f_t.value, 'Tidewater');
	assert.equal(els.f_a.value, 'Ann Vale');
	assert.equal(els.f_hcb.value, '77');
	assert.deepEqual(formEditions(get), [
		{
			n: 'Hollis Marr',
			'ext:audible.com': 'B0TIDEWAT1',
			'ext:amazon.com': 'B0TIDEWAT1',
			'ext:hardcover': '501',
			len: '10h',
		},
	]);
	assert.match(
		els.ioStatus.textContent,
		/^Filled in from Hardcover: title, authors, series, number in the series, the book's id in another catalog, an edition\.$/,
	);
});

test('a new book starts with the series it is added to and the author picked', async () => {
	const {ctx, get, els, storage} = await boot();
	const orchard = seriesIdOf(get, 'The Orchard Cycle');
	ctx.openSeries(orchard);
	await idle();
	const form = async href => {
		assert.match(href, /^book\.html#/);
		const page = await boot({page: 'book.html', hash: href.slice('book.html'.length), storage});
		return [page.els.f_s.value, page.els.f_a.value];
	};
	// a series: its name, and the authors of all its books
	assert.deepEqual(await form(els.toggleAdd.getAttribute('href')), ['The Orchard Cycle', 'Wendell Ashcombe']);
	// all books: nothing, unless an author is picked
	const books = await boot({page: 'books.html', storage});
	assert.deepEqual(await form(books.els.toggleAdd.getAttribute('href')), ['', '']);
	books.els.authorFilter.value = 'Priya Ostrander';
	books.els.authorFilter.listeners.change[0]();
	await idle();
	assert.equal(books.els.toggleAdd.getAttribute('href'), 'book.html#add&author=Priya+Ostrander');
	assert.deepEqual(await form(books.els.toggleAdd.getAttribute('href')), ['', 'Priya Ostrander']);
});

test('an address pasted in an edition id field becomes the id when the field is left', async () => {
	const {els, get} = await boot({page: 'book.html', hash: '#add'});
	const field = k => els.f_editions.querySelector(`input[data-i="0"][data-k="${k}"]`);
	const leave = (k, value) => {
		const input = field(k);
		input.value = value;
		typeEdition(els, 0, k, value);
		input.dispatch('focusout', {relatedTarget: field('isbn')});
		return input;
	};
	// the field's own id
	assert.equal(leave('ext:goodreads', 'https://www.goodreads.com/book/show/4242-the-salt-road').value, '4242');
	assert.equal(leave('ext:hardcover', 'https://hardcover.app/books/the-salt-road/editions/501').value, '501');
	assert.equal(
		leave('ext:audible.com', 'https://www.audible.com/pd/The-Salt-Road-Audiobook/B0SALTROAD?qid=1').value,
		'B0SALTROAD',
	);
	// another site's page: its ASIN goes to that site's field, which is added
	assert.equal(leave('ext:audible.com', 'https://www.amazon.co.uk/dp/B0SALTUK01').value, '');
	assert.equal(field('ext:amazon.co.uk').getAttribute('value'), 'B0SALTUK01');
	// and so does another catalog's release, AudiobookDB's
	assert.equal(leave('ext:goodreads', 'https://audiobookdb.org/releases/Kx7UDyK3gMqj').value, '');
	assert.equal(field('ext:audiobookdb').getAttribute('value'), 'Kx7UDyK3gMqj');
	assert.deepEqual(get('FORM_EDITIONS[0].fields'), {
		'ext:goodreads': '',
		'ext:hardcover': '501',
		'ext:audible.com': '',
		'ext:amazon.co.uk': 'B0SALTUK01',
		'ext:audiobookdb': 'Kx7UDyK3gMqj',
	});
	// a site whose field holds another ASIN keeps the address, for Save to report
	assert.equal(
		leave('ext:audible.com', 'https://www.amazon.co.uk/dp/B0OTHER001').value,
		'https://www.amazon.co.uk/dp/B0OTHER001',
	);
	// anything else is left as typed
	assert.equal(leave('ext:goodreads', 'not an address').value, 'not an address');
});

test('dates read: shown on the card, edited in the form, and filterable by year', async () => {
	const {ctx, els, storage} = await boot({page: 'books.html'});
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
	assert.equal(cards(els.results.innerHTML), inYear.length);
	els.readFilter.value = '__undated__';
	await ctx.refreshView();
	await idle();
	assert.equal(cards(els.results.innerHTML), demoBooks.filter(b => !b.r).length);

	// edit: the form shows the dates; they are tidied, sorted and de-duplicated on save
	const book = await bootBook(dated.t, {storage});
	const id = book.get('BOOK_FILTER');
	const f = book.els;
	book.ctx.openEditForm(id);
	assert.equal(f.f_r.value, dated.r.join(', '));
	f.f_r.value = '2026/9/1, 2021, 2026-09-01';
	f.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.deepEqual(book.get('CATALOG.books[0].read'), ['2021', '2026-09-01']);

	// "+ Read today" appends today's date once
	book.ctx.openEditForm(id);
	f.readTodayBtn.listeners.click[0]();
	await idle();
	f.readTodayBtn.listeners.click[0]();
	await idle();
	const today = book.get('today()');
	assert.equal(f.f_r.value, `2021, 2026-09-01, ${today}`);

	// a bad date is refused with a message, and nothing changes
	f.f_r.value = '2026-02-30';
	f.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.match(f.formError.textContent, /Not a date: 2026-02-30/);
	assert.deepEqual(book.get('CATALOG.books[0].read'), ['2021', '2026-09-01']);

	// clearing the field removes the dates
	f.f_r.value = '';
	f.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.equal(book.get('CATALOG.books[0].read.length > 0'), false);
});

test("an edition's own title: shown on the book page, found by the search, and kept or made the book's in the form", async () => {
	const mine = JSON.stringify([
		{
			t: 'The Lantern Keeper',
			a: ['Ann Vale'],
			e: [
				{ext: {'audible.co.uk': 'B0UKLAMP01'}},
				{t: 'The Keeper of Lanterns', ext: {'audible.com': 'B0USLAMP01'}},
			],
		},
		{t: 'Other', a: ['Ann Vale']},
	]);
	const {els, get, ctx, readable, storage} = await bootBook('The Lantern Keeper', {files: {'books.json': mine}});
	assert.match(
		readable(els.results.innerHTML),
		/<h2 class="title">The Lantern Keeper<\/h2><div class="alsoTitled">Also published as <cite>The Keeper of Lanterns<\/cite><\/div>/,
	);
	assert.match(readable(els.results.innerHTML), /<dt>Title<\/dt><dd>The Keeper of Lanterns<\/dd>/);

	// the search finds it by either title; the card names the other title only when that is what was found
	const list = await boot({page: 'books.html', storage});
	list.els.q.value = 'keeper of lanterns';
	await list.ctx.refreshView();
	await idle();
	assert.equal(cards(list.els.results.innerHTML), 1);
	assert.match(list.els.results.innerHTML, /Also published as <cite>The Keeper of Lanterns<\/cite>/);
	list.els.q.value = 'lantern keeper';
	await list.ctx.refreshView();
	await idle();
	assert.equal(cards(list.els.results.innerHTML), 1);
	assert.doesNotMatch(list.els.results.innerHTML, /Also published as/);

	// the form: the US edition's Title made the book's, the UK edition gets the book's title before
	ctx.openEditForm(get('BOOK_FILTER'));
	assert.deepEqual(formEditions(get), [
		{'ext:audible.co.uk': 'B0UKLAMP01'},
		{t: 'The Keeper of Lanterns', 'ext:audible.com': 'B0USLAMP01'},
	]);
	useEditionTitle(els, 1);
	assert.equal(els.f_t.value, 'The Keeper of Lanterns');
	assert.deepEqual(formEditions(get), [
		{'ext:audible.co.uk': 'B0UKLAMP01', t: 'The Lantern Keeper'},
		{t: '', 'ext:audible.com': 'B0USLAMP01'},
	]);
	// a title that is the book's (a subtitle aside) is no title of the edition's own
	typeEdition(els, 1, 't', 'The Keeper of Lanterns: A Novel');
	els.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.deepEqual(get('CATALOG.book(BOOK_FILTER)'), {
		t: 'The Keeper of Lanterns',
		a: ['Ann Vale'],
		e: [{t: 'The Lantern Keeper', ext: {'audible.co.uk': 'B0UKLAMP01'}}, {ext: {'audible.com': 'B0USLAMP01'}}],
	});
});

test("ISBNs: shown in a book's details, searchable however typed, edited in the form", async () => {
	// written before editions: read as the book's first edition
	const mine = JSON.stringify([
		{t: 'Boxed One', a: ['Ann Vale'], isbn: ['9780306406157']},
		{t: 'Other', a: ['Ann Vale']},
	]);
	const {els, get, ctx, readable, storage} = await bootBook('Boxed One', {files: {'books.json': mine}});
	assert.match(readable(els.results.innerHTML), /<dt>ISBN<\/dt><dd>9780306406157<\/dd>/);
	const list = await boot({page: 'books.html', storage});
	for (const q of ['9780306406157', '0-306-40615-2', '406157']) {
		list.els.q.value = q;
		await list.ctx.refreshView();
		await idle();
		assert.equal(cards(list.els.results.innerHTML), 1, q);
	}

	ctx.openEditForm(get('BOOK_FILTER'));
	assert.deepEqual(formEditions(get), [{isbn: '9780306406157'}]);
	// another ISBN is another edition
	typeEdition(els, 0, 'isbn', '9780306406157, 978-0-00-000000-2');
	els.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.deepEqual(get('CATALOG.books[0].editions'), [{isbn: '9780306406157'}, {isbn: '9780000000002'}]);

	// the same ISBN may go on another book (a boxed set); its details then say so
	const other = await bootBook('Other', {storage});
	const o = other.els;
	other.ctx.openEditForm(other.get('BOOK_FILTER'));
	typeEdition(o, 0, 'isbn', '0306406152');
	o.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.deepEqual(other.get('CATALOG.book(BOOK_FILTER).editions'), [{isbn: '9780306406157'}]);
	assert.match(
		other.readable(o.results.innerHTML),
		/<dt>Also in this edition<\/dt><dd><a href="#book=Boxed\+One">Boxed One<\/a><\/dd>/,
	);

	// a mistyped ISBN is refused with a message, and nothing changes
	other.ctx.openEditForm(other.get('BOOK_FILTER'));
	typeEdition(o, 0, 'isbn', '9780306406158');
	o.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.match(o.formError.textContent, /Not understood: edition 1: ISBN 9780306406158/);
	assert.deepEqual(other.get('CATALOG.book(BOOK_FILTER).editions'), [{isbn: '9780306406157'}]);
	typeEdition(o, 0, 'isbn', '');
	typeEdition(o, 0, 'ext:goodreads', 'twelve');
	typeEdition(o, 0, 'd', 'someday');
	o.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.match(
		o.formError.textContent,
		/Not understood: edition 1: Goodreads edition twelve; edition 1: Released someday/,
	);
	// removing the only card leaves an empty one, which is no edition
	removeEdition(o, 0);
	assert.deepEqual(formEditions(other.get), [{}]);
	o.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.equal(other.get('CATALOG.book(BOOK_FILTER).editions.length > 0'), false);
});

test("narrators and descriptions live on editions: the card names the narrators, the details each edition's, searchable, edited in the form", async () => {
	const {els, readable, storage} = await boot({page: 'books.html'});
	const salt = demoBooks.find(b => b.t === 'The Salt Road');
	assert.ok(
		salt.e.some(ed => ed.desc),
		'the demo data has an edition with a description',
	);
	// both narrators on the book; with different narrators each edition names its own
	assert.match(
		readable(els.results.innerHTML),
		/narr\. <a href="narrator\.html#n=Tobias\+Frane">Tobias Frane<\/a> \/ <a href="narrator\.html#n=Hollis\+Marr">Hollis Marr<\/a>/,
	);
	assert.doesNotMatch(readable(els.results.innerHTML), /UK edition/, 'the card leaves editions out');
	for (const q of ['hollis marr', 'uk edition']) {
		const found = await boot({page: 'books.html', storage, hash: '#q=' + hashValue(q)});
		assert.equal(cards(found.els.results.innerHTML), 1, q);
	}
	const book = await bootBook('The Salt Road', {storage});
	const b = book.els;
	assert.match(
		book.readable(b.results.innerHTML),
		/<h3>Edition 1<\/h3><dl class="details"><dt>Narrated by<\/dt><dd><a href="narrator\.html#n=Tobias\+Frane">Tobias Frane<\/a><\/dd><dt>ASIN/,
	);
	assert.match(
		book.readable(b.results.innerHTML),
		/<h3>Edition 2: UK edition<\/h3><dl class="details"><dt>Narrated by<\/dt><dd><a href="narrator\.html#n=Hollis\+Marr">Hollis Marr<\/a><\/dd><dt>ASIN/,
	);

	book.ctx.openEditForm(book.get('BOOK_FILTER'));
	assert.equal(formEditions(book.get)[0].n, 'Tobias Frane');
	assert.equal(formEditions(book.get)[0]['ext:audible.com'], 'SAMPLE0001');
	assert.equal(formEditions(book.get)[0]['ext:amazon.com'], 'SAMPLE0201');
	addEdition(b);
	typeEdition(b, 2, 'desc', 'Dramatized adaptation; unabridged');
	typeEdition(b, 2, 'n', 'A full cast');
	typeEdition(b, 2, 'ext:goodreads', '777');
	b.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.deepEqual(book.get('CATALOG.books[0].editions[2]'), {
		ext: {goodreads: '777'},
		n: ['A full cast'],
		desc: 'Dramatized adaptation; unabridged',
	});
});

test('box sets: kept as their own book, last in the series, and not counted as one more title', async () => {
	const {ctx, els, get} = await boot();
	ctx.openSeries(seriesIdOf(get, 'The Orchard Cycle'));
	await idle();
	const titles = [...els.results.innerHTML.matchAll(/<div class="title"><a [^>]*>([^<]+)<\/a>/g)].map(m => m[1]);
	assert.deepEqual(titles, [
		'The Brass Orchard',
		'The Copper Graft',
		'Harvest of Gears',
		'The Orchard Cycle: Books 2-3',
	]);
	assert.match(els.results.innerHTML, /<span class="n">3 owned \+ 1 box set<\/span>/);
	ctx.openSeries(null);
	await idle();
	assert.match(els.results.innerHTML, /The Orchard Cycle<\/a>\s*<span class="srow-owned">3 owned<\/span>/);
});

test('box sets: the edition shows on each of its books, and editing it on one edits it on all', async () => {
	const {ctx, els, get, readable, follow, storage} = await bootBook('The Copper Graft');
	assert.match(
		readable(els.results.innerHTML),
		/<h3>Edition: The Orchard Cycle: Books 2-3<\/h3><dl class="details"><dt>Narrated by<\/dt><dd><a [^>]*>Ingrid Voss<\/a><\/dd><dt>ASIN<\/dt><dd>audible.com <a [^>]*>SAMPLE0008<\/a><\/dd><dt>ISBN<\/dt><dd>9780306406157<\/dd><dt>Publisher<\/dt><dd><a [^>]*>Kestrel Row Audio<\/a><\/dd><dt>Released<\/dt><dd>2022-11<\/dd><dt>Length<\/dt><dd>23h 5m<\/dd>/,
	);
	assert.match(
		readable(els.results.innerHTML),
		/<dt>Also in this edition<\/dt><dd><a href="#book=Harvest\+of\+Gears">Harvest of Gears #3<\/a>/,
	);
	const copper = get('BOOK_FILTER'),
		harvest = bookIdOf(get, 'Harvest of Gears');
	follow(`#book=${harvest}`);
	await idle();
	assert.match(
		readable(els.results.innerHTML),
		/<dt>Also in this edition<\/dt><dd><a href="#book=The\+Copper\+Graft">The Copper Graft #2<\/a>/,
	);
	const list = await boot({page: 'books.html', storage, hash: '#q=kestrel+row'});
	assert.equal(cards(list.els.results.innerHTML), 3, "search finds a publisher (the box set's own book too)");

	ctx.history.back();
	await idle();
	ctx.openEditForm(copper);
	assert.match(
		readable(els.f_editions.innerHTML),
		/Also on Harvest of Gears, The Orchard Cycle: Books 2-3: changes here change it there too/,
	);
	typeEdition(els, 0, 'p', 'Merlin Lane Audio');
	els.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.equal(get(`CATALOG.book(${JSON.stringify(harvest)}).editions[0].publisher`), 'Merlin Lane Audio');
	assert.match(els.ioStatus.textContent, /Also updated the shared edition on 2 other books/);
});

test('a Goodreads import adds the ISBN to the edition of books already there', async () => {
	const mine = JSON.stringify([{t: 'Old Favorite', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}], r: ['2020']}]);
	const {els, get, readable} = await boot({page: 'import.html', files: {'books.json': mine}});
	const csv =
		'Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf,Date Read\n' +
		'Old Favorite,Ann Vale,"=""0306406152""","=""9780306406157""",Audible Audio,read,2023/11/04\n';
	els.goodreadsImportBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'goodreads.csv', text: csv}], value: ''}});
	await idle();
	const html = readable(els.importPreviewBody.innerHTML);
	// the edition picked on Goodreads may not be yours: it is left out unless ticked
	assert.match(
		html,
		/Goodreads has more \(1\)<\/h4>.*<span class="cmpBook">Old Favorite — Ann Vale<\/span><ul><li><label class="cmpPick"><input type="checkbox" data-pick="editions:0"> the Goodreads edition: ISBN<\/label>/,
	);
	// the book has a date read already, so the other one is a difference to tick, not a gain
	assert.match(
		html,
		/Different in both \(1\)<\/h4>.*data-pick="patch:0:r"> Dates read: <span class="cmpHere">2020<\/span> here, <span class="cmpThere">2023-11-04<\/span> on Goodreads/,
	);
	assert.equal(els.importConfirm.style.display, 'none', 'nothing ticked');
	const edition = els.importPreviewBody.querySelector('input[data-pick="editions:0"]');
	edition.checked = true;
	edition.dispatch('change');
	assert.equal(els.importConfirm.textContent, 'Apply 1 change');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books[0].editions'), [{ext: {'audible.com': 'B1'}, isbn: '9780306406157'}]);
	assert.deepEqual(get('CATALOG.books[0].read'), ['2020'], 'a value this catalog has is only replaced when ticked');
	assert.match(els.ioStatus.textContent, /added ISBNs to 1 book/);
});

test('authors are lists: the author filter offers each author on its own, and the form edits them as text', async () => {
	const {ctx, els, readable, storage} = await boot({page: 'books.html'});
	const nine = demoBooks.find(b => b.t === 'Nine Ways to Lose a Kingdom');
	assert.deepEqual(nine.a, ['Ferran Doyle', 'Priya Ostrander'], 'the demo data has a book with two authors');
	assert.match(readable(els.authorFilter.innerHTML), /<option value="Priya Ostrander">Priya Ostrander<\/option>/);
	assert.doesNotMatch(readable(els.authorFilter.innerHTML), /Ferran Doyle, Priya Ostrander/);
	assert.equal((readable(els.authorFilter.innerHTML).match(/<option value="Priya Ostrander">/g) || []).length, 1);
	// each author's name links to their page
	assert.match(
		readable(els.results.innerHTML),
		/<div class="meta"><a href="author\.html#a=Ferran\+Doyle">Ferran Doyle<\/a>, <a href="author\.html#a=Priya\+Ostrander">Priya Ostrander<\/a><\/div>/,
	);
	els.authorFilter.value = 'Priya Ostrander';
	await ctx.refreshView();
	await idle();
	assert.equal(cards(els.results.innerHTML), 3, 'her two books and the one she co-wrote');

	const book = await bootBook(nine.t, {storage});
	book.ctx.openEditForm(book.get('BOOK_FILTER'));
	assert.equal(book.els.f_a.value, 'Ferran Doyle, Priya Ostrander');
	book.els.f_a.value = 'Ferran Doyle & Cass Merriweather';
	book.els.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.deepEqual(book.get('CATALOG.book(BOOK_FILTER).authors'), ['Ferran Doyle', 'Cass Merriweather']);

	// authors and narrators written as comma separated text, from before, load as lists
	const mine = JSON.stringify([
		{t: 'Old Style', a: 'Ann Vale, Bo Reed', e: [{ext: {'audible.com': 'B1'}, n: 'Cy Hale, Di Moss'}]},
	]);
	const old = await boot({page: 'books.html', files: {'books.json': mine}});
	assert.deepEqual((await kept(old.storage)).books, [
		{t: 'Old Style', a: ['Ann Vale', 'Bo Reed'], e: [{ext: {'audible.com': 'B1'}, n: ['Cy Hale', 'Di Moss']}]},
	]);
	await idle();
	assert.match(old.readable(old.els.authorFilter.innerHTML), /<option value="Bo Reed">/);
	assert.match(
		old.readable(old.els.results.innerHTML),
		/Ann Vale<\/a>, <a [^>]*>Bo Reed<\/a> — narr\. <a href="narrator\.html#n=Cy\+Hale">Cy Hale<\/a>, <a href="narrator\.html#n=Di\+Moss">Di Moss<\/a><\/div>/,
	);
});

test('with no catalog in this browser it starts empty, not with the demo, and says where books come from', async () => {
	const {els, get, run, storage} = await boot({files: null});
	await idle();
	assert.deepEqual(get('CATALOG.books'), []);
	assert.deepEqual(get('CATALOG.toJSON().seriesInfo'), {});
	assert.equal(els.subtitle.textContent, 'Your catalog is empty');
	assert.match(els.results.innerHTML, /No books yet\. .*<a href="import\.html">Import &amp; export<\/a>/);
	assert.equal(await kept(storage), null, 'nothing is stored before the first edit');
	run("CATALOG.books.push(new Book({ title: 'First', authors: ['Me'] }))");
	await run('persist()');
	assert.deepEqual(await kept(storage), {
		books: [{t: 'First', a: ['Me']}],
		seriesInfo: {},
		authors: {},
		narrators: {},
		publishers: {},
		excluded: [],
		notDuplicates: [],
	});
});

test('the catalog is kept in this browser, from one page load to the next', async () => {
	// (on the Duplicates page, which holds the whole catalog)
	const first = await boot({page: 'duplicates.html'});
	first.run("CATALOG.books[0].title = 'Edited Locally'");
	await first.run('persist()');
	const again = await boot({storage: first.storage, page: 'duplicates.html'});
	assert.equal(again.get('CATALOG.books[0].title'), 'Edited Locally');
	assert.equal(again.get('CATALOG.books.length'), demoBooks.length);
	assert.deepEqual(
		again.withIds('CATALOG.books.map(b => b.id)'),
		first.withIds('CATALOG.books.map(b => b.id)'),
		'each book keeps its id',
	);
});

test('records saved before ids were kept by external catalog are read, and saved again the current way', async () => {
	const storage = new Map();
	const {database} = await boot({storage});
	await kept(storage);
	// make the stored records look as the app before this one wrote them
	const stores = database.data.get('audiobook-catalog').stores;
	for (const {value} of stores.get('editions').records.values()) {
		const {external = {}} = value;
		delete value.external;
		value.asins = Object.fromEntries(Object.entries(external).filter(([k]) => k.includes('.')));
		if (external.goodreads) value.goodreadsId = external.goodreads;
	}
	for (const {value} of stores.get('contributors').records.values()) {
		if (value.external && value.external.hardcover)
			value.hardcover = `https://hardcover.app/authors/${value.external.hardcover}`;
		delete value.external;
		delete value.externalKeys;
	}
	for (const {value} of stores.get('books').records.values()) delete value.externalKeys;
	const revision = database.records('meta').find(m => m.key === 'revision').value;
	const again = await boot({storage, page: 'duplicates.html'});
	await kept(storage);
	assert.ok(database.records('meta').find(m => m.key === 'revision').value > revision, 'saved again at once');
	assert.ok(database.records('editions').every(ed => ed.external && !ed.asins));
	assert.ok(database.records('books').every(b => Array.isArray(b.externalKeys)));
	assert.deepEqual(again.get('CATALOG.books'), demoBooks);
	assert.deepEqual(
		again.get("CATALOG.infoByName('authors').get('Marisol Quenby').external.hardcover"),
		'marisol-quenby-sample',
	);
});

test('the catalog localStorage kept is moved to IndexedDB on the first load, and kept aside as it was', async () => {
	const storage = new Map();
	const {get, withIds, database} = await boot({
		storage,
		page: 'duplicates.html',
		files: {...DEMO, 'not-duplicates.txt': 'x\n'},
	});
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
	for (const ed of shared)
		for (const id of ed.bookIds)
			assert.ok(
				database
					.records('books')
					.find(b => b.id === id)
					.editionIds.includes(ed.id),
			);
	assert.deepEqual(get('CATALOG.books'), demoBooks);
	assert.ok(
		withIds('CATALOG.books').every(b => b.uid),
		'every book has its id',
	);
	// a second load reads IndexedDB, not what localStorage has now
	storage.set(CATALOG_KEY, JSON.stringify({books: [{t: 'Not this', a: ['Me']}]}));
	const again = await boot({storage, page: 'duplicates.html'});
	assert.equal(again.get('CATALOG.books.length'), demoBooks.length);
});

test('a catalog with values that are not what their field holds is shown but not moved, until fixed', async () => {
	const storage = new Map([[CATALOG_KEY, JSON.stringify({books: [{t: 'Odd', a: ['Me'], g: 5, x: 1}]})]]);
	const {get, els} = await boot({storage, files: null});
	assert.equal(get('CATALOG.books[0].title'), 'Odd', 'the page shows it');
	assert.equal(await kept(storage), null, 'nothing is written');
	assert.ok(storage.has(CATALOG_KEY), 'localStorage still has it');
	assert.match(els.ioStatus.textContent, /^Not saved: these values can't be kept.*book #0 \('Odd'\): 'g', 'x'/);
});

test('without IndexedDB the page shows the catalog localStorage has, and says nothing is saved', async () => {
	const storage = new Map();
	databaseOf(storage).broken = true;
	const {get, els, run} = await boot({storage});
	assert.deepEqual(get('CATALOG.books'), demoBooks);
	assert.match(els.ioStatus.textContent, /^Not saved: this browser won't keep the catalog/);
	await run('persist()');
	assert.match(els.ioStatus.textContent, /^Not saved/);
	assert.ok(storage.has(CATALOG_KEY), 'what localStorage has stays');
});

test('a stored catalog that does not fit together is set aside, and the catalog starts empty', async () => {
	const storage = new Map();
	const first = await boot({storage});
	await first.saved();
	// a book that lists an edition there is no record of
	const {db} = await new Promise(resolve => {
		const req = first.database.open('audiobook-catalog', 4);
		req.onsuccess = () => resolve({db: req.result});
	});
	await new Promise(resolve => {
		const tx = db.transaction('editions', 'readwrite');
		tx.objectStore('editions').clear();
		tx.oncomplete = resolve;
	});
	// (a page that reads all of it finds out)
	const {get, els, database} = await boot({storage, page: 'duplicates.html'});
	assert.deepEqual(get('CATALOG.books'), []);
	assert.match(els.ioStatus.textContent, /set aside/);
	const aside = database.records('meta').find(m => m.key === 'unreadable');
	assert.equal(aside.value.books.length, demoBooks.length, 'what was stored is kept');
	assert.equal(database.records('books').length, 0);
});

test("a series' site, from before authors kept their own, goes to its author when the page opens", async () => {
	const storage = new Map();
	const first = await boot({storage});
	await first.saved();
	// a database of version 3, whose series kept a site
	const {db} = await new Promise(resolve => {
		const req = first.database.open('audiobook-catalog', 4);
		req.onsuccess = () => resolve({db: req.result});
	});
	const series = first.database.records('series').find(x => x.name === 'The Lantern Coast');
	await new Promise(resolve => {
		const tx = db.transaction('series', 'readwrite');
		tx.objectStore('series').put({...series, url: 'https://example.com/lantern'});
		tx.oncomplete = resolve;
	});
	first.database.data.get('audiobook-catalog').version = 3;
	// a page that shows only a slice still finds it moved
	const {database} = await boot({storage, page: 'books.html'});
	const stored = await kept(storage);
	assert.deepEqual(stored.seriesInfo['The Lantern Coast'], {
		total: 5,
		status: 'ongoing',
		note: 'book 5 is announced (fictional demo data)',
		ext: {goodreads: '90001', hardcover: 'the-lantern-coast-sample'},
	});
	assert.deepEqual(
		[stored.authors['Marisol Quenby'].url, stored.authors['Marisol Quenby'].links],
		['https://example.com/', ['https://example.com/lantern']],
	);
	assert.ok(!('url' in database.records('series').find(x => x.name === 'The Lantern Coast')));
	assert.equal(
		database.records('meta').some(m => m.key === 'reshape'),
		false,
	);
});

test("a catalog this browser can't read is set aside, not overwritten", async () => {
	const {get, els, storage} = await boot({storage: new Map([[CATALOG_KEY, '{not json']])});
	assert.deepEqual(get('CATALOG.books'), []);
	assert.equal(storage.get(CATALOG_KEY + '.unreadable'), '{not json');
	assert.equal(storage.has(CATALOG_KEY), false);
	assert.match(els.ioStatus.textContent, /set aside/);
});

test('importing an Audible CSV previews first, then adds only new books', async () => {
	const mine = JSON.stringify([{t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5'}]);
	const {els, get, readable} = await boot({
		page: 'import.html',
		files: {'books.json': mine, 'excluded.txt': 'BGONE\n'},
	});
	const csv =
		'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\n' +
		'x,A Crown of Embers 5: A Spark of Dawn,A Crown of Embers Series (book 5),Ilse Marlowe,,Finished,B5\n' +
		'x,A Crown of Embers 6: Ashfall,A Crown of Embers Series (book 6),Ilse Marlowe,A.B. Quill,Finished,B6\n' +
		'x,Removed,,Ilse Marlowe,,Finished,BGONE\n' +
		'x,Half Way,,Ilse Marlowe,,2h left,B7\n';
	els.audibleImportBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'library.csv', text: csv}], value: ''}});
	await idle();

	// preview: nothing changed yet
	assert.ok(els.importPreview.classList.contains('open'));
	assert.equal(els.importPreviewTitle.textContent, 'Compare with Audible');
	assert.equal(els.importPreview.place, 'after audiblePanel'); // under the panel that asked for it
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(
		html,
		/<p>1 new, 1 with more to give, 0 with values that differ, 0 the same as in this catalog\.<\/p>/,
	);
	assert.match(
		html,
		/New from Audible \(1\)<\/h4><ul class="cmpRows"><li><label class="cmpPick"><input type="checkbox" data-pick="take:1" checked=""> A Crown of Embers 6: Ashfall — Ilse Marlowe {2}\[A Crown of Embers #6\]/,
	);
	// Audible's edition is the one you have: ticked
	assert.match(
		html,
		/Audible has more \(1\)<\/h4>.*A Spark of Dawn — Ilse Marlowe {2}\[A Crown of Embers #5\]<\/span><ul><li><label class="cmpPick"><input type="checkbox" data-pick="editions:0" checked=""> the Audible edition: an edition \(ASIN audible\.com B5\)/,
	);
	assert.doesNotMatch(html, /Different in both/, 'the long form of a title is the same title');
	assert.match(html, /Skipped \(excluded from imports\): 1<\/p><ul><li>Removed — Ilse Marlowe/);
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');
	assert.equal(get('CATALOG.books.length'), 1);

	els.importConfirm.listeners.click[0]();
	await idle();
	assert.ok(!els.importPreview.classList.contains('open'));
	assert.deepEqual(get('CATALOG.books'), [
		{t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5', e: [{ext: {'audible.com': 'B5'}}]},
		{
			t: 'A Crown of Embers 6: Ashfall',
			a: ['Ilse Marlowe'],
			s: 'A Crown of Embers',
			sn: '6',
			e: [{ext: {'audible.com': 'B6'}, n: ['A. B. Quill']}],
		},
	]);
	assert.match(els.ioStatus.textContent, /Added 1 book, filled in 1 ASIN/);

	// the same file again: nothing to add, nothing to confirm
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'library.csv', text: csv}], value: ''}});
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /0 new, 0 with more to give, 0 with values that differ, 2 the same/);
	assert.match(els.importPreviewBody.innerHTML, /Nothing to take or send: both have the same\./);
	assert.equal(els.importConfirm.style.display, 'none');
});

test('a date read written as a plain string loads, renders, and round-trips through Export / Import', async () => {
	const mine = JSON.stringify([
		{t: 'Hand Edited', a: ['Ann Vale'], r: '2024-03-15'},
		{t: 'Odd', a: ['Ann Vale'], r: 5},
	]);
	const {els} = await boot({page: 'books.html', files: {'books.json': mine}});
	assert.match(els.results.innerHTML, /Read 2024-03-15/);
	assert.match(els.readFilter.innerHTML, /Read in 2024/);

	const backup = JSON.stringify({books: [{t: 'From Backup', a: ['Ann Vale'], r: '2023-01-05'}], seriesInfo: {}});
	const storage = new Map();
	const imp = await boot({page: 'import.html', files: {'books.json': mine}, storage});
	await imp.els.importFile.listeners.change[0]({target: {files: [{name: 'b.json', text: backup}], value: ''}});
	await idle();
	assert.doesNotMatch(imp.els.ioStatus.textContent, /Couldn't read/);
	assert.deepEqual(imp.get('CATALOG.books'), [{t: 'From Backup', a: ['Ann Vale'], r: ['2023-01-05']}]);
	await imp.saved();
	// back on the books page
	const back = await boot({page: 'books.html', files: {'books.json': mine}, storage});
	assert.match(back.els.results.innerHTML, /Read 2023-01-05/);
});

test('a Goodreads import fills in dates read on books that have none', async () => {
	const mine = JSON.stringify([{t: 'Old Favorite', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}]}]);
	const {els, get} = await boot({page: 'import.html', files: {'books.json': mine}});
	const csv =
		'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n' +
		'Old Favorite,Ann Vale,,Audible Audio,read,,2023/11/04\n';
	els.goodreadsImportBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'goodreads.csv', text: csv}], value: ''}});
	await idle();
	assert.match(
		els.importPreviewBody.innerHTML,
		/Old Favorite — Ann Vale<\/label><ul><li>read 2023-11-04<\/li><\/ul>/,
	);
	assert.equal(els.importConfirm.textContent, 'Apply 1 change');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books'), [
		{t: 'Old Favorite', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}], r: ['2023-11-04']},
	]);
	assert.match(els.ioStatus.textContent, /filled in dates read on 1 book/);
});

test('importing a Goodreads CSV can be canceled', async () => {
	const {els, get} = await boot({page: 'import.html'});
	const before = demoBooks.length;
	const csv =
		'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\n' +
		'"Zzz New Book (Zzz Saga, #2)",Nobody Yet,,Audible Audio,read,fantasy\n';
	els.goodreadsImportBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'goodreads.csv', text: csv}], value: ''}});
	await idle();
	assert.equal(els.importPreviewTitle.textContent, 'Compare with Goodreads');
	assert.equal(els.importPreview.place, 'after goodreadsPanel');
	assert.match(els.importPreviewBody.innerHTML, /Zzz New Book — Nobody Yet {2}\[Zzz Saga #2\]/);
	els.importCancel.listeners.click[0]();
	await idle();
	assert.ok(!els.importPreview.classList.contains('open'));
	assert.equal(get('CATALOG.books.length'), before);
	els.importConfirm.listeners.click[0](); // a stale click after cancelling does nothing
	assert.equal(get('CATALOG.books.length'), before);
});

test('a comparison takes only what is ticked: a value of the other source in place of yours, and not a book unticked', async () => {
	const mine = JSON.stringify([
		{t: 'Salt Road', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}, n: ['Hollis Marr']}]},
	]);
	const {els, get, readable} = await boot({page: 'import.html', files: {'books.json': mine}});
	const csv =
		'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\n' +
		'x,Salt Road,,Ann Vale,Ida Quell,Finished,B1\n' +
		'x,Brine Songs,,Ann Vale,,Finished,B2\n' +
		'x,Tidewater,,Ann Vale,,Finished,B3\n';
	const open = async () => {
		els.audibleImportBtn.listeners.click[0]();
		await idle();
		els.importCsvFile.listeners.change[0]({target: {files: [{name: 'library.csv', text: csv}], value: ''}});
		await idle();
	};
	const box = pick => els.importPreviewBody.querySelector(`input[data-pick="${pick}"]`);
	const tick = (pick, on) => {
		box(pick).checked = on;
		box(pick).dispatch('change');
	};
	await open();
	assert.match(
		readable(els.importPreviewBody.innerHTML),
		/Different in both \(1\)<\/h4>.*Salt Road — Ann Vale<\/span><ul><li><label class="cmpPick"><input type="checkbox" data-pick="patch:0:n:0"> Narrators: <span class="cmpHere">Hollis Marr<\/span> here, <span class="cmpThere">Ida Quell<\/span> on Audible<\/label>/,
	);
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');

	// tick none, then all, of the new books
	const [none] = els.importPreviewBody.querySelectorAll('button.cmpTick').filter(b => b.textContent === 'Tick none');
	none.listeners.click[0]();
	assert.equal(els.importConfirm.style.display, 'none');
	assert.equal(box('take:1').hasAttribute('checked'), false);
	els.importPreviewBody
		.querySelectorAll('button.cmpTick')
		.find(b => b.textContent === 'Tick all')
		.listeners.click[0]();
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');

	tick('take:2', false);
	tick('patch:0:n:0', true);
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books'), [
		{t: 'Salt Road', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}, n: ['Ida Quell']}]},
		{t: 'Brine Songs', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B2'}}]},
	]);
	assert.match(els.ioStatus.textContent, /^Added 1 book, changed 1 value\.$/);

	// the book left out is still new the next time
	await open();
	assert.match(readable(els.importPreviewBody.innerHTML), /New from Audible \(1\)<\/h4>.*Tidewater — Ann Vale/);
	assert.doesNotMatch(els.importPreviewBody.innerHTML, /Different in both/);
});

test("a series' name ticked in a comparison renames the series, on all its books, keeping its id and details", async () => {
	const storage = new Map();
	const mine = JSON.stringify([
		{t: 'Salt Road', a: ['Ann Vale'], s: 'Gull Isles', sn: '1', e: [{ext: {'audible.com': 'B1'}}]},
		{t: 'Paper Fen', a: ['Ann Vale'], s: 'Gull Isles', sn: '2', e: [{ext: {'audible.com': 'B2'}}]},
	]);
	const info = JSON.stringify({'Gull Isles': {total: 5, status: 'ongoing', note: 'Read in order.'}});
	const {els, readable} = await boot({
		page: 'import.html',
		storage,
		files: {'books.json': mine, 'series-info.json': info},
	});
	await settled(storage);
	const [{uid: id}] = databaseOf(storage).records('series');
	els.audibleImportBtn.listeners.click[0]();
	await idle();
	const csv =
		'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\n' +
		'x,Salt Road,The Gull Isle Saga,Ann Vale,,Finished,B1\n';
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'library.csv', text: csv}], value: ''}});
	await idle();
	assert.match(
		readable(els.importPreviewBody.innerHTML),
		/Series: <span class="cmpHere">Gull Isles<\/span> here, <span class="cmpThere">The Gull Isle Saga<\/span> on Audible \(renames the series, on 2 books\)/,
	);
	const box = els.importPreviewBody.querySelector('input[data-pick="patch:0:s"]');
	box.checked = true;
	box.dispatch('change');
	els.importConfirm.listeners.click[0]();
	await idle();
	const after = await kept(storage);
	assert.deepEqual(
		after.books.map(b => [b.t, b.s]),
		[
			['Salt Road', 'The Gull Isle Saga'],
			['Paper Fen', 'The Gull Isle Saga'],
		],
	);
	assert.deepEqual(
		databaseOf(storage)
			.records('series')
			.map(r => [r.uid, r.name]),
		[[id, 'The Gull Isle Saga']],
	);
	assert.deepEqual(after.seriesInfo, {'The Gull Isle Saga': {total: 5, status: 'ongoing', note: 'Read in order.'}});
});

test("Goodreads CSV downloads every book for Goodreads' import", async () => {
	const {ctx, els, get} = await boot({page: 'import.html'});
	const blobs = [];
	ctx.Blob = class {
		constructor(parts) {
			blobs.push(parts.join(''));
		}
	};
	ctx.URL = {createObjectURL: () => 'blob:x', revokeObjectURL() {}};
	els.goodreadsExportBtn.listeners.click[0]();
	await idle();
	assert.equal(blobs[0], get('new CatalogConnectors.EXPORTERS[0]().write(CATALOG.books).text'));
	assert.match(blobs[0], /^Book Id,Title,Author,/);
	assert.match(els.ioStatus.textContent, new RegExp(`Goodreads CSV with ${demoBooks.length} books downloaded`));
});

test('the Backups panel says how old the last backup is, and the catalog page reminds you when it is getting old', async () => {
	const storage = new Map();
	const imp = await boot({page: 'import.html', storage});
	await idle();
	assert.equal(imp.els.backupState.textContent, 'No backup downloaded in this browser yet.');
	imp.ctx.Blob = class {
		constructor() {}
	};
	imp.ctx.URL = {createObjectURL: () => 'blob:x', revokeObjectURL() {}};
	imp.els.exportBtn.listeners.click[0]();
	await idle();
	assert.equal(imp.els.backupState.textContent, 'Last backup today; nothing changed since.');
	const revision = JSON.parse(storage.get('audiobook-catalog-last-backup')).revision;
	assert.equal(typeof revision, 'number');

	// a fresh backup: no reminder
	const fresh = await boot({storage});
	await idle();
	assert.equal(fresh.els.backupNudge.textContent, '');

	// three weeks and a change later
	storage.set(
		'audiobook-catalog-last-backup',
		JSON.stringify({time: new Date(Date.now() - 21 * 86400000).toISOString(), revision: revision - 1}),
	);
	const old = await boot({storage});
	await idle();
	assert.equal(
		old.els.backupNudge.textContent,
		'Last backup 21 days ago, and 1 change saved since: download one on Import & export.',
	);
	const later = await boot({page: 'import.html', storage});
	await idle();
	assert.equal(later.els.backupState.textContent, 'Last backup 21 days ago; 1 change saved since.');
});

test('Export includes series and author info, and Import brings them back', async () => {
	const first = await boot({page: 'import.html'});
	const blobs = [];
	first.ctx.Blob = class {
		constructor(parts) {
			blobs.push(parts.join(''));
		}
	};
	first.ctx.URL = {createObjectURL: () => 'blob:x', revokeObjectURL() {}};
	first.els.exportBtn.listeners.click[0]();
	await idle();
	const backup = JSON.parse(blobs[0]);
	// version 3: the stored records by store and id, without what is derived
	assert.deepEqual(Object.keys(backup), [
		'version',
		'books',
		'editions',
		'series',
		'contributors',
		'marks',
		'exclusions',
	]);
	assert.equal(backup.version, 3);
	const byName = JSON.parse(JSON.stringify(Catalog.fromJSON(backup)));
	assert.deepEqual(withoutIds(byName), {
		books: demoBooks,
		seriesInfo: JSON.parse(DEMO_INFO),
		authors: JSON.parse(DEMO_AUTHORS),
		narrators: JSON.parse(DEMO_NARRATORS),
		publishers: JSON.parse(DEMO_PUBLISHERS),
		excluded: [],
		notDuplicates: [],
	});
	assert.deepEqual(
		Object.keys(backup.books),
		first.get('CATALOG.books.map(b => b.id)'),
		"by the ids they are stored under, in the catalog's order",
	);
	const [firstId, firstBook] = Object.entries(backup.books)[0];
	assert.deepEqual(
		Object.keys(firstBook).filter(k => !CatalogRecords.DERIVED.books.includes(k)),
		Object.keys(firstBook),
		'nothing derived',
	);
	assert.equal(firstBook.title, first.get('CATALOG.books[0].title'));
	assert.ok(!('id' in firstBook) && firstId);
	assert.ok(
		firstBook.authorIds.every(id => backup.contributors[id].kind === 'author'),
		'authors by id',
	);
	assert.ok(Object.values(backup.books).every(b => b.editionIds.every(id => backup.editions[id])));
	assert.equal(Object.keys(backup.series).length, new Set(demoBooks.map(b => b.s).filter(Boolean)).size);
	assert.ok(Object.values(backup.contributors).some(c => c.kind === 'narrator'));

	// into a page that has no series info: it comes back, and survives a reload
	const mine = JSON.stringify([{t: 'Mine', a: ['Me']}]);
	const files = {'books.json': mine};
	const other = await boot({page: 'import.html', files});
	assert.deepEqual(other.get('[CATALOG.toJSON().seriesInfo, CATALOG.toJSON().authors]'), [{}, {}]);
	await other.els.importFile.listeners.change[0]({
		target: {files: [{name: 'b.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	assert.deepEqual(other.get('CATALOG.books'), demoBooks);
	assert.deepEqual(other.get('CATALOG.toJSON().seriesInfo'), byName.seriesInfo);
	assert.deepEqual(other.get('CATALOG.toJSON().authors'), byName.authors);
	assert.deepEqual(other.get('[CATALOG.toJSON().narrators, CATALOG.toJSON().publishers]'), [
		byName.narrators,
		byName.publishers,
	]);
	await other.saved();
	assert.deepEqual(
		other.database
			.records('books')
			.map(b => b.id)
			.sort(),
		Object.keys(backup.books).sort(),
		'the books keep their ids',
	);
	assert.deepEqual(
		other.database
			.records('series')
			.map(x => x.id)
			.sort(),
		Object.keys(backup.series).sort(),
	);
	assert.deepEqual(
		other.database
			.records('contributors')
			.map(x => x.id)
			.sort(),
		Object.keys(backup.contributors).sort(),
	);
	await boot({files, storage: other.storage});
	assert.deepEqual((await kept(other.storage)).seriesInfo, byName.seriesInfo);
	const reloaded = await kept(other.storage);
	assert.deepEqual(reloaded.authors, byName.authors);
	assert.deepEqual([reloaded.narrators, reloaded.publishers], [byName.narrators, byName.publishers]);

	// a backup from a newer version of the page is refused, saying so
	await other.els.importFile.listeners.change[0]({
		target: {files: [{name: 'b.json', text: JSON.stringify({...backup, version: 4, books: {}})}], value: ''},
	});
	await idle();
	assert.match(other.els.ioStatus.textContent, /^Not restored: a newer version of the catalog made that backup/);
	assert.equal(other.get('CATALOG.books.length'), demoBooks.length);
	// nor one whose records don't fit together, which is named
	const broken = {...backup, books: {b1: {title: 'Lost', authorIds: ['nobody']}}};
	await other.els.importFile.listeners.change[0]({
		target: {files: [{name: 'b.json', text: JSON.stringify(broken)}], value: ''},
	});
	await idle();
	assert.equal(other.els.ioStatus.textContent, 'Not restored: no author is stored under nobody.');
	assert.equal(other.get('CATALOG.books.length'), demoBooks.length);

	// an older backup (a plain list of books) still imports and keeps the current series and author info
	const legacy = await boot({page: 'import.html'});
	await legacy.els.importFile.listeners.change[0]({target: {files: [{name: 'b.json', text: mine}], value: ''}});
	await idle();
	assert.deepEqual(legacy.get('CATALOG.books'), [{t: 'Mine', a: ['Me']}]);
	assert.deepEqual(legacy.get('CATALOG.toJSON().seriesInfo'), JSON.parse(DEMO_INFO));
	assert.deepEqual(legacy.get('CATALOG.toJSON().authors'), JSON.parse(DEMO_AUTHORS));
	assert.deepEqual(legacy.get('CATALOG.toJSON().narrators'), JSON.parse(DEMO_NARRATORS));
});

test('Restore takes the data files of a catalog from before it lived in the browser, picked together', async () => {
	const {els, get, storage} = await boot({page: 'import.html', files: null});
	const books = [
		{t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1'},
		{t: 'Tide Water', a: ['Ann Vale']},
	];
	const pair = Duplicates.pairKey(Book.fromJSON(books[0]), Book.fromJSON(books[1]));
	await els.importFile.listeners.change[0]({
		target: {
			value: '',
			files: [
				{name: 'books.json', text: JSON.stringify(books)},
				{name: 'series-info.json', text: '{"Gull Isle":{"total":3,"status":"ongoing"}}'},
				{name: 'authors.json', text: '{"Ann Vale":{"bio":"Writes about the sea."}}'},
				{name: 'narrators.json', text: '{"Cy Hale":{"bio":"Reads sea stories."}}'},
				{name: 'excluded.txt', text: '# books imports skip\nBGONE\n'},
				{name: 'not-duplicates.txt', text: pair + '\n'},
			],
		},
	});
	assert.match(
		els.ioStatus.textContent,
		/^Restored 2 books and the release details of 1 series; 1 more excluded from imports\.$/,
	);
	assert.deepEqual(await kept(storage), {
		books,
		seriesInfo: {'Gull Isle': {total: 3, status: 'ongoing'}},
		authors: {'Ann Vale': {bio: 'Writes about the sea.'}},
		narrators: {'Cy Hale': {bio: 'Reads sea stories.'}},
		publishers: {},
		excluded: ['BGONE'],
		notDuplicates: [pair],
	});
	assert.deepEqual(get('CATALOG.markTexts()'), [pair]);
	assert.deepEqual(
		get('[...CATALOG.marks.values()].map(m => [m.kind, m.bookIds])'),
		[['notDuplicates', get('CATALOG.books.map(b => b.id).sort()')]],
		'pointing at the books restored',
	);
	assert.equal(els.dupCount.textContent, '');

	// without books.json, or with a file that is none of these, nothing changes
	for (const files of [
		[{name: 'series-info.json', text: '{}'}],
		[
			{name: 'books.json', text: '[]'},
			{name: 'notes.txt', text: 'hi'},
		],
	]) {
		await els.importFile.listeners.change[0]({target: {value: '', files}});
		await idle();
		assert.match(els.ioStatus.textContent, /Couldn't read that/);
		assert.equal(get('CATALOG.books.length'), 2);
	}
	// nor with a value the catalog has no place for, which is named
	await els.importFile.listeners.change[0]({
		target: {value: '', files: [{name: 'b.json', text: JSON.stringify({books: [{t: 'Odd', a: ['Me'], g: 5}]})}]},
	});
	await idle();
	assert.equal(
		els.ioStatus.textContent,
		"Not restored: fix these values in the backup first (they aren't what their field holds): book #0 ('Odd'): 'g'.",
	);
	assert.equal(get('CATALOG.books.length'), 2);
});

// Press Remove book in a book's form, as in the library view, and let its Undo go.
// `i` is the book's place in the catalog's order.
// Remove the book titled `title` with the Remove book of its form, on its page, and let its Undo go; returns that page.
async function removeBook(title, options) {
	const page = await bootBook(title, options);
	const {ctx, els, get} = page;
	const id = get('BOOK_FILTER');
	ctx.openEditForm(id);
	els.formRemoveBtn.dispatch('click');
	assert.ok(!els.results.innerHTML.includes(`data-id="${id}"`), 'the book leaves the page at once');
	ctx.finishRemoving(); // as when its Undo is gone
	await idle();
	return page;
}

test('a removed book stays in the catalog until its Undo is gone, and Undo brings it back', async () => {
	const mine = JSON.stringify([
		{t: 'Keep', a: ['Ann Vale']},
		{t: 'Gone', a: ['Ann Vale'], id: 'BGONE2'},
	]);
	const {ctx, els, get, storage} = await bootBook('Gone', {files: {'books.json': mine}});
	ctx.openEditForm(get('BOOK_FILTER'));
	assert.equal(els.formRemoveBtn.style.display, '');
	els.formRemoveBtn.dispatch('click');
	assert.ok(!els.addForm.classList.contains('open'), 'the form closes');
	assert.doesNotMatch(els.results.innerHTML, />Gone</);
	assert.match(els.results.innerHTML, /Removed; imports will skip it/);
	assert.equal(els.ioStatus.textContent, 'Removed Gone; imports will skip it. Undo');
	assert.equal(get('CATALOG.books.length'), 1);
	els.ioStatus.querySelector('.undo').dispatch('click');
	await idle();
	assert.match(els.results.innerHTML, />Gone</);
	assert.equal(els.ioStatus.textContent, '');
	ctx.finishRemoving();
	await idle();
	assert.equal(get('CATALOG.books.length'), 1);
	assert.deepEqual(
		(await kept(storage)).books.map(b => b.t),
		['Keep', 'Gone'],
	);
	assert.deepEqual((await kept(storage)).excluded, []);
});

test("Read today on a book's details adds today to its dates read, and Undo takes it off", async () => {
	const {ctx, els, get, storage} = await bootBook('The Salt Road');
	const id = get('BOOK_FILTER');
	els.results.querySelector('.readToday').dispatch('click');
	await idle();
	const today = ctx.today();
	assert.deepEqual(get(`CATALOG.book(${JSON.stringify(id)}).read`), ['2023-06-02', '2025-11-20', today].sort());
	assert.ok((await kept(storage)).books.find(b => b.t === 'The Salt Road').r.includes(today));
	assert.doesNotMatch(els.results.innerHTML, /readToday/, 'read today already');
	assert.equal(els.ioStatus.textContent, 'Read The Salt Road today. Undo');
	els.ioStatus.querySelector('.undo').dispatch('click');
	await idle();
	assert.deepEqual((await kept(storage)).books.find(b => b.t === 'The Salt Road').r, ['2023-06-02', '2025-11-20']);
	assert.match(els.results.innerHTML, /class="readToday">\+ Read today</);
});

test('removing a book excludes it from imports, and Export / Import carry the exclusions', async () => {
	const mine = JSON.stringify([
		{t: 'Keep', a: ['Ann Vale']},
		{t: 'Gone', a: ['Ann Vale'], id: 'BGONE2'},
	]);
	const files = {'books.json': mine, 'excluded.txt': '# header\nBOLD\n'};
	const {els, get, storage} = await removeBook('Gone', {files});
	assert.deepEqual(get('CATALOG.books'), []);
	assert.equal(els.ioStatus.textContent, 'Removed Gone; imports will skip it. Undo');
	assert.match(els.results.innerHTML, /Removed; imports will skip it/);
	assert.deepEqual(
		(await kept(storage)).books.map(b => b.t),
		['Keep'],
	);
	assert.deepEqual((await kept(storage)).excluded, ['BOLD', 'BGONE2', 'Gone | Ann Vale']);

	// on the import page, an import (Audible by id, or Goodreads by title) does not bring it back
	const imp = await boot({page: 'import.html', files, storage});
	imp.els.audibleImportBtn.listeners.click[0]();
	await idle();
	imp.els.importCsvFile.listeners.change[0]({
		target: {
			files: [
				{
					name: 'l.csv',
					text: 'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\nx,Gone,,Ann Vale,,Finished,BGONE2\n',
				},
			],
			value: '',
		},
	});
	await idle();
	assert.match(imp.els.importPreviewBody.innerHTML, /excluded from imports\): 1/);
	imp.els.goodreadsImportBtn.listeners.click[0]();
	await idle();
	imp.els.importCsvFile.listeners.change[0]({
		target: {
			files: [
				{
					name: 'g.csv',
					text: 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\nGone,Ann Vale,,Audible Audio,read,\n',
				},
			],
			value: '',
		},
	});
	await idle();
	assert.match(imp.els.importPreviewBody.innerHTML, /excluded from imports\): 1/);

	// a reload keeps the exclusions along with the edit
	await boot({files, storage});
	assert.deepEqual((await kept(storage)).excluded, ['BOLD', 'BGONE2', 'Gone | Ann Vale']);

	// Export has the whole list; Import adds it to another page's list
	const blobs = [];
	imp.ctx.Blob = class {
		constructor(parts) {
			blobs.push(parts.join(''));
		}
	};
	imp.ctx.URL = {createObjectURL: () => 'blob:x', revokeObjectURL() {}};
	imp.els.exportBtn.listeners.click[0]();
	await idle();
	const backup = JSON.parse(blobs[0]);
	assert.deepEqual(backup.exclusions, ['BGONE2', 'BOLD', 'Gone | Ann Vale'], 'a list, sorted');
	const other = await boot({page: 'import.html', files: {'books.json': '[]', 'excluded.txt': 'BOLD\nOther\n'}});
	await other.els.importFile.listeners.change[0]({
		target: {files: [{name: 'b.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	assert.deepEqual(other.get('CATALOG.exclusions.entries'), ['BOLD', 'Other', 'BGONE2', 'Gone | Ann Vale']);
	assert.match(other.els.ioStatus.textContent, /2 more excluded from imports/);
});

test("the edit form takes the place of the book's details, and a new book's is above where they go", async () => {
	const {ctx, els, get} = await bootBook('The Drowned Chart');
	const id = get('BOOK_FILTER');
	ctx.openEditForm(id);
	assert.ok(
		els.results.querySelector('.book').classList.contains('editing'),
		'the details are hidden while the form is open',
	);
	assert.equal(els.addForm.place, 'after ', 'after the details');
	await ctx.refreshView();
	await idle();
	assert.ok(
		els.results.querySelector('.book').classList.contains('editing'),
		'redrawing the page keeps the form on the book',
	);
	els.cancelAdd.listeners.click[0]();
	await idle();
	assert.equal(els.addForm.place, 'before results');
	assert.ok(!els.results.querySelector('.book').classList.contains('editing'));
	assert.equal(ctx.location.replaced, null, 'Cancel on an edit stays on the book');

	const add = await boot({page: 'book.html', hash: '#add'});
	assert.ok(add.els.addForm.classList.contains('open'));
	assert.equal(add.els.addForm.place, 'before results');
});

test('removing a book closes its form, and an edit after it saves to the right book', async () => {
	const mine = JSON.stringify([
		{t: 'First', a: ['Ann Vale']},
		{t: 'Second', a: ['Ann Vale']},
		{t: 'Third', a: ['Ann Vale']},
	]);
	const {els, storage} = await removeBook('First', {files: {'books.json': mine}});
	assert.ok(!els.addForm.classList.contains('open'), 'the form closes');
	const second = await bootBook('Second', {storage});
	second.ctx.openEditForm(second.get('BOOK_FILTER'));
	second.els.f_t.value = 'Second, Edited';
	second.els.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.deepEqual(
		(await kept(storage)).books.map(b => b.t),
		['Second, Edited', 'Third'],
	);
	await removeBook('Third', {storage});
	second.ctx.openEditForm(second.get('BOOK_FILTER'));
	second.els.f_t.value = 'Second, Again';
	second.els.addForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.deepEqual(
		(await kept(storage)).books.map(b => b.t),
		['Second, Again'],
	);
});

test('series show which books are missing, and can be filtered to those; one without a note shows none', async () => {
	const {els, storage} = await boot();
	await idle();
	// (worked out on the Duplicates page, which holds the whole catalog)
	const whole = await boot({page: 'duplicates.html', storage});
	const info = JSON.parse(DEMO_INFO);
	const gaps = Object.keys(info).filter(name => whole.get(`CATALOG.missing(${JSON.stringify(name)})`).length);
	assert.ok(
		gaps.length > 0 && gaps.length < Object.keys(info).length,
		'the demo data should have a series with gaps and one without',
	);
	assert.match(els.results.innerHTML, /class="missing">missing #/);

	els.missingFilter.value = 'missing';
	els.missingFilter.listeners.change[0]();
	await idle();
	assert.equal((els.results.innerHTML.match(/class="srow-title"/g) || []).length, gaps.length); // no Standalone row either
	assert.equal(els.resultCount.textContent, `${gaps.length} series shown`);

	const {ctx: ctx2, els: els2, get: get2} = await boot();
	ctx2.openSeries(seriesIdOf(get2, gaps[0]));
	await idle();
	assert.match(els2.results.innerHTML, /class="series-note">[^<]*missing #/);

	// a series without a note shows none, never "undefined"
	const mine = JSON.stringify([{t: 'Gull Song', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [{n: ['Cy Hale']}]}]);
	const noNote = await boot({
		files: {'books.json': mine, 'series-info.json': JSON.stringify({'Gull Isle': {total: 5, status: 'ongoing'}})},
	});
	assert.match(noNote.els.results.innerHTML, /missing #/);
	assert.doesNotMatch(noNote.els.results.innerHTML, /undefined/);
});

test('a series and a book keep their ids in external catalogs, typed as an id or pasted as an address', async () => {
	const {ctx, els, get, storage} = await boot({hash: '#series=The+Lantern+Coast'});
	ctx.openSeriesForm(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	assert.equal(els.sf_ext_goodreads.value, '90001');
	assert.equal(els.sf_ext_hardcover.value, 'the-lantern-coast-sample');
	els.sf_ext_audible.value = 'https://www.audible.com/series/The-Lantern-Coast-Audiobooks/B0LANTERN1?ref=x';
	els.sf_ext_goodreads.value = '';
	await els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	// Hardcover's series by the name in its address, as no token is saved to look up its number
	assert.deepEqual(get("CATALOG.infoByName('series').get('The Lantern Coast').external"), {
		'audible.com': 'B0LANTERN1',
		hardcover: 'the-lantern-coast-sample',
	});
	assert.match(
		els.ioStatus.textContent,
		/^Saved The Lantern Coast\. Kept Hardcover's series by the name in its address, as no Hardcover API token is saved/,
	);
	assert.deepEqual((await kept(storage)).seriesInfo['The Lantern Coast'].ext, {
		'audible.com': 'B0LANTERN1',
		hardcover: 'the-lantern-coast-sample',
	});
	assert.match(
		els.results.innerHTML,
		/<a class="authorlink" href="https:\/\/www\.audible\.com\/series\/B0LANTERN1" target="_blank" rel="noopener">Audible ↗<\/a>/,
	);
	// something that is neither is refused
	ctx.openSeriesForm(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	els.sf_ext_goodreads.value = 'https://www.goodreads.com/book/show/4242';
	await els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.match(els.seriesFormError.textContent, /Goodreads: https:\/\/www\.goodreads\.com\/book\/show\/4242/);
	els.cancelSeries.listeners.click[0]();
	await idle();

	// a book's Goodreads work, by its address
	const book = await bootBook(SALT_ROAD, {storage});
	const b = book.els,
		id = book.get('BOOK_FILTER');
	book.ctx.openEditForm(id);
	b.f_ext_goodreads.value = 'https://www.goodreads.com/work/editions/990001-the-salt-road';
	b.addForm.listeners.submit[0]({preventDefault() {}, target: b.addForm});
	await idle();
	assert.equal(book.get("CATALOG.books[0].idOn('goodreads')"), '990001');
	assert.match(
		b.results.innerHTML,
		/<dt>Goodreads book<\/dt><dd><a href="https:\/\/www\.goodreads\.com\/work\/editions\/990001" target="_blank" rel="noopener">990001<\/a><\/dd>/,
	);

	// and its work on Open Library, and its item on Wikidata
	book.ctx.openEditForm(id);
	b.f_ext_openlibrary.value = 'https://openlibrary.org/works/OL123W/The_Salt_Road';
	b.f_ext_wikidata.value = 'q1001';
	b.addForm.listeners.submit[0]({preventDefault() {}, target: b.addForm});
	await idle();
	assert.deepEqual(book.get('CATALOG.books[0].external'), {
		goodreads: '990001',
		openlibrary: 'OL123W',
		wikidata: 'Q1001',
	});
});

test("an address pasted into a series', person's or book's id field becomes the id when the field is left", async () => {
	const {ctx, els, get} = await boot({hash: '#series=The+Lantern+Coast'});
	ctx.openSeriesForm(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	const leave = (input, value) => {
		input.value = value;
		input.dispatch('focusout');
		return input.value;
	};
	assert.equal(
		leave(els.sf_ext_audible, 'https://www.audible.com/series/The-Lantern-Coast-Audiobooks/B0LANTERN1?ref=x'),
		'B0LANTERN1',
	);
	assert.equal(leave(els.sf_ext_goodreads, ' https://www.goodreads.com/series/90002-the-lantern-coast '), '90002');
	assert.equal(
		leave(els.sf_ext_hardcover, 'https://hardcover.app/series/the-lantern-coast'),
		'the-lantern-coast',
		'the name in it, until Hardcover gives the number',
	);
	// another Audible site keeps its address, so the site isn't lost
	assert.equal(
		leave(els.sf_ext_audible, 'https://www.audible.co.uk/series/Lantern/B0LANTERN1?ref=x'),
		'https://www.audible.co.uk/series/B0LANTERN1',
	);
	// pasted into another catalog's field, it moves to that one's
	els.sf_ext_goodreads.value = '';
	assert.equal(leave(els.sf_ext_audible, 'https://www.goodreads.com/series/90003'), '');
	assert.equal(els.sf_ext_goodreads.value, '90003');
	// unless that one holds another id; what isn't an address there is left for Save to refuse
	assert.equal(
		leave(els.sf_ext_audible, 'https://www.goodreads.com/series/90004'),
		'https://www.goodreads.com/series/90004',
	);
	assert.equal(els.sf_ext_goodreads.value, '90003');
	assert.equal(
		leave(els.sf_ext_goodreads, 'https://www.goodreads.com/book/show/4242'),
		'https://www.goodreads.com/book/show/4242',
	);
	assert.equal(leave(els.sf_ext_goodreads, ''), '');

	// a book's ids, and a narrator's
	const book = await bootBook(SALT_ROAD);
	book.ctx.openEditForm(book.get('BOOK_FILTER'));
	assert.equal(leave(book.els.f_ext_openlibrary, 'https://openlibrary.org/works/OL123W/The_Salt_Road'), 'OL123W');
	assert.equal(leave(book.els.f_ext_wikidata, 'https://www.wikidata.org/wiki/Q1001'), 'Q1001');
	const narrator = await boot({page: 'narrator.html', hash: '#n=Tobias+Frane'});
	narrator.els.creditBody.querySelector('.aedit').listeners.click[0]();
	assert.equal(
		leave(narrator.els.cf_ext_goodreads, 'https://www.goodreads.com/author/show/5150.Tobias_Frane'),
		'5150',
	);
});

test('an edition has fields for Goodreads and Hardcover, and one for another catalog once it is picked or used', async () => {
	const {ctx, els, get} = await bootBook(SALT_ROAD);
	const id = get('BOOK_FILTER');
	ctx.openEditForm(id);
	assert.match(els.f_editions.innerHTML, /data-i="0" data-k="ext:goodreads"/);
	assert.match(els.f_editions.innerHTML, /data-i="0" data-k="ext:hardcover"/);
	assert.doesNotMatch(els.f_editions.innerHTML, /data-k="ext:openlibrary"/);
	assert.match(
		els.f_editions.innerHTML,
		/<select data-add-site="0"[^>]*><option value="">\+ Another catalog<\/option><option value="audiobookdb">AudiobookDB<\/option><option value="openlibrary">Open Library<\/option><option value="isfdb">ISFDB<\/option><option value="bookbrainz">BookBrainz<\/option><\/select>/,
	);
	els.f_editions.listeners.change[0]({target: {dataset: {addSite: '0'}, value: 'isfdb'}});
	await idle();
	assert.match(
		els.f_editions.innerHTML,
		/<label>ISFDB edition<\/label><input data-i="0" data-k="ext:isfdb" value="" placeholder="id or isfdb\.org address"/,
	);
	typeEdition(els, 0, 'ext:isfdb', 'https://www.isfdb.org/cgi-bin/pl.cgi?1039718=');
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	assert.equal(get("CATALOG.books[0].editions[0].idOn('isfdb')"), '1039718');
	// an edition with an id there shows its field
	ctx.openEditForm(id);
	assert.match(els.f_editions.innerHTML, /data-i="0" data-k="ext:isfdb" value="1039718"/);
	assert.match(
		els.f_editions.innerHTML,
		/<select data-add-site="0"[^>]*><option value="">\+ Another catalog<\/option><option value="audiobookdb">AudiobookDB<\/option><option value="openlibrary">Open Library<\/option><option value="bookbrainz">BookBrainz<\/option><\/select>/,
	);
});

test('a series can be edited in the page, and removed from its books', async () => {
	const {ctx, els, get, storage} = await boot();
	const info = JSON.parse(DEMO_INFO);
	const [name] = Object.keys(info);
	assert.doesNotMatch(els.results.innerHTML, /sedit/, 'not in the overview');
	ctx.openSeries(seriesIdOf(get, name));
	await idle();
	assert.match(
		els.results.innerHTML,
		/<div class="page-actions"><button type="button" class="sedit" data-series="[^"]+">Edit<\/button>(<button type="button" class="catalogCompare" data-compare="[a-z]+">Compare with [\w ]+<\/button>)+<\/div><\/div>$/,
		'at the end of the page of the series',
	);
	const books = await boot({page: 'books.html', storage});
	assert.doesNotMatch(books.els.results.innerHTML, /sedit|Compare with Hardcover/, 'nor in the list of all books');

	// edit: the form starts from the current entry
	ctx.openSeriesForm(seriesIdOf(get, name));
	await idle();
	assert.ok(els.seriesForm.classList.contains('open'));
	assert.equal(els.sf_total.value, String(info[name].total));
	assert.equal(els.sf_status.value, info[name].status);
	assert.equal(els.sf_note.value, info[name].note);
	assert.equal(els.seriesFormTitle.textContent, `Edit series: ${name}`);
	assert.equal(els.sf_url, undefined, 'a series keeps no site: its author or publisher does');
	Object.assign(els.sf_total, {value: '7'});
	Object.assign(els.sf_status, {value: 'ongoing'});
	Object.assign(els.sf_note, {value: '  book 8   is announced '});
	els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.ok(!els.seriesForm.classList.contains('open'));
	assert.deepEqual(get(`CATALOG.infoByName('series').get(${JSON.stringify(name)})`), {
		total: 7,
		status: 'ongoing',
		note: 'book 8 is announced',
	});
	assert.match(els.results.innerHTML, /7 released total/);
	assert.deepEqual((await kept(storage)).seriesInfo[name].total, 7);

	// invalid input is refused with a message, and nothing changes
	ctx.openSeriesForm(seriesIdOf(get, name));
	await idle();
	Object.assign(els.sf_total, {value: 'lots'});
	Object.assign(els.sf_note, {value: ''});
	els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.ok(els.seriesForm.classList.contains('open'));
	assert.match(els.seriesFormError.textContent, /total must be a positive integer/);
	assert.equal(get(`CATALOG.infoByName('series').get(${JSON.stringify(name)}).total`), 7);
	els.cancelSeries.listeners.click[0]();
	await idle();
	assert.ok(!els.seriesForm.classList.contains('open'));

	// a series with nothing kept about it gets it ("many" is allowed)
	const bare = demoBooks.map(b => b.s).find(s => s && !(s in info));
	assert.ok(bare, 'the demo data has a series without info');
	ctx.openSeriesForm(seriesIdOf(get, bare));
	await idle();
	assert.equal(els.sf_total.value, '');
	assert.equal(els.seriesFormTitle.textContent, `Edit series: ${bare}`);
	Object.assign(els.sf_total, {value: 'Many'});
	Object.assign(els.sf_status, {value: 'complete'});
	Object.assign(els.sf_note, {value: 'finished'});
	els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.deepEqual(get(`CATALOG.infoByName('series').get(${JSON.stringify(bare)})`), {
		total: 'many',
		status: 'complete',
		note: 'finished',
	});

	// emptying every field keeps nothing about it, and the series stays
	ctx.openSeriesForm(seriesIdOf(get, bare));
	await idle();
	for (const field of [els.sf_total, els.sf_note]) field.value = '';
	els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.equal(els.seriesFormError.textContent, '');
	assert.equal(get(`CATALOG.infoByName('series').has(${JSON.stringify(bare)})`), false);
	assert.equal(els.ioStatus.textContent, `Saved ${bare}.`);
	assert.ok(
		databaseOf(storage)
			.records('series')
			.some(x => x.name === bare),
	);

	// Remove series warns first, then takes it off its books, which stay
	const id = seriesIdOf(get, name),
		count = demoBooks.filter(b => b.s === name).length;
	ctx.openSeries(id);
	await idle();
	ctx.openSeriesForm(id);
	await idle();
	els.seriesRemoveBtn.listeners.click[0]();
	await idle();
	assert.equal(
		els.seriesFormError.textContent,
		`This takes ${name} off its ${count} books, which stay in the catalog without a series or a number in it, and removes the series. Press Remove series again to do it.`,
	);
	assert.equal(
		get(`CATALOG.books.filter(b => b.series === ${JSON.stringify(name)}).length`),
		count,
		'nothing changed yet',
	);
	els.seriesRemoveBtn.listeners.click[0]();
	await idle();
	assert.ok(!els.seriesForm.classList.contains('open'));
	assert.equal(els.ioStatus.textContent, `Removed the series ${name} from ${count} books.`);
	assert.equal(get('SERIES_FILTER'), null, 'every series shows');
	const saved = await kept(storage);
	assert.equal(saved.books.length, demoBooks.length);
	assert.equal(saved.books.filter(b => b.s === name || (!b.s && b.sn)).length, 0, 'no series, and no number in it');
	assert.equal(name in saved.seriesInfo, false);
	assert.equal(
		databaseOf(storage)
			.records('series')
			.some(x => x.id === id),
		false,
	);
});

test('a series no book is in any more stays, and can be removed', async () => {
	const books = JSON.stringify([
		{t: 'Fern 1', a: ['Bo Reed'], s: 'Fern Saga', sn: '1'},
		{t: 'Lone', a: ['Bo Reed']},
	]);
	const {get, storage} = await boot({files: {'books.json': books}});
	const id = seriesIdOf(get, 'Fern Saga');
	await removeBook('Fern 1', {storage, files: null});
	const home = await boot({storage, files: null});
	assert.match(home.els.results.innerHTML, /Fern Saga<\/a> <span class="srow-owned">no books yet<\/span>/);
	home.ctx.openSeries(id);
	await idle();
	assert.match(
		home.els.results.innerHTML,
		/No books in Fern Saga yet\.<\/p><div class="page-actions"><button type="button" class="sedit"/,
	);
	home.ctx.openSeriesForm(id);
	await idle();
	home.els.seriesRemoveBtn.listeners.click[0]();
	assert.equal(
		home.els.seriesFormError.textContent,
		'This removes Fern Saga, which no book is in. Press Remove series again to do it.',
	);
	home.els.seriesRemoveBtn.listeners.click[0]();
	await idle();
	await kept(storage);
	assert.deepEqual(databaseOf(storage).records('series'), []);
});

test('a series can be renamed from its form, on every book in it', async () => {
	const {ctx, els, get, storage} = await boot();
	const info = JSON.parse(DEMO_INFO);
	const [name] = Object.keys(info);
	const count = demoBooks.filter(b => b.s === name).length;
	assert.ok(count > 0);

	await kept(storage);
	const seriesId = databaseOf(storage)
		.records('series')
		.find(x => x.name === name).id;
	// shown from the series itself: the page follows the new name
	ctx.openSeries(seriesIdOf(get, name));
	await idle();
	ctx.openSeriesForm(seriesIdOf(get, name));
	await idle();
	assert.equal(els.sf_name.value, name);
	Object.assign(els.sf_name, {value: '  The Renamed   Saga '});
	els.seriesForm.listeners.submit[0]({preventDefault() {}});
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
	const saved = await kept(storage);
	assert.ok(saved.seriesInfo['The Renamed Saga']);
	assert.deepEqual(
		databaseOf(storage)
			.records('series')
			.filter(x => x.name === 'The Renamed Saga')
			.map(x => x.id),
		[seriesId],
		'it keeps its id',
	);
	assert.equal(saved.books.filter(b => b.s === 'The Renamed Saga').length, count);

	// a series without info is renamed without having to add some
	const bare = demoBooks.map(b => b.s).find(s => s && !(s in info));
	const bareCount = demoBooks.filter(b => b.s === bare).length;
	ctx.openSeriesForm(seriesIdOf(get, bare));
	await idle();
	Object.assign(els.sf_name, {value: 'Plain Renamed'});
	els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.equal(els.seriesFormError.textContent, '');
	assert.equal(get(`CATALOG.books.filter(b => b.series === 'Plain Renamed').length`), bareCount);
	assert.equal(get(`CATALOG.infoByName('series').has('Plain Renamed')`), false);

	// an empty name is refused
	ctx.openSeriesForm(seriesIdOf(get, 'Plain Renamed'));
	await idle();
	Object.assign(els.sf_name, {value: '   '});
	els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.match(els.seriesFormError.textContent, /Give the series a name/);
	els.cancelSeries.listeners.click[0]();
	await idle();

	// joining another series takes a second Save, and its info gives way to this form's
	ctx.openSeriesForm(seriesIdOf(get, 'Plain Renamed'));
	await idle();
	Object.assign(els.sf_name, {value: 'The Renamed Saga'});
	els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.ok(els.seriesForm.classList.contains('open'));
	assert.match(els.seriesFormError.textContent, /already a series called The Renamed Saga\. Press Save again/);
	assert.equal(get(`CATALOG.books.filter(b => b.series === 'Plain Renamed').length`), bareCount);
	els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.ok(!els.seriesForm.classList.contains('open'));
	assert.equal(get(`CATALOG.books.filter(b => b.series === 'The Renamed Saga').length`), count + bareCount);
	assert.deepEqual(get(`CATALOG.infoByName('series').get('The Renamed Saga')`), info[name]);
});

// Lets pending promises (a save on its way to the fake server) settle.
const settle = () => new Promise(resolve => setImmediate(resolve));

test('duplicates page: found, merged with the picked title, or kept apart', async () => {
	const mine = JSON.stringify([
		{
			t: 'The Salt Road',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '1',
			g: ['Fantasy'],
			e: [{ext: {'audible.com': 'B1'}}],
		},
		{
			t: 'Beacons',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '2',
			e: [{ext: {'audible.com': 'BBOX'}, p: 'Gull Audio'}],
		},
		{
			t: 'Salt Road',
			a: ['Marisol Quenby'],
			n: ['Tobias Frane'],
			s: 'Lantern Coast',
			sn: '1',
			r: ['2023-06-02'],
			e: [{ext: {goodreads: '4242'}}],
		},
		{
			t: 'The Drowned Chart',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '3',
			e: [{ext: {'audible.com': 'BBOX'}, p: 'Gull Audio'}],
		},
		{t: 'The Ledger', a: ['Priya Ostrander']},
		{t: 'The Ledger, Book 1', a: ['Priya Ostrander']},
	]);
	const files = {'books.json': mine};
	// every page's link says how many there are; a box set's titles share an edition but are not duplicates
	const home = await boot({files});
	assert.equal(home.els.dupCount.textContent, ' (2)');

	const {ctx, els, get, run, storage} = await boot({page: 'duplicates.html', files});
	// the books by the ids they are stored under
	const at = get('CATALOG.books.map(b => b.id)');
	assert.deepEqual(get('DUP_GROUPS'), [
		[at[0], at[2]],
		[at[4], at[5]],
	]);
	assert.match(els.subtitle.textContent, /^2 possible duplicates among 6 audiobooks/);
	assert.match(
		els.dupBody.innerHTML,
		/name="dup-0-title"[^>]*checked=""> <span class="dup-label">Title<\/span> The Salt Road/,
	);
	assert.match(els.dupBody.innerHTML, /Becomes: The Salt Road/);
	// what both entries have alike is said once, above them
	assert.match(
		els.dupBody.innerHTML,
		/<p class="dup-shared"><span class="dup-label">Author<\/span> Marisol Quenby · <span class="dup-label">Series<\/span> Lantern Coast #1<\/p>/,
	);
	assert.equal((els.dupBody.innerHTML.match(/dup-label">Author</g) || []).length, 2, 'once per group');

	// pick the second entry's title, then merge: one book with both editions, the narrator and the date read
	run('DUP_PICKS[0].title = 1; renderDuplicates()');
	assert.match(els.dupBody.innerHTML, /Becomes: Salt Road/);
	ctx.mergeGroup(0);
	assert.equal(get('CATALOG.books.length'), 5);
	assert.deepEqual(get('CATALOG.books[0]'), {
		t: 'Salt Road',
		a: ['Marisol Quenby'],
		s: 'Lantern Coast',
		sn: '1',
		g: ['Fantasy'],
		r: ['2023-06-02'],
		e: [{ext: {'audible.com': 'B1', goodreads: '4242'}, n: ['Tobias Frane']}],
	}); // Audible's and Goodreads' records of one edition
	assert.match(els.ioStatus.textContent, /^Merged 2 entries into Salt Road\./);
	assert.equal(get('CATALOG.exclusions.size'), 0); // the removed entry's ids live on in the kept book
	assert.deepEqual(
		get('CATALOG.books.map(b => b.id)'),
		[at[0], at[1], at[3], at[4], at[5]],
		'the book that came first is the one kept',
	);
	assert.deepEqual(get('DUP_GROUPS'), [[at[4], at[5]]]);
	assert.equal(els.dupCount.textContent, ' (1)');

	// "Not duplicates" is remembered in this browser, also after a reload
	ctx.keepApart(0);
	assert.match(els.dupBody.innerHTML, /No books look like duplicates/);
	assert.equal(els.dupCount.textContent, '');
	const again = await boot({page: 'duplicates.html', files, storage});
	assert.deepEqual(again.get('DUP_GROUPS'), []);
	assert.equal(again.get('CATALOG.books.length'), 5); // the merge was kept in this browser
});

test('Merge on a book finds the other book and opens the two on the duplicates page', async () => {
	const mine = JSON.stringify([
		{t: 'Ledger', a: ['Priya Ostrander']},
		{t: 'Other', a: ['Ann Vale']},
		{t: 'The Ledger', a: ['P. Ostrander'], r: ['2024']},
	]);
	const files = {'books.json': mine};
	const home = await bootBook('The Ledger', {files});
	const at = [0, 1, 2].map(i => bookIdAt(home.get, i));
	home.ctx.toggleMergeSearch(at[2]);
	assert.match(
		home.els.results.innerHTML,
		/class="merge" aria-expanded="true">Merge<\/button><\/div><div class="mergeSearch"><label for="mergeQuery">Find the book to merge it with<\/label><input type="search" id="mergeQuery"/,
	);
	// the book itself is not offered
	await home.ctx.findMergeBooks(at[2], 'ledger');
	assert.equal(
		home.els.mergeFound.innerHTML,
		`<li><a href="duplicates.html#merge=${at[2]},${at[0]}">Ledger</a> — Priya Ostrander</li>`,
	);
	await home.ctx.findMergeBooks(at[2], 'nothing like it');
	assert.equal(home.els.mergeFound.innerHTML, '<li class="none">No other book matches.</li>');
	home.ctx.toggleMergeSearch(at[2]);
	assert.doesNotMatch(home.els.results.innerHTML, /mergeSearch/);

	const {ctx, els, get} = await boot({
		page: 'duplicates.html',
		storage: home.storage,
		hash: `#merge=${at[2]},${at[0]}`,
	});
	assert.deepEqual(get('DUP_GROUPS'), [[at[0], at[2]]], 'in the order the catalog has them');
	assert.match(els.dupBody.innerHTML, /Picked by hand/);
	ctx.mergeGroup(0);
	assert.deepEqual(get('CATALOG.books'), [
		{t: 'Ledger', a: ['Priya Ostrander'], r: ['2024']},
		{t: 'Other', a: ['Ann Vale']},
	]);
	assert.equal(get('DUP_MANUAL'), null);
	assert.equal(ctx.location.hash, '');

	// an address naming no such books shows only what was found
	const stale = await boot({page: 'duplicates.html', storage: home.storage, hash: `#merge=${at[1]},no-such-book`});
	assert.deepEqual(stale.get('DUP_GROUPS'), []);
});

test('edits of different books in two tabs are both saved, and the same book edited in both is not', async () => {
	const files = {
		'books.json': JSON.stringify([
			{t: 'Mine', a: ['Me']},
			{t: 'Yours', a: ['You']},
			{t: 'Theirs', a: ['Them']},
		]),
	};
	const storage = new Map();
	const one = await boot({page: 'books.html', files, storage});
	const two = await boot({page: 'duplicates.html', files, storage});
	await one.run("CATALOG.books[0].title = 'Edited Here'; persist();");
	await two.run("CATALOG.books[1].title = 'Edited There'; persist();");
	assert.equal(two.els.ioStatus.textContent, '');
	assert.deepEqual(
		(await kept(storage)).books.map(b => b.t),
		['Edited Here', 'Edited There', 'Theirs'],
	);
	assert.equal(
		two.get('CATALOG.books[0].title'),
		'Edited Here',
		"the tab saving second took in the first one's edit",
	);

	// one tab removes a book and adds one; another tab's page takes that in once it saves an edit of its own
	const three = await bootBook('Theirs', {storage});
	const retitled = three.get('BOOK_FILTER');
	three.ctx.openEditForm(retitled);
	await two.run(
		"CATALOG.books.splice(0, 1); CATALOG.books.push(new Book({title: 'Added There', authors: ['Them']})); persist();",
	);
	await three.run("CATALOG.book(EDIT_ID).title = 'Retitled Here'; persist();");
	assert.deepEqual(
		(await kept(storage)).books.map(b => b.t),
		['Edited There', 'Retitled Here', 'Added There'],
	);
	assert.equal(three.get('EDIT_ID'), retitled, 'the form still edits the book it was opened on');
	assert.ok(three.els.addForm.classList.contains('open'));

	// both tabs change one book: the second save is refused, and nothing it held is written
	await three.run("CATALOG.book(EDIT_ID).title = 'Both Here'; persist();");
	await two.run("CATALOG.books[1].title = 'Both There'; CATALOG.books[0].title = 'Also There'; persist();");
	assert.match(two.els.ioStatus.textContent, /"Both There" changed in another tab too/);
	assert.deepEqual(
		(await kept(storage)).books.map(b => b.t),
		['Edited There', 'Both Here', 'Added There'],
	);
	await three.run("CATALOG.book(EDIT_ID).title = 'Again Here'; persist();"); // the tab that saved last can keep going
	assert.equal((await kept(storage)).books[1].t, 'Again Here');
});

test('merging keeps editions apart when asked, and books merged that way can be joined later', async () => {
	const mine = JSON.stringify([
		{
			t: 'The Salt Road',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '1',
			e: [{ext: {'audible.com': 'B1'}, len: 642}],
		},
		{
			t: 'Salt Road',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '1',
			e: [{ext: {goodreads: '4242'}, p: 'Gull Audio'}],
		},
		{
			t: 'Beacons',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '2',
			e: [{ext: {'audible.com': 'B2'}}, {ext: {goodreads: '777'}, isbn: '9780306406157'}],
		},
		{
			t: 'The Drowned Chart',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '3',
			e: [{ext: {'audible.com': 'B3'}}, {ext: {'audible.com': 'B3X'}}],
		},
		{t: 'Box Set', a: ['Marisol Quenby'], e: [{ext: {'audible.com': 'BBOX'}}, {ext: {goodreads: '888'}}]},
		{t: 'Other In Box', a: ['Marisol Quenby'], e: [{ext: {'audible.com': 'BBOX'}}]},
	]);
	const files = {'books.json': mine};
	const {ctx, els, get, run, storage} = await boot({page: 'duplicates.html', files});
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
	assert.deepEqual(get('CATALOG.books[0].editions'), [
		{ext: {'audible.com': 'B1'}, len: 642},
		{ext: {goodreads: '4242'}, p: 'Gull Audio'},
	]);
	// ...and the merged book is now offered for joining, like Beacons
	assert.deepEqual(get('SPLIT'), [at[0], at[2]]);
	ctx.joinBookEditions(at[0]);
	assert.deepEqual(get('CATALOG.books[0].editions'), [
		{ext: {'audible.com': 'B1', goodreads: '4242'}, p: 'Gull Audio', len: 642},
	]);
	assert.match(els.ioStatus.textContent, /^The Salt Road now has one edition\./);
	// "Keep separate" is remembered in this browser
	ctx.keepEditionsApart(get('SPLIT[0]'));
	assert.deepEqual(get('SPLIT'), []);
	const again = await boot({page: 'duplicates.html', storage});
	assert.deepEqual(again.get('SPLIT'), []);
	assert.equal(again.els.dupCount.textContent, '');
});

test("the app can be installed: the manifest's icons exist, and the service worker caches every page and module, and nothing else", () => {
	const manifest = JSON.parse(read('manifest.webmanifest'));
	for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(site, icon.src)), icon.src);
	assert.ok(manifest.icons.some(i => i.sizes === '512x512') && manifest.icons.some(i => i.sizes === '192x192'));
	// make pages writes the list sw.js caches (sw-app.js) from what public/ holds.
	const cached = JSON.parse(read('sw-app.js').match(/self\.APP_FILES = (\[.*\]);/)[1]);
	for (const file of cached.filter(f => f !== './')) assert.ok(fs.existsSync(path.join(site, file)), file);
	/** What the pages use: themselves, the modules they import, and what their <head> and the manifest name. */
	const used = new Set(['manifest.webmanifest', ...manifest.icons.map(i => i.src)]);
	for (const page of ALL_PAGES) {
		const html = read(page);
		assert.ok(html.includes('<link rel="manifest" href="manifest.webmanifest">'), page);
		used.add(page);
		for (const [, href] of html.matchAll(/<link [^>]*href="([^":]+)"/g)) used.add(href);
		for (const file of modulesOf(entryOf(page)[0])) used.add(file);
	}
	for (const file of used) assert.ok(cached.includes(file), `sw.js caches ${file}`);
	// public/ is what gets served, so it holds the app and nothing else (no catalog files, no notes).
	for (const file of cached.filter(f => f !== './'))
		assert.ok(used.has(file), `public/${file} is served and cached, but no page uses it`);
});

test('every page is written from its template, with the shared nav bar marking where it is', () => {
	// The pages in public/ are written by make pages (build.mjs), so a missing one means it wasn't run.
	const templates = fs.readdirSync(path.join(root, 'templates', 'pages')).map(f => f.replace(/\.liquid$/, '.html'));
	assert.deepEqual(templates.sort(), [...ALL_PAGES].sort());
	for (const page of ALL_PAGES) {
		assert.ok(fs.existsSync(path.join(site, page)), `public/${page} is missing: run make pages`);
		const html = read(page);
		for (const link of PAGES) assert.ok(html.includes(`<a href="${link}"`), `${page} links to ${link}`);
		assert.equal(html.match(/class="current"/g)?.length, 1, `${page} marks one link current`);
		// Only the page the link opens is that page; a book's or an author's page sits under its list.
		assert.equal(
			html.includes(`<a href="${page}" class="current" aria-current="page">`),
			PAGES.includes(page),
			page,
		);
	}
});

test('"Not duplicates" marks are kept in this browser and travel in backups', async () => {
	const books = [
		{t: 'The Ledger', a: ['Priya Ostrander']},
		{t: 'The Ledger, Book 1', a: ['Priya Ostrander']},
		{t: 'Salt Road', a: ['Marisol Quenby']},
		{t: 'Salt Road, Book 1', a: ['Marisol Quenby']},
	];
	const pairKey = (x, y) => Duplicates.pairKey(Book.fromJSON(books[x]), Book.fromJSON(books[y]));
	const ledger = pairKey(0, 1);
	const files = {'books.json': JSON.stringify(books), 'not-duplicates.txt': '# header\n' + ledger + '\n'};
	const {ctx, get, run, els, storage} = await boot({page: 'duplicates.html', files});
	const at = get('CATALOG.books.map(b => b.id)');
	// the marks kept hide that pair
	assert.deepEqual(get('DUP_GROUPS'), [[at[2], at[3]]]);

	// marking the other pair keeps it too, by the books' ids
	ctx.keepApart(0);
	assert.deepEqual((await kept(storage)).notDuplicates, [ledger, pairKey(2, 3)]);
	assert.deepEqual(get('[...CATALOG.marks.values()].map(m => m.bookIds)'), [
		[at[0], at[1]].sort(),
		[at[2], at[3]].sort(),
	]);
	assert.deepEqual(get('DUP_GROUPS'), []);
	assert.equal(els.dupCount.textContent, '');
	// so a book retitled is still marked, and a backup has the mark by its new title
	await run("CATALOG.books[3].title = 'Salt Road, Volume 1'; persist()");
	assert.equal(get('CATALOG.duplicates().markedNotSame(CATALOG.books[2], CATALOG.books[3])'), true);
	assert.deepEqual(get('CATALOG.markTexts()')[1], get('Duplicates.pairKey(CATALOG.books[2], CATALOG.books[3])'));
	await run("CATALOG.books[3].title = 'Salt Road, Book 1'; persist()");

	// Export carries every mark; Restore elsewhere brings them back
	const imp = await boot({page: 'import.html', files: {...files, 'not-duplicates.txt': ledger}});
	const blobs = [];
	imp.ctx.Blob = class {
		constructor(parts) {
			blobs.push(parts.join(''));
		}
	};
	imp.ctx.URL = {createObjectURL: () => 'blob:x', revokeObjectURL() {}};
	imp.els.exportBtn.listeners.click[0]();
	await idle();
	const exported = JSON.parse(blobs[0]);
	assert.deepEqual(
		Object.values(exported.marks),
		[{kind: 'notDuplicates', bookIds: imp.get('CATALOG.books.slice(0, 2).map(b => b.id).sort()')}],
		'by the ids of the books',
	);
	// which a Restore elsewhere keeps pointing at those books
	const copy = await boot({page: 'import.html', files: {'books.json': '[]'}});
	await copy.els.importFile.listeners.change[0]({target: {files: [{name: 'b.json', text: blobs[0]}], value: ''}});
	await idle();
	assert.deepEqual(
		copy.get('[...CATALOG.marks.values()]'),
		Object.entries(exported.marks).map(([id, m]) => ({id, ...m})),
	);
	assert.deepEqual(copy.get('CATALOG.markTexts()'), [ledger]);
	const backup = {books, seriesInfo: {}, notDuplicates: [ledger, pairKey(2, 3)]};
	const other = await boot({page: 'import.html', files: {'books.json': JSON.stringify(books)}});
	await other.els.importFile.listeners.change[0]({
		target: {files: [{name: 'b.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	const after = await boot({page: 'duplicates.html', storage: other.storage});
	assert.deepEqual(after.get('DUP_GROUPS'), []);
});

test("Merge previews a backup from another device and keeps both sides' changes", async () => {
	const mine = JSON.stringify([
		{t: 'Here', a: ['Ann Vale']},
		{t: 'Renamed', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}]},
	]);
	const backup = {
		books: [
			{t: 'Here', a: ['Ann Vale'], r: ['2025-06-01']},
			{t: 'Renamed Twice', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}]},
			{t: 'New There', a: ['Ann Vale']},
		],
		seriesInfo: {},
		excluded: ['BGONE9'],
		notDuplicates: ['["editions","id B1"]'],
	};
	const {els, get, storage} = await boot({page: 'import.html', files: {'books.json': mine}});
	els.mergeFile.listeners.change[0]({
		target: {files: [{name: 'phone.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	assert.equal(els.importPreviewTitle.textContent, 'Merge a backup');
	assert.equal(els.importPreview.place, 'after backupPanel');
	assert.ok(els.mergePrefer.classList.contains('show'));
	assert.match(els.importPreviewBody.innerHTML, /New from the backup: 1<\/p><ul><li>New There — Ann Vale/);
	assert.match(
		els.importPreviewBody.innerHTML,
		/keeping this catalog's: 1<\/p><ul><li>Renamed — Ann Vale \/ backup: Renamed Twice/,
	);
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
	els.mergeFile.listeners.change[0]({
		target: {files: [{name: 'phone.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /Nothing to merge/);
	assert.equal(els.importConfirm.style.display, 'none');
});

test('the page compares the catalog with Hardcover itself, with a token kept in this browser, and sends only what is ticked', async () => {
	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
	];
	const state = hardcoverState();
	const hc = fakeHardcover(state);
	let leaving = null; // what leaving the page while it sends would do
	const hardcover = async (url, init) => {
		if (JSON.parse(init.body).query.startsWith('mutation') && !leaving) {
			leaving = {
				preventDefault() {
					this.prevented = true;
				},
			};
			page.fire('beforeunload', leaving);
		}
		return hc.fetch(url, init);
	};
	const setTimeout = (fn, ms) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	}; // the pause between requests
	const page = await boot({page: 'import.html', files: {'books.json': JSON.stringify(mine)}, hardcover, setTimeout});
	const {els, get, readable, storage} = page;
	assert.notEqual(els.hardcoverPanel.style.display, 'none');
	assert.match(els.hardcoverKeyState.textContent, /Paste an API token .* kept in this browser only/);
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	assert.match(els.ioStatus.textContent, /Save your Hardcover API token first/);
	assert.equal(hc.sent.length, 0);

	els.hardcoverKey.value = 'Bearer tok-123';
	await els.hardcoverKeySave.listeners.click[0]();
	await idle();
	assert.equal(storage.get('audiobook-catalog-hardcover-token'), 'tok-123');
	assert.equal(els.hardcoverKey.value, '', 'the token is not left in the page');
	assert.match(els.hardcoverKeyState.textContent, /saved in this browser only/);

	// the comparison: asked from the page, nothing changed anywhere
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	assert.ok(hc.sent.every(s => s.auth === 'Bearer tok-123' && s.url === 'https://api.hardcover.app/v1/graphql'));
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));
	assert.ok(!els.bgTask.classList.contains('show'));
	assert.equal(els.importPreviewTitle.textContent, 'Compare with Hardcover');
	assert.equal(els.importPreview.place, 'after hardcoverPanel');
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(html, /^<p>2 books on your Hardcover Read shelf \(took 0:00\)<\/p>/);
	assert.match(
		html,
		/New from Hardcover \(1\)<\/h4><ul class="cmpRows"><li><label class="cmpPick"><input type="checkbox" data-pick="take:0" checked=""> Tidewater — Ann Vale {2}\[Gull Isle #1\]/,
	);
	// your books go on Hardcover only when ticked
	assert.match(
		html,
		/Not on your Hardcover Read shelf \(1\)<\/h4>.*<input type="checkbox" data-pick="add:0"> Lantern Hours — R\. T\. Hale: read 2024-05-01<\/label>/,
	);
	assert.match(html, /<input type="checkbox" data-pick="ids" checked=""> Save the Hardcover ids found for 1 book/);
	assert.match(
		html,
		/Not added, as Hardcover has no audiobook edition picked for them: 1<\/p><ul><li>The Paper Fen — Ann Vale/,
	);
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');
	assert.equal(get('CATALOG.books.length'), 1);
	assert.equal(state.shelf.length, 2);
	const add = els.importPreviewBody.querySelector('input[data-pick="add:0"]');
	add.checked = true;
	add.dispatch('change');
	assert.equal(els.importConfirm.textContent, 'Apply 3 changes');

	// applying keeps the catalog before sending, and the browser asks before leaving the page meanwhile
	await els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Lantern Hours', 'Tidewater']);
	assert.deepEqual(
		(await kept(storage)).books.map(b => b.t),
		['Lantern Hours', 'Tidewater'],
	);
	assert.equal(get("CATALOG.books[0].idOn('hardcover')"), '80', 'the Hardcover ids found are kept');
	assert.deepEqual(state.shelf.at(-1), {
		id: 102,
		book_id: 80,
		edition_id: 801,
		status_id: 3,
		user_book_reads: [{finished_at: '2024-05-01', edition_id: 801}],
	});
	assert.ok(leaving.prevented, 'leaving while it sends is asked about');
	const after = {
		preventDefault() {
			this.prevented = true;
		},
	};
	page.fire('beforeunload', after);
	assert.ok(!after.prevented, 'not once it is done');
	assert.match(els.importPreviewBody.innerHTML, /put 1 book\(s\) on your Hardcover Read shelf and added 1 read\(s\)/);
	assert.match(els.ioStatus.textContent, /^Added 1 book, saved Hardcover ids found for 1 book; Hardcover updated\./);
	assert.ok(
		!JSON.stringify(get('CATALOG.books')).includes('tok-123') &&
			![...storage.entries()].some(
				([k, v]) => k !== 'audiobook-catalog-hardcover-token' && v.includes('tok-123'),
			),
	);
});

test('a Hardcover comparison flags print books and ebooks, yours and on your shelf, and never sends their edition', async () => {
	const mine = [
		{t: 'Brine Songs', a: ['Ann Vale'], r: ['2024-06-01'], ext: {hardcover: '81'}, e: [{ext: {hardcover: '811'}}]},
		{t: 'Lantern Hours', a: ['R. T. Hale'], ext: {hardcover: '80'}, e: [{ext: {'amazon.com': 'B0LANTERNK'}}]},
	];
	const state = hardcoverState();
	state.editions[821] = {id: 821, book_id: 80, asin: 'B0LANTERNK', reading_format_id: 4, contributions: []};
	const hc = fakeHardcover(state);
	const setTimeout = (fn, ms) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const {els, readable} = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(
		html,
		/Maybe not audiobooks, in this catalog \(2\)<\/h4><p class="cmpNote">By what Hardcover says, these editions of yours may not be audiobooks: if so, give the book its audiobook edition in its form\.<\/p><ul class="cmpRows"><li><a href="book\.html#book=[^"]+">Brine Songs — Ann Vale<\/a>: Hardcover edition 811 is a print book on Hardcover <a href="https:\/\/hardcover\.app\/id\/edition\/811" target="_blank" rel="noopener">hardcover.app ↗<\/a><\/li><li><a href="book\.html#book=[^"]+">Lantern Hours — R\. T\. Hale<\/a>: ASIN B0LANTERNK is an ebook on Hardcover <a href="https:\/\/hardcover\.app\/id\/edition\/821"/,
	);
	assert.match(
		html,
		/Maybe not audiobooks, on your Hardcover shelves \(1\)<\/h4>.*<li>The Paper Fen — Ann Vale: read as a print book \(Hardcover edition 601\) <a href="https:\/\/hardcover\.app\/id\/edition\/601"/,
	);
	assert.doesNotMatch(html, /Editions to add|edition:0/, "the print edition read isn't offered as one of yours");
	const add = els.importPreviewBody.querySelector('input[data-pick="add:0"]');
	assert.match(readable(add.parentNode.innerHTML ?? ''), /Brine Songs/);
	add.checked = true;
	add.dispatch('change');
	await els.importConfirm.listeners.click[0]();
	await idle();
	const sent = state.shelf.at(-1);
	assert.equal(sent.book_id, 81);
	assert.ok(!sent.edition_id, 'the print edition is not sent');
	assert.deepEqual(
		sent.user_book_reads.map(r => r.finished_at),
		['2024-06-01'],
	);
});

test('the catalog proxy is kept in this browser, checked when saved, and only ever sent its own key', async () => {
	// the real Worker (proxy/worker.js) behind the page, with no catalog behind it
	const env = {PROXY_KEY: 'right-key', ALLOWED_ORIGINS: 'https://example.github.io'};
	const sent = [];
	const proxy = async (url, init = {}) => {
		sent.push({url, headers: init.headers});
		const request = new Request(url, {headers: {...init.headers, Origin: 'https://example.github.io'}});
		return handleProxy(request, env, {
			fetch: async () => {
				throw new Error('no catalog in this test');
			},
		});
	};
	const storage = new Map();
	const {els} = await boot({page: 'import.html', proxy, storage});
	assert.match(els.proxyState.textContent, /Paste your proxy's address and key/);
	assert.equal(els.proxyCheck.style.display, 'none');

	els.proxyUrl.value = 'http://catalog-proxy.example.workers.dev';
	els.proxyKey.value = 'right-key';
	await els.proxySave.listeners.click[0]();
	assert.match(els.ioStatus.textContent, /Paste the proxy's address first/, 'not https');
	assert.equal(storage.get('audiobook-catalog-proxy'), undefined);

	els.proxyUrl.value = 'https://catalog-proxy.example.workers.dev/';
	els.proxyKey.value = 'wrong-key';
	await els.proxySave.listeners.click[0]();
	assert.match(els.ioStatus.textContent, /^Catalog proxy saved; the proxy refused the key\.$/);

	els.proxyUrl.value = 'https://catalog-proxy.example.workers.dev/';
	els.proxyKey.value = ' right-key ';
	await els.proxySave.listeners.click[0]();
	assert.equal(
		els.ioStatus.textContent,
		'Catalog proxy saved; it answers, for audiobookdb, audible, bookbrainz, isfdb.',
	);
	assert.deepEqual(JSON.parse(storage.get('audiobook-catalog-proxy')), {
		url: 'https://catalog-proxy.example.workers.dev',
		key: 'right-key',
	});
	assert.equal(els.proxyKey.value, '', 'the key is not left in the page');
	assert.match(els.proxyState.textContent, /Saved in this browser only .*catalog-proxy\.example\.workers\.dev/);
	assert.ok(sent.every(s => s.url === 'https://catalog-proxy.example.workers.dev/ping'));
	assert.equal(JSON.stringify(sent.at(-1).headers), '{"X-Proxy-Key":"right-key"}');

	await els.proxyCheck.listeners.click[0]();
	assert.match(els.ioStatus.textContent, /^The catalog proxy answers/);
	await els.proxyRemove.listeners.click[0]();
	assert.equal(storage.get('audiobook-catalog-proxy'), undefined);
	assert.match(els.proxyState.textContent, /Paste your proxy's address/);

	// a proxy the browser can't reach (or that refuses this page, which a browser can't tell apart)
	const away = await boot({
		page: 'import.html',
		storage: new Map([
			['audiobook-catalog-proxy', JSON.stringify({url: 'https://gone.example.workers.dev', key: 'k'})],
		]),
	});
	await away.els.proxyCheck.listeners.click[0]();
	assert.match(away.els.ioStatus.textContent, /could not reach the catalog proxy/);
});

test('a Hardcover comparison sends nothing unticked, nothing once another tab saved, and says when Hardcover cannot be reached', async () => {
	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
	];
	const state = hardcoverState();
	const hc = fakeHardcover(state);
	const setTimeout = (fn, ms) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const page = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	const {els, get} = page;
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	// as it opens, only what an import takes is ticked
	await els.importConfirm.listeners.click[0]();
	await idle();
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')), 'nothing ticked to send, nothing sent');
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Lantern Hours', 'Tidewater']);
	assert.equal(get("CATALOG.books[0].idOn('hardcover')"), '80');
	assert.match(els.ioStatus.textContent, /^Added 1 book, saved Hardcover ids found for 1 book\.$/);

	// compared, then another tab saves an edit: applying changes and sends nothing
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	const add =
		els.importPreviewBody.querySelector('input[data-pick="reads:0"]') ||
		els.importPreviewBody.querySelector('input[data-pick="add:0"]');
	assert.ok(add, 'Lantern Hours is still to be put on Hardcover');
	add.checked = true;
	add.dispatch('change');
	const other = await boot({page: 'duplicates.html', storage}); // a page that holds every book
	await other.run("CATALOG.books[0].genres = ['Fantasy']; persist();");
	await other.saved();
	await els.importConfirm.listeners.click[0]();
	await idle();
	assert.match(
		els.ioStatus.textContent,
		/edited in another tab since you compared; nothing was changed, nothing sent to Hardcover/,
	);
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));

	const offline = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		setTimeout,
		storage: new Map([['audiobook-catalog-hardcover-token', 'tok-123']]),
	});
	await offline.els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	assert.match(
		offline.els.importPreviewBody.innerHTML,
		/Couldn't compare: this browser could not reach Hardcover \(offline/,
	);
	assert.equal(offline.els.importConfirm.style.display, 'none');
});

test("the Hardcover comparison can be only a series' or an author's books", async () => {
	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2'},
	];
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn, ms) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const {els, readable} = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	assert.equal(els.hardcoverScopeName.style.display, 'none');
	els.hardcoverScope.value = 'series';
	els.hardcoverScope.listeners.change[0]();
	await idle();
	assert.equal(els.hardcoverScopeName.style.display, '');
	assert.equal(
		readable(els.hardcoverScopeNames.innerHTML),
		'<option value="Gull Isle"></option>',
		'the series in the catalog are offered',
	);
	await els.hardcoverCompareBtn.listeners.click[0]();
	assert.match(els.ioStatus.textContent, /Type the series to compare first/);
	els.hardcoverScopeName.value = 'Ember Coast';
	await els.hardcoverCompareBtn.listeners.click[0]();
	assert.match(els.ioStatus.textContent, /No book in this catalog is in the series “Ember Coast”/);
	assert.equal(hc.sent.length, 0);

	els.hardcoverScopeName.value = 'Gull Isle';
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(html, /^<p>Only the series “Gull Isle”: 1 book in this catalog, 1 on your Hardcover Read shelf/);
	assert.match(html, /New from Hardcover \(1\)<\/h4>.*Tidewater — Ann Vale/);
	assert.doesNotMatch(html, /Paper Fen|Lantern Hours/);
	assert.match(html, /Not found on Hardcover \(1\)<\/h4>.*Brine Tide — Ann Vale/);
});

test("a series' or an author's page links to comparing their books with Hardcover, which starts it", async () => {
	const home = await boot({hash: '#series=The+Lantern+Coast'});
	await idle();
	// at the end of the page, beside Edit
	assert.match(
		home.readable(home.els.results.innerHTML),
		/<div class="page-actions"><button type="button" class="sedit" data-series="[^"]+">Edit<\/button><button type="button" class="catalogCompare" data-compare="hardcover">Compare with Hardcover<\/button>/,
	);
	const session = new Map();
	const author = await boot({page: 'author.html', hash: '#a=Marisol+Quenby', session});
	assert.match(
		author.readable(author.els.creditBody.innerHTML),
		/<div class="page-actions"><button type="button" class="aedit">Edit<\/button><button type="button" class="catalogCompare" data-compare="hardcover">Compare their books with Hardcover<\/button>/,
	);
	// the button hands the comparison over in this tab's sessionStorage, and opens Import & export as it is
	author.els.creditBody.querySelector('button[data-compare="hardcover"]').listeners.click[0]();
	assert.equal(author.ctx.location.assigned, 'import.html');
	assert.deepEqual(JSON.parse(session.get('audiobook-catalog-compare')), {
		catalog: 'hardcover',
		kind: 'author',
		id: author.get('CATALOG.nameIds.authors.get("Marisol Quenby")'),
	});

	const mine = [
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2'},
		{t: 'Lantern Hours', a: ['R. T. Hale']},
	];
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn, ms) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map([['audiobook-catalog-hardcover-token', 'tok-123']]);
	// the catalog Import & export reads is this one, where Ann Vale is known by a name, as from an older link
	session.set('audiobook-catalog-compare', JSON.stringify({catalog: 'hardcover', kind: 'author', id: 'Ann Vale'}));
	const {els, get, readable} = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		hardcover: hc.fetch,
		setTimeout,
		storage,
		session,
	});
	await idle();
	assert.deepEqual([els.hardcoverScope.value, els.hardcoverScopeName.value], ['author', 'Ann Vale']);
	assert.equal(els.importPreviewTitle.textContent, 'Compare with Hardcover');
	assert.match(
		readable(els.importPreviewBody.innerHTML),
		/^<p>Only books by Ann Vale: 1 book in this catalog, 2 on your Hardcover Read shelf/,
	);
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));
	assert.equal(get('CATALOG.books.length'), 2, 'comparing changes nothing');
});

// ------------------------------------------------------------------ AudiobookDB
const PROXY_ENV = {PROXY_KEY: 'right-key', ALLOWED_ORIGINS: 'https://example.github.io'};
const PROXY_SAVED = [
	'audiobook-catalog-proxy',
	JSON.stringify({url: 'https://catalog-proxy.example.workers.dev', key: 'right-key'}),
];

/** The real Worker (proxy/worker.js) in front of a fake AudiobookDB, as the page reaches it; `asked` is what the page sent. */
function audiobookdbBehindProxy(state = audiobookdbState()) {
	const abdb = fakeAudiobookdb(state);
	const asked = [];
	const proxy = async (url, init = {}) => {
		asked.push({url, headers: init.headers, method: init.method || 'GET'});
		const request = new Request(url, {
			method: init.method,
			body: init.body,
			headers: {...init.headers, Origin: 'https://example.github.io'},
		});
		return handleProxy(request, PROXY_ENV, {fetch: abdb.fetch});
	};
	return {state, abdb, proxy, asked};
}
// the pause between AudiobookDB requests passes at once
const abdbTimeout = (fn, ms) => {
	if (ms === 500) Promise.resolve().then(fn);
	return 0;
};

test('the page compares the catalog with AudiobookDB through the proxy, with a key kept in this browser, and puts only what is ticked on your Read shelf', async () => {
	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [{ext: {'audible.com': 'B0BRINETD1'}}]},
	];
	const {state, abdb, proxy, asked} = audiobookdbBehindProxy();
	let leaving = null; // what leaving the page while it sends would do
	state.onAdd = () => {
		if (!leaving) {
			leaving = {
				preventDefault() {
					this.prevented = true;
				},
			};
			page.fire('beforeunload', leaving);
		}
	};
	const storage = new Map([PROXY_SAVED]);
	const page = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		proxy,
		storage,
		setTimeout: abdbTimeout,
	});
	const {els, get, readable} = page;
	assert.match(
		els.audiobookdbKeyState.textContent,
		/Paste an API key from audiobookdb\.org .* Without it, Compare only finds your books there\./,
	);
	assert.equal(els.audiobookdbKeyRemove.style.display, 'none');

	// without a key, Compare only finds your books, and asks nothing of your account
	await els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	assert.equal(els.importPreviewTitle.textContent, 'Compare with AudiobookDB');
	assert.equal(els.importPreview.place, 'after audiobookdbPanel');
	let html = readable(els.importPreviewBody.innerHTML);
	assert.match(html, /^<p>2 books in this catalog, 2 of them on AudiobookDB \(took 0:00\)<\/p>/);
	assert.match(html, /Save your AudiobookDB API key \(below the buttons\) to compare your shelves too/);
	assert.match(
		html,
		/<input type="checkbox" data-pick="ids" checked=""> Save the AudiobookDB ids and covers found for 2 books, 3 series and people/,
	);
	assert.ok(
		abdb.sent.every(s => s.method === 'GET' && s.key === null),
		'no key, and nothing sent',
	);
	assert.ok(!abdb.sent.some(s => s.path.startsWith('users/') || s.path === 'auth/session'));
	els.importCancel.listeners.click[0]();

	els.audiobookdbKey.value = ' abdb-key-1 ';
	els.audiobookdbKeySave.listeners.click[0]();
	assert.equal(storage.get('audiobook-catalog-audiobookdb-key'), 'abdb-key-1');
	assert.equal(els.audiobookdbKey.value, '', 'the key is not left in the page');
	assert.match(els.audiobookdbKeyState.textContent, /saved in this browser only/);

	// with it: your Read shelf beside the catalog, and your books to put there
	abdb.sent.length = 0;
	await els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	html = readable(els.importPreviewBody.innerHTML);
	assert.match(
		html,
		/^<p>2 books in this catalog, 2 of them on AudiobookDB, 2 books on your AudiobookDB Listened shelf \(took 0:00\)<\/p>/,
	);
	assert.match(
		html,
		/New from AudiobookDB \(1\)<\/h4><ul class="cmpRows"><li><label class="cmpPick"><input type="checkbox" data-pick="take:0" checked=""> Tidewater — Ann Vale {2}\[Gull Isle #1\]/,
	);
	assert.match(
		html,
		/Not on your AudiobookDB Listened shelf \(1\)<\/h4>.*<input type="checkbox" data-pick="add:0"> Lantern Hours — R\. T\. Hale<\/label>/,
	);
	assert.match(
		html,
		/On another AudiobookDB shelf, left alone \(1\)<\/h4>.*Brine Tide — Ann Vale {2}\[Gull Isle #2\]: Currently Listening/,
	);
	assert.match(
		html,
		/Not added, as AudiobookDB has several releases of them and none is yours: 1\..*The Paper Fen — Ann Vale/,
	);
	assert.match(html, /Save the AudiobookDB ids and covers found for 2 books, 5 series and people/);
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');
	assert.ok(!abdb.sent.some(s => s.method === 'POST'), 'comparing sends nothing');
	// the key went only where it is needed
	assert.deepEqual(
		[...new Set(abdb.sent.filter(s => s.key).map(s => s.path))],
		['auth/session', 'users/username/reader/shelves'],
	);
	assert.ok(abdb.sent.filter(s => s.key).every(s => s.key === 'abdb-key-1'));
	assert.ok(asked.every(a => a.headers['X-Proxy-Key'] === 'right-key'));
	assert.ok(
		asked.every(a => !a.headers['X-Catalog-Key'] || /\/audiobookdb\/(auth\/session|users\/)/.test(a.url)),
		'the page sends the key only there too',
	);

	const add = els.importPreviewBody.querySelector('input[data-pick="add:0"]');
	add.checked = true;
	add.dispatch('change');
	assert.equal(els.importConfirm.textContent, 'Apply 3 changes');
	await els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Lantern Hours', 'Brine Tide', 'Tidewater']);
	const saved = await kept(storage);
	assert.deepEqual(
		saved.books.map(b => [b.t, b.ext, b.e.map(e => e.ext)]),
		[
			[
				'Lantern Hours',
				{audiobookdb: 'LntrnHours01'},
				[{'audible.com': 'B0LANTERN1', audiobookdb: 'RlsLntrnHrs1'}],
			],
			['Brine Tide', {audiobookdb: 'BrineTide001'}, [{'audible.com': 'B0BRINETD1', audiobookdb: 'RlsBrineUS01'}]],
			['Tidewater', {audiobookdb: 'Tidewater001'}, [{audiobookdb: 'RlsTidewatr1'}]],
		],
	);
	// the covers: Lantern Hours' book's (its release has none), Tidewater's release's; Brine Tide has none
	assert.deepEqual(
		saved.books.map(b => b.e.map(e => e.img)),
		[[{audiobookdb: 'a1'.repeat(32)}], [undefined], [{audiobookdb: 'd2'.repeat(32)}]],
	);
	assert.deepEqual(saved.authors['R. T. Hale'].ext, {audiobookdb: 'PrsnHale0001'});
	assert.deepEqual(saved.authors['Ann Vale'].ext, {audiobookdb: 'PrsnVale0001'});
	assert.deepEqual(saved.seriesInfo['Gull Isle'].ext, {audiobookdb: 'SrsGullIsle1'});
	assert.deepEqual(saved.narrators['Dana Fenwick'].ext, {audiobookdb: 'PrsnFnwk0001'});
	assert.deepEqual(saved.publishers['Gullwing Audio'].ext, {audiobookdb: 'PblshrGullw1'});
	assert.deepEqual(
		abdb.sent.filter(s => s.method === 'POST').map(s => [s.path, s.key]),
		[['users/username/reader/shelves/listened/books', 'abdb-key-1']],
	);
	assert.deepEqual(
		state.shelves[2].books.map(b => b.id),
		['Tidewater001', 'PaperFen0001', 'LntrnHours01'],
	);
	assert.ok(leaving.prevented, 'leaving while it sends is asked about');
	assert.match(els.importPreviewBody.innerHTML, /put 1 book\(s\) on your AudiobookDB Listened shelf/);
	assert.match(
		els.ioStatus.textContent,
		/^Added 1 book, saved AudiobookDB ids and covers found for 2 books and 5 series and people; AudiobookDB updated\./,
	);
	assert.ok(
		![...storage.entries()].some(([k, v]) => k !== 'audiobook-catalog-audiobookdb-key' && v.includes('abdb-key-1')),
		'the key is in no backup or record',
	);

	// comparing again: nothing left to send, nothing left to take
	await els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	html = readable(els.importPreviewBody.innerHTML);
	assert.doesNotMatch(html, /Not on your AudiobookDB Listened shelf|New from AudiobookDB|Save the AudiobookDB ids/);
});

test("an AudiobookDB comparison can be only a series' or an author's books, and their pages link to it", async () => {
	const home = await boot({hash: '#series=The+Lantern+Coast'});
	await idle();
	assert.match(
		home.readable(home.els.results.innerHTML),
		/<button type="button" class="catalogCompare" data-compare="audiobookdb">Compare with AudiobookDB<\/button>/,
	);
	const author = await boot({page: 'author.html', hash: '#a=Marisol+Quenby'});
	assert.match(
		author.readable(author.els.creditBody.innerHTML),
		/<button type="button" class="catalogCompare" data-compare="audiobookdb">Compare their books with AudiobookDB<\/button>/,
	);

	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [{ext: {'audible.com': 'B0BRINETD1'}}]},
	];
	const {abdb, proxy} = audiobookdbBehindProxy();
	const storage = new Map([PROXY_SAVED, ['audiobook-catalog-audiobookdb-key', 'abdb-key-1']]);
	const {els, get, readable} = await boot({
		page: 'import.html',
		hash: '#audiobookdb-series=Gull+Isle',
		files: {'books.json': JSON.stringify(mine)},
		proxy,
		storage,
		setTimeout: abdbTimeout,
	});
	await idle();
	assert.deepEqual([els.audiobookdbScope.value, els.audiobookdbScopeName.value], ['series', 'Gull Isle']);
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(
		html,
		/^<p>Only the series “Gull Isle”: 1 book in this catalog, 1 of them on AudiobookDB, 1 book on your AudiobookDB Listened shelf/,
	);
	assert.match(html, /New from AudiobookDB \(1\)<\/h4>.*Tidewater — Ann Vale/);
	assert.doesNotMatch(html, /Paper Fen|Lantern Hours/);
	assert.match(html, /On another AudiobookDB shelf, left alone \(1\)<\/h4>.*Brine Tide/);
	assert.match(html, /In the series on AudiobookDB, not in this catalog: 1<\/summary><ul><li>Gull Song<\/li>/);
	assert.ok(abdb.sent.some(s => s.path === 'series/SrsGullIsle1?include=books'));
	assert.ok(
		!abdb.sent.some(s => s.path === 'audiobooks/external/audible/B0LANTERN1'),
		"only the series' books are looked up",
	);
	assert.equal(get('CATALOG.books.length'), 2, 'comparing changes nothing');

	// an author: their books on your Read shelf, by the names AudiobookDB gives them
	els.audiobookdbScope.value = 'author';
	els.audiobookdbScope.listeners.change[0]();
	els.audiobookdbScopeName.value = 'R. T. Hale';
	await els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	const byHale = readable(els.importPreviewBody.innerHTML);
	assert.match(
		byHale,
		/^<p>Only books by R\. T\. Hale: 1 book in this catalog, 1 of them on AudiobookDB, 0 books on your AudiobookDB Listened shelf/,
	);
	assert.match(byHale, /Not on your AudiobookDB Listened shelf \(1\)<\/h4>.*Lantern Hours/);
	assert.doesNotMatch(byHale, /Tidewater|Brine Tide/);
});

test("a series is compared with Audible through the proxy, and Apply fills in its books' editions and the series' id", async () => {
	const home = await boot({hash: '#series=The+Lantern+Coast'});
	await idle();
	assert.match(
		home.readable(home.els.results.innerHTML),
		/<button type="button" class="catalogCompare" data-compare="audible">Compare with Audible<\/button>/,
	);
	const author = await boot({page: 'author.html', hash: '#a=Marisol+Quenby'});
	assert.doesNotMatch(author.els.creditBody.innerHTML, /data-compare="audible"/, 'Audible compares a series only');

	const mine = [
		{t: 'The Lantern Keeper', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [{ext: {'audible.com': 'B0LANTERN2'}}]},
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '4', e: [{p: 'Gullwing Audio'}]},
	];
	// the real Worker in front of Audible's catalog
	const behind = fakeProxyCatalogs();
	const audible = async url => {
		const u = new URL(url);
		const site = u.hostname.replace(/^api\./, '');
		return behind.route(`audible/${site}${u.pathname.replace(/^\/1\.0/, '')}${u.search}`);
	};
	const proxy = async (url, init = {}) =>
		handleProxy(new Request(url, {headers: {...init.headers, Origin: 'https://example.github.io'}}), PROXY_ENV, {
			fetch: async upstream => {
				const res = await audible(String(upstream.url || upstream));
				return new Response(JSON.stringify(await res.json()), {status: res.status});
			},
		});
	const storage = new Map([PROXY_SAVED]);
	const {els, get, readable} = await boot({
		page: 'import.html',
		hash: '#audible-series=Gull+Isle',
		files: {'books.json': JSON.stringify(mine)},
		proxy,
		storage,
		setTimeout: (fn, ms) => {
			if (ms === 250) Promise.resolve().then(fn);
			return 0;
		},
	});
	await idle();
	assert.deepEqual([els.audibleScope.value, els.audibleScopeName.value], ['series', 'Gull Isle']);
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(
		html,
		/^<p>Only the series “Gull Isle”: 2 books in this catalog, 4 books in the series on audible\.com/,
	);
	assert.match(html, /The Lantern Keeper/);
	assert.match(html, /Save the Audible ids and book counts found for 1 series/);
	assert.match(
		html,
		/In the series on Audible, not in this catalog: 2<\/summary><ul><li>1\. Salt Road<\/li><li>3\. Gull Song<\/li>/,
	);
	assert.doesNotMatch(html, /Save your Audible|shelf/, 'no key and no shelves');
	assert.ok(behind.sent.every(r => r.startsWith('audible/audible.com/catalog/')));
	assert.equal(get('CATALOG.books.length'), 2, 'comparing changes nothing');

	// the edition found by its ASIN is yours, so it is ticked; Brine Tide's is the one of its number, to tick
	const edition = n => els.importPreviewBody.querySelector(`input[data-pick="editions:${n}"]`);
	assert.match(html, /data-pick="editions:0" checked="">/);
	assert.match(html, /data-pick="editions:1">/);
	edition(1).checked = true;
	edition(1).dispatch('change');
	await els.importConfirm.listeners.click[0]();
	await idle();
	const saved = await kept(storage);
	assert.deepEqual(
		saved.books.map(b => [b.t, b.e.map(e => [e.ext, e.n, e.len])]),
		[
			['The Lantern Keeper', [[{'audible.com': 'B0LANTERN2'}, ['Hollis Marr', 'Dana Fenwick'], 612]]],
			['Brine Tide', [[{'audible.com': 'B0BRINETD4'}, ['Dana Fenwick'], 480]]],
		],
	);
	assert.deepEqual(
		[saved.seriesInfo['Gull Isle'].ext, saved.seriesInfo['Gull Isle'].total],
		[{'audible.com': 'B0SERIES02'}, 4],
	);
	assert.match(els.ioStatus.textContent, /Audible ids and book counts found for 1 series/);
});

test('a series is compared with every catalog at once, and Apply takes only the values picked', async () => {
	const home = await boot({hash: '#series=The+Lantern+Coast'});
	await idle();
	assert.match(
		home.readable(home.els.results.innerHTML),
		/<button type="button" class="catalogCompare" data-compare="all">Compare with all catalogs<\/button>/,
	);

	const mine = [
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '4', e: [{ext: {'amazon.com': 'B0BRINETD1'}}]},
	];
	// Brine Tide on your AudiobookDB Read shelf (Listened), not Currently Listening
	const state = audiobookdbState();
	state.shelves[2].books.push(...state.shelves[1].books.splice(0));
	const abdb = fakeAudiobookdb(state);
	// the real Worker in front of AudiobookDB and of Audible's catalog
	const behind = fakeProxyCatalogs();
	const proxy = async (url, init = {}) =>
		handleProxy(
			new Request(url, {
				method: init.method,
				body: init.body,
				headers: {...init.headers, Origin: 'https://example.github.io'},
			}),
			PROXY_ENV,
			{
				fetch: async (upstream, opts) => {
					const u = new URL(String(upstream.url || upstream));
					if (!/audible\./.test(u.hostname)) return abdb.fetch(upstream, opts);
					const site = u.hostname.replace(/^api\./, '');
					const res = await behind.route(`audible/${site}${u.pathname.replace(/^\/1\.0/, '')}${u.search}`);
					return new Response(JSON.stringify(await res.json()), {status: res.status});
				},
			},
		);
	const storage = new Map([PROXY_SAVED, ['audiobook-catalog-audiobookdb-key', 'abdb-key-1']]);
	const {els, get, readable} = await boot({
		page: 'import.html',
		hash: '#all-series=Gull+Isle',
		files: {
			'books.json': JSON.stringify(mine),
			'series-info.json': JSON.stringify({'Gull Isle': {ext: {'audible.com': 'B0SERIES02'}}}),
		},
		proxy,
		storage,
		setTimeout: (fn, ms) => {
			if (ms === 250 || ms === 500) Promise.resolve().then(fn);
			return 0;
		},
	});
	await idle();
	assert.deepEqual([els.allScope.value, els.allScopeName.value], ['series', 'Gull Isle']);
	assert.equal(els.importPreview.place, 'after allPanel');
	assert.equal(els.importPreviewTitle.textContent, 'Compare the series “Gull Isle” with AudiobookDB and Audible');
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(html, /<p>Hardcover: not asked, as it needs your Hardcover API token \(below\)\.<\/p>/);
	assert.match(html, /<p>Audible: 1 book in this catalog, 4 books in the series on audible\.com<\/p>/);
	// where they differ: every value, once, with the catalogs that have it, and this catalog's picked
	assert.match(
		html,
		/Released: <label class="cmpPick cmpChoice"><input type="radio" name="v:0:d:0" data-pick="value:0:d:0:here" checked=""> <span class="cmpHere">none<\/span> here<\/label> <label[^>]*><input type="radio" name="v:0:d:0" data-pick="value:0:d:0:0"> <span class="cmpThere">2020-02-02<\/span> on AudiobookDB<\/label> <label[^>]*><input type="radio" name="v:0:d:0" data-pick="value:0:d:0:1"> <span class="cmpThere">2023-09-12<\/span> on Audible<\/label>/,
	);
	assert.match(html, /<span class="cmpThere">8h<\/span> on AudiobookDB and Audible/);
	assert.match(
		html,
		/Number in series: .*<span class="cmpHere">4<\/span> here.*<span class="cmpThere">2<\/span> on AudiobookDB/,
	);
	assert.match(
		html,
		/New books \(1\)<\/h4>.*data-pick="fresh:0:none" checked=""> not added<\/label> <label[^>]*><input type="radio" name="f:0" data-pick="fresh:0:0"> from AudiobookDB: <span class="cmpThere">Tidewater — Ann Vale/,
	);
	assert.match(html, /data-pick="editions:1:0"> the Audible edition: audible\.com id, narrators/);
	assert.match(html, /In the series on Audible, not in this catalog: 3<\/summary>/);
	// each catalog's books that may not be audiobooks, as in its own comparison
	assert.match(
		html,
		/Maybe not audiobooks, in this catalog \(1\)<\/h4>.*<a href="book\.html#book=[^"]+">Brine Tide — Ann Vale {2}\[Gull Isle #4\]<\/a>: ASIN B0BRINETD1 is not sold on audible\.com: maybe a Kindle or print edition's ASIN <a href="https:\/\/www\.amazon\.com\/dp\/B0BRINETD1"/,
	);
	assert.doesNotMatch(html, /checked=""><\/?[^h]|type="checkbox"[^>]*checked/, 'no tickbox is ticked');
	assert.equal(els.importConfirm.style.display, 'none', 'nothing is picked at first');

	const pick = name => {
		const input = els.importPreviewBody.querySelector(`input[data-pick="${name}"]`);
		input.checked = true;
		input.dispatch('change');
	};
	pick('value:0:d:0:1');
	pick('value:0:n:0:0');
	pick('value:0:sn:0');
	pick('value:0:sn:here'); // changed back: the number stays
	pick('fresh:0:0');
	pick('ids:1');
	assert.equal(els.importConfirm.textContent, 'Apply 4 changes');
	await els.importConfirm.listeners.click[0]();
	await idle();
	const saved = await kept(storage);
	assert.deepEqual(
		saved.books.map(b => [b.t, b.sn, b.e.map(e => [e.ext, e.n, e.d, e.p, e.len])]),
		[
			['Brine Tide', '4', [[{'amazon.com': 'B0BRINETD1'}, ['Dana Fenwick'], '2023-09-12', undefined, undefined]]],
			[
				'Tidewater',
				'1',
				[[{audiobookdb: 'RlsTidewatr1'}, ['Dana Fenwick'], '2020-02-02', 'Gullwing Audio', 570]],
			],
		],
	);
	assert.deepEqual(
		[saved.seriesInfo['Gull Isle'].ext, saved.seriesInfo['Gull Isle'].total],
		[{'audible.com': 'B0SERIES02'}, 4],
	);
	assert.equal(saved.authors['Ann Vale'], undefined, "AudiobookDB's ids found weren't picked");
	assert.ok(!abdb.sent.some(s => s.method === 'POST'), 'nothing is sent');
	assert.equal(get('CATALOG.books.length'), 2);
	assert.match(
		els.ioStatus.textContent,
		/AudiobookDB: Added 1 book.*Audible: saved Audible ids and book counts found for 1 series or person; changed 2 values\./,
	);
});

test('AudiobookDB needs the proxy, says when the proxy is out of date, and says when it refuses the key', async () => {
	const mine = [{t: 'Lantern Hours', a: ['R. T. Hale'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]}];
	const none = await boot({page: 'import.html', files: {'books.json': JSON.stringify(mine)}});
	await none.els.audiobookdbCompareBtn.listeners.click[0]();
	assert.match(none.els.ioStatus.textContent, /AudiobookDB is asked through your catalog proxy: save one first/);

	const {proxy} = audiobookdbBehindProxy();
	const wrong = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		proxy,
		setTimeout: abdbTimeout,
		storage: new Map([PROXY_SAVED, ['audiobook-catalog-audiobookdb-key', 'not-my-key']]),
	});
	await wrong.els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	assert.match(wrong.els.importPreviewBody.innerHTML, /Couldn't compare: AudiobookDB refused your API key/);
	assert.equal(wrong.els.importConfirm.style.display, 'none');

	// a proxy deployed before AudiobookDB's shelves: it refuses the key
	const old = async (url, init = {}) =>
		init.headers['X-Catalog-Key']
			? new Response('{"error":"This path takes no catalog key."}', {status: 400})
			: proxy(url, init);
	const stale = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		proxy: old,
		setTimeout: abdbTimeout,
		storage: new Map([PROXY_SAVED, ['audiobook-catalog-audiobookdb-key', 'abdb-key-1']]),
	});
	await stale.els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	assert.match(
		stale.els.importPreviewBody.innerHTML,
		/Couldn't compare: the catalog proxy refused it \(400\): run npx wrangler deploy in proxy\/ to bring it up to date/,
	);
});

// ------------------------------------------------------------------ the authors page
test('the authors page lists every author, with their books and series, and a search narrows it', async () => {
	const {els, readable} = await boot({page: 'authors.html'});
	const authors = new Set(demoBooks.flatMap(b => b.a));
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, authors.size);
	assert.match(
		els.subtitle.textContent,
		new RegExp(`^${authors.size} authors across ${demoBooks.length} audiobooks`),
	);
	assert.match(
		readable(els.creditBody.innerHTML),
		/<a class="srow-title" href="author\.html#a=Priya\+Ostrander">Priya Ostrander<\/a>\s*<span class="srow-owned">3 books, 1 series<\/span>/,
	);
	// the first line of a bio, when there is one
	assert.match(readable(els.creditBody.innerHTML), /Priya Ostrander writes cozy mysteries/);
	els.q.value = 'ferran';
	els.q.listeners.input[0]();
	await idle();
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, 1);
	els.q.value = 'zzzz';
	els.q.listeners.input[0]();
	await idle();
	assert.match(readable(els.creditBody.innerHTML), /No authors match/);
});

test("someone's page from before it had its own goes there, and their page without an address goes to the list", async () => {
	for (const [list, hash, page] of [
		['authors.html', '#a=Marisol+Quenby', 'author.html'],
		['narrators.html', '#n=id-7', 'narrator.html'],
		['publishers.html', '#p=Kestrel+Row+Audio', 'publisher.html'],
	]) {
		const moved = await boot({page: list, hash});
		assert.equal(moved.ctx.location.replaced, page + hash, list + hash);
		const stays = await boot({page: list});
		assert.equal(stays.ctx.location.replaced, null, list);
		const bare = await boot({page});
		assert.equal(bare.ctx.location.replaced, list, page);
	}
	// typed into the list's address
	const {ctx, fire} = await boot({page: 'authors.html'});
	ctx.location.hash = '#a=Priya+Ostrander';
	fire('hashchange');
	assert.equal(ctx.location.replaced, 'author.html#a=Priya+Ostrander');
});

test("an author's page shows their bio, their links, and their series and titles from the catalog", async () => {
	const {ctx, els, fire, readable} = await boot({page: 'author.html', hash: '#a=Marisol+Quenby'});
	const html = readable(els.creditBody.innerHTML);
	assert.equal(ctx.document.title, 'Marisol Quenby · Audiobook Catalog');
	assert.match(els.crumb.innerHTML, /<a href="authors\.html">← All authors<\/a>/);
	assert.match(html, /<h2 class="author-name">Marisol Quenby<\/h2>/);
	assert.match(
		html,
		/<div class="author-bio"><p>Marisol Quenby writes seafaring fantasy[^<]*<\/p><p>The Lantern Coast began/,
	);
	for (const [label, url] of [
		['Website', 'https://example.com/'],
		['Audible', 'https://www.audible.com/author/'],
		['Goodreads', 'https://www.goodreads.com/author/show/'],
		['Hardcover', 'https://hardcover.app/authors/'],
	]) {
		assert.match(
			html,
			new RegExp(
				`<a class="authorlink" href="${url.replace(/[./]/g, '\\$&')}[^"]*" target="_blank" rel="noopener">${label} ↗</a>`,
			),
		);
	}
	// the series, with how many are owned of the released total, its books in order, each a link to it in the catalog
	assert.match(
		html,
		/<a href="index\.html#series=The\+Lantern\+Coast">The Lantern Coast<\/a> <span class="n">4 owned of 5<\/span> <span class="status ongoing">ongoing<\/span>/,
	);
	assert.match(
		html,
		/#1<\/span> <a href="book\.html#book=The\+Salt\+Road">The Salt Road<\/a><\/li><li>.*#2<\/span> <a href="book\.html#book=Beacons\+at\+Low\+Tide">/,
	);
	assert.equal(els.subtitle.textContent, '4 audiobooks in 1 series');
	// and the numbers none of her books has
	assert.match(html, /<\/p><p class="series-note">missing #\d+<\/p><ul class="author-books">/);

	// another author's page, by its address: her series, and a book outside it she wrote with someone else
	ctx.location.hash = '#a=Priya+Ostrander';
	fire('hashchange');
	await idle();
	const priya = readable(els.creditBody.innerHTML);
	assert.match(
		priya,
		/Halloway &amp; Finch<\/a> <span class="n">2 owned of 2<\/span> <span class="status complete">/,
	);
	assert.match(priya, /Outside a series <span class="n">1 book<\/span>/);
	assert.doesNotMatch(priya, /series-note/, 'none missing');
	assert.match(
		priya,
		/Nine Ways to Lose a Kingdom<\/a> <span class="with">with <a href="#a=Ferran\+Doyle">Ferran Doyle<\/a><\/span>/,
	);
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
	assert.equal(ctx.document.title, 'Nobody Here · Audiobook Catalog', 'named, though no book has them');
	assert.match(els.creditBody.innerHTML, /<h2 class="author-name">Nobody Here<\/h2>/);
	// an address naming no one goes to the list
	ctx.location.hash = '';
	fire('hashchange');
	await idle();
	assert.equal(ctx.location.replaced, 'authors.html');
});

// ------------------------------------------------------------------ the narrators and publishers pages
test('the narrators page lists every narrator of the editions, with their bio or the authors they read, and a search narrows it', async () => {
	const {ctx, els, readable} = await boot({page: 'narrators.html'});
	const narrators = new Set(demoBooks.flatMap(b => (b.e || []).flatMap(ed => ed.n || [])));
	assert.equal(ctx.document.title, 'Narrators · Audiobook Catalog');
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, narrators.size);
	assert.match(
		els.subtitle.textContent,
		new RegExp(`^${narrators.size} narrators across ${demoBooks.length} audiobooks`),
	);
	assert.match(
		readable(els.creditBody.innerHTML),
		/<a class="srow-title" href="narrator\.html#n=Ingrid\+Voss">Ingrid Voss<\/a>\s*<span class="srow-owned">5 books, 1 series<\/span><\/div><p class="srow-note">Ingrid Voss narrates fantasy/,
		'the first line of a bio, when there is one',
	);
	// else the authors they read most, the most first
	assert.match(
		readable(els.creditBody.innerHTML),
		/Dana Whitlock<\/a>\s*<span class="srow-owned">2 books, 1 series<\/span><\/div><p class="srow-note">Books by Priya Ostrander<\/p>/,
	);
	els.q.value = 'tobias';
	els.q.listeners.input[0]();
	await idle();
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, 1);
	els.q.value = 'zzzz';
	els.q.listeners.input[0]();
	await idle();
	assert.match(readable(els.creditBody.innerHTML), /No narrators match/);
});

test("a narrator's page shows the series and titles they read, with their authors and the other narrators", async () => {
	const books = JSON.stringify([
		{t: 'Tide One', a: ['Ann Vale'], s: 'Tide Saga', sn: '1', e: [{n: ['Cy Hale', 'Di Moss']}]},
		{t: 'Tide Two', a: ['Ann Vale'], s: 'Tide Saga', sn: '2', e: [{n: ['Cy Hale']}, {n: ['Ed Lund']}]},
		{t: 'Apple Hill', a: ['Bo Reed', 'Ann Vale'], e: [{n: ['Cy Hale'], p: 'Gull Audio'}]},
	]);
	const {ctx, els, fire, readable} = await boot({
		page: 'narrator.html',
		hash: '#n=Cy+Hale',
		files: {'books.json': books},
	});
	const html = readable(els.creditBody.innerHTML);
	assert.equal(ctx.document.title, 'Cy Hale · Audiobook Catalog');
	assert.match(els.crumb.innerHTML, /<a href="narrators\.html">← All narrators<\/a>/);
	assert.equal(els.subtitle.textContent, '3 audiobooks in 1 series and 1 outside a series');
	assert.match(html, /<h2 class="author-name">Cy Hale<\/h2>/);
	assert.match(html, /<a href="index\.html#series=Tide\+Saga">Tide Saga<\/a> <span class="n">2 books<\/span>/);
	// who else reads the editions Cy Hale reads, not the other editions
	assert.match(
		html,
		/Tide One<\/a> <span class="with">by <a href="author\.html#a=Ann\+Vale">Ann Vale<\/a><\/span> <span class="with">with <a href="#n=Di\+Moss">Di Moss<\/a><\/span><\/li>/,
	);
	assert.match(html, /Tide Two<\/a> <span class="with">by <a [^>]*>Ann Vale<\/a><\/span><\/li>/);
	assert.match(
		html,
		/Outside a series <span class="n">1 book<\/span>.*Apple Hill<\/a> <span class="with">by <a [^>]*>Bo Reed<\/a>, <a [^>]*>Ann Vale<\/a>/,
	);
	ctx.location.hash = '#n=Nobody+Here';
	fire('hashchange');
	await idle();
	assert.equal(els.subtitle.textContent, 'No books narrated by them in the catalog.');
	// an address naming no one goes to the list
	ctx.location.hash = '';
	fire('hashchange');
	await idle();
	assert.equal(ctx.location.replaced, 'narrators.html');
});

test("the publishers page lists the editions' publishers, and a publisher's page their books", async () => {
	const {ctx, els, readable, storage} = await boot({page: 'publishers.html'});
	assert.equal(ctx.document.title, 'Publishers · Audiobook Catalog');
	assert.match(els.subtitle.textContent, new RegExp(`^3 publishers across ${demoBooks.length} audiobooks`));
	assert.match(
		readable(els.creditBody.innerHTML),
		/<a class="srow-title" href="publisher\.html#p=Kestrel\+Row\+Audio">Kestrel Row Audio<\/a>\s*<span class="srow-owned">3 books, 1 series<\/span>/,
	);
	const pub = await boot({page: 'publisher.html', hash: '#p=Kestrel+Row+Audio', storage, files: null});
	await idle();
	assert.equal(pub.ctx.document.title, 'Kestrel Row Audio · Audiobook Catalog');
	assert.equal(pub.els.subtitle.textContent, '3 audiobooks in 1 series');
	assert.match(pub.readable(pub.els.creditBody.innerHTML), /The Orchard Cycle<\/a> <span class="n">3 books<\/span>/);
	assert.doesNotMatch(
		pub.readable(pub.els.creditBody.innerHTML),
		/class="with">with/,
		"a publisher's page names no other publishers",
	);
});

test('the narrators on a book card, and the publishers in its details, link to their pages', async () => {
	const {els, readable, storage} = await boot({page: 'books.html'});
	assert.match(readable(els.results.innerHTML), /narr\. <a href="narrator\.html#n=Ingrid\+Voss">Ingrid Voss<\/a>/);
	const book = await bootBook('The Copper Graft', {storage});
	assert.match(
		book.readable(book.els.results.innerHTML),
		/<dt>Publisher<\/dt><dd><a href="publisher\.html#p=Kestrel\+Row\+Audio">Kestrel Row Audio<\/a><\/dd>/,
	);
});

test("author info can be added, edited and removed on the author's page, and links are checked", async () => {
	const {els, get, storage} = await boot({page: 'author.html', hash: '#a=Wendell+Ashcombe'});
	const editClick = () => els.creditBody.querySelector('.aedit').listeners.click[0]();
	const submit = () => els.creditForm.listeners.submit[0]({preventDefault() {}});
	// Edit comes after their books, not by their name
	assert.match(
		els.creditBody.innerHTML,
		/^<div class="author-head"><h2 class="author-name">Wendell Ashcombe<\/h2><\/div>/,
	);
	assert.match(
		els.creditBody.innerHTML,
		/<\/ul><\/div><div class="page-actions"><button type="button" class="aedit">Edit<\/button>(<button type="button" class="catalogCompare" data-compare="[a-z]+">Compare their books with [\w ]+<\/button>)+<\/div>$/,
	);
	editClick();
	assert.ok(els.creditForm.classList.contains('open'));
	assert.equal(els.creditFormTitle.textContent, 'Edit author: Wendell Ashcombe');
	assert.equal(els.creditRemoveBtn.textContent, 'Remove author');
	els.cf_bio.value = '  Builds   clockwork worlds.\n\nLives by a canal. ';
	els.cf_url.value = 'wendell.example';
	submit();
	assert.match(els.creditFormError.textContent, /'url' must be a web address/);
	els.cf_url.value = 'https://wendell.example/';
	els.cf_ext_goodreads.value = 'https://hardcover.app/authors/wendell'; // pasted into the wrong field
	submit();
	assert.equal(
		els.creditFormError.textContent,
		'Not an id or address there: Goodreads: https://hardcover.app/authors/wendell.',
	);
	assert.equal(get("CATALOG.infoByName('authors').get('Wendell Ashcombe') || null"), null);
	els.cf_ext_goodreads.value = '';
	// an address gives the id; an Audible address names its site
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/wendell';
	els.cf_ext_audible.value = 'https://www.audible.co.uk/author/Wendell-Ashcombe/B0WENDELL1?ref=x';
	await submit();
	assert.ok(!els.creditForm.classList.contains('open'));
	const entry = {
		bio: 'Builds clockwork worlds.\n\nLives by a canal.',
		url: 'https://wendell.example/',
		ext: {'audible.co.uk': 'B0WENDELL1', hardcover: 'wendell'},
	};
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe')"), entry);
	assert.match(els.creditBody.innerHTML, /<p>Builds clockwork worlds\.<\/p><p>Lives by a canal\.<\/p>/);
	assert.match(
		els.creditBody.innerHTML,
		/<a class="authorlink" href="https:\/\/www\.audible\.co\.uk\/author\/B0WENDELL1" target="_blank" rel="noopener">Audible \(audible\.co\.uk\) ↗<\/a> <a class="authorlink" href="https:\/\/hardcover\.app\/authors\/wendell" target="_blank" rel="noopener">Hardcover ↗<\/a>/,
	);
	assert.match(
		els.ioStatus.textContent,
		/^Saved Wendell Ashcombe\. Kept Hardcover's author by the name in its address/,
	);
	// kept in this browser, and loaded again with the page
	assert.deepEqual((await kept(storage)).authors['Wendell Ashcombe'], entry);
	const again = await boot({page: 'author.html', hash: '#a=Wendell+Ashcombe', storage});
	assert.deepEqual(again.get("CATALOG.infoByName('authors').get('Wendell Ashcombe')"), entry);

	// editing shows what is there; emptying every field keeps nothing about them, and they stay
	editClick();
	assert.equal(els.creditFormTitle.textContent, 'Edit author: Wendell Ashcombe');
	assert.equal(els.cf_ext_hardcover.value, 'wendell');
	assert.equal(
		els.cf_ext_audible.value,
		'https://www.audible.co.uk/author/B0WENDELL1',
		'the address, so the site is kept',
	);
	for (const field of [els.cf_bio, els.cf_url, els.cf_ext_hardcover, els.cf_ext_audible]) field.value = '';
	await submit();
	await idle();
	assert.equal(get("CATALOG.infoByName('authors').get('Wendell Ashcombe') || null"), null);
	assert.equal(els.ioStatus.textContent, 'Saved Wendell Ashcombe.');
	assert.ok((await kept(storage)).authors['Marisol Quenby'], 'the other authors keep theirs');
	assert.ok(
		databaseOf(storage)
			.records('contributors')
			.some(c => c.name === 'Wendell Ashcombe'),
	);

	// an author can't be removed while a book has no other
	editClick();
	els.creditRemoveBtn.listeners.click[0]();
	assert.match(
		els.creditFormError.textContent,
		/^Wendell Ashcombe is the only author of \d+ books? \(.*\): give (them|it) another author first, or remove (them|it)\.$/,
	);
	assert.ok(get("CATALOG.books.some(b => b.authors.includes('Wendell Ashcombe'))"));
});

test("a Hardcover address in the series or info form is looked up for its number, and kept as it is when Hardcover can't be asked", async () => {
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn, ms) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	}; // the pause between requests
	const storage = new Map([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const {els, get} = await boot({
		page: 'author.html',
		hash: '#a=Wendell+Ashcombe',
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	const edit = () => els.creditBody.querySelector('.aedit').listeners.click[0]();
	const submit = () => els.creditForm.listeners.submit[0]({preventDefault() {}});
	edit();
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/wendell-ashcombe/books';
	await submit();
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), {hardcover: '4101'});
	assert.equal(
		els.ioStatus.textContent,
		'Saved Wendell Ashcombe. Found on Hardcover: Wendell Ashcombe (author 4101).',
	);
	assert.match(
		els.creditBody.innerHTML,
		/<a class="authorlink" href="https:\/\/hardcover\.app\/id\/author\/4101" target="_blank" rel="noopener">Hardcover ↗<\/a>/,
	);
	assert.deepEqual(hc.sent.at(-1).variables, {slug: 'wendell-ashcombe'});

	// as soon as the field is left; one merged into another is that one
	edit();
	els.cf_ext_hardcover.value = 'w-ashcombe';
	await els.cf_ext_hardcover.listeners.change[0]();
	await idle();
	assert.equal(els.cf_ext_hardcover.value, '4101');
	// the address becomes the name in it when the field is left, and then the number Hardcover gives
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/wendell-ashcombe';
	const looking = els.cf_ext_hardcover.listeners.change[0]();
	els.cf_ext_hardcover.dispatch('focusout');
	assert.equal(els.cf_ext_hardcover.value, 'wendell-ashcombe');
	await looking;
	await idle();
	assert.equal(els.cf_ext_hardcover.value, '4101');
	// a number, or an address by number, is not looked up
	const asked = hc.sent.length;
	els.cf_ext_hardcover.value = 'https://hardcover.app/id/authors/4102';
	await submit();
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), {hardcover: '4102'});
	assert.equal(hc.sent.length, asked);

	// a name Hardcover has no page for is refused
	edit();
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/nobody-here';
	await submit();
	assert.equal(
		els.creditFormError.textContent,
		'Hardcover has no author at https://hardcover.app/authors/nobody-here.',
	);
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), {hardcover: '4102'});
	// when Hardcover can't be asked, the name in the address is kept, and still links to its page
	storage.set('audiobook-catalog-hardcover-token', 'expired');
	await submit();
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), {hardcover: 'nobody-here'});
	assert.match(
		els.ioStatus.textContent,
		/Kept Hardcover's author by the name in its address, as Hardcover couldn't be asked for its number \(Hardcover refused your token/,
	);
	assert.match(els.creditBody.innerHTML, /href="https:\/\/hardcover\.app\/authors\/nobody-here"/);

	// a series' and a publisher's likewise
	storage.set('audiobook-catalog-hardcover-token', 'tok-123');
	const index = await boot({hardcover: hc.fetch, setTimeout, storage});
	index.ctx.openSeriesForm(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	index.els.sf_ext_hardcover.value = 'hardcover.app/series/the-lantern-coast';
	await index.els.seriesForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.equal(index.get("CATALOG.infoByName('series').get('The Lantern Coast').external.hardcover"), '3101');
	const pub = await boot({
		page: 'publisher.html',
		hash: '#p=Kestrel+Row+Audio',
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	pub.els.creditBody.querySelector('.aedit').listeners.click[0]();
	await idle();
	assert.equal(
		pub.els.cf_ext_hardcover.value,
		'kestrel-row-audio-sample',
		'a name kept before stays until the form is saved',
	);
	pub.els.cf_ext_hardcover.value = 'kestrel-row-audio';
	await pub.els.creditForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.equal(pub.get("CATALOG.infoByName('publishers').get('Kestrel Row Audio').external.hardcover"), '5101');
});

test('an author can be renamed from their form, on every book, keeping their id; a narrator renamed to another joins them', async () => {
	const {ctx, els, get, storage} = await boot({page: 'author.html', hash: '#a=Wendell+Ashcombe'});
	const submit = () => els.creditForm.listeners.submit[0]({preventDefault() {}});
	const count = demoBooks.filter(b => b.a.includes('Wendell Ashcombe')).length;
	await kept(storage);
	const authorId = databaseOf(storage)
		.records('contributors')
		.find(c => c.name === 'Wendell Ashcombe').id;
	els.creditBody.querySelector('.aedit').listeners.click[0]();
	assert.equal(els.cf_name.value, 'Wendell Ashcombe');
	// an author's name can't be read as several
	els.cf_name.value = 'Ashcombe, Wendell';
	await submit();
	assert.match(els.creditFormError.textContent, /would be read as several authors/);
	els.cf_name.value = '   ';
	await submit();
	assert.equal(els.creditFormError.textContent, 'Give the author a name.');
	els.cf_name.value = '  Wendell  P. Ashcombe ';
	await submit();
	await idle();
	assert.ok(!els.creditForm.classList.contains('open'));
	assert.equal(els.ioStatus.textContent, `Renamed Wendell Ashcombe to Wendell P. Ashcombe on ${count} books.`);
	assert.equal(ctx.location.hash, `#a=${authorId}`, 'the address names them by id, not by the old name');
	assert.match(els.creditBody.innerHTML, /<h2 class="author-name">Wendell P\. Ashcombe<\/h2>/);
	const saved = await kept(storage);
	assert.equal(saved.books.filter(b => b.a.includes('Wendell P. Ashcombe')).length, count);
	assert.ok(!saved.books.some(b => b.a.includes('Wendell Ashcombe')));
	assert.deepEqual(
		databaseOf(storage)
			.records('contributors')
			.filter(c => c.name === 'Wendell P. Ashcombe')
			.map(c => c.id),
		[authorId],
	);

	// renaming a narrator to one the catalog has takes a second Save, and joins them
	const both = demoBooks.filter(b =>
		(b.e || []).some(ed => (ed.n || []).some(n => n === 'Dana Whitlock' || n === 'Ingrid Voss')),
	).length;
	const narrator = await boot({page: 'narrator.html', hash: '#n=Dana+Whitlock', storage});
	const ingrid = databaseOf(storage)
		.records('contributors')
		.find(c => c.name === 'Ingrid Voss').id;
	narrator.els.creditBody.querySelector('.aedit').listeners.click[0]();
	narrator.els.cf_name.value = 'Ingrid Voss';
	narrator.els.cf_bio.value = 'Reads everything.';
	await narrator.els.creditForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.ok(narrator.els.creditForm.classList.contains('open'));
	assert.match(
		narrator.els.creditFormError.textContent,
		/^There is already a narrator called Ingrid Voss\. Press Save again to join them/,
	);
	assert.ok(narrator.get("CATALOG.books.some(b => b.editions.some(ed => ed.narrators.includes('Dana Whitlock')))"));
	await narrator.els.creditForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.ok(!narrator.els.creditForm.classList.contains('open'));
	assert.equal(narrator.ctx.location.hash, `#n=${ingrid}`);
	// what the form has wins; what Ingrid Voss had fills in the rest
	assert.deepEqual(narrator.get("CATALOG.infoByName('narrators').get('Ingrid Voss')"), {
		bio: 'Reads everything.',
		url: 'https://example.com/',
		ext: {hardcover: 'ingrid-voss-sample'},
	});
	assert.match(narrator.els.subtitle.textContent, new RegExp(`^${both} audiobooks`));
	const joined = await kept(storage);
	assert.ok(!joined.books.some(b => (b.e || []).some(ed => (ed.n || []).includes('Dana Whitlock'))));
	assert.deepEqual(
		databaseOf(storage)
			.records('contributors')
			.filter(c => c.name === 'Ingrid Voss')
			.map(c => c.id),
		[ingrid],
	);
	assert.ok(
		!databaseOf(storage)
			.records('contributors')
			.some(c => c.name === 'Dana Whitlock'),
	);
	assert.equal(get('SHOWN'), authorId);
});

test('a narrator or publisher can be edited on their page, with links checked, and removed from their books', async () => {
	const {els, get, storage} = await boot({page: 'narrator.html', hash: '#n=Tobias+Frane'});
	const submit = () => els.creditForm.listeners.submit[0]({preventDefault() {}});
	assert.match(els.creditBody.innerHTML, /No bio or links yet/);
	els.creditBody.querySelector('.aedit').listeners.click[0]();
	await idle();
	assert.equal(els.creditFormTitle.textContent, 'Edit narrator: Tobias Frane');
	assert.equal(els.creditSaveBtn.textContent, 'Save narrator');
	els.cf_bio.value = 'Reads sea stories.';
	els.cf_ext_audible.value = 'https://www.goodreads.com/author/show/1.Tobias';
	submit();
	assert.match(els.creditFormError.textContent, /Not an id or address there: Audible: https:\/\/www\.goodreads\.com/);
	els.cf_ext_audible.value = 'https://www.audible.com/search?searchNarrator=Tobias+Frane';
	submit();
	assert.deepEqual(get("CATALOG.infoByName('narrators').get('Tobias Frane')"), {
		bio: 'Reads sea stories.',
		ext: {'audible.com': 'Tobias Frane'},
	});
	assert.deepEqual((await kept(storage)).narrators['Tobias Frane'], {
		bio: 'Reads sea stories.',
		ext: {'audible.com': 'Tobias Frane'},
	});
	assert.match(
		els.creditBody.innerHTML,
		/<div class="author-bio"><p>Reads sea stories\.<\/p><\/div><p class="author-links"><a class="authorlink" href="https:\/\/www\.audible\.com\/search\?searchNarrator=Tobias%20Frane" target="_blank" rel="noopener">Audible ↗<\/a><\/p>/,
	);
	assert.equal(els.ioStatus.textContent, 'Saved Tobias Frane.');

	// Remove narrator warns first, then takes them off the editions they read
	const read = demoBooks.filter(b => (b.e || []).some(ed => (ed.n || []).includes('Tobias Frane'))).length;
	assert.ok(read > 0);
	els.creditBody.querySelector('.aedit').listeners.click[0]();
	await idle();
	els.creditRemoveBtn.listeners.click[0]();
	assert.equal(
		els.creditFormError.textContent,
		`This takes Tobias Frane off ${read} book${read > 1 ? 's' : ''}' editions, which stay in the catalog, and removes them. Press Remove narrator again to do it.`,
	);
	els.creditRemoveBtn.listeners.click[0]();
	await idle();
	assert.equal(els.ioStatus.textContent, `Removed Tobias Frane from ${read} book${read > 1 ? 's' : ''}.`);
	assert.match(els.creditBody.innerHTML, /Tobias Frane was removed\. <a href="narrators\.html">All narrators<\/a>/);
	const saved = await kept(storage);
	assert.equal(saved.books.length, demoBooks.length);
	assert.ok(!saved.books.some(b => (b.e || []).some(ed => (ed.n || []).includes('Tobias Frane'))));
	assert.equal('Tobias Frane' in saved.narrators, false);
	assert.ok(
		!databaseOf(storage)
			.records('contributors')
			.some(c => c.name === 'Tobias Frane'),
	);

	// a publisher's page shows what the demo data keeps about it
	const pub = await boot({page: 'publisher.html', hash: '#p=Kestrel+Row+Audio'});
	assert.match(pub.els.creditBody.innerHTML, /Kestrel Row Audio is a small audiobook studio/);
	assert.match(
		pub.els.creditBody.innerHTML,
		/<a class="authorlink" href="https:\/\/hardcover\.app\/publishers\/[^"]*" target="_blank" rel="noopener">Hardcover ↗<\/a>/,
	);
	assert.equal(pub.els.cf_ext_hardcover.getAttribute('placeholder'), 'id, or its address on hardcover.app');
	assert.ok(!pub.els.cf_ext.innerHTML.includes('cf_ext_goodreads'), 'Goodreads has no publisher pages');
});

test('Check on the import page lists problems; a catalog in an older format is kept in the current one at once', async () => {
	const mine = JSON.stringify([{t: 'Old Favorite', a: 'Ann Vale', id: 'B0OLD00001'}]);
	const info = JSON.stringify({Nowhere: {total: 3, status: 'ongoing'}});
	const {els, storage} = await boot({page: 'import.html', files: {'books.json': mine, 'series-info.json': info}});
	// moving it to IndexedDB wrote it the current way
	assert.deepEqual((await kept(storage)).books, [
		{t: 'Old Favorite', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B0OLD00001'}}]},
	]);
	els.checkBtn.listeners.click[0]();
	await idle();
	const report = els.importPreviewBody.innerHTML;
	assert.equal(els.importPreview.place, 'after checkPanel');
	assert.match(
		report,
		/1 books; 1 series, 1 with a released total; 1 author, 0 narrators, 0 publishers, 0 with a bio or links\./,
	);
	assert.match(report, /No problems found/);
	assert.equal(els.importConfirm.style.display, 'none');
	assert.equal(els.importCancel.textContent, 'Close');
});

test('Box sets on the import page adds a set beside the titles sharing its edition, once confirmed', async () => {
	const set = {ext: {'audible.com': 'B0SET00001'}};
	const mine = JSON.stringify([
		{t: 'Gull Isle', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [set]},
		{t: 'Second Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [set]},
	]);
	const {els, get} = await boot({page: 'import.html', files: {'books.json': mine}});
	els.boxSetsBtn.listeners.click[0]();
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /Gull Isle, Books 1-2 — Ann Vale: 2 titles already here/);
	assert.match(els.importPreviewBody.innerHTML, /New: 1/);
	assert.equal(get('CATALOG.books.length'), 2, 'nothing changes before it is confirmed');
	assert.equal(els.importConfirm.textContent, 'Add 1 book');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books[2]'), {
		t: 'Gull Isle, Books 1-2',
		a: ['Ann Vale'],
		s: 'Gull Isle',
		sn: '1-2',
		e: [set],
	});
	assert.match(els.ioStatus.textContent, /Added 1 book for box sets/);
	els.boxSetsBtn.listeners.click[0]();
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /already kept both as its own book and as its titles/);
	assert.equal(els.importConfirm.style.display, 'none');
});

test('a browser that prefers British English sees "catalogue"; any other sees "catalog", and the data is never respelled', async () => {
	const titled = JSON.stringify([{t: 'The Catalog of Stars', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}]}]);
	for (const page of ALL_PAGES) {
		const {ctx} = await boot({
			page,
			hash: PAGE_HASH[page] || '',
			languages: ['sv-SE', 'en-GB'],
			files: {'books.json': titled},
		});
		await idle();
		assert.match(ctx.document.title, /Audiobook Catalogue$/, page);
		// (the body holds what the page drew too; the Hardcover scope read:catalog is a name, and stays, and so does the book's title)
		assert.ok(
			!/(?<!:)\b[Cc]atalog\b/.test(ctx.document.body.innerHTML.replace(/The Catalog of Stars/g, '')),
			`${page} has no American spelling left`,
		);
		assert.match(ctx.document.body.innerHTML, /<h1>Audiobook Catalogue<\/h1>/, page);
	}
	const uk = await boot({page: 'import.html', languages: ['en-AU'], files: {'books.json': titled}});
	await idle();
	assert.equal(uk.els.subtitle.textContent, '1 audiobooks in the catalogue');
	const app = await boot({page: 'books.html', languages: ['en-GB'], files: {'books.json': titled}});
	await idle();
	assert.match(app.els.results.innerHTML, /The Catalog of Stars/);
	assert.equal(app.ctx.document.title, 'Books · Audiobook Catalogue');
	const book = await boot({
		page: 'book.html',
		hash: '#book=The+Catalog+of+Stars',
		languages: ['en-GB'],
		storage: app.storage,
	});
	assert.equal(book.ctx.document.title, 'The Catalog of Stars — Audiobook Catalogue', 'a title is data');

	const us = await boot({page: 'import.html', languages: ['fr-FR', 'fr'], files: {'books.json': titled}});
	await idle();
	assert.equal(us.els.subtitle.textContent, '1 audiobooks in the catalog');
	assert.match(us.ctx.document.title, /Audiobook Catalog$/);
	assert.match(us.ctx.document.body.innerHTML, /<h1>Audiobook Catalog<\/h1>/);
});

// ------------------------------------------------------------------ a page holds only what it shows
const SAGAS = JSON.stringify([
	...['1', '2', '3'].map(n => ({t: `Gull ${n}`, a: ['Ann Vale'], s: 'Gull Isle', sn: n, e: [{n: ['Cy Hale']}]})),
	...['1', '2', '3', '4', '5'].map(n => ({t: `Fern ${n}`, a: ['Bo Reed'], s: 'Fern Saga', sn: n})),
]);
// A browser that has the catalog in IndexedDB already, and a page booted on it that has read nothing yet.
async function movedIn(files, options = {}) {
	const storage = new Map();
	await boot({storage, files});
	await kept(storage);
	databaseOf(storage).resetReads();
	return boot({storage, files: null, ...options});
}

test('the series overview reads no book, and a series page only the books of that series', async () => {
	const {ctx, get, database} = await movedIn({'books.json': SAGAS});
	await idle();
	assert.match(ctx.document.getElementById('results').innerHTML, /Gull Isle/);
	assert.equal(database.reads('books'), 0, 'the overview is drawn from the series records');
	assert.equal(get('CATALOG.books.length'), 0);
	ctx.openSeries(seriesIdOf(get, 'Gull Isle'));
	await idle();
	assert.equal(database.reads('books'), 3);
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Gull 1', 'Gull 2', 'Gull 3']);
});

test('links to authors, narrators and publishers carry the id they are stored under, from pages that hold no book', async () => {
	const books = JSON.stringify([
		...['1', '2'].map(n => ({
			t: `Gull ${n}`,
			a: ['Ann Vale', 'Di Moss'],
			s: 'Gull Isle',
			sn: n,
			e: [{n: ['Cy Hale'], p: 'Tern Press'}],
		})),
		{t: 'Fern 1', a: ['Bo Reed'], s: 'Fern Saga', sn: '1'},
	]);
	// read as they are, not with readable(): it names an id the page made up as well
	const linked = (html, key) =>
		[...html.matchAll(new RegExp(`#${key}=([^"&]+)">([^<]+)</a>`, 'g'))].map(([, id, name]) => [
			decodeURIComponent(id),
			name,
		]);
	const overview = await movedIn({'books.json': books});
	await idle();
	const stored = kind =>
		overview.database
			.records('contributors')
			.filter(c => c.kind === kind)
			.map(c => [c.id, c.name]);
	assert.deepEqual(
		linked(overview.els.results.innerHTML, 'a').sort(),
		stored('author').sort(),
		'the series overview',
	);
	for (const [page, key, kind] of [
		['authors.html', 'a', 'author'],
		['narrators.html', 'n', 'narrator'],
		['publishers.html', 'p', 'publisher'],
	]) {
		const {els} = await boot({page, storage: overview.storage, files: null});
		await idle();
		assert.deepEqual(linked(els.creditBody.innerHTML, key).sort(), stored(kind).sort(), page);
	}
});

test('all books shows 50 at a time, and Show more reads the next ones', async () => {
	const books = Array.from({length: 60}, (_, i) => ({
		t: `Pebble ${String(i + 1).padStart(2, '0')}`,
		a: ['Ann Vale'],
	}));
	const {els, get, database} = await movedIn({'books.json': JSON.stringify(books)}, {page: 'books.html'});
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
	const {ctx, els, get, storage, database} = await movedIn(
		{'books.json': SAGAS},
		{page: 'book.html', hash: '#book=Gull+3'},
	);
	assert.equal(database.reads('books'), 2, 'only the book shown (found by the title in the address, then read)');
	ctx.openEditForm(bookIdOf(get, 'Gull 3'));
	els.f_s.value = 'Fern Saga';
	els.f_sn.value = '6';
	els.addForm.listeners.submit[0]({preventDefault() {}, target: els.addForm});
	await idle();
	const books = (await kept(storage)).books;
	assert.equal(books.length, 8);
	assert.deepEqual(
		books.find(b => b.t === 'Fern 4'),
		{t: 'Fern 4', a: ['Bo Reed'], s: 'Fern Saga', sn: '4'},
		'a book the page never read',
	);
	assert.deepEqual(books.find(b => b.t === 'Gull 3').s, 'Fern Saga');
	const count = store => Object.fromEntries(database.records(store).map(x => [x.name, [x.bookCount, x.seriesCount]]));
	assert.deepEqual(count('series'), {'Fern Saga': [6, undefined], 'Gull Isle': [2, undefined]});
	assert.deepEqual(count('contributors'), {'Ann Vale': [3, 2], 'Bo Reed': [5, 1], 'Cy Hale': [3, 2]});
	assert.equal(database.records('credits').length, 8 + 3);

	// a series whose last books are removed stays, as an entry of its own
	for (const title of ['Gull 1', 'Gull 2']) await removeBook(title, {storage, files: null});
	assert.deepEqual(count('series'), {'Fern Saga': [6, undefined], 'Gull Isle': [0, undefined]});
	assert.deepEqual(count('contributors'), {'Ann Vale': [1, 1], 'Bo Reed': [5, 1], 'Cy Hale': [1, 1]});
	assert.equal((await kept(storage)).books.length, 6);
});

test('the Duplicates count is kept with the revision it was counted at, and counted again once the catalog changed', async () => {
	const books = JSON.stringify([
		{t: 'Ledger', a: ['Priya Ostrander']},
		{t: 'Ledger', a: ['Priya Ostrander'], r: ['2024']},
		{t: 'Other', a: ['Ann Vale']},
	]);
	const {els, run, storage, database} = await movedIn({'books.json': books});
	await idle();
	assert.equal(els.dupCount.textContent, ' (1)');
	assert.equal(database.reads('books'), 0, 'the count kept is shown without reading the books');
	const revision = () => database.records('meta').find(m => m.key === 'revision').value;
	assert.equal(database.records('meta').find(m => m.key === 'duplicates').revision, revision());

	// a page holding the whole catalog keeps the count with each save; one that holds some counts it after
	const dup = await boot({page: 'duplicates.html', storage});
	await dup.run("CATALOG.books.push(new Book({ title: 'Other', authors: ['Ann Vale'] })); persist();");
	assert.deepEqual(
		database.records('meta').find(m => m.key === 'duplicates'),
		{key: 'duplicates', value: 2, revision: revision()},
	);
	await run('updateNav()');
	await idle();
	assert.equal(els.dupCount.textContent, ' (2)');
	// a page that holds some books counts again after its save, reading every book, and keeps the count
	const home = await boot({page: 'books.html', storage});
	database.resetReads();
	await home.run(
		"CATALOG.books.push(new Book({ title: 'Ledger', authors: ['Ann Vale'] }), new Book({ title: 'Ledger', authors: ['Ann Vale'] })); persist();",
	);
	await idle();
	assert.equal(home.els.dupCount.textContent, ' (3)');
	assert.ok(database.reads('books') >= 6, 'every book was read to count them');
	assert.deepEqual(
		database.records('meta').find(m => m.key === 'duplicates'),
		{key: 'duplicates', value: 3, revision: revision()},
	);
	database.resetReads();
	const next = await boot({storage});
	await idle();
	assert.equal(next.els.dupCount.textContent, ' (3)');
	assert.equal(database.reads('books'), 0);
});

test("the authors list reads no book, and an author's page only their books", async () => {
	const {els, database, readable, storage} = await movedIn({'books.json': SAGAS}, {page: 'authors.html'});
	await idle();
	assert.match(
		readable(els.creditBody.innerHTML),
		/Ann Vale<\/a>\s*<span class="srow-owned">3 books, 1 series<\/span>/,
	);
	assert.equal(els.subtitle.textContent, '2 authors across 8 audiobooks');
	assert.equal(database.reads('books'), 0);
	const bo = await boot({page: 'author.html', hash: '#a=Bo+Reed', storage, files: null});
	await idle();
	assert.equal(bo.els.subtitle.textContent, '5 audiobooks in 1 series');
	assert.equal(database.reads('books'), 5);
});

test('the stats page counts what the catalog lacks, and lists which ones', async () => {
	const books = [
		{
			t: 'The Tidewright',
			a: ['Ann Vale'],
			s: 'Lantern Coast',
			sn: '1',
			g: ['Fantasy'],
			r: ['2024-03-01'],
			e: [{ext: {'audible.com': 'B0TIDEWRT1'}, n: ['Cy Hale'], p: 'Tern Press', d: '2020-05-01', len: 600}],
		},
		{t: 'Salt and Ember', a: ['Ann Vale'], s: 'Lantern Coast', sn: '2', e: [{isbn: '9780000000002'}]},
	];
	const files = {'books.json': JSON.stringify(books), 'authors.json': JSON.stringify({'Ann Vale': {bio: 'Writes.'}})};
	const {els, get} = await boot({page: 'stats.html', files});
	assert.equal(els.subtitle.textContent, '2 audiobooks, 2 editions');
	const html = els.statsBody.innerHTML;
	const second = get('CATALOG.books[1].id');
	// one of two books has no genres, and the line lists it, linked to its page
	const genres = els['stat-books-genres'].innerHTML;
	assert.match(genres, /No genres<\/span><span class="statCount">1 \(50%\)/);
	assert.ok(genres.includes(`href="book.html#book=${second}"`), genres);
	// a value every one has is a line of its own that opens to nothing
	assert.ok(
		html.includes(
			'<div class="statRow statDone"><span class="statLabel">No editions</span><span class="statCount">none</span></div>',
		),
		html,
	);
	assert.equal(els['stat-authors-bio'], undefined, 'the one author has a bio');
	// the table counts Audible ids, a book by its editions'
	const table = els.statCatalogs.innerHTML;
	assert.match(table, /<th>Audible<\/th><td title="50%">1<\/td><td title="50%">1<\/td>/);
	assert.doesNotMatch(table, /Goodreads/, 'a catalog nothing has an id in is left out');
});
