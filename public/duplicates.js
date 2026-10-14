// The duplicates page: books that look like one title entered twice (the way an import would match
// them; see Duplicates.groups), plus a pair picked by hand with the merge button on the catalog page
// (duplicates.html#merge=3,7). Merging keeps one entry, with the title, author and series you
// pick, and every genre, date read and edition of the others; the rest are removed without excluding
// them from imports (the kept book carries their ids, so an import finds it). Pairs marked
// "Not duplicates" are remembered in this browser and in backups (store.js).
// The editions of the merged entries become one edition when none disagree on an ASIN or Goodreads id
// (one book imported from both Audible and Goodreads), unless you untick that. Books merged before
// that, whose editions still look like one, are listed below the duplicates to be joined the same way.
import {Text} from './modules/text.js';
import {Edition} from './modules/edition.js';
import {Book} from './modules/book.js';
import {Duplicates} from './modules/duplicates.js';
import { CATALOG, addNotDuplicates, esc, updateNav, persist, showIoStatus, startPage, byId, spell } from './store.js';
/** @import {Picks} from './modules/book.js' */

/** @type {number[][]} */
export let DUP_GROUPS = [];           // groups of indexes into CATALOG.books shown
/** @type {Picks[]} */
export let DUP_PICKS = [];            // per group: which book's title, author and series to keep
/** @type {number[] | null} */
export let DUP_MANUAL = null;         // the pair picked by hand, until it is merged or kept apart
let DUP_FOUND = 0;             // how many of DUP_GROUPS Duplicates.groups found (the rest is DUP_MANUAL)
/** @type {number[]} */
export let SPLIT = [];                // indexes of books whose editions look like one edition recorded twice

/** @typedef {'title' | 'authors' | 'series'} DupField */
/** @type {[DupField, string][]} */
const DUP_FIELDS = [['title', 'Title'], ['authors', 'Author'], ['series', 'Series']];   // narrators are on the editions, which are all kept
/** @type {(b: Book, f: DupField) => string} */
const dupValue = (b, f)=> f === 'series' ? (b.series ? b.series + (b.number ? ` #${b.number}` : '') : '') : f === 'authors' ? Text.namesText(b.authors) : b.title;

/**
 * The pair in the address (#merge=3,7), if it names two books.
 * @returns {number[] | null}
 */
function manualPair(){
	const m = /^#merge=(\d+),(\d+)$/.exec(location.hash || '');
	if(!m) return null;
	const pair = [parseInt(m[1], 10), parseInt(m[2], 10)];
	return pair[0] !== pair[1] && pair.every(i=> i < CATALOG.books.length) ? pair : null;
}

function forgetManualPair(){
	DUP_MANUAL = null;
	try{ history.replaceState(null, '', location.pathname); }catch(e){}
}

// Find the groups again (the books changed), keeping the choices made for a group that is still there.
function refreshPage(){
	const duplicates = CATALOG.duplicates();
	const found = duplicates.groups();
	const pair = DUP_MANUAL;
	const manual = pair && !found.some(g=> pair.every(i=> g.includes(i))) ? [pair] : [];
	const groups = [...manual, ...found];
	DUP_FOUND = found.length;
	const before = new Map(DUP_GROUPS.map((g, k)=> [g.join(','), DUP_PICKS[k]]));
	DUP_GROUPS = groups;
	DUP_PICKS = groups.map(g=> before.get(g.join(',')) || {});
	SPLIT = duplicates.splitEditions();
	renderDuplicates();
}

/**
 * Whether any of `editions` is also on a book outside `idx` (a box set): joining it would change those too.
 * @param {Edition[]} editions
 * @param {number[]} idx
 * @returns {boolean}
 */
function sharedOutside(editions, idx){
	return CATALOG.books.some((b, i)=> !idx.includes(i) &&
		b.editions.some(x=> editions.some(ed=> x.sameAs(ed))));
}

/**
 * The choices for group `g`, with joinEditions on by default when the editions can be joined.
 * @param {number} g
 * @returns {Picks & {joinable: boolean, joinEditions: boolean}}
 */
function groupPicks(g){
	const idx = DUP_GROUPS[g], picks = DUP_PICKS[g];
	const separate = Book.merge(idx.map(i=> CATALOG.books[i]), {...picks, joinEditions: false}).editions;
	const joinable = Edition.joinable(separate) && !sharedOutside(separate, idx);
	return {...picks, joinable, joinEditions: joinable && picks.joinEditions !== false};
}

