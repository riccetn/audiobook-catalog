// The app's server (server/worker.js: the catalog proxy and sync), run in Node with a fake catalog behind it and
// the sync copy in SQLite: what it lets through, and what it refuses; and make serve's local server around it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {handle, allowedOrigins, KEY_HEADER, OLD_KEY_HEADER} from '../server/worker.js';
import {upstreamUrl, CATALOG_KEY_HEADER} from '../server/proxy.js';
import {MAX_SYNC} from '../server/sync.js';
import {sqliteD1} from '../server/sqlite-d1.js';
import {deployConfig, shellArg, DATABASE, BINDING, DEPLOY_CONFIG} from '../server/deploy.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV = {SERVER_KEY: 'k3y-for-tests', ALLOWED_ORIGINS: 'https://example.github.io, http://127.0.0.1:8000'};
const APP = 'https://example.github.io';

/** A fake catalog answering every address with what was asked, and a cache in a Map. */
function behind() {
	const asked = [];
	const fetch = async request => {
		asked.push({
			url: request.url,
			method: request.method,
			headers: Object.fromEntries(request.headers),
			body: request.body ? await request.text() : null,
		});
		if (request.url.includes('missing'))
			return new Response('{"error":"not found"}', {status: 404, headers: {'Content-Type': 'application/json'}});
		return new Response(JSON.stringify({asked: request.url}), {
			headers: {'Content-Type': 'application/json', 'Set-Cookie': 'session=1'},
		});
	};
	const kept = new Map();
	const cache = {
		match: async request => kept.get(request.url)?.clone(),
		put: async (request, response) => {
			kept.set(request.url, response);
		},
	};
	return {asked, kept, deps: {fetch, cache}};
}

/**
 * @param {string} path
 * @param {{origin?: string | null, key?: string | null, method?: string, headers?: Record<string, string>, body?: string}} [opts]
 */
function ask(path, {origin = APP, key = ENV.SERVER_KEY, method = 'GET', headers = {}, body} = {}) {
	return new Request(`https://proxy.example.workers.dev${path}`, {
		method,
		body,
		headers: {
			...(origin ? {Origin: origin} : {}),
			...(key ? {[KEY_HEADER]: key} : {}),
			...headers,
		},
	});
}

test('proxy: routes name a catalog, never an address, and stay in its API', () => {
	const up = path => {
		const url = new URL(`https://proxy.example.workers.dev${path}`);
		return upstreamUrl(url.pathname, url.search);
	};
	assert.equal(
		up('/audiobookdb/audiobooks/external/audible/B0FAKE0001'),
		'https://audiobookdb.org/api/audiobooks/external/audible/B0FAKE0001',
	);
	assert.equal(
		up('/audible/audible.co.uk/catalog/products/B0FAKE0001?response_groups=series'),
		'https://api.audible.co.uk/1.0/catalog/products/B0FAKE0001?response_groups=series',
	);
	assert.equal(up('/bookbrainz/edition/1111-2222'), 'https://api.bookbrainz.org/1/edition/1111-2222');
	assert.equal(up('/isfdb/getpub.cgi?9780000000002'), 'https://www.isfdb.org/cgi-bin/rest/getpub.cgi?9780000000002');
	// not a catalog, not an Audible site, outside Audible's catalog API, climbing out, or nothing asked
	for (const path of [
		'/example.com/x',
		'/https:/evil.example/x',
		'/audible/evil.example/catalog/products/B0FAKE0001',
		'/audible/audible.com/1.0/library',
		'/audible/audible.com/account',
		'/audiobookdb/../../admin',
		'/audiobookdb/%2e%2e/admin',
		'/audiobookdb//evil.example/x',
		'/audiobookdb/',
		'/audiobookdb',
		'/constructor/x',
		'/__proto__/x',
	]) {
		assert.equal(up(path), null, path);
	}
});

