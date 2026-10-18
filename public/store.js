// What every page shares: the catalog, kept in this browser's IndexedDB and nowhere else, the
// status line and the page links. Each page's own module starts with startPage(), handing it a refresh()
// that redraws the page from CATALOG.
import {Text} from './modules/text.js';
import {Catalog} from './modules/catalog.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {CatalogDatabase, CatalogConflict, MemoryReader} from './modules/catalog-database.js';
/** @import {CatalogReader} from './modules/catalog-database.js' */
/** @import {RecordSet, Snapshot, StoreName} from './modules/catalog-records.js' */
/** @import {Book} from './modules/book.js' */
/** @import {NamedKind} from './modules/catalog.js' */
/** @import {ContributorKind} from './modules/contributor.js' */
import {HardcoverClient} from './modules/hardcover-client.js';
import {ExternalCatalog} from './modules/external-catalog.js';
/** @import {ExternalKind} from './modules/external-catalog.js' */
/** @import {Unchecked} from './modules/text.js' */

/**
 * Comparing with Hardcover, or sending to it, going on (or just ended) in a page, as showHardcoverJob() shows it.
 * @typedef {object} HardcoverJob
 * @property {'compare' | 'send'} mode
 * @property {boolean} dryRun only reading: nothing is written
 * @property {boolean} running
 * @property {number} elapsed milliseconds
 * @property {string} [step] what it is doing
 * @property {number} [done] of `total` steps
 * @property {number} [total]
 * @property {number} [code] how it ended: 0 when all went through
 * @property {string} [out] what it had to say
 * @property {string} [err] what went wrong
 */

// British spelling ("catalogue") when the browser's first English language is a British one, else American.
export const BRITISH = (() => { try{ return Text.prefersBritish(navigator.languages || [navigator.language]); }catch(e){ return false; } })();

/**
 * The page's own text in the spelling this browser prefers (see BRITISH); never a book's title or other data.
 * @param {string} text
 * @returns {string}
 */
export function spell(text){ return Text.spelled(text, BRITISH); }

// Attributes of the page's own elements that hold text a reader sees.
const TEXT_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

/**
 * Respell the text in `node` and below, in place (see spell).
 * @param {Node} node
 */
function respell(node){
	for(const child of node.childNodes){
		if(child.nodeType === Node.TEXT_NODE) child.nodeValue = spell(child.nodeValue || '');
		else if(child.nodeType === Node.ELEMENT_NODE){
			const el = /** @type {Element} */ (child);
			for(const name of TEXT_ATTRIBUTES){
				const value = el.getAttribute(name);
				if(value !== null) el.setAttribute(name, spell(value));
			}
			respell(el);
		}
	}
}

// The page as written is American, so respell it before the page's module finds its elements and
// fills them in; at this point it holds only the page's own text.
if(BRITISH){
	document.title = spell(document.title);
	respell(document.body);
}

/**
 * Something to put in an element: an element, or text (always as text, never read as HTML). Null, undefined,
 * false and '' stand for nothing, so a part shown only sometimes can be `cond && buildElement(...)`; lists are flattened.
 * @typedef {Node | string | number | null | undefined | false | Child[]} Child
 */

/**
 * The nodes and text of `children`, flattened, without the empty ones.
 * @param {Child[]} children
 * @returns {(Node | string)[]}
 */
export function nodes(children){
	/** @type {(Node | string)[]} */
	const out = [];
	for(const c of children){
		if(Array.isArray(c)) out.push(...nodes(c));
		else if(c !== null && c !== undefined && c !== false && c !== '') out.push(typeof c === 'number' ? String(c) : c);
	}
	return out;
}

/**
 * A new element: buildElement('a', {class: 'srow-title', href}, name). Attributes are set as given: null, undefined
 * and false leave one out, true sets it empty (checked); a function under an on... name listens to that
 * event (onclick: fn). The children go in in order (see Child).
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>} [attrs]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function buildElement(tag, attrs = {}, ...children){
	const el = document.createElement(tag);
	for(const [name, value] of Object.entries(attrs)){
		if(typeof value === 'function') el.addEventListener(name.slice(2), value);
		else if(value === true) el.setAttribute(name, '');
		else if(value !== null && value !== undefined && value !== false) el.setAttribute(name, String(value));
	}
	el.append(...nodes(children));
	return el;
}

/**
 * Replace what `el` holds with `children` (see Child).
 * @param {Element} el
 * @param {...Child} children
 */
export function fillElement(el, ...children){ el.replaceChildren(...nodes(children)); }

/**
 * `items` with `separator` between each two, as children for buildElement() or fillElement(): links joined with ', '.
 * @param {Child[]} items
 * @param {string} separator
 * @returns {Child[]}
 */
export function joined(items, separator){ return items.flatMap((x, i)=> i ? [separator, x] : [x]); }

// The addresses of an author's, a narrator's and a publisher's page: by the id they are stored under, so a
// link holds while their name is spelled another way (spaces as +, as the catalog page writes its own addresses).
const hashValue = (/** @type {string} */ v)=> encodeURIComponent(v).replace(/%20/g, '+');
/** @type {Record<ContributorKind, string>} */
const CREDIT_PAGES = {authors: 'authors.html#a=', narrators: 'narrators.html#n=', publishers: 'publishers.html#p='};
/**
 * The address of the page of the author, narrator or publisher stored under `id`.
 * @param {ContributorKind} kind
 * @param {string} id
 * @returns {string}
 */
export const creditPageHref = (kind, id)=> CREDIT_PAGES[kind] + hashValue(id);
/**
 * The address of someone's page, by name: their id when the page holds it, else their name, which their page
 * looks up. Never a new id: a page holding only some of the catalog would make up one no record has.
 * @type {(kind: ContributorKind, name: string) => string}
 */
