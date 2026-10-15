// Tests for the catalog's classes (public/modules): tidying, validation, the Audible and Goodreads readers,
// the merge, duplicates, backups and Hardcover.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Text } from '../public/modules/text.js';
import { Isbn } from '../public/modules/isbn.js';
import { Edition } from '../public/modules/edition.js';
import { Book } from '../public/modules/book.js';
import { Series } from '../public/modules/series.js';
import { Author } from '../public/modules/author.js';
import { Exclusions } from '../public/modules/exclusions.js';
import { Validator } from '../public/modules/validator.js';
import { Merger } from '../public/modules/merger.js';
import { Duplicates } from '../public/modules/duplicates.js';
import { Backup } from '../public/modules/backup.js';
import { Catalog } from '../public/modules/catalog.js';
import { Csv } from '../public/modules/csv.js';
import { AudibleImporter } from '../public/modules/audible-importer.js';
import { GoodreadsImporter } from '../public/modules/goodreads-importer.js';
import { GoodreadsExporter } from '../public/modules/goodreads-exporter.js';
import { HardcoverClient } from '../public/modules/hardcover-client.js';
import { HardcoverSync } from '../public/modules/hardcover-sync.js';
import { fakeHardcover, hardcoverState } from './fake-hardcover.mjs';

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
// The duplicate groups among books as stored.
const findDuplicates = (books, marks) => new Duplicates(Bs(books), marks).groups();

// ------------------------------------------------------------------ data
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'sample');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const loadBooks = file => Book.fixBooks(JSON.parse(read(file)));
const loadSeriesInfo = file => JSON.parse(read(file));
const loadAuthors = file => JSON.parse(read(file));

test('demo data validates without errors or warnings', () => {
	assert.deepEqual(Validator.validate(loadBooks(path.join(DATA, 'books.json')), loadSeriesInfo(path.join(DATA, 'series-info.json'))),
		{ errors: [], warnings: [] });
	assert.deepEqual(Validator.validateAuthors(loadBooks(path.join(DATA, 'books.json')), loadAuthors(path.join(DATA, 'authors.json'))),
		{ errors: [], warnings: [] });
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
	assert.deepEqual(new Duplicates(books, new Set([old])).groups(), []);
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
		...ed({ asin: { 'audible.com': 'B0X' }, n: ['A. B. Vale'], p: 'Gull Audio', desc: 'UK edition' }) });
	assert.equal(rec.t, 'A  Title ', 'the input record is not modified');
});

test('exclusions accept ASINs and title | author pairs', () => {
	const ex = Exclusions.parse('# comment\nB012345678  # trailing note\nSome Title | Some Author\n\n');
	assert.ok(ex.covers(B({ t: 'x', a: ['y'], ...ed({ gr: '1' }, { asin: { 'audible.com': 'B012345678' } }) })));
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

	assert.deepEqual(B({ t: 'Gone', a: ['Ann Vale'], ...ed({ asin: { 'audible.com': 'B9' } }) }).exclusionEntries(), ['B9', 'Gone | Ann Vale']);
	const odd = B({ t: 'Book #2 | Part One', a: ['Ann Vale'] });
	const [entry] = odd.exclusionEntries();
	assert.equal(entry, 'Book 2 Part One | Ann Vale');
	assert.ok(Exclusions.parse(entry).covers(odd));
});

test('validation: a clean catalog passes; required fields, unknown keys, ids', () => {
	const clean = [{ t: 'A', a: ['B'], s: 'S', sn: '1', g: ['x'], hcb: '77', ...ed({ asin: { 'audible.com': 'B0' }, gr: '1', hc: '5', isbn: '9780000000002', p: 'P', d: '2021-05', len: 600 }) }];
	assert.deepEqual(Validator.validate(clean, { S: { total: 3, status: 'ongoing', note: 'n', url: 'https://example.com' } }), { errors: [], warnings: [] });
	assert.equal(Validator.validate([{ t: '', a: ['x'] }, { t: 't', a: ['a'], bogus: 1 }, 'nope'], {}).errors.length, 3);
	assert.ok(Validator.validate([{ t: 't', a: ['a'], sn: '1' }], {}).errors.some(e => e.includes('no series')));
	// an old-style book-level id is an unknown key: fixBooks() turns it into an edition first
	assert.ok(Validator.validate([{ t: 't', a: ['a'], id: 'B0' }], {}).errors.some(e => e.includes("unknown key 'id'")));
	assert.ok(Validator.validate([{ t: '1', a: ['a'], ...ed({ asin: { 'audible.com': 'B0' } }) }, { t: '1', a: ['a'], ...ed({ asin: { 'audible.com': 'B0' } }) }], {}).errors.some(e => e.includes('duplicate ASIN B0')));
});

test('Goodreads ids: validated, excluded, and kept apart from ASINs', () => {
	assert.deepEqual(Validator.validate([{ t: 'A', a: ['B'], ...ed({ gr: '4242' }) }], {}), { errors: [], warnings: [] });
	assert.ok(Validator.validate([{ t: 'A', a: ['B'], ...ed({ gr: 'show/4242' }) }], {}).errors.some(e => e.includes('digits only')));
	assert.ok(Validator.validate([{ t: 'A', a: ['B'], ...ed({ gr: 4242 }) }], {}).errors.some(e => e.includes("'gr' must be")));
	assert.ok(Validator.validate([{ t: '1', a: ['a'], ...ed({ gr: '7' }) }, { t: '1', a: ['a'], ...ed({ gr: '7' }) }], {}).errors.some(e => e.includes('duplicate Goodreads id 7')));

	assert.deepEqual(B({ t: 'Gone', a: ['Ann Vale'], ...ed({ asin: { 'audible.com': 'B9' }, gr: '4242' }, { asin: { 'audible.com': 'B10' } }) }).exclusionEntries(), ['B9', 'B10', 'Goodreads 4242', 'Gone | Ann Vale']);
	const ex = Exclusions.parse('Goodreads 4242\ngr: 77  # the paperback\n');
	assert.deepEqual(ex.entries, ['Goodreads 4242', 'Goodreads 77']);
	assert.equal(ex.add('GOODREADS 4242'), null);
	assert.ok(ex.covers(B({ t: 'Renamed', a: ['Someone'], ...ed({ gr: '77' }) })));
	assert.ok(!ex.covers(B(Book.fixBooks([{ t: 'Renamed', a: ['Someone'], ...ed({ id: '77' }) }])[0])), 'a Goodreads id is not an ASIN');
	assert.ok(!Exclusions.parse('4242\n').covers(B({ t: 'x', a: ['y'], ...ed({ gr: '4242' }) })), 'a bare number is an ASIN, not a Goodreads id');
});

test('validation: series-info must match a series and be well formed', () => {
	const books = [{ t: 't', a: ['a'], s: 'Real' }];
	const errors = Validator.validate(books, {
		Ghost: { total: 2, status: 'ongoing', note: 'n' },
		Real: { total: 0, status: 'paused', note: '', url: 'ftp://x', extra: 1 },
	}).errors.join('\n');
	for (const needle of ["'Ghost' matches no series", 'status must be', 'total must be', 'url must start', 'unknown keys']) {
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
		[{ t: 'Ts', a: ['A'], s: 'S', sn: '2', g: ['Fantasy', 'Magic'], ...ed({ asin: { 'audible.com': 'B0000000A1' }, n: ['N'] }) }, null]);
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
	assert.deepEqual(json(result.books), [{ t: 'Second Wind', a: ['Ann'], s: 'Fantasy Adventures', sn: '2', ...ed({ asin: { 'audible.com': 'B2' } }) }]);
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
	assert.deepEqual(json(result.books), [{ t: 'The First Adventure', a: ['Ann'], s: 'Fantasy Adventures', sn: '1', ...ed({ gr: '4243' }) }]);
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
		{ t: 'Kept', a: ['Ann'], s: 'Series', sn: '2', g: ['urban-fantasy', 'witches'], r: ['2024-03-15'], ...ed({ gr: '4242', n: ['Nate Narrator'] }) },
		{ t: 'Some Book', a: ['A. B. Quill'], ...ed({ gr: '77', n: ['R. T. Hale'] }) },
		{ t: 'No Id', a: ['Dee'] },
	]);
	assert.equal(result.skippedUnfinished, 1);
});

