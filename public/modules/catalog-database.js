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

/** The open database. */
export class CatalogDatabase {
	static NAME = 'audiobook-catalog';
	// Bump it, and add to upgrade(), whenever the stores or their indexes change.
	// 2: the books' `hardcoverId` index became `externalKeys`, which series and contributors have too.
	static VERSION = 2;
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
			req.onupgradeneeded = () => CatalogDatabase.upgrade(req.result, /** @type {IDBTransaction} */ (req.transaction));
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
	 */
	static upgrade(db, tx){
		for(const store of CatalogRecords.STORE_NAMES){
			const spec = CatalogRecords.STORES[store];
			const os = db.objectStoreNames.contains(store) ? tx.objectStore(store) : db.createObjectStore(store, {keyPath: spec.keyPath});
			const wanted = spec.indexes.map(([index]) => index);
			for(const index of [...os.indexNames]) if(!wanted.includes(index)) os.deleteIndex(index);
			for(const [index, keyPath, options] of spec.indexes) if(!os.indexNames.contains(index)) os.createIndex(index, keyPath, options);
		}
		if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath: 'key'});
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
	 * saved yet); returns the new revision. Throws a CatalogConflict when another tab saved meanwhile, and
	 * then writes nothing.
	 * @param {Changes} changes
	 * @param {number | null} expected
	 * @returns {Promise<number>}
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
		for(const store of CatalogRecords.STORE_NAMES){
			const os = tx.objectStore(store);
			for(const key of changes.delete[store] || []) os.delete(key);
			for(const value of changes.put[store] || []) os.put(value);
		}
		const next = (revision || 0) + 1;
		meta.put({key: 'revision', value: next, savedAt: new Date().toISOString()});
		await done;
		return next;
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