const namedPageHref = (kind, name)=> creditPageHref(kind, CATALOG.nameIds[kind].get(name) ?? name);
/** @type {(name: string) => string} */
export const authorPageHref = name=> namedPageHref('authors', name);
/** @type {(name: string) => string} */
export const narratorPageHref = name=> namedPageHref('narrators', name);
/** @type {(name: string) => string} */
export const publisherPageHref = name=> namedPageHref('publishers', name);
/**
 * The address that compares a series' or an author's books with Hardcover on the Import & export page.
 * @param {'series' | 'author'} kind
 * @param {string} id the series' or the author's
 * @returns {string}
 */
export const hardcoverCompareHref = (kind, id)=> `import.html#hardcover-${kind}=` + hashValue(id);

/**
 * What an address of one of those pages holds after `key`= (#n=id), or null: the id there, as it is.
 * @param {string} hash
 * @param {string} key
 * @returns {string | null}
 */
export function valueFromPageHash(hash, key){
	const m = new RegExp(`^#${key}=(.*)$`).exec(String(hash || ''));
	if(!m) return null;
	let value = m[1].replace(/\+/g, ' ');
	try{ value = decodeURIComponent(value); }catch(e){}
	return value.trim() || null;
}

/**
 * The id of the series or person an address names: by their id, or by their name (a link from before
 * addresses had ids). Null when it names neither.
 * @param {NamedKind} kind
 * @param {string | null} value
 * @returns {string | null}
 */
export function idFromAddress(kind, value){
	if(value === null) return null;
	if(CATALOG.nameOf(kind, value) !== undefined) return value;
	return CATALOG.nameIds[kind].get(value) ?? null;
}

// The catalog the page shows. It stays this one object: a page that takes another catalog (Restore, an
// import confirmed) moves it in with CATALOG.replaceWith().
export const CATALOG = new Catalog();
/** @type {number | null} */
export let SEEN_REVISION = null;      // the revision of the stored catalog this page last read or wrote; null while none was ever saved

/** @type {CatalogDatabase | null} */
let DATABASE = null;
/** @type {Snapshot} */
let SAVED = new Map();               // the records as this page last read or wrote them, so a save writes only what changed
let SAVE_REFUSED = '';                // why nothing can be saved in this browser, when nothing can
/** @type {Promise<void>} */
let SAVING = Promise.resolve();       // the saves asked for, one after another
/** @type {Promise<void>} */
let COUNTING = Promise.resolve();     // what waits for the saves: the Duplicates link's count, and pages drawn again (afterSaving)
let READING = Promise.resolve();      // the reads pages wait on (see reading())
let STARTUP_NOTICE = '';
// A page holds only what it shows (loadRecords() brings in more), unless it asked for the whole catalog
// (startPage's `whole`, or wholeCatalog()); a page in a browser without IndexedDB holds all of it.
let WHOLE = false;
/** @type {Map<string, number>} */
let POSITIONS = new Map();            // the place among all the books of each book loaded, while not WHOLE

// The page's own hooks, from startPage(): onHardcoverJob(job), when the page has it, does more with each
// update of a Hardcover run (see showHardcoverJob); redrawPage() draws the page again when a save took in
// what another tab changed.
/** @type {((job: HardcoverJob | null) => void) | null} */
let onHardcoverJob = null;
/** @type {((before: Book[]) => void) | null} */
let redrawPage = null;

/** @returns {Promise<number | null>} the revision of the catalog as it is stored now (another tab may have saved since) */
export async function storedRevision(){
	try{ return DATABASE ? await DATABASE.revision() : null; }catch(e){ return null; }
}

/** @returns {Promise<void>} when the saves asked for so far are done, and the Duplicates link counted after them */
export function whenSaved(){ return Promise.all([SAVING, COUNTING, READING]).then(() => {}); }

/**
 * Note a read the page waits on (loadRecords and the like), so whenSaved() waits for it too.
 * @template T
 * @param {Promise<T>} read
 * @returns {Promise<T>}
 */
function reading(read){
	READING = Promise.all([READING, read.catch(() => {})]).then(() => {});
	return read;
}

/**
 * How many duplicate groups and books with split editions a catalog has, as the Duplicates link counts them.
 * @param {Catalog} catalog
 * @returns {number}
 */
function duplicateCount(catalog){
	const duplicates = catalog.duplicates();
	return duplicates.groups().length + duplicates.splitEditions().length;
}

/** @param {number | null} n how many, or null while that isn't known */
function showDuplicateCount(n){ byId('dupCount').textContent = n ? ` (${n})` : ''; }

// The page links: the duplicates link says how many duplicates and books with split editions there are.
// That takes every book, so a page that holds only some shows the count kept with the revision it was
// counted at; when the catalog changed since, it counts again after the page is drawn, reading every
// book but keeping none, and keeps the count for the next page.
export function updateNav(){
	if(WHOLE){ showDuplicateCount(duplicateCount(CATALOG)); return; }
	COUNTING = COUNTING.then(() => SAVING).then(countDuplicates).catch(() => {});
}

/**
 * Do `task` once the saves asked for so far are done (a page draws again from what is stored, say);
 * whenSaved() waits for it too. A task that fails says so on the status line.
 * @param {() => Promise<void> | void} task
 * @returns {Promise<void>}
 */
export function afterSaving(task){
	const run = COUNTING.then(() => SAVING).then(task).catch(e => showIoStatus(spell(`Couldn't read the catalog kept in this browser: ${Text.errorText(e)}. Reload the page.`), true));
	COUNTING = run;
	return run;
}