test('Goodreads CSV: every book on the read shelf, one own edition\'s ids, the latest full date read', () => {
	const box = { asin: { 'audible.com': 'BBOX' }, isbn: '9781000000009' };
	const books = [
		{ ...book('Kept'), a: ['Ann Vale', 'Bo Reed'], s: 'Saga, Told', sn: '2', g: ['Science Fiction', 'Witches'],
			...ed({ asin: { 'audible.com': 'B1' }, p: 'Pub', d: '2019-04-02' }, { gr: '4242', isbn: '9780306406157', d: '2020' }), r: ['2024-03-15', '2025-01', '2023-06-02'] },
		book('Boxed One', 'Cy', { ...ed(box), r: ['2024'] }),
		book('Boxed Two', 'Cy', { ...ed(box, { gr: '9' }) }),
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
	const incoming = [book('One'), book('Two', 'Author', { asin: { 'audible.com': 'B2' } })];
	const report = merge(existing, incoming);
	assert.deepEqual(existing.map(b => b.t), ['One', 'Two']);
	assert.deepEqual([report.matched, report.added.length], [1, 1]);
	assert.equal(merge(existing, structuredClone(incoming)).added.length, 0);
	assert.equal(existing.length, 2);
});

test('merge: hand edits win but a missing id is filled in', () => {
	const existing = [book('A Spark of Dawn', 'Ilse Marlowe', { s: 'A Crown of Embers', sn: '5', g: ['Mine'] })];
	const report = merge(existing, [book('A Crown of Embers 5: A Spark of Dawn', 'Ilse Marlowe',
		{ s: 'A Crown of Embers Series', sn: '5', g: ['Theirs'], ...ed({ asin: { 'audible.com': 'B5' } }) })]);
	assert.deepEqual(existing, [{ t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5', g: ['Mine'], ...ed({ asin: { 'audible.com': 'B5' } }) }]);
	assert.equal(report.backfilled.length, 1);
});

test('merge: a Goodreads id matches a renamed book, and a missing one is filled in', () => {
	const existing = [book('Renamed By Hand', 'Author', ed({ gr: '4242' })), book('No Id Yet', 'Author', ed({ asin: { 'audible.com': 'B77' } }))];
	const report = merge(existing, [book('Goodreads Title', 'Author', ed({ gr: '4242' })), book('No Id Yet', 'Author', ed({ gr: '77' }))]);
	assert.deepEqual(existing.map(b => [b.t, b.e]), [['Renamed By Hand', [{ gr: '4242' }]], ['No Id Yet', [{ asin: { 'audible.com': 'B77' }, gr: '77' }]]]);
	assert.deepEqual([report.added.length, report.goodreadsFilled.length, report.backfilled.length, report.editionsAdded.length], [0, 1, 0, 0]);
	assert.equal(merge(existing, [book('Renamed Again', 'Author', ed({ gr: '77' }))]).added.length, 0);
});

test('merge: dates read are filled in on books without any, never replaced', () => {
	const existing = [book('Dated', 'Author', { r: ['2020-01-01'] }), book('Undated')];
	const report = merge(existing, [book('Dated', 'Author', { r: ['2024-03-15'] }), book('Undated', 'Author', { r: ['2024-04-01'] })]);
	assert.deepEqual(existing.map(b => b.r), [['2020-01-01'], ['2024-04-01']]);
	assert.deepEqual([report.datesFilled.length, report.added.length], [1, 0]);
	assert.equal(merge(existing, [book('Undated', 'Author', { r: ['2025-01-01'] })]).datesFilled.length, 0);
});

test('merge: ids, long titles, boxed sets, series spelling, exclusions, authors', () => {
	let existing = [book('Completely Renamed', 'Author', ed({ asin: { 'audible.com': 'B7' } }))];
	assert.equal(merge(existing, [book('Original Title', 'Author', ed({ asin: { 'audible.com': 'B7' } }))]).added.length, 0);

	existing = [book('A Crown of Embers', 'Ilse Marlowe')];
	merge(existing, [book('A Crown of Embers, Book 1', 'Ilse Marlowe', ed({ asin: { 'audible.com': 'B1' } }))]);
	assert.deepEqual([existing.length, existing[0].e], [1, [{ asin: { 'audible.com': 'B1' } }]]);

	existing = [book('Lantern of the Deep', 'R.T. Hale')];
	assert.equal(merge(existing, [book('Lantern of the Deep: Books 1-3', 'R.T. Hale')]).added.length, 1);

	existing = [book('One', 'Author', { s: 'Ember Coast', sn: '1' })];
	merge(existing, [book('Two', 'Author', { s: 'Ember Coast Series', sn: '2' }), book('Three', 'Author', { s: 'ember-coast', sn: '3' })]);
	assert.deepEqual([...new Set(existing.map(b => b.s))], ['Ember Coast']);

	existing = [];
	const ex = Exclusions.parse('B9\nRemoved Box Set | Author\n');
	const report = merge(existing, [book('Gone', 'Author', ed({ asin: { 'audible.com': 'B9' } })), book('Removed Box Set'), book('Fine')], ex);
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
	assert.deepEqual(Edition.splitIsbns({ asin: { 'audible.com': 'B1' }, isbn: '978-0-00-000000-2, 0306406152' }), [{ asin: { 'audible.com': 'B1' }, isbn: ISBN_A }, { isbn: ISBN_BOX }]);
	assert.deepEqual(Edition.splitIsbns({ asin: { 'audible.com': 'B1' }, n: ['Ann Vale'], isbn: [ISBN_A, '0-306-40615-2', ISBN_A] }), [{ asin: { 'audible.com': 'B1' }, isbn: ISBN_A, n: ['Ann Vale'] }, { isbn: ISBN_BOX }]);
	assert.deepEqual(Edition.splitIsbns({ asin: { 'audible.com': 'B1' }, isbn: ' ' }), [{ asin: { 'audible.com': 'B1' } }]);
	assert.deepEqual(Edition.splitIsbns({ asin: { 'audible.com': 'B1' }, isbn: 'soon' }), [{ asin: { 'audible.com': 'B1' }, isbn: 'soon' }]);   // left for validate() to report
	// the lists of ISBNs from before one ISBN per edition are migrated on load; an ISBN another edition has is that edition
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: ['B'], ...ed({ asin: { 'audible.com': 'B1' }, isbn: [ISBN_A, ISBN_B] }, { gr: '7', isbn: [ISBN_B] }) }])[0].e,
		[{ asin: { 'audible.com': 'B1' }, isbn: ISBN_A }, { gr: '7', isbn: ISBN_B }]);
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
	const { errors, warnings } = Validator.validate([{ t: 'A', a: ['B'], ...ed({ isbn: '978-0-00-000000-2' }, { asin: { 'audible.com': 'B1' }, isbn: ISBN_A }) }], {});
	assert.deepEqual(errors, []);
	assert.ok(warnings.some(w => w.includes(`as '${ISBN_A}'`)));
	assert.ok(warnings.some(w => w.includes(`lists ISBN ${ISBN_A} on two editions`)));
});

test('ISBNs are read from Audible and Goodreads exports', () => {
	const audible = new AudibleImporter();
	const [rec] = audible.rowToBook({ Title: 'T', Authors: 'A', Progress: 'Finished', ASIN: 'B1', ISBN10: '0306406152', ISBN13: ISBN_BOX });
	assert.deepEqual(json(rec.editions), [{ asin: { 'audible.com': 'B1' }, isbn: ISBN_BOX }]);
	const [two] = audible.rowToBook({ Title: 'T', Authors: 'A', Progress: 'Finished', ASIN: 'B1', ISBN10: '0306406152', ISBN13: ISBN_A });
	assert.deepEqual(json(two.editions), [{ asin: { 'audible.com': 'B1' }, isbn: ISBN_BOX }, { isbn: ISBN_A }], 'two different ISBNs are two editions');
	assert.equal('e' in json(audible.rowToBook({ Title: 'T', Authors: 'A', Progress: 'Finished', ISBN13: 'n/a' })[0]), false);
	const result = new GoodreadsImporter().read('Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf\n'
		+ 'With,Ann,"=""0306406152""","=""9780306406157""",Audible Audio,read\n'
		+ 'Without,Ann,"=""""","=""""",Audiobook,read\n');
	assert.deepEqual(json(result.books), [{ t: 'With', a: ['Ann'], ...ed({ isbn: ISBN_BOX }) }, { t: 'Without', a: ['Ann'] }]);
});

