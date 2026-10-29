// The catalog's IndexedDB database: a store per kind of record (CatalogRecords.STORES) and `meta`, which
// holds the revision (bumped by every save, so a page can tell another tab saved since it last read) and
// a catalog set aside because it could not be read. The browser's indexedDB is passed in, so the tests
// can pass a fake one.
import {CatalogRecords} from './catalog-records.js';
import {Contributor} from './contributor.js';
import type {BackupJSON} from './backup.js';
/** the synced copy this browser last read or sent (`copy` names it, see CatalogSync.seal) */
export type SyncBase = {revision: number; copy: string; backup: BackupJSON; at: string};
import type {RecordSet, StoreName, Changes} from './catalog-records.js';

/** What a save finds when another tab saved since this page last read or wrote the catalog. */
export class CatalogConflict extends Error {
	constructor() {
		super('the catalog was changed in another tab');
		this.name = 'CatalogConflict';
	}
}

/**
 * The request's result, once it succeeds.
 */
function requested<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/**
 * Resolves when the transaction commits; rejects when it is aborted or fails.
 */
function committed(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error || new Error('the save was abandoned'));
		tx.onerror = () => reject(tx.error);
	});
}

/**
 * Reads in one read-only transaction, so what they return is one revision of the catalog: records by key,
 * a page of an index (keyset paging: the next page starts after the last key shown), an index's distinct
 * keys, and counts. The key ranges come from the browser's IDBKeyRange, which the database was opened with.
 */
export class CatalogReader {
	tx: IDBTransaction;
	keyRange: typeof IDBKeyRange;

	constructor(tx: IDBTransaction, keyRange: typeof IDBKeyRange) {
		this.tx = tx;
		this.keyRange = keyRange;
	}

	/**
	 * The store, or one of its indexes.
	 */
	source(store: string, index?: string): IDBObjectStore | IDBIndex {
		const os = this.tx.objectStore(store);
		return index ? os.index(index) : os;
	}

	/**
	 * The records under these keys, in their order, leaving out keys with none.
	 */
	async get(store: string, keys: IDBValidKey[]): Promise<any[]> {
		const os = this.tx.objectStore(store);
		const found = await Promise.all([...new Set(keys)].map(key => requested(os.get(key))));
		return found.filter(rec => rec !== undefined);
	}

	/**
	 * The records with keys in `query` (a key, an IDBKeyRange, or null for all), in index order, at most `count`.
	 */
	all(
		store: string,
		index: string | undefined,
		query: IDBValidKey | IDBKeyRange | null = null,
		count?: number,
	): Promise<any[]> {
		return requested(this.source(store, index).getAll(query, count));
	}

	/**
	 * The keys of the records with index keys in `query`, in index order, without reading the records.
	 */
	allKeys(
		store: string,
		index: string | undefined,
		query: IDBValidKey | IDBKeyRange | null = null,
	): Promise<IDBValidKey[]> {
		return requested(this.source(store, index).getAllKeys(query));
	}

