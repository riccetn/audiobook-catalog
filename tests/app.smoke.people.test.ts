// Browser smoke tests: authors, narrators and publishers, spelling, pages that hold only what they show, links,
// Fill in from other catalogs, and places. The pages run in Node against a fake DOM (boot() in smoke.ts).
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeHardcover, hardcoverState} from './fake-hardcover.ts';
import {fakeCatalogs} from './fake-catalogs.ts';
import {
	ALL_PAGES,
	PAGE_HASH,
	bookIdOf,
	boot,
	bootBook,
	bootEdit,
	bootEditBook,
	databaseOf,
	demoBooks,
	draftEditions,
	idle,
	kept,
	removeBook,
	saveEdit,
	seriesIdOf,
	typeIn,
} from './smoke.ts';

// ------------------------------------------------------------------ the authors page
test('the authors page lists every author, with their books and series, and a search narrows it', async () => {
	const {els, readable} = await boot({page: 'authors.html'});
	const authors = new Set(demoBooks.flatMap(b => b.a));
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, authors.size);
	assert.match(
		els.subtitle.textContent,
		new RegExp(`^${authors.size} authors across ${demoBooks.length} audiobooks`),
	);
	assert.match(
		readable(els.creditBody.innerHTML),
		/<a class="srow-title" href="author\.html#a=Priya\+Ostrander">Priya Ostrander<\/a>\s*<span class="srow-owned">3 books, 1 series<\/span>/,
	);
	// a box set kept beside its titles is counted apart, not as one more book
	const sets = demoBooks.filter(b => b.a.includes('Wendell Ashcombe') && /^\d+-\d+$/.test(b.sn || '')).length;
	const titles = demoBooks.filter(b => b.a.includes('Wendell Ashcombe')).length - sets;
	assert.equal(sets, 1);
	assert.match(
		readable(els.creditBody.innerHTML),
		new RegExp(`Wendell Ashcombe</a>\\s*<span class="srow-owned">${titles} books \\+ 1 box set, 1 series</span>`),
	);
	const author = await boot({page: 'author.html', hash: '#a=Wendell+Ashcombe', storage: undefined});
	await idle();
	assert.equal(author.els.subtitle.textContent, `${titles} audiobooks in 1 series, and 1 box set`);
	// the first line of a bio, when there is one
	assert.match(readable(els.creditBody.innerHTML), /Priya Ostrander writes cozy mysteries/);
	els.q.value = 'ferran';
	els.q.listeners.input[0]();
	await idle();
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, 1);
	els.q.value = 'zzzz';
	els.q.listeners.input[0]();
	await idle();
	assert.match(readable(els.creditBody.innerHTML), /No authors match/);
});
test("someone's page from before it had its own goes there, and their page without an address goes to the list", async () => {
	for (const [list, hash, page] of [
		['authors.html', '#a=Marisol+Quenby', 'author.html'],
		['narrators.html', '#n=id-7', 'narrator.html'],
		['publishers.html', '#p=Kestrel+Row+Audio', 'publisher.html'],
	]) {
		const moved = await boot({page: list, hash});
		assert.equal(moved.ctx.location.replaced, page + hash, list + hash);
		const stays = await boot({page: list});
		assert.equal(stays.ctx.location.replaced, null, list);
		const bare = await boot({page});
		assert.equal(bare.ctx.location.replaced, list, page);
	}
	// typed into the list's address
	const {ctx, fire} = await boot({page: 'authors.html'});
	ctx.location.hash = '#a=Priya+Ostrander';
	fire('hashchange');
	assert.equal(ctx.location.replaced, 'author.html#a=Priya+Ostrander');
});
test("an author's page shows their bio, their links, and their series and titles from the catalog", async () => {
	const {ctx, els, fire, readable} = await boot({page: 'author.html', hash: '#a=Marisol+Quenby'});
	const html = readable(els.creditBody.innerHTML);
	assert.equal(ctx.document.title, 'Marisol Quenby · Audiobook Catalog');
	assert.match(els.crumb.innerHTML, /<a href="authors\.html">← All authors<\/a>/);
	assert.match(html, /<h2 class="author-name">Marisol Quenby<\/h2>/);
	assert.match(
		html,
		/<div class="author-bio"><p>Marisol Quenby writes seafaring fantasy[^<]*<\/p><p>The Lantern Coast began/,
	);
	for (const [label, url] of [
		['Website', 'https://example.com/'],
		['Audible', 'https://www.audible.com/author/'],
		['Goodreads', 'https://www.goodreads.com/author/show/'],
		['Hardcover', 'https://hardcover.app/authors/'],
	]) {
		assert.match(
			html,
			new RegExp(
				`<a class="authorlink" href="${url.replace(/[./]/g, '\\$&')}[^"]*" target="_blank" rel="noopener">${label} ↗</a>`,
			),
		);
	}
	// the series, with how many are owned of the released total, its books in order, each a link to it in the catalog
	assert.match(
		html,
		/<a href="index\.html#series=The\+Lantern\+Coast">The Lantern Coast<\/a> <span class="n">4 owned of 5<\/span> <span class="status ongoing">ongoing<\/span>/,
	);
	assert.match(
		html,
		/#1<\/span> <a href="book\.html#book=The\+Salt\+Road">The Salt Road<\/a><\/li><li>.*#2<\/span> <a href="book\.html#book=Beacons\+at\+Low\+Tide">/,
	);
	assert.equal(els.subtitle.textContent, '4 audiobooks in 1 series');
	// and the numbers none of her books has
	assert.match(html, /<\/p><p class="series-note">missing #\d+<\/p><ul class="author-books">/);

	// another author's page, by its address: her series, and a book outside it she wrote with someone else
	ctx.location.hash = '#a=Priya+Ostrander';
	fire('hashchange');
	await idle();
	const priya = readable(els.creditBody.innerHTML);
	assert.match(
		priya,
		/Halloway &amp; Finch<\/a> <span class="n">2 owned of 2<\/span> <span class="status complete">/,
	);
	assert.match(priya, /Outside a series <span class="n">1 book<\/span>/);
	assert.doesNotMatch(priya, /series-note/, 'none missing');
	assert.match(
		priya,
		/Nine Ways to Lose a Kingdom<\/a> <span class="with">with <a href="#a=Ferran\+Doyle">Ferran Doyle<\/a><\/span>/,
	);
	assert.equal(els.subtitle.textContent, '3 audiobooks in 1 series and 1 outside a series');

	// an author without info or series
	ctx.location.hash = '#a=Odalys+Rennick';
	fire('hashchange');
	await idle();
	assert.match(readable(els.creditBody.innerHTML), /No bio or links yet/);
	assert.match(readable(els.creditBody.innerHTML), /Titles <span class="n">1 book<\/span>/);
	ctx.location.hash = '#a=Nobody+Here';
	fire('hashchange');
	await idle();
	assert.equal(els.subtitle.textContent, 'No books by this author in the catalog.');
	assert.equal(ctx.document.title, 'Nobody Here · Audiobook Catalog', 'named, though no book has them');
	assert.match(els.creditBody.innerHTML, /<h2 class="author-name">Nobody Here<\/h2>/);
	// an address naming no one goes to the list
	ctx.location.hash = '';
	fire('hashchange');
	await idle();
	assert.equal(ctx.location.replaced, 'authors.html');
});
// ------------------------------------------------------------------ the narrators and publishers pages
test('the narrators page lists every narrator of the editions, with their bio or the authors they read, and a search narrows it', async () => {
	const {ctx, els, readable} = await boot({page: 'narrators.html'});
	const narrators = new Set(demoBooks.flatMap(b => (b.e || []).flatMap((ed: any) => ed.n || [])));
	assert.equal(ctx.document.title, 'Narrators · Audiobook Catalog');
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, narrators.size);
	assert.match(
		els.subtitle.textContent,
		new RegExp(`^${narrators.size} narrators across ${demoBooks.length} audiobooks`),
	);
	assert.match(
		readable(els.creditBody.innerHTML),
		/<a class="srow-title" href="narrator\.html#n=Ingrid\+Voss">Ingrid Voss<\/a>\s*<span class="srow-owned">4 books \+ 1 box set, 1 series<\/span><\/div><p class="srow-note">Ingrid Voss narrates fantasy/,
		'the first line of a bio, when there is one',
	);
	// else the authors they read most, the most first
	assert.match(
		readable(els.creditBody.innerHTML),
		/Dana Whitlock<\/a>\s*<span class="srow-owned">2 books, 1 series<\/span><\/div><p class="srow-note">Books by Priya Ostrander<\/p>/,
	);
	els.q.value = 'tobias';
	els.q.listeners.input[0]();
	await idle();
	assert.equal((readable(els.creditBody.innerHTML).match(/class="srow-title"/g) || []).length, 1);
	els.q.value = 'zzzz';
	els.q.listeners.input[0]();
	await idle();
	assert.match(readable(els.creditBody.innerHTML), /No narrators match/);
});
test("a narrator's page shows the series and titles they read, with their authors and the other narrators", async () => {
	const books = JSON.stringify([
		{t: 'Tide One', a: ['Ann Vale'], s: 'Tide Saga', sn: '1', e: [{n: ['Cy Hale', 'Di Moss']}]},
		{t: 'Tide Two', a: ['Ann Vale'], s: 'Tide Saga', sn: '2', e: [{n: ['Cy Hale']}, {n: ['Ed Lund']}]},
		{t: 'Apple Hill', a: ['Bo Reed', 'Ann Vale'], e: [{n: ['Cy Hale'], p: 'Gull Audio'}]},
	]);
	const {ctx, els, fire, readable} = await boot({
		page: 'narrator.html',
		hash: '#n=Cy+Hale',
		files: {'books.json': books},
	});
	const html = readable(els.creditBody.innerHTML);
	assert.equal(ctx.document.title, 'Cy Hale · Audiobook Catalog');
	assert.match(els.crumb.innerHTML, /<a href="narrators\.html">← All narrators<\/a>/);
	assert.equal(els.subtitle.textContent, '3 audiobooks in 1 series and 1 outside a series');
	assert.match(html, /<h2 class="author-name">Cy Hale<\/h2>/);
	assert.match(html, /<a href="index\.html#series=Tide\+Saga">Tide Saga<\/a> <span class="n">2 books<\/span>/);
	// who else reads the editions Cy Hale reads, not the other editions
	assert.match(
		html,
		/Tide One<\/a> <span class="with">by <a href="author\.html#a=Ann\+Vale">Ann Vale<\/a><\/span> <span class="with">with <a href="#n=Di\+Moss">Di Moss<\/a><\/span><\/li>/,
	);
	assert.match(html, /Tide Two<\/a> <span class="with">by <a [^>]*>Ann Vale<\/a><\/span><\/li>/);
	assert.match(
		html,
		/Outside a series <span class="n">1 book<\/span>.*Apple Hill<\/a> <span class="with">by <a [^>]*>Bo Reed<\/a>, <a [^>]*>Ann Vale<\/a>/,
	);
	ctx.location.hash = '#n=Nobody+Here';
	fire('hashchange');
	await idle();
	assert.equal(els.subtitle.textContent, 'No books narrated by them in the catalog.');
	// an address naming no one goes to the list
	ctx.location.hash = '';
	fire('hashchange');
	await idle();
	assert.equal(ctx.location.replaced, 'narrators.html');
});
test("the publishers page lists the editions' publishers, and a publisher's page their books", async () => {
	const {ctx, els, readable, storage} = await boot({page: 'publishers.html'});
	assert.equal(ctx.document.title, 'Publishers · Audiobook Catalog');
	assert.match(els.subtitle.textContent, new RegExp(`^3 publishers across ${demoBooks.length} audiobooks`));
	assert.match(
		readable(els.creditBody.innerHTML),
		/<a class="srow-title" href="publisher\.html#p=Kestrel\+Row\+Audio">Kestrel Row Audio<\/a>\s*<span class="srow-owned">2 books \+ 1 box set, 1 series<\/span>/,
	);
	const pub = await boot({page: 'publisher.html', hash: '#p=Kestrel+Row+Audio', storage, files: null});
	await idle();
	assert.equal(pub.ctx.document.title, 'Kestrel Row Audio · Audiobook Catalog');
	// the box set kept beside its titles is counted apart from them
	assert.equal(pub.els.subtitle.textContent, '2 audiobooks in 1 series, and 1 box set');
	assert.match(
		pub.readable(pub.els.creditBody.innerHTML),
		/The Orchard Cycle<\/a> <span class="n">2 books \+ 1 box set<\/span>/,
	);
	assert.doesNotMatch(
		pub.readable(pub.els.creditBody.innerHTML),
		/class="with">with/,
		"a publisher's page names no other publishers",
	);
});
test('a book published by two publishers together is on both their pages, and its Edit page names both', async () => {
	const mine = [
		{
			t: 'Apple Hill',
			a: ['Ann Vale'],
			e: [{ext: {'audible.com': 'B0APPLEHL1'}, p: ['Gull Audio', 'Tern & Pike Press']}],
		},
		{t: 'Brine Tide', a: ['Ann Vale'], e: [{p: ['Tern & Pike Press']}]},
	];
	const {els, readable, storage} = await boot({page: 'publishers.html', files: {'books.json': JSON.stringify(mine)}});
	assert.match(els.subtitle.textContent, /^2 publishers across 2 audiobooks/);
	assert.match(
		readable(els.creditBody.innerHTML),
		/<a class="srow-title" href="publisher\.html#p=[^"]+">Gull Audio<\/a>\s*<span class="srow-owned">1 book<\/span>/,
	);
	assert.match(
		readable(els.creditBody.innerHTML),
		/<a class="srow-title" href="publisher\.html#p=[^"]+">Tern &amp; Pike Press<\/a>\s*<span class="srow-owned">2 books<\/span>/,
	);
	for (const [name, count] of [
		['Gull Audio', '1 audiobook'],
		['Tern & Pike Press', '2 audiobooks'],
	]) {
		const pub = await boot({page: 'publisher.html', hash: '#p=' + encodeURIComponent(name), storage, files: null});
		await idle();
		assert.equal(pub.els.subtitle.textContent, count);
		assert.match(pub.readable(pub.els.creditBody.innerHTML), /Apple Hill/);
	}
	const page = await bootBook('Apple Hill', {storage, files: null});
	assert.match(
		page.readable(page.els.results.innerHTML),
		/<dt>Publishers<\/dt><dd><a href="publisher\.html#p=[^"]+">Gull Audio<\/a>, <a href="publisher\.html#p=[^"]+">Tern &amp; Pike Press<\/a><\/dd>/,
	);
	const edit = await bootEditBook('Apple Hill', {storage, files: null});
	assert.equal(edit.els.b0e0_p.value, 'Gull Audio, Tern & Pike Press');
	// taking one off saves the other alone
	typeIn(edit.els, 'b0e0_p', 'Tern & Pike Press');
	assert.equal(await saveEdit(edit), true);
	assert.deepEqual((await kept(storage)).books[0].e[0].p, ['Tern & Pike Press']);
});
test('the narrators on a book card, and the publishers in its details, link to their pages', async () => {
	const {els, readable, storage} = await boot({page: 'books.html'});
	assert.match(readable(els.results.innerHTML), /narr\. <a href="narrator\.html#n=Ingrid\+Voss">Ingrid Voss<\/a>/);
	const book = await bootBook('The Copper Graft', {storage});
	assert.match(
		book.readable(book.els.results.innerHTML),
		/<dt>Publisher<\/dt><dd><a href="publisher\.html#p=Kestrel\+Row\+Audio">Kestrel Row Audio<\/a><\/dd>/,
	);
});
test("author info can be added, edited and removed on the author's page, and links are checked", async () => {
	const {els, get, storage} = await boot({page: 'author.html', hash: '#a=Wendell+Ashcombe'});
	const editClick = () => els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	const submit = () => els.creditForm.listeners.submit[0]({preventDefault() {}});
	// Edit comes after their books, not by their name
	assert.match(
		els.creditBody.innerHTML,
		/^<div class="author-head"><h2 class="author-name">Wendell Ashcombe<\/h2><\/div>/,
	);
	assert.match(
		els.creditBody.innerHTML,
		/<\/ul><\/div><div class="page-actions"><button type="button" class="aedit">Edit<\/button><a class="sedit" href="edit\.html#author=id-\d+">Edit their books<\/a><\/div>$/,
	);
	editClick();
	assert.ok(els.creditForm.classList.contains('open'));
	assert.equal(els.creditFormTitle.textContent, 'Edit author: Wendell Ashcombe');
	assert.equal(els.creditRemoveBtn.textContent, 'Remove author');
	els.cf_bio.value = '  Builds   clockwork worlds.\n\nLives by a canal. ';
	els.cf_url.value = 'wendell.example';
	submit();
	assert.match(els.creditFormError.textContent, /'url' must be a web address/);
	els.cf_url.value = 'https://wendell.example/';
	els.cf_ext_goodreads.value = 'https://hardcover.app/authors/wendell'; // pasted into the wrong field
	submit();
	assert.equal(
		els.creditFormError.textContent,
		'Not an id or address there: Goodreads: https://hardcover.app/authors/wendell.',
	);
	assert.equal(get("CATALOG.infoByName('authors').get('Wendell Ashcombe') || null"), null);
	els.cf_ext_goodreads.value = '';
	// an address gives the id; an Audible address names its site
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/wendell';
	els.cf_ext_audible.value = 'https://www.audible.co.uk/author/Wendell-Ashcombe/B0WENDELL1?ref=x';
	await submit();
	assert.ok(!els.creditForm.classList.contains('open'));
	const entry = {
		bio: 'Builds clockwork worlds.\n\nLives by a canal.',
		url: 'https://wendell.example/',
		ext: {'audible.co.uk': 'B0WENDELL1', hardcover: 'wendell'},
	};
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe')"), entry);
	assert.match(els.creditBody.innerHTML, /<p>Builds clockwork worlds\.<\/p><p>Lives by a canal\.<\/p>/);
	assert.match(
		els.creditBody.innerHTML,
		/<a class="authorlink" href="https:\/\/www\.audible\.co\.uk\/author\/B0WENDELL1" target="_blank" rel="noopener">Audible \(audible\.co\.uk\) ↗<\/a> <a class="authorlink" href="https:\/\/hardcover\.app\/authors\/wendell" target="_blank" rel="noopener">Hardcover ↗<\/a>/,
	);
	assert.match(
		els.ioStatus.textContent,
		/^Saved Wendell Ashcombe\. Kept Hardcover's author by the name in its address/,
	);
	// kept in this browser, and loaded again with the page
	assert.deepEqual((await kept(storage)).authors['Wendell Ashcombe'], entry);
	const again = await boot({page: 'author.html', hash: '#a=Wendell+Ashcombe', storage});
	assert.deepEqual(again.get("CATALOG.infoByName('authors').get('Wendell Ashcombe')"), entry);

	// editing shows what is there; emptying every field keeps nothing about them, and they stay
	editClick();
	assert.equal(els.creditFormTitle.textContent, 'Edit author: Wendell Ashcombe');
	assert.equal(els.cf_ext_hardcover.value, 'wendell');
	assert.equal(
		els.cf_ext_audible.value,
		'https://www.audible.co.uk/author/B0WENDELL1',
		'the address, so the site is kept',
	);
	for (const field of [els.cf_bio, els.cf_url, els.cf_ext_hardcover, els.cf_ext_audible]) field.value = '';
	await submit();
	await idle();
	assert.equal(get("CATALOG.infoByName('authors').get('Wendell Ashcombe') || null"), null);
	assert.equal(els.ioStatus.textContent, 'Saved Wendell Ashcombe.');
	assert.ok((await kept(storage)).authors['Marisol Quenby'], 'the other authors keep theirs');
	assert.ok(
		databaseOf(storage)
			.records('contributors')
			.some(c => c.name === 'Wendell Ashcombe'),
	);

	// an author can't be removed while a book has no other
	editClick();
	els.creditRemoveBtn.listeners.click[0]();
	assert.match(
		els.creditFormError.textContent,
		/^Wendell Ashcombe is the only author of \d+ books? \(.*\): give (them|it) another author first, or remove (them|it)\.$/,
	);
	assert.ok(get("CATALOG.books.some(b => b.authors.includes('Wendell Ashcombe'))"));
});
test("a Hardcover address in the series or info form is looked up for its number, and kept as it is when Hardcover can't be asked", async () => {
	const hc = fakeHardcover(hardcoverState());
	const setTimeout = (fn: () => unknown, ms: number) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	}; // the pause between requests
	const storage = new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const {els, get} = await boot({
		page: 'author.html',
		hash: '#a=Wendell+Ashcombe',
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	const edit = () => els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	const submit = () => els.creditForm.listeners.submit[0]({preventDefault() {}});
	edit();
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/wendell-ashcombe/books';
	await submit();
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), {hardcover: '4101'});
	assert.equal(
		els.ioStatus.textContent,
		'Saved Wendell Ashcombe. Found on Hardcover: Wendell Ashcombe (author 4101).',
	);
	assert.match(
		els.creditBody.innerHTML,
		/<a class="authorlink" href="https:\/\/hardcover\.app\/id\/author\/4101" target="_blank" rel="noopener">Hardcover ↗<\/a>/,
	);
	assert.deepEqual(hc.sent.at(-1)!.variables, {slug: 'wendell-ashcombe'});

	// as soon as the field is left; one merged into another is that one
	edit();
	els.cf_ext_hardcover.value = 'w-ashcombe';
	await els.cf_ext_hardcover.listeners.change[0]();
	await idle();
	assert.equal(els.cf_ext_hardcover.value, '4101');
	// the address becomes the name in it when the field is left, and then the number Hardcover gives
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/wendell-ashcombe';
	const looking = els.cf_ext_hardcover.listeners.change[0]();
	els.cf_ext_hardcover.dispatch('focusout');
	assert.equal(els.cf_ext_hardcover.value, 'wendell-ashcombe');
	await looking;
	await idle();
	assert.equal(els.cf_ext_hardcover.value, '4101');
	// a number, or an address by number, is not looked up
	const asked = hc.sent.length;
	els.cf_ext_hardcover.value = 'https://hardcover.app/id/authors/4102';
	await submit();
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), {hardcover: '4102'});
	assert.equal(hc.sent.length, asked);

	// a name Hardcover has no page for is refused
	edit();
	els.cf_ext_hardcover.value = 'https://hardcover.app/authors/nobody-here';
	await submit();
	assert.equal(
		els.creditFormError.textContent,
		'Hardcover has no author at https://hardcover.app/authors/nobody-here.',
	);
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), {hardcover: '4102'});
	// when Hardcover can't be asked, the name in the address is kept, and still links to its page
	storage.set('audiobook-catalog-hardcover-token', 'expired');
	await submit();
	assert.deepEqual(get("CATALOG.infoByName('authors').get('Wendell Ashcombe').external"), {hardcover: 'nobody-here'});
	assert.match(
		els.ioStatus.textContent,
		/Kept Hardcover's author by the name in its address, as Hardcover couldn't be asked for its id \(Hardcover refused your token/,
	);
	assert.match(els.creditBody.innerHTML, /href="https:\/\/hardcover\.app\/authors\/nobody-here"/);

	// a series' and a publisher's likewise
	storage.set('audiobook-catalog-hardcover-token', 'tok-123');
	const index = await bootEdit('The Lantern Coast', {hardcover: hc.fetch, setTimeout, storage});
	index.els.sf_ext_hardcover.value = 'hardcover.app/series/the-lantern-coast';
	assert.ok(await saveEdit(index));
	assert.equal(index.get("CATALOG.infoByName('series').get('The Lantern Coast').external.hardcover"), '3101');
	const pub = await boot({
		page: 'publisher.html',
		hash: '#p=Kestrel+Row+Audio',
		hardcover: hc.fetch,
		setTimeout,
		storage,
	});
	pub.els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	await idle();
	assert.equal(
		pub.els.cf_ext_hardcover.value,
		'kestrel-row-audio-sample',
		'a name kept before stays until the form is saved',
	);
	pub.els.cf_ext_hardcover.value = 'kestrel-row-audio';
	await pub.els.creditForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.equal(pub.get("CATALOG.infoByName('publishers').get('Kestrel Row Audio').external.hardcover"), '5101');
});
test('an author can be renamed from their form, on every book, keeping their id; a narrator renamed to another joins them', async () => {
	const {ctx, els, get, storage} = await boot({page: 'author.html', hash: '#a=Wendell+Ashcombe'});
	const submit = () => els.creditForm.listeners.submit[0]({preventDefault() {}});
	const count = demoBooks.filter(b => b.a.includes('Wendell Ashcombe')).length;
	await kept(storage);
	const authorId = databaseOf(storage)
		.records('contributors')
		.find(c => c.name === 'Wendell Ashcombe').id;
	els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	assert.equal(els.cf_name.value, 'Wendell Ashcombe');
	// an author's name can't be read as several
	els.cf_name.value = 'Ashcombe, Wendell';
	await submit();
	assert.match(els.creditFormError.textContent, /would be read as several authors/);
	els.cf_name.value = '   ';
	await submit();
	assert.equal(els.creditFormError.textContent, 'Give the author a name.');
	els.cf_name.value = '  Wendell  P. Ashcombe ';
	await submit();
	await idle();
	assert.ok(!els.creditForm.classList.contains('open'));
	assert.equal(els.ioStatus.textContent, `Renamed Wendell Ashcombe to Wendell P. Ashcombe on ${count} books.`);
	assert.equal(ctx.location.hash, `#a=${authorId}`, 'the address names them by id, not by the old name');
	assert.match(els.creditBody.innerHTML, /<h2 class="author-name">Wendell P\. Ashcombe<\/h2>/);
	const saved = await kept(storage);
	assert.equal(saved.books.filter((b: any) => b.a.includes('Wendell P. Ashcombe')).length, count);
	assert.ok(!saved.books.some((b: any) => b.a.includes('Wendell Ashcombe')));
	assert.deepEqual(
		databaseOf(storage)
			.records('contributors')
			.filter(c => c.name === 'Wendell P. Ashcombe')
			.map(c => c.id),
		[authorId],
	);

	// renaming a narrator to one the catalog has takes a second Save, and joins them
	// a box set is counted apart from the books
	const both = demoBooks.filter(
		b =>
			!/^\d+-\d+$/.test(b.sn || '') &&
			(b.e || []).some((ed: any) =>
				(ed.n || []).some((n: string) => n === 'Dana Whitlock' || n === 'Ingrid Voss'),
			),
	).length;
	const narrator = await boot({page: 'narrator.html', hash: '#n=Dana+Whitlock', storage});
	const ingrid = databaseOf(storage)
		.records('contributors')
		.find(c => c.name === 'Ingrid Voss').id;
	narrator.els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	narrator.els.cf_name.value = 'Ingrid Voss';
	narrator.els.cf_bio.value = 'Reads everything.';
	await narrator.els.creditForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.ok(narrator.els.creditForm.classList.contains('open'));
	assert.match(
		narrator.els.creditFormError.textContent,
		/^There is already a narrator called Ingrid Voss\. Press Save again to join them/,
	);
	assert.ok(narrator.get("CATALOG.books.some(b => b.editions.some(ed => ed.narrators.includes('Dana Whitlock')))"));
	await narrator.els.creditForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.ok(!narrator.els.creditForm.classList.contains('open'));
	assert.equal(narrator.ctx.location.hash, `#n=${ingrid}`);
	// what the form has wins; what Ingrid Voss had fills in the rest
	assert.deepEqual(narrator.get("CATALOG.infoByName('narrators').get('Ingrid Voss')"), {
		bio: 'Reads everything.',
		url: 'https://example.com/',
		ext: {hardcover: 'ingrid-voss-sample'},
	});
	assert.match(narrator.els.subtitle.textContent, new RegExp(`^${both} audiobooks`));
	const joined = await kept(storage);
	assert.ok(!joined.books.some((b: any) => (b.e || []).some((ed: any) => (ed.n || []).includes('Dana Whitlock'))));
	assert.deepEqual(
		databaseOf(storage)
			.records('contributors')
			.filter(c => c.name === 'Ingrid Voss')
			.map(c => c.id),
		[ingrid],
	);
	assert.ok(
		!databaseOf(storage)
			.records('contributors')
			.some(c => c.name === 'Dana Whitlock'),
	);
	assert.equal(get('SHOWN'), authorId);
});
test('a narrator or publisher can be edited on their page, with links checked, and removed from their books', async () => {
	const {els, get, storage} = await boot({page: 'narrator.html', hash: '#n=Tobias+Frane'});
	const submit = () => els.creditForm.listeners.submit[0]({preventDefault() {}});
	assert.match(els.creditBody.innerHTML, /No bio or links yet/);
	els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	await idle();
	assert.equal(els.creditFormTitle.textContent, 'Edit narrator: Tobias Frane');
	assert.equal(els.creditSaveBtn.textContent, 'Save narrator');
	els.cf_bio.value = 'Reads sea stories.';
	els.cf_ext_audible.value = 'https://www.goodreads.com/author/show/1.Tobias';
	submit();
	assert.match(els.creditFormError.textContent, /Not an id or address there: Audible: https:\/\/www\.goodreads\.com/);
	els.cf_ext_audible.value = 'https://www.audible.com/search?searchNarrator=Tobias+Frane';
	submit();
	assert.deepEqual(get("CATALOG.infoByName('narrators').get('Tobias Frane')"), {
		bio: 'Reads sea stories.',
		ext: {'audible.com': 'Tobias Frane'},
	});
	assert.deepEqual((await kept(storage)).narrators['Tobias Frane'], {
		bio: 'Reads sea stories.',
		ext: {'audible.com': 'Tobias Frane'},
	});
	assert.match(
		els.creditBody.innerHTML,
		/<div class="author-bio"><p>Reads sea stories\.<\/p><\/div><p class="author-links"><a class="authorlink" href="https:\/\/www\.audible\.com\/search\?searchNarrator=Tobias%20Frane" target="_blank" rel="noopener">Audible ↗<\/a><\/p>/,
	);
	assert.equal(els.ioStatus.textContent, 'Saved Tobias Frane.');

	// Remove narrator warns first, then takes them off the editions they read
	const read = demoBooks.filter(b => (b.e || []).some((ed: any) => (ed.n || []).includes('Tobias Frane'))).length;
	assert.ok(read > 0);
	els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	await idle();
	els.creditRemoveBtn.listeners.click[0]();
	assert.equal(
		els.creditFormError.textContent,
		`This takes Tobias Frane off ${read} book${read > 1 ? 's' : ''}' editions, which stay in the catalog, and removes them. Press Remove narrator again to do it.`,
	);
	els.creditRemoveBtn.listeners.click[0]();
	await idle();
	assert.equal(els.ioStatus.textContent, `Removed Tobias Frane from ${read} book${read > 1 ? 's' : ''}.`);
	assert.match(els.creditBody.innerHTML, /Tobias Frane was removed\. <a href="narrators\.html">All narrators<\/a>/);
	const saved = await kept(storage);
	assert.equal(saved.books.length, demoBooks.length);
	assert.ok(!saved.books.some((b: any) => (b.e || []).some((ed: any) => (ed.n || []).includes('Tobias Frane'))));
	assert.equal('Tobias Frane' in saved.narrators, false);
	assert.ok(
		!databaseOf(storage)
			.records('contributors')
			.some(c => c.name === 'Tobias Frane'),
	);

	// a publisher's page shows what the demo data keeps about it
	const pub = await boot({page: 'publisher.html', hash: '#p=Kestrel+Row+Audio'});
	assert.match(pub.els.creditBody.innerHTML, /Kestrel Row Audio is a small audiobook studio/);
	assert.match(
		pub.els.creditBody.innerHTML,
		/<a class="authorlink" href="https:\/\/hardcover\.app\/publishers\/[^"]*" target="_blank" rel="noopener">Hardcover ↗<\/a>/,
	);
	assert.equal(pub.els.cf_ext_hardcover.getAttribute('placeholder'), 'id, or its address on hardcover.app');
	assert.ok(!pub.els.cf_ext.innerHTML.includes('cf_ext_goodreads'), 'Goodreads has no publisher pages');
});
test('Check on the import page lists problems; a catalog in an older format is kept in the current one at once', async () => {
	const mine = JSON.stringify([
		{t: 'Old Favorite', a: 'Ann Vale', id: 'B0OLD00001'},
		{t: 'Far Away', a: 'Ann Vale', s: 'Elsewhere', sn: '1'},
	]);
	const info = JSON.stringify({Nowhere: {total: 3, status: 'ongoing'}, Elsewhere: {status: 'complete'}});
	const {els, storage} = await boot({page: 'import.html', files: {'books.json': mine, 'series-info.json': info}});
	// moving it to IndexedDB wrote it the current way
	assert.deepEqual((await kept(storage)).books, [
		{t: 'Old Favorite', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B0OLD00001'}}]},
		{t: 'Far Away', a: ['Ann Vale'], s: 'Elsewhere', sn: '1'},
	]);
	els.checkBtn.listeners.click[0]();
	await idle();
	const report = els.importPreviewBody.innerHTML;
	assert.equal(els.importPreview.place, 'after checkPanel');
	assert.match(
		report,
		/2 books; 2 series, 1 with a released total; 1 author, 0 narrators, 0 publishers, 0 with a bio or links\./,
	);
	assert.match(report, /No problems found/);
	assert.equal(els.importConfirm.style.display, 'none');
	assert.equal(els.importCancel.textContent, 'Close');
});
test('Box sets on the import page adds a set beside the titles sharing its edition, once confirmed', async () => {
	const set = {ext: {'audible.com': 'B0SET00001'}};
	const mine = JSON.stringify([
		{t: 'Gull Isle', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [set]},
		{t: 'Second Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [set]},
	]);
	const {els, get} = await boot({page: 'import.html', files: {'books.json': mine}});
	els.boxSetsBtn.listeners.click[0]();
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /Gull Isle, Books 1-2 — Ann Vale: 2 titles already here/);
	assert.match(els.importPreviewBody.innerHTML, /New: 1/);
	assert.equal(get('CATALOG.books.length'), 2, 'nothing changes before it is confirmed');
	assert.equal(els.importConfirm.textContent, 'Add 1 book');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books[2]'), {
		t: 'Gull Isle, Books 1-2',
		a: ['Ann Vale'],
		s: 'Gull Isle',
		sn: '1-2',
		e: [set],
	});
	assert.match(els.ioStatus.textContent, /Added 1 book for box sets/);
	els.boxSetsBtn.listeners.click[0]();
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /already kept both as its own book and as its titles/);
	assert.equal(els.importConfirm.style.display, 'none');
});
test('a browser that prefers British English sees "catalogue"; any other sees "catalog", and the data is never respelled', async () => {
	const titled = JSON.stringify([{t: 'The Catalog of Stars', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}]}]);
	for (const page of ALL_PAGES) {
		const {ctx} = await boot({
			page,
			hash: PAGE_HASH[page] || '',
			languages: ['sv-SE', 'en-GB'],
			files: {'books.json': titled},
		});
		await idle();
		assert.match(ctx.document.title, /Audiobook Catalogue$/, page);
		// (the body holds what the page drew too; the Hardcover scope read:catalog is a name, and stays, and so does the book's title)
		assert.ok(
			!/(?<!:)\b[Cc]atalog\b/.test(ctx.document.body.innerHTML.replace(/The Catalog of Stars/g, '')),
			`${page} has no American spelling left`,
		);
		assert.match(ctx.document.body.innerHTML, /<h1>Audiobook Catalogue<\/h1>/, page);
	}
	const uk = await boot({page: 'import.html', languages: ['en-AU'], files: {'books.json': titled}});
	await idle();
	assert.equal(uk.els.subtitle.textContent, '1 audiobooks in the catalogue');
	const app = await boot({page: 'books.html', languages: ['en-GB'], files: {'books.json': titled}});
	await idle();
	assert.match(app.els.results.innerHTML, /The Catalog of Stars/);
	assert.equal(app.ctx.document.title, 'Books · Audiobook Catalogue');
	const book = await boot({
		page: 'book.html',
		hash: '#book=The+Catalog+of+Stars',
		languages: ['en-GB'],
		storage: app.storage,
	});
	assert.equal(book.ctx.document.title, 'The Catalog of Stars — Audiobook Catalogue', 'a title is data');

	const us = await boot({page: 'import.html', languages: ['fr-FR', 'fr'], files: {'books.json': titled}});
	await idle();
	assert.equal(us.els.subtitle.textContent, '1 audiobooks in the catalog');
	assert.match(us.ctx.document.title, /Audiobook Catalog$/);
	assert.match(us.ctx.document.body.innerHTML, /<h1>Audiobook Catalog<\/h1>/);
});
test('the Edit and credit pages respell their notes and confirmations, but never the names in them', async () => {
	const books = JSON.stringify([
		{t: 'Catalog One', a: ['Catalog Vale'], s: 'Catalog Saga', sn: '1', e: [{n: ['Catalog Reed']}]},
		{t: 'Catalog Two', a: ['Catalog Vale'], s: 'Catalog Saga', sn: '2'},
	]);
	const options = {languages: ['en-GB'], files: {'books.json': books}};
	// the note under a names field, and the status after saving
	const edit = await bootEditBook('Catalog One', options);
	edit.els.b0_a.value = 'Catalog Vale, Catalog Wen';
	edit.els.b0_a.dispatch('input');
	assert.equal(edit.els.b0_aNew.textContent, 'New author: Catalog Wen, added to the catalogue when this is saved.');
	typeIn(edit.els, 'b0_a', 'Catalog Vale, Catalog Wen');
	assert.equal(await saveEdit(edit), true);
	assert.match(edit.els.ioStatus.textContent, / New in the catalogue: the author Catalog Wen\.$/);
	// Remove book and Remove series
	const book = await bootEditBook('Catalog Two', {...options, storage: edit.storage});
	book.els.bookRemoveBtn.listeners.click[0]();
	assert.equal(
		book.els.bookFormError.textContent,
		'This takes Catalog Two out of the catalogue, and imports will skip it. Press Remove book again to do it.',
	);
	const series = await bootEdit('Catalog Saga', {...options, storage: edit.storage});
	series.els.seriesRemoveBtn.listeners.click[0]();
	assert.equal(
		series.els.seriesFormError.textContent,
		'This takes Catalog Saga off its 2 books, which stay in the catalogue without a series or a number in it, and removes the series. Press Remove series again to do it.',
	);
	// Remove narrator
	const narrator = await boot({...options, page: 'narrator.html', hash: '#n=Catalog+Reed', storage: edit.storage});
	await idle();
	narrator.els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	await idle();
	narrator.els.creditRemoveBtn.listeners.click[0]();
	assert.equal(
		narrator.els.creditFormError.textContent,
		"This takes Catalog Reed off 1 book' editions, which stay in the catalogue, and removes them. Press Remove narrator again to do it.",
	);
});
test("a module's messages are respelled for a British browser, but the titles in them never are", async () => {
	const mine = JSON.stringify([{t: 'Catalog Notes', a: ['Ann Vale'], r: ['2024-05-01', '2023-01-01']}]);
	const state = hardcoverState();
	// a book on the Read shelf that Hardcover has no author for is skipped, and the comparison says so
	state.books[90] = {id: 90, title: 'Catalog Days', contributions: []};
	state.shelf.push({id: 3, book_id: 90, status_id: 3, user_book_reads: []});
	const hc = fakeHardcover(state);
	const setTimeout = (fn: () => unknown, ms: number) => {
		if (ms === 1000) Promise.resolve().then(fn);
		return 0;
	};
	const {els} = await boot({
		page: 'import.html',
		languages: ['en-GB'],
		files: {'books.json': mine},
		hardcover: hc.fetch,
		setTimeout,
		storage: new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]),
	});
	// Check's warning names the book by its title, as it is
	els.checkBtn.listeners.click[0]();
	await idle();
	assert.match(
		els.importPreviewBody.innerHTML,
		/book #0 \('Catalog Notes'\): dates read \['2024-05-01', '2023-01-01'\] are not in order/,
	);
	assert.doesNotMatch(els.importPreviewBody.innerHTML, /Catalogue Notes/);
	// the comparison's summary is the sync's, and so is its warning, with Hardcover's title in it
	await els.hardcoverCompareBtn.listeners.click[0]();
	await idle();
	const html = els.importPreviewBody.innerHTML;
	assert.match(html, /^<p>2 books on your Hardcover Read shelf \(took 0:00\)<\/p>/);
	assert.match(html, /'Catalog Days': no author on Hardcover, skipped/);
	assert.doesNotMatch(html, /Catalogue Days/);
	assert.match(html, /the same as in this catalogue/, "the page's own text is respelled");
});
// ------------------------------------------------------------------ a page holds only what it shows
const SAGAS = JSON.stringify([
	...['1', '2', '3'].map(n => ({t: `Gull ${n}`, a: ['Ann Vale'], s: 'Gull Isle', sn: n, e: [{n: ['Cy Hale']}]})),
	...['1', '2', '3', '4', '5'].map(n => ({t: `Fern ${n}`, a: ['Bo Reed'], s: 'Fern Saga', sn: n})),
]);
// A browser that has the catalog in IndexedDB already, and a page booted on it that has read nothing yet.
async function movedIn(files: any, options = {}) {
	const storage = new Map<string, string>();
	await boot({storage, files});
	await kept(storage);
	databaseOf(storage).resetReads();
	return boot({storage, files: null, ...options});
}
test('the series overview reads no book, and a series page only the books of that series', async () => {
	const {ctx, get, database} = await movedIn({'books.json': SAGAS});
	await idle();
	assert.match(ctx.document.getElementById('results').innerHTML, /Gull Isle/);
	assert.equal(database.reads('books'), 0, 'the overview is drawn from the series records');
	assert.equal(get('CATALOG.books.length'), 0);
	ctx.openSeries(seriesIdOf(get, 'Gull Isle'));
	await idle();
	assert.equal(database.reads('books'), 3);
	assert.deepEqual(get('CATALOG.books.map(b => b.title)'), ['Gull 1', 'Gull 2', 'Gull 3']);
});
test('links to authors, narrators and publishers carry the id they are stored under, from pages that hold no book', async () => {
	const books = JSON.stringify([
		...['1', '2'].map(n => ({
			t: `Gull ${n}`,
			a: ['Ann Vale', 'Di Moss'],
			s: 'Gull Isle',
			sn: n,
			e: [{n: ['Cy Hale'], p: 'Tern Press'}],
		})),
		{t: 'Fern 1', a: ['Bo Reed'], s: 'Fern Saga', sn: '1'},
	]);
	// read as they are, not with readable(): it names an id the page made up as well
	const linked = (html: string, key: string) =>
		[...html.matchAll(new RegExp(`#${key}=([^"&]+)">([^<]+)</a>`, 'g'))].map(([, id, name]) => [
			decodeURIComponent(id),
			name,
		]);
	const overview = await movedIn({'books.json': books});
	await idle();
	const stored = (kind: string) =>
		overview.database
			.records('contributors')
			.filter(c => c.kind === kind)
			.map(c => [c.id, c.name]);
	assert.deepEqual(
		linked(overview.els.results.innerHTML, 'a').sort(),
		stored('author').sort(),
		'the series overview',
	);
	for (const [page, key, kind] of [
		['authors.html', 'a', 'author'],
		['narrators.html', 'n', 'narrator'],
		['publishers.html', 'p', 'publisher'],
	]) {
		const {els} = await boot({page, storage: overview.storage, files: null});
		await idle();
		assert.deepEqual(linked(els.creditBody.innerHTML, key).sort(), stored(kind).sort(), page);
	}
});
test('all books shows 50 at a time, and Show more reads the next ones', async () => {
	const books = Array.from({length: 60}, (_, i) => ({
		t: `Pebble ${String(i + 1).padStart(2, '0')}`,
		a: ['Ann Vale'],
	}));
	const {els, get, database} = await movedIn({'books.json': JSON.stringify(books)}, {page: 'books.html'});
	await idle();
	assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 50);
	assert.equal(els.resultCount.textContent, '50 of 60 shown');
	assert.equal(get('CATALOG.books.length'), 50, 'the page holds only the books it shows');
	assert.equal(database.reads('books'), 50);
	const more = els.results.querySelector('#showMore')!;
	assert.equal(more.textContent, 'Show 10 more');
	more.dispatch('click');
	await idle();
	assert.equal((els.results.innerHTML.match(/class="book"/g) || []).length, 60);
	assert.equal(els.resultCount.textContent, '60 shown');
	assert.equal(els.results.querySelector('#showMore'), null);
	assert.equal(database.reads('books'), 60, 'only the books not read yet');
});
test('an edit on a page that holds some books keeps every other record, and the counts follow', async () => {
	const {ctx, els, storage, database} = await movedIn(
		{'books.json': SAGAS},
		{page: 'edit.html', hash: '#book=Gull+3'},
	);
	await idle();
	await ctx.ASKING;
	assert.equal(database.reads('books'), 2, 'only the book shown (found by the title in the address, then read)');
	els.b0_s.value = 'Fern Saga';
	typeIn(els, 'b0_sn', '6');
	assert.equal(await saveEdit({els}), true);
	const books = (await kept(storage)).books;
	assert.equal(books.length, 8);
	assert.deepEqual(
		books.find((b: any) => b.t === 'Fern 4'),
		{t: 'Fern 4', a: ['Bo Reed'], s: 'Fern Saga', sn: '4'},
		'a book the page never read',
	);
	assert.deepEqual(books.find((b: any) => b.t === 'Gull 3').s, 'Fern Saga');
	const count = (store: any) =>
		Object.fromEntries(database.records(store).map(x => [x.name, [x.bookCount, x.seriesCount]]));
	assert.deepEqual(count('series'), {'Fern Saga': [6, undefined], 'Gull Isle': [2, undefined]});
	assert.deepEqual(count('contributors'), {'Ann Vale': [3, 2], 'Bo Reed': [5, 1], 'Cy Hale': [3, 2]});
	assert.equal(database.records('credits').length, 8 + 3);

	// a series whose last books are removed stays, as an entry of its own
	for (const title of ['Gull 1', 'Gull 2']) await removeBook(title, {storage, files: null});
	assert.deepEqual(count('series'), {'Fern Saga': [6, undefined], 'Gull Isle': [0, undefined]});
	assert.deepEqual(count('contributors'), {'Ann Vale': [1, 1], 'Bo Reed': [5, 1], 'Cy Hale': [1, 1]});
	assert.equal((await kept(storage)).books.length, 6);
});
test('the Duplicates count is kept with the revision it was counted at, and counted again once the catalog changed', async () => {
	const books = JSON.stringify([
		{t: 'Ledger', a: ['Priya Ostrander']},
		{t: 'Ledger', a: ['Priya Ostrander'], r: ['2024']},
		{t: 'Other', a: ['Ann Vale']},
	]);
	const {els, run, storage, database} = await movedIn({'books.json': books});
	await idle();
	assert.equal(els.dupCount.textContent, ' (1)');
	assert.equal(database.reads('books'), 0, 'the count kept is shown without reading the books');
	const revision = () => database.records('meta').find(m => m.key === 'revision').value;
	assert.equal(database.records('meta').find(m => m.key === 'duplicates').revision, revision());

	// a page holding the whole catalog keeps the count with each save; one that holds some counts it after
	const dup = await boot({page: 'duplicates.html', storage});
	await dup.run("CATALOG.books.push(new Book({ title: 'Other', authors: ['Ann Vale'] })); persist();");
	assert.deepEqual(
		database.records('meta').find(m => m.key === 'duplicates'),
		{key: 'duplicates', value: 2, revision: revision()},
	);
	await run('updateNav()');
	await idle();
	assert.equal(els.dupCount.textContent, ' (2)');
	// a page that holds some books counts again after its save, reading every book, and keeps the count
	const home = await boot({page: 'books.html', storage});
	database.resetReads();
	await home.run(
		"CATALOG.books.push(new Book({ title: 'Ledger', authors: ['Ann Vale'] }), new Book({ title: 'Ledger', authors: ['Ann Vale'] })); persist();",
	);
	await idle();
	assert.equal(home.els.dupCount.textContent, ' (3)');
	assert.ok(database.reads('books') >= 6, 'every book was read to count them');
	assert.deepEqual(
		database.records('meta').find(m => m.key === 'duplicates'),
		{key: 'duplicates', value: 3, revision: revision()},
	);
	database.resetReads();
	const next = await boot({storage});
	await idle();
	assert.equal(next.els.dupCount.textContent, ' (3)');
	assert.equal(database.reads('books'), 0);
});
test("the authors list reads no book, and an author's page only their books", async () => {
	const {els, database, readable, storage} = await movedIn({'books.json': SAGAS}, {page: 'authors.html'});
	await idle();
	assert.match(
		readable(els.creditBody.innerHTML),
		/Ann Vale<\/a>\s*<span class="srow-owned">3 books, 1 series<\/span>/,
	);
	assert.equal(els.subtitle.textContent, '2 authors across 8 audiobooks');
	assert.equal(database.reads('books'), 0);
	const bo = await boot({page: 'author.html', hash: '#a=Bo+Reed', storage, files: null});
	await idle();
	assert.equal(bo.els.subtitle.textContent, '5 audiobooks in 1 series');
	assert.equal(database.reads('books'), 5);
});
test('the stats page counts what the catalog lacks, and lists which ones', async () => {
	const books = [
		{
			t: 'The Tidewright',
			a: ['Ann Vale'],
			s: 'Lantern Coast',
			sn: '1',
			g: ['Fantasy'],
			r: ['2024-03-01'],
			e: [{ext: {'audible.com': 'B0TIDEWRT1'}, n: ['Cy Hale'], p: 'Tern Press', d: '2020-05-01', len: 600}],
		},
		{t: 'Salt and Ember', a: ['Ann Vale'], s: 'Lantern Coast', sn: '2', e: [{isbn: '9780000000002'}]},
	];
	const files = {'books.json': JSON.stringify(books), 'authors.json': JSON.stringify({'Ann Vale': {bio: 'Writes.'}})};
	const {els, get} = await boot({page: 'stats.html', files});
	assert.equal(els.subtitle.textContent, '2 audiobooks, 2 editions');
	const html = els.statsBody.innerHTML;
	const second = get('CATALOG.books[1].id');
	// one of two books has no genres, and the line lists it, linked to its page
	const genres = els['stat-books-genres'].innerHTML;
	assert.match(genres, /No genres<\/span><span class="statCount">1 \(50%\)/);
	assert.ok(genres.includes(`href="book.html#book=${second}"`), genres);
	// a value every one has is a line of its own that opens to nothing
	assert.ok(
		html.includes(
			'<div class="statRow statDone"><span class="statLabel">No editions</span><span class="statCount">none</span></div>',
		),
		html,
	);
	assert.equal(els['stat-authors-bio'], undefined, 'the one author has a bio');
	// the table counts Audible ids, a book by its editions'
	const table = els.statCatalogs.innerHTML;
	assert.match(table, /<th>Audible<\/th><td title="50%">1<\/td><td title="50%">1<\/td>/);
	assert.doesNotMatch(table, /Goodreads/, 'a catalog nothing has an id in is left out');
});
test("the Edit series page edits each book's fields and editions in place, and saves them only after a review", async () => {
	const files = {
		'books.json': JSON.stringify([
			{
				t: 'Fern 1',
				a: ['Bo Reed'],
				s: 'Fern Saga',
				sn: '1',
				e: [
					{ext: {'audible.com': 'B0FERN0001'}, n: ['Cy Hale'], d: '2020-01-01'},
					{isbn: '9780000000002', d: '2021-05-01'},
				],
			},
			{
				t: 'Fern 2',
				a: ['Bo Reed'],
				s: 'Fern Saga',
				sn: '2',
				e: [
					{ext: {'audible.com': 'B0FERN0002'}, d: '2022', desc: 'A storm comes to the fen.'},
					{ext: {'audible.com': 'B0FERN0003'}},
				],
			},
		]),
	};
	const session = new Map<string, string>();
	const edit = await bootEdit('Fern Saga', {files, session});
	const {els, get, storage} = edit;
	assert.deepEqual(get('DRAFTS.map(d => d.book.title)'), ['Fern 1', 'Fern 2']);
	// an edition is told apart by its description, else its narrators, else its ids
	assert.match(els.editBooks.innerHTML, /<span class="editEdName editEdDesc">A storm comes to the fen\.<\/span>/);
	assert.match(els.editBooks.innerHTML, /<span class="editEdName">Narrated by Cy Hale<\/span>/);
	assert.match(els.editBooks.innerHTML, /<span class="editEdName">audible\.com B0FERN0003<\/span>/);

	// typed into a book's and an edition's fields
	els.b0_t.value = 'Fern One';
	els.b0_t.listeners.change[0]();
	els.b0e0_n.value = 'Cy Hale, Ann Vale';
	els.b0e0_n.listeners.change[0]();
	assert.equal(els.changeCount.textContent, '2 changes');
	assert.equal(get('DRAFTS[0].book.editions[0].narrators.join()'), 'Cy Hale,Ann Vale');
	assert.equal(get('CATALOG.book(DRAFTS[0].id).title'), 'Fern 1', 'nothing saved yet');
	// what can't be read is said on the book, and changes nothing
	els.b1_r.value = 'last spring';
	els.b1_r.listeners.change[0]();
	assert.match(els['book-1-error'].textContent, /Not a date: last spring/);
	els.b1_r.value = '';
	els.b1_r.listeners.change[0]();
	assert.equal(els['book-1-error'].textContent, '');

	// an id added to an edition draws the books again, and every card stays open or closed as it was
	els['book-1-ed-1'].setAttribute('open', '');
	els['book-0'].removeAttribute('open');
	els.b1e1_more.value = 'https://www.goodreads.com/book/show/4242';
	els.b1e1_more.listeners.change[0]();
	assert.equal(get('DRAFTS[1].book.editions[1].external.goodreads'), '4242');
	assert.equal(els['b1e1_ext-goodreads'].value, '4242', 'the new id has a field of its own');
	assert.equal(els['book-1-ed-1'].hasAttribute('open'), true, 'the edition stays open');
	assert.equal(els['book-1-ed-0'].hasAttribute('open'), false);
	assert.equal(els['book-0'].hasAttribute('open'), false, 'a book closed stays closed');
	assert.equal(els['book-1'].hasAttribute('open'), true);
	els['book-0'].setAttribute('open', '');
	els['b1e1_ext-goodreads'].value = '';
	els['b1e1_ext-goodreads'].listeners.change[0]();
	assert.equal(get("'goodreads' in DRAFTS[1].book.editions[1].external"), false);
	// a bare id is read as the catalog picked beside it, and needs one
	els.b1e1_more.value = '4343';
	els.b1e1_more.listeners.change[0]();
	assert.match(
		els['book-1-ed-1-error'].textContent,
		/Not an edition's address: 4343\. For a bare id, pick its catalog/,
	);
	els['b1e1_more-catalog'].value = 'goodreads';
	els.b1e1_more.listeners.change[0]();
	assert.equal(els['book-1-ed-1-error'].textContent, '');
	assert.equal(get('DRAFTS[1].book.editions[1].external.goodreads'), '4343');
	assert.equal(els['b1e1_ext-goodreads'].value, '4343');
	els.b1e1_more.value = '4444';
	els['b1e1_more-catalog'].value = 'goodreads';
	els.b1e1_more.listeners.change[0]();
	assert.match(els['book-1-ed-1-error'].textContent, /It has an id on Goodreads already: 4444/);
	els.b1e1_more.value = '';
	els['b1e1_ext-goodreads'].value = '';
	els['b1e1_ext-goodreads'].listeners.change[0]();
	assert.equal(get("'goodreads' in DRAFTS[1].book.editions[1].external"), false);

	// Merge with…: the two editions of Fern 1 become one
	els['book-0-ed-0-merge'].listeners.click[0]();
	els['book-0-ed-0-merge-1'].listeners.click[0]();
	assert.equal(get('DRAFTS[0].book.editions.length'), 1);
	assert.equal(get('DRAFTS[0].book.editions[0].isbn'), '9780000000002');
	// Split: the ISBN goes to an edition of its own again, the narrators are on both
	els['book-0-ed-0-split'].listeners.click[0]();
	els['book-0-ed-0-split-isbn'].value = 'move';
	els['book-0-ed-0-split-n'].value = 'copy';
	els['book-0-ed-0-split-do'].listeners.click[0]();
	assert.deepEqual(get('DRAFTS[0].book.editions.map(ed => ed.format())'), [
		'Narrated by Cy Hale, Ann Vale; ASIN audible.com B0FERN0001; Released 2020-01-01',
		'Narrated by Cy Hale, Ann Vale; ISBN 9780000000002',
	]);
	// Remove edition, kept out of imports
	els['book-1-ed-1-remove'].listeners.click[0]();
	els['book-1-ed-1-exclude'].checked = true;
	els['book-1-ed-1-remove-do'].listeners.click[0]();
	assert.equal(get('DRAFTS[1].book.editions.length'), 1);
	assert.deepEqual(get('EXCLUDE'), ['Edition B0FERN0003']);

	// an edition's field that can't be read stops Review & save, which scrolls to it
	els.b1e0_more.value = 'not an address';
	els.b1e0_more.listeners.change[0]();
	await els.reviewBtn.listeners.click[0]();
	await idle();
	assert.equal(els.reviewPanel.classList.contains('open'), false);
	assert.match(els['book-1-ed-0-error'].textContent, /Not an edition's address: not an address/);
	assert.equal(els['book-1-ed-0-error'].scrolledTo, true);
	els.b1e0_more.value = '';
	els.b1e0_more.listeners.change[0]();

	// Review & save lists it all, and the fields can't change while it is open, so Save saves what it lists
	await els.reviewBtn.listeners.click[0]();
	await idle();
	for (const part of ['seriesPanel', 'editBooks', 'saveBar']) assert.ok(els[part].hasAttribute('inert'), part);
	els.reviewBackBtn.listeners.click[0]();
	assert.equal(els.editBooks.hasAttribute('inert'), false, 'Back edits again');
	await els.reviewBtn.listeners.click[0]();
	await idle();
	const review = els.reviewList.textContent;
	assert.match(review, /Fern One: Title: Fern 1 → Fern One/);
	assert.match(review, /Edition Narrated by Cy Hale: Narrators: Cy Hale → Cy Hale, Ann Vale/);
	assert.match(review, /Removed edition: ISBN 9780000000002/);
	assert.match(review, /New edition: Narrated by Cy Hale, Ann Vale; ISBN 9780000000002/);
	assert.match(review, /Fern 2: Removed edition: audible\.com B0FERN0003, and kept out of imports/);
	await els.reviewSaveBtn.listeners.click[0]();
	await idle();
	assert.match(els.ioStatus.textContent, /^Saved 2 books, kept 1 edition id out of imports\./);
	assert.equal(els.changeCount.textContent, 'No changes yet');
	// Save goes back to the series' page, which says what was saved, once
	const seriesId = get('SERIES_ID');
	assert.equal(edit.ctx.location.assigned, 'index.html#series=' + seriesId);
	const series = await boot({storage, files: null, session, hash: '#series=' + seriesId});
	assert.match(series.els.ioStatus.textContent, /^Saved 2 books, kept 1 edition id out of imports\./);
	assert.equal(session.has('audiobook-catalog-status'), false);
	const saved = await kept(storage);
	assert.deepEqual(
		saved.books.map((b: any) => [b.t, b.e.map((x: any) => x.ext || x.isbn)]),
		[
			['Fern One', [{'audible.com': 'B0FERN0001'}, '9780000000002']],
			['Fern 2', [{'audible.com': 'B0FERN0002'}]],
		],
	);
	assert.deepEqual(saved.excluded, ['Edition B0FERN0003']);

	// the list of what imports skip, on Import & export, takes it off again
	const io = await boot({page: 'import.html', storage, files: null});
	io.els.exclusionsBtn.listeners.click[0]();
	await idle();
	assert.match(io.els.exclusionsList.innerHTML, /<span>Edition B0FERN0003<\/span>/);
	io.els.exclusionsList.querySelector('.removeExclusion')!.listeners.click[0]();
	await idle();
	assert.equal(io.els.ioStatus.textContent.startsWith('Imports may add Edition B0FERN0003 again.'), true);
	assert.match(io.els.exclusionsList.innerHTML, /no book or edition is excluded/);
	assert.deepEqual((await kept(storage)).excluded, []);
});
test("links: a book's and an edition's, typed on its Edit page (a catalog's page going to its id) and shown on its page", async () => {
	const mine = JSON.stringify([
		{
			t: 'The Lantern Keeper',
			a: ['Ann Vale'],
			links: ['https://ann-vale.example/lantern-keeper'],
			e: [{ext: {'audible.com': 'B0LANT0001'}, links: ['https://gullwing.example/lantern-keeper']}],
		},
	]);
	const {els, readable, storage} = await bootBook('The Lantern Keeper', {files: {'books.json': mine}});
	assert.match(
		readable(els.results.innerHTML),
		/<dt>Link<\/dt><dd><a class="weblink" href="https:\/\/ann-vale\.example\/lantern-keeper" target="_blank" rel="noopener">ann-vale\.example ↗<\/a><\/dd>/,
	);
	assert.match(
		readable(els.results.innerHTML),
		/<h3>Edition<\/h3><dl class="details"><dt>ASIN<\/dt><dd>[^]*?<\/dd><dt>Link<\/dt><dd><a class="weblink" href="https:\/\/gullwing\.example\/lantern-keeper" target="_blank" rel="noopener">gullwing\.example ↗<\/a><\/dd><\/dl>/,
	);

	const edit = await bootEditBook('The Lantern Keeper', {storage});
	const e = edit.els;
	assert.equal(e.b0_links.value, 'https://ann-vale.example/lantern-keeper');
	assert.equal(draftEditions(edit.get)[0].links, 'https://gullwing.example/lantern-keeper');
	// a catalog's page among the book's links goes to its id field; other links stay as typed
	e.b0_links.value =
		'https://ann-vale.example/lantern-keeper\nwww.gullwing.example/lanterns\nhttps://openlibrary.org/works/OL77W';
	e.b0_links.dispatch('focusout');
	assert.equal(e.b0_ext_openlibrary.value, 'OL77W');
	assert.equal(e.b0_links.value, 'https://ann-vale.example/lantern-keeper\nwww.gullwing.example/lanterns');
	// and an edition's page among an edition's goes to the card's field for it
	e.b0e0_links.value = 'https://gullwing.example/lantern-keeper\nhttps://www.goodreads.com/book/show/4242';
	e.b0e0_links.dispatch('focusout');
	assert.deepEqual(draftEditions(edit.get)[0], {
		'ext:audible.com': 'B0LANT0001',
		'ext:goodreads': '4242',
		links: 'https://gullwing.example/lantern-keeper',
	});
	// an address whose field holds another id goes to Another id, which says so
	e.b0e0_links.value = 'https://gullwing.example/lantern-keeper\nhttps://www.goodreads.com/book/show/99';
	e.b0e0_links.dispatch('focusout');
	assert.match(
		e['book-0-ed-0-error'].textContent,
		/It has an id on Goodreads already: https:\/\/www\.goodreads\.com\/book\/show\/99\./,
	);
	typeIn(e, 'b0e0_more', '');
	assert.equal(e['book-0-ed-0-error'].textContent, '');
	assert.equal(await saveEdit(edit), true);
	assert.deepEqual((await kept(storage)).books[0], {
		t: 'The Lantern Keeper',
		a: ['Ann Vale'],
		ext: {openlibrary: 'OL77W'},
		links: ['https://ann-vale.example/lantern-keeper', 'https://www.gullwing.example/lanterns'],
		e: [
			{ext: {'audible.com': 'B0LANT0001', goodreads: '4242'}, links: ['https://gullwing.example/lantern-keeper']},
		],
	});
	const shown = await bootBook('The Lantern Keeper', {storage});
	assert.match(
		shown.readable(shown.els.results.innerHTML),
		/<dt>Links<\/dt><dd><a class="weblink" href="https:\/\/ann-vale\.example\/lantern-keeper"[^>]*>ann-vale\.example ↗<\/a> <a class="weblink" href="https:\/\/www\.gullwing\.example\/lanterns"[^>]*>gullwing\.example ↗<\/a><\/dd>/,
	);
	// a book's card in a list leaves them out
	const list = await boot({page: 'books.html', storage});
	assert.doesNotMatch(list.els.results.innerHTML, /gullwing|ann-vale/);
});
test("links: a series', a book's and an edition's, edited on the Edit series page and shown on the series' page", async () => {
	const files = {
		'books.json': JSON.stringify([
			{t: 'The Lantern Keeper', a: ['Ann Vale'], s: 'Lanterns', sn: '1', e: [{desc: 'UK edition'}]},
		]),
		'series-info.json': JSON.stringify({}),
	};
	const edit = await bootEdit('Lanterns', {files});
	const {els, storage} = edit;
	assert.equal(els.sf_links.value, '');
	els.sf_total.value = '3';
	els.sf_links.value = 'gullwing.example/lanterns\nhttps://www.goodreads.com/series/1234-lanterns';
	els.sf_links.dispatch('focusout');
	assert.equal(els.sf_ext_goodreads.value, '1234');
	assert.equal(els.sf_links.value, 'gullwing.example/lanterns');
	els.b0_links.value = 'https://ann-vale.example/lanterns/1';
	els.b0_links.dispatch('change');
	// an edition's catalog page goes to Another id, as the card has no field for it yet
	els.b0e0_links.value = 'https://gullwing.example/lanterns/1/uk\nhttps://www.goodreads.com/book/show/4242';
	els.b0e0_links.dispatch('focusout');
	await els.reviewBtn.listeners.click[0]();
	await idle();
	assert.match(els.reviewList.textContent, /Links: https:\/\/gullwing\.example\/lanterns/);
	assert.match(els.reviewList.textContent, /Links: https:\/\/ann-vale\.example\/lanterns\/1/);
	assert.match(els.reviewList.textContent, /Links: https:\/\/gullwing\.example\/lanterns\/1\/uk/);
	await els.reviewSaveBtn.listeners.click[0]();
	await idle();
	const stored = await kept(storage);
	assert.deepEqual(stored.seriesInfo.Lanterns, {
		total: 3,
		ext: {goodreads: '1234'},
		links: ['https://gullwing.example/lanterns'],
	});
	assert.deepEqual(stored.books[0].links, ['https://ann-vale.example/lanterns/1']);
	assert.deepEqual(stored.books[0].e, [
		{ext: {goodreads: '4242'}, desc: 'UK edition', links: ['https://gullwing.example/lanterns/1/uk']},
	]);
	// the series' page shows them after its catalog links
	const series = await boot({storage, hash: edit.ctx.location.assigned.slice('index.html'.length)});
	await idle();
	assert.match(
		series.els.results.innerHTML,
		/Goodreads ↗<\/a> <a class="authorlink" href="https:\/\/gullwing\.example\/lanterns" target="_blank" rel="noopener">gullwing\.example ↗<\/a>/,
	);
});
test("links: a person's other links, typed in their form beside their website, a catalog's page going to its id", async () => {
	const {els, get} = await boot({page: 'publisher.html', hash: '#p=Kestrel+Row+Audio'});
	els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	assert.equal(els.cf_links.value, '');
	els.cf_links.value = 'gullwing.example/about\nhttps://www.wikidata.org/wiki/Q77\n https://gullwing.example/about ';
	els.cf_links.dispatch('focusout');
	assert.equal(els.cf_ext_wikidata.value, 'Q77');
	await els.creditForm.listeners.submit[0]({preventDefault() {}});
	await idle();
	assert.deepEqual(get("CATALOG.infoByName('publishers').get('Kestrel Row Audio')").links, [
		'https://gullwing.example/about',
	]);
	assert.equal(get("CATALOG.infoByName('publishers').get('Kestrel Row Audio')").ext.wikidata, 'Q77');
	assert.match(els.creditBody.innerHTML, /href="https:\/\/gullwing\.example\/about"[^>]*>gullwing\.example ↗<\/a>/);
	els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	assert.equal(els.cf_links.value, 'https://gullwing.example/about');
});
// ------------------------------------------------------------------ Fill in from other catalogs: series and people
const LANTERN_KEEPER = {
	t: 'The Lantern Keeper',
	a: ['Ann Vale'],
	s: 'Gull Isle',
	sn: '2',
	ext: {openlibrary: 'OL900W'},
	e: [{ext: {'audible.com': 'B0LANTERN2'}, n: ['Hollis Marr']}],
};
test("an author's form is filled in from other catalogs: what they have is offered with ticks, and nothing is kept before Save", async () => {
	const catalogs = fakeCatalogs();
	const {ctx, els, storage} = await boot({
		page: 'author.html',
		hash: '#a=Ann+Vale',
		files: {'books.json': JSON.stringify([LANTERN_KEEPER])},
		catalogs: catalogs.fetch,
	});
	els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	assert.equal(els.cf_fill.innerHTML, '');
	els.cf_ext_isfdb.value = '77';
	await ctx.fillCredit();
	// found on her book's work on Open Library, and on Wikidata by the id Open Library has for her
	const drawn = els.cf_fill.innerHTML;
	assert.match(
		drawn,
		/<p class="entryFrom">Open Library: <a href="https:\/\/openlibrary\.org\/authors\/OL70A" target="_blank" rel="noopener">Ann Vale<\/a>, named on your books there<\/p>/,
	);
	assert.match(
		drawn,
		/<p class="entryFrom">Wikidata: <a href="https:\/\/www\.wikidata\.org\/wiki\/Q9002" target="_blank" rel="noopener">Ann Vale<\/a>, by the id kept here<\/p><p class="hint">writer of sea stories<\/p>/,
	);
	assert.doesNotMatch(drawn, /Q9005|OL71A/, 'no namesakes once she is found for sure');
	assert.match(drawn, /to ask Hardcover too, save your Hardcover API token on the Import &amp; export page/);
	const ticks = [0, 1, 2, 3, 4, 5, 6].map(i => els[`cf_fill-pick-${i}`]);
	assert.equal(els['cf_fill-pick-7'], undefined, 'the ISFDB id is not offered, as the form has one');
	assert.deepEqual(
		ticks.map(t => t.checked),
		[true, true, true, true, true, false, true],
		'all but the link are ticked',
	);
	assert.match(
		drawn,
		/Its id on Goodreads: <a href="https:\/\/www\.goodreads\.com\/author\/show\/8801"[^>]*>8801<\/a>/,
	);
	// asking changed nothing: not the form, not the catalog
	assert.equal(els.cf_bio.value, '');
	assert.equal(els.cf_ext_goodreads.value, '');
	assert.deepEqual((await kept(storage)).authors, {});
	// only what is ticked is added, to the form
	ticks[3].checked = false; // not her Goodreads id
	ticks[5].checked = true; // but the link
	els.cf_fillAdd.listeners.click[0]();
	assert.equal(els.cf_fill.innerHTML, '');
	assert.equal(els.cf_bio.value, 'Ann Vale writes of tides.\n\nShe lives by an estuary.');
	assert.equal(els.cf_url.value, 'https://annvale.example');
	assert.equal(els.cf_ext_openlibrary.value, 'OL70A');
	assert.equal(els.cf_ext_wikidata.value, 'Q9002');
	assert.equal(els.cf_ext_amazon.value, 'B0AUTHOR01');
	assert.equal(els.cf_ext_goodreads.value, '');
	assert.equal(els.cf_ext_isfdb.value, '77', 'what was typed stays');
	assert.equal(els.cf_links.value, 'https://valereaders.example/');
	assert.equal(els.ioStatus.textContent, 'Added 6 values to the form; save it to keep them.');
	assert.deepEqual((await kept(storage)).authors, {}, 'still only in the form');
	// Save keeps them
	await els.creditForm.listeners.submit[0]({preventDefault() {}});
	assert.deepEqual((await kept(storage)).authors['Ann Vale'], {
		bio: 'Ann Vale writes of tides.\n\nShe lives by an estuary.',
		url: 'https://annvale.example',
		ext: {'amazon.com': 'B0AUTHOR01', openlibrary: 'OL70A', isfdb: '77', wikidata: 'Q9002'},
		links: ['https://valereaders.example/'],
	});
	// asked again, there is nothing more but what was left unticked; Close puts the list away
	els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	await ctx.fillCredit();
	assert.equal(els['cf_fill-pick-1'], undefined);
	assert.match(els.cf_fill.innerHTML, /Its id on Goodreads/);
	els.cf_fillClose.listeners.click[0]();
	assert.equal(els.cf_fill.innerHTML, '');
	// nothing was sent anywhere but questions to the two catalogs
	assert.ok(catalogs.sent.every(url => /^https:\/\/(openlibrary\.org|www\.wikidata\.org)\//.test(url)));
});
test('a narrator found by name alone is offered unticked, and a catalog that has no one says so', async () => {
	const catalogs = fakeCatalogs();
	const page = await boot({
		page: 'author.html',
		hash: '#a=Ann+Vale',
		files: {'books.json': JSON.stringify([{t: 'Tide Tables', a: ['Ann Vale']}])},
		catalogs: catalogs.fetch,
	});
	const {ctx, els, storage} = page;
	els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	await ctx.fillCredit();
	// her book has no id anywhere, so she is found by name: two on each catalog, which may be others
	assert.equal((els.cf_fill.innerHTML.match(/class="entryAnswer unsure"/g) || []).length, 4);
	assert.match(els.cf_fill.innerHTML, /found by name alone, so it may be another of that name/);
	assert.match(els.cf_fill.innerHTML, /<p class="hint">1 work, best known for Tide Tables 1988<\/p>/);
	const ticks = [...Array(20).keys()].map(i => els[`cf_fill-pick-${i}`]).filter(Boolean);
	assert.ok(ticks.length > 8);
	assert.ok(ticks.every(t => !t.checked));
	// adding with nothing ticked adds nothing
	els.cf_fillAdd.listeners.click[0]();
	assert.equal(els.ioStatus.textContent, 'Nothing was ticked, so nothing was added.');
	assert.equal(els.cf_bio.value, '');
	// one bio at most: ticking the other namesake's unticks the first
	await ctx.fillCredit();
	const bios = [...Array(20).keys()]
		.map(i => els[`cf_fill-pick-${i}`])
		.filter(t => t && /Bio: /.test(t.parentNode!.textContent));
	assert.equal(bios.length, 2);
	bios[0].checked = true;
	bios[1].checked = true;
	bios[1].listeners.change[0]();
	assert.deepEqual(
		bios.map(t => t.checked),
		[false, true],
	);
	els.cf_fillAdd.listeners.click[0]();
	assert.equal(els.cf_bio.value, 'Ann Vale edits tide tables.');
	assert.deepEqual((await kept(storage)).authors, {});
	// a closed form's answers are not listed
	const closing = ctx.fillCredit();
	els.cancelCredit.listeners.click[0]();
	await closing;
	assert.equal(els.cf_fill.innerHTML, '');
	// no one of that name
	const nobody = await boot({
		page: 'narrator.html',
		hash: '#n=Hollis+Marr',
		files: {'books.json': JSON.stringify([LANTERN_KEEPER])},
		catalogs: catalogs.fetch,
	});
	nobody.els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	await nobody.ctx.fillCredit();
	assert.match(nobody.els.cf_fill.innerHTML, /None of the other catalogs asked has Hollis Marr\./);
	// offline, it says so and changes nothing
	const offline = await boot({
		page: 'author.html',
		hash: '#a=Ann+Vale',
		files: {'books.json': JSON.stringify([LANTERN_KEEPER])},
	});
	offline.els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	await offline.ctx.fillCredit();
	assert.match(
		offline.els.cf_fill.innerHTML,
		/Open Library couldn't be asked: this browser could not reach Open Library/,
	);
	assert.equal(offline.els['cf_fill-pick-0'], undefined);
});
test("the Edit page's Ask the catalogs fills in the series panel too, and Review & save lists what was added", async () => {
	const hc = fakeHardcover(hardcoverState());
	const storage = new Map<string, string>([['audiobook-catalog-hardcover-token', 'tok-123']]);
	const tidewater = {t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', ext: {hardcover: '77'}};
	const page = await bootEdit('Gull Isle', {
		files: {'books.json': JSON.stringify([tidewater])},
		catalogs: fakeCatalogs().fetch,
		hardcover: hc.fetch,
		setTimeout: done => setTimeout(done), // no waiting between the questions
		storage,
	});
	const {ctx, els} = page;
	await ctx.ASKING;
	await idle();
	assert.equal(els.sf_fill.innerHTML, '', 'nothing is asked until Ask the catalogs is pressed');
	assert.equal(els.seriesFillBtn, undefined, 'one button asks about both the series and its books');
	els.sf_total.value = 'many';
	els.askBtn.listeners.click[0]();
	await ctx.ASKING;
	await idle();
	const drawn = els.sf_fill.innerHTML;
	assert.match(
		drawn,
		/Hardcover: <a href="https:\/\/hardcover\.app\/id\/series\/3102"[^>]*>Gull Isle<\/a>, named on your books there/,
	);
	assert.match(drawn, /Wikidata: <a [^>]*>Gull Isle<\/a>, found by name alone/);
	assert.doesNotMatch(drawn, /Books released so far/, 'a count is kept, so none is offered');
	// Hardcover's are ticked, Wikidata's (found by name) are not
	const ticks = [0, 1, 2, 3].map(i => els[`sf_fill-pick-${i}`]);
	assert.deepEqual(
		ticks.map(t => [t.parentNode!.textContent, t.checked]),
		[
			['Status: complete', true],
			['Its id on Hardcover: 3102', true],
			['Its id on Wikidata: Q9003', false],
			['Its id on Goodreads: 6611', false],
		],
	);
	assert.equal(els.sf_status.value, '');
	ticks[3].checked = true;
	els.sf_fillAdd.listeners.click[0]();
	assert.equal(els.sf_total.value, 'many');
	assert.equal(els.sf_status.value, 'complete');
	assert.equal(els.sf_ext_hardcover.value, '3102');
	assert.equal(els.sf_ext_goodreads.value, '6611');
	assert.equal(els.sf_ext_wikidata.value, '');
	assert.equal(els.ioStatus.textContent, 'Added 3 values to the form; save it to keep them.');
	assert.deepEqual((await kept(storage)).seriesInfo, {}, 'nothing is kept before Save');
	assert.ok(await saveEdit(page));
	assert.deepEqual((await kept(storage)).seriesInfo['Gull Isle'], {
		total: 'many',
		status: 'complete',
		ext: {goodreads: '6611', hardcover: '3102'},
	});
	assert.ok(
		hc.sent.every(s => s.query.startsWith('query ')),
		'Hardcover was only asked',
	);
});
// ------------------------------------------------------------------ places
// Invented worlds: Port Wren is on the Gull Coast of Emberlands, a world Ann Vale made and Gullwing Games owns.
const SETTING_FILES = {
	'books.json': JSON.stringify([
		{t: 'The Tidewright', a: ['Ann Vale'], pl: ['Port Wren'], e: [{ext: {'audible.com': 'B0TIDE0001'}}]},
		{t: 'Salt and Ember', a: ['Bo Reyes'], pl: ['Emberlands'], e: [{ext: {'audible.com': 'B0SALT0001'}}]},
		{t: 'A Quiet Harbor', a: ['Cy Hale'], e: [{ext: {'audible.com': 'B0QUIET001'}}]},
	]),
	'places.json': JSON.stringify({
		'Port Wren': {in: ['Gull Coast'], note: 'A port town.'},
		'Gull Coast': {in: ['Emberlands']},
		Emberlands: {by: ['Ann Vale'], owner: 'Gullwing Games'},
	}),
};
test('the places page lists every place as a tree, the places within each below it, and a search finds one by name', async () => {
	const {els, readable} = await boot({page: 'places.html', files: SETTING_FILES});
	await idle();
	assert.equal(els.subtitle.textContent, '3 places across 3 audiobooks');
	// adding a place is a button: its name is typed in the form
	assert.match(els.addPlace.outerHTML, /<a class="addbtn" id="addPlace" href="place\.html#new">\+ Add a place<\/a>/);
	assert.equal(els.newPlaceName, undefined);
	const html = readable(els.placeBody.innerHTML);
	const row = (name: string, count: string) =>
		`<div class="place-row"><div class="srow-head"><span class="place-name"><a class="srow-title" href="place.html#place=${name.replace(/ /g, '+')}">${name}</a></span><span class="srow-owned">${count}</span></div>`;
	assert.ok(
		html.startsWith(
			`<ul class="place-tree top"><li>${row('Emberlands', '1 book, 1 more within')}</div><ul class="place-tree"><li>${row('Gull Coast', '1 book within')}</div>`,
		),
		html,
	);
	// a note goes below the line, so the count stays at its end
	assert.ok(html.includes(`${row('Port Wren', '1 book')}<p class="srow-note">A port town.</p></div>`), html);
	els.q.value = 'wren';
	els.q.listeners.input[0]();
	const found = readable(els.placeBody.innerHTML);
	assert.match(
		found,
		/Port Wren<\/a> <span class="within">in Gull Coast<\/span><\/span><span class="srow-owned">1 book<\/span>/,
	);
	assert.doesNotMatch(found, /Emberlands<\/a>/);
});
test('the places tree counts a book once in a place, however many of the places within it it is set in', async () => {
	const files = {
		...SETTING_FILES,
		'books.json': JSON.stringify([
			{t: 'The Tidewright', a: ['Ann Vale'], pl: ['Port Wren', 'Gull Coast', 'Emberlands']},
			{t: 'Salt and Ember', a: ['Bo Reyes'], pl: ['Port Wren', 'Dun Moor']},
			{t: 'A Quiet Harbor', a: ['Cy Hale'], pl: ['Dun Moor']},
		]),
		'places.json': JSON.stringify({
			'Port Wren': {in: ['Gull Coast']},
			'Gull Coast': {in: ['Emberlands']},
			'Dun Moor': {in: ['Emberlands']},
			Emberlands: {},
		}),
	};
	const {els, readable} = await boot({page: 'places.html', files});
	await idle();
	const html = readable(els.placeBody.innerHTML);
	const count = (name: string) => html.match(new RegExp(`>${name}</a></span><span class="srow-owned">([^<]*)<`))![1];
	assert.equal(count('Emberlands'), '1 book, 2 more within', 'The Tidewright is set there itself');
	assert.equal(count('Gull Coast'), '1 book, 1 more within');
	assert.equal(count('Dun Moor'), '2 books');
	assert.equal(count('Port Wren'), '2 books');
});
test('a place part of several shows under each, but the places within it only once', async () => {
	const files = {
		...SETTING_FILES,
		'places.json': JSON.stringify({
			'Port Wren': {in: ['Gull Coast', 'Tide Isles']},
			'Wren Harbor': {in: ['Port Wren']},
			'Gull Coast': {in: ['Emberlands']},
			'Tide Isles': {},
		}),
	};
	const {els, readable} = await boot({page: 'places.html', files});
	await idle();
	const html = readable(els.placeBody.innerHTML);
	assert.equal(html.match(/>Port Wren<\/a>/g)!.length, 2, 'under the Gull Coast and the Tide Isles');
	assert.equal(html.match(/>Wren Harbor<\/a>/g)!.length, 1, 'once, under the first');
	assert.match(
		html,
		/>Port Wren<\/a> <span class="within">\(the places within it are under <a href="place\.html#place=Gull\+Coast">Gull Coast<\/a>\)<\/span>/,
	);
});
test("a place's page shows what it is within, who made it, the places within it as a tree, and the books set there and in them", async () => {
	const {ctx, els, storage, readable} = await boot({
		page: 'place.html',
		hash: '#place=Emberlands',
		files: SETTING_FILES,
	});
	await idle();
	assert.equal(ctx.document.title, 'Emberlands · Audiobook Catalog');
	assert.equal(els.subtitle.textContent, '2 audiobooks set here or in a place within it');
	const html = readable(els.placeBody.innerHTML);
	assert.match(html, /<h2 class="author-name">Emberlands<\/h2>/);
	assert.match(html, /Created by <a href="author\.html#a=Ann\+Vale">Ann Vale<\/a>/);
	assert.match(html, /Rights held by Gullwing Games/);
	// the tree of the places within it, with it at the top
	assert.match(
		html,
		/<p class="series-title">Places within it<\/p><ul class="place-tree"><li><div class="place-row">.*>Emberlands<\/a>.*<ul class="place-tree"><li>.*>Gull Coast<\/a>.*<ul class="place-tree"><li>.*>Port Wren<\/a>/,
	);
	assert.match(
		html,
		/Set here <span class="n">1 book<\/span><\/p><ul class="author-books"><li><a href="book\.html#book=Salt\+and\+Ember">/,
	);
	assert.match(
		html,
		/<a href="#place=Port\+Wren">Port Wren<\/a> <span class="n">1 book<\/span><\/p><ul class="author-books"><li><a href="book\.html#book=The\+Tidewright">/,
	);
	assert.match(html, /<a class="sedit" href="#new=id-\d+">\+ Add a place within it<\/a>/);

	// a place: what it is part of, and what that is within; no tree when nothing is within it
	const wren = await boot({page: 'place.html', hash: '#place=Port+Wren', storage});
	await idle();
	const place = wren.readable(wren.els.placeBody.innerHTML);
	assert.match(place, /Part of <a href="#place=Gull\+Coast">Gull Coast<\/a>/);
	assert.match(place, /Also within <a href="#place=Emberlands">Emberlands<\/a>/);
	assert.doesNotMatch(place, /Places within it/);
	assert.equal(wren.els.subtitle.textContent, '1 audiobook set here');
});
test("a place is edited, renamed and removed on its page, and can't be put within itself", async () => {
	const {els, storage} = await boot({page: 'place.html', hash: '#place=Gull+Coast', files: SETTING_FILES});
	await idle();
	const submit = () => els.placeForm.listeners.submit[0]({preventDefault() {}});
	els.placeBody.querySelector('.aedit')!.listeners.click[0]();
	assert.ok(els.placeForm.classList.contains('open'));
	assert.equal(els.placeFormTitle.textContent, 'Edit place: Gull Coast');
	assert.equal(els.sf_in.value, 'Emberlands');
	// a place within it can't be what it is part of
	els.sf_in.value = 'Emberlands, Port Wren';
	submit();
	assert.match(els.placeFormError.textContent, /can't be part of Port Wren: it is within Gull Coast already/);
	els.sf_in.value = 'Emberlands';
	els.sf_name.value = 'Gull Shore';
	els.sf_note.value = '  Windy  cliffs. ';
	els.sf_ext_wikidata.value = 'https://www.wikidata.org/wiki/Q4242';
	submit();
	assert.ok(!els.placeForm.classList.contains('open'));
	assert.equal(els.ioStatus.textContent, 'Renamed Gull Coast to Gull Shore on 0 books.');
	const stored = await kept(storage);
	assert.deepEqual(stored.places['Gull Shore'], {
		in: ['Emberlands'],
		note: 'Windy cliffs.',
		ext: {wikidata: 'Q4242'},
	});
	assert.deepEqual(stored.places['Port Wren'].in, ['Gull Shore'], 'the places within it follow');
	assert.equal(stored.places['Gull Coast'], undefined);

	// removing it puts its places in what it was part of
	els.placeBody.querySelector('.aedit')!.listeners.click[0]();
	els.placeRemoveBtn.listeners.click[0]();
	assert.match(
		els.placeFormError.textContent,
		/^This removes Gull Shore, where no book is set; the places within it stay/,
	);
	els.placeRemoveBtn.listeners.click[0]();
	const after = await kept(storage);
	assert.equal(after.places['Gull Shore'], undefined);
	assert.deepEqual(after.places['Port Wren'].in, ['Emberlands']);
	assert.equal(els.ioStatus.textContent, 'Removed Gull Shore.');
});
test('a new place is named in its form; one added from a place is within it', async () => {
	// + Add a place on the list: an empty form
	const blank = await boot({page: 'place.html', hash: '#new', files: SETTING_FILES});
	await idle();
	const {els} = blank;
	assert.ok(els.placeForm.classList.contains('open'));
	assert.equal(els.placeFormTitle.textContent, 'New place');
	assert.equal(els.sf_name.value, '');
	assert.equal(els.sf_in.value, '');
	assert.equal(els.placeRemoveBtn.hidden, true);
	els.placeForm.listeners.submit[0]({preventDefault() {}});
	assert.equal(els.placeFormError.textContent, 'Give the place a name.');
	els.sf_name.value = 'Emberlands';
	els.placeForm.listeners.submit[0]({preventDefault() {}});
	assert.equal(els.placeFormError.textContent, 'There is already a place called Emberlands.');
	// Cancel adds nothing, and goes back to the list
	els.cancelPlace.listeners.click[0]();
	assert.equal(blank.ctx.location.assigned, 'places.html');

	// + Add a place within it, on a place's page: its Part of is filled in
	const id = blank.get("CATALOG.nameIds.places.get('Emberlands')");
	const {ctx, els: form, storage} = await boot({page: 'place.html', hash: '#new=' + id, storage: blank.storage});
	await idle();
	assert.equal(form.subtitle.textContent, 'A new place within Emberlands');
	assert.equal(form.sf_in.value, 'Emberlands');
	form.sf_name.value = ' Tide Isles ';
	form.sf_by.value = 'Dee Marsh';
	form.placeForm.listeners.submit[0]({preventDefault() {}});
	assert.equal(form.ioStatus.textContent, 'Added Tide Isles.');
	const stored = await kept(storage);
	assert.deepEqual(stored.places['Tide Isles'], {in: ['Emberlands'], by: ['Dee Marsh']});
	// saved, its page shows it, known by its id
	const tide = databaseOf(storage)
		.records('places')
		.find(x => x.name === 'Tide Isles');
	assert.equal(ctx.location.hash, '#place=' + tide.id);
	assert.match(form.placeBody.innerHTML, /<h2 class="author-name">Tide Isles<\/h2>/);
	// its creator is an author of their own, though no book of theirs is in the catalog
	assert.ok(
		databaseOf(storage)
			.records('contributors')
			.some(c => c.name === 'Dee Marsh' && c.kind === 'author'),
	);
});
test("a book's page lists its places with what each is within, and the Edit page sets them", async () => {
	const book = await bootBook('The Tidewright', {files: SETTING_FILES});
	await idle();
	assert.match(
		book.readable(book.els.results.innerHTML),
		/<dt>Place<\/dt><dd><a href="place\.html#place=Port\+Wren">Port Wren<\/a> <span class="within">\(Gull Coast, Emberlands\)<\/span><\/dd>/,
	);
	const edit = await boot({
		page: 'edit.html',
		hash: '#book=' + bookIdOf(book.get, 'The Tidewright'),
		storage: book.storage,
	});
	await idle();
	assert.equal(edit.els.b0_pl.value, 'Port Wren');
	typeIn(edit.els, 'b0_pl', 'Port Wren, Saltmarsh');
	edit.els.b0_pl.dispatch('input');
	assert.deepEqual(edit.get('DRAFTS[0].book.places'), ['Port Wren', 'Saltmarsh']);
	assert.match(edit.els.b0_plNew.textContent, /New place: Saltmarsh/);
});
