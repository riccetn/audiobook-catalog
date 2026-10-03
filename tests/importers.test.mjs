// Tests for importers.js: tidying, validation, the Audible and Goodreads readers and the merge.
// Run with:  make test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const C = createRequire(import.meta.url)('../importers.js');

const book = (t, a = 'Author', extra = {}) => ({ t, a, ...extra });
// A book's editions: ed({ id: 'B1' }, { gr: '7' }) -> { e: [{ id: 'B1' }, { gr: '7' }] }
const ed = (...editions) => ({ e: editions });

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
  const rec = { t: 'A  Title ', a: 'A.B. Quill', s: ' S ', sn: '1', g: ['Fantasy ', '  ', 'Cozy  Mystery'],
    ...ed({ id: ' B0X', n: 'A.B.  Vale', p: 'Gull  Audio', desc: ' UK   edition' }) };
  assert.deepEqual(C.tidyBook(rec), { t: 'A Title', a: 'A. B. Quill', s: 'S', sn: '1', g: ['Fantasy', 'Cozy Mystery'],
    ...ed({ id: 'B0X', n: 'A. B. Vale', p: 'Gull Audio', desc: 'UK edition' }) });
  assert.equal(rec.t, 'A  Title ', 'the input record is not modified');
});

test('exclusions accept ASINs and title | author pairs', () => {
  const ex = C.parseExclusions('# comment\nB012345678  # trailing note\nSome Title | Some Author\n\n');
  assert.ok(ex.covers({ t: 'x', a: 'y', ...ed({ gr: '1' }, { id: 'B012345678' }) }));
  assert.ok(ex.covers({ t: 'SOME title!', a: 'Some Author' }));
  assert.ok(!ex.covers({ t: 'Other', a: 'Some Author' }));
  assert.equal(C.parseExclusions('').size, 0);
});

test('exclusions list their entries, and a removed book gets entries that keep it out', () => {
  const ex = C.parseExclusions('# comment\nB012345678  # trailing note\nSome Title|Some Author\n');
  assert.deepEqual(ex.entries, ['B012345678', 'Some Title | Some Author']);
  // an entry already covered is not added twice, however it is spelled
  assert.equal(ex.add('B012345678'), null);
  assert.equal(ex.add('some title! | Some Author'), null);
  assert.equal(ex.add('  New   Title | Ann  # why '), 'New Title | Ann');
  assert.equal(ex.add('a\nb'), 'a b');     // never more than one line

  assert.deepEqual(C.exclusionEntries({ t: 'Gone', a: 'Ann Vale', ...ed({ id: 'B9' }) }), ['B9', 'Gone | Ann Vale']);
  const odd = { t: 'Book #2 | Part One', a: 'Ann Vale' };
  const [entry] = C.exclusionEntries(odd);
  assert.equal(entry, 'Book 2 Part One | Ann Vale');
  assert.ok(C.parseExclusions(entry).covers(odd));
});

test('validation: a clean catalogue passes; required fields, unknown keys, ids', () => {
  const clean = [{ t: 'A', a: 'B', s: 'S', sn: '1', g: ['x'], hcb: '77', ...ed({ id: 'B0', gr: '1', hc: '5', isbn: '9780000000002', p: 'P', d: '2021-05', len: 600 }) }];
  assert.deepEqual(C.validate(clean, { S: { total: 3, status: 'ongoing', note: 'n', url: 'https://example.com' } }), { errors: [], warnings: [] });
  assert.equal(C.validate([{ t: '', a: 'x' }, { t: 't', a: 'a', bogus: 1 }, 'nope'], {}).errors.length, 3);
  assert.ok(C.validate([{ t: 't', a: 'a', sn: '1' }], {}).errors.some(e => e.includes('no series')));
  // an old-style book-level id is an unknown key: fixBooks() turns it into an edition first
  assert.ok(C.validate([{ t: 't', a: 'a', id: 'B0' }], {}).errors.some(e => e.includes("unknown key 'id'")));
  assert.ok(C.validate([{ t: '1', a: 'a', ...ed({ id: 'B0' }) }, { t: '1', a: 'a', ...ed({ id: 'B0' }) }], {}).errors.some(e => e.includes('duplicate id')));
});

test('Goodreads ids: validated, excluded, and kept apart from ASINs', () => {
  assert.deepEqual(C.validate([{ t: 'A', a: 'B', ...ed({ gr: '4242' }) }], {}), { errors: [], warnings: [] });
  assert.ok(C.validate([{ t: 'A', a: 'B', ...ed({ gr: 'show/4242' }) }], {}).errors.some(e => e.includes('digits only')));
  assert.ok(C.validate([{ t: 'A', a: 'B', ...ed({ gr: 4242 }) }], {}).errors.some(e => e.includes("'gr' must be")));
  assert.ok(C.validate([{ t: '1', a: 'a', ...ed({ gr: '7' }) }, { t: '1', a: 'a', ...ed({ gr: '7' }) }], {}).errors.some(e => e.includes('duplicate Goodreads id 7')));

  assert.deepEqual(C.exclusionEntries({ t: 'Gone', a: 'Ann Vale', ...ed({ id: 'B9', gr: '4242' }, { id: 'B10' }) }), ['B9', 'B10', 'Goodreads 4242', 'Gone | Ann Vale']);
  const ex = C.parseExclusions('Goodreads 4242\ngr: 77  # the paperback\n');
  assert.deepEqual(ex.entries, ['Goodreads 4242', 'Goodreads 77']);
  assert.equal(ex.add('GOODREADS 4242'), null);
  assert.ok(ex.covers({ t: 'Renamed', a: 'Someone', ...ed({ gr: '77' }) }));
  assert.ok(!ex.covers({ t: 'Renamed', a: 'Someone', ...ed({ id: '77' }) }), 'a Goodreads id is not an ASIN');
  assert.ok(!C.parseExclusions('4242\n').covers({ t: 'x', a: 'y', ...ed({ gr: '4242' }) }), 'a bare number is an ASIN, not a Goodreads id');
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
    { t: '1', a: 'A.B. Quill', ...ed({ n: 'R.T.  Hale' }) },
    { t: '2', a: 'A.B. Quill', s: 'Some  Series', g: ['Cozy  Mystery'] },
    { t: 'Double  Title', a: 'Ann Vale' },
  ], {}).warnings.join('\n');
  assert.equal(untidy.split("author 'A.B. Quill'").length - 1, 1);
  for (const needle of ["use 'A. B. Quill'", "narrator 'R.T.  Hale'", "use 'R. T. Hale'", "series 'Some  Series'",
                        "genre 'Cozy  Mystery'", "title 'Double  Title'"]) {
    assert.ok(untidy.includes(needle), needle);
  }
  assert.deepEqual(C.validate([{ t: 'Fine', a: 'A. B. Quill', ...ed({ n: 'R. T. Hale' }) }], {}).warnings, []);
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
  assert.deepEqual(C.readBackup({ books: [], seriesInfo: {}, excluded: ['B9'] }).excluded, ['B9']);
  assert.equal(C.readBackup({ books: [], seriesInfo: {} }).excluded, null);
  assert.throws(() => C.readBackup({ books: [], excluded: 'B9' }), /excluded/);
  assert.throws(() => C.readBackup({ books: [], excluded: [7] }), /excluded/);
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
  assert.equal(C.cleanTitle('Ember: Books 1-3', '1-3'), 'Ember: Books 1-3', 'a box set keeps its range');
});

