// What every page shares: the catalog, kept in this browser's IndexedDB and nowhere else, the
// status line and the page links. Each page's own module starts with startPage(), handing it a refresh()
// that redraws the page from CATALOG.
import {Text} from './modules/text.js';
import {Catalog} from './modules/catalog.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {Contributor} from './modules/contributor.js';
import {CatalogDatabase, CatalogConflict, MemoryReader} from './modules/catalog-database.js';
import type {CatalogReader} from './modules/catalog-database.js';
import type {RecordSet, Snapshot, StoreName} from './modules/catalog-records.js';
import type {Book} from './modules/book.js';
import type {NamedKind} from './modules/catalog.js';
import type {ContributorKind} from './modules/contributor.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import {CompareCatalogs} from './modules/compare-catalogs.js';
import type {ExternalKind, ExternalId} from './modules/external-catalog.js';
import type {Unchecked} from './modules/text.js';
import type {SyncPrefer} from './modules/catalog-sync.js';

/**
 * Comparing with Hardcover or AudiobookDB, or sending to it, going on (or just ended) in a page, as showCatalogJob() shows it.
 */
export interface CatalogJob {
	/** its name, as the page says it ("Hardcover") */
	catalog: string;
	mode: 'compare' | 'send';
	/** only reading: nothing is written */
	dryRun: boolean;
	running: boolean;
	/** milliseconds */
	elapsed: number;
	/** what it is doing */
	step?: string;
	/** of `total` steps */
	done?: number;
	total?: number;
	/** how it ended: 0 when all went through */
	code?: number;
	/** what it had to say */
	out?: string;
	/** what went wrong */
	err?: string;
}

// British spelling ("catalogue") when the browser's first English language is a British one, else American.
const BRITISH = (() => {
	try {
		return Text.prefersBritish(navigator.languages || [navigator.language]);
	} catch {
		return false;
	}
})();

/**
 * The page's own text in the spelling this browser prefers (see BRITISH); never a book's title or other data.
 */
export function spell(text: string): string {
	return Text.spelled(text, BRITISH);
}

// Attributes of the page's own elements that hold text a reader sees.
const TEXT_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

/**
 * Respell the text in `node` and below, in place (see spell).
 */
function respell(node: Node) {
	for (const child of node.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) child.nodeValue = spell(child.nodeValue || '');
		else if (child.nodeType === Node.ELEMENT_NODE) {
			const el = child as Element;
			for (const name of TEXT_ATTRIBUTES) {
				const value = el.getAttribute(name);
				if (value !== null) el.setAttribute(name, spell(value));
			}
			respell(el);
		}
	}
}

// The page as written is American, so respell it before the page's module finds its elements and
// fills them in; at this point it holds only the page's own text.
if (BRITISH) {
	document.title = spell(document.title);
	respell(document.body);
}

/**
 * Something to put in an element: an element, or text (always as text, never read as HTML). Null, undefined,
 * false and '' stand for nothing, so a part shown only sometimes can be `cond && buildElement(...)`; lists are flattened.
 */
export type Child = Node | string | number | null | undefined | false | Child[];

/**
 * The nodes and text of `children`, flattened, without the empty ones.
 */
export function nodes(children: Child[]): (Node | string)[] {
	const out: (Node | string)[] = [];
	for (const c of children) {
		if (Array.isArray(c)) out.push(...nodes(c));
		else if (c !== null && c !== undefined && c !== false && c !== '')
			out.push(typeof c === 'number' ? String(c) : c);
	}
	return out;
}

/**
 * A new element: buildElement('a', {class: 'srow-title', href}, name). Attributes are set as given: null, undefined
 * and false leave one out, true sets it empty (checked); a function under an on... name listens to that
 * event (onclick: fn). The children go in in order (see Child).
 */
export function buildElement<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number | boolean | null | undefined | ((e: Event) => void)> = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) {
		if (typeof value === 'function') el.addEventListener(name.slice(2), value);
		else if (value === true) el.setAttribute(name, '');
		else if (value !== null && value !== undefined && value !== false) el.setAttribute(name, String(value));
	}
	el.append(...nodes(children));
	return el;
}

/**
 * Replace what `el` holds with `children` (see Child).
 */
export function fillElement(el: Element, ...children: Child[]) {
	el.replaceChildren(...nodes(children));
}

/**
 * `items` with `separator` between each two, as children for buildElement() or fillElement(): links joined with ', '.
 */
export function joined(items: Child[], separator: string): Child[] {
	return items.flatMap((x, i) => (i ? [separator, x] : [x]));
}

/**
 * A value as an address after the # writes it: encoded, with spaces as +.
 */
export const hashValue: (v: string) => string = v => encodeURIComponent(v).replace(/%20/g, '+');
// The addresses of an author's, a narrator's and a publisher's page: by the id they are stored under, so a
// link holds while their name is spelled another way.
const CREDIT_PAGES: Record<ContributorKind, [string, string]> = {
	authors: ['author.html', '#a='],
	narrators: ['narrator.html', '#n='],
	publishers: ['publisher.html', '#p='],
};
/**
 * The address of the page of the author, narrator or publisher stored under `id`.
 */
export const creditPageHref = (kind: ContributorKind, id: string): string =>
	pageHref(CREDIT_PAGES[kind][0], CREDIT_PAGES[kind][1] + hashValue(id));
/**
 * The address of someone's page, by name: their id when the page holds it, else their name, which their page
 * looks up. Never a new id: a page holding only some of the catalog would make up one no record has.
 */
const namedPageHref: (kind: ContributorKind, name: string) => string = (kind, name) =>
	creditPageHref(kind, CATALOG.nameIds[kind].get(name) ?? name);
export const authorPageHref: (name: string) => string = name => namedPageHref('authors', name);
export const narratorPageHref: (name: string) => string = name => namedPageHref('narrators', name);
export const publisherPageHref: (name: string) => string = name => namedPageHref('publishers', name);
/**
 * The address of `file` showing `hash`: only the hash on that page itself, so the page shows it without loading again.
 */
function pageHref(file: string, hash: string): string {
	const here = typeof location === 'object' ? location.pathname || '' : '';
	return (here.endsWith('/' + file) || (file === 'index.html' && here.endsWith('/')) ? '' : file) + hash;
}
/**
 * The address of a book's page, by the id it is stored under.
 */
export const bookPageHref: (id: string) => string = id => pageHref('book.html', '#book=' + hashValue(id));
/**
 * The address of a series' page (its books), by the id it is stored under.
 */
export const seriesPageHref: (id: string) => string = id => pageHref('index.html', '#series=' + hashValue(id));
/** The address of the page of the books in no series. */
export const standalonePageHref = () => pageHref('index.html', '#standalone');
/**
 * The address that compares a series' or an author's books with a catalog's shelves on the Import & export page
 * (`import.html#hardcover-series=<id>`): what a Compare button opens where this tab keeps nothing, and older links.
 * @param catalog the catalog's key, as its client class says it (CatalogClient.CATALOG)
 * @param id the series' or the author's
 */
export const shelfCompareHref = (catalog: string, kind: 'series' | 'author', id: string): string =>
	`import.html#${catalog}-${kind}=` + hashValue(id);

/**
 * What a Compare button asks the Import & export page to compare: a series' or an author's books (by id) with
 * a catalog's (its client's CATALOG).
 */
export type CompareRequest = {catalog: string; kind: 'series' | 'author'; id: string};
/** Where a Compare button leaves its CompareRequest for the Import & export page: this tab only, read once. */
export const COMPARE_STORAGE_KEY = 'audiobook-catalog-compare';

