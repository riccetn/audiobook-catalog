// The catalog proxy (proxy/worker.js), run in Node with a fake catalog behind it: what it lets through,
// and what it refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, upstreamUrl, allowedOrigins, KEY_HEADER } from '../proxy/worker.js';

const ENV = { PROXY_KEY: 'k3y-for-tests', ALLOWED_ORIGINS: 'https://example.github.io, http://127.0.0.1:8000' };
const APP = 'https://example.github.io';

/** A fake catalog answering every address with what was asked, and a cache in a Map. */
function behind() {
	const asked = [];
	const fetch = async request => {
		asked.push({ url: request.url, headers: Object.fromEntries(request.headers) });
		if (request.url.includes('missing')) return new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
		return new Response(JSON.stringify({ asked: request.url }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'session=1' } });
	};
	const kept = new Map();
	const cache = {
		match: async request => kept.get(request.url)?.clone(),
		put: async (request, response) => { kept.set(request.url, response); },
	};
	return { asked, kept, deps: { fetch, cache } };
}

/**
 * @param {string} path
 * @param {{origin?: string | null, key?: string | null, method?: string, headers?: Record<string, string>}} [opts]
 */
function ask(path, { origin = APP, key = ENV.PROXY_KEY, method = 'GET', headers = {} } = {}) {
	return new Request(`https://proxy.example.workers.dev${path}`, { method, headers: {
		...(origin ? { Origin: origin } : {}), ...(key ? { [KEY_HEADER]: key } : {}), ...headers } });
}

test('proxy: routes name a catalog, never an address, and stay in its API', () => {
	const up = path => upstreamUrl(new URL(`https://proxy.example.workers.dev${path}`));
	assert.equal(up('/audiobookdb/audiobooks/external/audible/B0FAKE0001'), 'https://audiobookdb.org/api/audiobooks/external/audible/B0FAKE0001');
	assert.equal(up('/audible/audible.co.uk/catalog/products/B0FAKE0001?response_groups=series'),
		'https://api.audible.co.uk/1.0/catalog/products/B0FAKE0001?response_groups=series');
	assert.equal(up('/bookbrainz/edition/1111-2222'), 'https://api.bookbrainz.org/1/edition/1111-2222');
	assert.equal(up('/isfdb/getpub.cgi?9780000000002'), 'https://www.isfdb.org/cgi-bin/rest/getpub.cgi?9780000000002');
	// not a catalog, not an Audible site, outside Audible's catalog API, climbing out, or nothing asked
	for (const path of ['/example.com/x', '/https:/evil.example/x', '/audible/evil.example/catalog/products/B0FAKE0001',
		'/audible/audible.com/1.0/library', '/audible/audible.com/account', '/audiobookdb/../../admin', '/audiobookdb/%2e%2e/admin',
		'/audiobookdb//evil.example/x', '/audiobookdb/', '/audiobookdb', '/constructor/x', '/__proto__/x']) {
		assert.equal(up(path), null, path);
	}
});

test('proxy: answers only the app with the key, and passes on only the body and its type', async () => {
	const { asked, deps } = behind();
	const ok = await handle(ask('/audiobookdb/audiobooks/external/audible/B0FAKE0001', { headers: { Cookie: 'mine=1', Accept: 'application/json' } }), ENV, deps);
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get('Access-Control-Allow-Origin'), APP);
	assert.equal(ok.headers.get('Set-Cookie'), null, 'no cookies from the catalog');
	assert.deepEqual(await ok.json(), { asked: 'https://audiobookdb.org/api/audiobooks/external/audible/B0FAKE0001' });
	assert.equal(asked[0].headers.cookie, undefined, 'no cookies to the catalog');
	assert.equal(asked[0].headers[KEY_HEADER.toLowerCase()], undefined, 'the key stays in the proxy');
	assert.equal(asked[0].headers.accept, 'application/json');
	assert.match(asked[0].headers['user-agent'], /audiobook-catalog-proxy/);

	const status = async (path, opts) => (await handle(ask(path, opts), ENV, deps)).status;
	assert.equal(await status('/audiobookdb/x', { origin: 'https://evil.example' }), 403);
	assert.equal(await status('/audiobookdb/x', { key: null }), 401);
	assert.equal(await status('/audiobookdb/x', { key: 'k3y-for-test' }), 401);
	assert.equal(await status('/audiobookdb/x', { key: 'k3y-for-tests!' }), 401);
	assert.equal(await status('/audiobookdb/x', { method: 'POST' }), 405);
	assert.equal(await status('/somewhere/else'), 404);
	assert.equal(await status('/audiobookdb/x', { origin: null }), 200, 'curl, with the key');
	assert.equal(asked.length, 2, 'nothing refused reached a catalog');
	assert.equal((await handle(ask('/ping'), { ALLOWED_ORIGINS: ENV.ALLOWED_ORIGINS }, deps)).status, 500, 'no key set: refuses everything');
});

test('proxy: the preflight allows the key header, and ping says which catalogs', async () => {
	const { deps } = behind();
	const pre = await handle(ask('/audiobookdb/x', { method: 'OPTIONS', key: null }), ENV, deps);
	assert.equal(pre.status, 204);
	assert.equal(pre.headers.get('Access-Control-Allow-Origin'), APP);
	assert.equal(pre.headers.get('Access-Control-Allow-Headers'), KEY_HEADER);
	const ping = await handle(ask('/ping'), ENV, deps);
	assert.deepEqual(await ping.json(), { ok: true, catalogs: ['audiobookdb', 'audible', 'bookbrainz', 'isfdb'] });
	assert.deepEqual(allowedOrigins({}), ['https://riccetn.github.io', 'http://127.0.0.1:8000', 'http://localhost:8000']);
});

test('proxy: keeps answers found for a day, and asks again for one not found', async () => {
	const { asked, kept, deps } = behind();
	const path = '/audible/audible.com/catalog/products/B0FAKE0001';
	assert.equal((await handle(ask(path), ENV, deps)).status, 200);
	const again = await handle(ask(path, { origin: 'http://127.0.0.1:8000' }), ENV, deps);
	assert.equal(asked.length, 1, 'the second answer came from the cache');
	assert.equal(again.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8000', 'with the CORS of the page asking');
	assert.match(again.headers.get('Cache-Control'), /max-age=86400/);
	assert.equal((await handle(ask('/audiobookdb/missing'), ENV, deps)).status, 404);
	await handle(ask('/audiobookdb/missing'), ENV, deps);
	assert.equal(asked.length, 3);
	assert.equal(kept.size, 1);
	const down = { ...deps, fetch: async () => { throw new Error('offline'); }, cache: null };
	assert.equal((await handle(ask('/bookbrainz/x'), ENV, down)).status, 502);
});