test('proxy: answers only the app with the key, and passes on only the body and its type', async () => {
	const {asked, deps} = behind();
	const ok = await handle(
		ask('/proxy/audiobookdb/audiobooks/external/audible/B0FAKE0001', {
			headers: {Cookie: 'mine=1', Accept: 'application/json'},
		}),
		ENV,
		deps,
	);
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get('Access-Control-Allow-Origin'), APP);
	assert.equal(ok.headers.get('Set-Cookie'), null, 'no cookies from the catalog');
	assert.deepEqual(await ok.json(), {asked: 'https://audiobookdb.org/api/audiobooks/external/audible/B0FAKE0001'});
	assert.equal(asked[0].headers.cookie, undefined, 'no cookies to the catalog');
	assert.equal(asked[0].headers[KEY_HEADER.toLowerCase()], undefined, 'the key stays in the proxy');
	assert.equal(asked[0].headers.accept, 'application/json');
	assert.match(asked[0].headers['user-agent'], /audiobook-catalog-proxy/);

	const status = async (path, opts) => (await handle(ask(path, opts), ENV, deps)).status;
	assert.equal(await status('/proxy/audiobookdb/x', {origin: 'https://evil.example'}), 403);
	assert.equal(await status('/proxy/audiobookdb/x', {key: null}), 401);
	assert.equal(await status('/proxy/audiobookdb/x', {key: 'k3y-for-test'}), 401);
	assert.equal(await status('/proxy/audiobookdb/x', {key: 'k3y-for-tests!'}), 401);
	assert.equal(await status('/proxy/audiobookdb/x', {method: 'POST'}), 405);
	assert.equal(await status('/proxy/audiobookdb/x', {method: 'DELETE'}), 405);
	assert.equal(await status('/proxy/somewhere/else'), 404);
	assert.equal(await status('/proxy/audiobookdb/x', {origin: null}), 200, 'curl, with the key');
	assert.equal(
		await status('/proxy/audiobookdb/x', {origin: 'https://proxy.example.workers.dev'}),
		200,
		'the app it serves',
	);
	assert.equal(asked.length, 2, 'nothing refused reached a catalog (and the last came from the cache)');
	assert.equal(
		(await handle(ask('/ping'), {ALLOWED_ORIGINS: ENV.ALLOWED_ORIGINS}, deps)).status,
		500,
		'no key set: refuses everything',
	);
});

test('proxy: the preflight allows the key headers, and ping says which catalogs', async () => {
	const {deps} = behind();
	const pre = await handle(ask('/proxy/audiobookdb/x', {method: 'OPTIONS', key: null}), ENV, deps);
	assert.equal(pre.status, 204);
	assert.equal(pre.headers.get('Access-Control-Allow-Origin'), APP);
	assert.equal(
		pre.headers.get('Access-Control-Allow-Headers'),
		`${KEY_HEADER}, ${OLD_KEY_HEADER}, ${CATALOG_KEY_HEADER}, Content-Type`,
	);
	assert.equal(pre.headers.get('Access-Control-Allow-Methods'), 'GET, POST');
	const ping = await handle(ask('/ping'), ENV, deps);
	assert.deepEqual(await ping.json(), {
		ok: true,
		proxy: ['audiobookdb', 'audible', 'bookbrainz', 'isfdb'],
		sync: false,
	});
	assert.deepEqual(allowedOrigins({}), [
		'https://riccetn.github.io',
		'http://127.0.0.1:8000',
		'http://localhost:8000',
	]);
});

test("the server's own address opens the app's index page, and a page from before still pings it", async () => {
	const {deps} = behind();
	/** @type {string[]} */
	const served = [];
	const ASSETS = {
		fetch: async request => {
			served.push(new URL(request.url).pathname);
			return new Response('<p>the app</p>', {headers: {'Content-Type': 'text/html'}});
		},
	};
	const env = {...ENV, ASSETS};
	const page = await handle(ask('/', {key: null, origin: null}), env, deps);
	assert.equal(page.status, 200);
	assert.equal(await page.text(), '<p>the app</p>');
	assert.deepEqual(served, ['/index.html'], 'no redirect: index.html itself');
	assert.equal((await (await handle(ask('/'), env, deps)).json()).ok, true, 'with the key, the ping');
	assert.equal((await handle(ask('/ping', {key: null}), env, deps)).status, 401, 'only / is the app');
	assert.deepEqual(served, ['/index.html']);
});