test('Audible rows', () => {
  const base = { Title: 'T', 'Title Short': 'Ts', Authors: 'A', Progress: 'Finished', ASIN: 'B0000000A1' };
  const row = kw => ({ ...base, ...kw });
  assert.deepEqual(C.audibleRowToRecord(row({ Series: 'S (book 2)', Narrators: 'N', Tags: 'Fantasy, Magic' })),
    [{ t: 'Ts', a: 'A', s: 'S', sn: '2', g: ['Fantasy', 'Magic'], ...ed({ id: 'B0000000A1', n: 'N' }) }, null]);
  const [tidy] = C.audibleRowToRecord(row({ Authors: 'A.B. Quill, Ann  Vale', Narrators: 'R.T.   Hale', Tags: 'Cozy  Mystery, Fantasy' }));
  assert.deepEqual([tidy.a, tidy.e[0].n, tidy.g], ['A. B. Quill, Ann Vale', 'R. T. Hale', ['Cozy Mystery', 'Fantasy']]);
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

test('Audible: a title holding its series is split when the Series column is empty', () => {
  const result = C.readAudible(HEADER + '"Second Wind: Fantasy Adventures, Book 2",,,,Ann,,,,Finished,B2,\n');
  assert.deepEqual(result.records, [{ t: 'Second Wind', a: 'Ann', s: 'Fantasy Adventures', sn: '2', ...ed({ id: 'B2' }) }]);
});

// -------------------------------------------------------- series from Audible
// Shaped like answers from Audible's catalogue API, with invented books.
const product = (...series) => ({ product: { asin: 'X', series: series.map(([title, sequence, asin]) => ({ title, sequence, asin })) } });

test('Audible catalogue answers: a book\'s series and a series\' released total', () => {
  assert.equal(C.audibleProductUrl('B0SAMPLE01', 'uk', 'series'),
    'https://api.audible.co.uk/1.0/catalog/products/B0SAMPLE01?response_groups=series');
  assert.deepEqual(C.audibleSeries(product(['The Lantern  Coast', '2', 'S1'], ['Odd', 'Book 3', 'S2'])), [
    { name: 'The Lantern Coast', number: '2', asin: 'S1' },
    { name: 'Odd', number: null, asin: 'S2' },
  ]);
  assert.deepEqual(C.audibleSeries({ product: {} }), []);
  assert.deepEqual(C.audibleSeries(null), []);
  const children = (...seqs) => ({ product: { relationships: seqs.map(sequence => ({ relationship_to_product: 'child', sequence })) } });
  assert.equal(C.audibleSeriesTotal(children('1', '2', '2.5', '1-3', '4')), 4);
  assert.equal(C.audibleSeriesTotal(children('1', '1-6')), 6);
  assert.equal(C.audibleSeriesTotal(children('', '0.5')), null);
  assert.equal(C.audibleSeriesTotal({ product: { relationships: [{ relationship_to_product: 'parent', sequence: '9' }] } }), null);
  assert.equal(C.audibleSeriesTotal(null), null);
});

test('series lookups: books missing a series or number, and one book per series without release info', () => {
  const books = [
    book('Loose', 'Ann', ed({ id: 'B1' })),
    book('Unnumbered', 'Ann', { s: 'Gull Isle', ...ed({ id: 'B2' }) }),
    book('Gull 2', 'Ann', { s: 'Gull Isle', sn: '2', ...ed({ id: 'B3' }) }),
    book('Known 1', 'Ann', { s: 'Known', sn: '1', ...ed({ id: 'B4' }) }),
    book('No ASIN', 'Ann', ed({ gr: '7' })),
  ];
  assert.deepEqual(C.seriesLookups(books, { Known: { total: 3, status: 'ongoing' } }), ['B1', 'B2']);
  assert.deepEqual(C.seriesLookups(books, {}), ['B1', 'B2', 'B4']);
});

test('series from Audible fill only what is empty, in the spelling in use', () => {
  const books = [
    book('Loose', 'Ann', ed({ id: 'B1' })),
    book('Unnumbered', 'Ann', { s: 'Gull Isle', ...ed({ id: 'B2' }) }),
    book('Other number', 'Ann', { s: 'Gull Isle', sn: '5', ...ed({ id: 'B3' }) }),
    book('Other series', 'Ann', { s: 'My Own Name', ...ed({ id: 'B4' }) }),
    book('Nested', 'Ann', ed({ id: 'B5' })),
  ];
  const found = new Map([
    ['B1', C.audibleSeries(product(['The Gull Isle Series', '1', 'SG']))],
    ['B2', C.audibleSeries(product(['Gull Isle', '3', 'SG']))],
    ['B3', C.audibleSeries(product(['Gull Isle', '4', 'SG']))],
    ['B4', C.audibleSeries(product(['Theirs', '2', 'ST']))],
    ['B5', C.audibleSeries(product(['Thornmere: Wardens', '1', 'SW'], ['Thornmere', '6', 'SM']))],
  ]);
  const report = C.seriesFromAudible(books, found);
  assert.deepEqual(books.map(b => [b.s, b.sn]), [
    ['Gull Isle', '1'], ['Gull Isle', '3'], ['Gull Isle', '5'], ['My Own Name', undefined], ['Thornmere', '6'],
  ]);
  assert.deepEqual(report.filled.map(b => b.t), ['Loose', 'Unnumbered', 'Nested']);
  assert.deepEqual([...report.series], [['Gull Isle', 'SG'], ['Thornmere', 'SM']]);
  assert.deepEqual(report.warnings, []);

  const twoSeries = [book('Torn', 'Ann', ed({ id: 'B6' }))];
  const warned = C.seriesFromAudible(twoSeries, new Map([['B6', C.audibleSeries(product(['Red', '1'], ['Blue', '2']))]]));
  assert.deepEqual([twoSeries[0].s, twoSeries[0].sn], ['Red', '1']);
  assert.match(warned.warnings[0], /several series/);
});

test('series from Audible: a box set\'s ASIN gives each title the series, not the set\'s number', () => {
  const books = [book('First', 'Ann', ed({ id: 'BOX' })), book('Second', 'Ann', ed({ id: 'BOX' }))];
  C.seriesFromAudible(books, new Map([['BOX', C.audibleSeries(product(['Gull Isle', '1-2', 'SG']))]]));
  assert.deepEqual(books.map(b => [b.s, b.sn]), [['Gull Isle', undefined], ['Gull Isle', undefined]]);
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
  for (const [raw, expected] of Object.entries(cases)) assert.deepEqual(C.parseGoodreadsTitle(raw), expected, raw);
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
  for (const [raw, expected] of Object.entries(cases)) assert.deepEqual(C.readGoodreadsTitle(raw), expected, raw);
  const result = C.readGoodreads(GR_HEADER + '4243,"The First Adventure: Fantasy Adventures, Book 1",Ann,,Audible Audio,read,\n');
  assert.deepEqual(result.records, [{ t: 'The First Adventure', a: 'Ann', s: 'Fantasy Adventures', sn: '1', ...ed({ gr: '4243' }) }]);
});

test('books imported with the series in the title are split on load, never changing a series', () => {
  const [plain, same, numbered, other, otherNumber, paren, nothing] = C.fixBooks([
    { t: 'The First Adventure: Fantasy Adventures, Book 1', a: 'Ann' },
    { t: 'The First Adventure: Fantasy Adventures, Book 1', a: 'Ann', s: 'The Fantasy Adventures Series' },
    { t: 'Second Wind: Fantasy Adventures, Book 2', a: 'Ann', s: 'Fantasy Adventures', sn: '2', r: ['2024'] },
    { t: 'Iron Gate: Wardens, Book 2', a: 'Ann', s: 'Thornmere', sn: '5' },
    { t: 'Second Wind: Fantasy Adventures, Book 2', a: 'Ann', s: 'Fantasy Adventures', sn: '7' },
    { t: 'Kept (Fantasy Adventures, #3)', a: 'Ann' },
    { t: 'Lantern (Unabridged)', a: 'Ann' },
  ]);
  assert.deepEqual(plain, { t: 'The First Adventure', a: 'Ann', s: 'Fantasy Adventures', sn: '1' });
  assert.deepEqual(same, { t: 'The First Adventure', a: 'Ann', s: 'The Fantasy Adventures Series', sn: '1' });
  assert.deepEqual(numbered, { t: 'Second Wind', a: 'Ann', s: 'Fantasy Adventures', sn: '2', r: ['2024'] });
  assert.deepEqual(other, { t: 'Iron Gate: Wardens, Book 2', a: 'Ann', s: 'Thornmere', sn: '5' });
  assert.deepEqual(otherNumber.t, 'Second Wind: Fantasy Adventures, Book 2');
  assert.deepEqual(paren, { t: 'Kept', a: 'Ann', s: 'Fantasy Adventures', sn: '3' });
  assert.deepEqual(nothing, { t: 'Lantern (Unabridged)', a: 'Ann' });
  // an exclusion written with the long title still keeps the book out
  assert.ok(C.parseExclusions('The First Adventure: Fantasy Adventures, Book 1 | Ann').covers(plain));
});

test('Goodreads export: only read audio editions, with tidy names', () => {
  const result = C.readGoodreads(GR_HEADER
    + '4242,"Kept (Series, #2)",Ann,Nate Narrator,Audible Audio,read,"urban-fantasy, witches",2024/03/15\n'
    + '11,Paperback,Bob,,Paperback,read,\n'
    + '12,Unread audio,Cy,,Audiobook,to-read,\n'
    + '"=""77""",Some Book,A.B.  Quill,R.T. Hale,Audiobook,read,\n'
    + ',No Id,Dee,,Audiobook,read,\n');
  assert.deepEqual(result.records, [
    { t: 'Kept', a: 'Ann', s: 'Series', sn: '2', g: ['urban-fantasy', 'witches'], ...ed({ gr: '4242', n: 'Nate Narrator' }), r: ['2024-03-15'] },
    { t: 'Some Book', a: 'A. B. Quill', ...ed({ gr: '77', n: 'R. T. Hale' }) },
    { t: 'No Id', a: 'Dee' },
  ]);
  assert.equal(result.skippedUnfinished, 1);
});

test('Goodreads CSV: every book on the read shelf, one own edition\'s ids, the latest full date read', () => {
  const box = { id: 'BBOX', isbn: '9781000000009' };
  const books = [
    book('Kept', 'Ann Vale and Bo Reed', { s: 'Saga, Told', sn: '2', g: ['Science Fiction', 'Witches'],
      ...ed({ id: 'B1', p: 'Pub', d: '2019-04-02' }, { gr: '4242', isbn: '9780306406157', d: '2020' }), r: ['2024-03-15', '2025-01', '2023-06-02'] }),
    book('Boxed One', 'Cy', { ...ed(box), r: ['2024'] }),
    book('Boxed Two', 'Cy', { ...ed(box, { gr: '9' }) }),
    book('Say "hi"', 'Dee'),
  ];
  const out = C.goodreadsCsv(books);
  assert.deepEqual([out.books, out.withoutIds, out.withoutDate], [4, 2, 3]);
  const rows = C.parseCsv(out.csv);
  assert.deepEqual(rows[0], { 'Book Id': '4242', Title: 'Kept (Saga, Told, #2)', Author: 'Ann Vale', 'Additional Authors': 'Bo Reed',
    ISBN: '0306406152', ISBN13: '9780306406157', Publisher: '', Binding: 'Audiobook', 'Year Published': '2020',
    'Date Read': '2024/03/15', Bookshelves: 'science-fiction, witches', 'Exclusive Shelf': 'read', 'Read Count': '3' });
  // a box set's edition is on several titles, so its ids would file them all as the box set
  assert.deepEqual([rows[1]['ISBN13'], rows[1]['Binding'], rows[1]['Date Read'], rows[1]['Read Count']], ['', 'Audiobook', '', '1']);
  assert.equal(rows[2]['Book Id'], '9');
  // a missing date read is unknown, not unread: the book still goes on the read shelf
  assert.deepEqual([rows[3].Title, rows[3]['Exclusive Shelf'], rows[3]['Date Read']], ['Say "hi"', 'read', '']);

  // Goodreads' own import format, so our Goodreads import reads it back
  const back = C.readGoodreads(out.csv).records;
  assert.deepEqual(back.map(b => [b.t, b.s, b.sn]), [['Kept', 'Saga, Told', '2'], ['Boxed One', undefined, undefined],
    ['Boxed Two', undefined, undefined], ['Say "hi"', undefined, undefined]]);
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
    { s: 'A Crown of Embers Series', sn: '5', g: ['Theirs'], ...ed({ id: 'B5' }) })]);
  assert.deepEqual(existing, [{ t: 'A Spark of Dawn', a: 'Ilse Marlowe', s: 'A Crown of Embers', sn: '5', g: ['Mine'], ...ed({ id: 'B5' }) }]);
  assert.equal(report.backfilled.length, 1);
});