test('merge: ISBNs fill in the matching edition, another ISBN is another edition, and ISBNs never make two books one', () => {
	const existing = [book('One', 'Author', ed({ asin: { 'audible.com': 'B1' } })), book('Two')];
	const report = merge(existing, [book('One', 'Author', ed({ asin: { 'audible.com': 'B1' }, isbn: ISBN_A })), book('Two', 'Author', ed({ isbn: ISBN_BOX }))]);
	assert.deepEqual(existing.map(b => b.e), [[{ asin: { 'audible.com': 'B1' }, isbn: ISBN_A }], [{ isbn: ISBN_BOX }]]);
	assert.deepEqual([report.isbnsFilled.length, report.editionsAdded.length, report.added.length], [2, 0, 0]);
	const again = merge(existing, [book('One', 'Author', ed({ isbn: ISBN_B }))]);
	assert.deepEqual([again.isbnsFilled.length, again.editionsAdded.length], [0, 1]);
	assert.deepEqual(existing[0].e, [{ asin: { 'audible.com': 'B1' }, isbn: ISBN_A }, { isbn: ISBN_B }]);

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
	assert.ok(ex.covers(B({ t: 'x', a: ['y'], ...ed({ asin: { 'amazon.com': '0306406152' } }) })));   // a bare ISBN-10 is also an ASIN
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
	assert.deepEqual(old, { t: 'A', a: ['B'], r: ['2024'], e: [{ asin: { 'audible.com': 'B1' }, gr: '7', isbn: ISBN_A }] });
	// half migrated by hand: the old fields fill in the edition with the same ASIN, or come first
	assert.deepEqual(Book.fixEditions({ t: 'A', a: ['B'], gr: '7', e: [{ asin: { 'audible.com': 'B2' } }, { asin: { 'audible.com': 'B1' }, isbn: ISBN_A }] }).e,
		[{ gr: '7' }, { asin: { 'audible.com': 'B2' } }, { asin: { 'audible.com': 'B1' }, isbn: ISBN_A }]);
	assert.deepEqual(Book.fixEditions({ t: 'A', a: ['B'], id: 'B1', gr: '7', e: [{ asin: { 'audible.com': 'B1' }, p: 'P' }] }).e, [{ asin: { 'audible.com': 'B1' }, gr: '7', p: 'P' }]);
	assert.deepEqual(Book.fixEditions({ t: 'A', a: ['B'], e: [] }), { t: 'A', a: ['B'] });
	const current = { t: 'A', a: ['B'], e: [{ asin: { 'audible.com': 'B1' } }] };
	assert.deepEqual(Book.fixEditions(current), current);
	assert.deepEqual(json(Backup.read([{ t: 'A', a: ['B'], id: 'B1' }]).books[0].editions), [{ asin: { 'audible.com': 'B1' } }]);
});

test('editions: validation of fields, and of a box set edition shared by several titles', () => {
	const box = { asin: { 'audible.com': 'BBOX' }, isbn: ISBN_BOX, p: 'Gull Audio', len: 1200 };
	const clean = [{ t: 'Two', a: ['A'], s: 'S', sn: '2', e: [{ asin: { 'audible.com': 'B2' } }, box] }, { t: 'Three', a: ['A'], s: 'S', sn: '3', e: [{ ...box }] }];
	assert.deepEqual(Validator.validate(clean, {}), { errors: [], warnings: [] });

	const errors = Validator.validate([
		{ t: 'A', a: ['B'], e: [] }, { t: 'C', a: ['B'], e: [{}, { n: [''] }] },
		{ t: 'D', a: ['B'], e: [{ asin: { 'audible.com': 'B1' }, d: '15/03/2024', len: 12.5, extra: 1 }, 'nope'] },
		{ t: 'E', a: ['B'], e: [{ asin: { 'audible.com': 'B9' } }, { asin: { 'audible.com': 'B9' }, p: 'x' }] },
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
	assert.deepEqual(json(rec.editions), [{ asin: { 'audible.com': 'B1' }, p: 'Gull Audio', d: '2021-05-04', len: 642 }]);
	const result = new GoodreadsImporter().read('Book Id,Title,Author,Binding,Exclusive Shelf,Publisher,Year Published,Original Publication Year\n'
		+ '4242,T,A,Audible Audio,read,Gull Audio,2021,1999\n');
	assert.deepEqual(json(result.books[0].editions), [{ gr: '4242', p: 'Gull Audio', d: '2021' }]);
});

test('merge: an edition fills in its match, a lone edition, or is added as another edition', () => {
	// Goodreads finds the book Audible added: its only edition gains the Goodreads id and publisher
	const existing = [book('One', 'Author', ed({ asin: { 'audible.com': 'B1' }, p: 'Mine' }))];
	let report = merge(existing, [book('One', 'Author', ed({ gr: '7', p: 'Theirs', d: '2021' }))]);
	assert.deepEqual(existing[0].e, [{ asin: { 'audible.com': 'B1' }, gr: '7', p: 'Mine', d: '2021' }]);
	assert.deepEqual([report.goodreadsFilled.length, report.detailsFilled.length, report.editionsAdded.length], [1, 1, 0]);

	// another ASIN is another edition; later imports fill in the one they share an ISBN with
	report = merge(existing, [book('One', 'Author', ed({ asin: { 'audible.com': 'B1UK' }, isbn: ISBN_B }))]);
	assert.deepEqual(existing[0].e, [{ asin: { 'audible.com': 'B1' }, gr: '7', p: 'Mine', d: '2021' }, { asin: { 'audible.com': 'B1UK' }, isbn: ISBN_B }]);
	assert.equal(report.editionsAdded.length, 1);
	report = merge(existing, [book('One', 'Author', ed({ gr: '8', isbn: ISBN_B }))]);
	assert.deepEqual(existing[0].e[1], { asin: { 'audible.com': 'B1UK' }, gr: '8', isbn: ISBN_B });
	assert.equal(merge(existing, [book('Renamed', 'Author', ed({ gr: '8' }))]).added.length, 0, 'any edition finds the book');
	assert.equal(merge(existing, structuredClone([book('One', 'Author', ed({ gr: '8', isbn: ISBN_B }))])).editionsAdded.length, 0);
});

test('merge: a box set edition on several titles matches them, and is filled in on every copy', () => {
	const box = () => ({ asin: { 'audible.com': 'BBOX' } });
	const existing = [book('Two', 'Author', { s: 'S', sn: '2', ...ed(box()) }), book('Three', 'Author', { s: 'S', sn: '3', ...ed(box()) })];
	const report = merge(existing, [book('S: Books 2-3', 'Author', { s: 'S', sn: '2-3', ...ed({ asin: { 'audible.com': 'BBOX' }, p: 'Gull Audio' }) })]);
	assert.deepEqual([report.added.map(b => [b.t, b.sn]), report.matched], [[['S: Books 2-3', '2-3']], 1]);
	const filled = { asin: { 'audible.com': 'BBOX' }, p: 'Gull Audio', desc: 'S: Books 2-3' };
	assert.deepEqual(existing.map(b => b.e), [[filled], [filled], [filled]]);
	assert.notEqual(existing[0].e[0], existing[1].e[0], 'copies, not one shared object');

	// a book whose only edition is the box set gets its own edition rather than filling in the box set
	merge(existing, [book('Three', 'Author', ed({ gr: '33' }))]);
	assert.deepEqual(existing[1].e, [filled, { gr: '33' }]);
	assert.deepEqual(existing[0].e, [filled]);
});

test('merge: a box set is kept as its own book and becomes its titles, each with the same edition', () => {
	const existing = [
		book('Spark', 'Ann Vale', { s: 'Ember', sn: '1', ...ed({ asin: { 'audible.com': 'B1' }, n: ['Tobias Frane'] }) }),
		book('Flame', 'Ann Vale', { s: 'Ember', sn: '2', r: ['2023'] }),
		book('Other', 'Ann Vale', { s: 'Gull Isle', sn: '3' }),
	];
	const box = book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember Series', sn: '1-3', g: ['Fantasy'], r: ['2024-05-01'], ...ed({ asin: { 'audible.com': 'BBOX' }, n: ['Hollis Marr'] }) });
	const report = merge(existing, [box]);
	const set = { asin: { 'audible.com': 'BBOX' }, n: ['Hollis Marr'], desc: 'Ember: Books 1-3' };
	assert.deepEqual(existing.map(b => [b.t, b.sn, b.e, b.r]), [
		['Spark', '1', [{ asin: { 'audible.com': 'B1' }, n: ['Tobias Frane'] }, set], ['2024-05-01']],
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
	const gr = merge(existing, [book('The Ember Trilogy', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ gr: '99' }) })]);
	assert.deepEqual(gr.added, []);
	assert.deepEqual([0, 1, 3, 4].map(i => existing[i].e.at(-1)), Array(4).fill({ ...set, gr: '99' }));
	assert.equal(existing.length, 5, 'the set found by its edition, though Goodreads names it otherwise');
	assert.equal(existing[0].e.length, 2, 'the title\'s own edition is left alone');

	// a single title imported later finds the title the set added
	assert.equal(merge(existing, [book('Ember Falls', 'Ann Vale', { s: 'Ember', sn: '3', ...ed({ asin: { 'audible.com': 'B3' } }) })]).added.length, 0);
	assert.deepEqual(existing[3].e, [{ ...set, gr: '99' }, { asin: { 'audible.com': 'B3' } }]);
});

test('merge: a box set already in the catalog as one book gains its titles; without ids or excluded it stays as is', () => {
	const whole = [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ asin: { 'audible.com': 'BBOX' } }) })];
	merge(whole, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ asin: { 'audible.com': 'BBOX' }, p: 'Gull Audio' }) })]);
	const set = { asin: { 'audible.com': 'BBOX' }, p: 'Gull Audio', desc: 'Ember: Books 1-3' };
	assert.deepEqual(whole, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', e: [set] }),
		...[1, 2, 3].map(n => book(`Ember, Book ${n}`, 'Ann Vale', { s: 'Ember', sn: String(n), e: [set] }))]);

	const none = [];
	merge(none, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ n: ['Hollis Marr'] }) })]);
	assert.deepEqual(none.map(b => b.sn), ['1-3'], 'nothing would tie the titles together');

	const kept = [];
	const report = merge(kept, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ asin: { 'audible.com': 'BBOX' } }) })], Exclusions.parse('BBOX\n'));
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
	const box = () => ({ asin: { 'audible.com': 'BBOX' }, hc: '700' });
	const books = [book('One', 'Ann Vale', { s: 'Gull Isle', sn: '1', hcb: '71', ...ed(box()) }), book('Two', 'Ann Vale', { s: 'Gull Isle', sn: '2', hcb: '72', ...ed(box()) })];
	const report = merge(books, [book('Gull Isle Duology', 'Ann Vale', { hcb: '70', r: ['2025-02-02'], ...ed(box()) })], null, { allDates: true });
	assert.deepEqual(books[2], { t: 'Gull Isle Duology', a: ['Ann Vale'], s: 'Gull Isle', sn: '1-2', r: ['2025-02-02'], hcb: '70',
		e: [{ asin: { 'audible.com': 'BBOX' }, hc: '700', desc: 'Gull Isle Duology' }] });
	assert.deepEqual(books.map(b => b.r), Array(3).fill(['2025-02-02']));
	assert.deepEqual([report.added.length, report.boxSets.length], [1, 1]);
	// read again: the set finds itself, and reading it reads its titles
	merge(books, [book('Gull Isle Duology', 'Ann Vale', { hcb: '70', r: ['2026-03-03'], ...ed(box()) })], null, { allDates: true });
	assert.deepEqual([books.length, books.map(b => b.r.at(-1))], [3, Array(3).fill('2026-03-03')]);
	// a title's own Hardcover book reads only that title, even when the box set's edition finds another title first
	merge(books, [book('Two', 'Ann Vale', { hcb: '72', r: ['2026-04-04'], ...ed(box()) })], null, { allDates: true });
	assert.deepEqual(books.map(b => b.r.at(-1)), ['2026-03-03', '2026-04-04', '2026-03-03']);
	// exports: the set goes to Hardcover and Goodreads as the set's edition, its titles without it
	assert.deepEqual(HardcoverSync.planExport(Bs(books), []).add.map(a => [a.book, a.edition]), [[71, null], [72, null], [70, 700]]);
	const rows = Csv.parse(new GoodreadsExporter().write(Bs([book('One', 'Ann Vale', { s: 'Gull Isle', sn: '1', ...ed({ gr: '9' }) }),
		book('Gull Isle Duology', 'Ann Vale', { s: 'Gull Isle', sn: '1-2', ...ed({ gr: '9' }) })])).csv);
	assert.deepEqual(rows.map(r => r['Book Id']), ['', '9']);
});