/**
 * Buttons that compare a series' or an author's books with each catalog that compares them
 * (CompareCatalogs, the syncs' PARTS), and with all of them at once when there are several; `words(label)` is
 * each button's text.
 */
export function shelfCompareButtons(
	kind: 'series' | 'author',
	id: string,
	words: (label: string) => string,
): HTMLButtonElement[] {
	const syncs = CompareCatalogs.of(kind);
	const button: (catalog: string, label: string) => HTMLButtonElement = (catalog, label) =>
		buildElement(
			'button',
			{
				type: 'button',
				class: 'catalogCompare',
				'data-compare': catalog,
				onclick: () => openShelfCompare({catalog, kind, id}),
			},
			words(label),
		);
	return [
		...syncs.map(({catalog, label}) => button(catalog, label)),
		...(syncs.length > 1 ? [button(ALL_CATALOGS, 'all catalogs')] : []),
	];
}

/** The CompareRequest's catalog that compares with every catalog at once (the All catalogs panel's prefix). */
export const ALL_CATALOGS = 'all';

/**
 * Open the Import & export page to compare `request`, handed over in this tab's sessionStorage, so the address
 * stays the page's own and a reload or Back doesn't compare again; a browser that keeps nothing there gets
 * the comparison's address (shelfCompareHref).
 */
export function openShelfCompare(request: CompareRequest) {
	let address = 'import.html';
	try {
		sessionStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(request));
	} catch {
		address = shelfCompareHref(request.catalog, request.kind, request.id);
	}
	location.assign(address);
}

/**
 * The comparison a Compare button handed over (openShelfCompare), taken so it is done once; null for none.
 */
export function takeShelfCompare(): CompareRequest | null {
	try {
		const raw = sessionStorage.getItem(COMPARE_STORAGE_KEY);
		if (raw === null) return null;
		sessionStorage.removeItem(COMPARE_STORAGE_KEY);
		const request: unknown = JSON.parse(raw);
		return Text.isObject(request) &&
			typeof request.catalog === 'string' &&
			(request.kind === 'series' || request.kind === 'author') &&
			typeof request.id === 'string'
			? {catalog: request.catalog, kind: request.kind, id: request.id}
			: null;
	} catch {
		return null; // nothing kept, or not what a button keeps
	}
}

/**
 * What an address of one of those pages holds after `key`= (#n=id), or null: the id there, as it is.
 */
export function valueFromPageHash(hash: string, key: string): string | null {
	const m = new RegExp(`^#${key}=(.*)$`).exec(String(hash || ''));
	if (!m) return null;
	let value = m[1].replace(/\+/g, ' ');
	try {
		value = decodeURIComponent(value);
	} catch {
		/* not encoded: kept as written */
	}
	return value.trim() || null;
}

/**
 * The id of the series or person an address names: by their id, or by their name (a link from before
 * addresses had ids). Null when it names neither.
 */
export function idFromAddress(kind: NamedKind, value: string | null): string | null {
	if (value === null) return null;
	if (CATALOG.nameOf(kind, value) !== undefined) return value;
	return CATALOG.nameIds[kind].get(value) ?? null;
}

// The catalog the page shows. It stays this one object: a page that takes another catalog (Restore, an
// import confirmed) moves it in with CATALOG.replaceWith().
export const CATALOG = new Catalog();
export let SEEN_REVISION: number | null = null; // the revision of the stored catalog this page last read or wrote; null while none was ever saved

let DATABASE: CatalogDatabase | null = null;
let SAVED: Snapshot = new Map(); // the records as this page last read or wrote them, so a save writes only what changed
let SAVE_REFUSED = ''; // why nothing can be saved in this browser, when nothing can
let SAVING: Promise<void> = Promise.resolve(); // the saves asked for, one after another
let COUNTING: Promise<void> = Promise.resolve(); // what waits for the saves: the Duplicates link's count, and pages drawn again (afterSaving)
let READING = Promise.resolve(); // the reads pages wait on (see reading())
let STARTUP_NOTICE = '';
// A page holds only what it shows (loadRecords() brings in more), unless it asked for the whole catalog
// (startPage's `whole`, or wholeCatalog()); a page in a browser without IndexedDB holds all of it.
let WHOLE = false;
let POSITIONS: Map<string, number> = new Map(); // the place among all the books of each book loaded, while not WHOLE

// The page's own hooks, from startPage(): onCatalogJob(job), when the page has it, does more with each
// update of a Hardcover or AudiobookDB run (see showCatalogJob); redrawPage() draws the page again when a save took in
// what another tab changed.
let onCatalogJob: ((job: CatalogJob | null) => void) | null = null;
let redrawPage: ((before: Book[]) => void) | null = null;

/** @returns the revision of the catalog as it is stored now (another tab may have saved since) */
export async function storedRevision(): Promise<number | null> {
	try {
		return DATABASE ? await DATABASE.revision() : null;
	} catch {
		return null;
	}
}

// When this browser last downloaded (or restored) a backup, and the catalog's revision then, so the pages can say
// how old the newest backup is and how many saves came since. It is about this browser's copy, so localStorage keeps it.
const BACKUP_KEY = 'audiobook-catalog-last-backup';

/** @returns the last backup this browser noted, if any */
function lastBackup(): {time: string; revision: number | null} | null {
	try {
		const v = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null');
		return v && typeof v.time === 'string' && !isNaN(Date.parse(v.time)) ? v : null;
	} catch {
		return null;
	}
}

/** Note that the catalog as stored now is in a backup (one just downloaded or restored). */
export async function noteBackup() {
	await whenSaved();
	const revision = await storedRevision();
	try {
		localStorage.setItem(BACKUP_KEY, JSON.stringify({time: new Date().toISOString(), revision}));
	} catch {
		/* the backup just goes unnoted */
	}
}

/**
 * How old the last backup is, in whole days (null when there is none), and how many saves came since.
 */
export async function backupAge(now: number = Date.now()): Promise<{days: number | null; changes: number}> {
	const last = lastBackup();
	const revision = (await storedRevision()) || 0;
	return {
		days: last ? Math.max(0, Math.floor((now - Date.parse(last.time)) / 86400000)) : null,
		changes: Math.max(0, revision - ((last && last.revision) || 0)),
	};
}

/**
 * The backup's age as the Backups panel says it.
 */
export function backupAgeText({days, changes}: {days: number | null; changes: number}): string {
	if (days === null) return 'No backup downloaded in this browser yet.';
	const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
	return (
		`Last backup ${when}; ` +
		(changes ? `${Text.plural(changes, 'change')} saved since.` : 'nothing changed since.')
	);
}

/**
 * Whether the catalog page should remind you to download a backup: something changed since the last one, and
 * that was two weeks ago or more, or many changes ago (or there is none, and some changes were made).
 */
export const needsBackup = ({days, changes}: {days: number | null; changes: number}): boolean =>
	changes > 0 && (days === null ? changes >= 10 : days >= 14 || changes >= 50);

/** @returns when the saves asked for so far are done, and the Duplicates link counted after them */
export function whenSaved(): Promise<void> {
	return Promise.all([SAVING, COUNTING, READING]).then(() => {});
}

/**
 * Note a read the page waits on (loadRecords and the like), so whenSaved() waits for it too.
 */
function reading<T>(read: Promise<T>): Promise<T> {
	READING = Promise.all([READING, read.catch(() => {})]).then(() => {});
	return read;
}

/**
 * How many duplicate groups and books with split editions a catalog has, as the Duplicates link counts them.
 */
function duplicateCount(catalog: Catalog): number {
	const duplicates = catalog.duplicates();
	return duplicates.groups().length + duplicates.splitEditions().length;
}

/** @param n how many, or null while that isn't known */
function showDuplicateCount(n: number | null) {
	byId('dupCount').textContent = n ? ` (${n})` : '';
}