test('merge: a Goodreads id matches a renamed book, and a missing one is filled in', () => {
  const existing = [book('Renamed By Hand', 'Author', ed({ gr: '4242' })), book('No Id Yet', 'Author', ed({ id: 'B77' }))];
  const report = C.merge(existing, [book('Goodreads Title', 'Author', ed({ gr: '4242' })), book('No Id Yet', 'Author', ed({ gr: '77' }))]);
  assert.deepEqual(existing.map(b => [b.t, b.e]), [['Renamed By Hand', [{ gr: '4242' }]], ['No Id Yet', [{ id: 'B77', gr: '77' }]]]);
  assert.deepEqual([report.added.length, report.goodreadsFilled.length, report.backfilled.length, report.editionsAdded.length], [0, 1, 0, 0]);
  assert.equal(C.merge(existing, [book('Renamed Again', 'Author', ed({ gr: '77' }))]).added.length, 0);
});

test('merge: dates read are filled in on books without any, never replaced', () => {
  const existing = [book('Dated', 'Author', { r: ['2020-01-01'] }), book('Undated')];
  const report = C.merge(existing, [book('Dated', 'Author', { r: ['2024-03-15'] }), book('Undated', 'Author', { r: ['2024-04-01'] })]);
  assert.deepEqual(existing.map(b => b.r), [['2020-01-01'], ['2024-04-01']]);
  assert.deepEqual([report.datesFilled.length, report.added.length], [1, 0]);
  assert.equal(C.merge(existing, [book('Undated', 'Author', { r: ['2025-01-01'] })]).datesFilled.length, 0);
});

test('merge: ids, long titles, boxed sets, series spelling, exclusions, authors', () => {
  let existing = [book('Completely Renamed', 'Author', ed({ id: 'B7' }))];
  assert.equal(C.merge(existing, [book('Original Title', 'Author', ed({ id: 'B7' }))]).added.length, 0);

  existing = [book('A Crown of Embers', 'Ilse Marlowe')];
  C.merge(existing, [book('A Crown of Embers, Book 1', 'Ilse Marlowe', ed({ id: 'B1' }))]);
  assert.deepEqual([existing.length, existing[0].e], [1, [{ id: 'B1' }]]);

  existing = [book('Lantern of the Deep', 'R.T. Hale')];
  assert.equal(C.merge(existing, [book('Lantern of the Deep: Books 1-3', 'R.T. Hale')]).added.length, 1);

  existing = [book('One', 'Author', { s: 'Ember Coast', sn: '1' })];
  C.merge(existing, [book('Two', 'Author', { s: 'Ember Coast Series', sn: '2' }), book('Three', 'Author', { s: 'ember-coast', sn: '3' })]);
  assert.deepEqual([...new Set(existing.map(b => b.s))], ['Ember Coast']);

  existing = [];
  const ex = C.parseExclusions('B9\nRemoved Box Set | Author\n');
  const report = C.merge(existing, [book('Gone', 'Author', ed({ id: 'B9' })), book('Removed Box Set'), book('Fine')], ex);
  assert.deepEqual(existing.map(b => b.t), ['Fine']);
  assert.equal(report.excluded.length, 2);

  existing = [book('Dark', 'Ann')];
  C.merge(existing, [book('Dark', 'Bob')]);
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
  for (const [raw, expected] of Object.entries(cases)) assert.equal(C.parseIsbn(raw), expected, raw);
  assert.deepEqual(C.parseIsbns(`${ISBN_A}, 0-306-40615-2; ${ISBN_A} nope`), { isbns: [ISBN_A, ISBN_BOX], bad: [`${ISBN_A} nope`] });
  assert.deepEqual(C.parseIsbns(`${ISBN_A} 0306406152`), { isbns: [ISBN_A, ISBN_BOX], bad: [] });
});

test('ISBNs: one per edition, so another ISBN becomes another edition, stored in the 13-digit form', () => {
  assert.deepEqual(C.splitIsbns({ id: 'B1', isbn: '978-0-00-000000-2, 0306406152' }), [{ id: 'B1', isbn: ISBN_A }, { isbn: ISBN_BOX }]);
  assert.deepEqual(C.splitIsbns({ id: 'B1', n: 'Ann Vale', isbn: [ISBN_A, '0-306-40615-2', ISBN_A] }), [{ id: 'B1', isbn: ISBN_A, n: 'Ann Vale' }, { isbn: ISBN_BOX }]);
  assert.deepEqual(C.splitIsbns({ id: 'B1', isbn: ' ' }), [{ id: 'B1' }]);
  assert.deepEqual(C.splitIsbns({ id: 'B1', isbn: 'soon' }), [{ id: 'B1', isbn: 'soon' }]);   // left for validate() to report
  // the lists of ISBNs from before one ISBN per edition are migrated on load; an ISBN another edition has is that edition
  assert.deepEqual(C.fixBooks([{ t: 'A', a: 'B', ...ed({ id: 'B1', isbn: [ISBN_A, ISBN_B] }, { gr: '7', isbn: [ISBN_B] }) }])[0].e,
    [{ id: 'B1', isbn: ISBN_A }, { gr: '7', isbn: ISBN_B }]);
  assert.deepEqual(C.fixBooks([{ t: 'A', a: 'B', ...ed({ isbn: '978-0-00-000000-2' }) }])[0].e, [{ isbn: ISBN_A }]);
  assert.deepEqual(C.tidyBook({ t: 'A', a: 'B', ...ed({ isbn: ['0-306-40615-2', ISBN_BOX, ' bad  one '] }) }).e, [{ isbn: ISBN_BOX }, { isbn: 'bad one' }]);
});

test('ISBNs: validation', () => {
  // several editions with an ISBN each, and the same ISBN on several books (a boxed set), are fine
  assert.deepEqual(C.validate([{ t: '1', a: 'A', ...ed({ isbn: ISBN_A }, { isbn: ISBN_BOX }) }, { t: '2', a: 'A', ...ed({ isbn: ISBN_BOX }) }], {}), { errors: [], warnings: [] });
  for (const isbn of [[ISBN_A], '', [], 9780000000002]) {
    assert.ok(C.validate([{ t: 'A', a: 'B', ...ed({ isbn }) }], {}).errors.some(e => e.includes("'isbn' must be one ISBN")), JSON.stringify(isbn));
  }
  assert.ok(C.validate([{ t: 'A', a: 'B', ...ed({ isbn: '9780000000003' }) }], {}).errors.some(e => e.includes('not a valid ISBN')));
  const { errors, warnings } = C.validate([{ t: 'A', a: 'B', ...ed({ isbn: '978-0-00-000000-2' }, { id: 'B1', isbn: ISBN_A }) }], {});
  assert.deepEqual(errors, []);
  assert.ok(warnings.some(w => w.includes(`as '${ISBN_A}'`)));
  assert.ok(warnings.some(w => w.includes(`lists ISBN ${ISBN_A} on two editions`)));
});

test('ISBNs are read from Audible and Goodreads exports', () => {
  const [rec] = C.audibleRowToRecord({ Title: 'T', Authors: 'A', Progress: 'Finished', ASIN: 'B1', ISBN10: '0306406152', ISBN13: ISBN_BOX });
  assert.deepEqual(rec.e, [{ id: 'B1', isbn: ISBN_BOX }]);
  const [two] = C.audibleRowToRecord({ Title: 'T', Authors: 'A', Progress: 'Finished', ASIN: 'B1', ISBN10: '0306406152', ISBN13: ISBN_A });
  assert.deepEqual(two.e, [{ id: 'B1', isbn: ISBN_BOX }, { isbn: ISBN_A }], 'two different ISBNs are two editions');
  assert.equal('e' in C.audibleRowToRecord({ Title: 'T', Authors: 'A', Progress: 'Finished', ISBN13: 'n/a' })[0], false);
  const result = C.readGoodreads('Title,Author,ISBN,ISBN13,Binding,Exclusive Shelf\n'
    + 'With,Ann,"=""0306406152""","=""9780306406157""",Audible Audio,read\n'
    + 'Without,Ann,"=""""","=""""",Audiobook,read\n');
  assert.deepEqual(result.records, [{ t: 'With', a: 'Ann', ...ed({ isbn: ISBN_BOX }) }, { t: 'Without', a: 'Ann' }]);
});

test('merge: ISBNs fill in the matching edition, another ISBN is another edition, and ISBNs never make two books one', () => {
  const existing = [book('One', 'Author', ed({ id: 'B1' })), book('Two')];
  const report = C.merge(existing, [book('One', 'Author', ed({ id: 'B1', isbn: ISBN_A })), book('Two', 'Author', ed({ isbn: ISBN_BOX }))]);
  assert.deepEqual(existing.map(b => b.e), [[{ id: 'B1', isbn: ISBN_A }], [{ isbn: ISBN_BOX }]]);
  assert.deepEqual([report.isbnsFilled.length, report.editionsAdded.length, report.added.length], [2, 0, 0]);
  const again = C.merge(existing, [book('One', 'Author', ed({ isbn: ISBN_B }))]);
  assert.deepEqual([again.isbnsFilled.length, again.editionsAdded.length], [0, 1]);
  assert.deepEqual(existing[0].e, [{ id: 'B1', isbn: ISBN_A }, { isbn: ISBN_B }]);

  // a boxed set's ISBN on each of its books: they stay separate books, and the set itself is a new book
  const boxed = [book('First', 'Author', ed({ isbn: ISBN_BOX }))];
  const added = C.merge(boxed, [book('Second', 'Author', ed({ isbn: ISBN_BOX })), book('The Boxed Set', 'Author', ed({ isbn: ISBN_BOX }))]).added;
  assert.deepEqual(added.map(b => b.t), ['Second', 'The Boxed Set']);
});

