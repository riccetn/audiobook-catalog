// Tests for importers.js, the browser port of the Python importers. The cases mirror
// tests/test_model.py, test_audible.py, test_goodreads.py and test_merge.py, and the last test runs
// the Python pipeline on the same files and checks both give identical results.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = createRequire(import.meta.url)('../importers.js');

const book = (t, a = 'Author', extra = {}) => ({ t, a, ...extra });

// ------------------------------------------------------------------ model
test('series names: spelling variants are one series, different series stay apart', () => {
  const variants = ['Ember Coast', 'Ember Coast Series', 'The Ember-Coast series', 'ember coast'];
  assert.equal(new Set(variants.map(C.seriesNorm)).size, 1);
  assert.equal(C.seriesNorm('Salt-Marsh Hollow'), C.seriesNorm('Salt Marsh Hollow'));
  assert.notEqual(C.seriesNorm('The Harbor Guild'), C.seriesNorm('The Ridge Guild'));
});

test('first author ignores co-authors', () => {
  assert.equal(C.firstAuthor('R.T. Hale, C.J. Marsh'), C.firstAuthor('R.T. Hale'));
  assert.equal(C.firstAuthor('Ann Vale and P.T. Vale'), C.norm('Ann Vale'));
});

test('lookup keys are forgiving in one direction only', () => {
  const key = (...p) => JSON.stringify(p);
  const longForm = { t: 'A Crown of Embers 5: A Spark of Dawn', a: 'Ilse Marlowe' };
  assert.ok(C.lookupKeys(longForm).includes(key('title', C.norm('A Spark of Dawn'), C.norm('Ilse Marlowe'))));
  const box = { t: 'Lantern of the Deep: Books 1-3', a: 'R.T. Hale' };
  assert.ok(!C.lookupKeys(box).includes(key('title', C.norm('Lantern of the Deep'), C.norm('R.T. Hale'))));
});

test('names and text are tidied', () => {
  const cases = {
    'A.B. Quill': 'A. B. Quill', 'A. B. Quill': 'A. B. Quill', 'A.B.C. Quill': 'A. B. C. Quill',
    'Ann Vale, R.T. Hale': 'Ann Vale, R. T. Hale', 'R.T. Hale and P.Q. Vale': 'R. T. Hale and P. Q. Vale',
    'Ann Vale': 'Ann Vale', 'A. Quill': 'A. Quill', 'Quill, A.B.': 'Quill, A. B.',
  };
  for (const [raw, expected] of Object.entries(cases)) {
    assert.equal(C.normalizeName(raw), expected, raw);
    assert.equal(C.normalizeName(expected), expected, 'idempotent: ' + expected);
  }
  assert.equal(C.tidyText('  Ann    Vale \t'), 'Ann Vale');
  assert.equal(C.tidyText('Ann\u00a0Vale'), 'Ann Vale');
  assert.equal(C.tidyText('Ann\u200b Vale\ufeff'), 'Ann Vale');
  assert.equal(C.tidyText('Two\nlines'), 'Two lines');
  const rec = { t: 'A  Title ', a: 'A.B. Quill', n: 'Ann   Vale', s: ' S ', sn: '1', g: ['Fantasy ', '  ', 'Cozy  Mystery'], id: 'B0X' };
  assert.deepEqual(C.tidyBook(rec), { t: 'A Title', a: 'A. B. Quill', n: 'Ann Vale', s: 'S', sn: '1', g: ['Fantasy', 'Cozy Mystery'], id: 'B0X' });
  assert.equal(rec.t, 'A  Title ', 'the input record is not modified');
});

test('exclusions accept ASINs and title | author pairs', () => {
  const ex = C.parseExclusions('# comment\nB012345678  # trailing note\nSome Title | Some Author\n\n');
  assert.ok(ex.covers({ t: 'x', a: 'y', id: 'B012345678' }));
  assert.ok(ex.covers({ t: 'SOME title!', a: 'Some Author' }));
  assert.ok(!ex.covers({ t: 'Other', a: 'Some Author' }));
  assert.equal(C.parseExclusions('').size, 0);
});