test('boxSetBooks keeps each box set in the catalog as its own book and as its titles', () => {
	const tide = { asin: { 'audible.com': 'BTIDE' } }, ember = { asin: { 'audible.com': 'BEMBER' }, desc: 'Ember: Books 1-2' };
	const books = Bs([
		book('Tide: Books 1-3', 'Bo Lin', { s: 'Tide', sn: '1-3', r: ['2024'], ...ed({ ...tide }) }),
		book('Tide Two', 'Bo Lin', { s: 'Tide', sn: '2' }),
		book('Spark', 'Ann Vale', { s: 'Ember', sn: '1', r: ['2023', '2024'], ...ed({ ...ember }) }),
		book('Flame', 'Ann Vale', { s: 'Ember', sn: '2', r: ['2024'], ...ed({ ...ember }) }),
		book('Gap One', 'Cy Hale', { s: 'Gap', sn: '1', ...ed({ asin: { 'audible.com': 'BGAP' } }) }),   // not in a row: no set
		book('Gap Three', 'Cy Hale', { s: 'Gap', sn: '3', ...ed({ asin: { 'audible.com': 'BGAP' } }) }),
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
	const plain = Bs([book('A', 'X', { s: 'Saga', sn: '1', ...ed({ gr: '5' }) }), book('B', 'X', { s: 'Saga', sn: '2', ...ed({ gr: '5' }) })]);
	Merger.boxSets(plain);
	assert.deepEqual(json(plain[2]), book('Saga, Books 1-2', 'X', { s: 'Saga', sn: '1-2', e: [{ gr: '5' }] }));
});

test('Audible and Goodreads exports: a box set is read with its range', () => {
	const audible = new AudibleImporter().read('Title,Title Short,Authors,Series,Book Numbers,Progress,ASIN\n' +
		'"Ember: Books 1-3","Ember: Books 1-3",Ann Vale,"Ember (books 1-3)",1-3,Finished,BBOX\n');
	assert.deepEqual(json(audible.books), [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ asin: { 'audible.com': 'BBOX' } }) })]);
	const goodreads = new GoodreadsImporter().read(GR_HEADER + '99,"The Ember Trilogy (Ember, #1-3)",Ann Vale,,Audible Audio,read,,2024/05/01\n');
	assert.deepEqual(json(goodreads.books), [book('The Ember Trilogy', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ gr: '99' }), r: ['2024-05-01'] })]);
});

test('editions as text: formatted for the card and read back from the form', () => {
	const edition = { asin: { 'audible.com': 'B0X' }, gr: '4242', isbn: ISBN_A, n: ['Ann Vale'], p: 'Gull Audio', d: '2021-05', len: 642, desc: 'UK edition' };
	const line = E(edition).format();
	assert.equal(line, `UK edition; Narrated by Ann Vale; ASIN audible.com B0X; Goodreads 4242; ISBN ${ISBN_A}; Publisher Gull Audio; Released 2021-05; Length 10h 42m`);
	assert.deepEqual(json(Edition.parse(line)), { editions: [edition], bad: [], hcb: null });
	// text without a label is the description, once per edition; anything else unreadable is reported;
	// a second ISBN is another edition
	assert.deepEqual(json(Edition.parse(`asin: B1; isbn 978-0-00-000000-2, 0306406152; Dramatized adaptation\n\n${ISBN_B}; 2020; 45 min; narrator R. T. Hale\n`
		+ 'Audio CD; Goodreads x; second description\nDescription: First edition')), {
		editions: [{ asin: { 'audible.com': 'B1' }, isbn: ISBN_A, desc: 'Dramatized adaptation' }, { isbn: ISBN_BOX }, { isbn: ISBN_B, n: ['R. T. Hale'], d: '2020', len: 45 },
			{ desc: 'Audio CD' }, { desc: 'First edition' }],
		bad: ['Goodreads x', 'second description'], hcb: null,
	});
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
	assert.equal(E({ asin: { 'amazon.com': 'B2', 'audible.co.uk': 'B1' } }).format(), 'ASIN audible.co.uk B1, amazon.com B2');
	// an edition's ASIN from before sites ("id") is audible.com's
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: ['B'], e: [{ id: 'B1', gr: '7' }, { id: 'B2', asin: { 'amazon.com': 'B3' } }] }])[0].e,
		[{ asin: { 'audible.com': 'B1' }, gr: '7' }, { asin: { 'audible.com': 'B2', 'amazon.com': 'B3' } }]);
	// one that disagrees with the audible.com ASIN it has is left for validate() to report
	const [odd] = Book.fixBooks([{ t: 'A', a: ['B'], e: [{ id: 'B1', asin: { 'audible.com': 'B2' } }] }]);
	assert.ok(Validator.validate([odd], {}).errors.some(e => e.includes("unknown key 'id'")));
	assert.ok(Validator.validate([book('A', 'B', ed({ asin: { 'kobo.com': 'B1' } }))], {}).errors.some(e => e.includes("'kobo.com' is not an Amazon or Audible site")));
	assert.ok(Validator.validate([book('A', 'B', ed({ asin: {} }))], {}).errors.some(e => e.includes("'asin' must be the edition's ASINs by site")));
	assert.ok(Validator.validate([book('A', 'B', ed({ asin: 'B1' }))], {}).errors.some(e => e.includes("'asin' must be")));
});