test('exclusions by ISBN', () => {
  const ex = C.parseExclusions(`ISBN 978-0-00-000000-2  # read the paperback\n${ISBN_BOX}\n0306406152\nB012345678\n`);
  assert.deepEqual(ex.entries, [`ISBN ${ISBN_A}`, `ISBN ${ISBN_BOX}`, '0306406152', 'B012345678']);
  assert.equal(ex.add('isbn: 0-00-000000-0'), null);   // the ISBN-10 of 978-0-00-000000-2
  assert.ok(ex.covers({ t: 'x', a: 'y', ...ed({ isbn: '9780000000002' }) }));
  assert.ok(ex.covers({ t: 'x', a: 'y', ...ed({ isbn: ISBN_B }, { isbn: ISBN_BOX }) }));
  assert.ok(ex.covers({ t: 'x', a: 'y', ...ed({ id: '0306406152' }) }));   // a bare ISBN-10 is also an ASIN
  assert.ok(!ex.covers({ t: 'x', a: 'y', ...ed({ isbn: ISBN_B }) }));

  const existing = [];
  const report = C.merge(existing, [book('Box Book 1', 'Author', ed({ isbn: ISBN_BOX })), book('Box Book 2', 'Author', ed({ isbn: ISBN_BOX })), book('Fine', 'Author', ed({ isbn: ISBN_B }))], ex);
  assert.deepEqual(existing.map(b => b.t), ['Fine']);
  assert.equal(report.excluded.length, 2);
});

test('missing books: gaps up to the released total, boxed sets fill their range, novellas do not', () => {
  const owned = ['1', '2.5', '4-6', '9', 'x'].map(sn => book('T' + sn, 'A', { s: 'Brass Meadow', sn }));
  assert.deepEqual(C.missingNumbers(owned, 8), [2, 3, 7, 8]);
  assert.deepEqual(C.missingNumbers(owned, 5), [2, 3]);
  assert.deepEqual(C.missingNumbers([book('One', 'A', { s: 'Brass Meadow', sn: '1-3' })], 3), []);
  assert.equal(C.missingNumbers(owned, 'many'), null);
  assert.equal(C.missingNumbers(owned, undefined), null);
});

// ---------------------------------------------------------------- editions
test('editions: a book from before editions gets its ids and ISBNs as its first edition', () => {
  const [old] = C.fixBooks([{ t: 'A', a: 'B', id: 'B1', gr: '7', isbn: '978-0-00-000000-2', r: ['2024'] }]);
  assert.deepEqual(old, { t: 'A', a: 'B', r: ['2024'], e: [{ id: 'B1', gr: '7', isbn: ISBN_A }] });
  // half migrated by hand: the old fields fill in the edition with the same ASIN, or come first
  assert.deepEqual(C.fixEditions({ t: 'A', a: 'B', gr: '7', e: [{ id: 'B2' }, { id: 'B1', isbn: ISBN_A }] }).e,
    [{ gr: '7' }, { id: 'B2' }, { id: 'B1', isbn: ISBN_A }]);
  assert.deepEqual(C.fixEditions({ t: 'A', a: 'B', id: 'B1', gr: '7', e: [{ id: 'B1', p: 'P' }] }).e, [{ id: 'B1', gr: '7', p: 'P' }]);
  assert.deepEqual(C.fixEditions({ t: 'A', a: 'B', e: [] }), { t: 'A', a: 'B' });
  const current = { t: 'A', a: 'B', e: [{ id: 'B1' }] };
  assert.deepEqual(C.fixEditions(current), current);
  assert.deepEqual(C.readBackup([{ t: 'A', a: 'B', id: 'B1' }]).books[0].e, [{ id: 'B1' }]);
});

test('editions: validation of fields, and of a box set edition shared by several titles', () => {
  const box = { id: 'BBOX', isbn: ISBN_BOX, p: 'Gull Audio', len: 1200 };
  const clean = [{ t: 'Two', a: 'A', s: 'S', sn: '2', e: [{ id: 'B2' }, box] }, { t: 'Three', a: 'A', s: 'S', sn: '3', e: [{ ...box }] }];
  assert.deepEqual(C.validate(clean, {}), { errors: [], warnings: [] });

  const errors = C.validate([
    { t: 'A', a: 'B', e: [] }, { t: 'C', a: 'B', e: [{}, { n: '' }] },
    { t: 'D', a: 'B', e: [{ id: 'B1', d: '15/03/2024', len: 12.5, extra: 1 }, 'nope'] },
    { t: 'E', a: 'B', e: [{ id: 'B9' }, { id: 'B9', p: 'x' }] },
  ], {}).errors.join('\n');
  for (const needle of ["'e' must be a non-empty list", 'edition #1: is empty', "edition #2: 'n' must be a non-empty string",
                        "'d' must be a release date", "'len' must be",
                        "unknown key 'extra'", 'edition #2: not an object', 'lists the edition with id B9 twice']) {
    assert.ok(errors.includes(needle), needle);
  }
  const { warnings } = C.validate([{ t: 'Two', a: 'A', e: [box] }, { t: 'Three', a: 'A', e: [{ ...box, p: 'Other  Audio' }] }], {});
  assert.ok(warnings.some(w => w.includes('the edition with id BBOX differs from its copy')));
  assert.ok(warnings.some(w => w.includes("publisher 'Other  Audio'")));
});

test('editions: length and release date are read from Audible, publisher and year from Goodreads', () => {
  const cases = { '11 hrs and 5 mins': 665, '11h 5m': 665, '45 min': 45, '10 hours': 600, '1 hr': 60, '11:05': 665, '0 min': null, 'soon': null, '': null };
  for (const [raw, expected] of Object.entries(cases)) assert.equal(C.parseLength(raw), expected, raw);
  assert.deepEqual([642, 600, 45].map(C.formatLength), ['10h 42m', '10h', '45m']);

  const [rec] = C.audibleRowToRecord({ Title: 'T', Authors: 'A', Progress: 'Finished', ASIN: 'B1',
    Publishers: 'Gull  Audio', 'Release Date': '2021-05-04', Length: '10 hrs and 42 mins' });
  assert.deepEqual(rec.e, [{ id: 'B1', p: 'Gull Audio', d: '2021-05-04', len: 642 }]);
  const result = C.readGoodreads('Book Id,Title,Author,Binding,Exclusive Shelf,Publisher,Year Published,Original Publication Year\n'
    + '4242,T,A,Audible Audio,read,Gull Audio,2021,1999\n');
  assert.deepEqual(result.records[0].e, [{ gr: '4242', p: 'Gull Audio', d: '2021' }]);
});

test('merge: an edition fills in its match, a lone edition, or is added as another edition', () => {
  // Goodreads finds the book Audible added: its only edition gains the Goodreads id and publisher
  const existing = [book('One', 'Author', ed({ id: 'B1', p: 'Mine' }))];
  let report = C.merge(existing, [book('One', 'Author', ed({ gr: '7', p: 'Theirs', d: '2021' }))]);
  assert.deepEqual(existing[0].e, [{ id: 'B1', gr: '7', p: 'Mine', d: '2021' }]);
  assert.deepEqual([report.goodreadsFilled.length, report.detailsFilled.length, report.editionsAdded.length], [1, 1, 0]);

  // another ASIN is another edition; later imports fill in the one they share an ISBN with
  report = C.merge(existing, [book('One', 'Author', ed({ id: 'B1UK', isbn: ISBN_B }))]);
  assert.deepEqual(existing[0].e, [{ id: 'B1', gr: '7', p: 'Mine', d: '2021' }, { id: 'B1UK', isbn: ISBN_B }]);
  assert.equal(report.editionsAdded.length, 1);
  report = C.merge(existing, [book('One', 'Author', ed({ gr: '8', isbn: ISBN_B }))]);
  assert.deepEqual(existing[0].e[1], { id: 'B1UK', gr: '8', isbn: ISBN_B });
  assert.equal(C.merge(existing, [book('Renamed', 'Author', ed({ gr: '8' }))]).added.length, 0, 'any edition finds the book');
  assert.equal(C.merge(existing, structuredClone([book('One', 'Author', ed({ gr: '8', isbn: ISBN_B }))])).editionsAdded.length, 0);
});

test('merge: a box set edition on several titles matches them, and is filled in on every copy', () => {
  const box = () => ({ id: 'BBOX' });
  const existing = [book('Two', 'Author', { s: 'S', sn: '2', ...ed(box()) }), book('Three', 'Author', { s: 'S', sn: '3', ...ed(box()) })];
  const report = C.merge(existing, [book('S: Books 2-3', 'Author', { s: 'S', sn: '2-3', ...ed({ id: 'BBOX', p: 'Gull Audio' }) })]);
  assert.deepEqual([report.added.length, report.matched], [0, 1]);
  const filled = { id: 'BBOX', p: 'Gull Audio', desc: 'S: Books 2-3' };
  assert.deepEqual(existing.map(b => b.e), [[filled], [filled]]);
  assert.notEqual(existing[0].e[0], existing[1].e[0], 'copies, not one shared object');

  // a book whose only edition is the box set gets its own edition rather than filling in the box set
  C.merge(existing, [book('Three', 'Author', ed({ gr: '33' }))]);
  assert.deepEqual(existing[1].e, [filled, { gr: '33' }]);
  assert.deepEqual(existing[0].e, [filled]);
});

