// The service worker (public/sw.js), run in Node with a fake network and cache: the app's files come from the cache,
// a new version is fetched whole, and on this computer the network goes first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {compiledBefore} from '../build.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'public');

/**
 * Starts sw.js at an address, with every file answered by the fake network and `caches` kept in a Map.
 * `waiting` is the new version's worker, waiting to take over, and `open` the pages of the app this one has.
 * @param {{origin?: string, version?: string, stores?: Map<string, Map<string, Response>>, redirects?: boolean, waiting?: object, open?: number}} [options]
 */
function start({
	origin = 'https://example.github.io',
	version = 'v1',
	stores = new Map(),
	redirects = false,
	waiting = null,
	open = 1,
} = {}) {
	const base = `${origin}/app/`;
	const listeners = {};
	const asked = [];
	let online = true;
	const fetch = async request => {
		asked.push({url: request.url, cache: request.cache});
		if (!online) throw new TypeError('offline');
		const res = new Response(`fresh ${new URL(request.url).pathname}`, {headers: {'Content-Type': 'text/html'}});
		// a host that drops .html from addresses (Cloudflare's assets by default) answers through a redirect
		if (redirects) Object.defineProperty(res, 'redirected', {value: true});
		return res;
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
	let skipped = 0;
	const self = {
		addEventListener: (type, fn) => (listeners[type] = fn),
		skipWaiting: async () => void skipped++,
		registration: {waiting},
		clients: {
			claim: async () => assert.fail('a new version waits until no page of the old one is open'),
			matchAll: async ({type}) => (assert.equal(type, 'window'), Array.from({length: open}, () => ({}))),
		},
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
			assert.match(file, /^sw-app\.js(\?v=\w+)?$/);
			self.APP_VERSION = version;
			self.APP_FILES = ['./', 'index.html', 'store.js', 'modules/book.js'];
		},
	});
	vm.runInContext(fs.readFileSync(path.join(site, 'sw.js'), 'utf8'), context);
	/** Runs an event's listener and waits for what it waits on. */
	const fire = async (type, request, data) => {
		let waited = Promise.resolve();
		let answer;
		listeners[type]({request, data, waitUntil: p => (waited = p), respondWith: p => (answer = p)});
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
		answer: file => fire('fetch', new Request(new URL(file, base))),
		/** A page's navigation to a file (a Request made with mode 'navigate' can't be built, so it is said). */
		navigate: file => {
			const request = new Request(new URL(file, base));
			Object.defineProperty(request, 'mode', {value: 'navigate'});
			return fire('fetch', request);
		},
		message: data => fire('message', undefined, data),
		skipped: () => skipped,
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
	// another site's requests are left to the network, and so are the app's server's when it serves the app too
	assert.equal(await sw.get('https://api.hardcover.app/v1/graphql'), undefined);
	for (const route of ['sync', 'ping', 'proxy/audiobookdb/books/FAKEbook0001'])
		assert.equal(await sw.get(route), undefined, route);
	assert.equal(sw.asked.length, fetched + 1);
});

test("a new version is fetched whole into a cache of its own, and the app's old one goes once it is active", async () => {
	const sw = start({version: 'v1'});
	await sw.install();
	await sw.activate();
	sw.stores.get('audiobook-catalog-v1').set('https://example.github.io/app/store.js', new Response('old store.js'));
	// another app on the same origin (an account's github.io) keeps its caches
	sw.stores.set('other-app-v7', new Map());
	const next = start({version: 'v2', stores: sw.stores});
	await next.install();
	assert.deepEqual([...sw.stores.keys()], ['audiobook-catalog-v1', 'other-app-v7', 'audiobook-catalog-v2']);
	await next.activate();
	assert.deepEqual([...sw.stores.keys()], ['other-app-v7', 'audiobook-catalog-v2']);
	assert.equal(await next.get('store.js'), 'fresh /app/store.js');
});