// The page links: the duplicates link says how many duplicates and books with split editions there are.
// That takes every book, so a page that holds only some shows the count kept with the revision it was
// counted at; when the catalog changed since, it counts again after the page is drawn, reading every
// book but keeping none, and keeps the count for the next page.
export function updateNav() {
	if (WHOLE) {
		showDuplicateCount(duplicateCount(CATALOG));
		return;
	}
	COUNTING = COUNTING.then(() => SAVING)
		.then(countDuplicates)
		.catch(() => {});
}

/**
 * Do `task` once the saves asked for so far are done (a page draws again from what is stored, say);
 * whenSaved() waits for it too. A task that fails says so on the status line.
 */
export function afterSaving(task: () => Promise<void> | void): Promise<void> {
	const run = COUNTING.then(() => SAVING)
		.then(task)
		.catch(e =>
			showIoStatus(
				spell(`Couldn't read the catalog kept in this browser: ${Text.errorText(e)}. Reload the page.`),
				true,
			),
		);
	COUNTING = run;
	return run;
}

async function countDuplicates() {
	if (!DATABASE) return;
	const [kept, revision] = await Promise.all([DATABASE.duplicateCount(), DATABASE.revision()]);
	if (revision === null) {
		showDuplicateCount(0);
		return;
	}
	if (kept && kept.revision === revision) {
		showDuplicateCount(kept.count);
		return;
	}
	showDuplicateCount(null);
	const stored = await DATABASE.load();
	if (!stored) return;
	const n = duplicateCount(CatalogRecords.toCatalog(stored.records));
	showDuplicateCount(n);
	await DATABASE.keepDuplicateCount(stored.revision, n);
}

/**
 * Each book's place among all of them, for the records of a page that holds only some: as it was loaded,
 * or NEW_POSITION for one it added (the save puts it after the others).
 */
const positionOf: (b: Book, index: number) => number = (b, index) =>
	WHOLE ? index : (POSITIONS.get(b.id as string) ?? CatalogRecords.NEW_POSITION);

/** @returns the records of what the page holds now */
const recordsNow = (): RecordSet => CatalogRecords.fromCatalog(CATALOG, undefined, WHOLE ? undefined : positionOf);

/**
 * Whether the page loaded (or saved) the record under `key`.
 */
const loaded = (store: StoreName, key: IDBValidKey): boolean =>
	!!(SAVED.get(store) || new Map()).has(JSON.stringify(key));

/**
 * What a page asks loadRecords() for: books by id, every book of some series (by id, or by name), the books
 * with an edition an external id names ("asin B0…", as Edition.idKeys() has it, or "isbn 978…"), and series
 * and people by id (their records, whether or not any book loaded names them).
 */
export interface Wanted {
	books?: string[];
	seriesBooks?: string[];
	seriesNamed?: string[];
	editionKeys?: string[];
	series?: string[];
	contributors?: string[];
}

/**
 * The records `want` names that the page lacks (`has` says what it holds), with what they need to make
 * books: their editions, the other books of those editions (a box set's titles, which a card names, and
 * which an edit of the edition changes too), and the series and people they all name.
 */
async function readWanted(
	r: CatalogReader,
	want: Wanted,
	has: (store: StoreName, key: IDBValidKey) => boolean,
): Promise<RecordSet> {
	const bookIds = new Set(want.books || []);
	const seriesBooks = [...(want.seriesBooks || [])];
	for (const name of want.seriesNamed || [])
		for (const rec of await r.all('series', 'name', name)) seriesBooks.push(rec.id);
	for (const key of want.editionKeys || [])
		for (const ed of await r.all('editions', 'idKeys', key)) for (const id of ed.bookIds) bookIds.add(id);
	for (const id of seriesBooks)
		for (const key of await r.allKeys('books', 'bySeries', r.keyRange.bound([id], [id, []])))
			bookIds.add(key as string);
	const lacking: (store: StoreName, ids: Iterable<string>) => string[] = (store, ids) =>
		[...new Set(ids)].filter(id => !has(store, id));
	const books: import('./modules/catalog-records.js').BookRecord[] = await r.get('books', lacking('books', bookIds));
	const editions: import('./modules/catalog-records.js').EditionRecord[] = await r.get(
		'editions',
		lacking(
			'editions',
			books.flatMap(b => b.editionIds),
		),
	);
	const others = await r.get(
		'books',
		lacking(
			'books',
			editions.flatMap(ed => ed.bookIds),
		).filter(id => !bookIds.has(id)),
	);
	const seen = new Set(editions.map(ed => ed.id));
	editions.push(
		...(await r.get(
			'editions',
			lacking(
				'editions',
				others.flatMap(b => b.editionIds),
			).filter(id => !seen.has(id)),
		)),
	);
	books.push(...others);
	const series = lacking('series', [
		...books.map(b => b.seriesId).filter(x => x !== undefined),
		...seriesBooks,
		...(want.series || []),
	]);
	const people = lacking('contributors', [
		...books.flatMap(b => b.authorIds),
		...editions.flatMap(ed => [...ed.narratorIds, ...(ed.publisherId ? [ed.publisherId] : [])]),
		...(want.contributors || []),
	]);
	return {
		books,
		editions,
		series: await r.get('series', series),
		contributors: await r.get('contributors', people),
		credits: [],
		marks: [],
		exclusions: [],
	};
}

/**
 * Take records read from the database into CATALOG, next to what the page holds; a record it holds
 * already stays as the page has it.
 */
function takeIn(records: RecordSet) {
	const now = recordsNow();
	const combined: Record<string, any[]> = {};
	for (const store of CatalogRecords.STORE_NAMES) {
		const mine = now[store] as Record<string, any>[];
		const keys = new Set(mine.map(rec => JSON.stringify(CatalogRecords.keyOf(store, rec))));
		const fresh = (records[store] as Record<string, any>[]).filter(
			rec => !keys.has(JSON.stringify(CatalogRecords.keyOf(store, rec))),
		);
		combined[store] = [...mine, ...fresh];
		if (!CatalogRecords.DERIVED[store]) continue;
		if (!SAVED.has(store)) SAVED.set(store, new Map());
		const saved = SAVED.get(store) as Map<string, string>;
		for (const rec of fresh)
			saved.set(JSON.stringify(CatalogRecords.keyOf(store, rec)), CatalogRecords.ownText(store, rec));
	}
	for (const b of records.books) if (!POSITIONS.has(b.id)) POSITIONS.set(b.id, b.position);
	CATALOG.replaceWith(CatalogRecords.toCatalog(combined as unknown as RecordSet));
	CATALOG.assignIds();
}

/**
 * Bring what `want` names into CATALOG (see Wanted), once the saves asked for are done. The page holds
 * everything already when it is WHOLE. Throws when the records can't be read.
 */
export function loadRecords(want: Wanted): Promise<void> {
	return reading(
		(async () => {
			if (WHOLE || !DATABASE) return;
			await SAVING;
			const db = DATABASE;
			const {result} = await db.read(r => readWanted(r, want, loaded));
			takeIn(result);
		})(),
	);
}

/**
 * Ask the stored catalog something (`ask` reads it with a CatalogReader), once the saves asked for are
 * done; when the page holds all of it (and in a browser without IndexedDB), the catalog the page holds.
 */
export function queryCatalog<T>(ask: (reader: CatalogReader) => Promise<T>): Promise<T> {
	return reading(
		(async () => {
			await SAVING;
			if (DATABASE && !WHOLE) return (await DATABASE.read(ask)).result;
			return ask(new MemoryReader(recordsNow()) as unknown as CatalogReader);
		})(),
	);
}

