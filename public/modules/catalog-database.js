// The catalog's IndexedDB database: a store per kind of record (CatalogRecords.STORES) and `meta`, which
// holds the revision (bumped by every save, so a page can tell another tab saved since it last read) and
// a catalog set aside because it could not be read. The browser's indexedDB is passed in, so the tests
// can pass a fake one.
import {CatalogRecords} from './catalog-records.js';
/** @import {RecordSet, StoreName, Changes} from './catalog-records.js' */

/** What a save finds when another tab saved since this page last read or wrote the catalog. */
export class CatalogConflict extends Error {
	constructor(){
		super('the catalog was changed in another tab');
		this.name = 'CatalogConflict';
	}
}

/**
 * The request's result, once it succeeds.
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function requested(req){
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/**
 * Resolves when the transaction commits; rejects when it is aborted or fails.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function committed(tx){
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
	/**
	 * @param {IDBTransaction} tx
	 * @param {typeof IDBKeyRange} keyRange
	 */
	constructor(tx, keyRange){
		this.tx = tx;
		this.keyRange = keyRange;
	}

	/**
	 * The store, or one of its indexes.
	 * @param {string} store
	 * @param {string} [index]
	 * @returns {IDBObjectStore | IDBIndex}
	 */
	source(store, index){
		const os = this.tx.objectStore(store);
		return index ? os.index(index) : os;
	}

	/**
	 * The records under these keys, in their order, leaving out keys with none.
	 * @param {string} store
	 * @param {IDBValidKey[]} keys
	 * @returns {Promise<any[]>}
	 */
	async get(store, keys){
		const os = this.tx.objectStore(store);
		const found = await Promise.all([...new Set(keys)].map(key => requested(os.get(key))));
		return found.filter(rec => rec !== undefined);
	}

	/**
	 * The records with keys in `query` (a key, an IDBKeyRange, or null for all), in index order, at most `count`.
	 * @param {string} store
	 * @param {string | undefined} index
	 * @param {IDBValidKey | IDBKeyRange | null} [query]
	 * @param {number} [count]
	 * @returns {Promise<any[]>}
	 */
	all(store, index, query = null, count){
		return requested(this.source(store, index).getAll(query, count));
	}

	/**
	 * The keys of the records with index keys in `query`, in index order, without reading the records.
	 * @param {string} store
	 * @param {string | undefined} index
	 * @param {IDBValidKey | IDBKeyRange | null} [query]
	 * @returns {Promise<IDBValidKey[]>}
	 */
	allKeys(store, index, query = null){
		return requested(this.source(store, index).getAllKeys(query));
	}

	/**
	 * Each index key in `query` with the key of its record, as [indexKey, key], in index order, without
	 * reading the records (a search reads the books' search text this way).
	 * @param {string} store
	 * @param {string} index
	 * @param {IDBValidKey | IDBKeyRange | null} [query]
	 * @returns {Promise<[IDBValidKey, IDBValidKey][]>}
	 */
	indexKeys(store, index, query = null){
		return new Promise((resolve, reject) => {
			/** @type {[IDBValidKey, IDBValidKey][]} */
			const out = [];
			const req = this.source(store, index).openKeyCursor(query);
			req.onsuccess = () => {
				const cursor = req.result;
				if(!cursor){ resolve(out); return; }
				out.push([cursor.key, cursor.primaryKey]);
				cursor.continue();
			};
			req.onerror = () => reject(req.error);
		});
	}

	/**
	 * The records whose index key starts with `prefix` (a compound key's first parts), in index order.
	 * @param {string} store
	 * @param {string} index
	 * @param {IDBValidKey[]} prefix
	 * @param {number} [count]
	 * @returns {Promise<any[]>}
	 */
	under(store, index, prefix, count){
		return this.all(store, index, this.keyRange.bound(prefix, [...prefix, []]), count);
	}

	/**
	 * Up to `count` records after `after` (an index key shown last; null for the first page), in index
	 * order, and below `upper` when given, e.g. the next books of one person (["id-7"] + [[]] as the end).
	 * @param {string} store
	 * @param {string | undefined} index
	 * @param {IDBValidKey | null} after
	 * @param {number} count
	 * @param {IDBValidKey} [lower] where the list starts (when `after` is null)
	 * @param {IDBValidKey} [upper] where it ends
	 * @returns {Promise<any[]>}
	 */
	page(store, index, after, count, lower, upper){
		const from = after !== null ? after : lower;
		const open = after !== null;
		const range = from === undefined ? (upper === undefined ? null : this.keyRange.upperBound(upper, true))
			: upper === undefined ? this.keyRange.lowerBound(from, open) : this.keyRange.bound(from, upper, open, true);
		return this.all(store, index, range, count);
	}

	/**
	 * The distinct keys of an index (a multiEntry index's values: every genre), in order, without reading any record.
	 * @param {string} store
	 * @param {string} index
	 * @returns {Promise<IDBValidKey[]>}
	 */
	keys(store, index){
		return new Promise((resolve, reject) => {
			/** @type {IDBValidKey[]} */
			const out = [];
			const req = this.source(store, index).openKeyCursor(null, 'nextunique');
			req.onsuccess = () => {
				const cursor = req.result;
				if(!cursor){ resolve(out); return; }
				out.push(cursor.key);
				cursor.continue();
			};
			req.onerror = () => reject(req.error);
		});
	}

	/**
	 * How many records have keys in `query` (all of them with none).
	 * @param {string} store
	 * @param {string} [index]
	 * @param {IDBValidKey | IDBKeyRange | null} [query]
	 * @returns {Promise<number>}
	 */
	count(store, index, query = null){
		return requested(this.source(store, index).count(query ?? undefined));
	}

	/**
	 * Go through the records with keys in `query` one at a time, in index order, keeping none: `each` gets
	 * every record's value as the cursor reaches it.
	 * @param {string} store
	 * @param {string | undefined} index
	 * @param {IDBValidKey | IDBKeyRange | null} query
	 * @param {(value: any) => void} each
	 * @returns {Promise<void>}
	 */
	walk(store, index, query, each){
		return new Promise((resolve, reject) => {
			const req = this.source(store, index).openCursor(query);
			req.onsuccess = () => {
				const cursor = req.result;
				if(!cursor){ resolve(); return; }
				each(cursor.value);
				cursor.continue();
			};
			req.onerror = () => reject(req.error);
		});
	}
}