	/**
	 * Each index key in `query` with the key of its record, as [indexKey, key], in index order, without
	 * reading the records (a search reads the books' search text this way).
	 */
	indexKeys(
		store: string,
		index: string,
		query: IDBValidKey | IDBKeyRange | null = null,
	): Promise<[IDBValidKey, IDBValidKey][]> {
		return new Promise((resolve, reject) => {
			const out: [IDBValidKey, IDBValidKey][] = [];
			const req = this.source(store, index).openKeyCursor(query);
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) {
					resolve(out);
					return;
				}
				out.push([cursor.key, cursor.primaryKey]);
				cursor.continue();
			};
			req.onerror = () => reject(req.error);
		});
	}

	/**
	 * The records whose index key starts with `prefix` (a compound key's first parts), in index order.
	 */
	under(store: string, index: string, prefix: IDBValidKey[], count?: number): Promise<any[]> {
		return this.all(store, index, this.keyRange.bound(prefix, [...prefix, []]), count);
	}

	/**
	 * Up to `count` records after `after` (an index key shown last; null for the first page), in index
	 * order, and below `upper` when given, e.g. the next books of one person (["id-7"] + [[]] as the end).
	 * @param lower where the list starts (when `after` is null)
	 * @param upper where it ends
	 */
	page(
		store: string,
		index: string | undefined,
		after: IDBValidKey | null,
		count: number,
		lower?: IDBValidKey,
		upper?: IDBValidKey,
	): Promise<any[]> {
		const from = after !== null ? after : lower;
		const open = after !== null;
		const range =
			from === undefined
				? upper === undefined
					? null
					: this.keyRange.upperBound(upper, true)
				: upper === undefined
					? this.keyRange.lowerBound(from, open)
					: this.keyRange.bound(from, upper, open, true);
		return this.all(store, index, range, count);
	}

	/**
	 * The distinct keys of an index (a multiEntry index's values: every genre), in order, without reading any record.
	 */
	keys(store: string, index: string): Promise<IDBValidKey[]> {
		return new Promise((resolve, reject) => {
			const out: IDBValidKey[] = [];
			const req = this.source(store, index).openKeyCursor(null, 'nextunique');
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) {
					resolve(out);
					return;
				}
				out.push(cursor.key);
				cursor.continue();
			};
			req.onerror = () => reject(req.error);
		});
	}

	/**
	 * How many records have keys in `query` (all of them with none).
	 */
	count(store: string, index?: string, query: IDBValidKey | IDBKeyRange | null = null): Promise<number> {
		return requested(this.source(store, index).count(query ?? undefined));
	}
}

import type {BookRecord, EditionRecord, SeriesRecord, ContributorRecord, CreditRecord} from './catalog-records.js';

/**
 * Two keys in IndexedDB's order: numbers, then strings, then lists (item by item).
 */
function compareKeys(x: any, y: any): number {
	const rank = (k: any) => (typeof k === 'number' ? 1 : typeof k === 'string' ? 3 : Array.isArray(k) ? 5 : 0);
	if (rank(x) !== rank(y)) return rank(x) - rank(y);
	if (Array.isArray(x)) {
		for (let i = 0; i < Math.min(x.length, y.length); i++) {
			const c = compareKeys(x[i], y[i]);
			if (c) return c;
		}
		return x.length - y.length;
	}
	return x < y ? -1 : x > y ? 1 : 0;
}

/** A key range as MemoryReader takes one (IDBKeyRange's fields). */
class MemoryRange {
	constructor(lower: any, upper: any, lowerOpen: boolean, upperOpen: boolean) {
		Object.assign(this, {lower, upper, lowerOpen, upperOpen});
	}
	static lowerBound(key: any, open: boolean = false) {
		return new MemoryRange(key, undefined, open, true);
	}
	static upperBound(key: any, open: boolean = false) {
		return new MemoryRange(undefined, key, true, open);
	}
	static bound(lower: any, upper: any, lowerOpen: boolean = false, upperOpen: boolean = false) {
		return new MemoryRange(lower, upper, lowerOpen, upperOpen);
	}
	static only(key: any) {
		return new MemoryRange(key, key, false, false);
	}
}

/**
 * The reads of a CatalogReader over records held in memory, for a browser that keeps no IndexedDB: the
 * page then holds the whole catalog, and asks it what it would ask the database.
 */
export class MemoryReader {
	records: RecordSet;
	keyRange: typeof IDBKeyRange;

	constructor(records: RecordSet) {
		this.records = records;
		this.keyRange = MemoryRange as unknown as typeof IDBKeyRange;
	}

