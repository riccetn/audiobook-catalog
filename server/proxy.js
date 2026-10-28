// The catalog proxy: asks, for the app's pages, the catalogs whose APIs don't answer web pages (no CORS headers).
// It is not an open proxy: a request names a catalog from CATALOGS, never an address, so it can only reach those
// APIs, and only with GET, but for the few paths a catalog lists as needing your account there (`keyed`).
// Answers are cached for a day, to be gentle with small catalogs, but never those of a keyed path.
// It keeps no account key: one the page sends (CATALOG_KEY_HEADER) is passed on to the catalog's keyed paths
// only, and refused anywhere else. It never sees the Hardcover token: Hardcover answers pages itself.
// The server (worker.js) checks the origin and the server key before a request gets here.
import {jsonResponse} from './responses.js';

/**
 * What the proxy uses from outside, so the tests run it offline: the fetch to the catalogs, and the cache
 * (Cloudflare's `caches.default`, or the local server's), with `later` to finish putting into it after answering.
 * @typedef {{fetch: (request: Request) => Promise<Response>, cache?: Cache | null, later?: (task: Promise<unknown>) => void}} ProxyDeps
 */
/**
 * A path of a catalog's API that acts for your account there: the method it takes, and the path (after the
 * route's base, without the query) it matches. Only these get your account key, and only these take a POST.
 * @typedef {{method: 'GET' | 'POST', path: RegExp}} KeyedPath
 */
/**
 * A catalog the proxy asks: the API address its routes go under, given the route's first part when the
 * catalog has sites (Audible), and the start a path must have, so only its public catalog API is reached;
 * with `keyed`, the paths that act for your account, and the header the catalog reads its key from.
 * @typedef {{base: (site: string) => string | null, sites?: boolean, paths?: RegExp, keyed?: KeyedPath[], keyHeader?: string}} Route
 */
/** @typedef {{href: string, rest: string, route: Route}} Upstream the catalog's address a request asks for, its path in the API, and its route */

const AUDIBLE_SITES = [
	'audible.com',
	'audible.co.uk',
	'audible.de',
	'audible.fr',
	'audible.it',
	'audible.es',
	'audible.ca',
	'audible.com.au',
	'audible.in',
	'audible.co.jp',
];

/** @type {Record<string, Route>} */
export const CATALOGS = {
	// AudiobookDB's public API (audiobookdb.org/docs): /proxy/audiobookdb/audiobooks/external/audible/<ASIN>
	// With your API key (X-API-Key) for who you are, your shelves, and putting a book on one; nothing else
	// gets the key, and nothing else may be sent.
	audiobookdb: {
		base: () => 'https://audiobookdb.org/api/',
		keyHeader: 'X-API-Key',
		keyed: [
			{method: 'GET', path: /^auth\/session$/},
			{method: 'GET', path: /^users\/username\/[^/]+\/shelves(\/[^/]+)?$/},
			{method: 'POST', path: /^users\/username\/[^/]+\/shelves\/[^/]+\/books$/},
		],
	},
	// Audible's catalog API, which needs no account: /proxy/audible/audible.co.uk/catalog/products/<ASIN>?response_groups=...
	audible: {
		base: site => (AUDIBLE_SITES.includes(site) ? `https://api.${site}/1.0/` : null),
		sites: true,
		paths: /^catalog\//,
	},
	// BookBrainz's API: /proxy/bookbrainz/edition/<bbid>
	bookbrainz: {base: () => 'https://api.bookbrainz.org/1/'},
	// ISFDB's REST API (cgi-bin/rest): /proxy/isfdb/getpub.cgi?<ISBN>
	isfdb: {base: () => 'https://www.isfdb.org/cgi-bin/rest/'},
};

// The header the page puts your key for a catalog in (AudiobookDB's API key), sent on by the route's keyHeader.
export const CATALOG_KEY_HEADER = 'X-Catalog-Key';
// A body sent on (putting a book on a shelf) is a few dozen bytes; anything much bigger isn't the app's.
const MAX_BODY = 16 * 1024;
const CACHE_SECONDS = 24 * 60 * 60;
const USER_AGENT = 'audiobook-catalog-proxy (+https://github.com/riccetn/audiobook-catalog)';
// The request headers passed on to a catalog; nothing else (cookies, the keys) leaves the server.
const PASSED_HEADERS = ['accept', 'accept-language'];

/**
 * The catalog's address a proxy path (after `/proxy`) asks for, or null when it names no catalog or leaves its API.
 * `/audible/audible.de/catalog/products/B0X`, `?x=1` → `https://api.audible.de/1.0/catalog/products/B0X?x=1`.
 * @param {string} path
 * @param {string} [search] the query, with its `?`
 * @returns {string | null}
 */
