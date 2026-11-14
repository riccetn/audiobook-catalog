// What every page shares: the catalog, kept in this browser's IndexedDB and nowhere else, the page links, the
// last backup, syncing devices and the banner of a catalog's run. (Drawing and the status line are dom.ts's, the id
// fields id-fields.ts's, your keys and server connections.ts's.) Each page's own module starts with startPage(), handing it a refresh()
// that redraws the page from CATALOG.
import {Text} from './modules/text.js';
import {Catalog} from './modules/catalog.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {Contributor} from './modules/contributor.js';
import {CatalogDatabase, CatalogConflict, MemoryReader} from './modules/catalog-database.js';
import type {CatalogReader} from './modules/catalog-database.js';
import type {RecordSet, Snapshot, StoreName, BookRecord, EditionRecord} from './modules/catalog-records.js';
import type {Book} from './modules/book.js';
import type {NamedKind} from './modules/catalog.js';
import type {ContributorKind} from './modules/contributor.js';
import type {Unchecked, Phrase} from './modules/text.js';
import type {SyncPrefer} from './modules/catalog-sync.js';
import {spell, plural, firstThree, buildElement, fillElement, byId, showIoStatus} from './dom.js';
import {fetchFromServer} from './connections.js';

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
	step?: Phrase;
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
/** The Edit page of the series stored under `id` (or the author's books, or the book). */
export const editPageHref: (id: string, kind?: 'series' | 'author' | 'book') => string = (id, kind = 'series') =>
	pageHref('edit.html', `#${kind}=` + hashValue(id));