test('merge: a box set becomes its titles, each with the same edition', () => {
  const existing = [
    book('Spark', 'Ann Vale', { s: 'Ember', sn: '1', ...ed({ id: 'B1', n: 'Tobias Frane' }) }),
    book('Flame', 'Ann Vale', { s: 'Ember', sn: '2', r: ['2023'] }),
    book('Other', 'Ann Vale', { s: 'Gull Isle', sn: '3' }),
  ];
  const box = book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember Series', sn: '1-3', g: ['Fantasy'], r: ['2024-05-01'], ...ed({ id: 'BBOX', n: 'Hollis Marr' }) });
  const report = C.merge(existing, [box]);
  const set = { id: 'BBOX', n: 'Hollis Marr', desc: 'Ember: Books 1-3' };
  assert.deepEqual(existing.map(b => [b.t, b.sn, b.e, b.r]), [
    ['Spark', '1', [{ id: 'B1', n: 'Tobias Frane' }, set], ['2024-05-01']],
    ['Flame', '2', [set], ['2023']],
    ['Other', '3', undefined, undefined],
    ['Ember, Book 3', '3', [set], ['2024-05-01']],
  ]);
  assert.deepEqual(existing[3], { t: 'Ember, Book 3', a: 'Ann Vale', s: 'Ember', sn: '3', g: ['Fantasy'], r: ['2024-05-01'], e: [set] });
  assert.deepEqual([report.added.map(b => b.t), report.editionsAdded.map(b => b.t), report.datesFilled.map(b => b.t), report.matched],
    [['Ember, Book 3'], ['Spark', 'Flame'], ['Spark'], 1]);
  assert.deepEqual(report.boxSets, [{ t: 'Ember: Books 1-3', a: 'Ann Vale', titles: 2, added: 1 }]);
  assert.deepEqual(C.validate(existing, {}), { errors: [], warnings: [] });

  // the same set again changes nothing; Goodreads' copy of it fills in the edition on every title
  assert.deepEqual(C.merge(existing, [structuredClone(box)]).added, []);
  const gr = C.merge(existing, [book('The Ember Trilogy', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ gr: '99' }) })]);
  assert.deepEqual(gr.added, []);
  assert.deepEqual([0, 1, 3].map(i => existing[i].e.at(-1)), Array(3).fill({ ...set, gr: '99' }));
  assert.equal(existing[0].e.length, 2, 'the title\'s own edition is left alone');

  // a single title imported later finds the title the set added
  assert.equal(C.merge(existing, [book('Ember Falls', 'Ann Vale', { s: 'Ember', sn: '3', ...ed({ id: 'B3' }) })]).added.length, 0);
  assert.deepEqual(existing[3].e, [{ ...set, gr: '99' }, { id: 'B3' }]);
});

test('merge: box sets already in the catalogue as one book, without ids, or excluded stay as they are', () => {
  const whole = [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ id: 'BBOX' }) })];
  C.merge(whole, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ id: 'BBOX', p: 'Gull Audio' }) })]);
  assert.deepEqual(whole, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ id: 'BBOX', p: 'Gull Audio' }) })]);

  const none = [];
  C.merge(none, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ n: 'Hollis Marr' }) })]);
  assert.deepEqual(none.map(b => b.sn), ['1-3'], 'nothing would tie the titles together');

  const kept = [];
  const report = C.merge(kept, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ id: 'BBOX' }) })], C.parseExclusions('BBOX\n'));
  assert.deepEqual([kept, report.excluded.length], [[], 3]);
});

test('series from Audible: a box set\'s titles still named "Series, Book N" get the listing\'s titles', () => {
  const set = { id: 'BBOX' };
  const books = [book('Spark', 'Ann', { s: 'Ember', sn: '1', ...ed(set) }), book('Ember, Book 2', 'Ann', { s: 'Ember', sn: '2', ...ed(set) }),
    book('Ember, Book 3', 'Ann', { s: 'Ember', sn: '3', ...ed(set) }), book('Gull Isle, Book 1', 'Ann', { s: 'Gull Isle', sn: '1' })];
  const info = { Ember: { total: 3, status: 'complete' } };
  assert.deepEqual(C.seriesLookups(books, info), ['BBOX'], 'looked up although the series has release info');
  const listing = C.audibleSeriesListing({ product: { relationships: [
    { relationship_to_product: 'child', sequence: '1-3', title: 'Ember: Books 1-3' },
    { relationship_to_product: 'child', sequence: '2', title: ' Flame ' }, { relationship_to_product: 'child', sequence: '2', title: 'Flame (Dramatized)' },
    { relationship_to_product: 'child', sequence: '3', title: 'Ember Falls: Ember, Book 3' }, { relationship_to_product: 'parent', sequence: '4', title: 'No' },
  ] } });
  assert.deepEqual(listing, { total: 3, titles: { 2: 'Flame', 3: 'Ember Falls: Ember, Book 3' } });
  const series = new Map([['Ember', 'SER']]);
  assert.deepEqual(C.seriesListingLookups(books, info, series), ['SER']);
  assert.deepEqual(C.seriesListingLookups(books.slice(0, 1), info, series), [], 'nothing to name, release info known');
  const renamed = C.boxSetTitlesFromAudible(books, series, new Map([['SER', listing]]));
  assert.deepEqual(renamed.map(([b, old]) => [old, b.t]), [['Ember, Book 2', 'Flame'], ['Ember, Book 3', 'Ember Falls']]);
  assert.deepEqual(books.map(b => b.t), ['Spark', 'Flame', 'Ember Falls', 'Gull Isle, Book 1']);
  assert.deepEqual(C.addSeriesTotals({}, series, new Map([['SER', listing]]), 'us', '2026-10-03'), ['Ember']);
});

test('Audible and Goodreads exports: a box set is read with its range', () => {
  const audible = C.readAudible('Title,Title Short,Authors,Series,Book Numbers,Progress,ASIN\n' +
    '"Ember: Books 1-3","Ember: Books 1-3",Ann Vale,"Ember (books 1-3)",1-3,Finished,BBOX\n');
  assert.deepEqual(audible.records, [book('Ember: Books 1-3', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ id: 'BBOX' }) })]);
  const goodreads = C.readGoodreads(GR_HEADER + '99,"The Ember Trilogy (Ember, #1-3)",Ann Vale,,Audible Audio,read,,2024/05/01\n');
  assert.deepEqual(goodreads.records, [book('The Ember Trilogy', 'Ann Vale', { s: 'Ember', sn: '1-3', ...ed({ gr: '99' }), r: ['2024-05-01'] })]);
});

test('editions as text: formatted for the card and read back from the form', () => {
  const edition = { id: 'B0X', gr: '4242', isbn: ISBN_A, n: 'Ann Vale', p: 'Gull Audio', d: '2021-05', len: 642, desc: 'UK edition' };
  const line = C.formatEdition(edition);
  assert.equal(line, `UK edition; Narrated by Ann Vale; ASIN B0X; Goodreads 4242; ISBN ${ISBN_A}; Publisher Gull Audio; Released 2021-05; Length 10h 42m`);
  assert.deepEqual(C.parseEditions(line), { editions: [edition], bad: [], hcb: null });
  // text without a label is the description, once per edition; anything else unreadable is reported;
  // a second ISBN is another edition
  assert.deepEqual(C.parseEditions(`asin: B1; isbn 978-0-00-000000-2, 0306406152; Dramatized adaptation\n\n${ISBN_B}; 2020; 45 min; narrator R. T. Hale\n`
    + 'Audio CD; Goodreads x; second description\nDescription: First edition'), {
    editions: [{ id: 'B1', isbn: ISBN_A, desc: 'Dramatized adaptation' }, { isbn: ISBN_BOX }, { isbn: ISBN_B, n: 'R. T. Hale', d: '2020', len: 45 },
      { desc: 'Audio CD' }, { desc: 'First edition' }],
    bad: ['Goodreads x', 'second description'], hcb: null,
  });
});

test('saving a book keeps the copies of a shared edition in step', () => {
  const books = [
    book('Two', 'A', ed({ id: 'BBOX', p: 'Gull Audio' }, { id: 'B2' })),
    book('Three', 'A', ed({ id: 'BBOX', p: 'Gull Audio' })),
    book('Other', 'A', ed({ id: 'B9', isbn: [ISBN_BOX] })),
  ];
  // editing the box set on one title edits it on the other; an edition sharing only an ISBN is left alone
  assert.equal(C.saveBook(books, 0, book('Two', 'A', ed({ id: 'BBOX', p: 'Kestrel Audio', isbn: [ISBN_BOX] }, { id: 'B2' }))), 1);
  assert.deepEqual(books.map(b => b.e[0]), [{ id: 'BBOX', p: 'Kestrel Audio', isbn: [ISBN_BOX] }, { id: 'BBOX', p: 'Kestrel Audio', isbn: [ISBN_BOX] }, { id: 'B9', isbn: [ISBN_BOX] }]);
  // a new title typed with the box set's ASIN is linked to it and gets its details
  const four = book('Four', 'A', ed({ id: 'BBOX', len: 900 }));
  assert.equal(C.saveBook(books, null, four), 2);
  assert.deepEqual(books[3].e, [{ id: 'BBOX', isbn: [ISBN_BOX], p: 'Kestrel Audio', len: 900 }]);
  assert.deepEqual(books[1].e, books[3].e);
  // removing the edition from one title leaves the others
  assert.equal(C.saveBook(books, 3, book('Four', 'A')), 0);
  assert.equal(books[1].e[0].id, 'BBOX');
});