/**
 * Hold the whole catalog from now on (an import, Check or Export needs every book), once the saves asked for are done.
 */
export function wholeCatalog(): Promise<void> {
	return reading(
		(async () => {
			if (WHOLE || !DATABASE) return;
			await SAVING;
			const stored = await DATABASE.load();
			CATALOG.replaceWith(stored ? CatalogRecords.toCatalog(stored.records) : new Catalog());
			CATALOG.assignIds();
			SAVED = stored ? CatalogRecords.snapshot(stored.records) : new Map();
			if (stored) SEEN_REVISION = stored.revision;
			POSITIONS = new Map();
			WHOLE = true;
		})(),
	);
}

/**
 * Before a page that holds only some of the catalog saves: a series or person it names that it holds no
 * record of (a name typed in a form) may be stored already, under an id of its own. Use that id, and the
 * record's info, so the save adds no second one.
 */
async function takeInNamesTyped(): Promise<void> {
	if (WHOLE || !DATABASE) return;
	const ask: {kind: import('./modules/catalog.js').NamedKind; name: string}[] = [];
	for (const kind of Catalog.NAMED_KINDS) {
		const store = kind === 'series' ? 'series' : 'contributors';
		for (const name of CATALOG.namesOf(kind)) {
			const id = CATALOG.nameIds[kind].get(name);
			if (id === undefined || !loaded(store, id)) ask.push({kind, name});
		}
	}
	if (!ask.length) return;
	const {result} = await DATABASE.read(r =>
		Promise.all(
			ask.map(({kind, name}) =>
				kind === 'series'
					? r.all('series', 'name', name)
					: r.all('contributors', 'kindName', [Contributor.ONE[kind], name]),
			),
		),
	);
	result.forEach((found, i) => {
		const rec = found[0];
		if (!rec) return;
		const {kind, name} = ask[i],
			store = kind === 'series' ? 'series' : 'contributors';
		const info = CATALOG.infoMap(kind),
			had = CATALOG.nameIds[kind].get(name);
		const typed = had === undefined ? undefined : info.get(had);
		if (had !== undefined) info.delete(had);
		CATALOG.nameIds[kind].set(name, rec.id);
		const stored = CatalogRecords.toCatalog({
			books: [],
			editions: [],
			series: store === 'series' ? [rec] : [],
			contributors: store === 'contributors' ? [rec] : [],
			credits: [],
			marks: [],
			exclusions: [],
		})
			.infoMap(kind)
			.get(rec.id);
		const entry = typed || stored;
		if (entry) info.set(rec.id, entry);
		if (!SAVED.has(store)) SAVED.set(store, new Map());
		(SAVED.get(store) as Map<string, string>).set(JSON.stringify(rec.id), CatalogRecords.ownText(store, rec));
	});
}

/**
 * Keep the catalog as the page holds it now. Saves are made one after another, and each writes only the
 * records that changed. When another page or tab saved meanwhile, what it changed is taken in first
 * (catchUp), so edits of different entries in different tabs all stay; when both changed the same entry,
 * nothing is saved. Pages need not wait for it; it says on the status line when a save fails.
 */
export function persist(): Promise<void> {
	CATALOG.assignIds(); // a book or name just added has its id before the page draws it again
	SAVING = SAVING.then(saveNow);
	updateNav();
	return SAVING;
}

async function saveNow() {
	if (!DATABASE) {
		showIoStatus(SAVE_REFUSED, true);
		return;
	}
	const unstorable = CatalogRecords.unstorable(CATALOG);
	if (unstorable.length) {
		showIoStatus(
			spell(
				`Not saved: these values can't be kept, as they aren't what their field holds: ${Text.firstThree(unstorable, '; ')}. ` +
					'Export a backup, fix them there (Check lists them) and Restore it.',
			),
			true,
		);
		return;
	}
	// another tab may save again while this page takes in its last save, so this page tries a few times
	for (let tries = 1; ; tries++) {
		try {
			await takeInNamesTyped();
		} catch {
			showIoStatus(
				spell('Not saved: the catalog kept in this browser could not be read. Reload the page.'),
				true,
			);
			return;
		}
		const records = recordsNow();
		const changes = CatalogRecords.changes(SAVED, records);
		if (!changes.count && SEEN_REVISION !== null) return;
		try {
			const first = SEEN_REVISION === null;
			const saved = await DATABASE.save(changes, SEEN_REVISION);
			SEEN_REVISION = saved.revision;
			SAVED = changes.snapshot;
			// the books added have their place among all of them now
			for (const rec of records.books) {
				const position = saved.positions.get(rec.id);
				if (position === undefined) continue;
				POSITIONS.set(rec.id, position);
				(SAVED.get('books') as Map<string, string>).set(
					JSON.stringify(rec.id),
					CatalogRecords.ownText('books', {...rec, position}),
				);
			}
			if (first) setAsideOldCatalog();
			if (WHOLE) await DATABASE.keepDuplicateCount(saved.revision, duplicateCount(CATALOG)).catch(() => {});
			return;
		} catch (e) {
			if (!(e instanceof CatalogConflict)) {
				// nothing else holds this catalog, so say so instead of losing the edit quietly
				showIoStatus(
					spell(
						'Not saved: this browser refused to store the catalog (is its storage full?). Export a backup.',
					),
					true,
				);
				return;
			}
			const both = tries < 3 ? await catchUp() : [];
			if (both) {
				showIoStatus(
					spell(
						both.length
							? `Not saved: ${Text.firstThree(both)} changed in another tab too. Reload this page to see that, then make this change again.`
							: 'The catalog was changed in another tab. Reload this page to see that; this change was not saved.',
					),
					true,
				);
				return;
			}
		}
	}
}

/**
 * Another tab saved since this page last read or wrote the catalog: take what it changed into CATALOG,
 * so the next save writes this page's changes over the other tab's, and redraw the page. Returns null when
 * that was done, else what both changed (an empty list when the two can't be put together otherwise), and
 * then CATALOG is as it was.
 */
async function catchUp(): Promise<string[] | null> {
	// a page that never read a stored catalog (its first save moves the one localStorage kept) has nothing to go by
	if (!DATABASE || SEEN_REVISION === null) return [];
	let before: Book[];
	try {
		// a page that holds only some of the catalog reads only what it holds, as it is stored now
		const keys: (store: StoreName) => string[] = store =>
			[...(SAVED.get(store) || new Map()).keys()].map(key => JSON.parse(key));
		const db = DATABASE;
		const stored = WHOLE
			? await db.load()
			: await db
					.read(r =>
						readWanted(
							r,
							{books: keys('books'), series: keys('series'), contributors: keys('contributors')},
							() => false,
						),
					)
					.then(({result, revision}) => (revision === null ? null : {records: result, revision}));
		if (!stored) return [];
		const {records, conflicts} = CatalogRecords.merge(SAVED, recordsNow(), stored.records, WHOLE);
		if (conflicts.length) return conflicts;
		before = CATALOG.books;
		CATALOG.replaceWith(CatalogRecords.toCatalog(records));
		CATALOG.assignIds();
		SAVED = CatalogRecords.snapshot(stored.records);
		SEEN_REVISION = stored.revision;
		if (!WHOLE) for (const b of stored.records.books) POSITIONS.set(b.id, b.position);
	} catch {
		return [];
	}
	if (redrawPage) redrawPage(before);
	updateNav();
	return null;
}

// Ask the browser not to clear this site's storage when space runs low; on a phone it may otherwise.
function askToKeepStorage() {
	try {
		navigator.storage.persist().catch(() => {});
	} catch {
		/* asking is all a page can do */
	}
}