/** @import {BookRecord, EditionRecord, SeriesRecord, ContributorRecord, CreditRecord} from './catalog-records.js' */

/**
 * Two keys in IndexedDB's order: numbers, then strings, then lists (item by item).
 * @param {any} x
 * @param {any} y
 * @returns {number}
 */
function compareKeys(x, y){
	const rank = (/** @type {any} */ k) => typeof k === 'number' ? 1 : typeof k === 'string' ? 3 : Array.isArray(k) ? 5 : 0;
	if(rank(x) !== rank(y)) return rank(x) - rank(y);
	if(Array.isArray(x)){
		for(let i = 0; i < Math.min(x.length, y.length); i++){ const c = compareKeys(x[i], y[i]); if(c) return c; }
		return x.length - y.length;
	}
	return x < y ? -1 : x > y ? 1 : 0;
}

/** A key range as MemoryReader takes one (IDBKeyRange's fields). */
class MemoryRange {
	/**
	 * @param {any} lower
	 * @param {any} upper
	 * @param {boolean} lowerOpen
	 * @param {boolean} upperOpen
	 */
	constructor(lower, upper, lowerOpen, upperOpen){ Object.assign(this, {lower, upper, lowerOpen, upperOpen}); }
	/** @param {any} key @param {boolean} [open] */
	static lowerBound(key, open = false){ return new MemoryRange(key, undefined, open, true); }
	/** @param {any} key @param {boolean} [open] */
	static upperBound(key, open = false){ return new MemoryRange(undefined, key, true, open); }
	/** @param {any} lower @param {any} upper @param {boolean} [lowerOpen] @param {boolean} [upperOpen] */
	static bound(lower, upper, lowerOpen = false, upperOpen = false){ return new MemoryRange(lower, upper, lowerOpen, upperOpen); }
	/** @param {any} key */
	static only(key){ return new MemoryRange(key, key, false, false); }
}

