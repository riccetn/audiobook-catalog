// Browser smoke tests: the pages themselves, browsing the series and books, and a book and its editions on its
// page and its Edit page. The pages run in Node against a fake DOM (boot() in smoke.mjs).
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeHardcover, hardcoverState} from './fake-hardcover.mjs';
import {fakeCatalogs, fakeProxyCatalogs} from './fake-catalogs.mjs';
import {
	ALL_PAGES,
	PAGES,
	SALT_ROAD,
	addEditionOn,
	bookIdOf,
	boot,
	bootAdd,
	bootBook,
	bootEdit,
	bootEditBook,
	cards,
	demoBooks,
	draftEditions,
	entryOf,
	hashValue,
	idle,
	kept,
	modulesOf,
	read,
	saveEdit,
	seriesIdOf,
	settle,
	typeBookId,
	typeIn,
} from './smoke.mjs';

const IMPORT_PAGE_ONLY = [
	'modules/catalog-connectors.js',
	'modules/catalog-lookup.js',
	'modules/entry-lookup.js',
	'entry-fill.js',
	'modules/shelf-sync.js',
	'modules/book-source.js',
	'modules/file-importer.js',
	'modules/backup.js',
	'modules/backup-v1.js',
	'modules/merger.js',
	'modules/comparison.js',
	'modules/catalog-sync.js',
];
for (const page of ALL_PAGES) {
	const html = read(page);
	assert.equal(entryOf(page).length, 1, `${page} loads one module`);
	assert.ok(!/<script(?! type="module")/.test(html), `${page} loads no plain scripts`);
	for (const shared of ['store.js', 'modules/catalog.js'])
		assert.ok(modulesOf(entryOf(page)[0]).includes(shared), `${page} imports ${shared}`);
	// what only Import & export needs (the catalogs' connectors, backups, imports and comparisons) no other page
	// loads; the Edit page loads the lookup of other catalogs with import() when Fill in is used
	if (page !== 'import.html')
		for (const only of IMPORT_PAGE_ONLY)
			assert.ok(!modulesOf(entryOf(page)[0]).includes(only), `${page} doesn't load ${only}`);
	assert.ok(html.includes('<link rel="stylesheet" href="styles.css">'), page);
	for (const other of PAGES) assert.ok(html.includes(`href="${other}"`), `${page} links to ${other}`);
	assert.doesNotMatch(html, /Catalog<\/a>/, `${page}: Series and Books in the nav bar instead`);
}
test("a form's Cancel sits next to its Save, and a Remove button comes after both, apart from them", () => {
	let forms = 0;
	for (const page of ALL_PAGES) {
		for (const [, row] of read(page).matchAll(/<div class="formbtns">([\s\S]*?)<\/div>/g)) {
			const buttons = [...row.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, label]) => ({
				save: /class="save"/.test(attrs),
				label,
			}));
			const remove = buttons.findIndex(b => b.label.startsWith('Remove'));
			if (remove < 0) continue;
			forms++;
			const save = buttons.findIndex(b => b.save),
				cancel = buttons.findIndex(b => b.label === 'Cancel');
			assert.equal(cancel, save + 1, `${page}: Cancel follows Save`);
			assert.equal(remove, buttons.length - 1, `${page}: Remove comes last`);
		}
	}
	assert.equal(forms, 4, 'the author, narrator, publisher and place forms');
});
test('opens on the series overview, with a row per series', async () => {
	const {els, get} = await boot();
	assert.equal(get('SERIES_FILTER'), null);
	const seriesCount = new Set(demoBooks.filter(b => b.s).map(b => b.s)).size;
	assert.match(els.subtitle.textContent, new RegExp(`^${seriesCount} series across ${demoBooks.length} audiobooks`));
	assert.equal((els.results.innerHTML.match(/class="srow-title"/g) || []).length, seriesCount + 1); // + "Standalone"
	assert.ok(!els.crumb.classList.contains('show'));
	assert.equal(els.toggleAdd.style.display, 'none', "books are added on a series' page or the books page");
});
test('opening a series shows exactly that series, and its books can be added to', async () => {
	const {ctx, els, get} = await boot();
	const counts = {};
	demoBooks.forEach(b => b.s && (counts[b.s] = (counts[b.s] || 0) + 1));
	const [series] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	ctx.openSeries(seriesIdOf(get, series));
	await idle();
	assert.equal(cards(els.results.innerHTML), counts[series]);
	assert.ok(els.crumb.classList.contains('show'));
	assert.equal(els.crumbLabel.textContent, series);
	assert.equal(els.controls.style.display, 'none', 'nothing to search');
	assert.equal(els.resultCount.textContent, '', 'its books are not counted again');
	assert.equal(els.toggleAdd.style.display, '');
	assert.equal(els.toggleAdd.getAttribute('href'), `edit.html#add&series=${seriesIdOf(get, series)}`);
});
test('search narrows the books page', async () => {
	const {ctx, els} = await boot({page: 'books.html'});
	// says what the catalog holds, not where it came from
	assert.equal(els.subtitle.textContent, `${demoBooks.length} audiobooks in the catalog`);
	assert.equal(els.resultCount.textContent, `${demoBooks.length} shown`);
	const target = demoBooks[0];
	els.q.value = target.t;
	await ctx.refreshView();
	await idle();
	assert.ok(els.results.innerHTML.includes('class="book"'));
	assert.ok(cards(els.results.innerHTML) < demoBooks.length);
	els.q.value = 'zzzz-no-such-book-zzzz';
	await ctx.refreshView();
	await idle();
	assert.match(els.results.innerHTML, /No books match/);
});
test('the books page can be sorted by when they were read or added, newest first, as one list', async () => {
	const {ctx, els, storage} = await boot({page: 'books.html'});
	const titles = () =>
		[...els.results.innerHTML.matchAll(/<div class="title"><a href="[^"]+">([^<]+)<\/a>/g)].map(m => m[1]);
	const latest = b => (b.r || []).slice().sort().pop() || '';
	const byRead = [...demoBooks].filter(b => latest(b)).sort((x, y) => latest(y).localeCompare(latest(x)));

	els.sortBy.value = 'read';
	els.sortBy.listeners.change[0]();
	await idle();
	assert.equal(ctx.location.hash, '#sort=read');
	assert.doesNotMatch(els.results.innerHTML, /class="series-group"/, 'not grouped by series');
	assert.equal(titles()[0], byRead[0].t);
	assert.deepEqual(
		titles()
			.slice(0, byRead.length)
			.map(t => demoBooks.find(b => b.t === t))
			.every(b => latest(b)),
		true,
		'books read come first',
	);
	// each book says its series
	const inSeries = demoBooks.find(b => b.t === titles()[0]);
	if (inSeries.s)
		assert.match(
			els.results.innerHTML,
			new RegExp(`<div class="meta"><a href="index\\.html#series=[^"]+">${inSeries.s}</a>`),
		);

	els.sortBy.value = 'added';
	els.sortBy.listeners.change[0]();
	await idle();
	assert.equal(titles()[0], demoBooks[demoBooks.length - 1].t);

	// the address keeps it
	const again = await boot({page: 'books.html', hash: '#sort=added', storage});
	assert.equal(again.els.sortBy.value, 'added');
	assert.equal(
		[...again.els.results.innerHTML.matchAll(/<div class="title"><a href="[^"]+">([^<]+)<\/a>/g)][0][1],
		demoBooks[demoBooks.length - 1].t,
	);
});
test("the Filters button (a phone's) opens the filters and counts those on; a book's page has no search or filters", async () => {
	const {els} = await boot({page: 'books.html'});
	assert.equal(els.filtersBtn.textContent, 'Filters');
	els.filtersBtn.listeners.click[0]();
	assert.ok(els.controls.classList.contains('filtersOpen'));
	assert.equal(els.filtersBtn.getAttribute('aria-expanded'), 'true');
	els.genreFilter.value = 'Mystery';
	els.genreFilter.listeners.change[0]();
	await idle();
	assert.equal(els.filtersBtn.textContent, 'Filters · 1');
	const series = await boot();
	series.els.missingFilter.value = 'missing';
	series.els.missingFilter.listeners.change[0]();
	await idle();
	assert.equal(series.els.filtersBtn.textContent, 'Filters · 1');
	const book = await bootBook(SALT_ROAD);
	assert.equal(book.els.controls, undefined);
	assert.equal(book.els.q, undefined);
});
test('text from the catalog is shown as text, never read as HTML', async () => {
	const odd = '<img src=x onerror=alert(1)> & "Co"';
	// twice, so the duplicates page shows it too
	const mine = JSON.stringify([
		{t: odd, a: [odd], s: odd, sn: '1', g: [odd], e: [{desc: odd, n: [odd]}]},
		{t: odd, a: [odd], e: [{ext: {goodreads: '42'}}]},
	]);
	const info = JSON.stringify({[odd]: {total: 2, status: 'ongoing', note: odd}});
	const authors = JSON.stringify({[odd]: {bio: odd}});
	const files = {'books.json': mine, 'series-info.json': info, 'authors.json': authors};
	const pages = [
		['index.html', 'results', ''],
		['index.html', 'results', '#series=' + encodeURIComponent(odd)],
		['books.html', 'results', ''],
		['book.html', 'results', '#book=' + encodeURIComponent(odd)],
		['author.html', 'creditBody', '#a=' + encodeURIComponent(odd)],
		['duplicates.html', 'dupBody', ''],
	];
	for (const [page, id, hash] of pages) {
		const {els} = await boot({page, files, hash});
		await idle();
		const shown = els[id].innerHTML;
		assert.equal(els[id].querySelectorAll('img').length, 0, `${page}${hash}: no element made of the text`);
		assert.match(shown, /&lt;img src=x onerror=alert\(1\)&gt; &amp; "Co"/, page + hash);
	}
});
test('the address names what is shown, so a series, a book or a search can be linked to', async () => {
	const {ctx, els, get, storage} = await boot();
	assert.equal(ctx.location.hash, '');
	// by the ids they are stored under, so a link holds when a series or book is renamed
	const halloway = seriesIdOf(get, 'Halloway & Finch');
	ctx.openSeries(halloway);
	await idle();
	assert.equal(ctx.location.hash, `#series=${halloway}`);
	assert.equal(ctx.document.title, 'Halloway & Finch — Audiobook Catalog');
	// the overview links each series to that address (on this page), and book cards to their own page
	ctx.openSeries(null);
	await idle();
	assert.ok(
		els.results.innerHTML.includes(`<a class="srow-title" href="#series=${halloway}">Halloway &amp; Finch</a>`),
	);
	assert.match(els.results.innerHTML, /<a class="srow-title" href="#standalone">Standalone<\/a>/);
	ctx.openSeries(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	const saltRoad = bookIdOf(get, 'The Salt Road');
	assert.ok(
		els.results.innerHTML.includes(
			`<div class="title"><a href="book.html#book=${saltRoad}">The Salt Road</a></div>`,
		),
	);

	// opening one of those addresses shows the same thing, in another tab too
	for (const hash of [`#series=${halloway}`, '#series=Halloway+%26+Finch']) {
		const series = await boot({hash, storage});
		assert.equal(series.get('SERIES_FILTER'), halloway, 'by its id, or by its name (an address from before)');
		assert.equal(series.ctx.location.hash, `#series=${halloway}`);
		assert.equal(cards(series.els.results.innerHTML), 2);
		assert.equal(series.els.crumbLabel.textContent, 'Halloway & Finch');
	}
	for (const hash of [`#book=${saltRoad}`, '#book=The+Salt+Road']) {
		const book = await boot({page: 'book.html', hash, storage});
		assert.equal(book.get('BOOK_FILTER'), saltRoad);
		assert.equal(book.ctx.location.hash, `#book=${saltRoad}`);
		assert.equal((book.els.results.innerHTML.match(/class="book book-details"/g) || []).length, 1);
		assert.match(book.els.results.innerHTML, /<h2 class="title">The Salt Road<\/h2>/);
		assert.equal(book.ctx.document.title, 'The Salt Road — Audiobook Catalog');
		// with a way back to its series, and no count of the one book shown
		assert.equal(book.els.crumbLabel.textContent, 'The Lantern Coast › The Salt Road');
		assert.match(book.els.crumbLabel.innerHTML, /^<a href="index\.html#series=[^"]+">The Lantern Coast<\/a>/);
		assert.equal(book.els.resultCount, undefined);
		assert.doesNotMatch(book.ctx.document.body.innerHTML, /shown/);
	}
	const gone = await boot({page: 'book.html', hash: '#book=no-such-id', storage});
	assert.equal(gone.els.crumbLabel.textContent, 'No such book');
	assert.match(gone.els.results.innerHTML, /This book is not in the catalog/);
	const standalone = await boot({hash: '#standalone'});
	assert.equal(standalone.els.crumbLabel.textContent, 'Standalone books');
	assert.equal(cards(standalone.els.results.innerHTML), 3);

	// a search and the filters
	const found = await boot({page: 'books.html', hash: '#q=ashcombe&read=undated&genre=Science+Fiction'});
	assert.equal(found.els.q.value, 'ashcombe');
	assert.equal(found.els.readFilter.value, '__undated__');
	assert.equal(cards(found.els.results.innerHTML), 4);
	assert.equal(found.ctx.location.hash, '#q=ashcombe&genre=Science+Fiction&read=undated');
	const gaps = await boot({hash: '#q=coast&missing'});
	assert.equal(gaps.get('SERIES_FILTER'), null);
	assert.equal(gaps.els.missingFilter.value, 'missing');
	assert.equal(gaps.els.q.value, 'coast');
	// an address it does not understand shows the series overview
	const odd = await boot({hash: '#nothing=here&%E0%A4%A'});
	assert.equal(odd.get('SERIES_FILTER'), null);
	assert.equal(odd.ctx.location.hash, '');
});
test("addresses from when one page showed the series, the books and a book go to the books page and the book's page", async () => {
	for (const [hash, to] of [
		['#books', 'books.html'],
		['#books&q=salt+road&genre=Fantasy&sort=read', 'books.html#q=salt+road&genre=Fantasy&sort=read'],
		['#book=The+Salt+Road', 'book.html#book=The+Salt+Road'],
		['#book=id-3&q=x', 'book.html#book=id-3'],
	]) {
		const {ctx} = await boot({hash});
		assert.equal(ctx.location.replaced, to, hash);
	}
	for (const hash of ['', '#series=The+Lantern+Coast', '#q=coast&missing']) {
		const {ctx} = await boot({hash});
		assert.equal(ctx.location.replaced, null, hash);
	}
});
test('back and forward step through series, searches and filters, and books', async () => {
	const {ctx, els, get, follow, storage} = await boot();
	const {history} = ctx;
	const lantern = seriesIdOf(get, 'The Lantern Coast'),
		saltRoad = bookIdOf(get, 'The Salt Road'),
		beacons = bookIdOf(get, 'Beacons at Low Tide');
	// the series' links are on this page: following one shows it here
	follow(`#series=${lantern}`);
	await idle();
	assert.equal(get('SERIES_FILTER'), lantern);
	assert.equal(cards(els.results.innerHTML), 4);
	follow('#standalone');
	await idle();
	assert.equal(cards(els.results.innerHTML), 3);
	history.back();
	await idle();
	assert.equal(get('SERIES_FILTER'), lantern);
	assert.equal(cards(els.results.innerHTML), 4);
	history.back();
	await idle();
	assert.equal(get('SERIES_FILTER'), null);
	// typing a search is one entry, however many letters
	for (const q of ['c', 'co', 'coast']) {
		els.q.value = q;
		els.q.listeners.input[0]();
	}
	await idle();
	assert.deepEqual(
		history.entries.map(e => e.hash),
		['', '#q=coast'],
	);
	assert.equal((els.results.innerHTML.match(/class="srow-title"/g) || []).length, 1);
	history.back();
	await idle();
	assert.equal(els.q.value, '');
	assert.ok((els.results.innerHTML.match(/class="srow-title"/g) || []).length > 1);

	const books = await boot({page: 'books.html', storage});
	const b = books.els;
	b.genreFilter.value = 'Mystery';
	b.genreFilter.listeners.change[0]();
	await idle();
	for (const q of ['p', 'pr', 'priya']) {
		b.q.value = q;
		b.q.listeners.input[0]();
	}
	await idle();
	assert.deepEqual(
		books.ctx.history.entries.map(e => e.hash),
		['', '#genre=Mystery', '#q=priya&genre=Mystery'],
	);
	books.ctx.history.back();
	await idle();
	assert.equal(b.q.value, '');
	assert.equal(b.genreFilter.value, 'Mystery');
	books.ctx.history.back();
	await idle();
	assert.equal(b.genreFilter.value, '');
	assert.equal(cards(b.results.innerHTML), demoBooks.length);
	// a space typed in the search box stays there (the address carries the search without it)
	b.q.value = 'beacons ';
	b.q.listeners.input[0]();
	await idle();
	assert.equal(b.q.value, 'beacons ');
	b.q.value = 'beacons at';
	b.q.listeners.input[0]();
	await idle();
	assert.equal(books.ctx.location.hash, '#q=beacons+at');
	books.ctx.history.back();
	await idle();
	// a new search after going back starts a new entry instead of rewriting an old one
	b.q.value = 'salt';
	b.q.listeners.input[0]();
	await idle();
	assert.deepEqual(
		books.ctx.history.entries.map(e => e.hash),
		['', '#q=salt'],
	);

	// a link to another book (a box set's) on a book's page shows it there; Back the one before
	const book = await bootBook('The Salt Road', {storage});
	book.follow(`#book=${beacons}`);
	await idle();
	assert.equal(book.get('BOOK_FILTER'), beacons);
	assert.match(book.els.results.innerHTML, /<h2 class="title">Beacons at Low Tide<\/h2>/);
	book.ctx.history.back();
	await idle();
	assert.equal(book.get('BOOK_FILTER'), saltRoad);
	assert.match(book.els.results.innerHTML, /<h2 class="title">The Salt Road<\/h2>/);
});
test('saving a book keeps a publisher whose name has a comma, and still parts new names at commas', async () => {
	const files = {
		'books.json': JSON.stringify([
			{
				t: 'Pike Water',
				a: ['Bo Reed'],
				e: [{ext: {'audible.com': 'B0PIKE0001'}, p: ['Tern Press, Harbor Division']}],
			},
			{t: 'Pike Ford', a: ['Bo Reed'], e: [{ext: {'audible.com': 'B0PIKE0002'}}]},
		]),
	};
	const edit = await bootEditBook('Pike Water', {files});
	assert.equal(edit.els.b0e0_p.value, 'Tern Press, Harbor Division');
	typeIn(edit.els, 'b0_g', 'Fantasy');
	assert.equal(await saveEdit(edit), true);
	const {storage} = edit;
	assert.deepEqual((await kept(storage)).books[0].e[0].p, ['Tern Press, Harbor Division']);
	// another book's page knows the name from the catalog, and new names typed beside it are parted
	const ford = await bootEditBook('Pike Ford', {storage, files: null});
	typeIn(ford.els, 'b0e0_p', 'Tern Press, Harbor Division, Gull Audio, Wren Sound');
	assert.equal(await saveEdit(ford), true);
	assert.deepEqual((await kept(storage)).books[1].e[0].p, [
		'Tern Press, Harbor Division',
		'Gull Audio',
		'Wren Sound',
	]);
});
test('the Edit series page keeps a publisher whose name has a comma when another field of the edition changes', async () => {
	const files = {
		'books.json': JSON.stringify([
			{
				t: 'Pike 1',
				a: ['Bo Reed'],
				s: 'Pike Saga',
				sn: '1',
				e: [{ext: {'audible.com': 'B0PIKE0001'}, p: ['Tern Press, Harbor Division']}],
			},
		]),
	};
	const edit = await bootEdit('Pike Saga', {files});
	edit.els.b0e0_n.value = 'Cy Hale';
	edit.els.b0e0_n.listeners.change[0]();
	assert.equal(await saveEdit(edit), true);
	assert.deepEqual((await kept(edit.storage)).books[0].e[0], {
		ext: {'audible.com': 'B0PIKE0001'},
		n: ['Cy Hale'],
		p: ['Tern Press, Harbor Division'],
	});
});
test('editing a book keeps its editions, and their covers', async () => {
	const page = await bootBook(SALT_ROAD);
	const {storage} = page;
	const cover = 'e3'.repeat(32);
	page.run(
		`CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', goodreads: '4242' }, p: ['Gull Audio'], len: 642, img: {audiobookdb: '${cover}'}}, {ext: { 'audible.com': 'TESTASIN02' }}].map(e => Edition.fromJSON(e)); persist()`,
	);
	await idle();
	const edit = await bootEditBook(SALT_ROAD, {storage});
	const {els} = edit;
	assert.equal(els.eyebrow.textContent, 'Edit book');
	assert.equal(els.seriesPanel.hidden, true);
	assert.equal(els.b0e0_len.value, '10h 42m');
	assert.equal(els['b0e0_ext-goodreads'].value, '4242');
	assert.equal(els['b0e1_ext-audible.com'].value, 'TESTASIN02');
	assert.doesNotMatch(els['book-0'].innerHTML, /img:/, 'no field shows the cover key');
	typeIn(els, 'b0_t', 'Renamed In The App');
	assert.equal(await saveEdit(edit), true);
	assert.equal(edit.ctx.location.assigned, 'book.html#book=' + bookIdOf(edit.get, 'Renamed In The App'));
	const saved = (await kept(storage)).books[0];
	assert.deepEqual(
		{t: saved.t, e: saved.e},
		{
			t: 'Renamed In The App',
			e: [
				{
					ext: {'audible.com': 'TESTASIN01', goodreads: '4242'},
					p: ['Gull Audio'],
					len: 642,
					img: {audiobookdb: cover},
				},
				{ext: {'audible.com': 'TESTASIN02'}},
			],
		},
	);
	const shown = await bootBook('Renamed In The App', {storage});
	assert.match(shown.els.results.innerHTML, /<h2 class="title">Renamed In The App<\/h2>/);
	// AudiobookDB's cover comes first, at the details' size
	assert.match(
		shown.els.results.innerHTML,
		new RegExp(`<img class="cover large" src="https://cdn\\.audiobookdb\\.org/${cover}/large\\.jpg"`),
	);
});
test("the Edit page's author, series, narrator and publisher fields offer the names the catalog has as they are typed, and say which are new", async () => {
	const edit = await bootEditBook(SALT_ROAD);
	const {ctx, els, get, run} = edit;
	await ctx.loadFormNames();
	assert.deepEqual(get('FORM_NAMES.publisher').sort(), ['Gullwing Audio', 'Harbourlight Sound', 'Kestrel Row Audio']);
	const options = list => [...list.innerHTML.matchAll(/<li [^>]*>([^<]*)<\/li>/g)].map(m => m[1]);
	// the authors: the name the cursor is in is looked up, leaving out the ones the field has
	assert.equal(els.b0_a.getAttribute('role'), 'combobox');
	assert.equal(els.b0_a.value, 'Marisol Quenby');
	els.b0_a.value = 'Marisol Quenby, ren';
	els.b0_a.dispatch('input');
	assert.deepEqual(options(els.b0_aList), ['Odalys Rennick']);
	assert.equal(els.b0_a.getAttribute('aria-expanded'), 'true');
	els.b0_a.value = 'Marisol Quenby, o';
	els.b0_a.dispatch('input');
	assert.deepEqual(
		options(els.b0_aList),
		['Odalys Rennick', 'Priya Ostrander', 'Ferran Doyle', 'Wendell Ashcombe'],
		'names starting with it first, then a word, then anywhere',
	);
	// picked with the arrow keys and Enter, and read as if typed
	let prevented = false;
	els.b0_a.dispatch('keydown', {key: 'ArrowDown'});
	els.b0_a.dispatch('keydown', {key: 'ArrowDown'});
	assert.equal(els.b0_a.getAttribute('aria-activedescendant'), 'b0_aList-1');
	assert.match(
		els.b0_aList.innerHTML,
		/<li id="b0_aList-1" role="option" aria-selected="true" class="active">Priya Ostrander<\/li>/,
	);
	els.b0_a.dispatch('keydown', {
		key: 'Enter',
		preventDefault() {
			prevented = true;
		},
	});
	assert.ok(prevented);
	assert.equal(els.b0_a.value, 'Marisol Quenby, Priya Ostrander, ');
	assert.deepEqual(get('DRAFTS[0].book.authors'), ['Marisol Quenby', 'Priya Ostrander']);
	assert.equal(els.b0_aList.innerHTML, '');
	assert.equal(els.b0_a.getAttribute('aria-expanded'), 'false');
	// Escape closes the list, leaving what was typed
	els.b0_a.value = 'Wen';
	els.b0_a.dispatch('input');
	assert.deepEqual(options(els.b0_aList), ['Wendell Ashcombe']);
	els.b0_a.dispatch('keydown', {key: 'Escape'});
	assert.equal(els.b0_aList.innerHTML, '');
	assert.equal(els.b0_a.value, 'Wen');
	assert.equal(els.b0_aNew.textContent, 'New author: Wen, added to the catalog when this is saved.');
	typeIn(els, 'b0_a', 'Marisol Quenby, Priya Ostrander, ');
	// an edition's narrators and publishers: a click picks one, and the edition has it
	const narrators = els.b0e0_n;
	assert.equal(narrators.value, 'Tobias Frane');
	narrators.value = 'Tobias Frane, ing';
	narrators.dispatch('input');
	assert.deepEqual(options(els.b0e0_nList), ['Ingrid Voss']);
	els.b0e0_nList.children[0].dispatch('click');
	assert.equal(els.b0e0_n.value, 'Tobias Frane, Ingrid Voss, ');
	assert.deepEqual(get('DRAFTS[0].book.editions[0].narrators'), ['Tobias Frane', 'Ingrid Voss']);
	els.b0e0_p.value = 'kes';
	els.b0e0_p.dispatch('input');
	assert.deepEqual(options(els.b0e0_pList), ['Kestrel Row Audio']);
	els.b0e0_pList.children[0].dispatch('click');
	assert.equal(els.b0e0_p.value, 'Kestrel Row Audio, ', 'ready for another publisher');
	assert.deepEqual(get('DRAFTS[0].book.editions[0].publishers'), ['Kestrel Row Audio']);
	assert.equal(els.b0e0_pNew.hidden, true, 'a name the catalog has is not new');
	els.b0_a.dispatch('input');
	assert.equal(els.b0_aNew.hidden, true);
	// a name the catalog doesn't have is typed as before, and the field says it is new; only a comma parts
	// publishers, as "&" is part of many a name
	els.b0e0_p.value = 'Kestrel Row Audio, Wren & Finch Sound';
	els.b0e0_p.dispatch('input');
	assert.equal(els.b0e0_pList.innerHTML, '');
	assert.equal(els.b0e0_pNew.hidden, false);
	assert.equal(
		els.b0e0_pNew.textContent,
		'New publisher: Wren & Finch Sound, added to the catalog when this is saved.',
	);
	els.b0e0_p.listeners.change[0]();
	els.b0_s.value = 'Brand New Saga';
	els.b0_s.dispatch('input');
	assert.equal(els.b0_sNew.textContent, 'New series: Brand New Saga, added to the catalog when this is saved.');
	els.b0_s.value = 'The Lantern Coast';
	els.b0_s.dispatch('input');
	assert.equal(els.b0_sNew.hidden, true);
	assert.equal(await saveEdit(edit), true);
	assert.equal(els.ioStatus.textContent, `Saved ${SALT_ROAD}. New in the catalog: the publisher Wren & Finch Sound.`);
	const saved = (await kept(edit.storage)).books[0];
	assert.deepEqual(saved.a, ['Marisol Quenby', 'Priya Ostrander']);
	assert.deepEqual(
		[saved.e[0].n, saved.e[0].p],
		[
			['Tobias Frane', 'Ingrid Voss'],
			['Kestrel Row Audio', 'Wren & Finch Sound'],
		],
	);
	assert.ok(run('FORM_NAMES.author.length') > 0);
});
test("a book's details link an edition's ASIN to Audible and its Goodreads id to Goodreads; its card leaves editions out", async () => {
	const {run, storage} = await bootBook(SALT_ROAD);
	run(
		"CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', goodreads: '4242' }, p: ['Gull Audio', 'Tern & Finch Press'], len: 642}, {isbn: '9780000000002'}].map(e => Edition.fromJSON(e)); persist()",
	);
	const list = await boot({page: 'books.html', storage});
	// (only its cover's address has its ids)
	assert.doesNotMatch(list.els.results.innerHTML.replace(/<img [^>]*>/g, ''), /TESTASIN01|Gull Audio|9780000000002/);
	const {els, readable} = await bootBook(SALT_ROAD, {storage});
	const html = readable(els.results.innerHTML);
	assert.match(
		html,
		/<h3>Edition 1<\/h3><dl class="details"><dt>ASIN<\/dt><dd>audible\.com <a href="https:\/\/www\.audible\.com\/pd\/TESTASIN01" target="_blank" rel="noopener">TESTASIN01<\/a><\/dd><dt>Goodreads<\/dt><dd><a href="https:\/\/www\.goodreads\.com\/book\/show\/4242" target="_blank" rel="noopener">4242<\/a><\/dd><dt>Publishers<\/dt><dd><a href="publisher\.html#p=Gull\+Audio">Gull Audio<\/a>, <a href="publisher\.html#p=Tern\+%26\+Finch\+Press">Tern &amp; Finch Press<\/a><\/dd><dt>Length<\/dt><dd>10h 42m<\/dd><\/dl>/,
	);
	// an edition without either id has no links
	assert.match(html, /<h3>Edition 2<\/h3><dl class="details"><dt>ISBN<\/dt><dd>9780000000002<\/dd><\/dl>/);
	// each site's ASIN links to the book on that site
	const page = await bootBook(SALT_ROAD, {storage});
	page.run(
		"CATALOG.books[0].editions = [{ext: { 'audible.co.uk': 'TESTASIN02', 'amazon.com': 'TESTASIN03' }}].map(e => Edition.fromJSON(e)); persist()",
	);
	await page.ctx.refreshView();
	await idle();
	assert.match(
		page.readable(page.els.results.innerHTML),
		/<h3>Edition<\/h3><dl class="details"><dt>ASIN<\/dt><dd>audible\.co\.uk <a href="https:\/\/www\.audible\.co\.uk\/pd\/TESTASIN02"[^>]*>TESTASIN02<\/a>, amazon\.com <a href="https:\/\/www\.amazon\.com\/dp\/TESTASIN03"[^>]*>TESTASIN03<\/a><\/dd>/,
	);
});
test("a book edited on its Edit page keeps its id, and so do its editions, a box set's shared one included", async () => {
	const box = {ext: {'audible.com': 'B0BOX00001'}};
	const books = [
		{t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [box, {ext: {goodreads: '4001'}}]},
		{t: 'Gull Light', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [box]},
	];
	const page = await bootBook('Tidewater', {files: {'books.json': JSON.stringify(books)}});
	await page.saved();
	assert.deepEqual(
		page.database.records('editions').map(ed => ed.bookIds.length),
		[2, 1],
		"the box set's edition is one record",
	);
	const edit = await bootEditBook('Tidewater', {storage: page.storage});
	const {els, withIds, database, saved} = edit;
	const before = withIds('CATALOG.books');
	assert.deepEqual(
		before.map(b => b.t),
		['Tidewater', 'Gull Light'],
		"the other book of the box set's edition is loaded with it",
	);
	assert.match(
		els['book-0-ed-0'].innerHTML,
		/<span class="editEdShared">Also on Gull Light: a change here changes it there too\.<\/span>/,
	);
	typeIn(els, 'b0_t', 'Tidewater Rising');
	typeIn(els, 'b0e0_p', 'Gull Audio');
	assert.equal(await saveEdit(edit), true);
	await saved();
	assert.match(els.ioStatus.textContent, /^Saved Tidewater, updated the shared edition on 1 other book\./);
	const after = withIds('CATALOG.books');
	assert.equal(after[0].t, 'Tidewater Rising');
	assert.deepEqual(
		after.map(b => [b.uid, b.e.map(ed => ed.uid)]),
		before.map(b => [b.uid, b.e.map(ed => ed.uid)]),
	);
	assert.deepEqual(after[1].e[0].p, ['Gull Audio'], 'the edit reached the other title');
	const records = database.records('editions');
	assert.deepEqual(
		records.map(ed => [ed.id, ed.bookIds.length]),
		[
			[before[0].e[0].uid, 2],
			[before[0].e[1].uid, 1],
		],
		'still one record each',
	);
	assert.equal(records[0].publisherIds.length, 1);
	assert.deepEqual(
		database.records('books').map(b => b.title),
		['Tidewater Rising', 'Gull Light'],
	);
});
test("an edition's card on the Edit page has a field for each site it has an ASIN on, and Another id adds one for another site", async () => {
	const page = await bootBook(SALT_ROAD);
	page.run(
		"CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', 'amazon.co.uk': 'TESTASIN02' }}, {ext: { goodreads: '4242' }}].map(e => Edition.fromJSON(e)); persist()",
	);
	await idle();
	const edit = await bootEditBook(SALT_ROAD, {storage: page.storage});
	const {els, get} = edit;
	// the sites in use have a field; another is added by its address (or id and site) in Another id
	assert.equal(els['b0e0_ext-audible.com'].value, 'TESTASIN01');
	assert.equal(els['b0e0_ext-amazon.co.uk'].value, 'TESTASIN02');
	assert.equal(els['b0e0_ext-amazon.com'], undefined);
	typeIn(els, 'b0e0_more', 'https://www.amazon.com/dp/TESTASIN03?ref=x');
	assert.equal(els['b0e0_ext-amazon.com'].value, 'TESTASIN03');
	els['b0e1_more-catalog'].value = 'audible.com';
	typeIn(els, 'b0e1_more', 'testasin04');
	assert.deepEqual(JSON.parse(JSON.stringify(get('DRAFTS[0].book.editions'))), [
		{ext: {'audible.com': 'TESTASIN01', 'amazon.co.uk': 'TESTASIN02', 'amazon.com': 'TESTASIN03'}},
		{ext: {'audible.com': 'TESTASIN04', goodreads: '4242'}},
	]);
	// emptying a site's field drops that ASIN; something that isn't an ASIN is named, and changes nothing
	typeIn(els, 'b0e0_ext-amazon.co.uk', '');
	typeIn(els, 'b0e1_ext-audible.com', 'not an asin');
	assert.match(els['book-0-ed-1-error'].textContent, /Not understood: ASIN audible\.com not an asin/);
	assert.equal(await saveEdit(edit), false);
	typeIn(els, 'b0e1_ext-audible.com', 'TESTASIN04');
	assert.equal(await saveEdit(edit), true);
	assert.deepEqual((await kept(edit.storage)).books[0].e, [
		{ext: {'audible.com': 'TESTASIN01', 'amazon.com': 'TESTASIN03'}},
		{ext: {'audible.com': 'TESTASIN04', goodreads: '4242'}},
	]);
});
test('a book card shows its title, authors, narrators and read dates; its page shows the rest', async () => {
	const {ctx, get, readable, els, storage} = await boot();
	ctx.openSeries(seriesIdOf(get, 'The Lantern Coast'));
	await idle();
	const card = readable(els.results.innerHTML).match(
		/<div class="book" data-id="[^"]+"><div class="num">1<\/div>.*?<div class="read">[^<]*<\/div><\/div><\/div>/,
	)[0];
	// its cover from its first ASIN, hidden until it loads
	assert.match(
		card,
		/<div class="num">1<\/div><img class="cover small" src="https:\/\/m\.media-amazon\.com\/images\/P\/SAMPLE0001\.01\.MZZZZZZZ\.jpg" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"><div class="info">/,
	);
	assert.match(
		card,
		/<div class="title"><a href="book\.html#book=The\+Salt\+Road">The Salt Road<\/a><\/div><div class="meta"><a href="author\.html#a=Marisol\+Quenby">Marisol Quenby<\/a> — narr\. /,
	);
	assert.match(card, /<div class="read">Read 2023-06-02, 2025-11-20<\/div><\/div><\/div>$/);
	assert.doesNotMatch(card, /Fantasy|Goodreads|ISBN|Gullwing|<button/, 'nothing to edit, merge or remove it with');

	const book = await bootBook('The Salt Road', {storage});
	const details = book.readable(book.els.results.innerHTML);
	assert.match(
		details,
		/^<div class="book book-details" data-id="[^"]+"><div class="num">1<\/div><div class="head"><h2 class="title">The Salt Road<\/h2><div class="meta"><a href="author\.html#a=Marisol\+Quenby">Marisol Quenby<\/a> — narr\. /,
	);
	assert.match(
		details,
		/<dl class="details"><dt>Series<\/dt><dd><a href="index\.html#series=The\+Lantern\+Coast">The Lantern Coast<\/a> #1<\/dd><dt>Read<\/dt><dd>2023-06-02, 2025-11-20 <button type="button" class="readToday">\+ Read today<\/button><\/dd><dt>Genres<\/dt><dd><span class="genres"><span class="tag">Fantasy<\/span><span class="tag">Adventure<\/span><\/span><\/dd><\/dl>/,
	);
	assert.match(
		details,
		/<dt>Goodreads<\/dt><dd><a [^>]*>9001<\/a><\/dd><dt>ISBN<\/dt><dd>9780000000002<\/dd><dt>Publisher<\/dt><dd><a href="publisher\.html#p=Gullwing\+Audio">Gullwing Audio<\/a><\/dd><dt>Released<\/dt><dd>2019-04-02<\/dd><dt>Length<\/dt><dd>10h 42m<\/dd>/,
	);
	// Edit (its Edit page) and Merge, spelled out, come after everything else
	assert.match(
		details,
		/<\/div><div class="book-actions"><a class="edit" href="edit\.html#book=The\+Salt\+Road">Edit<\/a><button type="button" class="merge" aria-expanded="false">Merge<\/button><\/div><\/div><\/div>$/,
	);
	// the cover comes after the title (beside the rest, or across the card on a phone), then the rest
	assert.match(
		details,
		/<\/div><\/div><img class="cover large" src="https:\/\/m\.media-amazon\.com\/images\/P\/SAMPLE0001\.01\.LZZZZZZZ\.jpg"[^>]*><div class="info"><dl class="details"><dt>Series/,
	);
});
test('a cover tries the next address when one fails or is blank, and can be turned off', async () => {
	const storage = new Map();
	const {els, run} = await bootBook(SALT_ROAD, {storage});
	run(
		"CATALOG.books[0].editions = [{ext: { 'audible.com': 'B0COVER001' }, isbn: '9780000000002'}].map(e => Edition.fromJSON(e)); persist(); render()",
	);
	const cover = () => els.results.querySelector('.cover');
	assert.equal(cover().getAttribute('src'), 'https://m.media-amazon.com/images/P/B0COVER001.01.LZZZZZZZ.jpg');
	// Amazon answers with a blank picture: Open Library is asked next
	Object.assign(cover(), {naturalWidth: 1, naturalHeight: 1}).dispatch('load');
	assert.equal(
		cover().getAttribute('src'),
		'https://covers.openlibrary.org/b/isbn/9780000000002-L.jpg?default=false',
	);
	assert.ok(!cover().classList.contains('loaded'));
	Object.assign(cover(), {naturalWidth: 120, naturalHeight: 180}).dispatch('load');
	assert.ok(cover().classList.contains('loaded'));
	// when the last one fails too, it is hidden
	cover().dispatch('error');
	assert.ok(cover().classList.contains('missing'));
	// turned off on a list, no book asks for one, and it stays off in this browser, on a book's page too
	const list = await boot({page: 'books.html', storage});
	assert.ok(list.els.results.querySelector('.cover'));
	list.els.showCovers.checked = false;
	list.els.showCovers.dispatch('change');
	assert.equal(list.els.results.querySelector('.cover'), null);
	assert.ok(list.els.results.querySelector('.book'));
	const again = await boot({storage, hash: '#series=The+Lantern+Coast'});
	assert.equal(again.els.showCovers.checked, false);
	assert.equal(again.els.results.querySelector('.cover'), null);
	const page = await bootBook(SALT_ROAD, {storage});
	assert.equal(page.els.results.querySelector('.cover'), null);
});
test("a book's details link the Hardcover book and an edition's Hardcover id to Hardcover, and its Edit page keeps them", async () => {
	const {els, run, storage} = await bootBook(SALT_ROAD);
	run(
		"CATALOG.books[0].external = { hardcover: '808' }; CATALOG.books[0].editions = [{ext: { 'audible.com': 'TESTASIN01', hardcover: '31337' }}].map(e => Edition.fromJSON(e)); persist(); render()",
	);
	assert.match(
		els.results.innerHTML,
		/<dt>Hardcover book<\/dt><dd><a href="https:\/\/hardcover\.app\/id\/book\/808" target="_blank" rel="noopener">808<\/a><\/dd>/,
	);
	assert.match(
		els.results.innerHTML,
		/<dt>ASIN<\/dt><dd>audible\.com <a [^>]*>TESTASIN01<\/a><\/dd><dt>Hardcover<\/dt><dd><a href="https:\/\/hardcover\.app\/id\/edition\/31337" target="_blank" rel="noopener">31337<\/a><\/dd>/,
	);
	await idle();
	const list = await boot({page: 'books.html', storage, hash: '#q=808'});
	assert.equal(cards(list.els.results.innerHTML), 1, 'searchable by its Hardcover book id');
	const edit = await bootEditBook(SALT_ROAD, {storage});
	assert.equal(edit.els.b0_ext_hardcover.value, '808');
	assert.deepEqual(draftEditions(edit.get), [{'ext:audible.com': 'TESTASIN01', 'ext:hardcover': '31337'}]);
	// a Hardcover book id is a number
	await typeBookId(edit.els, 'hardcover', 'abc');
	assert.match(edit.els['book-0-error'].textContent, /Not a book's id or address there: Hardcover: abc/);
	assert.equal(await saveEdit(edit), false);
	// a book's address in an edition's Hardcover field goes on the book
	await typeBookId(edit.els, 'hardcover', '');
	typeIn(edit.els, 'b0e0_ext-hardcover', 'https://hardcover.app/id/book/909');
	assert.equal(await saveEdit(edit), true);
	const saved = (await kept(storage)).books[0];
	assert.deepEqual([saved.ext, saved.e], [{hardcover: '909'}, [{ext: {'audible.com': 'TESTASIN01'}}]]);
});
test('an edition added on the Edit page takes its place by release date, earliest first, undated last', async () => {
	const edit = await bootEditBook(SALT_ROAD);
	const {els} = edit;
	addEditionOn(els);
	typeIn(els, 'b0e2_p', 'Undated Audio');
	addEditionOn(els);
	typeIn(els, 'b0e3_p', 'Early Audio');
	typeIn(els, 'b0e3_d', '2018-01');
	assert.equal(await saveEdit(edit), true);
	const stored = (await kept(edit.storage)).books.find(b => b.t === SALT_ROAD);
	assert.deepEqual(
		stored.e.map(ed => ed.p[0]),
		['Early Audio', 'Gullwing Audio', 'Harbourlight Sound', 'Undated Audio'],
	);
});
test("a book's Hardcover field takes the address of a book or edition on Hardcover, and looks up its id", async () => {
	// the page asks Hardcover, with the token saved in this browser
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn, ms) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	}; // the pause between requests
	const storage = new Map();
	const edit = await bootEditBook(SALT_ROAD, {hardcover: hc.fetch, setTimeout, storage});
	const {els, get} = edit;
	await typeBookId(els, 'hardcover', 'https://hardcover.app/books/tidewater');
	assert.match(
		els['book-0-error'].textContent,
		/Couldn't find the Hardcover book: to look it up on Hardcover, save your Hardcover API token/,
	);
	assert.equal(await saveEdit(edit), false);
	assert.equal(hc.sent.length, 0);

	storage.set('audiobook-catalog-hardcover-token', 'tok-123');
	await typeBookId(els, 'hardcover', 'https://hardcover.app/books/tidewater');
	assert.equal(els['book-0-error'].textContent, '');
	assert.equal(els.b0_ext_hardcover.value, '77');
	assert.equal(get("DRAFTS[0].book.idOn('hardcover')"), '77');
	assert.match(els.ioStatus.textContent, /Found on Hardcover: Tidewater \(book 77\)/);
	// an edition's address: its book's id
	await typeBookId(els, 'hardcover', 'https://hardcover.app/books/lantern-hours/editions/801');
	assert.equal(els.b0_ext_hardcover.value, '80');
	// a book's /id/ address holds its id: nothing to ask
	const asked = hc.sent.length;
	await typeBookId(els, 'hardcover', 'hardcover.app/id/book/81');
	assert.equal(get("DRAFTS[0].book.idOn('hardcover')"), '81');
	assert.equal(hc.sent.length, asked);
	assert.equal(await saveEdit(edit), true);
	assert.equal((await kept(storage)).books[0].ext.hardcover, '81');
});
test('adding a book: the Edit page for a new book, which then opens its page', async () => {
	const page = await bootAdd();
	const {ctx, els, get, database, saved} = page;
	assert.equal(els.eyebrow.textContent, 'Add a book');
	assert.equal(els.subtitle.textContent, 'A new book');
	assert.equal(els.bookPanel.hidden, false);
	assert.equal(els.bookRemoveBtn.hidden, true);
	assert.equal(els.seriesPanel.hidden, true);
	assert.equal(els.catalogPanel.hidden, true, 'no catalog has a book that is not added yet');
	const current = [...ctx.document.querySelectorAll('nav.pages a')].filter(a => a.classList.contains('current'));
	assert.deepEqual(
		current.map(a => a.getAttribute('href')),
		['books.html'],
		'the nav bar marks Books',
	);
	const before = database.records('books').length;
	typeIn(els, 'b0_t', 'Brand New');
	assert.equal(els['book-0-error'].textContent, 'A book needs an author.');
	typeIn(els, 'b0_a', 'Some Author');
	typeIn(els, 'b0_g', 'Fantasy, Cozy');
	assert.equal(els['book-0-error'].textContent, '');
	assert.equal(await saveEdit(page), true);
	await saved();
	assert.equal(database.records('books').length, before + 1);
	const added = database.records('books').find(b => b.title === 'Brand New');
	assert.deepEqual(get(`CATALOG.book(${JSON.stringify(added.id)})`), {
		t: 'Brand New',
		a: ['Some Author'],
		g: ['Fantasy', 'Cozy'],
	});
	// its page opens, saying so
	assert.equal(ctx.location.assigned, `book.html#book=${added.id}`);
	assert.equal(els.ioStatus.textContent, 'Added Brand New. New in the catalog: the author Some Author.');
	// a book needs a title and an author
	const empty = await bootAdd();
	typeIn(empty.els, 'b0_g', 'Cozy');
	assert.equal(empty.els['book-0-error'].textContent, 'A book needs a title. A book needs an author.');
	assert.equal(await saveEdit(empty), false);
	// Discard goes back to where the new book was to go
	const cancel = await bootAdd('&series=id-x');
	cancel.els.discardBtn.listeners.click[0]();
	assert.equal(cancel.ctx.location.assigned, 'index.html#series=id-x');
	const plain = await bootAdd();
	plain.els.discardBtn.listeners.click[0]();
	assert.equal(plain.ctx.location.assigned, 'books.html');
	// an address from when a book's page added books goes to the Edit page
	const old = await boot({page: 'book.html', hash: '#add&series=id-x'});
	assert.equal(old.ctx.location.replaced, 'edit.html#add&series=id-x');
});
test('with a catalog proxy saved, a new book is filled in from Audible and AudiobookDB through it, with its key', async () => {
	const behind = fakeProxyCatalogs();
	const asked = [];
	const proxy = async (url, init) => {
		asked.push({url, key: init.headers['X-Server-Key']});
		return behind.route(url.replace('https://catalog-proxy.example.workers.dev/proxy/', ''));
	};
	const storage = new Map([
		[
			'audiobook-catalog-proxy',
			JSON.stringify({url: 'https://catalog-proxy.example.workers.dev', key: 'right-key'}),
		],
	]);
	const {ctx, els, get} = await bootAdd('', {proxy, storage});
	els.fillFrom.value = 'https://www.audible.com/pd/The-Lantern-Keeper-Audiobook/B0LANTERN2';
	await ctx.fillFromCatalog();
	assert.equal(els.bookFormError.textContent, '');
	assert.equal(els.b0_t.value, 'The Lantern Keeper');
	assert.equal(els.b0_a.value, 'Ann Vale');
	assert.equal(els.b0_s.value, 'Gull Isle');
	assert.equal(els.b0_sn.value, '2');
	assert.equal(els.b0_g.value, 'Fantasy, Literary Fiction');
	assert.equal(els.b0_ext_audiobookdb.value, 'LnTrnKpr2xYz');
	assert.deepEqual(draftEditions(get), [
		{
			n: 'Hollis Marr, Dana Fenwick',
			'ext:audible.com': 'B0LANTERN2',
			'ext:audiobookdb': 'RlsLntrnUS01',
			isbn: '9780000000019',
			p: 'Gullwing Audio',
			d: '2021-03-04',
			len: '10h 12m',
			'img:audiobookdb': 'c1'.repeat(32),
		},
	]);
	assert.match(
		els.ioStatus.textContent,
		/^Filled in from Audible and AudiobookDB: title, authors, series, number in the series, genres, the book's id in another catalog, an edition\.$/,
	);
	assert.ok(
		asked.length &&
			asked.every(a => a.key === 'right-key' && a.url.startsWith('https://catalog-proxy.example.workers.dev/')),
	);
	// an ASIN the book already has fills in that edition's gaps, even where it says something else, rather than adding one
	const again = await bootAdd('', {proxy, storage});
	addEditionOn(again.els);
	again.els['b0e0_more-catalog'].value = 'audible.com';
	typeIn(again.els, 'b0e0_more', 'B0OTHERED1');
	addEditionOn(again.els);
	again.els['b0e1_more-catalog'].value = 'audible.com';
	typeIn(again.els, 'b0e1_more', 'B0LANTERN2');
	typeIn(again.els, 'b0e1_p', 'Gullwing Audio Ltd');
	again.els.fillFrom.value = 'B0LANTERN2';
	await again.ctx.fillFromCatalog();
	assert.equal(again.els.bookFormError.textContent, '');
	assert.deepEqual(draftEditions(again.get), [
		{'ext:audible.com': 'B0OTHERED1'},
		{
			n: 'Hollis Marr, Dana Fenwick',
			'ext:audible.com': 'B0LANTERN2',
			'ext:audiobookdb': 'RlsLntrnUS01',
			isbn: '9780000000019',
			p: 'Gullwing Audio Ltd',
			d: '2021-03-04',
			len: '10h 12m',
			'img:audiobookdb': 'c1'.repeat(32),
		},
	]);
	// a title is looked up on AudiobookDB: by the authors typed, when it has several of that title
	const titled = await bootAdd('', {proxy, storage});
	titled.els.fillFrom.value = 'the lantern keeper';
	await titled.ctx.fillFromCatalog();
	assert.match(
		titled.els.bookFormError.textContent,
		/AudiobookDB has 2 books titled the lantern keeper: The Lantern Keeper by Ann Vale \(https:\/\/audiobookdb\.org\/books\/LnTrnKpr2xYz\); The Lantern Keeper by Bo Reed .*type the author first/,
	);
	typeIn(titled.els, 'b0_a', 'Ann Vale');
	await titled.ctx.fillFromCatalog();
	assert.equal(titled.els.bookFormError.textContent, '');
	assert.equal(titled.els.b0_ext_audiobookdb.value, 'LnTrnKpr2xYz');
	assert.equal(titled.els.b0_s.value, 'Gull Isle');
	assert.match(
		titled.els.ioStatus.textContent,
		/^Filled in from AudiobookDB: title, series, number in the series, genres, the book's id in another catalog\. \(AudiobookDB has 2 releases of it/,
	);
	titled.els.fillFrom.value = 'The Salt Harbor';
	await titled.ctx.fillFromCatalog();
	assert.match(
		titled.els.bookFormError.textContent,
		/AudiobookDB has no book titled The Salt Harbor by Ann Vale; paste its address instead/,
	);
	// without the proxy, AudiobookDB says how it could be asked
	const without = await bootAdd();
	without.els.fillFrom.value = 'https://audiobookdb.org/releases/RlsLntrnUS01';
	await without.ctx.fillFromCatalog();
	assert.match(
		without.els.bookFormError.textContent,
		/AudiobookDB can't be read from a web page; to ask it through a server of your own, save your server on the Import & export page first\.$/,
	);
});
test('a new book is filled in from another catalog: only its empty fields, and the edition', async () => {
	const catalogs = fakeCatalogs();
	const storage = new Map();
	const page = await bootAdd('', {catalogs: catalogs.fetch, storage});
	const {ctx, els, get} = page;
	// what was typed stays
	typeIn(els, 'b0_t', 'My Own Title');
	addEditionOn(els);
	typeIn(els, 'b0e0_desc', 'UK edition');
	els.fillFrom.value = 'https://openlibrary.org/books/OL901M/The_lantern_keeper';
	let prevented = false;
	els.fillFrom.dispatch('keydown', {
		key: 'Enter',
		preventDefault() {
			prevented = true;
		},
	});
	assert.ok(prevented, 'Enter looks it up');
	await idle();
	await settle();
	await settle();
	assert.equal(els.b0_t.value, 'My Own Title');
	assert.equal(els.b0_a.value, 'Ann Vale');
	assert.equal(els.b0_s.value, 'Gull Isle');
	assert.equal(els.b0_sn.value, '2');
	assert.equal(els.b0_ext_openlibrary.value, 'OL900W');
	assert.deepEqual(draftEditions(get), [
		{
			desc: 'UK edition',
			n: 'Hollis Marr',
			'ext:amazon.com': 'B0LANTERN2',
			'ext:goodreads': '5151',
			'ext:openlibrary': 'OL901M',
			isbn: '9780000000019',
			p: 'Gullwing Audio',
			d: '2021-03-04',
		},
	]);
	assert.match(
		els.ioStatus.textContent,
		/^Filled in from Open Library: authors, series, number in the series, the book's id in another catalog, an edition\. \(to fill in narrators and length from Hardcover too/,
	);
	assert.equal(els.fillFrom.value, '');
	assert.equal(els.bookFormError.textContent, '');
	// Wikidata adds what is still missing, and its ids where the book has none
	els.fillFrom.value = 'Q9001';
	await ctx.fillFromCatalog();
	assert.equal(els.bookFormError.textContent, '');
	assert.equal(els.b0_g.value, 'fantasy');
	assert.equal(els.b0_ext_wikidata.value, 'Q9001');
	assert.equal(els.b0_ext_goodreads.value, '7171');
	assert.equal(els.b0_ext_openlibrary.value, 'OL900W');
	assert.match(els.ioStatus.textContent, /^Filled in from Wikidata: genres, the book's ids in other catalogs\.$/);
	// again, nothing is left to fill in
	els.fillFrom.value = 'Q9001';
	await ctx.fillFromCatalog();
	assert.match(els.ioStatus.textContent, /^Found on Wikidata, but the book already has all it gives\./);
	// what can't be looked up says why, and keeps what was pasted
	els.fillFrom.value = 'https://www.audible.com/pd/B0TIDEWAT1';
	await ctx.fillFromCatalog();
	assert.match(
		els.bookFormError.textContent,
		/^Couldn't fill in the book: Audible and AudiobookDB can't be read from a web page; to look it up on Hardcover, save your Hardcover API token/,
	);
	assert.equal(els.fillFrom.value, 'https://www.audible.com/pd/B0TIDEWAT1');
	// saved, the book has it all
	assert.equal(await saveEdit(page), true);
	const added = (await kept(storage)).books.find(b => b.t === 'My Own Title');
	assert.deepEqual(added.ext, {
		goodreads: '7171',
		openlibrary: 'OL900W',
		wikidata: 'Q9001',
	});
	assert.equal(added.e[0].isbn, '9780000000019');
	assert.ok(catalogs.sent.length > 0);
});
test("a book fills in from Hardcover with the token saved, by an Audible page's ASIN", async () => {
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn, ms) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const storage = new Map([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const {ctx, els, get} = await bootAdd('', {
		hardcover: hc.fetch,
		catalogs: fakeCatalogs().fetch,
		setTimeout,
		storage,
	});
	els.fillFrom.value = 'https://www.audible.com/pd/Tidewater-Audiobook/B0TIDEWAT1';
	await ctx.fillFromCatalog();
	assert.equal(els.b0_t.value, 'Tidewater');
	assert.equal(els.b0_a.value, 'Ann Vale');
	assert.equal(els.b0_ext_hardcover.value, '77');
	assert.deepEqual(draftEditions(get), [
		{
			n: 'Hollis Marr',
			'ext:audible.com': 'B0TIDEWAT1',
			'ext:amazon.com': 'B0TIDEWAT1',
			'ext:hardcover': '501',
			len: '10h',
		},
	]);
	assert.match(
		els.ioStatus.textContent,
		/^Filled in from Hardcover: title, authors, series, number in the series, the book's id in another catalog, an edition\.$/,
	);
});
test('a new book starts with the series it is added to and the author picked', async () => {
	const {ctx, get, els, storage} = await boot();
	const orchard = seriesIdOf(get, 'The Orchard Cycle');
	ctx.openSeries(orchard);
	await idle();
	const form = async href => {
		assert.match(href, /^edit\.html#add/);
		const page = await bootAdd(href.slice('edit.html#add'.length), {storage});
		return [page.els.b0_s.value, page.els.b0_a.value];
	};
	// a series: its name, and the authors of all its books
	assert.deepEqual(await form(els.toggleAdd.getAttribute('href')), ['The Orchard Cycle', 'Wendell Ashcombe']);
	// all books: nothing, unless an author is picked
	const books = await boot({page: 'books.html', storage});
	assert.deepEqual(await form(books.els.toggleAdd.getAttribute('href')), ['', '']);
	books.els.authorFilter.value = 'Priya Ostrander';
	books.els.authorFilter.listeners.change[0]();
	await idle();
	assert.equal(books.els.toggleAdd.getAttribute('href'), 'edit.html#add&author=Priya+Ostrander');
	assert.deepEqual(await form(books.els.toggleAdd.getAttribute('href')), ['', 'Priya Ostrander']);
});
test("an edition's page pasted in Another id, or in its id field, becomes its id", async () => {
	const {els, get} = await bootAdd();
	addEditionOn(els);
	const ids = () => get('DRAFTS[0].book.editions[0].external');
	// Another id: the address of the edition's page on any catalog, which then has a field of its own
	typeIn(els, 'b0e0_more', 'https://www.goodreads.com/book/show/4242-the-salt-road');
	assert.equal(els['b0e0_ext-goodreads'].value, '4242');
	assert.equal(els.b0e0_more.value, '');
	typeIn(els, 'b0e0_more', 'https://hardcover.app/books/the-salt-road/editions/501');
	typeIn(els, 'b0e0_more', 'https://www.audible.com/pd/The-Salt-Road-Audiobook/B0SALTROAD?qid=1');
	typeIn(els, 'b0e0_more', 'https://www.amazon.co.uk/dp/B0SALTUK01');
	typeIn(els, 'b0e0_more', 'https://audiobookdb.org/releases/Kx7UDyK3gMqj');
	assert.deepEqual(ids(), {
		goodreads: '4242',
		hardcover: '501',
		'audible.com': 'B0SALTROAD',
		'amazon.co.uk': 'B0SALTUK01',
		audiobookdb: 'Kx7UDyK3gMqj',
	});
	// an id field takes its catalog's address too, and shows the id
	typeIn(els, 'b0e0_ext-goodreads', 'https://www.goodreads.com/book/show/4243-the-salt-road');
	assert.equal(els['b0e0_ext-goodreads'].value, '4243');
	assert.equal(ids().goodreads, '4243');
	// a site the edition has an ASIN on already keeps it, and says why
	typeIn(els, 'b0e0_more', 'https://www.amazon.co.uk/dp/B0OTHER001');
	assert.match(
		els['book-0-ed-0-error'].textContent,
		/It has an id on .* already: https:\/\/www\.amazon\.co\.uk\/dp\/B0OTHER001\./,
	);
	assert.equal(ids()['amazon.co.uk'], 'B0SALTUK01');
	// anything else is named
	typeIn(els, 'b0e0_more', 'not an address');
	assert.match(
		els['book-0-ed-0-error'].textContent,
		/Not an edition's address: not an address\. For a bare id, pick its catalog\./,
	);
});
test('dates read: shown on the card, edited on its Edit page, and filterable by year', async () => {
	const {ctx, els, storage} = await boot({page: 'books.html'});
	const dated = demoBooks.find(b => b.r && b.r.length > 1);
	assert.ok(dated, 'the demo data has a book read more than once');
	assert.ok(els.results.innerHTML.includes(`Read ${dated.r.join(', ')}`));

	// the read filter lists each year, newest first, and "no date"
	assert.match(els.readFilter.innerHTML, /Read in 2026.*Read in 2025.*Read in 2023/);
	assert.match(els.readFilter.innerHTML, /No date read/);
	els.readFilter.value = '2025';
	await ctx.refreshView();
	await idle();
	const inYear = demoBooks.filter(b => (b.r || []).some(d => d.startsWith('2025')));
	assert.equal(cards(els.results.innerHTML), inYear.length);
	els.readFilter.value = '__undated__';
	await ctx.refreshView();
	await idle();
	assert.equal(cards(els.results.innerHTML), demoBooks.filter(b => !b.r).length);

	// edit: the Edit page shows the dates; they are tidied, sorted and de-duplicated
	const stored = () => kept(storage).then(k => k.books.find(b => b.t === dated.t));
	const edit = await bootEditBook(dated.t, {storage});
	assert.equal(edit.els.b0_r.value, dated.r.join(', '));
	typeIn(edit.els, 'b0_r', '2026/9/1, 2021, 2026-09-01');
	assert.equal(await saveEdit(edit), true);
	assert.deepEqual((await stored()).r, ['2021', '2026-09-01']);

	// "+ Read today" adds today's date once
	const again = await bootEditBook(dated.t, {storage});
	const f = again.els;
	f['b0_r-today'].listeners.click[0]();
	f['b0_r-today'].listeners.click[0]();
	const today = again.get('Text.today()');
	assert.equal(f.b0_r.value, `2021, 2026-09-01, ${today}`);
	assert.deepEqual(again.get('DRAFTS[0].book.read'), ['2021', '2026-09-01', today]);

	// a bad date is named, and changes nothing
	typeIn(f, 'b0_r', '2026-02-30');
	assert.match(f['book-0-error'].textContent, /Not a date: 2026-02-30/);
	assert.equal(await saveEdit(again), false);
	assert.deepEqual((await stored()).r, ['2021', '2026-09-01']);

	// clearing the field removes the dates
	typeIn(f, 'b0_r', '');
	assert.equal(await saveEdit(again), true);
	assert.equal((await stored()).r, undefined);
});
test("an edition's own title: shown on the book page, found by the search, and kept or made the book's on its Edit page", async () => {
	const mine = JSON.stringify([
		{
			t: 'The Lantern Keeper',
			a: ['Ann Vale'],
			e: [
				{ext: {'audible.co.uk': 'B0UKLAMP01'}},
				{t: 'The Keeper of Lanterns', ext: {'audible.com': 'B0USLAMP01'}},
			],
		},
		{t: 'Other', a: ['Ann Vale']},
	]);
	const {els, readable, storage} = await bootBook('The Lantern Keeper', {files: {'books.json': mine}});
	assert.match(
		readable(els.results.innerHTML),
		/<h2 class="title">The Lantern Keeper<\/h2><div class="alsoTitled">Also published as <cite>The Keeper of Lanterns<\/cite><\/div>/,
	);
	assert.match(readable(els.results.innerHTML), /<dt>Title<\/dt><dd>The Keeper of Lanterns<\/dd>/);

	// the search finds it by either title; the card names the other title only when that is what was found
	const list = await boot({page: 'books.html', storage});
	list.els.q.value = 'keeper of lanterns';
	await list.ctx.refreshView();
	await idle();
	assert.equal(cards(list.els.results.innerHTML), 1);
	assert.match(list.els.results.innerHTML, /Also published as <cite>The Keeper of Lanterns<\/cite>/);
	list.els.q.value = 'lantern keeper';
	await list.ctx.refreshView();
	await idle();
	assert.equal(cards(list.els.results.innerHTML), 1);
	assert.doesNotMatch(list.els.results.innerHTML, /Also published as/);

	// the Edit page: the US edition's title made the book's, the UK edition gets the book's title before
	const edit = await bootEditBook('The Lantern Keeper', {storage});
	assert.deepEqual(draftEditions(edit.get), [
		{'ext:audible.co.uk': 'B0UKLAMP01'},
		{t: 'The Keeper of Lanterns', 'ext:audible.com': 'B0USLAMP01'},
	]);
	assert.doesNotMatch(edit.els['book-0-ed-0'].innerHTML, /Use as the book's title/, 'it has no title of its own');
	edit.els['book-0-ed-1-use-title'].listeners.click[0]();
	assert.equal(edit.els.b0_t.value, 'The Keeper of Lanterns');
	assert.deepEqual(draftEditions(edit.get), [
		{'ext:audible.co.uk': 'B0UKLAMP01', t: 'The Lantern Keeper'},
		{'ext:audible.com': 'B0USLAMP01'},
	]);
	// a title that is the book's (a subtitle aside) is no title of the edition's own
	typeIn(edit.els, 'b0e1_t', 'The Keeper of Lanterns: A Novel');
	assert.equal(await saveEdit(edit), true);
	assert.deepEqual((await kept(storage)).books[0], {
		t: 'The Keeper of Lanterns',
		a: ['Ann Vale'],
		e: [{t: 'The Lantern Keeper', ext: {'audible.co.uk': 'B0UKLAMP01'}}, {ext: {'audible.com': 'B0USLAMP01'}}],
	});
});
test("ISBNs: shown in a book's details, searchable however typed, edited on its Edit page", async () => {
	// written before editions: read as the book's first edition
	const mine = JSON.stringify([
		{t: 'Boxed One', a: ['Ann Vale'], isbn: ['9780306406157']},
		{t: 'Other', a: ['Ann Vale']},
	]);
	const {els, readable, storage} = await bootBook('Boxed One', {files: {'books.json': mine}});
	assert.match(readable(els.results.innerHTML), /<dt>ISBN<\/dt><dd>9780306406157<\/dd>/);
	const list = await boot({page: 'books.html', storage});
	for (const q of ['9780306406157', '0-306-40615-2', '406157']) {
		list.els.q.value = q;
		await list.ctx.refreshView();
		await idle();
		assert.equal(cards(list.els.results.innerHTML), 1, q);
	}

	const edit = await bootEditBook('Boxed One', {storage});
	assert.deepEqual(draftEditions(edit.get), [{isbn: '9780306406157'}]);
	// another ISBN is another edition
	typeIn(edit.els, 'b0e0_isbn', '9780306406157, 978-0-00-000000-2');
	assert.deepEqual(draftEditions(edit.get), [{isbn: '9780306406157'}, {isbn: '9780000000002'}]);
	assert.equal(await saveEdit(edit), true);
	const stored = async title => (await kept(storage)).books.find(b => b.t === title);
	assert.deepEqual((await stored('Boxed One')).e, [{isbn: '9780306406157'}, {isbn: '9780000000002'}]);

	// the same ISBN may go on another book (a boxed set); its details then say so
	const other = await bootEditBook('Other', {storage});
	addEditionOn(other.els);
	typeIn(other.els, 'b0e0_isbn', '0306406152');
	assert.equal(await saveEdit(other), true);
	assert.deepEqual((await stored('Other')).e, [{isbn: '9780306406157'}]);
	const page = await bootBook('Other', {storage});
	assert.match(
		page.readable(page.els.results.innerHTML),
		/<dt>Also in this edition<\/dt><dd><a href="#book=Boxed\+One">Boxed One<\/a><\/dd>/,
	);

	// a mistyped ISBN is named, and changes nothing
	const again = await bootEditBook('Other', {storage});
	const o = again.els;
	typeIn(o, 'b0e0_isbn', '9780306406158');
	assert.match(o['book-0-ed-0-error'].textContent, /Not understood: ISBN 9780306406158/);
	assert.equal(await saveEdit(again), false);
	o.b0e0_isbn.value = '';
	typeIn(o, 'b0e0_d', 'someday');
	assert.match(o['book-0-ed-0-error'].textContent, /Not understood: Released someday/);
	assert.deepEqual(draftEditions(again.get), [{isbn: '9780306406157'}]);
	// Remove edition leaves the book without one
	o['book-0-ed-0-remove'].listeners.click[0]();
	o['book-0-ed-0-remove-do'].listeners.click[0]();
	assert.equal(await saveEdit(again), true);
	assert.equal((await stored('Other')).e, undefined);
});
test("narrators and descriptions live on editions: the card names the narrators, the details each edition's, searchable, edited on its Edit page", async () => {
	const {els, readable, storage} = await boot({page: 'books.html'});
	const salt = demoBooks.find(b => b.t === 'The Salt Road');
	assert.ok(
		salt.e.some(ed => ed.desc),
		'the demo data has an edition with a description',
	);
	// both narrators on the book; with different narrators each edition names its own
	assert.match(
		readable(els.results.innerHTML),
		/narr\. <a href="narrator\.html#n=Tobias\+Frane">Tobias Frane<\/a> \/ <a href="narrator\.html#n=Hollis\+Marr">Hollis Marr<\/a>/,
	);
	assert.doesNotMatch(readable(els.results.innerHTML), /UK edition/, 'the card leaves editions out');
	for (const q of ['hollis marr', 'uk edition']) {
		const found = await boot({page: 'books.html', storage, hash: '#q=' + hashValue(q)});
		assert.equal(cards(found.els.results.innerHTML), 1, q);
	}
	const book = await bootBook('The Salt Road', {storage});
	const b = book.els;
	assert.match(
		book.readable(b.results.innerHTML),
		/<h3>Edition 1<\/h3><dl class="details"><dt>Narrated by<\/dt><dd><a href="narrator\.html#n=Tobias\+Frane">Tobias Frane<\/a><\/dd><dt>ASIN/,
	);
	assert.match(
		book.readable(b.results.innerHTML),
		/<h3>Edition 2: UK edition<\/h3><dl class="details"><dt>Narrated by<\/dt><dd><a href="narrator\.html#n=Hollis\+Marr">Hollis Marr<\/a><\/dd><dt>ASIN/,
	);

	const edit = await bootEditBook('The Salt Road', {storage});
	const e = edit.els;
	assert.equal(draftEditions(edit.get)[0].n, 'Tobias Frane');
	assert.equal(draftEditions(edit.get)[0]['ext:audible.com'], 'SAMPLE0001');
	assert.equal(draftEditions(edit.get)[0]['ext:amazon.com'], 'SAMPLE0201');
	addEditionOn(e);
	typeIn(e, 'b0e2_desc', 'Dramatized adaptation; unabridged');
	typeIn(e, 'b0e2_n', 'A full cast');
	e['b0e2_more-catalog'].value = 'goodreads';
	typeIn(e, 'b0e2_more', '777');
	assert.equal(await saveEdit(edit), true);
	assert.deepEqual((await kept(storage)).books[0].e[2], {
		ext: {goodreads: '777'},
		n: ['A full cast'],
		desc: 'Dramatized adaptation; unabridged',
	});
});
test('box sets: kept as their own book, last in the series, and not counted as one more title', async () => {
	const {ctx, els, get} = await boot();
	ctx.openSeries(seriesIdOf(get, 'The Orchard Cycle'));
	await idle();
	const titles = [...els.results.innerHTML.matchAll(/<div class="title"><a [^>]*>([^<]+)<\/a>/g)].map(m => m[1]);
	assert.deepEqual(titles, [
		'The Brass Orchard',
		'The Copper Graft',
		'Harvest of Gears',
		'The Orchard Cycle: Books 2-3',
	]);
	assert.match(els.results.innerHTML, /<span class="n">3 owned \+ 1 box set<\/span>/);
	ctx.openSeries(null);
	await idle();
	assert.match(els.results.innerHTML, /The Orchard Cycle<\/a>\s*<span class="srow-owned">3 owned<\/span>/);
});
test('box sets: the edition shows on each of its books, and editing it on one edits it on all', async () => {
	const {els, get, readable, follow, storage} = await bootBook('The Copper Graft');
	assert.match(
		readable(els.results.innerHTML),
		/<h3>Edition: The Orchard Cycle: Books 2-3<\/h3><dl class="details"><dt>Narrated by<\/dt><dd><a [^>]*>Ingrid Voss<\/a><\/dd><dt>ASIN<\/dt><dd>audible.com <a [^>]*>SAMPLE0008<\/a><\/dd><dt>ISBN<\/dt><dd>9780306406157<\/dd><dt>Publisher<\/dt><dd><a [^>]*>Kestrel Row Audio<\/a><\/dd><dt>Released<\/dt><dd>2022-11<\/dd><dt>Length<\/dt><dd>23h 5m<\/dd>/,
	);
	assert.match(
		readable(els.results.innerHTML),
		/<dt>Also in this edition<\/dt><dd><a href="#book=Harvest\+of\+Gears">Harvest of Gears #3<\/a>/,
	);
	const harvest = bookIdOf(get, 'Harvest of Gears');
	follow(`#book=${harvest}`);
	await idle();
	assert.match(
		readable(els.results.innerHTML),
		/<dt>Also in this edition<\/dt><dd><a href="#book=The\+Copper\+Graft">The Copper Graft #2<\/a>/,
	);
	const list = await boot({page: 'books.html', storage, hash: '#q=kestrel+row'});
	assert.equal(cards(list.els.results.innerHTML), 3, "search finds a publisher (the box set's own book too)");

	const edit = await bootEditBook('The Copper Graft', {storage});
	assert.match(
		edit.els['book-0-ed-0'].innerHTML,
		/Also on Harvest of Gears, The Orchard Cycle: Books 2-3: a change here changes it there too\./,
	);
	typeIn(edit.els, 'b0e0_p', 'Merlin Lane Audio');
	assert.equal(await saveEdit(edit), true);
	assert.match(edit.els.ioStatus.textContent, /updated the shared edition on 2 other books/);
	assert.deepEqual((await kept(storage)).books.find(b => b.t === 'Harvest of Gears').e[0].p, ['Merlin Lane Audio']);
});
test('a Goodreads import adds the ISBN to the edition of books already there', async () => {
	const mine = JSON.stringify([{t: 'Old Favorite', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}], r: ['2020']}]);
	const {els, get, readable} = await boot({page: 'import.html', files: {'books.json': mine}});
	const csv =
		'Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf,Date Read\n' +
		'Old Favorite,Ann Vale,"=""0306406152""","=""9780306406157""",Audible Audio,read,2023/11/04\n';
	els.goodreadsImportBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'goodreads.csv', text: csv}], value: ''}});
	await idle();
	const html = readable(els.importPreviewBody.innerHTML);
	// the edition picked on Goodreads may not be yours: it is left out unless ticked
	assert.match(
		html,
		/Goodreads has more \(1\)<\/h4>.*<span class="cmpBook">Old Favorite — Ann Vale<\/span><ul><li><label class="cmpPick"><input type="checkbox" data-pick="editions:0"> the Goodreads edition: ISBN<\/label>/,
	);
	// the book has a date read already, so the other one is a difference to tick, not a gain
	assert.match(
		html,
		/Different in both \(1\)<\/h4>.*data-pick="patch:0:r"> Dates read: <span class="cmpHere">2020<\/span> here, <span class="cmpThere">2023-11-04<\/span> on Goodreads/,
	);
	assert.equal(els.importConfirm.style.display, 'none', 'nothing ticked');
	const edition = els.importPreviewBody.querySelector('input[data-pick="editions:0"]');
	edition.checked = true;
	edition.dispatch('change');
	assert.equal(els.importConfirm.textContent, 'Apply 1 change');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books[0].editions'), [{ext: {'audible.com': 'B1'}, isbn: '9780306406157'}]);
	assert.deepEqual(get('CATALOG.books[0].read'), ['2020'], 'a value this catalog has is only replaced when ticked');
	assert.match(els.ioStatus.textContent, /added ISBNs to 1 book/);
});
test('authors are lists: the author filter offers each author on its own, and its Edit page edits them as text', async () => {
	const {ctx, els, readable, storage} = await boot({page: 'books.html'});
	const nine = demoBooks.find(b => b.t === 'Nine Ways to Lose a Kingdom');
	assert.deepEqual(nine.a, ['Ferran Doyle', 'Priya Ostrander'], 'the demo data has a book with two authors');
	assert.match(readable(els.authorFilter.innerHTML), /<option value="Priya Ostrander">Priya Ostrander<\/option>/);
	assert.doesNotMatch(readable(els.authorFilter.innerHTML), /Ferran Doyle, Priya Ostrander/);
	assert.equal((readable(els.authorFilter.innerHTML).match(/<option value="Priya Ostrander">/g) || []).length, 1);
	// each author's name links to their page
	assert.match(
		readable(els.results.innerHTML),
		/<div class="meta"><a href="author\.html#a=Ferran\+Doyle">Ferran Doyle<\/a>, <a href="author\.html#a=Priya\+Ostrander">Priya Ostrander<\/a><\/div>/,
	);
	els.authorFilter.value = 'Priya Ostrander';
	await ctx.refreshView();
	await idle();
	assert.equal(cards(els.results.innerHTML), 3, 'her two books and the one she co-wrote');

	const edit = await bootEditBook(nine.t, {storage});
	assert.equal(edit.els.b0_a.value, 'Ferran Doyle, Priya Ostrander');
	typeIn(edit.els, 'b0_a', 'Ferran Doyle & Cass Merriweather');
	assert.equal(await saveEdit(edit), true);
	assert.deepEqual((await kept(storage)).books.find(b => b.t === nine.t).a, ['Ferran Doyle', 'Cass Merriweather']);

	// authors and narrators written as comma separated text, from before, load as lists
	const mine = JSON.stringify([
		{t: 'Old Style', a: 'Ann Vale, Bo Reed', e: [{ext: {'audible.com': 'B1'}, n: 'Cy Hale, Di Moss'}]},
	]);
	const old = await boot({page: 'books.html', files: {'books.json': mine}});
	assert.deepEqual((await kept(old.storage)).books, [
		{t: 'Old Style', a: ['Ann Vale', 'Bo Reed'], e: [{ext: {'audible.com': 'B1'}, n: ['Cy Hale', 'Di Moss']}]},
	]);
	await idle();
	assert.match(old.readable(old.els.authorFilter.innerHTML), /<option value="Bo Reed">/);
	assert.match(
		old.readable(old.els.results.innerHTML),
		/Ann Vale<\/a>, <a [^>]*>Bo Reed<\/a> — narr\. <a href="narrator\.html#n=Cy\+Hale">Cy Hale<\/a>, <a href="narrator\.html#n=Di\+Moss">Di Moss<\/a><\/div>/,
	);
});
