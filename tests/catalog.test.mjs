// Tests for the catalog's classes (public/modules): tidying, validation, the Audible and Goodreads readers,
// the merge, comparisons, duplicates, backups and Hardcover.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Text } from '../public/modules/text.js';
import { Isbn } from '../public/modules/isbn.js';
import { Edition } from '../public/modules/edition.js';
import { ExternalCatalog } from '../public/modules/external-catalog.js';
import { Book } from '../public/modules/book.js';
import { Series } from '../public/modules/series.js';
import { Contributor } from '../public/modules/contributor.js';
import { Exclusions } from '../public/modules/exclusions.js';
import { Validator } from '../public/modules/validator.js';
import { Merger } from '../public/modules/merger.js';
import { Duplicates } from '../public/modules/duplicates.js';
import { Backup } from '../public/modules/backup.js';
import { Catalog } from '../public/modules/catalog.js';
import { Comparison } from '../public/modules/comparison.js';
import { Csv } from '../public/modules/csv.js';
import { Cover } from '../public/modules/cover.js';
import { AudibleImporter } from '../public/modules/audible-importer.js';
import { GoodreadsImporter } from '../public/modules/goodreads-importer.js';
import { GoodreadsExporter } from '../public/modules/goodreads-exporter.js';
import { HardcoverClient } from '../public/modules/hardcover-client.js';
import { HardcoverSync } from '../public/modules/hardcover-sync.js';
import { CatalogRecords } from '../public/modules/catalog-records.js';
import { CatalogDatabase, CatalogConflict } from '../public/modules/catalog-database.js';
import { fakeHardcover, hardcoverState } from './fake-hardcover.mjs';
import { FakeIndexedDB, FakeKeyRange } from './fake-indexeddb.mjs';

// Books are written here as they are stored ({t, a, s, sn, ..., e}), and compared that way: json() gives
// what toJSON() writes, so a Book, an Edition or a report of them compares with the stored form.
const json = x => JSON.parse(JSON.stringify(x));
const B = rec => Book.fromJSON(rec);
const Bs = recs => recs.map(B);
const E = rec => Edition.fromJSON(rec);
const book = (t, a = 'Author', extra = {}) => ({ t, a: [a], ...extra });
// A book's editions: ed({ asin: { 'audible.com': 'B1' } }, { gr: '7' }) -> { e: [{ asin: { 'audible.com': 'B1' } }, { gr: '7' }] }
const ed = (...editions) => ({ e: editions });
// The merge of imports, on books as stored: `books` gains what `incoming` has (changed in place, as stored),
// and the report lists books as stored.
const merge = (books, incoming, exclusions, opts) => {
	const list = Bs(books);
	const report = new Merger(list, exclusions, opts).merge(Bs(incoming));
	books.splice(0, books.length, ...json(list));
	return json(report);
};
// Merge a backup (as Export writes it) into a catalog made of books, series info, exclusions, marks and
// author info as stored; returns what Backup.mergeInto() made, as stored.
const mergeBackup = (books, info, exclusions, backup, prefer, notDuplicates, authors) => {
	const catalog = Catalog.fromJSON({ books, seriesInfo: info, authors: authors || {}, excluded: exclusions ? exclusions.entries : [],
		notDuplicates: [...(notDuplicates || [])] });
	const m = Backup.read(backup).mergeInto(catalog, prefer);
	return { ...json(m), seriesInfo: json(Object.fromEntries(m.series)), authors: json(Object.fromEntries(m.authors)) };
};
// "Not duplicates" marks as text (a backup's), as the catalog keeps them.
const textMarks = texts => new Map(texts.map(t => [Duplicates.textMark(t).id, Duplicates.textMark(t)]));
// The duplicate groups among books as stored, but for those `marks` (as text) keep apart.
const findDuplicates = (books, marks = []) => new Duplicates(Bs(books), textMarks(marks)).groups();

// ------------------------------------------------------------------ external catalogs
test('external catalogs: an id gives the address of its page, and the address gives the id back', () => {
	const pages = [
		['audible.com', 'edition', 'B0SALTROAD', 'https://www.audible.com/pd/B0SALTROAD'],
		['audible.co.uk', 'series', 'B0SERIES01', 'https://www.audible.co.uk/series/B0SERIES01'],
		['audible.de', 'author', 'B0AUTHOR01', 'https://www.audible.de/author/B0AUTHOR01'],
		['audible.com', 'narrator', 'Cy Hale', 'https://www.audible.com/search?searchNarrator=Cy%20Hale'],
		['audible.com', 'publisher', 'Gull Audio', 'https://www.audible.com/search?searchProvider=Gull%20Audio'],
		['amazon.com', 'edition', 'B0AMAZON01', 'https://www.amazon.com/dp/B0AMAZON01'],
		['amazon.co.uk', 'author', 'B0AUTHOR02', 'https://www.amazon.co.uk/stores/author/B0AUTHOR02'],
		['goodreads', 'book', '99', 'https://www.goodreads.com/work/editions/99'],
		['goodreads', 'edition', '4242', 'https://www.goodreads.com/book/show/4242'],
		['goodreads', 'series', '90001', 'https://www.goodreads.com/series/90001'],
		['goodreads', 'author', '7', 'https://www.goodreads.com/author/show/7'],
		['hardcover', 'book', '77', 'https://hardcover.app/id/book/77'],
		['hardcover', 'edition', '501', 'https://hardcover.app/id/edition/501'],
		['hardcover', 'series', '3101', 'https://hardcover.app/id/series/3101'],
		['hardcover', 'author', '4101', 'https://hardcover.app/id/author/4101'],
		['hardcover', 'narrator', '4102', 'https://hardcover.app/id/author/4102'],
		['hardcover', 'publisher', '5101', 'https://hardcover.app/id/publisher/5101'],
		// the name in the address, kept when Hardcover couldn't be asked for the number
		['hardcover', 'series', 'gull-isle', 'https://hardcover.app/series/gull-isle'],
		['hardcover', 'author', 'ann-vale', 'https://hardcover.app/authors/ann-vale'],
		['hardcover', 'publisher', 'gull-audio', 'https://hardcover.app/publishers/gull-audio'],
		['openlibrary', 'book', 'OL123W', 'https://openlibrary.org/works/OL123W'],
		['openlibrary', 'edition', 'OL456M', 'https://openlibrary.org/books/OL456M'],
		['openlibrary', 'author', 'OL789A', 'https://openlibrary.org/authors/OL789A'],
		['isfdb', 'book', '194342', 'https://www.isfdb.org/cgi-bin/title.cgi?194342'],
		['isfdb', 'edition', '1039718', 'https://www.isfdb.org/cgi-bin/pl.cgi?1039718'],
		['isfdb', 'series', '512', 'https://www.isfdb.org/cgi-bin/pe.cgi?512'],
		['isfdb', 'author', '77', 'https://www.isfdb.org/cgi-bin/ea.cgi?77'],
		['isfdb', 'publisher', '54977', 'https://www.isfdb.org/cgi-bin/publisher.cgi?54977'],
		['bookbrainz', 'book', '0a1b2c3d-0000-4000-8000-000000000001', 'https://bookbrainz.org/work/0a1b2c3d-0000-4000-8000-000000000001'],
		['bookbrainz', 'edition', '0a1b2c3d-0000-4000-8000-000000000002', 'https://bookbrainz.org/edition/0a1b2c3d-0000-4000-8000-000000000002'],
		['bookbrainz', 'series', '0a1b2c3d-0000-4000-8000-000000000003', 'https://bookbrainz.org/series/0a1b2c3d-0000-4000-8000-000000000003'],
		['bookbrainz', 'narrator', '0a1b2c3d-0000-4000-8000-000000000004', 'https://bookbrainz.org/author/0a1b2c3d-0000-4000-8000-000000000004'],
		['bookbrainz', 'publisher', '0a1b2c3d-0000-4000-8000-000000000005', 'https://bookbrainz.org/publisher/0a1b2c3d-0000-4000-8000-000000000005'],
		['wikidata', 'book', 'Q1001', 'https://www.wikidata.org/wiki/Q1001'],
		['wikidata', 'narrator', 'Q1002', 'https://www.wikidata.org/wiki/Q1002'],
		['wikidata', 'publisher', 'Q1003', 'https://www.wikidata.org/wiki/Q1003'],
	];
	for (const [catalog, kind, id, url] of pages) {
		assert.equal(ExternalCatalog.url(catalog, kind, id), url, `${catalog} ${kind}`);
		assert.deepEqual(ExternalCatalog.fromAddress(url, kind), { catalog, id }, url);
	}
	// the forms people paste: with a title, a query, without www or the scheme, on the phone site
	for (const [text, kind, catalog, id] of [
		['https://www.audible.co.uk/pd/The-Salt-Road-Audiobook/b0saltroad?qid=1', 'edition', 'audible.co.uk', 'B0SALTROAD'],
		['amazon.de/gp/product/B0AMAZON02', 'edition', 'amazon.de', 'B0AMAZON02'],
		['https://www.audible.com/series/The-Lantern-Coast-Audiobooks/B0SERIES01?ref=x', 'series', 'audible.com', 'B0SERIES01'],
		['https://www.audible.com/author/Ann-Vale/B0AUTHOR01', 'author', 'audible.com', 'B0AUTHOR01'],
		['https://www.audible.com/search?keywords=x&searchNarrator=Cy+Hale', 'narrator', 'audible.com', 'Cy Hale'],
		['https://m.goodreads.com/book/show/4242-the-salt-road', 'edition', 'goodreads', '4242'],
		['goodreads.com/author/show/7.Ann_Vale', 'author', 'goodreads', '7'],
		['https://hardcover.app/books/the-salt-road/editions/501', 'edition', 'hardcover', '501'],
		['https://hardcover.app/id/authors/4101/collections', 'author', 'hardcover', '4101'],
		['hardcover.app/authors/ann-vale/books?page=2', 'author', 'hardcover', 'ann-vale'],
		['https://openlibrary.org/works/OL123W/The_Salt_Road?edition=x', 'book', 'openlibrary', 'OL123W'],
		['openlibrary.org/books/ol456m', 'edition', 'openlibrary', 'OL456M'],
		['http://www.isfdb.org/cgi-bin/publisher.cgi?54977=', 'publisher', 'isfdb', '54977'],
		['isfdb.org/cgi-bin/title.cgi?194342', 'book', 'isfdb', '194342'],
		['https://m.wikidata.org/wiki/q1002', 'narrator', 'wikidata', 'Q1002'],
		['http://www.wikidata.org/entity/Q1001', 'book', 'wikidata', 'Q1001'],
	]) assert.deepEqual(ExternalCatalog.fromAddress(text, kind), { catalog, id }, text);
	// a page of another kind, another site, or no address at all names nothing
	for (const [text, kind] of [['https://www.goodreads.com/book/show/4242', 'series'], ['https://hardcover.app/books/the-salt-road', 'edition'],
		['https://www.kobo.com/dp/B0SALTROAD', 'edition'], ['B0SALTROAD', 'edition'], ['', 'author'], ['https://www.goodreads.com/author/show/ann', 'author'],
		['https://www.isfdb.org/cgi-bin/title.cgi?194342', 'edition'], ['https://openlibrary.org/works/OL123M', 'book'], ['https://www.wikidata.org/wiki/Q1001', 'edition']])
		assert.equal(ExternalCatalog.fromAddress(text, kind), null, text);
	// Goodreads has no publisher pages, so no publisher ids
	assert.equal(ExternalCatalog.url('goodreads', 'publisher', '1'), null);
	assert.equal(ExternalCatalog.siteOf('https://hardcover.app/books/the-salt-road'), 'hardcover');
	assert.equal(ExternalCatalog.siteOf('https://example.com/hardcover.app'), null);
	assert.equal(ExternalCatalog.siteOf('https://www.isfdb.org/cgi-bin/ea.cgi?77'), 'isfdb');
	// a Wikidata item doesn't say whether it is a book or an edition, so it is only ever the book's
	assert.equal(ExternalCatalog.url('wikidata', 'edition', 'Q1'), null);
	// every catalog says what it is
	for (const def of ExternalCatalog.ALL) assert.ok(def.description && Object.keys(def.kinds).length, def.key);
});

test('external catalogs: a Hardcover series or person is kept by its number, or by the name in its address as a fallback', () => {
	assert.ok(ExternalCatalog.isId('hardcover', 'author', '4101') && ExternalCatalog.isId('hardcover', 'author', 'ann-vale'));
	assert.ok(!ExternalCatalog.isFallbackId('hardcover', 'author', '4101'));
	assert.ok(ExternalCatalog.isFallbackId('hardcover', 'publisher', 'gull-audio'));
	assert.ok(!ExternalCatalog.isFallbackId('hardcover', 'book', 'tidewater'), 'a book has no fallback');
	assert.ok(!ExternalCatalog.isId('hardcover', 'series', 'not a slug'));
	assert.deepEqual(ExternalCatalog.readId('ann-vale', 'narrator', 'hardcover'), { catalog: 'hardcover', id: 'ann-vale' });
	assert.deepEqual(ExternalCatalog.problems({ hardcover: 'ann-vale' }, 'author'), { errors: [], warnings: [] }, 'a name kept before is still fine');
});

test('HardcoverClient.idBySlug finds the number of a series, author or publisher by the name in its address', async () => {
	const hc = fakeHardcover(hardcoverState());
	const client = new HardcoverClient('tok-123', hc.fetch, async () => {});
	assert.deepEqual(await HardcoverClient.idBySlug(client, 'series', 'the-lantern-coast'), { id: '3101', name: 'The Lantern Coast' });
	assert.deepEqual(await HardcoverClient.idBySlug(client, 'narrator', 'w-ashcombe'), { id: '4101', name: 'W. Ashcombe' }, 'one merged into another is that one');
	assert.deepEqual(await HardcoverClient.idBySlug(client, 'publisher', 'kestrel-row-audio'), { id: '5101', name: 'Kestrel Row Audio' });
	assert.equal(await HardcoverClient.idBySlug(client, 'author', 'nobody'), null);
	assert.deepEqual(hc.sent.map(s => s.query.split('(')[0]), ['query SeriesBySlug', 'query AuthorBySlug', 'query PublisherBySlug', 'query AuthorBySlug']);
	await assert.rejects(HardcoverClient.idBySlug(new HardcoverClient('bad', hc.fetch, async () => {}), 'author', 'x'), /refused your token/);
});

test('external catalogs: a form field takes an id or an address, and ids are tidied and checked', () => {
	assert.deepEqual(ExternalCatalog.readId(' 4242 ', 'edition', 'goodreads'), { catalog: 'goodreads', id: '4242' });
	assert.deepEqual(ExternalCatalog.readId('https://www.goodreads.com/book/show/4242.The_Salt_Road', 'edition', 'goodreads'), { catalog: 'goodreads', id: '4242' });
	assert.equal(ExternalCatalog.readId('https://hardcover.app/id/edition/501', 'edition', 'goodreads'), null, 'another catalog\'s address');
	assert.deepEqual(ExternalCatalog.readId('https://www.audible.co.uk/author/Ann-Vale/B0AUTHOR01', 'author', 'audible'), { catalog: 'audible.co.uk', id: 'B0AUTHOR01' }, 'the site the address is on');
	assert.deepEqual(ExternalCatalog.tidy({ goodreads: ' 7 ', 'audible.com': 'B0X' }), { 'audible.com': 'B0X', goodreads: '7' });
	assert.deepEqual(ExternalCatalog.problems({ hardcover: 'x' }, 'book').errors, ["'x' is not Hardcover's id of a book"]);
	assert.deepEqual(ExternalCatalog.problems({ hardcover: 'ann-vale' }, 'author'), { errors: [], warnings: [] });
	assert.deepEqual(ExternalCatalog.readId('ol456m', 'edition', 'openlibrary'), { catalog: 'openlibrary', id: 'OL456M' });
	assert.deepEqual(ExternalCatalog.readId('q1001', 'series', 'wikidata'), { catalog: 'wikidata', id: 'Q1001' });
	assert.deepEqual(ExternalCatalog.problems({ openlibrary: 'OL123W', wikidata: 'Q1' }, 'edition').errors,
		["'OL123W' is not Open Library's id of an edition", 'Wikidata has no edition pages, so no edition id']);
});

// ------------------------------------------------------------------ data
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'sample');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const loadBooks = file => Book.fixBooks(JSON.parse(read(file)));
const loadSeriesInfo = file => JSON.parse(read(file));
const loadContributors = file => JSON.parse(read(file));

test('demo data validates without errors or warnings', () => {
	assert.deepEqual(Validator.validate(loadBooks(path.join(DATA, 'books.json')), loadSeriesInfo(path.join(DATA, 'series-info.json'))),
		{ errors: [], warnings: [] });
	for (const kind of ['authors', 'narrators', 'publishers']) {
		assert.deepEqual(Validator.validateContributors(loadBooks(path.join(DATA, 'books.json')), kind, loadContributors(path.join(DATA, `${kind}.json`))),
			{ errors: [], warnings: [] }, kind);
	}
});

test('demo data has what the smoke test needs', () => {
	const books = loadBooks(path.join(DATA, 'books.json'));
	assert.ok(books.some(b => !b.s), 'needs standalone books');
	assert.ok(books.some(b => b.s), 'needs series');
});

// ------------------------------------------------------------------ model
test('series names: spelling variants are one series, different series stay apart', () => {
	const variants = ['Ember Coast', 'Ember Coast Series', 'The Ember-Coast series', 'ember coast'];
	assert.equal(new Set(variants.map(Series.norm)).size, 1);
	assert.equal(Series.norm('Salt-Marsh Hollow'), Series.norm('Salt Marsh Hollow'));
	assert.notEqual(Series.norm('The Harbor Guild'), Series.norm('The Ridge Guild'));
});

test('titles, authors and series in other scripts are told apart, and accents are forgiven', () => {
	assert.notEqual(Text.norm('Серый маяк'), Text.norm('Тихая гавань'));
	assert.equal(Text.norm('Тихая  Гавань!'), 'тихая гавань');
	assert.equal(Text.norm('Café Éclair'), Text.norm('Cafe Eclair'));
	assert.notEqual(Series.norm('Ледяной путь'), Series.norm('Звёздный берег'));
	assert.equal(Series.norm('Ледяной путь series'), Series.norm('Ледяной-путь'));
	assert.notEqual(Book.firstAuthor('Ивана Полярная'), Book.firstAuthor('Олег Северный'));

	// an import adds a second book in another script, keeps its own series, and sees no duplicates
	const books = [{ t: 'Серый маяк', a: ['Ивана Полярная'], s: 'Ледяной путь', sn: '1' }];
	const report = merge(books, [{ t: 'Тихая гавань', a: ['Олег Северный'], s: 'Звёздный берег', sn: '1' },
		{ t: 'Серый маяк', a: ['Ивана Полярная'] }]);
	assert.equal(report.added.length, 1);
	assert.equal(report.matched, 1);
	assert.deepEqual(books.map(b => b.s), ['Ледяной путь', 'Звёздный берег']);
	assert.deepEqual(findDuplicates(books), []);
	assert.deepEqual(findDuplicates([{ t: '漂流する灯台', a: ['北村 灯'] }, { t: '静かな港', a: ['北村 灯'] }]), []);
});

test('a title of only symbols matches nothing', () => {
	const books = [{ t: '???', a: ['Ann Vale'] }];
	assert.equal(merge(books, [{ t: '!!!', a: ['Ann Vale'] }]).added.length, 1);
	assert.deepEqual(findDuplicates(books), []);
	assert.ok(!Exclusions.parse('?? | Ann Vale').covers(B({ t: '!!', a: ['Ann Vale'] })));
});