test('proxy: keeps answers found for a day, and asks again for one not found', async () => {
	const {asked, kept, deps} = behind();
	const path = '/proxy/audible/audible.com/catalog/products/B0FAKE0001';
	assert.equal((await handle(ask(path), ENV, deps)).status, 200);
	const again = await handle(ask(path, {origin: 'http://127.0.0.1:8000'}), ENV, deps);
	assert.equal(asked.length, 1, 'the second answer came from the cache');
	assert.equal(
		again.headers.get('Access-Control-Allow-Origin'),
		'http://127.0.0.1:8000',
		'with the CORS of the page asking',
	);
	assert.match(again.headers.get('Cache-Control'), /max-age=86400/);
	assert.equal((await handle(ask('/proxy/audiobookdb/missing'), ENV, deps)).status, 404);
	await handle(ask('/proxy/audiobookdb/missing'), ENV, deps);
	assert.equal(asked.length, 3);
	assert.equal(kept.size, 1);
	const down = {
		...deps,
		fetch: async () => {
			throw new Error('offline');
		},
		cache: null,
	};
	assert.equal((await handle(ask('/proxy/bookbrainz/x'), ENV, down)).status, 502);
});

test('proxy: your catalog key goes only to the paths that need it, which alone take a POST and are never cached', async () => {
	const {asked, kept, deps} = behind();
	const shelf = '/proxy/audiobookdb/users/username/reader/shelves/read';
	const withKey = (path, opts = {}) =>
		ask(path, {...opts, headers: {[CATALOG_KEY_HEADER]: 'my-api-key', ...opts.headers}});

	const session = await handle(withKey('/proxy/audiobookdb/auth/session'), ENV, deps);
	assert.equal(session.status, 200);
	assert.equal(asked[0].headers['x-api-key'], 'my-api-key', 'sent on as AudiobookDB reads it');
	assert.equal(asked[0].headers[CATALOG_KEY_HEADER.toLowerCase()], undefined);
	assert.equal(session.headers.get('Cache-Control'), 'no-store');
	assert.equal((await handle(withKey(`${shelf}?booksTake=100`), ENV, deps)).status, 200);
	assert.equal((await handle(withKey('/proxy/audiobookdb/users/username/reader/shelves'), ENV, deps)).status, 200);
	assert.equal((await handle(withKey('/proxy/audiobookdb/users/username/reader/shelves'), ENV, deps)).status, 200);
	assert.equal(asked.length, 4, 'asked every time');
	assert.equal(kept.size, 0, 'nothing of yours kept');

	const put = await handle(
		withKey(`${shelf}/books`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Cookie: 'mine=1'},
			body: JSON.stringify({bookId: 'FAKEbook0001'}),
		}),
		ENV,
		deps,
	);
	assert.equal(put.status, 200);
	assert.equal(asked[4].method, 'POST');
	assert.equal(asked[4].body, '{"bookId":"FAKEbook0001"}');
	assert.equal(asked[4].headers['content-type'], 'application/json');
	assert.equal(asked[4].headers.cookie, undefined);
	assert.equal(asked[4].headers['x-api-key'], 'my-api-key');

	const status = async request => (await handle(request, ENV, deps)).status;
	assert.equal(
		await status(withKey('/proxy/audiobookdb/books/FAKEbook0001')),
		400,
		'a key sent where none is needed',
	);
	assert.equal(await status(withKey('/proxy/audible/audible.com/catalog/products/B0FAKE0001')), 400);
	assert.equal(await status(withKey(`${shelf}/books/more`, {method: 'POST'})), 405);
	assert.equal(await status(withKey('/proxy/audiobookdb/books', {method: 'POST'})), 405, 'never the shared catalog');
	assert.equal(
		await status(withKey('/proxy/audiobookdb/users/username/reader/shelves', {method: 'POST'})),
		405,
		'never a new shelf',
	);
	assert.equal(await status(ask(`${shelf}/books`, {method: 'POST'})), 401, 'sending needs the key');
	assert.equal(await status(withKey(`${shelf}/books`, {method: 'POST', body: 'x'.repeat(20000)})), 413);
	assert.equal(await status(withKey(`${shelf}/books`, {method: 'PUT'})), 405);
	assert.equal(asked.length, 5, 'nothing refused reached a catalog');

	assert.equal((await handle(ask(shelf), ENV, deps)).status, 200, 'a public shelf without a key');
	assert.equal(asked[5].headers['x-api-key'], undefined);
	assert.equal(kept.size, 0, 'and still not kept');
});

