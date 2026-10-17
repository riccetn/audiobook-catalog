// A small in-memory IndexedDB for the tests (no npm packages): databases with object stores under a key
// path, indexes (compound and multiEntry, unique ones refusing a second record), key ranges, getAll with
// a count, transactions that commit once their requests are done and roll back when aborted. Requests
// complete asynchronously, one at a time in the order they were made, as in a browser. It does what the
// app and its tests use, and throws on anything else rather than doing it wrongly.

// Key order: numbers, then dates, then strings, then arrays (element by element).
const typeRank = key => typeof key === 'number' ? 1 : key instanceof Date ? 2 : typeof key === 'string' ? 3 : Array.isArray(key) ? 5 : 0;

export function cmp(x, y) {
	const tx = typeRank(x), ty = typeRank(y);
	if (!tx || !ty) throw new DOMException('not a valid key', 'DataError');
	if (tx !== ty) return tx - ty;
	if (tx === 5) {
		for (let i = 0; i < Math.min(x.length, y.length); i++) {
			const c = cmp(x[i], y[i]);
			if (c) return c;
		}
		return x.length - y.length;
	}
	const a = tx === 2 ? x.getTime() : x, b = ty === 2 ? y.getTime() : y;
	return a < b ? -1 : a > b ? 1 : 0;
}

const validKey = key => {
	if (typeof key === 'number') return !Number.isNaN(key);
	if (typeof key === 'string') return true;
	if (key instanceof Date) return !Number.isNaN(key.getTime());
	if (Array.isArray(key)) return key.every(validKey);
	return false;
};

// The key at a key path in a value, or undefined when it has none (or not a valid one).
function keyAt(value, keyPath) {
	if (Array.isArray(keyPath)) {
		const parts = keyPath.map(p => keyAt(value, p));
		return parts.every(p => p !== undefined) ? parts : undefined;
	}
	let v = value;
	for (const part of keyPath.split('.')) v = v !== null && typeof v === 'object' ? v[part] : undefined;
	return validKey(v) ? v : undefined;
}

// The keys a record has in an index: none, one, or (multiEntry) one per valid value of a list.
function indexKeys(value, { keyPath, multiEntry }) {
	if (multiEntry && !Array.isArray(keyPath)) {
		let v = value;
		for (const part of keyPath.split('.')) v = v !== null && typeof v === 'object' ? v[part] : undefined;
		if (Array.isArray(v)) {
			const keys = [];
			for (const k of v.filter(validKey)) if (!keys.some(x => cmp(x, k) === 0)) keys.push(k);
			return keys;
		}
	}
	const key = keyAt(value, keyPath);
	return key === undefined ? [] : [key];
}

export class FakeKeyRange {
	constructor(lower, upper, lowerOpen = false, upperOpen = false) {
		Object.assign(this, { lower, upper, lowerOpen, upperOpen });
	}
	static only(key) { return new FakeKeyRange(key, key); }
	static lowerBound(key, open = false) { return new FakeKeyRange(key, undefined, open, true); }
	static upperBound(key, open = false) { return new FakeKeyRange(undefined, key, true, open); }
	static bound(lower, upper, lowerOpen = false, upperOpen = false) { return new FakeKeyRange(lower, upper, lowerOpen, upperOpen); }
	includes(key) {
		if (this.lower !== undefined) { const c = cmp(key, this.lower); if (c < 0 || (c === 0 && this.lowerOpen)) return false; }
		if (this.upper !== undefined) { const c = cmp(key, this.upper); if (c > 0 || (c === 0 && this.upperOpen)) return false; }
		return true;
	}
}
const inRange = (query, key) => query === undefined || query === null ? true : query instanceof FakeKeyRange ? query.includes(key) : cmp(query, key) === 0;

class FakeRequest {
	constructor(source, transaction) {
		Object.assign(this, { source, transaction, result: undefined, error: null, readyState: 'pending', onsuccess: null, onerror: null });
	}
}

class FakeIndex {
	constructor(store, name) { this.objectStore = store; this.name = name; }
	get spec() { return this.objectStore.data.indexes.get(this.name); }
	get keyPath() { return this.spec.keyPath; }
	get multiEntry() { return this.spec.multiEntry; }
	get unique() { return this.spec.unique; }
	// [indexKey, primaryKey, value] in index order
	entries(query) {
		const out = [];
		for (const { key, value } of this.objectStore.data.records.values()) {
			for (const k of indexKeys(value, this.spec)) if (inRange(query, k)) out.push([k, key, value]);
		}
		return out.sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]));
	}
	getAll(query, count) {
		return this.objectStore.transaction.request(this, () => this.entries(query).slice(0, count || undefined).map(e => structuredClone(e[2])));
	}
	get(query) { return this.objectStore.transaction.request(this, () => { const e = this.entries(query)[0]; return e ? structuredClone(e[2]) : undefined; }); }
	count(query) { return this.objectStore.transaction.request(this, () => this.entries(query).length); }
}

