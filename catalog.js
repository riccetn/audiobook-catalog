#!/usr/bin/env node
// Command line tools for the catalogue:  node catalog.js <command>
// The importers, merge and validation live in importers.js, which the page uses too.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './importers.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
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
// data/authors.json is optional: catalogues from before it have none.
const loadAuthors = file => fs.existsSync(file) ? JSON.parse(readText(file)) : {};

const dumpBooks = (books, file) => fs.writeFileSync(file, JSON.stringify(books), 'utf8');
const dumpSeriesInfo = (info, file) => fs.writeFileSync(file, JSON.stringify(info), 'utf8');
const dumpAuthors = (authors, file) => fs.writeFileSync(file, JSON.stringify(authors), 'utf8');
const authorsFile = args => path.join(args.data, 'authors.json');

/** Author info with tidy text (C.tidyAuthor), leaving out authors with nothing left. */
const tidyAuthors = authors => Object.fromEntries(Object.entries(authors).map(([name, entry]) => [name, C.tidyAuthor(entry)]).filter(([, e]) => e));

/** Check author info coming from the app: {blocking (errors), authors (tidied)}; an author left without books does not block. */
function checkAuthors(books, authors){
  const {errors} = C.validateAuthors(books, authors);
  return errors.length ? {blocking: errors} : {blocking: [], authors: tidyAuthors(authors)};
}

/** "author info: 1 added, 2 changed, 0 removed", from the old and new data/authors.json. */
function authorChanges(before, after){
  const names = Object.keys(after), oldNames = Object.keys(before);
  const added = names.filter(n => !(n in before)).length, removed = oldNames.filter(n => !(n in after)).length;
  const changed = names.filter(n => n in before && JSON.stringify(after[n]) !== JSON.stringify(before[n])).length;
  return `author info: ${added} added, ${changed} changed, ${removed} removed`;
}

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

/**
 * Entries of `entries` that data/not-duplicates.txt does not have yet. Like data/excluded.txt, the
 * file is only ever added to.
 */
function newNotDuplicates(file, entries){
  const have = new Set(fs.existsSync(file) ? C.parseNotDuplicates(readText(file)) : []);
  return C.parseNotDuplicates((entries || []).join('\n')).filter(e => !have.has(e));
}