test('"Not duplicates" marks made before other scripts were told apart still count', () => {
	const books = Bs([{ t: 'Sömnens hamn', a: ['Åsa Ek'] }, { t: 'Sömnens  hamn', a: ['Åsa Ek'], s: 'Ö' }]);
	assert.equal(new Duplicates(books).groups().length, 1);
	const old = Duplicates.pairKey(books[0], books[1], t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
	assert.notEqual(old, Duplicates.pairKey(books[0], books[1]));
	assert.deepEqual(new Duplicates(books, textMarks([old])).groups(), []);
});

test('first author ignores co-authors', () => {
	assert.equal(Book.firstAuthor('R.T. Hale, C.J. Marsh'), Book.firstAuthor('R.T. Hale'));
	assert.equal(Book.firstAuthor('Ann Vale and P.T. Vale'), Text.norm('Ann Vale'));
});

test('the series key survives a title edit', () => {
	const a = B({ t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5' });
	const b = B({ t: 'A Crown of Embers 5: A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers Series', sn: '5' });
	assert.deepEqual(a.keys().filter(k => b.keys().includes(k)), [a.keys()[0]]);
});

test('lookup keys are forgiving in one direction only', () => {
	const key = (...p) => JSON.stringify(p);
	const longForm = B({ t: 'A Crown of Embers 5: A Spark of Dawn', a: ['Ilse Marlowe'] });
	assert.ok(longForm.lookupKeys().includes(key('title', Text.norm('A Spark of Dawn'), Text.norm('Ilse Marlowe'))));
	const box = B({ t: 'Lantern of the Deep: Books 1-3', a: ['R.T. Hale'] });
	assert.ok(!box.lookupKeys().includes(key('title', Text.norm('Lantern of the Deep'), Text.norm('R.T. Hale'))));
});

test('names and text are tidied', () => {
	const cases = {
		'A.B. Quill': 'A. B. Quill', 'A. B. Quill': 'A. B. Quill', 'A.B.C. Quill': 'A. B. C. Quill',
		'Ann Vale, R.T. Hale': 'Ann Vale, R. T. Hale', 'R.T. Hale and P.Q. Vale': 'R. T. Hale and P. Q. Vale',
		'Ann Vale': 'Ann Vale', 'A. Quill': 'A. Quill', 'Quill, A.B.': 'Quill, A. B.',
	};
	for (const [raw, expected] of Object.entries(cases)) {
		assert.equal(Text.normalizeName(raw), expected, raw);
		assert.equal(Text.normalizeName(expected), expected, 'idempotent: ' + expected);
	}
	assert.equal(Text.tidy('  Ann    Vale \t'), 'Ann Vale');
	assert.equal(Text.tidy('Ann\u00a0Vale'), 'Ann Vale');
	assert.equal(Text.tidy('Ann\u200b Vale\ufeff'), 'Ann Vale');
	assert.equal(Text.tidy('Two\nlines'), 'Two lines');
	const rec = { t: 'A  Title ', a: ['A.B. Quill'], s: ' S ', sn: '1', g: ['Fantasy ', '  ', 'Cozy  Mystery'],
		...ed({ id: ' B0X', n: ['A.B.  Vale'], p: 'Gull  Audio', desc: ' UK   edition' }) };
	assert.deepEqual(Book.tidyJSON(rec), { t: 'A Title', a: ['A. B. Quill'], s: 'S', sn: '1', g: ['Fantasy', 'Cozy Mystery'],
		...ed({ ext: { 'audible.com': 'B0X' }, n: ['A. B. Vale'], p: 'Gull Audio', desc: 'UK edition' }) });
	assert.equal(rec.t, 'A  Title ', 'the input record is not modified');
});

test('exclusions accept ASINs and title | author pairs', () => {
	const ex = Exclusions.parse('# comment\nB012345678  # trailing note\nSome Title | Some Author\n\n');
	assert.ok(ex.covers(B({ t: 'x', a: ['y'], ...ed({ ext: { goodreads: '1' } }, { ext: { 'audible.com': 'B012345678' } }) })));
	assert.ok(ex.covers(B({ t: 'SOME title!', a: ['Some Author'] })));
	assert.ok(!ex.covers(B({ t: 'Other', a: ['Some Author'] })));
	assert.equal(Exclusions.parse('').size, 0);
});

test('exclusions list their entries, and a removed book gets entries that keep it out', () => {
	const ex = Exclusions.parse('# comment\nB012345678  # trailing note\nSome Title|Some Author\n');
	assert.deepEqual(ex.entries, ['B012345678', 'Some Title | Some Author']);
	// an entry already covered is not added twice, however it is spelled
	assert.equal(ex.add('B012345678'), null);
	assert.equal(ex.add('some title! | Some Author'), null);
	assert.equal(ex.add('  New   Title | Ann  # why '), 'New Title | Ann');
	assert.equal(ex.add('a\nb'), 'a b');     // never more than one line

	assert.deepEqual(B({ t: 'Gone', a: ['Ann Vale'], ...ed({ ext: { 'audible.com': 'B9' } }) }).exclusionEntries(), ['B9', 'Gone | Ann Vale']);
	const odd = B({ t: 'Book #2 | Part One', a: ['Ann Vale'] });
	const [entry] = odd.exclusionEntries();
	assert.equal(entry, 'Book 2 Part One | Ann Vale');
	assert.ok(Exclusions.parse(entry).covers(odd));
});

test('validation: a clean catalog passes; required fields, unknown keys, ids', () => {
	const clean = [{ t: 'A', a: ['B'], s: 'S', sn: '1', g: ['x'], ext: { hardcover: '77' }, ...ed({ ext: { 'audible.com': 'B0', goodreads: '1', hardcover: '5' }, isbn: '9780000000002', p: 'P', d: '2021-05', len: 600 }) }];
	assert.deepEqual(Validator.validate(clean, { S: { total: 3, status: 'ongoing', note: 'n' } }), { errors: [], warnings: [] });
	assert.equal(Validator.validate([{ t: '', a: ['x'] }, { t: 't', a: ['a'], bogus: 1 }, 'nope'], {}).errors.length, 3);
	assert.ok(Validator.validate([{ t: 't', a: ['a'], sn: '1' }], {}).errors.some(e => e.includes('no series')));
	// an old-style book-level id is an unknown key: fixBooks() turns it into an edition first
	assert.ok(Validator.validate([{ t: 't', a: ['a'], id: 'B0' }], {}).errors.some(e => e.includes("unknown key 'id'")));
	assert.ok(Validator.validate([{ t: '1', a: ['a'], ...ed({ ext: { 'audible.com': 'B0' } }) }, { t: '1', a: ['a'], ...ed({ ext: { 'audible.com': 'B0' } }) }], {}).errors.some(e => e.includes('duplicate ASIN B0')));
});

test('Goodreads ids: validated, excluded, and kept apart from ASINs', () => {
	assert.deepEqual(Validator.validate([{ t: 'A', a: ['B'], ...ed({ ext: { goodreads: '4242' } }) }], {}), { errors: [], warnings: [] });
	assert.ok(Validator.validate([{ t: 'A', a: ['B'], ...ed({ ext: { goodreads: 'show/4242' } }) }], {}).errors.some(e => e.includes("'show/4242' is not Goodreads's id of an edition")));
	assert.ok(Validator.validate([{ t: 'A', a: ['B'], ...ed({ ext: { goodreads: 4242 } }) }], {}).errors.some(e => e.includes("the id on 'goodreads' must be")));
	assert.ok(Validator.validate([{ t: '1', a: ['a'], ...ed({ ext: { goodreads: '7' } }) }, { t: '1', a: ['a'], ...ed({ ext: { goodreads: '7' } }) }], {}).errors.some(e => e.includes('duplicate Goodreads id 7')));

	assert.deepEqual(B({ t: 'Gone', a: ['Ann Vale'], ...ed({ ext: { 'audible.com': 'B9', goodreads: '4242' } }, { ext: { 'audible.com': 'B10' } }) }).exclusionEntries(), ['B9', 'B10', 'Goodreads 4242', 'Gone | Ann Vale']);
	const ex = Exclusions.parse('Goodreads 4242\ngr: 77  # the paperback\n');
	assert.deepEqual(ex.entries, ['Goodreads 4242', 'Goodreads 77']);
	assert.equal(ex.add('GOODREADS 4242'), null);
	assert.ok(ex.covers(B({ t: 'Renamed', a: ['Someone'], ...ed({ ext: { goodreads: '77' } }) })));
	assert.ok(!ex.covers(B(Book.fixBooks([{ t: 'Renamed', a: ['Someone'], ...ed({ id: '77' }) }])[0])), 'a Goodreads id is not an ASIN');
	assert.ok(!Exclusions.parse('4242\n').covers(B({ t: 'x', a: ['y'], ...ed({ ext: { goodreads: '4242' } }) })), 'a bare number is an ASIN, not a Goodreads id');
});

test('validation: series-info must be well formed, and may be for a series no book is in', () => {
	const books = [{ t: 't', a: ['a'], s: 'Real' }];
	const errors = Validator.validate(books, {
		Ghost: { total: 2, status: 'ongoing', note: 'n' },
		Real: { total: 0, status: 'paused', note: '', url: 'https://example.com/', extra: 1 },
	}).errors.join('\n');
	assert.ok(!errors.includes('Ghost'), 'a series of its own, with no books');
	for (const needle of ['status must be', 'total must be', 'unknown keys']) {
		assert.ok(errors.includes(needle), needle);
	}
	assert.deepEqual(Validator.validate([{ t: 't', a: ['a'], s: 'S' }], { S: { total: 'many', status: 'ongoing', note: 'n' } }).errors, []);
});

test('validation: warnings for lookalike series, leftover markup, odd numbers, untidy values (once each)', () => {
	const warnings = Validator.validate([
		{ t: '1', a: ['a'], s: 'Ember Coast' }, { t: '2', a: ['a'], s: 'Ember Coast Series' },
		{ t: '3', a: ['a'], s: 'Foo (book 1), Bar' }, { t: '4', a: ['a'], s: 'Odd', sn: '1, 1' },
	], {}).warnings.join('\n');
	for (const needle of ['look like the same series', 'leftover Audible markup', 'unusual series number']) {
		assert.ok(warnings.includes(needle), needle);
	}
	const untidy = Validator.validate([
		{ t: '1', a: ['A.B. Quill'], ...ed({ n: ['R.T.  Hale'] }) },
		{ t: '2', a: ['A.B. Quill'], s: 'Some  Series', g: ['Cozy  Mystery'] },
		{ t: 'Double  Title', a: ['Ann Vale'] },
	], {}).warnings.join('\n');
	assert.equal(untidy.split("author 'A.B. Quill'").length - 1, 1);
	for (const needle of ["use 'A. B. Quill'", "narrator 'R.T.  Hale'", "use 'R. T. Hale'", "series 'Some  Series'",
												"genre 'Cozy  Mystery'", "title 'Double  Title'"]) {
		assert.ok(untidy.includes(needle), needle);
	}
	assert.deepEqual(Validator.validate([{ t: 'Fine', a: ['A. B. Quill'], ...ed({ n: ['R. T. Hale'] }) }], {}).warnings, []);
});

test('dates read: full, month-only and year-only dates, in order', () => {
	const cases = {
		'2024-03-15': '2024-03-15', '2024/3/5': '2024-03-05', ' 2024-03 ': '2024-03', '2024': '2024',
		'2024-02-29': '2024-02-29', '2023-02-29': null, '2024-13': null, '2024-00-10': null, '15/03/2024': null, '': null,
	};
	for (const [raw, expected] of Object.entries(cases)) assert.equal(Text.parseDate(raw), expected, raw);
	assert.deepEqual(Text.parseDates('2025-01-02, 2021, 2025/1/2; nope'), { dates: ['2021', '2025-01-02'], bad: ['nope'] });
	assert.deepEqual(Text.parseDates('  '), { dates: [], bad: [] });

	assert.deepEqual(Validator.validate([{ t: 'A', a: ['B'], r: ['2021', '2024-03', '2025-01-02'] }], {}), { errors: [], warnings: [] });
	for (const r of [[], '2024-01-01', ['2024/01/01'], ['2023-02-29'], [2024]]) {
		assert.ok(Validator.validate([{ t: 'A', a: ['B'], r }], {}).errors.some(e => e.includes("'r' must be")), JSON.stringify(r));
	}
	assert.ok(Validator.validate([{ t: 'A', a: ['B'], r: ['2025-01-01', '2024-01-01'] }], {}).warnings.some(w => w.includes('not in order')));
});

test('dates read: a plain string becomes a list', () => {
	assert.deepEqual(Book.fixReadDates({ t: 'A', a: ['B'], r: '2024/3/15' }), { t: 'A', a: ['B'], r: ['2024-03-15'] });
	assert.deepEqual(Book.fixReadDates({ t: 'A', a: ['B'], r: '2025, 2021-06' }).r, ['2021-06', '2025']);
	assert.deepEqual(Book.fixReadDates({ t: 'A', a: ['B'], r: '  ' }), { t: 'A', a: ['B'] });
	assert.deepEqual(Book.fixReadDates({ t: 'A', a: ['B'], r: 'soon' }).r, ['soon']);   // left for validate() to report
	const listed = { t: 'A', a: ['B'], r: ['2024'] };
	assert.equal(Book.fixReadDates(listed), listed);
	assert.deepEqual(Book.tidyJSON({ t: 'A', a: ['B'], r: '2024-03-15' }).r, ['2024-03-15']);
	assert.deepEqual(Backup.read({ books: [{ t: 'A', a: ['B'], r: '2024' }], seriesInfo: {} }).books[0].read, ['2024']);
	assert.deepEqual(Backup.read([{ t: 'A', a: ['B'], r: '2024' }]).books[0].read, ['2024']);
	assert.deepEqual(Backup.read({ books: [], seriesInfo: {}, excluded: ['B9'] }).excluded, ['B9']);
	assert.equal(Backup.read({ books: [], seriesInfo: {} }).excluded, null);
	assert.throws(() => Backup.read({ books: [], excluded: 'B9' }), /excluded/);
	assert.throws(() => Backup.read({ books: [], excluded: [7] }), /excluded/);
});

// -------------------------------------------------------------------- CSV
test('CSV: BOM, quotes, doubled quotes, newlines in quotes, CRLF, short rows', () => {
	const rows = Csv.parse('\ufeffa,b,c\r\n1,"x, ""y""","multi\nline"\r\n\r\n2,plain\n3,mid"quote,\n');
	assert.deepEqual(rows, [
		{ a: '1', b: 'x, "y"', c: 'multi\nline' },
		{ a: '2', b: 'plain', c: undefined },
		{ a: '3', b: 'mid"quote', c: '' },
	]);
	assert.deepEqual(Csv.parse(''), []);
});

// ----------------------------------------------------------------- Audible
const HEADER = 'Title,Title Short,Series,Book Numbers,Authors,Narrators,Tags,Child Category,Progress,ASIN,Blurb\n';

test('Audible series field', () => {
	assert.deepEqual(AudibleImporter.parseSeriesField('Thornmere: Wardens (book 1), Thornmere (book 5)'), [['Thornmere: Wardens', '1'], ['Thornmere', '5']]);
	assert.deepEqual(AudibleImporter.parseSeriesField('Vera Stone, Ghost Hunter (book 3)'), [['Vera Stone, Ghost Hunter', '3']]);
	assert.deepEqual(AudibleImporter.parseSeriesField(''), []);
	assert.deepEqual(AudibleImporter.parseSeriesField(undefined), []);
	assert.deepEqual(AudibleImporter.parseSeriesField('The Aetherverse (book ), Side Projects (book 1)'), [['The Aetherverse', null], ['Side Projects', '1']]);
	assert.deepEqual(AudibleImporter.parseSeriesField('Brine Bound (books 1-4)'), [['Brine Bound', '1-4']]);
	assert.deepEqual(AudibleImporter.parseSeriesField('Just A Name'), [['Just A Name', null]]);
	for (const raw of ['Thornmere: Ferrymen (book 1), Thornmere (book 4)', 'Thornmere (book 4), Thornmere: Ferrymen (book 1)']) {
		assert.deepEqual(AudibleImporter.chooseSeries(AudibleImporter.parseSeriesField(raw)), ['Thornmere', '4', false]);
	}
	assert.deepEqual(AudibleImporter.chooseSeries([['A', '1'], ['B', '2']]), ['A', '1', true]);
	assert.deepEqual(AudibleImporter.chooseSeries([]), [null, null, false]);
});

test('Audible titles lose a trailing series number only when it matches', () => {
	assert.equal(AudibleImporter.cleanTitle('Lantern of the Deep 10', '10'), 'Lantern of the Deep');
	assert.equal(AudibleImporter.cleanTitle('Emberhart: 2', '2'), 'Emberhart');
	assert.equal(AudibleImporter.cleanTitle('Marsh Kisses', '1'), 'Marsh Kisses');
	assert.equal(AudibleImporter.cleanTitle('Mort', null), 'Mort');
	assert.equal(AudibleImporter.cleanTitle('7', '7'), '7');
	assert.equal(AudibleImporter.cleanTitle('Ember: Books 1-3', '1-3'), 'Ember: Books 1-3', 'a box set keeps its range');
});

test('Audible rows', () => {
	const base = { Title: 'T', 'Title Short': 'Ts', Authors: 'A', Progress: 'Finished', ASIN: 'B0000000A1' };
	const row = kw => ({ ...base, ...kw });
	const audible = new AudibleImporter();
	assert.deepEqual(json(audible.rowToBook(row({ Series: 'S (book 2)', Narrators: 'N', Tags: 'Fantasy, Magic' }))),
		[{ t: 'Ts', a: ['A'], s: 'S', sn: '2', g: ['Fantasy', 'Magic'], ...ed({ ext: { 'audible.com': 'B0000000A1' }, n: ['N'] }) }, null]);
	const [tidy] = audible.rowToBook(row({ Authors: 'A.B. Quill, Ann  Vale', Narrators: 'R.T.   Hale', Tags: 'Cozy  Mystery, Fantasy' }));
	assert.deepEqual([tidy.authors, tidy.editions[0].narrators, tidy.genres], [['A. B. Quill', 'Ann Vale'], ['R. T. Hale'], ['Cozy Mystery', 'Fantasy']]);
	assert.deepEqual(audible.rowToBook(row({ Progress: '3h left' })), [null, null]);
	assert.deepEqual(audible.rowToBook(row({ ASIN: 'B002V8N37Q' })), [null, null]);
	const [fallback] = audible.rowToBook(row({ Series: 'S', 'Book Numbers': '4, 1', 'Child Category': 'Epic' }));
	assert.deepEqual([fallback.number, fallback.genres], ['4', ['Epic']]);
	const [amb, warning] = audible.rowToBook(row({ Series: 'A (book 1), B (book 2)' }));
	assert.equal(amb.series, 'A');
	assert.match(warning, /several series/);
});

test('Audible export: BOM, quoted newlines and counts', () => {
	const result = new AudibleImporter().read('\ufeff' + HEADER
		+ 'T1,T1,S (book 1),1,Au,Na,"a, b",,Finished,B1,"multi\nline blurb"\n'
		+ 'T2,T2,,,Au,,,,1h left,B2,\n'
		+ 'Your First Listen,Your First Listen,,,Audible,,,,Finished,B002V8N37Q,\n'
		+ 'T3,T3,,,,,,,Finished,B3,\n');
	assert.deepEqual(result.books.map(b => b.title), ['T1']);
	assert.equal(result.skippedUnfinished, 1);
	assert.ok(result.warnings.some(w => w.includes('no author')));
});

test('Audible: a title holding its series is split when the Series column is empty', () => {
	const result = new AudibleImporter().read(HEADER + '"Second Wind: Fantasy Adventures, Book 2",,,,Ann,,,,Finished,B2,\n');
	assert.deepEqual(json(result.books), [{ t: 'Second Wind', a: ['Ann'], s: 'Fantasy Adventures', sn: '2', ...ed({ ext: { 'audible.com': 'B2' } }) }]);
});

// --------------------------------------------------------------- Goodreads
const GR_HEADER = 'Book Id,Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n';

test('Goodreads series formats', () => {
	const cases = {
		'Rains of Harrow (The Wayfarer Inn, #7)': ['Rains of Harrow', 'The Wayfarer Inn', '7'],
		"Frosted (Blaze, #6; Dana O'Hare, #1)": ['Frosted', 'Blaze', '6'],
		'Ballads and Brigands (Red Harbor #3)': ['Ballads and Brigands', 'Red Harbor', '3'],
		'Rift Clash: A LitRPG Adventure (Rift Universe, Book 8)': ['Rift Clash: A LitRPG Adventure', 'Rift Universe', '8'],
		'Parallel (Parallel, #1)': ['Parallel', 'Parallel', '1'],
		'The Ember Trilogy (Ember, #1-3)': ['The Ember Trilogy', 'Ember', '1-3'],
		'Gull Isle Omnibus (Gull Isle #4\u20136)': ['Gull Isle Omnibus', 'Gull Isle', '4-6'],
		'The Lamplighter': ['The Lamplighter', null, null],
	};
	for (const [raw, expected] of Object.entries(cases)) assert.deepEqual(Series.parseTitle(raw), expected, raw);
});

test('Goodreads titles with the series after a colon', () => {
	const cases = {
		'The First Adventure: Fantasy Adventures, Book 1': ['The First Adventure', 'Fantasy Adventures', '1'],
		'The First Adventure (Fantasy Adventures, #1)': ['The First Adventure', 'Fantasy Adventures', '1'],
		'The First Adventure: Fantasy Adventures, Book 1 (Fantasy Adventures, #1)': ['The First Adventure', 'Fantasy Adventures', '1'],
		'Salt Roads: A Tale of the Reach: Ember Coast, Book Three': ['Salt Roads: A Tale of the Reach', 'Ember Coast', '3'],
		'Glass Harbor: Tidewatch, Vol. 2.5': ['Glass Harbor', 'Tidewatch', '2.5'],
		// a colon part naming another series than the brackets stays in the title
		'Iron Gate: Wardens, Book 2 (Thornmere, #5)': ['Iron Gate: Wardens, Book 2', 'Thornmere', '5'],
		'Rift Clash: A LitRPG Adventure': ['Rift Clash: A LitRPG Adventure', null, null],
	};
	for (const [raw, expected] of Object.entries(cases)) assert.deepEqual(GoodreadsImporter.readTitle(raw), expected, raw);
	const result = new GoodreadsImporter().read(GR_HEADER + '4243,"The First Adventure: Fantasy Adventures, Book 1",Ann,,Audible Audio,read,\n');
	assert.deepEqual(json(result.books), [{ t: 'The First Adventure', a: ['Ann'], s: 'Fantasy Adventures', sn: '1', ...ed({ ext: { goodreads: '4243' } }) }]);
});

test('books imported with the series in the title are split on load, never changing a series', () => {
	const [plain, same, numbered, other, otherNumber, paren, nothing] = Book.fixBooks([
		{ t: 'The First Adventure: Fantasy Adventures, Book 1', a: ['Ann'] },
		{ t: 'The First Adventure: Fantasy Adventures, Book 1', a: ['Ann'], s: 'The Fantasy Adventures Series' },
		{ t: 'Second Wind: Fantasy Adventures, Book 2', a: ['Ann'], s: 'Fantasy Adventures', sn: '2', r: ['2024'] },
		{ t: 'Iron Gate: Wardens, Book 2', a: ['Ann'], s: 'Thornmere', sn: '5' },
		{ t: 'Second Wind: Fantasy Adventures, Book 2', a: ['Ann'], s: 'Fantasy Adventures', sn: '7' },
		{ t: 'Kept (Fantasy Adventures, #3)', a: ['Ann'] },
		{ t: 'Lantern (Unabridged)', a: ['Ann'] },
	]);
	assert.deepEqual(plain, { t: 'The First Adventure', a: ['Ann'], s: 'Fantasy Adventures', sn: '1' });
	assert.deepEqual(same, { t: 'The First Adventure', a: ['Ann'], s: 'The Fantasy Adventures Series', sn: '1' });
	assert.deepEqual(numbered, { t: 'Second Wind', a: ['Ann'], s: 'Fantasy Adventures', sn: '2', r: ['2024'] });
	assert.deepEqual(other, { t: 'Iron Gate: Wardens, Book 2', a: ['Ann'], s: 'Thornmere', sn: '5' });
	assert.deepEqual(otherNumber.t, 'Second Wind: Fantasy Adventures, Book 2');
	assert.deepEqual(paren, { t: 'Kept', a: ['Ann'], s: 'Fantasy Adventures', sn: '3' });
	assert.deepEqual(nothing, { t: 'Lantern (Unabridged)', a: ['Ann'] });
	// an exclusion written with the long title still keeps the book out
	assert.ok(Exclusions.parse('The First Adventure: Fantasy Adventures, Book 1 | Ann').covers(B(plain)));
});

test('Goodreads export: only read audio editions, with tidy names', () => {
	const result = new GoodreadsImporter().read(GR_HEADER
		+ '4242,"Kept (Series, #2)",Ann,Nate Narrator,Audible Audio,read,"urban-fantasy, witches",2024/03/15\n'
		+ '11,Paperback,Bob,,Paperback,read,\n'
		+ '12,Unread audio,Cy,,Audiobook,to-read,\n'
		+ '"=""77""",Some Book,A.B.  Quill,R.T. Hale,Audiobook,read,\n'
		+ ',No Id,Dee,,Audiobook,read,\n');
	assert.deepEqual(json(result.books), [
		{ t: 'Kept', a: ['Ann'], s: 'Series', sn: '2', g: ['urban-fantasy', 'witches'], r: ['2024-03-15'], ...ed({ ext: { goodreads: '4242' }, n: ['Nate Narrator'] }) },
		{ t: 'Some Book', a: ['A. B. Quill'], ...ed({ ext: { goodreads: '77' }, n: ['R. T. Hale'] }) },
		{ t: 'No Id', a: ['Dee'] },
	]);
	assert.equal(result.skippedUnfinished, 1);
});

test('Goodreads CSV: every book on the read shelf, one own edition\'s ids, the latest full date read', () => {
	const box = { ext: { 'audible.com': 'BBOX' }, isbn: '9781000000009' };
	const books = [
		{ ...book('Kept'), a: ['Ann Vale', 'Bo Reed'], s: 'Saga, Told', sn: '2', g: ['Science Fiction', 'Witches'],
			...ed({ ext: { 'audible.com': 'B1' }, p: 'Pub', d: '2019-04-02' }, { ext: { goodreads: '4242' }, isbn: '9780306406157', d: '2020' }), r: ['2024-03-15', '2025-01', '2023-06-02'] },
		book('Boxed One', 'Cy', { ...ed(box), r: ['2024'] }),
		book('Boxed Two', 'Cy', { ...ed(box, { ext: { goodreads: '9' } }) }),
		book('Say "hi"', 'Dee'),
	];
	const out = new GoodreadsExporter().write(Bs(books));
	assert.deepEqual([out.books, out.withoutIds, out.withoutDate], [4, 2, 3]);
	const rows = Csv.parse(out.csv);
	assert.deepEqual(rows[0], { 'Book Id': '4242', Title: 'Kept (Saga, Told, #2)', Author: 'Ann Vale', 'Additional Authors': 'Bo Reed',
		ISBN: '0306406152', ISBN13: '9780306406157', Publisher: '', Binding: 'Audiobook', 'Year Published': '2020',
		'Date Read': '2024/03/15', Bookshelves: 'science-fiction, witches', 'Exclusive Shelf': 'read', 'Read Count': '3' });
	// a box set's edition is on several titles, so its ids would file them all as the box set
	assert.deepEqual([rows[1]['ISBN13'], rows[1]['Binding'], rows[1]['Date Read'], rows[1]['Read Count']], ['', 'Audiobook', '', '1']);
	assert.equal(rows[2]['Book Id'], '9');
	// a missing date read is unknown, not unread: the book still goes on the read shelf
	assert.deepEqual([rows[3].Title, rows[3]['Exclusive Shelf'], rows[3]['Date Read']], ['Say "hi"', 'read', '']);

	// Goodreads' own import format, so our Goodreads import reads it back
	const back = new GoodreadsImporter().read(out.csv).books;
	assert.deepEqual(back.map(b => [b.title, b.series, b.number]), [['Kept', 'Saga, Told', '2'], ['Boxed One', undefined, undefined],
		['Boxed Two', undefined, undefined], ['Say "hi"', undefined, undefined]]);
});

// ------------------------------------------------------------------- merge
test('merge: new books are appended and the merge is idempotent', () => {
	const existing = [book('One')];
	const incoming = [book('One'), book('Two', 'Author', { ext: { 'audible.com': 'B2' } })];
	const report = merge(existing, incoming);
	assert.deepEqual(existing.map(b => b.t), ['One', 'Two']);
	assert.deepEqual([report.matched, report.added.length], [1, 1]);
	assert.equal(merge(existing, structuredClone(incoming)).added.length, 0);
	assert.equal(existing.length, 2);
});

test('merge: hand edits win but a missing id is filled in', () => {
	const existing = [book('A Spark of Dawn', 'Ilse Marlowe', { s: 'A Crown of Embers', sn: '5', g: ['Mine'] })];
	const report = merge(existing, [book('A Crown of Embers 5: A Spark of Dawn', 'Ilse Marlowe',
		{ s: 'A Crown of Embers Series', sn: '5', g: ['Theirs'], ...ed({ ext: { 'audible.com': 'B5' } }) })]);
	assert.deepEqual(existing, [{ t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5', g: ['Mine'], ...ed({ ext: { 'audible.com': 'B5' } }) }]);
	assert.equal(report.backfilled.length, 1);
});

test('merge: a Goodreads id matches a renamed book, and a missing one is filled in', () => {
	const existing = [book('Renamed By Hand', 'Author', ed({ ext: { goodreads: '4242' } })), book('No Id Yet', 'Author', ed({ ext: { 'audible.com': 'B77' } }))];
	const report = merge(existing, [book('Goodreads Title', 'Author', ed({ ext: { goodreads: '4242' } })), book('No Id Yet', 'Author', ed({ ext: { goodreads: '77' } }))]);
	assert.deepEqual(existing.map(b => [b.t, b.e]), [['Renamed By Hand', [{ ext: { goodreads: '4242' } }]], ['No Id Yet', [{ ext: { 'audible.com': 'B77', goodreads: '77' } }]]]);
	assert.deepEqual([report.added.length, report.goodreadsFilled.length, report.backfilled.length, report.editionsAdded.length], [0, 1, 0, 0]);
	assert.equal(merge(existing, [book('Renamed Again', 'Author', ed({ ext: { goodreads: '77' } }))]).added.length, 0);
});

test('merge: dates read are filled in on books without any, never replaced', () => {
	const existing = [book('Dated', 'Author', { r: ['2020-01-01'] }), book('Undated')];
	const report = merge(existing, [book('Dated', 'Author', { r: ['2024-03-15'] }), book('Undated', 'Author', { r: ['2024-04-01'] })]);
	assert.deepEqual(existing.map(b => b.r), [['2020-01-01'], ['2024-04-01']]);
	assert.deepEqual([report.datesFilled.length, report.added.length], [1, 0]);
	assert.equal(merge(existing, [book('Undated', 'Author', { r: ['2025-01-01'] })]).datesFilled.length, 0);
});

test('merge: ids, long titles, boxed sets, series spelling, exclusions, authors', () => {
	let existing = [book('Completely Renamed', 'Author', ed({ ext: { 'audible.com': 'B7' } }))];
	assert.equal(merge(existing, [book('Original Title', 'Author', ed({ ext: { 'audible.com': 'B7' } }))]).added.length, 0);

	existing = [book('A Crown of Embers', 'Ilse Marlowe')];
	merge(existing, [book('A Crown of Embers, Book 1', 'Ilse Marlowe', ed({ ext: { 'audible.com': 'B1' } }))]);
	assert.deepEqual([existing.length, existing[0].e], [1, [{ ext: { 'audible.com': 'B1' } }]]);

	existing = [book('Lantern of the Deep', 'R.T. Hale')];
	assert.equal(merge(existing, [book('Lantern of the Deep: Books 1-3', 'R.T. Hale')]).added.length, 1);

	existing = [book('One', 'Author', { s: 'Ember Coast', sn: '1' })];
	merge(existing, [book('Two', 'Author', { s: 'Ember Coast Series', sn: '2' }), book('Three', 'Author', { s: 'ember-coast', sn: '3' })]);
	assert.deepEqual([...new Set(existing.map(b => b.s))], ['Ember Coast']);

	existing = [];
	const ex = Exclusions.parse('B9\nRemoved Box Set | Author\n');
	const report = merge(existing, [book('Gone', 'Author', ed({ ext: { 'audible.com': 'B9' } })), book('Removed Box Set'), book('Fine')], ex);
	assert.deepEqual(existing.map(b => b.t), ['Fine']);
	assert.equal(report.excluded.length, 2);

	existing = [book('Dark', 'Ann')];
	merge(existing, [book('Dark', 'Bob')]);
	assert.equal(existing.length, 2);
});

// ------------------------------------------------------------------- ISBNs
// Real check digits, invented books: 978-0-00-000000-2 and friends.
const ISBN_A = '9780000000002', ISBN_B = '9781000000009', ISBN_BOX = '9780306406157';

test('ISBNs: ISBN-10 and ISBN-13, hyphens, prefixes and Goodreads quoting; bad check digits refused', () => {
	const cases = {
		'978-0-00-000000-2': ISBN_A, 'ISBN 9780000000002': ISBN_A, 'isbn-13: 978 0 00 000000 2': ISBN_A,
		'0-306-40615-2': ISBN_BOX, '="0306406152"': ISBN_BOX, '="9780306406157"': ISBN_BOX, '080442957x': '9780804429573',
		'9780000000003': null, '0306406153': null, '=""': null, '': null, 'B012345678': null, '1234567890123': null,
	};
	for (const [raw, expected] of Object.entries(cases)) assert.equal(Isbn.parse(raw), expected, raw);
	assert.deepEqual(Isbn.parseList(`${ISBN_A}, 0-306-40615-2; ${ISBN_A} nope`), { isbns: [ISBN_A, ISBN_BOX], bad: [`${ISBN_A} nope`] });
	assert.deepEqual(Isbn.parseList(`${ISBN_A} 0306406152`), { isbns: [ISBN_A, ISBN_BOX], bad: [] });
});

test('ISBNs: one per edition, so another ISBN becomes another edition, stored in the 13-digit form', () => {
	assert.deepEqual(Edition.splitIsbns({ ext: { 'audible.com': 'B1' }, isbn: '978-0-00-000000-2, 0306406152' }), [{ ext: { 'audible.com': 'B1' }, isbn: ISBN_A }, { isbn: ISBN_BOX }]);
	assert.deepEqual(Edition.splitIsbns({ ext: { 'audible.com': 'B1' }, n: ['Ann Vale'], isbn: [ISBN_A, '0-306-40615-2', ISBN_A] }), [{ ext: { 'audible.com': 'B1' }, isbn: ISBN_A, n: ['Ann Vale'] }, { isbn: ISBN_BOX }]);
	assert.deepEqual(Edition.splitIsbns({ ext: { 'audible.com': 'B1' }, isbn: ' ' }), [{ ext: { 'audible.com': 'B1' } }]);
	assert.deepEqual(Edition.splitIsbns({ ext: { 'audible.com': 'B1' }, isbn: 'soon' }), [{ ext: { 'audible.com': 'B1' }, isbn: 'soon' }]);   // left for validate() to report
	// the lists of ISBNs from before one ISBN per edition are migrated on load; an ISBN another edition has is that edition
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: ['B'], ...ed({ ext: { 'audible.com': 'B1' }, isbn: [ISBN_A, ISBN_B] }, { ext: { goodreads: '7' }, isbn: [ISBN_B] }) }])[0].e,
		[{ ext: { 'audible.com': 'B1' }, isbn: ISBN_A }, { ext: { goodreads: '7' }, isbn: ISBN_B }]);
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: ['B'], ...ed({ isbn: '978-0-00-000000-2' }) }])[0].e, [{ isbn: ISBN_A }]);
	assert.deepEqual(Book.tidyJSON({ t: 'A', a: ['B'], ...ed({ isbn: ['0-306-40615-2', ISBN_BOX, ' bad  one '] }) }).e, [{ isbn: ISBN_BOX }, { isbn: 'bad one' }]);
});

