// What every page shares: loading the catalogue, keeping edits (in this browser and, with `make serve`,
// on disk), the status line and the page links. Each page's own module starts with startPage(), handing
// it a refresh() that redraws the page from DATA.
import * as CatalogImport from './importers.js';

const LS_KEY = 'audiobook-catalog-data';
// A catalogue kept in this browser alone, for a copy of the app with no data/books.json of its own (the
// app installed on a phone from a static host): {books, seriesInfo, excluded}. It starts with a Restore.
const DEVICE_KEY = 'audiobook-catalog-device';
// Served from the project root: your own catalogue in data/ if it exists, otherwise the bundled demo.
const DATA_DIRS = ['data/', 'data/sample/'];

export let DATA = [];
export let SERIES_INFO = {};
export let BASELINE = '';
export let INFO_BASELINE = '';        // same, for series-info.json
let STARTUP_NOTICE = '';
export let EXCLUSIONS = CatalogImport.parseExclusions('');   // data/excluded.txt: books imports must never re-add
export let NEW_EXCLUDED = [];         // entries added to EXCLUSIONS in the page that data/excluded.txt does not have yet
export let DISK_SAVE = false;         // `make serve` saves edits straight to data/books.json and data/series-info.json
let SAVING = false;            // a save to disk is on its way
let SAVE_AGAIN = false;        // more edits came in while it was
export let LOCAL_SEEN = null;         // what this page last read from or wrote to localStorage[storeKey()]
let DATA_DIR = '';             // where the data files came from: 'data/', or 'data/sample/' for the demo
export let ON_DEVICE = false;         // the catalogue is this browser's own (DEVICE_KEY), not the files it was served
export let AUDIBLE_LOOKUP = false;    // `make serve` can look books up on Audible for the page (api/audible)
export let HARDCOVER = false;         // `make serve` with your own data can import from and export to Hardcover (api/hardcover)

// A module's bindings can only be assigned in the module itself, so the pages replace these through here.
export function setData(books){ DATA = books; }
export function setSeriesInfo(info){ SERIES_INFO = info; }

// The page's own hooks, from startPage(): refreshPage() redraws it from DATA; onHardcoverJob(job) and
// onHardcoverDone(job), when the page has them, do more with a Hardcover run (see followHardcover).
let refreshPage = ()=>{}, onHardcoverJob = null, onHardcoverDone = null;

// Pairs of books marked "Not duplicates", and books whose editions were marked "Keep separate", on the
// duplicates page. Kept in this browser, and with `make serve` in data/not-duplicates.txt (only ever
// added to, like data/excluded.txt); backups carry them too.
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
export let NOT_DUPLICATES = new Set();
let NOT_DUP_ON_DISK = new Set();   // the entries data/not-duplicates.txt has
try{
  const saved = JSON.parse(localStorage.getItem(NOT_DUP_KEY) || '[]');
  if(Array.isArray(saved)) NOT_DUPLICATES = new Set(saved.filter(x=> typeof x === 'string'));
}catch(e){}

// Add marks to NOT_DUPLICATES (and this browser's copy); returns how many were new. They reach
// data/not-duplicates.txt with the next save to disk.
export function addNotDuplicates(entries){
  const before = NOT_DUPLICATES.size;
  entries.forEach(e=> NOT_DUPLICATES.add(e));
  try{ localStorage.setItem(NOT_DUP_KEY, JSON.stringify([...NOT_DUPLICATES])); }catch(e){}
  return NOT_DUPLICATES.size - before;
}

// Marks data/not-duplicates.txt does not have yet.
export const pendingNotDuplicates = () => [...NOT_DUPLICATES].filter(k=> !NOT_DUP_ON_DISK.has(k));

// Dates read of a book; [] when it has none (or something that is not a list of dates).
export const readDates = b => Array.isArray(b.r) ? b.r.filter(d => typeof d === 'string') : [];

