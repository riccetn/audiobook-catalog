// The duplicates page: books that look like one title entered twice (the way an import would match
// them; see Duplicates.groups), plus a pair picked by hand with the merge button on the catalog page
// (duplicates.html#merge=<id>,<id>, the ids the two books are stored under). Merging keeps one entry, with the title, author and series you
// pick, and every genre, date read and edition of the others; the rest are removed without excluding
// them from imports (the kept book carries their ids, so an import finds it). Pairs marked
// "Not duplicates" are remembered in this browser and in backups (store.js).
// The editions of the merged entries become one edition when none disagree on an ASIN or Goodreads id
// (one book imported from both Audible and Goodreads), unless you untick that. Books merged before
// that, whose editions still look like one, are listed below the duplicates to be joined the same way.
import {Text} from './modules/text.js';
import {Edition} from './modules/edition.js';
import {Book} from './modules/book.js';
import { CATALOG, persist, showIoStatus, startPage, byId, spell, buildElement, fillElement } from './store.js';
/** @import {Picks} from './modules/book.js' */
/** @import {Child} from './store.js' */

// Books are known by the ids they are stored under, in the order CATALOG.books has them.
/** @type {string[][]} */
export let DUP_GROUPS = [];           // groups of books shown
/** @type {Picks[]} */
export let DUP_PICKS = [];            // per group: which book's title, author and series to keep
/** @type {string[] | null} */
export let DUP_MANUAL = null;         // the pair picked by hand, until it is merged or kept apart
let DUP_FOUND = 0;             // how many of DUP_GROUPS Duplicates.groups found (the rest is DUP_MANUAL)
/** @type {string[]} */
export let SPLIT = [];                // books whose editions look like one edition recorded twice

/**
 * The books stored under `ids`.
 * @param {string[]} ids
 * @returns {Book[]}
 */
const booksOf = ids=> ids.map(id=> /** @type {Book} */ (CATALOG.book(id)));
/**
 * The ids of books, in the order the catalog has them.
 * @param {string[]} ids
 * @returns {string[]}
 */
function inCatalogOrder(ids){
	const at = new Map(CATALOG.books.map((b, i)=> [b.id, i]));
	return [...ids].sort((x, y)=> (at.get(x) ?? 0) - (at.get(y) ?? 0));
}

/** @typedef {'title' | 'authors' | 'series'} DupField */
/** @type {[DupField, string][]} */
const DUP_FIELDS = [['title', 'Title'], ['authors', 'Author'], ['series', 'Series']];   // narrators are on the editions, which are all kept
/** @type {(b: Book, f: DupField) => string} */
const dupValue = (b, f)=> f === 'series' ? (b.series ? b.series + (b.number ? ` #${b.number}` : '') : '') : f === 'authors' ? Text.namesText(b.authors) : b.title;

/**
 * The pair in the address (#merge=<id>,<id>), if it names two books.
 * @returns {string[] | null}
 */
function manualPair(){
	const m = /^#merge=([^,]+),([^,]+)$/.exec(location.hash || '');
	if(!m) return null;
	/** @type {(v: string) => string} */
	const dec = v=>{ try{ return decodeURIComponent(v); }catch(e){ return v; } };
	const pair = [dec(m[1]), dec(m[2])];
	return pair[0] !== pair[1] && pair.every(id=> CATALOG.book(id)) ? inCatalogOrder(pair) : null;
}

function forgetManualPair(){
	DUP_MANUAL = null;
	try{ history.replaceState(null, '', location.pathname); }catch(e){}
}

// Find the groups again (the books changed), keeping the choices made for a group that is still there.
function refreshPage(){
	const duplicates = CATALOG.duplicates();
	/** @type {(i: number) => string} */
	const idAt = i=> /** @type {string} */ (CATALOG.books[i].id);
	const found = duplicates.groups().map(g=> g.map(idAt));
	const pair = DUP_MANUAL;
	const manual = pair && !found.some(g=> pair.every(id=> g.includes(id))) ? [pair] : [];
	const groups = [...manual, ...found];
	DUP_FOUND = found.length;
	const before = new Map(DUP_GROUPS.map((g, k)=> [g.join(','), DUP_PICKS[k]]));
	DUP_GROUPS = groups;
	DUP_PICKS = groups.map(g=> before.get(g.join(',')) || {});
	SPLIT = duplicates.splitEditions().map(idAt);
	renderDuplicates();
}

/**
 * Whether any of `editions` is also on a book outside `ids` (a box set): joining it would change those too.
 * @param {Edition[]} editions
 * @param {string[]} ids
 * @returns {boolean}
 */
