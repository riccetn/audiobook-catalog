// What every page shares: loading the catalogue, keeping edits (in this browser and, with `make serve`,
// on disk), the status line and the page links. Each page's own script defines refreshPage(), which
// redraws it from DATA, and starts with startPage().
const LS_KEY = 'audiobook-catalog-data';
// A catalogue kept in this browser alone, for a copy of the app with no data/books.json of its own (the
// app installed on a phone from a static host): {books, seriesInfo, excluded}. It starts with a Restore.
const DEVICE_KEY = 'audiobook-catalog-device';
// Served from the project root: your own catalogue in data/ if it exists, otherwise the bundled demo.
const DATA_DIRS = ['data/', 'data/sample/'];

let DATA = [];
let SERIES_INFO = {};
let BASELINE = '';
let INFO_BASELINE = '';        // same, for series-info.json
let STARTUP_NOTICE = '';
let EXCLUSIONS = CatalogImport.parseExclusions('');   // data/excluded.txt: books imports must never re-add
let NEW_EXCLUDED = [];         // entries added to EXCLUSIONS in the page that data/excluded.txt does not have yet
let DISK_SAVE = false;         // `make serve` saves edits straight to data/books.json and data/series-info.json
let SAVING = false;            // a save to disk is on its way
let SAVE_AGAIN = false;        // more edits came in while it was
let LOCAL_SEEN = null;         // what this page last read from or wrote to localStorage[storeKey()]
let DATA_DIR = '';             // where the data files came from: 'data/', or 'data/sample/' for the demo
let ON_DEVICE = false;         // the catalogue is this browser's own (DEVICE_KEY), not the files it was served
let AUDIBLE_LOOKUP = false;    // `make serve` can look books up on Audible for the page (api/audible)
let HARDCOVER = false;         // `make serve` with your own data can import from and export to Hardcover (api/hardcover)

// Pairs of books marked "Not duplicates", and books whose editions were marked "Keep separate", on the
// duplicates page. Kept in this browser, and with `make serve` in data/not-duplicates.txt (only ever
// added to, like data/excluded.txt); backups carry them too.
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
let NOT_DUPLICATES = new Set();
let NOT_DUP_ON_DISK = new Set();   // the entries data/not-duplicates.txt has
try{
  const saved = JSON.parse(localStorage.getItem(NOT_DUP_KEY) || '[]');
  if(Array.isArray(saved)) NOT_DUPLICATES = new Set(saved.filter(x=> typeof x === 'string'));
}catch(e){}

// Add marks to NOT_DUPLICATES (and this browser's copy); returns how many were new. They reach
// data/not-duplicates.txt with the next save to disk.
function addNotDuplicates(entries){
  const before = NOT_DUPLICATES.size;
  entries.forEach(e=> NOT_DUPLICATES.add(e));
  try{ localStorage.setItem(NOT_DUP_KEY, JSON.stringify([...NOT_DUPLICATES])); }catch(e){}
  return NOT_DUPLICATES.size - before;
}

// Marks data/not-duplicates.txt does not have yet.
const pendingNotDuplicates = () => [...NOT_DUPLICATES].filter(k=> !NOT_DUP_ON_DISK.has(k));

// Dates read of a book; [] when it has none (or something that is not a list of dates).
const readDates = b => Array.isArray(b.r) ? b.r.filter(d => typeof d === 'string') : [];

function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const storeKey = () => ON_DEVICE ? DEVICE_KEY : LS_KEY;

function localNow(){
  try{ return localStorage.getItem(storeKey()); }catch(e){ return null; }
}

// The page links: the duplicates link says how many duplicates and books with split editions there are.
function updateNav(){
  const n = CatalogImport.findDuplicates(DATA, NOT_DUPLICATES).length + CatalogImport.splitEditions(DATA, NOT_DUPLICATES).length;
  document.getElementById('dupCount').textContent = n ? ` (${n})` : '';
}

// Where edits go: with `make serve` and your own data/books.json, straight to disk (saveToDisk).
// Every edit is also kept in localStorage until the disk has it, so nothing is lost if a save fails
// (server stopped, or the files changed on disk meanwhile); with any other server, or the demo data,
// localStorage is all there is, and Export + `node catalog.js sync-export` bring edits back to data/.
// Another page or tab that saved meanwhile would be overwritten, so then nothing is saved.
function persist(){
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
function addExclusions(entries){
  const added = entries.map(e=> EXCLUSIONS.add(e)).filter(Boolean);
  NEW_EXCLUDED.push(...added);
  return added.length;
}

// The end of a status message about an edit: how to get it into the data file, unless that happens anyway.
function keepHint(file){
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
function keepOnDevice(){
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

function showIoStatus(msg, isErr){
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
function unsavedEdits(){
  if(SAVING) return true;
  try{ return localStorage.getItem(LS_KEY) !== null; }catch(e){ return false; }
}

// Load the catalogue from data/ again, after the server changed it (a Hardcover import), and redraw.
async function reloadFromDisk(){
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

// Load the catalogue (with this browser's unsaved edits), then let the page draw itself with `init`.
async function startPage(init){
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
  if(STARTUP_NOTICE) showIoStatus(STARTUP_NOTICE, true);
  // edits a failed save left in this browser, or marks made before they were saved to a file
  else if(DISK_SAVE && (restored || pendingNotDuplicates().length)) await saveToDisk();
}

// Installable as an app (on a phone, say), and usable offline once it is: see sw.js.
try{ navigator.serviceWorker.register('sw.js').catch(()=>{}); }catch(e){}
