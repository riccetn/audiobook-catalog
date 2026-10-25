// Writes the pages into public/ from the Liquid templates in templates/ (make pages): each page in templates/pages/
// fills in templates/layout.liquid, which holds what every page shares (the <head>, the title and the nav bar).
// The pages it writes are not committed (.gitignore), so build before serving or testing.
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
