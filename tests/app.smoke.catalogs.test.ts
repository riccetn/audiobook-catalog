// Browser smoke tests: installing the app, the other catalogs (Hardcover, AudiobookDB, Audible), your server
// and syncing devices. The pages run in Node against a fake DOM (boot() in smoke.ts).
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fakeHardcover, hardcoverState} from './fake-hardcover.ts';
import {audiobookdbState, fakeAudiobookdb, fakeProxyCatalogs} from './fake-catalogs.ts';
import {handle as handleServer} from '../server/worker.ts';
import type {Env} from '../server/worker.ts';
import {sqliteD1} from '../server/sqlite-d1.ts';
import {DatabaseSync} from 'node:sqlite';
import {Book} from '#app/modules/book.js';
import {Duplicates} from '#app/modules/duplicates.js';
import {DeviceSetup} from '#app/modules/device-setup.js';
import {
	ALL_PAGES,
	DEMO,
	PAGES,
	bookIdAt,
	boot,
	bootAdd,
	databaseOf,
	entryOf,
	idle,
	kept,
	modulesOf,
	read,
	root,
	saveEdit,
	site,
} from './smoke.ts';

test("the app can be installed: the manifest's icons exist, and the service worker caches every page and module, and nothing else", () => {
	const manifest = JSON.parse(read('manifest.webmanifest'));
	for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(site, icon.src)), icon.src);
	assert.ok(
		manifest.icons.some((i: any) => i.sizes === '512x512') &&
			manifest.icons.some((i: any) => i.sizes === '192x192'),
	);
	// make pages writes the list sw.js caches (sw-app.js) from what public/ holds.
	const cached = JSON.parse(read('sw-app.js').match(/self\.APP_FILES = (\[.*\]);/)![1]);
	for (const file of cached.filter((f: any) => f !== './')) assert.ok(fs.existsSync(path.join(site, file)), file);
	/** What the pages use: themselves, the modules they import, and what their <head> and the manifest name. */
	const used = new Set(['manifest.webmanifest', ...manifest.icons.map((i: any) => i.src)]);
	for (const page of ALL_PAGES) {
		const html = read(page);
		assert.ok(html.includes('<link rel="manifest" href="manifest.webmanifest">'), page);
		used.add(page);
		for (const [, href] of html.matchAll(/<link [^>]*href="([^":]+)"/g)) used.add(href);
		for (const file of modulesOf(entryOf(page)[0], {lazy: true})) used.add(file);
	}
	for (const file of used) assert.ok(cached.includes(file), `sw.js caches ${file}`);
	// public/ is what gets served, so it holds the app and nothing else (no catalog files, no notes).
	for (const file of cached.filter((f: any) => f !== './'))
		assert.ok(used.has(file), `public/${file} is served and cached, but no page uses it`);
});
test('every page is written from its template, with the shared nav bar marking where it is', () => {
	// The pages in public/ are written by make pages (build.mjs), so a missing one means it wasn't run.
	const templates = fs.readdirSync(path.join(root, 'templates', 'pages')).map(f => f.replace(/\.liquid$/, '.html'));
	assert.deepEqual(templates.sort(), [...ALL_PAGES].sort());
	for (const page of ALL_PAGES) {
		assert.ok(fs.existsSync(path.join(site, page)), `public/${page} is missing: run make pages`);
		const html = read(page);
		for (const link of PAGES) assert.ok(html.includes(`<a href="${link}"`), `${page} links to ${link}`);
		assert.equal(html.match(/class="current"/g)?.length, 1, `${page} marks one link current`);
		// Only the page the link opens is that page; a book's or an author's page sits under its list.
		assert.equal(
			html.includes(`<a href="${page}" class="current" aria-current="page">`),
			PAGES.includes(page),
			page,
		);
	}
});
test('"Not duplicates" marks are kept in this browser and travel in backups', async () => {
	const books = [
		{t: 'The Ledger', a: ['Priya Ostrander']},
		{t: 'The Ledger, Book 1', a: ['Priya Ostrander']},
		{t: 'Salt Road', a: ['Marisol Quenby']},
		{t: 'Salt Road, Book 1', a: ['Marisol Quenby']},
	];
	const pairKey = (x: any, y: any) => Duplicates.pairKey(Book.fromJSON(books[x]), Book.fromJSON(books[y]));
	const ledger = pairKey(0, 1);
	const files = {'books.json': JSON.stringify(books), 'not-duplicates.txt': '# header\n' + ledger + '\n'};
	const {ctx, get, run, els, storage} = await boot({page: 'duplicates.html', files});
	const at = get('CATALOG.books.map(b => b.id)');
	// the marks kept hide that pair
	assert.deepEqual(get('DUP_GROUPS'), [[at[2], at[3]]]);

	// marking the other pair keeps it too, by the books' ids
	ctx.keepApart(0);
	assert.deepEqual((await kept(storage)).notDuplicates, [ledger, pairKey(2, 3)]);
	assert.deepEqual(get('[...CATALOG.marks.values()].map(m => m.bookIds)'), [
		[at[0], at[1]].sort(),
		[at[2], at[3]].sort(),
	]);
	assert.deepEqual(get('DUP_GROUPS'), []);
	assert.equal(els.dupCount.textContent, '');
	// so a book retitled is still marked, and a backup has the mark by its new title
	await run("CATALOG.books[3].title = 'Salt Road, Volume 1'; persist()");
	assert.equal(get('CATALOG.duplicates().markedNotSame(CATALOG.books[2], CATALOG.books[3])'), true);
	assert.deepEqual(get('CATALOG.markTexts()')[1], get('Duplicates.pairKey(CATALOG.books[2], CATALOG.books[3])'));
	await run("CATALOG.books[3].title = 'Salt Road, Book 1'; persist()");

	// Export carries every mark; Restore elsewhere brings them back
	const imp = await boot({page: 'import.html', files: {...files, 'not-duplicates.txt': ledger}});
	const blobs: string[] = [];
	imp.ctx.Blob = class {
		constructor(parts: any) {
			blobs.push(parts.join(''));
		}
	};
	imp.ctx.URL = {createObjectURL: () => 'blob:x', revokeObjectURL() {}};
	imp.els.exportBtn.listeners.click[0]();
	await idle();
	const exported = JSON.parse(blobs[0]);
	assert.deepEqual(
		Object.values(exported.marks),
		[{kind: 'notDuplicates', bookIds: imp.get('CATALOG.books.slice(0, 2).map(b => b.id).sort()')}],
		'by the ids of the books',
	);
	// which a Restore elsewhere keeps pointing at those books
	const copy = await boot({page: 'import.html', files: {'books.json': '[]'}});
	await copy.els.importFile.listeners.change[0]({target: {files: [{name: 'b.json', text: blobs[0]}], value: ''}});
	await idle();
	assert.deepEqual(
		copy.get('[...CATALOG.marks.values()]'),
		Object.entries<any>(exported.marks).map(([id, m]) => ({id, ...m})),
	);
	assert.deepEqual(copy.get('CATALOG.markTexts()'), [ledger]);
	const backup = {books, seriesInfo: {}, notDuplicates: [ledger, pairKey(2, 3)]};
	const other = await boot({page: 'import.html', files: {'books.json': JSON.stringify(books)}});
	await other.els.importFile.listeners.change[0]({
		target: {files: [{name: 'b.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	const after = await boot({page: 'duplicates.html', storage: other.storage});
	assert.deepEqual(after.get('DUP_GROUPS'), []);
});
test("Merge previews a backup from another device and keeps both sides' changes", async () => {
	const mine = JSON.stringify([
		{t: 'Here', a: ['Ann Vale']},
		{t: 'Renamed', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}]},
	]);
	const backup = {
		books: [
			{t: 'Here', a: ['Ann Vale'], r: ['2025-06-01']},
			{t: 'Renamed Twice', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}]},
			{t: 'New There', a: ['Ann Vale']},
		],
		seriesInfo: {},
		excluded: ['BGONE9'],
		notDuplicates: ['["editions","id B1"]'],
	};
	const {els, get, storage} = await boot({page: 'import.html', files: {'books.json': mine}});
	els.mergeFile.listeners.change[0]({
		target: {files: [{name: 'phone.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	assert.equal(els.importPreviewTitle.textContent, 'Merge a backup');
	assert.equal(els.importPreview.place, 'after backupPanel');
	assert.ok(els.mergePrefer.classList.contains('show'));
	assert.match(els.importPreviewBody.innerHTML, /New from the backup: 1<\/p><ul><li>New There — Ann Vale/);
	assert.match(
		els.importPreviewBody.innerHTML,
		/keeping this catalog's: 1<\/p><ul><li>Renamed — Ann Vale \/ backup: Renamed Twice/,
	);
	assert.match(els.importPreviewBody.innerHTML, /More books marked "Not duplicates": 1/);
	assert.equal(get('CATALOG.books.length'), 2, 'nothing changes before it is confirmed');

	// preferring the backup's version redraws the preview, and confirming applies it
	els.mergePreferSelect.value = 'backup';
	els.mergePreferSelect.listeners.change[0]();
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /keeping the backup's: 1/);
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books'), backup.books);
	assert.deepEqual(get('CATALOG.exclusions.entries'), ['BGONE9']);
	assert.deepEqual(get('CATALOG.markTexts()'), ['["editions","id B1"]']);
	assert.deepEqual((await kept(storage)).notDuplicates, ['["editions","id B1"]']);
	assert.match(els.ioStatus.textContent, /^Merged: 1 added, 2 updated, 0 removed\./);
	assert.deepEqual((await kept(storage)).books, backup.books);
	assert.ok(!els.importPreview.classList.contains('open'));

	// merging the same backup again has nothing to do
	els.mergeFile.listeners.change[0]({
		target: {files: [{name: 'phone.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /Nothing to merge/);
	assert.equal(els.importConfirm.style.display, 'none');
});
test('the page compares the catalog with Hardcover itself, with a token kept in this browser, and sends only what is ticked', async () => {
	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
	];
	const state = hardcoverState();
	const hc = fakeHardcover(state);
	let leaving: any = null; // what leaving the page while it sends would do
	const hardcover = async (url: string, init: any) => {
		if (JSON.parse(init.body).query.startsWith('mutation') && !leaving) {
			leaving = {
				preventDefault() {
					this.prevented = true;
				},
			};
			page.fire('beforeunload', leaving);
		}
		return hc.fetch(url, init);
	};
	const setTimeout = (fn: () => unknown, ms: number) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	}; // the pause between requests
	const page = await boot({page: 'import.html', files: {'books.json': JSON.stringify(mine)}, hardcover, setTimeout});
	const {els, get, readable, storage} = page;
	assert.notEqual(els.hardcoverPanel.style.display, 'none');
	assert.match(els.hardcoverKeyState.textContent, /Paste an API token .* kept in this browser only/);
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	assert.match(els.ioStatus.textContent, /Save your Hardcover API token first/);
	assert.equal(hc.sent.length, 0);

	els.hardcoverKey.value = 'Bearer tok-123';
	await els.hardcoverKeySave.listeners.click[0]();
	await idle();
	assert.equal(storage.get('audiobook-catalog-hardcover-token'), 'tok-123');
	assert.equal(els.hardcoverKey.value, '', 'the token is not left in the page');
	assert.match(els.hardcoverKeyState.textContent, /saved in this browser only/);

	// the comparison: asked from the page, nothing changed anywhere
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	assert.ok(hc.sent.every(s => s.auth === 'Bearer tok-123' && s.url === 'https://api.hardcover.app/v1/graphql'));
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));
	assert.ok(!els.bgTask.classList.contains('show'));
	assert.equal(els.importPreviewTitle.textContent, 'Compare with Hardcover');
	assert.equal(els.importPreview.place, 'after hardcoverPanel');
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(html, /^<p>2 books on your Hardcover Read shelf \(took 0:00\)<\/p>/);
	assert.match(
		html,
		/New from Hardcover \(1\)<\/h4><ul class="cmpRows"><li><label class="cmpPick"><input type="checkbox" data-pick="take:0" checked=""> Tidewater — Ann Vale {2}\[Gull Isle #1\]/,
	);
	// your books go on Hardcover only when ticked
	assert.match(
		html,
		/Not on your Hardcover Read shelf \(1\)<\/h4>.*<input type="checkbox" data-pick="add:0"> Lantern Hours — R\. T\. Hale: read 2024-05-01<\/label>/,
	);
	assert.match(html, /<input type="checkbox" data-pick="ids" checked=""> Save the Hardcover ids found for 1 book/);
	assert.match(
		html,
		/Not added, as Hardcover has no audiobook edition picked for them: 1<\/p><ul><li>The Paper Fen — Ann Vale/,
	);
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');
	assert.equal(get('CATALOG.books.length'), 1);
	assert.equal(state.shelf.length, 2);
	const add = els.importPreviewBody.querySelector('input[data-pick="add:0"]')!;
	add.checked = true;
	add.dispatch('change');
	assert.equal(els.importConfirm.textContent, 'Apply 3 changes');

	// applying keeps the catalog before sending, and the browser asks before leaving the page meanwhile
	await els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Lantern Hours', 'Tidewater']);
	assert.deepEqual(
		(await kept(storage)).books.map((b: any) => b.t),
		['Lantern Hours', 'Tidewater'],
	);
	assert.equal(get("CATALOG.books[0].idOn('hardcover')"), '80', 'the Hardcover ids found are kept');
	assert.deepEqual(state.shelf.at(-1), {
		id: 102,
		book_id: 80,
		edition_id: 801,
		status_id: 3,
		user_book_reads: [{finished_at: '2024-05-01', edition_id: 801}],
	});
	assert.ok(leaving.prevented, 'leaving while it sends is asked about');
	const after: {preventDefault(): void; prevented?: boolean} = {
		preventDefault() {
			this.prevented = true;
		},
	};
	page.fire('beforeunload', after);
	assert.ok(!after.prevented, 'not once it is done');
	assert.match(els.importPreviewBody.innerHTML, /put 1 book\(s\) on your Hardcover Read shelf and added 1 read\(s\)/);
	assert.match(els.ioStatus.textContent, /^Added 1 book, saved Hardcover ids found for 1 book; Hardcover updated\./);
	assert.ok(
		!JSON.stringify(get('CATALOG.books')).includes('tok-123') &&
			![...storage.entries()].some(
				([k, v]) => k !== 'audiobook-catalog-hardcover-token' && v.includes('tok-123'),
			),
	);
});
test('a Hardcover comparison flags print books and ebooks, yours and on your shelf, and never sends their edition', async () => {
	const mine = [
		{t: 'Brine Songs', a: ['Ann Vale'], r: ['2024-06-01'], ext: {hardcover: '81'}, e: [{ext: {hardcover: '811'}}]},
		{t: 'Lantern Hours', a: ['R. T. Hale'], ext: {hardcover: '80'}, e: [{ext: {'amazon.com': 'B0LANTERNK'}}]},
	];
	const state = hardcoverState();
	state.editions[821] = {id: 821, book_id: 80, asin: 'B0LANTERNK', reading_format_id: 4, contributions: []};
	const hc = fakeHardcover(state);
	const setTimeout = (fn: () => unknown, ms: number) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const {els, readable} = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(
		html,
		/Maybe not audiobooks, in this catalog \(2\) <button[^>]*>Take out all<\/button> <button[^>]*>Tick none<\/button><\/h4><p class="cmpNote">By what Hardcover says, these editions of yours may not be audiobooks: if so, give the book its audiobook edition in its form, or tick what to put right\. Only values that are the same as that edition's on Hardcover are taken out\.<\/p><ul class="cmpRows"><li><a href="book\.html#book=[^"]+">Brine Songs — Ann Vale<\/a>: Hardcover edition 811 is a print book on Hardcover <a href="https:\/\/hardcover\.app\/id\/edition\/811" target="_blank" rel="noopener">hardcover.app ↗<\/a><ul><li><label class="cmpPick"><input type="checkbox" data-pick="fixOut:0"> Take out what it has of that edition: Hardcover id 811 \(nothing else is left, so the edition is removed\)<\/label><\/li><\/ul><\/li><li><a href="book\.html#book=[^"]+">Lantern Hours — R\. T\. Hale<\/a>: ASIN B0LANTERNK is an ebook on Hardcover <a href="https:\/\/hardcover\.app\/id\/edition\/821"/,
	);
	assert.match(
		html,
		/Maybe not audiobooks, on your Hardcover shelves \(1\)<\/h4>.*<li>The Paper Fen — Ann Vale: read as a print book \(Hardcover edition 601\) <a href="https:\/\/hardcover\.app\/id\/edition\/601"/,
	);
	assert.doesNotMatch(html, /Editions to add|edition:0/, "the print edition read isn't offered as one of yours");
	const add = els.importPreviewBody.querySelector('input[data-pick="add:0"]')!;
	assert.match(readable(add.parentNode!.innerHTML ?? ''), /Brine Songs/);
	add.checked = true;
	add.dispatch('change');
	await els.importConfirm.listeners.click[0]();
	await idle();
	const sent = state.shelf.at(-1);
	assert.equal(sent.book_id, 81);
	assert.ok(!sent.edition_id, 'the print edition is not sent');
	assert.deepEqual(
		sent.user_book_reads.map((r: any) => r.finished_at),
		['2024-06-01'],
	);
});
test('a Hardcover comparison offers, unticked, to put right an edition of yours that is a print book or an ebook there', async () => {
	const mine = [
		{
			t: 'Brine Songs',
			a: ['Ann Vale'],
			ext: {hardcover: '81'},
			e: [{ext: {hardcover: '811'}, isbn: '9780000000002', p: ['Kestrel Row'], n: ['Hollis Marr']}],
		},
		{t: 'Lantern Hours', a: ['R. T. Hale'], ext: {hardcover: '80'}, e: [{ext: {'amazon.com': 'B0LANTERNK'}}]},
	];
	const state = hardcoverState();
	state.editions[811].publisher = {name: 'Kestrel Row'};
	state.editions[812] = {
		id: 812,
		book_id: 81,
		asin: 'B0BRINEAUD',
		audio_seconds: 30000,
		reading_format_id: 2,
		contributions: [{contribution: 'Narrator', author: {name: 'Hollis Marr'}}],
	};
	state.editions[821] = {id: 821, book_id: 80, asin: 'B0LANTERNK', reading_format_id: 4, contributions: []};
	const setTimeout = (fn: () => unknown, ms: number) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const {els, readable} = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		hardcover: fakeHardcover(state).fetch,
		setTimeout,
		storage,
	});
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(
		html,
		/Brine Songs — Ann Vale<\/a>: Hardcover edition 811 is a print book on Hardcover <a[^>]*>hardcover\.app ↗<\/a><ul><li><label class="cmpPick"><input type="checkbox" data-pick="fixOut:0"> Take out what it has of that edition: Hardcover id 811, ISBN 9780000000002, publisher Kestrel Row<\/label><\/li><li><label class="cmpPick"><input type="checkbox" data-pick="fixIn:0"> Take those out and fill it in from the audiobook edition on Hardcover: amazon\.com id, Hardcover id, length <a href="https:\/\/hardcover\.app\/id\/edition\/812"/,
	);
	assert.match(
		html,
		/Lantern Hours — R\. T\. Hale<\/a>: ASIN B0LANTERNK is an ebook on Hardcover .*data-pick="fixOut:1"> Take out what it has of that edition: ASIN B0LANTERNK \(nothing else is left, so the edition is removed\)<\/label><\/li><li>.*data-pick="fixIn:1"> Take those out and fill it in from the audiobook edition on Hardcover: amazon\.com id, Hardcover id /,
	);
	assert.ok(
		els.importPreviewBody.querySelectorAll('input[data-pick^="fix"]').every(box => !box.checked),
		'nothing is ticked at first',
	);
	const tick = (pick: any) => {
		const box = els.importPreviewBody.querySelector(`input[data-pick="${pick}"]`)!;
		box.checked = true;
		box.dispatch('change');
	};
	tick('fixIn:0');
	tick('fixOut:1');
	await els.importConfirm.listeners.click[0]();
	await idle();
	assert.match(els.ioStatus.textContent, /put right the editions of 2 books/);
	const books = (await kept(storage)).books;
	assert.deepEqual(
		books.find((b: any) => b.t === 'Brine Songs').e,
		[{ext: {'amazon.com': 'B0BRINEAUD', hardcover: '812'}, n: ['Hollis Marr'], len: 500}],
		"the print edition's values are out, and the audiobook edition's in",
	);
	assert.equal(books.find((b: any) => b.t === 'Lantern Hours').e, undefined, 'an edition left with nothing is gone');
});
test('your server is kept in this browser, checked when saved, and only ever sent its own key', async () => {
	// the real Worker (server/worker.js) behind the page, with no catalog behind it
	const env = {SERVER_KEY: 'right-key', ALLOWED_ORIGINS: 'https://example.github.io'};
	const sent: any[] = [];
	const proxy = async (url: string, init: any = {}) => {
		sent.push({url, headers: init.headers});
		const request = new Request(url, {headers: {...init.headers, Origin: 'https://example.github.io'}});
		return handleServer(request, env, {
			fetch: async () => {
				throw new Error('no catalog in this test');
			},
		});
	};
	const storage = new Map<string, string>();
	const {els} = await boot({page: 'import.html', proxy, storage});
	assert.match(els.serverState.textContent, /Paste your server's address and key/);
	assert.equal(els.serverCheck.style.display, 'none');

	els.serverUrl.value = 'http://catalog-proxy.example.workers.dev';
	els.serverKey.value = 'right-key';
	await els.serverSave.listeners.click[0]();
	assert.match(els.ioStatus.textContent, /Paste the server's address first/, 'not https');
	assert.equal(storage.get('audiobook-catalog-proxy'), undefined);

	els.serverUrl.value = 'https://catalog-proxy.example.workers.dev/';
	els.serverKey.value = 'wrong-key';
	await els.serverSave.listeners.click[0]();
	assert.match(els.ioStatus.textContent, /^Server saved; your server refused the key\. Dismiss$/);

	els.serverUrl.value = 'https://catalog-proxy.example.workers.dev/';
	els.serverKey.value = ' right-key ';
	await els.serverSave.listeners.click[0]();
	assert.equal(
		els.ioStatus.textContent,
		'Server saved; it answers: its catalog proxy asks audiobookdb, audible, bookbrainz, isfdb, and sync is not set up on it.',
	);
	assert.deepEqual(JSON.parse(storage.get('audiobook-catalog-proxy')!), {
		url: 'https://catalog-proxy.example.workers.dev',
		key: 'right-key',
	});
	assert.equal(els.serverKey.value, '', 'the key is not left in the page');
	assert.match(els.serverState.textContent, /Saved in this browser only .*catalog-proxy\.example\.workers\.dev/);
	assert.ok(sent.every(s => s.url === 'https://catalog-proxy.example.workers.dev/ping'));
	assert.equal(JSON.stringify(sent.at(-1).headers), '{"X-Server-Key":"right-key"}');

	await els.serverCheck.listeners.click[0]();
	assert.match(els.ioStatus.textContent, /^Your server answers/);
	await els.serverRemove.listeners.click[0]();
	assert.equal(storage.get('audiobook-catalog-proxy'), undefined);
	assert.match(els.serverState.textContent, /Paste your server's address/);

	// a proxy the browser can't reach (or that refuses this page, which a browser can't tell apart)
	const away = await boot({
		page: 'import.html',
		storage: new Map<string, string>([
			['audiobook-catalog-proxy', JSON.stringify({url: 'https://gone.example.workers.dev', key: 'k'})],
		]),
	});
	await away.els.serverCheck.listeners.click[0]();
	assert.match(away.els.ioStatus.textContent, /could not reach your server/);

	// a server deployed before the proxy moved under /proxy/ says so
	const before = await boot({
		page: 'import.html',
		proxy: async () => new Response('{"ok":true,"catalogs":["audiobookdb"]}', {status: 200}),
		storage: new Map<string, string>([SERVER_SAVED]),
	});
	await before.els.serverCheck.listeners.click[0]();
	assert.equal(before.els.ioStatus.textContent, 'Your server is from before this version: deploy it again. Dismiss');
});
test('another device is set up from a QR code of the settings saved here, and asks before saving them', async () => {
	const saved = new Map<string, string>([
		[
			'audiobook-catalog-proxy',
			JSON.stringify({url: 'https://catalog-proxy.example.workers.dev', key: 'right-key'}),
		],
		['audiobook-catalog-sync-passphrase', 'sea glass lantern ö'],
		['audiobook-catalog-hardcover-token', 'tok-123'],
		['audiobook-catalog-audiobookdb-key', 'abdb-key'],
	]);
	const pc = await boot({page: 'import.html', storage: saved, files: null});
	const pick = (id: any) => pc.els[`setupPick-${id}`];
	assert.equal(
		pc.els.setupPicks.textContent,
		' Your server (https://catalog-proxy.example.workers.dev) The sync passphrase Your Hardcover API token Your AudiobookDB API key',
	);
	for (const id of ['server', 'passphrase', 'hardcover']) pick(id).checked = true;
	assert.equal(pc.els.setupCode.style.display, 'none');
	await pc.els.setupShowBtn.listeners.click[0]();
	assert.match(pc.els.setupQr.getAttribute('src') ?? '', /^data:image\/gif;base64,/);
	assert.equal(pc.els.setupCode.style.display, '');
	// the link opens this page where the PC has it, with only the ticked settings after the #
	const {link} = pc.get('setupLink()');
	assert.match(link, /^https:\/\/reader\.example\/import\.html#setup=[\w-]+$/);
	await pc.els.setupHideBtn.listeners.click[0]();
	assert.equal(pc.els.setupQr.getAttribute('src'), null);
	assert.equal(pc.els.setupCode.style.display, 'none');

	// the phone opens it: the settings leave the address at once, and nothing is saved until asked
	const asked: any[] = [];
	const proxy = async (url: string, init: any = {}) => {
		asked.push({url, key: init.headers['X-Server-Key']});
		return new Response('{"ok":true,"proxy":["audiobookdb"],"sync":true}', {status: 200});
	};
	const phone = await boot({page: 'import.html', hash: link.slice(link.indexOf('#')), proxy, files: null});
	assert.equal(phone.ctx.location.hash, '');
	assert.deepEqual(
		phone.ctx.history.entries.map((e: any) => e.hash),
		[''],
	);
	assert.equal(phone.els.setupReceived.style.display, '');
	assert.equal(
		phone.els.setupReceivedList.innerHTML,
		'<li>Your server, https://catalog-proxy.example.workers.dev</li><li>The sync passphrase</li><li>Your Hardcover API token</li>',
	);
	assert.equal(phone.storage.get('audiobook-catalog-proxy'), undefined);
	await phone.els.setupReceivedSave.listeners.click[0]();
	assert.deepEqual(JSON.parse(phone.storage.get('audiobook-catalog-proxy')!), {
		url: 'https://catalog-proxy.example.workers.dev',
		key: 'right-key',
	});
	assert.equal(phone.storage.get('audiobook-catalog-sync-passphrase'), 'sea glass lantern ö');
	assert.equal(phone.storage.get('audiobook-catalog-hardcover-token'), 'tok-123');
	assert.equal(phone.storage.get('audiobook-catalog-audiobookdb-key'), undefined, 'not ticked');
	assert.equal(phone.els.setupReceived.style.display, 'none');
	assert.match(phone.els.ioStatus.textContent, /^Settings saved; it answers: /);
	assert.deepEqual(asked, [{url: 'https://catalog-proxy.example.workers.dev/ping', key: 'right-key'}]);
	assert.match(phone.els.serverState.textContent, /Saved in this browser only/);

	// a link opened where settings are saved says it replaces them; Don't save keeps what was there
	const other = await boot({
		page: 'import.html',
		hash: link.slice(link.indexOf('#')),
		storage: new Map<string, string>([saved.entries().next().value!]),
		files: null,
	});
	assert.match(
		other.els.setupReceivedList.innerHTML,
		/<li>Your server, https:\/\/catalog-proxy\.example\.workers\.dev \(in place of the one saved here\)<\/li>/,
	);
	other.els.setupReceivedSkip.listeners.click[0]();
	assert.equal(other.els.ioStatus.textContent, 'Nothing saved.');
	assert.equal(other.storage.get('audiobook-catalog-sync-passphrase'), undefined);
	assert.equal(other.ctx.location.hash, '');

	// a page on this computer only (make serve) links to the server, which serves the app too; without one it can't
	const local = await boot({
		page: 'import.html',
		storage: new Map(saved),
		origin: 'http://127.0.0.1:8000',
		files: null,
	});
	local.els['setupPick-hardcover'].checked = true;
	assert.match(local.get('setupLink()').link, /^https:\/\/catalog-proxy\.example\.workers\.dev\/import\.html#setup=/);
	const alone = await boot({
		page: 'import.html',
		storage: new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]),
		origin: 'http://127.0.0.1:8000',
		files: null,
	});
	alone.els['setupPick-hardcover'].checked = true;
	await alone.els.setupShowBtn.listeners.click[0]();
	assert.match(alone.els.ioStatus.textContent, /^This page is on this computer only/);
	assert.equal(alone.els.setupCode.style.display, 'none');
	// nothing ticked, nothing shown; nothing saved, nothing to show
	alone.els['setupPick-hardcover'].checked = false;
	await alone.els.setupShowBtn.listeners.click[0]();
	assert.equal(alone.els.ioStatus.textContent, 'Tick a setting to hand over first. Dismiss');
	const empty = await boot({page: 'import.html', files: null});
	assert.equal(empty.els.setupShowBtn.style.display, 'none');
	assert.match(empty.els.setupState.textContent, /^Nothing to hand over yet/);
});

test("a set-up link's server is saved as Your server reads it: its address tidied, never one it can't use", async () => {
	const kept = {url: 'https://catalog-proxy.example.workers.dev', key: 'right-key'};
	const open = async (server: {url: string; key: string}) => {
		const link = DeviceSetup.link('https://reader.example/import.html', {server});
		const page = await boot({
			page: 'import.html',
			hash: link.slice(link.indexOf('#')),
			storage: new Map<string, string>([['audiobook-catalog-proxy', JSON.stringify(kept)]]),
			files: null,
		});
		await page.els.setupReceivedSave.listeners.click[0]();
		return JSON.parse(page.storage.get('audiobook-catalog-proxy')!);
	};
	assert.deepEqual(await open({url: ' https://other-proxy.example.workers.dev/ ', key: ' other-key '}), {
		url: 'https://other-proxy.example.workers.dev',
		key: 'other-key',
	});
	assert.deepEqual(await open({url: 'http://other-proxy.example.workers.dev', key: 'other-key'}), kept, 'not https');
});
test('devices sync through your server: encrypted, taking in what the others changed, and asking when both changed a book', async () => {
	// the real Worker behind the pages, with a D1 database for the synced copy
	const database = new DatabaseSync(':memory:');
	const env: Env = {
		SERVER_KEY: 'right-key',
		ALLOWED_ORIGINS: 'https://example.github.io',
		SYNC_DB: sqliteD1(database),
	};
	// the copy the server keeps
	const row = () =>
		database.prepare('SELECT revision, data FROM sync WHERE id = 1').get() as {revision: number; data: string};
	const sent: any[] = [];
	const proxy = async (url: string, init: any = {}) => {
		sent.push({url, method: init.method || 'GET', body: init.body});
		const request = new Request(url, {
			method: init.method,
			body: init.body,
			headers: {...init.headers, Origin: 'https://example.github.io'},
		});
		return handleServer(request, env, {fetch: async () => new Response('', {status: 500})});
	};
	// `idPrefix` gives a browser ids of its own (each fake one counts id-1, id-2, ... alike, where real ones never meet)
	const device = async (files: any, passphrase = 'sea glass lantern', idPrefix = '') => {
		const storage = new Map<string, string>([
			[
				'audiobook-catalog-proxy',
				JSON.stringify({url: 'https://catalog-proxy.example.workers.dev', key: 'right-key'}),
			],
			...(passphrase ? [['audiobook-catalog-sync-passphrase', passphrase] as [string, string]] : []),
		]);
		let n = 0;
		if (idPrefix) databaseOf(storage).newId = () => `${idPrefix}-${++n}`;
		const page = await boot({page: 'import.html', proxy, files, storage});
		await idle();
		return page;
	};
	const sync = async (page: any, button = 'syncBtn') => {
		await page.els[button].listeners.click[0]();
		await idle();
		return page.els.ioStatus.textContent;
	};
	const titles = async (storage: any) => (await kept(storage)).books.map((b: any) => b.t).sort();

	const pc = await device(DEMO);
	assert.match(pc.els.syncState.textContent, /Not synced from this browser yet/);
	assert.match(pc.els.syncPassphraseState.textContent, /saved in this browser only/);
	assert.equal(await sync(pc), "Synced: nothing new from your other devices; this device's catalog sent.");
	assert.equal(row().revision, 1);
	assert.ok(!row().data.includes('The Salt Road'), 'the server keeps nothing it can read');
	assert.match(pc.els.syncState.textContent, /^Last synced /);

	// a phone with nothing yet takes the whole catalog
	const phone = await device(null);
	assert.match(await sync(phone), /^Synced: \d+ changes taken in from your other devices; nothing to send\.$/);
	assert.deepEqual(await titles(phone.storage), await titles(pc.storage));
	assert.equal(row().revision, 1);

	// a date read added on the phone reaches the PC
	const id = bookIdAt(phone.get, 0);
	phone.run(`CATALOG.books.find(b => b.id === '${id}').read = ['2025-03-04']; persist()`);
	await idle();
	assert.match(await sync(phone), /this device's catalog sent\.$/);
	assert.match(await sync(pc), /^Synced: 1 change taken in/);
	assert.deepEqual(pc.database.records('books').find(b => b.id === id).read, ['2025-03-04']);

	// both retitle that book: the PC syncs first, so the phone asks which to keep
	pc.run(`CATALOG.books.find(b => b.id === '${id}').title = 'Retitled on the PC'; persist()`);
	phone.run(`CATALOG.books.find(b => b.id === '${id}').title = 'Retitled on the phone'; persist()`);
	await idle();
	await sync(pc);
	assert.equal(await sync(phone), 'Not synced: another device changed these too. Dismiss');
	assert.equal(phone.els.syncChoice.style.display, '');
	assert.match(phone.els.syncChoiceText.textContent, /"Retitled on the phone"\. Keep which\?$/);
	assert.equal(phone.els.syncReplace.style.display, 'none');
	assert.equal(
		phone.database.records('books').find(b => b.id === id).title,
		'Retitled on the phone',
		'nothing changed',
	);
	assert.match(await sync(phone, 'syncKeepTheirs'), /^Synced: 1 change taken in/);
	assert.equal(phone.database.records('books').find(b => b.id === id).title, 'Retitled on the PC');
	assert.equal(phone.els.syncChoice.style.display, 'none');

	// another passphrase can't open the copy, and changes nothing
	const before = row().revision;
	const stranger = await device(null, 'another passphrase');
	assert.match(await sync(stranger), /^Not synced: the passphrase does not open the synced copy\./);
	assert.equal(await kept(stranger.storage), null);
	assert.equal(row().revision, before);
	// a catalog made apart from the synced one can only be replaced by it
	const apart = await device(DEMO, 'sea glass lantern', 'apart');
	assert.equal(
		await sync(apart),
		'Not synced: this catalog and the synced one were not made from the same catalog. Dismiss',
	);
	assert.equal(apart.els.syncReplace.style.display, '');
	assert.match(await sync(apart, 'syncReplace'), /^Synced: /);
	assert.ok((await titles(apart.storage)).includes('Retitled on the PC'));
	// the passphrase is only ever sent sealed in, never as it is
	assert.ok(sent.every(s => !String(s.body || '').includes('sea glass lantern')));

	// without a passphrase, or with sync not set up on the proxy, it says so
	const bare = await device(DEMO, '');
	assert.match(await sync(bare), /^Not synced: save a sync passphrase first\. Dismiss$/);
	bare.els.syncPassphrase.value = 'sea glass lantern';
	bare.els.syncPassphraseSave.listeners.click[0]();
	assert.equal(bare.storage.get('audiobook-catalog-sync-passphrase'), 'sea glass lantern');
	assert.equal(bare.els.syncPassphrase.value, '');
	delete env.SYNC_DB;
	assert.match(await sync(bare), /^Not synced: sync is not set up on your server/);
});
test('a Hardcover comparison sends nothing unticked, nothing once another tab saved, and says when Hardcover cannot be reached', async () => {
	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
	];
	const state = hardcoverState();
	const hc = fakeHardcover(state);
	const setTimeout = (fn: () => unknown, ms: number) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const page = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	const {els, get} = page;
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	// as it opens, only what an import takes is ticked
	await els.importConfirm.listeners.click[0]();
	await idle();
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')), 'nothing ticked to send, nothing sent');
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Lantern Hours', 'Tidewater']);
	assert.equal(get("CATALOG.books[0].idOn('hardcover')"), '80');
	assert.match(els.ioStatus.textContent, /^Added 1 book, saved Hardcover ids found for 1 book\.$/);

	// compared, then another tab saves an edit: applying changes and sends nothing
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	const add =
		els.importPreviewBody.querySelector('input[data-pick="reads:0"]') ||
		els.importPreviewBody.querySelector('input[data-pick="add:0"]');
	assert.ok(add, 'Lantern Hours is still to be put on Hardcover');
	add.checked = true;
	add.dispatch('change');
	const other = await boot({page: 'duplicates.html', storage}); // a page that holds every book
	await other.run("CATALOG.books[0].genres = ['Fantasy']; persist();");
	await other.saved();
	await els.importConfirm.listeners.click[0]();
	await idle();
	assert.match(
		els.ioStatus.textContent,
		/edited in another tab since you compared; nothing was changed, nothing sent to Hardcover/,
	);
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));

	const offline = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		setTimeout,
		storage: new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]),
	});
	await offline.els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	assert.match(
		offline.els.importPreviewBody.innerHTML,
		/Couldn't compare: this browser could not reach Hardcover \(offline/,
	);
	assert.equal(offline.els.importConfirm.style.display, 'none');
});
// The Edit series page, with the other catalogs asked (edit-catalogs.js): they are asked only when Ask the
// catalogs is pressed, so a small edit doesn't wait on them.
const bootAsked = async (hash: string, options = {}) => {
	const page = await boot({...options, page: 'edit.html', hash});
	await idle();
	await page.ctx.ASKING;
	page.els.askBtn.listeners.click[0]();
	await page.ctx.ASKING;
	await idle();
	return page;
};
test('the Edit page shows the catalogs to ask when it opens, and asks them only when Ask the catalogs is pressed', async () => {
	const mine = [{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2'}];
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn: () => unknown, ms: number) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const page = await boot({
		page: 'edit.html',
		hash: '#series=Gull+Isle',
		files: {'books.json': JSON.stringify(mine)},
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	await idle();
	await page.ctx.ASKING;
	await idle();
	const {els, get} = page;
	assert.match(els.catalogPicks.innerHTML, /id="catalog-hardcover" checked=""/);
	assert.equal(hc.sent.length, 0, 'nothing is asked on open');
	assert.equal(get('RUN'), null);
	assert.equal(els.catalogNotes.textContent, '');
	assert.equal(els.askBtn.textContent, 'Ask the catalogs');
	els.askBtn.listeners.click[0]();
	await page.ctx.ASKING;
	await idle();
	assert.ok(hc.sent.length > 0);
	assert.match(els.catalogNotes.textContent, /Hardcover: \d+ books? read\./);
	assert.equal(els.askBtn.textContent, 'Ask again');
});
test("a book's Edit page asks the other catalogs about that book only, by its series (else its first author), and offers no other books", async () => {
	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2'},
	];
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn: () => unknown, ms: number) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const options = {files: {'books.json': JSON.stringify(mine)}, hardcover: hc.fetch, setTimeout, storage};
	const series = await bootAsked('#series=Gull+Isle', options);
	assert.match(series.els.editBooks.innerHTML, /class="editNew/, "the series' page offers the books it lacks");
	assert.ok(
		hc.sent.some(s => /ShelfBySeries/.test(s.query)),
		"the series' page reads the series' shelf entries",
	);
	hc.sent.length = 0;
	const book = await bootAsked('#book=Brine+Tide', {...options, files: null});
	const bookId = book.get('BOOK_ID');
	assert.deepEqual(book.get('RUN.part'), {kind: 'series', name: 'Gull Isle', books: [bookId]});
	assert.equal(book.get('DRAFTS.length'), 1);
	assert.doesNotMatch(book.els.editBooks.innerHTML, /class="editNew/);
	assert.match(book.els.catalogNotes.innerHTML, /Hardcover: 0 books read\./);
	// only the book itself is asked about: not the series there, nor its other books on your shelf
	assert.ok(!hc.sent.some(s => /ShelfBySeries|ShelfByAuthor/.test(s.query)), 'no series or author is read');
	assert.equal(book.get('RUN.review.fresh.length'), 0);
	const lone = await bootAsked('#book=Lantern+Hours', {...options, files: null});
	assert.deepEqual(lone.get('RUN.part'), {kind: 'author', name: 'R. T. Hale', books: [lone.get('BOOK_ID')]});
	// a new book is asked of no catalog
	const added = await bootAdd('', {...options, files: null});
	await added.ctx.ASKING;
	assert.equal(added.get('RUN'), null);
});
test("the Edit series page compares a series' books with Hardcover when asked, and adds a new book only when ticked", async () => {
	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2'},
	];
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn: () => unknown, ms: number) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const options = {files: {'books.json': JSON.stringify(mine)}, hardcover: hc.fetch, setTimeout, storage};
	const edit = await bootAsked('#series=Gull+Isle', options);
	const {els, get} = edit;
	// every catalog set up is asked, each with its site's favicon for an icon; those that can't be say why
	assert.match(
		els.catalogPicks.innerHTML,
		/<span class="catIcon cat-hardcover favicon" data-mark="Hc" style="--cat: #4f46b5" aria-hidden="true"><img src="https:\/\/assets\.hardcover\.app\/static\/favicon\.ico" alt="" referrerpolicy="no-referrer" decoding="async"><\/span>/,
	);
	// a favicon that can't be loaded leaves the catalog's mark, which CSS draws
	const hcIcon = els.catalogPicks.querySelector('.cat-hardcover')!;
	hcIcon.querySelector('img')!.listeners.error[0]();
	assert.match(
		els.catalogPicks.innerHTML,
		/<span class="catIcon cat-hardcover" data-mark="Hc" style="--cat: #4f46b5" aria-hidden="true"><\/span>/,
	);
	assert.match(
		els.catalogPicks.innerHTML,
		/<input type="checkbox" id="catalog-hardcover" checked=""> <span class="catIcon cat-hardcover[^"]*"[^>]*>(?:<img [^>]*>)?<\/span>Hardcover/,
	);
	assert.match(
		els.catalogPicks.innerHTML,
		/id="catalog-audiobookdb" disabled=""> <span class="catIcon cat-audiobookdb[^"]*"[^>]*>(?:<img [^>]*>)?<\/span>AudiobookDB<span class="editWhy"> \(needs your server's catalog proxy/,
	);
	assert.match(els.catalogNotes.textContent, /Hardcover: 1 book read\./);
	assert.match(els['book-0'].innerHTML, /not found on Hardcover/);
	assert.match(els.editBooks.innerHTML, /Add Tidewater — Ann Vale {2}\[Gull Isle #1\]/);
	assert.deepEqual(
		[...els.editBooks.innerHTML.matchAll(/id="((?:book|fresh)-\d+)"/g)].map(m => m[1]),
		['fresh-0', 'book-0'],
		'book 1 before your book 2',
	);
	assert.doesNotMatch(els.editBooks.innerHTML, /Paper Fen|Lantern Hours/);
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')), 'nothing is sent');
	assert.equal(els.changeCount.textContent, 'No changes yet', 'nothing is picked at first');

	// ticked, it shows the whole form, as Hardcover has it, and is added on Save as changed there
	els['fresh-0-add'].checked = true;
	els['fresh-0-add'].listeners.change[0]({target: els['fresh-0-add']});
	assert.equal(els.changeCount.textContent, '1 change');
	assert.equal(get('DRAFTS[1].added.kind'), 'fresh');
	assert.ok(els['fresh-0'].querySelector('#book-1'), "the new book's card is in its Add card");
	assert.equal(els.b1_t.value, 'Tidewater');
	assert.equal(els.b1_a.value, 'Ann Vale');
	assert.equal(els.bookCount.textContent, '1 book', 'your books only');
	assert.doesNotMatch(els['book-1'].innerHTML, /The book's page/);
	els.b1_t.value = 'Tidewater Rising';
	els.b1_t.listeners.change[0]();
	assert.equal(els.changeCount.textContent, '2 changes');
	await els.reviewBtn.listeners.click[0]();
	await idle();
	assert.match(
		els.reviewList.textContent,
		/New book: Tidewater — Ann Vale {2}\[Gull Isle #1\], as Hardcover has it, changed here/,
	);
	assert.match(els.reviewList.textContent, /Tidewater Rising: Title: Tidewater → Tidewater Rising/);
	await els.reviewSaveBtn.listeners.click[0]();
	await idle();
	assert.match(els.ioStatus.textContent, /^Added 1 book\./);
	assert.deepEqual(
		(await kept(storage)).books.map((b: any) => [b.t, b.s, b.sn]),
		[
			['Lantern Hours', undefined, undefined],
			['Brine Tide', 'Gull Isle', '2'],
			['Tidewater Rising', 'Gull Isle', '1'],
		],
	);
	assert.equal(get('CATALOG.books.length'), 3);

	// a catalog unticked is left out of the next run, remembered in this browser
	const again = await bootAsked('#series=Gull+Isle', {...options, files: null});
	again.els['catalog-hardcover'].checked = false;
	again.els['catalog-hardcover'].listeners.change[0]({target: again.els['catalog-hardcover']});
	assert.equal(storage.get('audiobook-catalog-edit-skip'), '["hardcover"]');
	const asked = hc.sent.length;
	again.els.askBtn.listeners.click[0]();
	await again.ctx.ASKING;
	assert.equal(hc.sent.length, asked);
	assert.match(again.els.catalogNotes.textContent, /No catalog is ticked/);
	assert.doesNotMatch(again.els.editBooks.innerHTML, /editOut|not found on/, 'nothing of the last run is shown');
});
test("a series' and an author's page link to the Edit page, which old links to their comparison go to", async () => {
	const home = await boot({hash: '#series=The+Lantern+Coast'});
	await idle();
	assert.match(
		home.readable(home.els.results.innerHTML),
		/<div class="page-actions"><a class="sedit" data-series="[^"]+" href="edit\.html#series=The\+Lantern\+Coast">Edit<\/a><\/div>/,
	);
	assert.doesNotMatch(home.els.results.innerHTML, /catalogCompare/);
	const author = await boot({page: 'author.html', hash: '#a=Marisol+Quenby'});
	assert.match(
		author.readable(author.els.creditBody.innerHTML),
		/<a class="sedit" href="edit\.html#author=id-\d+">Edit their books<\/a>/,
	);
	for (const [hash, to] of [
		['#hardcover-author=Ann+Vale', 'edit.html#author=Ann+Vale'],
		['#all-series=id-3', 'edit.html#series=id-3'],
		['#audible-series=Gull+Isle', 'edit.html#series=Gull+Isle'],
	]) {
		const io = await boot({page: 'import.html', hash, files: null});
		assert.equal(io.ctx.location.replaced, to, hash);
	}

	// an author's books, by name as from an older link: their series is a field of each book
	const mine = [
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2'},
		{t: 'Lantern Hours', a: ['R. T. Hale']},
	];
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn: () => unknown, ms: number) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const {els, get} = await bootAsked('#author=Ann+Vale', {
		files: {'books.json': JSON.stringify(mine)},
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	assert.equal(get('KIND'), 'author');
	assert.equal(els.seriesPanel.hidden, true);
	assert.equal(els.eyebrow.textContent, "Edit an author's books");
	assert.deepEqual(get('DRAFTS.map(d => d.book.title)'), ['Brine Tide']);
	assert.equal(els.b0_s.value, 'Gull Isle');
	assert.match(els.catalogNotes.textContent, /Hardcover: 2 books read\./);
	assert.match(els.editBooks.innerHTML, /Tidewater — Ann Vale/);
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));
	assert.equal(get('CATALOG.books.length'), 2, 'comparing changes nothing');
	// the series typed on a book is saved with it, and Save goes back to the author's page
	els.b0_s.value = 'Gull Isles';
	els.b0_s.listeners.change[0]();
	assert.ok(await saveEdit({els}));
	assert.equal((await kept(storage)).books[0].s, 'Gull Isles');
	assert.equal(get('location.assigned'), 'author.html#a=' + get('AUTHOR_ID'));
});
// ------------------------------------------------------------------ AudiobookDB
const SERVER_ENV = {SERVER_KEY: 'right-key', ALLOWED_ORIGINS: 'https://example.github.io'};
const SERVER_SAVED: [string, string] = [
	'audiobook-catalog-proxy',
	JSON.stringify({url: 'https://catalog-proxy.example.workers.dev', key: 'right-key'}),
];
/** The real Worker (server/worker.js) in front of a fake AudiobookDB, as the page reaches it; `asked` is what the page sent. */
function audiobookdbBehindProxy(state = audiobookdbState()) {
	const abdb = fakeAudiobookdb(state);
	const asked: any[] = [];
	const proxy = async (url: string, init: any = {}) => {
		asked.push({url, headers: init.headers, method: init.method || 'GET'});
		const request = new Request(url, {
			method: init.method,
			body: init.body,
			headers: {...init.headers, Origin: 'https://example.github.io'},
		});
		return handleServer(request, SERVER_ENV, {fetch: abdb.fetch});
	};
	return {state, abdb, proxy, asked};
}
// the pause between AudiobookDB requests passes at once
const abdbTimeout = (fn: () => unknown, ms: number) => {
	if (ms === 500) Promise.resolve().then(fn);
	return 0;
};
test('the page compares the catalog with AudiobookDB through the proxy, with a key kept in this browser, and puts only what is ticked on your Read shelf', async () => {
	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [{ext: {'audible.com': 'B0BRINETD1'}}]},
	];
	const {state, abdb, proxy, asked} = audiobookdbBehindProxy();
	let leaving: any = null; // what leaving the page while it sends would do
	state.onAdd = () => {
		if (!leaving) {
			leaving = {
				preventDefault() {
					this.prevented = true;
				},
			};
			page.fire('beforeunload', leaving);
		}
	};
	const storage = new Map<string, string>([SERVER_SAVED]);
	const page = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		proxy,
		storage,
		setTimeout: abdbTimeout,
	});
	const {els, get, readable} = page;
	assert.match(
		els.audiobookdbKeyState.textContent,
		/Paste an API key from audiobookdb\.org .* Without it, Compare only finds your books there\./,
	);
	assert.equal(els.audiobookdbKeyRemove.style.display, 'none');

	// without a key, Compare only finds your books, and asks nothing of your account
	await els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	assert.equal(els.importPreviewTitle.textContent, 'Compare with AudiobookDB');
	assert.equal(els.importPreview.place, 'after audiobookdbPanel');
	let html = readable(els.importPreviewBody.innerHTML);
	assert.match(html, /^<p>2 books in this catalog, 2 of them on AudiobookDB \(took 0:00\)<\/p>/);
	assert.match(html, /Save your AudiobookDB API key \(below the buttons\) to compare your shelves too/);
	assert.match(
		html,
		/<input type="checkbox" data-pick="ids" checked=""> Save the AudiobookDB ids and covers found for 2 books, 3 series and people/,
	);
	assert.ok(
		abdb.sent.every(s => s.method === 'GET' && s.key === null),
		'no key, and nothing sent',
	);
	assert.ok(!abdb.sent.some(s => s.path.startsWith('users/') || s.path === 'auth/session'));
	els.importCancel.listeners.click[0]();

	els.audiobookdbKey.value = ' abdb-key-1 ';
	els.audiobookdbKeySave.listeners.click[0]();
	assert.equal(storage.get('audiobook-catalog-audiobookdb-key'), 'abdb-key-1');
	assert.equal(els.audiobookdbKey.value, '', 'the key is not left in the page');
	assert.match(els.audiobookdbKeyState.textContent, /saved in this browser only/);

	// with it: your Read shelf beside the catalog, and your books to put there
	abdb.sent.length = 0;
	await els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	html = readable(els.importPreviewBody.innerHTML);
	assert.match(
		html,
		/^<p>2 books in this catalog, 2 of them on AudiobookDB, 2 books on your AudiobookDB Listened shelf \(took 0:00\)<\/p>/,
	);
	assert.match(
		html,
		/New from AudiobookDB \(1\)<\/h4><ul class="cmpRows"><li><label class="cmpPick"><input type="checkbox" data-pick="take:0" checked=""> Tidewater — Ann Vale {2}\[Gull Isle #1\]/,
	);
	assert.match(
		html,
		/Not on your AudiobookDB Listened shelf \(1\)<\/h4>.*<input type="checkbox" data-pick="add:0"> Lantern Hours — R\. T\. Hale<\/label>/,
	);
	assert.match(
		html,
		/On another AudiobookDB shelf, left alone \(1\)<\/h4>.*Brine Tide — Ann Vale {2}\[Gull Isle #2\]: Currently Listening/,
	);
	assert.match(
		html,
		/Not added, as AudiobookDB has several releases of them and none is yours: 1\..*The Paper Fen — Ann Vale/,
	);
	assert.match(html, /Save the AudiobookDB ids and covers found for 2 books, 5 series and people/);
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');
	assert.ok(!abdb.sent.some(s => s.method === 'POST'), 'comparing sends nothing');
	// the key went only where it is needed
	assert.deepEqual(
		[...new Set(abdb.sent.filter(s => s.key).map(s => s.path))],
		['auth/session', 'users/username/reader/shelves'],
	);
	assert.ok(abdb.sent.filter(s => s.key).every(s => s.key === 'abdb-key-1'));
	assert.ok(asked.every(a => a.headers['X-Server-Key'] === 'right-key'));
	assert.ok(
		asked.every(a => !a.headers['X-Catalog-Key'] || /\/audiobookdb\/(auth\/session|users\/)/.test(a.url)),
		'the page sends the key only there too',
	);

	const add = els.importPreviewBody.querySelector('input[data-pick="add:0"]')!;
	add.checked = true;
	add.dispatch('change');
	assert.equal(els.importConfirm.textContent, 'Apply 3 changes');
	await els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Lantern Hours', 'Brine Tide', 'Tidewater']);
	const saved = await kept(storage);
	assert.deepEqual(
		saved.books.map((b: any) => [b.t, b.ext, b.e.map((e: any) => e.ext)]),
		[
			[
				'Lantern Hours',
				{audiobookdb: 'LntrnHours01'},
				[{'audible.com': 'B0LANTERN1', audiobookdb: 'RlsLntrnHrs1'}],
			],
			['Brine Tide', {audiobookdb: 'BrineTide001'}, [{'audible.com': 'B0BRINETD1', audiobookdb: 'RlsBrineUS01'}]],
			['Tidewater', {audiobookdb: 'Tidewater001'}, [{'audible.com': 'B0TIDEWAT1', audiobookdb: 'RlsTidewatr1'}]],
		],
	);
	// the covers: Lantern Hours' book's (its release has none), Tidewater's release's; Brine Tide has none
	assert.deepEqual(
		saved.books.map((b: any) => b.e.map((e: any) => e.img)),
		[[{audiobookdb: 'a1'.repeat(32)}], [undefined], [{audiobookdb: 'd2'.repeat(32)}]],
	);
	assert.deepEqual(saved.authors['R. T. Hale'].ext, {audiobookdb: 'PrsnHale0001'});
	assert.deepEqual(saved.authors['Ann Vale'].ext, {audiobookdb: 'PrsnVale0001'});
	assert.deepEqual(saved.seriesInfo['Gull Isle'].ext, {audiobookdb: 'SrsGullIsle1'});
	assert.deepEqual(saved.narrators['Dana Fenwick'].ext, {audiobookdb: 'PrsnFnwk0001'});
	assert.deepEqual(saved.publishers['Gullwing Audio'].ext, {audiobookdb: 'PblshrGullw1'});
	assert.deepEqual(
		abdb.sent.filter(s => s.method === 'POST').map(s => [s.path, s.key]),
		[['users/username/reader/shelves/listened/books', 'abdb-key-1']],
	);
	assert.deepEqual(
		state.shelves[2].books.map((b: any) => b.id),
		['Tidewater001', 'PaperFen0001', 'LntrnHours01'],
	);
	assert.ok(leaving.prevented, 'leaving while it sends is asked about');
	assert.match(els.importPreviewBody.innerHTML, /put 1 book\(s\) on your AudiobookDB Listened shelf/);
	assert.match(
		els.ioStatus.textContent,
		/^Added 1 book, saved AudiobookDB ids and covers found for 2 books and 5 series and people; AudiobookDB updated\./,
	);
	assert.ok(
		![...storage.entries()].some(
			([k, v]: [string, string]) => k !== 'audiobook-catalog-audiobookdb-key' && v.includes('abdb-key-1'),
		),
		'the key is in no backup or record',
	);

	// comparing again: nothing left to send, nothing left to take
	await els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	html = readable(els.importPreviewBody.innerHTML);
	assert.doesNotMatch(html, /Not on your AudiobookDB Listened shelf|New from AudiobookDB|Save the AudiobookDB ids/);
});
test("the Edit series page compares a series' or an author's books with AudiobookDB through the proxy", async () => {
	const mine = [
		{t: 'Lantern Hours', a: ['R. T. Hale'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]},
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [{ext: {'audible.com': 'B0BRINETD1'}}]},
	];
	const {abdb, proxy} = audiobookdbBehindProxy();
	const storage = new Map<string, string>([SERVER_SAVED, ['audiobook-catalog-audiobookdb-key', 'abdb-key-1']]);
	const options = {files: {'books.json': JSON.stringify(mine)}, proxy, storage, setTimeout: abdbTimeout};
	const {els, get} = await bootAsked('#series=Gull+Isle', options);
	assert.match(els.catalogNotes.textContent, /AudiobookDB: \d+ books? read\./);
	assert.match(
		els['book-0'].innerHTML,
		/<a href="https:\/\/audiobookdb\.org\/[^"]+" target="_blank" rel="noopener" class="editOut"><span class="catIcon cat-audiobookdb[^"]*"[^>]*>(?:<img [^>]*>)?<\/span>AudiobookDB ↗<\/a>/,
	);
	assert.match(els.editBooks.innerHTML, /Add Tidewater — Ann Vale/);
	// a book only listed in the series there is a card too, read from AudiobookDB only once ticked
	assert.match(els['missing-0'].textContent, /^Not in your catalog Add 3\. Gull Song/);
	assert.match(els['missing-0'].innerHTML, /href="https:\/\/audiobookdb\.org\/[^"]*GullSong0001"/);
	assert.ok(!abdb.sent.some(s => s.path.startsWith('books/GullSong0001')), 'not read before it is ticked');
	// the ids it found for a book not on your shelves there: the book's with the book, the edition's on its card,
	// whose summary says there is something to review
	assert.match(els['book-0-take-0-ids'].textContent, /^AudiobookDB: Ids: AudiobookDB BrineTide001Take$/);
	assert.match(
		els['book-0-ed-0'].innerHTML,
		/<summary>.*<span class="editPill review"[^>]*>.*to review<\/span><\/summary>/,
	);
	assert.match(els['book-0-ed-0-take-0-ids'].textContent, /^AudiobookDB: .*RlsBrineUS01/);
	await els['book-0-take-0-ids-do'].listeners.click[0]();
	assert.ok(!get("DRAFTS[0].book.editions[0].idOn('audiobookdb')"), 'the book alone');
	await els['book-0-ed-0-take-0-ids-do'].listeners.click[0]();
	assert.doesNotMatch(els['book-0'].innerHTML, /editTake|to review/, 'nothing more to take');
	assert.equal(get("DRAFTS[0].book.idOn('audiobookdb')"), 'BrineTide001');
	assert.equal(get("DRAFTS[0].book.editions[0].idOn('audiobookdb')"), 'RlsBrineUS01');
	assert.doesNotMatch(els.editBooks.innerHTML, /Paper Fen|Lantern Hours/);
	assert.ok(abdb.sent.some(s => s.path === 'series/SrsGullIsle1?include=books'));
	assert.ok(
		!abdb.sent.some(s => s.path === 'audiobooks/external/audible/B0LANTERN1'),
		"only the series' books are looked up",
	);
	assert.ok(!abdb.sent.some(s => s.method === 'POST'), 'nothing is sent');
	assert.equal(get('CATALOG.books.length'), 2, 'comparing changes nothing');
	els['missing-0-add'].checked = true;
	els['missing-0-add'].listeners.change[0]({target: els['missing-0-add']});
	await idle();
	assert.ok(abdb.sent.some(s => s.path.startsWith('books/GullSong0001')));
	assert.match(els['missing-0'].textContent, /^Not in your catalog Add 3\. Gull Song by Ann Vale/);
	// read, its whole form is shown to change before it is added
	const at = get("DRAFTS.findIndex(d => d.added && d.added.kind === 'missing')");
	assert.ok(els['missing-0'].querySelector(`#book-${at}`));
	assert.equal(els[`b${at}_t`].value, 'Gull Song');
	els[`b${at}_g`].value = 'Fantasy';
	els[`b${at}_g`].listeners.change[0]();
	assert.ok(await saveEdit({els}));
	const saved = await kept(storage);
	assert.deepEqual(saved.books.find((b: any) => b.t === 'Gull Song').g, ['Fantasy'], 'as changed on the page');
	assert.deepEqual(
		saved.books.map((b: any) => [b.t, b.s, b.sn, b.ext, (b.e || []).map((e: any) => e.ext)]),
		[
			['Lantern Hours', undefined, undefined, undefined, [{'audible.com': 'B0LANTERN1'}]],
			[
				'Brine Tide',
				'Gull Isle',
				'2',
				{audiobookdb: 'BrineTide001'},
				[{'audible.com': 'B0BRINETD1', audiobookdb: 'RlsBrineUS01'}],
			],
			['Gull Song', 'Gull Isle', '3', {audiobookdb: 'GullSong0001'}, [{audiobookdb: 'RlsGullSng01'}]],
		],
		'the missing book ticked is added as AudiobookDB has it',
	);

	// an author's books: only theirs are looked up
	const byHale = await bootAsked('#author=R.+T.+Hale', {...options, files: null});
	assert.deepEqual(byHale.get('DRAFTS.map(d => d.book.title)'), ['Lantern Hours']);
	assert.match(byHale.els['book-0'].innerHTML, /AudiobookDB ↗/);
	assert.doesNotMatch(byHale.els.editBooks.innerHTML, /Tidewater|Brine Tide/);
});
test('the Edit series page offers to put right, with Take, an edition Hardcover has as a print book or an ebook', async () => {
	const mine = [
		{
			t: 'Brine Songs',
			a: ['Ann Vale'],
			s: 'Brine Cycle',
			sn: '1',
			ext: {hardcover: '81'},
			e: [{ext: {hardcover: '811'}, isbn: '9780000000002', p: ['Kestrel Row'], n: ['Hollis Marr']}],
		},
		{
			t: 'Lantern Hours',
			a: ['Ann Vale'],
			s: 'Brine Cycle',
			sn: '2',
			ext: {hardcover: '80'},
			e: [{ext: {'amazon.com': 'B0LANTERNK'}}],
		},
	];
	const state = hardcoverState();
	state.editions[811].publisher = {name: 'Kestrel Row'};
	state.editions[812] = {
		id: 812,
		book_id: 81,
		asin: 'B0BRINEAUD',
		audio_seconds: 30000,
		reading_format_id: 2,
		contributions: [{contribution: 'Narrator', author: {name: 'Hollis Marr'}}],
	};
	state.editions[821] = {id: 821, book_id: 80, asin: 'B0LANTERNK', reading_format_id: 4, contributions: []};
	const storage = new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const {els, get} = await bootAsked('#series=Brine+Cycle', {
		files: {'books.json': JSON.stringify(mine)},
		hardcover: fakeHardcover(state).fetch,
		storage,
		setTimeout: (fn: () => unknown, ms: number) => {
			if (ms === 1000) Promise.resolve().then(fn);
			return 0;
		},
	});
	const brine = get('DRAFTS[0].book.editions[0].id');
	const card = els['book-0-ed-0'];
	assert.match(card.textContent, /Maybe not an audiobook: Hardcover edition 811 is a print book on Hardcover/);
	assert.match(
		els[`book-0-fix-0-${brine}-out`].textContent,
		/^Hardcover: that edition's Hardcover id 811, ISBN 9780000000002, publisher Kestrel Row taken outTake$/,
	);
	assert.match(
		els[`book-0-fix-0-${brine}-in`].textContent,
		/^Hardcover: that edition's Hardcover id 811, ISBN 9780000000002, publisher Kestrel Row taken out, and the audiobook edition's amazon\.com id, Hardcover id, length put in Hardcover ↗Take$/,
	);
	const lantern = get('DRAFTS[1].book.editions[0].id');
	assert.match(
		els[`book-1-fix-0-${lantern}-out`].textContent,
		/^Hardcover: that edition's ASIN B0LANTERNK taken out, and with them the edition, as nothing else is left/,
	);
	assert.deepEqual(JSON.parse(JSON.stringify(get('DRAFTS[0].book.editions'))), [
		{
			ext: {hardcover: '811'},
			isbn: '9780000000002',
			n: ['Hollis Marr'],
			p: ['Kestrel Row'],
		},
	]);
	els[`book-0-fix-0-${brine}-in-do`].listeners.click[0]();
	els[`book-1-fix-0-${lantern}-out-do`].listeners.click[0]();
	await idle();
	assert.ok(!els[`book-0-fix-0-${brine}-in`], 'taken, it is offered no more');
	assert.doesNotMatch(els['book-0'].innerHTML + els['book-1'].innerHTML, /editNotAudio/);
	assert.equal(els.changeCount.textContent, '2 changes');
	await els.reviewBtn.listeners.click[0]();
	await idle();
	await els.reviewSaveBtn.listeners.click[0]();
	await idle();
	const books = (await kept(storage)).books;
	assert.deepEqual(books.find((b: any) => b.t === 'Brine Songs').e, [
		{ext: {'amazon.com': 'B0BRINEAUD', hardcover: '812'}, n: ['Hollis Marr'], len: 500},
	]);
	assert.equal(books.find((b: any) => b.t === 'Lantern Hours').e, undefined);
});
test("the Edit series page shows on an edition's card what the catalogs say of it, and offers their other editions apart", async () => {
	// an ASIN Audible doesn't sell, on a book whose one edition there is another
	const mine = [
		{t: 'The Lantern Keeper', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [{ext: {'audible.com': 'B0WRONGST3'}}]},
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '4', e: [{ext: {'audible.com': 'B0BRINETD4'}}]},
	];
	const behind = fakeProxyCatalogs();
	const proxy = async (url: string, init: any = {}) =>
		handleServer(new Request(url, {headers: {...init.headers, Origin: 'https://example.github.io'}}), SERVER_ENV, {
			fetch: async upstream => {
				const u = new URL(String(upstream.url || upstream));
				const site = u.hostname.replace(/^api\./, '');
				const res = await behind.route(`audible/${site}${u.pathname.replace(/^\/1\.0/, '')}${u.search}`);
				return new Response(JSON.stringify(await res.json()), {status: res.status});
			},
		});
	const {els, get} = await bootAsked('#series=Gull+Isle', {
		files: {'books.json': JSON.stringify(mine)},
		proxy,
		storage: new Map<string, string>([SERVER_SAVED, ['audiobook-catalog-edit-skip', '["audiobookdb"]']]),
		setTimeout: (fn: () => unknown, ms: number) => {
			if (ms === 250) Promise.resolve().then(fn);
			return 0;
		},
	});
	const card = els['book-0-ed-0'];
	assert.match(card.innerHTML, /<span class="editPill notAudio"[^>]*>not audio\?<\/span><\/summary>/);
	assert.match(card.textContent, /Maybe not an audiobook: ASIN B0WRONGST3 is not sold on audible\.com/);
	assert.doesNotMatch(els['book-0'].innerHTML.replace(card.innerHTML, ''), /editNotAudio/, 'only on its card');
	// Audible's edition isn't yours: offered as another edition, added only when asked
	const added = els['book-0'].querySelector('.editNewEdition')!;
	assert.match(added.textContent, /^Audible has another edition: .*B0LANTERN2.*Add$/);
	assert.equal(get('DRAFTS[0].book.editions.length'), 1);
	added.querySelector('button')!.listeners.click[0]();
	assert.deepEqual(get("DRAFTS[0].book.editions.map(ed => ed.ids('asin'))"), [['B0WRONGST3'], ['B0LANTERN2']]);
	assert.equal(els['book-0'].querySelector('.editNewEdition'), null, 'offered no more');
});
test("the Edit series page takes from Audible a book's edition when asked, and keeps the series' id found when ticked", async () => {
	const mine = [
		{t: 'The Lantern Keeper', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [{ext: {'audible.com': 'B0LANTERN2'}}]},
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '4', e: [{p: 'Gullwing Audio'}]},
	];
	// the real Worker in front of Audible's catalog
	const behind = fakeProxyCatalogs();
	const audible = async (url: string) => {
		const u = new URL(url);
		const site = u.hostname.replace(/^api\./, '');
		return behind.route(`audible/${site}${u.pathname.replace(/^\/1\.0/, '')}${u.search}`);
	};
	const proxy = async (url: string, init: any = {}) =>
		handleServer(new Request(url, {headers: {...init.headers, Origin: 'https://example.github.io'}}), SERVER_ENV, {
			fetch: async upstream => {
				const res = await audible(String(upstream.url || upstream));
				return new Response(JSON.stringify(await res.json()), {status: res.status});
			},
		});
	// AudiobookDB, which needs only the server too, is left out of this run
	const storage = new Map<string, string>([SERVER_SAVED, ['audiobook-catalog-edit-skip', '["audiobookdb"]']]);
	const {els, get} = await bootAsked('#series=Gull+Isle', {
		files: {'books.json': JSON.stringify(mine)},
		proxy,
		storage,
		setTimeout: (fn: () => unknown, ms: number) => {
			if (ms === 250) Promise.resolve().then(fn);
			return 0;
		},
	});
	assert.match(
		els.catalogPicks.innerHTML,
		/id="catalog-audible" checked=""> <span class="catIcon cat-audible[^"]*"[^>]*>(?:<img [^>]*>)?<\/span>Audible/,
	);
	assert.match(
		els.catalogPicks.innerHTML,
		/id="catalog-audiobookdb"> <span class="catIcon cat-audiobookdb[^"]*"[^>]*>(?:<img [^>]*>)?<\/span>AudiobookDB/,
	);
	// the series' books not in the catalog, as cards: Audible's answer has what adding one takes
	assert.deepEqual(
		[0, 1].map(n => els[`missing-${n}`].textContent.match(/^Not in your catalog Add ([^↗]*?)Audible ↗/)![1]),
		['1. Salt Road', '3. Gull Song'],
	);
	// among yours, in series order
	assert.deepEqual(
		[...els.editBooks.innerHTML.matchAll(/id="((?:book|missing|fresh)-\d+)"/g)].map(m => m[1]),
		['missing-0', 'book-0', 'missing-1', 'book-1'],
	);
	assert.ok(behind.sent.every(r => r.startsWith('audible/audible.com/catalog/')));
	assert.equal(get('CATALOG.books.length'), 2, 'comparing changes nothing');

	// each book's edition there, to take with what it fills in
	assert.match(els['book-0-ed-0'].innerHTML, /to review<\/span><\/summary>/);
	assert.match(els['book-0-ed-0'].textContent, /Audible: Narrators: .*ISBN: .*Take/);
	assert.match(els['book-1-ed-0'].textContent, /Audible: /);
	const take = (n: number) => els['book-' + n].querySelector('.editTake button')!;
	take(0).listeners.click[0]();
	take(1).listeners.click[0]();
	assert.doesNotMatch(els['book-0'].innerHTML, /editTake/, 'taken');
	// the series' Audible id and count, kept when ticked
	assert.match(els.catalogFound.textContent, /Keep the ids Audible found for Gull Isle/);
	els['info-0'].checked = true;
	els['info-0'].listeners.change[0]({target: els['info-0']});
	const sent = behind.sent.length;
	els['missing-1-add'].checked = true;
	els['missing-1-add'].listeners.change[0]({target: els['missing-1-add']});
	await idle();
	assert.equal(behind.sent.length, sent, 'nothing more is read');
	assert.ok(await saveEdit({els}));
	const saved = await kept(storage);
	assert.deepEqual(
		saved.books.map((b: any) => [b.t, b.e.map((e: any) => [e.ext, e.n, e.len])]),
		[
			['The Lantern Keeper', [[{'audible.com': 'B0LANTERN2'}, ['Hollis Marr', 'Dana Fenwick'], 612]]],
			['Brine Tide', [[{'audible.com': 'B0BRINETD4'}, ['Dana Fenwick'], 480]]],
			['Gull Song', [[{'audible.com': 'B0GULLSNG3'}, undefined, undefined]]],
		],
	);
	assert.deepEqual(
		[saved.seriesInfo['Gull Isle'].ext, saved.seriesInfo['Gull Isle'].total],
		[{'audible.com': 'B0SERIES02'}, 4],
	);
	assert.match(els.ioStatus.textContent, /Saved 2 books, added 1 book, kept ids found for 1 series or person\./);

	// an edition you keep out of imports is listed behind a link, and offers nothing
	const out = await bootAsked('#series=Gull+Isle', {
		files: {'books.json': JSON.stringify(mine), 'excluded.txt': 'Edition B0BRINETD4\n'},
		proxy,
		storage: new Map<string, string>([SERVER_SAVED, ['audiobook-catalog-edit-skip', '["audiobookdb"]']]),
		setTimeout: (fn: () => unknown, ms: number) => {
			if (ms === 250) Promise.resolve().then(fn);
			return 0;
		},
	});
	const brine = out.els['book-1'];
	assert.match(
		brine.innerHTML,
		/<details class="editExcluded"><summary>1 excluded edition<\/summary>.*<li>[^<]*audible\.com B0BRINETD4[^<]*\(Audible\) <a href="https:\/\/www\.audible\.com\/pd\/B0BRINETD4"/,
	);
	assert.equal(
		brine.querySelectorAll('.editChip').length + brine.querySelectorAll('.editTake').length,
		0,
		'nothing of it is offered',
	);
	assert.match(out.els['book-0'].textContent, /Audible: Narrators: /, 'the other books are as before');
});
test("the Edit series page shows every catalog's value beside a book's field, and takes only those picked", async () => {
	const mine = [
		{t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '4', e: [{ext: {'amazon.com': 'B0BRINETD1'}}]},
	];
	// Brine Tide on your AudiobookDB Read shelf (Listened), not Currently Listening
	const state = audiobookdbState();
	state.shelves[2].books.push(...state.shelves[1].books.splice(0));
	const abdb = fakeAudiobookdb(state);
	// the real Worker in front of AudiobookDB and of Audible's catalog
	const behind = fakeProxyCatalogs();
	const proxy = async (url: string, init: any = {}) =>
		handleServer(
			new Request(url, {
				method: init.method,
				body: init.body,
				headers: {...init.headers, Origin: 'https://example.github.io'},
			}),
			SERVER_ENV,
			{
				fetch: async (upstream: Request) => {
					const u = new URL(String(upstream.url || upstream));
					if (!/audible\./.test(u.hostname)) return abdb.fetch(upstream);
					const site = u.hostname.replace(/^api\./, '');
					const res = await behind.route(`audible/${site}${u.pathname.replace(/^\/1\.0/, '')}${u.search}`);
					return new Response(JSON.stringify(await res.json()), {status: res.status});
				},
			},
		);
	const storage = new Map<string, string>([SERVER_SAVED, ['audiobook-catalog-audiobookdb-key', 'abdb-key-1']]);
	const {els, get} = await bootAsked('#series=Gull+Isle', {
		files: {
			'books.json': JSON.stringify(mine),
			'series-info.json': JSON.stringify({'Gull Isle': {ext: {'audible.com': 'B0SERIES02'}}}),
		},
		proxy,
		storage,
		setTimeout: (fn: () => unknown, ms: number) => {
			if (ms === 250 || ms === 500) Promise.resolve().then(fn);
			return 0;
		},
	});
	assert.match(
		els.catalogPicks.innerHTML,
		/id="catalog-hardcover" disabled=""> <span class="catIcon cat-hardcover[^"]*"[^>]*>(?:<img [^>]*>)?<\/span>Hardcover<span class="editWhy"> \(needs your Hardcover API token/,
	);
	// a field's values, each once with the catalogs that have it
	const chips = (id: any) =>
		[...els[id].closest('.editField')!.querySelectorAll('.editChip')].map(c => c.textContent);
	assert.deepEqual(chips('b0e0_d'), ['AudiobookDB 2020-02-02', 'Audible 2023-09-12']);
	assert.deepEqual(chips('b0e0_len'), ['AudiobookDB, Audible 8h']);
	assert.deepEqual(chips('b0_sn'), ['AudiobookDB 2']);
	// a chip names its catalogs by their icons
	assert.match(
		els['b0_sn-pick-0'].innerHTML,
		/^<span class="editChipFrom"><span class="catIcon cat-audiobookdb favicon"/,
	);
	// an edition's description is a short name for it: one line
	assert.match(els['book-0'].innerHTML, /<input id="b0e0_desc" data-key="desc" placeholder="e\.g\. UK edition">/);
	assert.match(els.editBooks.innerHTML, /Add Tidewater — Ann Vale/);
	// AudiobookDB's book to take brings the ids it found: they aren't offered apart too
	assert.equal(
		els['book-0'].querySelectorAll('.editTake').filter(x => /^AudiobookDB/.test(x.textContent)).length,
		2,
		"the book's and the edition's",
	);
	assert.ok(!els['book-0-take-0-ids'] && !els['book-0-ed-0-take-0-ids'], 'AudiobookDB id found once');
	// an amazon.com ASIN is that site's alone: it isn't asked of audible.com, so isn't said not to be sold there
	assert.doesNotMatch(els['book-0'].textContent, /Maybe not an audiobook/);
	assert.equal(els.changeCount.textContent, 'No changes yet', 'nothing is picked at first');

	// a value picked fills the field in, and can be typed over
	els['b0e0_d-pick-1'].listeners.click[0]();
	assert.equal(els.b0e0_d.value, '2023-09-12');
	els['b0e0_n-pick-0'].listeners.click[0]();
	els['b0_sn-pick-0'].listeners.click[0]();
	els.b0_sn.value = '4'; // changed back: the number stays
	els.b0_sn.listeners.change[0]();
	els['fresh-0-add'].checked = true;
	els['fresh-0-add'].listeners.change[0]({target: els['fresh-0-add']});
	assert.equal(els.changeCount.textContent, '2 changes', "the edition's, and the new book");
	assert.ok(await saveEdit({els}));
	const saved = await kept(storage);
	assert.deepEqual(
		saved.books.map((b: any) => [b.t, b.sn, b.e.map((e: any) => [e.ext, e.n, e.d, e.p, e.len])]),
		[
			['Brine Tide', '4', [[{'amazon.com': 'B0BRINETD1'}, ['Dana Fenwick'], '2023-09-12', undefined, undefined]]],
			[
				'Tidewater',
				'1',
				[
					[
						{'audible.com': 'B0TIDEWAT1', audiobookdb: 'RlsTidewatr1'},
						['Dana Fenwick'],
						'2020-02-02',
						['Gullwing Audio'],
						570,
					],
				],
			],
		],
	);
	assert.equal(saved.authors['Ann Vale'], undefined, "AudiobookDB's ids found weren't picked");
	assert.ok(!abdb.sent.some(s => s.method === 'POST'), 'nothing is sent');
	assert.equal(get('CATALOG.books.length'), 2);
	assert.match(els.ioStatus.textContent, /^Saved 1 book, added 1 book\./);
});
test('AudiobookDB needs the proxy, says when the proxy is out of date, and says when it refuses the key', async () => {
	const mine = [{t: 'Lantern Hours', a: ['R. T. Hale'], e: [{ext: {'audible.com': 'B0LANTERN1'}}]}];
	const none = await boot({page: 'import.html', files: {'books.json': JSON.stringify(mine)}});
	await none.els.audiobookdbCompareBtn.listeners.click[0]();
	assert.match(
		none.els.ioStatus.textContent,
		/AudiobookDB is asked through your server's catalog proxy: save your server first/,
	);

	const {proxy} = audiobookdbBehindProxy();
	const wrong = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		proxy,
		setTimeout: abdbTimeout,
		storage: new Map<string, string>([SERVER_SAVED, ['audiobook-catalog-audiobookdb-key', 'not-my-key']]),
	});
	await wrong.els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	assert.match(wrong.els.importPreviewBody.innerHTML, /Couldn't compare: AudiobookDB refused your API key/);
	assert.equal(wrong.els.importConfirm.style.display, 'none');

	// a proxy deployed before AudiobookDB's shelves: it refuses the key
	const old = async (url: string, init: any = {}) =>
		init.headers['X-Catalog-Key']
			? new Response('{"error":"This path takes no catalog key."}', {status: 400})
			: proxy(url, init);
	const stale = await boot({
		page: 'import.html',
		files: {'books.json': JSON.stringify(mine)},
		proxy: old,
		setTimeout: abdbTimeout,
		storage: new Map<string, string>([SERVER_SAVED, ['audiobook-catalog-audiobookdb-key', 'abdb-key-1']]),
	});
	await stale.els.audiobookdbCompareBtn.listeners.click[0]();
	await idle();
	assert.match(
		stale.els.importPreviewBody.innerHTML,
		/Couldn't compare: your server refused it \(400\): deploy it again \(make deploy-server\) to bring it up to date/,
	);
});
