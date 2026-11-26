// Browser smoke tests: keeping the catalog in this browser, imports, backups, removing books, ids, the Edit
// series page and duplicates. The pages run in Node against a fake DOM (boot() in smoke.ts).
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import {Book} from '#app/modules/book.js';
import {Duplicates} from '#app/modules/duplicates.js';
import {CatalogRecords} from '#app/modules/catalog-records.js';
import {Backup} from '#app/modules/backup.js';
import {
	CATALOG_KEY,
	DEMO,
	DEMO_AUTHORS,
	DEMO_INFO,
	DEMO_NARRATORS,
	DEMO_PUBLISHERS,
	NOT_DUP_KEY,
	SALT_ROAD,
	bookIdAt,
	boot,
	bootBook,
	bootEdit,
	bootEditBook,
	databaseOf,
	demoBooks,
	idle,
	kept,
	removeBook,
	saveEdit,
	seriesIdOf,
	settled,
	typeBookId,
	typeIn,
	withoutIds,
} from './smoke.ts';

test('with no catalog in this browser it starts empty, not with the demo, and says where books come from', async () => {
	const {els, get, run, storage} = await boot({files: null});
	await idle();
	assert.deepEqual(get('CATALOG.books'), []);
	assert.deepEqual(get('CATALOG.toJSON().seriesInfo'), {});
	assert.equal(els.subtitle.textContent, 'Your catalog is empty');
	assert.match(els.results.innerHTML, /No books yet\. .*<a href="import\.html">Import &amp; export<\/a>/);
	assert.equal(await kept(storage), null, 'nothing is stored before the first edit');
	run("CATALOG.books.push(new Book({ title: 'First', authors: ['Me'] }))");
	await run('persist()');
	assert.deepEqual(await kept(storage), {
		books: [{t: 'First', a: ['Me']}],
		seriesInfo: {},
		authors: {},
		narrators: {},
		publishers: {},
		places: {},
		excluded: [],
		notDuplicates: [],
	});
});
test('the catalog is kept in this browser, from one page load to the next', async () => {
	// (on the Duplicates page, which holds the whole catalog)
	const first = await boot({page: 'duplicates.html'});
	first.run("CATALOG.books[0].title = 'Edited Locally'");
	await first.run('persist()');
	const again = await boot({storage: first.storage, page: 'duplicates.html'});
	assert.equal(again.get('CATALOG.books[0].title'), 'Edited Locally');
	assert.equal(again.get('CATALOG.books.length'), demoBooks.length);
	assert.deepEqual(
		again.withIds('CATALOG.books.map(b => b.id)'),
		first.withIds('CATALOG.books.map(b => b.id)'),
		'each book keeps its id',
	);
});
test('records saved before ids were kept by external catalog are read, and saved again the current way', async () => {
	const storage = new Map<string, string>();
	const {database} = await boot({storage});
	await kept(storage);
	// make the stored records look as the app before this one wrote them
	const stores = database.data.get('audiobook-catalog')!.stores;
	for (const {value} of stores.get('editions')!.records.values()) {
		const {external = {}} = value;
		delete value.external;
		value.asins = Object.fromEntries(Object.entries(external).filter(([k]) => k.includes('.')));
		if (external.goodreads) value.goodreadsId = external.goodreads;
	}
	for (const {value} of stores.get('contributors')!.records.values()) {
		if (value.external && value.external.hardcover)
			value.hardcover = `https://hardcover.app/authors/${value.external.hardcover}`;
		delete value.external;
		delete value.externalKeys;
	}
	for (const {value} of stores.get('books')!.records.values()) delete value.externalKeys;
	const revision = database.records('meta').find(m => m.key === 'revision').value;
	const again = await boot({storage, page: 'duplicates.html'});
	await kept(storage);
	assert.ok(database.records('meta').find(m => m.key === 'revision').value > revision, 'saved again at once');
	assert.ok(database.records('editions').every(ed => ed.external && !ed.asins));
	assert.ok(database.records('books').every(b => Array.isArray(b.externalKeys)));
	assert.deepEqual(again.get('CATALOG.books'), demoBooks);
	assert.deepEqual(
		again.get("CATALOG.infoByName('authors').get('Marisol Quenby').external.hardcover"),
		'marisol-quenby-sample',
	);
});
test('the catalog localStorage kept is moved to IndexedDB on the first load, and kept aside as it was', async () => {
	const storage = new Map<string, string>();
	const {get, withIds, database} = await boot({
		storage,
		page: 'duplicates.html',
		files: {...DEMO, 'not-duplicates.txt': 'x\n'},
	});
	const before = storage.get(CATALOG_KEY + '.moved-to-indexeddb');
	assert.ok(before, 'the old copy is renamed, not deleted');
	assert.equal(storage.has(CATALOG_KEY), false);
	assert.equal(storage.get(NOT_DUP_KEY + '.moved-to-indexeddb'), '["x"]');
	assert.deepEqual((await kept(storage)).books, demoBooks, 'IndexedDB holds the same books');
	assert.deepEqual((await kept(storage)).notDuplicates, ['x'], 'a mark that matches no book is kept as its text');
	assert.equal(database.records('books').length, demoBooks.length);
	// a box set's titles share one edition record, which lists them all
	const shared = database.records('editions').filter(ed => ed.bookIds.length > 1);
	assert.ok(shared.length, 'the demo has a box set');
	for (const ed of shared)
		for (const id of ed.bookIds)
			assert.ok(
				database
					.records('books')
					.find(b => b.id === id)
					.editionIds.includes(ed.id),
			);
	assert.deepEqual(get('CATALOG.books'), demoBooks);
	assert.ok(
		withIds('CATALOG.books').every((b: any) => b.uid),
		'every book has its id',
	);
	// a second load reads IndexedDB, not what localStorage has now
	storage.set(CATALOG_KEY, JSON.stringify({books: [{t: 'Not this', a: ['Me']}]}));
	const again = await boot({storage, page: 'duplicates.html'});
	assert.equal(again.get('CATALOG.books.length'), demoBooks.length);
});
test('a catalog with values that are not what their field holds is shown but not moved, until fixed', async () => {
	const storage = new Map<string, string>([
		[CATALOG_KEY, JSON.stringify({books: [{t: 'Odd', a: ['Me'], g: 5, x: 1}]})],
	]);
	const {get, els} = await boot({storage, files: null});
	assert.equal(get('CATALOG.books[0].title'), 'Odd', 'the page shows it');
	assert.equal(await kept(storage), null, 'nothing is written');
	assert.ok(storage.has(CATALOG_KEY), 'localStorage still has it');
	assert.match(els.ioStatus.textContent, /^Not saved: these values can't be kept.*book #0 \('Odd'\): 'g', 'x'/);
});
test('the status line clears a message after a while, but keeps an error until it is dismissed', async () => {
	const timers: {fn: () => unknown; ms: number}[] = [];
	const setTimeout = (fn: () => unknown, ms: number) => (timers.push({fn, ms}), timers.length);
	const {els, ctx} = await boot({setTimeout});
	assert.equal(els.ioStatus.getAttribute('role'), 'status', 'screen readers read it out');
	timers.length = 0;
	ctx.showIoStatus('Saved.');
	assert.deepEqual(
		timers.map(t => t.ms),
		[ctx.STATUS_TIME],
	);
	timers[0].fn();
	assert.equal(els.ioStatus.textContent, '');
	timers.length = 0;
	ctx.showIoStatus('Not saved: the disk is full.', true);
	assert.deepEqual(timers, [], 'no timer clears an error');
	assert.match(els.ioStatus.textContent, /^Not saved: the disk is full\. Dismiss$/);
	assert.ok(els.ioStatus.classList.contains('err'));
	els.ioStatus.querySelector('.dismiss')!.listeners.click[0]();
	assert.equal(els.ioStatus.textContent, '');
});
test('without IndexedDB the page shows the catalog localStorage has, and says nothing is saved', async () => {
	const storage = new Map<string, string>();
	databaseOf(storage).broken = true;
	const {get, els, run} = await boot({storage});
	assert.deepEqual(get('CATALOG.books'), demoBooks);
	assert.match(els.ioStatus.textContent, /^Not saved: this browser won't keep the catalog/);
	await run('persist()');
	assert.match(els.ioStatus.textContent, /^Not saved/);
	assert.ok(storage.has(CATALOG_KEY), 'what localStorage has stays');
});
test('a stored catalog that does not fit together is set aside, and the catalog starts empty', async () => {
	const storage = new Map<string, string>();
	const first = await boot({storage});
	await first.saved();
	// a book that lists an edition there is no record of
	const {db} = await new Promise<any>(resolve => {
		const req = first.database.open('audiobook-catalog', 7);
		req.onsuccess = () => resolve({db: req.result});
	});
	await new Promise(resolve => {
		const tx = db.transaction('editions', 'readwrite');
		tx.objectStore('editions').clear();
		tx.oncomplete = resolve;
	});
	// (a page that reads all of it finds out)
	const {get, els, database} = await boot({storage, page: 'duplicates.html'});
	assert.deepEqual(get('CATALOG.books'), []);
	assert.match(els.ioStatus.textContent, /set aside/);
	const aside = database.records('meta').find(m => m.key === 'unreadable');
	assert.equal(aside.value.books.length, demoBooks.length, 'what was stored is kept');
	assert.equal(database.records('books').length, 0);
});
test('a catalog another tab saves while this page saves it again in a new shape is read again, never set aside', async () => {
	// A browser whose stored catalog waits to be saved again (a database of version 3), where another tab's save
	// lands just before each of this page's first `saves` saves: the stored revision moves on under it.
	const open = async (saves: any) => {
		const storage = new Map<string, string>();
		const first = await boot({storage});
		await first.saved();
		const {db} = await new Promise<any>(resolve => {
			const req = first.database.open('audiobook-catalog', 7);
			req.onsuccess = () => resolve({db: req.result});
		});
		first.database.data.get('audiobook-catalog')!.version = 3;
		const fake = Object.getPrototypeOf(db),
			transaction = fake.transaction;
		let left = saves;
		fake.transaction = function (storeNames: any, mode: any) {
			if (left > 0 && mode === 'readwrite' && Array.isArray(storeNames) && storeNames.includes('books')) {
				left--;
				for (const rec of this.data.stores.get('meta').records.values())
					if (rec.key === 'revision') rec.value = {...rec.value, value: rec.value.value + 1};
			}
			return transaction.call(this, storeNames, mode);
		};
		try {
			const page = await boot({storage, page: 'books.html'});
			await page.saved();
			return page;
		} finally {
			fake.transaction = transaction;
		}
	};
	const has = (database: any, key: string) => database.records('meta').some((m: any) => m.key === key);

	// once: the page reads what the other tab saved, and saves that
	const once = await open(1);
	assert.equal(once.database.records('books').length, demoBooks.length);
	assert.equal(has(once.database, 'unreadable'), false);
	assert.equal(has(once.database, 'reshape'), false, 'saved again in the new shape');
	assert.equal(once.els.ioStatus.textContent, '');
	assert.deepEqual((await kept(once.storage)).books, demoBooks);

	// every time: the page gives up saving, says so, and still shows the catalog, which stays stored
	const always = await open(Infinity);
	assert.equal(always.database.records('books').length, demoBooks.length);
	assert.equal(has(always.database, 'unreadable'), false);
	assert.match(always.els.ioStatus.textContent, /^The catalog was changed in another tab while this page opened/);
	assert.equal(always.get('CATALOG.books.length'), demoBooks.length);
});
test("a series' site, from before authors kept their own, goes to its author when the page opens", async () => {
	const storage = new Map<string, string>();
	const first = await boot({storage});
	await first.saved();
	// a database of version 3, whose series kept a site
	const {db} = await new Promise<any>(resolve => {
		const req = first.database.open('audiobook-catalog', 7);
		req.onsuccess = () => resolve({db: req.result});
	});
	const series = first.database.records('series').find(x => x.name === 'The Lantern Coast');
	await new Promise(resolve => {
		const tx = db.transaction('series', 'readwrite');
		tx.objectStore('series').put({...series, url: 'https://example.com/lantern'});
		tx.oncomplete = resolve;
	});
	first.database.data.get('audiobook-catalog')!.version = 3;
	// a page that shows only a slice still finds it moved
	const {database} = await boot({storage, page: 'books.html'});
	const stored = await kept(storage);
	assert.deepEqual(stored.seriesInfo['The Lantern Coast'], {
		total: 5,
		status: 'ongoing',
		note: 'book 5 is announced (fictional demo data)',
		ext: {goodreads: '90001', hardcover: 'the-lantern-coast-sample'},
	});
	assert.deepEqual(
		[stored.authors['Marisol Quenby'].url, stored.authors['Marisol Quenby'].links],
		['https://example.com/', ['https://example.com/lantern']],
	);
	assert.ok(!('url' in database.records('series').find(x => x.name === 'The Lantern Coast')));
	assert.equal(
		database.records('meta').some(m => m.key === 'reshape'),
		false,
	);
});
test('an edition stored with one publisher, from before database version 5, is saved again with a list of them', async () => {
	const storage = new Map<string, string>();
	const first = await boot({storage});
	await first.saved();
	const {db} = await new Promise<any>(resolve => {
		const req = first.database.open('audiobook-catalog', 7);
		req.onsuccess = () => resolve({db: req.result});
	});
	const before = first.database.records('editions');
	await new Promise(resolve => {
		const tx = db.transaction('editions', 'readwrite');
		for (const {publisherIds, ...rec} of before)
			tx.objectStore('editions').put(publisherIds.length ? {...rec, publisherId: publisherIds[0]} : rec);
		tx.oncomplete = resolve;
	});
	first.database.data.get('audiobook-catalog')!.version = 4;
	// a page that shows only a slice still finds it moved
	const {database} = await boot({storage, page: 'books.html'});
	const after = database.records('editions');
	assert.deepEqual(
		after.map(ed => [ed.id, ed.publisherIds]),
		before.map(ed => [ed.id, ed.publisherIds]),
	);
	assert.ok(after.every(ed => !('publisherId' in ed)));
	assert.ok(after.some(ed => ed.publisherIds.length));
	assert.equal(
		database.records('meta').some(m => m.key === 'reshape'),
		false,
	);
	assert.deepEqual((await kept(storage)).books, demoBooks);
});
test('a person whose box sets were counted among their books, before database version 6, is counted again', async () => {
	const storage = new Map<string, string>();
	const first = await boot({storage});
	await first.saved();
	const {db} = await new Promise<any>(resolve => {
		const req = first.database.open('audiobook-catalog', 7);
		req.onsuccess = () => resolve({db: req.result});
	});
	const before = first.database.records('contributors');
	await new Promise(resolve => {
		const tx = db.transaction('contributors', 'readwrite');
		for (const {boxSetCount, ...rec} of before)
			tx.objectStore('contributors').put({...rec, bookCount: rec.bookCount + boxSetCount});
		tx.oncomplete = resolve;
	});
	first.database.data.get('audiobook-catalog')!.version = 5;
	const {database} = await boot({storage, page: 'authors.html'});
	const after = database.records('contributors');
	assert.deepEqual(
		after.map(c => [c.id, c.bookCount, c.boxSetCount]),
		before.map(c => [c.id, c.bookCount, c.boxSetCount]),
	);
	assert.ok(after.some(c => c.boxSetCount === 1));
});
test("a catalog this browser can't read is set aside, not overwritten", async () => {
	const {get, els, storage} = await boot({storage: new Map<string, string>([[CATALOG_KEY, '{not json']])});
	assert.deepEqual(get('CATALOG.books'), []);
	assert.equal(storage.get(CATALOG_KEY + '.unreadable'), '{not json');
	assert.equal(storage.has(CATALOG_KEY), false);
	assert.match(els.ioStatus.textContent, /set aside/);
});
test('importing an Audible CSV previews first, then adds only new books', async () => {
	const mine = JSON.stringify([{t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5'}]);
	const {els, get, readable} = await boot({
		page: 'import.html',
		files: {'books.json': mine, 'excluded.txt': 'BGONE\n'},
	});
	const csv =
		'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\n' +
		'x,A Crown of Embers 5: A Spark of Dawn,A Crown of Embers Series (book 5),Ilse Marlowe,,Finished,B5\n' +
		'x,A Crown of Embers 6: Ashfall,A Crown of Embers Series (book 6),Ilse Marlowe,A.B. Quill,Finished,B6\n' +
		'x,Removed,,Ilse Marlowe,,Finished,BGONE\n' +
		'x,Half Way,,Ilse Marlowe,,2h left,B7\n';
	els.audibleImportBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'library.csv', text: csv}], value: ''}});
	await idle();

	// preview: nothing changed yet
	assert.ok(els.importPreview.classList.contains('open'));
	assert.equal(els.importPreviewTitle.textContent, 'Compare with Audible');
	assert.equal(els.importPreview.place, 'after audiblePanel'); // under the panel that asked for it
	const html = readable(els.importPreviewBody.innerHTML);
	assert.match(
		html,
		/<p>1 new, 1 with more to give, 0 with values that differ, 0 the same as in this catalog\.<\/p>/,
	);
	assert.match(
		html,
		/New from Audible \(1\)<\/h4><ul class="cmpRows"><li><label class="cmpPick"><input type="checkbox" data-pick="take:1" checked=""> A Crown of Embers 6: Ashfall — Ilse Marlowe {2}\[A Crown of Embers #6\]/,
	);
	// Audible's edition is the one you have: ticked
	assert.match(
		html,
		/Audible has more \(1\)<\/h4>.*A Spark of Dawn — Ilse Marlowe {2}\[A Crown of Embers #5\]<\/span><ul><li><label class="cmpPick"><input type="checkbox" data-pick="editions:0" checked=""> the Audible edition: an edition \(ASIN audible\.com B5\)/,
	);
	assert.doesNotMatch(html, /Different in both/, 'the long form of a title is the same title');
	assert.match(html, /Skipped \(excluded from imports\): 1<\/p><ul><li>Removed — Ilse Marlowe/);
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');
	assert.equal(get('CATALOG.books.length'), 1);

	els.importConfirm.listeners.click[0]();
	await idle();
	assert.ok(!els.importPreview.classList.contains('open'));
	assert.deepEqual(get('CATALOG.books'), [
		{t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5', e: [{ext: {'audible.com': 'B5'}}]},
		{
			t: 'A Crown of Embers 6: Ashfall',
			a: ['Ilse Marlowe'],
			s: 'A Crown of Embers',
			sn: '6',
			e: [{ext: {'audible.com': 'B6'}, n: ['A. B. Quill']}],
		},
	]);
	assert.match(els.ioStatus.textContent, /Added 1 book, filled in 1 ASIN/);

	// the same file again: nothing to add, nothing to confirm
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'library.csv', text: csv}], value: ''}});
	await idle();
	assert.match(els.importPreviewBody.innerHTML, /0 new, 0 with more to give, 0 with values that differ, 2 the same/);
	assert.match(els.importPreviewBody.innerHTML, /Nothing to take or send: both have the same\./);
	assert.equal(els.importConfirm.style.display, 'none');
});
test('a date read written as a plain string loads, renders, and round-trips through Export / Import', async () => {
	const mine = JSON.stringify([
		{t: 'Hand Edited', a: ['Ann Vale'], r: '2024-03-15'},
		{t: 'Odd', a: ['Ann Vale'], r: 5},
	]);
	const {els} = await boot({page: 'books.html', files: {'books.json': mine}});
	assert.match(els.results.innerHTML, /Read 2024-03-15/);
	assert.match(els.readFilter.innerHTML, /Read in 2024/);

	const backup = JSON.stringify({books: [{t: 'From Backup', a: ['Ann Vale'], r: '2023-01-05'}], seriesInfo: {}});
	const storage = new Map<string, string>();
	const imp = await boot({page: 'import.html', files: {'books.json': mine}, storage});
	await imp.els.importFile.listeners.change[0]({target: {files: [{name: 'b.json', text: backup}], value: ''}});
	await idle();
	assert.doesNotMatch(imp.els.ioStatus.textContent, /Couldn't read/);
	assert.deepEqual(imp.get('CATALOG.books'), [{t: 'From Backup', a: ['Ann Vale'], r: ['2023-01-05']}]);
	await imp.saved();
	// back on the books page
	const back = await boot({page: 'books.html', files: {'books.json': mine}, storage});
	assert.match(back.els.results.innerHTML, /Read 2023-01-05/);
});
test('a Goodreads import fills in dates read on books that have none', async () => {
	const mine = JSON.stringify([{t: 'Old Favorite', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}]}]);
	const {els, get} = await boot({page: 'import.html', files: {'books.json': mine}});
	const csv =
		'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n' +
		'Old Favorite,Ann Vale,,Audible Audio,read,,2023/11/04\n';
	els.goodreadsImportBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'goodreads.csv', text: csv}], value: ''}});
	await idle();
	assert.match(
		els.importPreviewBody.innerHTML,
		/Old Favorite — Ann Vale<\/label><ul><li>read 2023-11-04<\/li><\/ul>/,
	);
	assert.equal(els.importConfirm.textContent, 'Apply 1 change');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books'), [
		{t: 'Old Favorite', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}}], r: ['2023-11-04']},
	]);
	assert.match(els.ioStatus.textContent, /filled in dates read on 1 book/);
});
test('importing a Goodreads CSV can be canceled', async () => {
	const {els, get} = await boot({page: 'import.html'});
	const before = demoBooks.length;
	const csv =
		'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\n' +
		'"Zzz New Book (Zzz Saga, #2)",Nobody Yet,,Audible Audio,read,fantasy\n';
	els.goodreadsImportBtn.listeners.click[0]();
	await idle();
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'goodreads.csv', text: csv}], value: ''}});
	await idle();
	assert.equal(els.importPreviewTitle.textContent, 'Compare with Goodreads');
	assert.equal(els.importPreview.place, 'after goodreadsPanel');
	assert.match(els.importPreviewBody.innerHTML, /Zzz New Book — Nobody Yet {2}\[Zzz Saga #2\]/);
	els.importCancel.listeners.click[0]();
	await idle();
	assert.ok(!els.importPreview.classList.contains('open'));
	assert.equal(get('CATALOG.books.length'), before);
	els.importConfirm.listeners.click[0](); // a stale click after cancelling does nothing
	assert.equal(get('CATALOG.books.length'), before);
});
test('a comparison takes only what is ticked: a value of the other source in place of yours, and not a book unticked', async () => {
	const mine = JSON.stringify([
		{t: 'Salt Road', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}, n: ['Hollis Marr']}]},
	]);
	const {els, get, readable} = await boot({page: 'import.html', files: {'books.json': mine}});
	const csv =
		'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\n' +
		'x,Salt Road,,Ann Vale,Ida Quell,Finished,B1\n' +
		'x,Brine Songs,,Ann Vale,,Finished,B2\n' +
		'x,Tidewater,,Ann Vale,,Finished,B3\n';
	const open = async () => {
		els.audibleImportBtn.listeners.click[0]();
		await idle();
		els.importCsvFile.listeners.change[0]({target: {files: [{name: 'library.csv', text: csv}], value: ''}});
		await idle();
	};
	const box = (pick: any) => els.importPreviewBody.querySelector(`input[data-pick="${pick}"]`)!;
	const tick = (pick: any, on: any) => {
		box(pick).checked = on;
		box(pick).dispatch('change');
	};
	await open();
	assert.match(
		readable(els.importPreviewBody.innerHTML),
		/Different in both \(1\)<\/h4>.*Salt Road — Ann Vale<\/span><ul><li><label class="cmpPick"><input type="checkbox" data-pick="patch:0:n:0"> Narrators: <span class="cmpHere">Hollis Marr<\/span> here, <span class="cmpThere">Ida Quell<\/span> on Audible<\/label>/,
	);
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');

	// tick none, then all, of the new books
	const [none] = els.importPreviewBody.querySelectorAll('button.cmpTick').filter(b => b.textContent === 'Tick none');
	none.listeners.click[0]();
	assert.equal(els.importConfirm.style.display, 'none');
	assert.equal(box('take:1').hasAttribute('checked'), false);
	els.importPreviewBody
		.querySelectorAll('button.cmpTick')
		.find(b => b.textContent === 'Tick all')!
		.listeners.click[0]();
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');

	tick('take:2', false);
	tick('patch:0:n:0', true);
	assert.equal(els.importConfirm.textContent, 'Apply 2 changes');
	els.importConfirm.listeners.click[0]();
	await idle();
	assert.deepEqual(get('CATALOG.books'), [
		{t: 'Salt Road', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B1'}, n: ['Ida Quell']}]},
		{t: 'Brine Songs', a: ['Ann Vale'], e: [{ext: {'audible.com': 'B2'}}]},
	]);
	assert.match(els.ioStatus.textContent, /^Added 1 book, changed 1 value\.$/);

	// the book left out is still new the next time
	await open();
	assert.match(readable(els.importPreviewBody.innerHTML), /New from Audible \(1\)<\/h4>.*Tidewater — Ann Vale/);
	assert.doesNotMatch(els.importPreviewBody.innerHTML, /Different in both/);
});
test("a series' name ticked in a comparison renames the series, on all its books, keeping its id and details", async () => {
	const storage = new Map<string, string>();
	const mine = JSON.stringify([
		{t: 'Salt Road', a: ['Ann Vale'], s: 'Gull Isles', sn: '1', e: [{ext: {'audible.com': 'B1'}}]},
		{t: 'Paper Fen', a: ['Ann Vale'], s: 'Gull Isles', sn: '2', e: [{ext: {'audible.com': 'B2'}}]},
	]);
	const info = JSON.stringify({'Gull Isles': {total: 5, status: 'ongoing', note: 'Read in order.'}});
	const {els, readable} = await boot({
		page: 'import.html',
		storage,
		files: {'books.json': mine, 'series-info.json': info},
	});
	await settled(storage);
	const [{uid: id}] = databaseOf(storage).records('series');
	els.audibleImportBtn.listeners.click[0]();
	await idle();
	const csv =
		'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\n' +
		'x,Salt Road,The Gull Isle Saga,Ann Vale,,Finished,B1\n';
	els.importCsvFile.listeners.change[0]({target: {files: [{name: 'library.csv', text: csv}], value: ''}});
	await idle();
	assert.match(
		readable(els.importPreviewBody.innerHTML),
		/Series: <span class="cmpHere">Gull Isles<\/span> here, <span class="cmpThere">The Gull Isle Saga<\/span> on Audible \(renames the series, on 2 books\)/,
	);
	const box = els.importPreviewBody.querySelector('input[data-pick="patch:0:s"]')!;
	box.checked = true;
	box.dispatch('change');
	els.importConfirm.listeners.click[0]();
	await idle();
	const after = await kept(storage);
	assert.deepEqual(
		after.books.map((b: any) => [b.t, b.s]),
		[
			['Salt Road', 'The Gull Isle Saga'],
			['Paper Fen', 'The Gull Isle Saga'],
		],
	);
	assert.deepEqual(
		databaseOf(storage)
			.records('series')
			.map(r => [r.uid, r.name]),
		[[id, 'The Gull Isle Saga']],
	);
	assert.deepEqual(after.seriesInfo, {'The Gull Isle Saga': {total: 5, status: 'ongoing', note: 'Read in order.'}});
});
test("Goodreads CSV downloads every book for Goodreads' import", async () => {
	const {ctx, els, get} = await boot({page: 'import.html'});
	const blobs: string[] = [];
	ctx.Blob = class {
		constructor(parts: any) {
			blobs.push(parts.join(''));
		}
	};
	ctx.URL = {createObjectURL: () => 'blob:x', revokeObjectURL() {}};
	els.goodreadsExportBtn.listeners.click[0]();
	await idle();
	assert.equal(blobs[0], get('new CatalogConnectors.EXPORTERS[0]().write(CATALOG.books).text'));
	assert.match(blobs[0], /^Book Id,Title,Author,/);
	assert.match(els.ioStatus.textContent, new RegExp(`Goodreads CSV with ${demoBooks.length} books downloaded`));
});
test('the Backups panel says how old the last backup is, and the catalog page reminds you when it is getting old', async () => {
	const storage = new Map<string, string>();
	const imp = await boot({page: 'import.html', storage});
	await idle();
	assert.equal(imp.els.backupState.textContent, 'No backup downloaded in this browser yet.');
	imp.ctx.Blob = class {
		constructor() {}
	};
	imp.ctx.URL = {createObjectURL: () => 'blob:x', revokeObjectURL() {}};
	imp.els.exportBtn.listeners.click[0]();
	await idle();
	assert.equal(imp.els.backupState.textContent, 'Last backup today; nothing changed since.');
	const revision = JSON.parse(storage.get('audiobook-catalog-last-backup')!).revision;
	assert.equal(typeof revision, 'number');

	// a fresh backup: no reminder
	const fresh = await boot({storage});
	await idle();
	assert.equal(fresh.els.backupNudge.textContent, '');

	// three weeks and a change later
	storage.set(
		'audiobook-catalog-last-backup',
		JSON.stringify({time: new Date(Date.now() - 21 * 86400000).toISOString(), revision: revision - 1}),
	);
	const old = await boot({storage});
	await idle();
	assert.equal(
		old.els.backupNudge.textContent,
		'Last backup 21 days ago, and 1 change saved since: download one on Import & export.',
	);
	const later = await boot({page: 'import.html', storage});
	await idle();
	assert.equal(later.els.backupState.textContent, 'Last backup 21 days ago; 1 change saved since.');
});
test('Export includes series and author info, and Import brings them back', async () => {
	const first = await boot({page: 'import.html'});
	const blobs: string[] = [];
	first.ctx.Blob = class {
		constructor(parts: any) {
			blobs.push(parts.join(''));
		}
	};
	first.ctx.URL = {createObjectURL: () => 'blob:x', revokeObjectURL() {}};
	first.els.exportBtn.listeners.click[0]();
	await idle();
	const backup = JSON.parse(blobs[0]);
	// version 7: the stored records by store and id, without what is derived
	assert.deepEqual(Object.keys(backup), [
		'version',
		'books',
		'editions',
		'series',
		'contributors',
		'places',
		'marks',
		'exclusions',
	]);
	assert.equal(backup.version, 7);
	const byName = JSON.parse(JSON.stringify(Backup.toCatalog(backup)));
	assert.deepEqual(withoutIds(byName), {
		books: demoBooks,
		seriesInfo: JSON.parse(DEMO_INFO),
		authors: JSON.parse(DEMO_AUTHORS),
		narrators: JSON.parse(DEMO_NARRATORS),
		publishers: JSON.parse(DEMO_PUBLISHERS),
		places: {},
		excluded: [],
		notDuplicates: [],
	});
	assert.deepEqual(
		Object.keys(backup.books),
		first.get('CATALOG.books.map(b => b.id)'),
		"by the ids they are stored under, in the catalog's order",
	);
	const [firstId, firstBook] = Object.entries<any>(backup.books)[0];
	assert.deepEqual(
		Object.keys(firstBook).filter(k => !CatalogRecords.DERIVED.books!.includes(k)),
		Object.keys(firstBook),
		'nothing derived',
	);
	assert.equal(firstBook.title, first.get('CATALOG.books[0].title'));
	assert.ok(!('id' in firstBook) && firstId);
	assert.ok(
		firstBook.authorIds.every((id: any) => backup.contributors[id].kind === 'author'),
		'authors by id',
	);
	assert.ok(Object.values<any>(backup.books).every(b => b.editionIds.every((id: any) => backup.editions[id])));
	assert.equal(Object.keys(backup.series).length, new Set(demoBooks.map(b => b.s).filter(Boolean)).size);
	assert.ok(Object.values<any>(backup.contributors).some(c => c.kind === 'narrator'));

	// into a page that has no series info: it comes back, and survives a reload
	const mine = JSON.stringify([{t: 'Mine', a: ['Me']}]);
	const files = {'books.json': mine};
	const other = await boot({page: 'import.html', files});
	assert.deepEqual(other.get('[CATALOG.toJSON().seriesInfo, CATALOG.toJSON().authors]'), [{}, {}]);
	await other.els.importFile.listeners.change[0]({
		target: {files: [{name: 'b.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	assert.deepEqual(other.get('CATALOG.books'), demoBooks);
	assert.deepEqual(other.get('CATALOG.toJSON().seriesInfo'), byName.seriesInfo);
	assert.deepEqual(other.get('CATALOG.toJSON().authors'), byName.authors);
	assert.deepEqual(other.get('[CATALOG.toJSON().narrators, CATALOG.toJSON().publishers]'), [
		byName.narrators,
		byName.publishers,
	]);
	await other.saved();
	assert.deepEqual(
		other.database
			.records('books')
			.map(b => b.id)
			.sort(),
		Object.keys(backup.books).sort(),
		'the books keep their ids',
	);
	assert.deepEqual(
		other.database
			.records('series')
			.map(x => x.id)
			.sort(),
		Object.keys(backup.series).sort(),
	);
	assert.deepEqual(
		other.database
			.records('contributors')
			.map(x => x.id)
			.sort(),
		Object.keys(backup.contributors).sort(),
	);
	await boot({files, storage: other.storage});
	assert.deepEqual((await kept(other.storage)).seriesInfo, byName.seriesInfo);
	const reloaded = await kept(other.storage);
	assert.deepEqual(reloaded.authors, byName.authors);
	assert.deepEqual([reloaded.narrators, reloaded.publishers], [byName.narrators, byName.publishers]);

	// a backup from a newer version of the page is refused, saying so
	await other.els.importFile.listeners.change[0]({
		target: {
			files: [{name: 'b.json', text: JSON.stringify({...backup, version: Backup.VERSION + 1, books: {}})}],
			value: '',
		},
	});
	await idle();
	assert.match(other.els.ioStatus.textContent, /^Not restored: a newer version of the catalog made that backup/);
	assert.equal(other.get('CATALOG.books.length'), demoBooks.length);
	// nor one whose records don't fit together, which is named
	const broken = {...backup, books: {b1: {title: 'Lost', authorIds: ['nobody']}}};
	await other.els.importFile.listeners.change[0]({
		target: {files: [{name: 'b.json', text: JSON.stringify(broken)}], value: ''},
	});
	await idle();
	assert.equal(other.els.ioStatus.textContent, 'Not restored: no author is stored under nobody. Dismiss');
	assert.equal(other.get('CATALOG.books.length'), demoBooks.length);

	// an older backup (a plain list of books) still imports and keeps the current series and author info
	const legacy = await boot({page: 'import.html'});
	await legacy.els.importFile.listeners.change[0]({target: {files: [{name: 'b.json', text: mine}], value: ''}});
	await idle();
	assert.deepEqual(legacy.get('CATALOG.books'), [{t: 'Mine', a: ['Me']}]);
	assert.deepEqual(legacy.get('CATALOG.toJSON().seriesInfo'), JSON.parse(DEMO_INFO));
	assert.deepEqual(legacy.get('CATALOG.toJSON().authors'), JSON.parse(DEMO_AUTHORS));
	assert.deepEqual(legacy.get('CATALOG.toJSON().narrators'), JSON.parse(DEMO_NARRATORS));
});
test('Restore takes a backup of a catalog made apart from this one, with its series and people under other ids', async () => {
	const {els, database, storage, run, saved} = await boot({page: 'import.html'});
	await saved();
	run(`CATALOG.addExclusions(['BGONE'])`);
	await run('persist()');
	// this catalog's backup as another browser would have written it: the same names, each under an id of its own
	const other = (id: any) => 'other-' + id;
	const backup: Record<string, any> = {version: 5, exclusions: [], marks: {}};
	for (const store of ['books', 'editions', 'series', 'contributors'] as const) {
		backup[store] = {};
		// (a book's place in a backup is its place in the catalog)
		for (const rec of database.records(store).sort((x, y) => (x.position ?? 0) - (y.position ?? 0))) {
			const own = Object.fromEntries(
				Backup.FIELDS[store].filter((f: any) => rec[f] !== undefined).map((f: any) => [f, rec[f]]),
			);
			if (own.seriesId) own.seriesId = other(own.seriesId);
			for (const f of ['authorIds', 'narratorIds', 'publisherIds']) if (own[f]) own[f] = own[f].map(other);
			backup[store][store === 'series' || store === 'contributors' ? other(rec.id) : rec.id] = own;
		}
	}
	const before = await kept(storage);
	await els.importFile.listeners.change[0]({
		target: {files: [{name: 'backup.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	assert.match(els.ioStatus.textContent, /^Restored 13 books/);
	// stored, under the backup's ids, with nothing left of the ids before
	assert.deepEqual(await kept(storage), before);
	for (const store of ['series', 'contributors'])
		assert.ok(
			database.records(store).every(rec => rec.id.startsWith('other-')),
			store,
		);
	assert.deepEqual(
		database.records('exclusions').map(x => x.entry),
		['BGONE'],
		'the exclusions stay',
	);
});
test('Restore takes the data files of a catalog from before it lived in the browser, picked together', async () => {
	const {els, get, storage} = await boot({page: 'import.html', files: null});
	const books = [
		{t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1'},
		{t: 'Tide Water', a: ['Ann Vale']},
	];
	const pair = Duplicates.pairKey(Book.fromJSON(books[0]), Book.fromJSON(books[1]));
	await els.importFile.listeners.change[0]({
		target: {
			value: '',
			files: [
				{name: 'books.json', text: JSON.stringify(books)},
				{name: 'series-info.json', text: '{"Gull Isle":{"total":3,"status":"ongoing"}}'},
				{name: 'authors.json', text: '{"Ann Vale":{"bio":"Writes about the sea."}}'},
				{name: 'narrators.json', text: '{"Cy Hale":{"bio":"Reads sea stories."}}'},
				{name: 'excluded.txt', text: '# books imports skip\nBGONE\n'},
				{name: 'not-duplicates.txt', text: pair + '\n'},
			],
		},
	});
	assert.match(
		els.ioStatus.textContent,
		/^Restored 2 books and the release details of 1 series; 1 more excluded from imports\.$/,
	);
	assert.deepEqual(await kept(storage), {
		books,
		seriesInfo: {'Gull Isle': {total: 3, status: 'ongoing'}},
		authors: {'Ann Vale': {bio: 'Writes about the sea.'}},
		narrators: {'Cy Hale': {bio: 'Reads sea stories.'}},
		publishers: {},
		places: {},
		excluded: ['BGONE'],
		notDuplicates: [pair],
	});
	assert.deepEqual(get('CATALOG.markTexts()'), [pair]);
	assert.deepEqual(
		get('[...CATALOG.marks.values()].map(m => [m.kind, m.bookIds])'),
		[['notDuplicates', get('CATALOG.books.map(b => b.id).sort()')]],
		'pointing at the books restored',
	);
	assert.equal(els.dupCount.textContent, '');

	// without books.json, or with a file that is none of these, nothing changes
	for (const files of [
		[{name: 'series-info.json', text: '{}'}],
		[
			{name: 'books.json', text: '[]'},
			{name: 'notes.txt', text: 'hi'},
		],
	]) {
		await els.importFile.listeners.change[0]({target: {value: '', files}});
		await idle();
		assert.match(els.ioStatus.textContent, /Couldn't read that/);
		assert.equal(get('CATALOG.books.length'), 2);
	}
	// nor with a value the catalog has no place for, which is named
	await els.importFile.listeners.change[0]({
		target: {value: '', files: [{name: 'b.json', text: JSON.stringify({books: [{t: 'Odd', a: ['Me'], g: 5}]})}]},
	});
	await idle();
	assert.equal(
		els.ioStatus.textContent,
		"Not restored: fix these values in the backup first (they aren't what their field holds): book #0 ('Odd'): 'g'. Dismiss",
	);
	assert.equal(get('CATALOG.books.length'), 2);
});
test("Remove book on a book's Edit page asks once more, then removes it and opens its series' page, or Books", async () => {
	const mine = JSON.stringify([
		{t: 'Keep', a: ['Ann Vale']},
		{t: 'Gone', a: ['Ann Vale'], id: 'BGONE2'},
		{t: 'Fern 1', a: ['Bo Reed'], s: 'Fern Saga', sn: '1'},
	]);
	const edit = await bootEditBook('Gone', {files: {'books.json': mine}});
	const {els, ctx, storage} = edit;
	assert.ok(!els.bookRemoveBtn.hidden);
	els.bookRemoveBtn.listeners.click[0]();
	assert.equal(
		els.bookFormError.textContent,
		'This takes Gone out of the catalog, and imports will skip it. Press Remove book again to do it.',
	);
	assert.deepEqual(
		(await kept(storage)).books.map((b: any) => b.t),
		['Keep', 'Gone', 'Fern 1'],
		'nothing is removed yet',
	);
	await els.bookRemoveBtn.listeners.click[0]();
	await idle();
	assert.equal(ctx.location.assigned, 'books.html');
	assert.deepEqual(
		(await kept(storage)).books.map((b: any) => b.t),
		['Keep', 'Fern 1'],
	);
	assert.deepEqual((await kept(storage)).excluded, ['BGONE2', 'Gone | Ann Vale']);
	// a book in a series: its series' page, which stays
	const fern = await removeBook('Fern 1', {storage});
	assert.equal(fern.ctx.location.assigned, `index.html#series=${seriesIdOf(fern.get, 'Fern Saga')}`);
	// changes not saved yet are dropped, and it says so
	const keep = await bootEditBook('Keep', {storage});
	typeIn(keep.els, 'b0_g', 'Cozy');
	keep.els.bookRemoveBtn.listeners.click[0]();
	assert.match(keep.els.bookFormError.textContent, /imports will skip it \(your changes here are dropped\)\./);
});
test("Read today on a book's details adds today to its dates read, and Undo takes it off", async () => {
	const {els, get, storage} = await bootBook('The Salt Road');
	const id = get('BOOK_FILTER');
	els.results.querySelector('.readToday')!.dispatch('click');
	await idle();
	const today = get('Text.today()');
	assert.deepEqual(get(`CATALOG.book(${JSON.stringify(id)}).read`), ['2023-06-02', '2025-11-20', today].sort());
	assert.ok((await kept(storage)).books.find((b: any) => b.t === 'The Salt Road').r.includes(today));
	assert.doesNotMatch(els.results.innerHTML, /readToday/, 'read today already');
	assert.match(
		els.results.innerHTML,
		/<dd>2023-06-02, 2025-11-20, \d{4}-\d\d-\d\d <button type="button" class="startReading">/,
	);
	assert.equal(els.ioStatus.textContent, 'Read The Salt Road today. Undo');
	els.ioStatus.querySelector('.undo')!.dispatch('click');
	await idle();
	assert.deepEqual((await kept(storage)).books.find((b: any) => b.t === 'The Salt Road').r, [
		'2023-06-02',
		'2025-11-20',
	]);
	assert.match(els.results.innerHTML, /class="readToday">\+ Read today</);
});
test("+ Start reading on a book's details keeps where you are in it, until you finish it today or stop", async () => {
	const {els, get, storage} = await bootBook('The Salt Road');
	const id = get('BOOK_FILTER');
	const stored = async () => (await kept(storage)).books.find((b: any) => b.t === 'The Salt Road');
	const today = get('Text.today()');
	els.results.querySelector('.startReading')!.dispatch('click');
	await idle();
	assert.deepEqual((await stored()).cr, {since: today});
	assert.equal(els.ioStatus.textContent, 'Reading The Salt Road now. Undo');
	assert.doesNotMatch(els.results.innerHTML, /startReading/, 'read already');
	assert.match(els.results.innerHTML, new RegExp(`<p class="readingText">Reading now since ${today}</p>`));

	// the place you have come to, and how far that is by its one edition's length (10h 42m)
	els.readingAt.value = '3:12:45';
	els.readingSave.dispatch('click');
	await idle();
	assert.deepEqual((await stored()).cr, {since: today, at: 11565});
	assert.equal(els.ioStatus.textContent, 'At 3:12:45 in The Salt Road. Undo');
	assert.match(els.results.innerHTML, new RegExp(`Reading now since ${today}, at 3:12:45 \\(30%\\)</p>`));
	assert.equal(els.readingAt.value, '3:12:45');
	els.readingAt.value = 'half way';
	els.readingSave.dispatch('click');
	await idle();
	assert.match(els.ioStatus.textContent, /Not a place in the book: half way\. Use h:mm:ss/);
	assert.deepEqual((await stored()).cr, {since: today, at: 11565}, 'unchanged');

	// finished today: a date read, and no longer reading it; Undo puts both back
	els.readingDone.dispatch('click');
	await idle();
	let book = await stored();
	assert.deepEqual([book.r, book.cr], [['2023-06-02', '2025-11-20', today].sort(), undefined]);
	assert.equal(els.ioStatus.textContent, 'Finished The Salt Road today. Undo');
	els.ioStatus.querySelector('.undo')!.dispatch('click');
	await idle();
	book = await stored();
	assert.deepEqual([book.r, book.cr], [['2023-06-02', '2025-11-20'], {since: today, at: 11565}]);
	assert.deepEqual(get(`CATALOG.book(${JSON.stringify(id)}).reading`), {since: today, at: 11565});

	// stop reading: no date read added
	els.readingStop.dispatch('click');
	await idle();
	book = await stored();
	assert.deepEqual([book.r, book.cr], [['2023-06-02', '2025-11-20'], undefined]);
	assert.match(els.results.innerHTML, /class="startReading">\+ Start reading</);
});
test('removing a book excludes it from imports, and Export / Import carry the exclusions', async () => {
	const mine = JSON.stringify([
		{t: 'Keep', a: ['Ann Vale']},
		{t: 'Gone', a: ['Ann Vale'], id: 'BGONE2'},
	]);
	const files = {'books.json': mine, 'excluded.txt': '# header\nBOLD\n'};
	const {ctx, get, storage} = await removeBook('Gone', {files});
	assert.deepEqual(get('CATALOG.books'), []);
	assert.equal(ctx.location.assigned, 'books.html');
	assert.deepEqual(
		(await kept(storage)).books.map((b: any) => b.t),
		['Keep'],
	);
	assert.deepEqual((await kept(storage)).excluded, ['BOLD', 'BGONE2', 'Gone | Ann Vale']);

	// on the import page, an import (Audible by id, or Goodreads by title) does not bring it back
	const imp = await boot({page: 'import.html', files, storage});
	imp.els.audibleImportBtn.listeners.click[0]();
	await idle();
	imp.els.importCsvFile.listeners.change[0]({
		target: {
			files: [
				{
					name: 'l.csv',
					text: 'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\nx,Gone,,Ann Vale,,Finished,BGONE2\n',
				},
			],
			value: '',
		},
	});
	await idle();
	assert.match(imp.els.importPreviewBody.innerHTML, /excluded from imports\): 1/);
	imp.els.goodreadsImportBtn.listeners.click[0]();
	await idle();
	imp.els.importCsvFile.listeners.change[0]({
		target: {
			files: [
				{
					name: 'g.csv',
					text: 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\nGone,Ann Vale,,Audible Audio,read,\n',
				},
			],
			value: '',
		},
	});
	await idle();
	assert.match(imp.els.importPreviewBody.innerHTML, /excluded from imports\): 1/);

	// a reload keeps the exclusions along with the edit
	await boot({files, storage});
	assert.deepEqual((await kept(storage)).excluded, ['BOLD', 'BGONE2', 'Gone | Ann Vale']);

	// Export has the whole list; Import adds it to another page's list
	const blobs: string[] = [];
	imp.ctx.Blob = class {
		constructor(parts: any) {
			blobs.push(parts.join(''));
		}
	};
	imp.ctx.URL = {createObjectURL: () => 'blob:x', revokeObjectURL() {}};
	imp.els.exportBtn.listeners.click[0]();
	await idle();
	const backup = JSON.parse(blobs[0]);
	assert.deepEqual(backup.exclusions, ['BGONE2', 'BOLD', 'Gone | Ann Vale'], 'a list, sorted');
	const other = await boot({page: 'import.html', files: {'books.json': '[]', 'excluded.txt': 'BOLD\nOther\n'}});
	await other.els.importFile.listeners.change[0]({
		target: {files: [{name: 'b.json', text: JSON.stringify(backup)}], value: ''},
	});
	await idle();
	assert.deepEqual(other.get('CATALOG.exclusions.entries'), ['BOLD', 'OTHER', 'BGONE2', 'Gone | Ann Vale']);
	assert.match(other.els.ioStatus.textContent, /2 more excluded from imports/);
});
test("a book's Edit page links back to the book, and Discard returns to it", async () => {
	const edit = await bootEditBook('The Drowned Chart');
	const {els, ctx, get} = edit;
	const id = get('BOOK_ID');
	assert.equal(ctx.location.hash, `#book=${id}`, 'an address by its title is turned into its id');
	assert.equal(els.subtitle.textContent, 'The Drowned Chart');
	assert.equal(els.backLink.getAttribute('href'), `book.html#book=${id}`);
	assert.equal(get('DRAFTS.length'), 1);
	assert.ok(!els.catalogPanel.hidden, 'the other catalogs are asked about it');
	els.discardBtn.listeners.click[0]();
	assert.equal(ctx.location.assigned, `book.html#book=${id}`);
	const none = await bootEditBook('No Such Book');
	assert.equal(none.els.subtitle.textContent, 'There is no such book in the catalog.');
	assert.equal(none.els.bookPanel.hidden, true);
});
test('with a book removed, edits of the others save to the right books, in another tab too', async () => {
	const mine = JSON.stringify([
		{t: 'First', a: ['Ann Vale']},
		{t: 'Second', a: ['Ann Vale']},
		{t: 'Third', a: ['Ann Vale']},
	]);
	const {storage} = await removeBook('First', {files: {'books.json': mine}});
	const second = await bootEditBook('Second', {storage});
	typeIn(second.els, 'b0_t', 'Second, Edited');
	assert.equal(await saveEdit(second), true);
	assert.deepEqual(
		(await kept(storage)).books.map((b: any) => b.t),
		['Second, Edited', 'Third'],
	);
	// another book removed while this one is open
	const again = await bootEditBook('Second, Edited', {storage});
	await removeBook('Third', {storage});
	typeIn(again.els, 'b0_t', 'Second, Again');
	assert.equal(await saveEdit(again), true);
	assert.deepEqual(
		(await kept(storage)).books.map((b: any) => b.t),
		['Second, Again'],
	);
});
test('series show which books are missing, and can be filtered to those; one without a note shows none', async () => {
	const {els, storage} = await boot();
	await idle();
	// (worked out on the Duplicates page, which holds the whole catalog)
	const whole = await boot({page: 'duplicates.html', storage});
	const info = JSON.parse(DEMO_INFO);
	const gaps = Object.keys(info).filter(name => whole.get(`CATALOG.missing(${JSON.stringify(name)})`).length);
	assert.ok(
		gaps.length > 0 && gaps.length < Object.keys(info).length,
		'the demo data should have a series with gaps and one without',
	);
	assert.match(els.results.innerHTML, /class="missing">missing #/);

	els.missingFilter.value = 'missing';
	els.missingFilter.listeners.change[0]();
	await idle();
	assert.equal((els.results.innerHTML.match(/class="srow-title"/g) || []).length, gaps.length); // no Standalone row either
	assert.equal(els.resultCount.textContent, `${gaps.length} series shown`);

	const {ctx: ctx2, els: els2, get: get2} = await boot();
	ctx2.openSeries(seriesIdOf(get2, gaps[0]));
	await idle();
	assert.match(els2.results.innerHTML, /class="series-note">[^<]*missing #/);

	// a series without a note shows none, never "undefined"
	const mine = JSON.stringify([{t: 'Gull Song', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [{n: ['Cy Hale']}]}]);
	const noNote = await boot({
		files: {'books.json': mine, 'series-info.json': JSON.stringify({'Gull Isle': {total: 5, status: 'ongoing'}})},
	});
	assert.match(noNote.els.results.innerHTML, /missing #/);
	assert.doesNotMatch(noNote.els.results.innerHTML, /undefined/);
});
test('a series and a book keep their ids in external catalogs, typed as an id or pasted as an address', async () => {
	const edit = await bootEdit('The Lantern Coast');
	const {els, get, storage} = edit;
	assert.equal(els.sf_ext_goodreads.value, '90001');
	assert.equal(els.sf_ext_hardcover.value, 'the-lantern-coast-sample');
	els.sf_ext_audible.value = 'https://www.audible.com/series/The-Lantern-Coast-Audiobooks/B0LANTERN1?ref=x';
	els.sf_ext_goodreads.value = '';
	assert.ok(await saveEdit(edit));
	// Hardcover's series by the name in its address, as no token is saved to look up its number
	assert.deepEqual(get("CATALOG.infoByName('series').get('The Lantern Coast').external"), {
		'audible.com': 'B0LANTERN1',
		hardcover: 'the-lantern-coast-sample',
	});
	assert.match(
		els.ioStatus.textContent,
		/^Saved The Lantern Coast\. Kept Hardcover's series by the name in its address, as no Hardcover API token is saved/,
	);
	assert.deepEqual((await kept(storage)).seriesInfo['The Lantern Coast'].ext, {
		'audible.com': 'B0LANTERN1',
		hardcover: 'the-lantern-coast-sample',
	});
	const series = await boot({storage, hash: '#series=The+Lantern+Coast'});
	assert.match(
		series.els.results.innerHTML,
		/<a class="authorlink" href="https:\/\/www\.audible\.com\/series\/B0LANTERN1" target="_blank" rel="noopener">Audible ↗<\/a>/,
	);
	// something that is neither is refused
	els.sf_ext_goodreads.value = 'https://www.goodreads.com/book/show/4242';
	assert.equal(await saveEdit(edit), false);
	assert.match(els.seriesFormError.textContent, /Goodreads: https:\/\/www\.goodreads\.com\/book\/show\/4242/);
	assert.ok(get('SERIES_ID'));

	// a book's Goodreads work, by its address, and its work on Open Library and its item on Wikidata
	const bookEdit = await bootEditBook(SALT_ROAD, {storage});
	await typeBookId(bookEdit.els, 'goodreads', 'https://www.goodreads.com/work/editions/990001-the-salt-road');
	assert.equal(bookEdit.get("DRAFTS[0].book.idOn('goodreads')"), '990001');
	bookEdit.els.b0_ext_openlibrary.value = 'https://openlibrary.org/works/OL123W/The_Salt_Road';
	await typeBookId(bookEdit.els, 'wikidata', 'q1001');
	assert.equal(await saveEdit(bookEdit), true);
	assert.deepEqual((await kept(storage)).books[0].ext, {
		goodreads: '990001',
		openlibrary: 'OL123W',
		wikidata: 'Q1001',
	});
	const book = await bootBook(SALT_ROAD, {storage});
	assert.match(
		book.els.results.innerHTML,
		/<dt>Goodreads book<\/dt><dd><a href="https:\/\/www\.goodreads\.com\/work\/editions\/990001" target="_blank" rel="noopener">990001<\/a><\/dd>/,
	);
});
test("an address pasted into a series', person's or book's id field becomes the id when the field is left", async () => {
	const {els} = await bootEdit('The Lantern Coast');
	const leave = (input: any, value: any) => {
		input.value = value;
		input.dispatch('focusout');
		return input.value;
	};
	assert.equal(
		leave(els.sf_ext_audible, 'https://www.audible.com/series/The-Lantern-Coast-Audiobooks/B0LANTERN1?ref=x'),
		'B0LANTERN1',
	);
	assert.equal(leave(els.sf_ext_goodreads, ' https://www.goodreads.com/series/90002-the-lantern-coast '), '90002');
	assert.equal(
		leave(els.sf_ext_hardcover, 'https://hardcover.app/series/the-lantern-coast'),
		'the-lantern-coast',
		'the name in it, until Hardcover gives the number',
	);
	// another Audible site keeps its address, so the site isn't lost
	assert.equal(
		leave(els.sf_ext_audible, 'https://www.audible.co.uk/series/Lantern/B0LANTERN1?ref=x'),
		'https://www.audible.co.uk/series/B0LANTERN1',
	);
	// pasted into another catalog's field, it moves to that one's
	els.sf_ext_goodreads.value = '';
	assert.equal(leave(els.sf_ext_audible, 'https://www.goodreads.com/series/90003'), '');
	assert.equal(els.sf_ext_goodreads.value, '90003');
	// unless that one holds another id; what isn't an address there is left for Save to refuse
	assert.equal(
		leave(els.sf_ext_audible, 'https://www.goodreads.com/series/90004'),
		'https://www.goodreads.com/series/90004',
	);
	assert.equal(els.sf_ext_goodreads.value, '90003');
	assert.equal(
		leave(els.sf_ext_goodreads, 'https://www.goodreads.com/book/show/4242'),
		'https://www.goodreads.com/book/show/4242',
	);
	assert.equal(leave(els.sf_ext_goodreads, ''), '');

	// a book's ids, and a narrator's
	const book = await bootEditBook(SALT_ROAD);
	assert.equal(leave(book.els.b0_ext_openlibrary, 'https://openlibrary.org/works/OL123W/The_Salt_Road'), 'OL123W');
	assert.equal(leave(book.els.b0_ext_wikidata, 'https://www.wikidata.org/wiki/Q1001'), 'Q1001');
	const narrator = await boot({page: 'narrator.html', hash: '#n=Tobias+Frane'});
	narrator.els.creditBody.querySelector('.aedit')!.listeners.click[0]();
	assert.equal(
		leave(narrator.els.cf_ext_goodreads, 'https://www.goodreads.com/author/show/5150.Tobias_Frane'),
		'5150',
	);
});
test('a series is edited on its Edit series page, and removed from its books', async () => {
	const {ctx, els, get, storage} = await boot();
	const info = JSON.parse(DEMO_INFO);
	const [name] = Object.keys(info);
	assert.doesNotMatch(els.results.innerHTML, /sedit/, 'not in the overview');
	ctx.openSeries(seriesIdOf(get, name));
	await idle();
	const id = seriesIdOf(get, name);
	assert.match(
		els.results.innerHTML,
		new RegExp(
			`<div class="page-actions"><a class="sedit" data-series="${id}" href="edit\\.html#series=${id}">Edit</a></div></div>$`,
		),
		'at the end of the page of the series',
	);
	const books = await boot({page: 'books.html', storage});
	assert.doesNotMatch(books.els.results.innerHTML, /sedit|Compare with Hardcover/, 'nor in the list of all books');

	// the page starts from the current entry, and lists its books
	let edit = await bootEdit(name, {storage});
	assert.equal(edit.get('SERIES_ID'), id);
	assert.equal(edit.els.sf_name.value, name);
	assert.equal(edit.els.sf_total.value, String(info[name].total));
	assert.equal(edit.els.sf_status.value, info[name].status);
	assert.equal(edit.els.sf_note.value, info[name].note);
	assert.equal(edit.els.subtitle.textContent, name);
	assert.equal(edit.els.sf_url, undefined, 'a series keeps no site: its author or publisher does');
	const count = demoBooks.filter(b => b.s === name).length;
	assert.equal(edit.get('DRAFTS.length'), count);
	assert.equal(edit.els.changeCount.textContent, 'No changes yet');
	Object.assign(edit.els.sf_total, {value: '7'});
	Object.assign(edit.els.sf_status, {value: 'ongoing'});
	Object.assign(edit.els.sf_note, {value: '  book 8   is announced '});
	// Review & save lists what changes, and saves nothing until Save
	await edit.els.reviewBtn.listeners.click[0]();
	await idle();
	assert.ok(edit.els.reviewPanel.classList.contains('open'));
	assert.match(edit.els.reviewList.textContent, /Books released: 7/);
	assert.match(edit.els.reviewList.textContent, /Note: book 8 is announced/);
	assert.equal(edit.get(`CATALOG.infoByName('series').get(${JSON.stringify(name)}).total`), info[name].total);
	await edit.els.reviewSaveBtn.listeners.click[0]();
	await idle();
	assert.deepEqual(edit.get(`CATALOG.infoByName('series').get(${JSON.stringify(name)})`), {
		total: 7,
		status: 'ongoing',
		note: 'book 8 is announced',
	});
	assert.equal(edit.els.ioStatus.textContent, `Saved ${name}.`);
	assert.deepEqual((await kept(storage)).seriesInfo[name].total, 7);

	// invalid input is refused with a message, and nothing changes
	Object.assign(edit.els.sf_total, {value: 'lots'});
	Object.assign(edit.els.sf_note, {value: ''});
	assert.equal(await saveEdit(edit), false);
	assert.match(edit.els.seriesFormError.textContent, /total must be a positive integer/);
	assert.equal(edit.get(`CATALOG.infoByName('series').get(${JSON.stringify(name)}).total`), 7);
	// Discard puts back what is stored, and goes back to the series' page
	edit.els.discardBtn.listeners.click[0]();
	await idle();
	assert.equal(edit.els.sf_total.value, '7');
	assert.equal(edit.ctx.location.assigned, 'index.html#series=' + id);

	// a series with nothing kept about it gets it ("many" is allowed)
	const bare = demoBooks.map(b => b.s).find(s => s && !(s in info));
	assert.ok(bare, 'the demo data has a series without info');
	edit = await bootEdit(bare, {storage});
	assert.equal(edit.els.sf_total.value, '');
	Object.assign(edit.els.sf_total, {value: 'Many'});
	Object.assign(edit.els.sf_status, {value: 'complete'});
	Object.assign(edit.els.sf_note, {value: 'finished'});
	assert.ok(await saveEdit(edit));
	assert.deepEqual(edit.get(`CATALOG.infoByName('series').get(${JSON.stringify(bare)})`), {
		total: 'many',
		status: 'complete',
		note: 'finished',
	});

	// a status left unknown, or a total left empty, is kept out
	Object.assign(edit.els.sf_status, {value: ''});
	assert.ok(await saveEdit(edit));
	assert.deepEqual(edit.get(`CATALOG.infoByName('series').get(${JSON.stringify(bare)})`), {
		total: 'many',
		note: 'finished',
	});
	edit = await bootEdit(bare, {storage});
	assert.equal(edit.els.sf_status.value, '', 'unknown, not ongoing');

	// emptying every field keeps nothing about it, and the series stays
	for (const field of [edit.els.sf_total, edit.els.sf_note]) field.value = '';
	assert.ok(await saveEdit(edit));
	assert.equal(edit.els.seriesFormError.textContent, '');
	assert.equal(edit.get(`CATALOG.infoByName('series').has(${JSON.stringify(bare)})`), false);
	assert.equal(edit.els.ioStatus.textContent, `Saved ${bare}.`);
	assert.ok(
		databaseOf(storage)
			.records('series')
			.some(x => x.name === bare),
	);

	// Remove series warns first, then takes it off its books, which stay, and goes to every series
	edit = await bootEdit(name, {storage});
	edit.els.seriesRemoveBtn.listeners.click[0]();
	await idle();
	assert.equal(
		edit.els.seriesFormError.textContent,
		`This takes ${name} off its ${count} books, which stay in the catalog without a series or a number in it, and removes the series. Press Remove series again to do it.`,
	);
	assert.equal(
		edit.get(`CATALOG.books.filter(b => b.series === ${JSON.stringify(name)}).length`),
		count,
		'nothing changed yet',
	);
	await edit.els.seriesRemoveBtn.listeners.click[0]();
	await idle();
	assert.equal(edit.ctx.location.replaced, 'index.html');
	const saved = await kept(storage);
	assert.equal(saved.books.length, demoBooks.length);
	assert.equal(
		saved.books.filter((b: any) => b.s === name || (!b.s && b.sn)).length,
		0,
		'no series, and no number in it',
	);
	assert.equal(name in saved.seriesInfo, false);
	assert.equal(
		databaseOf(storage)
			.records('series')
			.some(x => x.id === id),
		false,
	);
});
test('a series kept by an id alone shows no total or status', async () => {
	const books = JSON.stringify([
		{t: 'Fern 1', a: ['Bo Reed'], s: 'Fern Saga', sn: '1'},
		{t: 'Fern 2', a: ['Bo Reed'], s: 'Fern Saga', sn: '2'},
	]);
	const files = {'books.json': books, 'series-info.json': JSON.stringify({'Fern Saga': {ext: {goodreads: '90009'}}})};
	const {ctx, els, get, storage} = await boot({files});
	assert.match(els.results.innerHTML, /Fern Saga<\/a> <span class="srow-owned">2 owned<\/span>/);
	ctx.openSeries(seriesIdOf(get, 'Fern Saga'));
	await idle();
	assert.match(els.results.innerHTML, /<span class="n">[^<]*<\/span> <a [^>]*goodreads/);
	const author = await boot({page: 'author.html', hash: '#a=Bo+Reed', storage, files: null});
	assert.match(
		author.readable(author.els.creditBody.innerHTML),
		/Fern Saga<\/a> <span class="n">2 owned<\/span><\/p>/,
	);
	for (const html of [els.results.innerHTML, author.els.creditBody.innerHTML])
		assert.doesNotMatch(html, /undefined|released total|owned of|class="status/);
});
test('a series no book is in any more stays, and can be removed', async () => {
	const books = JSON.stringify([
		{t: 'Fern 1', a: ['Bo Reed'], s: 'Fern Saga', sn: '1'},
		{t: 'Lone', a: ['Bo Reed']},
	]);
	const {get, storage} = await boot({files: {'books.json': books}});
	const id = seriesIdOf(get, 'Fern Saga');
	await removeBook('Fern 1', {storage, files: null});
	const home = await boot({storage, files: null});
	assert.match(home.els.results.innerHTML, /Fern Saga<\/a> <span class="srow-owned">no books yet<\/span>/);
	home.ctx.openSeries(id);
	await idle();
	assert.match(
		home.els.results.innerHTML,
		/No books in Fern Saga yet\.<\/p><div class="page-actions"><a class="sedit"/,
	);
	const edit = await bootEdit('Fern Saga', {storage, files: null});
	assert.equal(edit.get('DRAFTS.length'), 0);
	edit.els.seriesRemoveBtn.listeners.click[0]();
	assert.equal(
		edit.els.seriesFormError.textContent,
		'This removes Fern Saga, which no book is in. Press Remove series again to do it.',
	);
	await edit.els.seriesRemoveBtn.listeners.click[0]();
	await idle();
	await kept(storage);
	assert.deepEqual(databaseOf(storage).records('series'), []);
});
test('a series can be renamed on its Edit series page, on every book in it', async () => {
	const {storage} = await boot();
	const info = JSON.parse(DEMO_INFO);
	const [name] = Object.keys(info);
	const count = demoBooks.filter(b => b.s === name).length;
	assert.ok(count > 0);

	await kept(storage);
	const seriesId = databaseOf(storage)
		.records('series')
		.find(x => x.name === name).id;
	let edit = await bootEdit(name, {storage});
	const {els, get} = edit;
	assert.equal(els.sf_name.value, name);
	Object.assign(els.sf_name, {value: '  The Renamed   Saga '});
	assert.ok(await saveEdit(edit));
	assert.equal(get(`CATALOG.books.filter(b => b.series === 'The Renamed Saga').length`), count);
	assert.equal(get(`CATALOG.books.some(b => b.series === ${JSON.stringify(name)})`), false);
	assert.deepEqual(get(`CATALOG.infoByName('series').get('The Renamed Saga')`), info[name]);
	assert.equal(get(`CATALOG.infoByName('series').has(${JSON.stringify(name)})`), false);
	assert.equal(get('SERIES_ID'), seriesId, 'still the series shown, by its id');
	assert.equal(els.subtitle.textContent, 'The Renamed Saga');
	assert.match(els.ioStatus.textContent, new RegExp(`Renamed .* on ${count} book`));
	const saved = await kept(storage);
	assert.ok(saved.seriesInfo['The Renamed Saga']);
	assert.deepEqual(
		databaseOf(storage)
			.records('series')
			.filter(x => x.name === 'The Renamed Saga')
			.map(x => x.id),
		[seriesId],
		'it keeps its id',
	);
	assert.equal(saved.books.filter((b: any) => b.s === 'The Renamed Saga').length, count);

	// a series without info is renamed without having to add some
	const bare = demoBooks.map(b => b.s).find(s => s && !(s in info));
	const bareCount = demoBooks.filter(b => b.s === bare).length;
	edit = await bootEdit(bare, {storage});
	Object.assign(edit.els.sf_name, {value: 'Plain Renamed'});
	assert.ok(await saveEdit(edit));
	assert.equal(edit.els.seriesFormError.textContent, '');
	assert.equal(edit.get(`CATALOG.books.filter(b => b.series === 'Plain Renamed').length`), bareCount);
	assert.equal(edit.get(`CATALOG.infoByName('series').has('Plain Renamed')`), false);

	// an empty name is refused
	Object.assign(edit.els.sf_name, {value: '   '});
	assert.equal(await saveEdit(edit), false);
	assert.match(edit.els.seriesFormError.textContent, /Give the series a name/);

	// joining another series is said in the review, and its info gives way to this page's
	Object.assign(edit.els.sf_name, {value: 'The Renamed Saga'});
	await edit.els.reviewBtn.listeners.click[0]();
	await idle();
	assert.match(edit.els.reviewList.textContent, /already a series called The Renamed Saga: these books move into it/);
	assert.equal(edit.get(`CATALOG.books.filter(b => b.series === 'Plain Renamed').length`), bareCount);
	await edit.els.reviewSaveBtn.listeners.click[0]();
	await idle();
	assert.equal(edit.get(`CATALOG.books.filter(b => b.series === 'The Renamed Saga').length`), count + bareCount);
	assert.deepEqual(edit.get(`CATALOG.infoByName('series').get('The Renamed Saga')`), info[name]);
});
test('duplicates page: found, merged with the picked title, or kept apart', async () => {
	const mine = JSON.stringify([
		{
			t: 'The Salt Road',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '1',
			g: ['Fantasy'],
			e: [{ext: {'audible.com': 'B1'}}],
		},
		{
			t: 'Beacons',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '2',
			e: [{ext: {'audible.com': 'BBOX'}, p: 'Gull Audio'}],
		},
		{
			t: 'Salt Road',
			a: ['Marisol Quenby'],
			n: ['Tobias Frane'],
			s: 'Lantern Coast',
			sn: '1',
			r: ['2023-06-02'],
			e: [{ext: {goodreads: '4242'}}],
		},
		{
			t: 'The Drowned Chart',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '3',
			e: [{ext: {'audible.com': 'BBOX'}, p: 'Gull Audio'}],
		},
		{t: 'The Ledger', a: ['Priya Ostrander']},
		{t: 'The Ledger, Book 1', a: ['Priya Ostrander']},
	]);
	const files = {'books.json': mine};
	// every page's link says how many there are; a box set's titles share an edition but are not duplicates
	const home = await boot({files});
	assert.equal(home.els.dupCount.textContent, ' (2)');

	const {ctx, els, get, run, storage} = await boot({page: 'duplicates.html', files});
	// the books by the ids they are stored under
	const at = get('CATALOG.books.map(b => b.id)');
	assert.deepEqual(get('DUP_GROUPS'), [
		[at[0], at[2]],
		[at[4], at[5]],
	]);
	assert.match(els.subtitle.textContent, /^2 possible duplicates among 6 audiobooks/);
	assert.match(
		els.dupBody.innerHTML,
		/name="dup-0-title"[^>]*checked=""> <span class="dup-label">Title<\/span> The Salt Road/,
	);
	assert.match(els.dupBody.innerHTML, /Becomes: The Salt Road/);
	// what both entries have alike is said once, above them
	assert.match(
		els.dupBody.innerHTML,
		/<p class="dup-shared"><span class="dup-label">Author<\/span> Marisol Quenby · <span class="dup-label">Series<\/span> Lantern Coast #1<\/p>/,
	);
	assert.equal((els.dupBody.innerHTML.match(/dup-label">Author</g) || []).length, 2, 'once per group');

	// pick the second entry's title, then merge: one book with both editions, the narrator and the date read
	run('DUP_PICKS[0].title = 1; renderDuplicates()');
	assert.match(els.dupBody.innerHTML, /Becomes: Salt Road/);
	ctx.mergeGroup(0);
	assert.equal(get('CATALOG.books.length'), 5);
	assert.deepEqual(get('CATALOG.books[0]'), {
		t: 'Salt Road',
		a: ['Marisol Quenby'],
		s: 'Lantern Coast',
		sn: '1',
		g: ['Fantasy'],
		r: ['2023-06-02'],
		e: [{ext: {'audible.com': 'B1', goodreads: '4242'}, n: ['Tobias Frane']}],
	}); // Audible's and Goodreads' records of one edition
	assert.match(els.ioStatus.textContent, /^Merged 2 entries into Salt Road\./);
	assert.equal(get('CATALOG.exclusions.size'), 0); // the removed entry's ids live on in the kept book
	assert.deepEqual(
		get('CATALOG.books.map(b => b.id)'),
		[at[0], at[1], at[3], at[4], at[5]],
		'the book that came first is the one kept',
	);
	assert.deepEqual(get('DUP_GROUPS'), [[at[4], at[5]]]);
	assert.equal(els.dupCount.textContent, ' (1)');

	// "Not duplicates" is remembered in this browser, also after a reload
	ctx.keepApart(0);
	assert.match(els.dupBody.innerHTML, /No books look like duplicates/);
	assert.equal(els.dupCount.textContent, '');
	const again = await boot({page: 'duplicates.html', files, storage});
	assert.deepEqual(again.get('DUP_GROUPS'), []);
	assert.equal(again.get('CATALOG.books.length'), 5); // the merge was kept in this browser
});
test('Merge on a book finds the other book and opens the two on the duplicates page', async () => {
	const mine = JSON.stringify([
		{t: 'Ledger', a: ['Priya Ostrander']},
		{t: 'Other', a: ['Ann Vale']},
		{t: 'The Ledger', a: ['P. Ostrander'], r: ['2024']},
	]);
	const files = {'books.json': mine};
	const home = await bootBook('The Ledger', {files});
	const at = [0, 1, 2].map(i => bookIdAt(home.get, i));
	home.ctx.toggleMergeSearch(at[2]);
	assert.match(
		home.els.results.innerHTML,
		/class="merge" aria-expanded="true">Merge<\/button><\/div><div class="mergeSearch"><label for="mergeQuery">Find the book to merge it with<\/label><input type="search" id="mergeQuery"/,
	);
	// the book itself is not offered
	await home.ctx.findMergeBooks(at[2], 'ledger');
	assert.equal(
		home.els.mergeFound.innerHTML,
		`<li><a href="duplicates.html#merge=${at[2]},${at[0]}">Ledger</a> — Priya Ostrander</li>`,
	);
	await home.ctx.findMergeBooks(at[2], 'nothing like it');
	assert.equal(home.els.mergeFound.innerHTML, '<li class="none">No other book matches.</li>');
	home.ctx.toggleMergeSearch(at[2]);
	assert.doesNotMatch(home.els.results.innerHTML, /mergeSearch/);

	const {ctx, els, get} = await boot({
		page: 'duplicates.html',
		storage: home.storage,
		hash: `#merge=${at[2]},${at[0]}`,
	});
	assert.deepEqual(get('DUP_GROUPS'), [[at[0], at[2]]], 'in the order the catalog has them');
	assert.match(els.dupBody.innerHTML, /Picked by hand/);
	ctx.mergeGroup(0);
	assert.deepEqual(get('CATALOG.books'), [
		{t: 'Ledger', a: ['Priya Ostrander'], r: ['2024']},
		{t: 'Other', a: ['Ann Vale']},
	]);
	assert.equal(get('DUP_MANUAL'), null);
	assert.equal(ctx.location.hash, '');

	// an address naming no such books shows only what was found
	const stale = await boot({page: 'duplicates.html', storage: home.storage, hash: `#merge=${at[1]},no-such-book`});
	assert.deepEqual(stale.get('DUP_GROUPS'), []);
});
test('edits of different books in two tabs are both saved, and the same book edited in both is not', async () => {
	const files = {
		'books.json': JSON.stringify([
			{t: 'Mine', a: ['Me']},
			{t: 'Yours', a: ['You']},
			{t: 'Theirs', a: ['Them']},
		]),
	};
	const storage = new Map<string, string>();
	const one = await boot({page: 'books.html', files, storage});
	const two = await boot({page: 'duplicates.html', files, storage});
	await one.run("CATALOG.books[0].title = 'Edited Here'; persist();");
	await two.run("CATALOG.books[1].title = 'Edited There'; persist();");
	assert.equal(two.els.ioStatus.textContent, '');
	assert.deepEqual(
		(await kept(storage)).books.map((b: any) => b.t),
		['Edited Here', 'Edited There', 'Theirs'],
	);
	assert.equal(
		two.get('CATALOG.books[0].title'),
		'Edited Here',
		"the tab saving second took in the first one's edit",
	);

	// one tab removes a book and adds one; another tab's page takes that in once it saves an edit of its own
	const three = await bootBook('Theirs', {storage});
	const retitled = three.get('BOOK_FILTER');
	await two.run(
		"CATALOG.books.splice(0, 1); CATALOG.books.push(new Book({title: 'Added There', authors: ['Them']})); persist();",
	);
	await three.run("CATALOG.book(BOOK_FILTER).title = 'Retitled Here'; persist();");
	assert.deepEqual(
		(await kept(storage)).books.map((b: any) => b.t),
		['Edited There', 'Retitled Here', 'Added There'],
	);
	assert.equal(three.get('BOOK_FILTER'), retitled, 'the page still shows the book it was opened on');

	// both tabs change one book: the second save is refused, and nothing it held is written
	await three.run("CATALOG.book(BOOK_FILTER).title = 'Both Here'; persist();");
	await two.run("CATALOG.books[1].title = 'Both There'; CATALOG.books[0].title = 'Also There'; persist();");
	assert.match(two.els.ioStatus.textContent, /"Both There" changed in another tab too/);
	assert.deepEqual(
		(await kept(storage)).books.map((b: any) => b.t),
		['Edited There', 'Both Here', 'Added There'],
	);
	await three.run("CATALOG.book(BOOK_FILTER).title = 'Again Here'; persist();"); // the tab that saved last can keep going
	assert.equal((await kept(storage)).books[1].t, 'Again Here');
});
test('a save that is refused says so and goes no further: the Edit page stays, with what was not saved', async () => {
	const files = {
		'books.json': JSON.stringify([
			{t: 'Moss 1', a: ['Bo Reed'], s: 'Moss Saga', sn: '1'},
			{t: 'Moss 2', a: ['Bo Reed'], s: 'Moss Saga', sn: '2'},
		]),
	};
	const edit = await bootEdit('Moss Saga', {files});
	const {els, storage, run} = edit;
	assert.equal(await run('persist()'), true, 'a save that is kept says so');
	els.b0_t.value = 'Moss One';
	els.b0_t.listeners.change[0]();
	// another tab changes the same book meanwhile
	const other = await boot({page: 'books.html', files: null, storage});
	await other.run("CATALOG.books[0].title = 'Moss First'; persist();");
	assert.equal(await saveEdit(edit), true);
	assert.match(els.ioStatus.textContent, /^Not saved: "Moss One" changed in another tab too/);
	assert.equal(edit.ctx.location.assigned ?? null, null, 'the page stays');
	assert.equal(els.changeCount.textContent, '1 change', 'with the change not saved');
	assert.equal((await kept(storage)).books[0].t, 'Moss First');
	assert.equal(await run('persist()'), false);
});
test('merging keeps editions apart when asked, and books merged that way can be joined later', async () => {
	const mine = JSON.stringify([
		{
			t: 'The Salt Road',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '1',
			e: [{ext: {'audible.com': 'B1'}, len: 642}],
		},
		{
			t: 'Salt Road',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '1',
			e: [{ext: {goodreads: '4242'}, p: 'Gull Audio'}],
		},
		{
			t: 'Beacons',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '2',
			e: [{ext: {'audible.com': 'B2'}}, {ext: {goodreads: '777'}, isbn: '9780306406157'}],
		},
		{
			t: 'The Drowned Chart',
			a: ['Marisol Quenby'],
			s: 'Lantern Coast',
			sn: '3',
			e: [{ext: {'audible.com': 'B3'}}, {ext: {'audible.com': 'B3X'}}],
		},
		{t: 'Box Set', a: ['Marisol Quenby'], e: [{ext: {'audible.com': 'BBOX'}}, {ext: {goodreads: '888'}}]},
		{t: 'Other In Box', a: ['Marisol Quenby'], e: [{ext: {'audible.com': 'BBOX'}}]},
	]);
	const files = {'books.json': mine};
	const {ctx, els, get, run, storage} = await boot({page: 'duplicates.html', files});
	const at = get('CATALOG.books.map(b => b.id)');
	// Beacons (an ASIN edition and a Goodreads one) is listed; two ASINs, or a box set's shared edition, are not
	assert.deepEqual(get('SPLIT'), [at[2]]);
	assert.match(els.subtitle.textContent, /1 book with editions that look like one/);
	assert.equal(els.dupCount.textContent, ' (2)');
	assert.match(els.dupBody.innerHTML, /class="dup-joinbox" data-g="0" checked=""/);

	// untick "Make the editions one edition": the merge keeps both
	run('DUP_PICKS[0].joinEditions = false; renderDuplicates()');
	assert.match(els.dupBody.innerHTML, /class="dup-joinbox" data-g="0">/);
	ctx.mergeGroup(0);
	assert.deepEqual(get('CATALOG.books[0].editions'), [
		{ext: {'audible.com': 'B1'}, len: 642},
		{ext: {goodreads: '4242'}, p: ['Gull Audio']},
	]);
	// ...and the merged book is now offered for joining, like Beacons
	assert.deepEqual(get('SPLIT'), [at[0], at[2]]);
	ctx.joinBookEditions(at[0]);
	assert.deepEqual(get('CATALOG.books[0].editions'), [
		{ext: {'audible.com': 'B1', goodreads: '4242'}, p: ['Gull Audio'], len: 642},
	]);
	assert.match(els.ioStatus.textContent, /^The Salt Road now has one edition\./);
	// "Keep separate" is remembered in this browser
	ctx.keepEditionsApart(get('SPLIT[0]'));
	assert.deepEqual(get('SPLIT'), []);
	const again = await boot({page: 'duplicates.html', storage});
	assert.deepEqual(again.get('SPLIT'), []);
	assert.equal(again.els.dupCount.textContent, '');
});