test('proxy: a catalog asking to slow down says how long, to the page too', async () => {
	const deps = {
		fetch: async () =>
			new Response('{}', {status: 429, headers: {'Retry-After': '30', 'X-RateLimit-Remaining': '0'}}),
		cache: null,
	};
	const slow = await handle(ask('/proxy/audiobookdb/books/FAKEbook0001'), ENV, deps);
	assert.equal(slow.status, 429);
	assert.equal(slow.headers.get('Retry-After'), '30');
	assert.equal(slow.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
	assert.equal(slow.headers.get('X-RateLimit-Remaining'), null);
});

test('sync: keeps one synced copy, replaced only over the revision it was read at', async () => {
	const {deps} = behind();
	const env = {...ENV, SYNC_DB: sqliteD1(new DatabaseSync(':memory:'))};
	const send = body => handle(ask('/sync', {method: 'POST', body: JSON.stringify(body)}), env, deps);
	const read = async () => (await handle(ask('/sync'), env, deps)).json();

	assert.deepEqual(await read(), {revision: 0, data: null, savedAt: null}, 'none yet');
	const first = await send({revision: 0, data: 'sealed-1'});
	assert.equal(first.status, 200);
	assert.equal((await first.json()).revision, 1);
	assert.equal(first.headers.get('Access-Control-Allow-Origin'), APP);
	assert.equal(first.headers.get('Cache-Control'), 'no-store');
	const kept = await read();
	assert.equal(kept.revision, 1);
	assert.equal(kept.data, 'sealed-1');
	assert.match(kept.savedAt, /^\d{4}-\d\d-\d\dT/);

	// a device that read revision 1 replaces it; one that read before (or nothing) is told to sync again
	assert.equal((await (await send({revision: 1, data: 'sealed-2'})).json()).revision, 2);
	for (const revision of [0, 1, 7]) {
		const late = await send({revision, data: 'sealed-late'});
		assert.equal(late.status, 409, `revision ${revision}`);
		assert.equal((await late.json()).revision, 2);
	}
	assert.equal((await read()).data, 'sealed-2');

	// what isn't a copy, or is too big for a row, is refused, and keeps nothing
	for (const body of [{revision: 2}, {revision: -1, data: 'x'}, {revision: '2', data: 'x'}, {revision: 2, data: ''}])
		assert.equal((await send(body)).status, 400, JSON.stringify(body));
	assert.equal((await handle(ask('/sync', {method: 'POST', body: 'not json'}), env, deps)).status, 400);
	assert.equal((await send({revision: 2, data: 'x'.repeat(MAX_SYNC + 1)})).status, 413);
	assert.equal((await read()).revision, 2);

	// at the root, beside the proxy, not in it; only with the key, and only from the app
	assert.equal((await handle(ask('/proxy/sync'), env, deps)).status, 404);
	assert.equal((await handle(ask('/sync', {key: 'wrong'}), env, deps)).status, 401);
	assert.equal((await handle(ask('/sync', {origin: 'https://evil.example'}), env, deps)).status, 403);
	// ping says whether sync is set up; without a database, /sync says so
	assert.equal((await (await handle(ask('/ping'), env, deps)).json()).sync, true);
	const none = await handle(ask('/sync'), ENV, deps);
	assert.equal(none.status, 501);
	assert.match((await none.json()).error, /SYNC_DB/);
	assert.equal((await (await handle(ask('/ping'), ENV, deps)).json()).sync, false);
});

test('server: the deploy binds the sync database by the id it found, in a config git ignores', () => {
	const id = '0f0e0d0c-0b0a-4009-8807-060504030201';
	const config = deployConfig('name = "audiobook-catalog-proxy"\nmain = "worker.js"\n\n', id);
	assert.match(config, /^# Written by deploy\.mjs/);
	assert.match(config, /main = "worker.js"\n\n\[\[d1_databases\]\]\n/);
	assert.match(config, new RegExp(`binding = "${BINDING}"\ndatabase_name = "${DATABASE}"\ndatabase_id = "${id}"\n$`));
	assert.throws(() => deployConfig('', 'not an id"\nmain = "evil.js'), /not a D1 database id/);
	assert.ok(fs.readFileSync('.gitignore', 'utf8').split('\n').includes(`server/${DEPLOY_CONFIG}`));
	assert.doesNotMatch(fs.readFileSync('server/wrangler.toml', 'utf8'), /database_id/, 'no id in git');
});

test('server: pages and servers from before still work: catalogs at the root, the old key header and secret', async () => {
	const {asked, deps} = behind();
	const old = await handle(
		new Request('https://proxy.example.workers.dev/audiobookdb/books/FAKEbook0001', {
			headers: {Origin: APP, [OLD_KEY_HEADER]: 'old-key'},
		}),
		{PROXY_KEY: 'old-key', ALLOWED_ORIGINS: APP},
		deps,
	);
	assert.equal(old.status, 200);
	assert.equal(asked[0].url, 'https://audiobookdb.org/api/books/FAKEbook0001');
	assert.equal(asked[0].headers[OLD_KEY_HEADER.toLowerCase()], undefined, 'the old header stays in the server too');
	assert.equal(
		(await handle(ask('/ping', {key: 'old-key'}), {PROXY_KEY: 'old-key', ALLOWED_ORIGINS: APP}, deps)).status,
		200,
	);
	assert.equal((await handle(ask('/ping', {key: 'old-key'}), {...ENV, PROXY_KEY: 'old-key'}, deps)).status, 401);
});

test('make serve: the pages from public/, everything else the server, with sync in SQLite', async t => {
	const {startServer, publicFile, readDevVars, memoryCache} = await import('../server/serve.mjs');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'));
	fs.mkdirSync(path.join(root, 'modules'));
	fs.writeFileSync(path.join(root, 'index.html'), '<p>the app</p>');
	fs.writeFileSync(path.join(root, 'modules', 'book.js'), 'export {};');
	const {asked, deps} = behind();
	const env = {...ENV, SYNC_DB: sqliteD1(new DatabaseSync(':memory:'))};
	const server = await startServer({root, port: 0, env, fetch: deps.fetch});
	t.after(() => server.close());
	const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
	const get = (route, init = {}) => fetch(`${base}${route}`, init);
	const keyed = {headers: {[KEY_HEADER]: ENV.SERVER_KEY, Origin: 'http://127.0.0.1:8000'}};

	const page = await get('/');
	assert.equal(page.status, 200);
	assert.equal(await page.text(), '<p>the app</p>');
	assert.match(page.headers.get('Content-Type'), /^text\/html/);
	const module = await get('/modules/book.js');
	assert.match(module.headers.get('Content-Type'), /^text\/javascript/);
	assert.equal(
		(await get('/../package.json')).status,
		401,
		'never outside public/: the server answers, wanting its key',
	);
	assert.equal(publicFile(root, '/%2e%2e/package.json'), null);
	assert.equal(publicFile(root, '/%E0%A4%A'), null);

	assert.deepEqual((await (await get('/ping', keyed)).json()).sync, true);
	const proxied = await get('/proxy/bookbrainz/edition/1111-2222', keyed);
	assert.equal(proxied.status, 200);
	assert.equal(proxied.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8000');
	await get('/proxy/bookbrainz/edition/1111-2222', keyed);
	assert.equal(asked.length, 1, 'kept for a day, as Cloudflare does');

	const send = body => get('/sync', {method: 'POST', body: JSON.stringify(body), headers: keyed.headers});
	assert.equal((await send({revision: 0, data: 'sealed-1'})).status, 200);
	assert.equal((await send({revision: 0, data: 'sealed-late'})).status, 409);
	assert.equal((await (await get('/sync', keyed)).json()).data, 'sealed-1');
	assert.equal((await get('/sync')).status, 401);

	assert.deepEqual(readDevVars('# mine\nSERVER_KEY = "abc"\nALLOWED_ORIGINS=http://127.0.0.1:8000\n\n'), {
		SERVER_KEY: 'abc',
		ALLOWED_ORIGINS: 'http://127.0.0.1:8000',
	});
	const cache = memoryCache();
	const request = new Request('https://catalog.example/x');
	await cache.put(request, new Response('kept', {headers: {'Cache-Control': 'public, max-age=60'}}));
	assert.equal(await (await cache.match(request)).text(), 'kept');
	await cache.put(request, new Response('not kept', {headers: {'Cache-Control': 'no-store'}}));
	assert.equal(await (await cache.match(request)).text(), 'kept');
});

test("deploy: Windows' shell gets one command line, quoted only where an argument needs it", () => {
	assert.equal(shellArg('wrangler.deploy.toml'), 'wrangler.deploy.toml');
	assert.equal(shellArg('--json'), '--json');
	assert.equal(shellArg('C:\\My Projects\\x'), '"C:\\My Projects\\x"');
	assert.equal(shellArg('a&b'), '"a&b"');
	assert.equal(shellArg('say "hi"'), '"say ""hi"""');
});