test('ASINs by site: each site may have its own, so only another ASIN on the same site is another edition', () => {
	const us = { asin: { 'audible.com': 'B1' } };
	assert.ok(E(us).sameAs(E({ asin: { 'amazon.com': 'B1' } })), 'the same ASIN on another site');
	assert.ok(!E(us).sameAs(E({ asin: { 'audible.com': 'B2' } })), 'another ASIN on audible.com');
	assert.ok(E({ ...us, hc: '5' }).sameAs(E({ asin: { 'amazon.com': 'B9' }, hc: '5' })), 'another site\'s ASIN does not disagree');
	// a Hardcover import's amazon.com ASIN fills in the edition an Audible import added
	const books = [book('Tidewater', 'Ann Vale', { hcb: '77', ...ed({ asin: { 'audible.com': 'B0TIDEWAT1' }, len: 600 }) })];
	const report = merge(books, [book('Tidewater', 'Ann Vale', { hcb: '77', ...ed({ asin: { 'amazon.com': 'B0TIDEWAT9' }, hc: '501' }) })]);
	assert.deepEqual(books[0].e, [{ asin: { 'audible.com': 'B0TIDEWAT1', 'amazon.com': 'B0TIDEWAT9' }, hc: '501', len: 600 }]);
	assert.deepEqual(report.backfilled, books);
	// and is found again by it
	assert.equal(merge(books, [book('Tide Water', 'Someone', ed({ asin: { 'amazon.co.uk': 'B0TIDEWAT9' } }))]).matched, 1);
	// an Audible export from another site keeps that site's ASINs
	const csv = 'Title,Authors,Progress,ASIN\nTidewater,Ann Vale,Finished,B0TIDEWATU\n';
	assert.deepEqual(json(new AudibleImporter('audible.co.uk').read(csv).books[0].editions), [{ asin: { 'audible.co.uk': 'B0TIDEWATU' } }]);
	assert.deepEqual(json(new AudibleImporter().read(csv).books[0].editions), [{ asin: { 'audible.com': 'B0TIDEWATU' } }]);
	// an ASIN in a Goodreads-style CSV is amazon.com's
	assert.deepEqual(json(new GoodreadsImporter().read('Book Id,Title,Author,Binding,Exclusive Shelf,ASIN\n42,Tidewater,Ann Vale,Audible Audio,read,B0TIDEWATA\n').books[0].editions),
		[{ asin: { 'amazon.com': 'B0TIDEWATA' }, gr: '42' }]);
});

test('editions as fields: one field per part in the book form, each checked on its own', () => {
	const edition = { asin: { 'audible.com': 'B0X' }, gr: '4242', hc: '31337', isbn: ISBN_A, n: ['Ann Vale', 'Bo Reed'], p: 'Gull Audio', d: '2021-05', len: 642, desc: 'UK edition; abridged' };
	const fields = E(edition).fields();
	assert.deepEqual(fields, { desc: 'UK edition; abridged', n: 'Ann Vale, Bo Reed', gr: '4242', hc: '31337', isbn: ISBN_A, p: 'Gull Audio', d: '2021-05', len: '10h 42m', 'asin:audible.com': 'B0X' });
	assert.deepEqual(json(Edition.fromFields(fields)), { editions: [edition], bad: [], hcb: null });
	// a field per site; a page's address gives its site's ASIN; another ASIN for a site that has one can't be read
	assert.deepEqual(json(Edition.fromFields({ 'asin:audible.co.uk': 'b0uk', 'asin:amazon.com': 'https://www.amazon.com/dp/B0AMAZON01' }).editions),
		[{ asin: { 'audible.co.uk': 'B0UK', 'amazon.com': 'B0AMAZON01' } }]);
	assert.deepEqual(json(Edition.fromFields({ 'asin:audible.com': 'B1, B2', 'asin:amazon.com': '' }).bad), ['ASIN audible.com B1, B2']);
	assert.ok(Edition.ASIN_SITES.includes('amazon.se') && Edition.ASIN_SITES.includes('audible.co.uk'));
	// empty fields are no edition; a second ISBN is another edition; an edition's address gives its id, a book's the book
	assert.deepEqual(json(Edition.fromFields({ desc: '  ', p: '' })), { editions: [], bad: [], hcb: null });
	assert.deepEqual(json(Edition.fromFields({ isbn: '978-0-00-000000-2, 0306406152', hc: 'https://hardcover.app/books/the-salt-road/editions/501' })),
		{ editions: [{ hc: '501', isbn: ISBN_A }, { isbn: ISBN_BOX }], bad: [], hcb: null });
	assert.deepEqual(json(Edition.fromFields({ asin: 'B1', hc: 'https://hardcover.app/id/book/909' })), { editions: [{ asin: { 'audible.com': 'B1' } }], bad: [], hcb: '909' });
	// what can't be read is reported with the field's name, and left out
	assert.deepEqual(json(Edition.fromFields({ asin: 'B1', gr: 'x', d: '2021-13', len: 'long', isbn: '978' })),
		{ editions: [{ asin: { 'audible.com': 'B1' } }], bad: ['Goodreads id x', 'ISBN 978', 'Released 2021-13', 'Length long'], hcb: null });	// a book's page on Goodreads gives its id
	assert.deepEqual(json(Edition.fromFields({ gr: 'https://www.goodreads.com/book/show/4242-the-salt-road?ref=nav' }).editions), [{ gr: '4242' }]);
});

test('idFromAddress: the id a pasted address names, and the field it goes in', () => {
	assert.deepEqual(Edition.idFromAddress('https://www.audible.co.uk/pd/The-Salt-Road-Audiobook/b0saltroad?qid=1'), { field: 'asin:audible.co.uk', id: 'B0SALTROAD' });
	assert.deepEqual(Edition.idFromAddress('https://www.amazon.com/The-Salt-Road/dp/B0AMAZON01/ref=sr_1_1'), { field: 'asin:amazon.com', id: 'B0AMAZON01' });
	assert.deepEqual(Edition.idFromAddress('amazon.de/gp/product/B0AMAZON02'), { field: 'asin:amazon.de', id: 'B0AMAZON02' });
	assert.deepEqual(Edition.idFromAddress(' https://www.goodreads.com/book/show/4242.The_Salt_Road '), { field: 'gr', id: '4242' });
	assert.deepEqual(Edition.idFromAddress('goodreads.com/book/show/4242'), { field: 'gr', id: '4242' });
	assert.deepEqual(Edition.idFromAddress('https://hardcover.app/books/the-salt-road/editions/501'), { field: 'hc', id: '501' });
	// ids, a Hardcover book's address, a Goodreads work or another site's page name no edition
	for (const text of ['B0SALTROAD', '4242', '', 'https://hardcover.app/books/the-salt-road', 'https://www.goodreads.com/work/editions/99',
		'https://www.kobo.com/dp/B0SALTROAD']) assert.equal(Edition.idFromAddress(text), null, text);
});

test('saving a book keeps the copies of a shared edition in step', () => {
	const catalog = new Catalog({ books: Bs([
		book('Two', 'A', ed({ asin: { 'audible.com': 'BBOX' }, p: 'Gull Audio' }, { asin: { 'audible.com': 'B2' } })),
		book('Three', 'A', ed({ asin: { 'audible.com': 'BBOX' }, p: 'Gull Audio' })),
		book('Other', 'A', ed({ asin: { 'audible.com': 'B9' }, isbn: [ISBN_BOX] })),
	]) });
	const books = () => json(catalog.books);
	// editing the box set on one title edits it on the other; an edition sharing only an ISBN is left alone
	assert.equal(catalog.saveBook(0, B(book('Two', 'A', ed({ asin: { 'audible.com': 'BBOX' }, p: 'Kestrel Audio', isbn: [ISBN_BOX] }, { asin: { 'audible.com': 'B2' } })))), 1);
	assert.deepEqual(books().map(b => b.e[0]), [{ asin: { 'audible.com': 'BBOX' }, p: 'Kestrel Audio', isbn: [ISBN_BOX] }, { asin: { 'audible.com': 'BBOX' }, p: 'Kestrel Audio', isbn: [ISBN_BOX] }, { asin: { 'audible.com': 'B9' }, isbn: [ISBN_BOX] }]);
	// a new title typed with the box set's ASIN is linked to it and gets its details
	const four = book('Four', 'A', ed({ asin: { 'audible.com': 'BBOX' }, len: 900 }));
	assert.equal(catalog.saveBook(null, B(four)), 2);
	assert.deepEqual(books()[3].e, [{ asin: { 'audible.com': 'BBOX' }, isbn: [ISBN_BOX], p: 'Kestrel Audio', len: 900 }]);
	assert.deepEqual(books()[1].e, books()[3].e);
	// removing the edition from one title leaves the others
	assert.equal(catalog.saveBook(3, B(book('Four', 'A'))), 0);
	assert.equal(books()[1].e[0].asin['audible.com'], 'BBOX');
});

