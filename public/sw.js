// The service worker that makes the catalog installable as an app (on a phone, say) and usable offline.
// The app's files are answered from the cache, without asking the network. sw-app.js, which make pages
// writes, lists them (every file in public/) with a hash of them all, so a deploy changes it; the browser checks it at each start,
// and a new version is fetched whole into a cache of its own in the background and shown from the next start
// on (one version at a time, so a page never mixes an old module with a new one). On this computer (make serve)
// the network goes first instead, so an edit shows at once. The catalog itself lives in IndexedDB (store.js), not in files.
importScripts('sw-app.js');

// `self`, as what it is in a service worker (the type checker only knows it as a worker's), with the files and
// version sw-app.js set.
const sw = /** @type {ServiceWorkerGlobalScope & {APP_VERSION: string, APP_FILES: string[]}} */ (
	/** @type {unknown} */ (self)
);

const CACHE = `audiobook-catalog-${sw.APP_VERSION}`;
const APP = sw.APP_FILES;

// Served from this computer (make serve), where the files change without a deploy.
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

sw.addEventListener('install', e => {
	e.waitUntil(
		caches
			.open(CACHE)
			// Past the browser's own cache, which may still hold the version before.
			.then(c => c.addAll(APP.map(file => new Request(file, {cache: 'reload'}))))
			.then(() => sw.skipWaiting()),
	);
});

sw.addEventListener('activate', e => {
	e.waitUntil(
		caches
			.keys()
			.then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
			.then(() => sw.clients.claim()),
	);
});

/**
 * Whether a request may be answered from the cache: the app's own files. Only public/ is served, so the
 * old data/ files beside it are out of reach anyway; requests to Hardcover go straight to the network.
 * @param {Request} req
 * @returns {boolean}
 */
function cacheable(req) {
	return req.method === 'GET' && new URL(req.url).origin === location.origin;
}

/**
 * Fetches a request and keeps a copy in the cache when it was answered.
 * @param {Request} req
 * @returns {Promise<Response>}
 */
function fetchAndKeep(req) {
	return fetch(req).then(res => {
		if (res.ok) {
			const copy = res.clone();
			caches.open(CACHE).then(c => c.put(req, copy));
		}
		return res;
	});
}

/**
 * The cached copy of a request (the app's files are cached without their query), if any.
 * @param {Request} req
 * @returns {Promise<Response | undefined>}
 */
function cached(req) {
	return caches.open(CACHE).then(c => c.match(req, {ignoreSearch: true}));
}

sw.addEventListener('fetch', e => {
	const req = e.request;
	if (!cacheable(req)) return;
	e.respondWith(
		LOCAL
			? fetchAndKeep(req).catch(() => cached(req).then(hit => hit || Response.error()))
			: cached(req).then(hit => hit || fetchAndKeep(req)),
	);
});