export function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const storeKey = () => ON_DEVICE ? DEVICE_KEY : LS_KEY;

export function localNow(){
  try{ return localStorage.getItem(storeKey()); }catch(e){ return null; }
}

// The page links: the duplicates link says how many duplicates and books with split editions there are.
export function updateNav(){
  const n = CatalogImport.findDuplicates(DATA, NOT_DUPLICATES).length + CatalogImport.splitEditions(DATA, NOT_DUPLICATES).length;
  document.getElementById('dupCount').textContent = n ? ` (${n})` : '';
}

// Where edits go: with `make serve` and your own data/books.json, straight to disk (saveToDisk).
// Every edit is also kept in localStorage until the disk has it, so nothing is lost if a save fails
// (server stopped, or the files changed on disk meanwhile); with any other server, or the demo data,
// localStorage is all there is, and Export + `node catalog.js sync-export` bring edits back to data/.
// Another page or tab that saved meanwhile would be overwritten, so then nothing is saved.
export function persist(){
  updateNav();
  if(localNow() !== LOCAL_SEEN){
    showIoStatus('The catalogue was changed in another tab. Reload this page to see that; this change was not saved.', true);
    return;
  }
  saveLocally();
  if(DISK_SAVE) saveToDisk();
}

function saveLocally(){
  if(ON_DEVICE){
    try{
      localStorage.setItem(DEVICE_KEY, JSON.stringify({books: DATA, seriesInfo: SERIES_INFO, excluded: EXCLUSIONS.entries}));
      LOCAL_SEEN = localNow();
    }catch(e){
      // nothing else holds this catalogue, so say so instead of losing the edit quietly
      showIoStatus('Not saved: this device refused to store the catalogue (is its storage full?). Export a backup.', true);
    }
    return;
  }
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({base: BASELINE, data: DATA, infoBase: INFO_BASELINE, info: SERIES_INFO, excluded: NEW_EXCLUDED}));
    LOCAL_SEEN = localNow();
  }catch(e){}
}

// Add entries (an ASIN, "ISBN 978...", "Goodreads 12345" or "Title | Author") to the books imports skip; returns how many were new.
export function addExclusions(entries){
  const added = entries.map(e=> EXCLUSIONS.add(e)).filter(Boolean);
  NEW_EXCLUDED.push(...added);
  return added.length;
}

// The end of a status message about an edit: how to get it into the data file, unless that happens anyway.
export function keepHint(file){
  return DISK_SAVE || ON_DEVICE ? '' : ` Export it on the Import & export page and run sync-export to keep it in ${file}.`;
}

async function saveToDisk(){
  if(SAVING){ SAVE_AGAIN = true; return; }
  SAVING = true;
  SAVE_AGAIN = false;
  let res, body;
  const excluded = NEW_EXCLUDED.slice(), notDuplicates = pendingNotDuplicates();
  try{
    res = await fetch('api/save', {
      method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({books: DATA, seriesInfo: SERIES_INFO, excluded, notDuplicates, base: BASELINE, infoBase: INFO_BASELINE}),
    });
    body = await res.json();
  }catch(e){
    SAVING = false;
    showIoStatus('Not saved to disk (is `make serve` still running?). Your edits are kept in this browser.', true);
    return;
  }
  SAVING = false;
  if(!res.ok){
    const why = body.conflict
      ? 'data/books.json changed on disk since this page loaded it. Export your edits here, then reload the page.'
      : [body.error, ...(body.errors || [])].filter(Boolean).join('; ');
    showIoStatus(`Not saved to disk: ${why} Your edits are kept in this browser.`, true);
    return;
  }
  BASELINE = body.base;
  INFO_BASELINE = body.infoBase;
  NEW_EXCLUDED = NEW_EXCLUDED.slice(excluded.length);   // data/excluded.txt has those now
  notDuplicates.forEach(k=> NOT_DUP_ON_DISK.add(k));    // and data/not-duplicates.txt these
  if(SAVE_AGAIN){ saveLocally(); saveToDisk(); return; }
  // the disk has everything now (tidied the way sync-export tidies); the browser copy is no longer needed
  if(JSON.stringify(body.books) !== JSON.stringify(DATA)){ DATA = body.books; refreshPage(); updateNav(); }
  try{ localStorage.removeItem(LS_KEY); LOCAL_SEEN = null; }catch(e){}
  if(!document.getElementById('ioStatus').textContent) showIoStatus('Saved.');
}

