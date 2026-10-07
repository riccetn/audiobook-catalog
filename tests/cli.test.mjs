// Tests for the command line (catalog.js), run against a copy of the demo data in a temp folder.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeHardcover, hardcoverState } from './fake-hardcover.mjs';
import { main, loadBooks, loadAuthors, createServer } from '../catalog.js';
import * as CatalogImport from '../importers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sandbox(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-cli-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'data', 'sample'), path.join(tmp, 'data', 'sample'), { recursive: true });
  const run = (...argv) => {
    const out = [], err = [];
    const code = main(['--root', tmp, ...argv], { out: s => out.push(s), err: s => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { tmp, run };
}

test('a fresh checkout validates the demo data', t => {
  const { run } = sandbox(t);
  const { code, out } = run('validate');
  assert.equal(code, 0);
  assert.match(out, /demo data/);
});

test('commands that write refuse to touch the demo data', t => {
  const { run } = sandbox(t);
  for (const argv of [['format'], ['import-audible', 'x.csv'], ['import-goodreads', 'x.csv'], ['sync-export', 'x.json'], ['merge-backup', 'x.json']]) {
    const { code, err } = run(...argv);
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, /init/);
  }
});

test('init creates an empty catalogue and never overwrites it', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json')), []);
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'excluded.txt')));
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'raw')));
  const again = run('init');
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists/);
  // once your own data exists it is used instead of the demo
  const { code, out } = run('validate');
  assert.equal(code, 0);
  assert.doesNotMatch(out, /demo data/);
});

test('init --sample copies the demo data', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init', '--sample').code, 0);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json')), loadBooks(path.join(tmp, 'data', 'sample', 'books.json')));
  assert.deepEqual(loadAuthors(path.join(tmp, 'data', 'authors.json')), loadAuthors(path.join(tmp, 'data', 'sample', 'authors.json')));
});

test('validate checks author info: bad entries are errors, a link to another site or an author without books a warning', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const dir = path.join(tmp, 'data');
  fs.writeFileSync(path.join(dir, 'books.json'), JSON.stringify([{ t: 'Here', a: ['Ann Vale'] }]));
  // a catalogue from before authors.json validates without one
  fs.unlinkSync(path.join(dir, 'authors.json'));
  assert.match(run('validate').out, /1 books, 0 series, 0 with release info, 0 authors with info; 0 error\(s\), 0 warning\(s\)/);

  fs.writeFileSync(path.join(dir, 'authors.json'), JSON.stringify({
    'Ann Vale': { bio: 'Writes.', url: 'https://example.com/', goodreads: 'https://www.audible.com/author/Ann-Vale/X' },
    'Bo Reed': { bio: 'Renamed since.' },
  }));
  const warned = run('validate');
  assert.equal(warned.code, 0);
  assert.match(warned.out, /warning: authors\['Ann Vale'\]: 'goodreads' should be an address on Goodreads/);
  assert.match(warned.out, /warning: authors: 'Bo Reed' matches no author in books.json/);
  assert.match(warned.out, /2 authors with info/);

  fs.writeFileSync(path.join(dir, 'authors.json'), JSON.stringify({ 'Ann Vale': { url: 'example.com', age: 40 } }));
  const bad = run('validate');
  assert.equal(bad.code, 1);
  assert.match(bad.out, /error: authors\['Ann Vale'\]: unknown keys \['age'\]/);
  assert.match(bad.out, /error: authors\['Ann Vale'\]: 'url' must be a web address/);
});

test('import-audible previews with --dry-run, then adds, fills in ids and honours excluded.txt', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const books = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(books, JSON.stringify([{ t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5' }]));
  fs.appendFileSync(path.join(tmp, 'data', 'excluded.txt'), 'BGONE\n');
  const csv = path.join(tmp, 'library.csv');
  fs.writeFileSync(csv, 'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\n'
    + 'x,A Crown of Embers 5: A Spark of Dawn,A Crown of Embers Series (book 5),Ilse Marlowe,,Finished,B5\n'
    + 'x,Ashfall,A Crown of Embers Series (book 6),Ilse Marlowe,A.B. Quill,Finished,B6\n'
    + 'x,Removed,,Ilse Marlowe,,Finished,BGONE\n'
    + 'x,Half Way,,Ilse Marlowe,,2h left,B7\n');

  const before = fs.readFileSync(books, 'utf8');
  const dry = run('import-audible', csv, '--dry-run');
  assert.equal(dry.code, 0);
  assert.match(dry.out, /already in the catalogue: 1/);
  assert.match(dry.out, /ASINs filled in on existing books: 1/);
  assert.match(dry.out, /skipped \(listed in data\/excluded.txt\): 1/);
  assert.match(dry.out, /\+ Ashfall - Ilse Marlowe {2}\[A Crown of Embers #6\]/);
  assert.match(dry.out, /dry run/);
  assert.equal(fs.readFileSync(books, 'utf8'), before);

  assert.equal(run('import-audible', csv).code, 0);
  assert.deepEqual(loadBooks(books), [
    { t: 'A Spark of Dawn', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '5', e: [{ asin: { 'audible.com': 'B5' } }] },
    { t: 'Ashfall', a: ['Ilse Marlowe'], s: 'A Crown of Embers', sn: '6', e: [{ asin: { 'audible.com': 'B6' }, n: ['A. B. Quill'] }] },
  ]);
  assert.match(run('import-audible', csv).out, /new: 0/);
});

test('import-goodreads adds read audiobooks', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const csv = path.join(tmp, 'goodreads.csv');
  fs.writeFileSync(csv, 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\n'
    + '"Kept (Series, #2)",Ann,Nate Narrator,Audible Audio,read,fantasy\n'
    + 'Paper,Bob,,Paperback,read,\n');
  const { code, out } = run('import-goodreads', csv);
  assert.equal(code, 0);
  assert.match(out, /Goodreads: 1 finished books read from goodreads.csv/);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json')),
    [{ t: 'Kept', a: ['Ann'], s: 'Series', sn: '2', g: ['fantasy'], e: [{ n: ['Nate Narrator'] }] }]);

  // a later export with a date read fills it in on the book already there
  fs.writeFileSync(csv, 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n'
    + '"Kept (Series, #2)",Ann,Nate Narrator,Audible Audio,read,fantasy,2024/03/15\n');
  assert.match(run('import-goodreads', csv).out, /dates read filled in on existing books: 1/);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json'))[0].r, ['2024-03-15']);

  // and a later one with Goodreads' Book Id column fills that in too
  fs.writeFileSync(csv, 'Book Id,Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\n'
    + '4242,"Kept (Series, #2)",Ann,Nate Narrator,Audible Audio,read,fantasy\n');
  assert.match(run('import-goodreads', csv).out, /Goodreads ids filled in on existing books: 1/);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json'))[0].e, [{ gr: '4242', n: ['Nate Narrator'] }]);
});

// The columns of a real Audible Library Extractor CSV export.
const ALE_COLUMNS = ['Added', 'Title', 'Title Short', 'Series', 'Book Numbers', 'Blurb', 'Authors', 'Narrators', 'Tags', 'Categories',
  'Parent Category', 'Child Category', 'Length', 'Progress', 'Release Date', 'Purchase Date', 'Publishers', 'My Rating', 'Rating',
  'Ratings', 'Favorite', 'Format', 'Language', 'Whispersync', 'From Plus Catalog', 'Unavailable', 'Archived', 'Downloaded',
  'Store Page Changed', 'Store Page Missing', 'ASIN', 'ISBN10', 'ISBN13', 'Summary', 'People Also Bought', 'Store Page Url',
  'Sample', 'Web Player', 'Cover', 'Search In Goodreads', 'Subtitle', 'Collection Ids'];
const row = values => ALE_COLUMNS.map(c => values[c] || '').join(',') + '\n';

test('imports store ISBNs, add another ISBN as another edition, and skip ISBNs in excluded.txt', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  fs.appendFileSync(path.join(tmp, 'data', 'excluded.txt'), 'ISBN 978-1-00-000000-9\n');
  const csv = path.join(tmp, 'library.csv');
  fs.writeFileSync(csv, ALE_COLUMNS.join(',') + '\n'
    + row({ Title: 'Kept', Authors: 'Ann', Progress: 'Finished', ASIN: 'B1', ISBN10: '0306406152', ISBN13: '9780306406157' })
    + row({ Title: 'Gone', Authors: 'Ann', Progress: 'Finished', ASIN: 'B2', ISBN13: '9781000000009' }));
  let { code, out } = run('import-audible', csv);
  assert.equal(code, 0);
  assert.match(out, /skipped \(listed in data\/excluded.txt\): 1/);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json')), [{ t: 'Kept', a: ['Ann'], e: [{ asin: { 'audible.com': 'B1' }, isbn: '9780306406157' }] }]);

  const gr = path.join(tmp, 'goodreads.csv');
  fs.writeFileSync(gr, 'Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf\n'
    + 'Kept,Ann,"=""""","=""9780000000002""",Audible Audio,read\n');
  ({ code, out } = run('import-goodreads', gr));
  assert.match(out, /other editions added to existing books: 1/);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json'))[0].e, [{ asin: { 'audible.com': 'B1' }, isbn: '9780306406157' }, { isbn: '9780000000002' }]);
});

test('imports keep editions: publisher, release date and length, and another ASIN as another edition', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const csv = path.join(tmp, 'library.csv');
  fs.writeFileSync(csv, ALE_COLUMNS.join(',') + '\n'
    + row({ Title: 'Kept', Authors: 'Ann', Progress: 'Finished', ASIN: 'B1', Publishers: 'Gull Audio', 'Release Date': '2021-05-04', Length: '10 hrs and 42 mins' }));
  assert.equal(run('import-audible', csv).code, 0);
  fs.writeFileSync(csv, ALE_COLUMNS.join(',') + '\n' + row({ Title: 'Kept', Authors: 'Ann', Progress: 'Finished', ASIN: 'B1UK' }));
  assert.match(run('import-audible', csv).out, /other editions added to existing books: 1/);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json')),
    [{ t: 'Kept', a: ['Ann'], e: [{ asin: { 'audible.com': 'B1' }, p: 'Gull Audio', d: '2021-05-04', len: 642 }, { asin: { 'audible.com': 'B1UK' } }] }]);
});