// ------------------------------------------------------------------ duplicates
test('findDuplicates pairs books an import would match, but not a box set\'s titles', () => {
  const books = [
    book('The Salt Road', 'Marisol Quenby', { s: 'Lantern Coast', sn: '1', ...ed({ id: 'B1' }) }),
    book('Beacons', 'Marisol Quenby', { s: 'Lantern Coast', sn: '2', ...ed({ id: 'BBOX' }) }),
    book('The Drowned Chart', 'Marisol Quenby', { s: 'Lantern Coast', sn: '3', ...ed({ id: 'BBOX' }) }),
    book('Salt Road', 'Marisol Quenby', { s: 'The Lantern Coast Series', sn: '1', ...ed({ gr: '4242' }) }),
    book('Lantern Coast 2: Beacons', 'Marisol Quenby, Tobias Frane'),
    book('Beacons', 'Someone Else'),
    book('Lantern Coast, Books 1-3', 'Marisol Quenby', { s: 'Lantern Coast', sn: '1-3' }),
  ];
  // same series and number; Audible's long title for "Beacons"; different authors and the boxed set stay apart
  assert.deepEqual(C.findDuplicates(books), [[0, 3], [1, 4]]);
  // a pair marked as different books is not offered again, whichever way round
  const notSame = new Set([C.duplicatePairKey(books[4], books[1])]);
  assert.deepEqual(C.findDuplicates(books, notSame), [[0, 3]]);
  assert.deepEqual(C.findDuplicates([]), []);
});

test('mergeBooks keeps the picked fields and combines genres, dates read and editions', () => {
  const a = book('Salt Road', 'Marisol Quenby', { s: 'Lantern Coast', sn: '1', g: ['Fantasy'], r: ['2025-11-20'],
    ...ed({ gr: '4242', p: 'Gullwing Audio' }, { isbn: ISBN_BOX }) });
  const b = book('The Salt Road', 'Marisol Quenby', { s: 'The Lantern Coast', sn: '1',
    g: ['Fantasy', 'Adventure'], r: ['2023-06-02', '2025-11-20'], hcb: '77', ...ed({ id: 'B1', gr: '4242', n: 'Tobias Frane', len: 642 }, { id: 'B2' }) });
  // by default the first entry that has a value wins; the narrator only b's edition has
  assert.deepEqual(C.mergeBooks([a, b]), {
    t: 'Salt Road', a: 'Marisol Quenby', s: 'Lantern Coast', sn: '1', g: ['Fantasy', 'Adventure'],
    r: ['2023-06-02', '2025-11-20'], hcb: '77',
    e: [{ id: 'B1', gr: '4242', n: 'Tobias Frane', p: 'Gullwing Audio', len: 642 }, { isbn: ISBN_BOX }, { id: 'B2' }],
  });
  const picked = C.mergeBooks([a, b], { t: 1, series: 1 });
  assert.equal(picked.t, 'The Salt Road');
  assert.equal(picked.s, 'The Lantern Coast');
  // the inputs are left alone
  assert.deepEqual(a.e, [{ gr: '4242', p: 'Gullwing Audio' }, { isbn: ISBN_BOX }]);
  assert.deepEqual(C.validate([picked], {}).errors, []);
});

test('editions that do not disagree on an ASIN, Goodreads id or ISBN can be joined, on merge or later', () => {
  const audible = book('Salt Road', 'Marisol Quenby', ed({ id: 'B1', len: 642 }));
  const goodreads = book('Salt Road', 'Marisol Quenby', ed({ gr: '4242', isbn: ISBN_B, p: 'Gull Audio', len: 600 }));
  assert.equal(C.editionsJoinable([{ id: 'B1' }, { gr: '4242' }]), true);
  assert.equal(C.editionsJoinable([{ id: 'B1' }, { id: 'B2' }]), false);
  assert.equal(C.editionsJoinable([{ id: 'B1', isbn: ISBN_A }, { gr: '4242', isbn: ISBN_B }]), false, 'another ISBN is another edition');
  assert.equal(C.editionsJoinable([{ id: 'B1' }]), false);
  // the first edition's values win
  assert.deepEqual(C.mergeBooks([audible, goodreads], { joinEditions: true }).e,
    [{ id: 'B1', gr: '4242', isbn: ISBN_B, p: 'Gull Audio', len: 642 }]);
  assert.equal(C.mergeBooks([audible, goodreads]).e.length, 2);
  assert.equal(audible.e[0].gr, undefined);              // the inputs are left alone

  const books = [
    book('Two Editions', 'A', ed({ id: 'B1' }, { gr: '7' })),
    book('Two Asins', 'A', ed({ id: 'B2' }, { id: 'B3' })),
    book('Box One', 'A', ed({ id: 'BBOX' }, { gr: '8' })),
    book('Box Two', 'A', ed({ id: 'BBOX' })),
    book('One', 'A', ed({ id: 'B4' })),
  ];
  assert.deepEqual(C.splitEditions(books), [0]);
  assert.deepEqual(C.splitEditions(books, new Set([C.editionsKey(books[0])])), []);
  assert.equal(C.editionsKey(book('x', 'y', ed({ gr: '7' }, { id: 'B1' }))), C.editionsKey(books[0]));
});

test('narrators: a narrator on the book moves onto its editions', () => {
  assert.deepEqual(C.fixEditions({ t: 'A', a: 'B', n: 'Ann Vale', e: [{ id: 'B1' }, { id: 'B2', n: 'R. T. Hale' }] }),
    { t: 'A', a: 'B', e: [{ id: 'B1', n: 'Ann Vale' }, { id: 'B2', n: 'R. T. Hale' }] });
  assert.deepEqual(C.fixEditions({ t: 'A', a: 'B', n: 'Ann Vale' }), { t: 'A', a: 'B', e: [{ n: 'Ann Vale' }] });
  assert.deepEqual(C.fixEditions({ t: 'A', a: 'B', n: ' ' }), { t: 'A', a: 'B' });
  // from before editions: ids and narrator make one edition
  assert.deepEqual(C.fixBooks([{ t: 'A', a: 'B', n: 'Ann Vale', id: 'B1' }])[0].e, [{ id: 'B1', n: 'Ann Vale' }]);
  assert.deepEqual(C.validate(C.fixBooks([{ t: 'A', a: 'B', n: 'Ann Vale', id: 'B1' }]), {}), { errors: [], warnings: [] });
  assert.ok(C.validate([{ t: 'A', a: 'B', n: 'Ann Vale' }], {}).errors.some(e => e.includes("unknown key 'n'")));

  assert.deepEqual(C.bookNarrators(book('A', 'B', ed({ n: 'Ann Vale' }, { n: 'R. T. Hale' }, { n: 'Ann Vale' }, { id: 'B3' }))), ['Ann Vale', 'R. T. Hale']);
  // an import's narrator never replaces the one you have
  const existing = [book('One', 'Author', ed({ id: 'B1', n: 'Mine' }))];
  C.merge(existing, [book('One', 'Author', ed({ gr: '7', n: 'A guess' }))]);
  assert.deepEqual(existing[0].e, [{ id: 'B1', gr: '7', n: 'Mine' }]);
});

test('backups carry the "Not duplicates" marks, and not-duplicates.txt lists them one per line', () => {
  const marks = ['["a","b","",""] ["c","b","",""]'];
  assert.deepEqual(C.readBackup({ books: [], notDuplicates: marks }).notDuplicates, marks);
  assert.equal(C.readBackup({ books: [] }).notDuplicates, null);
  assert.equal(C.readBackup([]).notDuplicates, null);
  assert.throws(() => C.readBackup({ books: [], notDuplicates: [1] }), /notDuplicates is not a list of strings/);
  assert.deepEqual(C.parseNotDuplicates('# header\n\n' + marks[0] + '\r\n  ' + marks[0] + '  \n["editions","id B1"]'),
    [marks[0], '["editions","id B1"]']);
  assert.deepEqual(C.parseNotDuplicates(''), []);
});