export function upstreamUrl(path, search = '') {
	return upstream(path, search)?.href ?? null;
}

/**
 * The keyed path of its catalog a request asks for, or null when it acts for no account.
 * @param {Upstream} up
 * @param {string} method
 * @returns {KeyedPath | null}
 */
export function keyedPath(up, method) {
	return (up.route.keyed || []).find(k => k.method === method && k.path.test(up.rest)) || null;
}

/**
 * @param {string} path
 * @param {string} search
 * @returns {Upstream | null}
 */
function upstream(path, search) {
	const parts = path.split('/').slice(1);
	const route = Object.hasOwn(CATALOGS, parts[0]) ? CATALOGS[parts[0]] : null;
	if (!route) return null;
	const base = route.base(route.sites ? parts[1] || '' : '');
	const rest = parts.slice(route.sites ? 2 : 1).join('/');
	if (!base || !rest || rest.split('/').some(p => !p || /^(\.|%2e){1,2}$/i.test(p))) return null;
	if (route.paths && !route.paths.test(rest)) return null;
	const target = new URL(rest + search, base);
	return target.href.startsWith(base) ? {href: target.href, rest, route} : null;
}

/**
 * Answers one request to the proxy, already let in by the server.
 * @param {Request} request
 * @param {string} path the catalog and the path in its API (`/audiobookdb/books/…`)
 * @param {ProxyDeps} deps
 * @param {Record<string, string>} cors the CORS headers for the page asking
 * @returns {Promise<Response>}
 */
export async function handleProxy(request, path, deps, cors) {
	const up = upstream(path, new URL(request.url).search);
	if (!up) return jsonResponse(404, {error: 'Not a catalog this proxy asks.'}, cors);
	const keyed = keyedPath(up, request.method);
	const accountKey = request.headers.get(CATALOG_KEY_HEADER);
	if (request.method === 'POST' && !keyed)
		return jsonResponse(405, {error: 'Only GET is allowed here.'}, {...cors, Allow: 'GET, OPTIONS'});
	// Your key goes only where the catalog needs it: sent anywhere else, the request is refused, not sent without it.
	if (accountKey && !keyed) return jsonResponse(400, {error: 'This path takes no catalog key.'}, cors);
	if (request.method === 'POST' && !accountKey)
		return jsonResponse(401, {error: 'Sending needs your catalog key.'}, cors);

	/** @type {Record<string, string>} */
	const headers = {
		'User-Agent': USER_AGENT,
		...Object.fromEntries(
			PASSED_HEADERS.flatMap(h =>
				request.headers.has(h) ? [[h, /** @type {string} */ (request.headers.get(h))]] : [],
			),
		),
	};
	if (keyed && accountKey && up.route.keyHeader) headers[up.route.keyHeader] = accountKey;
	/** @type {string | undefined} */
	let body;
	if (request.method === 'POST') {
		body = await request.text();
		if (body.length > MAX_BODY) return jsonResponse(413, {error: 'Too much to send.'}, cors);
		headers['Content-Type'] = 'application/json';
	}
	const ask = new Request(up.href, {method: request.method, headers, body});
	// What a keyed path answers is yours, and changes when you send: never kept, never taken from the cache.
	const cache = keyed ? null : deps.cache || null;
	let answer = cache ? await cache.match(ask) : undefined;
	if (!answer) {
		let got;
		try {
			got = await deps.fetch(ask);
		} catch {
			return jsonResponse(502, {error: 'The catalog could not be reached.'}, cors);
		}
		// Only the body, status and type go back: no cookies or other headers from the catalog,
		// and, when the catalog asks to slow down, how long to wait.
		const retry = got.status === 429 ? got.headers.get('Retry-After') : null;
		answer = new Response(got.body, {
			status: got.status,
			headers: {
				'Content-Type': got.headers.get('Content-Type') || 'application/octet-stream',
				'Cache-Control': got.ok && !keyed ? `public, max-age=${CACHE_SECONDS}` : 'no-store',
				...(retry ? {'Retry-After': retry} : {}),
			},
		});
		if (cache && got.ok) {
			const put = cache.put(ask, answer.clone());
			if (deps.later) deps.later(put);
			else await put;
		}
	}
	const back = new Headers(answer.headers);
	for (const [name, value] of Object.entries(cors)) back.set(name, value);
	return new Response(answer.body, {status: answer.status, headers: back});
}