	/**
	 * The records of a store with their keys in an index (or the store's), in order.
	 * @returns [key, record]
	 */
	entries(store: string, index: string | undefined): [any, any][] {
		const spec = CatalogRecords.STORES[store as StoreName];
		const found = spec && index ? spec.indexes.find(([name]) => name === index) : null;
		if (index && !found) throw new Error(`no index ${index} on ${store}`);
		const keyPath = found ? found[1] : spec.keyPath,
			multiEntry = !!(found && found[2] && found[2].multiEntry);
		const at: (rec: any, path: string) => any = (rec, path) => rec[path];
		const out: [any, any][] = [];
		for (const rec of this.records[store as StoreName] as any[]) {
			if (Array.isArray(keyPath)) {
				const key = keyPath.map(k => at(rec, k));
				if (key.every(k => k !== undefined)) out.push([key, rec]);
			} else {
				const v = at(rec, keyPath);
				if (multiEntry && Array.isArray(v)) for (const k of new Set(v)) out.push([k, rec]);
				else if (v !== undefined) out.push([v, rec]);
			}
		}
		const primary = (rec: any) => CatalogRecords.keyOf(store as StoreName, rec);
		return out.sort((x, y) => compareKeys(x[0], y[0]) || compareKeys(primary(x[1]), primary(y[1])));
	}

	/**
	 * @param query a key, a range, or null
	 */
	static inRange(query: any, key: any): boolean {
		if (query === null || query === undefined) return true;
		if (!(query instanceof MemoryRange)) return compareKeys(query, key) === 0;
		const r = query as MemoryRange & {lower: any; upper: any; lowerOpen: boolean; upperOpen: boolean};
		if (r.lower !== undefined) {
			const c = compareKeys(key, r.lower);
			if (c < 0 || (c === 0 && r.lowerOpen)) return false;
		}
		if (r.upper !== undefined) {
			const c = compareKeys(key, r.upper);
			if (c > 0 || (c === 0 && r.upperOpen)) return false;
		}
		return true;
	}

	async get(store: string, keys: IDBValidKey[]): Promise<any[]> {
		const all = this.entries(store, undefined);
		return [...new Set(keys)]
			.map(k => all.find(([key]) => compareKeys(key, k) === 0))
			.filter(e => !!e)
			.map(e => structuredClone((e as [any, any])[1]));
	}
	async all(
		store: string,
		index: string | undefined,
		query: IDBValidKey | IDBKeyRange | null = null,
		count?: number,
	): Promise<any[]> {
		const list = this.entries(store, index)
			.filter(([key]) => MemoryReader.inRange(query, key))
			.map(([, rec]) => rec);
		return structuredClone(count ? list.slice(0, count) : list);
	}
	async allKeys(
		store: string,
		index: string | undefined,
		query: IDBValidKey | IDBKeyRange | null = null,
	): Promise<IDBValidKey[]> {
		return this.entries(store, index)
			.filter(([key]) => MemoryReader.inRange(query, key))
			.map(([, rec]) => CatalogRecords.keyOf(store as StoreName, rec));
	}
	under(store: string, index: string, prefix: IDBValidKey[], count?: number): Promise<any[]> {
		return CatalogReader.prototype.under.call(this, store, index, prefix, count);
	}
	page(
		store: string,
		index: string | undefined,
		after: IDBValidKey | null,
		count: number,
		lower?: IDBValidKey,
		upper?: IDBValidKey,
	): Promise<any[]> {
		return CatalogReader.prototype.page.call(this, store, index, after, count, lower, upper);
	}
	async keys(store: string, index: string): Promise<IDBValidKey[]> {
		const out: any[] = [];
		for (const [key] of this.entries(store, index))
			if (!out.length || compareKeys(out[out.length - 1], key) !== 0) out.push(key);
		return out;
	}
	async indexKeys(
		store: string,
		index: string,
		query: IDBValidKey | IDBKeyRange | null = null,
	): Promise<[IDBValidKey, IDBValidKey][]> {
		return this.entries(store, index)
			.filter(([key]) => MemoryReader.inRange(query, key))
			.map(([key, rec]) => [key, CatalogRecords.keyOf(store as StoreName, rec)]);
	}
	async count(store: string, index?: string, query: IDBValidKey | IDBKeyRange | null = null): Promise<number> {
		return this.entries(store, index).filter(([key]) => MemoryReader.inRange(query, key)).length;
	}
}

