// What every page shares: the catalog, kept in this browser's IndexedDB and nowhere else, the
// status line and the page links. Each page's own module starts with startPage(), handing it a refresh()
// that redraws the page from CATALOG.
import {Text} from './modules/text.js';
import {Catalog} from './modules/catalog.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {CatalogDatabase, CatalogConflict} from './modules/catalog-database.js';
/** @import {RecordSet, Snapshot} from './modules/catalog-records.js' */
import {HardcoverClient} from './modules/hardcover-client.js';
import {ExternalCatalog} from './modules/external-catalog.js';
/** @import {ExternalKind} from './modules/external-catalog.js' */
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

// British spelling ("catalogue") when the browser's first English language is a British one, else American.
export const BRITISH = (() => { try{ return Text.prefersBritish(navigator.languages || [navigator.language]); }catch(e){ return false; } })();

/**
 * The page's own text in the spelling this browser prefers (see BRITISH); never a book's title or other data.
 * @param {string} text
 * @returns {string}
 */
export function spell(text){ return Text.spelled(text, BRITISH); }

// Attributes of the page's own elements that hold text a reader sees.
const TEXT_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

/**
 * Respell the text in `node` and below, in place (see spell).
 * @param {Node} node
 */
function respell(node){
	for(const child of node.childNodes){
		if(child.nodeType === Node.TEXT_NODE) child.nodeValue = spell(child.nodeValue || '');
		else if(child.nodeType === Node.ELEMENT_NODE){
			const el = /** @type {Element} */ (child);
			for(const name of TEXT_ATTRIBUTES){
				const value = el.getAttribute(name);
				if(value !== null) el.setAttribute(name, spell(value));
			}
			respell(el);
		}
	}
}

// The page as written is American, so respell it before the page's module finds its elements and
// fills them in; at this point it holds only the page's own text.
if(BRITISH){
	document.title = spell(document.title);
	respell(document.body);
}

/**
 * Something to put in an element: an element, or text (always as text, never read as HTML). Null, undefined,
 * false and '' stand for nothing, so a part shown only sometimes can be `cond && buildElement(...)`; lists are flattened.
 * @typedef {Node | string | number | null | undefined | false | Child[]} Child
 */

/**
 * The nodes and text of `children`, flattened, without the empty ones.
 * @param {Child[]} children
 * @returns {(Node | string)[]}
 */
export function nodes(children){
	/** @type {(Node | string)[]} */
	const out = [];
	for(const c of children){
		if(Array.isArray(c)) out.push(...nodes(c));
		else if(c !== null && c !== undefined && c !== false && c !== '') out.push(typeof c === 'number' ? String(c) : c);
	}
	return out;
}

/**
 * A new element: buildElement('a', {class: 'srow-title', href}, name). Attributes are set as given: null, undefined
 * and false leave one out, true sets it empty (checked); a function under an on... name listens to that
 * event (onclick: fn). The children go in in order (see Child).
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>} [attrs]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function buildElement(tag, attrs = {}, ...children){
	const el = document.createElement(tag);
	for(const [name, value] of Object.entries(attrs)){
		if(typeof value === 'function') el.addEventListener(name.slice(2), value);
		else if(value === true) el.setAttribute(name, '');
		else if(value !== null && value !== undefined && value !== false) el.setAttribute(name, String(value));
	}
	el.append(...nodes(children));
	return el;
}

/**
 * Replace what `el` holds with `children` (see Child).
 * @param {Element} el
 * @param {...Child} children
 */
export function fillElement(el, ...children){ el.replaceChildren(...nodes(children)); }

/**
 * `items` with `separator` between each two, as children for buildElement() or fillElement(): links joined with ', '.
 * @param {Child[]} items
 * @param {string} separator
 * @returns {Child[]}
 */
export function joined(items, separator){ return items.flatMap((x, i)=> i ? [separator, x] : [x]); }

// The addresses of an author's, a narrator's and a publisher's page, with spaces as + (as the catalog
// page writes its own addresses), so every link to a page looks the same.
const hashValue = (/** @type {string} */ v)=> encodeURIComponent(v).replace(/%20/g, '+');
/** @type {(name: string) => string} */
export const authorPageHref = name=> 'authors.html#a=' + hashValue(name);
/** @type {(name: string) => string} */
export const narratorPageHref = name=> 'narrators.html#n=' + hashValue(name);
/** @type {(name: string) => string} */
export const publisherPageHref = name=> 'publishers.html#p=' + hashValue(name);

