// Writes the pages into public/ from the Liquid templates in templates/ (make pages): each page in templates/pages/
// fills in templates/layout.liquid, which holds what every page shares (the <head>, the title and the nav bar).
// The pages it writes are not committed (.gitignore), so build before serving or testing. It copies the one library
// the app loads (the QR code's) into public/vendor/, and then it writes
// public/sw-app.js, the files the service worker caches and the version it names its cache by (sw.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Liquid} from 'liquidjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const templates = path.join(root, 'templates');
const pages = path.join(templates, 'pages');
const site = path.join(root, 'public');

// Strict, so a misspelled variable or filter fails the build rather than leaving a hole in a page.
const engine = new Liquid({root: templates, extname: '.liquid', strictVariables: true, strictFilters: true});

for (const file of fs
	.readdirSync(pages)
	.filter(f => f.endsWith('.liquid'))
	.sort()) {
	const page = file.replace(/\.liquid$/, '.html');
	// The layout gets the page's file name, to mark its own link in the nav bar.
	const html = await engine.renderFile(path.join('pages', file), {page, title: ''});
	fs.writeFileSync(path.join(site, page), html);
}

// The QR code library (Import & export's Set up another device), copied from node_modules as npm installed it, as
// the browser loads the app's files as they are. Not type checked: its JavaScript has no JSDoc.
const VENDOR = [['qrcode-generator/dist/qrcode.mjs', 'qrcode.mjs']];
fs.mkdirSync(path.join(site, 'vendor'), {recursive: true});
for (const [from, to] of VENDOR) {
	const file = path.join(root, 'node_modules', from);
	if (!fs.existsSync(file)) throw new Error(`${from.split('/')[0]} is not installed: run npm install first`);
	const text = fs.readFileSync(file, 'utf8');
	fs.writeFileSync(
		path.join(site, 'vendor', to),
		`// Copied from node_modules/${from} by make pages (build.mjs).\n// @ts-nocheck\n${text}`,
	);
}

// What the service worker caches: every file served but itself, what this writes, hidden files and the API docs
// make docs may have put in api/, so a file added to public/ or taken out of it needs nothing more. The version is a
// hash of them all, so a deploy that changes any of them changes sw-app.js, which tells the browser to fetch the app again.
const APP_FILE = 'sw-app.js';
const files = fs
	.readdirSync(site, {recursive: true, encoding: 'utf8'})
	.map(f => f.split(path.sep).join('/'))
	.filter(
		f =>
			![APP_FILE, 'sw.js'].includes(f) &&
			!f.startsWith('api/') &&
			!f.split('/').some(part => part.startsWith('.')) &&
			fs.statSync(path.join(site, f)).isFile(),
	)
	.sort();
const hash = crypto.createHash('sha256');
for (const file of files) hash.update(`${file}\0`).update(fs.readFileSync(path.join(site, file)));
fs.writeFileSync(
	path.join(site, APP_FILE),
	[
		"// Written by make pages (build.mjs): the app's files, which sw.js caches, and their hash, which it names its cache by.",
		`self.APP_VERSION = '${hash.digest('hex').slice(0, 16)}';`,
		`self.APP_FILES = ${JSON.stringify(['./', ...files])};`,
		'',
	].join('\n'),
);