function sharedOutside(editions, ids){
	return CATALOG.books.some(b=> !ids.includes(/** @type {string} */ (b.id)) &&
		b.editions.some(x=> editions.some(ed=> x.sameAs(ed))));
}

/**
 * The choices for group `g`, with joinEditions on by default when the editions can be joined.
 * @param {number} g
 * @returns {Picks & {joinable: boolean, joinEditions: boolean}}
 */
function groupPicks(g){
	const ids = DUP_GROUPS[g], picks = DUP_PICKS[g];
	const separate = Book.merge(booksOf(ids), {...picks, joinEditions: false}).editions;
	const joinable = Edition.joinable(separate) && !sharedOutside(separate, ids);
	return {...picks, joinable, joinEditions: joinable && picks.joinEditions !== false};
}

const editionLines = (/** @type {Book} */ b)=> b.editions.map(ed=> buildElement('div', {class: 'dup-extra'}, ed.format()));
/** @type {(label: string, value: string) => Child[]} */
const fieldLine = (label, value)=> [buildElement('span', {class: 'dup-label'}, label), ' ' + value];

/** @returns {Child[]} */
function renderSplit(){
	if(!SPLIT.length) return [];
	return [
		buildElement('h2', {class: 'dup-heading'}, 'Editions that look like one'),
		buildElement('p', {class: 'hint'}, 'These books have editions that don\'t disagree on an ASIN or Goodreads id, such as one from Audible and one from Goodreads.'),
		SPLIT.map(id=>{
			const b = /** @type {Book} */ (CATALOG.book(id));
			const joined = Edition.join(b.editions);
			return buildElement('div', {class: 'dup-group'},
				buildElement('div', {class: 'dup-books'}, buildElement('div', {class: 'dup-book'},
					buildElement('div', {class: 'dup-field'}, fieldLine('Title', b.title)),
					buildElement('div', {class: 'dup-field'}, fieldLine('Author', Text.namesText(b.authors))), editionLines(b))),
				buildElement('p', {class: 'dup-result'}, 'Becomes one edition: ' + joined.format()),
				buildElement('div', {class: 'formbtns'},
					buildElement('button', {type: 'button', class: 'save split-join', 'data-id': id, onclick: ()=> joinBookEditions(id)}, 'Make one edition'),
					buildElement('button', {type: 'button', class: 'split-apart', 'data-id': id, onclick: ()=> keepEditionsApart(id)}, 'Keep separate')));
		}),
	];
}

export function renderDuplicates(){
	byId('subtitle').textContent = (DUP_FOUND
		? `${DUP_FOUND} possible duplicate${DUP_FOUND === 1 ? '' : 's'} among ${CATALOG.books.length} audiobooks`
		: `No duplicates among ${CATALOG.books.length} audiobooks`) +
		(SPLIT.length ? `; ${SPLIT.length} book${SPLIT.length === 1 ? '' : 's'} with editions that look like one` : '');
	fillElement(byId('dupBody'),
		!DUP_GROUPS.length && buildElement('p', {class: 'empty'}, spell('No books look like duplicates. To merge two books anyway, ' +
			'press \u21C4 on one of them in the catalog and then on the other.')),
		DUP_GROUPS.map(duplicateGroup),
		renderSplit());
}

/**
 * Group `g` of DUP_GROUPS: its books, with a choice for each field they differ on, and what merging them makes.
 * @param {string[]} ids
 * @param {number} g
 * @returns {HTMLDivElement}
 */
