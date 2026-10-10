// What every page shares: the catalogue, kept in this browser's localStorage and nowhere else, the
// status line and the page links. Each page's own module starts with startPage(), handing it a refresh()
// that redraws the page from DATA.
import * as CatalogImport from './importers.js';

// The catalogue: {books, seriesInfo, authors, excluded}, the shape of a backup. (The key is the one the
// installed app kept its own catalogue under, so a phone's catalogue carries over as it is.)
const CATALOG_KEY = 'audiobook-catalog-device';
// Where edits waited for `make serve` to save them to data/, when the catalogue still lived in files:
// {data, info, authors, excluded}. Only read, once, when there is no catalogue yet.
const OLD_EDITS_KEY = 'audiobook-catalog-data';

export let DATA = [];
export let SERIES_INFO = {};
export let AUTHORS = {};              // author name -> {bio, url, audible, goodreads, hardcover}
export let EXCLUSIONS = CatalogImport.parseExclusions('');   // books imports must never re-add
export let FORMAT_NOTES = [];         // what in the stored catalogue is from an older format (CatalogImport.formatNotes); any save rewrites it
export let LOCAL_SEEN = null;         // what this page last read from or wrote to localStorage[CATALOG_KEY]

// A module's bindings can only be assigned in the module itself, so the pages replace these through here.
export function setData(books){ DATA = books; }
export function setSeriesInfo(info){ SERIES_INFO = info; }
export function setAuthors(authors){ AUTHORS = authors; }

// The page's own hook, from startPage(): onHardcoverJob(job), when the page has it, does more with each
// update of a Hardcover run (see showHardcoverJob).
let onHardcoverJob = null;

// Pairs of books marked "Not duplicates", and books whose editions were marked "Keep separate", on the
// duplicates page. Kept in this browser beside the catalogue; backups carry them too.
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
export let NOT_DUPLICATES = new Set();
try{
  const saved = JSON.parse(localStorage.getItem(NOT_DUP_KEY) || '[]');
  if(Array.isArray(saved)) NOT_DUPLICATES = new Set(saved.filter(x=> typeof x === 'string'));
}catch(e){}

// Add marks to NOT_DUPLICATES (and this browser's copy); returns how many were new.
export function addNotDuplicates(entries){
  const before = NOT_DUPLICATES.size;
  entries.forEach(e=> NOT_DUPLICATES.add(e));
  try{ localStorage.setItem(NOT_DUP_KEY, JSON.stringify([...NOT_DUPLICATES])); }catch(e){}
  return NOT_DUPLICATES.size - before;
}

// Dates read of a book; [] when it has none (or something that is not a list of dates).
export const readDates = b => Array.isArray(b.r) ? b.r.filter(d => typeof d === 'string') : [];

export function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function localNow(){
  try{ return localStorage.getItem(CATALOG_KEY); }catch(e){ return null; }
}

// The page links: the duplicates link says how many duplicates and books with split editions there are.
export function updateNav(){
  const n = CatalogImport.findDuplicates(DATA, NOT_DUPLICATES).length + CatalogImport.splitEditions(DATA, NOT_DUPLICATES).length;
  document.getElementById('dupCount').textContent = n ? ` (${n})` : '';
}

// Keep the catalogue as the page holds it now. Another page or tab that saved meanwhile would be
// overwritten, so then nothing is saved.
export function persist(){
  updateNav();
  if(localNow() !== LOCAL_SEEN){
    showIoStatus('The catalogue was changed in another tab. Reload this page to see that; this change was not saved.', true);
    return;
  }
  try{
    localStorage.setItem(CATALOG_KEY, JSON.stringify({books: DATA, seriesInfo: SERIES_INFO, authors: AUTHORS, excluded: EXCLUSIONS.entries}));
    LOCAL_SEEN = localNow();
    FORMAT_NOTES = [];    // written as the page holds it, which is the current format
  }catch(e){
    // nothing else holds this catalogue, so say so instead of losing the edit quietly
    showIoStatus('Not saved: this browser refused to store the catalogue (is its storage full?). Export a backup.', true);
  }
}

// Add entries (an ASIN, "ISBN 978...", "Goodreads 12345" or "Title | Author") to the books imports skip; returns how many were new.
export function addExclusions(entries){
  return entries.map(e=> EXCLUSIONS.add(e)).filter(Boolean).length;
}

// Ask the browser not to clear this site's storage when space runs low; on a phone it may otherwise.
function askToKeepStorage(){
  try{ navigator.storage.persist().catch(()=>{}); }catch(e){}
}

// The stored catalogue as a backup ({books, seriesInfo, authors, excluded}), or null when there is none
// yet. Edits from before, still waiting for `make serve` to save them to data/, are taken as the catalogue.
function storedCatalogue(){
  const raw = localNow();
  if(raw) return JSON.parse(raw);
  const old = JSON.parse(localStorage.getItem(OLD_EDITS_KEY) || 'null');
  if(old && Array.isArray(old.data)) return {books: old.data, seriesInfo: old.info, authors: old.authors, excluded: old.excluded};
  return null;
}