/** A save's writes and what it works out again, in its readwrite transaction (see CatalogDatabase.save). */
class SaveTransaction {
	tx: IDBTransaction;
	keyRange: typeof IDBKeyRange;
	/** the names of series and people looked up, by id */
	names: Map<string, string>;

	constructor(tx: IDBTransaction, keyRange: typeof IDBKeyRange) {
		this.tx = tx;
		this.keyRange = keyRange;
		this.names = new Map();
	}

	os(store: string) {
		return this.tx.objectStore(store);
	}
	get(store: string, key: IDBValidKey): Promise<any> {
		return requested(this.os(store).get(key));
	}
	/**
	 * The primary keys of the records whose `index` key is `key`, or starts with `prefix` when it is a list.
	 */
	keysIn(store: string, index: string, key: IDBValidKey, prefix: boolean = false): Promise<IDBValidKey[]> {
		const query = prefix && Array.isArray(key) ? this.keyRange.bound(key, [...key, []]) : key;
		return requested(this.os(store).index(index).getAllKeys(query));
	}
	under(store: string, index: string, prefix: IDBValidKey[]): Promise<any[]> {
		return requested(
			this.os(store)
				.index(index)
				.getAll(this.keyRange.bound(prefix, [...prefix, []])),
		);
	}
	/**
	 * The highest position in a store's `byPosition` index, or -1 when it is empty.
	 */
	lastPosition(store: string): Promise<number> {
		return new Promise((resolve, reject) => {
			const req = this.os(store).index('byPosition').openCursor(null, 'prev');
			req.onsuccess = () => resolve(req.result ? req.result.value.position : -1);
			req.onerror = () => reject(req.error);
		});
	}
	/**
	 * The name of a series or person, by their id (read once).
	 */
	async nameOf(id: string, what: string): Promise<string> {
		const had = this.names.get(id);
		if (had !== undefined) return had;
		const rec = await this.get(what === 'series' ? 'series' : 'contributors', id);
		if (!rec) throw new Error(`no ${what} is stored under ${id}`);
		this.names.set(id, rec.name);
		return rec.name;
	}