// ------------------------------------------------------------------ duplicates
test('findDuplicates pairs books an import would match, but not a box set\'s titles', () => {
	const books = [
		book('The Salt Road', 'Marisol Quenby', { s: 'Lantern Coast', sn: '1', ...ed({ asin: { 'audible.com': 'B1' } }) }),
		book('Beacons', 'Marisol Quenby', { s: 'Lantern Coast', sn: '2', ...ed({ asin: { 'audible.com': 'BBOX' } }) }),
		book('The Drowned Chart', 'Marisol Quenby', { s: 'Lantern Coast', sn: '3', ...ed({ asin: { 'audible.com': 'BBOX' } }) }),
		book('Salt Road', 'Marisol Quenby', { s: 'The Lantern Coast Series', sn: '1', ...ed({ gr: '4242' }) }),
		book('Lantern Coast 2: Beacons', 'Marisol Quenby, Tobias Frane'),
		book('Beacons', 'Someone Else'),
		book('Lantern Coast, Books 1-3', 'Marisol Quenby', { s: 'Lantern Coast', sn: '1-3' }),
	];
	// same series and number; Audible's long title for "Beacons"; different authors and the boxed set stay apart
	assert.deepEqual(findDuplicates(books), [[0, 3], [1, 4]]);
	// a pair marked as different books is not offered again, whichever way round
	const notSame = new Set([Duplicates.pairKey(B(books[4]), B(books[1]))]);
	assert.deepEqual(findDuplicates(books, notSame), [[0, 3]]);
	assert.deepEqual(findDuplicates([]), []);
});

test('mergeBooks keeps the picked fields and combines genres, dates read and editions', () => {
	const a = book('Salt Road', 'Marisol Quenby', { s: 'Lantern Coast', sn: '1', g: ['Fantasy'], r: ['2025-11-20'],
		...ed({ gr: '4242', p: 'Gullwing Audio' }, { isbn: ISBN_BOX }) });
	const b = book('The Salt Road', 'Marisol Quenby', { s: 'The Lantern Coast', sn: '1',
		g: ['Fantasy', 'Adventure'], r: ['2023-06-02', '2025-11-20'], hcb: '77', ...ed({ asin: { 'audible.com': 'B1' }, gr: '4242', n: ['Tobias Frane'], len: 642 }, { asin: { 'audible.com': 'B2' } }) });
	// by default the first entry that has a value wins; the narrator only b's edition has
	assert.deepEqual(json(Book.merge(Bs([a, b]))), {
		t: 'Salt Road', a: ['Marisol Quenby'], s: 'Lantern Coast', sn: '1', g: ['Fantasy', 'Adventure'],
		r: ['2023-06-02', '2025-11-20'], hcb: '77',
		e: [{ asin: { 'audible.com': 'B1' }, gr: '4242', n: ['Tobias Frane'], p: 'Gullwing Audio', len: 642 }, { isbn: ISBN_BOX }, { asin: { 'audible.com': 'B2' } }],
	});
	const picked = json(Book.merge(Bs([a, b]), { title: 1, series: 1 }));
	assert.equal(picked.t, 'The Salt Road');
	assert.equal(picked.s, 'The Lantern Coast');
	// the inputs are left alone
	assert.deepEqual(a.e, [{ gr: '4242', p: 'Gullwing Audio' }, { isbn: ISBN_BOX }]);
	assert.deepEqual(Validator.validate([picked], {}).errors, []);
});

test('editions that do not disagree on an ASIN, Goodreads id or ISBN can be joined, on merge or later', () => {
	const audible = book('Salt Road', 'Marisol Quenby', ed({ asin: { 'audible.com': 'B1' }, len: 642 }));
	const goodreads = book('Salt Road', 'Marisol Quenby', ed({ gr: '4242', isbn: ISBN_B, p: 'Gull Audio', len: 600 }));
	const joinable = editions => Edition.joinable(editions.map(E));
	assert.equal(joinable([{ asin: { 'audible.com': 'B1' } }, { gr: '4242' }]), true);
	assert.equal(joinable([{ asin: { 'audible.com': 'B1' } }, { asin: { 'audible.com': 'B2' } }]), false);
	assert.equal(joinable([{ asin: { 'audible.com': 'B1' }, isbn: ISBN_A }, { gr: '4242', isbn: ISBN_B }]), false, 'another ISBN is another edition');
	assert.equal(joinable([{ asin: { 'audible.com': 'B1' } }]), false);
	// the first edition's values win
	assert.deepEqual(json(Book.merge(Bs([audible, goodreads]), { joinEditions: true }).editions),
		[{ asin: { 'audible.com': 'B1' }, gr: '4242', isbn: ISBN_B, p: 'Gull Audio', len: 642 }]);
	assert.equal(Book.merge(Bs([audible, goodreads])).editions.length, 2);
	assert.equal(audible.e[0].gr, undefined);              // the inputs are left alone

	const books = Bs([
		book('Two Editions', 'A', ed({ asin: { 'audible.com': 'B1' } }, { gr: '7' })),
		book('Two Asins', 'A', ed({ asin: { 'audible.com': 'B2' } }, { asin: { 'audible.com': 'B3' } })),
		book('Box One', 'A', ed({ asin: { 'audible.com': 'BBOX' } }, { gr: '8' })),
		book('Box Two', 'A', ed({ asin: { 'audible.com': 'BBOX' } })),
		book('One', 'A', ed({ asin: { 'audible.com': 'B4' } })),
	]);
	assert.deepEqual(new Duplicates(books).splitEditions(), [0]);
	assert.deepEqual(new Duplicates(books, new Set([Duplicates.editionsKey(books[0])])).splitEditions(), []);
	assert.equal(Duplicates.editionsKey(B(book('x', 'y', ed({ gr: '7' }, { asin: { 'audible.com': 'B1' } })))), Duplicates.editionsKey(books[0]));
});

test('narrators: a narrator on the book moves onto its editions', () => {
	// a narrator on the book was one text, from before narrators were lists
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: 'B', n: 'Ann Vale', e: [{ asin: { 'audible.com': 'B1' } }, { asin: { 'audible.com': 'B2' }, n: 'R. T. Hale' }] }]),
		[{ t: 'A', a: ['B'], e: [{ asin: { 'audible.com': 'B1' }, n: ['Ann Vale'] }, { asin: { 'audible.com': 'B2' }, n: ['R. T. Hale'] }] }]);
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: 'B', n: 'Ann Vale' }]), [{ t: 'A', a: ['B'], e: [{ n: ['Ann Vale'] }] }]);
	assert.deepEqual(Book.fixEditions({ t: 'A', a: ['B'], n: ' ' }), { t: 'A', a: ['B'] });
	// from before editions: ids and narrator make one edition
	assert.deepEqual(Book.fixBooks([{ t: 'A', a: 'B', n: 'Ann Vale', id: 'B1' }])[0].e, [{ asin: { 'audible.com': 'B1' }, n: ['Ann Vale'] }]);
	assert.deepEqual(Validator.validate(Book.fixBooks([{ t: 'A', a: 'B', n: 'Ann Vale', id: 'B1' }]), {}), { errors: [], warnings: [] });
	assert.ok(Validator.validate([{ t: 'A', a: ['B'], n: ['Ann Vale'] }], {}).errors.some(e => e.includes("unknown key 'n'")));

	assert.deepEqual(B(book('A', 'B', ed({ n: ['Ann Vale'] }, { n: ['R. T. Hale'] }, { n: ['Ann Vale'] }, { asin: { 'audible.com': 'B3' } }))).narrators(), ['Ann Vale', 'R. T. Hale']);
	// an import's narrator never replaces the one you have
	const existing = [book('One', 'Author', ed({ asin: { 'audible.com': 'B1' }, n: ['Mine'] }))];
	merge(existing, [book('One', 'Author', ed({ gr: '7', n: ['A guess'] }))]);
	assert.deepEqual(existing[0].e, [{ asin: { 'audible.com': 'B1' }, gr: '7', n: ['Mine'] }]);
});

