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

/** The open database. */
export class CatalogDatabase {
	static NAME = 'audiobook-catalog';
	// Bump it, and add to upgrade(), whenever the stores or their indexes change.
	static VERSION = 1;
	/** @type {(StoreName | 'meta')[]} every store, the records' and meta */
	static ALL_STORES = [...CatalogRecords.STORE_NAMES, 'meta'];

	/** @param {IDBDatabase} db */
	constructor(db){
		this.db = db;
	}

	/**
	 * Open (and on first use, make) the database.
	 * @param {IDBFactory} factory the browser's indexedDB
	 * @param {string} [name]
	 * @returns {Promise<CatalogDatabase>}
	 */
	static open(factory, name = CatalogDatabase.NAME){
		return new Promise((resolve, reject) => {
			const req = factory.open(name, CatalogDatabase.VERSION);
			req.onupgradeneeded = () => CatalogDatabase.upgrade(req.result);
			req.onsuccess = () => {
				const db = req.result;
				// a newer version of the app, opened in another tab, needs this connection out of its way
				db.onversionchange = () => db.close();
				resolve(new CatalogDatabase(db));
			};
			req.onerror = () => reject(req.error);
			req.onblocked = () => reject(new Error('an older version of the app is open in another tab; close it'));
		});
	}

	/**
	 * Make the stores and indexes the database lacks.
	 * @param {IDBDatabase} db
	 */
	static upgrade(db){
		for(const store of CatalogRecords.STORE_NAMES){
			if(db.objectStoreNames.contains(store)) continue;
			const spec = CatalogRecords.STORES[store];
			const made = db.createObjectStore(store, {keyPath: spec.keyPath});
			for(const [index, keyPath, options] of spec.indexes) made.createIndex(index, keyPath, options);
		}
		if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath: 'key'});
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