test('ISBNs: validation', () => {
	// several editions with an ISBN each, and the same ISBN on several books (a boxed set), are fine
	assert.deepEqual(Validator.validate([{ t: '1', a: ['A'], ...ed({ isbn: ISBN_A }, { isbn: ISBN_BOX }) }, { t: '2', a: ['A'], ...ed({ isbn: ISBN_BOX }) }], {}), { errors: [], warnings: [] });
	for (const isbn of [[ISBN_A], '', [], 9780000000002]) {
		assert.ok(Validator.validate([{ t: 'A', a: ['B'], ...ed({ isbn }) }], {}).errors.some(e => e.includes("'isbn' must be one ISBN")), JSON.stringify(isbn));
	}
	assert.ok(Validator.validate([{ t: 'A', a: ['B'], ...ed({ isbn: '9780000000003' }) }], {}).errors.some(e => e.includes('not a valid ISBN')));
	const { errors, warnings } = Validator.validate([{ t: 'A', a: ['B'], ...ed({ isbn: '978-0-00-000000-2' }, { ext: { 'audible.com': 'B1' }, isbn: ISBN_A }) }], {});
	assert.deepEqual(errors, []);
	assert.ok(warnings.some(w => w.includes(`as '${ISBN_A}'`)));
	assert.ok(warnings.some(w => w.includes(`lists ISBN ${ISBN_A} on two editions`)));
});

test('ISBNs are read from Audible and Goodreads exports', () => {
	const audible = new AudibleImporter();
	const [rec] = audible.rowToBook({ Title: 'T', Authors: 'A', Progress: 'Finished', ASIN: 'B1', ISBN10: '0306406152', ISBN13: ISBN_BOX });
	assert.deepEqual(json(rec.editions), [{ ext: { 'audible.com': 'B1' }, isbn: ISBN_BOX }]);
	const [two] = audible.rowToBook({ Title: 'T', Authors: 'A', Progress: 'Finished', ASIN: 'B1', ISBN10: '0306406152', ISBN13: ISBN_A });
	assert.deepEqual(json(two.editions), [{ ext: { 'audible.com': 'B1' }, isbn: ISBN_BOX }, { isbn: ISBN_A }], 'two different ISBNs are two editions');
	assert.equal('e' in json(audible.rowToBook({ Title: 'T', Authors: 'A', Progress: 'Finished', ISBN13: 'n/a' })[0]), false);
	const result = new GoodreadsImporter().read('Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf\n'
		+ 'With,Ann,"=""0306406152""","=""9780306406157""",Audible Audio,read\n'
		+ 'Without,Ann,"=""""","=""""",Audiobook,read\n');
	assert.deepEqual(json(result.books), [{ t: 'With', a: ['Ann'], ...ed({ isbn: ISBN_BOX }) }, { t: 'Without', a: ['Ann'] }]);
});

test('merge: ISBNs fill in the matching edition, another ISBN is another edition, and ISBNs never make two books one', () => {
	const existing = [book('One', 'Author', ed({ ext: { 'audible.com': 'B1' } })), book('Two')];
	const report = merge(existing, [book('One', 'Author', ed({ ext: { 'audible.com': 'B1' }, isbn: ISBN_A })), book('Two', 'Author', ed({ isbn: ISBN_BOX }))]);
	assert.deepEqual(existing.map(b => b.e), [[{ ext: { 'audible.com': 'B1' }, isbn: ISBN_A }], [{ isbn: ISBN_BOX }]]);
	assert.deepEqual([report.isbnsFilled.length, report.editionsAdded.length, report.added.length], [2, 0, 0]);
	const again = merge(existing, [book('One', 'Author', ed({ isbn: ISBN_B }))]);
	assert.deepEqual([again.isbnsFilled.length, again.editionsAdded.length], [0, 1]);
	assert.deepEqual(existing[0].e, [{ ext: { 'audible.com': 'B1' }, isbn: ISBN_A }, { isbn: ISBN_B }]);

	// a boxed set's ISBN on each of its books: they stay separate books, and the set itself is a new book
	const boxed = [book('First', 'Author', ed({ isbn: ISBN_BOX }))];
	const added = merge(boxed, [book('Second', 'Author', ed({ isbn: ISBN_BOX })), book('The Boxed Set', 'Author', ed({ isbn: ISBN_BOX }))]).added;
	assert.deepEqual(added.map(b => b.t), ['Second', 'The Boxed Set']);
});

test('exclusions by ISBN', () => {
	const ex = Exclusions.parse(`ISBN 978-0-00-000000-2  # read the paperback\n${ISBN_BOX}\n0306406152\nB012345678\n`);
	assert.deepEqual(ex.entries, [`ISBN ${ISBN_A}`, `ISBN ${ISBN_BOX}`, '0306406152', 'B012345678']);
	assert.equal(ex.add('isbn: 0-00-000000-0'), null);   // the ISBN-10 of 978-0-00-000000-2
	assert.ok(ex.covers(B({ t: 'x', a: ['y'], ...ed({ isbn: '9780000000002' }) })));
	assert.ok(ex.covers(B({ t: 'x', a: ['y'], ...ed({ isbn: ISBN_B }, { isbn: ISBN_BOX }) })));
	assert.ok(ex.covers(B({ t: 'x', a: ['y'], ...ed({ ext: { 'amazon.com': '0306406152' } }) })));   // a bare ISBN-10 is also an ASIN
	assert.ok(!ex.covers(B({ t: 'x', a: ['y'], ...ed({ isbn: ISBN_B }) })));

	const existing = [];
	const report = merge(existing, [book('Box Book 1', 'Author', ed({ isbn: ISBN_BOX })), book('Box Book 2', 'Author', ed({ isbn: ISBN_BOX })), book('Fine', 'Author', ed({ isbn: ISBN_B }))], ex);
	assert.deepEqual(existing.map(b => b.t), ['Fine']);
	assert.equal(report.excluded.length, 2);
});

test('missing books: gaps up to the released total, boxed sets fill their range, novellas do not', () => {
	const owned = Bs(['1', '2.5', '4-6', '9', 'x'].map(sn => book('T' + sn, 'A', { s: 'Brass Meadow', sn })));
	assert.deepEqual(Series.missingNumbers(owned, 8), [2, 3, 7, 8]);
	assert.deepEqual(Series.missingNumbers(owned, 5), [2, 3]);
	assert.deepEqual(Series.missingNumbers(Bs([book('One', 'A', { s: 'Brass Meadow', sn: '1-3' })]), 3), []);
	assert.equal(Series.missingNumbers(owned, 'many'), null);
	assert.equal(Series.missingNumbers(owned, undefined), null);
});

// ---------------------------------------------------------------- editions
test('editions: a book from before editions gets its ids and ISBNs as its first edition', () => {
	const [old] = Book.fixBooks([{ t: 'A', a: ['B'], id: 'B1', gr: '7', isbn: '978-0-00-000000-2', r: ['2024'] }]);
	assert.deepEqual(old, { t: 'A', a: ['B'], r: ['2024'], e: [{ ext: { 'audible.com': 'B1', goodreads: '7' }, isbn: ISBN_A }] });
	// half migrated by hand: the old fields fill in the edition with the same ASIN, or come first
	assert.deepEqual(Book.fixEditions({ t: 'A', a: ['B'], gr: '7', e: [{ ext: { 'audible.com': 'B2' } }, { ext: { 'audible.com': 'B1' }, isbn: ISBN_A }] }).e,
		[{ ext: { goodreads: '7' } }, { ext: { 'audible.com': 'B2' } }, { ext: { 'audible.com': 'B1' }, isbn: ISBN_A }]);
	assert.deepEqual(Book.fixEditions({ t: 'A', a: ['B'], id: 'B1', gr: '7', e: [{ ext: { 'audible.com': 'B1' }, p: 'P' }] }).e, [{ ext: { 'audible.com': 'B1', goodreads: '7' }, p: 'P' }]);
	assert.deepEqual(Book.fixEditions({ t: 'A', a: ['B'], e: [] }), { t: 'A', a: ['B'] });
	const current = { t: 'A', a: ['B'], e: [{ ext: { 'audible.com': 'B1' } }] };
	assert.deepEqual(Book.fixEditions(current), current);
	assert.deepEqual(json(Backup.read([{ t: 'A', a: ['B'], id: 'B1' }]).books[0].editions), [{ ext: { 'audible.com': 'B1' } }]);
});

test('editions: validation of fields, and of a box set edition shared by several titles', () => {
	const box = { ext: { 'audible.com': 'BBOX' }, isbn: ISBN_BOX, p: 'Gull Audio', len: 1200 };
	const clean = [{ t: 'Two', a: ['A'], s: 'S', sn: '2', e: [{ ext: { 'audible.com': 'B2' } }, box] }, { t: 'Three', a: ['A'], s: 'S', sn: '3', e: [{ ...box }] }];
	assert.deepEqual(Validator.validate(clean, {}), { errors: [], warnings: [] });

	const errors = Validator.validate([
		{ t: 'A', a: ['B'], e: [] }, { t: 'C', a: ['B'], e: [{}, { n: [''] }] },
		{ t: 'D', a: ['B'], e: [{ ext: { 'audible.com': 'B1' }, d: '15/03/2024', len: 12.5, extra: 1 }, 'nope'] },
		{ t: 'E', a: ['B'], e: [{ ext: { 'audible.com': 'B9' } }, { ext: { 'audible.com': 'B9' }, p: 'x' }] },
	], {}).errors.join('\n');
	for (const needle of ["'e' must be a non-empty list", 'edition #1: is empty', "edition #2: 'n' must be a non-empty list of narrators",
												"'d' must be a release date", "'len' must be",
												"unknown key 'extra'", 'edition #2: not an object', 'lists the edition with ASIN B9 twice']) {
		assert.ok(errors.includes(needle), needle);
	}
	const { warnings } = Validator.validate([{ t: 'Two', a: ['A'], e: [box] }, { t: 'Three', a: ['A'], e: [{ ...box, p: 'Other  Audio' }] }], {});
	assert.ok(warnings.some(w => w.includes('the edition with ASIN BBOX differs from its copy')));
	assert.ok(warnings.some(w => w.includes("publisher 'Other  Audio'")));
});

test('editions: length and release date are read from Audible, publisher and year from Goodreads', () => {
	const cases = { '11 hrs and 5 mins': 665, '11h 5m': 665, '45 min': 45, '10 hours': 600, '1 hr': 60, '11:05': 665, '0 min': null, 'soon': null, '': null };
	for (const [raw, expected] of Object.entries(cases)) assert.equal(Text.parseLength(raw), expected, raw);
	assert.deepEqual([642, 600, 45].map(Text.formatLength), ['10h 42m', '10h', '45m']);

	const [rec] = new AudibleImporter().rowToBook({ Title: 'T', Authors: 'A', Progress: 'Finished', ASIN: 'B1',
		Publishers: 'Gull  Audio', 'Release Date': '2021-05-04', Length: '10 hrs and 42 mins' });
	assert.deepEqual(json(rec.editions), [{ ext: { 'audible.com': 'B1' }, p: 'Gull Audio', d: '2021-05-04', len: 642 }]);
	const result = new GoodreadsImporter().read('Book Id,Title,Author,Binding,Exclusive Shelf,Publisher,Year Published,Original Publication Year\n'
		+ '4242,T,A,Audible Audio,read,Gull Audio,2021,1999\n');
	assert.deepEqual(json(result.books[0].editions), [{ ext: { goodreads: '4242' }, p: 'Gull Audio', d: '2021' }]);
});

test('merge: an edition fills in its match, a lone edition, or is added as another edition', () => {
	// Goodreads finds the book Audible added: its only edition gains the Goodreads id and publisher
	const existing = [book('One', 'Author', ed({ ext: { 'audible.com': 'B1' }, p: 'Mine' }))];
	let report = merge(existing, [book('One', 'Author', ed({ ext: { goodreads: '7' }, p: 'Theirs', d: '2021' }))]);
	assert.deepEqual(existing[0].e, [{ ext: { 'audible.com': 'B1', goodreads: '7' }, p: 'Mine', d: '2021' }]);
	assert.deepEqual([report.goodreadsFilled.length, report.detailsFilled.length, report.editionsAdded.length], [1, 1, 0]);

	// another ASIN is another edition; later imports fill in the one they share an ISBN with
	report = merge(existing, [book('One', 'Author', ed({ ext: { 'audible.com': 'B1UK' }, isbn: ISBN_B }))]);
	assert.deepEqual(existing[0].e, [{ ext: { 'audible.com': 'B1', goodreads: '7' }, p: 'Mine', d: '2021' }, { ext: { 'audible.com': 'B1UK' }, isbn: ISBN_B }]);
	assert.equal(report.editionsAdded.length, 1);
	report = merge(existing, [book('One', 'Author', ed({ ext: { goodreads: '8' }, isbn: ISBN_B }))]);
	assert.equal(report.editionsAdded.length, 0, 'the edition with that ISBN is filled in, not added again');
	assert.deepEqual(existing[0].e[1], { ext: { 'audible.com': 'B1UK', goodreads: '8' }, isbn: ISBN_B });
	assert.equal(merge(existing, [book('Renamed', 'Author', ed({ ext: { goodreads: '8' } }))]).added.length, 0, 'any edition finds the book');
	assert.equal(merge(existing, structuredClone([book('One', 'Author', ed({ ext: { goodreads: '8' }, isbn: ISBN_B }))])).editionsAdded.length, 0);
});

test('merge: a box set edition on several titles matches them, and is filled in on every copy', () => {
	const box = () => ({ ext: { 'audible.com': 'BBOX' } });
	const existing = [book('Two', 'Author', { s: 'S', sn: '2', ...ed(box()) }), book('Three', 'Author', { s: 'S', sn: '3', ...ed(box()) })];
	const report = merge(existing, [book('S: Books 2-3', 'Author', { s: 'S', sn: '2-3', ...ed({ ext: { 'audible.com': 'BBOX' }, p: 'Gull Audio' }) })]);
	assert.deepEqual([report.added.map(b => [b.t, b.sn]), report.matched], [[['S: Books 2-3', '2-3']], 1]);
	const filled = { ext: { 'audible.com': 'BBOX' }, p: 'Gull Audio', desc: 'S: Books 2-3' };
	assert.deepEqual(existing.map(b => b.e), [[filled], [filled], [filled]]);
	assert.notEqual(existing[0].e[0], existing[1].e[0], 'copies, not one shared object');

	// a book whose only edition is the box set gets its own edition rather than filling in the box set
	merge(existing, [book('Three', 'Author', ed({ ext: { goodreads: '33' } }))]);
	assert.deepEqual(existing[1].e, [filled, { ext: { goodreads: '33' } }]);
	assert.deepEqual(existing[0].e, [filled]);
});

test('merge: a box set is kept as its own book and becomes its titles, each with the same edition', () => {
	const existing = [
		book('Spark', 'Ann Vale', { s: 'Ember', sn: '1', ...ed({ ext: { 'audible.com': 'B1' }, n: ['Tobias Frane'] }) }),
		book('Flame', 'Ann Vale', { s: 'Ember', sn: '2', r: ['2023'] }),
		book('Other', 'Ann Vale', { s: 'Gull Isle', sn: '3' }),
	];
	const box = book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember Series', sn: '1-3', g: ['Fantasy'], r: ['2024-05-01'], ...ed({ ext: { 'audible.com': 'BBOX' }, n: ['Hollis Marr'] }) });
	const report = merge(existing, [box]);
	const set = { ext: { 'audible.com': 'BBOX' }, n: ['Hollis Marr'], desc: 'Ember: Books 1-3' };
	assert.deepEqual(existing.map(b => [b.t, b.sn, b.e, b.r]), [
		['Spark', '1', [{ ext: { 'audible.com': 'B1' }, n: ['Tobias Frane'] }, set], ['2024-05-01']],
		['Flame', '2', [set], ['2023']],
		['Other', '3', undefined, undefined],
		['Ember, Book 3', '3', [set], ['2024-05-01']],
		['Ember: Books 1-3', '1-3', [set], ['2024-05-01']],
	]);
	assert.deepEqual(existing[3], { t: 'Ember, Book 3', a: ['Ann Vale'], s: 'Ember', sn: '3', g: ['Fantasy'], r: ['2024-05-01'], e: [set] });
	assert.deepEqual(existing[4], { t: 'Ember: Books 1-3', a: ['Ann Vale'], s: 'Ember', sn: '1-3', g: ['Fantasy'], r: ['2024-05-01'], e: [set] });
	assert.deepEqual([report.added.map(b => b.t), report.editionsAdded.map(b => b.t), report.datesFilled.map(b => b.t), report.matched],
		[['Ember, Book 3', 'Ember: Books 1-3'], ['Spark', 'Flame'], ['Spark'], 1]);
	assert.deepEqual(report.boxSets, [{ title: 'Ember: Books 1-3', authors: ['Ann Vale'], titles: 2, added: 1 }]);
	assert.deepEqual(Validator.validate(existing, {}), { errors: [], warnings: [] });

	// the same set again changes nothing; Goodreads' copy of it fills in the edition on every title
	assert.deepEqual(merge(existing, [structuredClone(box)]).added, []);
	const gr = merge(existing, [book('The Ember Trilogy', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ ext: { goodreads: '99' } }) })]);
	assert.deepEqual(gr.added, []);
	assert.deepEqual([0, 1, 3, 4].map(i => existing[i].e.at(-1)), Array(4).fill({ ...set, ext: { ...set.ext, goodreads: '99' } }));
	assert.equal(existing.length, 5, 'the set found by its edition, though Goodreads names it otherwise');
	assert.equal(existing[0].e.length, 2, 'the title\'s own edition is left alone');

	// a single title imported later finds the title the set added
	assert.equal(merge(existing, [book('Ember Falls', 'Ann Vale', { s: 'Ember', sn: '3', ...ed({ ext: { 'audible.com': 'B3' } }) })]).added.length, 0);
	assert.deepEqual(existing[3].e, [{ ...set, ext: { ...set.ext, goodreads: '99' } }, { ext: { 'audible.com': 'B3' } }]);
});