test('import-audible keeps a box set as its own book and splits it into its titles, each with the set\'s edition', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const csv = path.join(tmp, 'library.csv');
  fs.writeFileSync(csv, ALE_COLUMNS.join(',') + '\n'
    + row({ Title: 'Spark', Authors: 'Ann', Series: 'Ember (book 1)', Progress: 'Finished', ASIN: 'B1' })
    + row({ Title: 'Ember: Books 1-2', Authors: 'Ann', Series: 'Ember (books 1-2)', Progress: 'Finished', ASIN: 'BBOX' }));
  const { code, out } = run('import-audible', csv);
  assert.equal(code, 0);
  assert.match(out, /box sets kept as their own book and as their titles: 1\n    Ember: Books 1-2 - Ann: 1 already here, 1 added/);
  const set = { asin: { 'audible.com': 'BBOX' }, desc: 'Ember: Books 1-2' };
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json')), [
    { t: 'Spark', a: ['Ann'], s: 'Ember', sn: '1', e: [{ asin: { 'audible.com': 'B1' } }, set] },
    { t: 'Ember, Book 2', a: ['Ann'], s: 'Ember', sn: '2', e: [set] },
    { t: 'Ember: Books 1-2', a: ['Ann'], s: 'Ember', sn: '1-2', e: [set] },
  ]);
  assert.doesNotMatch(run('import-audible', csv).out, /box sets/, 'nothing new the second time');
});

test('box-sets keeps each box set in the catalogue as its own book and as its titles', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const booksPath = path.join(tmp, 'data', 'books.json');
  const box = { asin: { 'audible.com': 'BBOX' }, desc: 'Ember: Books 1-2' };
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'Spark', a: ['Ann'], s: 'Ember', sn: '1', e: [box] }, { t: 'Flame', a: ['Ann'], s: 'Ember', sn: '2', e: [box] }]));
  const before = fs.readFileSync(booksPath, 'utf8');
  let { code, out } = run('box-sets', '--dry-run');
  assert.equal(code, 0);
  assert.match(out, /box sets: 1\n    Ember: Books 1-2 - Ann: 2 title\(s\) already here\n  new: 1\n    \+ Ember: Books 1-2 - Ann  \[Ember #1-2\]\n\(dry run/);
  assert.equal(fs.readFileSync(booksPath, 'utf8'), before);
  ({ code, out } = run('box-sets'));
  assert.equal(code, 0);
  assert.deepEqual(loadBooks(booksPath)[2], { t: 'Ember: Books 1-2', a: ['Ann'], s: 'Ember', sn: '1-2', e: [box] });
  assert.match(run('box-sets').out, /box sets: 0\n  new: 0$/);
});

test('export-goodreads writes a CSV Goodreads imports, and --dry-run writes nothing', t => {
  const { tmp, run } = sandbox(t);
  const file = path.join(tmp, 'goodreads.csv');
  let { code, out } = run('export-goodreads', file, '--dry-run');
  assert.equal(code, 0);
  assert.match(out, /dry run/);
  assert.ok(!fs.existsSync(file));
  ({ code, out } = run('export-goodreads', file));
  assert.equal(code, 0);
  const books = loadBooks(path.join(root, 'data', 'sample', 'books.json'));
  assert.match(out, new RegExp(`${books.length} books for Goodreads`));
  const rows = CatalogImport.parseCsv(fs.readFileSync(file, 'utf8'));
  assert.equal(rows.length, books.length);
  assert.ok(rows.every(r => r['Exclusive Shelf'] === 'read'));
});

test('books from before editions validate, and format rewrites them with editions', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const booksPath = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'Old', a: ['Ann'], id: 'B1', gr: '7', isbn: ['9780306406157', '9780000000002'] },
    { t: 'Newer', a: ['Ann'], e: [{ id: 'B2', hcb: '9', isbn: ['9781000000009'] }] }]));
  const { code, out } = run('validate');
  assert.equal(code, 0);
  assert.match(out, /from before editions/);
  assert.match(out, /1 book\(s\) keep a Hardcover book id on an edition or several ISBNs on one edition/);
  assert.match(out, /1 book\(s\) keep an edition's ASIN as "id".*read as the audible.com ASIN/);
  assert.equal(run('format').code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(booksPath, 'utf8')), [{ t: 'Old', a: ['Ann'], e: [{ asin: { 'audible.com': 'B1' }, gr: '7', isbn: '9780306406157' }, { isbn: '9780000000002' }] },
    { t: 'Newer', a: ['Ann'], hcb: '9', e: [{ asin: { 'audible.com': 'B2' }, isbn: '9781000000009' }] }]);
  assert.doesNotMatch(run('validate').out, /from before editions|several ISBNs|ASIN as "id"/);
});

test('authors and narrators written as text validate, and format writes them as lists', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const booksPath = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'Old', a: 'Ann Vale, Bo Reed', e: [{ asin: { 'audible.com': 'B1' }, n: 'Cy Hale, Di Moss' }] }, { t: 'New', a: ['Ann Vale'] }]));
  const { code, out } = run('validate');
  assert.equal(code, 0);
  assert.match(out, /1 book\(s\) keep their authors or narrators as one comma separated text/);
  assert.equal(run('format').code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(booksPath, 'utf8')),
    [{ t: 'Old', a: ['Ann Vale', 'Bo Reed'], e: [{ asin: { 'audible.com': 'B1' }, n: ['Cy Hale', 'Di Moss'] }] }, { t: 'New', a: ['Ann Vale'] }]);
  assert.doesNotMatch(run('validate').out, /comma separated/);
});

test('titles holding their series validate, and format splits them', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const booksPath = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'The First Adventure: Fantasy Adventures, Book 1', a: ['Ann'] }]));
  assert.match(run('validate').out, /1 title\(s\) still hold their series/);
  assert.equal(run('format').code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(booksPath, 'utf8')), [{ t: 'The First Adventure', a: ['Ann'], s: 'Fantasy Adventures', sn: '1' }]);
  assert.doesNotMatch(run('validate').out, /still hold their series/);
});

test('an import that would leave invalid data writes nothing', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const books = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(books, JSON.stringify([{ t: 'Broken', a: ['X'], sn: '1' }]));
  const csv = path.join(tmp, 'library.csv');
  fs.writeFileSync(csv, 'Title Short,Authors,Progress,ASIN\nNew,Y,Finished,B1\n');
  const { code, err } = run('import-audible', csv);
  assert.equal(code, 1);
  assert.match(err, /Validation failed, nothing written/);
  assert.deepEqual(loadBooks(books), [{ t: 'Broken', a: ['X'], sn: '1' }]);
});