/**
 * Make this browser's copy the catalogue itself, when the page has no data/books.json of its own (the
 * demo is showing): from now on it loads from and saves to DEVICE_KEY, and no update of the demo data
 * can set it aside. Returns whether it did. Called when a backup is restored.
 */
export function keepOnDevice(){
  if(ON_DEVICE || DATA_DIR === 'data/') return false;
  ON_DEVICE = true;
  LOCAL_SEEN = localNow();
  askToKeepStorage();
  return true;
}

// Ask the browser not to clear this site's storage when space runs low; on a phone it may otherwise.
function askToKeepStorage(){
  try{ navigator.storage.persist().catch(()=>{}); }catch(e){}
}

// The catalogue kept on this device, if there is one; loads it and returns true.
function loadDeviceCopy(){
  try{
    const raw = localStorage.getItem(DEVICE_KEY);
    if(!raw) return false;
    const {books, seriesInfo, excluded} = CatalogImport.readBackup(JSON.parse(raw));
    DATA = books;                     // readBackup has migrated them already
    SERIES_INFO = seriesInfo || {};
    EXCLUSIONS = CatalogImport.parseExclusions('');
    (excluded || []).forEach(e=> EXCLUSIONS.add(e));
    BASELINE = INFO_BASELINE = '';
    LOCAL_SEEN = raw;
    return true;
  }catch(e){ return false; }
}

// Whether the server saves edits (only `make serve`, and only to your own data/books.json). Also
// notes whether it looks books up on Audible (`make serve`, with the demo data too).
async function detectDiskSave(dir){
  try{
    const res = await fetch('api/save', {cache: 'no-cache'});
    const body = res.ok ? await res.json() : {};
    AUDIBLE_LOOKUP = body.audible === true;
    HARDCOVER = dir === 'data/' && body.hardcover === true;
    return dir === 'data/' && body.writable === true;
  }catch(e){ return false; }
}

export function showIoStatus(msg, isErr){
  const el = document.getElementById('ioStatus');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.textContent = ''; }, 5000);
}

