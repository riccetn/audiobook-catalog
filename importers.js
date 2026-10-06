// The catalogue's data pipeline: tidying and identity of book records, validation, the Audible and
// Goodreads readers, and the merge that adds imported books without clobbering hand edits.
//
// An ES module shared by the pages (store.js and each page's script import it) and the command line
// (catalog.js), so both import exactly the same way.

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
// Hardcover's own ids, as stored in `hcb` on a book and `hc` on an edition of it.
const HARDCOVER_ID = /^\d+$/;
// A book: title, authors, series and number, genres, dates read, Hardcover book id, editions.
const BOOK_KEYS = ['t', 'a', 's', 'sn', 'g', 'r', 'hcb', 'e'];
// An edition: Audible ASIN, Goodreads id, Hardcover edition id, ISBN (one: another ISBN is another
// edition), narrators, publisher, release date, length in minutes, and your own description of it
// ("UK edition", "Dramatized adaptation").
const EDITION_KEYS = ['id', 'gr', 'hc', 'isbn', 'n', 'p', 'd', 'len', 'desc'];
// The ids that name one edition (and match books in imports). An ISBN names one edition too, but one
// ISBN may be on several books (a boxed set's), so it never makes two books the same.
const EDITION_IDS = ['id', 'gr', 'hc'];
// Before editions, a book held its ASIN, Goodreads id and ISBNs itself; fixEditions() moves them.
const LEGACY_KEYS = ['id', 'gr', 'isbn'];
const STATUSES = ['ongoing', 'complete'];
const SERIES_NUMBER = /^\d+(\.\d+)?(-\d+(\.\d+)?)?$/;
// A box set's range of whole numbers, "1-3"; more than BOX_MAX titles is taken for a typo.
const BOX_RANGE = /^(\d+)-(\d+)$/;
const BOX_MAX = 30;
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

// ------------------------------------------------------------------------ people
// What follows a comma without being a name of its own: "Ann Vale, Jr.".
const NAME_SUFFIX = /^(jr|sr|i{2,3}|iv|phd|md)\.?$/i;

/**
 * Split names written as text into a list: "Ann Vale, R. T. Hale" or "Ann Vale & R. T. Hale" ->
 * ["Ann Vale", "R. T. Hale"]. Commas, semicolons, "&" and "and" separate names; a suffix stays with its
 * name ("Ann Vale, Jr."). Names are trimmed, and repeats and empty parts dropped.
 */
function splitNames(text){
  const names = [];
  for(const part of String(text || '').split(/[,;]|\s&\s|\sand\s/).map(x => tidyText(x)).filter(Boolean)){
    if(NAME_SUFFIX.test(part) && names.length) names[names.length - 1] += ', ' + part;
    else names.push(part);
  }
  return names.filter((x, i) => names.indexOf(x) === i);
}

/** Names as one line of text: ["Ann Vale", "R. T. Hale"] -> "Ann Vale, R. T. Hale" (a string is returned as is). */
function namesText(names){
  return Array.isArray(names) ? names.join(', ') : String(names || '');
}

/**
 * Names as a list. Before they were lists, the authors ("a") and an edition's narrators ("n") were one
 * comma separated string; that is split (splitNames). A list keeps its names as they are, without
 * repeats or empty ones; anything else is left for validate() to report. Returns null for no names.
 */
function fixNames(v){
  if(typeof v === 'string') return splitNames(v).length ? splitNames(v) : null;
  if(!Array.isArray(v)) return v;
  const names = v.filter((x, i) => !(typeof x === 'string' && (!x.trim() || v.indexOf(x) !== i)));
  return !names.length ? null : names.length === v.length ? v : names;
}

/** A book (or edition) with its authors ("a") and narrators ("n") as lists; see fixNames(). */
function fixPeople(rec){
  if(!isObject(rec)) return rec;
  let out = rec;
  for(const k of ['a', 'n']){
    if(!(k in rec)) continue;
    const names = fixNames(rec[k]);
    if(names === rec[k]) continue;
    if(out === rec) out = {...rec};
    if(names === null) delete out[k]; else out[k] = names;
  }
  if(Array.isArray(rec.e) && rec.e.some(ed => fixPeople(ed) !== ed)){
    if(out === rec) out = {...rec};
    out.e = rec.e.map(fixPeople);
  }
  return out;
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
 * An edition as editions with one ISBN each, since an ISBN names one edition: "isbn": "978-0-441-01359-3"
 * becomes "9780441013593", and an edition with several (a list, from before one ISBN per edition, or
 * comma separated) keeps the first, each other one becoming an edition of its own with just that ISBN.
 * An empty value drops the field; what is not an ISBN is kept, tidied, for validate() to report.
 */
function splitIsbns(ed){
  if(!isObject(ed) || !('isbn' in ed) || (typeof ed.isbn !== 'string' && !Array.isArray(ed.isbn))) return [ed];
  const {isbn, ...rest} = ed;
  const parts = [];
  for(const x of Array.isArray(isbn) ? isbn : [isbn]){
    if(typeof x !== 'string'){ parts.push(x); continue; }
    if(!x.trim()) continue;
    const {isbns, bad} = parseIsbns(x);
    parts.push(...(bad.length ? [tidyText(x)] : isbns));
  }
  const unique = parts.filter((x, i) => typeof x !== 'string' || parts.indexOf(x) === i);
  if(!unique.length) return Object.keys(rest).length ? [rest] : [];
  return [orderEdition({...rest, isbn: unique[0]}), ...unique.slice(1).map(x => ({isbn: x}))];
}

// ---------------------------------------------------------------------- editions
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The editions of a book; [] when it has none (or `e` is not a list). */
function bookEditions(rec){
  return rec && Array.isArray(rec.e) ? rec.e.filter(isObject) : [];
}

/** The ISBN of an edition, as a 13-digit string, in a list; [] when it has none (or not a valid one). */
function editionIsbns(ed){
  const isbn = ed && typeof ed.isbn === 'string' ? parseIsbn(ed.isbn) : null;
  return isbn ? [isbn] : [];
}

/** The ISBNs of all editions of a book, without repeats. */
function bookIsbns(rec){
  return [...new Set(bookEditions(rec).flatMap(editionIsbns))];
}

/** The Audible ASINs (`field` 'id'), Goodreads ids ('gr') or Hardcover edition ids ('hc') of a book's editions. */
function bookIdsOf(rec, field){
  return [...new Set(bookEditions(rec).map(ed => ed[field]).filter(v => typeof v === 'string' && v))];
}

/** Whether two editions disagree on their ASIN, Goodreads id, Hardcover id or ISBN, so they cannot be one edition. */
function editionsConflict(x, y){
  if(EDITION_IDS.some(k => x[k] && y[k] && x[k] !== y[k])) return true;
  const a = editionIsbns(x), b = editionIsbns(y);
  return a.length > 0 && b.length > 0 && a[0] !== b[0];
}

/**
 * Whether two edition records are the same edition: they share an ASIN, a Goodreads id, a Hardcover id
 * or the ISBN, and disagree on none of them. A box set is one edition listed on each of its titles.
 */
function sameEdition(x, y){
  if(!isObject(x) || !isObject(y) || editionsConflict(x, y)) return false;
  if(EDITION_IDS.some(k => x[k] && x[k] === y[k])) return true;
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

/** Give edition `ed` (in place) what `from` has and it lacks. Nothing it has is changed. Returns the keys it gained. */
function fillEdition(ed, from){
  const gained = [];
  for(const k of EDITION_KEYS){
    if(from[k] !== undefined && ed[k] === undefined){ ed[k] = Array.isArray(from[k]) ? [...from[k]] : from[k]; gained.push(k); }
  }
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
 * An edition with several ISBNs becomes one edition per ISBN (splitIsbns), and the Hardcover book id
 * its editions held before it moved to the book ("hcb") goes on the book; when they name different
 * Hardcover books, `pickHcb(ids)` chooses (by default the first). An empty `e` is dropped.
 */
function fixEditions(rec, pickHcb){
  if(!isObject(rec)) return rec;
  const legacy = {}, out = {};
  for(const [k, v] of Object.entries(rec)){
    if(LEGACY_KEYS.includes(k)) legacy[k] = v; else if(k !== 'n') out[k] = v;
  }
  let editions = Array.isArray(rec.e) ? rec.e.flatMap(ed => isObject(ed) ? splitIsbns(ed) : [ed]) : rec.e;
  const fixedLegacy = Object.keys(legacy).length ? splitIsbns(legacy) : [];
  if(fixedLegacy.length){
    editions = Array.isArray(editions) ? editions.map(ed => isObject(ed) ? {...ed} : ed) : [];
    const [first, ...more] = fixedLegacy;
    const same = editions.find(ed => isObject(ed) && sameEdition(ed, first) && ['id', 'gr'].some(k => ed[k] && ed[k] === first[k]));
    if(same) fillEdition(same, first); else editions.unshift(orderEdition(first));
    editions.push(...more);
  }
  // A Hardcover book id an edition carries belongs to the book now.
  const hcbs = [];
  if(Array.isArray(editions)){
    editions = editions.map(ed => {
      if(!isObject(ed) || typeof ed.hcb !== 'string') return ed;
      const {hcb, ...rest} = ed;
      if(hcb.trim() && !hcbs.includes(hcb.trim())) hcbs.push(hcb.trim());
      return rest;
    }).filter(ed => !isObject(ed) || Object.keys(ed).length);
    // an edition that is just an ISBN another edition of the book has is that edition
    editions = editions.filter((ed, j) => !(isObject(ed) && Object.keys(ed).length === 1 && editionIsbns(ed).length &&
      editions.some((x, k) => k !== j && isObject(x) && editionIsbns(x)[0] === editionIsbns(ed)[0] && (Object.keys(x).length > 1 || k < j))));
  }
  if('n' in rec && !(typeof rec.n === 'string' && !rec.n.trim())){
    if(editions === undefined || (Array.isArray(editions) && !editions.length)) editions = [{n: rec.n}];
    else if(Array.isArray(editions)) editions = editions.map(ed => isObject(ed) && ed.n === undefined ? orderEdition({...ed, n: rec.n}) : ed);
    else out.n = rec.n;   // `e` is not a list: leave both for validate() to report
  }
  if(Array.isArray(editions) && !editions.length) editions = undefined;
  if(editions === undefined) delete out.e; else out.e = editions;
  if(hcbs.length && out.hcb === undefined) setHardcoverBook(out, pickHcb ? pickHcb(hcbs) : hcbs[0]);
  return out;
}

/** The narrators of a book's editions, without repeats, e.g. ["Ann Vale", "R. T. Hale"]. */
function bookNarrators(rec){
  return [...new Set(bookEditions(rec).flatMap(ed => fixNames(ed.n) || []).filter(n => typeof n === 'string' && n))];
}

/**
 * The parts of an edition as formatEdition() writes them, as [key, label, value] (the description has
 * no label), so the page can turn some of them into links.
 */
function editionParts(ed){
  const parts = [];
  if(ed.desc) parts.push(['desc', '', ed.desc]);
  if(ed.n && namesText(ed.n)) parts.push(['n', 'Narrated by', namesText(ed.n)]);
  if(ed.id) parts.push(['id', 'ASIN', ed.id]);
  if(ed.gr) parts.push(['gr', 'Goodreads', ed.gr]);
  if(ed.hc) parts.push(['hc', 'Hardcover', ed.hc]);
  if(typeof ed.isbn === 'string' && ed.isbn) parts.push(['isbn', 'ISBN', ed.isbn]);
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

const EDITION_PART = /^(asin|goodreads(?:\s+id)?|gr|hardcover(?:\s+book)?(?:\s+id)?|isbns?|publisher|released?|length|narrated\s+by|narrators?|description)\b:?\s*(.*)$/i;

/**
 * Read editions written one per line as formatEdition() writes them. Parts are separated by ';' and
 * start with their label; a bare ISBN, date or length is recognised without one, and other text
 * without a label is the edition's description (one per edition). A line with several ISBNs is that
 * many editions (splitIsbns). "Hardcover book 123" names the book, not the edition. An edition's address
 * on Hardcover (hardcover.app/books/the-salt-road/editions/501, with or without the label) gives its id.
 * Returns {editions, bad (the parts that could not be read), hcb (the Hardcover book id, or null)}.
 */
function parseEditions(text){
  const editions = [], bad = [];
  let hcb = null;
  for(const line of String(text || '').split(/\r\n|\r|\n/)){
    const ed = {};
    for(const part of line.split(';').map(x => tidyText(x)).filter(Boolean)){
      // an edition's address on Hardcover names the edition, a book's /id/ address the book
      const url = parseHardcoverUrl(part);
      if(url){
        if(url.edition) ed.hc = url.edition; else if(url.book) hcb = hcb || url.book; else bad.push(part);
        continue;
      }
      const m = EDITION_PART.exec(part);
      const label = m ? m[1].toLowerCase().replace(/\s+id$/, '') : '', value = m ? m[2].trim() : part;
      const isbns = parseIsbns(value), date = parseReadDate(value), minutes = parseLength(value);
      const allIsbns = isbns.isbns.length > 0 && !isbns.bad.length;
      let field = null, v = null;
      if(label === 'asin') [field, v] = ['id', value];
      else if(label === 'goodreads' || label === 'gr') [field, v] = ['gr', GOODREADS_ID.test(value) ? value : null];
      else if(label.startsWith('hardcover')){
        const kind = /book$/.test(label) ? 'book' : 'edition', url = parseHardcoverUrl(value);
        [field, v] = [kind === 'book' ? 'hcb' : 'hc', HARDCOVER_ID.test(value) ? value : url && url[kind] || null];
      }
      else if(label === 'publisher') [field, v] = ['p', value];
      else if(label.startsWith('narrat')) [field, v] = ['n', splitNames(value).length ? splitNames(value) : null];
      else if(label === 'description') [field, v] = ['desc', ed.desc ? null : value];
      else if(label.startsWith('releas')) [field, v] = ['d', date];
      else if(label === 'length') [field, v] = ['len', minutes];
      else if(label.startsWith('isbn') || (!label && allIsbns)) [field, v] = ['isbn', allIsbns ? isbns.isbns : null];
      else if(!label && date) [field, v] = ['d', date];
      else if(!label && minutes) [field, v] = ['len', minutes];
      else if(!label && !ed.desc) [field, v] = ['desc', value];
      if(!v){ bad.push(part); continue; }
      if(field === 'isbn') ed.isbn = [...new Set([...(ed.isbn || []), ...v])];
      else if(field === 'hcb') hcb = hcb || v;
      else ed[field] = v;
    }
    if(Object.keys(ed).length) editions.push(...splitIsbns(orderEdition(ed)));
  }
  return {editions, bad, hcb};
}

// The fields of the page's edition editor: [key, the label parseEditions() reads, the label the page shows].
const EDITION_FIELDS = [
  ['desc', 'Description', 'Description'], ['n', 'Narrated by', 'Narrators'],
  ['id', 'ASIN', 'ASIN'], ['gr', 'Goodreads', 'Goodreads id'], ['hc', 'Hardcover', 'Hardcover edition'],
  ['isbn', 'ISBN', 'ISBN'], ['p', 'Publisher', 'Publisher'], ['d', 'Released', 'Released'], ['len', 'Length', 'Length'],
];

/** An edition as the text of each of the editor's fields, e.g. {id: 'B0X', len: '10h 42m', n: 'Ann Vale, Bo Reed', ...}. */
function editionFields(ed){
  return Object.fromEntries(editionParts(ed).map(([k, , value]) => [k, value]));
}

/**
 * Read one edition from the editor's fields (as editionFields() gives them), checking each the way
 * parseEditions() checks a part with that label. Each field is read on its own, so a description or
 * narrator list may hold a ';'. Several ISBNs make that many editions (splitIsbns); a Hardcover book's
 * address in the Hardcover field names the book. Returns {editions (none when every field is empty),
 * bad (the fields that could not be read, as "Label value"), hcb (or null)}.
 */
function editionFromFields(fields){
  const ed = {}, bad = [];
  let hcb = null;
  for(const [k, label, shown] of EDITION_FIELDS){
    const value = tidyText(String(fields[k] || ''));
    if(!value) continue;
    if(k === 'desc'){ ed.desc = value; continue; }
    if(k === 'n'){ ed.n = splitNames(value); if(!ed.n.length) delete ed.n; continue; }
    const read = parseEditions(k === 'hc' && parseHardcoverUrl(value) ? value : `${label} ${value.replace(/;/g, ',')}`);
    const got = read.editions.flatMap(x => k === 'isbn' ? editionIsbns(x) : x[k] ? [x[k]] : []);
    if(read.hcb && k === 'hc') hcb = read.hcb;
    else if(read.bad.length || !got.length) bad.push(`${shown} ${value}`);
    else ed[k] = k === 'isbn' ? got : got[0];
  }
  return {editions: Object.keys(ed).length ? splitIsbns(orderEdition(ed)) : [], bad, hcb};
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
  const linked = (x, ed) => EDITION_IDS.some(f => ed[f] && x[f] === ed[f]) && !editionsConflict(x, ed);
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
        return {...ed};
      });
    }
  });
  if(index === null) books.push(rec); else books[index] = rec;
  return changed.size;
}