test('sync-export tidies names and spacing', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init', '--sample').code, 0);
  const exported = path.join(tmp, 'export.json');
  fs.writeFileSync(exported, JSON.stringify([
    { t: 'New  Book', a: ['A.B. Quill'], n: ['R.T.   Hale'] },
    { t: 'Fine Book', a: ['Ann Vale'] },
  ]));
  const { code, out } = run('sync-export', exported);
  assert.equal(code, 0);
  assert.match(out, /tidied stray spacing \/ run-together initials on 1 book/);
  const saved = loadBooks(path.join(tmp, 'data', 'books.json'));
  // a narrator on the book, from before narrators moved to editions, is saved on an edition
  assert.deepEqual(saved, [{ t: 'New Book', a: ['A. B. Quill'], e: [{ n: ['R. T. Hale'] }] }, { t: 'Fine Book', a: ['Ann Vale'] }]);
});

test('a date read written as a plain string is accepted and saved as a list', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const booksPath = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'Hand Edited', a: ['Ann Vale'], r: '2024-03-15' }]));
  assert.equal(run('validate').code, 0);

  const exported = path.join(tmp, 'export.json');
  fs.writeFileSync(exported, JSON.stringify({ books: [
    { t: 'Hand Edited', a: ['Ann Vale'], r: '2024-03-15' },
    { t: 'Two Reads', a: ['Ann Vale'], r: '2025-01-02, 2021' },
  ], seriesInfo: {} }));
  const { code, err } = run('sync-export', exported);
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(fs.readFileSync(booksPath, 'utf8')).map(b => b.r), [['2024-03-15'], ['2021', '2025-01-02']]);

  fs.writeFileSync(exported, JSON.stringify([{ t: 'Bad', a: ['Ann Vale'], r: 'last summer' }]));
  assert.match(run('sync-export', exported).err, /'r' must be a non-empty list/);
});

test('sync-export refuses files that are not catalogue exports', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init', '--sample').code, 0);
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify([{ title: 'x' }]));
  assert.equal(run('sync-export', bad).code, 1);
  fs.writeFileSync(bad, '{not json');
  assert.match(run('sync-export', bad).err, /cannot read/);
});

test('sync-export restores series info from the backup', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init', '--sample').code, 0);
  const infoPath = path.join(tmp, 'data', 'series-info.json');
  const books = loadBooks(path.join(tmp, 'data', 'books.json'));
  const [series] = books.filter(b => b.s).map(b => b.s);
  const seriesInfo = { [series]: { total: 9, status: 'ongoing', note: 'Researched in the app.' } };
  const exported = path.join(tmp, 'export.json');
  fs.writeFileSync(exported, JSON.stringify({ books, seriesInfo }));

  const dry = run('sync-export', exported, '--dry-run');
  assert.equal(dry.code, 0);
  assert.match(dry.out, /series info: \d+ added, \d+ changed, \d+ removed/);
  assert.notEqual(fs.readFileSync(infoPath, 'utf8'), JSON.stringify(seriesInfo));

  const { code, out } = run('sync-export', exported);
  assert.equal(code, 0);
  assert.match(out, /wrote data[\/\\]series-info\.json/);
  assert.equal(fs.readFileSync(infoPath, 'utf8'), JSON.stringify(seriesInfo));

  // a malformed entry in the backup blocks the whole sync
  fs.writeFileSync(exported, JSON.stringify({ books, seriesInfo: { [series]: { total: 0, status: 'maybe' } } }));
  assert.equal(run('sync-export', exported).code, 1);
  assert.equal(fs.readFileSync(infoPath, 'utf8'), JSON.stringify(seriesInfo));
});

test('sync-export restores author info from the backup, tidied, and leaves it alone for an older backup', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init', '--sample').code, 0);
  const authorsPath = path.join(tmp, 'data', 'authors.json');
  const books = loadBooks(path.join(tmp, 'data', 'books.json'));
  const exported = path.join(tmp, 'export.json');
  fs.writeFileSync(exported, JSON.stringify({ books, seriesInfo: {}, authors: { 'Wendell Ashcombe': { bio: '  Builds   clocks.  ', hardcover: ' https://hardcover.app/authors/wa ' } } }));
  const { code, out } = run('sync-export', exported);
  assert.equal(code, 0);
  assert.match(out, /author info: 1 added, 0 changed, 2 removed/);
  assert.match(out, /wrote data[\/\\]authors\.json/);
  assert.equal(fs.readFileSync(authorsPath, 'utf8'), JSON.stringify({ 'Wendell Ashcombe': { bio: 'Builds clocks.', hardcover: 'https://hardcover.app/authors/wa' } }));

  // a malformed entry blocks the whole sync
  fs.writeFileSync(exported, JSON.stringify({ books, seriesInfo: {}, authors: { 'Wendell Ashcombe': { url: 'nowhere' } } }));
  assert.equal(run('sync-export', exported).code, 1);
  // a backup from before author info leaves authors.json as it is
  fs.writeFileSync(exported, JSON.stringify({ books, seriesInfo: {} }));
  assert.match(run('sync-export', exported).out, /author info: not in this backup/);
  assert.match(fs.readFileSync(authorsPath, 'utf8'), /Builds clocks/);
});

test('sync-export adds the backup\'s excluded books to excluded.txt', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const excludedPath = path.join(tmp, 'data', 'excluded.txt');
  fs.appendFileSync(excludedPath, 'BOLD');                       // no newline at the end
  const before = fs.readFileSync(excludedPath, 'utf8');
  const exported = path.join(tmp, 'export.json');
  fs.writeFileSync(exported, JSON.stringify({ books: [], seriesInfo: {}, excluded: ['BOLD', 'BNEW', 'Gone | Ann Vale'] }));

  const dry = run('sync-export', exported, '--dry-run');
  assert.match(dry.out, /excluded from imports: 2 new/);
  assert.match(dry.out, /x Gone \| Ann Vale/);
  assert.equal(fs.readFileSync(excludedPath, 'utf8'), before);

  assert.equal(run('sync-export', exported).code, 0);
  assert.equal(fs.readFileSync(excludedPath, 'utf8'), before + '\nBNEW\nGone | Ann Vale\n');
  assert.match(run('sync-export', exported).out, /excluded from imports: 0 new/);

  // and imports skip them from then on
  const csv = path.join(tmp, 'library.csv');
  fs.writeFileSync(csv, 'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\nx,Gone,,Ann Vale,,Finished,B1\n');
  assert.match(run('import-audible', csv).out, /skipped \(listed in data\/excluded.txt\): 1/);
});

test('sync-export adds the backup\'s "Not duplicates" marks to not-duplicates.txt', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const notDupPath = path.join(tmp, 'data', 'not-duplicates.txt');
  const exported = path.join(tmp, 'export.json');
  const marks = ['["a","b","",""] ["c","b","",""]', '["editions","gr 7","id B1"]'];
  fs.writeFileSync(exported, JSON.stringify({ books: [], seriesInfo: {}, notDuplicates: marks }));

  const dry = run('sync-export', exported, '--dry-run');
  assert.match(dry.out, /marked not duplicates: 2 new/);
  assert.ok(!fs.existsSync(notDupPath));
  assert.equal(run('sync-export', exported).code, 0);
  assert.deepEqual(CatalogImport.parseNotDuplicates(fs.readFileSync(notDupPath, 'utf8')), marks);
  assert.match(run('sync-export', exported).out, /marked not duplicates: 0 new/);
  // a backup from before the marks were exported leaves the file alone
  fs.writeFileSync(exported, JSON.stringify({ books: [], seriesInfo: {} }));
  assert.doesNotMatch(run('sync-export', exported).out, /not duplicates/);
});

test('sync-export of an older backup (a plain list of books) leaves series info alone', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init', '--sample').code, 0);
  const infoPath = path.join(tmp, 'data', 'series-info.json');
  const before = fs.readFileSync(infoPath, 'utf8');
  const exported = path.join(tmp, 'export.json');
  fs.writeFileSync(exported, fs.readFileSync(path.join(tmp, 'data', 'books.json')));
  const { code, out } = run('sync-export', exported);
  assert.equal(code, 0);
  assert.match(out, /series info: not in this backup/);
  assert.equal(fs.readFileSync(infoPath, 'utf8'), before);
});

