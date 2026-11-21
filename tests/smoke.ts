// What the browser smoke tests (app.smoke.*.test.ts) share: boot() runs a page's real HTML and modules
// (index.html + series.js and the modules it imports, ...) in Node against a tiny fake DOM, a fake localStorage
// holding the demo data and a fake IndexedDB, so they need no dependencies and no browser. The modules run as ES
// modules in node:vm, which needs --experimental-vm-modules. The tests are in several files so that node --test
// runs them side by side.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Exclusions} from '#app/modules/exclusions.js';
import {Duplicates} from '#app/modules/duplicates.js';
import {CatalogRecords} from '#app/modules/catalog-records.js';
import type {RecordSet} from '#app/modules/catalog-records.js';
import {FakeIndexedDB, FakeKeyRange} from './fake-indexeddb.ts';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The app is the public/ folder, what a static server serves; the demo data stays outside it.
export const site = path.join(root, 'public');
// Read once: every boot loads the same pages and modules, and nothing changes them during a run.
export const FILES = new Map<string, string>();
export const read = (file: string): string => {
	if (!FILES.has(file)) FILES.set(file, fs.readFileSync(path.join(site, file), 'utf8'));
	return FILES.get(file) as string;
};
// the pages in the nav bar, and the pages they link to: a book's (book.html), an author's, a narrator's and a publisher's
export const PAGES = [
	'index.html',
	'books.html',
	'import.html',
	'duplicates.html',
	'authors.html',
	'narrators.html',
	'publishers.html',
	'places.html',
	'stats.html',
];
export const ALL_PAGES = [
	...PAGES,
	'book.html',
	'edit.html',
	'author.html',
	'narrator.html',
	'publisher.html',
	'place.html',
];
// someone's page shows the one its address names; without one it goes to the list
export const PAGE_HASH: Record<string, string> = {
	'author.html': '#a=Ann+Vale',
	'narrator.html': '#n=Cy+Hale',
	'publisher.html': '#p=Tern+Press',
	'place.html': '#place=Earth',
};
export const readData = (file: string) => fs.readFileSync(path.join(root, 'sample', file), 'utf8');
export const DEMO_BOOKS = readData('books.json');
export const DEMO_INFO = readData('series-info.json');
export const DEMO_AUTHORS = readData('authors.json');
export const DEMO_NARRATORS = readData('narrators.json');
export const DEMO_PUBLISHERS = readData('publishers.json');
// The module a page loads with <script type="module">, and the modules it imports, in load order; with
// `lazy`, also those it loads with import() when they are first used.
export const entryOf = (page: string) =>
	[...read(page).matchAll(/<script type="module" src="([^"]+)">/g)].map(m => m[1]);