/**
 * fixReadDates(), fixEditions(), fixPeople() and fixSeriesTitle() on every book of a list; anything that is not a list
 * is returned as is. A book whose editions name several Hardcover books keeps the one no other book's
 * editions name (the others are a box set's, whose edition is on each of its titles).
 */
function fixBooks(books){
  if(!Array.isArray(books)) return books;
  const owners = new Map();   // Hardcover book id on editions -> how many books have it
  for(const b of books){
    const ids = new Set(bookEditions(b).map(ed => ed.hcb).filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()));
    for(const id of ids) owners.set(id, (owners.get(id) || 0) + 1);
  }
  const pickHcb = ids => ids.find(id => owners.get(id) === 1) || ids[0];
  return books.map(b => fixSeriesTitle(fixPeople(fixEditions(fixReadDates(b), pickHcb))));
}

function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Lower-case, drop accents ("é" -> "e") and collapse everything that is not a letter or digit, in any
 * script: "Сёмга" stays a word, so two books in Cyrillic or Japanese are told apart by their titles.
 */
function norm(text){
  return String(text || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * norm() as it was before it knew other scripts: everything but a-z and 0-9 dropped. Only for reading
 * "Not duplicates" marks written then (see duplicatePairKey).
 */
function asciiNorm(text){
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Key under which two series names count as the same series ('Ember Coast' == 'The Ember-Coast series'). */
function seriesNorm(name){
  return seriesKey(norm(name));
}

// The series key of a name already normalised: no leading "the", no word "series", no spaces.
const seriesKey = n => n.replace(/^the /, '').replace(/(^| )series(?= |$)/g, ' ').replace(/ /g, '');

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

// Names tidied (normalizeName), without the repeats that tidying reveals.
const tidyNames = names => {
  const out = names.map(x => typeof x === 'string' ? normalizeName(x) : x);
  return out.filter((x, i) => typeof x !== 'string' || out.indexOf(x) === i);
};

/** Return a copy of an edition with tidy text in every field, and its ISBN in the 13-digit form. */
function tidyEdition(ed){
  if(!isObject(ed)) return ed;
  const out = fixPeople({...ed});
  for(const key of ['id', 'gr', 'hc', 'p', 'd', 'desc']){
    if(typeof out[key] === 'string') out[key] = tidyText(out[key]);
  }
  if(Array.isArray(out.n)) out.n = tidyNames(out.n);
  // the 13-digit form; anything that is not an ISBN is kept (tidied) for validate() to report
  if(typeof out.isbn === 'string') out.isbn = parseIsbn(out.isbn) || tidyText(out.isbn);
  return out;
}

/** Return a copy of a book record, in the edition format, with tidy text in every field. */
function tidyBook(rec){
  const out = {...fixPeople(fixEditions(fixReadDates(rec)))};
  for(const key of ['t', 's', 'sn', 'hcb']){
    if(typeof out[key] === 'string') out[key] = tidyText(out[key]);
  }
  if(Array.isArray(out.a)) out.a = tidyNames(out.a);
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
  return norm(firstName(authors));
}

// The first author, cut as before authors were a list (a name with a comma in it is cut there), so keys
// made from it, like those of "Not duplicates" marks, stay the same.
const firstName = authors => String((Array.isArray(authors) ? authors[0] : authors) || '').split(/,| and | & /)[0];

// Keys are JSON-encoded arrays so they work as Map and Set keys.
const key = (...parts) => JSON.stringify(parts);

/**
 * Identity keys for a book, strongest first: its editions' ASINs, Goodreads and Hardcover ids, then its
 * Hardcover book id (another edition of it), then series, then title.
 */
function bookKeys(rec){
  const keys = [];
  for(const field of EDITION_IDS) for(const id of bookIdsOf(rec, field)) keys.push(key(field, id));
  if(typeof rec.hcb === 'string' && rec.hcb) keys.push(key('hcb', rec.hcb));
  // a title or series of only punctuation or symbols has an empty key, which must not match anything
  if(rec.s && rec.sn && seriesNorm(rec.s)) keys.push(key('series', firstAuthor(rec.a), seriesNorm(rec.s), String(rec.sn).trim()));
  if(norm(rec.t)) keys.push(key('title', norm(rec.t), firstAuthor(rec.a)));
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
    this.hcs = new Set();      // Hardcover edition ids
    this.lines = new Map();   // key -> the entry as written in data/excluded.txt
  }
  /**
   * Add one line of data/excluded.txt: an ASIN, "ISBN 978...", "Goodreads 12345", "Hardcover 12345" or
   * "Title | Author";
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
      const hc = HARDCOVER_ENTRY.exec(line);
      if(hc){
        if(this.hcs.has(hc[1])) return null;
        this.hcs.add(hc[1]);
        this.lines.set(key('hc', hc[1]), line = `Hardcover ${hc[1]}`);
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
      bookIdsOf(rec, 'hc').some(hc => this.hcs.has(hc)) ||
      (norm(rec.t) !== '' && this.titles.has(key(norm(rec.t), firstAuthor(rec.a)))) || bookIsbns(rec).some(isbn => this.isbns.has(isbn));
  }
  /** The entries, one per line as in data/excluded.txt, without comments. */
  get entries(){ return [...this.lines.values()]; }
  get size(){ return this.lines.size; }
}

// "Goodreads 12345" (or "GR 12345"): a Goodreads book id, which needs its prefix to tell it from an ASIN.
const GOODREADS_ENTRY = /^(?:goodreads|gr)(?:\s+id)?:?\s*(\d+)$/i;
// "Hardcover 12345": a Hardcover edition id.
const HARDCOVER_ENTRY = /^hardcover(?:\s+id)?:?\s*(\d+)$/i;

/**
 * Parse the text of data/excluded.txt: an ASIN, "ISBN 978...", "Goodreads 12345", "Hardcover 12345" or "Title | Author",
 * per line; '#' starts a comment.
 */
function parseExclusions(text){
  const ex = new Exclusions();
  for(const line of (text || '').split(/\r\n|\r|\n/)) ex.add(line);
  return ex;
}

/**
 * The data/excluded.txt entries that keep a removed book out of later imports: the ASINs, Goodreads
 * book ids and Hardcover edition ids of its editions, and "Title | Author" (for books with none). '#' and '|' would
 * break the line, and matching ignores punctuation anyway, so they are dropped.
 */
function exclusionEntries(rec){
  const clean = v => tidyText(String(v || '').replace(/[#|]/g, ' '));
  const entries = [];
  for(const id of bookIdsOf(rec, 'id')) if(clean(id)) entries.push(clean(id));
  for(const gr of bookIdsOf(rec, 'gr')) if(GOODREADS_ID.test(gr.trim())) entries.push(`Goodreads ${gr.trim()}`);
  for(const hc of bookIdsOf(rec, 'hc')) if(HARDCOVER_ID.test(hc.trim())) entries.push(`Hardcover ${hc.trim()}`);
  if(clean(rec.t) && clean(namesText(rec.a))) entries.push(`${clean(rec.t)} | ${clean(namesText(rec.a))}`);
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

// A list of names, as `a` and `n` hold them.
const nameList = v => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.trim() !== '');

/** Check one edition of a book; adds to `errors` and `warnings`. */
function validateEdition(ed, label, errors, warnings){
  const nonEmpty = v => typeof v === 'string' && v.trim() !== '';
  if(!isObject(ed)){ errors.push(`${label}: not an object`); return; }
  for(const k of Object.keys(ed)){
    if(!EDITION_KEYS.includes(k)) errors.push(`${label}: unknown key ${repr(k)}`);
  }
  for(const k of ['id', 'gr', 'hc', 'p', 'd', 'desc']){
    if(k in ed && !nonEmpty(ed[k])) errors.push(`${label}: ${repr(k)} must be a non-empty string when present`);
  }
  if('n' in ed && !nameList(ed.n)) errors.push(`${label}: 'n' must be a non-empty list of narrators' names`);
  if(!Object.keys(ed).length) errors.push(`${label}: is empty`);
  if(nonEmpty(ed.gr) && !GOODREADS_ID.test(ed.gr.trim())){
    errors.push(`${label}: 'gr' must be a Goodreads book id (digits only), not ${repr(ed.gr)}`);
  }
  if(nonEmpty(ed.hc) && !HARDCOVER_ID.test(ed.hc.trim())) errors.push(`${label}: 'hc' must be a Hardcover id (digits only), not ${repr(ed.hc)}`);
  if(nonEmpty(ed.d) && parseReadDate(ed.d) !== ed.d){
    errors.push(`${label}: 'd' must be a release date (YYYY-MM-DD, YYYY-MM or YYYY), not ${repr(ed.d)}`);
  }
  if('len' in ed && !(Number.isInteger(ed.len) && ed.len > 0)){
    errors.push(`${label}: 'len' must be the length in whole minutes`);
  }
  if('isbn' in ed){
    const isbn = nonEmpty(ed.isbn) ? parseIsbn(ed.isbn) : null;
    if(!nonEmpty(ed.isbn)) errors.push(`${label}: 'isbn' must be one ISBN (another ISBN is another edition)`);
    else if(!isbn) errors.push(`${label}: ${repr(ed.isbn)} is not a valid ISBN`);
    else if(isbn !== ed.isbn) warnings.push(`${label}: write ISBN ${repr(ed.isbn)} as ${repr(isbn)}`);
  }
}

/** Return {errors, warnings}. Errors block imports; warnings are worth a look. */
function validate(books, info){
  const errors = [], warnings = [];
  if(!Array.isArray(books)) return {errors: ['books.json must contain a list'], warnings};
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

  // ASIN / Goodreads id -> the first edition seen with it; a box set is one edition on several titles
  const seen = {id: new Map(), gr: new Map(), hc: new Map()};
  const names = {id: 'id', gr: 'Goodreads id', hc: 'Hardcover id'};
  books.forEach((b, i) => {
    const label = isObj(b) ? `book #${i} (${repr(b.t === undefined ? '?' : b.t)})` : `book #${i}`;
    if(!isObj(b)){ errors.push(`${label}: not an object`); return; }
    for(const k of Object.keys(b)){
      if(!BOOK_KEYS.includes(k)) errors.push(`${label}: unknown key ${repr(k)}`);
    }
    if(!nonEmpty(b.t)) errors.push(`${label}: missing 't'`);
    if(!('a' in b)) errors.push(`${label}: missing 'a'`);
    else if(!nameList(b.a)) errors.push(`${label}: 'a' must be a non-empty list of authors' names`);
    for(const k of ['s', 'sn', 'hcb']){
      if(k in b && !nonEmpty(b[k])) errors.push(`${label}: ${repr(k)} must be a non-empty string when present`);
    }
    if(nonEmpty(b.hcb) && !HARDCOVER_ID.test(b.hcb.trim())) errors.push(`${label}: 'hcb' must be a Hardcover book id (digits only), not ${repr(b.hcb)}`);
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
    const isbns = bookEditions(b).flatMap(editionIsbns);
    for(const isbn of new Set(isbns.filter((x, j) => isbns.indexOf(x) !== j))) warnings.push(`${label}: lists ISBN ${isbn} on two editions`);
    for(const ed of bookEditions(b)){
      for(const field of EDITION_IDS){
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
    for(const n of Array.isArray(ed.n) ? ed.n : []){
      if(typeof n === 'string' && normalizeName(n) !== n) untidy.set(key('narrator', n), ['narrator', n, normalizeName(n)]);
    }
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
 * Read a backup exported from the page: {books: [...], seriesInfo: {...}, excluded: [...],
 * notDuplicates: [...]}, or a plain array of books from before series info was exported. Returns
 * {books, seriesInfo, excluded, notDuplicates}; seriesInfo, excluded (the data/excluded.txt entries)
 * and notDuplicates (the data/not-duplicates.txt entries) are null when the backup predates them, so
 * callers leave theirs alone. Throws if it is neither.
 */
function readBackup(data){
  if(Array.isArray(data)) return {books: fixBooks(data), seriesInfo: null, excluded: null, notDuplicates: null};
  if(data && typeof data === 'object' && Array.isArray(data.books)){
    const {seriesInfo: info, excluded, notDuplicates} = data;
    if(info !== undefined && !(info && typeof info === 'object' && !Array.isArray(info))) throw new Error('seriesInfo is not an object');
    for(const [name, list] of [['excluded', excluded], ['notDuplicates', notDuplicates]]){
      if(list !== undefined && !(Array.isArray(list) && list.every(x => typeof x === 'string'))){
        throw new Error(`${name} is not a list of strings`);
      }
    }
    return {books: fixBooks(data.books), seriesInfo: info === undefined ? null : info, excluded: excluded === undefined ? null : excluded,
      notDuplicates: notDuplicates === undefined ? null : notDuplicates};
  }
  throw new Error('expected a list of books or {books, seriesInfo, excluded}');
}

/**
 * The entries of data/not-duplicates.txt: one duplicatePairKey() or editionsKey() per line, for the
 * books the duplicates page was told are different books (or have different editions). Lines
 * starting with '#' are comments.
 */
function parseNotDuplicates(text){
  return [...new Set(String(text || '').split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')))];
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
  // a box set's range stays: "Ember: Books 1-3" is the set's name, which the merge keeps on its edition
  if(number && !BOX_RANGE.test(number)){
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
  let rec = {t: cleanTitle(title, series ? number : null), a: splitNames(cell(row, 'Authors'))};
  if(series){
    rec.s = series;
    if(number) rec.sn = number;
  }
  let tags = (row.Tags || '').split(',').map(t => t.trim()).filter(Boolean);
  if(!tags.length && cell(row, 'Child Category')) tags = [cell(row, 'Child Category')];
  if(tags.length) rec.g = tags;
  const edition = {};
  if(asin) edition.id = asin;
  if(splitNames(cell(row, 'Narrators')).length) edition.n = splitNames(cell(row, 'Narrators'));
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

// ------------------------------------------------------- series from Audible's catalogue
// Audible's catalogue API answers without a login, one host per store. The CLI does the fetching;
// these functions only build the addresses and read the answers, so they can be tested offline.
const AUDIBLE_STORES = {us: 'audible.com', uk: 'audible.co.uk', de: 'audible.de', fr: 'audible.fr', it: 'audible.it',
  es: 'audible.es', ca: 'audible.ca', au: 'audible.com.au', in: 'audible.in', jp: 'audible.co.jp'};

/** The catalogue address of a product (a book, or a series by its own ASIN) in one store. */
function audibleProductUrl(asin, store, groups){
  return `https://api.${AUDIBLE_STORES[store]}/1.0/catalog/products/${encodeURIComponent(asin)}?response_groups=${groups}`;
}

/** The series a catalogue product belongs to: [{name, number, asin}]; [] when none. */
function audibleSeries(json){
  const list = json && json.product && Array.isArray(json.product.series) ? json.product.series : [];
  return list.filter(isObject).map(x => ({
    name: tidyText(String(x.title || '')),
    number: SERIES_NUMBER.test(String(x.sequence || '').trim()) ? String(x.sequence).trim() : null,
    asin: typeof x.asin === 'string' ? x.asin : null,
  })).filter(x => x.name);
}

/**
 * How many books of a series are out, from the series' own catalogue product: the highest whole
 * number among its titles (a boxed set "1-3" counts up to 3, a novella "2.5" adds nothing).
 * Returns null when the answer lists no numbered titles.
 */
function audibleSeriesTotal(json){
  const rels = json && json.product && Array.isArray(json.product.relationships) ? json.product.relationships : [];
  let total = 0;
  for(const r of rels){
    if(!isObject(r) || r.relationship_to_product !== 'child') continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(String(r.sequence || '').trim());
    if(m) total = Math.max(total, parseInt(m[2] || m[1], 10));
  }
  return total || null;
}

/**
 * A series' own catalogue product as the lookups use it: {total: audibleSeriesTotal(), titles: the title
 * of each whole-numbered book, {"1": "Spark", ...}, the first listed when Audible has several}.
 */
function audibleSeriesListing(json){
  const rels = json && json.product && Array.isArray(json.product.relationships) ? json.product.relationships : [];
  const titles = {};
  for(const r of rels){
    if(!isObject(r) || r.relationship_to_product !== 'child') continue;
    const number = String(r.sequence || '').trim(), title = tidyText(String(r.title || ''));
    if(/^\d+$/.test(number) && title && !(String(Number(number)) in titles)) titles[String(Number(number))] = title;
  }
  return {total: audibleSeriesTotal(json), titles};
}

/** The name an import gives a box set's title it doesn't know yet, until Audible names it: "Ember, Book 2". */
function boxSetTitle(series, number){
  return `${series}, Book ${number}`;
}

const isBoxSetTitle = b => !!(b && b.s && b.sn && b.t === boxSetTitle(b.s, b.sn));

/** ASINs that appear on more than one book: box sets, whose series number is the set's, not the title's. */
function sharedAsins(books){
  const seen = new Set(), shared = new Set();
  for(const b of books) for(const id of new Set(bookEditions(b).map(ed => ed.id).filter(Boolean))){
    (seen.has(id) ? shared : seen).add(id);
  }
  return shared;
}

/**
 * The ASINs to look up for seriesFromAudible(): every book with no series or no number, and one
 * book of each series that has no release info yet or a box set's title still named boxSetTitle() (to
 * learn the series' own ASIN). `only` (books
 * of `books`, e.g. the ones an import just added) limits that to those books and their series.
 */
function seriesLookups(books, info, only){
  const asins = new Set(), covered = new Set();
  const own = b => bookEditions(b).map(ed => ed.id).filter(Boolean);
  const wanted = only || books;
  for(const b of wanted){
    if(!b.s || !b.sn) own(b).forEach(id => asins.add(id));
  }
  const shared = sharedAsins(books);
  for(const b of wanted){
    // a series with release info is looked up all the same when a box set's title waits for its name
    if(!b.s || (info && Object.prototype.hasOwnProperty.call(info, b.s) && !isBoxSetTitle(b)) || covered.has(b.s)) continue;
    const id = own(b).find(x => !shared.has(x)) || own(b)[0];
    if(id){ asins.add(id); covered.add(b.s); }
  }
  return [...asins];
}

/**
 * Fill in series from Audible's answers (`found`: Map of ASIN -> audibleSeries() list), never
 * changing a value you have: a book with no series gets Audible's (a parent series over its
 * sub-series, as imports pick it) and its number; a book with a series but no number gets the
 * number when Audible files it under that series. A number taken from a box set's ASIN is skipped.
 * Changes `books` in place. Returns {filled: [books], series: Map of your series name -> its Audible
 * ASIN, warnings}.
 */
function seriesFromAudible(books, found){
  const report = {filled: [], series: new Map(), warnings: []};
  const canonical = new Map();
  for(const b of books) if(b.s && !canonical.has(seriesNorm(b.s))) canonical.set(seriesNorm(b.s), b.s);
  const shared = sharedAsins(books);

  for(const b of books){
    for(const ed of bookEditions(b)){
      const list = ed.id && found.get(ed.id);
      if(!list || !list.length) continue;
      const boxSet = shared.has(ed.id);
      if(!b.s){
        const [name, number, ambiguous] = chooseSeries(list.map(x => [x.name, x.number]));
        const k = seriesNorm(name);
        if(!canonical.has(k)) canonical.set(k, name);
        b.s = canonical.get(k);
        if(number && !boxSet) b.sn = number;
        report.filled.push(b);
        if(ambiguous) report.warnings.push(`${repr(b.t)}: Audible lists several series (${list.map(x => x.name).join(', ')}); using ${repr(b.s)}`);
      } else if(!b.sn && !boxSet){
        const same = list.find(x => seriesNorm(x.name) === seriesNorm(b.s) && x.number);
        if(same){ b.sn = same.number; report.filled.push(b); }
      }
      for(const x of list){
        const name = canonical.get(seriesNorm(x.name));
        if(name && x.asin && !report.series.has(name)) report.series.set(name, x.asin);
      }
      if(b.s && b.sn) break;
    }
  }
  return report;
}

/**
 * The series ASINs to fetch audibleSeriesListing() for, from seriesFromAudible()'s `series` (Map of name
 * -> series ASIN): the series with no entry in `info`, and those with a box set's title still named
 * boxSetTitle().
 */
function seriesListingLookups(books, info, series){
  const unnamed = new Set(books.filter(isBoxSetTitle).map(b => b.s));
  return [...series].filter(([name]) => !Object.prototype.hasOwnProperty.call(info, name) || unnamed.has(name)).map(([, asin]) => asin);
}

/**
 * Name the box sets' titles that an import added as boxSetTitle() ("Ember, Book 2") after the book of
 * that number in their series' Audible listing (`series`: Map of name -> series ASIN, `listings`: Map of
 * series ASIN -> audibleSeriesListing()). No other title is changed. Changes `books` in place; returns
 * [[book, the title it had]].
 */
function boxSetTitlesFromAudible(books, series, listings){
  const renamed = [];
  for(const b of books){
    if(!isBoxSetTitle(b) || !series.has(b.s)) continue;
    const listing = listings.get(series.get(b.s));
    const title = listing && listing.titles && listing.titles[String(Number(b.sn))];
    if(!title) continue;
    const old = b.t, fixed = fixSeriesTitle({...b, t: title});
    b.t = fixed.s === b.s && fixed.sn === b.sn ? fixed.t : title;
    renamed.push([b, old]);
  }
  return renamed;
}

/**
 * Give each series in `series` (seriesFromAudible()'s Map of name -> Audible series ASIN) that has no
 * entry in `info` a released total from `totals` (Map of series ASIN -> audibleSeriesListing(), or its
 * total alone). Audible
 * only lists what is out, so the entry says "ongoing" and asks whether the series is finished.
 * Changes `info` in place; returns the names given a total.
 */
function addSeriesTotals(info, series, totals, store, today){
  const added = [];
  for(const [name, asin] of series){
    const listing = totals.get(asin), total = isObject(listing) ? listing.total : listing;
    if(Object.prototype.hasOwnProperty.call(info, name) || !total) continue;
    info[name] = {total, status: 'ongoing', note: `${total} released on ${AUDIBLE_STORES[store]} as of ${today}; is it complete?`};
    added.push(name);
  }
  return added;
}

// ------------------------------------------------------------------ Goodreads
// Goodreads has no "audiobook" flag; the edition's binding is the best signal there is.
const AUDIO_BINDINGS = new Set(['Audio CD', 'Audiobook', 'Audible Audio', 'MP3 CD', 'MP3 Book', 'Audio']);
const PAREN = /^(.*?)\s*\(([^()]+)\)\s*$/;
const SERIES_MARKER = new RegExp('(#|' + WORD_START + 'book(?![\\p{L}\\p{N}_])|' + WORD_START + 'vol(?![\\p{L}\\p{N}_]))', 'iu');

// A series number, or a box set's range ("#1-3", "#1–3").
const GOODREADS_NUMBER = /\d+(?:\.\d+)?(?:\s*[-\u2013]\s*\d+(?:\.\d+)?)?/;
const goodreadsNumber = text => text.replace(/\s*[-\u2013]\s*/, '-');

/** "Frosted (Blaze, #6; Dana O'Hare, #1)" -> ["Frosted", "Blaze", "6"]; a box set's "(Ember, #1-3)" gives "1-3". */
function parseGoodreadsTitle(raw){
  const m = PAREN.exec(raw.trim());
  if(!m) return [raw.trim(), null, null];
  const clean = m[1].trim(), inner = m[2].trim();
  const first = inner.split(';')[0].trim();          // only the first series when several are listed
  const comma = first.lastIndexOf(',');
  const name = comma >= 0 ? first.slice(0, comma) : '';
  const tail = comma >= 0 ? first.slice(comma + 1) : first;
  if(name && SERIES_MARKER.test(tail)){
    const num = GOODREADS_NUMBER.exec(tail);
    return [clean, name.trim(), num ? goodreadsNumber(num[0]) : null];
  }
  const m2 = new RegExp('^(.*?)\\s*#\\s*(' + GOODREADS_NUMBER.source + ')$').exec(first);
  if(m2) return [clean, m2[1].trim(), goodreadsNumber(m2[2])];
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
    let rec = {t: title, a: splitNames(cell(row, 'Author'))};
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
    if(splitNames(cell(row, 'Additional Authors')).length) edition.n = splitNames(cell(row, 'Additional Authors'));
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

// The columns of a Goodreads library export, which is also what goodreads.com/review/import takes.
const GOODREADS_COLUMNS = ['Book Id', 'Title', 'Author', 'Additional Authors', 'ISBN', 'ISBN13', 'Publisher', 'Binding',
  'Year Published', 'Date Read', 'Bookshelves', 'Exclusive Shelf', 'Read Count'];

const csvField = v => /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;

// Goodreads shelf names are lower case with hyphens: "Science Fiction" -> "science-fiction".
const goodreadsShelf = g => String(g).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

/** The 10-digit form of a 978 ISBN, or '' (979 ISBNs have none). */
function isbn10Of(isbn13){
  if(!isbn13.startsWith('978')) return '';
  const nine = isbn13.slice(3, 12);
  const check = (11 - [...nine].reduce((sum, c, i) => sum + (10 - i) * Number(c), 0) % 11) % 11;
  return nine + (check === 10 ? 'X' : String(check));
}

/**
 * The edition Goodreads should find a book by: one of its own (a box set's edition is on several titles,
 * and its ids would make Goodreads file every one of them as the box set), with a Goodreads id and an
 * ISBN if possible. `shared` tells whether an id or ISBN is on another book too.
 */
function goodreadsEdition(rec, shared){
  const own = bookEditions(rec).filter(ed => !shared(ed));
  const rank = ed => (ed.gr ? 2 : 0) + (editionIsbns(ed).length ? 1 : 0);
  return own.reduce((best, ed) => (!best || rank(ed) > rank(best) ? ed : best), null);
}

/**
 * Write the catalogue as a Goodreads library export CSV, which Goodreads' import accepts: every book on
 * the "read" shelf, with its series in the title as Goodreads writes it, its genres as shelves, and the
 * Goodreads id and ISBNs of one edition so Goodreads picks that edition (without them it goes by title and
 * author). Goodreads keeps one date read, so a book gets its latest full date; a book without one (no `r`,
 * or only "2024-03") goes on the shelf with no date. Returns {csv, books, withoutIds, withoutDate}.
 */
function goodreadsCsv(books){
  const owners = new Map();   // "gr:123" / "id:B0..." / "isbn:978..." -> books carrying it
  const edKeys = ed => [...['id', 'gr'].filter(k => ed[k]).map(k => k + ':' + ed[k]), ...editionIsbns(ed).map(i => 'isbn:' + i)];
  books.forEach(rec => bookEditions(rec).forEach(ed => edKeys(ed).forEach(k => {
    if(!owners.has(k)) owners.set(k, new Set());
    owners.get(k).add(rec);
  })));
  const report = {books: 0, withoutIds: 0, withoutDate: 0};
  const lines = [GOODREADS_COLUMNS.join(',')];
  for(const rec of books){
    const authors = (fixNames(rec && rec.a) || []).filter(x => typeof x === 'string');
    if(!isObject(rec) || !rec.t || !authors.length) continue;
    const ed = goodreadsEdition(rec, x => edKeys(x).some(k => owners.get(k).size > 1)) || {};
    const isbn = editionIsbns(ed)[0] || '';
    const series = rec.s ? ` (${rec.s}${rec.sn ? ', #' + rec.sn : ''})` : '';
    const dates = (Array.isArray(rec.r) ? rec.r : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const row = {
      'Book Id': ed.gr || '',
      'Title': rec.t + series,
      'Author': authors[0],
      'Additional Authors': authors.slice(1).join(', '),
      'ISBN': isbn10Of(isbn),
      'ISBN13': isbn,
      'Publisher': ed.p || '',
      'Binding': ed.id ? 'Audible Audio' : 'Audiobook',
      'Year Published': ed.d ? String(ed.d).slice(0, 4) : '',
      'Date Read': dates.length ? dates[dates.length - 1].replace(/-/g, '/') : '',
      'Bookshelves': (Array.isArray(rec.g) ? rec.g : []).map(goodreadsShelf).filter(Boolean).join(', '),
      'Exclusive Shelf': 'read',
      'Read Count': Array.isArray(rec.r) && rec.r.length ? String(rec.r.length) : '',
    };
    lines.push(GOODREADS_COLUMNS.map(c => csvField(row[c])).join(','));
    report.books++;
    if(!ed.gr && !isbn) report.withoutIds++;
    if(!dates.length) report.withoutDate++;
  }
  return {csv: lines.join('\n') + '\n', ...report};
}

// ------------------------------------------------------------------ Hardcover
// Hardcover's GraphQL API needs your personal token and must not be called from a browser, so the CLI
// does the asking (catalog.js). These functions only write the queries and read the answers, so they
// can be tested offline. Queries stay within three levels of nesting, which Hardcover plans to enforce.
const HARDCOVER_API = 'https://api.hardcover.app/v1/graphql';
// Hardcover's shelves (user_books.status_id): only "Read" is a finished book.
const HARDCOVER_STATUSES = {1: 'Want to Read', 2: 'Currently Reading', 3: 'Read', 4: 'Paused', 5: 'Did Not Finish', 6: 'Ignored'};
const HARDCOVER_READ = 3;
const HARDCOVER_AUDIO = 2;          // editions.reading_format_id of an audiobook
const HARDCOVER_PAGE = 100;         // shelf entries per request
const HARDCOVER_BATCH = 50;         // ids per lookup

const HARDCOVER_QUERIES = {
  me: 'query { me { id } }',
  shelf: `query Shelf($user: Int!, $offset: Int!) {
  user_books(where: {user_id: {_eq: $user}}, order_by: {id: asc}, limit: ${HARDCOVER_PAGE}, offset: $offset) {
    id book_id edition_id status_id
    user_book_reads(order_by: {id: asc}) { finished_at edition_id }
  }
}`,
  books: `query Books($ids: [Int!]) {
  books(where: {id: {_in: $ids}}) {
    id title
    contributions { contribution author { name } }
    featured_book_series { position series { name } }
  }
}`,
  editions: `query Editions($ids: [Int!]) {
  editions(where: {id: {_in: $ids}}) {
    id book_id asin isbn_13 isbn_10 release_date audio_seconds reading_format_id
    publisher { name }
    contributions { contribution author { name } }
  }
}`,
  addBook: `mutation AddBook($object: UserBookCreateInput!) { insert_user_book(object: $object) { id error } }`,
  bookBySlug: `query BookBySlug($slug: String!) {
  books(where: {slug: {_eq: $slug}}, limit: 1) { id canonical_id title }
}`,
  editionBook: `query EditionBook($id: Int!) {
  editions(where: {id: {_eq: $id}}) { book_id book { title } }
}`,
  addRead: `mutation AddRead($id: Int!, $read: DatesReadInput!) { insert_user_book_read(user_book_id: $id, user_book_read: $read) { id error } }`,
};

/**
 * The query that finds Hardcover editions and books for your editions' ids: by Hardcover edition id,
 * ASIN, ISBN-13 and Goodreads id (Hardcover's mapping of Goodreads books), only the parts with ids.
 * Returns {query, variables}, or null when there is nothing to look up.
 */
function hardcoverFindQuery(ids){
  const parts = [], vars = [], variables = {};
  const fields = 'id book_id asin isbn_13 reading_format_id';
  const add = (name, type, list, part) => {
    if(!list || !list.length) return;
    vars.push(`$${name}: ${type}`);
    variables[name] = list;
    parts.push(part);
  };
  add('hc', '[Int!]', ids.hc, `byId: editions(where: {id: {_in: $hc}}) { ${fields} }`);
  add('asin', '[String!]', ids.asin, `byAsin: editions(where: {asin: {_in: $asin}}) { ${fields} }`);
  add('isbn', '[String!]', ids.isbn, `byIsbn: editions(where: {isbn_13: {_in: $isbn}}) { ${fields} }`);
  add('gr', '[String!]', ids.gr,
    'byGoodreads: book_mappings(where: {platform: {name: {_eq: "Goodreads"}}, external_id: {_in: $gr}}) { book_id external_id }');
  if(!parts.length) return null;
  return {query: `query Find(${vars.join(', ')}) {\n  ${parts.join('\n  ')}\n}`, variables};
}

/** Names from a Hardcover contributions list, as a list: the authors (no role, or "Author"), or those with `role`. */
function hardcoverPeople(contributions, role){
  const names = (Array.isArray(contributions) ? contributions : []).filter(c => isObject(c) &&
    (role ? c.contribution === role : !c.contribution || c.contribution === 'Author'))
    .map(c => isObject(c.author) && typeof c.author.name === 'string' ? tidyText(c.author.name) : '').filter(Boolean);
  return [...new Set(names)];
}

/** One of your editions made from a Hardcover edition. */
function hardcoverEdition(edition){
  const ed = {hc: String(edition.id)};
  if(typeof edition.asin === 'string' && /^[A-Z0-9]{10}$/.test(edition.asin.trim())) ed.id = edition.asin.trim();
  // the ISBN-10 and ISBN-13 of an edition are one ISBN; should they differ, the ISBN-13 wins
  const isbn = [edition.isbn_13, edition.isbn_10].map(parseIsbn).find(Boolean);
  if(isbn) ed.isbn = isbn;
  const narrators = hardcoverPeople(edition.contributions, 'Narrator');
  if(narrators.length) ed.n = narrators;
  if(isObject(edition.publisher) && typeof edition.publisher.name === 'string' && tidyText(edition.publisher.name)) ed.p = tidyText(edition.publisher.name);
  const released = parseReadDate(edition.release_date);
  if(released) ed.d = released;
  if(Number.isInteger(edition.audio_seconds) && edition.audio_seconds >= 60) ed.len = Math.round(edition.audio_seconds / 60);
  return orderEdition(ed);
}

/** "2" for a position of 2, "2.5" for 2.5; null when there is none. */
function hardcoverPosition(position){
  return typeof position === 'number' && position >= 0 ? String(position) : null;
}

/**
 * Your books from your Hardcover shelf: `userBooks` (user_books rows), with `books` and `editions` as
 * Maps of id -> the rows the books and editions queries answered. Only books on the Read shelf are kept,
 * each with its finished dates (no date stays unknown, as in the catalogue). Returns {records, audio
 * (the records whose edition is an audiobook), otherShelves (how many are on other shelves), warnings}.
 */
function readHardcover(userBooks, books, editions){
  const result = {records: [], audio: new Set(), otherShelves: 0, warnings: []};
  for(const ub of userBooks){
    if(!isObject(ub)) continue;
    if(ub.status_id !== HARDCOVER_READ){ result.otherShelves++; continue; }
    const book = books.get(ub.book_id);
    if(!book || typeof book.title !== 'string' || !tidyText(book.title)){
      result.warnings.push(`Hardcover book ${ub.book_id}: not found, skipped`);
      continue;
    }
    const edition = ub.edition_id ? editions.get(ub.edition_id) : null;
    let rec = {t: tidyText(book.title), a: hardcoverPeople(book.contributions)};
    if(!rec.a.length){
      result.warnings.push(`${repr(rec.t)}: no author on Hardcover, skipped`);
      continue;
    }
    const series = isObject(book.featured_book_series) ? book.featured_book_series : null;
    if(series && isObject(series.series) && typeof series.series.name === 'string' && tidyText(series.series.name)){
      rec.s = tidyText(series.series.name);
      const number = hardcoverPosition(series.position);
      if(number) rec.sn = number;
    }
    const reads = Array.isArray(ub.user_book_reads) ? ub.user_book_reads : [];
    const dates = [...new Set(reads.map(r => isObject(r) && parseReadDate(r.finished_at)).filter(Boolean))].sort();
    if(dates.length) rec.r = dates;
    rec.hcb = String(ub.book_id);
    if(isObject(edition)) rec.e = [hardcoverEdition(edition)];
    rec = tidyBook(fixSeriesTitle(rec));
    result.records.push(rec);
    if(edition && edition.reading_format_id === HARDCOVER_AUDIO) result.audio.add(rec);
  }
  return result;
}

/**
 * What a Find query answered, as the Hardcover ids of each of your ids: {hc, asin, isbn, gr}, Maps of
 * your id -> {hc (null when only the book is known, or the edition is not an audiobook), hcb}. An ISBN or
 * Goodreads id names a book, but its edition is often the print one, so only an audiobook edition counts.
 */
function hardcoverMatches(data){
  const out = {hc: new Map(), asin: new Map(), isbn: new Map(), gr: new Map()};
  const list = name => data && Array.isArray(data[name]) ? data[name].filter(isObject) : [];
  const audio = ed => ed.reading_format_id === HARDCOVER_AUDIO;
  const put = (map, k, v) => { if(!map.has(k) || (!map.get(k).hc && v.hc)) map.set(k, v); };
  for(const ed of list('byId')) put(out.hc, String(ed.id), {hc: String(ed.id), hcb: String(ed.book_id)});
  for(const ed of list('byAsin')) if(ed.asin) put(out.asin, ed.asin, {hc: String(ed.id), hcb: String(ed.book_id)});
  for(const ed of list('byIsbn')) if(ed.isbn_13) put(out.isbn, ed.isbn_13, {hc: audio(ed) ? String(ed.id) : null, hcb: String(ed.book_id)});
  for(const m of list('byGoodreads')) if(m.external_id) put(out.gr, String(m.external_id), {hc: null, hcb: String(m.book_id)});
  return out;
}

/** The Hardcover edition ids planHardcoverExport() may send, as numbers: those of books with a Hardcover book id. */
function hardcoverExportEditions(books){
  const ids = books.filter(b => isObject(b) && b.hcb).flatMap(bookEditions).map(ed => ed.hc).filter(hc => typeof hc === 'string' && HARDCOVER_ID.test(hc));
  return [...new Set(ids)].map(Number);
}

/** The ids that hardcoverFindQuery() should look up: those of the editions of books without a Hardcover book id. */
function hardcoverLookups(books){
  const ids = {hc: new Set(), asin: new Set(), isbn: new Set(), gr: new Set()};
  for(const ed of books.filter(b => isObject(b) && !b.hcb).flatMap(bookEditions)){
    if(ed.hc && HARDCOVER_ID.test(ed.hc)) ids.hc.add(Number(ed.hc));
    if(ed.id) ids.asin.add(ed.id);
    editionIsbns(ed).forEach(isbn => ids.isbn.add(isbn));
    if(ed.gr) ids.gr.add(ed.gr);
  }
  return Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, [...v]]));
}

/**
 * A test of whether an edition is also on another of `books` (a box set's edition, on each of its
 * titles): it shares an ASIN, Goodreads id, Hardcover id or ISBN with an edition of another book.
 */
function sharedEditionTest(books){
  const ids = ed => [...EDITION_IDS.filter(k => ed[k]).map(k => k + ' ' + ed[k]), ...editionIsbns(ed).map(x => 'isbn ' + x)];
  const owners = new Map();
  for(const b of books) for(const id of new Set(bookEditions(b).flatMap(ids))) owners.set(id, (owners.get(id) || 0) + 1);
  return ed => ids(ed).some(id => owners.get(id) > 1);
}

/** Give a book (in place) a Hardcover book id, keeping its keys in the usual order. */
function setHardcoverBook(rec, id){
  const editions = rec.e;
  delete rec.e;
  rec.hcb = id;
  if(editions !== undefined) rec.e = editions;
}

/**
 * Give your books and editions the Hardcover ids found for them (`found`: merged hardcoverMatches()),
 * strongest id first: the Hardcover edition id, the ASIN, the ISBN, the Goodreads id. A book without a
 * Hardcover book id gets the one of its editions' Hardcover book (an edition of its own before a box
 * set's), and its editions their Hardcover edition ids. Only empty values are filled. Changes `books`
 * in place (a box set's copies alike, as they carry the same ids); returns the books that gained an id.
 */
function addHardcoverIds(books, found){
  const filled = [], shared = sharedEditionTest(books);
  for(const b of books){
    if(!isObject(b) || b.hcb) continue;
    let gained = false;
    const editions = bookEditions(b);
    for(const ed of [...editions.filter(x => !shared(x)), ...editions.filter(shared)]){
      const hit = (ed.hc && found.hc.get(ed.hc)) || (ed.id && found.asin.get(ed.id)) ||
        editionIsbns(ed).map(isbn => found.isbn.get(isbn)).find(Boolean) || (ed.gr && found.gr.get(ed.gr));
      if(!hit) continue;
      if(hit.hc && !ed.hc && fillEdition(ed, {hc: hit.hc}).length) gained = true;
      if(!b.hcb){ setHardcoverBook(b, hit.hcb); gained = true; }
    }
    if(gained) filled.push(b);
  }
  return filled;
}

/**
 * What an export to Hardcover would do: each of your books goes on your Read shelf as its Hardcover book,
 * as the Hardcover edition of an edition of its own (or a box set's, when the box set is the Hardcover
 * book), with its exact dates read as reads.
 * `shelf` is your user_books rows. Nothing on Hardcover is changed: a book already on another shelf is
 * left alone, and a book already on Read only gains the reads it lacks. Dates you only know to the month
 * or year can't be a Hardcover read, so they are listed instead.
 * `editionBooks`, when given, maps your editions' Hardcover edition ids to the Hardcover book each is an
 * edition of (as Hardcover says): only an edition of the book's own Hardcover book is sent, since a box
 * set's edition can be on a title whose Hardcover book is that title. Without it, a box set's edition
 * (one on several of your books) is only sent for a box set (a Hardcover book several books are).
 * Returns {add: [{book (Hardcover book id), edition (or null), dates, recs}], reads: [{userBook, edition,
 * dates, recs}], otherShelf: [[rec, status name]], unknown: [recs without a Hardcover book], inexact: [[rec, date]]}.
 */
function planHardcoverExport(books, shelf, editionBooks){
  const plan = {add: [], reads: [], otherShelf: [], unknown: [], inexact: []};
  const onShelf = new Map();
  for(const ub of shelf) if(isObject(ub) && !onShelf.has(ub.book_id)) onShelf.set(ub.book_id, ub);
  const owners = new Map();   // Hardcover book id -> how many of your books are it
  for(const b of books) if(isObject(b) && b.hcb) owners.set(b.hcb, (owners.get(b.hcb) || 0) + 1);
  const shared = sharedEditionTest(books);
  const wanted = new Map();   // Hardcover book id -> {edition, dates, recs}
  for(const b of books){
    if(!isObject(b)) continue;
    if(!b.hcb){ plan.unknown.push(b); continue; }
    const editions = bookEditions(b).filter(ed => ed.hc);
    const ed = editionBooks ? editions.find(x => editionBooks.get(x.hc) === b.hcb)
      : editions.find(x => !shared(x)) || (owners.get(b.hcb) > 1 ? editions[0] : null);
    const exact = (Array.isArray(b.r) ? b.r : []).filter(d => /^\d{4}-\d\d-\d\d$/.test(d));
    for(const d of Array.isArray(b.r) ? b.r : []) if(!exact.includes(d)) plan.inexact.push([b, d]);
    const w = wanted.get(b.hcb) || {edition: null, dates: new Set(), recs: []};
    if(!w.edition && ed) w.edition = ed.hc;
    exact.forEach(d => w.dates.add(d));
    w.recs.push(b);
    wanted.set(b.hcb, w);
  }
  for(const [hcb, w] of wanted){
    const book = Number(hcb), edition = w.edition ? Number(w.edition) : null, dates = [...w.dates].sort();
    const ub = onShelf.get(book);
    if(!ub){ plan.add.push({book, edition, dates, recs: w.recs}); continue; }
    if(ub.status_id !== HARDCOVER_READ){
      for(const rec of w.recs) plan.otherShelf.push([rec, HARDCOVER_STATUSES[ub.status_id] || `status ${ub.status_id}`]);
      continue;
    }
    const have = (Array.isArray(ub.user_book_reads) ? ub.user_book_reads : []).map(r => isObject(r) && r.finished_at).filter(Boolean);
    const missing = dates.filter(d => !have.includes(d));
    if(missing.length) plan.reads.push({userBook: ub.id, edition, dates: missing, recs: w.recs});
  }
  return plan;
}

/**
 * What an address on Hardcover names: {book} for hardcover.app/id/book/77; {edition, slug} for an
 * edition's page, hardcover.app/books/the-salt-road/editions/501 (or {edition} for /id/edition/501); {slug}
 * for a book's page, hardcover.app/books/the-salt-road, which only Hardcover can turn into the book's id
 * (hardcoverBookId). The ids are text, like `hc` and `hcb`. The scheme, "www." and anything after the id
 * may be there or not. null when it is not such an address.
 */
function parseHardcoverUrl(text){
  const m = /^(?:https?:\/\/)?(?:www\.)?hardcover\.app(\/[^?#\s]*)?(?:[?#]\S*)?$/i.exec(String(text || '').trim());
  if(!m) return null;
  const [first, second, third, fourth] = (m[1] || '').split('/').filter(Boolean);
  const id = x => HARDCOVER_ID.test(x || '') ? x : null;
  if(first === 'id' && id(third)){
    if(/^books?$/.test(second)) return {book: third};
    if(/^editions?$/.test(second)) return {edition: third};
  }
  if(first === 'books' && second){
    if(third === 'editions') return id(fourth) ? {edition: fourth, slug: second} : null;
    return {slug: second};
  }
  return null;
}

/**
 * The Hardcover book that `text` names (a book id, or an address as parseHardcoverUrl reads it), asking
 * Hardcover through `ask` (hardcoverAsker) only when the address doesn't hold the book's id: a book's page
 * by its slug, an edition by the edition's book. Returns {id, title (when Hardcover was asked)}; throws with a
 * short reason when it is not an address of a book or edition, or Hardcover has no such book.
 */
async function hardcoverBookId(ask, text){
  const value = String(text || '').trim();
  if(HARDCOVER_ID.test(value)) return {id: value};
  const url = parseHardcoverUrl(value);
  if(!url) throw new Error('not a Hardcover book id, or the address of a book or edition on hardcover.app');
  if(url.book) return {id: url.book};
  if(url.edition){
    const [edition] = (await ask(HARDCOVER_QUERIES.editionBook, {id: Number(url.edition)})).editions || [];
    if(!isObject(edition) || !Number.isInteger(edition.book_id)) throw new Error(`Hardcover has no edition ${url.edition}`);
    return {id: String(edition.book_id), title: isObject(edition.book) && typeof edition.book.title === 'string' ? edition.book.title : ''};
  }
  const [book] = (await ask(HARDCOVER_QUERIES.bookBySlug, {slug: url.slug})).books || [];
  if(!isObject(book) || !Number.isInteger(book.id)) throw new Error(`Hardcover has no book at hardcover.app/books/${url.slug}`);
  // a book merged into another one lives on as that one
  return {id: String(Number.isInteger(book.canonical_id) ? book.canonical_id : book.id), title: typeof book.title === 'string' ? book.title : ''};
}

/** A book's or an edition's page on Hardcover, by its id (Hardcover redirects to the current address). */
function hardcoverUrl(kind, id){
  return `https://hardcover.app/id/${kind}/${encodeURIComponent(id)}`;
}

// --------------------------------------------------------------- Hardcover runs
// The import, export and sync themselves, shared by the command line and the page: Hardcover allows
// browser requests (its API answers with open CORS headers), so the page can run them without
// `make serve`. They only ever reach Hardcover through `ask`, and write only through `save`.

/** A token as Hardcover shows it ("Bearer eyJ..."), without the "Bearer" and spacing; '' when there is none. */
function cleanHardcoverToken(t){
  return String(t || '').trim().replace(/^bearer\s+/i, '').trim();
}

/**
 * A function that asks Hardcover's API one query (with its variables) and returns the answer's `data`,
 * through `get` (a fetch), calling `pause()` between requests (Hardcover allows 60 a minute). `headers`
 * are added to each request. Throws with a short reason when Hardcover says no.
 */
function hardcoverAsker(token, get, pause, headers){
  let asked = 0;
  return async (query, variables) => {
    if(asked++) await pause();
    const res = await get(HARDCOVER_API, {method: 'POST', body: JSON.stringify({query, variables: variables || {}}), headers: {
      'content-type': 'application/json', authorization: `Bearer ${cleanHardcoverToken(token)}`, ...(headers || {})}});
    let json = null;
    try{ json = await res.json(); }catch(exc){ /* reported below */ }
    if(res.status === 401) throw new Error('Hardcover refused your token (expired, or missing a scope? make a new one at hardcover.app/account/api)');
    if(res.status === 429) throw new Error('Hardcover\'s rate limit was reached; try again later');
    if(!res.ok || !json) throw new Error(`Hardcover answered ${res.status}${json && json.error ? ` (${json.error})` : ''}`);
    if(Array.isArray(json.errors) && json.errors.length) throw new Error(`Hardcover: ${json.errors.map(e => e && e.message).join('; ')}`);
    return json.data || {};
  };
}

/** Every book on your Hardcover shelves (user_books rows, with their reads). */
async function fetchHardcoverShelf(ask, step){
  const me = await ask(HARDCOVER_QUERIES.me);
  const user = Array.isArray(me.me) && me.me[0] && me.me[0].id;
  if(!Number.isInteger(user)) throw new Error('Hardcover did not say who the token belongs to');
  const shelf = [];
  for(let offset = 0; ; offset += HARDCOVER_PAGE){
    const page = (await ask(HARDCOVER_QUERIES.shelf, {user, offset})).user_books || [];
    shelf.push(...page);
    step(`Reading your Hardcover shelves: ${shelf.length} books`);
    if(page.length < HARDCOVER_PAGE) return shelf;
  }
}

/** Hardcover rows (`kind` 'books' or 'editions') by id, asked in batches; `doing` is the progress step's text. */
async function fetchHardcoverRows(ask, kind, ids, step, doing){
  const rows = new Map();
  for(let i = 0; i < ids.length; i += HARDCOVER_BATCH){
    step(doing || `Reading the ${kind} on your Read shelf`, i, ids.length);
    for(const row of (await ask(HARDCOVER_QUERIES[kind], {ids: ids.slice(i, i + HARDCOVER_BATCH)}))[kind] || []) rows.set(row.id, row);
  }
  return rows;
}

/** The Hardcover ids of your editions' ASINs, ISBNs and Goodreads ids (see hardcoverMatches()). */
async function findOnHardcover(ask, lookups, step){
  const found = {hc: new Map(), asin: new Map(), isbn: new Map(), gr: new Map()};
  const longest = Math.max(0, ...Object.values(lookups).map(l => l.length));
  for(let i = 0; i < longest; i += HARDCOVER_BATCH){
    step('Finding your books on Hardcover', i, longest);
    const slice = Object.fromEntries(Object.entries(lookups).map(([k, l]) => [k, l.slice(i, i + HARDCOVER_BATCH)]));
    const q = hardcoverFindQuery(slice);
    if(!q) continue;
    const matches = hardcoverMatches(await ask(q.query, q.variables));
    for(const k of Object.keys(found)) for(const [id, hit] of matches[k]) if(!found[k].has(id)) found[k].set(id, hit);
  }
  return found;
}

/** Records as the import commands list them: "    + Title - Author  [Series #3]", at most `limit` of them. */
function recordLines(records, limit = 15){
  const lines = records.slice(0, limit).map(rec =>
    `    + ${rec.t} - ${namesText(rec.a)}${rec.s ? `  [${rec.s}${rec.sn ? ' #' + rec.sn : ''}]` : ''}`);
  if(records.length > limit) lines.push(`    ... and ${records.length - limit} more`);
  return lines;
}

/** What merge() did, as lines the import commands print. */
function mergeLines(report, warnings){
  const lines = [`  already in the catalogue: ${report.matched}`];
  const counts = [['backfilled', 'Audible ids filled in on existing books'], ['goodreadsFilled', 'Goodreads ids filled in on existing books'],
    ['hardcoverFilled', 'Hardcover ids filled in on existing books'], ['datesFilled', 'dates read filled in on existing books'],
    ['isbnsFilled', 'ISBNs added to existing books'], ['detailsFilled', 'narrator, publisher, release date or length filled in on existing books'],
    ['editionsAdded', 'other editions added to existing books'], ['excluded', 'skipped (listed in data/excluded.txt)']];
  for(const [k, label] of counts) if(report[k] && report[k].length) lines.push(`  ${label}: ${report[k].length}`);
  if(report.boxSets && report.boxSets.length){
    lines.push(`  box sets split into their titles: ${report.boxSets.length}`);
    for(const b of report.boxSets.slice(0, 15)) lines.push(`    ${b.t} - ${namesText(b.a)}: ${b.titles} already here, ${b.added} added`);
    if(report.boxSets.some(b => b.added)) lines.push('    (a title not here yet is named "Series, Book N" until --series or the `series` command names it)');
  }
  lines.push(`  new: ${report.added.length}`, ...recordLines(report.added));
  if(warnings && warnings.length){
    lines.push(`  needs a look (${warnings.length}):`);
    for(const w of warnings.slice(0, 15)) lines.push('    ! ' + w);
  }
  return lines;
}

/**
 * A Hardcover import, export or sync (`mode` 'import', 'export' or 'sync': import, then export) of
 * `books` (fixBooks() output, changed in place), asking Hardcover through `ask`. Import adds the books on
 * your Hardcover Read shelf like any import; export puts your books on that shelf with their dates read.
 * Neither ever changes or removes anything, here or on Hardcover. Options: `exclusions`, `info` (series
 * info, for validating), `dryRun`, `out(line)` and `err(line)` (what it has to say), `step(text, done,
 * total)` (progress) and `save()`, which keeps the changed `books` before anything is sent to Hardcover
 * and returns false (having said why) when it can't. Returns a promise of the exit code.
 */
async function runHardcover(books, mode, ask, opts){
  const {exclusions, info, dryRun, save} = opts;
  const out = opts.out || (() => {}), err = opts.err || (() => {}), step = opts.step || (() => {});
  const before = JSON.stringify(books);
  const stop = exc => { err(`error: ${exc.message}; nothing written`); return 1; };
  let shelf;
  try{
    step('Reading your Hardcover shelves');
    shelf = await fetchHardcoverShelf(ask, step);
  }catch(exc){ return stop(exc); }

  if(mode !== 'export'){
    const read = shelf.filter(ub => ub && ub.status_id === HARDCOVER_READ);
    let result;
    try{
      const found = await fetchHardcoverRows(ask, 'books', [...new Set(read.map(ub => ub.book_id))], step);
      const editions = await fetchHardcoverRows(ask, 'editions', [...new Set(read.map(ub => ub.edition_id).filter(Boolean))], step);
      result = readHardcover(shelf, found, editions);
    }catch(exc){ return stop(exc); }
    const report = merge(books, result.records, exclusions, {allDates: true, addable: rec => result.audio.has(rec)});
    out(`Hardcover: ${result.records.length} books on your Read shelf`);
    mergeLines(report, result.warnings).forEach(line => out(line));
    if(report.notAdded.length){
      out(`  not added, as Hardcover has no audiobook edition picked for them: ${report.notAdded.length}`);
      recordLines(report.notAdded, 5).forEach(line => out(line));
    }
  }

  let plan = null;
  if(mode !== 'import'){
    // which Hardcover book each edition belongs to, so a box set's edition is never sent as a title's
    const editionBooks = new Map();
    let filled;
    try{
      filled = addHardcoverIds(books, await findOnHardcover(ask, hardcoverLookups(books), step));
      const rows = await fetchHardcoverRows(ask, 'editions', hardcoverExportEditions(books), step, 'Checking your editions on Hardcover');
      for(const [id, row] of rows) editionBooks.set(String(id), String(row.book_id));
    }catch(exc){ return stop(exc); }
    plan = planHardcoverExport(books, shelf, editionBooks);
    const reads = plan.add.reduce((n, a) => n + a.dates.length, 0) + plan.reads.reduce((n, a) => n + a.dates.length, 0);
    out('to Hardcover:');
    out(`  Hardcover ids filled in on your books: ${filled.length}`);
    out(`  books to put on your Read shelf: ${plan.add.length}`);
    recordLines(plan.add.flatMap(a => a.recs)).forEach(line => out(line));
    out(`  dates read to add: ${reads}`);
    if(plan.otherShelf.length){
      out(`  on another Hardcover shelf, left alone: ${plan.otherShelf.length}`);
      for(const [rec, status] of plan.otherShelf.slice(0, 15)) out(`    ! ${rec.t} - ${namesText(rec.a)}: ${status}`);
    }
    if(plan.inexact.length) out(`  dates read without a day, not sent (a Hardcover read needs one): ${plan.inexact.length}`);
    if(plan.unknown.length){
      out(`  not found on Hardcover (no ASIN, ISBN or Goodreads id it knows; add "Hardcover <edition id>" by hand): ${plan.unknown.length}`);
      recordLines(plan.unknown, 5).forEach(line => out(line));
    }
  }

  const {errors} = validate(books, info || {});
  if(errors.length){
    err('Validation failed, nothing written:\n  ' + errors.slice(0, 10).join('\n  '));
    return 1;
  }
  if(dryRun){
    out('(dry run: nothing written)');
    return 0;
  }
  // the ids first, so they are kept even if Hardcover stops answering halfway
  if(!(await save(JSON.stringify(books) !== before))) return 1;
  if(!plan) return 0;
  return pushToHardcover(ask, plan, out, err, step);
}

/** Carry out planHardcoverExport()'s plan on Hardcover. Returns a promise of the exit code. */
async function pushToHardcover(ask, plan, out, err, step){
  let shelved = 0, reads = 0, done = 0;
  const total = plan.add.length + plan.reads.length;
  const problems = [];
  const addRead = async (userBook, edition, date, rec) => {
    const r = (await ask(HARDCOVER_QUERIES.addRead, {id: userBook, read: {finished_at: date, ...(edition ? {edition_id: edition} : {})}})).insert_user_book_read;
    if(!r || r.error) problems.push(`${rec.t}: read ${date} not added (${r && r.error || 'no answer'})`); else reads++;
  };
  try{
    for(const a of plan.add){
      step('Putting books on your Hardcover Read shelf', done++, total);
      const object = {book_id: a.book, status_id: HARDCOVER_READ, ...(a.edition ? {edition_id: a.edition} : {})};
      const r = (await ask(HARDCOVER_QUERIES.addBook, {object})).insert_user_book;
      if(!r || r.error || !r.id){ problems.push(`${a.recs[0].t}: not added (${r && r.error || 'no answer'})`); continue; }
      shelved++;
      for(const d of a.dates) await addRead(r.id, a.edition, d, a.recs[0]);
    }
    for(const a of plan.reads){
      step('Adding reads to books on your Read shelf', done++, total);
      for(const d of a.dates) await addRead(a.userBook, a.edition, d, a.recs[0]);
    }
  }catch(exc){
    err(`error: ${exc.message}; stopped after putting ${shelved} book(s) on Hardcover and adding ${reads} read(s). ` +
      'Run it again to carry on: what is already there is not added twice.');
    return 1;
  }
  out(`put ${shelved} book(s) on your Hardcover Read shelf and added ${reads} read(s)`);
  for(const p of problems.slice(0, 15)) out('    ! ' + p);
  return problems.length ? 1 : 0;
}

// ---------------------------------------------------------------------- merge
/** [first, last] of a box set's series range ("1-3" -> [1, 3]), or null for a single title or no series. */
function boxRange(rec){
  const m = rec && rec.s && BOX_RANGE.exec(String(rec.sn || '').trim());
  if(!m) return null;
  const lo = Number(m[1]), hi = Number(m[2]);
  return lo < hi && hi - lo < BOX_MAX ? [lo, hi] : null;
}

// Which report list a book goes on when one of its editions gains a field.
const FILLED_REPORT = {id: 'backfilled', gr: 'goodreadsFilled', hc: 'hardcoverFilled', isbn: 'isbnsFilled', n: 'detailsFilled', p: 'detailsFilled', d: 'detailsFilled', len: 'detailsFilled', desc: 'detailsFilled'};

/**
 * Append incoming records that are not in `existing` yet (mutates `existing`). An existing book
 * always wins, except that it gains dates read when it has none, and the editions it lacks:
 * - an incoming edition with the same ASIN, Goodreads id or ISBN as one of the book's editions fills in
 *   what that edition is missing (and so does every copy of it on a box set's other titles);
 * - otherwise, when the book has one edition of its own that does not disagree on the ASIN or
 *   Goodreads id, that edition is filled in (a Goodreads export finding the book an Audible import added);
 * - otherwise the incoming edition is added as another edition of the book.
 * A record of another Hardcover book that finds a book by a box set's edition is the box set: its dates
 * read go to every title the edition is on. Series names are folded onto the spelling already in use.
 * ISBNs never make two books the same: one ISBN may be on several books (a boxed set's ISBN on each
 * book in it).
 * Options: `allDates` adds every incoming date read the book lacks, not only to a book with none (for
 * sources that keep every read, like Hardcover; a date counts as there when the book has it or the month
 * or year it falls in); `addable(rec)` says whether an unmatched record may be added (others only fill
 * in a book they match, and go on `notAdded`).
 * A box set with a series range ("1-3") and an id or ISBN becomes its titles (see mergeBoxSet below),
 * unless it is in `existing` as one book already.
 * Returns {added, backfilled, goodreadsFilled, hardcoverFilled, isbnsFilled, detailsFilled, editionsAdded,
 * datesFilled, excluded, notAdded, boxSets, matched}: books that gained an Audible id, a Goodreads id, a Hardcover
 * id, ISBNs, a narrator, publisher, release date or length, a new edition, dates read; box sets
 * split into their titles ({t, a, titles: how many you had, added: how many were added}).
 */
function merge(existing, incoming, exclusions, opts){
  exclusions = exclusions || new Exclusions();
  opts = opts || {};
  const report = {added: [], backfilled: [], goodreadsFilled: [], hardcoverFilled: [], isbnsFilled: [], detailsFilled: [], editionsAdded: [],
    datesFilled: [], excluded: [], notAdded: [], boxSets: [], matched: 0};

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
  const giveDates = (reader, rec) => {
    if(rec.r && rec.r.length && !reader.r){
      reader.r = [...rec.r];
      note(report.datesFilled, reader);
    } else if(opts.allDates && Array.isArray(rec.r) && Array.isArray(reader.r)){
      const more = rec.r.filter(d => !hasReadDate(reader.r, d));
      if(more.length){
        reader.r = [...new Set([...reader.r, ...more])].sort();
        note(report.datesFilled, reader);
      }
    }
  };
  // Give book `i` (one title of a box set, whose titles are `set`) the set's edition `ed`: it fills in
  // the copy the book has (by an id, or the one edition it shares with another title of the set that
  // does not disagree, as when Goodreads' box set finds the one an Audible import split), else is added
  // beside the book's own editions, which are other editions and never filled in.
  const giveBoxEdition = (i, ed, set) => {
    const book = existing[i];
    const shared = bookEditions(book).filter(x => !editionsConflict(x, ed) && copiesOf(x).some(([j]) => j !== i && set.includes(j)));
    const target = bookEditions(book).find(x => sameEdition(x, ed)) || (shared.length === 1 ? shared[0] : undefined);
    if(target){
      for(const field of fillEdition(target, ed)) note(report[FILLED_REPORT[field]], book);
    } else {
      book.e = [...bookEditions(book), orderEdition({...ed})];
      note(report.editionsAdded, book);
    }
    indexBook(i);
  };

  /**
   * An incoming box set (a series and a range, "1-3"): each number is a title, found by author, series
   * and number (or by already holding the set's edition), or else added. Every title gets the set's
   * edition, and the set's dates read when it has none. Returns false when the set is in the catalogue
   * as one book, which then merges as any other record.
   */
  const mergeBoxSet = (rec, original, [lo, hi]) => {
    // without an id or ISBN there is nothing to tie the titles together, so the set stays one book
    if(!bookEditions(rec).some(ed => EDITION_IDS.some(k => ed[k]) || editionIsbns(ed).length)) return false;
    const editions = bookEditions(rec).map(ed => orderEdition({...ed, desc: ed.desc || rec.t}));
    const author = firstAuthor(rec.a), series = seriesNorm(rec.s);
    const ownsSet = b => bookEditions(b).some(x => editions.some(ed => EDITION_IDS.some(k => x[k] && x[k] === ed[k]) && sameEdition(x, ed)));
    const titleNumber = b => firstAuthor(b.a) === author && seriesNorm(b.s || '') === series && /^\d+$/.test(String(b.sn || '').trim()) ?
      Number(String(b.sn).trim()) : null;
    const whole = existing.some(b => (ownsSet(b) && titleNumber(b) === null) ||
      (norm(b.t) === norm(rec.t) && firstAuthor(b.a) === author));
    if(whole) return false;
    const titles = [], excluded = exclusions.covers(rec);
    let added = 0;
    for(let n = lo; n <= hi; n++){
      let i = existing.findIndex(b => ownsSet(b) && titleNumber(b) === n);
      if(i < 0) i = index.has(key('series', author, series, String(n))) ? index.get(key('series', author, series, String(n))) : -1;
      if(i >= 0){ titles.push(i); continue; }
      const part = {t: boxSetTitle(rec.s, n), a: [...rec.a], s: rec.s, sn: String(n)};
      if(rec.g) part.g = [...rec.g];
      if(rec.r) part.r = [...rec.r];
      if(editions.length) part.e = editions.map(ed => ({...ed}));
      if(excluded || exclusions.covers(part)){ report.excluded.push(part); continue; }
      if(opts.addable && !opts.addable(original)){ report.notAdded.push(part); continue; }
      existing.push(part);
      report.added.push(part);
      indexBook(existing.length - 1);
      added++;
    }
    if(titles.length) report.matched++;
    const before = titles.map(i => JSON.stringify(existing[i]));
    for(const i of titles){
      for(const ed of editions) giveBoxEdition(i, ed, titles);
      giveDates(existing[i], rec);
    }
    // every copy of the set's edition ends up with all it is known by
    for(const ed of editions){
      const copies = existing.flatMap((b, i) => bookEditions(b).filter(x => sameEdition(x, ed)).map(x => [i, x]));
      for(const [, x] of copies) for(const [, y] of copies) fillEdition(x, y);
      copies.forEach(([i]) => indexBook(i));
    }
    const changed = titles.filter((i, j) => JSON.stringify(existing[i]) !== before[j]).length;
    if(added || changed) report.boxSets.push({t: rec.t, a: rec.a, titles: titles.length, added});
    return true;
  };

  for(const original of incoming){
    const rec = {...fixPeople(original)};   // authors and narrators as lists, even from a caller that wrote text
    if(rec.s){
      const k = seriesNorm(rec.s);
      if(!canonical.has(k)) canonical.set(k, rec.s);
      rec.s = canonical.get(k);
    }
    const range = boxRange(rec);
    if(range && mergeBoxSet(rec, original, range)) continue;

    const hit = lookupKeys(rec).find(k => index.has(k));
    if(hit !== undefined){
      const match = index.get(hit), book = existing[match];
      report.matched++;
      // A Hardcover book other than this one, found by a box set's edition, is the box set: reading it
      // was reading each of its titles.
      const boxSet = !!(rec.hcb && book.hcb && rec.hcb !== book.hcb);
      const readers = new Set([match]);
      for(const ed of bookEditions(rec)){
        const own = bookEditions(book);
        let target = own.find(x => sameEdition(x, ed));
        if(!target && own.length === 1 && !editionsConflict(own[0], ed) && !copiesOf(own[0]).length) target = own[0];
        if(target){
          const copies = copiesOf(target);
          if(boxSet) copies.forEach(([i]) => readers.add(i));
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
      if(rec.hcb && !book.hcb){
        setHardcoverBook(book, rec.hcb);
        note(report.hardcoverFilled, book);
        indexBook(match);
      }
      for(const i of readers) giveDates(existing[i], rec);
      continue;
    }
    if(exclusions.covers(rec)){
      report.excluded.push(rec);
      continue;
    }
    if(opts.addable && !opts.addable(original)){
      report.notAdded.push(rec);
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
 * Whether `dates` (dates read) already has `date`: the same date, or a less exact one it falls in
 * ("2024-03" has "2024-03-15"), or a more exact one in it ("2024-03-15" has "2024-03").
 */
function hasReadDate(dates, date){
  return dates.some(d => typeof d === 'string' && (d === date || date.startsWith(d + '-') || d.startsWith(date + '-')));
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
 * With `normalize` asciiNorm, the key as marks made before norm() knew other scripts have it.
 */
function duplicatePairKey(x, y, normalize){
  const n = normalize || norm;
  const id = b => key(n(b.t), n(firstName(b.a)), seriesKey(n(b.s)), String(b.sn || '').trim());
  return [id(x), id(y)].sort().join(' ');
}

/** Whether `notSame` has the pair x, y marked as different books, under its key now or as marked before. */
function markedNotSame(notSame, x, y){
  return notSame.has(duplicatePairKey(x, y)) || notSame.has(duplicatePairKey(x, y, asciiNorm));
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
  const isId = k => /^\["(id|gr|hc|hcb)"/.test(k);
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
        if(j !== i && !markedNotSame(notSame, b, books[j])) parent[root(j)] = root(i);
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
  const out = orderEdition({...editions[0]});
  for(const ed of editions.slice(1)) fillEdition(out, ed);
  return out;
}

/** Key for "these editions of a book are different editions": the ids they carry, in any order. */
function editionsKey(rec){
  const ids = bookEditions(rec).flatMap(ed => [
    ...EDITION_IDS.filter(k => typeof ed[k] === 'string' && ed[k]).map(k => k + ' ' + ed[k]),
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
  const shared = sharedEditionTest(books);
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
  const title = from('t', b => typeof b.t === 'string' && b.t !== '');
  if(title) out.t = title.t;
  const authors = from('a', b => Array.isArray(b.a) && b.a.length > 0);
  if(authors) out.a = [...authors.a];
  const series = from('series', b => typeof b.s === 'string' && b.s !== '');
  if(series){
    out.s = series.s;
    if(series.sn) out.sn = series.sn;
  }
  const genres = [...new Set(recs.flatMap(b => Array.isArray(b.g) ? b.g : []))];
  if(genres.length) out.g = genres;
  const dates = [...new Set(recs.flatMap(b => Array.isArray(b.r) ? b.r : []))].sort();
  if(dates.length) out.r = dates;
  const hardcover = from('hcb', b => typeof b.hcb === 'string' && b.hcb !== '');
  if(hardcover) out.hcb = hardcover.hcb;
  const editions = [];
  for(const ed of recs.flatMap(bookEditions)){
    const same = editions.find(x => sameEdition(x, ed));
    if(same) fillEdition(same, ed);
    else editions.push(orderEdition({...ed}));
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
 * - series info both have keeps the preferred side's; the backup's excluded books, and its "Not duplicates"
 *   marks, are added to ours (`notDuplicates`, the marks this catalogue has).
 * Changes nothing it is given. Returns {books, seriesInfo, excluded (entries new to `exclusions`),
 * notDuplicates (marks new to `notDuplicates`),
 * added, updated, removed, skipped, conflicts: [{mine, theirs}], infoAdded, infoChanged, infoKept}.
 */
function mergeBackup(books, seriesInfo, exclusions, backup, prefer, notDuplicates){
  const takeBackup = prefer === 'backup';
  const copy = rec => JSON.parse(JSON.stringify(rec));
  const out = books.map(copy);
  const result = {added: [], updated: [], removed: [], skipped: [], conflicts: [], infoAdded: [], infoChanged: [], infoKept: []};

  const ours = parseExclusions((exclusions ? exclusions.entries : []).join('\n'));
  const theirsOnly = new Exclusions();
  result.excluded = (backup.excluded || []).map(e => ours.add(e)).filter(Boolean);
  result.excluded.forEach(e => theirsOnly.add(e));
  const ourMarks = new Set(notDuplicates || []);
  result.notDuplicates = parseNotDuplicates((backup.notDuplicates || []).join('\n')).filter(k => !ourMarks.has(k));

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

export {
  fingerprint, norm, seriesNorm, tidyText, parseReadDate, parseReadDates, fixReadDates, fixBooks, normalizeName, tidyBook, firstAuthor, bookKeys, lookupKeys,
  splitNames, namesText, fixNames, fixPeople,
  parseIsbn, parseIsbns, splitIsbns, bookIsbns, rowIsbns,
  bookEditions, editionIsbns, sameEdition, fixEditions, tidyEdition, parseLength, formatLength, editionParts, formatEdition, parseEditions, EDITION_FIELDS, editionFields, editionFromFields, saveBook,
  bookNarrators,
  Exclusions, parseExclusions, exclusionEntries, validate, readBackup, parseCsv,
  parseSeriesField, chooseSeries, cleanTitle, audibleRowToRecord, readAudible,
  AUDIBLE_STORES, audibleProductUrl, audibleSeries, audibleSeriesTotal, audibleSeriesListing, seriesLookups, seriesFromAudible, addSeriesTotals,
  boxSetTitle, seriesListingLookups, boxSetTitlesFromAudible,
  HARDCOVER_API, HARDCOVER_QUERIES, HARDCOVER_STATUSES, HARDCOVER_PAGE, HARDCOVER_BATCH, hardcoverFindQuery, hardcoverEdition,
  readHardcover, hardcoverMatches, hardcoverLookups, addHardcoverIds, hardcoverExportEditions, planHardcoverExport,
  cleanHardcoverToken, hardcoverAsker, runHardcover, recordLines, mergeLines, hardcoverUrl, parseHardcoverUrl, hardcoverBookId, hasReadDate,
  parseGoodreadsTitle, splitSeriesTitle, fixSeriesTitle, readGoodreadsTitle, readGoodreads, goodreadsCsv, merge, missingNumbers, duplicatePairKey, findDuplicates, mergeBooks,
  editionsJoinable, joinEditions, editionsKey, splitEditions, mergeBackup, parseNotDuplicates,
};