	/**
	 * @param positions the positions given to the books added, by id
	 */
	async write(changes: Changes, positions: Map<string, number>) {
		const put = changes.put,
			del = changes.delete;
		const puts: (store: StoreName) => Record<string, any>[] = store => (put[store] || []) as Record<string, any>[];
		const dels: (store: StoreName) => IDBValidKey[] = store => del[store] || [];

		// what the books, series and people changed were before, for what they leave behind
		const affectedEditions = new Set([...puts('editions').map(r => r.id), ...dels('editions')] as string[]);
		const affectedSeries = new Set([...puts('series').map(r => r.id), ...dels('series')] as string[]);
		const affectedPeople = new Set([...puts('contributors').map(r => r.id), ...dels('contributors')] as string[]);
		const oldBooks: Map<string, BookRecord | undefined> = new Map();
		for (const id of [...puts('books').map(r => r.id), ...dels('books')] as string[]) {
			const old = await this.get('books', id);
			oldBooks.set(id, old);
			if (!old) continue;
			old.editionIds.forEach((ed: string) => affectedEditions.add(ed));
			if (old.seriesId) affectedSeries.add(old.seriesId);
			for (const key of await this.keysIn('credits', 'bookId', id))
				affectedPeople.add((key as IDBValidKey[])[0] as string);
		}
		/** series and people whose name changes, so their books' search text does */
		const renamed: Set<string> = new Set();
		for (const [store, list] of [
			['series', puts('series')],
			['contributors', puts('contributors')],
		] as ['series' | 'contributors', Record<string, any>[]][]) {
			for (const r of list) {
				const old = await this.get(store, r.id);
				if (old && old.name !== r.name) renamed.add(r.id);
			}
		}

		// the writes. A series or person the page removed goes once no stored book names them (below).
		for (const store of ['marks', 'books'] as StoreName[])
			for (const key of dels(store)) this.os(store).delete(key);
		for (const key of dels('exclusions')) this.os('exclusions').delete(key);
		const dropped = new Set([...dels('series'), ...dels('contributors')].map(key => key as string));
		let nextBook = -1;
		for (const r of puts('books')) {
			let position = r.position;
			if (position === CatalogRecords.NEW_POSITION) {
				const old = oldBooks.get(r.id);
				if (old) position = old.position;
				else {
					if (nextBook < 0) nextBook = (await this.lastPosition('books')) + 1;
					position = nextBook++;
					positions.set(r.id, position);
				}
			}
			this.os('books').put({...r, position});
		}
		for (const r of puts('editions')) this.os('editions').put(r);
		for (const r of [...puts('series'), ...puts('contributors')])
			this.os(r.kind ? 'contributors' : 'series').put(r);
		for (const r of puts('marks')) this.os('marks').put(r);
		let nextExclusion = -1;
		for (const r of puts('exclusions')) {
			if (await this.get('exclusions', r.entry)) continue;
			if (nextExclusion < 0) nextExclusion = (await this.lastPosition('exclusions')) + 1;
			this.os('exclusions').put({entry: r.entry, position: nextExclusion++});
		}

		// the books an edition is on (one no book has is gone), and the books whose derived fields change
		const affectedBooks = new Set(puts('books').map(r => r.id) as string[]);
		for (const r of puts('books')) r.editionIds.forEach((ed: string) => affectedEditions.add(ed));
		const editions: Map<string, EditionRecord> = new Map();
		for (const id of affectedEditions) {
			const ed = await this.get('editions', id);
			if (!ed) continue;
			const bookIds = (await this.keysIn('books', 'editionIds', id)) as string[];
			if (!bookIds.length) {
				this.os('editions').delete(id);
				continue;
			}
			const fresh = {...ed, bookIds};
			this.os('editions').put(fresh);
			editions.set(id, fresh);
			bookIds.forEach(b => affectedBooks.add(b));
		}
		for (const id of renamed) {
			const ids = (await this.get('series', id))
				? await this.keysIn('books', 'bySeries', [id], true)
				: (await this.keysIn('credits', 'byTitle', [id], true)).map(key => (key as IDBValidKey[])[1]);
			ids.forEach(b => affectedBooks.add(b as string));
		}

		// each of those books' derived fields and credits, from its editions and the names it points at
		for (const id of dels('books')) {
			for (const key of await this.keysIn('credits', 'bookId', id)) this.os('credits').delete(key);
			for (const key of await this.keysIn('marks', 'bookIds', id)) this.os('marks').delete(key);
		}
		for (const id of affectedBooks) {
			const rec: BookRecord | undefined = await this.get('books', id);
			if (!rec) continue;
			for (const ed of rec.editionIds)
				if (!editions.has(ed)) {
					const found = await this.get('editions', ed);
					if (found) editions.set(ed, found);
				}
			/** name -> id, by kind, of the names this book has */
			const ids: Map<string, string> = new Map();
			const name: (id: string, what: string) => Promise<string> = async (x, what) => {
				const n = await this.nameOf(x, what);
				ids.set(what + '\n' + n, x);
				return n;
			};
			for (const a of rec.authorIds) await name(a, 'author');
			if (rec.seriesId) await name(rec.seriesId, 'series');
			for (const edId of rec.editionIds) {
				const ed = editions.get(edId);
				if (!ed) continue;
				for (const n of ed.narratorIds) await name(n, 'narrator');
				if (ed.publisherId) await name(ed.publisherId, 'publisher');
			}
			const book = CatalogRecords.bookOf(rec, editions, x => this.names.get(x) as string);
			const derived = CatalogRecords.bookRecord(
				book,
				(kind, n) => ids.get((kind === 'series' ? 'series' : Contributor.ONE[kind]) + '\n' + n) as string,
				rec.position,
			);
			const fresh = {...derived, ...CatalogRecords.ownFields('books', rec)};
			this.os('books').put(fresh);
			const old = oldBooks.get(id);
			if (old && old.seriesId) affectedSeries.add(old.seriesId);
			if (fresh.seriesId) affectedSeries.add(fresh.seriesId);
			for (const key of await this.keysIn('credits', 'bookId', id)) {
				affectedPeople.add((key as IDBValidKey[])[0] as string);
				this.os('credits').delete(key);
			}
			for (const credit of CatalogRecords.creditsOf(
				fresh as BookRecord,
				rec.editionIds.map(e => editions.get(e)).filter(e => !!e),
			)) {
				affectedPeople.add(credit.contributorId);
				this.os('credits').put(credit);
			}
		}

		// the series and people those books are in or credit: their counts. They stay when no book names them
		// any more (an entry of their own), unless the page removed them.
		for (const id of affectedSeries) {
			const rec: SeriesRecord | undefined = await this.get('series', id);
			if (!rec) continue;
			const books = await this.under('books', 'bySeries', [id]);
			if (!books.length && dropped.has(id)) {
				this.os('series').delete(id);
				continue;
			}
			const fresh = CatalogRecords.rederiveSeries(CatalogRecords.ownFields('series', rec) as SeriesRecord, books);
			this.os('series').put({...fresh, ...CatalogRecords.ownFields('series', rec)});
		}
		for (const id of affectedPeople) {
			const rec: ContributorRecord | undefined = await this.get('contributors', id);
			if (!rec) continue;
			const credits: CreditRecord[] = await this.under('credits', 'byTitle', [id]);
			if (!credits.length && dropped.has(id)) {
				this.os('contributors').delete(id);
				continue;
			}
			const books: BookRecord[] = [];
			for (const c of credits) {
				const b = await this.get('books', c.bookId);
				if (b) books.push(b);
			}
			const authors: Map<string, string> = new Map();
			if (rec.kind !== 'author')
				for (const b of books)
					for (const a of b.authorIds) if (!authors.has(a)) authors.set(a, await this.nameOf(a, 'author'));
			const fresh = CatalogRecords.rederiveContributor(
				CatalogRecords.ownFields('contributors', rec) as ContributorRecord,
				books,
				a => authors.get(a) || '',
			);
			this.os('contributors').put({...fresh, ...CatalogRecords.ownFields('contributors', rec)});
		}
	}
}