// Load the catalog kept in this browser (all of it with `whole`; otherwise the page loads what it shows
// itself, with loadRecords()); with none, it starts empty. One that can't be read is set aside (under
// meta's `unreadable`), not overwritten by the next edit. When nothing was saved yet, the catalog
// localStorage kept before is moved over; records from an older version of the app are saved again in
// the current shape (a series' site moved to its author or publisher).
async function loadCatalog(whole: boolean) {
	try {
		DATABASE = await CatalogDatabase.open(indexedDB);
	} catch {
		SAVE_REFUSED = spell(
			"Not saved: this browser won't keep the catalog for this page (it has no IndexedDB here). Export a backup before you leave.",
		);
		STARTUP_NOTICE = SAVE_REFUSED;
		WHOLE = true;
		await readOldCatalog();
		return;
	}
	let stored: {records: RecordSet; revision: number} | null = null;
	try {
		const revision = await DATABASE.revision();
		if (revision === null) {
			// a catalog from before it lived in IndexedDB is saved there at once (and is in the current format then)
			WHOLE = true;
			if (await readOldCatalog()) await persist();
			// one that can't be saved (persist() said why) stays shown as it is
			if (!whole && (await DATABASE.revision()) !== null) holdNothing();
			return;
		}
		const reshape = await DATABASE.needsReshape();
		if (!whole && !reshape) {
			SEEN_REVISION = revision;
			return;
		}
		stored = await DATABASE.load();
		if (!stored) return;
		CATALOG.replaceWith(CatalogRecords.toCatalog(stored.records));
		SEEN_REVISION = stored.revision;
		SAVED = CatalogRecords.snapshot(stored.records);
		WHOLE = true;
		CATALOG.moveSeriesSites();
		if (reshape || CatalogRecords.outdated(stored.records)) await saveAll();
		if (!whole) holdNothing();
	} catch (e) {
		try {
			SEEN_REVISION = await DATABASE.setAside(stored ? stored.records : Text.errorText(e));
			SAVED = new Map();
		} catch {
			DATABASE = null;
			SAVE_REFUSED = spell(
				"Not saved: the catalog kept in this browser can't be read or set aside. Export a backup.",
			);
		}
		CATALOG.replaceWith(new Catalog());
		WHOLE = whole || !DATABASE;
		STARTUP_NOTICE = spell(
			"Couldn't read the catalog kept in this browser; it was set aside and the catalog starts empty. Restore a backup.",
		);
	}
}

// Save every record again, so each has the derived fields this version of the app reads (the page holds them all).
async function saveAll() {
	const db = DATABASE as CatalogDatabase;
	await SAVING;
	const changes = CatalogRecords.changes(new Map(), recordsNow());
	const saved = await db.save(changes, SEEN_REVISION);
	SEEN_REVISION = saved.revision;
	SAVED = changes.snapshot;
}

// After a page that loads only what it shows moved or reshaped the catalog: it holds nothing yet.
function holdNothing() {
	CATALOG.replaceWith(new Catalog());
	SAVED = new Map();
	POSITIONS = new Map();
	WHOLE = false;
}

// localStorage held the catalog before IndexedDB did: under CATALOG_KEY as a backup ({books, seriesInfo, authors, narrators,
// publishers, excluded}; the key is the one the installed app kept its own catalog under), with the "Not duplicates"
// marks under NOT_DUP_KEY. Once moved, each is kept under its name + MOVED_SUFFIX, a copy that is never read again.
const CATALOG_KEY = 'audiobook-catalog-device';
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
const MOVED_SUFFIX = '.moved-to-indexeddb';

/**
 * Read the catalog localStorage kept into CATALOG; returns whether there was one. One that can't be read
 * is set aside (under CATALOG_KEY + '.unreadable'), and the catalog starts empty. Reading backups is loaded
 * only then, as no page needs it otherwise.
 */
async function readOldCatalog(): Promise<boolean> {
	const item: (key: string) => string | null = key => {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	};
	try {
		const raw = item(CATALOG_KEY);
		if (!raw) return false;
		const saved: Unchecked = JSON.parse(raw);
		const {Backup} = await import('./modules/backup.js');
		const catalog = Backup.toCatalog(saved);
		const marks = JSON.parse(item(NOT_DUP_KEY) || '[]');
		if (Array.isArray(marks)) catalog.addMarkTexts(marks.filter(x => typeof x === 'string'));
		CATALOG.replaceWith(catalog);
		return true;
	} catch {
		try {
			localStorage.setItem(CATALOG_KEY + '.unreadable', item(CATALOG_KEY) || '');
			localStorage.removeItem(CATALOG_KEY);
		} catch {
			/* the notice below still tells what happened */
		}
		STARTUP_NOTICE = spell(
			"Couldn't read the catalog kept in this browser; it was set aside and the catalog starts empty. Restore a backup.",
		);
		return false;
	}
}

// Once IndexedDB holds the catalog, what localStorage kept is renamed, so it is never read again but not lost.
function setAsideOldCatalog() {
	for (const key of [CATALOG_KEY, NOT_DUP_KEY]) {
		try {
			const value = localStorage.getItem(key);
			if (value === null) continue;
			localStorage.setItem(key + MOVED_SUFFIX, value);
			localStorage.removeItem(key);
		} catch {
			/* left as it was, and moved on the next load */
		}
	}
}

let ioStatusTimer: ReturnType<typeof setTimeout> | undefined;

/** How long the status line shows a message, and so how long its Undo can be pressed. */
export const STATUS_TIME = 5000;

/**
 * Say something on the status line for a few seconds; `isErr` shows it as an error. With `undo`, the line
 * has an Undo button that runs it and clears the line.
 */
export function showIoStatus(msg: string, isErr?: boolean, undo?: () => void) {
	const el = byId('ioStatus');
	const clear = () => {
		clearTimeout(ioStatusTimer);
		fillElement(el);
	};
	fillElement(
		el,
		msg,
		undo && [
			' ',
			buildElement(
				'button',
				{
					type: 'button',
					class: 'undo',
					onclick: () => {
						clear();
						undo();
					},
				},
				'Undo',
			),
		],
	);
	el.classList.toggle('err', !!isErr);
	clearTimeout(ioStatusTimer);
	ioStatusTimer = setTimeout(clear, STATUS_TIME);
}

/**
 * The page's element with this id. Throws when there is none, which is a mistake in the page.
 */
export function byId(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) throw new Error(`the page has no #${id}`);
	return el;
}

export type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * The page's form field (an <input>, <select> or <textarea>) with this id, for its value; byId() for anything else.
 */
export function fieldById(id: string): FormField {
	return byId(id) as FormField;
}

// ------------------------------------------------------------ external ids in forms and on pages
// A form has a field per group of external catalogs (Audible, Amazon, Goodreads, Hardcover) that has pages
// for what the form edits; each takes an id or the address of the page there, and the catalog keeps the id.

/**
 * The fields for the external ids of a kind of thing, each a <div> with a label and an input whose id is
 * `prefix` and the group ("sf_ext_goodreads"); `except` leaves groups out (a field of their own elsewhere).
 */
export function externalFields(prefix: string, kind: ExternalKind, except: string[] = []): HTMLDivElement[] {
	return ExternalCatalog.groupsFor(kind)
		.filter(g => !except.includes(g.key))
		.map(g => {
			const sites = ExternalCatalog.forKind(kind).filter(def => def.group === g.key);
			const example =
				sites.length > 1
					? g.default
					: ((ExternalCatalog.url(sites[0].key, kind, 'x') || '')
							.replace(/^https?:\/\/(www\.)?/, '')
							.split('/')[0] as string);
			// Hardcover's address of a series or person is looked up for its number as soon as the field is left
			const lookup =
				g.key === 'hardcover' && kind !== 'book' && kind !== 'edition'
					? {
							onchange: async () => {
								const found = await lookupHardcoverField(prefix, kind);
								if (found && found.note) showIoStatus(found.note);
							},
						}
					: {};
			return buildElement(
				'div',
				{},
				buildElement('label', {for: prefix + g.key}, g.name),
				buildElement('input', {
					id: prefix + g.key,
					'data-group': g.key,
					placeholder: `id, or its address on ${example}`,
					...lookup,
					onfocusout: () => externalFieldToId(prefix, kind, g.key),
				}),
			);
		});
}