/** The address of the page of the books in no series. */
export const standalonePageHref = () => pageHref('index.html', '#standalone');

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
let SAVING: Promise<boolean> = Promise.resolve(true); // the saves asked for, one after another
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
	if (days === null) return spell('No backup downloaded in this browser yet.');
	const when = days === 0 ? spell('today') : days === 1 ? spell('yesterday') : spell('{days} days ago', {days});
	return changes
		? spell('Last backup {when}; {changes} saved since.', {when, changes: plural(changes, 'change')})
		: spell('Last backup {when}; nothing changed since.', {when});
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
				spell("Couldn't read the catalog kept in this browser: {error}. Reload the page.", {
					error: Text.errorPhrase(e),
				}),
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
	const books: BookRecord[] = await r.get('books', lacking('books', bookIds));
	const editions: EditionRecord[] = await r.get(
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
		...editions.flatMap(ed => [...ed.narratorIds, ...CatalogRecords.publisherIdsOf(ed)]),
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
	const ask: {kind: NamedKind; name: string}[] = [];
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
 * nothing is saved. Pages need not wait for it; it says on the status line when a save fails. Resolves to
 * whether the catalog was kept, so a page that goes on (sends to a catalog, leaves) can stop instead.
 */
export function persist(): Promise<boolean> {
	CATALOG.assignIds(); // a book or name just added has its id before the page draws it again
	SAVING = SAVING.then(saveNow);
	updateNav();
	return SAVING;
}

async function saveNow(): Promise<boolean> {
	if (!DATABASE) {
		showIoStatus(SAVE_REFUSED, true);
		return false;
	}
	const unstorable = CatalogRecords.unstorable(CATALOG);
	if (unstorable.length) {
		showIoStatus(
			spell(
				"Not saved: these values can't be kept, as they aren't what their field holds: {values}. Export a backup, fix them there (Check lists them) and Restore it.",
				{values: firstThree(unstorable, '; ')},
			),
			true,
		);
		return false;
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
			return false;
		}
		const records = recordsNow();
		const changes = CatalogRecords.changes(SAVED, records);
		if (!changes.count && SEEN_REVISION !== null) return true;
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
			return true;
		} catch (e) {
			if (!(e instanceof CatalogConflict)) {
				// nothing else holds this catalog, so say so instead of losing the edit quietly
				showIoStatus(
					spell(
						'Not saved: this browser refused to store the catalog (is its storage full?). Export a backup.',
					),
					true,
				);
				return false;
			}
			const both = tries < 3 ? await catchUp() : [];
			if (both) {
				showIoStatus(
					both.length
						? spell(
								'Not saved: {entries} changed in another tab too. Reload this page to see that, then make this change again.',
								{entries: firstThree(both)},
							)
						: spell(
								'The catalog was changed in another tab. Reload this page to see that; this change was not saved.',
							),
					true,
				);
				return false;
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
		for (let tries = 1; ; tries++) {
			stored = await DATABASE.load();
			if (!stored) return;
			CATALOG.replaceWith(CatalogRecords.toCatalog(stored.records));
			SEEN_REVISION = stored.revision;
			SAVED = CatalogRecords.snapshot(stored.records);
			WHOLE = true;
			CATALOG.moveSeriesSites();
			if (!((await DATABASE.needsReshape()) || CatalogRecords.outdated(stored.records))) break;
			// Saving them again may fail though they were read: that is no reason to set the catalog aside.
			try {
				await saveAll();
				break;
			} catch (e) {
				// another tab saved meanwhile (most likely it opened with this one, and saved them again too): read what it saved
				const conflict = e instanceof CatalogConflict;
				if (conflict && tries < 3) continue;
				// shown as it was read, all of it; when the browser refused the save, the next one writes every record again
				if (!conflict) SAVED = new Map();
				STARTUP_NOTICE = spell(
					conflict
						? 'The catalog was changed in another tab while this page opened. Reload the page.'
						: "Couldn't update the catalog kept in this browser for this version of the app (is its storage full?). Export a backup.",
				);
				return;
			}
		}
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
	if (res.status === 401) throw new Error(spell('your server refused the key'));
	if (res.status === 501) throw new Error(spell('sync is not set up on your server (see Your server in the docs)'));
	if (res.status === 404) throw new Error(spell('your server is from before sync: deploy it again'));
	if (res.status === 413) throw new Error(spell('the catalog is too big to sync'));
	if (!res.ok) throw new Error(spell('your server answered {status}', {status: res.status}));
	return (await res.json()) as {revision: number; data?: string | null};
}

/**
 * Sync this browser's catalog with the copy on your server: take in what other devices changed since this
 * browser last synced, save it here, and send the result. When both changed one entry, nothing is changed and
 * the outcome names them, unless `prefer` says whose to keep. Throws a plain error (or CatalogSync's
 * WrongPassphrase, UnrelatedCatalogs, or NewerBackup) when it can't.
 */
export async function syncCatalog(prefer?: SyncPrefer): Promise<SyncOutcome> {
	if (!DATABASE) throw new Error(SAVE_REFUSED || spell('this browser keeps no catalog to sync'));
	const passphrase = savedPassphrase();
	if (!passphrase) throw new Error(spell('save a sync passphrase first'));
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
				throw new Error(spell('what the other devices changed could not be saved here, so nothing was sent'));
			if (redrawPage) redrawPage(before);
		}
		const copy = opened ? opened.copy || Catalog.newId() : Catalog.newId();
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
	throw new Error(spell('other devices kept syncing meanwhile; try again'));
}

// ------------------------------------------------------------ runs on a catalog's shelves
// Comparing with a catalog's shelves (Hardcover, AudiobookDB), or sending to it, can take minutes, a request or two a second. The
// page running it shows it on top while it goes (#bgTask), and hands each update to the page's onCatalogJob.
const JOB_VERBS: Record<CatalogJob['mode'], (catalog: string) => string> = {
	compare: catalog => spell('Comparing with {catalog}', {catalog}),
	send: catalog => spell('Updating your {catalog} shelves', {catalog}),
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
					job.step ? spell(job.step) : '',
					counted && [
						spell(': {done} of {total} ', {done: job.done ?? 0, total: job.total ?? 0}),
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
	else showHandedStatus();
}

/** The sessionStorage key of a status line handed to the next page this tab opens (openWithStatus). */
export const STATUS_STORAGE_KEY = 'audiobook-catalog-status';

/**
 * Open `address`, which says `status` in its status line when it starts (as Save on the Edit series page
 * says what it saved on the series' page); a browser that keeps nothing in sessionStorage just opens it.
 */
export function openWithStatus(address: string, status: string) {
	try {
		sessionStorage.setItem(STATUS_STORAGE_KEY, status);
	} catch {
		/* the page opens without it */
	}
	location.assign(address);
}

/** Show the status line the page before handed over (openWithStatus), once. */
function showHandedStatus() {
	let status: string | null = null;
	try {
		status = sessionStorage.getItem(STATUS_STORAGE_KEY);
		sessionStorage.removeItem(STATUS_STORAGE_KEY);
	} catch {
		/* nothing handed over */
	}
	if (status) showIoStatus(status);
}

// Installable as an app (on a phone, say), and usable offline once it is: see sw.js.
try {
	navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).catch(() => {});
} catch {
	/* no offline use in this browser */
}