test('merge: a box set already in the catalog as one book gains its titles; without ids or excluded it stays as is', () => {
	const whole = [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ ext: { 'audible.com': 'BBOX' } }) })];
	merge(whole, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ ext: { 'audible.com': 'BBOX' }, p: 'Gull Audio' }) })]);
	const set = { ext: { 'audible.com': 'BBOX' }, p: 'Gull Audio', desc: 'Ember: Books 1-3' };
	assert.deepEqual(whole, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', e: [set] }),
		...[1, 2, 3].map(n => book(`Ember, Book ${n}`, 'Ann Vale', { s: 'Ember', sn: String(n), e: [set] }))]);

	const none = [];
	merge(none, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ n: ['Hollis Marr'] }) })]);
	assert.deepEqual(none.map(b => b.sn), ['1-3'], 'nothing would tie the titles together');

	const kept = [];
	const report = merge(kept, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ ext: { 'audible.com': 'BBOX' } }) })], Exclusions.parse('BBOX\n'));
	assert.deepEqual([kept, report.excluded.length], [[], 4]);
});

test('collections: a range is a collection, sorted after the titles of its series', () => {
	assert.deepEqual(['1-3', ' 4-6 ', '2.5-3', '3', '3-3', '3-1', '', undefined].map(Series.range), [[1, 3], [4, 6], [2.5, 3], null, null, null, null, null]);
	assert.equal(B(book('Set', 'A', { s: 'S', sn: '1-3' })).isCollection(), true);
	assert.equal(B(book('Set', 'A', { sn: '1-3' })).isCollection(), false, 'no series, no collection');
	const books = Bs([book('Set B', 'A', { s: 'S', sn: '4-6' }), book('Set A', 'A', { s: 'S', sn: '1-3' }), book('Omnibus', 'A', { s: 'S', sn: '1-6' }),
		book('Three', 'A', { s: 'S', sn: '3' }), book('Loose', 'A', { s: 'S' }), book('One', 'A', { s: 'S', sn: '1' }), book('Novella', 'A', { s: 'S', sn: '1.5' })]);
	assert.deepEqual(books.sort(Book.bySeriesNumber).map(b => b.title), ['One', 'Novella', 'Three', 'Loose', 'Set A', 'Omnibus', 'Set B']);
	assert.deepEqual(new Catalog({ books }).authorWorks('A').series[0].books.map(b => b.title).slice(-3), ['Set A', 'Omnibus', 'Set B']);
});

test('merge: another Hardcover book found by a box set\'s edition on titles in a row is kept as their collection', () => {
	const box = () => ({ ext: { 'audible.com': 'BBOX', hardcover: '700' } });
	const books = [book('One', 'Ann Vale', { s: 'Gull Isle', sn: '1', ext: { hardcover: '71' }, ...ed(box()) }), book('Two', 'Ann Vale', { s: 'Gull Isle', sn: '2', ext: { hardcover: '72' }, ...ed(box()) })];
	const report = merge(books, [book('Gull Isle Duology', 'Ann Vale', { ext: { hardcover: '70' }, r: ['2025-02-02'], ...ed(box()) })], null, { allDates: true });
	assert.deepEqual(books[2], { t: 'Gull Isle Duology', a: ['Ann Vale'], s: 'Gull Isle', sn: '1-2', r: ['2025-02-02'], ext: { hardcover: '70' },
		e: [{ ext: { 'audible.com': 'BBOX', hardcover: '700' }, desc: 'Gull Isle Duology' }] });
	assert.deepEqual(books.map(b => b.r), Array(3).fill(['2025-02-02']));
	assert.deepEqual([report.added.length, report.boxSets.length], [1, 1]);
	// read again: the set finds itself, and reading it reads its titles
	merge(books, [book('Gull Isle Duology', 'Ann Vale', { ext: { hardcover: '70' }, r: ['2026-03-03'], ...ed(box()) })], null, { allDates: true });
	assert.deepEqual([books.length, books.map(b => b.r.at(-1))], [3, Array(3).fill('2026-03-03')]);
	// a title's own Hardcover book reads only that title, even when the box set's edition finds another title first
	merge(books, [book('Two', 'Ann Vale', { ext: { hardcover: '72' }, r: ['2026-04-04'], ...ed(box()) })], null, { allDates: true });
	assert.deepEqual(books.map(b => b.r.at(-1)), ['2026-03-03', '2026-04-04', '2026-03-03']);
	// exports: the set goes to Hardcover and Goodreads as the set's edition, its titles without it
	assert.deepEqual(HardcoverSync.planExport(Bs(books), []).add.map(a => [a.book, a.edition]), [[71, null], [72, null], [70, 700]]);
	const rows = Csv.parse(new GoodreadsExporter().write(Bs([book('One', 'Ann Vale', { s: 'Gull Isle', sn: '1', ...ed({ ext: { goodreads: '9' } }) }),
		book('Gull Isle Duology', 'Ann Vale', { s: 'Gull Isle', sn: '1-2', ...ed({ ext: { goodreads: '9' } }) })])).csv);
	assert.deepEqual(rows.map(r => r['Book Id']), ['', '9']);
});

test('boxSetBooks keeps each box set in the catalog as its own book and as its titles', () => {
	const tide = { ext: { 'audible.com': 'BTIDE' } }, ember = { ext: { 'audible.com': 'BEMBER' }, desc: 'Ember: Books 1-2' };
	const books = Bs([
		book('Tide: Books 1-3', 'Bo Lin', { s: 'Tide', sn: '1-3', r: ['2024'], ...ed({ ...tide }) }),
		book('Tide Two', 'Bo Lin', { s: 'Tide', sn: '2' }),
		book('Spark', 'Ann Vale', { s: 'Ember', sn: '1', r: ['2023', '2024'], ...ed({ ...ember }) }),
		book('Flame', 'Ann Vale', { s: 'Ember', sn: '2', r: ['2024'], ...ed({ ...ember }) }),
		book('Gap One', 'Cy Hale', { s: 'Gap', sn: '1', ...ed({ ext: { 'audible.com': 'BGAP' } }) }),   // not in a row: no set
		book('Gap Three', 'Cy Hale', { s: 'Gap', sn: '3', ...ed({ ext: { 'audible.com': 'BGAP' } }) }),
	]);
	const report = json(Merger.boxSets(books, Exclusions.parse('Tide, Book 3 | Bo Lin\n')));
	const tideSet = { ...tide, desc: 'Tide: Books 1-3' };
	assert.deepEqual(json(books.slice(6)), [
		book('Tide, Book 1', 'Bo Lin', { s: 'Tide', sn: '1', r: ['2024'], e: [tideSet] }),
		book('Ember: Books 1-2', 'Ann Vale', { s: 'Ember', sn: '1-2', r: ['2024'], e: [ember] }),
	]);
	assert.deepEqual(json(books[1].editions), [tideSet], 'a title there already gains the set\'s edition');
	assert.deepEqual([report.added.length, report.excluded.map(b => b.t)], [2, ['Tide, Book 3']]);
	assert.deepEqual(Validator.validate(json(books), {}).errors, []);
	// done once, there is nothing more to do
	const again = Merger.boxSets(books, Exclusions.parse('Tide, Book 3 | Bo Lin\n'));
	assert.deepEqual([again.added, again.boxSets], [[], []]);
	// with no description the set is named after its series
	const plain = Bs([book('A', 'X', { s: 'Saga', sn: '1', ...ed({ ext: { goodreads: '5' } }) }), book('B', 'X', { s: 'Saga', sn: '2', ...ed({ ext: { goodreads: '5' } }) })]);
	Merger.boxSets(plain);
	assert.deepEqual(json(plain[2]), book('Saga, Books 1-2', 'X', { s: 'Saga', sn: '1-2', e: [{ ext: { goodreads: '5' } }] }));
});

test('Audible and Goodreads exports: a box set is read with its range', () => {
	const audible = new AudibleImporter().read('Title,Title Short,Authors,Series,Book Numbers,Progress,ASIN\n' +
		'"Ember: Books 1-3","Ember: Books 1-3",Ann Vale,"Ember (books 1-3)",1-3,Finished,BBOX\n');
	assert.deepEqual(json(audible.books), [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ ext: { 'audible.com': 'BBOX' } }) })]);
	const goodreads = new GoodreadsImporter().read(GR_HEADER + '99,"The Ember Trilogy (Ember, #1-3)",Ann Vale,,Audible Audio,read,,2024/05/01\n');
	assert.deepEqual(json(goodreads.books), [book('The Ember Trilogy', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ ext: { goodreads: '99' } }), r: ['2024-05-01'] })]);
});

test('editions as text: formatted for the card and read back from the form', () => {
	const edition = { ext: { 'audible.com': 'B0X', goodreads: '4242' }, isbn: ISBN_A, n: ['Ann Vale'], p: 'Gull Audio', d: '2021-05', len: 642, desc: 'UK edition' };
	const line = E(edition).format();
	assert.equal(line, `UK edition; Narrated by Ann Vale; ASIN audible.com B0X; Goodreads 4242; ISBN ${ISBN_A}; Publisher Gull Audio; Released 2021-05; Length 10h 42m`);
	assert.deepEqual(json(Edition.parse(line)), { editions: [edition], bad: [], book: {} });
	// text without a label is the description, once per edition; anything else unreadable is reported;
	// a second ISBN is another edition
	assert.deepEqual(json(Edition.parse(`asin: B1; isbn 978-0-00-000000-2, 0306406152; Dramatized adaptation\n\n${ISBN_B}; 2020; 45 min; narrator R. T. Hale\n`
		+ 'Audio CD; Goodreads x; second description\nDescription: First edition')), {
		editions: [{ ext: { 'audible.com': 'B1' }, isbn: ISBN_A, desc: 'Dramatized adaptation' }, { isbn: ISBN_BOX }, { isbn: ISBN_B, n: ['R. T. Hale'], d: '2020', len: 45 },
			{ desc: 'Audio CD' }, { desc: 'First edition' }],
		bad: ['Goodreads x', 'second description'], book: {},
	});
	// every catalog is named as the card names it, its edition's id or (with "book") the book's
	const ids = { goodreads: '4242', openlibrary: 'OL456M', isfdb: '1039718', bookbrainz: '0a1b2c3d-0000-4000-8000-000000000002' };
	assert.equal(E({ ext: ids }).format(), 'Goodreads 4242; Open Library OL456M; ISFDB 1039718; BookBrainz 0a1b2c3d-0000-4000-8000-000000000002');
	assert.deepEqual(json(Edition.parse(`${E({ ext: ids }).format()}; Open Library book OL123W; ISFDB edition https://www.isfdb.org/cgi-bin/pl.cgi?1039718=; Wikidata Q1`)),
		{ editions: [{ ext: ids }], bad: ['Wikidata Q1'], book: { openlibrary: 'OL123W' } });
});

test('ASINs by site: read from text, an ASIN without a site is audible.com\'s, and old "id" ASINs are audible.com\'s', () => {
	assert.deepEqual(Edition.parseAsins('audible.com B0ABCDEFG1, B0X1234567 (amazon.co.uk); https://www.amazon.de/dp/B0ZZZZZZZ9?ref=x'),
		{ asins: { 'audible.com': 'B0ABCDEFG1', 'amazon.co.uk': 'B0X1234567', 'amazon.de': 'B0ZZZZZZZ9' }, bad: [] });
	assert.deepEqual(Edition.parseAsins('https://www.audible.co.uk/pd/The-Salt-Road-Audiobook/B0SALTROAD?qid=1 b0lower001'),
		{ asins: { 'audible.co.uk': 'B0SALTROAD', 'audible.com': 'B0LOWER001' }, bad: [] });
	assert.deepEqual(Edition.parseAsins('B0ABCDEFG1', 'amazon.com'), { asins: { 'amazon.com': 'B0ABCDEFG1' }, bad: [] });
	// a second ASIN for one site, a site with no ASIN, or a shop that isn't Amazon's can't be read
	assert.deepEqual(Edition.parseAsins('audible.com B1, audible.com B2').bad, ['audible.com B2']);
	assert.deepEqual(Edition.parseAsins('audible.com').bad, ['audible.com']);
	assert.deepEqual(Edition.parseAsins('kobo.com B1').bad, ['kobo.com']);
	// shown with Audible's sites first
	assert.equal(E({ ext: { 'amazon.com': 'B2', 'audible.co.uk': 'B1' } }).format(), 'ASIN audible.co.uk B1, amazon.com B2');
	// an edition's ASIN from before sites ("id") is audible.com's
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: ['B'], e: [{ id: 'B1', gr: '7' }, { id: 'B2', asin: { 'amazon.com': 'B3' } }] }])[0].e,
		[{ ext: { 'audible.com': 'B1', goodreads: '7' } }, { ext: { 'audible.com': 'B2', 'amazon.com': 'B3' } }]);
	// one that disagrees with the audible.com ASIN it has is left for validate() to report
	const [odd] = Book.fixBooks([{ t: 'A', a: ['B'], e: [{ id: 'B1', asin: { 'audible.com': 'B2' } }] }]);
	assert.ok(Validator.validate([odd], {}).errors.some(e => e.includes("unknown key 'id'")));
	assert.ok(Validator.validate([book('A', 'B', ed({ ext: { 'kobo.com': 'B1' } }))], {}).warnings.some(e => e.includes("'kobo.com' is not an external catalog this app knows")));
	assert.ok(Validator.validate([book('A', 'B', ed({ ext: {} }))], {}).errors.some(e => e.includes("'ext' must map external catalogs to ids")));
	assert.ok(Validator.validate([book('A', 'B', ed({ ext: 'B1' }))], {}).errors.some(e => e.includes("'ext' must map")));
});

test('ASINs by site: each site may have its own, so only another ASIN on the same site is another edition', () => {
	const us = { ext: { 'audible.com': 'B1' } };
	assert.ok(E(us).sameAs(E({ ext: { 'amazon.com': 'B1' } })), 'the same ASIN on another site');
	assert.ok(!E(us).sameAs(E({ ext: { 'audible.com': 'B2' } })), 'another ASIN on audible.com');
	assert.ok(E({ ...us, ext: { ...us.ext, hardcover: '5' } }).sameAs(E({ ext: { 'amazon.com': 'B9', hardcover: '5' } })), 'another site\'s ASIN does not disagree');
	// a Hardcover import's amazon.com ASIN fills in the edition an Audible import added
	const books = [book('Tidewater', 'Ann Vale', { ext: { hardcover: '77' }, ...ed({ ext: { 'audible.com': 'B0TIDEWAT1' }, len: 600 }) })];
	const report = merge(books, [book('Tidewater', 'Ann Vale', { ext: { hardcover: '77' }, ...ed({ ext: { 'amazon.com': 'B0TIDEWAT9', hardcover: '501' } }) })]);
	assert.deepEqual(books[0].e, [{ ext: { 'audible.com': 'B0TIDEWAT1', 'amazon.com': 'B0TIDEWAT9', hardcover: '501' }, len: 600 }]);
	assert.deepEqual(report.backfilled, books);
	// and is found again by it
	assert.equal(merge(books, [book('Tide Water', 'Someone', ed({ ext: { 'amazon.co.uk': 'B0TIDEWAT9' } }))]).matched, 1);
	// an Audible export from another site keeps that site's ASINs
	const csv = 'Title,Authors,Progress,ASIN\nTidewater,Ann Vale,Finished,B0TIDEWATU\n';
	assert.deepEqual(json(new AudibleImporter('audible.co.uk').read(csv).books[0].editions), [{ ext: { 'audible.co.uk': 'B0TIDEWATU' } }]);
	assert.deepEqual(json(new AudibleImporter().read(csv).books[0].editions), [{ ext: { 'audible.com': 'B0TIDEWATU' } }]);
	// an ASIN in a Goodreads-style CSV is amazon.com's
	assert.deepEqual(json(new GoodreadsImporter().read('Book Id,Title,Author,Binding,Exclusive Shelf,ASIN\n42,Tidewater,Ann Vale,Audible Audio,read,B0TIDEWATA\n').books[0].editions),
		[{ ext: { 'amazon.com': 'B0TIDEWATA', goodreads: '42' } }]);
});

test('editions as fields: one field per part in the book form, each checked on its own', () => {
	const edition = { ext: { 'audible.com': 'B0X', goodreads: '4242', hardcover: '31337' }, isbn: ISBN_A, n: ['Ann Vale', 'Bo Reed'], p: 'Gull Audio', d: '2021-05', len: 642, desc: 'UK edition; abridged' };
	const fields = E(edition).fields();
	assert.deepEqual(fields, { desc: 'UK edition; abridged', n: 'Ann Vale, Bo Reed', 'ext:goodreads': '4242', 'ext:hardcover': '31337', isbn: ISBN_A, p: 'Gull Audio', d: '2021-05', len: '10h 42m', 'ext:audible.com': 'B0X' });
	assert.deepEqual(json(Edition.fromFields(fields)), { editions: [edition], bad: [], book: {} });
	// a field per site; a page's address gives its site's ASIN; another ASIN for a site that has one can't be read
	assert.deepEqual(json(Edition.fromFields({ 'ext:audible.co.uk': 'b0uk', 'ext:amazon.com': 'https://www.amazon.com/dp/B0AMAZON01' }).editions),
		[{ ext: { 'audible.co.uk': 'B0UK', 'amazon.com': 'B0AMAZON01' } }]);
	assert.deepEqual(json(Edition.fromFields({ 'ext:audible.com': 'B1, B2', 'ext:amazon.com': '' }).bad), ['ASIN audible.com B1, B2']);
	assert.ok(ExternalCatalog.ASIN_SITES.includes('amazon.se') && ExternalCatalog.ASIN_SITES.includes('audible.co.uk'));
	// empty fields are no edition; a second ISBN is another edition; an edition's address gives its id, a book's the book
	assert.deepEqual(json(Edition.fromFields({ desc: '  ', p: '' })), { editions: [], bad: [], book: {} });
	assert.deepEqual(json(Edition.fromFields({ isbn: '978-0-00-000000-2, 0306406152', 'ext:hardcover': 'https://hardcover.app/books/the-salt-road/editions/501' })),
		{ editions: [{ ext: { hardcover: '501' }, isbn: ISBN_A }, { isbn: ISBN_BOX }], bad: [], book: {} });
	assert.deepEqual(json(Edition.fromFields({ 'ext:audible.com': 'B1', 'ext:hardcover': 'https://hardcover.app/id/book/909' })), { editions: [{ ext: { 'audible.com': 'B1' } }], bad: [], book: { hardcover: '909' } });
	// what can't be read is reported with the field's name, and left out
	assert.deepEqual(json(Edition.fromFields({ 'ext:audible.com': 'B1', 'ext:goodreads': 'x', d: '2021-13', len: 'long', isbn: '978' })),
		{ editions: [{ ext: { 'audible.com': 'B1' } }], bad: ['Goodreads edition x', 'ISBN 978', 'Released 2021-13', 'Length long'], book: {} });	// a book's page on Goodreads gives its id
	assert.deepEqual(json(Edition.fromFields({ 'ext:goodreads': 'https://www.goodreads.com/book/show/4242-the-salt-road?ref=nav' }).editions), [{ ext: { goodreads: '4242' } }]);
});

test('idFromAddress: the id a pasted address names, and the field it goes in', () => {
	assert.deepEqual(Edition.idFromAddress('https://www.audible.co.uk/pd/The-Salt-Road-Audiobook/b0saltroad?qid=1'), { field: 'ext:audible.co.uk', id: 'B0SALTROAD' });
	assert.deepEqual(Edition.idFromAddress('https://www.amazon.com/The-Salt-Road/dp/B0AMAZON01/ref=sr_1_1'), { field: 'ext:amazon.com', id: 'B0AMAZON01' });
	assert.deepEqual(Edition.idFromAddress('amazon.de/gp/product/B0AMAZON02'), { field: 'ext:amazon.de', id: 'B0AMAZON02' });
	assert.deepEqual(Edition.idFromAddress(' https://www.goodreads.com/book/show/4242.The_Salt_Road '), { field: 'ext:goodreads', id: '4242' });
	assert.deepEqual(Edition.idFromAddress('goodreads.com/book/show/4242'), { field: 'ext:goodreads', id: '4242' });
	assert.deepEqual(Edition.idFromAddress('https://hardcover.app/books/the-salt-road/editions/501'), { field: 'ext:hardcover', id: '501' });
	// ids, a Hardcover book's address, a Goodreads work or another site's page name no edition
	for (const text of ['B0SALTROAD', '4242', '', 'https://hardcover.app/books/the-salt-road', 'https://www.goodreads.com/work/editions/99',
		'https://www.kobo.com/dp/B0SALTROAD']) assert.equal(Edition.idFromAddress(text), null, text);
});

test('saving a book keeps the copies of a shared edition in step', () => {
	const catalog = new Catalog({ books: Bs([
		book('Two', 'A', ed({ ext: { 'audible.com': 'BBOX' }, p: 'Gull Audio' }, { ext: { 'audible.com': 'B2' } })),
		book('Three', 'A', ed({ ext: { 'audible.com': 'BBOX' }, p: 'Gull Audio' })),
		book('Other', 'A', ed({ ext: { 'audible.com': 'B9' }, isbn: [ISBN_BOX] })),
	]) });
	catalog.books.forEach((b, i) => { b.id = `book-${i}`; });
	const books = () => json(catalog.books);
	// editing the box set on one title edits it on the other; an edition sharing only an ISBN is left alone
	assert.equal(catalog.saveBook('book-0', B(book('Two', 'A', ed({ ext: { 'audible.com': 'BBOX' }, p: 'Kestrel Audio', isbn: [ISBN_BOX] }, { ext: { 'audible.com': 'B2' } })))), 1);
	assert.deepEqual(books().map(b => b.e[0]), [{ ext: { 'audible.com': 'BBOX' }, p: 'Kestrel Audio', isbn: [ISBN_BOX] }, { ext: { 'audible.com': 'BBOX' }, p: 'Kestrel Audio', isbn: [ISBN_BOX] }, { ext: { 'audible.com': 'B9' }, isbn: [ISBN_BOX] }]);
	// a new title typed with the box set's ASIN is linked to it and gets its details
	const four = book('Four', 'A', ed({ ext: { 'audible.com': 'BBOX' }, len: 900 }));
	assert.equal(catalog.saveBook(null, B(four)), 2);
	assert.ok(catalog.books[3].id, 'a book added gets an id');
	assert.deepEqual(books()[3].e, [{ ext: { 'audible.com': 'BBOX' }, isbn: [ISBN_BOX], p: 'Kestrel Audio', len: 900 }]);
	assert.deepEqual(books()[1].e, books()[3].e);
	// removing the edition from one title leaves the others
	assert.equal(catalog.saveBook(catalog.books[3].id, B(book('Four', 'A'))), 0);
	assert.throws(() => catalog.saveBook('nobody', B(book('Five', 'A'))), /no book is stored under nobody/);
	assert.equal(books()[1].e[0].ext['audible.com'], 'BBOX');
});

// ------------------------------------------------------------------ duplicates
test('findDuplicates pairs books an import would match, but not a box set\'s titles', () => {
	const books = [
		book('The Salt Road', 'Marisol Quenby', { s: 'Lantern Coast', sn: '1', ...ed({ ext: { 'audible.com': 'B1' } }) }),
		book('Beacons', 'Marisol Quenby', { s: 'Lantern Coast', sn: '2', ...ed({ ext: { 'audible.com': 'BBOX' } }) }),
		book('The Drowned Chart', 'Marisol Quenby', { s: 'Lantern Coast', sn: '3', ...ed({ ext: { 'audible.com': 'BBOX' } }) }),
		book('Salt Road', 'Marisol Quenby', { s: 'The Lantern Coast Series', sn: '1', ...ed({ ext: { goodreads: '4242' } }) }),
		book('Lantern Coast 2: Beacons', 'Marisol Quenby, Tobias Frane'),
		book('Beacons', 'Someone Else'),
		book('Lantern Coast, Books 1-3', 'Marisol Quenby', { s: 'Lantern Coast', sn: '1-3' }),
	];
	// same series and number; Audible's long title for "Beacons"; different authors and the boxed set stay apart
	assert.deepEqual(findDuplicates(books), [[0, 3], [1, 4]]);
	// a pair marked as different books is not offered again, whichever way round
	const notSame = [Duplicates.pairKey(B(books[4]), B(books[1]))];
	assert.deepEqual(findDuplicates(books, notSame), [[0, 3]]);
	assert.deepEqual(findDuplicates([]), []);
});