/**
 * When a field externalFields() made is left holding a page's address, it is given the id the address names,
 * which is what is kept. An address on another of the group's sites (audible.co.uk in the Audible field)
 * stays an address, tidied, as the id alone would be read as the usual site's. An address pasted into another
 * catalog's field moves to that catalog's field, when the form has one that is empty or holds the same id.
 * Anything else is left for Save to refuse, saying why.
 */
function externalFieldToId(prefix: string, kind: ExternalKind, group: string) {
	const field = document.getElementById(prefix + group) as HTMLInputElement | null;
	const text = field ? Text.tidy(field.value) : '';
	if (!field || !text) return;
	/** @param into the group of the field it goes in */
	const shown = (found: ExternalId, into: string) => {
		const bare = ExternalCatalog.readId(found.id, kind, into);
		return bare && bare.catalog === found.catalog
			? found.id
			: ExternalCatalog.url(found.catalog, kind, found.id) || text;
	};
	const found = ExternalCatalog.readId(text, kind, group);
	if (found) {
		field.value = shown(found, group);
		return;
	}
	const elsewhere = ExternalCatalog.fromAddress(text, kind),
		g = elsewhere && ExternalCatalog.groupOf(elsewhere.catalog);
	const other = g ? (document.getElementById(prefix + g.key) as HTMLInputElement | null) : null;
	if (!elsewhere || !g || !other) return;
	const value = shown(elsewhere, g.key),
		there = Text.tidy(other.value);
	if (there && there !== value) return;
	other.value = value;
	field.value = '';
}

/**
 * Put an entry's external ids in the fields externalFields() made.
 */
export function fillExternalFields(prefix: string, kind: ExternalKind, ids: Record<string, string>) {
	for (const g of ExternalCatalog.groupsFor(kind)) {
		const field = document.getElementById(prefix + g.key);
		if (field) (field as HTMLInputElement).value = ExternalCatalog.fieldText(ids, kind, g.key);
	}
}

/**
 * The external ids in the fields externalFields() made, as {ids, bad (the fields that hold neither an id nor
 * an address there, as "Goodreads: text")}. The ids an entry has in catalogs no field stands for are kept.
 * @param had the entry's ids before
 */
export function readExternalFields(
	prefix: string,
	kind: ExternalKind,
	had: Record<string, string> = {},
): {ids: Record<string, string>; bad: string[]} {
	const groups = ExternalCatalog.groupsFor(kind).filter(g => document.getElementById(prefix + g.key));
	const shown = new Set(groups.map(g => g.key));
	const ids: Record<string, string> = Object.fromEntries(
		Object.entries(had).filter(([key]) => {
			const g = ExternalCatalog.groupOf(key);
			return !g || !shown.has(g.key);
		}),
	);
	const bad: string[] = [];
	for (const g of groups) {
		const text = Text.tidy(fieldById(prefix + g.key).value);
		if (!text) continue;
		const found = ExternalCatalog.readId(text, kind, g.key);
		if (found) ids[found.catalog] = found.id;
		else bad.push(`${g.name}: ${text}`);
	}
	return {ids, bad};
}

/**
 * Links to an entry's pages in external catalogs ("Goodreads ↗"), one per id; an Audible or Amazon site
 * other than the group's usual one says which ("Audible (audible.co.uk) ↗").
 * @param cls the links' class
 */
export function externalLinks(
	ids: Record<string, string>,
	kind: ExternalKind,
	cls: string = 'authorlink',
): HTMLAnchorElement[] {
	return Object.entries(ExternalCatalog.order(ids) || {}).flatMap(([key, id]) => {
		const url = ExternalCatalog.url(key, kind, id),
			g = ExternalCatalog.groupOf(key);
		if (!url) return [];
		const name = g ? (g.default === key ? g.name : `${g.name} (${key})`) : ExternalCatalog.name(key);
		return [buildElement('a', {class: cls, href: url, target: '_blank', rel: 'noopener'}, `${name} \u2197`)];
	});
}

// ------------------------------------------------------------ the catalogs' keys and clients
// Your key for a catalog (Hardcover's token, AudiobookDB's API key) is kept in this browser only (never in a
// backup), under its client class's KEY_STORAGE, and saved on Import & export. A catalog whose API answers web
// pages (Hardcover) is asked from the page itself; one that doesn't (AudiobookDB) through your server's catalog
// proxy, which passes the key on only with the requests that need it and never keeps it.
import type {CatalogClient, ClientClass, CatalogFetch} from './modules/catalog-client.js';

/**
 * Your key for the catalog of `Client`, as saved in this browser; '' for none.
 */
export function savedKey(Client: typeof CatalogClient): string {
	try {
		return Client.cleanKey(localStorage.getItem(Client.KEY_STORAGE));
	} catch {
		return '';
	}
}

/**
 * Keep `key` (tidied the way its catalog takes it) as your key for the catalog of `Client` in this browser, or
 * forget the one kept when it is ''. Throws when the browser refuses to store it.
 */
export function saveKey(Client: typeof CatalogClient, key: string) {
	const clean = Client.cleanKey(key);
	if (clean) localStorage.setItem(Client.KEY_STORAGE, clean);
	else localStorage.removeItem(Client.KEY_STORAGE);
}

/**
 * Asks a catalog that answers web pages from this page, saying plainly when the browser can't reach it at all.
 * @param label the catalog's name
 */
function fetchDirect(label: string): CatalogFetch {
	return async (url, opts) => {
		try {
			return await fetch(url, opts);
		} catch (e) {
			throw new Error(
				`this browser could not reach ${label} (offline, or ${label} refused a request from a web page)`,
				{cause: e},
			);
		}
	};
}

/**
 * A client of `Client`'s catalog asking from this page (or through the saved server's catalog proxy, for a
 * catalog asked through it), with `key` (your key; the one saved in this browser when left out).
 */
export function catalogClient<C extends CatalogClient>(Client: ClientClass<C>, key: string = savedKey(Client)): C {
	const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
	const server = savedServer();
	const get: CatalogFetch = Client.VIA_PROXY
		? (route, init) => fetchViaProxy(route, server, init)
		: fetchDirect(Client.LABEL);
	return new Client(get, key, pause);
}

/**
 * A client of each catalog of `Clients` (CatalogConnectors.CLIENTS) whose key is saved in this browser.
 */
export function keyedClients(Clients: readonly ClientClass[]): CatalogClient[] {
	return Clients.filter(Client => savedKey(Client)).map(Client => catalogClient(Client));
}

// ------------------------------------------------------------ Hardcover from the page
/**
 * The Hardcover book that `text` names: its id, or the address of the book's or one of its editions'
 * pages on hardcover.app (HardcoverClient.bookId), as {id, title}. An address without the book's id
 * is looked up on Hardcover with the token saved in this browser. Throws with a short reason.
 */
export async function lookupHardcoverBook(text: string): Promise<{id: string; title?: string}> {
	const {HardcoverClient} = await import('./modules/hardcover-client.js');
	const url = HardcoverClient.parseUrl(text);
	if (!url || url.book) return HardcoverClient.bookId(null, text);
	const token = savedKey(HardcoverClient);
	if (!token)
		throw new Error('to look it up on Hardcover, save your Hardcover API token on the Import & export page first');
	return HardcoverClient.bookId(catalogClient(HardcoverClient, token), text);
}