test('series fills in series, numbers and released totals from Audible, and --dry-run writes nothing', async t => {
  const { tmp } = sandbox(t);
  const dataDir = path.join(tmp, 'data');
  fs.writeFileSync(path.join(dataDir, 'books.json'), JSON.stringify([
    { t: 'Loose', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B1' } }] },
    { t: 'Gull 2', a: ['Ann Vale'], s: 'Gull Isle', sn: '2', e: [{ asin: { 'audible.com': 'B2' } }] },
    { t: 'Unknown', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B9' } }] },
  ]));
  fs.writeFileSync(path.join(dataDir, 'series-info.json'), '{}');
  const answers = {
    B1: { product: { series: [{ title: 'The Gull Isle Series', sequence: '1', asin: 'SG' }] } },
    B2: { product: { series: [{ title: 'Gull Isle', sequence: '2', asin: 'SG' }] } },
    SG: { product: { relationships: ['1', '2', '3'].map(sequence => ({ relationship_to_product: 'child', sequence })) } },
  };
  const asked = [];
  const fetch = async url => {
    asked.push(url);
    const asin = /products\/([^?]+)/.exec(url)[1];
    const body = answers[asin];
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  const run = async (...argv) => {
    const out = [], err = [];
    const code = await main(['--root', tmp, ...argv], { out: s => out.push(s), err: s => err.push(s), fetch, pause: async () => {} });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  const before = fs.readFileSync(path.join(dataDir, 'books.json'), 'utf8');
  const dry = await run('series', '--store', 'uk', '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /series or number filled in: 1/);
  assert.match(dry.out, /\+ Loose - Ann Vale {2}\[Gull Isle #1\]/);
  assert.match(dry.out, /\+ Gull Isle: 3/);
  assert.match(dry.out, /not found on audible.co.uk: 1/);
  assert.ok(asked.every(u => u.startsWith('https://api.audible.co.uk/')));
  assert.equal(fs.readFileSync(path.join(dataDir, 'books.json'), 'utf8'), before);

  assert.equal((await run('series')).code, 0);
  assert.deepEqual(loadBooks(path.join(dataDir, 'books.json')).map(b => [b.t, b.s, b.sn]),
    [['Loose', 'Gull Isle', '1'], ['Gull 2', 'Gull Isle', '2'], ['Unknown', undefined, undefined]]);
  const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'series-info.json'), 'utf8'));
  assert.equal(info['Gull Isle'].total, 3);
  assert.equal(info['Gull Isle'].status, 'ongoing');
});

test('import-audible --series names a box set\'s new titles after Audible\'s series listing', async t => {
  const { tmp } = sandbox(t);
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const booksPath = path.join(dataDir, 'books.json');
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'Spark', a: ['Ann Vale'], s: 'Ember', sn: '1', e: [{ asin: { 'audible.com': 'B0SPARK001' } }] }]));
  fs.writeFileSync(path.join(dataDir, 'series-info.json'), JSON.stringify({ Ember: { total: 3, status: 'complete' } }));
  const csv = path.join(tmp, 'library.csv');
  fs.writeFileSync(csv, 'Title,Title Short,Series,Authors,Progress,ASIN\n'
    + '"Ember: Books 1-3","Ember: Books 1-3","Ember (books 1-3)",Ann Vale,Finished,B0EMBERBOX\n');
  const child = (sequence, title) => ({ relationship_to_product: 'child', sequence, title });
  const fetch = async url => {
    const asin = /products\/([^?]+)/.exec(url)[1];
    const body = {
      B0EMBERBOX: { product: { series: [{ title: 'Ember', sequence: '1-3', asin: 'B0EMBERSER' }] } },
      B0EMBERSER: { product: { relationships: [child('1', 'Spark'), child('1-3', 'Ember: Books 1-3'), child('2', 'Flame'), child('3', 'Ember Falls')] } },
    }[asin];
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  const out = [], err = [];
  const code = await main(['--root', tmp, 'import-audible', csv, '--series'], { out: s => out.push(s), err: s => err.push(s), fetch, pause: async () => {} });
  assert.equal(code, 0, err.join('\n'));
  assert.match(out.join('\n'), /box sets' titles named: 2\n    Ember, Book 2 -> Flame\n    Ember, Book 3 -> Ember Falls/);
  const set = { asin: { 'audible.com': 'B0EMBERBOX' }, desc: 'Ember: Books 1-3' };
  assert.deepEqual(loadBooks(booksPath).map(b => [b.t, b.sn, b.e]), [
    ['Spark', '1', [{ asin: { 'audible.com': 'B0SPARK001' } }, set]], ['Flame', '2', [set]], ['Ember Falls', '3', [set]],
    ['Ember: Books 1-3', '1-3', [set]],
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'series-info.json'), 'utf8')), { Ember: { total: 3, status: 'complete' } });
});

test('import-audible --series looks up the series of the new books only', async t => {
  const { tmp } = sandbox(t);
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'books.json'), JSON.stringify([{ t: 'Old Standalone', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B0OLD00001' } }] }]));
  fs.writeFileSync(path.join(dataDir, 'series-info.json'), '{}');
  const csv = path.join(tmp, 'library.csv');
  fs.writeFileSync(csv, 'Title,Title Short,Series,Authors,Narrators,Progress,ASIN\n'
    + 'x,Tidewater,,Ann Vale,,Finished,B0NEW00001\n');
  const asked = [];
  const fetch = async url => {
    const asin = /products\/([^?]+)/.exec(url)[1];
    asked.push(asin);
    const body = {
      B0NEW00001: { product: { series: [{ title: 'Gull Isle', sequence: '1', asin: 'B0GULLISLE' }] } },
      B0GULLISLE: { product: { relationships: ['1', '2'].map(sequence => ({ relationship_to_product: 'child', sequence })) } },
    }[asin];
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  const run = async (...argv) => {
    const out = [], err = [];
    const code = await main(['--root', tmp, ...argv], { out: s => out.push(s), err: s => err.push(s), fetch, pause: async () => {} });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const booksPath = path.join(dataDir, 'books.json');
  const before = fs.readFileSync(booksPath, 'utf8');

  const dry = await run('import-audible', csv, '--series', '--store', 'uk', '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /new: 1[\s\S]*series of the new books:[\s\S]*\+ Tidewater - Ann Vale {2}\[Gull Isle #1\][\s\S]*\+ Gull Isle: 2[\s\S]*dry run/);
  assert.deepEqual(asked, ['B0NEW00001', 'B0GULLISLE']);       // the old standalone book is not asked about again
  assert.equal(fs.readFileSync(booksPath, 'utf8'), before);

  assert.equal((await run('import-audible', csv, '--series')).code, 0);
  assert.deepEqual(loadBooks(booksPath).map(b => [b.t, b.s, b.sn]), [['Old Standalone', undefined, undefined], ['Tidewater', 'Gull Isle', '1']]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'series-info.json'), 'utf8'))['Gull Isle'].total, 2);

  // nothing new: nothing to look up
  asked.length = 0;
  assert.equal((await run('import-audible', csv, '--series')).code, 0);
  assert.deepEqual(asked, []);
  // the export's ASINs are audible.com's, or those of the store named; the same ASIN on audible.co.uk is the same edition
  assert.deepEqual(loadBooks(booksPath)[1].e[0].asin, { 'audible.com': 'B0NEW00001' });
  assert.match((await run('import-audible', csv, '--store', 'uk')).out, /ASINs filled in on existing books: 1/);
  assert.deepEqual(loadBooks(booksPath)[1].e[0].asin, { 'audible.co.uk': 'B0NEW00001', 'audible.com': 'B0NEW00001' });
});

test('series writes nothing when Audible cannot be reached, and refuses the demo data', async t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('series').code, 2);
  assert.match(run('series', '--store', 'xx').err, /--store must be one of/);
  assert.match(run('validate', '--store', 'uk').err, /--store only goes with series/);
  assert.match(run('import-goodreads', 'x.csv', '--series').err, /--series only goes with import-audible/);
  assert.doesNotMatch(run('import-audible', 'x.csv', '--store', 'uk').err, /--store only goes/);
  assert.equal(run('init', '--sample').code, 0);
  const books = path.join(tmp, 'data', 'books.json');
  const before = fs.readFileSync(books, 'utf8');
  const err = [];
  const code = await main(['--root', tmp, 'series'], { out: () => {}, err: s => err.push(s),
    fetch: async () => { throw new Error('offline'); }, pause: async () => {} });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /could not reach audible.com \(offline\); no series filled in/);
  assert.equal(fs.readFileSync(books, 'utf8'), before);
});

test('--data-dir points anywhere', t => {
  const { tmp, run } = sandbox(t);
  const elsewhere = path.join(tmp, 'elsewhere');
  assert.equal(run('--data-dir', elsewhere, 'init').code, 0);
  assert.deepEqual(loadBooks(path.join(elsewhere, 'books.json')), []);
  const { code, out } = run('--data-dir', elsewhere, 'validate');
  assert.equal(code, 0);
  assert.doesNotMatch(out, /demo data/);
});

test('a missing explicit data dir is an error, not a silent fallback', t => {
  const { tmp, run } = sandbox(t);
  const { code, err } = run('--data-dir', path.join(tmp, 'nope'), 'validate');
  assert.equal(code, 1);
  assert.match(err, /error/);
});