/** Append entries to data/not-duplicates.txt, creating it (with its explanatory header) if needed. */
function appendNotDuplicates(file, lines){
  if(!lines.length) return;
  let text = fs.existsSync(file) ? readText(file) : NOT_DUPLICATES_HEADER;
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

const NOT_DUPLICATES_HEADER = `# Books the Duplicates page was told are different books ("Not duplicates"), and books whose
# editions it was told are different editions ("Keep separate"). One entry per line, written by the
# page; delete a line to have that pair offered again.
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
  C.recordLines(records, limit).forEach(line => io.out(line));
}

/** What C.merge() did, as the import commands print it. */
function printMerge(report, warnings, io){
  C.mergeLines(report, warnings).forEach(line => io.out(line));
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
  const authors = loadAuthors(authorsFile(args));
  const people = C.validateAuthors(books, authors);
  errors.push(...people.errors);
  warnings.push(...people.warnings);
  if(Array.isArray(raw) && raw.some(b => b && typeof b === 'object' && ['id', 'gr', 'isbn', 'n'].some(k => k in b))){
    io.out('note: some books keep their ids, ISBNs or narrator on the book, from before editions; they are read as editions, ' +
      'and `make format` (or any save) writes them that way');
  }
  const oldEditions = Array.isArray(raw) ? raw.filter(b => C.bookEditions(b).some(ed => 'hcb' in ed || Array.isArray(ed.isbn))).length : 0;
  if(oldEditions){
    io.out(`note: ${oldEditions} book(s) keep a Hardcover book id on an edition or several ISBNs on one edition; they are read ` +
      'with the id on the book and one edition per ISBN, and `make format` (or any save) writes them that way');
  }
  const textNames = Array.isArray(raw) ? raw.filter(b => b && typeof b === 'object' &&
    (typeof b.a === 'string' || typeof b.n === 'string' || C.bookEditions(b).some(ed => typeof ed.n === 'string'))).length : 0;
  if(textNames){
    io.out(`note: ${textNames} book(s) keep their authors or narrators as one comma separated text; they are read as lists, ` +
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
  const authorCount = authors && typeof authors === 'object' && !Array.isArray(authors) ? Object.keys(authors).length : 0;
  io.out(`${Array.isArray(books) ? books.length : 0} books, ${series.size} series, ${Object.keys(info).length} with release info, ` +
    `${authorCount} author${authorCount === 1 ? '' : 's'} with info; ` +
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
  const authorsPath = path.join(target, 'authors.json');
  if(fs.existsSync(booksPath)){
    io.err(`${shown(booksPath, args.root)} already exists; not touching it.`);
    return 1;
  }
  fs.mkdirSync(path.join(target, 'raw'), {recursive: true});
  if(args.sample){
    const demo = path.join(args.root, 'data', 'sample');
    dumpBooks(loadBooks(path.join(demo, 'books.json')), booksPath);
    dumpSeriesInfo(loadSeriesInfo(path.join(demo, 'series-info.json')), infoPath);
    dumpAuthors(loadAuthors(path.join(demo, 'authors.json')), authorsPath);
  } else {
    dumpBooks([], booksPath);
    dumpSeriesInfo({}, infoPath);
    dumpAuthors({}, authorsPath);
  }
  if(!fs.existsSync(excludedPath)) fs.writeFileSync(excludedPath, EXCLUDED_HEADER, 'utf8');
  io.out(`created ${shown(target, args.root)}/ with books.json, series-info.json, authors.json and excluded.txt`);
  io.out('next: save your Audible export in its raw/ folder and run `node catalog.js import-audible <file>`');
  return 0;
}

/** Rewrite data/*.json the way the tools write them: in the current format (with editions), as compact JSON. */
function cmdFormat(args, io){
  if(!requireOwnData(args, io)) return 2;
  const [booksPath, infoPath] = paths(args);
  dumpBooks(loadBooks(booksPath), booksPath);
  dumpSeriesInfo(loadSeriesInfo(infoPath), infoPath);
  if(fs.existsSync(authorsFile(args))) dumpAuthors(loadAuthors(authorsFile(args)), authorsFile(args));
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
  const notDupPath = path.join(args.data, 'not-duplicates.txt');
  const authorsPath = authorsFile(args);
  let newBooks, newInfo, newAuthors, excluded, notDuplicates;
  try{
    ({books: newBooks, seriesInfo: newInfo, authors: newAuthors, excluded, notDuplicates} = C.readBackup(JSON.parse(readText(args.file))));
  }catch(exc){
    io.err(`cannot read ${args.file}: ${exc.message}`);
    return 1;
  }
  const oldInfo = loadSeriesInfo(infoPath);
  const {books: tidiedBooks, tidied, blocking, errors} = checkFromApp(newBooks, newInfo, oldInfo);
  const people = newAuthors ? checkAuthors(newBooks, newAuthors) : {blocking: []};
  if(blocking.length || people.blocking.length){
    io.err('Not a valid catalogue export:\n  ' + [...blocking, ...people.blocking].slice(0, 10).join('\n  '));
    return 1;
  }
  newBooks = tidiedBooks;
  if(tidied) io.out(`tidied stray spacing / run-together initials on ${tidied} book(s)`);
  const oldBooks = loadBooks(booksPath);
  const label = b => JSON.stringify([b.t, C.namesText(b.a)]);
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
  if(people.authors) io.out(authorChanges(loadAuthors(authorsPath), people.authors));
  else io.out(`author info: not in this backup (older export), ${shown(authorsPath, args.root)} left as is`);
  const addedExcluded = newExclusions(excludedPath, excluded);
  if(excluded){
    io.out(`excluded from imports: ${addedExcluded.length} new`);
    for(const line of addedExcluded.slice(0, 10)) io.out(`    x ${line}`);
  }
  const addedNotDup = newNotDuplicates(notDupPath, notDuplicates);
  if(notDuplicates) io.out(`marked not duplicates: ${addedNotDup.length} new`);
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
  if(people.authors){
    dumpAuthors(people.authors, authorsPath);
    io.out(`wrote ${shown(authorsPath, args.root)}`);
  }
  if(addedExcluded.length){
    appendExclusions(excludedPath, addedExcluded);
    io.out(`added to ${shown(excludedPath, args.root)}`);
  }
  if(addedNotDup.length){
    appendNotDuplicates(notDupPath, addedNotDup);
    io.out(`added to ${shown(notDupPath, args.root)}`);
  }
  const orphaned = errors.filter(e => e.startsWith('series-info'));
  if(orphaned.length) io.out('series-info needs attention:\n  ' + orphaned.join('\n  '));
  return 0;
}

/**
 * Merge a backup exported on another device into data/, when both have changed since they were last
 * the same (see mergeBackup). Where both changed the same book or series info, ours is kept unless
 * --prefer-backup.
 */
function cmdMergeBackup(args, io){
  if(!requireOwnData(args, io)) return 2;
  const [booksPath, infoPath, excludedPath] = paths(args);
  const notDupPath = path.join(args.data, 'not-duplicates.txt');
  let backup;
  try{
    backup = C.readBackup(JSON.parse(readText(args.file)));
  }catch(exc){
    io.err(`cannot read ${args.file}: ${exc.message}`);
    return 1;
  }
  const oldInfo = loadSeriesInfo(infoPath);
  const authorsPath = authorsFile(args), oldAuthors = loadAuthors(authorsPath);
  const m = C.mergeBackup(loadBooks(booksPath), oldInfo, loadExclusions(excludedPath), backup, args.preferBackup ? 'backup' : 'mine',
    fs.existsSync(notDupPath) ? C.parseNotDuplicates(readText(notDupPath)) : [], oldAuthors);
  const {books, blocking, errors} = checkFromApp(m.books, m.seriesInfo, oldInfo);
  const people = checkAuthors(m.books, m.authors);
  if(blocking.length || people.blocking.length){
    io.err('The merged catalogue does not validate, nothing written:\n  ' + [...blocking, ...people.blocking].slice(0, 10).join('\n  '));
    return 1;
  }
  const side = args.preferBackup ? 'the backup\'s' : 'ours';
  io.out(`${backup.books.length} books in ${path.basename(args.file)}; ${books.length} after merging`);
  io.out(`  new from the backup: ${m.added.length}`);
  preview(m.added, io);
  io.out(`  updated (genres, dates read, editions${args.preferBackup ? ', or the backup\'s title, author or series' : ''}): ${m.updated.length}`);
  io.out(`  removed (removed on the other device): ${m.removed.length}`);
  for(const rec of m.removed.slice(0, 15)) io.out(`    - ${rec.t} - ${C.namesText(rec.a)}`);
  if(m.skipped.length) io.out(`  not added back (listed in excluded.txt): ${m.skipped.length}`);
  if(m.conflicts.length){
    io.out(`  title, author or series differ, kept ${side}: ${m.conflicts.length}`);
    const label = r => `${r.t} - ${C.namesText(r.a)}${r.s ? ` [${r.s}${r.sn ? ' #' + r.sn : ''}]` : ''}`;
    for(const {mine, theirs} of m.conflicts.slice(0, 15)) io.out(`    ~ ${label(mine)}  /  backup: ${label(theirs)}`);
  }
  io.out(`series info: ${m.infoAdded.length} added, ${m.infoChanged.length} taken from the backup, ${m.infoKept.length} differing kept as ours`);
  io.out(`author info: ${m.authorsAdded.length} added, ${m.authorsChanged.length} taken from the backup, ${m.authorsKept.length} differing kept as ours`);
  if(m.excluded.length) io.out(`excluded from imports: ${m.excluded.length} new`);
  if(m.notDuplicates.length) io.out(`marked not duplicates: ${m.notDuplicates.length} new`);
  if(args.dryRun){
    io.out('(dry run: nothing written)');
    return 0;
  }
  dumpBooks(books, booksPath);
  io.out(`wrote ${shown(booksPath, args.root)}`);
  dumpSeriesInfo(m.seriesInfo, infoPath);
  io.out(`wrote ${shown(infoPath, args.root)}`);
  if(m.authorsAdded.length || m.authorsChanged.length){
    dumpAuthors(people.authors, authorsPath);
    io.out(`wrote ${shown(authorsPath, args.root)}`);
  }
  if(m.excluded.length){
    appendExclusions(excludedPath, m.excluded);
    io.out(`added to ${shown(excludedPath, args.root)}`);
  }
  if(m.notDuplicates.length){
    appendNotDuplicates(notDupPath, m.notDuplicates);
    io.out(`added to ${shown(notDupPath, args.root)}`);
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
function writeAtomic(file, text, mode){
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp');
  fs.writeFileSync(tmp, text, {encoding: 'utf8', ...(mode ? {mode} : {})});
  if(mode) fs.chmodSync(tmp, mode);   // a file left over from an earlier write keeps its own mode
  fs.renameSync(tmp, file);
}

function sendJson(res, status, body){
  if(status >= 400 && body && body.error) res.logNote = body.error;   // for serve's log (see createServer)
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
 * demo) and that Audible lookups are, PUT {books, seriesInfo, authors, excluded, notDuplicates, base, infoBase, authorsBase}
 * writes the files (data/authors.json only when `authors` is sent), and adds the entries in
 * `excluded` (books removed in the page) to data/excluded.txt and those in `notDuplicates` (marked on the
 * duplicates page) to data/not-duplicates.txt. `base`, `infoBase` and `authorsBase` are the
 * fingerprints of the files the page's edits started from; if one of them changed since (an import,
 * sync-export or a hand edit), the save is refused rather than overwriting that change. excluded.txt
 * and not-duplicates.txt are only ever added to, so they need no such check.
 */
function handleSave(req, res, root, port){
  const dir = path.join(root, 'data');
  const booksPath = path.join(dir, 'books.json'), infoPath = path.join(dir, 'series-info.json');
  const excludedPath = path.join(dir, 'excluded.txt'), notDupPath = path.join(dir, 'not-duplicates.txt');
  const authorsPath = path.join(dir, 'authors.json');
  const writable = fs.existsSync(booksPath);
  // `audible`: this server can also look books up on Audible for the page (see handleAudible)
  // `hardcover`: the page can save a Hardcover token and import from / export to Hardcover (handleHardcover)
  if(req.method === 'GET'){ sendJson(res, 200, {writable, audible: true, hardcover: writable}); return; }
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
    let body, books, seriesInfo, authors, excluded, notDuplicates;
    try{
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      ({books, seriesInfo, authors, excluded, notDuplicates} = C.readBackup(body));
      if(!seriesInfo) throw new Error('seriesInfo missing');
    }catch(exc){ sendJson(res, 400, {error: `not a catalogue: ${exc.message}`}); return; }

    const booksText = readText(booksPath);
    const infoText = fs.existsSync(infoPath) ? readText(infoPath) : '{}';
    const authorsText = fs.existsSync(authorsPath) ? readText(authorsPath) : '{}';
    if(body.base !== C.fingerprint(booksText) || body.infoBase !== C.fingerprint(infoText) ||
       (authors && body.authorsBase !== C.fingerprint(authorsText))){
      sendJson(res, 409, {error: 'data/books.json, data/series-info.json or data/authors.json changed on disk since the page loaded it', conflict: true});
      return;
    }
    const checked = checkFromApp(books, seriesInfo, null);
    const people = authors ? checkAuthors(books, authors) : {blocking: []};
    const blocking = [...checked.blocking, ...people.blocking];
    if(blocking.length){ sendJson(res, 400, {error: 'not saved', errors: blocking.slice(0, 10)}); return; }
    const newBooksText = JSON.stringify(checked.books), newInfoText = JSON.stringify(seriesInfo);
    const newAuthorsText = people.authors ? JSON.stringify(people.authors) : authorsText;
    try{
      if(newBooksText !== booksText) writeAtomic(booksPath, newBooksText);
      if(newInfoText !== infoText) writeAtomic(infoPath, newInfoText);
      if(newAuthorsText !== authorsText) writeAtomic(authorsPath, newAuthorsText);
      appendExclusions(excludedPath, newExclusions(excludedPath, excluded));
      appendNotDuplicates(notDupPath, newNotDuplicates(notDupPath, notDuplicates));
    }catch(exc){ sendJson(res, 500, {error: `could not write: ${exc.message}`}); return; }
    sendJson(res, 200, {base: C.fingerprint(newBooksText), infoBase: C.fingerprint(newInfoText), authorsBase: C.fingerprint(newAuthorsText),
      books: checked.books, authors: JSON.parse(newAuthorsText)});
  });
}

const ASIN = /^[A-Z0-9]{10}$/;

/**
 * The page's Audible lookups, since a browser may not ask Audible itself: POST {store, groups, asins}
 * with up to AUDIBLE_BATCH ASINs answers {results: {asin: ...}} as fetchFromAudible() finds them.
 * Same-origin only, like saves, so no other site can use this server to reach Audible.
 */
function handleAudible(req, res, port, get, pause, log){
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
    const finish = startTask(log, `Audible ${groups} lookup of ${asins.length} ASIN(s) on ${C.AUDIBLE_STORES[store]}`);
    let found;
    try{
      found = await fetchFromAudible(get, pause, store, asins, groups);
    }catch(exc){
      finish(`failed: ${exc.message}`);
      sendJson(res, 502, {error: `could not reach ${C.AUDIBLE_STORES[store]} (${exc.message})`});
      return;
    }
    finish(`${[...found.values()].filter(x => x !== null).length} found`);
    sendJson(res, 200, {results: Object.fromEntries(found)});
  });
}

/** Read a JSON request body of up to `limit` bytes, then call `done(body)`; answers 413 or 400 itself. */
function readJson(req, res, limit, done){
  const chunks = [];
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if(size > limit){ sendJson(res, 413, {error: 'too large'}); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if(res.headersSent) return;
    let body;
    try{ body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }catch(exc){ sendJson(res, 400, {error: 'not JSON'}); return; }
    done(body);
  });
}

/**
 * The page's Hardcover token, kept in data/hardcover-token: GET says whether one is saved (never what
 * it is), PUT {token} saves it, DELETE removes it. Same-origin only, and only with your own data/books.json.
 */
function handleHardcoverToken(req, res, root, port){
  const dir = path.join(root, 'data'), file = path.join(dir, HARDCOVER_TOKEN_FILE);
  if(req.method === 'GET'){ sendJson(res, 200, {token: Boolean(savedHardcoverToken(dir))}); return; }
  if(!['PUT', 'DELETE'].includes(req.method)){ sendJson(res, 405, {error: 'use GET, PUT or DELETE'}); return; }
  if(!sameOrigin(req, port)){ sendJson(res, 403, {error: 'only accepted from this page'}); return; }
  if(!fs.existsSync(path.join(dir, 'books.json'))){ sendJson(res, 409, {error: 'no data/books.json: run `node catalog.js init` first'}); return; }
  if(req.method === 'DELETE'){
    try{ fs.rmSync(file, {force: true}); }catch(exc){ sendJson(res, 500, {error: `could not remove it: ${exc.message}`}); return; }
    sendJson(res, 200, {token: false});
    return;
  }
  readJson(req, res, 16 * 1024, body => {
    const token = cleanToken(body && body.token);
    if(!token || /\s/.test(token)){ sendJson(res, 400, {error: 'that is not a Hardcover API token'}); return; }
    try{
      writeAtomic(file, token + '\n', 0o600);   // readable by you alone
    }catch(exc){ sendJson(res, 500, {error: `could not save it: ${exc.message}`}); return; }
    sendJson(res, 200, {token: true});
  });
}

/** What the page sees of a Hardcover run. */
const jobView = job => job && {id: job.id, mode: job.mode, dryRun: job.dryRun, running: job.running, started: job.started,
  elapsed: (job.finished || Date.now()) - job.started, step: job.step, done: job.done, total: job.total,
  out: job.out.join('\n'), err: job.err.join('\n'), code: job.code, base: job.base, infoBase: job.infoBase};

/**
 * The page's Hardcover import, export and sync, run in the background: POST {mode: "import", "export" or
 * "sync", dryRun, base, infoBase} starts `node catalog.js hardcover-<mode>` on your own data and answers 202
 * {job} at once; GET answers {job} (the run going on, or the last one, or null) with its progress and,
 * once done, what it printed and its exit code. Like a save, a run is refused when the files changed on
 * disk since the page loaded them, and one runs at a time. `net` swaps in {fetch, pause, env} for tests.
 */
function handleHardcover(req, res, root, port, net, runs, log){
  if(req.method === 'GET'){ sendJson(res, 200, {job: jobView(runs.job)}); return; }
  if(req.method !== 'POST'){ sendJson(res, 405, {error: 'use GET or POST'}); return; }
  if(!sameOrigin(req, port)){ sendJson(res, 403, {error: 'only accepted from this page'}); return; }
  const dir = path.join(root, 'data');
  const booksPath = path.join(dir, 'books.json'), infoPath = path.join(dir, 'series-info.json');
  if(!fs.existsSync(booksPath)){ sendJson(res, 409, {error: 'no data/books.json: run `node catalog.js init` first'}); return; }
  readJson(req, res, 4 * 1024, body => {
    if(!body || !['import', 'export', 'sync'].includes(body.mode)){ sendJson(res, 400, {error: 'expected {mode: "import", "export" or "sync", dryRun}'}); return; }
    if(runs.job && runs.job.running){ sendJson(res, 409, {error: 'a Hardcover run is still going', job: jobView(runs.job)}); return; }
    const infoText = () => fs.existsSync(infoPath) ? readText(infoPath) : '{}';
    if(body.base !== C.fingerprint(readText(booksPath)) || body.infoBase !== C.fingerprint(infoText())){
      sendJson(res, 409, {error: 'data/books.json or data/series-info.json changed on disk since the page loaded it', conflict: true});
      return;
    }
    const job = runs.job = {id: runs.next++, mode: body.mode, dryRun: Boolean(body.dryRun), running: true, started: Date.now(),
      finished: null, step: 'Starting', done: null, total: null, out: [], err: [], code: null, base: null, infoBase: null};
    const io = {out: s => job.out.push(s), err: s => job.err.push(s), fetch: net.fetch, pause: net.pause, env: net.env,
      progress: (text, done, total) => Object.assign(job, {step: text, done: total ? done : null, total: total || null})};
    const finish = startTask(log, `Hardcover ${job.mode}${job.dryRun ? ' (dry run)' : ''}`);
    sendJson(res, 202, {job: jobView(job)});
    Promise.resolve().then(() => cmdHardcover({root, data: dir, dryRun: job.dryRun}, io, job.mode))
      .catch(exc => { job.err.push(`error: ${exc.message}`); return 1; })
      .then(code => {
        Object.assign(job, {code, running: false, finished: Date.now(), step: 'Done', done: null, total: null});
        try{ Object.assign(job, {base: C.fingerprint(readText(booksPath)), infoBase: C.fingerprint(infoText())}); }catch(exc){ /* left null */ }
        finish(`exit code ${code}${job.err.length ? `: ${job.err[0]}` : ''}`);
      });
  });
}

/**
 * The page's lookup of a Hardcover book by an address on hardcover.app (C.hardcoverBookId), asked with
 * the token the server keeps: POST {address} answers {id, title}, or {error} (404 when Hardcover has no
 * such book). Same-origin only, and only with your own data/books.json, like the token.
 */
function handleHardcoverBook(req, res, root, port, net){
  if(req.method !== 'POST'){ sendJson(res, 405, {error: 'use POST'}); return; }
  if(!sameOrigin(req, port)){ sendJson(res, 403, {error: 'only accepted from this page'}); return; }
  const dir = path.join(root, 'data');
  if(!fs.existsSync(path.join(dir, 'books.json'))){ sendJson(res, 409, {error: 'no data/books.json: run `node catalog.js init` first'}); return; }
  readJson(req, res, 4 * 1024, async body => {
    const address = body && typeof body.address === 'string' ? body.address : '';
    if(!C.parseHardcoverUrl(address)){ sendJson(res, 400, {error: 'not the address of a book or edition on hardcover.app'}); return; }
    const ask = hardcoverClient({fetch: net.fetch, pause: net.pause, env: net.env}, dir);
    if(!ask){ sendJson(res, 409, {error: 'no Hardcover API token: save one on the Import & export page first'}); return; }
    try{
      sendJson(res, 200, await C.hardcoverBookId(ask, address));
    }catch(exc){
      sendJson(res, /^Hardcover has no /.test(exc.message) ? 404 : 502, {error: exc.message});
    }
  });
}

// ----------------------------------------------------------- serve's log
/** serve's log: each line goes to `write` (the terminal) stamped with the local time. */
function serveLogger(write){
  return line => write(`[${new Date().toTimeString().slice(0, 8)}] ${line}`);
}

const took = ms => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

/**
 * Log that a long task (an Audible lookup, a Hardcover run) started, and return a function that logs it
 * finished, with what came of it and how long it took.
 */
function startTask(log, what){
  const started = Date.now();
  log(`started: ${what}`);
  return outcome => log(`finished: ${what}${outcome ? `, ${outcome}` : ''} (${took(Date.now() - started)})`);
}

/**
 * `get` (a fetch) that logs each request to Audible or Hardcover: method, address, the GraphQL operation,
 * status and time. Never headers or bodies: they carry the Hardcover token and your books.
 */
function loggedFetch(get, log){
  return async (url, init = {}) => {
    const started = Date.now();
    let op = '';
    try{
      // its name, or for an unnamed one ("query { me { id } }") what it asks for
      const m = /^\s*(?:query|mutation)\s*(\w*)[^{]*\{\s*(\w+)/.exec(JSON.parse(init.body).query);
      if(m) op = ` (${m[1] || m[2]})`;
    }catch(exc){ /* not GraphQL */ }
    const what = `${init.method || 'GET'} ${url}${op}`;
    try{
      const res = await get(url, init);
      log(`external: ${what} -> ${res.status} (${took(Date.now() - started)})`);
      return res;
    }catch(exc){
      log(`external: ${what} -> failed: ${exc.message} (${took(Date.now() - started)})`);
      throw exc;
    }
  };
}

/**
 * The server behind `serve`: the project folder, plus the page's saves (see handleSave) and Audible
 * lookups (handleAudible; `audible` swaps in {fetch, pause} for tests). `log` hears each API call, each
 * request to Audible or Hardcover and each long task (cmdServe prints them in the terminal).
 */
function createServer(root, port, audible = {}, hardcover = {}, log = () => {}){
  const fetchNow = (...a) => globalThis.fetch(...a);
  const get = loggedFetch(audible.fetch || fetchNow, log), pause = audible.pause || defaultPause;
  const net = {...hardcover, fetch: loggedFetch(hardcover.fetch || fetchNow, log)};
  const runs = {job: null, next: 1};   // the Hardcover run going on, or the last one (one at a time)
  return http.createServer((req, res) => {
    let file, urlPath;
    try{
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      file = path.join(root, urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath);
    }catch(e){ res.writeHead(400).end('bad request'); return; }
    if(urlPath.startsWith('/api/')){
      // the path only: request bodies carry your books and the Hardcover token
      const started = Date.now();
      res.on('close', () => log(`${req.method} ${urlPath} ${res.statusCode}${res.logNote ? ` (${res.logNote})` : ''} (${took(Date.now() - started)})`));
    }
    if(urlPath === '/api/save'){ handleSave(req, res, root, port()); return; }
    if(urlPath === '/api/audible'){ handleAudible(req, res, port(), get, pause, log); return; }
    if(urlPath === '/api/hardcover/token'){ handleHardcoverToken(req, res, root, port()); return; }
    if(urlPath === '/api/hardcover'){ handleHardcover(req, res, root, port(), net, runs, log); return; }
    if(urlPath === '/api/hardcover/book'){ handleHardcoverBook(req, res, root, port(), net); return; }
    if(!file.startsWith(root + path.sep) && file !== root){ res.writeHead(403).end('forbidden'); return; }
    // the token gives access to your Hardcover account: no page gets to read it
    if(path.basename(file).toLowerCase().includes(HARDCOVER_TOKEN_FILE)){ res.writeHead(404, {'Content-Type': 'text/plain'}).end('not found'); return; }
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
 * audibleSeries() list; for `relationships` (series ASINs), ASIN -> audibleSeriesListing(). An ASIN
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
    found.set(asin, known && (groups === 'series' ? C.audibleSeries(known) : C.audibleSeriesListing(known)));
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
  let found, report, totals, renamed;
  try{
    found = await fetchFromAudible(get, pause, args.store, asins, 'series');
    report = C.seriesFromAudible(books, found);
    const listings = await fetchFromAudible(get, pause, args.store, C.seriesListingLookups(books, info, report.series), 'relationships');
    renamed = C.boxSetTitlesFromAudible(books, report.series, listings);
    totals = C.addSeriesTotals(info, report.series, listings, args.store, new Date().toISOString().slice(0, 10));
  }catch(exc){
    io.err(`error: could not reach ${store} (${exc.message}); no series filled in`);
    return 1;
  }
  const unknown = [...found.values()].filter(x => x === null).length;

  io.out(`  series or number filled in: ${report.filled.length}`);
  preview(report.filled, io);
  if(renamed.length){
    io.out(`  box sets' titles named: ${renamed.length}`);
    for(const [b, old] of renamed.slice(0, 15)) io.out(`    ${old} -> ${b.t}`);
    if(renamed.length > 15) io.out(`    ... and ${renamed.length - 15} more`);
  }
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
  if(report.filled.length || renamed.length){
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
// Your Hardcover API token, kept with your catalogue (git-ignored, and never served to a page).
const HARDCOVER_TOKEN_FILE = 'hardcover-token';
const HARDCOVER_PAUSE_MS = 1000;   // Hardcover allows 60 requests a minute

const cleanToken = C.cleanHardcoverToken;

/** The token saved in `dir` (data/hardcover-token), or ''. */
function savedHardcoverToken(dir){
  const file = path.join(dir, HARDCOVER_TOKEN_FILE);
  return fs.existsSync(file) ? cleanToken(readText(file)) : '';
}

/**
 * A function that asks Hardcover's API one query (see C.hardcoverAsker), one request a second; null when
 * there is no token: $HARDCOVER_TOKEN, else the one saved in `dir`.
 */
function hardcoverClient(io, dir){
  const token = cleanToken((io.env || process.env)[HARDCOVER_TOKEN_ENV]) || savedHardcoverToken(dir);
  if(!token) return null;
  const pause = io.pause || (() => new Promise(done => setTimeout(done, HARDCOVER_PAUSE_MS)));
  return C.hardcoverAsker(token, io.fetch || globalThis.fetch, pause, {'user-agent': 'audiobook-catalog (personal catalogue sync)'});
}

/**
 * hardcover-import, hardcover-export and hardcover-sync (`mode` 'import', 'export' or 'sync'; see
 * C.runHardcover). `io.progress(text, done, total)`, when given, hears what it is doing (`serve` shows it
 * in the page). Returns a promise of the exit code.
 */
async function cmdHardcover(args, io, mode){
  if(!requireOwnData(args, io)) return 2;
  const ask = hardcoverClient(io, args.data);
  if(!ask){
    io.err('error: no Hardcover API token (make one at hardcover.app/account/api): save it on the Import & export ' +
      `page under make serve, put it in ${shown(path.join(args.data, HARDCOVER_TOKEN_FILE), args.root)} or set $${HARDCOVER_TOKEN_ENV}`);
    return 2;
  }
  const [booksPath, infoPath, excludedPath] = paths(args);
  const booksText = readText(booksPath);
  const books = C.fixBooks(JSON.parse(booksText));
  const save = async changed => {
    // an edit saved meanwhile (from the page) would be lost by writing, and the export plan made from an old catalogue
    if(readText(booksPath) !== booksText){
      io.err(`error: ${shown(booksPath, args.root)} changed while this ran (an edit in the page?); nothing written, ` +
        'nothing sent to Hardcover. Run it again.');
      return false;
    }
    if(changed){
      dumpBooks(books, booksPath);
      io.out(`wrote ${shown(booksPath, args.root)}`);
    }
    return true;
  };
  return C.runHardcover(books, mode, ask, {exclusions: loadExclusions(excludedPath), info: loadSeriesInfo(infoPath),
    dryRun: args.dryRun, out: io.out, err: io.err, step: io.progress, save});
}

function cmdServe(args, io){
  const server = createServer(args.root, () => server.address().port, {}, {}, serveLogger(io.out));
  server.listen(args.port, '127.0.0.1', () => {
    io.out(`serving ${args.root} at http://localhost:${args.port}/ (Ctrl+C to stop)`);
    io.out(fs.existsSync(path.join(args.root, 'data', 'books.json'))
      ? 'edits in the page are saved to data/books.json, data/series-info.json and data/authors.json'
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
    help: `add the books on your Hardcover Read shelf, with their dates read (needs your Hardcover API token)`},
  'hardcover-export': {run: (a, io) => cmdHardcover(a, io, 'export'), dryRun: true,
    help: 'put your books on your Hardcover Read shelf, with their dates read, and keep their Hardcover ids'},
  'hardcover-sync': {run: (a, io) => cmdHardcover(a, io, 'sync'), dryRun: true, help: 'hardcover-import, then hardcover-export'},
  'sync-export': {run: cmdSyncExport, file: true, dryRun: true, help: 'adopt a JSON backup exported from the app as data/books.json, data/series-info.json and data/authors.json (and add to data/excluded.txt and data/not-duplicates.txt)'},
  'merge-backup': {run: cmdMergeBackup, file: true, dryRun: true,
    help: 'merge a JSON backup from another device into data/ when both have changed (--prefer-backup: its edits win)'},
  'serve': {run: cmdServe, help: 'serve the app at http://localhost:8000/ (--port N); saves edits made in the page'},
};

const USAGE = `usage: node catalog.js [--root DIR] [--data-dir DIR] <command> [options]

commands:
${Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(17)}${c.help}`).join('\n')}

  --dry-run          (imports, series, hardcover-*, sync-export, merge-backup, export-goodreads) show what would change without writing
  --series           (import-audible) then fill in the new books' series from Audible (--store us, uk, ...)
  --data-dir DIR     folder with books.json, series-info.json and authors.json (default: $${DATA_DIR_ENV},
                     then ./data, then the bundled demo)`;

function parseArgs(argv){
  const args = {root: ROOT, dataDir: null, command: null, file: null, dryRun: false, preferBackup: false, sample: false, port: 8000, store: null, series: false};
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
    else if(a === '--prefer-backup') args.preferBackup = true;
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
  if(args.preferBackup && args.command !== 'merge-backup') throw new Error('--prefer-backup only goes with merge-backup');
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

export {main, loadBooks, loadSeriesInfo, loadAuthors, dataDir, liveDataDir, createServer};

// Run as a command (node catalog.js ...), not imported by the tests.
if(process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)){
  Promise.resolve(main(process.argv.slice(2))).then(code => { if(code !== null) process.exitCode = code; });
}
