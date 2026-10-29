// The service worker that makes the catalog installable as an app (on a phone, say) and usable offline.
// The app's files are answered from the cache, without asking the network. sw-app.js, which make pages
// writes, lists them (every file in public/) with a hash of them all, so a deploy changes it; the browser checks it at each start,
// and a new version is fetched whole into a cache of its own in the background and shown from the next start
// on (one version at a time, so a page never mixes an old module with a new one). On this computer (make serve)
// the network goes first instead, so an edit shows at once. The catalog itself lives in IndexedDB (store.ts), not in files.
importScripts('sw-app.js');

// `self`, as what it is in a service worker (the type checker only knows it as a worker's), with the files and
// version sw-app.js set.
const sw = self as unknown as ServiceWorkerGlobalScope & {APP_VERSION: string; APP_FILES: string[]};

const CACHE = `audiobook-catalog-${sw.APP_VERSION}`;
const APP = sw.APP_FILES;
// What the app's server answers when it serves the app too (server/worker.ts): its catalog proxy and sync, which
// are never cached (a synced copy kept here would hide the other devices' changes). sw.js is in the app's folder.
const SERVER_PATHS = ['ping', 'sync'].map(route => new URL(route, location.href).pathname);
const PROXY_PATH = new URL('proxy/', location.href).pathname;

// Served from this computer (make serve), where the files change without a deploy.
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

sw.addEventListener('install', e => {
	e.waitUntil(
		caches
			.open(CACHE)
			// Past the browser's own cache, which may still hold the version before.
			.then(c =>
				Promise.all(
					APP.map(file => {
						const req = new Request(file, {cache: 'reload'});
						return fetch(req).then(res => {
							// all or nothing, as addAll would: a version missing a file is never used
							if (!res.ok) throw new Error(`${file}: ${res.status}`);
							return unredirected(res).then(plain => c.put(req, plain));
						});
					}),
				),
			)
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
 * old data/ files beside it are out of reach anyway; requests to Hardcover, and to the app's server, go
 * straight to the network.
 */
function cacheable(req: Request): boolean {
	const url = new URL(req.url);
	if (req.method !== 'GET' || url.origin !== location.origin) return false;
	return !SERVER_PATHS.includes(url.pathname) && !url.pathname.startsWith(PROXY_PATH);
}

/**
 * A response as a page may be given it. One the network reached through a redirect (a host that drops `.html` from
 * addresses, as Cloudflare's assets did) can't answer a page's navigation: Chrome refuses it ("a redirected response
 * was used for a request whose redirect mode is not follow"), so it is copied into a response of its own.
 */
function unredirected(res: Response): Promise<Response> {
	if (!res.redirected) return Promise.resolve(res);
	return res
		.blob()
		.then(body => new Response(body, {status: res.status, statusText: res.statusText, headers: res.headers}));
}

/**
 * Fetches a request and keeps a copy in the cache when it was answered.
 */
function fetchAndKeep(req: Request): Promise<Response> {
	return fetch(req)
		.then(unredirected)
		.then(res => {
			if (res.ok) {
				const copy = res.clone();
				caches.open(CACHE).then(c => c.put(req, copy));
			}
			return res;
		});
}

/**
 * The cached copy of a request (the app's files are cached without their query), if any.
 */
function cached(req: Request): Promise<Response | undefined> {
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
