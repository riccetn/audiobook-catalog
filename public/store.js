// What every page shares: the catalog, kept in this browser's localStorage and nowhere else, the
// status line and the page links. Each page's own module starts with startPage(), handing it a refresh()
// that redraws the page from CATALOG.
import {Text} from './modules/text.js';
import {Book} from './modules/book.js';
import {Catalog} from './modules/catalog.js';
import {HardcoverClient} from './modules/hardcover-client.js';
/** @import {Unchecked} from './modules/text.js' */

/**
 * A Hardcover import, export or sync going on (or just ended) in a page, as showHardcoverJob() shows it.
 * @typedef {object} HardcoverJob
 * @property {'import' | 'export' | 'sync'} mode
 * @property {boolean} dryRun a preview: nothing is written
 * @property {boolean} running
 * @property {number} elapsed milliseconds
 * @property {string} [step] what it is doing
 * @property {number} [done] of `total` steps
 * @property {number} [total]
 * @property {number} [code] how it ended: 0 when all went through
 * @property {string} [out] what it had to say
 * @property {string} [err] what went wrong
 */

// The catalog: {books, seriesInfo, authors, excluded}, the shape of a backup. (The key is the one the
// installed app kept its own catalog under, so a phone's catalog carries over as it is.)
const CATALOG_KEY = 'audiobook-catalog-device';
// Where edits waited for `make serve` to save them to data/, when the catalog still lived in files:
// {data, info, authors, excluded}. Only read, once, when there is no catalog yet.
const OLD_EDITS_KEY = 'audiobook-catalog-data';

// British spelling ("catalogue") when the browser's first English language is a British one, else American.
export const BRITISH = (() => { try{ return Text.prefersBritish(navigator.languages || [navigator.language]); }catch(e){ return false; } })();

/**
 * The page's own text in the spelling this browser prefers (see BRITISH); never a book's title or other data.
 * @param {string} text
 * @returns {string}
 */
export function spell(text){ return Text.spelled(text, BRITISH); }

// The page as written is American, so respell it before the page's module finds its elements and
// fills them in; at this point it holds only the page's own text.
if(BRITISH){
	document.title = spell(document.title);
	document.body.innerHTML = spell(document.body.innerHTML);
}

// The catalog the page shows. It stays this one object: a page that takes another catalog (Restore, an
// import confirmed) moves it in with CATALOG.replaceWith().
export const CATALOG = new Catalog();
/** @type {string[]} */
export let FORMAT_NOTES = [];         // what in the stored catalog is from an older format (Book.formatNotes); any save rewrites it
/** @type {string | null} */
export let LOCAL_SEEN = null;         // what this page last read from or wrote to localStorage[CATALOG_KEY]

// The page's own hook, from startPage(): onHardcoverJob(job), when the page has it, does more with each
// update of a Hardcover run (see showHardcoverJob).
/** @type {((job: HardcoverJob | null) => void) | null} */
let onHardcoverJob = null;

// Pairs of books marked "Not duplicates", and books whose editions were marked "Keep separate", on the
// duplicates page. Kept in this browser beside the catalog; backups carry them too.
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
/** @returns {string[]} the marks kept in this browser */
function storedNotDuplicates(){
	try{
		const saved = JSON.parse(localStorage.getItem(NOT_DUP_KEY) || '[]');
		if(Array.isArray(saved)) return saved.filter(x=> typeof x === 'string');
	}catch(e){}
	return [];
}

/**
 * Add marks to CATALOG.notDuplicates (and this browser's copy); returns how many were new.
 * @param {string[]} entries
 * @returns {number}
 */
export function addNotDuplicates(entries){
	const added = CATALOG.addNotDuplicates(entries);
	saveNotDuplicates();
	return added;
}

// The marks are kept apart from the catalog, so a page that only marks a pair saves only them.
export function saveNotDuplicates(){
	try{ localStorage.setItem(NOT_DUP_KEY, JSON.stringify([...CATALOG.notDuplicates])); }catch(e){}
}

/**
 * Text made safe to put in HTML.
 * @param {unknown} s
 * @returns {string}
 */