test('validation: errors and warnings', () => {
  const clean = [{ t: 'A', a: 'B', s: 'S', sn: '1', g: ['x'], id: 'B0' }];
  assert.deepEqual(C.validate(clean, { S: { total: 3, status: 'ongoing', note: 'n', url: 'https://example.com' } }), { errors: [], warnings: [] });
  assert.equal(C.validate([{ t: '', a: 'x' }, { t: 't', a: 'a', bogus: 1 }, 'nope'], {}).errors.length, 3);
  assert.ok(C.validate([{ t: '1', a: 'a', id: 'B0' }, { t: '2', a: 'a', id: 'B0' }], {}).errors.some(e => e.includes('duplicate id')));
  const warnings = C.validate([
    { t: '1', a: 'a', s: 'Ember Coast' }, { t: '2', a: 'a', s: 'Ember Coast Series' },
    { t: '3', a: 'a', s: 'Foo (book 1), Bar' }, { t: '4', a: 'A.B. Quill', s: 'Odd', sn: '1, 1' },
  ], {}).warnings.join('\n');
  for (const needle of ['look like the same series', 'leftover Audible markup', 'unusual series number', "use 'A. B. Quill'"]) {
    assert.ok(warnings.includes(needle), needle);
  }
});

// -------------------------------------------------------------------- CSV
test('CSV: BOM, quotes, doubled quotes, newlines in quotes, CRLF, short rows', () => {
  const rows = C.parseCsv('\ufeffa,b,c\r\n1,"x, ""y""","multi\nline"\r\n\r\n2,plain\n3,mid"quote,\n');
  assert.deepEqual(rows, [
    { a: '1', b: 'x, "y"', c: 'multi\nline' },
    { a: '2', b: 'plain', c: undefined },
    { a: '3', b: 'mid"quote', c: '' },
  ]);
  assert.deepEqual(C.parseCsv(''), []);
});

// ----------------------------------------------------------------- Audible
const HEADER = 'Title,Title Short,Series,Book Numbers,Authors,Narrators,Tags,Child Category,Progress,ASIN,Blurb\n';

test('Audible series field', () => {
  assert.deepEqual(C.parseSeriesField('Thornmere: Wardens (book 1), Thornmere (book 5)'), [['Thornmere: Wardens', '1'], ['Thornmere', '5']]);
  assert.deepEqual(C.parseSeriesField('Vera Stone, Ghost Hunter (book 3)'), [['Vera Stone, Ghost Hunter', '3']]);
  assert.deepEqual(C.parseSeriesField(''), []);
  assert.deepEqual(C.parseSeriesField(undefined), []);
  assert.deepEqual(C.parseSeriesField('The Aetherverse (book ), Side Projects (book 1)'), [['The Aetherverse', null], ['Side Projects', '1']]);
  assert.deepEqual(C.parseSeriesField('Brine Bound (books 1-4)'), [['Brine Bound', '1-4']]);
  assert.deepEqual(C.parseSeriesField('Just A Name'), [['Just A Name', null]]);
  for (const raw of ['Thornmere: Ferrymen (book 1), Thornmere (book 4)', 'Thornmere (book 4), Thornmere: Ferrymen (book 1)']) {
    assert.deepEqual(C.chooseSeries(C.parseSeriesField(raw)), ['Thornmere', '4', false]);
  }
  assert.deepEqual(C.chooseSeries([['A', '1'], ['B', '2']]), ['A', '1', true]);
  assert.deepEqual(C.chooseSeries([]), [null, null, false]);
});

test('Audible titles lose a trailing series number only when it matches', () => {
  assert.equal(C.cleanTitle('Lantern of the Deep 10', '10'), 'Lantern of the Deep');
  assert.equal(C.cleanTitle('Emberhart: 2', '2'), 'Emberhart');
  assert.equal(C.cleanTitle('Marsh Kisses', '1'), 'Marsh Kisses');
  assert.equal(C.cleanTitle('Mort', null), 'Mort');
  assert.equal(C.cleanTitle('7', '7'), '7');
});

