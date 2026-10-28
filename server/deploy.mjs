// Deploys the app's server with its sync database (make deploy-server, or node server/deploy.mjs), so the
// database's id never has to be written into wrangler.toml, which git tracks. It finds the D1 database by its
// name (making it the first time), writes wrangler.toml with the binding and that id into wrangler.deploy.toml
// (git-ignored), and deploys that. A plain `npx wrangler deploy` still deploys the server, without sync.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const DATABASE = 'audiobook-catalog-sync';
export const BINDING = 'SYNC_DB';
export const DEPLOY_CONFIG = 'wrangler.deploy.toml';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * wrangler.toml with the sync database bound, by its id.
 * @param {string} toml
 * @param {string} id
 * @returns {string}
 */
export function deployConfig(toml, id) {
	if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`not a D1 database id: ${id}`);
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
 * Run wrangler (through npx, as it is no devDependency) in `cwd`; with `capture`, return what it printed.
 * @param {string[]} args
 * @param {{cwd?: string, capture?: boolean}} [opts]
 * @returns {string}
 */
function wrangler(args, {cwd = HERE, capture = false} = {}) {
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
	if (run.status !== 0) process.exit(run.status || 1);
	return run.stdout || '';
}

/** @returns {string | null} the sync database's id, or null when there is none yet */
function databaseId() {
	// asked outside this folder, so wrangler finds no config to read or write
	const listed = JSON.parse(wrangler(['d1', 'list', '--json'], {cwd: os.tmpdir(), capture: true}));
	const found = listed.find(d => d.name === DATABASE);
	return found ? found.uuid || found.id : null;
}

function deploy() {
	console.log(`Looking for the sync database ${DATABASE} on your Cloudflare account…`);
	let id = databaseId();
	if (!id) {
		console.log('There is none yet: making it.');
		wrangler(['d1', 'create', DATABASE], {cwd: os.tmpdir()});
		id = databaseId();
		if (!id) throw new Error(`wrangler made no database named ${DATABASE}`);
	}
	const toml = fs.readFileSync(path.join(HERE, 'wrangler.toml'), 'utf8');
	fs.writeFileSync(path.join(HERE, DEPLOY_CONFIG), deployConfig(toml, id));
	console.log(`Deploying the server with the sync database (${id}) bound as ${BINDING}…`);
	wrangler(['deploy', '--config', DEPLOY_CONFIG]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) deploy();
