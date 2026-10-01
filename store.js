// What every page shares: loading the catalogue, keeping edits (in this browser and, with `make serve`,
// on disk), the status line and the page links. Each page's own script defines refreshPage(), which
// redraws it from DATA, and starts with startPage().
const LS_KEY = 'audiobook-catalog-data';
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
let LOCAL_SEEN = null;         // what this page last read from or wrote to localStorage[LS_KEY]

// Pairs of books marked "Not duplicates" on the duplicates page; kept in this browser only.
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
let NOT_DUPLICATES = new Set();
try{
  const saved = JSON.parse(localStorage.getItem(NOT_DUP_KEY) || '[]');
  if(Array.isArray(saved)) NOT_DUPLICATES = new Set(saved.filter(x=> typeof x === 'string'));
}catch(e){}

// Dates read of a book; [] when it has none (or something that is not a list of dates).
const readDates = b => Array.isArray(b.r) ? b.r.filter(d => typeof d === 'string') : [];

function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function localNow(){
  try{ return localStorage.getItem(LS_KEY); }catch(e){ return null; }
}

// The page links: the duplicates link says how many there are.
function updateNav(){
  const n = CatalogImport.findDuplicates(DATA, NOT_DUPLICATES).length;
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
  return DISK_SAVE ? '' : ` Export it on the Import & export page and run sync-export to keep it in ${file}.`;
}

async function saveToDisk(){
  if(SAVING){ SAVE_AGAIN = true; return; }
  SAVING = true;
  SAVE_AGAIN = false;
  let res, body;
  const excluded = NEW_EXCLUDED.slice();
  try{
    res = await fetch('api/save', {
      method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({books: DATA, seriesInfo: SERIES_INFO, excluded, base: BASELINE, infoBase: INFO_BASELINE}),
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
  if(SAVE_AGAIN){ saveLocally(); saveToDisk(); return; }
  // the disk has everything now (tidied the way sync-export tidies); the browser copy is no longer needed
  if(JSON.stringify(body.books) !== JSON.stringify(DATA)){ DATA = body.books; refreshPage(); updateNav(); }
  try{ localStorage.removeItem(LS_KEY); LOCAL_SEEN = null; }catch(e){}
  if(!document.getElementById('ioStatus').textContent) showIoStatus('Saved.');
}

// Whether the server saves edits (only `make serve`, and only to your own data/books.json).
async function detectDiskSave(dir){
  if(dir !== 'data/') return false;
  try{
    const res = await fetch('api/save', {cache: 'no-cache'});
    return res.ok && (await res.json()).writable === true;
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
    let excludedText = '';
    try{ excludedText = await fetchText(dir + 'excluded.txt'); }catch(e){}
    return {dir, booksText, infoText, excludedText};
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

// Load the catalogue (with this browser's unsaved edits), then let the page draw itself with `init`.
async function startPage(init){
  try{
    const {dir, booksText, infoText, excludedText} = await loadData();
    DATA = CatalogImport.fixBooks(JSON.parse(booksText));   // "r": "2024-03-15" -> ["2024-03-15"]
    SERIES_INFO = JSON.parse(infoText);
    EXCLUSIONS = CatalogImport.parseExclusions(excludedText);
    BASELINE = CatalogImport.fingerprint(booksText);
    INFO_BASELINE = CatalogImport.fingerprint(infoText);
    DISK_SAVE = await detectDiskSave(dir);
  }catch(e){
    document.getElementById('subtitle').textContent =
      "Couldn't load the catalogue data. Serve this folder over HTTP (make serve) instead of opening the file directly.";
    return;
  }
  const restored = restoreLocalEdits();
  init();
  updateNav();
  if(STARTUP_NOTICE) showIoStatus(STARTUP_NOTICE, true);
  else if(restored && DISK_SAVE) await saveToDisk();     // edits a failed save left in this browser
}
