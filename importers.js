// The catalogue's data pipeline: tidying and identity of book records, validation, the Audible and
// Goodreads readers, and the merge that adds imported books without clobbering hand edits.
//
// Shared by the page (index.html loads it as a plain script, defining the global CatalogImport) and
// the command line (catalog.js require()s it), so both import exactly the same way.
const CatalogImport = (() => {

// ------------------------------------------------------------------ fingerprints
/**
 * Cheap non-cryptographic hash of a data file's text. The page tags its edits with the fingerprint of
 * the books.json it loaded, and `serve` refuses to save over a file whose fingerprint has changed since.
 */
function fingerprint(s){
  let h = 5381;
  for(let i = 0; i < s.length; i++){ h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36) + ':' + s.length;
}

// ------------------------------------------------------------------ book records
// A Goodreads book id, as stored in `gr`: the number in goodreads.com/book/show/12345.
const GOODREADS_ID = /^\d+$/;
const BOOK_KEYS = ['t', 'a', 's', 'sn', 'g', 'r', 'e'];
// An edition: Audible ASIN, Goodreads id, ISBNs, narrator(s), publisher, release date, length in
// minutes, and your own description of it ("UK edition", "Dramatized adaptation", "Audio CD").
const EDITION_KEYS = ['id', 'gr', 'isbn', 'n', 'p', 'd', 'len', 'desc'];
// Before editions, a book held its ASIN, Goodreads id and ISBNs itself; fixEditions() moves them.
const LEGACY_KEYS = ['id', 'gr', 'isbn'];
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

// ------------------------------------------------------------------------ ISBNs
const isbn10Ok = s => [...s].reduce((sum, c, i) => sum + (10 - i) * (c === 'X' ? 10 : Number(c)), 0) % 11 === 0;
const isbn13Check = s => String((10 - [...s.slice(0, 12)].reduce((sum, c, i) => sum + Number(c) * (i % 2 ? 3 : 1), 0) % 10) % 10);

/**
 * An ISBN as stored in `isbn`: always the 13-digit form without hyphens, so the ISBN-10 and ISBN-13
 * of one edition are the same entry. Accepts hyphens and spaces, an "ISBN" prefix, and Goodreads'
 * ="0441013597" quoting. Returns null when it is not a valid ISBN (wrong length or check digit).
 */
function parseIsbn(text){
  const s = String(text || '').toUpperCase().replace(/ISBN(?:-?1[03])?:?/g, '').replace(/[\s\-="']/g, '');
  if(/^\d{9}[\dX]$/.test(s)){
    if(!isbn10Ok(s)) return null;
    const twelve = '978' + s.slice(0, 9);
    return twelve + isbn13Check(twelve);
  }
  if(/^97[89]\d{10}$/.test(s)) return isbn13Check(s) === s[12] ? s : null;
  return null;
}

/**
 * Parse a list of ISBNs separated by commas or semicolons (or spaces, when every part is a whole ISBN).
 * Returns {isbns (13-digit, no repeats, in the order given), bad (not an ISBN)}.
 */
function parseIsbns(text){
  const isbns = [], bad = [];
  for(const part of String(text || '').split(/[,;]/).map(x => tidyText(x)).filter(Boolean)){
    let found = [parseIsbn(part)];
    if(!found[0] && part.includes(' ')){
      const words = part.split(' ').map(parseIsbn);
      if(words.every(Boolean)) found = words;
    }
    if(!found[0]){ bad.push(part); continue; }
    for(const isbn of found) if(!isbns.includes(isbn)) isbns.push(isbn);
  }
  return {isbns, bad};
}

/**
 * Return an edition with its ISBNs as a list, like fixReadDates() for dates: a hand-written "isbn":
 * "978-0-441-01359-3" (or several, comma separated) becomes ["9780441013593"]. An empty string drops
 * the field; text that is not a list of ISBNs is left for validate() to report.
 */
function fixIsbns(rec){
  if(!rec || typeof rec !== 'object' || typeof rec.isbn !== 'string') return rec;
  const {isbn, ...rest} = rec;
  if(!isbn.trim()) return rest;
  const {isbns, bad} = parseIsbns(isbn);
  return {...rest, isbn: bad.length ? [tidyText(isbn)] : isbns};
}

// ---------------------------------------------------------------------- editions
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The editions of a book; [] when it has none (or `e` is not a list). */
function bookEditions(rec){
  return rec && Array.isArray(rec.e) ? rec.e.filter(isObject) : [];
}

/** The ISBNs of an edition, as 13-digit strings; [] when it has none (or none that are valid). */
function editionIsbns(ed){
  if(!ed || !Array.isArray(ed.isbn)) return [];
  return [...new Set(ed.isbn.map(parseIsbn).filter(Boolean))];
}

/** The ISBNs of all editions of a book, without repeats. */
function bookIsbns(rec){
  return [...new Set(bookEditions(rec).flatMap(editionIsbns))];
}

/** The Audible ASINs (`field` 'id') or Goodreads ids ('gr') of a book's editions. */
function bookIdsOf(rec, field){
  return [...new Set(bookEditions(rec).map(ed => ed[field]).filter(v => typeof v === 'string' && v))];
}

/** Whether two editions disagree on their ASIN or Goodreads id, so they cannot be one edition. */
function editionsConflict(x, y){
  return ['id', 'gr'].some(k => x[k] && y[k] && x[k] !== y[k]);
}

/**
 * Whether two edition records are the same edition: they share an ASIN, a Goodreads id or an ISBN, and
 * do not disagree on the ASIN or Goodreads id. A box set is one edition listed on each of its titles.
 */
function sameEdition(x, y){
  if(!isObject(x) || !isObject(y) || editionsConflict(x, y)) return false;
  if(['id', 'gr'].some(k => x[k] && x[k] === y[k])) return true;
  const isbns = editionIsbns(y);
  return editionIsbns(x).some(isbn => isbns.includes(isbn));
}

/** An edition with its keys in the usual order (unknown keys last, for validate() to report). */
function orderEdition(ed){
  const out = {};
  for(const k of EDITION_KEYS) if(ed[k] !== undefined) out[k] = ed[k];
  for(const k of Object.keys(ed)) if(!(k in out)) out[k] = ed[k];
  return out;
}

/**
 * Give edition `ed` (in place) what `from` has and it lacks; ISBNs it lacks are added to its list.
 * Nothing it has is changed. Returns the keys it gained.
 */
function fillEdition(ed, from){
  const gained = [];
  for(const k of EDITION_KEYS){
    if(k !== 'isbn' && from[k] !== undefined && ed[k] === undefined){ ed[k] = from[k]; gained.push(k); }
  }
  const have = editionIsbns(ed), more = editionIsbns(from).filter(isbn => !have.includes(isbn));
  if(more.length){ ed.isbn = [...(Array.isArray(ed.isbn) ? ed.isbn : []), ...more]; gained.push('isbn'); }
  if(gained.length){
    const ordered = orderEdition(ed);
    for(const k of Object.keys(ed)) delete ed[k];
    Object.assign(ed, ordered);
  }
  return gained;
}

/**
 * Return a book in the edition format. A book from before editions keeps its ASIN, Goodreads id and
 * ISBNs itself ("id", "gr", "isbn"); they become its first edition (or fill in the edition that
 * already has that ASIN or Goodreads id). A narrator on the book itself ("n", from before narrators
 * moved to editions) goes on each of its editions that has none, or on a new edition when it has none.
 * ISBNs written as text become lists, and an empty `e` is dropped.
 */
function fixEditions(rec){
  if(!isObject(rec)) return rec;
  const legacy = {}, out = {};
  for(const [k, v] of Object.entries(rec)){
    if(LEGACY_KEYS.includes(k)) legacy[k] = v; else if(k !== 'n') out[k] = v;
  }
  const fixedLegacy = fixIsbns(legacy);
  let editions = Array.isArray(rec.e) ? rec.e.map(ed => isObject(ed) ? fixIsbns(ed) : ed) : rec.e;
  if(Object.keys(fixedLegacy).length){
    editions = Array.isArray(editions) ? editions.map(ed => isObject(ed) ? {...ed} : ed) : [];
    const same = editions.find(ed => isObject(ed) && sameEdition(ed, fixedLegacy) && ['id', 'gr'].some(k => ed[k] && ed[k] === fixedLegacy[k]));
    if(same) fillEdition(same, fixedLegacy); else editions.unshift(orderEdition(fixedLegacy));
  }
  if('n' in rec && !(typeof rec.n === 'string' && !rec.n.trim())){
    if(editions === undefined || (Array.isArray(editions) && !editions.length)) editions = [{n: rec.n}];
    else if(Array.isArray(editions)) editions = editions.map(ed => isObject(ed) && ed.n === undefined ? orderEdition({...ed, n: rec.n}) : ed);
    else out.n = rec.n;   // `e` is not a list: leave both for validate() to report
  }
  if(Array.isArray(editions) && !editions.length) editions = undefined;
  if(editions === undefined) delete out.e; else out.e = editions;
  return out;
}

/** The narrators of a book's editions, without repeats, e.g. ["Ann Vale", "R. T. Hale"]. */
function bookNarrators(rec){
  return [...new Set(bookEditions(rec).map(ed => ed.n).filter(n => typeof n === 'string' && n))];
}

/**
 * The parts of an edition as formatEdition() writes them, as [key, label, value] (the description has
 * no label), so the page can turn some of them into links.
 */
function editionParts(ed){
  const parts = [];
  if(ed.desc) parts.push(['desc', '', ed.desc]);
  if(ed.n) parts.push(['n', 'Narrated by', ed.n]);
  if(ed.id) parts.push(['id', 'ASIN', ed.id]);
  if(ed.gr) parts.push(['gr', 'Goodreads', ed.gr]);
  if(Array.isArray(ed.isbn) && ed.isbn.length) parts.push(['isbn', 'ISBN', ed.isbn.join(', ')]);
  if(ed.p) parts.push(['p', 'Publisher', ed.p]);
  if(ed.d) parts.push(['d', 'Released', ed.d]);
  if(Number.isInteger(ed.len)) parts.push(['len', 'Length', formatLength(ed.len)]);
  return parts;
}

/**
 * An edition as one line of text, the way the page shows it and its edit form takes it: "UK edition;
 * Narrated by Ann Vale; ASIN B0X; Goodreads 4242; ISBN 9780000000002; Publisher Gull Audio;
 * Released 2021-05; Length 10h 42m".
 */
function formatEdition(ed){
  return editionParts(ed).map(([, label, value]) => label ? `${label} ${value}` : value).join('; ');
}

const EDITION_PART = /^(asin|goodreads(?:\s+id)?|gr|isbns?|publisher|released?|length|narrated\s+by|narrators?|description)\b:?\s*(.*)$/i;

/**
 * Read editions written one per line as formatEdition() writes them. Parts are separated by ';' and
 * start with their label; a bare ISBN, date or length is recognised without one, and other text
 * without a label is the edition's description (one per edition).
 * Returns {editions, bad (the parts that could not be read)}.
 */
function parseEditions(text){
  const editions = [], bad = [];
  for(const line of String(text || '').split(/\r\n|\r|\n/)){
    const ed = {};
    for(const part of line.split(';').map(x => tidyText(x)).filter(Boolean)){
      const m = EDITION_PART.exec(part);
      const label = m ? m[1].toLowerCase().replace(/\s+id$/, '') : '', value = m ? m[2].trim() : part;
      const isbns = parseIsbns(value), date = parseReadDate(value), minutes = parseLength(value);
      const allIsbns = isbns.isbns.length > 0 && !isbns.bad.length;
      let field = null, v = null;
      if(label === 'asin') [field, v] = ['id', value];
      else if(label === 'goodreads' || label === 'gr') [field, v] = ['gr', GOODREADS_ID.test(value) ? value : null];
      else if(label === 'publisher') [field, v] = ['p', value];
      else if(label.startsWith('narrat')) [field, v] = ['n', value];
      else if(label === 'description') [field, v] = ['desc', ed.desc ? null : value];
      else if(label.startsWith('releas')) [field, v] = ['d', date];
      else if(label === 'length') [field, v] = ['len', minutes];
      else if(label.startsWith('isbn') || (!label && allIsbns)) [field, v] = ['isbn', allIsbns ? isbns.isbns : null];
      else if(!label && date) [field, v] = ['d', date];
      else if(!label && minutes) [field, v] = ['len', minutes];
      else if(!label && !ed.desc) [field, v] = ['desc', value];
      if(!v){ bad.push(part); continue; }
      if(field === 'isbn') ed.isbn = [...new Set([...(ed.isbn || []), ...v])];
      else ed[field] = v;
    }
    if(Object.keys(ed).length) editions.push(orderEdition(ed));
  }
  return {editions, bad};
}

/**
 * Put `rec` at `books[index]` (or add it, when `index` is null) and keep the editions it shares with
 * other books in step: a copy that was identical to the edition before the edit gets the edit, and an
 * edition that shares an ASIN or Goodreads id with one on another book (a box set being linked up)
 * takes what that one has and passes it on. Returns how many other books changed.
 */
function saveBook(books, index, rec){
  const old = index === null ? [] : bookEditions(books[index]);
  const neu = bookEditions(rec);
  const others = books.map((b, k) => k).filter(k => k !== index && isObject(books[k]) && Array.isArray(books[k].e));
  const linked = (x, ed) => ['id', 'gr'].some(f => ed[f] && x[f] === ed[f]) && !editionsConflict(x, ed);
  const befores = neu.map((ed, j) => old.find(x => sameEdition(x, ed)) || (old.length === neu.length ? old[j] : undefined));
  const same = (x, y) => y !== undefined && JSON.stringify(x) === JSON.stringify(y);
  neu.forEach((ed, j) => {
    for(const k of others) for(const x of books[k].e) if(isObject(x) && !same(x, befores[j]) && linked(x, ed)) fillEdition(ed, x);
  });
  const changed = new Set();
  neu.forEach((ed, j) => {
    for(const k of others){
      books[k].e = books[k].e.map(x => {
        if(!isObject(x) || !(same(x, befores[j]) || linked(x, ed)) || same(x, ed)) return x;
        changed.add(k);
        return {...ed, ...(ed.isbn ? {isbn: [...ed.isbn]} : {})};
      });
    }
  });
  if(index === null) books.push(rec); else books[index] = rec;
  return changed.size;
}

/** fixReadDates(), fixEditions() and fixSeriesTitle() on every book of a list; anything that is not a list is returned as is. */
function fixBooks(books){
  return Array.isArray(books) ? books.map(b => fixSeriesTitle(fixEditions(fixReadDates(b)))) : books;
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

/** Return a copy of an edition with tidy text in every field, and its ISBNs in the 13-digit form. */
function tidyEdition(ed){
  if(!isObject(ed)) return ed;
  const out = {...fixIsbns(ed)};
  for(const key of ['id', 'gr', 'p', 'd', 'desc']){
    if(typeof out[key] === 'string') out[key] = tidyText(out[key]);
  }
  if(typeof out.n === 'string') out.n = normalizeName(out.n);
  if(Array.isArray(out.isbn)){
    // the 13-digit form; anything that is not an ISBN is kept (tidied) for validate() to report
    const isbns = out.isbn.map(x => typeof x === 'string' ? parseIsbn(x) || tidyText(x) : x);
    out.isbn = isbns.filter((x, i) => typeof x !== 'string' || isbns.indexOf(x) === i);
  }
  return out;
}

/** Return a copy of a book record, in the edition format, with tidy text in every field. */
function tidyBook(rec){
  const out = {...fixEditions(fixReadDates(rec))};
  for(const key of ['t', 's', 'sn']){
    if(typeof out[key] === 'string') out[key] = tidyText(out[key]);
  }
  if(typeof out.a === 'string') out.a = normalizeName(out.a);
  if(Array.isArray(out.g)){
    out.g = out.g.map(x => typeof x === 'string' ? tidyText(x) : x).filter(x => x !== '');
  }
  if(Array.isArray(out.r)){
    out.r = out.r.map(x => typeof x === 'string' ? tidyText(x) : x);
  }
  if(Array.isArray(out.e)) out.e = out.e.map(tidyEdition);
  return out;
}

function firstAuthor(authors){
  return norm((authors || '').split(/,| and | & /)[0]);
}

// Keys are JSON-encoded arrays so they work as Map and Set keys.
const key = (...parts) => JSON.stringify(parts);

/** Identity keys for a book, strongest first: its editions' ASINs and Goodreads ids, then series, then title. */
function bookKeys(rec){
  const keys = [];
  for(const id of bookIdsOf(rec, 'id')) keys.push(key('id', id));
  for(const gr of bookIdsOf(rec, 'gr')) keys.push(key('gr', gr));
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
  constructor(){
    this.ids = new Set();
    this.titles = new Set();   // key(norm(title), firstAuthor(author))
    this.isbns = new Set();    // 13-digit ISBNs
    this.grs = new Set();      // Goodreads book ids
    this.lines = new Map();   // key -> the entry as written in data/excluded.txt
  }
  /**
   * Add one line of data/excluded.txt: an ASIN, "ISBN 978...", "Goodreads 12345" or "Title | Author";
   * '#' starts a comment.
   * Returns the entry as it should be written, or null for a blank line or one already covered.
   * A bare ISBN-13 counts as an ISBN; a bare ISBN-10 as both an ASIN and an ISBN (Amazon uses a print
   * edition's ISBN-10 as its ASIN).
   */
  add(line){
    line = tidyText(String(line).split('#')[0]);
    if(!line) return null;
    const bar = line.indexOf('|');
    if(bar < 0){
      const gr = GOODREADS_ENTRY.exec(line);
      if(gr){
        if(this.grs.has(gr[1])) return null;
        this.grs.add(gr[1]);
        this.lines.set(key('gr', gr[1]), line = `Goodreads ${gr[1]}`);
        return line;
      }
      const isbn = parseIsbn(line);
      if(isbn && (/^isbn/i.test(line) || !/^[\dX]{10}$/i.test(line))){
        if(this.isbns.has(isbn)) return null;
        this.isbns.add(isbn);
        this.lines.set(key('isbn', isbn), line = `ISBN ${isbn}`);
        return line;
      }
      if(this.ids.has(line) && (!isbn || this.isbns.has(isbn))) return null;
      this.ids.add(line);
      if(isbn) this.isbns.add(isbn);
      this.lines.set(key('id', line), line);
      return line;
    }
    const title = line.slice(0, bar).trim(), author = line.slice(bar + 1).trim();
    const k = key(norm(title), firstAuthor(author));
    if(this.titles.has(k)) return null;
    this.titles.add(k);
    // an entry written before series were split off titles still keeps out the book under its short title
    const split = splitSeriesTitle(title);
    if(split && split[0]) this.titles.add(key(norm(split[0]), firstAuthor(author)));
    this.lines.set(k, line = `${title} | ${author}`);
    return line;
  }
  covers(rec){
    return bookIdsOf(rec, 'id').some(id => this.ids.has(id)) || bookIdsOf(rec, 'gr').some(gr => this.grs.has(gr)) ||
      this.titles.has(key(norm(rec.t), firstAuthor(rec.a))) || bookIsbns(rec).some(isbn => this.isbns.has(isbn));
  }
  /** The entries, one per line as in data/excluded.txt, without comments. */
  get entries(){ return [...this.lines.values()]; }
  get size(){ return this.lines.size; }
}

// "Goodreads 12345" (or "GR 12345"): a Goodreads book id, which needs its prefix to tell it from an ASIN.
const GOODREADS_ENTRY = /^(?:goodreads|gr)(?:\s+id)?:?\s*(\d+)$/i;

/**
 * Parse the text of data/excluded.txt: an ASIN, "ISBN 978...", "Goodreads 12345" or "Title | Author",
 * per line; '#' starts a comment.
 */
function parseExclusions(text){
  const ex = new Exclusions();
  for(const line of (text || '').split(/\r\n|\r|\n/)) ex.add(line);
  return ex;
}

/**
 * The data/excluded.txt entries that keep a removed book out of later imports: the ASINs and Goodreads
 * book ids of its editions, and "Title | Author" (for books with neither). '#' and '|' would
 * break the line, and matching ignores punctuation anyway, so they are dropped.
 */
function exclusionEntries(rec){
  const clean = v => tidyText(String(v || '').replace(/[#|]/g, ' '));
  const entries = [];
  for(const id of bookIdsOf(rec, 'id')) if(clean(id)) entries.push(clean(id));
  for(const gr of bookIdsOf(rec, 'gr')) if(GOODREADS_ID.test(gr.trim())) entries.push(`Goodreads ${gr.trim()}`);
  if(clean(rec.t) && clean(rec.a)) entries.push(`${clean(rec.t)} | ${clean(rec.a)}`);
  return entries;
}

// Quote a value for a message, Python-repr style: 'Title', or "It's" when it contains a quote.
function repr(v){
  if(Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']';
  if(typeof v !== 'string') return String(v);
  const q = v.includes("'") && !v.includes('"') ? '"' : "'";
  const body = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
}

/** Check one edition of a book; adds to `errors` and `warnings`. */
function validateEdition(ed, label, errors, warnings){
  const nonEmpty = v => typeof v === 'string' && v.trim() !== '';
  if(!isObject(ed)){ errors.push(`${label}: not an object`); return; }
  for(const k of Object.keys(ed)){
    if(!EDITION_KEYS.includes(k)) errors.push(`${label}: unknown key ${repr(k)}`);
  }
  for(const k of ['id', 'gr', 'n', 'p', 'd', 'desc']){
    if(k in ed && !nonEmpty(ed[k])) errors.push(`${label}: ${repr(k)} must be a non-empty string when present`);
  }
  if(!Object.keys(ed).length) errors.push(`${label}: is empty`);
  if(nonEmpty(ed.gr) && !GOODREADS_ID.test(ed.gr.trim())){
    errors.push(`${label}: 'gr' must be a Goodreads book id (digits only), not ${repr(ed.gr)}`);
  }
  if(nonEmpty(ed.d) && parseReadDate(ed.d) !== ed.d){
    errors.push(`${label}: 'd' must be a release date (YYYY-MM-DD, YYYY-MM or YYYY), not ${repr(ed.d)}`);
  }
  if('len' in ed && !(Number.isInteger(ed.len) && ed.len > 0)){
    errors.push(`${label}: 'len' must be the length in whole minutes`);
  }
  if('isbn' in ed){
    if(!(Array.isArray(ed.isbn) && ed.isbn.length && ed.isbn.every(nonEmpty))){
      errors.push(`${label}: 'isbn' must be a non-empty list of ISBNs`);
    } else {
      const seen = new Set();
      for(const x of ed.isbn){
        const isbn = parseIsbn(x);
        if(!isbn) errors.push(`${label}: ${repr(x)} is not a valid ISBN`);
        else if(isbn !== x) warnings.push(`${label}: write ISBN ${repr(x)} as ${repr(isbn)}`);
        if(isbn && seen.has(isbn)) warnings.push(`${label}: ISBN ${isbn} is listed twice`);
        seen.add(isbn);
      }
    }
  }
}

/** Return {errors, warnings}. Errors block imports; warnings are worth a look. */
function validate(books, info){
  const errors = [], warnings = [];
  if(!Array.isArray(books)) return {errors: ['books.json must contain a list'], warnings};
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

  // ASIN / Goodreads id -> the first edition seen with it; a box set is one edition on several titles
  const seen = {id: new Map(), gr: new Map()};
  const names = {id: 'id', gr: 'Goodreads id'};
  books.forEach((b, i) => {
    const label = isObj(b) ? `book #${i} (${repr(b.t === undefined ? '?' : b.t)})` : `book #${i}`;
    if(!isObj(b)){ errors.push(`${label}: not an object`); return; }
    for(const k of Object.keys(b)){
      if(!BOOK_KEYS.includes(k)) errors.push(`${label}: unknown key ${repr(k)}`);
    }
    for(const k of ['t', 'a']){
      if(!nonEmpty(b[k])) errors.push(`${label}: missing ${repr(k)}`);
    }
    for(const k of ['s', 'sn']){
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
    if('e' in b && !(Array.isArray(b.e) && b.e.length)){
      errors.push(`${label}: 'e' must be a non-empty list of editions`);
    } else if('e' in b){
      b.e.forEach((ed, j) => validateEdition(ed, `${label} edition #${j + 1}`, errors, warnings));
    }
    if(b.sn && !b.s) errors.push(`${label}: has a series number but no series`);
    if(b.sn && typeof b.sn === 'string' && !SERIES_NUMBER.test(b.sn.trim())){
      warnings.push(`${label}: unusual series number ${repr(b.sn)}`);
    }
    const titleKey = key(norm(b.t), firstAuthor(b.a));
    for(const ed of bookEditions(b)){
      for(const field of ['id', 'gr']){
        const v = ed[field];
        if(!nonEmpty(v)) continue;
        const other = seen[field].get(v);
        if(!other){ seen[field].set(v, {i, label, titleKey, ed}); continue; }
        if(other.i === i) errors.push(`${label}: lists the edition with ${names[field]} ${v} twice`);
        else if(other.titleKey === titleKey) errors.push(`${label}: duplicate ${names[field]} ${v} (also ${other.label})`);
        else if(field === 'id' || !ed.id || !other.ed.id){
          // a box set's edition on each of its titles: fine, as long as the copies agree
          if(JSON.stringify(orderEdition(tidyEdition(ed))) !== JSON.stringify(orderEdition(tidyEdition(other.ed)))){
            warnings.push(`${label}: the edition with ${names[field]} ${v} differs from its copy on ${other.label}`);
          }
        }
      }
    }
  });

  const seriesNames = new Set(books.filter(b => isObj(b) && b.s).map(b => b.s));

  const untidy = new Map();
  const labels = {t: 'title', a: 'author', s: 'series', g: 'genre'};
  for(const b of books){
    if(!isObj(b)) continue;
    for(const [k, label] of Object.entries(labels)){
      const values = Array.isArray(b[k]) ? b[k] : [b[k]];
      for(const value of values){
        if(typeof value !== 'string') continue;
        const expected = k === 'a' ? normalizeName(value) : tidyText(value);
        if(expected !== value) untidy.set(key(label, value), [label, value, expected]);
      }
    }
  }
  for(const ed of books.flatMap(bookEditions)){
    if(typeof ed.p === 'string' && tidyText(ed.p) !== ed.p) untidy.set(key('publisher', ed.p), ['publisher', ed.p, tidyText(ed.p)]);
    if(typeof ed.n === 'string' && normalizeName(ed.n) !== ed.n) untidy.set(key('narrator', ed.n), ['narrator', ed.n, normalizeName(ed.n)]);
    if(typeof ed.desc === 'string' && tidyText(ed.desc) !== ed.desc) untidy.set(key('description', ed.desc), ['description', ed.desc, tidyText(ed.desc)]);
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
 * Read a backup exported from the page: {books: [...], seriesInfo: {...}, excluded: [...]}, or a
 * plain array of books from before series info was exported. Returns {books, seriesInfo, excluded};
 * seriesInfo and excluded (the data/excluded.txt entries) are null when the backup predates them,
 * so callers leave theirs alone. Throws if it is neither.
 */
function readBackup(data){
  if(Array.isArray(data)) return {books: fixBooks(data), seriesInfo: null, excluded: null};
  if(data && typeof data === 'object' && Array.isArray(data.books)){
    const {seriesInfo: info, excluded} = data;
    if(info !== undefined && !(info && typeof info === 'object' && !Array.isArray(info))) throw new Error('seriesInfo is not an object');
    if(excluded !== undefined && !(Array.isArray(excluded) && excluded.every(x => typeof x === 'string'))){
      throw new Error('excluded is not a list of strings');
    }
    return {books: fixBooks(data.books), seriesInfo: info === undefined ? null : info, excluded: excluded === undefined ? null : excluded};
  }
  throw new Error('expected a list of books or {books, seriesInfo, excluded}');
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

// Audible Library Extractor has "ISBN10" and "ISBN13", Goodreads "ISBN" and "ISBN13"; spacing and case are forgiven.
const ISBN_COLUMN = /^isbns?[\s_-]*(1[03])?$/i;

/** The valid ISBNs in a CSV row's ISBN columns, 13-digit and without repeats. */
function rowIsbns(row){
  const isbns = [];
  for(const [name, value] of Object.entries(row)){
    if(!ISBN_COLUMN.test(name.trim())) continue;
    for(const part of String(value || '').split(/[,;]/)){
      const isbn = parseIsbn(part);
      if(isbn && !isbns.includes(isbn)) isbns.push(isbn);
    }
  }
  return isbns;
}

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

/**
 * A length in whole minutes, from Audible's "11 hrs and 5 mins", "11h 5m", "45 min" or "11:05".
 * Returns null when there is none.
 */
function parseLength(text){
  const s = tidyText(String(text || '')).toLowerCase();
  let m = /^(\d+):(\d{1,2})(?::\d{1,2})?$/.exec(s);
  if(m) return Number(m[1]) * 60 + Number(m[2]) || null;
  m = /^(?:(\d+)\s*h(?:ours?|rs?)?)?(?:\s*(?:and|,)?\s*(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(s);
  if(!m || (m[1] === undefined && m[2] === undefined)) return null;
  return Number(m[1] || 0) * 60 + Number(m[2] || 0) || null;
}

/** 642 -> "10h 42m"; the form parseLength() reads back. */
function formatLength(minutes){
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
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
  if(series){
    rec.s = series;
    if(number) rec.sn = number;
  }
  let tags = (row.Tags || '').split(',').map(t => t.trim()).filter(Boolean);
  if(!tags.length && cell(row, 'Child Category')) tags = [cell(row, 'Child Category')];
  if(tags.length) rec.g = tags;
  const edition = {};
  if(asin) edition.id = asin;
  if(cell(row, 'Narrators')) edition.n = cell(row, 'Narrators');
  const isbns = rowIsbns(row);
  if(isbns.length) edition.isbn = isbns;
  if(cell(row, 'Publishers')) edition.p = cell(row, 'Publishers');
  const released = parseReadDate(cell(row, 'Release Date'));
  if(released) edition.d = released;
  const minutes = parseLength(cell(row, 'Length'));
  if(minutes) edition.len = minutes;
  if(Object.keys(edition).length) rec.e = [edition];
  rec = tidyBook(fixSeriesTitle(rec));   // a title like "Lantern of the Deep: Ember Coast, Book 2" with no Series column

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

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
// "Title: Series, Book 3" (also "Volume 3", "Vol. 3", "#3" or "Book Three"). The title takes the last
// colon, so a subtitle stays with it; a series name with a colon in it loses its first part.
const COLON_SERIES = new RegExp('^(.+):\\s*(.+?)\\s*,\\s*(?:book|volume|vol\\.?|#)\\s*(\\d+(?:\\.\\d+)?|' +
  NUMBER_WORDS.join('|') + ')\\s*$', 'i');

/** "Title: Series, Book 3" -> ["Title", "Series", "3"], or null. */
function splitColonSeries(raw){
  const m = COLON_SERIES.exec(raw);
  if(!m) return null;
  const word = NUMBER_WORDS.indexOf(m[3].toLowerCase());
  return [m[1].trim(), m[2].trim(), word >= 0 ? String(word) : m[3]];
}

/**
 * Split a series and number off a title written as "Title: Series, Book 3" or "Title (Series, #3)".
 * Returns [title, series, number], or null when the title names no series with a number.
 */
function splitSeriesTitle(raw){
  raw = tidyText(raw);
  const colon = splitColonSeries(raw);
  if(colon) return colon;
  if(!PAREN.test(raw)) return null;
  const parts = parseGoodreadsTitle(raw);
  return parts[1] && parts[2] ? parts : null;
}

/**
 * Take the series out of the title of a book imported before titles were split ("Title: Series, Book 3").
 * A book without a series gets the one in its title; a book that already has that series only loses it
 * from the title (and gains the number if it had none). A different series or number is never changed;
 * then the title stays as it is.
 */
function fixSeriesTitle(rec){
  if(!isObject(rec) || typeof rec.t !== 'string') return rec;
  const split = splitSeriesTitle(rec.t);
  if(!split || !split[0]) return rec;
  const [t, s, sn] = split;
  if(!rec.s && !rec.sn) return {...rec, t, s, sn};
  if(typeof rec.s !== 'string' || seriesNorm(rec.s) !== seriesNorm(s)) return rec;
  if(rec.sn && Number(rec.sn) !== Number(sn)) return rec;
  return {...rec, t, ...(rec.sn ? {} : {sn})};
}

/**
 * A Goodreads title: "Frosted (Blaze, #6; Dana O'Hare, #1)" or "Frosted: Blaze, Book 6" -> ["Frosted", "Blaze", "6"].
 * When both are there, the colon part is dropped if it names the same series.
 */
function readGoodreadsTitle(raw){
  const [title, series, number] = parseGoodreadsTitle(raw);
  const colon = splitColonSeries(title);
  if(!colon) return [title, series, number];
  if(!series) return colon;
  return seriesNorm(colon[1]) === seriesNorm(series) ? [colon[0], series, number || colon[2]] : [title, series, number];
}

/** Read the text of a Goodreads library export CSV. Keeps audio editions on the "read" shelf. */
function readGoodreads(text){
  const result = {records: [], warnings: [], skippedUnfinished: 0};
  for(const row of parseCsv(text)){
    if(!AUDIO_BINDINGS.has(cell(row, 'Binding'))) continue;
    if(cell(row, 'Exclusive Shelf') !== 'read'){ result.skippedUnfinished++; continue; }
    const [title, series, number] = readGoodreadsTitle(row.Title || '');
    let rec = {t: title, a: cell(row, 'Author')};
    if(series){
      rec.s = series;
      if(number) rec.sn = number;
    }
    const shelves = (row.Bookshelves || '').split(',').map(s => s.trim()).filter(Boolean);
    if(shelves.length) rec.g = shelves;
    // Goodreads' own id for the edition; spreadsheet programs sometimes save it as ="12345".
    const edition = {};
    const gr = cell(row, 'Book Id').replace(/[="\s]/g, '');
    if(GOODREADS_ID.test(gr)) edition.gr = gr;
    // Goodreads files narrators under "Additional Authors"; treat that as a best guess.
    if(cell(row, 'Additional Authors')) edition.n = cell(row, 'Additional Authors');
    const isbns = rowIsbns(row);
    if(isbns.length) edition.isbn = isbns;
    if(cell(row, 'Publisher')) edition.p = cell(row, 'Publisher');
    const year = parseReadDate(cell(row, 'Year Published'));   // this edition's; "Original Publication Year" is the book's
    if(year) edition.d = year;
    if(Object.keys(edition).length) rec.e = [edition];
    const read = parseReadDate(cell(row, 'Date Read'));   // Goodreads keeps only the latest read
    if(read) rec.r = [read];
    rec = tidyBook(rec);
    if(rec.a && rec.t) result.records.push(rec);
  }
  return result;
}

// ---------------------------------------------------------------------- merge
// Which report list a book goes on when one of its editions gains a field.
const FILLED_REPORT = {id: 'backfilled', gr: 'goodreadsFilled', isbn: 'isbnsFilled', p: 'detailsFilled', d: 'detailsFilled', len: 'detailsFilled'};

/**
 * Append incoming records that are not in `existing` yet (mutates `existing`). An existing book
 * always wins, except that it gains dates read when it has none, and the editions it lacks:
 * - an incoming edition with the same ASIN, Goodreads id or ISBN as one of the book's editions fills in
 *   what that edition is missing (and so does every copy of it on a box set's other titles);
 * - otherwise, when the book has one edition of its own that does not disagree on the ASIN or
 *   Goodreads id, that edition is filled in (a Goodreads export finding the book an Audible import added);
 * - otherwise the incoming edition is added as another edition of the book.
 * Series names are folded onto the spelling already in use. ISBNs never make two books the same:
 * one ISBN may be on several books (a boxed set's ISBN on each book in it).
 * Returns {added, backfilled, goodreadsFilled, isbnsFilled, detailsFilled, editionsAdded, datesFilled,
 * excluded, matched}: books that gained an Audible id, a Goodreads id, ISBNs, a publisher, release date
 * or length, a new edition, dates read.
 */
function merge(existing, incoming, exclusions){
  exclusions = exclusions || new Exclusions();
  const report = {added: [], backfilled: [], goodreadsFilled: [], isbnsFilled: [], detailsFilled: [], editionsAdded: [],
    datesFilled: [], excluded: [], matched: 0};

  const index = new Map();
  const indexKey = (k, i) => { if(!index.has(k)) index.set(k, i); };
  const indexBook = i => bookKeys(existing[i]).forEach(k => indexKey(k, i));
  existing.forEach((rec, i) => indexBook(i));

  const canonical = new Map();
  for(const rec of existing){
    if(rec.s && !canonical.has(seriesNorm(rec.s))) canonical.set(seriesNorm(rec.s), rec.s);
  }

  // [book index, edition] of every copy of an edition, on any book, other than the edition itself
  const copiesOf = ed => existing.flatMap((rec, i) => bookEditions(rec).filter(x => x !== ed && sameEdition(x, ed)).map(x => [i, x]));
  const note = (list, rec) => { if(!list.includes(rec) && !report.added.includes(rec)) list.push(rec); };

  for(let rec of incoming){
    rec = {...rec};
    if(rec.s){
      const k = seriesNorm(rec.s);
      if(!canonical.has(k)) canonical.set(k, rec.s);
      rec.s = canonical.get(k);
    }

    const hit = lookupKeys(rec).find(k => index.has(k));
    if(hit !== undefined){
      const match = index.get(hit), book = existing[match];
      report.matched++;
      for(const ed of bookEditions(rec)){
        const own = bookEditions(book);
        let target = own.find(x => sameEdition(x, ed));
        if(!target && own.length === 1 && !editionsConflict(own[0], ed) && !copiesOf(own[0]).length) target = own[0];
        if(target){
          const copies = copiesOf(target);
          for(const field of fillEdition(target, ed)) note(report[FILLED_REPORT[field]], book);
          for(const [i, copy] of copies){ fillEdition(copy, target); indexBook(i); }
        } else if(own.length){
          book.e = [...book.e, orderEdition({...ed})];
          note(report.editionsAdded, book);
        } else {
          // a book without editions just gains the ids it lacked, as before editions existed
          const first = {};
          book.e = [first];
          for(const field of fillEdition(first, ed)) note(report[FILLED_REPORT[field]], book);
        }
        indexBook(match);
      }
      if(rec.r && rec.r.length && !book.r){
        book.r = [...rec.r];
        report.datesFilled.push(book);
      }
      continue;
    }
    if(exclusions.covers(rec)){
      report.excluded.push(rec);
      continue;
    }
    if(rec.e) rec.e = rec.e.map(ed => isObject(ed) ? {...ed} : ed);
    existing.push(rec);
    report.added.push(rec);
    indexBook(existing.length - 1);
  }
  return report;
}

/**
 * The series numbers from 1 to `total` that none of `books` covers, e.g. [3, 5]. A boxed set
 * ("4-6") covers each number in it; a novella such as "2.5" covers none, so it does not hide a
 * missing book 2. Returns null when `total` is not a count (e.g. "many" or no series info).
 */
function missingNumbers(books, total){
  if(!(Number.isInteger(total) && total > 0)) return null;
  const owned = new Set();
  for(const b of books){
    const m = /^(\d+)(?:-(\d+))?$/.exec(String(b.sn || '').trim());
    if(!m) continue;
    const from = parseInt(m[1], 10), to = Math.min(m[2] ? parseInt(m[2], 10) : from, total);
    for(let n = from; n <= to; n++) owned.add(n);
  }
  const missing = [];
  for(let n = 1; n <= total; n++) if(!owned.has(n)) missing.push(n);
  return missing;
}

// ---------------------------------------------------------------------- duplicates
/**
 * Key for "these two books are different books", so a pair you dismissed is not offered again.
 * Built from what identifies a title (not from list positions, which change), in either order.
 */
function duplicatePairKey(x, y){
  const id = b => key(norm(b.t), firstAuthor(b.a), seriesNorm(b.s), String(b.sn || '').trim());
  return [id(x), id(y)].sort().join(' ');
}

/**
 * Books that look like one title entered twice, as groups of indexes into `books`, e.g. [[3, 17]].
 * Two books pair up the way an import would match them, minus the ids: the same first author, series
 * and number (spelling-insensitive), or the same author and title, forgiving Audible's long titles.
 * Sharing an ASIN or Goodreads id pairs nothing by itself, since a box set's titles share one edition.
 * `notSame` holds duplicatePairKey()s of pairs that are different books.
 */
function findDuplicates(books, notSame){
  notSame = notSame || new Set();
  const isId = k => k.startsWith('["id"') || k.startsWith('["gr"');
  const byKey = new Map();
  books.forEach((b, i) => {
    if(!isObject(b) || typeof b.t !== 'string') return;
    for(const k of bookKeys(b).filter(k => !isId(k))){
      if(!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(i);
    }
  });
  const parent = books.map((b, i) => i);
  const root = i => parent[i] === i ? i : (parent[i] = root(parent[i]));
  books.forEach((b, i) => {
    if(!isObject(b) || typeof b.t !== 'string') return;
    for(const k of lookupKeys(b).filter(k => !isId(k))){
      for(const j of byKey.get(k) || []){
        if(j !== i && !notSame.has(duplicatePairKey(b, books[j]))) parent[root(j)] = root(i);
      }
    }
  });
  const groups = new Map();
  books.forEach((b, i) => {
    const r = root(i);
    if(!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  return [...groups.values()].filter(g => g.length > 1);
}

/**
 * Whether several editions could all be one edition: none disagree with another on the ASIN or
 * Goodreads id. The usual case is one book imported twice, once with its Audible ASIN and once with
 * its Goodreads id.
 */
function editionsJoinable(editions){
  return editions.length > 1 && editions.every((x, i) => editions.slice(i + 1).every(y => !editionsConflict(x, y)));
}

/** Editions made into one: the first, filled in from the others (nothing it has is changed). */
function joinEditions(editions){
  const out = orderEdition({...editions[0], ...(Array.isArray(editions[0].isbn) ? {isbn: [...editions[0].isbn]} : {})});
  for(const ed of editions.slice(1)) fillEdition(out, ed);
  return out;
}

/** Key for "these editions of a book are different editions": the ids they carry, in any order. */
function editionsKey(rec){
  const ids = bookEditions(rec).flatMap(ed => [
    ...['id', 'gr'].filter(k => typeof ed[k] === 'string' && ed[k]).map(k => k + ' ' + ed[k]),
    ...editionIsbns(ed).map(x => 'isbn ' + x),
  ]);
  return key('editions', ...[...new Set(ids)].sort());
}

/**
 * Books whose editions look like one edition recorded twice (see editionsJoinable), as indexes into
 * `books`; a book with an edition that another book shares (a box set) is left out. `keepApart` holds
 * editionsKey()s of books whose editions are different.
 */
function splitEditions(books, keepApart){
  keepApart = keepApart || new Set();
  const owners = new Map();   // ASIN / Goodreads id / ISBN -> how many books carry it
  books.forEach(b => {
    const ids = new Set(bookEditions(b).flatMap(ed => [...['id', 'gr'].filter(k => ed[k]).map(k => k + ' ' + ed[k]), ...editionIsbns(ed)]));
    for(const id of ids) owners.set(id, (owners.get(id) || 0) + 1);
  });
  const shared = ed => [...['id', 'gr'].filter(k => ed[k]).map(k => k + ' ' + ed[k]), ...editionIsbns(ed)].some(id => owners.get(id) > 1);
  return books.map((b, i) => i).filter(i => {
    const editions = bookEditions(books[i]);
    return editionsJoinable(editions) && !editions.some(shared) && !keepApart.has(editionsKey(books[i]));
  });
}

/**
 * One book made of several entries for the same title. `pick` says, for 't', 'a' and 'series'
 * (the series and its number together), which entry's value to keep, as an index into `recs`; by
 * default the first entry that has one. Genres and dates read are combined, and so are editions: an
 * edition that shares an ASIN, Goodreads id or ISBN with one already kept fills in what it lacks,
 * the others are added. With `pick.joinEditions`, editions that do not disagree on an ASIN or
 * Goodreads id become one edition (see editionsJoinable).
 */
function mergeBooks(recs, pick){
  pick = pick || {};
  const from = (field, has) => {
    const i = pick[field];
    return Number.isInteger(i) && recs[i] && has(recs[i]) ? recs[i] : recs.find(has);
  };
  const out = {};
  for(const k of ['t', 'a']){
    const rec = from(k, b => typeof b[k] === 'string' && b[k] !== '');
    if(rec) out[k] = rec[k];
  }
  const series = from('series', b => typeof b.s === 'string' && b.s !== '');
  if(series){
    out.s = series.s;
    if(series.sn) out.sn = series.sn;
  }
  const genres = [...new Set(recs.flatMap(b => Array.isArray(b.g) ? b.g : []))];
  if(genres.length) out.g = genres;
  const dates = [...new Set(recs.flatMap(b => Array.isArray(b.r) ? b.r : []))].sort();
  if(dates.length) out.r = dates;
  const editions = [];
  for(const ed of recs.flatMap(bookEditions)){
    const same = editions.find(x => sameEdition(x, ed));
    if(same) fillEdition(same, ed);
    else editions.push(orderEdition({...ed, ...(Array.isArray(ed.isbn) ? {isbn: [...ed.isbn]} : {})}));
  }
  if(pick.joinEditions && editionsJoinable(editions)) out.e = [joinEditions(editions)];
  else if(editions.length) out.e = editions;
  return out;
}

// A book as text that ignores the order of its keys, editions' keys and dates read, for "did it change?".
function bookText(rec){
  const pairs = (obj, keys) => keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]);
  return JSON.stringify(BOOK_KEYS.filter(k => rec[k] !== undefined).map(k =>
    k === 'e' && Array.isArray(rec.e) ? [k, rec.e.map(ed => isObject(ed) ? pairs(ed, EDITION_KEYS) : ed)]
      : k === 'r' && Array.isArray(rec.r) ? [k, [...rec.r].sort()] : [k, rec[k]]));
}

/**
 * Merge a backup made on another device into this catalogue, when both have changed since they were
 * last the same (there is no common ancestor to compare with, so this works from what each side has):
 * - a book only the backup has is added, unless this catalogue excludes it (it was removed here);
 * - a book only this catalogue has stays, unless the backup newly excludes it (it was removed there);
 * - a book both have (found as imports find books) keeps the union of their genres, dates read and
 *   editions; where title, author or series differ, `prefer` ('mine', the default, or 'backup') wins,
 *   and the book is listed in `conflicts`;
 * - series info both have keeps the preferred side's; the backup's excluded books are added to ours.
 * Changes nothing it is given. Returns {books, seriesInfo, excluded (entries new to `exclusions`),
 * added, updated, removed, skipped, conflicts: [{mine, theirs}], infoAdded, infoChanged, infoKept}.
 */
function mergeBackup(books, seriesInfo, exclusions, backup, prefer){
  const takeBackup = prefer === 'backup';
  const copy = rec => JSON.parse(JSON.stringify(rec));
  const out = books.map(copy);
  const result = {added: [], updated: [], removed: [], skipped: [], conflicts: [], infoAdded: [], infoChanged: [], infoKept: []};

  const ours = parseExclusions((exclusions ? exclusions.entries : []).join('\n'));
  const theirsOnly = new Exclusions();
  result.excluded = (backup.excluded || []).map(e => ours.add(e)).filter(Boolean);
  result.excluded.forEach(e => theirsOnly.add(e));

  // Each key leads to every book that has it: a box set's titles share their edition's ASIN.
  const index = new Map();
  const indexBook = i => bookKeys(out[i]).forEach(k => { if(!index.has(k)) index.set(k, []); if(!index.get(k).includes(i)) index.get(k).push(i); });
  out.forEach((rec, i) => indexBook(i));
  const matched = new Set();
  const label = rec => JSON.stringify([rec.t, rec.a, rec.s || '', rec.sn || '']);
  // A book of the backup is one of ours by its title first, then its place in a series, then its ids
  // (which a box set's titles share), and each of ours matches one book of the backup at most.
  const findOurs = rec => {
    const keys = lookupKeys(rec);
    const rank = k => k.startsWith('["title"') ? 0 : k.startsWith('["series"') ? 1 : 2;
    for(const k of keys.slice().sort((x, y) => rank(x) - rank(y))){
      const i = (index.get(k) || []).find(x => !matched.has(x));
      if(i !== undefined) return i;
    }
  };

  for(const theirs of backup.books){
    const i = findOurs(theirs);
    if(i === undefined){
      if(exclusions && exclusions.covers(theirs)){ result.skipped.push(theirs); continue; }
      out.push(copy(theirs));
      result.added.push(out[out.length - 1]);
      indexBook(out.length - 1);
      continue;
    }
    matched.add(i);
    const mine = out[i];
    if(label(mine) !== label(theirs)) result.conflicts.push({mine: copy(mine), theirs});
    const merged = mergeBooks(takeBackup ? [theirs, mine] : [mine, theirs]);
    // an edition without ids that both sides have is still one edition
    if(merged.e){
      const seen = new Set();
      merged.e = merged.e.filter(x => { const k = JSON.stringify(EDITION_KEYS.map(f => x[f])); return !seen.has(k) && seen.add(k); });
    }
    if(bookText(merged) === bookText(mine)) continue;
    out[i] = merged;
    if(!result.updated.includes(merged)) result.updated.push(merged);
    indexBook(i);
  }

  const kept = out.filter((rec, i) => {
    const gone = i < books.length && !matched.has(i) && theirsOnly.covers(rec);
    if(gone) result.removed.push(rec);
    return !gone;
  });

  const info = {...(seriesInfo || {})};
  for(const [name, entry] of Object.entries(backup.seriesInfo || {})){
    if(!(name in info)){ info[name] = entry; result.infoAdded.push(name); }
    else if(JSON.stringify(info[name]) !== JSON.stringify(entry)){
      if(takeBackup){ info[name] = entry; result.infoChanged.push(name); }
      else result.infoKept.push(name);
    }
  }
  return {...result, books: kept, seriesInfo: info};
}

return {
  fingerprint, norm, seriesNorm, tidyText, parseReadDate, parseReadDates, fixReadDates, fixBooks, normalizeName, tidyBook, firstAuthor, bookKeys, lookupKeys,
  parseIsbn, parseIsbns, fixIsbns, bookIsbns, rowIsbns,
  bookEditions, editionIsbns, sameEdition, fixEditions, tidyEdition, parseLength, formatLength, editionParts, formatEdition, parseEditions, saveBook,
  bookNarrators,
  Exclusions, parseExclusions, exclusionEntries, validate, readBackup, parseCsv,
  parseSeriesField, chooseSeries, cleanTitle, audibleRowToRecord, readAudible,
  parseGoodreadsTitle, splitSeriesTitle, fixSeriesTitle, readGoodreadsTitle, readGoodreads, merge, missingNumbers, duplicatePairKey, findDuplicates, mergeBooks,
  editionsJoinable, joinEditions, editionsKey, splitEditions, mergeBackup,
};
})();

if(typeof module !== 'undefined' && module.exports) module.exports = CatalogImport;