const editionLines = (/** @type {Book} */ b)=> b.editions.map(ed=> `<div class="dup-extra">${esc(ed.format())}</div>`).join('');

function renderSplit(){
	if(!SPLIT.length) return '';
	let html = '<h2 class="dup-heading">Editions that look like one</h2>' +
		'<p class="hint">These books have editions that don\'t disagree on an ASIN or Goodreads id, such as one from Audible and one from Goodreads.</p>';
	SPLIT.forEach(i=>{
		const b = CATALOG.books[i];
		const joined = Edition.join(b.editions);
		html += `<div class="dup-group"><div class="dup-books"><div class="dup-book">` +
			`<div class="dup-field"><span class="dup-label">Title</span> ${esc(b.title)}</div>` +
			`<div class="dup-field"><span class="dup-label">Author</span> ${esc(Text.namesText(b.authors))}</div>${editionLines(b)}</div></div>` +
			`<p class="dup-result">Becomes one edition: ${esc(joined.format())}</p>` +
			`<div class="formbtns"><button type="button" class="save split-join" data-i="${i}">Make one edition</button>` +
			`<button type="button" class="split-apart" data-i="${i}">Keep separate</button></div></div>`;
	});
	return html;
}

export function renderDuplicates(){
	byId('subtitle').textContent = (DUP_FOUND
		? `${DUP_FOUND} possible duplicate${DUP_FOUND === 1 ? '' : 's'} among ${CATALOG.books.length} audiobooks`
		: `No duplicates among ${CATALOG.books.length} audiobooks`) +
		(SPLIT.length ? `; ${SPLIT.length} book${SPLIT.length === 1 ? '' : 's'} with editions that look like one` : '');
	let html = DUP_GROUPS.length ? '' : spell('<p class="empty">No books look like duplicates. To merge two books anyway, ' +
		'press &#8644; on one of them in the catalog and then on the other.</p>');
	DUP_GROUPS.forEach((idx, g)=>{
		const books = idx.map(i=> CATALOG.books[i]);
		const picks = groupPicks(g);
		const merged = Book.merge(books, picks);
		html += `<div class="dup-group">${DUP_MANUAL && g === 0 && DUP_MANUAL.join() === idx.join() ? '<p class="dup-note">Picked by hand</p>' : ''}<div class="dup-books">`;
		books.forEach((b, k)=>{
			html += '<div class="dup-book">';
			DUP_FIELDS.forEach(([f, label])=>{
				const value = dupValue(b, f);
				if(!value) return;
				const choices = new Set(books.map(x=> dupValue(x, f)).filter(Boolean));
				const line = `<span class="dup-label">${label}</span> ${esc(value)}`;
				if(choices.size < 2){ html += `<div class="dup-field">${line}</div>`; return; }
				const checked = dupValue(merged, f) === value && books.findIndex(x=> dupValue(x, f) === value) === k;
				html += `<label class="dup-field dup-choice"><input type="radio" name="dup-${g}-${f}" data-g="${g}" data-f="${f}" data-k="${k}"${checked ? ' checked' : ''}> ${line}</label>`;
			});
			const extra = [
				b.genres.length ? esc(b.genres.join(', ')) : '',
				b.read.length ? 'Read ' + esc(b.read.join(', ')) : '',
				...b.editions.map(ed=> esc(ed.format())),
			].filter(Boolean);
			html += extra.map(x=> `<div class="dup-extra">${x}</div>`).join('') + '</div>';
		});
		const editions = merged.editions.length;
		html += `</div><p class="dup-result">Becomes: ${esc(merged.title)} — ${esc(Text.namesText(merged.authors))}` +
			(merged.series ? ` — ${esc(dupValue(merged, 'series'))}` : '') +
			(editions ? `, ${editions} edition${editions === 1 ? '' : 's'}` : '') +
			(merged.read.length ? `, read ${esc(merged.read.join(', '))}` : '') + '</p>' + editionLines(merged);
		if(picks.joinable){
			html += `<label class="dup-join"><input type="checkbox" class="dup-joinbox" data-g="${g}"${picks.joinEditions ? ' checked' : ''}> ` +
				'Make the editions one edition (they don\'t disagree on an ASIN or Goodreads id)</label>';
		}
		html += `<div class="formbtns"><button type="button" class="save dup-merge" data-g="${g}">Merge into one</button>` +
			`<button type="button" class="dup-apart" data-g="${g}">Not duplicates</button></div></div>`;
	});
	html += renderSplit();
	byId('dupBody').innerHTML = html;
	// (each element found is the kind its selector names, with the data-* the html above gives it)
	document.querySelectorAll('#dupBody .dup-joinbox').forEach(input=>{
		input.addEventListener('change', e=>{
			const box = /** @type {HTMLInputElement} */ (e.currentTarget);
			DUP_PICKS[Number(box.dataset.g)].joinEditions = box.checked;
			renderDuplicates();
		});
	});
	document.querySelectorAll('#dupBody .split-join').forEach(btn=>{
		btn.addEventListener('click', e=> joinBookEditions(parseInt(dataOf(e).i, 10)));
	});
	document.querySelectorAll('#dupBody .split-apart').forEach(btn=>{
		btn.addEventListener('click', e=> keepEditionsApart(parseInt(dataOf(e).i, 10)));
	});
	document.querySelectorAll('#dupBody input[type=radio]').forEach(input=>{
		input.addEventListener('change', e=>{
			const {g, f, k} = dataOf(e);
			DUP_PICKS[Number(g)][/** @type {DupField} */ (f)] = parseInt(k, 10);
			renderDuplicates();
		});
	});
	document.querySelectorAll('#dupBody .dup-merge').forEach(btn=>{
		btn.addEventListener('click', e=> mergeGroup(parseInt(dataOf(e).g, 10)));
	});
	document.querySelectorAll('#dupBody .dup-apart').forEach(btn=>{
		btn.addEventListener('click', e=> keepApart(parseInt(dataOf(e).g, 10)));
	});
}