/** why the field can't be saved, or what to say about it */
export type HardcoverFieldLookup = {error: string; note: string};
/** the lookup, and the name it looks up */
export type HardcoverFieldLookupOnItsWay = Promise<HardcoverFieldLookup> & {slug?: string};
/** each field's lookup on its way, so a Save waits for it */
const HARDCOVER_FIELD_LOOKUPS: WeakMap<Element, HardcoverFieldLookupOnItsWay> = new WeakMap();

/**
 * Hardcover keeps a series, author, narrator or publisher by its number, which its links by id keep working
 * with when it is renamed, but its pages' addresses (what gets pasted) have a name in them. When the Hardcover
 * field externalFields() made holds such an address (or the name alone), this asks Hardcover for the number
 * (with the token saved in this browser) and puts it in the field. When Hardcover can't be asked (no token,
 * offline, refused), the name is kept: its page's address still works until Hardcover renames it.
 * Resolves to {error} when Hardcover has no such page, else {note} (what was found, or why the name was kept);
 * null when there is nothing to look up (a number, or nothing), so a form can save at once.
 */
export function lookupHardcoverField(
	prefix: string,
	kind: 'series' | 'author' | 'narrator' | 'publisher',
): Promise<HardcoverFieldLookup> | null {
	const field = document.getElementById(prefix + 'hardcover');
	const text = field ? Text.tidy((field as HTMLInputElement).value) : '';
	const found = text ? ExternalCatalog.readId(text, kind, 'hardcover') : null;
	if (!field || !found || !ExternalCatalog.isFallbackId('hardcover', kind, found.id)) return null;
	const onItsWay = HARDCOVER_FIELD_LOOKUPS.get(field);
	const slug = found.id;
	// the same name, as an address or alone (leaving the field turns its address into the name)
	if (onItsWay && onItsWay.slug === slug) return onItsWay;
	const address = ExternalCatalog.url('hardcover', kind, slug);
	const kept = (why: string) => ({
		error: '',
		note: `Kept Hardcover's ${kind} by the name in its address, as ${why}.`,
	});
	const lookup: HardcoverFieldLookupOnItsWay = (async () => {
		const {HardcoverClient} = await import('./modules/hardcover-client.js');
		const token = savedKey(HardcoverClient);
		if (!token) return kept('no Hardcover API token is saved on the Import & export page to look up its number');
		let row: {id: string; name: string} | null;
		try {
			row = await HardcoverClient.idBySlug(catalogClient(HardcoverClient, token), kind, slug);
		} catch (err) {
			return kept(`Hardcover couldn't be asked for its number (${Text.errorText(err)})`);
		}
		if (!row) return {error: `Hardcover has no ${kind} at ${address}.`, note: ''};
		const now = ExternalCatalog.readId((field as HTMLInputElement).value, kind, 'hardcover');
		if (now && now.id === slug) (field as HTMLInputElement).value = row.id;
		return {error: '', note: `Found on Hardcover: ${row.name || slug} (${kind} ${row.id}).`};
	})();
	lookup.slug = slug;
	HARDCOVER_FIELD_LOOKUPS.set(field, lookup);
	lookup.finally(() => {
		if (HARDCOVER_FIELD_LOOKUPS.get(field) === lookup) HARDCOVER_FIELD_LOOKUPS.delete(field);
	});
	return lookup;
}

// ------------------------------------------------------------ your server
// The app's optional server (server/worker.ts: a Cloudflare Worker, or make serve on this computer), when its
// address and key are saved on Import & export, does two things: its catalog proxy asks the catalogs whose APIs
// don't answer web pages (AudiobookDB, Audible, BookBrainz, ISFDB), and it keeps the copy devices sync with.
// Like the Hardcover token they are kept in this browser only (never in a backup); without them those catalogs
// are not asked. Hardcover is never asked through it, so the token never leaves for anywhere but Hardcover.
// The storage key is the one from when the server was only the proxy, so a server saved then is still found.
export const SERVER_STORAGE_KEY = 'audiobook-catalog-proxy';
const SERVER_KEY_HEADER = 'X-Server-Key';
const CATALOG_KEY_HEADER = 'X-Catalog-Key'; // your key for a catalog, which the proxy passes on only where it is needed

/** the server's address (no slash at the end) and its key */
export type ServerSettings = {url: string; key: string};

/** @returns the server saved in this browser, or null */
export function savedServer(): ServerSettings | null {
	try {
		const v = JSON.parse(localStorage.getItem(SERVER_STORAGE_KEY) || 'null') as Unchecked;
		const url = v && typeof v.url === 'string' ? serverAddress(v.url) : '';
		return url && typeof v.key === 'string' && v.key ? {url, key: v.key} : null;
	} catch {
		return null;
	}
}

/**
 * The server address typed, tidied (no slash at the end), or '' when it isn't one: https, or http only on this
 * computer (make serve), with no query or password in it.
 */
export function serverAddress(text: string): string {
	let url;
	try {
		url = new URL(text.trim());
	} catch {
		return '';
	}
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return '';
	if (url.search || url.hash || url.username || url.password) return '';
	return (url.origin + url.pathname).replace(/\/+$/, '');
}

/**
 * Asks the server: `path` is its route (`ping`, `sync`, `proxy/audiobookdb/…`). With `init.key` (your key for a
 * catalog, AudiobookDB's) it goes along for the proxy to pass on, and with `init.body` it is a POST of that JSON.
 * Throws plainly when no server is saved or the browser can't reach it.
 * @param server the saved one when left out
 */
export async function fetchFromServer(
	path: string,
	server: ServerSettings | null = savedServer(),
	init: {body?: string; key?: string} = {},
): Promise<Response> {
	if (!server) throw new Error('save your server on the Import & export page');
	const headers: Record<string, string> = {[SERVER_KEY_HEADER]: server.key};
	if (init.key) headers[CATALOG_KEY_HEADER] = init.key;
	if (init.body !== undefined) headers['Content-Type'] = 'application/json';
	const ask = init.body !== undefined ? {method: 'POST', body: init.body, headers} : {headers};
	try {
		return await fetch(`${server.url}/${path.replace(/^\/+/, '')}`, ask);
	} catch (e) {
		throw new Error(
			'this browser could not reach your server (check its address, and that it allows this page in ALLOWED_ORIGINS)',
			{cause: e},
		);
	}
}

/**
 * Asks a catalog through the server's catalog proxy: `route` is the catalog and the path in its API
 * (`audiobookdb/audiobooks/external/audible/B0…`); `init` as for fetchFromServer.
 * @param server the saved one when left out
 */
export function fetchViaProxy(
	route: string,
	server: ServerSettings | null = savedServer(),
	init: {body?: string; key?: string} = {},
): Promise<Response> {
	return fetchFromServer(`proxy/${route.replace(/^\/+/, '')}`, server, init);
}

// ------------------------------------------------------------ syncing devices
// With sync set up on your server (a D1 database, or make serve's SQLite file; docs/server.md), the server keeps one
// copy of the catalog, encrypted with a passphrase that is kept in this browser only, like the server's key (never in a backup,
// never sent). Syncing takes in what other devices changed since this browser last synced, saves it, and sends the
// result as the next copy (CatalogSync). What this browser last synced is kept in IndexedDB (meta `sync`).
export const SYNC_STORAGE_KEY = 'audiobook-catalog-sync-passphrase';