test('authors and narrators are lists; comma separated text from before is split on load', () => {
	assert.deepEqual(Text.splitNames('Ann Vale, R. T. Hale; Bo Reed & Cy Hale and Di Moss'), ['Ann Vale', 'R. T. Hale', 'Bo Reed', 'Cy Hale', 'Di Moss']);
	assert.deepEqual(Text.splitNames('Ann Vale, Jr., Bo Reed, III'), ['Ann Vale, Jr.', 'Bo Reed, III']);
	assert.deepEqual(Text.splitNames(' Ann  Vale ,, Ann  Vale '), ['Ann Vale']);
	assert.deepEqual(Text.splitNames(''), []);
	assert.equal(Text.namesText(['Ann Vale', 'Bo Reed']), 'Ann Vale, Bo Reed');

	const old = { t: 'Old', a: 'Ann Vale, Bo Reed', e: [{ asin: { 'audible.com': 'B1' }, n: 'Cy Hale & Di Moss' }, { asin: { 'audible.com': 'B2' }, n: ['Kept, As Is'] }] };
	assert.deepEqual(Book.fixBooks([old]), [{ t: 'Old', a: ['Ann Vale', 'Bo Reed'], e: [{ asin: { 'audible.com': 'B1' }, n: ['Cy Hale', 'Di Moss'] }, { asin: { 'audible.com': 'B2' }, n: ['Kept, As Is'] }] }]);
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
	assert.equal(E({ n: ['Cy Hale', 'Di Moss'], asin: { 'audible.com': 'B1' } }).format(), 'Narrated by Cy Hale, Di Moss; ASIN audible.com B1');
	assert.deepEqual(json(Edition.parse('Narrated by Cy Hale, Di Moss; ASIN B1').editions), [{ asin: { 'audible.com': 'B1' }, n: ['Cy Hale', 'Di Moss'] }]);
	assert.deepEqual(B(book('A', 'B', ed({ n: ['Cy Hale', 'Di Moss'] }, { n: ['Di Moss'] }))).narrators(), ['Cy Hale', 'Di Moss']);

	// imports give lists: Audible's and Goodreads' columns are split, and so are books from before, on load
	const [rec] = new AudibleImporter().rowToBook({ Title: 'T', Authors: 'Ann Vale, Bo Reed', Narrators: 'Cy Hale, Di Moss', Progress: 'Finished', ASIN: 'B0000000A1' });
	assert.deepEqual([rec.authors, rec.editions[0].narrators], [['Ann Vale', 'Bo Reed'], ['Cy Hale', 'Di Moss']]);
	const gr = new GoodreadsImporter().read(GR_HEADER + '4242,Kept,Ann Vale,"Cy Hale, Di Moss",Audible Audio,read,,\n').books[0];
	assert.deepEqual([gr.authors, gr.editions[0].narrators], [['Ann Vale'], ['Cy Hale', 'Di Moss']]);
	const existing = [];
	merge(existing, Book.fixBooks([{ t: 'Text', a: 'Ann Vale, Bo Reed', s: 'Saga', sn: '1-2', e: [{ asin: { 'audible.com': 'BBOX' }, n: 'Cy Hale' }] }]));
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
		book('Both Read', 'Ann Vale', { r: ['2024-01-02'], g: ['Mystery'], ...ed({ asin: { 'audible.com': 'B1' } }) }),
		book('Only Here', 'Ann Vale'),
		book('Removed There', 'Ann Vale', ed({ asin: { 'audible.com': 'BGONE' } })),
		book('Same Both', 'Ann Vale', ed({ n: ['Ivo Brandt'] })),
	];
	const before = JSON.stringify(mine);
	const backup = {
		books: [
			book('Both Read', 'Ann Vale', { r: ['2025-06-01'], g: ['Cozy'], ...ed({ asin: { 'audible.com': 'B1' }, n: ['Dana Whitlock'] }) }),
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
		{ t: 'Both Read', a: ['Ann Vale'], g: ['Mystery', 'Cozy'], r: ['2024-01-02', '2025-06-01'], e: [{ asin: { 'audible.com': 'B1' }, n: ['Dana Whitlock'] }] },
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
	const mine = [book('Lantern Road', 'Ann Vale', { s: 'Tide Saga', sn: '1', ...ed({ asin: { 'audible.com': 'B1' } }) })];
	const theirs = book('The Lantern Road', 'Ann Vale', { s: 'Tide Saga', sn: '1', ...ed({ asin: { 'audible.com': 'B1' } }) });
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
test('author info: validated against the books, links checked against their sites', () => {
	const books = [book('Lantern Road', 'Ann Vale')];
	assert.deepEqual(Validator.validateAuthors(books, {}), { errors: [], warnings: [] });
	assert.deepEqual(Validator.validateAuthors(books, undefined), { errors: [], warnings: [] });
	assert.deepEqual(Validator.validateAuthors(books, { 'Ann Vale': { bio: 'Hi.\n\nMore.', url: 'https://example.com/',
		audible: 'https://www.audible.co.uk/author/Ann-Vale/X1', goodreads: 'https://www.goodreads.com/author/show/1.Ann',
		hardcover: 'https://hardcover.app/authors/ann-vale' } }), { errors: [], warnings: [] });
	const { errors, warnings } = Validator.validateAuthors(books, {
		'Ann Vale': { bio: '', url: 'example.com', audible: 'https://hardcover.app/authors/ann-vale', note: 'x' },
		'Cy Hale': 'not an object',
	});
	assert.deepEqual(errors, [
		"authors['Ann Vale']: unknown keys ['note']",
		"authors['Ann Vale']: 'bio' must be a non-empty string when present",
		"authors['Ann Vale']: 'url' must be a web address starting with http:// or https://",
		"authors['Cy Hale']: not an object",
	]);
	assert.deepEqual(warnings, [
		"authors['Ann Vale']: 'audible' should be an address on Audible, not 'https://hardcover.app/authors/ann-vale'",
		"authors: 'Cy Hale' matches no author in books.json",
	]);
	assert.deepEqual(Validator.validateAuthors(books, []).errors, ['authors: must map author names to their info']);
});

test('author info is tidied: a bio keeps its paragraphs, empty fields are dropped', () => {
	assert.deepEqual(json(Author.tidy('Ann Vale', { bio: '  First  line.\r\nSecond\u00a0line.\n\n\n\nNew  paragraph. ', url: ' https://example.com/ ', goodreads: '  ' })),
		{ bio: 'First line.\nSecond line.\n\nNew paragraph.', url: 'https://example.com/' });
	assert.equal(Author.tidy('Ann Vale', { bio: ' ', url: '' }), null);
	assert.equal(Author.tidy('Ann Vale', 'nope'), null);
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
	assert.deepEqual(catalog.authorList(), [
		{ name: 'Ann Vale', books: 6, series: 2 }, { name: 'Bo Reed', books: 2, series: 1 },
	]);
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
	const box = { asin: { 'audible.com': 'BBOX' }, n: ['Dana Whitlock'] };
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
	assert.ok(E({ hc: '501' }).sameAs(E({ hc: '501', asin: { 'audible.com': 'B1' } })));
	assert.ok(!E({ hc: '501', asin: { 'audible.com': 'B1' } }).sameAs(E({ hc: '502', asin: { 'audible.com': 'B1' } })), 'different Hardcover editions conflict');
	// an incoming record finds the book by its Hardcover edition, or by the same Hardcover book
	const books = [book('Tidewater', 'Ann Vale', { hcb: '77', ...ed({ asin: { 'audible.com': 'B1' }, hc: '501' }) })];
	const report = merge(books, [book('Tidewater (Unabridged)', 'Ann Vale', { hcb: '77', ...ed({ hc: '502', n: ['Hollis Marr'] }) })]);
	assert.equal(report.matched, 1);
	assert.deepEqual(books[0], { t: 'Tidewater', a: ['Ann Vale'], hcb: '77', e: [{ asin: { 'audible.com': 'B1' }, hc: '501' }, { hc: '502', n: ['Hollis Marr'] }] });
	// a book found by an edition gains the Hardcover book id it lacked, before its editions
	const fen = [book('Fen', 'Ann Vale', { r: ['2024'], ...ed({ asin: { 'audible.com': 'B2' } }) })];
	assert.equal(merge(fen, [book('Fen', 'Ann Vale', { hcb: '78', ...ed({ asin: { 'audible.com': 'B2' }, hc: '601' }) })]).hardcoverFilled.length, 1);
	assert.deepEqual(Object.keys(fen[0]), ['t', 'a', 'r', 'hcb', 'e']);
	assert.deepEqual(fen[0].e, [{ asin: { 'audible.com': 'B2' }, hc: '601' }]);
	assert.deepEqual(findDuplicates([book('One', 'Ann Vale', { hcb: '77' }), book('Two', 'Ann Vale', { hcb: '77' })]), []);
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
		{ t: 'One', a: ['Ann Vale'], hcb: '71', e: [{ asin: { 'audible.com': 'BBOX' }, hc: '700' }, { asin: { 'audible.com': 'B1' }, hc: '711' }] },
		{ t: 'Two', a: ['Ann Vale'], hcb: '70', e: [{ asin: { 'audible.com': 'BBOX' }, hc: '700' }] },
		{ t: 'Three', a: ['Ann Vale'], hcb: '73', e: [{ asin: { 'audible.com': 'B3' } }] },
		{ t: 'Four', a: ['Ann Vale'], hcb: '74' },
	]);
	assert.deepEqual(Validator.validate(books, {}), { errors: [], warnings: [] });
	assert.match(Validator.validate([book('A', 'B', ed({ asin: { 'audible.com': 'B1' }, hcb: '7' }))], {}).errors.join('\n'), /unknown key 'hcb'/);
	assert.match(Validator.validate([book('A', 'B', { hcb: 'x7' })], {}).errors.join('\n'), /'hcb' must be a Hardcover book id/);
});

test('Hardcover ids round-trip through the edit form, are validated and exclude books', () => {
	const line = E({ asin: { 'audible.com': 'B0X' }, hc: '501' }).format();
	assert.equal(line, 'ASIN audible.com B0X; Hardcover 501');
	assert.deepEqual(json(Edition.parse(line + '\nhardcover id: 9').editions), [{ asin: { 'audible.com': 'B0X' }, hc: '501' }, { hc: '9' }]);
	// the Hardcover book, as editions used to show it, is the book's
	assert.deepEqual(json(Edition.parse(line + '; Hardcover book 77')), { editions: [{ asin: { 'audible.com': 'B0X' }, hc: '501' }], bad: [], hcb: '77' });
	assert.deepEqual(json(Edition.parse('Hardcover abc').bad), ['Hardcover abc']);
	const { errors } = Validator.validate([book('Tidewater', 'Ann Vale', ed({ hc: 'x1' }))], {});
	assert.match(errors.join('\n'), /'hc' must be a Hardcover id/);
	assert.match(Validator.validate([book('A', 'Ann Vale', ed({ hc: '5' })), book('A', 'Ann Vale', ed({ hc: '5' }))], {}).errors.join('\n'), /duplicate Hardcover id 5/);
	assert.deepEqual(B(book('Gone', 'Ann Vale', { hcb: '77', ...ed({ hc: '501' }) })).exclusionEntries(), ['Hardcover 501', 'Gone | Ann Vale']);
	const ex = Exclusions.parse('Hardcover 501\n');
	assert.deepEqual(ex.entries, ['Hardcover 501']);
	const report = merge([], [book('Gone Again', 'Ann Vale', ed({ hc: '501' }))], ex);
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
		{ t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', r: ['2022-01-09', '2024-03-15'], hcb: '77',
			e: [{ asin: { 'amazon.com': 'B0TIDEWAT1' }, hc: '501', isbn: '9780000000002', n: ['Hollis Marr', 'Cy Hale'], p: 'Gullwing Audio', d: '2021-05-04', len: 642 }] },
		{ t: 'The Paper Fen', a: ['R. T. Hale', 'Bo Reed'], hcb: '78', e: [{ hc: '601' }] },
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
		book('Tidewater', 'Ann Vale', ed({ asin: { 'audible.com': 'B0TIDEWAT1' } })),
		book('Box One', 'Ann Vale', ed({ asin: { 'audible.com': 'B0BOXSET01' } })), book('Box Two', 'Ann Vale', ed({ asin: { 'audible.com': 'B0BOXSET01' } })),
		book('Fen', 'Ann Vale', ed({ gr: '4242' })),
		book('Kept', 'Ann Vale', { hcb: '8', ...ed({ asin: { 'audible.com': 'B0KEPT0001' }, hc: '9' }) }),
		book('Own First', 'Ann Vale', ed({ asin: { 'audible.com': 'B0BOXSET01' } }, { asin: { 'audible.com': 'B0OWN00001' }, hc: '711' })),
		book('Nowhere', 'Ann Vale'),
	]);
	assert.deepEqual(HardcoverSync.lookups(books), { hc: [711], asin: ['B0TIDEWAT1', 'B0BOXSET01', 'B0OWN00001'], isbn: [], gr: ['4242'] });
	const found = { hc: new Map([['711', { hc: '711', hcb: '71' }]]), isbn: new Map(),
		asin: new Map([['B0TIDEWAT1', { hc: '501', hcb: '77' }], ['B0BOXSET01', { hc: '700', hcb: '70' }], ['B0KEPT0001', { hc: '1', hcb: '2' }]]),
		gr: new Map([['4242', { hc: null, hcb: '79' }]]) };
	const filled = HardcoverSync.addIds(books, found);
	assert.deepEqual(filled.map(b => b.title), ['Tidewater', 'Box One', 'Box Two', 'Fen', 'Own First']);
	assert.deepEqual(json(books).map(b => [b.hcb, b.e && b.e[0]]), [
		['77', { asin: { 'audible.com': 'B0TIDEWAT1' }, hc: '501' }], ['70', { asin: { 'audible.com': 'B0BOXSET01' }, hc: '700' }], ['70', { asin: { 'audible.com': 'B0BOXSET01' }, hc: '700' }],
		['79', { gr: '4242' }], ['8', { asin: { 'audible.com': 'B0KEPT0001' }, hc: '9' }],
		['71', { asin: { 'audible.com': 'B0BOXSET01' }, hc: '700' }],   // its own edition's Hardcover book, not the box set's
		[undefined, undefined],
	]);
	assert.deepEqual(Object.keys(json(books[0])), ['t', 'a', 'hcb', 'e']);
});