/** The open database. */
export class CatalogDatabase {
	static NAME = 'audiobook-catalog';
	// Bump it, and add to upgrade(), whenever the stores or their indexes change.
	// 2: the books' `hardcoverId` index became `externalKeys`, which series and contributors have too.
	// 3: indexes for pages that load only what they show (books by position, edition, read year, search
	// text and standalone; exclusions by position), and derived fields for them; records from before are
	// saved again in the new shape (`reshape` in meta says they wait for that).
	// 4: a series no longer keeps a site; records from before are saved again with it moved to the series'
	// author or publisher (Catalog.moveSeriesSites), the stores as they were.
	static VERSION = 4;
	/** every store, the records' and meta */
	static ALL_STORES: (StoreName | 'meta')[] = [...CatalogRecords.STORE_NAMES, 'meta'];

	db: IDBDatabase;
	keyRange: typeof IDBKeyRange;

	constructor(db: IDBDatabase, keyRange: typeof IDBKeyRange) {
		this.db = db;
		this.keyRange = keyRange;
	}

	/**
	 * Open (and on first use, make) the database.
	 * @param factory the browser's indexedDB
	 * @param keyRange the browser's IDBKeyRange
	 */
	static open(
		factory: IDBFactory,
		name: string = CatalogDatabase.NAME,
		keyRange: typeof IDBKeyRange = globalThis.IDBKeyRange,
	): Promise<CatalogDatabase> {
		return new Promise((resolve, reject) => {
			const req = factory.open(name, CatalogDatabase.VERSION);
			req.onupgradeneeded = event =>
				CatalogDatabase.upgrade(req.result, req.transaction as IDBTransaction, event.oldVersion);
			req.onsuccess = () => {
				const db = req.result;
				// a newer version of the app, opened in another tab, needs this connection out of its way
				db.onversionchange = () => db.close();
				resolve(new CatalogDatabase(db, keyRange));
			};
			req.onerror = () => reject(req.error);
			req.onblocked = () => reject(new Error('an older version of the app is open in another tab; close it'));
		});
	}