/**
 * The name an address of one of those pages holds after `key`= (#n=Ann+Vale), or null.
 * @param {string} hash
 * @param {string} key
 * @returns {string | null}
 */
export function nameFromPageHash(hash, key){
	const m = new RegExp(`^#${key}=(.*)$`).exec(String(hash || ''));
	if(!m) return null;
	let name = m[1].replace(/\+/g, ' ');
	try{ name = decodeURIComponent(name); }catch(e){}
	return name.trim() || null;
}

// The catalog the page shows. It stays this one object: a page that takes another catalog (Restore, an
// import confirmed) moves it in with CATALOG.replaceWith().
export const CATALOG = new Catalog();
/** @type {number | null} */
export let SEEN_REVISION = null;      // the revision of the stored catalog this page last read or wrote; null while none was ever saved

/** @type {CatalogDatabase | null} */
let DATABASE = null;
/** @type {Snapshot} */
let SAVED = new Map();               // the records as this page last read or wrote them, so a save writes only what changed
let SAVE_REFUSED = '';                // why nothing can be saved in this browser, when nothing can
/** @type {Promise<void>} */
let SAVING = Promise.resolve();       // the saves asked for, one after another
let STARTUP_NOTICE = '';

// The page's own hook, from startPage(): onHardcoverJob(job), when the page has it, does more with each
// update of a Hardcover run (see showHardcoverJob).
/** @type {((job: HardcoverJob | null) => void) | null} */
let onHardcoverJob = null;

/**
 * Add "Not duplicates" (or "Keep separate") marks of the duplicates page to CATALOG.notDuplicates; returns
 * how many were new. Like any change, persist() saves them.
 * @param {string[]} entries
 * @returns {number}
 */
export function addNotDuplicates(entries){
	return CATALOG.addNotDuplicates(entries);
}

/** @returns {Promise<number | null>} the revision of the catalog as it is stored now (another tab may have saved since) */
export async function storedRevision(){
	try{ return DATABASE ? await DATABASE.revision() : null; }catch(e){ return null; }
}

/** @returns {Promise<void>} when the saves asked for so far are done */
export function whenSaved(){ return SAVING; }

// The page links: the duplicates link says how many duplicates and books with split editions there are.
export function updateNav(){
	const duplicates = CATALOG.duplicates();
	const n = duplicates.groups().length + duplicates.splitEditions().length;
	byId('dupCount').textContent = n ? ` (${n})` : '';
}

/**
 * Keep the catalog as the page holds it now. Saves are made one after another, and each writes only the
 * records that changed. Another page or tab that saved meanwhile would be overwritten, so then nothing is
 * saved. Pages need not wait for it; it says on the status line when a save fails.
 * @returns {Promise<void>}
 */
export function persist(){
	updateNav();
	return SAVING = SAVING.then(saveNow);
}