test('mergeBooks keeps the picked fields and combines genres, dates read and editions', () => {
	const a = book('Salt Road', 'Marisol Quenby', { s: 'Lantern Coast', sn: '1', g: ['Fantasy'], r: ['2025-11-20'],
		...ed({ ext: { goodreads: '4242' }, p: 'Gullwing Audio' }, { isbn: ISBN_BOX }) });
	const b = book('The Salt Road', 'Marisol Quenby', { s: 'The Lantern Coast', sn: '1',
		g: ['Fantasy', 'Adventure'], r: ['2023-06-02', '2025-11-20'], ext: { hardcover: '77' }, ...ed({ ext: { 'audible.com': 'B1', goodreads: '4242' }, n: ['Tobias Frane'], len: 642 }, { ext: { 'audible.com': 'B2' } }) });
	// by default the first entry that has a value wins; the narrator only b's edition has
	assert.deepEqual(json(Book.merge(Bs([a, b]))), {
		t: 'Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', g: ['Fantasy', 'Adventure'],
		r: ['2023-06-02', '2025-11-20'], ext: { hardcover: '77' },
		e: [{ ext: { 'audible.com': 'B1', goodreads: '4242' }, n: ['Tobias Frane'], p: 'Gullwing Audio', len: 642 }, { isbn: ISBN_BOX }, { ext: { 'audible.com': 'B2' } }],
	});
	const picked = json(Book.merge(Bs([a, b]), { title: 1, series: 1 }));
	assert.equal(picked.t, 'The Salt Road');
	assert.equal(picked.s, 'The Lantern Coast');
	// the inputs are left alone
	assert.deepEqual(a.e, [{ ext: { goodreads: '4242' }, p: 'Gullwing Audio' }, { isbn: ISBN_BOX }]);
	assert.deepEqual(Validator.validate([picked], {}).errors, []);
});

test('editions that do not disagree on an ASIN, Goodreads id or ISBN can be joined, on merge or later', () => {
	const audible = book('Salt Road', 'Marisol Quenby', ed({ ext: { 'audible.com': 'B1' }, len: 642 }));
	const goodreads = book('Salt Road', 'Marisol Quenby', ed({ ext: { goodreads: '4242' }, isbn: ISBN_B, p: 'Gull Audio', len: 600 }));
	const joinable = editions => Edition.joinable(editions.map(E));
	assert.equal(joinable([{ ext: { 'audible.com': 'B1' } }, { ext: { goodreads: '4242' } }]), true);
	assert.equal(joinable([{ ext: { 'audible.com': 'B1' } }, { ext: { 'audible.com': 'B2' } }]), false);
	assert.equal(joinable([{ ext: { 'audible.com': 'B1' }, isbn: ISBN_A }, { ext: { goodreads: '4242' }, isbn: ISBN_B }]), false, 'another ISBN is another edition');
	assert.equal(joinable([{ ext: { 'audible.com': 'B1' } }]), false);
	// the first edition's values win
	assert.deepEqual(json(Book.merge(Bs([audible, goodreads]), { joinEditions: true }).editions),
		[{ ext: { 'audible.com': 'B1', goodreads: '4242' }, isbn: ISBN_B, p: 'Gull Audio', len: 642 }]);
	assert.equal(Book.merge(Bs([audible, goodreads])).editions.length, 2);
	assert.equal(audible.e[0].gr, undefined);              // the inputs are left alone

	const books = Bs([
		book('Two Editions', 'A', ed({ ext: { 'audible.com': 'B1' } }, { ext: { goodreads: '7' } })),
		book('Two Asins', 'A', ed({ ext: { 'audible.com': 'B2' } }, { ext: { 'audible.com': 'B3' } })),
		book('Box One', 'A', ed({ ext: { 'audible.com': 'BBOX' } }, { ext: { goodreads: '8' } })),
		book('Box Two', 'A', ed({ ext: { 'audible.com': 'BBOX' } })),
		book('One', 'A', ed({ ext: { 'audible.com': 'B4' } })),
	]);
	assert.deepEqual(new Duplicates(books).splitEditions(), [0]);
	assert.deepEqual(new Duplicates(books, textMarks([Duplicates.editionsKey(books[0])])).splitEditions(), []);
	assert.equal(Duplicates.editionsKey(B(book('x', 'y', ed({ ext: { goodreads: '7' } }, { ext: { 'audible.com': 'B1' } })))), Duplicates.editionsKey(books[0]));
});

test('narrators: a narrator on the book moves onto its editions', () => {
	// a narrator on the book was one text, from before narrators were lists
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: 'B', n: 'Ann Vale', e: [{ ext: { 'audible.com': 'B1' } }, { ext: { 'audible.com': 'B2' }, n: 'R. T. Hale' }] }]),
		[{ t: 'A', a: ['B'], e: [{ ext: { 'audible.com': 'B1' }, n: ['Ann Vale'] }, { ext: { 'audible.com': 'B2' }, n: ['R. T. Hale'] }] }]);
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: 'B', n: 'Ann Vale' }]), [{ t: 'A', a: ['B'], e: [{ n: ['Ann Vale'] }] }]);
	assert.deepEqual(Book.fixEditions({ t: 'A', a: ['B'], n: ' ' }), { t: 'A', a: ['B'] });
	// from before editions: ids and narrator make one edition
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: 'B', n: 'Ann Vale', id: 'B1' }])[0].e, [{ ext: { 'audible.com': 'B1' }, n: ['Ann Vale'] }]);
	assert.deepEqual(Validator.validate(Book.fixBooks([{ t: 'A', a: 'B', n: 'Ann Vale', id: 'B1' }]), {}), { errors: [], warnings: [] });
	assert.ok(Validator.validate([{ t: 'A', a: ['B'], n: ['Ann Vale'] }], {}).errors.some(e => e.includes("unknown key 'n'")));

	assert.deepEqual(B(book('A', 'B', ed({ n: ['Ann Vale'] }, { n: ['R. T. Hale'] }, { n: ['Ann Vale'] }, { ext: { 'audible.com': 'B3' } }))).narrators(), ['Ann Vale', 'R. T. Hale']);
	// an import's narrator never replaces the one you have
	const existing = [book('One', 'Author', ed({ ext: { 'audible.com': 'B1' }, n: ['Mine'] }))];
	merge(existing, [book('One', 'Author', ed({ ext: { goodreads: '7' }, n: ['A guess'] }))]);
	assert.deepEqual(existing[0].e, [{ ext: { 'audible.com': 'B1', goodreads: '7' }, n: ['Mine'] }]);
});

test('a count is written with its word, singular for one', () => {
	assert.equal(Text.plural(1, 'book'), '1 book');
	assert.equal(Text.plural(0, 'book'), '0 books');
	assert.equal(Text.plural(3, 'Goodreads id'), '3 Goodreads ids');
	assert.equal(Text.plural(2, 'series', 'series'), '2 series');
});

test('authors and narrators are lists; comma separated text from before is split on load', () => {
	assert.deepEqual(Text.splitNames('Ann Vale, R. T. Hale; Bo Reed & Cy Hale and Di Moss'), ['Ann Vale', 'R. T. Hale', 'Bo Reed', 'Cy Hale', 'Di Moss']);
	assert.deepEqual(Text.splitNames('Ann Vale, Jr., Bo Reed, III'), ['Ann Vale, Jr.', 'Bo Reed, III']);
	assert.deepEqual(Text.splitNames(' Ann  Vale ,, Ann  Vale '), ['Ann Vale']);
	assert.deepEqual(Text.splitNames(''), []);
	assert.equal(Text.namesText(['Ann Vale', 'Bo Reed']), 'Ann Vale, Bo Reed');

	const old = { t: 'Old', a: 'Ann Vale, Bo Reed', e: [{ ext: { 'audible.com': 'B1' }, n: 'Cy Hale & Di Moss' }, { ext: { 'audible.com': 'B2' }, n: ['Kept, As Is'] }] };
	assert.deepEqual(Book.fixBooks([old]), [{ t: 'Old', a: ['Ann Vale', 'Bo Reed'], e: [{ ext: { 'audible.com': 'B1' }, n: ['Cy Hale', 'Di Moss'] }, { ext: { 'audible.com': 'B2' }, n: ['Kept, As Is'] }] }]);
	assert.deepEqual(Book.fixBooks([{ t: 'No Author', a: '  ' }]), [{ t: 'No Author' }]);
	assert.deepEqual(Book.tidyJSON({ t: 'T', a: ['A.B.  Quill', 'A. B. Quill'], e: [{ n: ['R.T. Hale'] }] }), { t: 'T', a: ['A. B. Quill'], e: [{ n: ['R. T. Hale'] }] });

	// validate wants lists; the loaders give it them
	const errors = Validator.validate([{ t: 'A', a: 'Ann Vale' }, { t: 'B', a: [] }, { t: 'C', a: ['X'], e: [{ n: 'Cy Hale' }] }], {}).errors.join('\n');
	for (const needle of ["book #0 ('A'): 'a' must be a non-empty list of authors' names", "book #1 ('B'): 'a' must be a non-empty list",
												"'n' must be a non-empty list of narrators' names"]) {
		assert.ok(errors.includes(needle), needle);
	}
	assert.deepEqual(Validator.validate(Book.fixBooks([old]), {}), { errors: [], warnings: [] });
	assert.ok(Validator.validate([{ t: 'A', a: ['X'], e: [{ n: ['R.T. Hale'] }] }], {}).warnings.some(w => w.includes("narrator 'R.T. Hale'")));

	// matching goes by the first author, as it did when authors were text, so keys and marks stay the same
	const loaded = rec => B(Book.fixBooks([rec])[0]);
	assert.deepEqual(B({ t: 'Old', a: ['Ann Vale', 'Bo Reed'] }).keys(), loaded({ t: 'Old', a: 'Ann Vale, Bo Reed' }).keys());
	assert.equal(Duplicates.pairKey(B({ t: 'X', a: ['Ann Vale', 'Bo Reed'] }), B({ t: 'Y', a: ['Cy Hale'] })),
		Duplicates.pairKey(loaded({ t: 'X', a: 'Ann Vale, Bo Reed' }), loaded({ t: 'Y', a: 'Cy Hale' })));
	assert.deepEqual(B({ t: 'Gone', a: ['Ann Vale', 'Bo Reed'] }).exclusionEntries(), ['Gone | Ann Vale, Bo Reed']);
	assert.ok(Exclusions.parse('Gone | Ann Vale, Bo Reed').covers(B({ t: 'Gone', a: ['Ann Vale'] })));

	// editions as text: narrators are written and read back as one comma separated part
	assert.equal(E({ n: ['Cy Hale', 'Di Moss'], ext: { 'audible.com': 'B1' } }).format(), 'Narrated by Cy Hale, Di Moss; ASIN audible.com B1');
	assert.deepEqual(json(Edition.parse('Narrated by Cy Hale, Di Moss; ASIN B1').editions), [{ ext: { 'audible.com': 'B1' }, n: ['Cy Hale', 'Di Moss'] }]);
	assert.deepEqual(B(book('A', 'B', ed({ n: ['Cy Hale', 'Di Moss'] }, { n: ['Di Moss'] }))).narrators(), ['Cy Hale', 'Di Moss']);

	// imports give lists: Audible's and Goodreads' columns are split, and so are books from before, on load
	const [rec] = new AudibleImporter().rowToBook({ Title: 'T', Authors: 'Ann Vale, Bo Reed', Narrators: 'Cy Hale, Di Moss', Progress: 'Finished', ASIN: 'B0000000A1' });
	assert.deepEqual([rec.authors, rec.editions[0].narrators], [['Ann Vale', 'Bo Reed'], ['Cy Hale', 'Di Moss']]);
	const gr = new GoodreadsImporter().read(GR_HEADER + '4242,Kept,Ann Vale,"Cy Hale, Di Moss",Audible Audio,read,,\n').books[0];
	assert.deepEqual([gr.authors, gr.editions[0].narrators], [['Ann Vale'], ['Cy Hale', 'Di Moss']]);
	const existing = [];
	merge(existing, Book.fixBooks([{ t: 'Text', a: 'Ann Vale, Bo Reed', s: 'Saga', sn: '1-2', e: [{ ext: { 'audible.com': 'BBOX' }, n: 'Cy Hale' }] }]));
	assert.deepEqual(existing.map(b => [b.a, b.e[0].n]), Array(3).fill([['Ann Vale', 'Bo Reed'], ['Cy Hale']]));
	const titles = Bs(existing);
	new Merger(titles).merge([]);
	assert.notEqual(titles[0].authors, titles[1].authors, 'each title has a list of its own');
});

test('backups carry the "Not duplicates" marks, and not-duplicates.txt lists them one per line', () => {
	const marks = ['["a","b","",""] ["c","b","",""]'];
	assert.deepEqual(Backup.read({ books: [], notDuplicates: marks }).notDuplicates, marks);
	assert.equal(Backup.read({ books: [] }).notDuplicates, null);
	assert.equal(Backup.read([]).notDuplicates, null);
	assert.throws(() => Backup.read({ books: [], notDuplicates: [1] }), /notDuplicates is not a list of strings/);
	assert.deepEqual(Duplicates.parseMarks('# header\n\n' + marks[0] + '\r\n  ' + marks[0] + '  \n["editions","id B1"]'),
		[marks[0], '["editions","id B1"]']);
	assert.deepEqual(Duplicates.parseMarks(''), []);
});

// ------------------------------------------------------------ merge a backup
test('merging a backup from another device keeps what each side added, edited and removed', () => {
	const mine = [
		book('Both Read', 'Ann Vale', { r: ['2024-01-02'], g: ['Mystery'], ...ed({ ext: { 'audible.com': 'B1' } }) }),
		book('Only Here', 'Ann Vale'),
		book('Removed There', 'Ann Vale', ed({ ext: { 'audible.com': 'BGONE' } })),
		book('Same Both', 'Ann Vale', ed({ n: ['Ivo Brandt'] })),
	];
	const before = JSON.stringify(mine);
	const backup = {
		books: [
			book('Both Read', 'Ann Vale', { r: ['2025-06-01'], g: ['Cozy'], ...ed({ ext: { 'audible.com': 'B1' }, n: ['Dana Whitlock'] }) }),
			book('Only There', 'Ann Vale', { s: 'Tide Saga', sn: '2' }),
			book('Removed Here', 'Ann Vale'),
			book('Same Both', 'Ann Vale', ed({ n: ['Ivo Brandt'] })),
		],
		seriesInfo: { 'Tide Saga': { total: '3', status: 'ongoing' } },
		excluded: ['BGONE', 'Removed There | Ann Vale'],
	};
	const exclusions = Exclusions.parse('Removed Here | Ann Vale\n');
	const m = mergeBackup(mine, {}, exclusions, backup);
	assert.deepEqual(m.books, [
		{ t: 'Both Read', a: ['Ann Vale'], g: ['Mystery', 'Cozy'], r: ['2024-01-02', '2025-06-01'], e: [{ ext: { 'audible.com': 'B1' }, n: ['Dana Whitlock'] }] },
		book('Only Here', 'Ann Vale'),
		book('Same Both', 'Ann Vale', ed({ n: ['Ivo Brandt'] })),
		book('Only There', 'Ann Vale', { s: 'Tide Saga', sn: '2' }),
	]);
	assert.deepEqual(m.added.map(b => b.t), ['Only There']);
	assert.deepEqual(m.updated.map(b => b.t), ['Both Read']);
	assert.deepEqual(m.removed.map(b => b.t), ['Removed There']);
	assert.deepEqual(m.skipped.map(b => b.t), ['Removed Here']);
	assert.deepEqual(m.excluded, ['BGONE', 'Removed There | Ann Vale']);
	assert.deepEqual(m.seriesInfo, backup.seriesInfo);
	assert.deepEqual(m.infoAdded, ['Tide Saga']);
	assert.deepEqual(m.conflicts, []);
	assert.equal(JSON.stringify(mine), before, 'the catalog it was given is unchanged');
	assert.equal(exclusions.size, 1);
	assert.deepEqual(m.notDuplicates, [], 'a backup without marks adds none');
});

test('merging a backup adds the backup\'s "Not duplicates" marks to ours', () => {
	const marks = ['["editions","id B1"]', '["editions","id B2"]'];
	const backup = { books: [], seriesInfo: {}, excluded: [], notDuplicates: [marks[1], marks[0], marks[1]] };
	const ours = new Set([marks[0]]);
	assert.deepEqual(mergeBackup([], {}, null, backup, 'mine', ours).notDuplicates, [marks[1]]);
	assert.deepEqual([...ours], [marks[0]], 'our marks are unchanged');
	assert.deepEqual(mergeBackup([], {}, null, backup).notDuplicates, [marks[1], marks[0]]);
});

test('merging a backup: where both changed a title or series info, ours wins unless the backup is preferred', () => {
	const mine = [book('Lantern Road', 'Ann Vale', { s: 'Tide Saga', sn: '1', ...ed({ ext: { 'audible.com': 'B1' } }) })];
	const theirs = book('The Lantern Road', 'Ann Vale', { s: 'Tide Saga', sn: '1', ...ed({ ext: { 'audible.com': 'B1' } }) });
	const info = { 'Tide Saga': { total: '3', status: 'ongoing' } };
	const backup = { books: [theirs], seriesInfo: { 'Tide Saga': { total: '4', status: 'complete' } }, excluded: [] };

	const keep = mergeBackup(mine, info, null, backup);
	assert.equal(keep.books[0].t, 'Lantern Road');
	assert.deepEqual(keep.updated, []);
	assert.equal(keep.conflicts.length, 1);
	assert.deepEqual(keep.seriesInfo, info);
	assert.deepEqual(keep.infoKept, ['Tide Saga']);

	const take = mergeBackup(mine, info, null, backup, 'backup');
	assert.equal(take.books[0].t, 'The Lantern Road');
	assert.deepEqual(take.updated.map(b => b.t), ['The Lantern Road']);
	assert.deepEqual(take.seriesInfo, backup.seriesInfo);
	assert.deepEqual(take.infoChanged, ['Tide Saga']);
});

test('merging a backup: author info only the backup has is added; where both differ, ours wins unless the backup is preferred', () => {
	const mine = [book('Lantern Road', 'Ann Vale'), book('Ember Gate', 'Bo Reed')];
	const authors = { 'Ann Vale': { bio: 'Written here.' } };
	const backup = { books: mine, seriesInfo: {}, authors: { 'Ann Vale': { bio: 'Written there.' }, 'Bo Reed': { url: 'https://example.com/' } } };
	const keep = mergeBackup(mine, {}, null, backup, 'mine', [], authors);
	assert.deepEqual(keep.authors, { 'Ann Vale': { bio: 'Written here.' }, 'Bo Reed': { url: 'https://example.com/' } });
	assert.deepEqual([keep.authorsAdded, keep.authorsChanged, keep.authorsKept], [['Bo Reed'], [], ['Ann Vale']]);
	const take = mergeBackup(mine, {}, null, backup, 'backup', [], authors);
	assert.deepEqual(take.authors, backup.authors);
	assert.deepEqual(take.authorsChanged, ['Ann Vale']);
	assert.deepEqual(authors, { 'Ann Vale': { bio: 'Written here.' } }, 'changes nothing it is given');
	// a backup from before author info keeps ours
	assert.deepEqual(mergeBackup(mine, {}, null, { books: mine }, 'backup', [], authors).authors, authors);
});

// ------------------------------------------------------------------ authors
test('author info: validated against the books, ids checked against their catalogs', () => {
	const books = [book('Lantern Road', 'Ann Vale')];
	assert.deepEqual(Validator.validateContributors(books, 'authors', {}), { errors: [], warnings: [] });
	assert.deepEqual(Validator.validateContributors(books, 'authors', undefined), { errors: [], warnings: [] });
	assert.deepEqual(Validator.validateContributors(books, 'authors', { 'Ann Vale': { bio: 'Hi.\n\nMore.', url: 'https://example.com/',
		ext: { 'audible.co.uk': 'B0ANNVALE1', goodreads: '1', hardcover: 'ann-vale' }, links: ['https://example.org/ann-vale'] } }), { errors: [], warnings: [] });
	const { errors, warnings } = Validator.validateContributors(books, 'authors', {
		'Ann Vale': { bio: '', url: 'example.com', ext: { goodreads: 'ann', 'kobo.com': '1' }, links: ['https://www.goodreads.com/author/show/7.Ann_Vale', 'nowhere'], note: 'x' },
		'Cy Hale': 'not an object',
	});
	assert.deepEqual(errors, [
		"authors['Ann Vale']: unknown keys ['note']",
		"authors['Ann Vale']: 'bio' must be a non-empty string when present",
		"authors['Ann Vale']: 'url' must be a web address starting with http:// or https://",
		"authors['Ann Vale']: 'ann' is not Goodreads's id of an author",
		"authors['Ann Vale']: link 'nowhere' must be a web address starting with http:// or https://",
		"authors['Cy Hale']: not an object",
	]);
	assert.deepEqual(warnings, [
		"authors['Ann Vale']: 'kobo.com' is not an external catalog this app knows",
		"authors['Ann Vale']: link 'https://www.goodreads.com/author/show/7.Ann_Vale' is a page on Goodreads; keep its id '7' instead",
	]);
	assert.deepEqual(Validator.validateContributors(books, 'authors', []).errors, ['authors: must map author names to their info']);
	// a publisher has no page on Goodreads
	assert.deepEqual(Validator.validateContributors([book('A', 'B', ed({ p: 'Gull Audio' }))], 'publishers', { 'Gull Audio': { ext: { goodreads: '1' } } }).errors,
		["publishers['Gull Audio']: Goodreads has no publisher pages, so no publisher id"]);
});

test('author info from before ids: the address of each page becomes its id, and one that can\'t be read is kept as a link', () => {
	assert.deepEqual(Contributor.fixLinks({ bio: 'Hi.', audible: 'https://www.audible.co.uk/author/Ann-Vale/B0ANNVALE1?ref=x', goodreads: 'https://www.goodreads.com/author/show/1.Ann_Vale',
		hardcover: 'https://hardcover.app/authors/ann-vale' }, 'authors'),
		{ bio: 'Hi.', ext: { 'audible.co.uk': 'B0ANNVALE1', goodreads: '1', hardcover: 'ann-vale' } });
	assert.deepEqual(Contributor.fixLinks({ goodreads: 'https://www.goodreads.com/list/show/5', hardcover: '' }, 'authors'),
		{ links: ['https://www.goodreads.com/list/show/5'] }, 'not an author page');
	assert.deepEqual(Contributor.fixLinks({ audible: 'https://www.audible.com/search?searchNarrator=Cy+Hale' }, 'narrators'), { ext: { 'audible.com': 'Cy Hale' } });
	assert.deepEqual(Contributor.fixLinks({ bio: 'Hi.' }, 'authors'), { bio: 'Hi.' }, 'nothing to do');
	// the catalog reads an old entry in the current format
	const catalog = Catalog.fromJSON({ books: [book('A', 'Ann Vale')], authors: { 'Ann Vale': { goodreads: 'https://www.goodreads.com/author/show/1' } } });
	assert.deepEqual(json(catalog.infoByName('authors').get('Ann Vale')), { ext: { goodreads: '1' } });
	assert.deepEqual(ExternalCatalog.url('goodreads', 'author', '1'), 'https://www.goodreads.com/author/show/1');
});

test('narrator and publisher info: names come from the editions, and backups carry and merge it', () => {
	const books = [book('Lantern Road', 'Ann Vale', { e: [{ n: ['Cy Hale'], p: 'Gull Audio' }] })];
	assert.deepEqual(Validator.validateContributors(books, 'narrators', { 'Cy Hale': { bio: 'Reads.' }, 'Ann Vale': { bio: 'Writes.' } }),
		{ errors: [], warnings: [] }, 'a narrator no edition has is an entry of their own');
	assert.deepEqual(Validator.validateContributors(books, 'publishers', { 'Gull Audio': { ext: { hardcover: 'gull' } } }),
		{ errors: [], warnings: [] });
	assert.deepEqual(Validator.validateContributors(books, 'publishers', { 'Gull Audio': { url: 'gull' } }).errors,
		["publishers['Gull Audio']: 'url' must be a web address starting with http:// or https://"]);
	// the Check looks at all three
	const catalog = Catalog.fromJSON({ books, narrators: { Nobody: { bio: 'Hi.' } }, publishers: { 'Gull Audio': { note: 'x' } } });
	const found = catalog.validate({ contributors: true });
	assert.deepEqual([found.errors, found.warnings], [["publishers['Gull Audio']: unknown keys ['note']"], []]);
	// backups: read, older ones have none, and merging adds the backup's
	assert.equal(Backup.read({ books: [] }).narrators, null);
	assert.throws(() => Backup.read({ books: [], publishers: [] }), /publishers is not an object/);
	const mine = Catalog.fromJSON({ books, narrators: { 'Cy Hale': { bio: 'Mine.' } } });
	const m = Backup.read({ books, narrators: { 'Cy Hale': { bio: 'Theirs.' } }, publishers: { 'Gull Audio': { bio: 'Theirs.' } } }).mergeInto(mine);
	assert.deepEqual([m.narratorsKept, m.publishersAdded], [['Cy Hale'], ['Gull Audio']]);
	assert.deepEqual(json(Object.fromEntries(m.narrators)), { 'Cy Hale': { bio: 'Mine.' } });
	assert.deepEqual(json(mine.clone()).publishers, {});
	assert.deepEqual(Object.keys(json(mine)), ['books', 'seriesInfo', 'authors', 'narrators', 'publishers', 'excluded', 'notDuplicates', 'ids']);
	assert.deepEqual(Object.keys(json(Catalog.fromJSON({ books: [] }))), ['books', 'seriesInfo', 'authors', 'narrators', 'publishers', 'excluded', 'notDuplicates'], 'no ids when there are none');
});

