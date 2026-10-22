// The catalog proxy: a Cloudflare Worker that asks, for the app's pages, the catalogs whose APIs don't
// answer web pages (no CORS headers). It is not an open proxy: a request names a catalog from CATALOGS,
// never an address, so it can only reach those APIs, and only with GET. It answers only the app's own
// origins (ALLOWED_ORIGINS) and only with the key (the PROXY_KEY secret), which the app keeps in the
// browser like the Hardcover token. Answers are cached for a day, to be gentle with small catalogs.
// It holds no catalog data and never sees the Hardcover token: Hardcover answers pages itself.
// Deployed on its own (see proxy/README.md); the app works without it.

/**
 * What the Worker is given by Cloudflare: the variables in wrangler.toml and the secrets.
 * @typedef {{PROXY_KEY?: string, ALLOWED_ORIGINS?: string}} Env
 */
/**
 * What `handle` uses from outside, so the tests run it offline: the fetch to the catalogs, and the cache
 * (Cloudflare's `caches.default`), with `later` to finish putting into it after answering.
 * @typedef {{fetch: (request: Request) => Promise<Response>, cache?: Cache | null, later?: (task: Promise<unknown>) => void}} Deps
 */
/**
 * A catalog the proxy asks: the API address its routes go under, given the route's first part when the
 * catalog has sites (Audible), and the start a path must have, so only its public catalog API is reached.
 * @typedef {{base: (site: string) => string | null, sites?: boolean, paths?: RegExp}} Route
 */

const AUDIBLE_SITES = ['audible.com', 'audible.co.uk', 'audible.de', 'audible.fr', 'audible.it', 'audible.es',
	'audible.ca', 'audible.com.au', 'audible.in', 'audible.co.jp'];