test('Audible rows', () => {
  const base = { Title: 'T', 'Title Short': 'Ts', Authors: 'A', Progress: 'Finished', ASIN: 'B0000000A1' };
  const row = kw => ({ ...base, ...kw });
  assert.deepEqual(C.audibleRowToRecord(row({ Series: 'S (book 2)', Narrators: 'N', Tags: 'Fantasy, Magic' })),
    [{ t: 'Ts', a: 'A', n: 'N', s: 'S', sn: '2', g: ['Fantasy', 'Magic'], id: 'B0000000A1' }, null]);
  const [tidy] = C.audibleRowToRecord(row({ Authors: 'A.B. Quill, Ann  Vale', Narrators: 'R.T.   Hale', Tags: 'Cozy  Mystery, Fantasy' }));
  assert.deepEqual([tidy.a, tidy.n, tidy.g], ['A. B. Quill, Ann Vale', 'R. T. Hale', ['Cozy Mystery', 'Fantasy']]);
  assert.deepEqual(C.audibleRowToRecord(row({ Progress: '3h left' })), [null, null]);
  assert.deepEqual(C.audibleRowToRecord(row({ ASIN: 'B002V8N37Q' })), [null, null]);
  const [fallback] = C.audibleRowToRecord(row({ Series: 'S', 'Book Numbers': '4, 1', 'Child Category': 'Epic' }));
  assert.deepEqual([fallback.sn, fallback.g], ['4', ['Epic']]);
  const [amb, warning] = C.audibleRowToRecord(row({ Series: 'A (book 1), B (book 2)' }));
  assert.equal(amb.s, 'A');
  assert.match(warning, /several series/);
});

test('Audible export: BOM, quoted newlines and counts', () => {
  const result = C.readAudible('\ufeff' + HEADER
    + 'T1,T1,S (book 1),1,Au,Na,"a, b",,Finished,B1,"multi\nline blurb"\n'
    + 'T2,T2,,,Au,,,,1h left,B2,\n'
    + 'Your First Listen,Your First Listen,,,Audible,,,,Finished,B002V8N37Q,\n'
    + 'T3,T3,,,,,,,Finished,B3,\n');
  assert.deepEqual(result.records.map(r => r.t), ['T1']);
  assert.equal(result.skippedUnfinished, 1);
  assert.ok(result.warnings.some(w => w.includes('no author')));
});

// --------------------------------------------------------------- Goodreads
const GR_HEADER = 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\n';

test('Goodreads series formats', () => {
  const cases = {
    'Rains of Harrow (The Wayfarer Inn, #7)': ['Rains of Harrow', 'The Wayfarer Inn', '7'],
    "Frosted (Blaze, #6; Dana O'Hare, #1)": ['Frosted', 'Blaze', '6'],
    'Ballads and Brigands (Red Harbor #3)': ['Ballads and Brigands', 'Red Harbor', '3'],
    'Rift Clash: A LitRPG Adventure (Rift Universe, Book 8)': ['Rift Clash: A LitRPG Adventure', 'Rift Universe', '8'],
    'Parallel (Parallel, #1)': ['Parallel', 'Parallel', '1'],
    'The Lamplighter': ['The Lamplighter', null, null],
  };
  for (const [raw, expected] of Object.entries(cases)) assert.deepEqual(C.parseGoodreadsTitle(raw), expected, raw);
});