async function countDuplicates(){
	if(!DATABASE) return;
	const [kept, revision] = await Promise.all([DATABASE.duplicateCount(), DATABASE.revision()]);
	if(revision === null){ showDuplicateCount(0); return; }
	if(kept && kept.revision === revision){ showDuplicateCount(kept.count); return; }
	showDuplicateCount(null);
	const stored = await DATABASE.load();
	if(!stored) return;
	const n = duplicateCount(CatalogRecords.toCatalog(stored.records));
	showDuplicateCount(n);
	await DATABASE.keepDuplicateCount(stored.revision, n);
}

/**
 * Each book's place among all of them, for the records of a page that holds only some: as it was loaded,
 * or NEW_POSITION for one it added (the save puts it after the others).
 * @type {(b: Book, index: number) => number}
 */
const positionOf = (b, index) => WHOLE ? index : POSITIONS.get(/** @type {string} */ (b.id)) ?? CatalogRecords.NEW_POSITION;

/** @returns {RecordSet} the records of what the page holds now */
const recordsNow = () => CatalogRecords.fromCatalog(CATALOG, undefined, WHOLE ? undefined : positionOf);

/**
 * Whether the page loaded (or saved) the record under `key`.
 * @param {StoreName} store
 * @param {IDBValidKey} key
 * @returns {boolean}
 */
const loaded = (store, key) => !!(SAVED.get(store) || new Map()).has(JSON.stringify(key));

/**
 * What a page asks loadRecords() for: books by id, every book of some series (by id, or by name), the books
 * with an edition an external id names ("asin B0…", as Edition.idKeys() has it, or "isbn 978…"), and series
 * and people by id (their records, whether or not any book loaded names them).
 * @typedef {object} Wanted
 * @property {string[]} [books]
 * @property {string[]} [seriesBooks]
 * @property {string[]} [seriesNamed]
 * @property {string[]} [editionKeys]
 * @property {string[]} [series]
 * @property {string[]} [contributors]
 */

/**
 * The records `want` names that the page lacks (`has` says what it holds), with what they need to make
 * books: their editions, the other books of those editions (a box set's titles, which a card names, and
 * which an edit of the edition changes too), and the series and people they all name.
 * @param {CatalogReader} r
 * @param {Wanted} want
 * @param {(store: StoreName, key: IDBValidKey) => boolean} has
 * @returns {Promise<RecordSet>}
 */
async function readWanted(r, want, has){
	const bookIds = new Set(want.books || []);
	const seriesBooks = [...want.seriesBooks || []];
	for(const name of want.seriesNamed || []) for(const rec of await r.all('series', 'name', name)) seriesBooks.push(rec.id);
	for(const key of want.editionKeys || []) for(const ed of await r.all('editions', 'idKeys', key)) for(const id of ed.bookIds) bookIds.add(id);
	for(const id of seriesBooks) for(const key of await r.allKeys('books', 'bySeries', r.keyRange.bound([id], [id, []]))) bookIds.add(/** @type {string} */ (key));
	/** @type {(store: StoreName, ids: Iterable<string>) => string[]} */
	const lacking = (store, ids) => [...new Set(ids)].filter(id => !has(store, id));
	/** @type {import('./modules/catalog-records.js').BookRecord[]} */
	const books = await r.get('books', lacking('books', bookIds));
	/** @type {import('./modules/catalog-records.js').EditionRecord[]} */
	const editions = await r.get('editions', lacking('editions', books.flatMap(b => b.editionIds)));
	const others = await r.get('books', lacking('books', editions.flatMap(ed => ed.bookIds)).filter(id => !bookIds.has(id)));
	const seen = new Set(editions.map(ed => ed.id));
	editions.push(...await r.get('editions', lacking('editions', others.flatMap(b => b.editionIds)).filter(id => !seen.has(id))));
	books.push(...others);
	const series = lacking('series', [...books.map(b => b.seriesId).filter(x => x !== undefined), ...seriesBooks, ...want.series || []]);
	const people = lacking('contributors', [...books.flatMap(b => b.authorIds), ...editions.flatMap(ed => [...ed.narratorIds, ...ed.publisherId ? [ed.publisherId] : []]),
		...want.contributors || []]);
	return {books, editions, series: await r.get('series', series), contributors: await r.get('contributors', people), credits: [], marks: [], exclusions: []};
}

/**
 * Take records read from the database into CATALOG, next to what the page holds; a record it holds
 * already stays as the page has it.
 * @param {RecordSet} records
 */
function takeIn(records){
	const now = recordsNow();
	/** @type {Record<string, any[]>} */
	const combined = {};
	for(const store of CatalogRecords.STORE_NAMES){
		const mine = /** @type {Record<string, any>[]} */ (now[store]);
		const keys = new Set(mine.map(rec => JSON.stringify(CatalogRecords.keyOf(store, rec))));
		const fresh = /** @type {Record<string, any>[]} */ (records[store]).filter(rec => !keys.has(JSON.stringify(CatalogRecords.keyOf(store, rec))));
		combined[store] = [...mine, ...fresh];
		if(!CatalogRecords.DERIVED[store]) continue;
		if(!SAVED.has(store)) SAVED.set(store, new Map());
		const saved = /** @type {Map<string, string>} */ (SAVED.get(store));
		for(const rec of fresh) saved.set(JSON.stringify(CatalogRecords.keyOf(store, rec)), CatalogRecords.ownText(store, rec));
	}
	for(const b of records.books) if(!POSITIONS.has(b.id)) POSITIONS.set(b.id, b.position);
	CATALOG.replaceWith(CatalogRecords.toCatalog(/** @type {RecordSet} */ (/** @type {unknown} */ (combined))));
	CATALOG.assignIds();
}