/**
 * The reads of a CatalogReader over records held in memory, for a browser that keeps no IndexedDB: the
 * page then holds the whole catalog, and asks it what it would ask the database.
 */
export class MemoryReader {
	/** @param {RecordSet} records */
	constructor(records){
		this.records = records;
		this.keyRange = /** @type {typeof IDBKeyRange} */ (/** @type {unknown} */ (MemoryRange));
	}

	/**
	 * The records of a store with their keys in an index (or the store's), in order.
	 * @param {string} store
	 * @param {string | undefined} index
	 * @returns {[any, any][]} [key, record]
	 */
	entries(store, index){
		const spec = CatalogRecords.STORES[/** @type {StoreName} */ (store)];
		const found = spec && index ? spec.indexes.find(([name]) => name === index) : null;
		if(index && !found) throw new Error(`no index ${index} on ${store}`);
		const keyPath = found ? found[1] : spec.keyPath, multiEntry = !!(found && found[2] && found[2].multiEntry);
		/** @type {(rec: any, path: string) => any} */
		const at = (rec, path) => rec[path];
		/** @type {[any, any][]} */
		const out = [];
		for(const rec of /** @type {any[]} */ (this.records[/** @type {StoreName} */ (store)])){
			if(Array.isArray(keyPath)){
				const key = keyPath.map(k => at(rec, k));
				if(key.every(k => k !== undefined)) out.push([key, rec]);
			}
			else{
				const v = at(rec, keyPath);
				if(multiEntry && Array.isArray(v)) for(const k of new Set(v)) out.push([k, rec]);
				else if(v !== undefined) out.push([v, rec]);
			}
		}
		const primary = (/** @type {any} */ rec) => CatalogRecords.keyOf(/** @type {StoreName} */ (store), rec);
		return out.sort((x, y) => compareKeys(x[0], y[0]) || compareKeys(primary(x[1]), primary(y[1])));
	}

	/**
	 * @param {any} query a key, a range, or null
	 * @param {any} key
	 * @returns {boolean}
	 */
	static inRange(query, key){
		if(query === null || query === undefined) return true;
		if(!(query instanceof MemoryRange)) return compareKeys(query, key) === 0;
		const r = /** @type {MemoryRange & {lower: any, upper: any, lowerOpen: boolean, upperOpen: boolean}} */ (query);
		if(r.lower !== undefined){ const c = compareKeys(key, r.lower); if(c < 0 || (c === 0 && r.lowerOpen)) return false; }
		if(r.upper !== undefined){ const c = compareKeys(key, r.upper); if(c > 0 || (c === 0 && r.upperOpen)) return false; }
		return true;
	}