test('Goodreads export: only read audio editions, with tidy names', () => {
  const result = C.readGoodreads(GR_HEADER
    + '"Kept (Series, #2)",Ann,Nate Narrator,Audible Audio,read,"urban-fantasy, witches"\n'
    + 'Paperback,Bob,,Paperback,read,\n'
    + 'Unread audio,Cy,,Audiobook,to-read,\n'
    + 'Some Book,A.B.  Quill,R.T. Hale,Audiobook,read,\n');
  assert.deepEqual(result.records, [
    { t: 'Kept', a: 'Ann', n: 'Nate Narrator', s: 'Series', sn: '2', g: ['urban-fantasy', 'witches'] },
    { t: 'Some Book', a: 'A. B. Quill', n: 'R. T. Hale' },
  ]);
  assert.equal(result.skippedUnfinished, 1);
});

// ------------------------------------------------------------------- merge
test('merge: new books are appended and the merge is idempotent', () => {
  const existing = [book('One')];
  const incoming = [book('One'), book('Two', 'Author', { id: 'B2' })];
  const report = C.merge(existing, incoming);
  assert.deepEqual(existing.map(b => b.t), ['One', 'Two']);
  assert.deepEqual([report.matched, report.added.length], [1, 1]);
  assert.equal(C.merge(existing, structuredClone(incoming)).added.length, 0);
  assert.equal(existing.length, 2);
});

test('merge: hand edits win but a missing id is filled in', () => {
  const existing = [book('A Spark of Dawn', 'Ilse Marlowe', { s: 'A Crown of Embers', sn: '5', g: ['Mine'] })];
  const report = C.merge(existing, [book('A Crown of Embers 5: A Spark of Dawn', 'Ilse Marlowe',
    { s: 'A Crown of Embers Series', sn: '5', g: ['Theirs'], id: 'B5' })]);
  assert.deepEqual(existing, [{ t: 'A Spark of Dawn', a: 'Ilse Marlowe', s: 'A Crown of Embers', sn: '5', g: ['Mine'], id: 'B5' }]);
  assert.equal(report.backfilled.length, 1);
});

test('merge: ids, long titles, boxed sets, series spelling, exclusions, authors', () => {
  let existing = [book('Completely Renamed', 'Author', { id: 'B7' })];
  assert.equal(C.merge(existing, [book('Original Title', 'Author', { id: 'B7' })]).added.length, 0);

  existing = [book('A Crown of Embers', 'Ilse Marlowe')];
  C.merge(existing, [book('A Crown of Embers, Book 1', 'Ilse Marlowe', { id: 'B1' })]);
  assert.deepEqual([existing.length, existing[0].id], [1, 'B1']);

  existing = [book('Lantern of the Deep', 'R.T. Hale')];
  assert.equal(C.merge(existing, [book('Lantern of the Deep: Books 1-3', 'R.T. Hale')]).added.length, 1);

  existing = [book('One', 'Author', { s: 'Ember Coast', sn: '1' })];
  C.merge(existing, [book('Two', 'Author', { s: 'Ember Coast Series', sn: '2' }), book('Three', 'Author', { s: 'ember-coast', sn: '3' })]);
  assert.deepEqual([...new Set(existing.map(b => b.s))], ['Ember Coast']);

  existing = [];
  const ex = C.parseExclusions('B9\nRemoved Box Set | Author\n');
  const report = C.merge(existing, [book('Gone', 'Author', { id: 'B9' }), book('Removed Box Set'), book('Fine')], ex);
  assert.deepEqual(existing.map(b => b.t), ['Fine']);
  assert.equal(report.excluded.length, 2);

  existing = [book('Dark', 'Ann')];
  C.merge(existing, [book('Dark', 'Bob')]);
  assert.equal(existing.length, 2);
});

// ------------------------------------------------------- parity with Python
const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);