/**
 * Bring what `want` names into CATALOG (see Wanted), once the saves asked for are done. The page holds
 * everything already when it is WHOLE. Throws when the records can't be read.
 * @param {Wanted} want
 * @returns {Promise<void>}
 */
export function loadRecords(want){
	return reading((async () => {
		if(WHOLE || !DATABASE) return;
		await SAVING;
		const db = DATABASE;
		const {result} = await db.read(r => readWanted(r, want, loaded));
		takeIn(result);
	})());
}

/**
 * Ask the stored catalog something (`ask` reads it with a CatalogReader), once the saves asked for are
 * done; when the page holds all of it (and in a browser without IndexedDB), the catalog the page holds.
 * @template T
 * @param {(reader: CatalogReader) => Promise<T>} ask
 * @returns {Promise<T>}
 */
export function queryCatalog(ask){
	return reading((async () => {
		await SAVING;
		if(DATABASE && !WHOLE) return (await DATABASE.read(ask)).result;
		return ask(/** @type {CatalogReader} */ (/** @type {unknown} */ (new MemoryReader(recordsNow()))));
	})());
}

/**
 * Hold the whole catalog from now on (an import, Check or Export needs every book), once the saves asked for are done.
 * @returns {Promise<void>}
 */
export function wholeCatalog(){
	return reading(loadWhole());
}

async function loadWhole(){
	if(WHOLE || !DATABASE) return;
	await SAVING;
	const stored = await DATABASE.load();
	CATALOG.replaceWith(stored ? CatalogRecords.toCatalog(stored.records) : new Catalog());
	CATALOG.assignIds();
	SAVED = stored ? CatalogRecords.snapshot(stored.records) : new Map();
	if(stored) SEEN_REVISION = stored.revision;
	POSITIONS = new Map();
	WHOLE = true;
}

/**
 * Before a page that holds only some of the catalog saves: a series or person it names that it holds no
 * record of (a name typed in a form) may be stored already, under an id of its own. Use that id, and the
 * record's info, so the save adds no second one.
 * @returns {Promise<void>}
 */
async function takeInNamesTyped(){
	if(WHOLE || !DATABASE) return;
	/** @type {{kind: import('./modules/catalog.js').NamedKind, name: string}[]} */
	const ask = [];
	for(const kind of Catalog.NAMED_KINDS){
		const store = kind === 'series' ? 'series' : 'contributors';
		for(const name of CATALOG.namesOf(kind)){
			const id = CATALOG.nameIds[kind].get(name);
			if(id === undefined || !loaded(store, id)) ask.push({kind, name});
		}
	}
	if(!ask.length) return;
	/** @type {Record<string, string>} */
	const one = {authors: 'author', narrators: 'narrator', publishers: 'publisher'};
	const {result} = await DATABASE.read(r => Promise.all(ask.map(({kind, name}) => kind === 'series' ? r.all('series', 'name', name) : r.all('contributors', 'kindName', [one[kind], name]))));
	result.forEach((found, i) => {
		const rec = found[0];
		if(!rec) return;
		const {kind, name} = ask[i], store = kind === 'series' ? 'series' : 'contributors';
		const info = CATALOG.infoMap(kind), had = CATALOG.nameIds[kind].get(name);
		const typed = had === undefined ? undefined : info.get(had);
		if(had !== undefined) info.delete(had);
		CATALOG.nameIds[kind].set(name, rec.id);
		const stored = CatalogRecords.toCatalog({books: [], editions: [], series: store === 'series' ? [rec] : [], contributors: store === 'contributors' ? [rec] : [],
			credits: [], marks: [], exclusions: []}).infoMap(kind).get(rec.id);
		const entry = typed || stored;
		if(entry) info.set(rec.id, entry);
		if(!SAVED.has(store)) SAVED.set(store, new Map());
		/** @type {Map<string, string>} */ (SAVED.get(store)).set(JSON.stringify(rec.id), CatalogRecords.ownText(store, rec));
	});
}

/**
 * Keep the catalog as the page holds it now. Saves are made one after another, and each writes only the
 * records that changed. When another page or tab saved meanwhile, what it changed is taken in first
 * (catchUp), so edits of different entries in different tabs all stay; when both changed the same entry,
 * nothing is saved. Pages need not wait for it; it says on the status line when a save fails.
 * @returns {Promise<void>}
 */
export function persist(){
	CATALOG.assignIds();   // a book or name just added has its id before the page draws it again
	SAVING = SAVING.then(saveNow);
	updateNav();
	return SAVING;
}

