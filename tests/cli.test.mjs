// Tests for the command line (catalog.js), run against a copy of the demo data in a temp folder.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { main, loadBooks, createServer } = require('../catalog.js');
const CatalogImport = require('../importers.js');

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
});

test('import-audible previews with --dry-run, then adds, fills in ids and honours excluded.txt', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const books = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(books, JSON.stringify([{ t: 'A Spark of Dawn', a: 'Ilse Marlowe', s: 'A Crown of Embers', sn: '5' }]));
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
  assert.match(dry.out, /Audible ids filled in on existing books: 1/);
  assert.match(dry.out, /skipped \(listed in data\/excluded.txt\): 1/);
  assert.match(dry.out, /\+ Ashfall - Ilse Marlowe {2}\[A Crown of Embers #6\]/);
  assert.match(dry.out, /dry run/);
  assert.equal(fs.readFileSync(books, 'utf8'), before);

  assert.equal(run('import-audible', csv).code, 0);
  assert.deepEqual(loadBooks(books), [
    { t: 'A Spark of Dawn', a: 'Ilse Marlowe', s: 'A Crown of Embers', sn: '5', e: [{ id: 'B5' }] },
    { t: 'Ashfall', a: 'Ilse Marlowe', s: 'A Crown of Embers', sn: '6', e: [{ id: 'B6', n: 'A. B. Quill' }] },
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
    [{ t: 'Kept', a: 'Ann', s: 'Series', sn: '2', g: ['fantasy'], e: [{ n: 'Nate Narrator' }] }]);

  // a later export with a date read fills it in on the book already there
  fs.writeFileSync(csv, 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n'
    + '"Kept (Series, #2)",Ann,Nate Narrator,Audible Audio,read,fantasy,2024/03/15\n');
  assert.match(run('import-goodreads', csv).out, /dates read filled in on existing books: 1/);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json'))[0].r, ['2024-03-15']);

  // and a later one with Goodreads' Book Id column fills that in too
  fs.writeFileSync(csv, 'Book Id,Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\n'
    + '4242,"Kept (Series, #2)",Ann,Nate Narrator,Audible Audio,read,fantasy\n');
  assert.match(run('import-goodreads', csv).out, /Goodreads ids filled in on existing books: 1/);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json'))[0].e, [{ gr: '4242', n: 'Nate Narrator' }]);
});

// The columns of a real Audible Library Extractor CSV export.
const ALE_COLUMNS = ['Added', 'Title', 'Title Short', 'Series', 'Book Numbers', 'Blurb', 'Authors', 'Narrators', 'Tags', 'Categories',
  'Parent Category', 'Child Category', 'Length', 'Progress', 'Release Date', 'Purchase Date', 'Publishers', 'My Rating', 'Rating',
  'Ratings', 'Favorite', 'Format', 'Language', 'Whispersync', 'From Plus Catalog', 'Unavailable', 'Archived', 'Downloaded',
  'Store Page Changed', 'Store Page Missing', 'ASIN', 'ISBN10', 'ISBN13', 'Summary', 'People Also Bought', 'Store Page Url',
  'Sample', 'Web Player', 'Cover', 'Search In Goodreads', 'Subtitle', 'Collection Ids'];
const row = values => ALE_COLUMNS.map(c => values[c] || '').join(',') + '\n';

test('imports store ISBNs, add other editions\' ISBNs, and skip ISBNs in excluded.txt', t => {
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
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json')), [{ t: 'Kept', a: 'Ann', e: [{ id: 'B1', isbn: ['9780306406157'] }] }]);

  const gr = path.join(tmp, 'goodreads.csv');
  fs.writeFileSync(gr, 'Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf\n'
    + 'Kept,Ann,"=""""","=""9780000000002""",Audible Audio,read\n');
  ({ code, out } = run('import-goodreads', gr));
  assert.match(out, /ISBNs added to existing books: 1/);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json'))[0].e, [{ id: 'B1', isbn: ['9780306406157', '9780000000002'] }]);
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
    [{ t: 'Kept', a: 'Ann', e: [{ id: 'B1', p: 'Gull Audio', d: '2021-05-04', len: 642 }, { id: 'B1UK' }] }]);
});

test('books from before editions validate, and format rewrites them with editions', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const booksPath = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'Old', a: 'Ann', id: 'B1', gr: '7', isbn: ['9780306406157'] }]));
  const { code, out } = run('validate');
  assert.equal(code, 0);
  assert.match(out, /from before editions/);
  assert.equal(run('format').code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(booksPath, 'utf8')), [{ t: 'Old', a: 'Ann', e: [{ id: 'B1', gr: '7', isbn: ['9780306406157'] }] }]);
  assert.doesNotMatch(run('validate').out, /from before editions/);
});

test('titles holding their series validate, and format splits them', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const booksPath = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'The First Adventure: Fantasy Adventures, Book 1', a: 'Ann' }]));
  assert.match(run('validate').out, /1 title\(s\) still hold their series/);
  assert.equal(run('format').code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(booksPath, 'utf8')), [{ t: 'The First Adventure', a: 'Ann', s: 'Fantasy Adventures', sn: '1' }]);
  assert.doesNotMatch(run('validate').out, /still hold their series/);
});

test('an import that would leave invalid data writes nothing', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const books = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(books, JSON.stringify([{ t: 'Broken', a: 'X', sn: '1' }]));
  const csv = path.join(tmp, 'library.csv');
  fs.writeFileSync(csv, 'Title Short,Authors,Progress,ASIN\nNew,Y,Finished,B1\n');
  const { code, err } = run('import-audible', csv);
  assert.equal(code, 1);
  assert.match(err, /Validation failed, nothing written/);
  assert.deepEqual(loadBooks(books), [{ t: 'Broken', a: 'X', sn: '1' }]);
});