export function esc(s){
	/** @type {Record<string, string>} */
	const entities = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
	return String(s).replace(/[&<>"']/g, c => entities[c]);
}

/** @returns {string | null} the catalog as localStorage holds it now */
export function localNow(){
	try{ return localStorage.getItem(CATALOG_KEY); }catch(e){ return null; }
}

// The page links: the duplicates link says how many duplicates and books with split editions there are.
export function updateNav(){
	const duplicates = CATALOG.duplicates();
	const n = duplicates.groups().length + duplicates.splitEditions().length;
	byId('dupCount').textContent = n ? ` (${n})` : '';
}

// Keep the catalog as the page holds it now. Another page or tab that saved meanwhile would be
// overwritten, so then nothing is saved.
export function persist(){
	updateNav();
	if(localNow() !== LOCAL_SEEN){
		showIoStatus(spell('The catalog was changed in another tab. Reload this page to see that; this change was not saved.'), true);
		return;
	}
	try{
		const {books, seriesInfo, authors, excluded} = CATALOG.toJSON();   // the marks have a key of their own
		localStorage.setItem(CATALOG_KEY, JSON.stringify({books, seriesInfo, authors, excluded}));
		LOCAL_SEEN = localNow();
		FORMAT_NOTES = [];    // written as the page holds it, which is the current format
	}catch(e){
		// nothing else holds this catalog, so say so instead of losing the edit quietly
		showIoStatus(spell('Not saved: this browser refused to store the catalog (is its storage full?). Export a backup.'), true);
	}
}

/**
 * Add entries (an ASIN, "ISBN 978...", "Goodreads 12345" or "Title | Author") to the books imports skip; returns how many were new.
 * @param {string[]} entries
 * @returns {number}
 */
export function addExclusions(entries){
	return CATALOG.addExclusions(entries);
}

// Ask the browser not to clear this site's storage when space runs low; on a phone it may otherwise.
function askToKeepStorage(){
	try{ navigator.storage.persist().catch(()=>{}); }catch(e){}
}

/**
 * The stored catalog as a backup ({books, seriesInfo, authors, excluded}), or null when there is none
 * yet. Edits from before, still waiting for `make serve` to save them to data/, are taken as the catalog.
 * @returns {Unchecked}
 */
function storedCatalog(){
	const raw = localNow();
	if(raw) return JSON.parse(raw);
	const old = JSON.parse(localStorage.getItem(OLD_EDITS_KEY) || 'null');
	if(old && Array.isArray(old.data)) return {books: old.data, seriesInfo: old.info, authors: old.authors, excluded: old.excluded};
	return null;
}

// Load the catalog kept in this browser; with none, it starts empty. One that can't be read is set
// aside (under CATALOG_KEY + '.unreadable'), not overwritten by the next edit.
function loadCatalog(){
	try{
		const saved = storedCatalog();
		if(saved){
			const notes = Book.formatNotes(saved.books);   // before Catalog.fromJSON migrates them
			const notDuplicates = CATALOG.notDuplicates;
			CATALOG.replaceWith(Catalog.fromJSON(saved));
			CATALOG.notDuplicates = notDuplicates;
			FORMAT_NOTES = notes;
		}
	}catch(e){
		try{ localStorage.setItem(CATALOG_KEY + '.unreadable', localNow() || ''); localStorage.removeItem(CATALOG_KEY); }catch(err){}
		STARTUP_NOTICE = spell("Couldn't read the catalog kept in this browser; it was set aside and the catalog starts empty. Restore a backup.");
	}
	LOCAL_SEEN = localNow();
}
let STARTUP_NOTICE = '';

/** @type {ReturnType<typeof setTimeout> | undefined} */
let ioStatusTimer;

/**
 * Say something on the status line for a few seconds; `isErr` shows it as an error.
 * @param {string} msg
 * @param {boolean} [isErr]
 */
export function showIoStatus(msg, isErr){
	const el = byId('ioStatus');
	el.textContent = msg;
	el.classList.toggle('err', !!isErr);
	clearTimeout(ioStatusTimer);
	ioStatusTimer = setTimeout(()=>{ el.textContent = ''; }, 5000);
}

/**
 * The page's element with this id. Throws when there is none, which is a mistake in the page.
 * @param {string} id
 * @returns {HTMLElement}
 */
export function byId(id){
	const el = document.getElementById(id);
	if(!el) throw new Error(`the page has no #${id}`);
	return el;
}

/** @typedef {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} FormField */

/**
 * The page's form field (an <input>, <select> or <textarea>) with this id, for its value; byId() for anything else.
 * @param {string} id
 * @returns {FormField}
 */
export function fieldById(id){
	return /** @type {FormField} */ (byId(id));
}

// ------------------------------------------------------------ Hardcover from the page
// The page asks Hardcover itself (its API allows browser requests), with a token kept in this browser
// only (never in a backup), saved on Import & export.
export const HARDCOVER_TOKEN_KEY = 'audiobook-catalog-hardcover-token';
export const HARDCOVER_PAUSE_MS = 1000;   // Hardcover allows 60 requests a minute

/** @returns {string} the Hardcover token saved in this browser, or '' */
export function browserHardcoverToken(){
	try{ return HardcoverClient.cleanToken(localStorage.getItem(HARDCOVER_TOKEN_KEY)); }catch(e){ return ''; }
}

/**
 * Asks Hardcover from this page, saying plainly when the browser can't reach it at all.
 * @param {string} url
 * @param {RequestInit} opts
 * @returns {Promise<Response>}
 */
export async function fetchHardcover(url, opts){
	try{ return await fetch(url, opts); }
	catch(e){ throw new Error('this browser could not reach Hardcover (offline, or Hardcover refused a request from a web page)'); }
}

/**
 * A Hardcover client asking from this page, with `token`.
 * @param {string} token
 * @returns {HardcoverClient}
 */
export function hardcoverClient(token){
	const pause = () => new Promise(done => setTimeout(done, HARDCOVER_PAUSE_MS));
	return new HardcoverClient(token, fetchHardcover, pause);
}

/**
 * The Hardcover book that `text` names: its id, or the address of the book's or one of its editions'
 * pages on hardcover.app (HardcoverClient.bookId), as {id, title}. An address without the book's id
 * is looked up on Hardcover with the token saved in this browser. Throws with a short reason.
 * @param {string} text
 * @returns {Promise<{id: string, title?: string}>}
 */
export async function lookupHardcoverBook(text){
	const url = HardcoverClient.parseUrl(text);
	if(!url || url.book) return HardcoverClient.bookId(null, text);
	const token = browserHardcoverToken();
	if(!token) throw new Error('to look it up on Hardcover, save your Hardcover API token on the Import & export page first');
	return HardcoverClient.bookId(hardcoverClient(token), text);
}

// ------------------------------------------------------------ Hardcover runs
// A Hardcover import, export or sync can take minutes, one request a second. The page running it shows
// it on top while it goes (#bgTask), and hands each update to the page's onHardcoverJob.
/** @type {Record<string, string>} */
const HARDCOVER_VERBS = {import: 'Importing from Hardcover', export: 'Exporting to Hardcover', sync: 'Syncing with Hardcover'};
/** @type {Record<string, string>} */
const HARDCOVER_PREVIEWS = {import: 'Checking what a Hardcover import would do', export: 'Checking what a Hardcover export would do',
	sync: 'Checking what a Hardcover sync would do'};

/** @type {(ms: number) => string} */
export const minutes = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * Show a Hardcover run in the banner on top (#bgTask), and hand it to the page's own onHardcoverJob.
 * @param {HardcoverJob | null} job
 */
export function showHardcoverJob(job){
	const el = document.getElementById('bgTask');
	if(el){
		el.classList.toggle('show', Boolean(job && job.running));
		if(!job || !job.running) el.innerHTML = '';
		else {
			const counted = typeof job.total === 'number' && Number.isInteger(job.total) && job.total > 0;
			el.innerHTML = `<span class="spinner" aria-hidden="true"></span><div class="bgTaskText">` +
				`<strong>${esc((job.dryRun ? HARDCOVER_PREVIEWS : HARDCOVER_VERBS)[job.mode] || 'Working with Hardcover')}</strong>` +
				` <span class="bgTaskTime">${minutes(job.elapsed)}</span><br>${esc(job.step || '')}` +
				(counted ? `: ${job.done} of ${job.total} <progress max="${job.total}" value="${job.done}"></progress>` : '') +
				(job.dryRun ? '' : spell('<br><small>Please don\'t edit the catalog until it is done: an edit saved meanwhile stops it before anything is written.</small>')) +
				'</div>';
		}
	}
	if(onHardcoverJob) onHardcoverJob(job);
}

/**
 * Load the catalog kept in this browser (empty the first time), then let the page draw itself with
 * `init`. `page.onHardcoverJob` is optional (see showHardcoverJob).
 * @param {() => void} init
 * @param {{onHardcoverJob?: (job: HardcoverJob | null) => void}} [page]
 */
export async function startPage(init, page = {}){
	({onHardcoverJob = null} = page);
	CATALOG.notDuplicates = new Set(storedNotDuplicates());
	loadCatalog();
	askToKeepStorage();
	init();
	updateNav();
	if(STARTUP_NOTICE) showIoStatus(STARTUP_NOTICE, true);
}

// Installable as an app (on a phone, say), and usable offline once it is: see sw.js.
try{ navigator.serviceWorker.register('sw.js').catch(()=>{}); }catch(e){}