class FakeObjectStore {
	constructor(transaction, name) {
		this.transaction = transaction;
		this.name = name;
		this.data = transaction.db.data.stores.get(name);
		if (!this.data) throw new DOMException(`no object store ${name}`, 'NotFoundError');
	}
	get keyPath() { return this.data.keyPath; }
	get indexNames() { return names([...this.data.indexes.keys()]); }
	entries(query) {
		return [...this.data.records.values()].filter(r => inRange(query, r.key)).sort((x, y) => cmp(x.key, y.key));
	}
	writable() { if (this.transaction.mode === 'readonly') throw new DOMException('the transaction is read-only', 'ReadOnlyError'); }
	get(query) { return this.transaction.request(this, () => { const r = this.entries(query)[0]; return r ? structuredClone(r.value) : undefined; }); }
	getAll(query, count) { return this.transaction.request(this, () => this.entries(query).slice(0, count || undefined).map(r => structuredClone(r.value))); }
	count(query) { return this.transaction.request(this, () => this.entries(query).length); }
	put(value) {
		this.writable();
		const copy = structuredClone(value);
		const key = keyAt(copy, this.data.keyPath);
		if (key === undefined) throw new DOMException('the value has no valid key at the key path', 'DataError');
		return this.transaction.request(this, () => {
			const id = JSON.stringify(key);
			for (const [name, spec] of this.data.indexes) {
				if (!spec.unique) continue;
				for (const k of indexKeys(copy, spec)) {
					for (const [other, r] of this.data.records) {
						if (other !== id && indexKeys(r.value, spec).some(x => cmp(x, k) === 0)) {
							throw new DOMException(`index ${name} already has ${JSON.stringify(k)}`, 'ConstraintError');
						}
					}
				}
			}
			this.data.records.set(id, { key, value: copy });
			return key;
		});
	}
	delete(query) {
		this.writable();
		return this.transaction.request(this, () => {
			for (const r of this.entries(query)) this.data.records.delete(JSON.stringify(r.key));
			return undefined;
		});
	}
	clear() {
		this.writable();
		return this.transaction.request(this, () => { this.data.records.clear(); return undefined; });
	}
	index(name) {
		if (!this.data.indexes.has(name)) throw new DOMException(`no index ${name}`, 'NotFoundError');
		return new FakeIndex(this, name);
	}
	createIndex(name, keyPath, { unique = false, multiEntry = false } = {}) {
		if (this.transaction.mode !== 'versionchange') throw new DOMException('indexes are made in an upgrade', 'InvalidStateError');
		if (Array.isArray(keyPath) && multiEntry) throw new DOMException('a multiEntry index has one key path', 'InvalidAccessError');
		this.data.indexes.set(name, { keyPath, unique, multiEntry });
		return new FakeIndex(this, name);
	}
	deleteIndex(name) {
		if (this.transaction.mode !== 'versionchange') throw new DOMException('indexes are removed in an upgrade', 'InvalidStateError');
		if (!this.data.indexes.has(name)) throw new DOMException(`no index ${name}`, 'NotFoundError');
		this.data.indexes.delete(name);
	}
}

const names = list => Object.assign([...list].sort(), { contains: n => list.includes(n), item: i => [...list].sort()[i] ?? null });

