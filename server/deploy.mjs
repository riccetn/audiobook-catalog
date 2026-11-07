// Deploys the app's server with its sync database (make deploy-server, or node server/deploy.mjs), so the
// database's id never has to be written into wrangler.toml, which git tracks. The first time it finds the D1
// database by its name (making it if there is none) and keeps its id in sync-database-id (git-ignored), so later
// deploys don't ask Cloudflare for it again; it writes wrangler.toml with the binding and that id into
// wrangler.deploy.toml (git-ignored too), and deploys that. When a deploy with the kept id fails (the database was
// deleted, or the id is another account's), it looks the database up again and tries once more.
// A plain `npx wrangler deploy` still deploys the server, without sync.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const DATABASE = 'audiobook-catalog-sync';
export const BINDING = 'SYNC_DB';
export const DEPLOY_CONFIG = 'wrangler.deploy.toml';
export const ID_FILE = 'sync-database-id';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} id
 * @returns {boolean} whether it is shaped like a D1 database's id
 */
function isDatabaseId(id) {
	return /^[0-9a-f-]{36}$/i.test(id);
}

/**
 * The id kept in sync-database-id, read from what the file holds.
 * @param {string | null} text the file's text, null when there is none
 * @returns {string | null} the id, or null when the file is missing or holds no id (so it is looked up again)
 */
export function keptId(text) {
	const id = (text || '').trim();
	return isDatabaseId(id) ? id : null;
}

/**
 * wrangler.toml with the sync database bound, by its id.
 * @param {string} toml
 * @param {string} id
 * @returns {string}
 */
export function deployConfig(toml, id) {
	if (!isDatabaseId(id)) throw new Error(`not a D1 database id: ${id}`);
	return (
		`# Written by deploy.mjs from wrangler.toml, with the sync database's id; not kept in git.\n` +
		`${toml.trimEnd()}\n\n[[d1_databases]]\nbinding = "${BINDING}"\ndatabase_name = "${DATABASE}"\ndatabase_id = "${id}"\n`
	);
}

/**
 * An argument as cmd.exe reads it: as it is when it holds nothing the shell would read, else in double quotes.
 * @param {string} arg
 * @returns {string}
 */
export function shellArg(arg) {
	return /^[\w@+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Run wrangler (through npx, as it is no devDependency) in `cwd`; with `capture`, return what it printed. When it
 * fails, this exits, unless `mayFail`, when it returns null.
 * @param {string[]} args
 * @param {{cwd?: string, capture?: boolean, mayFail?: boolean}} [opts]
 * @returns {string | null}
 */
function wrangler(args, {cwd = HERE, capture = false, mayFail = false} = {}) {
	// --yes: npx would otherwise ask before installing wrangler. A captured run gets no input either, so wrangler
	// asks nothing (its first-run question about usage metrics, say): a question printed where it is captured
	// can't be seen, and would wait for an answer forever.
	const command = ['npx', '--yes', 'wrangler', ...args];
	/** @type {import('node:child_process').SpawnSyncOptionsWithStringEncoding} */
	const options = {
		cwd,
		encoding: 'utf8',
		stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
		env: capture
			? {...process.env, WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS || 'false'}
			: process.env,
	};
	// On Windows npx is npx.cmd, which only a shell runs, and Node deprecates handing a shell separate arguments
	// (DEP0190, as it only joins them), so it gets the one command line, each argument quoted where it needs it.
	const run =
		process.platform === 'win32'
			? spawnSync(command.map(shellArg).join(' '), {...options, shell: true})
			: spawnSync(command[0], command.slice(1), options);
	if (run.status !== 0) {
		if (mayFail) return null;
		process.exit(run.status || 1);
	}
	return run.stdout || '';
}

/** @returns {string | null} the sync database's id, or null when there is none yet */
function databaseId() {
	// asked outside this folder, so wrangler finds no config to read or write
	const listed = JSON.parse(wrangler(['d1', 'list', '--json'], {cwd: os.tmpdir(), capture: true}) || '[]');
	const found = listed.find(d => d.name === DATABASE);
	return found ? found.uuid || found.id : null;
}

/** @returns {string} the sync database's id, found by its name on the Cloudflare account (made when missing) */
function findDatabase() {
	console.log(`Looking for the sync database ${DATABASE} on your Cloudflare account…`);
	let id = databaseId();
	if (!id) {
		console.log('There is none yet: making it.');
		wrangler(['d1', 'create', DATABASE], {cwd: os.tmpdir()});
		id = databaseId();
		if (!id) throw new Error(`wrangler made no database named ${DATABASE}`);
	}
	fs.writeFileSync(path.join(HERE, ID_FILE), `${id}\n`);
	return id;
}

/**
 * Deploy with the sync database bound by its id.
 * @param {string} id
 * @param {boolean} mayFail
 * @returns {boolean} whether it deployed
 */
function deployWith(id, mayFail) {
	const toml = fs.readFileSync(path.join(HERE, 'wrangler.toml'), 'utf8');
	fs.writeFileSync(path.join(HERE, DEPLOY_CONFIG), deployConfig(toml, id));
	console.log(`Deploying the server with the sync database (${id}) bound as ${BINDING}…`);
	return wrangler(['deploy', '--config', DEPLOY_CONFIG], {mayFail}) !== null;
}

function deploy() {
	const file = path.join(HERE, ID_FILE);
	const kept = keptId(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
	if (kept) {
		console.log(`Using the sync database's id kept in server/${ID_FILE}.`);
		if (deployWith(kept, true)) return;
		console.log(`That didn't deploy: looking the database up again, in case its id changed.`);
	}
	deployWith(findDatabase(), false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) deploy();
