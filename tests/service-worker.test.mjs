// The service worker (public/sw.js), run in Node with a fake network and cache: the app's files come from the cache,
// a new version is fetched whole, and on this computer the network goes first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'public');

/**
 * Starts sw.js at an address, with every file answered by the fake network and `caches` kept in a Map.
 * @param {{origin?: string, version?: string, stores?: Map<string, Map<string, Response>>}} [options]
 */
function start({origin = 'https://example.github.io', version = 'v1', stores = new Map()} = {}) {
	const base = `${origin}/app/`;
	const listeners = {};
	const asked = [];
	let online = true;
	const fetch = async request => {
		asked.push({url: request.url, cache: request.cache});
		if (!online) throw new TypeError('offline');
		return new Response(`fresh ${new URL(request.url).pathname}`);
	};
	const storeOf = name => {
		if (!stores.has(name)) stores.set(name, new Map());
		const kept = stores.get(name);
		return {
			match: async (request, {ignoreSearch} = {}) => {
				const url = new URL(request.url);
				if (ignoreSearch) url.search = '';
				return kept.get(url.href)?.clone();
			},
			put: async (request, response) => void kept.set(request.url, response),
			addAll: async requests => {
				for (const request of requests) kept.set(request.url, await fetch(request));
			},
		};
	};
	const caches = {
		open: async name => storeOf(name),
		keys: async () => [...stores.keys()],
		delete: async name => stores.delete(name),
	};
	const self = {
		addEventListener: (type, fn) => (listeners[type] = fn),
		skipWaiting: async () => {},
		clients: {claim: async () => {}},
	};
	const context = vm.createContext({
		self,
		caches,
		fetch,
		location: new URL(`${base}sw.js`),
		Request: class extends Request {
			constructor(url, init) {
				super(new URL(url, base), init);
			}
		},
		Response,
		URL,
		importScripts: file => {
			assert.equal(file, 'sw-app.js');
			self.APP_VERSION = version;
			self.APP_FILES = ['./', 'index.html', 'store.js', 'modules/book.js'];
		},
	});
	vm.runInContext(fs.readFileSync(path.join(site, 'sw.js'), 'utf8'), context);
	/** Runs an event's listener and waits for what it waits on. */
	const fire = async (type, request) => {
		let waited = Promise.resolve();
		let answer;
		listeners[type]({request, waitUntil: p => (waited = p), respondWith: p => (answer = p)});
		await waited;
		return answer && (await answer);
	};
	return {
		stores,
		asked,
		goOffline: () => (online = false),
		install: () => fire('install'),
		activate: () => fire('activate'),
		get: async file => {
			const res = await fire('fetch', new Request(new URL(file, base)));
			await new Promise(resolve => setImmediate(resolve)); // the copy is kept after answering
			return res && (await res.text());
		},
	};
}

test("the app's files come from the cache, past the browser's own cache when installing, without asking the network again", async () => {
	const sw = start();
	await sw.install();
	await sw.activate();
	assert.deepEqual([...sw.stores.keys()], ['audiobook-catalog-v1']);
	assert.deepEqual(
		sw.asked.map(a => [new URL(a.url).pathname, a.cache]),
		['/app/', '/app/index.html', '/app/store.js', '/app/modules/book.js'].map(file => [file, 'reload']),
	);
	const fetched = sw.asked.length;
	assert.equal(await sw.get('store.js'), 'fresh /app/store.js');
	assert.equal(await sw.get('index.html?x=1'), 'fresh /app/index.html');
	assert.equal(sw.asked.length, fetched);
	// a file the list lacks is fetched once, then kept
	assert.equal(await sw.get('api/index.html'), 'fresh /app/api/index.html');
	assert.equal(await sw.get('api/index.html'), 'fresh /app/api/index.html');
	assert.equal(sw.asked.length, fetched + 1);
	// another site's requests are left to the network
	assert.equal(await sw.get('https://api.hardcover.app/v1/graphql'), undefined);
});

test('a new version is fetched whole into a cache of its own, and the old one goes once it is active', async () => {
	const sw = start({version: 'v1'});
	await sw.install();
	await sw.activate();
	sw.stores.get('audiobook-catalog-v1').set('https://example.github.io/app/store.js', new Response('old store.js'));
	const next = start({version: 'v2', stores: sw.stores});
	await next.install();
	assert.deepEqual([...sw.stores.keys()], ['audiobook-catalog-v1', 'audiobook-catalog-v2']);
	await next.activate();
	assert.deepEqual([...sw.stores.keys()], ['audiobook-catalog-v2']);
	assert.equal(await next.get('store.js'), 'fresh /app/store.js');
});

test('on this computer the network goes first, and the cache answers offline', async () => {
	const sw = start({origin: 'http://127.0.0.1:8000'});
	await sw.install();
	await sw.activate();
	const fetched = sw.asked.length;
	assert.equal(await sw.get('store.js'), 'fresh /app/store.js');
	assert.equal(sw.asked.length, fetched + 1);
	sw.goOffline();
	assert.equal(await sw.get('store.js'), 'fresh /app/store.js');
});

test('make pages writes the files to cache, every file served but the API docs, and the version, a hash of them', () => {
	const written = fs.readFileSync(path.join(site, 'sw-app.js'), 'utf8');
	const files = fs
		.readdirSync(site, {recursive: true, encoding: 'utf8'})
		.map(f => f.split(path.sep).join('/'))
		.filter(
			f =>
				!['sw.js', 'sw-app.js'].includes(f) &&
				!f.startsWith('api/') &&
				fs.statSync(path.join(site, f)).isFile(),
		)
		.sort();
	assert.ok(files.includes('index.html') && files.includes('modules/book.js'));
	assert.deepEqual(JSON.parse(written.match(/APP_FILES = (\[.*\]);/)[1]), ['./', ...files]);
	const hash = crypto.createHash('sha256');
	for (const file of files) hash.update(`${file}\0`).update(fs.readFileSync(path.join(site, file)));
	assert.equal(written.match(/APP_VERSION = '(\w+)'/)[1], hash.digest('hex').slice(0, 16));
});