async function saveNow(){
	if(!DATABASE){ showIoStatus(SAVE_REFUSED, true); return; }
	const unstorable = CatalogRecords.unstorable(CATALOG);
	if(unstorable.length){
		showIoStatus(spell(`Not saved: these values can't be kept, as they aren't what their field holds: ${unstorable.slice(0, 3).join('; ')}` +
			`${unstorable.length > 3 ? ` and ${unstorable.length - 3} more` : ''}. Export a backup, fix them there (Check lists them) and Restore it.`), true);
		return;
	}
	const changes = CatalogRecords.changes(SAVED, CatalogRecords.fromCatalog(CATALOG));
	if(!changes.count && SEEN_REVISION !== null) return;
	try{
		const first = SEEN_REVISION === null;
		SEEN_REVISION = await DATABASE.save(changes, SEEN_REVISION);
		SAVED = changes.snapshot;
		if(first) setAsideOldCatalog();
	}catch(e){
		showIoStatus(e instanceof CatalogConflict
			? spell('The catalog was changed in another tab. Reload this page to see that; this change was not saved.')
			// nothing else holds this catalog, so say so instead of losing the edit quietly
			: spell('Not saved: this browser refused to store the catalog (is its storage full?). Export a backup.'), true);
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

// Load the catalog kept in this browser; with none, it starts empty. One that can't be read is set aside
// (under meta's `unreadable`), not overwritten by the next edit. When nothing was saved yet, the catalog
// localStorage kept before is moved over.
async function loadCatalog(){
	try{
		DATABASE = await CatalogDatabase.open(indexedDB);
	}catch(e){
		SAVE_REFUSED = spell("Not saved: this browser won't keep the catalog for this page (it has no IndexedDB here). Export a backup before you leave.");
		STARTUP_NOTICE = SAVE_REFUSED;
		readOldCatalog();
		return;
	}
	/** @type {{records: RecordSet, revision: number} | null} */
	let stored = null;
	try{
		stored = await DATABASE.load();
		if(!stored){
			// a catalog from before it lived in IndexedDB is saved there at once (and is in the current format then)
			if(readOldCatalog()) await persist();
			return;
		}
		CATALOG.replaceWith(CatalogRecords.toCatalog(stored.records));
		SEEN_REVISION = stored.revision;
		SAVED = CatalogRecords.snapshot(stored.records);
		// records from an older version of the app are saved again in the current shape
		if(CatalogRecords.outdated(stored.records)) await persist();
	}catch(e){
		try{
			SEEN_REVISION = await DATABASE.setAside(stored ? stored.records : Text.errorText(e));
			SAVED = new Map();
		}catch(err){
			DATABASE = null;
			SAVE_REFUSED = spell("Not saved: the catalog kept in this browser can't be read or set aside. Export a backup.");
		}
		STARTUP_NOTICE = spell("Couldn't read the catalog kept in this browser; it was set aside and the catalog starts empty. Restore a backup.");
	}
}

// localStorage held the catalog before IndexedDB did: under CATALOG_KEY as a backup ({books, seriesInfo, authors, narrators,
// publishers, excluded}; the key is the one the installed app kept its own catalog under), with the "Not duplicates"
// marks under NOT_DUP_KEY, and the edits that waited for `make serve` to save them to data/, from when the catalog still
// lived in files, under OLD_EDITS_KEY ({data, info, authors, excluded}). Once moved, each is kept under its name +
// MOVED_SUFFIX, a copy that is never read again.
const CATALOG_KEY = 'audiobook-catalog-device';
const NOT_DUP_KEY = 'audiobook-catalog-not-duplicates';
const OLD_EDITS_KEY = 'audiobook-catalog-data';
const MOVED_SUFFIX = '.moved-to-indexeddb';

/**
 * Read the catalog localStorage kept into CATALOG; returns whether there was one. One that can't be read
 * is set aside (under CATALOG_KEY + '.unreadable'), and the catalog starts empty.
 * @returns {boolean}
 */
function readOldCatalog(){
	/** @type {(key: string) => string | null} */
	const item = key => { try{ return localStorage.getItem(key); }catch(e){ return null; } };
	try{
		const raw = item(CATALOG_KEY), old = JSON.parse(item(OLD_EDITS_KEY) || 'null');
		/** @type {Unchecked} */
		const saved = raw ? JSON.parse(raw)
			: old && Array.isArray(old.data) ? {books: old.data, seriesInfo: old.info, authors: old.authors, excluded: old.excluded} : null;
		if(!saved) return false;
		const catalog = Catalog.fromJSON(saved);
		const marks = JSON.parse(item(NOT_DUP_KEY) || '[]');
		if(Array.isArray(marks)) catalog.addNotDuplicates(marks.filter(x=> typeof x === 'string'));
		CATALOG.replaceWith(catalog);
		return true;
	}catch(e){
		try{ localStorage.setItem(CATALOG_KEY + '.unreadable', item(CATALOG_KEY) || ''); localStorage.removeItem(CATALOG_KEY); }catch(err){}
		STARTUP_NOTICE = spell("Couldn't read the catalog kept in this browser; it was set aside and the catalog starts empty. Restore a backup.");
		return false;
	}
}

// Once IndexedDB holds the catalog, what localStorage kept is renamed, so it is never read again but not lost.
function setAsideOldCatalog(){
	for(const key of [CATALOG_KEY, NOT_DUP_KEY, OLD_EDITS_KEY]){
		try{
			const value = localStorage.getItem(key);
			if(value === null) continue;
			localStorage.setItem(key + MOVED_SUFFIX, value);
			localStorage.removeItem(key);
		}catch(e){}
	}
}

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

// ------------------------------------------------------------ external ids in forms and on pages
// A form has a field per group of external catalogs (Audible, Amazon, Goodreads, Hardcover) that has pages
// for what the form edits; each takes an id or the address of the page there, and the catalog keeps the id.

/**
 * The fields for the external ids of a kind of thing, each a <div> with a label and an input whose id is
 * `prefix` and the group ("sf_ext_goodreads"); `except` leaves groups out (a field of their own elsewhere).
 * @param {string} prefix
 * @param {ExternalKind} kind
 * @param {string[]} [except]
 * @returns {HTMLDivElement[]}
 */
export function externalFields(prefix, kind, except = []){
	return ExternalCatalog.groupsFor(kind).filter(g=> !except.includes(g.key)).map(g=>{
		const sites = ExternalCatalog.forKind(kind).filter(def=> def.group === g.key);
		const example = sites.length > 1 ? g.default : /** @type {string} */ ((ExternalCatalog.url(sites[0].key, kind, 'x') || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]);
		return buildElement('div', {}, buildElement('label', {for: prefix + g.key}, g.name),
			buildElement('input', {id: prefix + g.key, 'data-group': g.key, placeholder: `id, or its address on ${example}`}));
	});
}

/**
 * Put an entry's external ids in the fields externalFields() made.
 * @param {string} prefix
 * @param {ExternalKind} kind
 * @param {Record<string, string>} ids
 */
export function fillExternalFields(prefix, kind, ids){
	for(const g of ExternalCatalog.groupsFor(kind)){
		const field = document.getElementById(prefix + g.key);
		if(field) /** @type {HTMLInputElement} */ (field).value = ExternalCatalog.fieldText(ids, kind, g.key);
	}
}

/**
 * The external ids in the fields externalFields() made, as {ids, bad (the fields that hold neither an id nor
 * an address there, as "Goodreads: text")}. The ids an entry has in catalogs no field stands for are kept.
 * @param {string} prefix
 * @param {ExternalKind} kind
 * @param {Record<string, string>} [had] the entry's ids before
 * @returns {{ids: Record<string, string>, bad: string[]}}
 */
export function readExternalFields(prefix, kind, had = {}){
	const groups = ExternalCatalog.groupsFor(kind).filter(g=> document.getElementById(prefix + g.key));
	const shown = new Set(groups.map(g=> g.key));
	/** @type {Record<string, string>} */
	const ids = Object.fromEntries(Object.entries(had).filter(([key])=> { const g = ExternalCatalog.groupOf(key); return !g || !shown.has(g.key); }));
	/** @type {string[]} */
	const bad = [];
	for(const g of groups){
		const text = Text.tidy(fieldById(prefix + g.key).value);
		if(!text) continue;
		const found = ExternalCatalog.readId(text, kind, g.key);
		if(found) ids[found.catalog] = found.id; else bad.push(`${g.name}: ${text}`);
	}
	return {ids, bad};
}

/**
 * Links to an entry's pages in external catalogs ("Goodreads ↗"), one per id; an Audible or Amazon site
 * other than the group's usual one says which ("Audible (audible.co.uk) ↗").
 * @param {Record<string, string>} ids
 * @param {ExternalKind} kind
 * @param {string} [cls] the links' class
 * @returns {HTMLAnchorElement[]}
 */
export function externalLinks(ids, kind, cls = 'authorlink'){
	return Object.entries(ExternalCatalog.order(ids) || {}).flatMap(([key, id])=>{
		const url = ExternalCatalog.url(key, kind, id), g = ExternalCatalog.groupOf(key);
		if(!url) return [];
		const name = g ? (g.default === key ? g.name : `${g.name} (${key})`) : ExternalCatalog.name(key);
		return [buildElement('a', {class: cls, href: url, target: '_blank', rel: 'noopener'}, `${name} \u2197`)];
	});
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
		if(!job || !job.running) fillElement(el);
		else {
			const counted = typeof job.total === 'number' && Number.isInteger(job.total) && job.total > 0;
			fillElement(el, buildElement('span', {class: 'spinner', 'aria-hidden': 'true'}), buildElement('div', {class: 'bgTaskText'},
				buildElement('strong', {}, (job.dryRun ? HARDCOVER_PREVIEWS : HARDCOVER_VERBS)[job.mode] || 'Working with Hardcover'),
				' ', buildElement('span', {class: 'bgTaskTime'}, minutes(job.elapsed)), buildElement('br'), job.step || '',
				counted && [`: ${job.done} of ${job.total} `, buildElement('progress', {max: job.total, value: job.done})],
				!job.dryRun && [buildElement('br'), buildElement('small', {}, spell('Please don\'t edit the catalog until it is done: an edit saved meanwhile stops it before anything is written.'))]));
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
	await loadCatalog();
	askToKeepStorage();
	init();
	updateNav();
	if(STARTUP_NOTICE) showIoStatus(STARTUP_NOTICE, true);
}

// Installable as an app (on a phone, say), and usable offline once it is: see sw.js.
try{ navigator.serviceWorker.register('sw.js').catch(()=>{}); }catch(e){}