	/**
	 * Make the stores and indexes the database lacks, and remove the indexes it no longer has. The records
	 * stay as they are: CatalogRecords.toCatalog() reads an older record too, and the next save writes it
	 * in the current shape.
	 * @param tx the upgrade's
	 * @param oldVersion the version it had (0 for a new database)
	 */
	static upgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number = 0) {
		for (const store of CatalogRecords.STORE_NAMES) {
			const spec = CatalogRecords.STORES[store];
			const os = db.objectStoreNames.contains(store)
				? tx.objectStore(store)
				: db.createObjectStore(store, {keyPath: spec.keyPath});
			const wanted = spec.indexes.map(([index]) => index);
			for (const index of [...os.indexNames]) if (!wanted.includes(index)) os.deleteIndex(index);
			for (const [index, keyPath, options] of spec.indexes)
				if (!os.indexNames.contains(index)) os.createIndex(index, keyPath, options);
		}
		if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath: 'key'});
		// records from before version 3 lack the derived fields its indexes read, and from before version 4
		// a series may keep a site
		if (oldVersion > 0 && oldVersion < 4) tx.objectStore('meta').put({key: 'reshape', value: oldVersion});
	}

	/** @returns whether the records wait to be saved again in the current shape (see VERSION) */
	async needsReshape(): Promise<boolean> {
		const tx = this.db.transaction('meta', 'readonly');
		return !!(await requested(tx.objectStore('meta').get('reshape')));
	}

	/**
	 * Read with `fn` in one read-only transaction (see CatalogReader); returns what it returns, and the
	 * revision the records are (null when nothing was ever saved).
	 */
	async read<T>(fn: (reader: CatalogReader) => Promise<T>): Promise<{result: T; revision: number | null}> {
		const tx = this.db.transaction(CatalogDatabase.ALL_STORES, 'readonly');
		const reader = new CatalogReader(tx, this.keyRange);
		const [meta, result] = await Promise.all([requested(tx.objectStore('meta').get('revision')), fn(reader)]);
		return {result, revision: meta ? meta.value : null};
	}

	/**
	 * How many duplicates the Duplicates link counts, as kept for the revision it was counted at; null when none is kept.
	 */
	async duplicateCount(): Promise<{count: number; revision: number} | null> {
		const tx = this.db.transaction('meta', 'readonly');
		const rec = await requested(tx.objectStore('meta').get('duplicates'));
		return rec ? {count: rec.value, revision: rec.revision} : null;
	}

	/**
	 * Keep how many duplicates the catalog has at `revision`, unless another save came since.
	 */
	async keepDuplicateCount(revision: number, count: number): Promise<void> {
		const tx = this.db.transaction('meta', 'readwrite');
		const done = committed(tx);
		const meta = tx.objectStore('meta');
		const rec = await requested(meta.get('revision'));
		if (rec && rec.value === revision) meta.put({key: 'duplicates', value: count, revision});
		await done;
	}

	/**
	 * What this browser last synced with the other devices (CatalogSync): the synced copy's revision, the backup
	 * that copy was, and when; null before the first sync.
	 */
	async syncBase(): Promise<SyncBase | null> {
		const tx = this.db.transaction('meta', 'readonly');
		const rec = await requested(tx.objectStore('meta').get('sync'));
		return rec ? rec.value : null;
	}

	/**
	 * Keep what this browser synced last (see syncBase()); null forgets it.
	 */
	async keepSyncBase(base: SyncBase | null): Promise<void> {
		const tx = this.db.transaction('meta', 'readwrite');
		const done = committed(tx);
		if (base) tx.objectStore('meta').put({key: 'sync', value: base});
		else tx.objectStore('meta').delete('sync');
		await done;
	}

	/** @returns the revision saved last, or null when nothing was ever saved */
	async revision(): Promise<number | null> {
		const tx = this.db.transaction('meta', 'readonly');
		const rec = await requested(tx.objectStore('meta').get('revision'));
		return rec ? rec.value : null;
	}

	/**
	 * Every record, and the revision they are; null when nothing was ever saved.
	 */
	async load(): Promise<{records: RecordSet; revision: number} | null> {
		const tx = this.db.transaction(CatalogDatabase.ALL_STORES, 'readonly');
		const [meta, ...lists] = await Promise.all([
			requested(tx.objectStore('meta').get('revision')),
			...CatalogRecords.STORE_NAMES.map(store => requested(tx.objectStore(store).getAll())),
		]);
		if (!meta) return null;
		const records = Object.fromEntries(
			CatalogRecords.STORE_NAMES.map((store, i) => [store, lists[i]]),
		) as unknown as RecordSet;
		return {records, revision: meta.value};
	}

	/**
	 * Write the changes in one transaction, if the revision saved is still `expected` (null: nothing was
	 * saved yet), and work out again what depends on what changed, from what is stored: the credits of the
	 * books changed, the books an edition is on, a book's derived fields (its search text names its series,
	 * people and editions), a series' counts from its books and a person's from their credits. A page may
	 * hold only some of the catalog, so what it removes is removed only when nothing stored still needs it:
	 * an edition goes with its last book, and a series or person the page removed once no book names them.
	 * A series or person no book names any more stays, as an entry of its own. A book added with position NEW_POSITION goes after all the others,
	 * and an exclusion already stored keeps its place. Returns the new revision and the positions given.
	 * Throws a CatalogConflict when another tab saved meanwhile, and then writes nothing.
	 */
	async save(changes: Changes, expected: number | null): Promise<{revision: number; positions: Map<string, number>}> {
		const tx = this.db.transaction(CatalogDatabase.ALL_STORES, 'readwrite');
		const done = committed(tx);
		const meta = tx.objectStore('meta');
		const rec = await requested(meta.get('revision'));
		const revision = rec ? rec.value : null;
		if (revision !== expected) {
			tx.abort();
			await done.catch(() => {});
			throw new CatalogConflict();
		}
		const positions: Map<string, number> = new Map();
		try {
			await new SaveTransaction(tx, this.keyRange).write(changes, positions);
		} catch (e) {
			try {
				tx.abort();
			} catch {
				/* the transaction had already ended */
			}
			await done.catch(() => {});
			throw e;
		}
		const next = (revision || 0) + 1;
		meta.put({key: 'revision', value: next, savedAt: new Date().toISOString()});
		meta.delete('reshape');
		await done;
		return {revision: next, positions};
	}

	/**
	 * Set aside what is stored (as `what`, the records or whatever could be read) under meta's
	 * `unreadable`, and empty the catalog; returns the new revision.
	 */
	async setAside(what: unknown): Promise<number> {
		const tx = this.db.transaction(CatalogDatabase.ALL_STORES, 'readwrite');
		const done = committed(tx);
		const meta = tx.objectStore('meta');
		const rec = await requested(meta.get('revision'));
		const next = (rec ? rec.value : 0) + 1;
		meta.put({key: 'unreadable', value: what, at: new Date().toISOString()});
		for (const store of CatalogRecords.STORE_NAMES) tx.objectStore(store).clear();
		meta.put({key: 'revision', value: next, savedAt: new Date().toISOString()});
		await done;
		return next;
	}

	close() {
		this.db.close();
	}
}