// ------------------------------------------------------------ merge a backup
test('merging a backup from another device keeps what each side added, edited and removed', () => {
  const mine = [
    book('Both Read', 'Ann Vale', { r: ['2024-01-02'], g: ['Mystery'], ...ed({ id: 'B1' }) }),
    book('Only Here', 'Ann Vale'),
    book('Removed There', 'Ann Vale', ed({ id: 'BGONE' })),
    book('Same Both', 'Ann Vale', ed({ n: 'Ivo Brandt' })),
  ];
  const before = JSON.stringify(mine);
  const backup = {
    books: [
      book('Both Read', 'Ann Vale', { r: ['2025-06-01'], g: ['Cozy'], ...ed({ id: 'B1', n: 'Dana Whitlock' }) }),
      book('Only There', 'Ann Vale', { s: 'Tide Saga', sn: '2' }),
      book('Removed Here', 'Ann Vale'),
      book('Same Both', 'Ann Vale', ed({ n: 'Ivo Brandt' })),
    ],
    seriesInfo: { 'Tide Saga': { total: '3', status: 'ongoing' } },
    excluded: ['BGONE', 'Removed There | Ann Vale'],
  };
  const exclusions = C.parseExclusions('Removed Here | Ann Vale\n');
  const m = C.mergeBackup(mine, {}, exclusions, backup);
  assert.deepEqual(m.books, [
    { t: 'Both Read', a: 'Ann Vale', g: ['Mystery', 'Cozy'], r: ['2024-01-02', '2025-06-01'], e: [{ id: 'B1', n: 'Dana Whitlock' }] },
    book('Only Here', 'Ann Vale'),
    book('Same Both', 'Ann Vale', ed({ n: 'Ivo Brandt' })),
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
  assert.equal(JSON.stringify(mine), before, 'the catalogue it was given is unchanged');
  assert.equal(exclusions.size, 1);
  assert.deepEqual(m.notDuplicates, [], 'a backup without marks adds none');
});

test('merging a backup adds the backup\'s "Not duplicates" marks to ours', () => {
  const marks = ['["editions","id B1"]', '["editions","id B2"]'];
  const backup = { books: [], seriesInfo: {}, excluded: [], notDuplicates: [marks[1], marks[0], marks[1]] };
  const ours = new Set([marks[0]]);
  assert.deepEqual(C.mergeBackup([], {}, null, backup, 'mine', ours).notDuplicates, [marks[1]]);
  assert.deepEqual([...ours], [marks[0]], 'our marks are unchanged');
  assert.deepEqual(C.mergeBackup([], {}, null, backup).notDuplicates, [marks[1], marks[0]]);
});

test('merging a backup: where both changed a title or series info, ours wins unless the backup is preferred', () => {
  const mine = [book('Lantern Road', 'Ann Vale', { s: 'Tide Saga', sn: '1', ...ed({ id: 'B1' }) })];
  const theirs = book('The Lantern Road', 'Ann Vale', { s: 'Tide Saga', sn: '1', ...ed({ id: 'B1' }) });
  const info = { 'Tide Saga': { total: '3', status: 'ongoing' } };
  const backup = { books: [theirs], seriesInfo: { 'Tide Saga': { total: '4', status: 'complete' } }, excluded: [] };

  const keep = C.mergeBackup(mine, info, null, backup);
  assert.equal(keep.books[0].t, 'Lantern Road');
  assert.deepEqual(keep.updated, []);
  assert.equal(keep.conflicts.length, 1);
  assert.deepEqual(keep.seriesInfo, info);
  assert.deepEqual(keep.infoKept, ['Tide Saga']);

  const take = C.mergeBackup(mine, info, null, backup, 'backup');
  assert.equal(take.books[0].t, 'The Lantern Road');
  assert.deepEqual(take.updated.map(b => b.t), ['The Lantern Road']);
  assert.deepEqual(take.seriesInfo, backup.seriesInfo);
  assert.deepEqual(take.infoChanged, ['Tide Saga']);
});

test('merging a backup: a book the backup still has is not removed, and the same catalogue merges to itself', () => {
  const mine = [book('Back Again', 'Ann Vale', { r: ['2025-01-01', '2023-05-05'] })];
  // removed on the other device, then added there again
  const backup = { books: [book('Back Again', 'Ann Vale')], seriesInfo: {}, excluded: ['Back Again | Ann Vale'] };
  const m = C.mergeBackup(mine, {}, null, backup);
  assert.deepEqual(m.books, mine);
  assert.deepEqual(m.removed, []);
  // dates read in another order are not a change
  const same = C.mergeBackup(mine, {}, null, { books: [book('Back Again', 'Ann Vale', { r: ['2023-05-05', '2025-01-01'] })] });
  assert.deepEqual([same.added, same.updated, same.removed, same.conflicts], [[], [], [], []]);
});

test('merging a backup: the titles of a box set, which share an edition, each find their own book', () => {
  const box = { id: 'BBOX', n: 'Dana Whitlock' };
  const mine = [book('First Tide', 'Ann Vale', { s: 'Tide Saga', sn: '1', ...ed(box) }),
    book('Second Tide', 'Ann Vale', { s: 'Tide Saga', sn: '2', ...ed(box) })];
  const backup = { books: [book('Second Tide', 'Ann Vale', { s: 'Tide Saga', sn: '2', r: ['2025-02-02'], ...ed(box) }),
    book('First Tide', 'Ann Vale', { s: 'Tide Saga', sn: '1', ...ed(box) })] };
  const m = C.mergeBackup(mine, {}, null, backup);
  assert.deepEqual(m.conflicts, []);
  assert.deepEqual(m.books.map(b => [b.t, b.r]), [['First Tide', undefined], ['Second Tide', ['2025-02-02']]]);
});

// ------------------------------------------------------------------ Hardcover
test('Hardcover ids: an edition id names an edition, the book id is the book\'s', () => {
  assert.ok(C.sameEdition({ hc: '501' }, { hc: '501', id: 'B1' }));
  assert.ok(!C.sameEdition({ hc: '501', id: 'B1' }, { hc: '502', id: 'B1' }), 'different Hardcover editions conflict');
  // an incoming record finds the book by its Hardcover edition, or by the same Hardcover book
  const books = [book('Tidewater', 'Ann Vale', { hcb: '77', ...ed({ id: 'B1', hc: '501' }) })];
  const report = C.merge(books, [book('Tidewater (Unabridged)', 'Ann Vale', { hcb: '77', ...ed({ hc: '502', n: 'Hollis Marr' }) })]);
  assert.equal(report.matched, 1);
  assert.deepEqual(books[0], { t: 'Tidewater', a: 'Ann Vale', hcb: '77', e: [{ id: 'B1', hc: '501' }, { hc: '502', n: 'Hollis Marr' }] });
  // a book found by an edition gains the Hardcover book id it lacked, before its editions
  const fen = [book('Fen', 'Ann Vale', { r: ['2024'], ...ed({ id: 'B2' }) })];
  assert.equal(C.merge(fen, [book('Fen', 'Ann Vale', { hcb: '78', ...ed({ id: 'B2', hc: '601' }) })]).hardcoverFilled.length, 1);
  assert.deepEqual(Object.keys(fen[0]), ['t', 'a', 'r', 'hcb', 'e']);
  assert.deepEqual(fen[0].e, [{ id: 'B2', hc: '601' }]);
  assert.deepEqual(C.findDuplicates([book('One', 'Ann Vale', { hcb: '77' }), book('Two', 'Ann Vale', { hcb: '77' })]), []);
});

test('Hardcover book ids move from the editions to the book on load', () => {
  // the book's own Hardcover book before a box set's, whose edition (and so its id) is on each of its titles
  const books = C.fixBooks([
    book('One', 'Ann Vale', ed({ id: 'BBOX', hc: '700', hcb: '70' }, { id: 'B1', hc: '711', hcb: '71' })),
    book('Two', 'Ann Vale', ed({ id: 'BBOX', hc: '700', hcb: '70' })),
    book('Three', 'Ann Vale', { hcb: '73', ...ed({ id: 'B3', hcb: '99' }) }),
    book('Four', 'Ann Vale', ed({ hcb: '74' })),
  ]);
  assert.deepEqual(books, [
    { t: 'One', a: 'Ann Vale', hcb: '71', e: [{ id: 'BBOX', hc: '700' }, { id: 'B1', hc: '711' }] },
    { t: 'Two', a: 'Ann Vale', hcb: '70', e: [{ id: 'BBOX', hc: '700' }] },
    { t: 'Three', a: 'Ann Vale', hcb: '73', e: [{ id: 'B3' }] },
    { t: 'Four', a: 'Ann Vale', hcb: '74' },
  ]);
  assert.deepEqual(C.validate(books, {}), { errors: [], warnings: [] });
  assert.match(C.validate([book('A', 'B', ed({ id: 'B1', hcb: '7' }))], {}).errors.join('\n'), /unknown key 'hcb'/);
  assert.match(C.validate([book('A', 'B', { hcb: 'x7' })], {}).errors.join('\n'), /'hcb' must be a Hardcover book id/);
});

test('Hardcover ids round-trip through the edit form, are validated and exclude books', () => {
  const line = C.formatEdition({ id: 'B0X', hc: '501' });
  assert.equal(line, 'ASIN B0X; Hardcover 501');
  assert.deepEqual(C.parseEditions(line + '\nhardcover id: 9').editions, [{ id: 'B0X', hc: '501' }, { hc: '9' }]);
  // the Hardcover book, as editions used to show it, is the book's
  assert.deepEqual(C.parseEditions(line + '; Hardcover book 77'), { editions: [{ id: 'B0X', hc: '501' }], bad: [], hcb: '77' });
  assert.deepEqual(C.parseEditions('Hardcover abc').bad, ['Hardcover abc']);
  const { errors } = C.validate([book('Tidewater', 'Ann Vale', ed({ hc: 'x1' }))], {});
  assert.match(errors.join('\n'), /'hc' must be a Hardcover id/);
  assert.match(C.validate([book('A', 'Ann Vale', ed({ hc: '5' })), book('A', 'Ann Vale', ed({ hc: '5' }))], {}).errors.join('\n'), /duplicate Hardcover id 5/);
  assert.deepEqual(C.exclusionEntries(book('Gone', 'Ann Vale', { hcb: '77', ...ed({ hc: '501' }) })), ['Hardcover 501', 'Gone | Ann Vale']);
  const ex = C.parseExclusions('Hardcover 501\n');
  assert.deepEqual(ex.entries, ['Hardcover 501']);
  const report = C.merge([], [book('Gone Again', 'Ann Vale', ed({ hc: '501' }))], ex);
  assert.equal(report.excluded.length, 1);
});

test('merge: allDates adds the reads a book lacks, addable keeps some records from being added', () => {
  const books = [book('Tidewater', 'Ann Vale', { r: ['2023-04', '2024-01-02'] })];
  const incoming = [book('Tidewater', 'Ann Vale', { r: ['2023-04-09', '2025-06-30'] }), book('Paper Only', 'Ann Vale')];
  const report = C.merge(books, incoming, null, { allDates: true, addable: rec => rec !== incoming[1] });
  assert.deepEqual(books.map(b => b.r), [['2023-04', '2024-01-02', '2025-06-30']], '2023-04-09 is in 2023-04');
  assert.deepEqual(report.datesFilled, [books[0]]);
  assert.deepEqual(report.notAdded.map(b => b.t), ['Paper Only']);
  // without allDates, a book that has dates keeps them
  const plain = [book('Tidewater', 'Ann Vale', { r: ['2023-04'] })];
  C.merge(plain, [book('Tidewater', 'Ann Vale', { r: ['2025-06-30'] })]);
  assert.deepEqual(plain[0].r, ['2023-04']);
});

// Hardcover answers, as its API gives them (invented books)
const HC_BOOKS = new Map([
  [77, { id: 77, title: 'Tidewater', contributions: [{ contribution: null, author: { name: 'Ann  Vale' } }, { contribution: 'Illustrator', author: { name: 'P. Dray' } }],
    featured_book_series: { position: 2, series: { name: 'Gull Isle' } } }],
  [78, { id: 78, title: 'The Paper Fen', contributions: [{ contribution: 'Author', author: { name: 'R.T. Hale' } }], featured_book_series: null }],
  [79, { id: 79, title: 'Someday Maybe', contributions: [{ contribution: null, author: { name: 'Ann Vale' } }] }],
]);
const HC_EDITIONS = new Map([
  [501, { id: 501, book_id: 77, asin: 'B0TIDEWAT1', isbn_13: '9780000000002', isbn_10: null, release_date: '2021-05-04', audio_seconds: 38520,
    reading_format_id: 2, publisher: { name: 'Gullwing Audio' }, contributions: [{ contribution: 'Narrator', author: { name: 'Hollis Marr' } }] }],
  [601, { id: 601, book_id: 78, asin: null, isbn_13: null, reading_format_id: 1, contributions: [] }],
]);
const HC_SHELF = [
  { id: 1, book_id: 77, edition_id: 501, status_id: 3, user_book_reads: [{ finished_at: '2024-03-15' }, { finished_at: null }, { finished_at: '2022-01-09' }] },
  { id: 2, book_id: 78, edition_id: 601, status_id: 3, user_book_reads: [] },
  { id: 3, book_id: 79, edition_id: null, status_id: 1, user_book_reads: [] },
];

test('readHardcover: the Read shelf as books, with every finished date and the Hardcover ids', () => {
  const result = C.readHardcover(HC_SHELF, HC_BOOKS, HC_EDITIONS);
  assert.equal(result.otherShelves, 1);
  assert.deepEqual(result.records, [
    { t: 'Tidewater', a: 'Ann Vale', s: 'Gull Isle', sn: '2', r: ['2022-01-09', '2024-03-15'], hcb: '77',
      e: [{ id: 'B0TIDEWAT1', hc: '501', isbn: '9780000000002', n: 'Hollis Marr', p: 'Gullwing Audio', d: '2021-05-04', len: 642 }] },
    { t: 'The Paper Fen', a: 'R. T. Hale', hcb: '78', e: [{ hc: '601' }] },
  ]);
  assert.deepEqual([...result.audio].map(r => r.t), ['Tidewater'], 'only the audiobook edition may be added');
  assert.deepEqual(C.readHardcover([{ id: 9, book_id: 99, status_id: 3 }], HC_BOOKS, HC_EDITIONS).warnings, ['Hardcover book 99: not found, skipped']);
});

test('hardcoverFindQuery asks only for the ids there are, and hardcoverMatches reads the answer', () => {
  assert.equal(C.hardcoverFindQuery({ hc: [], asin: [], isbn: [], gr: [] }), null);
  const q = C.hardcoverFindQuery({ hc: [], asin: ['B0TIDEWAT1'], isbn: [], gr: ['4242'] });
  assert.deepEqual(q.variables, { asin: ['B0TIDEWAT1'], gr: ['4242'] });
  assert.match(q.query, /^query Find\(\$asin: \[String!\], \$gr: \[String!\]\)/);
  assert.match(q.query, /byAsin: editions\(where: \{asin: \{_in: \$asin\}\}\)/);
  assert.doesNotMatch(q.query, /byIsbn|byId/);
  const found = C.hardcoverMatches({
    byAsin: [{ id: 501, book_id: 77, asin: 'B0TIDEWAT1', reading_format_id: 2 }],
    byIsbn: [{ id: 601, book_id: 78, isbn_13: '9780000000019', reading_format_id: 1 }],
    byGoodreads: [{ book_id: 79, external_id: '4242' }],
  });
  assert.deepEqual(found.asin.get('B0TIDEWAT1'), { hc: '501', hcb: '77' });
  assert.deepEqual(found.isbn.get('9780000000019'), { hc: null, hcb: '78' }, 'a print edition only names the book');
  assert.deepEqual(found.gr.get('4242'), { hc: null, hcb: '79' });
});

test('addHardcoverIds fills in the ids found (box set copies alike), never changing one you have', () => {
  const books = [
    book('Tidewater', 'Ann Vale', ed({ id: 'B0TIDEWAT1' })),
    book('Box One', 'Ann Vale', ed({ id: 'B0BOXSET01' })), book('Box Two', 'Ann Vale', ed({ id: 'B0BOXSET01' })),
    book('Fen', 'Ann Vale', ed({ gr: '4242' })),
    book('Kept', 'Ann Vale', { hcb: '8', ...ed({ id: 'B0KEPT0001', hc: '9' }) }),
    book('Own First', 'Ann Vale', ed({ id: 'B0BOXSET01' }, { id: 'B0OWN00001', hc: '711' })),
    book('Nowhere', 'Ann Vale'),
  ];
  assert.deepEqual(C.hardcoverLookups(books), { hc: [711], asin: ['B0TIDEWAT1', 'B0BOXSET01', 'B0OWN00001'], isbn: [], gr: ['4242'] });
  const found = { hc: new Map([['711', { hc: '711', hcb: '71' }]]), isbn: new Map(),
    asin: new Map([['B0TIDEWAT1', { hc: '501', hcb: '77' }], ['B0BOXSET01', { hc: '700', hcb: '70' }], ['B0KEPT0001', { hc: '1', hcb: '2' }]]),
    gr: new Map([['4242', { hc: null, hcb: '79' }]]) };
  const filled = C.addHardcoverIds(books, found);
  assert.deepEqual(filled.map(b => b.t), ['Tidewater', 'Box One', 'Box Two', 'Fen', 'Own First']);
  assert.deepEqual(books.map(b => [b.hcb, b.e && b.e[0]]), [
    ['77', { id: 'B0TIDEWAT1', hc: '501' }], ['70', { id: 'B0BOXSET01', hc: '700' }], ['70', { id: 'B0BOXSET01', hc: '700' }],
    ['79', { gr: '4242' }], ['8', { id: 'B0KEPT0001', hc: '9' }],
    ['71', { id: 'B0BOXSET01', hc: '700' }],   // its own edition's Hardcover book, not the box set's
    [undefined, undefined],
  ]);
  assert.deepEqual(Object.keys(books[0]), ['t', 'a', 'hcb', 'e']);
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
  const plan = C.planHardcoverExport(books, shelf);
  assert.deepEqual(plan.add.map(a => [a.book, a.edition, a.dates, a.recs.map(r => r.t)]), [
    [78, null, [], ['Fen']],                             // no date read: on the Read shelf without one
    [70, 700, ['2023-02-01'], ['Box One', 'Box Two']],   // a box set is one Hardcover book
    [71, 711, [], ['Single Two']],                       // a title's own edition before the box set's
    [72, null, [], ['Single Three']],                    // the box set's edition is not an edition of book 72
  ]);
  assert.deepEqual(plan.reads, [{ userBook: 1, edition: 501, dates: ['2022-01-09'], recs: [books[0]] }]);
  assert.deepEqual(plan.otherShelf.map(([r, s]) => [r.t, s]), [['Wanted', 'Want to Read']]);
  assert.deepEqual(plan.unknown.map(r => r.t), ['Nowhere']);
  assert.deepEqual(plan.inexact.map(([r, d]) => [r.t, d]), [['Tidewater', '2025']]);
  assert.equal(C.hardcoverUrl('edition', '501'), 'https://hardcover.app/id/edition/501');

  // told which Hardcover book each edition is of, only an edition of the book's own is sent
  const lone = [book('Lone', 'Ann Vale', { hcb: '72', ...ed({ hc: '700' }) }), book('Mixed', 'Ann Vale', { hcb: '73', ...ed({ hc: '700' }, { hc: '731' }) })];
  assert.deepEqual(C.hardcoverExportEditions(lone), [700, 731]);
  const editionBooks = new Map([['700', '70'], ['731', '73']]);
  assert.deepEqual(C.planHardcoverExport(lone, [], editionBooks).add.map(a => [a.book, a.edition]), [[72, null], [73, 731]]);
  assert.deepEqual(C.planHardcoverExport(lone.slice(0, 1), []).add.map(a => [a.book, a.edition]), [[72, 700]], 'without it, a lone box set edition is taken as the book\'s');
});

test('merge: another Hardcover book found by a box set\'s edition is the box set, and its reads go to every title', () => {
  const box = () => ({ id: 'BBOX', hc: '700' });
  const books = [book('One', 'Ann Vale', { hcb: '71', r: ['2024'], ...ed(box()) }), book('Two', 'Ann Vale', { hcb: '72', ...ed(box()) }),
    book('Three', 'Ann Vale', { hcb: '73', ...ed({ id: 'B3' }) })];
  const report = C.merge(books, [book('One and Two', 'Ann Vale', { hcb: '70', r: ['2025-02-02'], ...ed(box()) })], null, { allDates: true });
  assert.deepEqual(books.map(b => [b.hcb, b.r]), [['71', ['2024', '2025-02-02']], ['72', ['2025-02-02']], ['73', undefined]]);
  assert.equal(report.datesFilled.length, 2);
  // the title's own Hardcover book, found by the same edition, reads only that title
  C.merge(books, [book('One', 'Ann Vale', { hcb: '71', r: ['2026-01-01'], ...ed(box()) })], null, { allDates: true });
  assert.deepEqual(books.map(b => b.r && b.r.at(-1)), ['2026-01-01', '2025-02-02', undefined]);
});