/**
 * The data-* of the element an event's listener is on, which the html of renderDuplicates() gives it.
 * @param {Event} e
 * @returns {Record<string, string>}
 */
const dataOf = e=> /** @type {Record<string, string>} */ (/** @type {HTMLElement} */ (e.currentTarget).dataset);

/**
 * Merge group `g` into its first book: on a copy of the catalog, so nothing changes unless the result validates.
 * @param {number} g
 */
export function mergeGroup(g){
	const idx = DUP_GROUPS[g];
	if(!idx) return;
	const merged = Book.merge(idx.map(i=> CATALOG.books[i]), groupPicks(g));
	const copy = CATALOG.clone();
	const keep = Math.min(...idx);
	// an edition a box set shares with other titles gets what the merged one gained there too
	copy.saveBook(keep, merged);
	idx.filter(i=> i !== keep).sort((x, y)=> y - x).forEach(i=> copy.books.splice(i, 1));
	const errors = copy.validate().errors.filter(e=> !e.startsWith('series-info'));
	if(errors.length){
		showIoStatus(`Couldn't merge ${merged.title}: ${errors[0]}`, true);
		return;
	}
	CATALOG.books = copy.books;
	forgetManualPair();            // its indexes are stale now
	refreshPage(); persist();
	showIoStatus(`Merged ${idx.length} entries into ${merged.title}.`);
}

/**
 * Remember that the books of group `g` are different books (see addNotDuplicates).
 * @param {number} g
 */
export function keepApart(g){
	const books = (DUP_GROUPS[g] || []).map(i=> CATALOG.books[i]);
	addNotDuplicates(books.flatMap((x, k)=> books.slice(k + 1).map(y=> Duplicates.pairKey(x, y))));
	if(DUP_MANUAL && DUP_MANUAL.join() === (DUP_GROUPS[g] || []).join()) forgetManualPair();
	updateNav();
	refreshPage();
}

/**
 * Make the editions of book `i` one edition (it is in SPLIT).
 * @param {number} i
 */
export function joinBookEditions(i){
	const b = CATALOG.books[i];
	if(!b || !Edition.joinable(b.editions)) return;
	const copy = CATALOG.clone();
	const joined = b.clone();
	joined.editions = [Edition.join(b.editions)];
	copy.saveBook(i, joined);
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
 * Remember that the editions of book `i` are different editions (see addNotDuplicates).
 * @param {number} i
 */
export function keepEditionsApart(i){
	if(!CATALOG.books[i]) return;
	addNotDuplicates([Duplicates.editionsKey(CATALOG.books[i])]);
	updateNav();
	refreshPage();
}

export const READY = startPage(()=>{ DUP_MANUAL = manualPair(); refreshPage(); });