function duplicateGroup(ids, g){
	const books = booksOf(ids);
	const picks = groupPicks(g);
	const merged = Book.merge(books, picks);
	const bookBox = (/** @type {Book} */ b, /** @type {number} */ k)=> buildElement('div', {class: 'dup-book'},
		DUP_FIELDS.map(([f, label])=>{
			const value = dupValue(b, f);
			if(!value) return null;
			const choices = new Set(books.map(x=> dupValue(x, f)).filter(Boolean));
			if(choices.size < 2) return buildElement('div', {class: 'dup-field'}, fieldLine(label, value));
			const checked = dupValue(merged, f) === value && books.findIndex(x=> dupValue(x, f) === value) === k;
			const pick = ()=>{ DUP_PICKS[g][f] = k; renderDuplicates(); };
			return buildElement('label', {class: 'dup-field dup-choice'},
				buildElement('input', {type: 'radio', name: `dup-${g}-${f}`, 'data-g': g, 'data-f': f, 'data-k': k, checked, onchange: pick}), ' ', fieldLine(label, value));
		}),
		[b.genres.join(', '), b.read.length ? 'Read ' + b.read.join(', ') : '', ...b.editions.map(ed=> ed.format())]
			.filter(Boolean).map(x=> buildElement('div', {class: 'dup-extra'}, x)));
	const editions = merged.editions.length;
	return buildElement('div', {class: 'dup-group'},
		DUP_MANUAL && g === 0 && DUP_MANUAL.join() === ids.join() && buildElement('p', {class: 'dup-note'}, 'Picked by hand'),
		buildElement('div', {class: 'dup-books'}, books.map(bookBox)),
		buildElement('p', {class: 'dup-result'}, `Becomes: ${merged.title} — ${Text.namesText(merged.authors)}` +
			(merged.series ? ` — ${dupValue(merged, 'series')}` : '') +
			(editions ? `, ${editions} edition${editions === 1 ? '' : 's'}` : '') +
			(merged.read.length ? `, read ${merged.read.join(', ')}` : '')),
		editionLines(merged),
		picks.joinable && buildElement('label', {class: 'dup-join'},
			buildElement('input', {type: 'checkbox', class: 'dup-joinbox', 'data-g': g, checked: picks.joinEditions, onchange: (/** @type {Event} */ e)=>{
				DUP_PICKS[g].joinEditions = /** @type {HTMLInputElement} */ (e.currentTarget).checked;
				renderDuplicates();
			}}),
			' Make the editions one edition (they don\'t disagree on an ASIN or Goodreads id)'),
		buildElement('div', {class: 'formbtns'},
			buildElement('button', {type: 'button', class: 'save dup-merge', 'data-g': g, onclick: ()=> mergeGroup(g)}, 'Merge into one'),
			buildElement('button', {type: 'button', class: 'dup-apart', 'data-g': g, onclick: ()=> keepApart(g)}, 'Not duplicates')));
}

/**
 * Merge group `g` into its first book: on a copy of the catalog, so nothing changes unless the result validates.
 * @param {number} g
 */
export function mergeGroup(g){
	const ids = DUP_GROUPS[g];
	if(!ids) return;
	const merged = Book.merge(booksOf(ids), groupPicks(g));
	const copy = CATALOG.clone();
	const keep = inCatalogOrder(ids)[0];
	merged.id = keep;   // the book that comes first stays the record it was, in its place
	// an edition a box set shares with other titles gets what the merged one gained there too
	copy.saveBook(keep, merged);
	copy.books = copy.books.filter(b=> b.id === keep || !ids.includes(/** @type {string} */ (b.id)));
	const errors = copy.validate().errors.filter(e=> !e.startsWith('series-info'));
	if(errors.length){
		showIoStatus(`Couldn't merge ${merged.title}: ${errors[0]}`, true);
		return;
	}
	CATALOG.books = copy.books;
	forgetManualPair();            // one of its books is gone now
	refreshPage(); persist();
	showIoStatus(`Merged ${ids.length} entries into ${merged.title}.`);
}

/**
 * Remember that the books of group `g` are different books (Catalog.markNotDuplicates).
 * @param {number} g
 */
export function keepApart(g){
	CATALOG.markNotDuplicates(booksOf(DUP_GROUPS[g] || []));
	if(DUP_MANUAL && DUP_MANUAL.join() === (DUP_GROUPS[g] || []).join()) forgetManualPair();
	refreshPage(); persist();
}

/**
 * Make the editions of the book stored under `id` one edition (it is in SPLIT).
 * @param {string} id
 */
export function joinBookEditions(id){
	const b = CATALOG.book(id);
	if(!b || !Edition.joinable(b.editions)) return;
	const copy = CATALOG.clone();
	const joined = b.clone();
	joined.editions = [Edition.join(b.editions)];
	copy.saveBook(id, joined);
	const errors = copy.validate().errors.filter(e=> !e.startsWith('series-info'));
	if(errors.length){
		showIoStatus(`Couldn't join the editions of ${b.title}: ${errors[0]}`, true);
		return;
	}
	CATALOG.books = copy.books;
	forgetManualPair();
	refreshPage(); persist();
	showIoStatus(`${b.title} now has one edition.`);
}

/**
 * Remember that the editions of the book stored under `id` are different editions (Catalog.markKeepSeparate).
 * @param {string} id
 */
export function keepEditionsApart(id){
	const b = CATALOG.book(id);
	if(!b) return;
	CATALOG.markKeepSeparate(b);
	refreshPage(); persist();
}

/**
 * After a save took in what another tab changed (store.js): the pair picked by hand stays, unless the
 * other tab removed one of its books.
 */
function redraw(){
	if(DUP_MANUAL && !DUP_MANUAL.every(id=> CATALOG.book(id))) forgetManualPair();
	refreshPage();
}

export const READY = startPage(()=>{ DUP_MANUAL = manualPair(); refreshPage(); }, {whole: true, refresh: redraw});