class FakeTransaction {
	constructor(db, storeNames, mode) {
		this.db = db;
		this.mode = mode;
		this.storeNames = storeNames;
		this.error = null;
		this.oncomplete = this.onabort = this.onerror = null;
		this.queue = [];
		this.finished = false;
		this.running = false;
		// what to put back if it is aborted
		this.before = mode === 'readonly' ? null : new Map([...db.data.stores].map(([n, s]) => [n, new Map(s.records)]));
		this.beforeStores = mode === 'versionchange' ? new Map(db.data.stores) : null;
		this.next();
	}
	objectStore(name) {
		if (this.finished) throw new DOMException('the transaction has finished', 'InvalidStateError');
		// an upgrade reaches every store there is
		const known = this.mode === 'versionchange' ? this.db.data.stores.has(name) : this.storeNames.includes(name);
		if (!known) throw new DOMException(`${name} is not in this transaction`, 'NotFoundError');
		return new FakeObjectStore(this, name);
	}
	request(source, run) {
		if (this.finished) throw new DOMException('the transaction has finished', 'TransactionInactiveError');
		const req = new FakeRequest(source, this);
		this.queue.push([req, run]);
		this.next();
		return req;
	}
	// Run the next request on a later turn; with none left after its callbacks (and what they await), commit.
	next() {
		if (this.running) return;
		this.running = true;
		setImmediate(() => {
			this.running = false;
			if (this.finished) return;
			const item = this.queue.shift();
			if (!item) { this.commit(); return; }
			const [req, run] = item;
			try {
				req.result = run();
				req.readyState = 'done';
				if (req.onsuccess) req.onsuccess({ target: req, type: 'success' });
			} catch (error) {
				req.error = error;
				req.readyState = 'done';
				if (req.onerror) req.onerror({ target: req, type: 'error' });
				if (this.onerror) this.onerror({ target: req, type: 'error' });
				this.abort(error);
				return;
			}
			this.next();
		});
	}
	commit() {
		this.finished = true;
		if (this.oncomplete) this.oncomplete({ target: this, type: 'complete' });
	}
	abort(error) {
		if (this.finished) throw new DOMException('the transaction has finished', 'InvalidStateError');
		this.finished = true;
		this.error = error || new DOMException('the transaction was aborted', 'AbortError');
		if (this.beforeStores) this.db.data.stores = this.beforeStores;
		if (this.before) for (const [n, records] of this.before) { const s = this.db.data.stores.get(n); if (s) s.records = records; }
		setImmediate(() => { if (this.onabort) this.onabort({ target: this, type: 'abort' }); });
	}
}

class FakeDatabase {
	constructor(data, name) {
		this.data = data;
		this.name = name;
		this.closed = false;
		this.onversionchange = null;
		this.upgrading = null;
	}
	get version() { return this.data.version; }
	get objectStoreNames() { return names([...this.data.stores.keys()]); }
	createObjectStore(name, { keyPath } = {}) {
		if (!this.upgrading) throw new DOMException('stores are made in an upgrade', 'InvalidStateError');
		if (keyPath === undefined) throw new Error('the fake only does stores with a key path');
		this.data.stores.set(name, { keyPath, indexes: new Map(), records: new Map() });
		this.upgrading.storeNames.push(name);
		return new FakeObjectStore(this.upgrading, name);
	}
	transaction(storeNames, mode = 'readonly') {
		if (this.closed) throw new DOMException('the database is closed', 'InvalidStateError');
		const list = Array.isArray(storeNames) ? storeNames : [storeNames];
		for (const n of list) if (!this.data.stores.has(n)) throw new DOMException(`no object store ${n}`, 'NotFoundError');
		return new FakeTransaction(this, list, mode);
	}
	close() { this.closed = true; }
}

/** The fake indexedDB: what a page gets as `indexedDB`. Pass one to several pages for tabs of one browser. */
export class FakeIndexedDB {
	constructor() {
		this.data = new Map();   // name -> {version, stores: Map}
		this.broken = false;     // true: opening fails, as in a browser that keeps no databases
	}
	open(name, version = 1) {
		const req = new FakeRequest(null, null);
		req.onupgradeneeded = req.onblocked = null;
		setImmediate(() => {
			if (this.broken) {
				req.error = new DOMException('IndexedDB is not available', 'UnknownError');
				if (req.onerror) req.onerror({ target: req, type: 'error' });
				return;
			}
			let data = this.data.get(name);
			if (!data) this.data.set(name, data = { version: 0, stores: new Map() });
			if (version < data.version) {
				req.error = new DOMException('the database is newer than asked for', 'VersionError');
				if (req.onerror) req.onerror({ target: req, type: 'error' });
				return;
			}
			const db = new FakeDatabase(data, name);
			req.result = db;
			const succeed = () => { req.readyState = 'done'; if (req.onsuccess) req.onsuccess({ target: req, type: 'success' }); };
			if (version === data.version) { succeed(); return; }
			const oldVersion = data.version;
			const tx = new FakeTransaction(db, [], 'versionchange');
			db.upgrading = tx;
			req.transaction = tx;
			data.version = version;
			tx.oncomplete = () => { db.upgrading = null; req.transaction = null; succeed(); };
			try {
				if (req.onupgradeneeded) req.onupgradeneeded({ target: req, type: 'upgradeneeded', oldVersion, newVersion: version });
			} catch (error) {
				data.version = oldVersion;
				tx.abort(error);
				req.error = error;
				if (req.onerror) req.onerror({ target: req, type: 'error' });
			}
		});
		return req;
	}
	/** What a store holds now, as plain values in key order (for tests to look at). */
	records(store, name = 'audiobook-catalog') {
		const data = this.data.get(name);
		const s = data && data.stores.get(store);
		return s ? [...s.records.values()].sort((x, y) => cmp(x.key, y.key)).map(r => structuredClone(r.value)) : [];
	}
}
