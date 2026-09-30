// The catalogue's data pipeline: tidying and identity of book records, validation, the Audible and
// Goodreads readers, and the merge that adds imported books without clobbering hand edits.
//
// Shared by the page (index.html loads it as a plain script, defining the global CatalogImport) and
// the command line (catalog.js require()s it), so both import exactly the same way.
const CatalogImport = (() => {

// ------------------------------------------------------------------ book records
const BOOK_KEYS = ['t', 'a', 'n', 's', 'sn', 'g', 'id', 'r'];
const STATUSES = ['ongoing', 'complete'];
const SERIES_NUMBER = /^\d+(\.\d+)?(-\d+(\.\d+)?)?$/;
// JavaScript's \b is ASCII-only, so "é" would count as a word boundary; this is the Unicode "no word char before".
const WORD_START = '(?<![\\p{L}\\p{N}_])';

/**
 * A date a book was read, as stored in `r`: "2024-03-15", or just "2024-03" / "2024" when that is all
 * you remember. Also accepts Goodreads' "2024/03/15" and single-digit months/days. Returns the
 * canonical form, or null when it is not a real date.
 */
function parseReadDate(text){
  const m = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/.exec(tidyText(String(text || '')));
  if(!m) return null;
  const [, y, mo, d] = m;
  if(mo === undefined) return y;
  const month = Number(mo);
  if(month < 1 || month > 12) return null;
  const pad = n => String(n).padStart(2, '0');
  if(d === undefined) return `${y}-${pad(month)}`;
  const day = Number(d);
  const daysInMonth = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
  if(day < 1 || day > daysInMonth) return null;
  return `${y}-${pad(month)}-${pad(day)}`;
}

/** Parse a comma separated list of read dates. Returns {dates (sorted, no repeats), bad (unparseable)}. */
function parseReadDates(text){
  const dates = new Set(), bad = [];
  for(const part of String(text || '').split(/[,;]/).map(x => x.trim()).filter(Boolean)){
    const date = parseReadDate(part);
    if(date) dates.add(date); else bad.push(part);
  }
  return {dates: [...dates].sort(), bad};
}

/**
 * Return a book with its dates read as a list. Hand-edited data may hold a single date as a plain
 * string ("r": "2024-03-15", or "2023, 2024-03"); that becomes ["2024-03-15"]. An empty string drops
 * the field; anything that still is not a list of dates is left for validate() to report.
 */
function fixReadDates(rec){
  if(!rec || typeof rec !== 'object' || typeof rec.r !== 'string') return rec;
  const {r, ...rest} = rec;
  if(!r.trim()) return rest;
  const {dates, bad} = parseReadDates(r);
  return {...rest, r: bad.length ? [tidyText(r)] : dates};
}

/** fixReadDates() on every book of a list; anything that is not a list is returned as is. */
function fixBooks(books){
  return Array.isArray(books) ? books.map(fixReadDates) : books;
}

function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Lower-case and collapse everything that is not a letter or digit. */
function norm(text){
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Key under which two series names count as the same series ('Ember Coast' == 'The Ember-Coast series'). */
function seriesNorm(name){
  let n = norm(name);
  n = n.replace(/^the\s+/, '');
  n = n.replace(/\bseries\b/g, '');
  return n.replace(/[^a-z0-9]/g, '');
}

const RUN_TOGETHER_INITIALS = new RegExp(WORD_START + '([A-Z])\\.(?=[A-Z]\\.)', 'gu');
const INVISIBLE = /[\u200b\ufeff]/g;
const WHITESPACE = /[\s\x1c-\x1f]+/g;   // \s plus the ASCII separator controls

/** Trim and collapse whitespace: tabs, newlines, non-breaking spaces and runs of spaces become one space. */
function tidyText(text){
  return text.replace(INVISIBLE, '').replace(WHITESPACE, ' ').trim();
}

/** Tidy a person's name and space out run-together initials: "A.B.  Quill" -> "A. B. Quill". */
function normalizeName(name){
  return tidyText(name).replace(RUN_TOGETHER_INITIALS, '$1. ');
}

/** Return a copy of a book record with tidy text in every field. */
function tidyBook(rec){
  const out = {...fixReadDates(rec)};
  for(const key of ['t', 's', 'sn', 'id']){
    if(typeof out[key] === 'string') out[key] = tidyText(out[key]);
  }
  for(const key of ['a', 'n']){
    if(typeof out[key] === 'string') out[key] = normalizeName(out[key]);
  }
  if(Array.isArray(out.g)){
    out.g = out.g.map(x => typeof x === 'string' ? tidyText(x) : x).filter(x => x !== '');
  }
  if(Array.isArray(out.r)){
    out.r = out.r.map(x => typeof x === 'string' ? tidyText(x) : x);
  }
  return out;
}

function firstAuthor(authors){
  return norm((authors || '').split(/,| and | & /)[0]);
}

// Keys are JSON-encoded arrays so they work as Map and Set keys.
const key = (...parts) => JSON.stringify(parts);

/** Identity keys for a book, strongest first. The series key survives title edits. */
function bookKeys(rec){
  const keys = [];
  if(rec.id) keys.push(key('id', rec.id));
  if(rec.s && rec.sn) keys.push(key('series', firstAuthor(rec.a), seriesNorm(rec.s), String(rec.sn).trim()));
  keys.push(key('title', norm(rec.t), firstAuthor(rec.a)));
  return keys;
}

const TRAILING_BOOK_N = new RegExp(',?\\s*' + WORD_START + 'book\\s*\\d+\\s*$', 'iu');

/**
 * Keys used to *find* an incoming record among existing books, with forgiving title variants:
 * "A Crown of Embers 5: A Spark of Dawn" -> "A Spark of Dawn", "X, Book 1" -> "X". One-directional
 * (long incoming vs short existing) so a boxed set is never mistaken for its first book.
 */
function lookupKeys(rec){
  const keys = bookKeys(rec);
  const author = firstAuthor(rec.a);
  const title = rec.t;
  const variants = [];
  if(title.includes(':')) variants.push(title.slice(title.lastIndexOf(':') + 1));
  const stripped = title.replace(TRAILING_BOOK_N, '');
  if(stripped !== title) variants.push(stripped);
  for(const v of variants){
    const k = key('title', norm(v), author);
    if(norm(v) && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/** Books that imports must never re-add (because you removed them on purpose). */
class Exclusions {
  constructor(ids, titles){
    this.ids = new Set(ids || []);
    this.titles = new Set((titles || []).map(([t, a]) => key(t, a)));   // [norm(title), firstAuthor(author)]
  }
  covers(rec){
    return this.ids.has(rec.id) || this.titles.has(key(norm(rec.t), firstAuthor(rec.a)));
  }
  get size(){ return this.ids.size + this.titles.size; }
}

/** Parse the text of data/excluded.txt: an ASIN, or "Title | Author", per line; '#' starts a comment. */
function parseExclusions(text){
  const ex = new Exclusions();
  for(let line of (text || '').split(/\r\n|\r|\n/)){
    line = line.split('#')[0].trim();
    if(!line) continue;
    const bar = line.indexOf('|');
    if(bar >= 0){
      ex.titles.add(key(norm(line.slice(0, bar).trim()), firstAuthor(line.slice(bar + 1).trim())));
    } else {
      ex.ids.add(line);
    }
  }
  return ex;
}

// Quote a value for a message, Python-repr style: 'Title', or "It's" when it contains a quote.
function repr(v){
  if(Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']';
  if(typeof v !== 'string') return String(v);
  const q = v.includes("'") && !v.includes('"') ? '"' : "'";
  const body = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
}

/** Return {errors, warnings}. Errors block imports; warnings are worth a look. */
function validate(books, info){
  const errors = [], warnings = [];
  if(!Array.isArray(books)) return {errors: ['books.json must contain a list'], warnings};
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

  const seenIds = new Map();
  books.forEach((b, i) => {
    const label = isObj(b) ? `book #${i} (${repr(b.t === undefined ? '?' : b.t)})` : `book #${i}`;
    if(!isObj(b)){ errors.push(`${label}: not an object`); return; }
    for(const k of Object.keys(b)){
      if(!BOOK_KEYS.includes(k)) errors.push(`${label}: unknown key ${repr(k)}`);
    }
    for(const k of ['t', 'a']){
      if(!nonEmpty(b[k])) errors.push(`${label}: missing ${repr(k)}`);
    }
    for(const k of ['n', 's', 'sn', 'id']){
      if(k in b && !nonEmpty(b[k])) errors.push(`${label}: ${repr(k)} must be a non-empty string when present`);
    }
    if('g' in b && !(Array.isArray(b.g) && b.g.every(nonEmpty))){
      errors.push(`${label}: 'g' must be a list of non-empty strings`);
    }
    if('r' in b){
      if(!(Array.isArray(b.r) && b.r.length && b.r.every(d => typeof d === 'string' && parseReadDate(d) === d))){
        errors.push(`${label}: 'r' must be a non-empty list of dates read (YYYY-MM-DD, YYYY-MM or YYYY)`);
      } else if(b.r.some((d, j) => j > 0 && b.r[j - 1] >= d)){
        warnings.push(`${label}: dates read ${repr(b.r)} are not in order (or repeat one)`);
      }
    }
    if(b.sn && !b.s) errors.push(`${label}: has a series number but no series`);
    if(b.sn && typeof b.sn === 'string' && !SERIES_NUMBER.test(b.sn.trim())){
      warnings.push(`${label}: unusual series number ${repr(b.sn)}`);
    }
    if(b.id){
      if(seenIds.has(b.id)) errors.push(`${label}: duplicate id ${b.id} (also ${seenIds.get(b.id)})`);
      seenIds.set(b.id, label);
    }
  });

  const seriesNames = new Set(books.filter(b => isObj(b) && b.s).map(b => b.s));

  const untidy = new Map();
  const labels = {t: 'title', a: 'author', n: 'narrator', s: 'series', g: 'genre'};
  for(const b of books){
    if(!isObj(b)) continue;
    for(const [k, label] of Object.entries(labels)){
      const values = Array.isArray(b[k]) ? b[k] : [b[k]];
      for(const value of values){
        if(typeof value !== 'string') continue;
        const expected = (k === 'a' || k === 'n') ? normalizeName(value) : tidyText(value);
        if(expected !== value) untidy.set(key(label, value), [label, value, expected]);
      }
    }
  }
  const byText = (x, y) => x < y ? -1 : x > y ? 1 : 0;
  for(const [label, value, expected] of [...untidy.values()].sort((x, y) => byText(x[0], y[0]) || byText(x[1], y[1]))){
    warnings.push(`${label} ${repr(value)} has stray spacing or run-together initials; use ${repr(expected)}`);
  }

  const sortedSeries = [...seriesNames].sort();
  for(const name of sortedSeries){
    if(new RegExp('\\(' + 'books?' + '(?![\\p{L}\\p{N}_])', 'iu').test(name)){
      warnings.push(`series name ${repr(name)} looks like leftover Audible markup (several series joined together?)`);
    }
  }

  const byNorm = new Map();
  for(const name of seriesNames){
    const k = seriesNorm(name);
    if(!byNorm.has(k)) byNorm.set(k, new Set());
    byNorm.get(k).add(name);
  }
  for(const variants of byNorm.values()){
    if(variants.size > 1) warnings.push('series names that look like the same series: ' + [...variants].sort().join(' / '));
  }

  for(const [name, entry] of Object.entries(info || {})){
    if(!seriesNames.has(name)) errors.push(`series-info: ${repr(name)} matches no series in books.json`);
    if(!isObj(entry)){ errors.push(`series-info[${repr(name)}]: not an object`); continue; }
    if(!STATUSES.includes(entry.status)) errors.push(`series-info[${repr(name)}]: status must be one of ${repr(STATUSES.slice().sort())}`);
    const total = entry.total;
    if(!(Number.isInteger(total) && total > 0) && total !== 'many'){
      errors.push(`series-info[${repr(name)}]: total must be a positive integer (or "many")`);
    }
    if('url' in entry && !(typeof entry.url === 'string' && /^https?:\/\//.test(entry.url))){
      errors.push(`series-info[${repr(name)}]: url must start with http:// or https://`);
    }
    const unknown = Object.keys(entry).filter(k => !['total', 'status', 'note', 'url'].includes(k)).sort();
    if(unknown.length) errors.push(`series-info[${repr(name)}]: unknown keys ${repr(unknown)}`);
  }
  return {errors, warnings};
}

// ---------------------------------------------------------------------- backups
/**
 * Read a backup exported from the page: {books: [...], seriesInfo: {...}}, or a plain array of
 * books from before series info was exported. Returns {books, seriesInfo}, where seriesInfo is
 * null for the old format (so callers leave their series info alone). Throws if it is neither.
 */
function readBackup(data){
  if(Array.isArray(data)) return {books: fixBooks(data), seriesInfo: null};
  if(data && typeof data === 'object' && Array.isArray(data.books)){
    const info = data.seriesInfo;
    if(info === undefined) return {books: fixBooks(data.books), seriesInfo: null};
    if(info && typeof info === 'object' && !Array.isArray(info)) return {books: fixBooks(data.books), seriesInfo: info};
    throw new Error('seriesInfo is not an object');
  }
  throw new Error('expected a list of books or {books, seriesInfo}');
}

// ------------------------------------------------------------------------ CSV
/**
 * Parse CSV text (RFC 4180: quoted fields, doubled quotes, newlines inside quotes) into objects
 * keyed by the header row: a leading BOM is dropped, blank lines are
 * skipped, and missing trailing fields are undefined.
 */
function parseCsv(text){
  text = String(text || '').replace(/^\ufeff/, '');
  const rows = [];
  let row = [], field = '', quoted = false, atStart = true, i = 0;
  const endField = () => { row.push(field); field = ''; atStart = true; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while(i < text.length){
    const c = text[i];
    if(quoted){
      if(c === '"'){
        if(text[i + 1] === '"'){ field += '"'; i += 2; continue; }
        quoted = false; atStart = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if(c === '"' && atStart){ quoted = true; atStart = false; i++; }
    else if(c === ','){ endField(); i++; }
    else if(c === '\r'){ endRow(); i += text[i + 1] === '\n' ? 2 : 1; }
    else if(c === '\n'){ endRow(); i++; }
    else { field += c; atStart = false; i++; }
  }
  if(!atStart || row.length) endRow();

  const nonBlank = rows.filter(r => !(r.length === 1 && r[0] === ''));
  if(!nonBlank.length) return [];
  const [header, ...body] = nonBlank;
  return body.map(r => {
    const obj = {};
    header.forEach((name, j) => { obj[name] = r[j]; });
    return obj;
  });
}

const cell = (row, name) => (row[name] || '').trim();

// -------------------------------------------------------------------- Audible
// Audible's built-in "Your First Listen" sample appears in every library.
const SAMPLE_ASINS = new Set(['B002V8N37Q']);

// "Thornmere: Wardens (book 3), Thornmere (book 5)": anchor on the "(book N)" markers,
// because series names themselves can contain commas ("Vera Stone, Ghost Hunter").
const SERIES_PART = /\s*(.+?)\s*\(books?\s*([^)]*)\)\s*(?:,|$)/iy;

/** "S (book 2), T (books 1-4)" -> [["S", "2"], ["T", "1-4"]]; a missing number is null. */
function parseSeriesField(raw){
  raw = (raw || '').trim();
  const pairs = [];
  let pos = 0;
  while(pos < raw.length){
    SERIES_PART.lastIndex = pos;
    const m = SERIES_PART.exec(raw);
    if(!m) break;
    pairs.push([m[1].trim(), m[2].trim() || null]);
    pos = SERIES_PART.lastIndex;
  }
  const rest = raw.slice(pos).replace(/^[ ,]+|[ ,]+$/g, '');
  if(rest) pairs.push([rest, null]);
  return pairs;
}

/**
 * Pick one series when Audible lists several. Returns [name, number, wasAmbiguous]. A parent
 * series wins over its sub-series ("Thornmere" over "Thornmere: Wardens"); otherwise the first
 * listed wins and the book is flagged for review.
 */
function chooseSeries(pairs){
  if(!pairs.length) return [null, null, false];
  if(pairs.length === 1) return [pairs[0][0], pairs[0][1], false];
  const names = pairs.map(([name]) => name);
  for(const [name, number] of pairs){
    if(names.every(other => other === name || other.startsWith(name + ':'))) return [name, number, false];
  }
  return [pairs[0][0], pairs[0][1], true];
}

/** Drop a trailing series number that Audible bakes into short titles ("Lantern of the Deep 10"). */
function cleanTitle(title, number){
  title = title.trim();
  if(number){
    const stripped = title.replace(new RegExp('[\\s:,\\-]+' + escapeRegExp(number.trim()) + '\\s*$'), '');
    if(stripped) return stripped;
  }
  return title;
}

/** Convert one Audible CSV row. Returns [record or null, warning or null]. */
function audibleRowToRecord(row){
  if(cell(row, 'Progress') !== 'Finished') return [null, null];
  const asin = cell(row, 'ASIN');
  if(SAMPLE_ASINS.has(asin)) return [null, null];

  let [series, number, ambiguous] = chooseSeries(parseSeriesField(row.Series));
  if(series && number === null){
    number = (row['Book Numbers'] || '').split(',')[0].trim() || null;
  }

  const title = (row['Title Short'] || row.Title || '').trim();
  let rec = {t: cleanTitle(title, series ? number : null), a: cell(row, 'Authors')};
  const narrator = cell(row, 'Narrators');
  if(narrator) rec.n = narrator;
  if(series){
    rec.s = series;
    if(number) rec.sn = number;
  }
  let tags = (row.Tags || '').split(',').map(t => t.trim()).filter(Boolean);
  if(!tags.length && cell(row, 'Child Category')) tags = [cell(row, 'Child Category')];
  if(tags.length) rec.g = tags;
  if(asin) rec.id = asin;
  rec = tidyBook(rec);

  const warning = ambiguous
    ? `${repr(rec.t)}: belongs to several series (${row.Series}); using ${repr(series)}`
    : null;
  return [rec, warning];
}

/** Read the text of an Audible Library Extractor CSV. Only finished books are kept. */
function readAudible(text){
  const result = {records: [], warnings: [], skippedUnfinished: 0};
  for(const row of parseCsv(text)){
    const [rec, warning] = audibleRowToRecord(row);
    if(rec === null){
      if(cell(row, 'Progress') !== 'Finished' && !SAMPLE_ASINS.has(cell(row, 'ASIN'))) result.skippedUnfinished++;
      continue;
    }
    if(!rec.a){
      result.warnings.push(`${repr(rec.t)}: no author in the export, skipped`);
      continue;
    }
    result.records.push(rec);
    if(warning) result.warnings.push(warning);
  }
  return result;
}

// ------------------------------------------------------------------ Goodreads
// Goodreads has no "audiobook" flag; the edition's binding is the best signal there is.
const AUDIO_BINDINGS = new Set(['Audio CD', 'Audiobook', 'Audible Audio', 'MP3 CD', 'MP3 Book', 'Audio']);
const PAREN = /^(.*?)\s*\(([^()]+)\)\s*$/;
const SERIES_MARKER = new RegExp('(#|' + WORD_START + 'book(?![\\p{L}\\p{N}_])|' + WORD_START + 'vol(?![\\p{L}\\p{N}_]))', 'iu');

/** "Frosted (Blaze, #6; Dana O'Hare, #1)" -> ["Frosted", "Blaze", "6"]. */
function parseGoodreadsTitle(raw){
  const m = PAREN.exec(raw.trim());
  if(!m) return [raw.trim(), null, null];
  const clean = m[1].trim(), inner = m[2].trim();
  const first = inner.split(';')[0].trim();          // only the first series when several are listed
  const comma = first.lastIndexOf(',');
  const name = comma >= 0 ? first.slice(0, comma) : '';
  const tail = comma >= 0 ? first.slice(comma + 1) : first;
  if(name && SERIES_MARKER.test(tail)){
    const num = /\d+(?:\.\d+)?/.exec(tail);
    return [clean, name.trim(), num ? num[0] : null];
  }
  const m2 = /^(.*?)\s*#\s*(\d+(?:\.\d+)?)$/.exec(first);
  if(m2) return [clean, m2[1].trim(), m2[2]];
  return [clean, first, null];
}

/** Read the text of a Goodreads library export CSV. Keeps audio editions on the "read" shelf. */
function readGoodreads(text){
  const result = {records: [], warnings: [], skippedUnfinished: 0};
  for(const row of parseCsv(text)){
    if(!AUDIO_BINDINGS.has(cell(row, 'Binding'))) continue;
    if(cell(row, 'Exclusive Shelf') !== 'read'){ result.skippedUnfinished++; continue; }
    const [title, series, number] = parseGoodreadsTitle(row.Title || '');
    let rec = {t: title, a: cell(row, 'Author')};
    // Goodreads files narrators under "Additional Authors"; treat that as a best guess.
    const narrator = cell(row, 'Additional Authors');
    if(narrator) rec.n = narrator;
    if(series){
      rec.s = series;
      if(number) rec.sn = number;
    }
    const shelves = (row.Bookshelves || '').split(',').map(s => s.trim()).filter(Boolean);
    if(shelves.length) rec.g = shelves;
    const read = parseReadDate(cell(row, 'Date Read'));   // Goodreads keeps only the latest read
    if(read) rec.r = [read];
    rec = tidyBook(rec);
    if(rec.a && rec.t) result.records.push(rec);
  }
  return result;
}

// ---------------------------------------------------------------------- merge
/**
 * Append incoming records that are not in `existing` yet (mutates `existing`). An existing book
 * always wins, except that a missing Audible id and missing dates read are filled in; series names
 * are folded onto the spelling already in use. Returns {added, backfilled, datesFilled, excluded, matched}.
 */
function merge(existing, incoming, exclusions){
  exclusions = exclusions || new Exclusions();
  const report = {added: [], backfilled: [], datesFilled: [], excluded: [], matched: 0};

  const index = new Map();
  const indexKey = (k, i) => { if(!index.has(k)) index.set(k, i); };
  existing.forEach((rec, i) => bookKeys(rec).forEach(k => indexKey(k, i)));

  const canonical = new Map();
  for(const rec of existing){
    if(rec.s && !canonical.has(seriesNorm(rec.s))) canonical.set(seriesNorm(rec.s), rec.s);
  }

  for(let rec of incoming){
    rec = {...rec};
    if(rec.s){
      const k = seriesNorm(rec.s);
      if(!canonical.has(k)) canonical.set(k, rec.s);
      rec.s = canonical.get(k);
    }

    const hit = lookupKeys(rec).find(k => index.has(k));
    if(hit !== undefined){
      const match = index.get(hit);
      report.matched++;
      if(rec.id && !existing[match].id){
        existing[match].id = rec.id;
        report.backfilled.push(existing[match]);
        indexKey(key('id', rec.id), match);
      }
      if(rec.r && rec.r.length && !existing[match].r){
        existing[match].r = [...rec.r];
        report.datesFilled.push(existing[match]);
      }
      continue;
    }
    if(exclusions.covers(rec)){
      report.excluded.push(rec);
      continue;
    }
    existing.push(rec);
    report.added.push(rec);
    bookKeys(rec).forEach(k => indexKey(k, existing.length - 1));
  }
  return report;
}

return {
  norm, seriesNorm, tidyText, parseReadDate, parseReadDates, fixReadDates, fixBooks, normalizeName, tidyBook, firstAuthor, bookKeys, lookupKeys,
  Exclusions, parseExclusions, validate, readBackup, parseCsv,
  parseSeriesField, chooseSeries, cleanTitle, audibleRowToRecord, readAudible,
  parseGoodreadsTitle, readGoodreads, merge,
};
})();

if(typeof module !== 'undefined' && module.exports) module.exports = CatalogImport;