	/** @type {CatalogReader['get']} */
	async get(store, keys){
		const all = this.entries(store, undefined);
		return [...new Set(keys)].map(k => all.find(([key]) => compareKeys(key, k) === 0)).filter(e => !!e).map(e => structuredClone(/** @type {[any, any]} */ (e)[1]));
	}
	/** @type {CatalogReader['all']} */
	async all(store, index, query = null, count){
		const list = this.entries(store, index).filter(([key]) => MemoryReader.inRange(query, key)).map(([, rec]) => rec);
		return structuredClone(count ? list.slice(0, count) : list);
	}
	/** @type {CatalogReader['allKeys']} */
	async allKeys(store, index, query = null){
		return this.entries(store, index).filter(([key]) => MemoryReader.inRange(query, key)).map(([, rec]) => CatalogRecords.keyOf(/** @type {StoreName} */ (store), rec));
	}
	/** @type {CatalogReader['under']} */
	under(store, index, prefix, count){ return CatalogReader.prototype.under.call(this, store, index, prefix, count); }
	/** @type {CatalogReader['page']} */
	page(store, index, after, count, lower, upper){ return CatalogReader.prototype.page.call(this, store, index, after, count, lower, upper); }
	/** @type {CatalogReader['keys']} */
	async keys(store, index){
		/** @type {any[]} */
		const out = [];
		for(const [key] of this.entries(store, index)) if(!out.length || compareKeys(out[out.length - 1], key) !== 0) out.push(key);
		return out;
	}
	/** @type {CatalogReader['indexKeys']} */
	async indexKeys(store, index, query = null){
		return this.entries(store, index).filter(([key]) => MemoryReader.inRange(query, key)).map(([key, rec]) => [key, CatalogRecords.keyOf(/** @type {StoreName} */ (store), rec)]);
	}
	/** @type {CatalogReader['count']} */
	async count(store, index, query = null){ return this.entries(store, index).filter(([key]) => MemoryReader.inRange(query, key)).length; }
	/** @type {CatalogReader['walk']} */
	async walk(store, index, query, each){ for(const rec of await this.all(store, index, query)) each(rec); }
}

/** A save's writes and what it works out again, in its readwrite transaction (see CatalogDatabase.save). */
class SaveTransaction {
	/**
	 * @param {IDBTransaction} tx
	 * @param {typeof IDBKeyRange} keyRange
	 */
	constructor(tx, keyRange){
		this.tx = tx;
		this.keyRange = keyRange;
		/** @type {Map<string, string>} the names of series and people looked up, by id */
		this.names = new Map();
	}

	/** @param {string} store */
	os(store){ return this.tx.objectStore(store); }
	/**
	 * @param {string} store
	 * @param {IDBValidKey} key
	 * @returns {Promise<any>}
	 */
	get(store, key){ return requested(this.os(store).get(key)); }
	/**
	 * The primary keys of the records whose `index` key is `key`, or starts with `prefix` when it is a list.
	 * @param {string} store
	 * @param {string} index
	 * @param {IDBValidKey} key
	 * @param {boolean} [prefix]
	 * @returns {Promise<IDBValidKey[]>}
	 */
	keysIn(store, index, key, prefix = false){
		const query = prefix && Array.isArray(key) ? this.keyRange.bound(key, [...key, []]) : key;
		return requested(this.os(store).index(index).getAllKeys(query));
	}
	/**
	 * @param {string} store
	 * @param {string} index
	 * @param {IDBValidKey[]} prefix
	 * @returns {Promise<any[]>}
	 */
	under(store, index, prefix){ return requested(this.os(store).index(index).getAll(this.keyRange.bound(prefix, [...prefix, []]))); }
	/**
	 * The highest position in a store's `byPosition` index, or -1 when it is empty.
	 * @param {string} store
	 * @returns {Promise<number>}
	 */
	lastPosition(store){
		return new Promise((resolve, reject) => {
			const req = this.os(store).index('byPosition').openCursor(null, 'prev');
			req.onsuccess = () => resolve(req.result ? req.result.value.position : -1);
			req.onerror = () => reject(req.error);
		});
	}
	/**
	 * The name of a series or person, by their id (read once).
	 * @param {string} id
	 * @param {string} what
	 * @returns {Promise<string>}
	 */
	async nameOf(id, what){
		const had = this.names.get(id);
		if(had !== undefined) return had;
		const rec = (await this.get(what === 'series' ? 'series' : 'contributors', id));
		if(!rec) throw new Error(`no ${what} is stored under ${id}`);
		this.names.set(id, rec.name);
		return rec.name;
	}

