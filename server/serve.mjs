// The app's server on this computer (make serve, or node server/serve.mjs): the pages from public/, and the same
// routes the Cloudflare Worker answers (worker.js's `handle`): the catalog proxy under /proxy/ and sync at /sync,
// with the synced copy in a SQLite file (server/.local/sync.sqlite) in place of D1. A request for a file in public/
// gets the file, as Cloudflare answers its static assets first; anything else goes to `handle`.
// The key and origins are read from server/.dev.vars (git-ignored; the file `wrangler dev` reads too) or the
// environment. Without a key it makes one, keeps it in .dev.vars and prints it, to paste into the app.
// Node built-ins only; node:sqlite needs Node 22.13 or later.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {handle} from './worker.js';
import {sqliteD1} from './sqlite-d1.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC = path.join(HERE, '..', 'public');
export const DEV_VARS = path.join(HERE, '.dev.vars');
export const SYNC_FILE = path.join(HERE, '.local', 'sync.sqlite');

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain; charset=utf-8',
	'.woff2': 'font/woff2',
};

/**
 * The variables in a .dev.vars file (`NAME=value` lines, the value maybe quoted; # starts a comment).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function readDevVars(text) {
	/** @type {Record<string, string>} */
	const vars = {};
	for (const line of text.split(/\r?\n/)) {
		const found = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (found) vars[found[1]] = found[2].replace(/^(["'])(.*)\1$/, '$2');
	}
	return vars;
}

/**
 * The file in `root` a path asks for (a folder's index.html), or null when there is none or it leaves `root`.
 * @param {string} root
 * @param {string} pathname
 * @returns {string | null}
 */
export function publicFile(root, pathname) {
	let wanted;
	try {
		wanted = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (wanted.includes('\0')) return null;
	let file = path.join(root, path.normalize(wanted));
	if (file !== root && !file.startsWith(root + path.sep)) return null;
	try {
		if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
		return fs.statSync(file).isFile() ? file : null;
	} catch {
		return null;
	}
}

/**
 * Cloudflare's cache, as the proxy uses it, kept in memory until the server stops: answers by address, for as
 * long as their Cache-Control's max-age says.
 * @returns {Cache}
 */
export function memoryCache() {
	/** @type {Map<string, {response: Response, until: number}>} */
	const kept = new Map();
	const cache = {
		/** @param {Request} request */
		match: async request => {
			const hit = kept.get(request.url);
			if (hit && hit.until > Date.now()) return hit.response.clone();
			kept.delete(request.url);
			return undefined;
		},
		/**
		 * @param {Request} request
		 * @param {Response} response
		 */
		put: async (request, response) => {
			const age = Number(/max-age=(\d+)/.exec(response.headers.get('Cache-Control') || '')?.[1] || 0);
			const body = await response.arrayBuffer();
			const copy = new Response(body, {status: response.status, headers: response.headers});
			if (age > 0) kept.set(request.url, {response: copy, until: Date.now() + age * 1000});
		},
	};
	return /** @type {Cache} */ (/** @type {unknown} */ (cache));
}

/**
 * Starts the server, and resolves once it listens.
 * @param {{root?: string, port?: number, host?: string, env: import('./worker.js').Env, fetch?: (request: Request) => Promise<Response>}} options
 * @returns {Promise<http.Server>}
 */
export function startServer({root = PUBLIC, port = 8000, host = '127.0.0.1', env, fetch = globalThis.fetch}) {
	const deps = {fetch, cache: memoryCache()};
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
			const file = req.method === 'GET' || req.method === 'HEAD' ? publicFile(root, url.pathname) : null;
			if (file) {
				const type =
					TYPES[/** @type {keyof typeof TYPES} */ (path.extname(file))] || 'application/octet-stream';
				// always asked again, as the files change while you work (the service worker asks the network first here)
				res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-cache'});
				res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
				return;
			}
			/** @type {Buffer[]} */
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			/** @type {[string, string][]} */
			const headers = [];
			for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
			const body =
				chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
			const answer = await handle(new Request(url, {method: req.method, headers, body}), env, deps);
			res.writeHead(answer.status, Object.fromEntries(answer.headers));
			res.end(Buffer.from(await answer.arrayBuffer()));
		} catch (e) {
			res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
			res.end(`The server failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => resolve(server));
	});
}

/**
 * The server's variables: .dev.vars, then the environment; with a new key made and kept when there is none.
 * @returns {{env: Record<string, string>, made: boolean}}
 */
function devEnv() {
	const vars = fs.existsSync(DEV_VARS) ? readDevVars(fs.readFileSync(DEV_VARS, 'utf8')) : {};
	for (const name of ['SERVER_KEY', 'PROXY_KEY', 'ALLOWED_ORIGINS'])
		if (process.env[name]) vars[name] = process.env[name];
	if (vars.SERVER_KEY || vars.PROXY_KEY) return {env: vars, made: false};
	vars.SERVER_KEY = crypto.randomBytes(24).toString('base64url');
	fs.appendFileSync(DEV_VARS, `SERVER_KEY=${vars.SERVER_KEY}\n`);
	return {env: vars, made: true};
}

async function main() {
	const port = Number(process.env.PORT) || 8000;
	const host = process.env.HOST || '127.0.0.1';
	const {env, made} = devEnv();
	fs.mkdirSync(path.dirname(SYNC_FILE), {recursive: true});
	const database = new DatabaseSync(SYNC_FILE);
	await startServer({port, host, env: {...env, SYNC_DB: sqliteD1(database)}});
	const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
	console.log(`The app is at http://${shown}:${port}/`);
	console.log(
		`Its server (catalog proxy and sync) is at the same address, with the key ${made ? 'made now and kept in' : 'in'} server/.dev.vars:`,
	);
	console.log(`  ${env.SERVER_KEY || env.PROXY_KEY}`);
	console.log(`Synced copies are kept in ${path.relative(process.cwd(), SYNC_FILE)}. Ctrl+C stops it.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