async function saveNow(){
	if(!DATABASE){ showIoStatus(SAVE_REFUSED, true); return; }
	const unstorable = CatalogRecords.unstorable(CATALOG);
	if(unstorable.length){
		showIoStatus(spell(`Not saved: these values can't be kept, as they aren't what their field holds: ${unstorable.slice(0, 3).join('; ')}` +
			`${unstorable.length > 3 ? ` and ${unstorable.length - 3} more` : ''}. Export a backup, fix them there (Check lists them) and Restore it.`), true);
		return;
	}
	// another tab may save again while this page takes in its last save, so this page tries a few times
	for(let tries = 1; ; tries++){
		try{
			await takeInNamesTyped();
		}catch(e){
			showIoStatus(spell('Not saved: the catalog kept in this browser could not be read. Reload the page.'), true);
			return;
		}
		const records = recordsNow();
		const changes = CatalogRecords.changes(SAVED, records);
		if(!changes.count && SEEN_REVISION !== null) return;
		try{
			const first = SEEN_REVISION === null;
			const saved = await DATABASE.save(changes, SEEN_REVISION);
			SEEN_REVISION = saved.revision;
			SAVED = changes.snapshot;
			// the books added have their place among all of them now
			for(const rec of records.books){
				const position = saved.positions.get(rec.id);
				if(position === undefined) continue;
				POSITIONS.set(rec.id, position);
				/** @type {Map<string, string>} */ (SAVED.get('books')).set(JSON.stringify(rec.id), CatalogRecords.ownText('books', {...rec, position}));
			}
			if(first) setAsideOldCatalog();
			if(WHOLE) await DATABASE.keepDuplicateCount(saved.revision, duplicateCount(CATALOG)).catch(() => {});
			return;
		}catch(e){
			if(!(e instanceof CatalogConflict)){
				// nothing else holds this catalog, so say so instead of losing the edit quietly
				showIoStatus(spell('Not saved: this browser refused to store the catalog (is its storage full?). Export a backup.'), true);
				return;
			}
			const both = tries < 3 ? await catchUp() : [];
			if(both){
				showIoStatus(spell(both.length
					? `Not saved: ${both.slice(0, 3).join(', ')}${both.length > 3 ? ` and ${both.length - 3} more` : ''} changed in another tab too. Reload this page to see that, then make this change again.`
					: 'The catalog was changed in another tab. Reload this page to see that; this change was not saved.'), true);
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
 * @returns {Promise<string[] | null>}
 */
async function catchUp(){
	// a page that never read a stored catalog (its first save moves the one localStorage kept) has nothing to go by
	if(!DATABASE || SEEN_REVISION === null) return [];
	/** @type {Book[]} */
	let before;
	try{
		// a page that holds only some of the catalog reads only what it holds, as it is stored now
		/** @type {(store: StoreName) => string[]} */
		const keys = store => [...(SAVED.get(store) || new Map()).keys()].map(key => JSON.parse(key));
		const db = DATABASE;
		const stored = WHOLE ? await db.load()
			: await db.read(r => readWanted(r, {books: keys('books'), series: keys('series'), contributors: keys('contributors')}, () => false))
				.then(({result, revision}) => revision === null ? null : {records: result, revision});
		if(!stored) return [];
		const {records, conflicts} = CatalogRecords.merge(SAVED, recordsNow(), stored.records, WHOLE);
		if(conflicts.length) return conflicts;
		before = CATALOG.books;
		CATALOG.replaceWith(CatalogRecords.toCatalog(records));
		CATALOG.assignIds();
		SAVED = CatalogRecords.snapshot(stored.records);
		SEEN_REVISION = stored.revision;
		if(!WHOLE) for(const b of stored.records.books) POSITIONS.set(b.id, b.position);
	}catch(e){
		return [];
	}
	if(redrawPage) redrawPage(before);
	updateNav();
	return null;
}

/**
 * Add entries (an ASIN, "ISBN 978...", "Goodreads 12345" or "Title | Author") to the books imports skip; returns how many were new.
 * @param {string[]} entries
 * @returns {number}
 */
export function addExclusions(entries){
	return CATALOG.addExclusions(entries);
}

// Ask the browser not to clear this site's storage when space runs low; on a phone it may otherwise.
function askToKeepStorage(){
	try{ navigator.storage.persist().catch(()=>{}); }catch(e){}
}

// Load the catalog kept in this browser (all of it with `whole`; otherwise the page loads what it shows
// itself, with loadRecords()); with none, it starts empty. One that can't be read is set aside (under
// meta's `unreadable`), not overwritten by the next edit. When nothing was saved yet, the catalog
// localStorage kept before is moved over; records from an older version of the app are saved again in
// the current shape.
/** @param {boolean} whole */
async function loadCatalog(whole){
	try{
		DATABASE = await CatalogDatabase.open(indexedDB);
	}catch(e){
		SAVE_REFUSED = spell("Not saved: this browser won't keep the catalog for this page (it has no IndexedDB here). Export a backup before you leave.");
		STARTUP_NOTICE = SAVE_REFUSED;
		WHOLE = true;
		readOldCatalog();
		return;
	}
	/** @type {{records: RecordSet, revision: number} | null} */
	let stored = null;
	try{
		const revision = await DATABASE.revision();
		if(revision === null){
			// a catalog from before it lived in IndexedDB is saved there at once (and is in the current format then)
			WHOLE = true;
			if(readOldCatalog()) await persist();
			// one that can't be saved (persist() said why) stays shown as it is
			if(!whole && await DATABASE.revision() !== null) holdNothing();
			return;
		}
		const reshape = await DATABASE.needsReshape();
		if(!whole && !reshape){ SEEN_REVISION = revision; return; }
		stored = await DATABASE.load();
		if(!stored) return;
		CATALOG.replaceWith(CatalogRecords.toCatalog(stored.records));
		SEEN_REVISION = stored.revision;
		SAVED = CatalogRecords.snapshot(stored.records);
		WHOLE = true;
		if(reshape || CatalogRecords.outdated(stored.records)) await saveAll();
		if(!whole) holdNothing();
	}catch(e){
		try{
			SEEN_REVISION = await DATABASE.setAside(stored ? stored.records : Text.errorText(e));
			SAVED = new Map();
		}catch(err){
			DATABASE = null;
			SAVE_REFUSED = spell("Not saved: the catalog kept in this browser can't be read or set aside. Export a backup.");
		}
		CATALOG.replaceWith(new Catalog());
		WHOLE = whole || !DATABASE;
		STARTUP_NOTICE = spell("Couldn't read the catalog kept in this browser; it was set aside and the catalog starts empty. Restore a backup.");
	}
}

// Save every record again, so each has the derived fields this version of the app reads (the page holds them all).
async function saveAll(){
	const db = /** @type {CatalogDatabase} */ (DATABASE);
	await SAVING;
	const changes = CatalogRecords.changes(new Map(), recordsNow());
	const saved = await db.save(changes, SEEN_REVISION);
	SEEN_REVISION = saved.revision;
	SAVED = changes.snapshot;
}

// After a page that loads only what it shows moved or reshaped the catalog: it holds nothing yet.
function holdNothing(){
	CATALOG.replaceWith(new Catalog());
	SAVED = new Map();
	POSITIONS = new Map();
	WHOLE = false;
}

// localStorage held the catalog before IndexedDB did: under CATALOG_KEY as a backup ({books, seriesInfo, authors, narrators,
// publishers, excluded}; the key is the one the installed app kept its own catalog under), with the "Not duplicates"
// marks under NOT_DUP_KEY, and the edits that waited for `make serve` to save them to data/, from when the catalog still
// lived in files, under OLD_EDITS_KEY ({data, info, authors, excluded}). Once moved, each is kept under its name +
// MOVED_SUFFIX, a copy that is never read again.
const CATALOG_KEY = 'audiobook-catalog-device';
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
const OLD_EDITS_KEY = 'audiobook-catalog-data';
const MOVED_SUFFIX = '.moved-to-indexeddb';

/**
 * Read the catalog localStorage kept into CATALOG; returns whether there was one. One that can't be read
 * is set aside (under CATALOG_KEY + '.unreadable'), and the catalog starts empty.
 * @returns {boolean}
 */
function readOldCatalog(){
	/** @type {(key: string) => string | null} */
	const item = key => { try{ return localStorage.getItem(key); }catch(e){ return null; } };
	try{
		const raw = item(CATALOG_KEY), old = JSON.parse(item(OLD_EDITS_KEY) || 'null');
		/** @type {Unchecked} */
		const saved = raw ? JSON.parse(raw)
			: old && Array.isArray(old.data) ? {books: old.data, seriesInfo: old.info, authors: old.authors, excluded: old.excluded} : null;
		if(!saved) return false;
		const catalog = Catalog.fromJSON(saved);
		const marks = JSON.parse(item(NOT_DUP_KEY) || '[]');
		if(Array.isArray(marks)) catalog.addMarkTexts(marks.filter(x=> typeof x === 'string'));
		CATALOG.replaceWith(catalog);
		return true;
	}catch(e){
		try{ localStorage.setItem(CATALOG_KEY + '.unreadable', item(CATALOG_KEY) || ''); localStorage.removeItem(CATALOG_KEY); }catch(err){}
		STARTUP_NOTICE = spell("Couldn't read the catalog kept in this browser; it was set aside and the catalog starts empty. Restore a backup.");
		return false;
	}
}

// Once IndexedDB holds the catalog, what localStorage kept is renamed, so it is never read again but not lost.
function setAsideOldCatalog(){
	for(const key of [CATALOG_KEY, NOT_DUP_KEY, OLD_EDITS_KEY]){
		try{
			const value = localStorage.getItem(key);
			if(value === null) continue;
			localStorage.setItem(key + MOVED_SUFFIX, value);
			localStorage.removeItem(key);
		}catch(e){}
	}
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let ioStatusTimer;

/** How long the status line shows a message, and so how long its Undo can be pressed. */
export const STATUS_TIME = 5000;

/**
 * Say something on the status line for a few seconds; `isErr` shows it as an error. With `undo`, the line
 * has an Undo button that runs it and clears the line.
 * @param {string} msg
 * @param {boolean} [isErr]
 * @param {() => void} [undo]
 */
export function showIoStatus(msg, isErr, undo){
	const el = byId('ioStatus');
	const clear = ()=>{ clearTimeout(ioStatusTimer); fillElement(el); };
	fillElement(el, msg, undo && [' ', buildElement('button', {type: 'button', class: 'undo', onclick: ()=>{ clear(); undo(); }}, 'Undo')]);
	el.classList.toggle('err', !!isErr);
	clearTimeout(ioStatusTimer);
	ioStatusTimer = setTimeout(clear, STATUS_TIME);
}

/**
 * The page's element with this id. Throws when there is none, which is a mistake in the page.
 * @param {string} id
 * @returns {HTMLElement}
 */
export function byId(id){
	const el = document.getElementById(id);
	if(!el) throw new Error(`the page has no #${id}`);
	return el;
}

/** @typedef {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} FormField */

/**
 * The page's form field (an <input>, <select> or <textarea>) with this id, for its value; byId() for anything else.
 * @param {string} id
 * @returns {FormField}
 */
export function fieldById(id){
	return /** @type {FormField} */ (byId(id));
}

// ------------------------------------------------------------ external ids in forms and on pages
// A form has a field per group of external catalogs (Audible, Amazon, Goodreads, Hardcover) that has pages
// for what the form edits; each takes an id or the address of the page there, and the catalog keeps the id.

/**
 * The fields for the external ids of a kind of thing, each a <div> with a label and an input whose id is
 * `prefix` and the group ("sf_ext_goodreads"); `except` leaves groups out (a field of their own elsewhere).
 * @param {string} prefix
 * @param {ExternalKind} kind
 * @param {string[]} [except]
 * @returns {HTMLDivElement[]}
 */
export function externalFields(prefix, kind, except = []){
	return ExternalCatalog.groupsFor(kind).filter(g=> !except.includes(g.key)).map(g=>{
		const sites = ExternalCatalog.forKind(kind).filter(def=> def.group === g.key);
		const example = sites.length > 1 ? g.default : /** @type {string} */ ((ExternalCatalog.url(sites[0].key, kind, 'x') || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]);
		// Hardcover's address of a series or person is looked up for its number as soon as the field is left
		const lookup = g.key === 'hardcover' && kind !== 'book' && kind !== 'edition'
			? {onchange: async ()=> { const found = await lookupHardcoverField(prefix, kind); if(found && found.note) showIoStatus(found.note); }} : {};
		return buildElement('div', {}, buildElement('label', {for: prefix + g.key}, g.name),
			buildElement('input', {id: prefix + g.key, 'data-group': g.key, placeholder: `id, or its address on ${example}`, ...lookup}));
	});
}

/**
 * Put an entry's external ids in the fields externalFields() made.
 * @param {string} prefix
 * @param {ExternalKind} kind
 * @param {Record<string, string>} ids
 */
export function fillExternalFields(prefix, kind, ids){
	for(const g of ExternalCatalog.groupsFor(kind)){
		const field = document.getElementById(prefix + g.key);
		if(field) /** @type {HTMLInputElement} */ (field).value = ExternalCatalog.fieldText(ids, kind, g.key);
	}
}

/**
 * The external ids in the fields externalFields() made, as {ids, bad (the fields that hold neither an id nor
 * an address there, as "Goodreads: text")}. The ids an entry has in catalogs no field stands for are kept.
 * @param {string} prefix
 * @param {ExternalKind} kind
 * @param {Record<string, string>} [had] the entry's ids before
 * @returns {{ids: Record<string, string>, bad: string[]}}
 */
export function readExternalFields(prefix, kind, had = {}){
	const groups = ExternalCatalog.groupsFor(kind).filter(g=> document.getElementById(prefix + g.key));
	const shown = new Set(groups.map(g=> g.key));
	/** @type {Record<string, string>} */
	const ids = Object.fromEntries(Object.entries(had).filter(([key])=> { const g = ExternalCatalog.groupOf(key); return !g || !shown.has(g.key); }));
	/** @type {string[]} */
	const bad = [];
	for(const g of groups){
		const text = Text.tidy(fieldById(prefix + g.key).value);
		if(!text) continue;
		const found = ExternalCatalog.readId(text, kind, g.key);
		if(found) ids[found.catalog] = found.id; else bad.push(`${g.name}: ${text}`);
	}
	return {ids, bad};
}

/**
 * Links to an entry's pages in external catalogs ("Goodreads ↗"), one per id; an Audible or Amazon site
 * other than the group's usual one says which ("Audible (audible.co.uk) ↗").
 * @param {Record<string, string>} ids
 * @param {ExternalKind} kind
 * @param {string} [cls] the links' class
 * @returns {HTMLAnchorElement[]}
 */
export function externalLinks(ids, kind, cls = 'authorlink'){
	return Object.entries(ExternalCatalog.order(ids) || {}).flatMap(([key, id])=>{
		const url = ExternalCatalog.url(key, kind, id), g = ExternalCatalog.groupOf(key);
		if(!url) return [];
		const name = g ? (g.default === key ? g.name : `${g.name} (${key})`) : ExternalCatalog.name(key);
		return [buildElement('a', {class: cls, href: url, target: '_blank', rel: 'noopener'}, `${name} \u2197`)];
	});
}

// ------------------------------------------------------------ Hardcover from the page
// The page asks Hardcover itself (its API allows browser requests), with a token kept in this browser
// only (never in a backup), saved on Import & export.
export const HARDCOVER_TOKEN_KEY = 'audiobook-catalog-hardcover-token';
const HARDCOVER_PAUSE_MS = 1000;   // Hardcover allows 60 requests a minute

/** @returns {string} the Hardcover token saved in this browser, or '' */
export function browserHardcoverToken(){
	try{ return HardcoverClient.cleanToken(localStorage.getItem(HARDCOVER_TOKEN_KEY)); }catch(e){ return ''; }
}

/**
 * Asks Hardcover from this page, saying plainly when the browser can't reach it at all.
 * @param {string} url
 * @param {RequestInit} opts
 * @returns {Promise<Response>}
 */
async function fetchHardcover(url, opts){
	try{ return await fetch(url, opts); }
	catch(e){ throw new Error('this browser could not reach Hardcover (offline, or Hardcover refused a request from a web page)'); }
}

/**
 * A Hardcover client asking from this page, with `token`.
 * @param {string} token
 * @returns {HardcoverClient}
 */
export function hardcoverClient(token){
	const pause = () => new Promise(done => setTimeout(done, HARDCOVER_PAUSE_MS));
	return new HardcoverClient(token, fetchHardcover, pause);
}

/**
 * The Hardcover book that `text` names: its id, or the address of the book's or one of its editions'
 * pages on hardcover.app (HardcoverClient.bookId), as {id, title}. An address without the book's id
 * is looked up on Hardcover with the token saved in this browser. Throws with a short reason.
 * @param {string} text
 * @returns {Promise<{id: string, title?: string}>}
 */
export async function lookupHardcoverBook(text){
	const url = HardcoverClient.parseUrl(text);
	if(!url || url.book) return HardcoverClient.bookId(null, text);
	const token = browserHardcoverToken();
	if(!token) throw new Error('to look it up on Hardcover, save your Hardcover API token on the Import & export page first');
	return HardcoverClient.bookId(hardcoverClient(token), text);
}

/** @typedef {{error: string, note: string}} HardcoverFieldLookup why the field can't be saved, or what to say about it */
/** @typedef {Promise<HardcoverFieldLookup> & {text?: string}} HardcoverFieldLookupOnItsWay */
/** @type {WeakMap<Element, HardcoverFieldLookupOnItsWay>} each field's lookup on its way, so a Save waits for it */
const HARDCOVER_FIELD_LOOKUPS = new WeakMap();

/**
 * Hardcover keeps a series, author, narrator or publisher by its number, which its links by id keep working
 * with when it is renamed, but its pages' addresses (what gets pasted) have a name in them. When the Hardcover
 * field externalFields() made holds such an address (or the name alone), this asks Hardcover for the number
 * (with the token saved in this browser) and puts it in the field. When Hardcover can't be asked (no token,
 * offline, refused), the name is kept: its page's address still works until Hardcover renames it.
 * Resolves to {error} when Hardcover has no such page, else {note} (what was found, or why the name was kept);
 * null when there is nothing to look up (a number, or nothing), so a form can save at once.
 * @param {string} prefix
 * @param {'series' | 'author' | 'narrator' | 'publisher'} kind
 * @returns {Promise<HardcoverFieldLookup> | null}
 */
export function lookupHardcoverField(prefix, kind){
	const field = document.getElementById(prefix + 'hardcover');
	const text = field ? Text.tidy(/** @type {HTMLInputElement} */ (field).value) : '';
	const found = text ? ExternalCatalog.readId(text, kind, 'hardcover') : null;
	if(!field || !found || !ExternalCatalog.isFallbackId('hardcover', kind, found.id)) return null;
	const onItsWay = HARDCOVER_FIELD_LOOKUPS.get(field);
	if(onItsWay && onItsWay.text === text) return onItsWay;
	const slug = found.id, address = ExternalCatalog.url('hardcover', kind, slug);
	const kept = (/** @type {string} */ why)=> ({error: '', note: `Kept Hardcover's ${kind} by the name in its address, as ${why}.`});
	/** @type {HardcoverFieldLookupOnItsWay} */
	const lookup = (async ()=>{
		const token = browserHardcoverToken();
		if(!token) return kept('no Hardcover API token is saved on the Import & export page to look up its number');
		/** @type {{id: string, name: string} | null} */
		let row;
		try{ row = await HardcoverClient.idBySlug(hardcoverClient(token), kind, slug); }
		catch(err){ return kept(`Hardcover couldn't be asked for its number (${Text.errorText(err)})`); }
		if(!row) return {error: `Hardcover has no ${kind} at ${address}.`, note: ''};
		if(Text.tidy(/** @type {HTMLInputElement} */ (field).value) === text) /** @type {HTMLInputElement} */ (field).value = row.id;
		return {error: '', note: `Found on Hardcover: ${row.name || slug} (${kind} ${row.id}).`};
	})();
	lookup.text = text;
	HARDCOVER_FIELD_LOOKUPS.set(field, lookup);
	lookup.finally(()=>{ if(HARDCOVER_FIELD_LOOKUPS.get(field) === lookup) HARDCOVER_FIELD_LOOKUPS.delete(field); });
	return lookup;
}

// ------------------------------------------------------------ Hardcover runs
// Comparing with Hardcover, or sending to it, can take minutes, one request a second. The page running it
// shows it on top while it goes (#bgTask), and hands each update to the page's onHardcoverJob.
/** @type {Record<string, string>} */
const HARDCOVER_VERBS = {compare: 'Comparing with Hardcover', send: 'Updating your Hardcover shelves'};

/** @type {(ms: number) => string} */
export const minutes = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * Show a Hardcover run in the banner on top (#bgTask), and hand it to the page's own onHardcoverJob.
 * @param {HardcoverJob | null} job
 */
export function showHardcoverJob(job){
	const el = document.getElementById('bgTask');
	if(el){
		el.classList.toggle('show', Boolean(job && job.running));
		if(!job || !job.running) fillElement(el);
		else {
			const counted = typeof job.total === 'number' && Number.isInteger(job.total) && job.total > 0;
			fillElement(el, buildElement('span', {class: 'spinner', 'aria-hidden': 'true'}), buildElement('div', {class: 'bgTaskText'},
				buildElement('strong', {}, HARDCOVER_VERBS[job.mode] || 'Working with Hardcover'),
				' ', buildElement('span', {class: 'bgTaskTime'}, minutes(job.elapsed)), buildElement('br'), job.step || '',
				counted && [`: ${job.done} of ${job.total} `, buildElement('progress', {max: job.total, value: job.done})],
				!job.dryRun && [buildElement('br'), buildElement('small', {}, spell('Please don\'t edit the catalog until it is done: an edit saved meanwhile stops it before anything is written.'))]));
		}
	}
	if(onHardcoverJob) onHardcoverJob(job);
}

/**
 * Open the catalog kept in this browser (empty the first time), then let the page draw itself with
 * `init`, which loads what it shows (loadRecords, queryCatalog); with `page.whole` CATALOG holds the whole
 * catalog before. `page.refresh(before)` draws it again after a save took in another tab's changes
 * (`before` are the books the page had, as their places in CATALOG.books may have changed); it and
 * `page.onHardcoverJob` (see showHardcoverJob) are optional.
 * @param {() => void | Promise<void>} init
 * @param {{whole?: boolean, refresh?: (before: Book[]) => void, onHardcoverJob?: (job: HardcoverJob | null) => void}} [page]
 */
export async function startPage(init, page = {}){
	({onHardcoverJob = null, refresh: redrawPage = null} = page);
	await loadCatalog(!!page.whole);
	CATALOG.assignIds();   // the page knows every entry by its id (a catalog that can't be saved has none yet)
	askToKeepStorage();
	await init();
	updateNav();
	if(STARTUP_NOTICE) showIoStatus(STARTUP_NOTICE, true);
}

// Installable as an app (on a phone, say), and usable offline once it is: see sw.js.
try{ navigator.serviceWorker.register('sw.js').catch(()=>{}); }catch(e){}