	/**
	 * @param {Changes} changes
	 * @param {Map<string, number>} positions the positions given to the books added, by id
	 */
	async write(changes, positions){
		const put = changes.put, del = changes.delete;
		/** @type {(store: StoreName) => Record<string, any>[]} */
		const puts = store => /** @type {Record<string, any>[]} */ (put[store] || []);
		/** @type {(store: StoreName) => IDBValidKey[]} */
		const dels = store => del[store] || [];

		// what the books, series and people changed were before, for what they leave behind
		const affectedEditions = new Set(/** @type {string[]} */ ([...puts('editions').map(r => r.id), ...dels('editions')]));
		const affectedSeries = new Set(/** @type {string[]} */ ([...puts('series').map(r => r.id), ...dels('series')]));
		const affectedPeople = new Set(/** @type {string[]} */ ([...puts('contributors').map(r => r.id), ...dels('contributors')]));
		/** @type {Map<string, BookRecord | undefined>} */
		const oldBooks = new Map();
		for(const id of /** @type {string[]} */ ([...puts('books').map(r => r.id), ...dels('books')])){
			const old = await this.get('books', id);
			oldBooks.set(id, old);
			if(!old) continue;
			old.editionIds.forEach((/** @type {string} */ ed) => affectedEditions.add(ed));
			if(old.seriesId) affectedSeries.add(old.seriesId);
			for(const key of await this.keysIn('credits', 'bookId', id)) affectedPeople.add(/** @type {string} */ (/** @type {IDBValidKey[]} */ (key)[0]));
		}
		/** @type {Set<string>} series and people whose name changes, so their books' search text does */
		const renamed = new Set();
		for(const [store, list] of /** @type {['series' | 'contributors', Record<string, any>[]][]} */ ([['series', puts('series')], ['contributors', puts('contributors')]])){
			for(const r of list){
				const old = await this.get(store, r.id);
				if(old && old.name !== r.name) renamed.add(r.id);
			}
		}

		// the writes. A series, person or edition the page dropped stays while anything stored needs it
		// (below), without the info the page removed.
		for(const store of /** @type {StoreName[]} */ (['marks', 'books'])) for(const key of dels(store)) this.os(store).delete(key);
		for(const key of dels('exclusions')) this.os('exclusions').delete(key);
		for(const store of /** @type {('series' | 'contributors')[]} */ (['series', 'contributors'])){
			for(const key of dels(store)){
				const old = await this.get(store, key);
				if(old) this.os(store).put(Object.fromEntries(Object.entries(old).filter(([k]) => !CatalogRecords.INFO[store].includes(k))));
			}
		}
		let nextBook = -1;
		for(const r of puts('books')){
			let position = r.position;
			if(position === CatalogRecords.NEW_POSITION){
				const old = oldBooks.get(r.id);
				if(old) position = old.position;
				else{
					if(nextBook < 0) nextBook = await this.lastPosition('books') + 1;
					position = nextBook++;
					positions.set(r.id, position);
				}
			}
			this.os('books').put({...r, position});
		}
		for(const r of puts('editions')) this.os('editions').put(r);
		for(const r of [...puts('series'), ...puts('contributors')]) this.os(r.kind ? 'contributors' : 'series').put(r);
		for(const r of puts('marks')) this.os('marks').put(r);
		let nextExclusion = -1;
		for(const r of puts('exclusions')){
			if(await this.get('exclusions', r.entry)) continue;
			if(nextExclusion < 0) nextExclusion = await this.lastPosition('exclusions') + 1;
			this.os('exclusions').put({entry: r.entry, position: nextExclusion++});
		}

		// the books an edition is on (one no book has is gone), and the books whose derived fields change
		const affectedBooks = new Set(/** @type {string[]} */ (puts('books').map(r => r.id)));
		for(const r of puts('books')) r.editionIds.forEach((/** @type {string} */ ed) => affectedEditions.add(ed));
		/** @type {Map<string, EditionRecord>} */
		const editions = new Map();
		for(const id of affectedEditions){
			const ed = await this.get('editions', id);
			if(!ed) continue;
			const bookIds = /** @type {string[]} */ (await this.keysIn('books', 'editionIds', id));
			if(!bookIds.length){ this.os('editions').delete(id); continue; }
			const fresh = {...ed, bookIds};
			this.os('editions').put(fresh);
			editions.set(id, fresh);
			bookIds.forEach(b => affectedBooks.add(b));
		}
		for(const id of renamed){
			const ids = (await this.get('series', id)) ? await this.keysIn('books', 'bySeries', [id], true)
				: (await this.keysIn('credits', 'byTitle', [id], true)).map(key => /** @type {IDBValidKey[]} */ (key)[1]);
			ids.forEach(b => affectedBooks.add(/** @type {string} */ (b)));
		}

		// each of those books' derived fields and credits, from its editions and the names it points at
		for(const id of dels('books')){
			for(const key of await this.keysIn('credits', 'bookId', id)) this.os('credits').delete(key);
			for(const key of await this.keysIn('marks', 'bookIds', id)) this.os('marks').delete(key);
		}
		for(const id of affectedBooks){
			/** @type {BookRecord | undefined} */
			const rec = await this.get('books', id);
			if(!rec) continue;
			for(const ed of rec.editionIds) if(!editions.has(ed)){
				const found = await this.get('editions', ed);
				if(found) editions.set(ed, found);
			}
			/** @type {Map<string, string>} name -> id, by kind, of the names this book has */
			const ids = new Map();
			/** @type {(id: string, what: string) => Promise<string>} */
			const name = async (x, what) => { const n = await this.nameOf(x, what); ids.set(what + '\n' + n, x); return n; };
			for(const a of rec.authorIds) await name(a, 'author');
			if(rec.seriesId) await name(rec.seriesId, 'series');
			for(const edId of rec.editionIds){
				const ed = editions.get(edId);
				if(!ed) continue;
				for(const n of ed.narratorIds) await name(n, 'narrator');
				if(ed.publisherId) await name(ed.publisherId, 'publisher');
			}
			const book = CatalogRecords.bookOf(rec, editions, (x, what) => /** @type {string} */ (this.names.get(x)));
			/** @type {Record<string, string>} */
			const kindOf = {series: 'series', authors: 'author', narrators: 'narrator', publishers: 'publisher'};
			const derived = CatalogRecords.bookRecord(book, (kind, n) => /** @type {string} */ (ids.get(kindOf[kind] + '\n' + n)), rec.position);
			const fresh = {...derived, ...CatalogRecords.ownFields('books', rec)};
			this.os('books').put(fresh);
			const old = oldBooks.get(id);
			if(old && old.seriesId) affectedSeries.add(old.seriesId);
			if(fresh.seriesId) affectedSeries.add(fresh.seriesId);
			for(const key of await this.keysIn('credits', 'bookId', id)){
				affectedPeople.add(/** @type {string} */ (/** @type {IDBValidKey[]} */ (key)[0]));
				this.os('credits').delete(key);
			}
			for(const credit of CatalogRecords.creditsOf(/** @type {BookRecord} */ (fresh), rec.editionIds.map(e => editions.get(e)).filter(e => !!e))){
				affectedPeople.add(credit.contributorId);
				this.os('credits').put(credit);
			}
		}

		// the series and people those books are in or credit: their counts, and whether they are still needed
		for(const id of affectedSeries){
			/** @type {SeriesRecord | undefined} */
			const rec = await this.get('series', id);
			if(!rec) continue;
			const books = await this.under('books', 'bySeries', [id]);
			if(!books.length && !CatalogRecords.hasInfo('series', rec)){ this.os('series').delete(id); continue; }
			const fresh = CatalogRecords.rederiveSeries(/** @type {SeriesRecord} */ (CatalogRecords.ownFields('series', rec)), books);
			this.os('series').put({...fresh, ...CatalogRecords.ownFields('series', rec)});
		}
		for(const id of affectedPeople){
			/** @type {ContributorRecord | undefined} */
			const rec = await this.get('contributors', id);
			if(!rec) continue;
			/** @type {CreditRecord[]} */
			const credits = await this.under('credits', 'byTitle', [id]);
			if(!credits.length && !CatalogRecords.hasInfo('contributors', rec)){ this.os('contributors').delete(id); continue; }
			/** @type {BookRecord[]} */
			const books = [];
			for(const c of credits){ const b = await this.get('books', c.bookId); if(b) books.push(b); }
			/** @type {Map<string, string>} */
			const authors = new Map();
			if(rec.kind !== 'author') for(const b of books) for(const a of b.authorIds) if(!authors.has(a)) authors.set(a, await this.nameOf(a, 'author'));
			const fresh = CatalogRecords.rederiveContributor(/** @type {ContributorRecord} */ (CatalogRecords.ownFields('contributors', rec)), books, a => authors.get(a) || '');
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
	static VERSION = 3;
	/** @type {(StoreName | 'meta')[]} every store, the records' and meta */
	static ALL_STORES = [...CatalogRecords.STORE_NAMES, 'meta'];

	/**
	 * @param {IDBDatabase} db
	 * @param {typeof IDBKeyRange} keyRange
	 */
	constructor(db, keyRange){
		this.db = db;
		this.keyRange = keyRange;
	}

	/**
	 * Open (and on first use, make) the database.
	 * @param {IDBFactory} factory the browser's indexedDB
	 * @param {string} [name]
	 * @param {typeof IDBKeyRange} [keyRange] the browser's IDBKeyRange
	 * @returns {Promise<CatalogDatabase>}
	 */
	static open(factory, name = CatalogDatabase.NAME, keyRange = globalThis.IDBKeyRange){
		return new Promise((resolve, reject) => {
			const req = factory.open(name, CatalogDatabase.VERSION);
			req.onupgradeneeded = event => CatalogDatabase.upgrade(req.result, /** @type {IDBTransaction} */ (req.transaction), event.oldVersion);
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
	 * @param {IDBDatabase} db
	 * @param {IDBTransaction} tx the upgrade's
	 * @param {number} [oldVersion] the version it had (0 for a new database)
	 */
	static upgrade(db, tx, oldVersion = 0){
		for(const store of CatalogRecords.STORE_NAMES){
			const spec = CatalogRecords.STORES[store];
			const os = db.objectStoreNames.contains(store) ? tx.objectStore(store) : db.createObjectStore(store, {keyPath: spec.keyPath});
			const wanted = spec.indexes.map(([index]) => index);
			for(const index of [...os.indexNames]) if(!wanted.includes(index)) os.deleteIndex(index);
			for(const [index, keyPath, options] of spec.indexes) if(!os.indexNames.contains(index)) os.createIndex(index, keyPath, options);
		}
		if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath: 'key'});
		// records from before version 3 lack the derived fields its indexes read
		if(oldVersion > 0 && oldVersion < 3) tx.objectStore('meta').put({key: 'reshape', value: oldVersion});
	}

	/** @returns {Promise<boolean>} whether the records wait to be saved again in the current shape (see VERSION) */
	async needsReshape(){
		const tx = this.db.transaction('meta', 'readonly');
		return !!(await requested(tx.objectStore('meta').get('reshape')));
	}

	/**
	 * Read with `fn` in one read-only transaction (see CatalogReader); returns what it returns, and the
	 * revision the records are (null when nothing was ever saved).
	 * @template T
	 * @param {(reader: CatalogReader) => Promise<T>} fn
	 * @returns {Promise<{result: T, revision: number | null}>}
	 */
	async read(fn){
		const tx = this.db.transaction(CatalogDatabase.ALL_STORES, 'readonly');
		const reader = new CatalogReader(tx, this.keyRange);
		const [meta, result] = await Promise.all([requested(tx.objectStore('meta').get('revision')), fn(reader)]);
		return {result, revision: meta ? meta.value : null};
	}

	/**
	 * How many duplicates the Duplicates link counts, as kept for the revision it was counted at; null when none is kept.
	 * @returns {Promise<{count: number, revision: number} | null>}
	 */
	async duplicateCount(){
		const tx = this.db.transaction('meta', 'readonly');
		const rec = await requested(tx.objectStore('meta').get('duplicates'));
		return rec ? {count: rec.value, revision: rec.revision} : null;
	}

	/**
	 * Keep how many duplicates the catalog has at `revision`, unless another save came since.
	 * @param {number} revision
	 * @param {number} count
	 * @returns {Promise<void>}
	 */
	async keepDuplicateCount(revision, count){
		const tx = this.db.transaction('meta', 'readwrite');
		const done = committed(tx);
		const meta = tx.objectStore('meta');
		const rec = await requested(meta.get('revision'));
		if(rec && rec.value === revision) meta.put({key: 'duplicates', value: count, revision});
		await done;
	}

	/** @returns {Promise<number | null>} the revision saved last, or null when nothing was ever saved */
	async revision(){
		const tx = this.db.transaction('meta', 'readonly');
		const rec = await requested(tx.objectStore('meta').get('revision'));
		return rec ? rec.value : null;
	}

	/**
	 * Every record, and the revision they are; null when nothing was ever saved.
	 * @returns {Promise<{records: RecordSet, revision: number} | null>}
	 */
	async load(){
		const tx = this.db.transaction(CatalogDatabase.ALL_STORES, 'readonly');
		const [meta, ...lists] = await Promise.all([requested(tx.objectStore('meta').get('revision')),
			...CatalogRecords.STORE_NAMES.map(store => requested(tx.objectStore(store).getAll()))]);
		if(!meta) return null;
		const records = /** @type {RecordSet} */ (Object.fromEntries(CatalogRecords.STORE_NAMES.map((store, i) => [store, lists[i]])));
		return {records, revision: meta.value};
	}

	/**
	 * Write the changes in one transaction, if the revision saved is still `expected` (null: nothing was
	 * saved yet), and work out again what depends on what changed, from what is stored: the credits of the
	 * books changed, the books an edition is on, a book's derived fields (its search text names its series,
	 * people and editions), a series' counts from its books and a person's from their credits. A page may
	 * hold only some of the catalog, so what it removes is removed only when nothing stored still needs it:
	 * an edition goes with its last book, a series or person with their last book once they have no info
	 * (removing it removes their info). A book added with position NEW_POSITION goes after all the others,
	 * and an exclusion already stored keeps its place. Returns the new revision and the positions given.
	 * Throws a CatalogConflict when another tab saved meanwhile, and then writes nothing.
	 * @param {Changes} changes
	 * @param {number | null} expected
	 * @returns {Promise<{revision: number, positions: Map<string, number>}>}
	 */
	async save(changes, expected){
		const tx = this.db.transaction(CatalogDatabase.ALL_STORES, 'readwrite');
		const done = committed(tx);
		const meta = tx.objectStore('meta');
		const rec = await requested(meta.get('revision'));
		const revision = rec ? rec.value : null;
		if(revision !== expected){
			tx.abort();
			await done.catch(() => {});
			throw new CatalogConflict();
		}
		/** @type {Map<string, number>} */
		const positions = new Map();
		try{
			await new SaveTransaction(tx, this.keyRange).write(changes, positions);
		}catch(e){
			try{ tx.abort(); }catch(err){}
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
	 * @param {unknown} what
	 * @returns {Promise<number>}
	 */
	async setAside(what){
		const tx = this.db.transaction(CatalogDatabase.ALL_STORES, 'readwrite');
		const done = committed(tx);
		const meta = tx.objectStore('meta');
		const rec = await requested(meta.get('revision'));
		const next = (rec ? rec.value : 0) + 1;
		meta.put({key: 'unreadable', value: what, at: new Date().toISOString()});
		for(const store of CatalogRecords.STORE_NAMES) tx.objectStore(store).clear();
		meta.put({key: 'revision', value: next, savedAt: new Date().toISOString()});
		await done;
		return next;
	}

	close(){ this.db.close(); }
}