test('author info is tidied: a bio keeps its paragraphs, empty fields are dropped', () => {
	assert.deepEqual(json(Contributor.tidy('Ann Vale', { bio: '  First  line.\r\nSecond\u00a0line.\n\n\n\nNew  paragraph. ', url: ' https://example.com/ ', ext: { goodreads: '  ' }, links: [' '] })),
		{ bio: 'First line.\nSecond line.\n\nNew paragraph.', url: 'https://example.com/' });
	assert.equal(Contributor.tidy('Ann Vale', { bio: ' ', url: '' }), null);
	assert.equal(Contributor.tidy('Ann Vale', 'nope'), null);
});

test('an author\'s works: their series in series order, then their other titles, co-written books included', () => {
	const catalog = new Catalog({ books: Bs([
		book('Third', 'Ann Vale', { s: 'Tide Saga', sn: '3' }), book('First', 'Ann Vale', { s: 'Tide Saga', sn: '1' }),
		book('Novella', 'Ann Vale', { s: 'Tide Saga' }), book('Zebra Days', 'Ann Vale'),
		{ t: 'Apple Hill', a: ['Bo Reed', 'Ann Vale'] }, book('Not Hers', 'Bo Reed', { s: 'Tide Saga', sn: '2' }),
		book('Boxed', 'Ann Vale', { s: 'Ash Cycle', sn: '1-3' }),
	]) });
	const works = catalog.authorWorks('Ann Vale');
	assert.deepEqual(works.series.map(s => [s.name, s.books.map(b => b.title)]),
		[['Ash Cycle', ['Boxed']], ['Tide Saga', ['First', 'Third', 'Novella']]]);
	assert.deepEqual(works.titles.map(b => b.title), ['Apple Hill', 'Zebra Days']);
	assert.deepEqual(catalog.authorWorks('Nobody'), { series: [], titles: [] });
});

test('narrators\' and publishers\' works come from the editions, each book once', () => {
	const catalog = new Catalog({ books: Bs([
		book('Second', 'Ann Vale', { s: 'Tide Saga', sn: '2', e: [{ n: ['Cy Hale'], p: 'Gull Audio' }, { n: ['Cy Hale', 'Di Moss'], p: 'Gull Audio' }] }),
		book('First', 'Ann Vale', { s: 'Tide Saga', sn: '1', e: [{ n: ['Di Moss'], p: 'Gull Audio' }] }),
		book('Apple Hill', 'Bo Reed', { e: [{ n: ['Cy Hale'], p: 'Harbor Sound' }] }),
		book('Unread Edition', 'Bo Reed'),
	]) });
	const works = catalog.narratorWorks('Di Moss');
	assert.deepEqual(works.series.map(s => [s.name, s.books.map(b => b.title)]), [['Tide Saga', ['First', 'Second']]]);
	assert.deepEqual(catalog.publisherWorks('Harbor Sound').titles.map(b => b.title), ['Apple Hill']);
	assert.deepEqual(catalog.narratorWorks('Nobody'), { series: [], titles: [] });
});

test('backups carry author info, and older ones have none', () => {
	const authors = { 'Ann Vale': { bio: 'Hi.' } };
	assert.deepEqual(json(Object.fromEntries(Backup.read({ books: [], authors }).authors)), authors);
	assert.equal(Backup.read({ books: [] }).authors, null);
	assert.equal(Backup.read([]).authors, null);
	assert.throws(() => Backup.read({ books: [], authors: [] }), /authors is not an object/);
});

test('merging a backup: a book the backup still has is not removed, and the same catalog merges to itself', () => {
	const mine = [book('Back Again', 'Ann Vale', { r: ['2025-01-01', '2023-05-05'] })];
	// removed on the other device, then added there again
	const backup = { books: [book('Back Again', 'Ann Vale')], seriesInfo: {}, excluded: ['Back Again | Ann Vale'] };
	const m = mergeBackup(mine, {}, null, backup);
	assert.deepEqual(m.books, mine);
	assert.deepEqual(m.removed, []);
	// dates read in another order are not a change
	const same = mergeBackup(mine, {}, null, { books: [book('Back Again', 'Ann Vale', { r: ['2023-05-05', '2025-01-01'] })] });
	assert.deepEqual([same.added, same.updated, same.removed, same.conflicts], [[], [], [], []]);
});

test('merging a backup: the titles of a box set, which share an edition, each find their own book', () => {
	const box = { ext: { 'audible.com': 'BBOX' }, n: ['Dana Whitlock'] };
	const mine = [book('First Tide', 'Ann Vale', { s: 'Tide Saga', sn: '1', ...ed(box) }),
		book('Second Tide', 'Ann Vale', { s: 'Tide Saga', sn: '2', ...ed(box) })];
	const backup = { books: [book('Second Tide', 'Ann Vale', { s: 'Tide Saga', sn: '2', r: ['2025-02-02'], ...ed(box) }),
		book('First Tide', 'Ann Vale', { s: 'Tide Saga', sn: '1', ...ed(box) })] };
	const m = mergeBackup(mine, {}, null, backup);
	assert.deepEqual(m.conflicts, []);
	assert.deepEqual(m.books.map(b => [b.t, b.r]), [['First Tide', undefined], ['Second Tide', ['2025-02-02']]]);
});

// ------------------------------------------------------------------ Hardcover
test('Hardcover ids: an edition id names an edition, the book id is the book\'s', () => {
	assert.ok(E({ ext: { hardcover: '501' } }).sameAs(E({ ext: { hardcover: '501', 'audible.com': 'B1' } })));
	assert.ok(!E({ ext: { hardcover: '501', 'audible.com': 'B1' } }).sameAs(E({ ext: { hardcover: '502', 'audible.com': 'B1' } })), 'different Hardcover editions conflict');
	// an incoming record finds the book by its Hardcover edition, or by the same Hardcover book
	const books = [book('Tidewater', 'Ann Vale', { ext: { hardcover: '77' }, ...ed({ ext: { 'audible.com': 'B1', hardcover: '501' } }) })];
	const report = merge(books, [book('Tidewater (Unabridged)', 'Ann Vale', { ext: { hardcover: '77' }, ...ed({ ext: { hardcover: '502' }, n: ['Hollis Marr'] }) })]);
	assert.equal(report.matched, 1);
	assert.deepEqual(books[0], { t: 'Tidewater', a: ['Ann Vale'], ext: { hardcover: '77' }, e: [{ ext: { 'audible.com': 'B1', hardcover: '501' } }, { ext: { hardcover: '502' }, n: ['Hollis Marr'] }] });
	// a book found by an edition gains the Hardcover book id it lacked, before its editions
	const fen = [book('Fen', 'Ann Vale', { r: ['2024'], ...ed({ ext: { 'audible.com': 'B2' } }) })];
	assert.equal(merge(fen, [book('Fen', 'Ann Vale', { ext: { hardcover: '78' }, ...ed({ ext: { 'audible.com': 'B2', hardcover: '601' } }) })]).hardcoverFilled.length, 1);
	assert.deepEqual(Object.keys(fen[0]), ['t', 'a', 'r', 'ext', 'e']);
	assert.deepEqual(fen[0].e, [{ ext: { 'audible.com': 'B2', hardcover: '601' } }]);
	assert.deepEqual(findDuplicates([book('One', 'Ann Vale', { ext: { hardcover: '77' } }), book('Two', 'Ann Vale', { ext: { hardcover: '77' } })]), []);
});