// Load the catalogue kept in this browser; with none, it starts empty. One that can't be read is set
// aside (under CATALOG_KEY + '.unreadable'), not overwritten by the next edit.
function loadCatalogue(){
  try{
    const saved = storedCatalogue();
    if(saved){
      const notes = CatalogImport.formatNotes(saved.books);   // before readBackup migrates them
      const {books, seriesInfo, authors, excluded} = CatalogImport.readBackup(saved);
      DATA = books;                     // readBackup has migrated them already
      SERIES_INFO = seriesInfo || {};
      AUTHORS = authors || {};
      (excluded || []).forEach(e=> EXCLUSIONS.add(e));
      FORMAT_NOTES = notes;
    }
  }catch(e){
    try{ localStorage.setItem(CATALOG_KEY + '.unreadable', localNow()); localStorage.removeItem(CATALOG_KEY); }catch(err){}
    STARTUP_NOTICE = "Couldn't read the catalogue kept in this browser; it was set aside and the catalogue starts empty. Restore a backup.";
  }
  LOCAL_SEEN = localNow();
}
let STARTUP_NOTICE = '';

export function showIoStatus(msg, isErr){
  const el = document.getElementById('ioStatus');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.textContent = ''; }, 5000);
}

// ------------------------------------------------------------ Hardcover from the page
// The page asks Hardcover itself (its API allows browser requests), with a token kept in this browser
// only (never in a backup), saved on Import & export.
export const HARDCOVER_TOKEN_KEY = 'audiobook-catalog-hardcover-token';
export const HARDCOVER_PAUSE_MS = 1000;   // Hardcover allows 60 requests a minute

export function browserHardcoverToken(){
  try{ return CatalogImport.cleanHardcoverToken(localStorage.getItem(HARDCOVER_TOKEN_KEY)); }catch(e){ return ''; }
}

// Asks Hardcover from this page, saying plainly when the browser can't reach it at all.
export async function fetchHardcover(url, opts){
  try{ return await fetch(url, opts); }
  catch(e){ throw new Error('this browser could not reach Hardcover (offline, or Hardcover refused a request from a web page)'); }
}

/**
 * The Hardcover book that `text` names: its id, or the address of the book's or one of its editions'
 * pages on hardcover.app (CatalogImport.hardcoverBookId), as {id, title}. An address without the book's id
 * is looked up on Hardcover with the token saved in this browser. Throws with a short reason.
 */
export async function lookupHardcoverBook(text){
  const url = CatalogImport.parseHardcoverUrl(text);
  if(!url || url.book) return CatalogImport.hardcoverBookId(null, text);
  const token = browserHardcoverToken();
  if(!token) throw new Error('to look it up on Hardcover, save your Hardcover API token on the Import & export page first');
  const pause = () => new Promise(done => setTimeout(done, HARDCOVER_PAUSE_MS));
  return CatalogImport.hardcoverBookId(CatalogImport.hardcoverAsker(token, fetchHardcover, pause), text);
}

// ------------------------------------------------------------ Hardcover runs
// A Hardcover import, export or sync can take minutes, one request a second. The page running it shows
// it on top while it goes (#bgTask), and hands each update to the page's onHardcoverJob.
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
      el.innerHTML = `<span class="spinner" aria-hidden="true"></span><div class="bgTaskText">` +
        `<strong>${esc((job.dryRun ? HARDCOVER_PREVIEWS : HARDCOVER_VERBS)[job.mode] || 'Working with Hardcover')}</strong>` +
        ` <span class="bgTaskTime">${minutes(job.elapsed)}</span><br>${esc(job.step || '')}` +
        (counted ? `: ${job.done} of ${job.total} <progress max="${job.total}" value="${job.done}"></progress>` : '') +
        (job.dryRun ? '' : '<br><small>Please don\'t edit the catalogue until it is done: an edit saved meanwhile stops it before anything is written.</small>') +
        '</div>';
    }
  }
  if(onHardcoverJob) onHardcoverJob(job);
}

/**
 * Load the catalogue kept in this browser (empty the first time), then let the page draw itself with
 * `init`. `page.onHardcoverJob` is optional (see showHardcoverJob).
 */
export async function startPage(init, page = {}){
  ({onHardcoverJob = null} = page);
  loadCatalogue();
  askToKeepStorage();
  init();
  updateNav();
  if(STARTUP_NOTICE) showIoStatus(STARTUP_NOTICE, true);
}

// Installable as an app (on a phone, say), and usable offline once it is: see sw.js.
try{ navigator.serviceWorker.register('sw.js').catch(()=>{}); }catch(e){}
