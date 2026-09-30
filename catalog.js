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

// ---------------------------------------------------------------------- commands
const DEMO_NOTE = 'note: no data/books.json found, so this is the bundled demo data (data/sample). ' +
  'Run `node catalog.js init` to start your own catalogue.';

const EXCLUDED_HEADER = `# Books that imports must never re-add (because you removed them on purpose).
# One entry per line; anything after '#' is a comment. Either:
#   B0XXXXXXXX                  an Audible ASIN
#   Some Title | Some Author    for books with no ASIN (e.g. Goodreads-only entries)
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

function runImport(args, io, read, label){
  if(!requireOwnData(args, io)) return 2;
  const [booksPath, infoPath, excludedPath] = paths(args);
  const books = loadBooks(booksPath);
  const result = read(readText(args.file));
  const report = C.merge(books, result.records, loadExclusions(excludedPath));

  io.out(`${label}: ${result.records.length} finished books read from ${path.basename(args.file)}`);
  io.out(`  already in the catalogue: ${report.matched}`);
  if(report.backfilled.length) io.out(`  Audible ids filled in on existing books: ${report.backfilled.length}`);
  if(report.datesFilled.length) io.out(`  dates read filled in on existing books: ${report.datesFilled.length}`);
  if(report.excluded.length) io.out(`  skipped (listed in data/excluded.txt): ${report.excluded.length}`);
  io.out(`  new: ${report.added.length}`);
  preview(report.added, io);
  if(result.warnings.length){
    io.out(`  needs a look (${result.warnings.length}):`);
    for(const w of result.warnings.slice(0, 15)) io.out('    ! ' + w);
  }

  const {errors} = C.validate(books, loadSeriesInfo(infoPath));
  if(errors.length){
    io.err('Validation failed, nothing written:\n  ' + errors.slice(0, 10).join('\n  '));
    return 1;
  }
  if(args.dryRun){
    io.out('(dry run: nothing written)');
    return 0;
  }
  dumpBooks(books, booksPath);
  io.out(`wrote ${shown(booksPath, args.root)}`);
  return 0;
}

function cmdValidate(args, io){
  const [booksPath, infoPath] = paths(args);
  if(isDemo(args.root, args.data)) io.out(DEMO_NOTE);
  const books = loadBooks(booksPath), info = loadSeriesInfo(infoPath);
  const {errors, warnings} = C.validate(books, info);
  for(const w of warnings) io.out('warning: ' + w);
  for(const e of errors) io.out('error: ' + e);
  const series = new Set(Array.isArray(books) ? books.filter(b => b && b.s).map(b => b.s) : []);
  io.out(`${Array.isArray(books) ? books.length : 0} books, ${series.size} series, ${Object.keys(info).length} with release info; ` +
    `${errors.length} error(s), ${warnings.length} warning(s)`);
  return errors.length ? 1 : 0;
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

/** Rewrite data/*.json in the canonical layout (one book per line, series-info sorted). */
function cmdFormat(args, io){
  if(!requireOwnData(args, io)) return 2;
  const [booksPath, infoPath] = paths(args);
  dumpBooks(loadBooks(booksPath), booksPath);
  dumpSeriesInfo(loadSeriesInfo(infoPath), infoPath);
  io.out('data files rewritten in canonical layout');
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

/** Replace data/books.json (and data/series-info.json, if the backup has it) with a backup exported from the app. */
function cmdSyncExport(args, io){
  if(!requireOwnData(args, io)) return 2;
  const [booksPath, infoPath] = paths(args);
  let newBooks, newInfo;
  try{
    ({books: newBooks, seriesInfo: newInfo} = C.readBackup(JSON.parse(readText(args.file))));
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
  const orphaned = errors.filter(e => e.startsWith('series-info'));
  if(orphaned.length) io.out('series-info needs attention:\n  ' + orphaned.join('\n  '));
  return 0;
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
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
 * demo), PUT {books, seriesInfo, base, infoBase} writes both files. `base` and `infoBase` are the
 * fingerprints of the files the page's edits started from; if either file changed since (an import,
 * sync-export or a hand edit), the save is refused rather than overwriting that change.
 */
function handleSave(req, res, root, port){
  const dir = path.join(root, 'data');
  const booksPath = path.join(dir, 'books.json'), infoPath = path.join(dir, 'series-info.json');
  const writable = fs.existsSync(booksPath);
  if(req.method === 'GET'){ sendJson(res, 200, {writable}); return; }
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
    let body, books, seriesInfo;
    try{
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      ({books, seriesInfo} = C.readBackup(body));
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
    }catch(exc){ sendJson(res, 500, {error: `could not write: ${exc.message}`}); return; }
    sendJson(res, 200, {base: C.fingerprint(newBooksText), infoBase: C.fingerprint(newInfoText), books: checked.books});
  });
}

/** The server behind `serve`: the project folder, plus the page's saves (see handleSave). */
function createServer(root, port){
  return http.createServer((req, res) => {
    let file, urlPath;
    try{
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      file = path.join(root, urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath);
    }catch(e){ res.writeHead(400).end('bad request'); return; }
    if(urlPath === '/api/save'){ handleSave(req, res, root, port()); return; }
    if(!file.startsWith(root + path.sep) && file !== root){ res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, body) => {
      if(err){ res.writeHead(404, {'Content-Type': 'text/plain'}).end('not found'); return; }
      res.writeHead(200, {'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
      res.end(body);
    });
  });
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
    help: 'add new finished books from an Audible Library Extractor CSV'},
  'import-goodreads': {run: (a, io) => runImport(a, io, C.readGoodreads, 'Goodreads'), file: true, dryRun: true,
    help: 'add audiobooks from a Goodreads library export CSV'},
  'init': {run: cmdInit, help: 'create your own git-ignored data files (--sample: start from the demo data)'},
  'validate': {run: cmdValidate, help: 'check data/ for problems'},
  'format': {run: cmdFormat, help: 'rewrite data/*.json in the canonical layout'},
  'sync-export': {run: cmdSyncExport, file: true, dryRun: true, help: 'adopt a JSON backup exported from the app as data/books.json and data/series-info.json'},
  'serve': {run: cmdServe, help: 'serve the app at http://localhost:8000/ (--port N); saves edits made in the page'},
};

const USAGE = `usage: node catalog.js [--root DIR] [--data-dir DIR] <command> [options]

commands:
${Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(17)}${c.help}`).join('\n')}

  --dry-run          (imports, sync-export) show what would change without writing
  --data-dir DIR     folder with books.json and series-info.json (default: $${DATA_DIR_ENV},
                     then ./data, then the bundled demo)`;

function parseArgs(argv){
  const args = {root: ROOT, dataDir: null, command: null, file: null, dryRun: false, sample: false, port: 8000};
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
  return args;
}

/** Run a command; returns the exit code (null while `serve` keeps running). */
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
}

module.exports = {main, loadBooks, loadSeriesInfo, dataDir, liveDataDir, createServer};

if(require.main === module){
  const code = main(process.argv.slice(2));
  if(code !== null) process.exitCode = code;
}