test("a new version waiting takes over on a page's navigation when no other page of the app is open", async () => {
	const told = [];
	const waiting = {postMessage: message => told.push(message)};
	for (const open of [0, 1]) {
		const sw = start({waiting, open});
		await sw.install();
		await sw.activate();
		const res = await sw.navigate('books.html');
		assert.equal(res.headers.get('Refresh'), '0', 'the page loads again, from the new version');
		assert.equal(await res.text(), '');
	}
	assert.deepEqual(told, ['skipWaiting', 'skipWaiting']);
	// with another page open, the old version still answers, as that page may import a module later
	const sw = start({waiting, open: 2});
	await sw.install();
	await sw.activate();
	const res = await sw.navigate('books.html');
	assert.equal(res.headers.get('Refresh'), null);
	assert.equal(await res.text(), 'fresh /app/books.html');
	assert.equal(told.length, 2);
	// nothing waiting: the page as cached; and a module never hands over, only a page's navigation
	const alone = start();
	await alone.install();
	assert.equal(await (await alone.navigate('books.html')).text(), 'fresh /app/books.html');
	const busy = start({waiting, open: 1});
	await busy.install();
	assert.equal(await busy.get('store.js'), 'fresh /app/store.js');
	assert.equal(told.length, 2);
	// the waiting version, told, takes over
	assert.equal(busy.skipped(), 0);
	await busy.message('skipWaiting');
	await busy.message('something else');
	assert.equal(busy.skipped(), 1);
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

test('make pages clears the scripts it compiled before, never the vendored library or the API docs beside them', () => {
	for (const file of ['store.js', 'store.js.map', 'modules/book.js', 'modules/book.js.map', 'sw.js', 'sw-app.js'])
		assert.equal(compiledBefore(file), true, file);
	// the server's workflow writes the API docs into public/api/ before its deploy builds again
	for (const file of ['api/assets/main.js', 'api/assets/search.js', 'vendor/qrcode.mjs', 'vendor/qrcode.js'])
		assert.equal(compiledBefore(file), false, file);
	for (const file of ['index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg'])
		assert.equal(compiledBefore(file), false, file);
});

test('make pages writes the files to cache, every file served but the source maps and the API docs, and the version, a hash of them', () => {
	const written = fs.readFileSync(path.join(site, 'sw-app.js'), 'utf8');
	const files = fs
		.readdirSync(site, {recursive: true, encoding: 'utf8'})
		.map(f => f.split(path.sep).join('/'))
		.filter(
			f =>
				!['sw.js', 'sw-app.js'].includes(f) &&
				!f.startsWith('api/') &&
				!f.endsWith('.map') &&
				fs.statSync(path.join(site, f)).isFile(),
		)
		.sort();
	assert.ok(files.includes('index.html') && files.includes('modules/book.js'));
	assert.deepEqual(JSON.parse(written.match(/APP_FILES = (\[.*\]);/)[1]), ['./', ...files]);
	const hash = crypto.createHash('sha256');
	for (const file of files) hash.update(`${file}\0`).update(fs.readFileSync(path.join(site, file)));
	const version = hash.digest('hex').slice(0, 16);
	assert.equal(written.match(/APP_VERSION = '(\w+)'/)[1], version);
	// in sw.js too, so the browser sees a new version by sw.js alone
	assert.ok(fs.readFileSync(path.join(site, 'sw.js'), 'utf8').includes(`importScripts('sw-app.js?v=${version}');`));
});

test('an answer reached through a redirect is copied, as Chrome refuses a redirected page', async () => {
	const sw = start({redirects: true});
	await sw.install();
	for (const kept of sw.stores.get('audiobook-catalog-v1').values()) assert.equal(kept.redirected, false);
	const page = await sw.answer('index.html');
	assert.equal(page.redirected, false);
	assert.equal(await page.text(), 'fresh /app/index.html');
	assert.equal(page.headers.get('Content-Type'), 'text/html');
	const fresh = await sw.answer('api/index.html');
	assert.equal(fresh.redirected, false, 'fetched now, too');
	assert.equal(await fresh.text(), 'fresh /app/api/index.html');
});