/** @type {Record<string, Route>} */
export const CATALOGS = {
	// AudiobookDB's public API (audiobookdb.org/docs): /audiobookdb/audiobooks/external/audible/<ASIN>
	audiobookdb: {base: () => 'https://audiobookdb.org/api/'},
	// Audible's catalog API, which needs no account: /audible/audible.co.uk/catalog/products/<ASIN>?response_groups=...
	audible: {base: site => AUDIBLE_SITES.includes(site) ? `https://api.${site}/1.0/` : null, sites: true, paths: /^catalog\//},
	// BookBrainz's API: /bookbrainz/edition/<bbid>
	bookbrainz: {base: () => 'https://api.bookbrainz.org/1/'},
	// ISFDB's REST API (cgi-bin/rest): /isfdb/getpub.cgi?<ISBN>
	isfdb: {base: () => 'https://www.isfdb.org/cgi-bin/rest/'},
};

export const DEFAULT_ORIGINS = ['https://riccetn.github.io', 'http://127.0.0.1:8000', 'http://localhost:8000'];
export const KEY_HEADER = 'X-Proxy-Key';
const CACHE_SECONDS = 24 * 60 * 60;
const USER_AGENT = 'audiobook-catalog-proxy (+https://github.com/riccetn/audiobook-catalog)';
// The request headers passed on to a catalog; nothing else (cookies, the key) leaves the Worker.
const PASSED_HEADERS = ['accept', 'accept-language'];

/**
 * The origins the proxy answers: ALLOWED_ORIGINS (separated by commas or spaces), else the app's.
 * @param {Env} env
 * @returns {string[]}
 */
export function allowedOrigins(env){
	const listed = (env.ALLOWED_ORIGINS || '').split(/[\s,]+/).map(o => o.replace(/\/+$/, '')).filter(Boolean);
	return listed.length ? listed : DEFAULT_ORIGINS;
}

/**
 * Compares the key without stopping at the first difference, so timing doesn't tell how much was right.
 * @param {string} given
 * @param {string} key
 * @returns {boolean}
 */
function sameKey(given, key){
	let diff = given.length ^ key.length;
	for(let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i % (given.length || 1));
	return diff === 0;
}

/**
 * The catalog's address a proxy path asks for, or null when it names no catalog or leaves its API.
 * `/audible/audible.de/catalog/products/B0X?x=1` → `https://api.audible.de/1.0/catalog/products/B0X?x=1`.
 * @param {URL} url the request's address
 * @returns {string | null}
 */
export function upstreamUrl(url){
	const parts = url.pathname.split('/').slice(1);
	const route = Object.hasOwn(CATALOGS, parts[0]) ? CATALOGS[parts[0]] : null;
	if(!route) return null;
	const base = route.base(route.sites ? parts[1] || '' : '');
	const rest = parts.slice(route.sites ? 2 : 1).join('/');
	if(!base || !rest || rest.split('/').some(p => !p || /^(\.|%2e){1,2}$/i.test(p))) return null;
	if(route.paths && !route.paths.test(rest)) return null;
	const target = new URL(rest + url.search, base);
	return target.href.startsWith(base) ? target.href : null;
}

/**
 * The CORS headers for an allowed origin (none for a request without one, as from curl).
 * @param {string | null} origin
 * @returns {Record<string, string>}
 */
function corsHeaders(origin){
	return origin ? {'Access-Control-Allow-Origin': origin, 'Vary': 'Origin'} : {'Vary': 'Origin'};
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} headers
 * @returns {Response}
 */
function json(status, body, headers){
	return new Response(JSON.stringify(body), {status, headers: {...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
}

/**
 * Answers one request to the proxy.
 * @param {Request} request
 * @param {Env} env
 * @param {Deps} deps
 * @returns {Promise<Response>}
 */
export async function handle(request, env, deps){
	const origin = request.headers.get('Origin');
	if(origin && !allowedOrigins(env).includes(origin)) return json(403, {error: 'This origin may not use the proxy.'}, {'Vary': 'Origin'});
	const cors = corsHeaders(origin);
	if(request.method === 'OPTIONS'){
		return new Response(null, {status: 204, headers: {...cors, 'Access-Control-Allow-Methods': 'GET',
			'Access-Control-Allow-Headers': KEY_HEADER, 'Access-Control-Max-Age': '86400'}});
	}
	if(request.method !== 'GET') return json(405, {error: 'Only GET is allowed.'}, {...cors, 'Allow': 'GET, OPTIONS'});
	if(!env.PROXY_KEY) return json(500, {error: 'The proxy has no key: set the PROXY_KEY secret.'}, cors);
	if(!sameKey(request.headers.get(KEY_HEADER) || '', env.PROXY_KEY)) return json(401, {error: 'Wrong or missing proxy key.'}, cors);

	const url = new URL(request.url);
	if(url.pathname === '/' || url.pathname === '/ping') return json(200, {ok: true, catalogs: Object.keys(CATALOGS)}, cors);
	const target = upstreamUrl(url);
	if(!target) return json(404, {error: 'Not a catalog this proxy asks.'}, cors);

	const ask = new Request(target, {headers: {'User-Agent': USER_AGENT,
		...Object.fromEntries(PASSED_HEADERS.flatMap(h => request.headers.has(h) ? [[h, /** @type {string} */ (request.headers.get(h))]] : []))}});
	const cache = deps.cache || null;
	let answer = cache ? await cache.match(ask) : undefined;
	if(!answer){
		let got;
		try{ got = await deps.fetch(ask); }
		catch{ return json(502, {error: 'The catalog could not be reached.'}, cors); }
		// Only the body, status and type go back: no cookies or other headers from the catalog.
		answer = new Response(got.body, {status: got.status, headers: {'Content-Type': got.headers.get('Content-Type') || 'application/octet-stream',
			'Cache-Control': got.ok ? `public, max-age=${CACHE_SECONDS}` : 'no-store'}});
		if(cache && got.ok){
			const put = cache.put(ask, answer.clone());
			if(deps.later) deps.later(put); else await put;
		}
	}
	const headers = new Headers(answer.headers);
	for(const [name, value] of Object.entries(cors)) headers.set(name, value);
	return new Response(answer.body, {status: answer.status, headers});
}

export default {
	/**
	 * Cloudflare's entry point.
	 * @param {Request} request
	 * @param {Env} env
	 * @param {{waitUntil: (task: Promise<unknown>) => void}} ctx
	 * @returns {Promise<Response>}
	 */
	fetch(request, env, ctx){
		// Cloudflare's own cache; a browser's CacheStorage has no `default`
		const cache = /** @type {{default?: Cache}} */ (/** @type {unknown} */ (globalThis.caches))?.default || null;
		return handle(request, env, {fetch: r => fetch(r), cache, later: task => ctx.waitUntil(task)});
	},
};