test('sync-export tidies names and spacing', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init', '--sample').code, 0);
  const exported = path.join(tmp, 'export.json');
  fs.writeFileSync(exported, JSON.stringify([
    { t: 'New  Book', a: 'A.B. Quill', n: 'R.T.   Hale' },
    { t: 'Fine Book', a: 'Ann Vale' },
  ]));
  const { code, out } = run('sync-export', exported);
  assert.equal(code, 0);
  assert.match(out, /tidied stray spacing \/ run-together initials on 1 book/);
  const saved = loadBooks(path.join(tmp, 'data', 'books.json'));
  // a narrator on the book, from before narrators moved to editions, is saved on an edition
  assert.deepEqual(saved, [{ t: 'New Book', a: 'A. B. Quill', e: [{ n: 'R. T. Hale' }] }, { t: 'Fine Book', a: 'Ann Vale' }]);
});

test('a date read written as a plain string is accepted and saved as a list', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const booksPath = path.join(tmp, 'data', 'books.json');
  fs.writeFileSync(booksPath, JSON.stringify([{ t: 'Hand Edited', a: 'Ann Vale', r: '2024-03-15' }]));
  assert.equal(run('validate').code, 0);

  const exported = path.join(tmp, 'export.json');
  fs.writeFileSync(exported, JSON.stringify({ books: [
    { t: 'Hand Edited', a: 'Ann Vale', r: '2024-03-15' },
    { t: 'Two Reads', a: 'Ann Vale', r: '2025-01-02, 2021' },
  ], seriesInfo: {} }));
  const { code, err } = run('sync-export', exported);
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(fs.readFileSync(booksPath, 'utf8')).map(b => b.r), [['2024-03-15'], ['2021', '2025-01-02']]);

  fs.writeFileSync(exported, JSON.stringify([{ t: 'Bad', a: 'Ann Vale', r: 'last summer' }]));
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
  assert.deepEqual(await (await fetch(url)).json(), { writable: false });
  assert.equal((await put({ books: [], seriesInfo: {} })).status, 409);

  assert.equal(run('init').code, 0);
  const booksPath = path.join(tmp, 'data', 'books.json'), infoPath = path.join(tmp, 'data', 'series-info.json');
  assert.deepEqual(await (await fetch(url)).json(), { writable: true });
  const base = fp(fs.readFileSync(booksPath, 'utf8')), infoBase = fp(fs.readFileSync(infoPath, 'utf8'));

  // a save writes both files, tidied like sync-export, and returns the new fingerprints
  const books = [{ t: 'Saved  From Page', a: 'A.B. Quill', s: 'Saga', sn: '1' }];
  const seriesInfo = { Saga: { total: 3, status: 'ongoing', note: '' } };
  const res = await put({ books, seriesInfo, base, infoBase });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.deepEqual(loadBooks(booksPath), [{ t: 'Saved From Page', a: 'A. B. Quill', s: 'Saga', sn: '1' }]);
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

  // and the data files are still served as before
  assert.deepEqual(await (await fetch(`http://localhost:${port}/data/books.json`)).json(), loadBooks(booksPath));
});

test('merge-backup merges a backup from another device into data/', t => {
  const { tmp, run } = sandbox(t);
  assert.equal(run('init').code, 0);
  const dir = path.join(tmp, 'data');
  fs.writeFileSync(path.join(dir, 'books.json'), JSON.stringify([
    { t: 'Here', a: 'Ann Vale' }, { t: 'Gone There', a: 'Ann Vale' }, { t: 'Renamed', a: 'Ann Vale', e: [{ id: 'B1' }] },
  ]));
  const backup = path.join(tmp, 'phone.json');
  fs.writeFileSync(backup, JSON.stringify({
    books: [{ t: 'Here', a: 'Ann Vale', r: ['2025-06-01'] }, { t: 'Renamed Twice', a: 'Ann Vale', e: [{ id: 'B1' }] }, { t: 'New There', a: 'Ann Vale' }],
    seriesInfo: {}, excluded: ['Gone There | Ann Vale'],
  }));
  const dry = run('merge-backup', backup, '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /new from the backup: 1\n {4}\+ New There - Ann Vale/);
  assert.match(dry.out, /removed \(removed on the other device\): 1\n {4}- Gone There - Ann Vale/);
  assert.match(dry.out, /title, author or series differ, kept ours: 1/);
  assert.match(dry.out, /dry run/);
  assert.equal(loadBooks(path.join(dir, 'books.json')).length, 3);

  const { code, out, err } = run('merge-backup', backup, '--prefer-backup');
  assert.equal(code, 0, err);
  assert.match(out, /kept the backup's: 1/);
  assert.deepEqual(loadBooks(path.join(dir, 'books.json')), [
    { t: 'Here', a: 'Ann Vale', r: ['2025-06-01'] }, { t: 'Renamed Twice', a: 'Ann Vale', e: [{ id: 'B1' }] }, { t: 'New There', a: 'Ann Vale' },
  ]);
  assert.match(fs.readFileSync(path.join(dir, 'excluded.txt'), 'utf8'), /^Gone There \| Ann Vale$/m);
  assert.match(run('validate', '--prefer-backup').err, /--prefer-backup only goes with merge-backup/);
});
