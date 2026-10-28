// The app's optional server: a Cloudflare Worker (or, for development, the same code in Node: serve.mjs), which
// serves the app's pages from public/ too (as static assets, before this code runs), with two unrelated jobs, each in a module of its own: the catalog proxy (proxy.js, `/proxy/<catalog>/…`), for the catalogs
// whose APIs don't answer web pages, and syncing devices (sync.js, `/sync`). This file lets a request in or not:
// it answers only the app's own origins (its own, and ALLOWED_ORIGINS), and only with the key (the SERVER_KEY secret), which the
// app keeps in the browser like the Hardcover token; then it hands the request to its route.
// Deployed on its own (see server/README.md); the app works without it.
import {CATALOGS, CATALOG_KEY_HEADER, handleProxy} from './proxy.js';
import {handleSync} from './sync.js';
import {corsHeaders, jsonResponse} from './responses.js';

/**
 * What the Worker is given by Cloudflare (or serve.mjs): the variables in wrangler.toml, the secrets, and the
 * sync database, and the app's files (ASSETS, when it serves the app too). PROXY_KEY is the key's name from when the
 * server was only the proxy, still read.
 * @typedef {{SERVER_KEY?: string, PROXY_KEY?: string, ALLOWED_ORIGINS?: string, SYNC_DB?: D1Database, ASSETS?: {fetch: (request: Request) => Promise<Response>}}} Env
 */
/** @import {D1Database} from './sync.js' */
/** @import {ProxyDeps} from './proxy.js' */

export const DEFAULT_ORIGINS = ['https://riccetn.github.io', 'http://127.0.0.1:8000', 'http://localhost:8000'];
export const KEY_HEADER = 'X-Server-Key';
// The key's header from when the server was only the proxy, which pages from before still send.
export const OLD_KEY_HEADER = 'X-Proxy-Key';

/**
 * The origins the server answers: ALLOWED_ORIGINS (separated by commas or spaces), else the app's.
 * @param {Env} env
 * @returns {string[]}
 */
export function allowedOrigins(env) {
	const listed = (env.ALLOWED_ORIGINS || '')
		.split(/[\s,]+/)
		.map(o => o.replace(/\/+$/, ''))
		.filter(Boolean);
	return listed.length ? listed : DEFAULT_ORIGINS;
}

/**
 * Compares the key without stopping at the first difference, so timing doesn't tell how much was right.
 * @param {string} given
 * @param {string} key
 * @returns {boolean}
 */
function sameKey(given, key) {
	let diff = given.length ^ key.length;
	for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i % (given.length || 1));
	return diff === 0;
}

/**
 * The server key a request was sent with, if any.
 * @param {Request} request
 * @returns {string | null}
 */
function keyOf(request) {
	return request.headers.get(KEY_HEADER) ?? request.headers.get(OLD_KEY_HEADER);
}

/**
 * Answers one request to the server.
 * @param {Request} request
 * @param {Env} env
 * @param {ProxyDeps} deps
 * @returns {Promise<Response>}
 */
export async function handle(request, env, deps) {
	const path = new URL(request.url).pathname;
	// The app's own address opens the app. Cloudflare's assets serve each file only at its name (wrangler.toml), so
	// / is answered here; a page from before /ping asks / with the key, and still gets the ping.
	if (path === '/' && env.ASSETS && request.method === 'GET' && !keyOf(request))
		return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), {headers: request.headers}));
	const origin = request.headers.get('Origin');
	// the app served by the server itself is always let in, wherever it is deployed
	const own = origin === new URL(request.url).origin;
	if (origin && !own && !allowedOrigins(env).includes(origin))
		return jsonResponse(403, {error: 'This origin may not use the server.'}, {Vary: 'Origin'});
	const cors = corsHeaders(origin);
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				...cors,
				'Access-Control-Allow-Methods': 'GET, POST',
				'Access-Control-Allow-Headers': `${KEY_HEADER}, ${OLD_KEY_HEADER}, ${CATALOG_KEY_HEADER}, Content-Type`,
				'Access-Control-Max-Age': '86400',
			},
		});
	}
	if (request.method !== 'GET' && request.method !== 'POST')
		return jsonResponse(405, {error: 'Only GET and POST are allowed.'}, {...cors, Allow: 'GET, POST, OPTIONS'});
	const key = env.SERVER_KEY || env.PROXY_KEY;
	if (!key) return jsonResponse(500, {error: 'The server has no key: set the SERVER_KEY secret.'}, cors);
	if (!sameKey(keyOf(request) ?? '', key)) return jsonResponse(401, {error: 'Wrong or missing server key.'}, cors);

	if (path === '/' || path === '/ping')
		return jsonResponse(200, {ok: true, proxy: Object.keys(CATALOGS), sync: Boolean(env.SYNC_DB)}, cors);
	if (path === '/sync') return handleSync(request, env.SYNC_DB, cors);
	if (path.startsWith('/proxy/')) return handleProxy(request, path.slice('/proxy'.length), deps, cors);
	// pages from before the proxy moved under /proxy/ ask the catalogs at the root
	return handleProxy(request, path, deps, cors);
}

export default {
	/**
	 * Cloudflare's entry point.
	 * @param {Request} request
	 * @param {Env} env
	 * @param {{waitUntil: (task: Promise<unknown>) => void}} ctx
	 * @returns {Promise<Response>}
	 */
	fetch(request, env, ctx) {
		// Cloudflare's own cache; a browser's CacheStorage has no `default`
		const cache = /** @type {{default?: Cache}} */ (/** @type {unknown} */ (globalThis.caches))?.default || null;
		return handle(request, env, {fetch: r => fetch(r), cache, later: task => ctx.waitUntil(task)});
	},
};