test('planHardcoverExport adds what is missing on Hardcover and leaves everything there alone', () => {
	const books = [
		book('Tidewater', 'Ann Vale', { r: ['2022-01-09', '2024-03-15', '2025'], hcb: '77', ...ed({ hc: '501' }) }),
		book('Fen', 'Ann Vale', { hcb: '78' }),
		book('Box One', 'Ann Vale', { r: ['2023-02-01'], hcb: '70', ...ed({ hc: '700' }) }),
		book('Box Two', 'Ann Vale', { r: ['2023-02-01'], hcb: '70', ...ed({ hc: '700' }) }),
		book('Single Two', 'Ann Vale', { hcb: '71', ...ed({ hc: '700' }, { hc: '711' }) }),
		book('Single Three', 'Ann Vale', { hcb: '72', ...ed({ hc: '700' }) }),
		book('Wanted', 'Ann Vale', { hcb: '79' }),
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
	assert.equal(HardcoverClient.url('edition', '501'), 'https://hardcover.app/id/edition/501');

	// told which Hardcover book each edition is of, only an edition of the book's own is sent
	const lone = [book('Lone', 'Ann Vale', { hcb: '72', ...ed({ hc: '700' }) }), book('Mixed', 'Ann Vale', { hcb: '73', ...ed({ hc: '700' }, { hc: '731' }) })];
	assert.deepEqual(HardcoverSync.exportEditions(Bs(lone)), [700, 731]);
	const editionBooks = new Map([['700', '70'], ['731', '73']]);
	assert.deepEqual(HardcoverSync.planExport(Bs(lone), [], editionBooks).add.map(a => [a.book, a.edition]), [[72, null], [73, 731]]);
	assert.deepEqual(HardcoverSync.planExport(Bs(lone.slice(0, 1)), []).add.map(a => [a.book, a.edition]), [[72, 700]], 'without it, a lone box set edition is taken as the book\'s');
});

test('merge: another Hardcover book found by a box set\'s edition is the box set, and its reads go to every title', () => {
	const box = () => ({ asin: { 'audible.com': 'BBOX' }, hc: '700' });
	const books = [book('One', 'Ann Vale', { hcb: '71', r: ['2024'], ...ed(box()) }), book('Two', 'Ann Vale', { hcb: '72', ...ed(box()) }),
		book('Three', 'Ann Vale', { hcb: '73', ...ed({ asin: { 'audible.com': 'B3' } }) })];
	const report = merge(books, [book('One and Two', 'Ann Vale', { hcb: '70', r: ['2025-02-02'], ...ed(box()) })], null, { allDates: true });
	assert.deepEqual(books.map(b => [b.hcb, b.r]), [['71', ['2024', '2025-02-02']], ['72', ['2025-02-02']], ['73', undefined]]);
	assert.equal(report.datesFilled.length, 2);
	// the title's own Hardcover book, found by the same edition, reads only that title
	merge(books, [book('One', 'Ann Vale', { hcb: '71', r: ['2026-01-01'], ...ed(box()) })], null, { allDates: true });
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
		{ editions: [{ asin: { 'audible.com': 'B0X' }, hc: '501' }, { hc: '9' }], bad: [], hcb: null });
	assert.deepEqual(json(Edition.parse('ASIN B0X; https://hardcover.app/id/book/77')), { editions: [{ asin: { 'audible.com': 'B0X' } }], bad: [], hcb: '77' });
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

test('formatNotes says what in books.json is from an older format', () => {
	assert.deepEqual(Book.formatNotes([{ t: 'Gull Isle', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B0SET00001' } }] }]), []);
	const notes = Book.formatNotes([{ t: 'Old Favorite', a: 'Ann Vale', e: [{ id: 'B0OLD00001' }] }]);
	assert.equal(notes.length, 2);
	assert.match(notes[0], /1 book\(s\) keep an edition's ASIN as "id"/);
	assert.match(notes[1], /1 book\(s\) keep their authors or narrators as one comma separated text/);
	assert.deepEqual(Book.formatNotes({}), []);
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
