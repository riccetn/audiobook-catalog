// The service worker that makes the catalog installable as an app (on a phone, say) and usable offline.
// The app's files are answered from the cache, without asking the network. sw-version.js, which make pages
// writes, holds a hash of everything served, so a deploy changes it; the browser checks it at each start,
// and a new version is fetched whole into a cache of its own in the background and shown from the next start
// on (one version at a time, so a page never mixes an old module with a new one). On this computer (make serve)
// the network goes first instead, so an edit shows at once. The catalog itself lives in IndexedDB (store.js), not in files.
importScripts('sw-version.js');

// `self`, as what it is in a service worker (the type checker only knows it as a worker's), with the version
// sw-version.js set.
const sw = /** @type {ServiceWorkerGlobalScope & {APP_VERSION: string}} */ (/** @type {unknown} */ (self));

const CACHE = `audiobook-catalog-${sw.APP_VERSION}`;
const APP = [
	'./',
	'index.html',
	'books.html',
	'book.html',
	'import.html',
	'duplicates.html',
	'authors.html',
	'narrators.html',
	'publishers.html',
	'author.html',
	'narrator.html',
	'publisher.html',
	'styles.css',
	'store.js',
	'book-list.js',
	'series.js',
	'books.js',
	'book.js',
	'combo-box.js',
	'import.js',
	'duplicates.js',
	'authors.js',
	'credits.js',
	'narrators.js',
	'publishers.js',
	'credit.js',
	'credit-kinds.js',
	'author.js',
	'narrator.js',
	'publisher.js',
	'manifest.webmanifest',
	'icons/icon.svg',
	'icons/icon-192.png',
	'icons/icon-512.png',
	'modules/audible-importer.js',
	'modules/contributor.js',
	'modules/backup.js',
	'modules/backup-v1.js',
	'modules/book.js',
	'modules/catalog.js',
	'modules/comparison.js',
	'modules/cover.js',
	'modules/csv.js',
	'modules/duplicates.js',
	'modules/edition.js',
	'modules/external-catalog.js',
	'modules/exclusions.js',
	'modules/goodreads-exporter.js',
	'modules/goodreads-importer.js',
	'modules/hardcover-client.js',
	'modules/hardcover-sync.js',
	'modules/file-importer.js',
	'modules/file-exporter.js',
	'modules/isbn.js',
	'modules/merger.js',
	'modules/series.js',
	'modules/text.js',
	'modules/validator.js',
	'modules/catalog-records.js',
	'modules/catalog-database.js',
	'modules/catalog-lookup.js',
	'modules/catalog-client.js',
	'modules/shelf-sync.js',
	'modules/book-source.js',
	'modules/catalog-connectors.js',
	'modules/open-library-source.js',
	'modules/wikidata-source.js',
	'modules/hardcover-source.js',
	'modules/audible-source.js',
	'modules/audiobookdb-source.js',
	'modules/audiobookdb-client.js',
	'modules/audiobookdb-sync.js',
];

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