export function modulesOf(file: string, {lazy = false} = {}, seen = new Set<string>()): string[] {
	seen.add(file);
	const src = read(file);
	const deps = [...src.matchAll(/^import [^;]* from '(\.\.?\/[^']+)';$/gm)];
	if (lazy) deps.push(...src.matchAll(/\bimport\('(\.\.?\/[^']+)'\)/g));
	for (const [, dep] of deps) {
		const found = path.posix.join(path.posix.dirname(file), dep);
		if (!seen.has(found)) modulesOf(found, {lazy}, seen);
	}
	return [...seen];
}
// V8's code cache of each module, by file: every boot compiles the modules anew in its own context, and with
// the cache that is much quicker than parsing them again. (It holds no state, only the compiled code.)
export const CODE_CACHE = new Map<string, Buffer>();
// Node's SourceTextModule has createCachedData(), which @types/node leaves out.
type CachingModule = vm.SourceTextModule & {createCachedData(): Buffer};
/** Run the page's module and the modules it imports in `context`; returns their namespaces by file. */
export async function runModules(entry: string, context: vm.Context): Promise<Map<string, any>> {
	if (!vm.SourceTextModule)
		throw new Error('the smoke test needs node --experimental-vm-modules (make test passes it)');
	const modules = new Map<string, vm.SourceTextModule>();
	// a specifier is relative to the module that imports it (modules/book.js imports './edition.js')
	const linker = (specifier: string, from: {identifier: string}): vm.SourceTextModule =>
		load(path.posix.join(path.posix.dirname(from.identifier), specifier));
	// what a module loads with import() when it needs it, as a browser does; one at a time, as two linking
	// at once may share modules that are still being linked
	let importing: Promise<unknown> = Promise.resolve();
	const importModuleDynamically = (specifier: string, from: {identifier: string}) => {
		const module = linker(specifier, from);
		const ready = importing.then(async () => {
			if (module.status === 'unlinked') await module.link(linker);
			if (module.status === 'linked') await module.evaluate();
			return module;
		});
		importing = ready.catch(() => {});
		return ready;
	};
	const load = (file: string): vm.SourceTextModule => {
		if (!modules.has(file)) {
			const module = new vm.SourceTextModule(read(file), {
				context,
				identifier: file,
				importModuleDynamically,
				cachedData: CODE_CACHE.get(file),
			});
			// made before the module runs, which V8 requires
			if (!CODE_CACHE.has(file)) CODE_CACHE.set(file, (module as CachingModule).createCachedData());
			modules.set(file, module);
		}
		return modules.get(file) as vm.SourceTextModule;
	};
	const main = load(entry);
	await main.link(linker);
	await main.evaluate();
	return new Map([...modules].map(([file, m]) => [file, m.namespace]));
}
// A small DOM: elements with attributes and children, built by the page with createElement/append and
// read back by the tests as innerHTML, written the way a browser writes it. Setting innerHTML throws: the
// page builds its elements, it never parses HTML.
export const VOID = new Set([
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
export const ENTITIES: Record<string, string> = {
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
export const decode = (text: string) =>
	text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m: string, e: string) => {
		if (e[0] === '#')
			return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
		if (!(e in ENTITIES)) throw new Error(`the fake DOM doesn't know ${m}`);
		return ENTITIES[e];
	});
export const escText = (text: string) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/\u00A0/g, '&nbsp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
export const escAttr = (text: string) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/\u00A0/g, '&nbsp;')
		.replace(/"/g, '&quot;');
export const dataName = (key: string) => 'data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
/** A function the page listens with. */
export type Listener = (event?: any) => any;
/** An element or a text, as an element's childNodes hold them. */
export type FakeNode = FakeElement | FakeText;
export class FakeText {
	nodeType = 3 as const;
	nodeValue: string;
	parentNode: FakeElement | null = null;
	constructor(text: unknown) {
		this.nodeValue = String(text);
	}
	get textContent() {
		return this.nodeValue;
	}
	set textContent(text: unknown) {
		this.nodeValue = String(text);
	}
	get outerHTML() {
		return escText(this.nodeValue);
	}
}
/** Does `el` match a simple selector: tag, .class, #id, [attr], [attr="value"] and [attr^="start"], combined (no descendants)? */
export function matches(el: FakeElement, selector: string): boolean {
	return selectorTests(selector).every(test => test(el));
}
// a selector's parts as tests of an element, worked out once per selector: the pages match the same few again and again
type ElementTest = (el: FakeElement) => boolean;
export const SELECTORS = new Map<string, ElementTest[]>();
export function selectorTests(selector: string): ElementTest[] {
	const known = SELECTORS.get(selector);
	if (known) return known;
	const parts = selector.match(/^[a-z0-9]+|\.[\w-]+|#[\w-]+|\[[\w-]+(?:\^?="[^"]*")?\]/gi) || [];
	if (parts.join('') !== selector) throw new Error(`the fake DOM can't match ${selector}`);
	const tests = parts.map((part): ElementTest => {
		if (part[0] === '.') return el => el.classList.contains(part.slice(1));
		if (part[0] === '#') return el => el.getAttribute('id') === part.slice(1);
		if (part[0] === '[') {
			const [, name, op, value] = /^\[([\w-]+)(?:(\^?)="([^"]*)")?\]$/.exec(part) as RegExpExecArray;
			if (value === undefined) return el => el.hasAttribute(name);
			if (op) return el => el.getAttribute(name)?.startsWith(value) ?? false;
			return el => el.getAttribute(name) === value;
		}
		const tag = part.toLowerCase();
		return el => el.localName === tag;
	});
	SELECTORS.set(selector, tests);
	return tests;
}
/** The first element below `root` with the id, in document order, as getElementById finds it. */
export function findById(root: FakeElement, id: string): FakeElement | null {
	for (const child of root.childNodes) {
		if (child.nodeType !== 1) continue;
		if (child.attributes.get('id') === id) return child;
		const found = findById(child, id);
		if (found) return found;
	}
	return null;
}
export class FakeElement {
	// what the page sets on an element besides these (checked, disabled, files, open, ...), as a browser's has them
	[property: string]: any;
	nodeType = 1 as const;
	localName: string;
	tagName: string;
	attributes = new Map<string, string>();
	childNodes: FakeNode[] = [];
	parentNode: FakeElement | null = null;
	listeners: Record<string, Listener[]> = {};
	style: Record<string, string> = {};
	value = '';
	dataset: Record<string, string | undefined>;
	classList: {
		contains(c: string): boolean;
		add(c: string): void;
		remove(c: string): void;
		toggle(c: string, force?: unknown): boolean;
	};
	/** The page scrolled it into view. */
	scrolledTo?: boolean;
	/** Where it was last moved to, as 'before <id>' or 'after <id>'. */
	place?: string;
	constructor(tag: string, id?: string) {
		this.localName = tag.toLowerCase();
		this.tagName = tag.toUpperCase();
		if (id) this.setAttribute('id', id);
		this.dataset = new Proxy(
			{},
			{
				get: (t, key) =>
					typeof key === 'string' && this.hasAttribute(dataName(key))
						? this.getAttribute(dataName(key))
						: undefined,
				set: (t, key, value) => {
					this.setAttribute(dataName(String(key)), value);
					return true;
				},
				has: (t, key) => this.hasAttribute(dataName(String(key))),
			},
		);
		const classes = () => (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
		const setClasses = (list: string[]) => this.setAttribute('class', list.join(' '));
		this.classList = {
			contains: c => classes().includes(c),
			add: c => {
				if (!classes().includes(c)) setClasses([...classes(), c]);
			},
			remove: c => setClasses(classes().filter(x => x !== c)),
			toggle(c, force) {
				const on = force === undefined ? !this.contains(c) : !!force;
				if (on) this.add(c);
				else this.remove(c);
				return on;
			},
		};
	}
	get id() {
		return this.getAttribute('id') || '';
	}
	set id(v: string) {
		this.setAttribute('id', v);
	}
	get className() {
		return this.getAttribute('class') || '';
	}
	set className(v: string) {
		this.setAttribute('class', v);
	}
	get title() {
		return this.getAttribute('title') || '';
	}
	set title(v: string) {
		this.setAttribute('title', v);
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	setAttribute(name: string, value: unknown) {
		this.attributes.set(name, String(value));
	}
	hasAttribute(name: string) {
		return this.attributes.has(name);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	append(...nodes: (FakeNode | string)[]) {
		for (const node of nodes) {
			const child = typeof node === 'string' ? new FakeText(node) : node;
			if (child.parentNode) child.parentNode.childNodes.splice(child.parentNode.childNodes.indexOf(child), 1);
			child.parentNode = this;
			this.childNodes.push(child);
		}
	}
	appendChild(node: FakeNode) {
		this.append(node);
		return node;
	}
	removeChild(node: FakeNode) {
		this.childNodes.splice(this.childNodes.indexOf(node), 1);
		node.parentNode = null;
		return node;
	}
	replaceChildren(...nodes: (FakeNode | string)[]) {
		this.childNodes.forEach(c => {
			c.parentNode = null;
		});
		this.childNodes = [];
		this.append(...nodes);
	}
	hasChildNodes() {
		return this.childNodes.length > 0;
	}
	get children(): FakeElement[] {
		return this.childNodes.filter((c): c is FakeElement => c.nodeType === 1);
	}
	get textContent(): string {
		return this.childNodes.map(c => c.textContent).join('');
	}
	set textContent(text: unknown) {
		this.replaceChildren(...(String(text) ? [String(text)] : []));
	}
	get innerHTML(): string {
		return this.childNodes.map(c => c.outerHTML).join('');
	}
	set innerHTML(_html: string) {
		throw new Error(`the page set innerHTML of #${this.id}`);
	}
	get outerHTML(): string {
		const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
		return (
			`<${this.localName}${attrs}>` + (VOID.has(this.localName) ? '' : `${this.innerHTML}</${this.localName}>`)
		);
	}
	/** Elements below this one matching `selector` (simple selectors, or several separated by spaces for descendants). */
	querySelectorAll(selector: string): FakeElement[] {
		const [first, ...rest] = selector.trim().split(/\s+/);
		const found: FakeElement[] = [];
		const walk = (el: FakeElement) =>
			el.children.forEach(c => {
				if (matches(c, first)) found.push(c);
				walk(c);
			});
		walk(this);
		return rest.length ? [...new Set(found.flatMap(el => el.querySelectorAll(rest.join(' '))))] : found;
	}
	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll(selector)[0] || null;
	}
	/** It and the elements it is in, innermost first. */
	withAncestors(): FakeElement[] {
		const out: FakeElement[] = [this];
		for (let el = this.parentNode; el; el = el.parentNode) out.push(el);
		return out;
	}
	closest(selector: string): FakeElement | null {
		return this.withAncestors().find(el => matches(el, selector)) ?? null;
	}
	addEventListener(type: string, fn: Listener) {
		(this.listeners[type] ||= []).push(fn);
	}
	/** Run the listeners for `type` as a browser would for an event on this element. */
	dispatch(type: string, event: object = {}) {
		for (const el of this.withAncestors()) {
			(el.listeners[type] || []).forEach(fn =>
				fn({preventDefault() {}, ...event, target: this, currentTarget: el}),
			);
		}
	}
	reset() {}
	// an element the page scrolled into view says so
	scrollIntoView() {
		this.scrolledTo = true;
	}
	click() {}
	focus() {}
	// where an element was last moved to, as 'before <id>' or 'after <id>'
	before(node: FakeElement) {
		node.place = `before ${this.id}`;
	}
	after(node: FakeElement) {
		node.place = `after ${this.id}`;
	}
}
/** The page's <body>, parsed: tags, attributes, text and entities, as the pages write them. */
export function parseBody(html: string): FakeElement {
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
export const CATALOG_KEY = 'audiobook-catalog-device';
export const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
/** Data files by name, as they are written ({'books.json': text, 'excluded.txt': ...}). */
export type DataFiles = Record<string, string>;
export const DEMO: DataFiles = {
	'books.json': DEMO_BOOKS,
	'series-info.json': DEMO_INFO,
	'authors.json': DEMO_AUTHORS,
	'narrators.json': DEMO_NARRATORS,
	'publishers.json': DEMO_PUBLISHERS,
};
// The catalog in localStorage, made of data files ({'books.json': text, 'series-info.json': ..., 'excluded.txt': ...}) as written.
export function stored(files: DataFiles): string {
	const json = (name: string, empty: string) => JSON.parse(files[name] || empty);
	const catalog = {
		books: json('books.json', '[]'),
		seriesInfo: json('series-info.json', '{}'),
		authors: json('authors.json', '{}'),
		narrators: json('narrators.json', '{}'),
		publishers: json('publishers.json', '{}'),
		places: json('places.json', '{}'),
		excluded: Exclusions.parse(files['excluded.txt'] || '').entries,
	};
	return JSON.stringify(catalog);
}
// A backup (or anything else) without the ids books, editions, series and people are stored under.
export const withoutIds = (json: unknown): any =>
	JSON.parse(JSON.stringify(json), (k, v) => (k === 'uid' || k === 'ids' ? undefined : v));
// The browser's IndexedDB that goes with a localStorage (a Map), so pages booted with the same storage are
// tabs of one browser. Its ids are numbered, so tests can name them.
export const DATABASES = new WeakMap<Map<string, string>, FakeIndexedDB>();
export function databaseOf(storage: Map<string, string>): FakeIndexedDB {
	if (!DATABASES.has(storage)) {
		const database = new FakeIndexedDB();
		let n = 0;
		database.newId = () => `id-${++n}`;
		DATABASES.set(storage, database);
	}
	return DATABASES.get(storage) as FakeIndexedDB;
}
// Every page the current test booted, so idle() can wait for all of them. (Not the earlier tests' pages: each
// test waits for its own, and waiting on every page of the run made idle() slower with each test.)
export const BOOTED: Booted[] = [];
test.beforeEach(() => {
	BOOTED.length = 0;
});
// Once every page has drawn what it was asked to show, and saved what it was asked to save (a page reads
// what it shows from IndexedDB, after the saves before it, so a step that changes the view needs this).
export async function idle() {
	for (let i = 0; i < 3; i++) {
		await Promise.all(BOOTED.map(page => page.saved()));
		await new Promise(resolve => setImmediate(resolve));
	}
}
// Once the saves of every page of this browser are done.
export const settled = (storage: Map<string, string>) =>
	Promise.all((databaseOf(storage).pages || []).map(page => page.saved()));
// What the pages keep in IndexedDB, once their saves are done, as a backup has it (without the ids); null when nothing was saved.
export async function kept(storage: Map<string, string>): Promise<any> {
	await settled(storage);
	const database = databaseOf(storage);
	if (!database.records('meta').length) return null;
	// what the fake database holds: the records the pages put there
	const records = Object.fromEntries(
		CatalogRecords.STORE_NAMES.map(store => [store, database.records(store)]),
	) as unknown as RecordSet;
	return JSON.parse(
		JSON.stringify(CatalogRecords.toCatalog(records), (k, v) => (k === 'uid' || k === 'ids' ? undefined : v)),
	);
}
/** A fetch the page is given: a fake of a catalog, or of your server. */
export type Fetch = (url: string, init?: any) => Promise<any>;
/** What boot() is told: see there. */
export interface BootOptions {
	page?: string;
	files?: DataFiles | null;
	storage?: Map<string, string>;
	hash?: string;
	origin?: string;
	setTimeout?: (fn: () => unknown, ms: number) => unknown;
	hardcover?: Fetch | null;
	catalogs?: Fetch | null;
	proxy?: Fetch | null;
	languages?: string[];
	session?: Map<string, string>;
}
/** get(): a value of the page, read through JSON; with the page's database. */
export type Getter = ((expr: string) => any) & {database: FakeIndexedDB};
/** A booted page: see boot(). */
export interface Booted {
	/** What the page's modules export, live, and else its globals. */
	ctx: any;
	/** The page's elements by id. */
	els: Record<string, FakeElement>;
	storage: Map<string, string>;
	database: FakeIndexedDB;
	get: Getter;
	withIds: (expr: string) => any;
	run: (code: string) => any;
	fire: (type: string, event?: object) => void;
	follow: (hash: string) => void;
	saved: () => Promise<unknown>;
	readable: (html: string) => string;
}

/**
 * Load the page into a fresh fake browser. `storage` is a Map standing in for localStorage; unless it
 * holds a catalog already, the catalog is made of `files` (see stored(); default: the demo data), or
 * there is none when `files` is null.
 */
export async function boot({
	page = 'index.html',
	files = DEMO,
	storage = new Map(),
	hash = '',
	origin = 'https://reader.example',
	setTimeout = () => 0,
	hardcover = null,
	catalogs = null,
	proxy = null,
	languages = ['en-US', 'en'],
	session = new Map(),
}: BootOptions = {}): Promise<Booted> {
	await settled(storage); // a page loaded after another saved reads what it saved
	if (files && !storage.has(CATALOG_KEY)) storage.set(CATALOG_KEY, stored(files));
	if (files && files['not-duplicates.txt'] && !storage.has(NOT_DUP_KEY)) {
		storage.set(NOT_DUP_KEY, JSON.stringify(Duplicates.parseMarks(files['not-duplicates.txt'])));
	}
	const html = read(page);
	const body = parseBody(html);
	// the page's elements by id, the ones the page makes (form fields drawn from code) included
	const byId = (id: unknown) => findById(body, String(id));
	const els: Record<string, FakeElement> = new Proxy(
		{},
		{get: (_, id) => (typeof id === 'string' ? byId(id) || undefined : undefined)},
	);
	const document = {
		getElementById: byId,
		querySelectorAll: (selector: string) => body.querySelectorAll(selector),
		querySelector: (selector: string) => body.querySelector(selector),
		createElement: (tag: string) => new FakeElement(tag),
		body,
		title: decode((html.match(/<title>([^<]*)<\/title>/) as RegExpMatchArray)[1]),
	};
	const localStorage = {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: unknown) => storage.set(k, String(v)),
		removeItem: (k: string) => storage.delete(k),
	};
	// this tab's sessionStorage: a Map too, which a page opened from this one is booted with
	const sessionStorage = {
		getItem: (k: string) => session.get(k) ?? null,
		setItem: (k: string, v: unknown) => session.set(k, String(v)),
		removeItem: (k: string) => session.delete(k),
	};
	// The page asks nothing of the server it came from; only Hardcover, Open Library, Wikidata and the
	// catalog proxy (a workers.dev address), when a test gives a fake of them.
	const fetch = async (url: string, init: object = {}) => {
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
		onload: (event: {target: {result: string}}) => void = () => {};
		readAsText(file: {name: string; text: string}) {
			this.onload({target: {result: file.text}});
		}
	}
	// The session history: `entries` of {hash, state}, `at` the current one; back() and forward() fire popstate.
	// a page sent elsewhere (location.replace) says where in `replaced`, one it opens (location.assign) in `assigned`
	const location = {
		href: `${origin}/${page}${hash}`,
		origin,
		hostname: new URL(origin).hostname,
		hash,
		pathname: '/' + page,
		search: '',
		replaced: null as string | null,
		assigned: null as string | null,
		replace(url: string) {
			this.replaced = url;
		},
		assign(url: string) {
			this.assigned = url;
		},
	};
	const windowListeners: Record<string, Listener[]> = {};
	const fire = (type: string, event: object = {}) => (windowListeners[type] || []).forEach(fn => fn(event));
	const entries: {hash: string; state: unknown}[] = [{hash, state: null}];
	let at = 0;
	const hashOf = (url: unknown) => (String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : '');
	const history = {
		entries,
		get state() {
			return entries[at].state;
		},
		get at() {
			return at;
		},
		pushState(state: unknown, _title: string, url: string) {
			entries.splice(at + 1);
			entries.push({hash: hashOf(url), state});
			at++;
			location.hash = hashOf(url);
		},
		replaceState(state: unknown, _title: string, url: string) {
			entries[at] = {hash: hashOf(url), state};
			location.hash = hashOf(url);
		},
		go(n: number) {
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
	const addEventListener = (type: string, fn: Listener) => (windowListeners[type] ||= []).push(fn);
	const navigator = {languages};
	const Node = {ELEMENT_NODE: 1, TEXT_NODE: 3};
	const database = databaseOf(storage);
	// ids from the fake IndexedDB, and the browser's WebCrypto (syncing encrypts with it)
	const crypto = {
		randomUUID: () => database.newId(),
		subtle: globalThis.crypto.subtle,
		getRandomValues: (array: Uint8Array<ArrayBuffer>) => globalThis.crypto.getRandomValues(array),
	};
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
		TextEncoder,
		TextDecoder,
		CompressionStream,
		DecompressionStream,
		btoa,
		atob,
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
	const exported: Record<string, any> = {};
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
	const run = (code: string) => inScope.call(exported, code);
	// Values cross the VM boundary as JSON so deepEqual is not confused by a different Object.prototype. The ids
	// books and editions are stored under (`uid`) are left out, as most tests compare values; withIds() keeps them.
	const get = ((expr: string) =>
		JSON.parse(run(`JSON.stringify(${expr})`), (k, v) => (k === 'uid' ? undefined : v))) as Getter;
	const withIds = (expr: string) => JSON.parse(run(`JSON.stringify(${expr})`));
	// ctx.render(), ctx.CATALOG etc. are the exports; anything else (ctx.location, ctx.Blob = ...) the page's globals.
	const ctx = new Proxy(context, {
		get: (target, key) => (typeof key === 'string' && key in exported ? exported[key] : target[key as string]),
	});
	// what the page saves, saved: persist() writes in the background
	const saved = () => run('whenSaved()');
	// The page's links, with the ids in them read as names (#a=id-4 -> #a=Priya+Ostrander, #book=id-11 -> #book=The+Ledger+...),
	// so a test can say which book, series or person a link is to.
	const readable = (html: string) => {
		// by what this browser stores, and what the page holds (a book it added and has not saved yet)
		const records = (store: string) => database.records(store);
		const heldNames = (kind: string): [string, string][] =>
			JSON.parse(run(`JSON.stringify([...CATALOG.nameIds.${kind}].map(([name, id]) => [id, name]))`));
		const people = (kind: string): [string, string][] => [
			...records('contributors')
				.filter(c => c.kind === kind)
				.map((c): [string, string] => [c.id, c.name]),
			...heldNames(kind + 's'),
		];
		const held: [string, string][] = JSON.parse(run(`JSON.stringify(CATALOG.books.map(b => [b.id, b.title]))`));
		const named: Record<string, [string, string][]> = {
			book: [...records('books').map((b): [string, string] => [b.id, b.title]), ...held],
			series: [...records('series').map((x): [string, string] => [x.id, x.name]), ...heldNames('series')],
			a: people('author'),
			n: people('narrator'),
			p: people('publisher'),
			place: [...records('places').map((x): [string, string] => [x.id, x.name]), ...heldNames('places')],
		};
		const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
		return html.replace(/#(book|series|a|n|p|place)=([^"&]+)/g, (m, k, id) => {
			const name = new Map(named[k]).get(decodeURIComponent(id));
			return name === undefined ? m : `#${k}=${enc(name)}`;
		});
	};
	get.database = database;
	// a link on the page to another place on it (#...) followed: a new history entry, and the page shows it
	const follow = (hash: string) => {
		history.pushState(null, '', hash);
		fire('hashchange');
	};
	const booted: Booted = {ctx, els, storage, database, get, withIds, run, fire, follow, saved, readable};
	(database.pages ||= []).push(booted);
	BOOTED.push(booted);
	return booted;
}
// Pages know books, series and people by the ids they are stored under: the id of the book at `i` in the
// catalog's order, and of the series or person by their name, as the page's browser stores them. (A page
// holds only what it shows, so these are read from what is stored.)
export const bookIdOf = (get: Getter, title: string): string =>
	(get.database.records('books').find(b => b.title === title) || {}).id;
export const bookIdAt = (get: Getter, i: number): string =>
	[...get.database.records('books')].sort((x, y) => x.position - y.position)[i].id;
export const seriesIdOf = (get: Getter, name: string): string =>
	(get.database.records('series').find(x => x.name === name) || {}).id;
// A book's page, by its title (as an address from before has it, which the page turns into its id).
export const hashValue = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
export const bootBook = (title: string, options: BootOptions = {}) =>
	boot({...options, page: 'book.html', hash: '#book=' + hashValue(title)});
// A series' Edit series page, by its name (which the page turns into its id).
export const bootEdit = async (series: string, options: BootOptions = {}) => {
	const page = await boot({...options, page: 'edit.html', hash: '#series=' + hashValue(series)});
	await idle();
	return page;
};
// One book's Edit page (edit.html#book=<id>), by its title (which the page turns into its id), once it shows the
// catalogs it can ask (it asks them only when Ask the catalogs is pressed).
export const bootEditBook = async (title: string, options: BootOptions = {}) => {
	const page = await boot({...options, page: 'edit.html', hash: '#book=' + hashValue(title)});
	await idle();
	await page.ctx.ASKING;
	await idle();
	return page;
};
// Adding a book on the Edit page (edit.html#add), with what follows it in the address ('&series=<id>').
export const bootAdd = async (rest = '', options: BootOptions = {}) => {
	const page = await boot({...options, page: 'edit.html', hash: '#add' + rest});
	await idle();
	return page;
};
// A field of the Edit page typed in, and read as when it is left.
export const typeIn = (els: Record<string, FakeElement>, id: string, value: string) => {
	els[id].value = value;
	return els[id].listeners.change[0]();
};
// The editions of the book being edited, as their fields hold them (the first book's on the page).
export const draftEditions = (get: Getter) => get('DRAFTS[0].book.editions.map(ed => ed.fields())');
// + Add an edition on a book's card.
export const addEditionOn = (els: Record<string, FakeElement>, i = 0) =>
	els[`book-${i}`].querySelector('.editAddEdition')?.dispatch('click');
// A book's id in a catalog typed in (`group`, its field's), and the book's ids read as when it is left.
export const typeBookId = (els: Record<string, FakeElement>, group: string, value: string, i = 0) => {
	els[`b${i}_ext_${group}`].value = value;
	return els[`b${i}_ext`].listeners.change[0]();
};
// Review & save on the Edit series page, then Save when the review opens (it doesn't when something is refused).
export const saveEdit = async ({els}: {els: Record<string, FakeElement>}) => {
	await els.reviewBtn.listeners.click[0]();
	await idle();
	if (!els.reviewPanel.classList.contains('open')) return false;
	await els.reviewSaveBtn.listeners.click[0]();
	await idle();
	return true;
};
// the first of the demo books
export const SALT_ROAD: string = JSON.parse(DEMO_BOOKS)[0].t;
// The book cards in a list.
export const cards = (html: string) => (html.match(/class="book"/g) || []).length;
export const demoBooks: any[] = JSON.parse(DEMO_BOOKS);
// Remove the book titled `title` with Remove book on its Edit page, pressed twice; returns that page.
export async function removeBook(title: string, options?: BootOptions) {
	const page = await bootEditBook(title, options);
	const {els} = page;
	els.bookRemoveBtn.listeners.click[0]();
	assert.match(els.bookFormError.textContent, /Press Remove book again to do it\.$/);
	await els.bookRemoveBtn.listeners.click[0]();
	await idle();
	return page;
}
// Lets pending promises (a save on its way to the fake server) settle.
export const settle = () => new Promise(resolve => setImmediate(resolve));