/** @returns the sync passphrase saved in this browser, or '' */
export function savedPassphrase(): string {
	try {
		return localStorage.getItem(SYNC_STORAGE_KEY) || '';
	} catch {
		return '';
	}
}

/** @returns when this browser last synced, and the copy's revision then */
export async function lastSync(): Promise<{revision: number; at: string} | null> {
	try {
		const base = DATABASE ? await DATABASE.syncBase() : null;
		return base ? {revision: base.revision, at: base.at} : null;
	} catch {
		return null;
	}
}

/**
 * What a sync did: how many records it took in from the other devices, whether it sent a new copy, and the
 * entries both this browser and another device changed (then nothing was done, unless told which to keep).
 */
export type SyncOutcome = {taken: number; sent: boolean; conflicts: string[]};

/**
 * The server's answer to a sync request, or a plain error saying what is wrong.
 */
async function syncAnswer(res: Response): Promise<{revision: number; data?: string | null}> {
	if (res.status === 401) throw new Error('your server refused the key');
	if (res.status === 501) throw new Error('sync is not set up on your server (see Your server in the docs)');
	if (res.status === 404) throw new Error('your server is from before sync: deploy it again');
	if (res.status === 413) throw new Error('the catalog is too big to sync');
	if (!res.ok) throw new Error(`your server answered ${res.status}`);
	return (await res.json()) as {revision: number; data?: string | null};
}

/**
 * Sync this browser's catalog with the copy on your server: take in what other devices changed since this
 * browser last synced, save it here, and send the result. When both changed one entry, nothing is changed and
 * the outcome names them, unless `prefer` says whose to keep. Throws a plain error (or CatalogSync's
 * WrongPassphrase, UnrelatedCatalogs, or NewerBackup) when it can't.
 */
export async function syncCatalog(prefer?: SyncPrefer): Promise<SyncOutcome> {
	if (!DATABASE) throw new Error(SAVE_REFUSED || 'this browser keeps no catalog to sync');
	const passphrase = savedPassphrase();
	if (!passphrase) throw new Error('save a sync passphrase first');
	// only Import & export syncs, so only it loads what syncing needs
	const [{Backup}, {CatalogSync}] = await Promise.all([
		import('./modules/backup.js'),
		import('./modules/catalog-sync.js'),
	]);
	await wholeCatalog();
	// another device may send its copy between this browser's reading and sending: then it reads again
	for (let tries = 1; tries <= 3; tries++) {
		const got = await syncAnswer(await fetchFromServer('sync'));
		const base = await DATABASE.syncBase();
		const opened = got.data ? await CatalogSync.open(got.data, passphrase) : null;
		// what this browser synced last is of use only while the copy is that one, at that revision or later
		const known = base && opened && opened.copy === base.copy && got.revision >= base.revision ? base.backup : null;
		await SAVING;
		const mine = Backup.write(CATALOG);
		const result = CatalogSync.combine(known, mine, opened ? opened.backup : null, prefer);
		if (result.conflicts.length && !prefer) return {taken: 0, sent: false, conflicts: result.conflicts};
		if (result.taken) {
			const before = CATALOG.books;
			// the synced catalog in place of this one names its series and people under other ids, which can't be
			// stored beside this one's names: this one goes first
			if (prefer === 'replace') {
				const emptied = new Catalog();
				emptied.addExclusions(CATALOG.exclusions.entries); // only ever added to
				CATALOG.replaceWith(emptied);
				await persist();
			}
			CATALOG.replaceWith(CatalogRecords.toCatalog(result.records));
			await persist();
			if (CatalogRecords.changes(SAVED, recordsNow()).count)
				throw new Error('what the other devices changed could not be saved here, so nothing was sent');
			if (redrawPage) redrawPage(before);
		}
		const copy = opened ? opened.copy || CatalogRecords.newId() : CatalogRecords.newId();
		if (opened && !result.sent) {
			await DATABASE.keepSyncBase({
				revision: got.revision,
				copy,
				backup: opened.backup,
				at: new Date().toISOString(),
			});
			return {taken: result.taken, sent: false, conflicts: result.conflicts};
		}
		const now = Backup.write(CATALOG);
		const key = opened ? opened.key : await CatalogSync.keyFor(passphrase);
		const body = JSON.stringify({revision: got.revision, data: await CatalogSync.seal(now, key, copy)});
		const res = await fetchFromServer('sync', undefined, {body});
		if (res.status === 409) continue;
		const sent = await syncAnswer(res);
		await DATABASE.keepSyncBase({revision: sent.revision, copy, backup: now, at: new Date().toISOString()});
		return {taken: result.taken, sent: true, conflicts: result.conflicts};
	}
	throw new Error('other devices kept syncing meanwhile; try again');
}

// ------------------------------------------------------------ runs on a catalog's shelves
// Comparing with a catalog's shelves (Hardcover, AudiobookDB), or sending to it, can take minutes, a request or two a second. The
// page running it shows it on top while it goes (#bgTask), and hands each update to the page's onCatalogJob.
const JOB_VERBS: Record<CatalogJob['mode'], (catalog: string) => string> = {
	compare: catalog => `Comparing with ${catalog}`,
	send: catalog => `Updating your ${catalog} shelves`,
};

export const minutes: (ms: number) => string = ms => {
	const s = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Show a Hardcover or AudiobookDB run in the banner on top (#bgTask), and hand it to the page's own onCatalogJob.
 */
export function showCatalogJob(job: CatalogJob | null) {
	const el = document.getElementById('bgTask');
	if (el) {
		el.classList.toggle('show', Boolean(job && job.running));
		if (!job || !job.running) fillElement(el);
		else {
			const counted = typeof job.total === 'number' && Number.isInteger(job.total) && job.total > 0;
			fillElement(
				el,
				buildElement('span', {class: 'spinner', 'aria-hidden': 'true'}),
				buildElement(
					'div',
					{class: 'bgTaskText'},
					buildElement('strong', {}, JOB_VERBS[job.mode](job.catalog)),
					' ',
					buildElement('span', {class: 'bgTaskTime'}, minutes(job.elapsed)),
					buildElement('br'),
					job.step || '',
					counted && [
						`: ${job.done} of ${job.total} `,
						buildElement('progress', {max: job.total, value: job.done}),
					],
					!job.dryRun && [
						buildElement('br'),
						buildElement(
							'small',
							{},
							spell(
								"Please don't edit the catalog until it is done: an edit saved meanwhile stops it before anything is written.",
							),
						),
					],
				),
			);
		}
	}
	if (onCatalogJob) onCatalogJob(job);
}

/**
 * Open the catalog kept in this browser (empty the first time), then let the page draw itself with
 * `init`, which loads what it shows (loadRecords, queryCatalog); with `page.whole` CATALOG holds the whole
 * catalog before. `page.refresh(before)` draws it again after a save took in another tab's changes
 * (`before` are the books the page had, as their places in CATALOG.books may have changed); it and
 * `page.onCatalogJob` (see showCatalogJob) are optional.
 */
export async function startPage(
	init: () => void | Promise<void>,
	page: {whole?: boolean; refresh?: (before: Book[]) => void; onCatalogJob?: (job: CatalogJob | null) => void} = {},
) {
	({onCatalogJob = null, refresh: redrawPage = null} = page);
	await loadCatalog(!!page.whole);
	CATALOG.assignIds(); // the page knows every entry by its id (a catalog that can't be saved has none yet)
	askToKeepStorage();
	await init();
	updateNav();
	if (STARTUP_NOTICE) showIoStatus(STARTUP_NOTICE, true);
}

// Installable as an app (on a phone, say), and usable offline once it is: see sw.js.
try {
	navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).catch(() => {});
} catch {
	/* no offline use in this browser */
}