async function fetchText(url){
  const res = await fetch(url, {cache: 'no-cache'});
  if(!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function loadData(){
  for(const dir of DATA_DIRS){
    let booksText;
    try{ booksText = await fetchText(dir + 'books.json'); }catch(e){ continue; }
    let infoText = '{}';
    try{ infoText = await fetchText(dir + 'series-info.json'); }catch(e){}
    let excludedText = '', notDupText = '';
    try{ excludedText = await fetchText(dir + 'excluded.txt'); }catch(e){}
    try{ notDupText = await fetchText(dir + 'not-duplicates.txt'); }catch(e){}
    return {dir, booksText, infoText, excludedText, notDupText};
  }
  throw new Error('no books.json found');
}

// Local edits are only reused if they were made against *this* books.json (and series-info.json, for
// saves that carry series info); otherwise an updated data file would keep showing stale data.
// Returns whether there were edits to reuse.
function restoreLocalEdits(){
  try{
    const raw = LOCAL_SEEN = localStorage.getItem(LS_KEY);
    if(!raw) return false;
    const saved = JSON.parse(raw);
    const hasInfo = saved && typeof saved.info === 'object' && saved.info !== null && !Array.isArray(saved.info);
    if(saved && saved.base === BASELINE && Array.isArray(saved.data) && (!hasInfo || saved.infoBase === INFO_BASELINE)){
      DATA = CatalogImport.fixBooks(saved.data);
      if(hasInfo) SERIES_INFO = saved.info;
      if(Array.isArray(saved.excluded)) addExclusions(saved.excluded.filter(x=> typeof x === 'string'));
      return true;
    } else {
      localStorage.setItem(LS_KEY + '.backup', raw);
      localStorage.removeItem(LS_KEY);
      LOCAL_SEEN = null;
      STARTUP_NOTICE = 'The catalogue data has changed; earlier local edits were set aside, not deleted.';
    }
  }catch(e){}
  return false;
}

// Whether edits made here have not reached data/ yet (a save on its way, or one that failed).
export function unsavedEdits(){
  if(SAVING) return true;
  try{ return localStorage.getItem(LS_KEY) !== null; }catch(e){ return false; }
}

// Load the catalogue from data/ again, after the server changed it (a Hardcover import), and redraw.
export async function reloadFromDisk(){
  const {booksText, infoText, excludedText} = await loadData();
  DATA = CatalogImport.fixBooks(JSON.parse(booksText));
  SERIES_INFO = JSON.parse(infoText);
  EXCLUSIONS = CatalogImport.parseExclusions(excludedText);
  NEW_EXCLUDED = [];
  BASELINE = CatalogImport.fingerprint(booksText);
  INFO_BASELINE = CatalogImport.fingerprint(infoText);
  refreshPage();
  updateNav();
}

// ------------------------------------------------------------ Hardcover runs
// A Hardcover import, export or sync runs on the server (`make serve`, api/hardcover) and can take
// minutes, one request a second. Every page shows it while it goes (#bgTask), also when it was started
// in another tab or before a reload, and redraws from data/ when it has changed the catalogue. A page
// may pass onHardcoverJob(job) (each update) and onHardcoverDone(job) (when it ends) to startPage to do more.
export let HARDCOVER_JOB = null;      // the run going on, as the server last described it
let HARDCOVER_POLL_MS = 1000;
let FOLLOWING = null;          // the promise of following a run, while one is followed
const HARDCOVER_VERBS = {import: 'Importing from Hardcover', export: 'Exporting to Hardcover', sync: 'Syncing with Hardcover'};
const HARDCOVER_PREVIEWS = {import: 'Checking what a Hardcover import would do', export: 'Checking what a Hardcover export would do',
  sync: 'Checking what a Hardcover sync would do'};

export const minutes = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function showHardcoverJob(job){
  const el = document.getElementById('bgTask');
  if(el){
    el.classList.toggle('show', Boolean(job && job.running));
    if(!job || !job.running) el.innerHTML = '';
    else {
      const counted = Number.isInteger(job.total) && job.total > 0;
      const here = location.pathname.endsWith('import.html');
      el.innerHTML = `<span class="spinner" aria-hidden="true"></span><div class="bgTaskText">` +
        `<strong>${esc((job.dryRun ? HARDCOVER_PREVIEWS : HARDCOVER_VERBS)[job.mode] || 'Working with Hardcover')}</strong>` +
        ` <span class="bgTaskTime">${minutes(job.elapsed)}</span><br>${esc(job.step || '')}` +
        (counted ? `: ${job.done} of ${job.total} <progress max="${job.total}" value="${job.done}"></progress>` : '') +
        (job.dryRun ? '' : '<br><small>Please don\'t edit the catalogue until it is done: an edit saved meanwhile stops it before anything is written.</small>') +
        (here ? '' : ' <a href="import.html">Details</a>') + '</div>';
    }
  }
  if(onHardcoverJob) onHardcoverJob(job);
}

// When a run that changed nothing in the page's own view ends on a page with nothing more to say.
async function hardcoverDoneQuietly(job){
  if(!job.dryRun && job.base && job.base !== BASELINE && !unsavedEdits()){
    try{ await reloadFromDisk(); }catch(e){}
  }
  showIoStatus(job.code === 0 ? `${HARDCOVER_VERBS[job.mode]}: done.` : `${HARDCOVER_VERBS[job.mode]} did not finish cleanly; see Import & export.`, job.code !== 0);
}

/**
 * Show `job` (a run the server described) until it ends, asking the server again every HARDCOVER_POLL_MS,
 * then hand it to onHardcoverDone. Returns a promise of the ended run (null if the server went away).
 */
export function followHardcover(job){
  if(FOLLOWING) return FOLLOWING;
  FOLLOWING = (async ()=>{
    HARDCOVER_JOB = job;
    showHardcoverJob(job);
    while(job && job.running){
      await new Promise(resolve => setTimeout(resolve, HARDCOVER_POLL_MS));
      try{ job = (await (await fetch('api/hardcover', {cache: 'no-cache'})).json()).job; }
      catch(e){ job = null; showIoStatus('Lost touch with the server (is `make serve` still running?).', true); }
      HARDCOVER_JOB = job && job.running ? job : null;
      showHardcoverJob(job);
    }
    HARDCOVER_JOB = null;
    FOLLOWING = null;
    if(job) await (onHardcoverDone ? onHardcoverDone(job) : hardcoverDoneQuietly(job));
    return job;
  })();
  return FOLLOWING;
}

// A run may be going on already (started in another tab, or before this page was loaded).
async function checkHardcover(){
  try{
    const {job} = await (await fetch('api/hardcover', {cache: 'no-cache'})).json();
    if(job && job.running) await followHardcover(job);
  }catch(e){}
}

/**
 * Load the catalogue (with this browser's unsaved edits), then let the page draw itself with `init`.
 * `page.refresh` redraws the page from DATA after a save to disk tidied the books or a Hardcover run
 * changed them; `page.onHardcoverJob` and `page.onHardcoverDone` are optional (see followHardcover).
 */
export async function startPage(init, page){
  ({refresh: refreshPage, onHardcoverJob = null, onHardcoverDone = null} = page);
  try{
    const {dir, booksText, infoText, excludedText, notDupText} = await loadData();
    DATA = CatalogImport.fixBooks(JSON.parse(booksText));   // "r": "2024-03-15" -> ["2024-03-15"]
    SERIES_INFO = JSON.parse(infoText);
    EXCLUSIONS = CatalogImport.parseExclusions(excludedText);
    NOT_DUP_ON_DISK = new Set(CatalogImport.parseNotDuplicates(notDupText));
    NOT_DUP_ON_DISK.forEach(k=> NOT_DUPLICATES.add(k));
    BASELINE = CatalogImport.fingerprint(booksText);
    INFO_BASELINE = CatalogImport.fingerprint(infoText);
    DATA_DIR = dir;
    DISK_SAVE = await detectDiskSave(dir);
  }catch(e){
    document.getElementById('subtitle').textContent =
      "Couldn't load the catalogue data. Serve this folder over HTTP (make serve) instead of opening the file directly.";
    return;
  }
  ON_DEVICE = DATA_DIR !== 'data/' && loadDeviceCopy();
  if(ON_DEVICE) askToKeepStorage();
  const restored = !ON_DEVICE && restoreLocalEdits();
  init();
  updateNav();
  if(HARDCOVER) checkHardcover();   // not awaited: it follows a run as long as it goes
  if(STARTUP_NOTICE) showIoStatus(STARTUP_NOTICE, true);
  // edits a failed save left in this browser, or marks made before they were saved to a file
  else if(DISK_SAVE && (restored || pendingNotDuplicates().length)) await saveToDisk();
}

// Installable as an app (on a phone, say), and usable offline once it is: see sw.js.
try{ navigator.serviceWorker.register('sw.js').catch(()=>{}); }catch(e){}