test('gives exactly the same results as the Python importers', { skip: !python && 'python not found' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-parity-'));
  const audible = '\ufeff' + HEADER
    + 'Long,A Crown of Embers 5: A Spark of Dawn,A Crown of Embers Series (book 5),5,Ilse Marlowe,"R.T.  Hale",,Epic,Finished,BX1,\n'
    + 'L,Lantern of the Deep 10,Lantern of the Deep (book 10),10,A.B. Quill,,"Cozy, Mystery",,Finished,BX2,"a ""quoted""\nblurb"\n'
    + 'W,Wardens,"Thornmere: Wardens (book 3), Thornmere (book 5)",,Ann Vale,,,,Finished,BX3,\n'
    + 'A,Ambiguous,"Alpha (book 1), Beta (book 2)",,Ann Vale,,,,Finished,BX4,\n'
    + "V,Vera's Case,\"Vera Stone, Ghost Hunter (book )\",\"2, 7\",Ann Vale,,,,Finished,BX5,\n"
    + 'U,Unfinished,,,Ann Vale,,,,2h left,BX6,\n'
    + 'N,No Author,,,,,,,Finished,BX7,\n'
    + 'Box,Lantern of the Deep: Books 1-3,,,A.B. Quill,,,,Finished,BX8,\n'
    + 'Ex,Excluded One,,,Ann Vale,,,,Finished,BX9,\n';
  const goodreads = GR_HEADER
    + '"Frosted (Blaze, #6; Dana O\'Hare, #1)",Ann  Vale,Nate Narrator,Audible Audio,read,"urban-fantasy, witches"\n'
    + '"Ballads and Brigands (Red Harbor #3)",Bob,,Audio CD,read,\n'
    + '"Rift Clash: A LitRPG Adventure (Rift Universe, Book 8)",Cy,,MP3 CD,to-read,\n'
    + 'Excluded Two,A.B. Quill,,Audiobook,read,\n'
    + 'Paper,Dee,,Paperback,read,\n';
  const excluded = '# test\nBX9 # gone\nExcluded Two | A. B. Quill\n';
  const existing = [
    book('A Spark of Dawn', 'Ilse Marlowe', { s: 'A Crown of Embers', sn: '5' }),
    book('Lantern of the Deep', 'A. B. Quill'),
    book('Frosted', 'Ann Vale', { s: 'Blaze', sn: '6', id: 'BOLD' }),
  ];
  const files = { 'audible.csv': audible, 'goodreads.csv': goodreads, 'excluded.txt': excluded, 'books.json': JSON.stringify(existing) };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);

  const script = `
import json, sys
from pathlib import Path
from catalog import audible, goodreads
from catalog.merge import merge
from catalog.model import load_exclusions, validate
d = Path(sys.argv[1])
books = json.loads((d / "books.json").read_text())
ex = load_exclusions(d / "excluded.txt")
out = []
for reader, name in ((audible, "audible.csv"), (goodreads, "goodreads.csv")):
    r = reader.read_library(d / name)
    rep = merge(books, r.records, ex)
    out.append({"records": r.records, "warnings": r.warnings, "skipped": r.skipped_unfinished,
                "added": rep.added, "backfilled": rep.backfilled, "excluded": rep.excluded, "matched": rep.matched})
errors, warnings = validate(books, {})
print(json.dumps({"steps": out, "books": books, "errors": errors, "warnings": warnings}))
`;
  const py = spawnSync(python, ['-c', script, dir], { cwd: root, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(py.status, 0, py.stderr);
  const expected = JSON.parse(py.stdout);

  const books = structuredClone(existing);
  const ex = C.parseExclusions(excluded);
  const steps = [[C.readAudible, audible], [C.readGoodreads, goodreads]].map(([read, text]) => {
    const r = read(text);
    const rep = C.merge(books, r.records, ex);
    return { records: r.records, warnings: r.warnings, skipped: r.skippedUnfinished,
             added: rep.added, backfilled: rep.backfilled, excluded: rep.excluded, matched: rep.matched };
  });
  const { errors, warnings } = C.validate(books, {});
  assert.deepEqual(JSON.parse(JSON.stringify({ steps, books, errors, warnings })), expected);
  assert.ok(expected.steps[0].added.length && expected.steps[0].backfilled.length && expected.steps[1].excluded.length,
    'the fixture exercises adding, backfilling and exclusions');
});
