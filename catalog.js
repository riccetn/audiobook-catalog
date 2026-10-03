#!/usr/bin/env node
// Command line tools for the catalogue:  node catalog.js <command>
// The importers, merge and validation live in importers.js, which the page uses too.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const C = require('./importers.js');

const ROOT = __dirname;
const DATA_DIR_ENV = 'CATALOG_DATA_DIR';

// ------------------------------------------------------------------ data location
const expandUser = p => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

/** Where *your* catalogue lives: --data-dir, else $CATALOG_DATA_DIR, else <root>/data (git-ignored). */
function liveDataDir(root, override){
  if(override) return path.resolve(expandUser(override));
  if(process.env[DATA_DIR_ENV]) return path.resolve(expandUser(process.env[DATA_DIR_ENV]));
  return path.join(root, 'data');
}

/** Directory to read from. With nothing configured and no data/books.json yet, use the bundled demo. */
function dataDir(root, override){
  const live = liveDataDir(root, override);
  const explicit = Boolean(override || process.env[DATA_DIR_ENV]);
  if(explicit || fs.existsSync(path.join(live, 'books.json'))) return live;
  return path.join(live, 'sample');
}

const isDemo = (root, dir) => path.resolve(dir) === path.join(root, 'data', 'sample');

// ------------------------------------------------------------------- load / save
const readText = file => fs.readFileSync(file, 'utf8');
const loadBooks = file => C.fixBooks(JSON.parse(readText(file)));   // "r": "2024-03-15" -> ["2024-03-15"]
const loadSeriesInfo = file => JSON.parse(readText(file));

const dumpBooks = (books, file) => fs.writeFileSync(file, JSON.stringify(books), 'utf8');
const dumpSeriesInfo = (info, file) => fs.writeFileSync(file, JSON.stringify(info), 'utf8');

function loadExclusions(file){
  return fs.existsSync(file) ? C.parseExclusions(readText(file)) : C.parseExclusions('');
}

/**
 * Entries of `entries` that data/excluded.txt does not cover yet, as they would be written there.
 * The file is only ever added to: removing an entry stays a hand edit.
 */
function newExclusions(file, entries){
  const ex = loadExclusions(file);
  return (entries || []).map(e => ex.add(e)).filter(Boolean);
}

/** Append entries to data/excluded.txt, creating it (with its explanatory header) if needed. */
function appendExclusions(file, lines){
  if(!lines.length) return;
  let text = fs.existsSync(file) ? readText(file) : EXCLUDED_HEADER;
  if(text && !text.endsWith('\n')) text += '\n';
  writeAtomic(file, text + lines.map(l => l + '\n').join(''));
}

// ---------------------------------------------------------------------- commands
const DEMO_NOTE = 'note: no data/books.json found, so this is the bundled demo data (data/sample). ' +
  'Run `node catalog.js init` to start your own catalogue.';

const EXCLUDED_HEADER = `# Books that imports must never re-add (because you removed them on purpose).
# One entry per line; anything after '#' is a comment. Either:
#   B0XXXXXXXX                  an Audible ASIN
#   ISBN 978-0-00-000000-2      an ISBN (skips every book carrying it, e.g. all books of a boxed set)
#   Goodreads 12345678          a Goodreads book id (the number in goodreads.com/book/show/...)
#   Some Title | Some Author    for books with neither id
`;

function paths(args){
  const d = args.data;
  return [path.join(d, 'books.json'), path.join(d, 'series-info.json'), path.join(d, 'excluded.txt')];
}

