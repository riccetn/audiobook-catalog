// Tests for importers.js: tidying, validation, the Audible and Goodreads readers and the merge.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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

test('the series key survives a title edit', () => {
  const a = { t: 'A Spark of Dawn', a: 'Ilse Marlowe', s: 'A Crown of Embers', sn: '5' };
  const b = { t: 'A Crown of Embers 5: A Spark of Dawn', a: 'Ilse Marlowe', s: 'A Crown of Embers Series', sn: '5' };
  assert.deepEqual(C.bookKeys(a).filter(k => C.bookKeys(b).includes(k)), [C.bookKeys(a)[0]]);
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

test('validation: a clean catalogue passes; required fields, unknown keys, ids', () => {
  const clean = [{ t: 'A', a: 'B', s: 'S', sn: '1', g: ['x'], id: 'B0' }];
  assert.deepEqual(C.validate(clean, { S: { total: 3, status: 'ongoing', note: 'n', url: 'https://example.com' } }), { errors: [], warnings: [] });
  assert.equal(C.validate([{ t: '', a: 'x' }, { t: 't', a: 'a', bogus: 1 }, 'nope'], {}).errors.length, 3);
  assert.ok(C.validate([{ t: 't', a: 'a', sn: '1' }], {}).errors.some(e => e.includes('no series')));
  assert.ok(C.validate([{ t: '1', a: 'a', id: 'B0' }, { t: '2', a: 'a', id: 'B0' }], {}).errors.some(e => e.includes('duplicate id')));
});

test('validation: series-info must match a series and be well formed', () => {
  const books = [{ t: 't', a: 'a', s: 'Real' }];
  const errors = C.validate(books, {
    Ghost: { total: 2, status: 'ongoing', note: 'n' },
    Real: { total: 0, status: 'paused', note: '', url: 'ftp://x', extra: 1 },
  }).errors.join('\n');
  for (const needle of ["'Ghost' matches no series", 'status must be', 'total must be', 'url must start', 'unknown keys']) {
    assert.ok(errors.includes(needle), needle);
  }
  assert.deepEqual(C.validate([{ t: 't', a: 'a', s: 'S' }], { S: { total: 'many', status: 'ongoing', note: 'n' } }).errors, []);
});

test('validation: warnings for lookalike series, leftover markup, odd numbers, untidy values (once each)', () => {
  const warnings = C.validate([
    { t: '1', a: 'a', s: 'Ember Coast' }, { t: '2', a: 'a', s: 'Ember Coast Series' },
    { t: '3', a: 'a', s: 'Foo (book 1), Bar' }, { t: '4', a: 'a', s: 'Odd', sn: '1, 1' },
  ], {}).warnings.join('\n');
  for (const needle of ['look like the same series', 'leftover Audible markup', 'unusual series number']) {
    assert.ok(warnings.includes(needle), needle);
  }
  const untidy = C.validate([
    { t: '1', a: 'A.B. Quill', n: 'R.T.  Hale' },
    { t: '2', a: 'A.B. Quill', s: 'Some  Series', g: ['Cozy  Mystery'] },
    { t: 'Double  Title', a: 'Ann Vale' },
  ], {}).warnings.join('\n');
  assert.equal(untidy.split("author 'A.B. Quill'").length - 1, 1);
  for (const needle of ["use 'A. B. Quill'", "narrator 'R.T.  Hale'", "use 'R. T. Hale'", "series 'Some  Series'",
                        "genre 'Cozy  Mystery'", "title 'Double  Title'"]) {
    assert.ok(untidy.includes(needle), needle);
  }
  assert.deepEqual(C.validate([{ t: 'Fine', a: 'A. B. Quill', n: 'R. T. Hale' }], {}).warnings, []);
});

test('dates read: full, month-only and year-only dates, in order', () => {
  const cases = {
    '2024-03-15': '2024-03-15', '2024/3/5': '2024-03-05', ' 2024-03 ': '2024-03', '2024': '2024',
    '2024-02-29': '2024-02-29', '2023-02-29': null, '2024-13': null, '2024-00-10': null, '15/03/2024': null, '': null,
  };
  for (const [raw, expected] of Object.entries(cases)) assert.equal(C.parseReadDate(raw), expected, raw);
  assert.deepEqual(C.parseReadDates('2025-01-02, 2021, 2025/1/2; nope'), { dates: ['2021', '2025-01-02'], bad: ['nope'] });
  assert.deepEqual(C.parseReadDates('  '), { dates: [], bad: [] });

  assert.deepEqual(C.validate([{ t: 'A', a: 'B', r: ['2021', '2024-03', '2025-01-02'] }], {}), { errors: [], warnings: [] });
  for (const r of [[], '2024-01-01', ['2024/01/01'], ['2023-02-29'], [2024]]) {
    assert.ok(C.validate([{ t: 'A', a: 'B', r }], {}).errors.some(e => e.includes("'r' must be")), JSON.stringify(r));
  }
  assert.ok(C.validate([{ t: 'A', a: 'B', r: ['2025-01-01', '2024-01-01'] }], {}).warnings.some(w => w.includes('not in order')));
});

test('dates read: a plain string becomes a list', () => {
  assert.deepEqual(C.fixReadDates({ t: 'A', a: 'B', r: '2024/3/15' }), { t: 'A', a: 'B', r: ['2024-03-15'] });
  assert.deepEqual(C.fixReadDates({ t: 'A', a: 'B', r: '2025, 2021-06' }).r, ['2021-06', '2025']);
  assert.deepEqual(C.fixReadDates({ t: 'A', a: 'B', r: '  ' }), { t: 'A', a: 'B' });
  assert.deepEqual(C.fixReadDates({ t: 'A', a: 'B', r: 'soon' }).r, ['soon']);   // left for validate() to report
  const listed = { t: 'A', a: 'B', r: ['2024'] };
  assert.equal(C.fixReadDates(listed), listed);
  assert.deepEqual(C.tidyBook({ t: 'A', a: 'B', r: '2024-03-15' }).r, ['2024-03-15']);
  assert.deepEqual(C.readBackup({ books: [{ t: 'A', a: 'B', r: '2024' }], seriesInfo: {} }).books[0].r, ['2024']);
  assert.deepEqual(C.readBackup([{ t: 'A', a: 'B', r: '2024' }]).books[0].r, ['2024']);
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
const GR_HEADER = 'Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves,Date Read\n';

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
    + '"Kept (Series, #2)",Ann,Nate Narrator,Audible Audio,read,"urban-fantasy, witches",2024/03/15\n'
    + 'Paperback,Bob,,Paperback,read,\n'
    + 'Unread audio,Cy,,Audiobook,to-read,\n'
    + 'Some Book,A.B.  Quill,R.T. Hale,Audiobook,read,\n');
  assert.deepEqual(result.records, [
    { t: 'Kept', a: 'Ann', n: 'Nate Narrator', s: 'Series', sn: '2', g: ['urban-fantasy', 'witches'], r: ['2024-03-15'] },
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

test('merge: dates read are filled in on books without any, never replaced', () => {
  const existing = [book('Dated', 'Author', { r: ['2020-01-01'] }), book('Undated')];
  const report = C.merge(existing, [book('Dated', 'Author', { r: ['2024-03-15'] }), book('Undated', 'Author', { r: ['2024-04-01'] })]);
  assert.deepEqual(existing.map(b => b.r), [['2020-01-01'], ['2024-04-01']]);
  assert.deepEqual([report.datesFilled.length, report.added.length], [1, 0]);
  assert.equal(C.merge(existing, [book('Undated', 'Author', { r: ['2025-01-01'] })]).datesFilled.length, 0);
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
