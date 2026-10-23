// The service worker that makes the catalog installable as an app (on a phone, say) and usable offline.
// Every request goes to the network first, so a new version of the app shows up at once; the cached copy
// is only used when the network fails. The catalog itself lives in IndexedDB (store.js), not in files.
const CACHE = 'audiobook-catalog-v12';
const APP = ['./', 'index.html', 'books.html', 'book.html', 'import.html', 'duplicates.html', 'authors.html', 'narrators.html', 'publishers.html', 'author.html', 'narrator.html', 'publisher.html', 'styles.css', 'store.js', 'book-list.js',
	'series.js', 'books.js', 'book.js', 'combo-box.js', 'import.js', 'duplicates.js', 'authors.js', 'credits.js', 'narrators.js', 'publishers.js', 'credit.js', 'credit-kinds.js', 'author.js', 'narrator.js', 'publisher.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
	'modules/audible-importer.js', 'modules/contributor.js', 'modules/backup.js', 'modules/book.js', 'modules/catalog.js', 'modules/comparison.js',
	'modules/cover.js', 'modules/csv.js', 'modules/duplicates.js', 'modules/edition.js', 'modules/external-catalog.js', 'modules/exclusions.js', 'modules/goodreads-exporter.js',
	'modules/goodreads-importer.js', 'modules/hardcover-client.js', 'modules/hardcover-sync.js', 'modules/file-importer.js', 'modules/file-exporter.js', 'modules/isbn.js',
	'modules/merger.js', 'modules/series.js', 'modules/text.js', 'modules/validator.js', 'modules/catalog-records.js', 'modules/catalog-database.js', 'modules/catalog-lookup.js',
	'modules/catalog-client.js', 'modules/shelf-sync.js', 'modules/book-source.js', 'modules/catalog-connectors.js', 'modules/open-library-source.js',
	'modules/wikidata-source.js', 'modules/hardcover-source.js', 'modules/audible-source.js', 'modules/audiobookdb-source.js',
	'modules/audiobookdb-client.js', 'modules/audiobookdb-sync.js'];

// `self`, as what it is in a service worker (the type checker only knows it as a worker's).
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

sw.addEventListener('install', e=>{
	e.waitUntil(caches.open(CACHE).then(c=> c.addAll(APP)).then(()=> sw.skipWaiting()));
});

sw.addEventListener('activate', e=>{
	e.waitUntil(caches.keys()
		.then(keys=> Promise.all(keys.filter(k=> k !== CACHE).map(k=> caches.delete(k))))
		.then(()=> sw.clients.claim()));
});

/**
 * Whether a request may be answered from the cache: the app's own files. Only public/ is served, so the
 * old data/ files beside it are out of reach anyway; requests to Hardcover go straight to the network.
 * @param {Request} req
 * @returns {boolean}
 */
function cacheable(req){
	return req.method === 'GET' && new URL(req.url).origin === location.origin;
}

sw.addEventListener('fetch', e=>{
	const req = e.request;
	if(!cacheable(req)) return;
	e.respondWith(fetch(req).then(res=>{
		if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c=> c.put(req, copy)); }
		return res;
	}).catch(()=> caches.match(req, {ignoreSearch: true}).then(hit=> hit || Response.error())));
});