test('bad command lines print the usage', t => {
  const { run } = sandbox(t);
  for (const argv of [[], ['nope'], ['import-audible'], ['validate', '--dry-run'], ['validate', '--bogus']]) {
    const { code, err } = run(...argv);
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, /usage: node catalog.js/);
  }
  assert.match(run('--help').out, /import-goodreads/);
});

test('serve looks books up on Audible for the page, and only for the page', async t => {
  const { tmp } = sandbox(t);
  const asked = [];
  const fetchAudible = async u => {
    asked.push(u);
    const asin = /products\/([^?]+)/.exec(u)[1];
    if (asin === 'B0DOWN0000') return { ok: false, status: 503 };
    const body = {
      B0SERIES01: { product: { series: [{ title: 'Gull Isle', sequence: '2', asin: 'B0GULLISLE' }] } },
      B0GULLISLE: { product: { relationships: [{ relationship_to_product: 'child', sequence: '3' }] } },
    }[asin];
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  const server = createServer(tmp, () => server.address().port, { fetch: fetchAudible, pause: async () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const ask = (body, headers = {}) => fetch(`http://localhost:${port}/api/audible`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  const res = await ask({ store: 'de', groups: 'series', asins: ['B0SERIES01', 'B0UNKNOWN0'] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { results: { B0SERIES01: [{ name: 'Gull Isle', number: '2', asin: 'B0GULLISLE' }], B0UNKNOWN0: null } });
  assert.ok(asked.every(u => u.startsWith('https://api.audible.de/')));
  assert.deepEqual(await (await ask({ store: 'us', groups: 'relationships', asins: ['B0GULLISLE'] })).json(), { results: { B0GULLISLE: { total: 3, titles: {} } } });

  const down = await ask({ store: 'us', groups: 'series', asins: ['B0DOWN0000'] });
  assert.equal(down.status, 502);
  assert.match((await down.json()).error, /could not reach audible.com/);
  for (const bad of [{ store: 'xx', groups: 'series', asins: [] }, { store: 'us', groups: 'all', asins: [] },
    { store: 'us', groups: 'series', asins: ['../../etc'] }, { store: 'us', groups: 'series', asins: Array(26).fill('B0SERIES01') }]) {
    assert.equal((await ask(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const before = asked.length;
  assert.equal((await ask({ store: 'us', groups: 'series', asins: ['B0SERIES01'] }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await fetch(`http://localhost:${port}/api/audible`)).status, 405);
  assert.equal(asked.length, before);
});

test('serve logs API calls, requests to Audible and Hardcover, and long tasks, never the token', async t => {
  const { tmp } = sandbox(t);
  const dataDir = path.join(tmp, 'data');
  fs.writeFileSync(path.join(dataDir, 'books.json'), JSON.stringify([{ t: 'Lantern Hours', a: ['R. T. Hale'], e: [{ asin: { 'audible.com': 'B0LANTERN1' } }] }]));
  fs.writeFileSync(path.join(dataDir, 'series-info.json'), '{}');
  const fetchAudible = async u => u.includes('B0DOWN0000') ? { ok: false, status: 503 }
    : { ok: true, status: 200, json: async () => ({ product: { series: [{ title: 'Gull Isle', sequence: '2', asin: 'B0GULLISLE' }] } }) };
  const hc = fakeHardcover(hardcoverState());
  const lines = [];
  const server = createServer(tmp, () => server.address().port, { fetch: fetchAudible, pause: async () => {} },
    { fetch: hc.fetch, pause: async () => {}, env: {} }, line => lines.push(line));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const send = (url, method, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const until = async test => { while (!lines.some(test)) await new Promise(done => setTimeout(done, 5)); };

  await send('/api/audible', 'POST', { store: 'us', groups: 'series', asins: ['B0SERIES01'] });
  await send('/api/audible', 'POST', { store: 'us', groups: 'series', asins: ['B0DOWN0000'] });
  await fetch(base + '/index.html');
  await send('/api/hardcover/token', 'PUT', { token: 'Bearer tok-123' });
  await send('/api/hardcover', 'POST', { mode: 'import', dryRun: true, base: CatalogImport.fingerprint(fs.readFileSync(path.join(dataDir, 'books.json'), 'utf8')),
    infoBase: CatalogImport.fingerprint('{}') });
  await until(l => l.startsWith('finished: Hardcover'));
  await send('/api/hardcover', 'POST', { mode: 'import', base: 'old', infoBase: 'old' });
  await until(l => l.startsWith('POST /api/hardcover 409'));

  const log = lines.join('\n');
  assert.match(log, /^started: Audible series lookup of 1 ASIN\(s\) on audible\.com$/m);
  assert.match(log, /^external: GET https:\/\/api\.audible\.com\/1\.0\/catalog\/products\/B0SERIES01\?response_groups=series -> 200 \(\d+ ms\)$/m);
  assert.match(log, /^finished: Audible series lookup of 1 ASIN\(s\) on audible\.com, 1 found \(\d+ ms\)$/m);
  assert.match(log, /^POST \/api\/audible 200 \(\d+ ms\)$/m);
  assert.match(log, /^external: GET \S+B0DOWN0000\S+ -> 503/m);
  assert.match(log, /^finished: \S+ series lookup .*, failed: Audible answered 503/m);
  assert.match(log, /^POST \/api\/audible 502 \(could not reach audible\.com \(Audible answered 503\)\) \(\d+ ms\)$/m);
  assert.match(log, /^PUT \/api\/hardcover\/token 200 /m);
  assert.match(log, /^started: Hardcover import \(dry run\)$/m);
  assert.match(log, /^external: POST https:\/\/api\.hardcover\.app\/v1\/graphql \(me\) -> 200 /m);
  assert.match(log, /^external: POST https:\/\/api\.hardcover\.app\/v1\/graphql \(Shelf\) -> 200 /m);
  assert.match(log, /^finished: Hardcover import \(dry run\), exit code 0 \(\d+ ms\)$/m);
  assert.match(log, /^POST \/api\/hardcover 409 \(data\/books\.json or data\/series-info\.json changed on disk since the page loaded it\)/m);
  assert.doesNotMatch(log, /index\.html/, 'only API calls, not the pages');
  assert.doesNotMatch(log, /tok-123/, 'never the token');
});

test('serve saves the page\'s edits to your own data, and nothing else', async t => {
  const { tmp, run } = sandbox(t);
  const server = createServer(tmp, () => server.address().port);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const url = `http://localhost:${port}/api/save`;
  const fp = CatalogImport.fingerprint;
  const put = (body, headers = {}) => fetch(url, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  // demo data only: not writable, and a save is refused
  assert.deepEqual(await (await fetch(url)).json(), { writable: false, audible: true, hardcover: false });
  assert.equal((await put({ books: [], seriesInfo: {} })).status, 409);

  assert.equal(run('init').code, 0);
  const booksPath = path.join(tmp, 'data', 'books.json'), infoPath = path.join(tmp, 'data', 'series-info.json');
  assert.deepEqual(await (await fetch(url)).json(), { writable: true, audible: true, hardcover: true });
  const base = fp(fs.readFileSync(booksPath, 'utf8')), infoBase = fp(fs.readFileSync(infoPath, 'utf8'));

  // a save writes both files, tidied like sync-export, and returns the new fingerprints
  const books = [{ t: 'Saved  From Page', a: ['A.B. Quill'], s: 'Saga', sn: '1' }];
  const seriesInfo = { Saga: { total: 3, status: 'ongoing', note: '' } };
  const res = await put({ books, seriesInfo, base, infoBase });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.deepEqual(loadBooks(booksPath), [{ t: 'Saved From Page', a: ['A. B. Quill'], s: 'Saga', sn: '1' }]);
  assert.deepEqual(saved.books, loadBooks(booksPath));
  assert.deepEqual(JSON.parse(fs.readFileSync(infoPath, 'utf8')), seriesInfo);
  assert.equal(saved.base, fp(fs.readFileSync(booksPath, 'utf8')));
  assert.equal(saved.infoBase, fp(fs.readFileSync(infoPath, 'utf8')));
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'data')).filter(f => f.endsWith('.tmp')), []);

  // books removed in the page are added to excluded.txt, once
  const excludedPath = path.join(tmp, 'data', 'excluded.txt');
  fs.unlinkSync(excludedPath);
  const excluded = await put({ books: saved.books, seriesInfo, excluded: ['BGONE', 'Gone | Ann'], base: saved.base, infoBase: saved.infoBase });
  assert.equal(excluded.status, 200);
  const excludedText = fs.readFileSync(excludedPath, 'utf8');
  assert.match(excludedText, /^# Books that imports must never re-add/);
  assert.ok(excludedText.endsWith('\nBGONE\nGone | Ann\n'));
  assert.equal((await put({ books: saved.books, seriesInfo, excluded: ['gone | ann'], base: saved.base, infoBase: saved.infoBase })).status, 200);
  assert.equal(fs.readFileSync(excludedPath, 'utf8'), excludedText);
  assert.equal((await put({ books: saved.books, seriesInfo, excluded: 'BGONE', base: saved.base, infoBase: saved.infoBase })).status, 400);

  // so are the pairs marked "Not duplicates" on the duplicates page, to not-duplicates.txt
  const notDupPath = path.join(tmp, 'data', 'not-duplicates.txt');
  const marks = ['["a","b","",""] ["c","b","",""]', '["editions","gr 7","id B1"]'];
  assert.equal((await put({ books: saved.books, seriesInfo, notDuplicates: marks, base: saved.base, infoBase: saved.infoBase })).status, 200);
  const notDupText = fs.readFileSync(notDupPath, 'utf8');
  assert.match(notDupText, /^# Books the Duplicates page was told are different books/);
  assert.deepEqual(CatalogImport.parseNotDuplicates(notDupText), marks);
  assert.equal((await put({ books: saved.books, seriesInfo, notDuplicates: [marks[1]], base: saved.base, infoBase: saved.infoBase })).status, 200);
  assert.equal(fs.readFileSync(notDupPath, 'utf8'), notDupText);
  assert.equal((await put({ books: saved.books, seriesInfo, notDuplicates: 'x', base: saved.base, infoBase: saved.infoBase })).status, 400);

  // a save based on an older version of the files is refused, and the files stay as they are
  const stale = await put({ books: [], seriesInfo: {}, base, infoBase });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).conflict, true);
  assert.equal(loadBooks(booksPath).length, 1);

  // invalid books are refused with the reasons
  const bad = await put({ books: [{ t: 'No Author' }], seriesInfo: {}, base: saved.base, infoBase: saved.infoBase });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).errors.length);
  assert.equal(loadBooks(booksPath).length, 1);

  // other sites cannot save: wrong origin, wrong host, or not JSON
  const ok = { books: [], seriesInfo: {}, base: saved.base, infoBase: saved.infoBase };
  assert.equal((await put(ok, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(ok) })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/save', method: 'PUT',
      headers: { Host: `evil.example:${port}`, 'Content-Type': 'application/json' } }, resolve);
    req.on('error', reject);
    req.end(JSON.stringify(ok));
  });
  assert.equal(wrongHost.statusCode, 403);
  wrongHost.resume();
  assert.equal(loadBooks(booksPath).length, 1);

  // author info is saved to authors.json, tidied, when the page sends it, checked like the other files
  const authorsPath = path.join(tmp, 'data', 'authors.json');
  const authorsBase = fp(fs.readFileSync(authorsPath, 'utf8'));
  const withAuthors = await put({ books: saved.books, seriesInfo, authors: { 'A. B. Quill': { bio: ' Quill  writes. ' } }, base: saved.base, infoBase: saved.infoBase, authorsBase });
  assert.equal(withAuthors.status, 200);
  const savedAuthors = await withAuthors.json();
  assert.deepEqual(savedAuthors.authors, { 'A. B. Quill': { bio: 'Quill writes.' } });
  assert.equal(fs.readFileSync(authorsPath, 'utf8'), JSON.stringify(savedAuthors.authors));
  assert.equal(savedAuthors.authorsBase, fp(fs.readFileSync(authorsPath, 'utf8')));
  const staleAuthors = await put({ books: saved.books, seriesInfo, authors: {}, base: saved.base, infoBase: saved.infoBase, authorsBase });
  assert.equal(staleAuthors.status, 409);
  const badAuthors = await put({ books: saved.books, seriesInfo, authors: { 'A. B. Quill': { url: 'x' } }, base: saved.base, infoBase: saved.infoBase, authorsBase: savedAuthors.authorsBase });
  assert.equal(badAuthors.status, 400);
  assert.match((await badAuthors.json()).errors.join(), /'url' must be a web address/);
  assert.equal(fs.readFileSync(authorsPath, 'utf8'), JSON.stringify(savedAuthors.authors));

  // and the data files are still served as before
  assert.deepEqual(await (await fetch(`http://localhost:${port}/data/books.json`)).json(), loadBooks(booksPath));
});

test('merge-backup merges a backup from another device into data/', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const dir = path.join(tmp, 'data');
  fs.writeFileSync(path.join(dir, 'books.json'), JSON.stringify([
    { t: 'Here', a: ['Ann Vale'] }, { t: 'Gone There', a: ['Ann Vale'] }, { t: 'Renamed', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B1' } }] },
  ]));
  const backup = path.join(tmp, 'phone.json');
  fs.writeFileSync(backup, JSON.stringify({
    books: [{ t: 'Here', a: ['Ann Vale'], r: ['2025-06-01'] }, { t: 'Renamed Twice', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B1' } }] }, { t: 'New There', a: ['Ann Vale'] }],
    seriesInfo: {}, excluded: ['Gone There | Ann Vale'], notDuplicates: ['["editions","id B1"]', '["editions","id B7"]'],
    authors: { 'Ann Vale': { bio: 'From the phone.' } },
  }));
  fs.writeFileSync(path.join(dir, 'authors.json'), JSON.stringify({ 'Ann Vale': { bio: 'From the PC.' } }));
  fs.writeFileSync(path.join(dir, 'not-duplicates.txt'), '["editions","id B1"]\n');
  const dry = run('merge-backup', backup, '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /new from the backup: 1\n {4}\+ New There - Ann Vale/);
  assert.match(dry.out, /removed \(removed on the other device\): 1\n {4}- Gone There - Ann Vale/);
  assert.match(dry.out, /title, author or series differ, kept ours: 1/);
  assert.match(dry.out, /marked not duplicates: 1 new/);
  assert.match(dry.out, /author info: 0 added, 0 taken from the backup, 1 differing kept as ours/);
  assert.match(dry.out, /dry run/);
  assert.equal(loadBooks(path.join(dir, 'books.json')).length, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'not-duplicates.txt'), 'utf8'), '["editions","id B1"]\n');

  const { code, out, err } = run('merge-backup', backup, '--prefer-backup');
  assert.equal(code, 0, err);
  assert.match(out, /kept the backup's: 1/);
  assert.deepEqual(loadAuthors(path.join(dir, 'authors.json')), { 'Ann Vale': { bio: 'From the phone.' } });
  assert.deepEqual(loadBooks(path.join(dir, 'books.json')), [
    { t: 'Here', a: ['Ann Vale'], r: ['2025-06-01'] }, { t: 'Renamed Twice', a: ['Ann Vale'], e: [{ asin: { 'audible.com': 'B1' } }] }, { t: 'New There', a: ['Ann Vale'] },
  ]);
  assert.match(fs.readFileSync(path.join(dir, 'excluded.txt'), 'utf8'), /^Gone There \| Ann Vale$/m);
  assert.equal(fs.readFileSync(path.join(dir, 'not-duplicates.txt'), 'utf8'), '["editions","id B1"]\n["editions","id B7"]\n');
  assert.match(run('validate', '--prefer-backup').err, /--prefer-backup only goes with merge-backup/);
});

function hardcoverSandbox(t, books, state) {
  const { tmp } = sandbox(t);
  const dataDir = path.join(tmp, 'data');
  fs.writeFileSync(path.join(dataDir, 'books.json'), JSON.stringify(books));
  fs.writeFileSync(path.join(dataDir, 'series-info.json'), '{}');
  const hc = fakeHardcover(state);
  const run = async (argv, env = { HARDCOVER_TOKEN: 'Bearer tok-123' }, more = {}) => {
    const out = [], err = [];
    const code = await main(['--root', tmp, ...argv], { out: s => out.push(s), err: s => err.push(s), fetch: hc.fetch, pause: async () => {}, env, ...more });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { dataDir, run, sent: hc.sent, booksPath: path.join(dataDir, 'books.json') };
}

test('hardcover-sync imports the Read shelf, then puts the rest on it, and --dry-run changes nothing anywhere', async t => {
  const state = hardcoverState();
  const { run, sent, booksPath } = hardcoverSandbox(t, [
    { t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2023-07-01', '2024'], e: [{ asin: { 'audible.com': 'B0LANTERN1' } }] },
    { t: 'Brine Songs', a: ['Ann Vale'], e: [{ gr: '4242', isbn: '9780000000002' }] },
    { t: 'Handwritten', a: ['Ann Vale'] },
  ], state);
  const before = fs.readFileSync(booksPath, 'utf8');

  const dry = await run(['hardcover-sync', '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /Hardcover: 2 books on your Read shelf/);
  assert.match(dry.out, /new: 1\n {4}\+ Tidewater - Ann Vale {2}\[Gull Isle #1\]/);
  assert.match(dry.out, /not added, as Hardcover has no audiobook edition picked for them: 1\n {4}\+ The Paper Fen - Ann Vale/);
  assert.match(dry.out, /Hardcover ids filled in on your books: 2/);
  assert.match(dry.out, /books to put on your Read shelf: 2/);
  assert.match(dry.out, /dates read to add: 1/);
  assert.match(dry.out, /dates read without a day, not sent .*: 1/);
  assert.match(dry.out, /not found on Hardcover .*: 1\n {4}\+ Handwritten - Ann Vale/);
  assert.match(dry.out, /dry run: nothing written/);
  assert.equal(fs.readFileSync(booksPath, 'utf8'), before);
  assert.ok(sent.every(s => s.url === 'https://api.hardcover.app/v1/graphql' && s.auth === 'Bearer tok-123'));
  assert.ok(!sent.some(s => s.query.startsWith('mutation')), 'a dry run sends nothing to Hardcover');

  const real = await run(['hardcover-sync']);
  assert.equal(real.code, 0, real.err);
  assert.match(real.out, /put 2 book\(s\) on your Hardcover Read shelf and added 1 read\(s\)/);
  assert.deepEqual(loadBooks(booksPath), [
    { t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2023-07-01', '2024'], hcb: '80', e: [{ asin: { 'audible.com': 'B0LANTERN1' }, hc: '801' }] },
    { t: 'Brine Songs', a: ['Ann Vale'], hcb: '81', e: [{ gr: '4242', isbn: '9780000000002' }] },
    { t: 'Handwritten', a: ['Ann Vale'] },
    { t: 'Tidewater', a: ['Ann Vale'], s: 'Gull Isle', sn: '1', r: ['2024-03-15'], hcb: '77', e: [{ asin: { 'amazon.com': 'B0TIDEWAT1' }, hc: '501', n: ['Hollis Marr'], len: 600 }] },
  ]);
  assert.deepEqual(state.shelf.slice(2).map(ub => [ub.book_id, ub.edition_id, ub.status_id, ub.user_book_reads]), [
    [80, 801, 3, [{ finished_at: '2023-07-01', edition_id: 801 }]],
    [81, null, 3, []],   // found by a print edition's ISBN or Goodreads id: the book, not that edition
  ]);

  // a second run finds nothing to do on either side
  const again = await run(['hardcover-sync']);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /new: 0/);
  assert.match(again.out, /books to put on your Read shelf: 0/);
  assert.equal(state.shelf.length, 4);
});

test('hardcover-export leaves books on other shelves alone; hardcover-import adds new reads to books you have', async t => {
  const state = hardcoverState();
  state.shelf[0].user_book_reads.push({ finished_at: '2025-08-01' });
  state.shelf.push({ id: 3, book_id: 80, edition_id: null, status_id: 1, user_book_reads: [] });
  const { run, booksPath } = hardcoverSandbox(t, [
    { t: 'Tidewater', a: ['Ann Vale'], r: ['2024-03'], e: [{ asin: { 'audible.com': 'B0TIDEWAT1' } }] },
    { t: 'Lantern Hours', a: ['R. T. Hale'], e: [{ asin: { 'audible.com': 'B0LANTERN1' } }] },
  ], state);

  const exp = await run(['hardcover-export']);
  assert.equal(exp.code, 0, exp.err);
  assert.match(exp.out, /on another Hardcover shelf, left alone: 1\n {4}! Lantern Hours - R\. T\. Hale: Want to Read/);
  assert.doesNotMatch(exp.out, /Hardcover: \d+ books on your Read shelf/, 'export does not import');
  assert.deepEqual(state.shelf.map(ub => ub.status_id), [3, 3, 1]);

  const imp = await run(['hardcover-import']);
  assert.equal(imp.code, 0, imp.err);
  assert.match(imp.out, /dates read filled in on existing books: 1/);
  assert.deepEqual(loadBooks(booksPath)[0].r, ['2024-03', '2025-08-01'], '2024-03-15 is the 2024-03 you have');
  assert.doesNotMatch(imp.out, /to Hardcover:/, 'import does not export');
});

test('a box set\'s edition on its titles: exported as their own books, and reading the box set reads each', async t => {
  const state = hardcoverState();
  state.books[82] = { id: 82, title: 'Salt Ledger', contributions: [{ contribution: null, author: { name: 'Ann Vale' } }] };
  state.books[90] = { id: 90, title: 'Gull Isle: Books 1-2', contributions: [{ contribution: null, author: { name: 'Ann Vale' } }] };
  state.editions[821] = { id: 821, book_id: 82, reading_format_id: 2, contributions: [] };
  state.editions[900] = { id: 900, book_id: 90, asin: 'B0BOXSET01', reading_format_id: 2, contributions: [] };
  // each title is its own Hardcover book; the box set's edition (900) is an edition of the box set (90)
  const box = { asin: { 'audible.com': 'B0BOXSET01' }, hc: '900' };
  const { run, booksPath } = hardcoverSandbox(t, [
    { t: 'Tidewater', a: ['Ann Vale'], r: ['2024-05-01'], hcb: '77', e: [{ ...box }] },
    { t: 'Salt Ledger', a: ['Ann Vale'], r: ['2024-06-01'], hcb: '82', e: [{ ...box }, { hc: '821' }] },
  ], state);

  const exp = await run(['hardcover-export']);
  assert.equal(exp.code, 0, exp.err);
  assert.deepEqual(state.shelf.slice(2).map(ub => [ub.book_id, ub.edition_id, ub.user_book_reads]), [
    [82, 821, [{ finished_at: '2024-06-01', edition_id: 821 }]],   // its own edition, not the box set's
  ]);
  assert.deepEqual(state.shelf[0].user_book_reads.at(-1), { finished_at: '2024-05-01' }, 'Tidewater gains a read without the box set\'s edition');

  // the box set itself read on Hardcover: each of its titles was read
  state.shelf.push({ id: 9, book_id: 90, edition_id: 900, status_id: 3, user_book_reads: [{ finished_at: '2025-02-02' }] });
  const imp = await run(['hardcover-import']);
  assert.equal(imp.code, 0, imp.err);
  assert.deepEqual(loadBooks(booksPath).map(b => [b.t, b.hcb, b.r]), [
    ['Tidewater', '77', ['2024-03-15', '2024-05-01', '2025-02-02']],
    ['Salt Ledger', '82', ['2024-06-01', '2025-02-02']],
  ]);
});

test('hardcover commands need a token, and write nothing when Hardcover says no', async t => {
  const { run, booksPath } = hardcoverSandbox(t, [{ t: 'Tidewater', a: ['Ann Vale'] }], hardcoverState());
  const before = fs.readFileSync(booksPath, 'utf8');
  const none = await run(['hardcover-sync'], {});
  assert.equal(none.code, 2);
  assert.match(none.err, /no Hardcover API token .*: save it on the Import & export page under make serve, put it in data[\/\\]hardcover-token or set \$HARDCOVER_TOKEN/);
  const bad = await run(['hardcover-import'], { HARDCOVER_TOKEN: 'stale' });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Hardcover refused your token .*; nothing written/);
  assert.equal(fs.readFileSync(booksPath, 'utf8'), before);
});

test('hardcover commands use the token saved with the catalogue when $HARDCOVER_TOKEN is not set', async t => {
  const { run, dataDir, sent } = hardcoverSandbox(t, [{ t: 'Tidewater', a: ['Ann Vale'] }], hardcoverState());
  fs.writeFileSync(path.join(dataDir, 'hardcover-token'), 'Bearer tok-123\n');
  const res = await run(['hardcover-import', '--dry-run'], {});
  assert.equal(res.code, 0, res.err);
  assert.ok(sent.length && sent.every(s => s.auth === 'Bearer tok-123'));
  // the environment wins over the file
  const env = await run(['hardcover-import', '--dry-run'], { HARDCOVER_TOKEN: 'other' });
  assert.equal(env.code, 1);
});

test('serve keeps the Hardcover token for the page, never shows it, and runs Hardcover imports and exports', async t => {
  const { tmp } = sandbox(t);
  const dataDir = path.join(tmp, 'data');
  const booksPath = path.join(dataDir, 'books.json'), tokenPath = path.join(dataDir, 'hardcover-token');
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2023-07-01'], e: [{ asin: { 'audible.com': 'B0LANTERN1' } }] }]));
  fs.writeFileSync(path.join(dataDir, 'series-info.json'), '{}');
  const state = hardcoverState(), hc = fakeHardcover(state);
  const server = createServer(tmp, () => server.address().port, {}, { fetch: hc.fetch, pause: async () => {}, env: {} });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const send = (url, method, body, headers = {}) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const fingerprints = () => ({ base: CatalogImport.fingerprint(fs.readFileSync(booksPath, 'utf8')), infoBase: CatalogImport.fingerprint('{}') });

  assert.deepEqual(await (await fetch(base + '/api/hardcover/token')).json(), { token: false });
  assert.equal((await send('/api/hardcover/token', 'PUT', { token: 'tok-123' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await send('/api/hardcover/token', 'PUT', { token: '' })).status, 400);
  assert.equal((await send('/api/hardcover/token', 'PUT', { token: 'Bearer tok-123' })).status, 200);
  assert.equal(fs.readFileSync(tokenPath, 'utf8'), 'tok-123\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  assert.deepEqual(await (await fetch(base + '/api/hardcover/token')).json(), { token: true });
  assert.equal((await fetch(base + '/data/hardcover-token')).status, 404, 'no page can read the token');
  assert.equal((await fetch(base + '/data/../data/HARDCOVER-TOKEN')).status, 404);

  // a run goes on in the background: POST starts it, GET follows it until it is done
  const follow = async res => {
    assert.equal(res.status, 202);
    let { job } = await res.json();
    while (job.running) {
      await new Promise(done => setTimeout(done, 5));
      ({ job } = await (await fetch(base + '/api/hardcover')).json());
    }
    return job;
  };
  assert.deepEqual(await (await fetch(base + '/api/hardcover')).json(), { job: null });
  // a dry run changes nothing anywhere; the real run writes data/books.json and Hardcover
  const dry = await follow(await send('/api/hardcover', 'POST', { mode: 'sync', dryRun: true, ...fingerprints() }));
  assert.equal(dry.code, 0, dry.err);
  assert.equal(dry.dryRun, true);
  assert.match(dry.out, /books to put on your Read shelf: 1[\s\S]*dry run: nothing written/);
  assert.equal(state.shelf.length, 2);
  assert.equal((await send('/api/hardcover', 'POST', { mode: 'sync', ...fingerprints() }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await send('/api/hardcover', 'POST', { mode: 'all', ...fingerprints() })).status, 400);
  const stale = await send('/api/hardcover', 'POST', { mode: 'sync', base: 'old', infoBase: 'old' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).conflict, true);
  const real = await follow(await send('/api/hardcover', 'POST', { mode: 'sync', ...fingerprints() }));
  assert.equal(real.code, 0, real.err);
  assert.match(real.out, /put 1 book\(s\) on your Hardcover Read shelf and added 1 read\(s\)/);
  assert.equal(state.shelf.length, 3);
  assert.equal(real.base, fingerprints().base);
  assert.ok(real.elapsed >= 0);
  assert.equal(loadBooks(booksPath).length, 2, 'Tidewater was imported');

  assert.equal((await send('/api/hardcover/token', 'DELETE')).status, 200);
  assert.ok(!fs.existsSync(tokenPath));
  const none = await follow(await send('/api/hardcover', 'POST', { mode: 'import', dryRun: true, ...fingerprints() }));
  assert.equal(none.code, 2);
  assert.match(none.err, /no Hardcover API token/);
});

test('serve looks up a Hardcover book by its address for the page, with the token it keeps', async t => {
  const { tmp } = sandbox(t);
  const dataDir = path.join(tmp, 'data');
  const hc = fakeHardcover(hardcoverState());
  const server = createServer(tmp, () => server.address().port, {}, { fetch: hc.fetch, pause: async () => {}, env: {} });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const lookup = async (address, headers = {}) => {
    const res = await fetch(base + '/api/hardcover/book', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ address }) });
    return [res.status, await res.json()];
  };
  const address = 'https://hardcover.app/books/tidewater';
  assert.deepEqual(await lookup(address), [409, { error: 'no data/books.json: run `node catalog.js init` first' }]);
  fs.writeFileSync(path.join(dataDir, 'books.json'), '[]');
  assert.match((await lookup(address))[1].error, /no Hardcover API token/);
  fs.writeFileSync(path.join(dataDir, 'hardcover-token'), 'tok-123\n');
  assert.equal((await lookup(address, { Origin: 'http://evil.example' }))[0], 403);
  assert.equal((await lookup('Tidewater'))[0], 400);
  assert.deepEqual(await lookup(address), [200, { id: '77', title: 'Tidewater' }]);
  assert.deepEqual(await lookup('https://hardcover.app/books/whatever/editions/801'), [200, { id: '80', title: 'Lantern Hours' }]);
  assert.deepEqual(await lookup('https://hardcover.app/books/no-such-book'), [404, { error: 'Hardcover has no book at hardcover.app/books/no-such-book' }]);
  assert.ok(hc.sent.every(s => s.auth === 'Bearer tok-123'));
  assert.equal((await fetch(base + '/api/hardcover/book')).status, 405);
});

test('serve shows a Hardcover run while it goes, runs one at a time, and an edit saved meanwhile stops it', async t => {
  const { tmp } = sandbox(t);
  const dataDir = path.join(tmp, 'data');
  const booksPath = path.join(dataDir, 'books.json');
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'Lantern Hours', a: ['R. T. Hale'], e: [{ asin: { 'audible.com': 'B0LANTERN1' } }] }]));
  fs.writeFileSync(path.join(dataDir, 'series-info.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'hardcover-token'), 'tok-123');
  const state = hardcoverState(), hc = fakeHardcover(state);
  let release = null, gate = null;
  const hold = () => { gate = new Promise(done => { release = done; }); };
  const server = createServer(tmp, () => server.address().port, {}, { fetch: hc.fetch, pause: () => gate || Promise.resolve(), env: {} });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const start = body => fetch(base + '/api/hardcover', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: CatalogImport.fingerprint(fs.readFileSync(booksPath, 'utf8')), infoBase: CatalogImport.fingerprint('{}'), ...body }) });
  const now = async () => (await (await fetch(base + '/api/hardcover')).json()).job;
  const until = async test => { for (let job = await now(); ; job = await now()) { if (test(job)) return job; await new Promise(done => setTimeout(done, 5)); } };

  hold();
  const first = await start({ mode: 'sync' });
  assert.equal(first.status, 202);
  const going = await until(job => job.step !== 'Starting');
  assert.equal(going.running, true);
  assert.equal(going.mode, 'sync');
  assert.equal(going.dryRun, false);
  assert.match(going.step, /^Reading your Hardcover shelves/);
  const second = await start({ mode: 'import', dryRun: true });
  assert.equal(second.status, 409, 'one run at a time');
  assert.equal((await second.json()).job.id, going.id);

  // an edit saved from the page while it runs: the run writes nothing and sends nothing
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'Lantern Hours', a: ['R. T. Hale'], g: ['Edited'], e: [{ asin: { 'audible.com': 'B0LANTERN1' } }] }]));
  gate = null;
  release();
  const done = await until(job => !job.running);
  assert.equal(done.code, 1);
  assert.match(done.err, /data[\/\\]books\.json changed while this ran .*nothing written, nothing sent to Hardcover/);
  assert.deepEqual(loadBooks(booksPath)[0].g, ['Edited']);
  assert.equal(state.shelf.length, 2);
  assert.ok(!hc.sent.some(s => s.query.startsWith('mutation')));
});

test('hardcover commands say what they are doing through io.progress', async t => {
  const state = hardcoverState();
  const { run } = hardcoverSandbox(t, [{ t: 'Lantern Hours', a: ['R. T. Hale'], r: ['2023-07-01'], e: [{ asin: { 'audible.com': 'B0LANTERN1' } }] }], state);
  const steps = [];
  const res = await run(['hardcover-sync'], undefined, { progress: (text, done, total) => steps.push(total ? `${text}: ${done} of ${total}` : text) });
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(steps, [
    'Reading your Hardcover shelves',
    'Reading your Hardcover shelves: 2 books',
    'Reading the books on your Read shelf: 0 of 2',
    'Reading the editions on your Read shelf: 0 of 2',
    'Finding your books on Hardcover: 0 of 1',
    'Checking your editions on Hardcover: 0 of 2',
    'Putting books on your Hardcover Read shelf: 0 of 1',
  ]);
});