function shown(file, root){
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

/** Commands that write must never touch the demo data. */
function requireOwnData(args, io){
  if(isDemo(args.root, args.data)){
    io.err('No catalogue data yet. Run `node catalog.js init` first ' +
      '(or `init --sample` to start from the demo data).');
    return false;
  }
  return true;
}

function preview(records, io, limit = 15){
  for(const rec of records.slice(0, limit)){
    const series = rec.s ? `  [${rec.s}${rec.sn ? ' #' + rec.sn : ''}]` : '';
    io.out(`    + ${rec.t} - ${rec.a}${series}`);
  }
  if(records.length > limit) io.out(`    ... and ${records.length - limit} more`);
}

/** What C.merge() did, as the import commands print it. */
function printMerge(report, warnings, io){
  io.out(`  already in the catalogue: ${report.matched}`);
  if(report.backfilled.length) io.out(`  Audible ids filled in on existing books: ${report.backfilled.length}`);
  if(report.goodreadsFilled.length) io.out(`  Goodreads ids filled in on existing books: ${report.goodreadsFilled.length}`);
  if(report.hardcoverFilled.length) io.out(`  Hardcover ids filled in on existing books: ${report.hardcoverFilled.length}`);
  if(report.datesFilled.length) io.out(`  dates read filled in on existing books: ${report.datesFilled.length}`);
  if(report.isbnsFilled.length) io.out(`  ISBNs added to existing books: ${report.isbnsFilled.length}`);
  if(report.detailsFilled.length) io.out(`  narrator, publisher, release date or length filled in on existing books: ${report.detailsFilled.length}`);
  if(report.editionsAdded.length) io.out(`  other editions added to existing books: ${report.editionsAdded.length}`);
  if(report.excluded.length) io.out(`  skipped (listed in data/excluded.txt): ${report.excluded.length}`);
  io.out(`  new: ${report.added.length}`);
  preview(report.added, io);
  if(warnings.length){
    io.out(`  needs a look (${warnings.length}):`);
    for(const w of warnings.slice(0, 15)) io.out('    ! ' + w);
  }
}

function runImport(args, io, read, label){
  if(!requireOwnData(args, io)) return 2;
  const [booksPath, infoPath, excludedPath] = paths(args);
  const books = loadBooks(booksPath);
  const result = read(readText(args.file));
  const report = C.merge(books, result.records, loadExclusions(excludedPath));

  io.out(`${label}: ${result.records.length} finished books read from ${path.basename(args.file)}`);
  printMerge(report, result.warnings, io);

  const {errors} = C.validate(books, loadSeriesInfo(infoPath));
  if(errors.length){
    io.err('Validation failed, nothing written:\n  ' + errors.slice(0, 10).join('\n  '));
    return 1;
  }
  if(!args.dryRun){
    dumpBooks(books, booksPath);
    io.out(`wrote ${shown(booksPath, args.root)}`);
  }
  // --series: the new books' series and numbers, and release info for series new to the catalogue
  if(args.series && report.added.length){
    io.out('series of the new books:');
    return lookUpSeries(args, io, books, loadSeriesInfo(infoPath), booksPath, infoPath, report.added);
  }
  if(args.dryRun) io.out('(dry run: nothing written)');
  return 0;
}

function cmdValidate(args, io){
  const [booksPath, infoPath] = paths(args);
  if(isDemo(args.root, args.data)) io.out(DEMO_NOTE);
  const raw = JSON.parse(readText(booksPath));
  const books = C.fixBooks(raw), info = loadSeriesInfo(infoPath);
  const {errors, warnings} = C.validate(books, info);
  if(Array.isArray(raw) && raw.some(b => b && typeof b === 'object' && ['id', 'gr', 'isbn', 'n'].some(k => k in b))){
    io.out('note: some books keep their ids, ISBNs or narrator on the book, from before editions; they are read as editions, ' +
      'and `make format` (or any save) writes them that way');
  }
  const retitled = Array.isArray(raw) ? raw.filter(b => b && typeof b === 'object' && C.fixSeriesTitle(b) !== b).length : 0;
  if(retitled){
    io.out(`note: ${retitled} title(s) still hold their series ("Title: Series, Book 3"); they are read with the series ` +
      'split off, and `make format` (or any save) writes them that way');
  }
  for(const w of warnings) io.out('warning: ' + w);
  for(const e of errors) io.out('error: ' + e);
  const series = new Set(Array.isArray(books) ? books.filter(b => b && b.s).map(b => b.s) : []);
  io.out(`${Array.isArray(books) ? books.length : 0} books, ${series.size} series, ${Object.keys(info).length} with release info; ` +
    `${errors.length} error(s), ${warnings.length} warning(s)`);
  return errors.length ? 1 : 0;
}

/** Write the catalogue as a CSV for Goodreads' import (goodreads.com/review/import). Reads data/, writes only FILE. */
function cmdExportGoodreads(args, io){
  const [booksPath] = paths(args);
  if(isDemo(args.root, args.data)) io.out(DEMO_NOTE);
  const out = C.goodreadsCsv(loadBooks(booksPath));
  if(!args.dryRun) fs.writeFileSync(args.file, out.csv, 'utf8');
  io.out(`${out.books} books for Goodreads' "read" shelf`);
  if(out.withoutIds) io.out(`  without a Goodreads id or ISBN (Goodreads goes by title and author): ${out.withoutIds}`);
  if(out.withoutDate) io.out(`  without a full date read: ${out.withoutDate}`);
  io.out(args.dryRun ? '(dry run: nothing written)' : `wrote ${shown(args.file, args.root)}; import it at https://www.goodreads.com/review/import`);
  return 0;
}

/** Create your own (git-ignored) data files, empty or copied from the demo data. */
function cmdInit(args, io){
  const target = liveDataDir(args.root, args.dataDir);
  const booksPath = path.join(target, 'books.json');
  const infoPath = path.join(target, 'series-info.json');
  const excludedPath = path.join(target, 'excluded.txt');
  if(fs.existsSync(booksPath)){
    io.err(`${shown(booksPath, args.root)} already exists; not touching it.`);
    return 1;
  }
  fs.mkdirSync(path.join(target, 'raw'), {recursive: true});
  if(args.sample){
    const demo = path.join(args.root, 'data', 'sample');
    dumpBooks(loadBooks(path.join(demo, 'books.json')), booksPath);
    dumpSeriesInfo(loadSeriesInfo(path.join(demo, 'series-info.json')), infoPath);
  } else {
    dumpBooks([], booksPath);
    dumpSeriesInfo({}, infoPath);
  }
  if(!fs.existsSync(excludedPath)) fs.writeFileSync(excludedPath, EXCLUDED_HEADER, 'utf8');
  io.out(`created ${shown(target, args.root)}/ with books.json, series-info.json and excluded.txt`);
  io.out('next: save your Audible export in its raw/ folder and run `node catalog.js import-audible <file>`');
  return 0;
}

/** Rewrite data/*.json the way the tools write them: in the current format (with editions), as compact JSON. */
function cmdFormat(args, io){
  if(!requireOwnData(args, io)) return 2;
  const [booksPath, infoPath] = paths(args);
  dumpBooks(loadBooks(booksPath), booksPath);
  dumpSeriesInfo(loadSeriesInfo(infoPath), infoPath);
  io.out('data files rewritten in the current format');
  return 0;
}

/** Items of `a` missing from `b`, counting duplicates (like Python's Counter subtraction). */
function multisetMinus(a, b){
  const count = new Map();
  for(const x of b) count.set(x, (count.get(x) || 0) + 1);
  const out = [];
  for(const x of a){
    if(count.get(x)) count.set(x, count.get(x) - 1);
    else out.push(x);
  }
  return out;
}

/**
 * Check books (and series info, when given) coming from the app, as in a backup or a save from the page.
 * Returns the books with tidy text, the errors that block writing them, and all errors.
 */
function checkFromApp(newBooks, newInfo, oldInfo){
  const {errors} = C.validate(newBooks, newInfo || oldInfo);
  // a series-info entry left without books is expected if a series was renamed/removed in the app;
  // report but do not block on that. A malformed entry in the app's own series info does block.
  const orphan = e => /^series-info: .* matches no series/.test(e);
  const blocking = errors.filter(e => newInfo ? !orphan(e) : !e.startsWith('series-info'));
  if(blocking.length) return {blocking, errors};
  const books = newBooks.map(C.tidyBook);      // the app's edit form does not enforce tidy text
  const tidied = newBooks.filter((b, i) => JSON.stringify(b) !== JSON.stringify(books[i])).length;
  return {books, tidied, blocking, errors};
}

/**
 * Replace data/books.json (and data/series-info.json, if the backup has it) with a backup exported
 * from the app, and add the backup's excluded books to data/excluded.txt.
 */
function cmdSyncExport(args, io){
  if(!requireOwnData(args, io)) return 2;
  const [booksPath, infoPath, excludedPath] = paths(args);
  let newBooks, newInfo, excluded;
  try{
    ({books: newBooks, seriesInfo: newInfo, excluded} = C.readBackup(JSON.parse(readText(args.file))));
  }catch(exc){
    io.err(`cannot read ${args.file}: ${exc.message}`);
    return 1;
  }
  const oldInfo = loadSeriesInfo(infoPath);
  const {books: tidiedBooks, tidied, blocking, errors} = checkFromApp(newBooks, newInfo, oldInfo);
  if(blocking.length){
    io.err('Not a valid catalogue export:\n  ' + blocking.slice(0, 10).join('\n  '));
    return 1;
  }
  newBooks = tidiedBooks;
  if(tidied) io.out(`tidied stray spacing / run-together initials on ${tidied} book(s)`);
  const oldBooks = loadBooks(booksPath);
  const label = b => JSON.stringify([b.t, b.a]);
  const before = oldBooks.map(label), after = newBooks.map(label);
  const gone = multisetMinus(before, after).map(x => JSON.parse(x));
  const added = multisetMinus(after, before).map(x => JSON.parse(x));
  io.out(`${oldBooks.length} -> ${newBooks.length} books; ${added.length} new/renamed, ${gone.length} removed/renamed`);
  for(const [title, author] of added.slice(0, 10)) io.out(`    + ${title} - ${author}`);
  for(const [title, author] of gone.slice(0, 10)) io.out(`    - ${title} - ${author}`);
  if(newInfo){
    const names = Object.keys(newInfo), oldNames = Object.keys(oldInfo);
    const addedInfo = names.filter(n => !(n in oldInfo));
    const removedInfo = oldNames.filter(n => !(n in newInfo));
    const changedInfo = names.filter(n => n in oldInfo && JSON.stringify(newInfo[n]) !== JSON.stringify(oldInfo[n]));
    io.out(`series info: ${addedInfo.length} added, ${changedInfo.length} changed, ${removedInfo.length} removed`);
  } else {
    io.out(`series info: not in this backup (older export), ${shown(infoPath, args.root)} left as is`);
  }
  const addedExcluded = newExclusions(excludedPath, excluded);
  if(excluded){
    io.out(`excluded from imports: ${addedExcluded.length} new`);
    for(const line of addedExcluded.slice(0, 10)) io.out(`    x ${line}`);
  }
  if(args.dryRun){
    io.out('(dry run: nothing written)');
    return 0;
  }
  dumpBooks(newBooks, booksPath);
  io.out(`wrote ${shown(booksPath, args.root)}`);
  if(newInfo){
    dumpSeriesInfo(newInfo, infoPath);
    io.out(`wrote ${shown(infoPath, args.root)}`);
  }
  if(addedExcluded.length){
    appendExclusions(excludedPath, addedExcluded);
    io.out(`added to ${shown(excludedPath, args.root)}`);
  }
  const orphaned = errors.filter(e => e.startsWith('series-info'));
  if(orphaned.length) io.out('series-info needs attention:\n  ' + orphaned.join('\n  '));
  return 0;
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Largest save the page may send: far more than any real catalogue, small enough to bound memory.
const MAX_SAVE_BYTES = 32 * 1024 * 1024;

/** Write a file in one step, so a crash or a full disk never leaves half a catalogue behind. */
function writeAtomic(file, text){
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp');
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function sendJson(res, status, body){
  res.writeHead(status, {'Content-Type': CONTENT_TYPES['.json'], 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(body));
}

/**
 * Only this page may save: the request must name this server as its host (so another site cannot
 * reach it through DNS rebinding), come from this server's own origin if the browser says where it
 * comes from, and be JSON (which a cross-site page cannot send without a CORS preflight, never granted).
 */
function sameOrigin(req, port){
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  if(!hosts.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  if(origin !== undefined && origin !== `http://${req.headers.host}`) return false;
  return /^application\/json(;|$)/.test(req.headers['content-type'] || '');
}

/**
 * The page's saves: GET says whether saving is possible (only to your own data/books.json, never the
 * demo) and that Audible lookups are, PUT {books, seriesInfo, excluded, base, infoBase} writes both files, and adds the entries in
 * `excluded` (books removed in the page) to data/excluded.txt. `base` and `infoBase` are the
 * fingerprints of the files the page's edits started from; if either file changed since (an import,
 * sync-export or a hand edit), the save is refused rather than overwriting that change. excluded.txt
 * is only ever added to, so it needs no such check.
 */
function handleSave(req, res, root, port){
  const dir = path.join(root, 'data');
  const booksPath = path.join(dir, 'books.json'), infoPath = path.join(dir, 'series-info.json');
  const excludedPath = path.join(dir, 'excluded.txt');
  const writable = fs.existsSync(booksPath);
  // `audible`: this server can also look books up on Audible for the page (see handleAudible)
  if(req.method === 'GET'){ sendJson(res, 200, {writable, audible: true}); return; }
  if(req.method !== 'PUT'){ sendJson(res, 405, {error: 'use GET or PUT'}); return; }
  if(!sameOrigin(req, port)){ sendJson(res, 403, {error: 'saves are only accepted from this page'}); return; }
  if(!writable){ sendJson(res, 409, {error: 'no data/books.json: run `node catalog.js init` first'}); return; }

  const chunks = [];
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if(size > MAX_SAVE_BYTES){ sendJson(res, 413, {error: 'too large'}); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if(res.headersSent) return;
    let body, books, seriesInfo, excluded;
    try{
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      ({books, seriesInfo, excluded} = C.readBackup(body));
      if(!seriesInfo) throw new Error('seriesInfo missing');
    }catch(exc){ sendJson(res, 400, {error: `not a catalogue: ${exc.message}`}); return; }

    const booksText = readText(booksPath);
    const infoText = fs.existsSync(infoPath) ? readText(infoPath) : '{}';
    if(body.base !== C.fingerprint(booksText) || body.infoBase !== C.fingerprint(infoText)){
      sendJson(res, 409, {error: 'data/books.json or data/series-info.json changed on disk since the page loaded it', conflict: true});
      return;
    }
    const checked = checkFromApp(books, seriesInfo, null);
    if(checked.blocking.length){ sendJson(res, 400, {error: 'not saved', errors: checked.blocking.slice(0, 10)}); return; }
    const newBooksText = JSON.stringify(checked.books), newInfoText = JSON.stringify(seriesInfo);
    try{
      if(newBooksText !== booksText) writeAtomic(booksPath, newBooksText);
      if(newInfoText !== infoText) writeAtomic(infoPath, newInfoText);
      appendExclusions(excludedPath, newExclusions(excludedPath, excluded));
    }catch(exc){ sendJson(res, 500, {error: `could not write: ${exc.message}`}); return; }
    sendJson(res, 200, {base: C.fingerprint(newBooksText), infoBase: C.fingerprint(newInfoText), books: checked.books});
  });
}

const ASIN = /^[A-Z0-9]{10}$/;

/**
 * The page's Audible lookups, since a browser may not ask Audible itself: POST {store, groups, asins}
 * with up to AUDIBLE_BATCH ASINs answers {results: {asin: ...}} as fetchFromAudible() finds them.
 * Same-origin only, like saves, so no other site can use this server to reach Audible.
 */
function handleAudible(req, res, port, get, pause){
  if(req.method !== 'POST'){ sendJson(res, 405, {error: 'use POST'}); return; }
  if(!sameOrigin(req, port)){ sendJson(res, 403, {error: 'lookups are only accepted from this page'}); return; }
  const chunks = [];
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if(size > 64 * 1024){ sendJson(res, 413, {error: 'too large'}); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    if(res.headersSent) return;
    let store, groups, asins;
    try{
      ({store, groups, asins} = JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }catch(exc){ sendJson(res, 400, {error: 'not JSON'}); return; }
    if(!Object.prototype.hasOwnProperty.call(C.AUDIBLE_STORES, store) || !['series', 'relationships'].includes(groups) ||
       !Array.isArray(asins) || asins.length > AUDIBLE_BATCH || !asins.every(a => typeof a === 'string' && ASIN.test(a))){
      sendJson(res, 400, {error: `expected {store, groups: "series" or "relationships", asins: up to ${AUDIBLE_BATCH} ASINs}`});
      return;
    }
    try{
      sendJson(res, 200, {results: Object.fromEntries(await fetchFromAudible(get, pause, store, asins, groups))});
    }catch(exc){ sendJson(res, 502, {error: `could not reach ${C.AUDIBLE_STORES[store]} (${exc.message})`}); }
  });
}

/**
 * The server behind `serve`: the project folder, plus the page's saves (see handleSave) and Audible
 * lookups (handleAudible; `audible` swaps in {fetch, pause} for tests).
 */
function createServer(root, port, audible = {}){
  const get = audible.fetch || globalThis.fetch, pause = audible.pause || defaultPause;
  return http.createServer((req, res) => {
    let file, urlPath;
    try{
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      file = path.join(root, urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath);
    }catch(e){ res.writeHead(400).end('bad request'); return; }
    if(urlPath === '/api/save'){ handleSave(req, res, root, port()); return; }
    if(urlPath === '/api/audible'){ handleAudible(req, res, port(), get, pause); return; }
    if(!file.startsWith(root + path.sep) && file !== root){ res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, body) => {
      if(err){ res.writeHead(404, {'Content-Type': 'text/plain'}).end('not found'); return; }
      res.writeHead(200, {'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
      res.end(body);
    });
  });
}

// ----------------------------------------------------------- Audible's catalogue
const AUDIBLE_PAUSE_MS = 250;   // between requests, to be gentle with Audible
const AUDIBLE_BATCH = 25;       // ASINs per api/audible request from the page

/**
 * Look ASINs up in one Audible store, one after another: for `series` groups, a Map of ASIN ->
 * audibleSeries() list; for `relationships` (series ASINs), ASIN -> audibleSeriesTotal(). An ASIN
 * Audible doesn't know maps to null. Throws when Audible can't be reached or answers with an error.
 */
async function fetchFromAudible(get, pause, store, asins, groups){
  const found = new Map();
  for(const asin of asins){
    const res = await get(C.audibleProductUrl(asin, store, groups), {headers: {accept: 'application/json'}});
    let json = null;
    if(res.status !== 404){
      if(!res.ok) throw new Error(`Audible answered ${res.status}`);
      json = await res.json();
    }
    const known = json && json.product ? json : null;
    found.set(asin, known && (groups === 'series' ? C.audibleSeries(known) : C.audibleSeriesTotal(known)));
    await pause();
  }
  return found;
}

const defaultPause = () => new Promise(done => setTimeout(done, AUDIBLE_PAUSE_MS));

/**
 * Fill in series, numbers and released totals from Audible's catalogue, looked up by ASIN. Only
 * empty values are filled: a book's series or number, and series-info for series that have none.
 * Returns a promise of the exit code.
 */
function cmdSeries(args, io){
  if(!requireOwnData(args, io)) return 2;
  const [booksPath, infoPath] = paths(args);
  const books = loadBooks(booksPath), info = loadSeriesInfo(infoPath);
  return lookUpSeries(args, io, books, info, booksPath, infoPath);
}

/** `only`: look up just these books (and their series) instead of the whole catalogue. */
async function lookUpSeries(args, io, books, info, booksPath, infoPath, only){
  const get = io.fetch || globalThis.fetch, pause = io.pause || defaultPause;
  const store = C.AUDIBLE_STORES[args.store];
  const asins = C.seriesLookups(books, info, only);
  io.out(`looking up ${asins.length} book(s) on ${store}`);
  let found, report, totals;
  try{
    found = await fetchFromAudible(get, pause, args.store, asins, 'series');
    report = C.seriesFromAudible(books, found);
    const wanted = [...report.series].filter(([name]) => !Object.prototype.hasOwnProperty.call(info, name)).map(([, asin]) => asin);
    totals = C.addSeriesTotals(info, report.series, await fetchFromAudible(get, pause, args.store, wanted, 'relationships'),
      args.store, new Date().toISOString().slice(0, 10));
  }catch(exc){
    io.err(`error: could not reach ${store} (${exc.message}); no series filled in`);
    return 1;
  }
  const unknown = [...found.values()].filter(x => x === null).length;

  io.out(`  series or number filled in: ${report.filled.length}`);
  preview(report.filled, io);
  io.out(`  series given a released total: ${totals.length}`);
  for(const name of totals.slice(0, 15)) io.out(`    + ${name}: ${info[name].total}`);
  if(totals.length > 15) io.out(`    ... and ${totals.length - 15} more`);
  if(unknown) io.out(`  not found on ${store}: ${unknown} (another store? --store uk, de, ...)`);
  if(report.warnings.length){
    io.out(`  needs a look (${report.warnings.length}):`);
    for(const w of report.warnings.slice(0, 15)) io.out('    ! ' + w);
  }

  const {errors} = C.validate(books, info);
  if(errors.length){
    io.err('Validation failed, nothing written:\n  ' + errors.slice(0, 10).join('\n  '));
    return 1;
  }
  if(args.dryRun){
    io.out('(dry run: nothing written)');
    return 0;
  }
  if(report.filled.length){
    dumpBooks(books, booksPath);
    io.out(`wrote ${shown(booksPath, args.root)}`);
  }
  if(totals.length){
    dumpSeriesInfo(info, infoPath);
    io.out(`wrote ${shown(infoPath, args.root)}`);
  }
  return 0;
}

// ------------------------------------------------------------------- Hardcover
const HARDCOVER_TOKEN_ENV = 'HARDCOVER_TOKEN';
const HARDCOVER_PAUSE_MS = 1000;   // Hardcover allows 60 requests a minute

/**
 * A function that asks Hardcover's API one query (with its variables) and returns the answer's `data`,
 * one request a second; null when no token is set. Throws with a short reason when Hardcover says no.
 */
function hardcoverClient(io){
  const env = io.env || process.env;
  const token = String(env[HARDCOVER_TOKEN_ENV] || '').trim().replace(/^bearer\s+/i, '');
  if(!token) return null;
  const get = io.fetch || globalThis.fetch;
  const pause = io.pause || (() => new Promise(done => setTimeout(done, HARDCOVER_PAUSE_MS)));
  let asked = 0;
  return async (query, variables) => {
    if(asked++) await pause();
    const res = await get(C.HARDCOVER_API, {method: 'POST', body: JSON.stringify({query, variables: variables || {}}), headers: {
      'content-type': 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'audiobook-catalog (personal catalogue sync)'}});
    let json = null;
    try{ json = await res.json(); }catch(exc){ /* reported below */ }
    if(res.status === 401) throw new Error(`Hardcover refused the token in $${HARDCOVER_TOKEN_ENV} (expired, or missing a scope? make a new one at hardcover.app/account/api)`);
    if(res.status === 429) throw new Error('Hardcover\'s rate limit was reached; try again later');
    if(!res.ok || !json) throw new Error(`Hardcover answered ${res.status}${json && json.error ? ` (${json.error})` : ''}`);
    if(Array.isArray(json.errors) && json.errors.length) throw new Error(`Hardcover: ${json.errors.map(e => e && e.message).join('; ')}`);
    return json.data || {};
  };
}

/** Every book on your Hardcover shelves (user_books rows, with their reads). */
async function fetchHardcoverShelf(ask){
  const me = await ask(C.HARDCOVER_QUERIES.me);
  const user = Array.isArray(me.me) && me.me[0] && me.me[0].id;
  if(!Number.isInteger(user)) throw new Error('Hardcover did not say who the token belongs to');
  const shelf = [];
  for(let offset = 0; ; offset += C.HARDCOVER_PAGE){
    const page = (await ask(C.HARDCOVER_QUERIES.shelf, {user, offset})).user_books || [];
    shelf.push(...page);
    if(page.length < C.HARDCOVER_PAGE) return shelf;
  }
}

/** Hardcover rows (`kind` 'books' or 'editions') by id, asked in batches. */
async function fetchHardcoverRows(ask, kind, ids){
  const rows = new Map();
  for(let i = 0; i < ids.length; i += C.HARDCOVER_BATCH){
    for(const row of (await ask(C.HARDCOVER_QUERIES[kind], {ids: ids.slice(i, i + C.HARDCOVER_BATCH)}))[kind] || []) rows.set(row.id, row);
  }
  return rows;
}

/** The Hardcover ids of your editions' ASINs, ISBNs and Goodreads ids (see C.hardcoverMatches). */
async function findOnHardcover(ask, lookups){
  const found = {hc: new Map(), asin: new Map(), isbn: new Map(), gr: new Map()};
  const longest = Math.max(0, ...Object.values(lookups).map(l => l.length));
  for(let i = 0; i < longest; i += C.HARDCOVER_BATCH){
    const slice = Object.fromEntries(Object.entries(lookups).map(([k, l]) => [k, l.slice(i, i + C.HARDCOVER_BATCH)]));
    const q = C.hardcoverFindQuery(slice);
    if(!q) continue;
    const matches = C.hardcoverMatches(await ask(q.query, q.variables));
    for(const k of Object.keys(found)) for(const [id, hit] of matches[k]) if(!found[k].has(id)) found[k].set(id, hit);
  }
  return found;
}

/**
 * hardcover-import, hardcover-export and hardcover-sync (`mode` 'import', 'export' or 'sync': import, then
 * export). Import adds the books on your Hardcover Read shelf like any import; export puts your books on
 * that shelf with their dates read. Neither ever changes or removes anything, here or on Hardcover.
 * Returns a promise of the exit code.
 */
async function cmdHardcover(args, io, mode){
  if(!requireOwnData(args, io)) return 2;
  const ask = hardcoverClient(io);
  if(!ask){
    io.err(`error: set ${HARDCOVER_TOKEN_ENV} to your Hardcover API token (hardcover.app/account/api)`);
    return 2;
  }
  const [booksPath, infoPath, excludedPath] = paths(args);
  const books = loadBooks(booksPath), info = loadSeriesInfo(infoPath), before = JSON.stringify(books);
  const stop = exc => { io.err(`error: ${exc.message}; nothing written`); return 1; };
  let shelf;
  try{
    shelf = await fetchHardcoverShelf(ask);
  }catch(exc){ return stop(exc); }

  if(mode !== 'export'){
    const read = shelf.filter(ub => ub && ub.status_id === 3);
    let result;
    try{
      const found = await fetchHardcoverRows(ask, 'books', [...new Set(read.map(ub => ub.book_id))]);
      const editions = await fetchHardcoverRows(ask, 'editions', [...new Set(read.map(ub => ub.edition_id).filter(Boolean))]);
      result = C.readHardcover(shelf, found, editions);
    }catch(exc){ return stop(exc); }
    const report = C.merge(books, result.records, loadExclusions(excludedPath), {allDates: true, addable: rec => result.audio.has(rec)});
    io.out(`Hardcover: ${result.records.length} books on your Read shelf`);
    printMerge(report, result.warnings, io);
    if(report.notAdded.length) io.out(`  not added, as Hardcover has no audiobook edition picked for them: ${report.notAdded.length}`);
    preview(report.notAdded, io, 5);
  }

  let plan = null, filled = [];
  if(mode !== 'import'){
    try{
      filled = C.addHardcoverIds(books, await findOnHardcover(ask, C.hardcoverLookups(books)));
    }catch(exc){ return stop(exc); }
    plan = C.planHardcoverExport(books, shelf);
    const reads = plan.add.reduce((n, a) => n + a.dates.length, 0) + plan.reads.reduce((n, a) => n + a.dates.length, 0);
    io.out('to Hardcover:');
    io.out(`  Hardcover ids filled in on your books: ${filled.length}`);
    io.out(`  books to put on your Read shelf: ${plan.add.length}`);
    preview(plan.add.flatMap(a => a.recs), io);
    io.out(`  dates read to add: ${reads}`);
    if(plan.otherShelf.length){
      io.out(`  on another Hardcover shelf, left alone: ${plan.otherShelf.length}`);
      for(const [rec, status] of plan.otherShelf.slice(0, 15)) io.out(`    ! ${rec.t} - ${rec.a}: ${status}`);
    }
    if(plan.inexact.length) io.out(`  dates read without a day, not sent (a Hardcover read needs one): ${plan.inexact.length}`);
    if(plan.unknown.length){
      io.out(`  not found on Hardcover (no ASIN, ISBN or Goodreads id it knows; add "Hardcover <edition id>" by hand): ${plan.unknown.length}`);
      preview(plan.unknown, io, 5);
    }
  }

  const {errors} = C.validate(books, info);
  if(errors.length){
    io.err('Validation failed, nothing written:\n  ' + errors.slice(0, 10).join('\n  '));
    return 1;
  }
  if(args.dryRun){
    io.out('(dry run: nothing written)');
    return 0;
  }
  // the ids first, so they are kept even if Hardcover stops answering halfway
  if(JSON.stringify(books) !== before){
    dumpBooks(books, booksPath);
    io.out(`wrote ${shown(booksPath, args.root)}`);
  }
  if(!plan) return 0;
  return pushToHardcover(ask, plan, io);
}

/** Carry out planHardcoverExport()'s plan on Hardcover. Returns a promise of the exit code. */
async function pushToHardcover(ask, plan, io){
  let shelved = 0, reads = 0;
  const problems = [];
  const addRead = async (userBook, edition, date, rec) => {
    const r = (await ask(C.HARDCOVER_QUERIES.addRead, {id: userBook, read: {finished_at: date, ...(edition ? {edition_id: edition} : {})}})).insert_user_book_read;
    if(!r || r.error) problems.push(`${rec.t}: read ${date} not added (${r && r.error || 'no answer'})`); else reads++;
  };
  try{
    for(const a of plan.add){
      const object = {book_id: a.book, status_id: 3, ...(a.edition ? {edition_id: a.edition} : {})};
      const r = (await ask(C.HARDCOVER_QUERIES.addBook, {object})).insert_user_book;
      if(!r || r.error || !r.id){ problems.push(`${a.recs[0].t}: not added (${r && r.error || 'no answer'})`); continue; }
      shelved++;
      for(const d of a.dates) await addRead(r.id, a.edition, d, a.recs[0]);
    }
    for(const a of plan.reads) for(const d of a.dates) await addRead(a.userBook, a.edition, d, a.recs[0]);
  }catch(exc){
    io.err(`error: ${exc.message}; stopped after putting ${shelved} book(s) on Hardcover and adding ${reads} read(s). ` +
      'Run it again to carry on: what is already there is not added twice.');
    return 1;
  }
  io.out(`put ${shelved} book(s) on your Hardcover Read shelf and added ${reads} read(s)`);
  for(const p of problems.slice(0, 15)) io.out('    ! ' + p);
  return problems.length ? 1 : 0;
}

/** Serve the project folder to this machine only (it holds your personal data). */
function cmdServe(args, io){
  const server = createServer(args.root, () => server.address().port);
  server.listen(args.port, '127.0.0.1', () => {
    io.out(`serving ${args.root} at http://localhost:${args.port}/ (Ctrl+C to stop)`);
    io.out(fs.existsSync(path.join(args.root, 'data', 'books.json'))
      ? 'edits in the page are saved to data/books.json and data/series-info.json'
      : 'showing the demo data; edits in the page stay in the browser (run `node catalog.js init` for your own)');
  });
  return null;   // keeps running
}

const COMMANDS = {
  'import-audible': {run: (a, io) => runImport(a, io, C.readAudible, 'Audible'), file: true, dryRun: true,
    help: 'add new finished books from an Audible Library Extractor CSV (--series: then look up their series on Audible)'},
  'import-goodreads': {run: (a, io) => runImport(a, io, C.readGoodreads, 'Goodreads'), file: true, dryRun: true,
    help: 'add audiobooks from a Goodreads library export CSV'},
  'export-goodreads': {run: cmdExportGoodreads, file: true, dryRun: true,
    help: 'write the catalogue to FILE as a CSV that Goodreads imports (goodreads.com/review/import)'},
  'init': {run: cmdInit, help: 'create your own git-ignored data files (--sample: start from the demo data)'},
  'validate': {run: cmdValidate, help: 'check data/ for problems'},
  'format': {run: cmdFormat, help: 'rewrite data/*.json in the current format (e.g. old ids and ISBNs as editions)'},
  'series': {run: cmdSeries, dryRun: true,
    help: 'fill in missing series, numbers and released totals from Audible, by ASIN (--store us, uk, de, ...)'},
  'hardcover-import': {run: (a, io) => cmdHardcover(a, io, 'import'), dryRun: true,
    help: `add the books on your Hardcover Read shelf, with their dates read (needs $${HARDCOVER_TOKEN_ENV})`},
  'hardcover-export': {run: (a, io) => cmdHardcover(a, io, 'export'), dryRun: true,
    help: 'put your books on your Hardcover Read shelf, with their dates read, and keep their Hardcover ids'},
  'hardcover-sync': {run: (a, io) => cmdHardcover(a, io, 'sync'), dryRun: true, help: 'hardcover-import, then hardcover-export'},
  'sync-export': {run: cmdSyncExport, file: true, dryRun: true, help: 'adopt a JSON backup exported from the app as data/books.json and data/series-info.json (and add to data/excluded.txt)'},
  'serve': {run: cmdServe, help: 'serve the app at http://localhost:8000/ (--port N); saves edits made in the page'},
};

const USAGE = `usage: node catalog.js [--root DIR] [--data-dir DIR] <command> [options]

commands:
${Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(17)}${c.help}`).join('\n')}

  --dry-run          (imports, series, hardcover-*, sync-export, export-goodreads) show what would change without writing
  --series           (import-audible) then fill in the new books' series from Audible (--store us, uk, ...)
  --data-dir DIR     folder with books.json and series-info.json (default: $${DATA_DIR_ENV},
                     then ./data, then the bundled demo)`;

function parseArgs(argv){
  const args = {root: ROOT, dataDir: null, command: null, file: null, dryRun: false, sample: false, port: 8000, store: null, series: false};
  const rest = [];
  for(let i = 0; i < argv.length; i++){
    const a = argv[i];
    const value = () => {
      if(i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if(a === '--root') args.root = value();
    else if(a === '--data-dir') args.dataDir = value();
    else if(a === '--dry-run') args.dryRun = true;
    else if(a === '--sample') args.sample = true;
    else if(a === '--port') args.port = Number(value());
    else if(a === '--store') args.store = value().toLowerCase();
    else if(a === '--series') args.series = true;
    else if(a === '-h' || a === '--help') args.help = true;
    else if(a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  [args.command, args.file] = rest;
  const cmd = COMMANDS[args.command];
  if(args.help) return args;
  if(!cmd) throw new Error(args.command ? `unknown command ${args.command}` : 'no command given');
  if(cmd.file && !args.file) throw new Error(`${args.command} needs a file`);
  if(rest.length > (cmd.file ? 2 : 1)) throw new Error(`unexpected argument ${rest[rest.length - 1]}`);
  if(args.dryRun && !cmd.dryRun) throw new Error(`${args.command} has no --dry-run`);
  if(args.sample && args.command !== 'init') throw new Error('--sample only goes with init');
  if(!Number.isInteger(args.port) || args.port <= 0) throw new Error('--port needs a port number');
  if(args.series && args.command !== 'import-audible') throw new Error('--series only goes with import-audible');
  if(args.store !== null && args.command !== 'series' && !args.series) throw new Error('--store only goes with series and import-audible --series');
  args.store = args.store || 'us';
  if(!C.AUDIBLE_STORES[args.store]) throw new Error(`--store must be one of ${Object.keys(C.AUDIBLE_STORES).join(', ')}`);
  return args;
}

/** Run a command; returns the exit code (a promise of it for `series` and `hardcover-*`, null while `serve` keeps running). */
function main(argv, io = {out: s => console.log(s), err: s => console.error(s)}){
  let args;
  try{
    args = parseArgs(argv);
  }catch(exc){
    io.err(`${USAGE}\n\nerror: ${exc.message}`);
    return 2;
  }
  if(args.help){ io.out(USAGE); return 0; }
  args.root = path.resolve(args.root);
  args.data = dataDir(args.root, args.dataDir);
  if(args.file) args.file = path.resolve(args.file);
  try{
    return COMMANDS[args.command].run(args, io);
  }catch(exc){
    return failed(exc, io);
  }
}

function failed(exc, io){
  if(exc.code === 'ENOENT'){
    io.err(`error: no such file: ${exc.path}`);
    return 1;
  }
  if(exc instanceof SyntaxError){
    io.err(`error: invalid JSON: ${exc.message}`);
    return 1;
  }
  throw exc;
}

module.exports = {main, loadBooks, loadSeriesInfo, dataDir, liveDataDir, createServer};

if(require.main === module){
  Promise.resolve(main(process.argv.slice(2))).then(code => { if(code !== null) process.exitCode = code; });
}
