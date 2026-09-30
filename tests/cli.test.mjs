// Tests for the command line (catalog.js), run against a copy of the demo data in a temp folder.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { main, loadBooks } = createRequire(import.meta.url)('../catalog.js');

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
  for (const argv of [['format'], ['import-audible', 'x.csv'], ['import-goodreads', 'x.csv'], ['sync-export', 'x.json']]) {
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
    { t: 'A Spark of Dawn', a: 'Ilse Marlowe', s: 'A Crown of Embers', sn: '5', id: 'B5' },
    { t: 'Ashfall', a: 'Ilse Marlowe', n: 'A. B. Quill', s: 'A Crown of Embers', sn: '6', id: 'B6' },
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
    [{ t: 'Kept', a: 'Ann', n: 'Nate Narrator', s: 'Series', sn: '2', g: ['fantasy'] }]);

  // a later export with a date read fills it in on the book already there
  fs.writeFileSync(csv, 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n'
    + '"Kept (Series, #2)",Ann,Nate Narrator,Audible Audio,read,fantasy,2024/03/15\n');
  assert.match(run('import-goodreads', csv).out, /dates read filled in on existing books: 1/);
  assert.deepEqual(loadBooks(path.join(tmp, 'data', 'books.json'))[0].r, ['2024-03-15']);
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
  assert.deepEqual(saved, [{ t: 'New Book', a: 'A. B. Quill', n: 'R. T. Hale' }, { t: 'Fine Book', a: 'Ann Vale' }]);
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