test('Hardcover book ids move from the editions to the book on load', () => {
	// the book's own Hardcover book before a box set's, whose edition (and so its id) is on each of its titles
	const books = Book.fixBooks([
		book('One', 'Ann Vale', ed({ asin: { 'audible.com': 'BBOX' }, hc: '700', hcb: '70' }, { asin: { 'audible.com': 'B1' }, hc: '711', hcb: '71' })),
		book('Two', 'Ann Vale', ed({ asin: { 'audible.com': 'BBOX' }, hc: '700', hcb: '70' })),
		book('Three', 'Ann Vale', { hcb: '73', ...ed({ asin: { 'audible.com': 'B3' }, hcb: '99' }) }),
		book('Four', 'Ann Vale', ed({ hcb: '74' })),
	]);
	assert.deepEqual(books, [
		{ t: 'One', a: ['Ann Vale'], ext: { hardcover: '71' }, e: [{ ext: { 'audible.com': 'BBOX', hardcover: '700' } }, { ext: { 'audible.com': 'B1', hardcover: '711' } }] },
		{ t: 'Two', a: ['Ann Vale'], ext: { hardcover: '70' }, e: [{ ext: { 'audible.com': 'BBOX', hardcover: '700' } }] },
		{ t: 'Three', a: ['Ann Vale'], ext: { hardcover: '73' }, e: [{ ext: { 'audible.com': 'B3' } }] },
		{ t: 'Four', a: ['Ann Vale'], ext: { hardcover: '74' } },
	]);
	assert.deepEqual(Validator.validate(books, {}), { errors: [], warnings: [] });
	assert.match(Validator.validate([book('A', 'B', ed({ ext: { 'audible.com': 'B1' }, hcb: '7' }))], {}).errors.join('\n'), /unknown key 'hcb'/);
	assert.match(Validator.validate([book('A', 'B', { ext: { hardcover: 'x7' } })], {}).errors.join('\n'), /'x7' is not Hardcover's id of a book/);
});

test('Hardcover ids round-trip through the edit form, are validated and exclude books', () => {
	const line = E({ ext: { 'audible.com': 'B0X', hardcover: '501' } }).format();
	assert.equal(line, 'ASIN audible.com B0X; Hardcover 501');
	assert.deepEqual(json(Edition.parse(line + '\nhardcover id: 9').editions), [{ ext: { 'audible.com': 'B0X', hardcover: '501' } }, { ext: { hardcover: '9' } }]);
	// the Hardcover book, as editions used to show it, is the book's
	assert.deepEqual(json(Edition.parse(line + '; Hardcover book 77')), { editions: [{ ext: { 'audible.com': 'B0X', hardcover: '501' } }], bad: [], book: { hardcover: '77' } });
	assert.deepEqual(json(Edition.parse('Hardcover abc').bad), ['Hardcover abc']);
	const { errors } = Validator.validate([book('Tidewater', 'Ann Vale', ed({ ext: { hardcover: 'x1' } }))], {});
	assert.match(errors.join('\n'), /'x1' is not Hardcover's id of an edition/);
	assert.match(Validator.validate([book('A', 'Ann Vale', ed({ ext: { hardcover: '5' } })), book('A', 'Ann Vale', ed({ ext: { hardcover: '5' } }))], {}).errors.join('\n'), /duplicate Hardcover id 5/);
	assert.deepEqual(B(book('Gone', 'Ann Vale', { ext: { hardcover: '77' }, ...ed({ ext: { hardcover: '501' } }) })).exclusionEntries(), ['Hardcover 501', 'Gone | Ann Vale']);
	const ex = Exclusions.parse('Hardcover 501\n');
	assert.deepEqual(ex.entries, ['Hardcover 501']);
	const report = merge([], [book('Gone Again', 'Ann Vale', ed({ ext: { hardcover: '501' } }))], ex);
	assert.equal(report.excluded.length, 1);
});

test('merge: allDates adds the reads a book lacks, addable keeps some records from being added', () => {
	const books = [book('Tidewater', 'Ann Vale', { r: ['2023-04', '2024-01-02'] })];
	const incoming = [book('Tidewater', 'Ann Vale', { r: ['2023-04-09', '2025-06-30'] }), book('Paper Only', 'Ann Vale')];
	const report = merge(books, incoming, null, { allDates: true, addable: b => b.title !== 'Paper Only' });
	assert.deepEqual(books.map(b => b.r), [['2023-04', '2024-01-02', '2025-06-30']], '2023-04-09 is in 2023-04');
	assert.deepEqual(report.datesFilled, [books[0]]);
	assert.deepEqual(report.notAdded.map(b => b.t), ['Paper Only']);
	// without allDates, a book that has dates keeps them
	const plain = [book('Tidewater', 'Ann Vale', { r: ['2023-04'] })];
	merge(plain, [book('Tidewater', 'Ann Vale', { r: ['2025-06-30'] })]);
	assert.deepEqual(plain[0].r, ['2023-04']);
});

// Hardcover answers, as its API gives them (invented books)
const HC_BOOKS = new Map([
	[77, { id: 77, title: 'Tidewater', contributions: [{ contribution: null, author: { name: 'Ann  Vale' } }, { contribution: 'Illustrator', author: { name: 'P. Dray' } }],
		featured_book_series: { position: 2, series: { name: 'Gull Isle' } } }],
	[78, { id: 78, title: 'The Paper Fen', contributions: [{ contribution: 'Author', author: { name: 'R.T. Hale' } }, { contribution: null, author: { name: 'Bo Reed' } }],
		featured_book_series: null }],
	[79, { id: 79, title: 'Someday Maybe', contributions: [{ contribution: null, author: { name: 'Ann Vale' } }] }],
]);
const HC_EDITIONS = new Map([
	[501, { id: 501, book_id: 77, asin: 'B0TIDEWAT1', isbn_13: '9780000000002', isbn_10: null, release_date: '2021-05-04', audio_seconds: 38520,
		reading_format_id: 2, publisher: { name: 'Gullwing Audio' }, contributions: [{ contribution: 'Narrator', author: { name: 'Hollis Marr' } }, { contribution: 'Narrator', author: { name: 'Cy Hale' } }] }],
	[601, { id: 601, book_id: 78, asin: null, isbn_13: null, reading_format_id: 1, contributions: [] }],
]);
const HC_SHELF = [
	{ id: 1, book_id: 77, edition_id: 501, status_id: 3, user_book_reads: [{ finished_at: '2024-03-15' }, { finished_at: null }, { finished_at: '2022-01-09' }] },
	{ id: 2, book_id: 78, edition_id: 601, status_id: 3, user_book_reads: [] },
	{ id: 3, book_id: 79, edition_id: null, status_id: 1, user_book_reads: [] },
];

test('readHardcover: the Read shelf as books, with every finished date and the Hardcover ids', () => {
	const result = HardcoverSync.read(HC_SHELF, HC_BOOKS, HC_EDITIONS);
	assert.equal(result.otherShelves, 1);
	assert.deepEqual(json(result.books), [
		{ t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', r: ['2022-01-09', '2024-03-15'], ext: { hardcover: '77' },
			e: [{ ext: { 'amazon.com': 'B0TIDEWAT1', hardcover: '501' }, isbn: '9780000000002', n: ['Hollis Marr', 'Cy Hale'], p: 'Gullwing Audio', d: '2021-05-04', len: 642 }] },
		{ t: 'The Paper Fen', a: ['R. T. Hale', 'Bo Reed'], ext: { hardcover: '78' }, e: [{ ext: { hardcover: '601' } }] },
	]);
	assert.deepEqual([...result.audio].map(b => b.title), ['Tidewater'], 'only the audiobook edition may be added');
	assert.deepEqual(HardcoverSync.read([{ id: 9, book_id: 99, status_id: 3 }], HC_BOOKS, HC_EDITIONS).warnings, ['Hardcover book 99: not found, skipped']);
});

test('hardcoverFindQuery asks only for the ids there are, and hardcoverMatches reads the answer', () => {
	assert.equal(HardcoverClient.findQuery({ hc: [], asin: [], isbn: [], gr: [] }), null);
	const q = HardcoverClient.findQuery({ hc: [], asin: ['B0TIDEWAT1'], isbn: [], gr: ['4242'] });
	assert.deepEqual(q.variables, { asin: ['B0TIDEWAT1'], gr: ['4242'] });
	assert.match(q.query, /^query Find\(\$asin: \[String!\], \$gr: \[String!\]\)/);
	assert.match(q.query, /byAsin: editions\(where: \{asin: \{_in: \$asin\}\}\)/);
	assert.doesNotMatch(q.query, /byIsbn|byId/);
	const found = HardcoverClient.matches({
		byAsin: [{ id: 501, book_id: 77, asin: 'B0TIDEWAT1', reading_format_id: 2 }],
		byIsbn: [{ id: 601, book_id: 78, isbn_13: '9780000000019', reading_format_id: 1 }],
		byGoodreads: [{ book_id: 79, external_id: '4242' }],
	});
	assert.deepEqual(found.asin.get('B0TIDEWAT1'), { hc: '501', hcb: '77' });
	assert.deepEqual(found.isbn.get('9780000000019'), { hc: null, hcb: '78' }, 'a print edition only names the book');
	assert.deepEqual(found.gr.get('4242'), { hc: null, hcb: '79' });
});

test('addHardcoverIds fills in the ids found (box set copies alike), never changing one you have', () => {
	const books = Bs([
		book('Tidewater', 'Ann Vale', ed({ ext: { 'audible.com': 'B0TIDEWAT1' } })),
		book('Box One', 'Ann Vale', ed({ ext: { 'audible.com': 'B0BOXSET01' } })), book('Box Two', 'Ann Vale', ed({ ext: { 'audible.com': 'B0BOXSET01' } })),
		book('Fen', 'Ann Vale', ed({ ext: { goodreads: '4242' } })),
		book('Kept', 'Ann Vale', { ext: { hardcover: '8' }, ...ed({ ext: { 'audible.com': 'B0KEPT0001', hardcover: '9' } }) }),
		book('Own First', 'Ann Vale', ed({ ext: { 'audible.com': 'B0BOXSET01' } }, { ext: { 'audible.com': 'B0OWN00001', hardcover: '711' } })),
		book('Nowhere', 'Ann Vale'),
	]);
	assert.deepEqual(HardcoverSync.lookups(books), { hc: [711], asin: ['B0TIDEWAT1', 'B0BOXSET01', 'B0OWN00001'], isbn: [], gr: ['4242'] });
	const found = { hc: new Map([['711', { hc: '711', hcb: '71' }]]), isbn: new Map(),
		asin: new Map([['B0TIDEWAT1', { hc: '501', hcb: '77' }], ['B0BOXSET01', { hc: '700', hcb: '70' }], ['B0KEPT0001', { hc: '1', hcb: '2' }]]),
		gr: new Map([['4242', { hc: null, hcb: '79' }]]) };
	const filled = HardcoverSync.addIds(books, found);
	assert.deepEqual(filled.map(b => b.title), ['Tidewater', 'Box One', 'Box Two', 'Fen', 'Own First']);
	assert.deepEqual(json(books).map(b => [b.ext && b.ext.hardcover, b.e && b.e[0]]), [
		['77', { ext: { 'audible.com': 'B0TIDEWAT1', hardcover: '501' } }], ['70', { ext: { 'audible.com': 'B0BOXSET01', hardcover: '700' } }], ['70', { ext: { 'audible.com': 'B0BOXSET01', hardcover: '700' } }],
		['79', { ext: { goodreads: '4242' } }], ['8', { ext: { 'audible.com': 'B0KEPT0001', hardcover: '9' } }],
		['71', { ext: { 'audible.com': 'B0BOXSET01', hardcover: '700' } }],   // its own edition's Hardcover book, not the box set's
		[undefined, undefined],
	]);
	assert.deepEqual(Object.keys(json(books[0])), ['t', 'a', 'ext', 'e']);
});

test('planHardcoverExport adds what is missing on Hardcover and leaves everything there alone', () => {
	const books = [
		book('Tidewater', 'Ann Vale', { r: ['2022-01-09', '2024-03-15', '2025'], ext: { hardcover: '77' }, ...ed({ ext: { hardcover: '501' } }) }),
		book('Fen', 'Ann Vale', { ext: { hardcover: '78' } }),
		book('Box One', 'Ann Vale', { r: ['2023-02-01'], ext: { hardcover: '70' }, ...ed({ ext: { hardcover: '700' } }) }),
		book('Box Two', 'Ann Vale', { r: ['2023-02-01'], ext: { hardcover: '70' }, ...ed({ ext: { hardcover: '700' } }) }),
		book('Single Two', 'Ann Vale', { ext: { hardcover: '71' }, ...ed({ ext: { hardcover: '700' } }, { ext: { hardcover: '711' } }) }),
		book('Single Three', 'Ann Vale', { ext: { hardcover: '72' }, ...ed({ ext: { hardcover: '700' } }) }),
		book('Wanted', 'Ann Vale', { ext: { hardcover: '79' } }),
		book('Nowhere', 'Ann Vale'),
	];
	const shelf = [
		{ id: 1, book_id: 77, status_id: 3, user_book_reads: [{ finished_at: '2024-03-15' }] },
		{ id: 3, book_id: 79, status_id: 1, user_book_reads: [] },
	];
	const plan = json(HardcoverSync.planExport(Bs(books), shelf));
	assert.deepEqual(plan.add.map(a => [a.book, a.edition, a.dates, a.books.map(b => b.t)]), [
		[78, null, [], ['Fen']],                             // no date read: on the Read shelf without one
		[70, 700, ['2023-02-01'], ['Box One', 'Box Two']],   // a box set is one Hardcover book
		[71, 711, [], ['Single Two']],                       // a title's own edition before the box set's
		[72, null, [], ['Single Three']],                    // the box set's edition is not an edition of book 72
	]);
	assert.deepEqual(plan.reads, [{ userBook: 1, edition: 501, dates: ['2022-01-09'], books: [books[0]] }]);
	assert.deepEqual(plan.otherShelf.map(([r, s]) => [r.t, s]), [['Wanted', 'Want to Read']]);
	assert.deepEqual(plan.unknown.map(r => r.t), ['Nowhere']);
	assert.deepEqual(plan.inexact.map(([r, d]) => [r.t, d]), [['Tidewater', '2025']]);
	assert.equal(ExternalCatalog.url('hardcover', 'edition', '501'), 'https://hardcover.app/id/edition/501');

	// told which Hardcover book each edition is of, only an edition of the book's own is sent
	const lone = [book('Lone', 'Ann Vale', { ext: { hardcover: '72' }, ...ed({ ext: { hardcover: '700' } }) }), book('Mixed', 'Ann Vale', { ext: { hardcover: '73' }, ...ed({ ext: { hardcover: '700' } }, { ext: { hardcover: '731' } }) })];
	assert.deepEqual(HardcoverSync.exportEditions(Bs(lone)), [700, 731]);
	const editionBooks = new Map([['700', '70'], ['731', '73']]);
	assert.deepEqual(HardcoverSync.planExport(Bs(lone), [], editionBooks).add.map(a => [a.book, a.edition]), [[72, null], [73, 731]]);
	assert.deepEqual(HardcoverSync.planExport(Bs(lone.slice(0, 1)), []).add.map(a => [a.book, a.edition]), [[72, 700]], 'without it, a lone box set edition is taken as the book\'s');
});

test('merge: another Hardcover book found by a box set\'s edition is the box set, and its reads go to every title', () => {
	const box = () => ({ ext: { 'audible.com': 'BBOX', hardcover: '700' } });
	const books = [book('One', 'Ann Vale', { ext: { hardcover: '71' }, r: ['2024'], ...ed(box()) }), book('Two', 'Ann Vale', { ext: { hardcover: '72' }, ...ed(box()) }),
		book('Three', 'Ann Vale', { ext: { hardcover: '73' }, ...ed({ ext: { 'audible.com': 'B3' } }) })];
	const report = merge(books, [book('One and Two', 'Ann Vale', { ext: { hardcover: '70' }, r: ['2025-02-02'], ...ed(box()) })], null, { allDates: true });
	assert.deepEqual(books.map(b => [b.ext.hardcover, b.r]), [['71', ['2024', '2025-02-02']], ['72', ['2025-02-02']], ['73', undefined]]);
	assert.equal(report.datesFilled.length, 2);
	// the title's own Hardcover book, found by the same edition, reads only that title
	merge(books, [book('One', 'Ann Vale', { ext: { hardcover: '71' }, r: ['2026-01-01'], ...ed(box()) })], null, { allDates: true });
	assert.deepEqual(books.map(b => b.r && b.r.at(-1)), ['2026-01-01', '2025-02-02', undefined]);
});

test('Hardcover addresses name a book or an edition, and editions take an edition\'s address', async () => {
	assert.deepEqual(HardcoverClient.parseUrl('https://hardcover.app/books/tidewater/editions/501'), { edition: '501', slug: 'tidewater' });
	assert.deepEqual(HardcoverClient.parseUrl(' hardcover.app/books/tidewater '), { slug: 'tidewater' });
	assert.deepEqual(HardcoverClient.parseUrl('https://hardcover.app/books/tidewater/reviews/@ann?ref=x'), { slug: 'tidewater' });
	assert.deepEqual(HardcoverClient.parseUrl('http://www.hardcover.app/id/book/77#top'), { book: '77' });
	assert.deepEqual(HardcoverClient.parseUrl('https://hardcover.app/id/editions/501'), { edition: '501' });
	for (const other of ['77', 'https://hardcover.app/authors/ann-vale', 'https://hardcover.app/books/tidewater/editions/abc',
		'https://example.com/hardcover.app/id/book/1', 'https://hardcover.app.example.com/id/book/1', 'https://hardcover.app/', ''])
		assert.equal(HardcoverClient.parseUrl(other), null, other);

	assert.deepEqual(json(Edition.parse('Hardcover https://hardcover.app/books/tidewater/editions/501; ASIN B0X\nhardcover.app/books/tidewater/editions/9')),
		{ editions: [{ ext: { 'audible.com': 'B0X', hardcover: '501' } }, { ext: { hardcover: '9' } }], bad: [], book: {} });
	assert.deepEqual(json(Edition.parse('ASIN B0X; https://hardcover.app/id/book/77')), { editions: [{ ext: { 'audible.com': 'B0X' } }], bad: [], book: { hardcover: '77' } });
	// a book's page has no id in it: that goes in the book's own field
	assert.deepEqual(json(Edition.parse('ASIN B0X; https://hardcover.app/books/tidewater').bad), ['https://hardcover.app/books/tidewater']);
	assert.deepEqual(json(Edition.parse('Hardcover book https://hardcover.app/books/tidewater/editions/501').bad), ['Hardcover book https://hardcover.app/books/tidewater/editions/501']);
});

test('hardcoverBookId finds the book an address names, asking Hardcover only when the address lacks its id', async () => {
	const hc = fakeHardcover(hardcoverState());
	const client = new HardcoverClient('tok-123', hc.fetch, async () => {});
	assert.deepEqual(await HardcoverClient.bookId(client, ' 77 '), { id: '77' });
	assert.deepEqual(await HardcoverClient.bookId(client, 'https://hardcover.app/id/book/78'), { id: '78' });
	assert.equal(hc.sent.length, 0);
	assert.deepEqual(await HardcoverClient.bookId(client, 'https://hardcover.app/books/tidewater'), { id: '77', title: 'Tidewater' });
	assert.deepEqual(await HardcoverClient.bookId(client, 'https://hardcover.app/books/whatever/editions/801'), { id: '80', title: 'Lantern Hours' });
	assert.deepEqual(await HardcoverClient.bookId(client, 'https://hardcover.app/books/tidewater-2'), { id: '77', title: 'Tidewater' }, 'a merged book is the one it was merged into');
	assert.deepEqual(hc.sent.map(s => s.variables), [{ slug: 'tidewater' }, { id: 801 }, { slug: 'tidewater-2' }]);
	await assert.rejects(HardcoverClient.bookId(client, 'https://hardcover.app/books/no-such-book'), /Hardcover has no book at hardcover\.app\/books\/no-such-book/);
	await assert.rejects(HardcoverClient.bookId(client, 'https://hardcover.app/id/edition/999'), /Hardcover has no edition 999/);
	await assert.rejects(HardcoverClient.bookId(client, 'Tidewater'), /not a Hardcover book id, or the address/);
	// without a way to ask (no token), only an address that holds the id is read
	assert.deepEqual(await HardcoverClient.bookId(null, 'https://hardcover.app/id/book/78'), { id: '78' });
	await assert.rejects(HardcoverClient.bookId(null, 'https://hardcover.app/books/tidewater'), /needs Hardcover/);
});

test('errorText gives what went wrong, whatever was thrown', () => {
	assert.equal(Text.errorText(new Error('no such book')), 'no such book');
	assert.equal(Text.errorText({ message: 'from another realm' }), 'from another realm');
	assert.equal(Text.errorText('just text'), 'just text');
	assert.equal(Text.errorText(null), 'null');
});

test('hardcoverAsker asks one query a request, pausing between them, and says plainly when Hardcover says no', async () => {
	const sent = [];
	let paused = 0, answer = { ok: true, status: 200, json: async () => ({ data: { me: [{ id: 42 }] } }) };
	const get = async (url, init) => { sent.push([url, init]); return answer; };
	const client = new HardcoverClient(' Bearer tok-123 ', get, async () => { paused++; });
	const ask = (query, variables) => client.ask(query, variables);
	assert.deepEqual(await ask('query { me { id } }'), { me: [{ id: 42 }] });
	assert.equal(paused, 0, 'no pause before the first request');
	const [url, init] = sent[0];
	assert.equal(url, 'https://api.hardcover.app/v1/graphql');
	assert.equal(init.method, 'POST');
	// only the headers a browser may send to another site (no user-agent unless asked for)
	assert.deepEqual(init.headers, { 'content-type': 'application/json', authorization: 'Bearer tok-123' });
	assert.deepEqual(JSON.parse(init.body), { query: 'query { me { id } }', variables: {} });
	answer = { ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) };
	await assert.rejects(ask('query { me { id } }'), /Hardcover refused your token/);
	assert.equal(paused, 1);
	answer = { ok: true, status: 200, json: async () => ({ errors: [{ message: 'field "x" not found' }] }) };
	await assert.rejects(ask('query { x }'), /^Error: Hardcover: field "x" not found$/);
	const named = new HardcoverClient('t', get, async () => {}, { 'user-agent': 'test' });
	answer = { ok: true, status: 200, json: async () => ({ data: {} }) };
	await named.ask('query { me { id } }');
	assert.equal(sent.at(-1)[1].headers['user-agent'], 'test');
	assert.equal(HardcoverClient.cleanToken('  bearer abc '), 'abc');
});

test('British spelling: the first English language decides; otherwise American', () => {
	for (const langs of [['en-GB'], ['en_AU'], ['sv-SE', 'sv', 'en-GB', 'en-US'], ['en-IE'], ['en-Latn-NZ'], ['EN-in']]) assert.equal(Text.prefersBritish(langs), true, langs.join());
	for (const langs of [[], ['en'], ['en-US', 'en-GB'], ['sv-SE', 'sv'], ['fr-CA'], ['de-GB']]) assert.equal(Text.prefersBritish(langs), false, langs.join());
});

test('spelled() respells the app\'s words for British readers, and leaves names and identifiers as they are', () => {
	assert.equal(Text.spelled('Check the catalog', true), 'Check the catalogue');
	assert.equal(Text.spelled('Audiobook Catalog · this catalog\'s version · two catalogs', true), 'Audiobook Catalogue · this catalogue\'s version · two catalogues');
	assert.equal(Text.spelled('the catalogue', true), 'the catalogue');
	assert.equal(Text.spelled('audiobook-catalog-backup, read:catalog, catalogs-x, cataloging', true), 'audiobook-catalog-backup, read:catalog, catalogs-x, cataloging');
	assert.equal(Text.spelled('Check the catalog', false), 'Check the catalog');
});

// ------------------------------------------------------------------ IndexedDB records
// Numbered ids, so tests can name them.
const numbered = () => { let n = 0; return () => `id-${++n}`; };
// A catalog's records, and the catalog they make again, as a backup has it (without the ids).
const recordsOf = (catalog, newId = numbered()) => CatalogRecords.fromCatalog(catalog, newId);
const withoutIds = x => JSON.parse(JSON.stringify(x), (k, v) => (k === 'uid' || k === 'ids' ? undefined : v));
const BOX = { ext: { 'audible.com': 'B0BOX00001' }, n: ['Cy Hale'], p: 'Gull Audio' };
const shelf = () => Catalog.fromJSON({
	books: [
		{ t: 'The Glass Orchard', a: ['Mira Tallis'], s: 'Orchard Cycle', sn: '1', g: ['Fantasy'], r: ['2024-01-05', '2025-02-03'], e: [BOX, { ext: { goodreads: '4001' } }] },
		{ t: 'Orchard Frost', a: ['Mira Tallis', 'Odo Wren'], s: 'Orchard Cycle', sn: '2', e: [BOX] },
		{ t: 'Orchard Cycle, Books 1-2', a: ['Mira Tallis'], s: 'Orchard Cycle', sn: '1-2', e: [BOX] },
		{ t: 'A Quiet Harbor', a: ['Odo Wren'], e: [{ isbn: '9780306406157', n: ['Mira Tallis'] }] },
	],
	seriesInfo: { 'Orchard Cycle': { total: 3, status: 'ongoing' } },
	authors: { 'Mira Tallis': { bio: 'Writes about orchards.' } },
	narrators: { 'Cy Hale': { url: 'https://example.com/cy' } },
	excluded: ['B0GONE0001', 'Gone | Odo Wren'],
});

test('records: a catalog becomes records pointing at each other by id, and the same catalog again', () => {
	const catalog = shelf();
	const before = withoutIds(catalog);
	const records = recordsOf(catalog);
	assert.deepEqual(withoutIds(CatalogRecords.toCatalog(records)), before);
	const [orchard, frost, set, harbor] = records.books;
	assert.deepEqual(orchard, { id: 'id-1', title: 'The Glass Orchard', authorIds: [records.contributors.find(c => c.name === 'Mira Tallis' && c.kind === 'author').id],
		genres: ['Fantasy'], read: ['2024-01-05', '2025-02-03'], editionIds: ['id-5', 'id-6'], position: 0, sortTitle: 'glass orchard', titleKey: 'the glass orchard',
		firstAuthorKey: 'mira tallis', words: ['the', 'glass', 'orchard', 'mira', 'tallis'], seriesId: orchard.seriesId, seriesKey: 'orchardcycle',
		isCollection: 0, numberKey: 1, numberEnd: 1, number: '1', lastRead: '2025-02-03', externalKeys: [], readYears: ['2024', '2025'], search: orchard.search });
	assert.ok(orchard.search.startsWith('the glass orchard mira tallis orchard cycle fantasy b0box00001'), 'what a search looks in');
	assert.deepEqual(harbor.readYears, ['undated']);
	assert.equal(harbor.standalone, 1);
	assert.deepEqual([set.isCollection, set.numberKey, set.numberEnd], [1, 1, 2]);
	assert.equal(harbor.seriesId, undefined, 'a book without a series is in no series index');
	// the box set's edition is one record on all three books
	const box = records.editions.find(ed => ed.idKeys.includes('asin B0BOX00001'));
	assert.deepEqual(box.bookIds, [orchard.id, frost.id, set.id]);
	assert.ok([orchard, frost, set].every(b => b.editionIds.includes(box.id)));
	assert.equal(records.editions.length, 3);
	assert.deepEqual(records.series.map(x => [x.name, x.bookCount, x.owned, x.missing, x.total, x.lastRead, x.authorIds.length]), [['Orchard Cycle', 3, 2, [3], 3, '2025-02-03', 2]]);
	// someone who writes one book and narrates another has a record for each
	assert.deepEqual(records.contributors.filter(c => c.name === 'Mira Tallis').map(c => [c.kind, c.bookCount, c.bio]),
		[['author', 3, 'Writes about orchards.'], ['narrator', 1, undefined]]);
	assert.deepEqual(records.credits.filter(c => c.bookId === frost.id).map(c => c.kind), ['author', 'author', 'narrator', 'publisher']);
	assert.deepEqual(records.exclusions, [{ entry: 'B0GONE0001', position: 0 }, { entry: 'Gone | Odo Wren', position: 1 }]);
	// the catalog keeps the ids, so the next save finds the same records
	assert.deepEqual(catalog.books.map(b => b.id), ['id-1', 'id-2', 'id-3', 'id-4']);
	assert.deepEqual(CatalogRecords.changes(CatalogRecords.snapshot(records), recordsOf(catalog)).count, 0);
});

test('records: ids stay, a copy that differs or an id used twice gets its own, and a renamed series keeps its id', () => {
	const catalog = shelf();
	recordsOf(catalog);
	const ids = catalog.books.map(b => b.id), seriesId = catalog.nameIds.series.get('Orchard Cycle');
	// one copy of the box set's edition gains a description: it is an edition of its own now
	catalog.books[1].editions[0].description = 'with an extra story';
	// a book restored twice has the same id twice
	catalog.books.push(catalog.books[3].clone());
	catalog.renameEntry('series', 'Orchard Cycle', 'The Orchard Cycle');
	const records = recordsOf(catalog, () => 'new');
	assert.deepEqual(catalog.books.map(b => b.id), [...ids, 'new']);
	assert.equal(catalog.books[1].editions[0].id, 'new');
	assert.deepEqual(records.editions.find(ed => ed.id === catalog.books[0].editions[0].id).bookIds, [ids[0], ids[2]]);
	assert.deepEqual(records.series.map(x => [x.id, x.name]), [[seriesId, 'The Orchard Cycle']]);
	// a name no book has any more keeps its id: it is an entry of its own, until it is removed
	catalog.books.splice(3, 2);
	const narrator = catalog.nameIds.narrators.get('Mira Tallis');
	assert.ok(recordsOf(catalog).contributors.some(c => c.id === narrator && c.bookCount === 0));
	assert.equal(catalog.nameIds.narrators.get('Mira Tallis'), narrator);
	assert.deepEqual(catalog.removeEntry('narrators', narrator), []);
	assert.equal(recordsOf(catalog).contributors.some(c => c.id === narrator), false);
});

test('renameEntry renames a person on every book, keeping their id, or joins one the catalog has', () => {
	const catalog = Catalog.fromJSON({ books: [
		book('Fern 1', 'Bo Reed', { a: ['Bo Reed', 'B. Reed'], e: [{ n: ['Cy Hale', 'C. Hale'], p: 'Gull Audio' }] }),
		book('Fern 2', 'B. Reed', { e: [{ n: ['C. Hale'], p: 'Gull Press' }] }),
		book('Other', 'Ann Vale'),
	], authors: { 'B. Reed': { bio: 'Short.' } } });
	catalog.assignIds();
	const id = (kind, name) => catalog.nameIds[kind].get(name);
	const publisher = id('publishers', 'Gull Press');
	assert.equal(catalog.renameEntry('publishers', 'Gull Press', 'Gull Audio Press'), 1);
	assert.deepEqual(catalog.books.map(b => b.editions[0]?.publisher), ['Gull Audio', 'Gull Audio Press', undefined]);
	assert.equal(id('publishers', 'Gull Audio Press'), publisher);
	assert.equal(id('publishers', 'Gull Press'), undefined);
	// joining: a book naming both names the one left once, which keeps its id, and gets the info moved
	const bo = id('authors', 'Bo Reed'), short = id('authors', 'B. Reed');
	assert.equal(catalog.renameEntry('authors', 'B. Reed', 'Bo Reed'), 2);
	assert.deepEqual(catalog.books.map(b => b.authors), [['Bo Reed'], ['Bo Reed'], ['Ann Vale']]);
	assert.equal(id('authors', 'Bo Reed'), bo);
	assert.equal(catalog.authors.has(short), false);
	assert.deepEqual(catalog.authors.get(bo).toJSON(), { bio: 'Short.' });
	assert.equal(catalog.authors.get(bo).name, 'Bo Reed');
	assert.equal(catalog.renameEntry('narrators', 'C. Hale', 'Cy Hale'), 2);
	assert.deepEqual(catalog.books.map(b => b.editions[0]?.narrators), [['Cy Hale'], ['Cy Hale'], undefined]);
	catalog.assignIds();
	assert.deepEqual([...catalog.nameIds.authors.keys()].sort(), ['Ann Vale', 'Bo Reed']);
});

test('removeEntry takes a series or person off every book, and refuses to leave a book without an author', () => {
	const catalog = Catalog.fromJSON({ books: [
		book('Fern 1', 'Bo Reed', { a: ['Bo Reed', 'Ann Vale'], s: 'Fern Saga', sn: '1', e: [{ n: ['Cy Hale', 'Di Moss'], p: 'Gull Audio' }] }),
		book('Fern 2', 'Bo Reed', { s: 'Fern Saga', sn: '2', e: [{ n: ['Cy Hale'] }] }),
	], seriesInfo: { 'Fern Saga': { total: 3, status: 'ongoing' } } });
	catalog.assignIds();
	const id = (kind, name) => catalog.nameIds[kind].get(name);
	assert.deepEqual(catalog.removeEntry('series', id('series', 'Fern Saga')).map(b => b.title), ['Fern 1', 'Fern 2']);
	assert.ok(catalog.books.every(b => b.series === undefined && b.number === undefined));
	assert.equal(catalog.series.size, 0);
	assert.equal(catalog.nameIds.series.size, 0);
	assert.deepEqual(catalog.removeEntry('narrators', id('narrators', 'Cy Hale')).length, 2);
	assert.deepEqual(catalog.books.map(b => b.editions[0].narrators), [['Di Moss'], []]);
	catalog.removeEntry('publishers', id('publishers', 'Gull Audio'));
	assert.equal(catalog.books[0].editions[0].publisher, undefined);
	// Ann Vale shares her book; Bo Reed is the only author of Fern 2
	assert.equal(catalog.removeProblem('authors', id('authors', 'Ann Vale')), '');
	catalog.removeEntry('authors', id('authors', 'Ann Vale'));
	assert.deepEqual(catalog.books[0].authors, ['Bo Reed']);
	assert.equal(catalog.removeProblem('authors', id('authors', 'Bo Reed')),
		'Bo Reed is the only author of 2 books (Fern 1, Fern 2): give them another author first, or remove them.');
	assert.throws(() => catalog.removeEntry('authors', id('authors', 'Bo Reed')), /only author/);
	// the ids of what is left are kept, and nothing removed comes back
	catalog.assignIds();
	assert.deepEqual([...catalog.nameIds.narrators.keys()], ['Di Moss']);
	assert.deepEqual([...catalog.nameIds.authors.keys()], ['Bo Reed']);
});

test('records: marks point at books, so they hold when a book is retitled', () => {
	const catalog = shelf();
	const [orchard, , , harbor] = catalog.books;
	// marks as a backup has them, before the books have ids: kept as text, and they count already
	assert.equal(catalog.addMarkTexts([Duplicates.pairKey(orchard, harbor), Duplicates.editionsKey(orchard), 'an old mark']), 3);
	assert.ok(catalog.duplicates().markedNotSame(orchard, harbor));
	const records = recordsOf(catalog);
	assert.deepEqual(records.marks.map(m => [m.kind, m.bookIds, m.editionIds]), [
		['notDuplicates', ['id-1', 'id-4'], undefined], ['keepSeparate', ['id-1'], ['id-5', 'id-6']], ['text', undefined, undefined]]);
	// in memory they point at the books too, so a retitle keeps them, and a backup has them by the new title
	orchard.title = 'The Glass Orchard (Revised)';
	assert.ok(catalog.duplicates().markedNotSame(orchard, harbor));
	assert.ok(catalog.duplicates().markedSeparate(orchard));
	assert.deepEqual(catalog.markTexts(), [Duplicates.pairKey(orchard, harbor), Duplicates.editionsKey(orchard), 'an old mark']);
	assert.equal(catalog.addMarkTexts([Duplicates.pairKey(orchard, harbor)]), 0, 'a mark it has already');
	records.books[0].title = 'Glass Orchard';
	const back = CatalogRecords.toCatalog(records);
	assert.ok(back.duplicates().markedNotSame(back.books[0], back.books[3]));
	assert.ok(back.markTexts().includes(Duplicates.editionsKey(back.books[0])));
	assert.ok(back.markTexts().includes('an old mark'));
	// marked by hand: by id; a book given another edition is offered again, and a book removed takes its pair mark along
	const frost = back.books[1];
	assert.equal(back.markNotDuplicates([back.books[2], frost]), 1);
	assert.ok(back.marks.has(`pair ${[back.books[2].id, frost.id].sort().join(' ')}`));
	back.books[0].editions.push(E({ ext: { goodreads: '4002' } }));
	back.books.splice(2, 1);
	back.assignIds();
	assert.ok(!back.duplicates().markedSeparate(back.books[0]));
	assert.deepEqual([...back.marks.values()].map(m => m.kind), ['notDuplicates', 'text', 'text']);
});

test('records: what a record has no place for is named, so it is fixed before it is stored', () => {
	const catalog = Catalog.fromJSON({ books: [{ t: 'Odd', a: ['Me'], g: 5, e: [{ len: '10h', x: 1 }] }], seriesInfo: {} });
	assert.deepEqual(CatalogRecords.unstorable(catalog), ["book #0 ('Odd'): 'g'", "book #0 ('Odd') edition #1: 'len', 'x'"]);
	assert.deepEqual(CatalogRecords.unstorable(shelf()), []);
});

test('the database saves only what changed, refuses a save over another tab\'s, and pages through an index', async () => {
	const factory = new FakeIndexedDB();
	const db = await CatalogDatabase.open(factory, undefined, FakeKeyRange);
	assert.equal(await db.load(), null, 'nothing saved yet');
	const catalog = shelf();
	const records = recordsOf(catalog);
	const first = CatalogRecords.changes(new Map(), records);
	assert.equal((await db.save(first, null)).revision, 1);
	await assert.rejects(db.save(first, null), CatalogConflict, 'another tab saved first');
	catalog.books[3].title = 'A Quieter Harbor';
	const second = CatalogRecords.changes(first.snapshot, recordsOf(catalog));
	assert.deepEqual(Object.keys(second.put), ['books'], 'credits are worked out by the save');
	assert.deepEqual(second.put.books.map(b => b.title), ['A Quieter Harbor']);
	assert.equal((await db.save(second, 1)).revision, 2);
	const loaded = await db.load();
	assert.equal(loaded.revision, 2);
	assert.deepEqual(withoutIds(CatalogRecords.toCatalog(loaded.records)), withoutIds(catalog));

	// a page of books A-Z, the next page after its last row, one series in reading order, a narrator's titles
	const ask = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
	const tx = db.db.transaction(['books', 'credits'], 'readonly');
	const byTitle = tx.objectStore('books').index('byTitle');
	const page = await ask(byTitle.getAll(null, 2));
	assert.deepEqual(page.map(b => b.title), ['The Glass Orchard', 'Orchard Cycle, Books 1-2']);
	const last = page[page.length - 1];
	assert.deepEqual((await ask(byTitle.getAll(FakeKeyRange.lowerBound([last.sortTitle, last.id], true), 2))).map(b => b.title), ['Orchard Frost', 'A Quieter Harbor']);
	assert.equal(await ask(byTitle.count()), 4);
	const series = records.series[0].id;
	assert.deepEqual((await ask(tx.objectStore('books').index('bySeries').getAll(FakeKeyRange.bound([series], [series, []])))).map(b => b.number), ['1', '2', '1-2']);
	const narrator = records.contributors.find(c => c.kind === 'narrator' && c.name === 'Mira Tallis').id;
	assert.deepEqual((await ask(tx.objectStore('credits').index('byTitle').getAll(FakeKeyRange.bound([narrator], [narrator, []])))).map(c => c.bookId), ['id-4']);
	assert.deepEqual((await ask(tx.objectStore('books').index('words').getAll(FakeKeyRange.bound('orch', 'orch\uffff')))).map(b => b.title).sort(),
		['Orchard Cycle, Books 1-2', 'Orchard Frost', 'The Glass Orchard']);

	// the same through a reader: one transaction, keyset pages, prefixes, distinct keys
	factory.resetReads();
	const read = await db.read(async r => {
		const first = await r.page('books', 'byTitle', null, 2);
		const next = await r.page('books', 'byTitle', [first[1].sortTitle, first[1].id], 2);
		const inSeries = await r.under('books', 'bySeries', [series]);
		const genres = await r.keys('books', 'genres');
		const byKey = await r.get('books', [inSeries[0].id, 'no-such-id', inSeries[0].id]);
		return {first, next, inSeries, genres, byKey, count: await r.count('books')};
	});
	assert.equal(read.revision, 2);
	assert.deepEqual(read.result.first.map(b => b.title), ['The Glass Orchard', 'Orchard Cycle, Books 1-2']);
	assert.deepEqual(read.result.next.map(b => b.title), ['Orchard Frost', 'A Quieter Harbor']);
	assert.deepEqual(read.result.inSeries.map(b => b.number), ['1', '2', '1-2']);
	assert.deepEqual(read.result.genres, [...new Set(records.books.flatMap(b => b.genres))].sort());
	assert.deepEqual(read.result.byKey.map(b => b.id), [read.result.inSeries[0].id]);
	assert.equal(read.result.count, 4);
	assert.equal(factory.reads('books'), 2 + 2 + 3 + 1, 'distinct keys and counts read no records');

	// set aside: the catalog is emptied, what was stored is kept under meta
	assert.equal(await db.setAside(loaded.records), 3);
	assert.deepEqual(factory.records('books'), []);
	assert.equal(factory.records('meta').find(m => m.key === 'unreadable').value.books.length, 4);
});

test('a save takes in what another tab saved, unless both changed the same entry', () => {
	const base = recordsOf(shelf());
	const saved = CatalogRecords.snapshot(base);
	const mine = CatalogRecords.toCatalog(base), theirs = CatalogRecords.toCatalog(base);
	// here: a book added to the series, by an author new to the catalog, and an exclusion
	mine.books.push(Book.fromJSON({ t: 'Orchard Thaw', a: ['Lio Marsh'], s: 'Orchard Cycle', sn: '3' }));
	mine.addExclusions(['Mine | Me']);
	// there: the series info and another book changed, a book removed, the same new author added
	theirs.seriesInfo('Orchard Cycle').total = 4;
	theirs.books[1].read = ['2026-01-01'];
	theirs.books.splice(3, 1);
	theirs.books.push(Book.fromJSON({ t: 'Lio Alone', a: ['Lio Marsh'] }));
	const their = recordsOf(theirs, () => `there-${Math.random()}`);
	const { records, conflicts } = CatalogRecords.merge(saved, recordsOf(mine, () => `here-${Math.random()}`), their);
	assert.deepEqual(conflicts, []);
	const merged = CatalogRecords.toCatalog(records);
	assert.deepEqual(merged.books.map(b => b.title), ['The Glass Orchard', 'Orchard Frost', 'Orchard Cycle, Books 1-2', 'Orchard Thaw', 'Lio Alone']);
	assert.deepEqual(merged.books[1].read, ['2026-01-01']);
	assert.equal(merged.seriesInfo('Orchard Cycle').total, 4);
	assert.deepEqual(merged.exclusions.entries.slice(-1), ['Mine | Me']);
	// the author both tabs added is one again once saved
	const again = recordsOf(merged);
	assert.equal(again.contributors.filter(c => c.name === 'Lio Marsh').length, 1);
	assert.deepEqual(merged.books.slice(3).map(b => b.authors), [['Lio Marsh'], ['Lio Marsh']]);

	// the same book changed on both sides, or changed here and removed there
	const here = CatalogRecords.toCatalog(base), there = CatalogRecords.toCatalog(base);
	here.books[0].title = 'Glass Orchard'; there.books[0].title = 'The Glass Orchard (Revised)';
	here.books[3].genres = ['Sea']; there.books.splice(3, 1);
	here.seriesInfo('Orchard Cycle').total = 5; there.seriesInfo('Orchard Cycle').total = 5;   // alike: no conflict
	assert.deepEqual(CatalogRecords.merge(saved, recordsOf(here), recordsOf(there)).conflicts, ['"Glass Orchard"', '"A Quiet Harbor"']);
});

test('records: external ids are kept by catalog and indexed; records from before them are read and saved again', async () => {
	const catalog = Catalog.fromJSON({
		books: [{ t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', ext: { hardcover: '77' }, e: [{ ext: { 'audible.com': 'B0TIDEWAT1', goodreads: '4242' } }] }],
		seriesInfo: { 'Gull Isle': { total: 3, ext: { goodreads: '90001' } } },
		authors: { 'Ann Vale': { ext: { 'audible.com': 'B0ANNVALE1', hardcover: 'ann-vale' }, links: ['https://example.org/ann'] } },
	});
	const records = recordsOf(catalog);
	assert.deepEqual(records.books[0].externalKeys, ['hardcover 77']);
	assert.deepEqual(records.books[0].external, { hardcover: '77' });
	assert.deepEqual(records.editions[0].external, { 'audible.com': 'B0TIDEWAT1', goodreads: '4242' });
	assert.deepEqual(records.series[0].externalKeys, ['goodreads 90001']);
	const ann = records.contributors.find(c => c.name === 'Ann Vale');
	assert.deepEqual([ann.external, ann.links, ann.externalKeys], [{ 'audible.com': 'B0ANNVALE1', hardcover: 'ann-vale' }, ['https://example.org/ann'], ['audible.com B0ANNVALE1', 'hardcover ann-vale']]);
	assert.equal(CatalogRecords.outdated(records), false);
	assert.deepEqual(withoutIds(CatalogRecords.toCatalog(records)), withoutIds(catalog));

	// a database from before (version 1): ids under keys of their own, and the books' hardcoverId index
	const factory = new FakeIndexedDB();
	await new Promise((resolve, reject) => {
		const req = factory.open('audiobook-catalog', 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			for (const store of CatalogRecords.STORE_NAMES) db.createObjectStore(store, { keyPath: CatalogRecords.STORES[store].keyPath });
			db.createObjectStore('meta', { keyPath: 'key' });
			req.transaction.objectStore('books').createIndex('hardcoverId', 'hardcoverId');
		};
		req.onsuccess = () => {
			const db = req.result, tx = db.transaction([...CatalogRecords.STORE_NAMES, 'meta'], 'readwrite');
			const old = structuredClone(records);
			delete old.books[0].external; delete old.books[0].externalKeys; old.books[0].hardcoverId = '77';
			delete old.editions[0].external; Object.assign(old.editions[0], { asins: { 'audible.com': 'B0TIDEWAT1' }, goodreadsId: '4242' });
			const oldAnn = old.contributors.find(c => c.name === 'Ann Vale');
			delete oldAnn.external; delete oldAnn.links; delete oldAnn.externalKeys;
			Object.assign(oldAnn, { audible: 'https://www.audible.com/author/Ann-Vale/B0ANNVALE1', hardcover: 'https://hardcover.app/authors/ann-vale' });
			for (const store of CatalogRecords.STORE_NAMES) for (const rec of old[store]) tx.objectStore(store).put(rec);
			tx.objectStore('meta').put({ key: 'revision', value: 1 });
			tx.oncomplete = () => { db.close(); resolve(); };
		};
		req.onerror = () => reject(req.error);
	});
	const db = await CatalogDatabase.open(factory, undefined, FakeKeyRange);
	const books = db.db.transaction('books', 'readonly').objectStore('books');
	assert.ok(books.indexNames.contains('externalKeys') && !books.indexNames.contains('hardcoverId'), 'the indexes are brought up to date');
	const loaded = await db.load();
	assert.equal(CatalogRecords.outdated(loaded.records), true);
	const back = CatalogRecords.toCatalog(loaded.records);
	assert.deepEqual(json(back.books[0]).ext, { hardcover: '77' });
	assert.deepEqual(json(back.books[0]).e[0].ext, { 'audible.com': 'B0TIDEWAT1', goodreads: '4242' });
	assert.deepEqual(json(back.infoByName('authors').get('Ann Vale')), { ext: { 'audible.com': 'B0ANNVALE1', hardcover: 'ann-vale' } });
});

test('backups carry the ids: Restore keeps them, and Merge finds a book by its id first', () => {
	const catalog = shelf();
	recordsOf(catalog);
	const backup = JSON.parse(JSON.stringify(catalog));
	assert.equal(backup.books[0].uid, 'id-1');
	assert.equal(backup.books[0].e[0].uid, 'id-5');
	assert.deepEqual(backup.ids.series, { 'Orchard Cycle': catalog.nameIds.series.get('Orchard Cycle') });
	assert.deepEqual(Validator.validate(backup.books, backup.seriesInfo).errors, [], 'the Check knows the ids');
	const restored = Catalog.fromJSON(backup);
	assert.deepEqual(restored.books.map(b => b.id), ['id-1', 'id-2', 'id-3', 'id-4']);
	assert.deepEqual([...restored.nameIds.authors], [...catalog.nameIds.authors]);
	// retitled on the other device: still the same book
	backup.books[3].t = 'Harbor Lights';
	const m = Backup.read(backup).mergeInto(catalog, 'backup');
	assert.equal(m.added.length, 0);
	assert.deepEqual(m.books.map(b => [b.id, b.title]).at(3), ['id-4', 'Harbor Lights']);
	assert.throws(() => Backup.read({ books: [], ids: { series: { X: 5 } } }), /ids.series must map names to ids/);
});

// ------------------------------------------------------------------ comparing with another source
const COMPARED = () => new Catalog({ books: Bs([
	{ t: 'Salt Road', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', r: ['2020'], e: [{ ext: { 'audible.com': 'B1' }, n: ['Hollis Marr'], len: 600 }] },
	{ t: 'Paper Fen', a: ['Ann Vale'] },
	{ t: 'Only Mine', a: ['Bo Reed'] },
]) });
const INCOMING = () => Bs([
	{ t: 'Salt Road', a: ['Ann Vale'], s: 'Gull Isle Series', sn: '1', r: ['2023-01-05'], e: [{ ext: { 'audible.com': 'B1' }, n: ['Hollis Marr', 'Ida Quell'], p: 'Kestrel Row Audio', len: 601 }] },
	{ t: 'Paper Fen', a: ['Ann Vale'] },
	{ t: 'Lantern Hours', a: ['R. T. Hale'] },
]);

test('a comparison shows what is new, what an import fills in, and what differs, changing nothing', () => {
	const catalog = COMPARED();
	const before = JSON.stringify(catalog);
	const { books, onlyHere, merged } = Comparison.compare(catalog, INCOMING());
	assert.equal(JSON.stringify(catalog), before);
	assert.deepEqual(books.map(b => [b.at, b.kind]), [[0, 'gains'], [1, 'same'], [2, 'new']]);
	assert.deepEqual([books[0].gains, books[0].editionGains], [[], ['publisher']], 'a value this catalog lacks is filled in');
	// the series is spelled another way, the length one minute off (rounding): neither differs
	assert.deepEqual(books[0].differences.map(d => [d.key, d.label, d.here, d.there]), [
		['0:r', 'Dates read', '2020', '2023-01-05'],
		['0:n:0', 'Narrators', 'Hollis Marr', 'Hollis Marr, Ida Quell'],
	]);
	assert.deepEqual(json(books[2].added), [{ t: 'Lantern Hours', a: ['R. T. Hale'] }]);
	assert.deepEqual(onlyHere.map(b => b.title), ['Only Mine']);
	assert.equal(merged.books.length, 4, 'the copy has everything imported');
	// a series this catalog lacks is a difference, in the spelling in use, as an import does not add it
	const plain = new Catalog({ books: Bs([{ t: 'Tidewater', a: ['Ann Vale'] }, { t: 'Beacons', a: ['Ann Vale'], s: 'Gull Isle', sn: '2' }]) });
	const [tide] = Comparison.compare(plain, Bs([{ t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle Series', sn: '1' }])).books;
	assert.deepEqual(tide.differences.map(d => [d.field, d.here, d.value]), [['s', '', 'Gull Isle'], ['sn', '', '1']]);
	// a source that keeps every read (Hardcover) adds the dates on importing, so they are no difference
	assert.deepEqual(Comparison.compare(catalog, INCOMING(), { allDates: true }).books[0].differences.map(d => d.key), ['0:n:0']);
});

test('applying a comparison imports only the books picked, and replaces only the values picked', () => {
	const catalog = COMPARED();
	const incoming = INCOMING();
	const { report, patched } = Comparison.apply(catalog, incoming, { take: new Set([2]), patch: new Set(['0:n:0', '9:t']) });
	assert.equal(patched, 1);
	assert.deepEqual(report.added.map(b => b.title), ['Lantern Hours']);
	assert.deepEqual(json(catalog.books[0]), { t: 'Salt Road', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', r: ['2020'],
		e: [{ ext: { 'audible.com': 'B1' }, n: ['Hollis Marr', 'Ida Quell'], len: 600 }] }, 'not imported: no publisher, its date read kept');
	assert.deepEqual(catalog.books.map(b => b.title), ['Salt Road', 'Paper Fen', 'Only Mine', 'Lantern Hours']);

	// a book whose edition is not picked gains its dates read and ids, but not what its edition has
	const dated = new Catalog({ books: Bs([{ t: 'Salt Road', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'B1' } }] }]) });
	const goodreads = Bs([{ t: 'Salt Road', a: ['Ann Vale'], r: ['2023-01-05'], ext: { goodreads: '77' }, e: [{ ext: { goodreads: '4242' }, isbn: '9780306406157', p: 'Gull Audio' }] }]);
	const [gr] = Comparison.compare(dated, goodreads).books;
	assert.deepEqual([gr.gains, gr.editionGains], [['read 2023-01-05', 'Goodreads id'], ['Goodreads id, ISBN, publisher']]);
	Comparison.apply(dated, goodreads, { take: new Set([0]), editions: new Set(), patch: new Set() });
	assert.deepEqual(json(dated.books), [{ t: 'Salt Road', a: ['Ann Vale'], r: ['2023-01-05'], ext: { goodreads: '77' }, e: [{ ext: { 'audible.com': 'B1' } }] }]);

	// a difference that is gone by the time it is applied is left alone
	const again = Comparison.apply(catalog, incoming, { take: new Set(), patch: new Set(['0:n:0']) });
	assert.equal(again.patched, 0);

	// a box set's edition is one edition: each copy of it gets the value picked
	const sets = new Catalog({ books: Bs([
		{ t: 'Gull Isle, Book 1', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [{ ext: { 'audible.com': 'BSET' }, p: 'Old Press' }] },
		{ t: 'Gull Isle, Book 2', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [{ ext: { 'audible.com': 'BSET' }, p: 'Old Press' }] },
	]) });
	const from = Bs([{ t: 'Gull Isle, Book 1', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'BSET' }, p: 'Kestrel Row Audio' }] }]);
	assert.deepEqual(Comparison.compare(sets, from).books[0].differences.map(d => d.key), ['0:p:0']);
	Comparison.apply(sets, from, { take: new Set(), patch: new Set(['0:p:0']) });
	assert.deepEqual(sets.books.map(b => b.editions[0].publisher), ['Kestrel Row Audio', 'Kestrel Row Audio']);
});

test('a merge reports what became of each incoming book', () => {
	const books = Bs([{ t: 'Salt Road', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'B1' } }] }]);
	const report = new Merger(books, Exclusions.parse('Gone | Ann Vale')).merge(Bs([
		{ t: 'Salt Road', a: ['Ann Vale'], e: [{ ext: { 'audible.com': 'B1' } }] }, { t: 'New One', a: ['Ann Vale'] }, { t: 'Gone', a: ['Ann Vale'] },
		{ t: 'Gull Isle (books 1-2)', a: ['Ann Vale'], s: 'Gull Isle', sn: '1-2', e: [{ ext: { 'audible.com': 'BSET' } }] }]));
	assert.deepEqual(report.matches.map(m => [m.incoming.title, m.books.map(b => b.title), m.added.map(b => b.title), m.excluded, m.boxSet]), [
		['Salt Road', ['Salt Road'], [], false, false],
		['New One', [], ['New One'], false, false],
		['Gone', [], [], true, false],
		['Gull Isle (books 1-2)', [], ['Gull Isle, Book 1', 'Gull Isle, Book 2', 'Gull Isle (books 1-2)'], false, true],
	]);
});

test('comparing with Hardcover only reads it, and plans what putting your books there would do', async () => {
	const hc = fakeHardcover(hardcoverState());
	const sync = new HardcoverSync(new HardcoverClient('tok-123', hc.fetch, async () => {}));
	const catalog = new Catalog({ books: Bs([{ t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ ext: { 'audible.com': 'B0LANTERN1' } }] }]) });
	const before = JSON.stringify(catalog);
	const steps = [];
	const result = await sync.compare(catalog, text => steps.push(text));
	assert.equal(JSON.stringify(catalog), before);
	assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));
	assert.ok(steps.includes('Reading your Hardcover shelves'));
	assert.deepEqual(result.comparison.books.map(b => [b.theirs.title, b.kind]), [['Tidewater', 'new'], ['The Paper Fen', 'notAdded']]);
	assert.deepEqual(result.idsFound.map(b => [b.title, b.idOn('hardcover')]), [['Lantern Hours', '80']]);
	assert.deepEqual(result.plan.add.map(a => [a.book, a.edition, a.dates]), [[80, 801, ['2024-05-01']]]);
	assert.equal(result.otherShelves, 0);
});

test('comparing with Hardcover can be only a series\' or an author\'s books, on both sides', async () => {
	assert.ok(Comparison.scope('series', 'gull isle series')(B({ t: 'X', a: ['Ann Vale'], s: 'Gull Isle', sn: '1' })));
	assert.ok(!Comparison.scope('series', 'Gull Isle')(B({ t: 'X', a: ['Ann Vale'] })));
	assert.ok(Comparison.scope('author', 'ann vale')(B({ t: 'X', a: ['Bo Reed', 'Ann Vale'] })));
	const hc = fakeHardcover(hardcoverState());
	const sync = new HardcoverSync(new HardcoverClient('tok-123', hc.fetch, async () => {}));
	const catalog = new Catalog({ books: Bs([
		{ t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2024-05-01'], e: [{ ext: { 'audible.com': 'B0LANTERN1' } }] },
		{ t: 'Brine Tide', a: ['Ann Vale'], s: 'Gull Isle', sn: '2' },
	]) });
	const result = await sync.compare(catalog, () => {}, { kind: 'series', name: 'Gull Isle' });
	// only that part of your shelves is read from Hardcover
	assert.ok(!hc.sent.some(s => s.query.startsWith('query Shelf(')));
	assert.deepEqual(hc.sent.filter(s => s.query.startsWith('query ShelfBy')).map(s => [s.query.match(/^query (\w+)/)[1], s.variables.ids || s.variables.books]),
		[['ShelfBySeries', [3102]]], 'by the id of the series of that name');
	assert.deepEqual(result.incoming.map(b => b.title), ['Tidewater'], 'The Paper Fen is in no series');
	assert.deepEqual(result.comparison.books.map(b => [b.theirs.title, b.kind]), [['Tidewater', 'new']]);
	assert.deepEqual(result.plan.add, [], 'Lantern Hours is not in the series');
	assert.deepEqual(result.plan.unknown.map(b => b.title), ['Brine Tide']);
	assert.deepEqual(result.idsFound, []);

	// your books of an author are read by the Hardcover books they are, also where Hardcover has them by another name
	const sent = hc.sent.length;
	const byHale = await sync.compare(catalog, () => {}, { kind: 'author', name: 'R. T. Hale' });
	assert.deepEqual(hc.sent.slice(sent).filter(s => s.query.startsWith('query ShelfBy')).map(s => [s.query.match(/^query (\w+)/)[1], s.variables.ids || s.variables.books]),
		[['ShelfByAuthor', [4104]], ['ShelfByBooks', [80]]]);

	// a series named another way there is found by your books of it, and by the Hardcover id its info has
	const state = hardcoverState();
	state.books[77].featured_book_series.series.name = 'Gull Isle Series';
	const other = fakeHardcover(state);
	const named = new Catalog({ books: Bs([{ t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', e: [{ ext: { 'audible.com': 'B0TIDEWAT1' } }] }]) });
	const parts = await new HardcoverSync(new HardcoverClient('tok-123', other.fetch, async () => {})).compare(named, () => {}, { kind: 'series', name: 'Gull Isle', hardcover: '3999' });
	assert.deepEqual(other.sent.find(s => s.query.startsWith('query ShelfBySeries')).variables.ids, [3999, 3102]);
	assert.deepEqual(parts.comparison.books.map(b => [b.theirs.title, b.kind]), [['Tidewater', 'gains']]);
	assert.deepEqual(byHale.plan.add.map(a => a.book), [80]);
	assert.deepEqual(byHale.idsFound.map(b => b.title), ['Lantern Hours']);
});

test('a book\'s cover is looked for by its ASINs first, then its Open Library edition and its ISBN', () => {
	const book = Book.fromJSON({t: 'The Glass Orchard', a: ['Wren Halloway'], e: [
		{ext: {'audible.co.uk': 'B0GLASS001', 'amazon.com': 'B0GLASS002', goodreads: '4242'}, isbn: '9780000000002'},
		{ext: {'audible.com': 'B0GLASS003', openlibrary: 'OL123M'}, isbn: '9780000000002'},
		{ext: {'audible.co.jp': 'B0GLASS004', 'audible.com': 'not an asin'}}]});
	assert.deepEqual(Cover.addresses(book), [
		'https://m.media-amazon.com/images/P/B0GLASS001.01.MZZZZZZZ.jpg',
		'https://m.media-amazon.com/images/P/B0GLASS002.01.MZZZZZZZ.jpg',
		'https://m.media-amazon.com/images/P/B0GLASS003.01.MZZZZZZZ.jpg',
		'https://m.media-amazon.com/images/P/B0GLASS004.01.MZZZZZZZ.jpg',
		'https://covers.openlibrary.org/b/isbn/9780000000002-M.jpg?default=false',
		'https://covers.openlibrary.org/b/olid/OL123M-M.jpg?default=false']);
	assert.equal(Cover.addresses(book, 'large')[0], 'https://m.media-amazon.com/images/P/B0GLASS001.01.LZZZZZZZ.jpg');
	assert.equal(Cover.addresses(book, 'large').at(-1), 'https://covers.openlibrary.org/b/olid/OL123M-L.jpg?default=false');
	// nothing to find it by
	assert.deepEqual(Cover.addresses(Book.fromJSON({t: 'Untold', a: ['Ann Vale'], e: [{ext: {goodreads: '9'}}]})), []);
	// Amazon's answer for an ASIN without an image is a 1×1 picture
	assert.equal(Cover.isCover(1, 1), false);
	assert.equal(Cover.isCover(160, 160), true);
});

test('a series\' site, from before authors and publishers kept their own, goes to its one author or publisher, else its note', () => {
	const books = [
		{ t: 'One', a: ['Ann Vale'], s: 'Solo', sn: '1', e: [{ ext: { 'audible.com': 'B1' }, p: 'Gull Audio' }] },
		{ t: 'Two', a: ['Ann Vale'], s: 'Solo', sn: '2' },
		{ t: 'Three', a: ['Bo Reed'], s: 'Has Site', sn: '1' },
		{ t: 'Four', a: ['Cy Hale'], s: 'Pair', sn: '1', e: [{ ext: { 'audible.com': 'B4' }, p: 'Gull Audio' }] },
		{ t: 'Five', a: ['Di Moss'], s: 'Pair', sn: '2', e: [{ ext: { 'audible.com': 'B5' }, p: 'Gull Audio' }] },
		{ t: 'Six', a: ['Cy Hale'], s: 'Mixed', sn: '1', e: [{ ext: { 'audible.com': 'B6' }, p: 'Gull Audio' }] },
		{ t: 'Seven', a: ['Di Moss'], s: 'Mixed', sn: '2', e: [{ ext: { 'audible.com': 'B7' }, p: 'Owl Audio' }] },
	];
	const backup = Backup.read({ books, seriesInfo: {
		Solo: { url: ' https://example.com/ann ' },
		'Has Site': { total: 2, status: 'ongoing', url: 'https://example.com/bo-series' },
		Pair: { total: 2, status: 'complete', url: 'https://example.com/gull' },
		Mixed: { total: 3, status: 'ongoing', note: 'book 3 is announced', url: 'https://example.com/mixed' },
		Bad: { note: 1, url: 'https://example.com/bad' },
	}, authors: { 'Bo Reed': { url: 'https://example.com/bo' } }, publishers: {} });
	assert.deepEqual(json(Object.fromEntries(backup.series)), {
		'Has Site': { total: 2, status: 'ongoing' },
		Pair: { total: 2, status: 'complete' },
		Mixed: { total: 3, status: 'ongoing', note: 'book 3 is announced; site: https://example.com/mixed' },
		Bad: { note: 1, url: 'https://example.com/bad' },
	}, 'a series with nothing else goes; a note that isn\'t text keeps the site for the Check');
	assert.deepEqual(json(Object.fromEntries(/** @type {Map} */ (backup.authors))), {
		'Bo Reed': { url: 'https://example.com/bo', links: ['https://example.com/bo-series'] },
		'Ann Vale': { url: 'https://example.com/ann' },
	}, 'their own site, or another link when they have one');
	assert.deepEqual(json(Object.fromEntries(/** @type {Map} */ (backup.publishers))), { 'Gull Audio': { url: 'https://example.com/gull' } });

	// a backup from before author info was kept has nowhere to put it but the note
	const old = Backup.read({ books: books.slice(0, 2), seriesInfo: { Solo: { total: 2, status: 'ongoing', url: 'https://example.com/ann' } } });
	assert.deepEqual(json(old.series.get('Solo')), { total: 2, status: 'ongoing', note: 'site: https://example.com/ann' });
	assert.deepEqual(Validator.validate(books, { Solo: { total: 2, status: 'ongoing', url: 'https://example.com/' } }).errors, ["series-info['Solo']: unknown keys ['url']"]);

	// records from before keep it on the series record; the whole catalog moves it, and is saved again
	const catalog = Catalog.fromJSON({ books: books.slice(0, 2), seriesInfo: { Solo: { total: 2, status: 'ongoing' } }, authors: {} });
	const records = recordsOf(catalog);
	records.series[0].url = 'https://example.com/ann';
	assert.equal(CatalogRecords.outdated(records), true);
	const back = CatalogRecords.toCatalog(records);
	assert.equal(back.moveSeriesSites(), true);
	assert.deepEqual(json(back.infoByName('series').get('Solo')), { total: 2, status: 'ongoing' });
	assert.deepEqual(json(back.infoByName('authors').get('Ann Vale')), { url: 'https://example.com/ann' });
	assert.equal(back.moveSeriesSites(), false);
	assert.equal(CatalogRecords.outdated(recordsOf(back)), false);
});
