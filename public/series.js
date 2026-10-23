// The series page (index.html): every series, and a series' own page (its books, and editing or removing it).
// The book cards and lists are book-list.js's; loading and saving live in store.js.
import {Text} from './modules/text.js';
import {Series} from './modules/series.js';
import {Validator} from './modules/validator.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import {CatalogRecords} from './modules/catalog-records.js';
/** @import {SeriesRecord} from './modules/catalog-records.js' */
/** @import {CatalogReader} from './modules/catalog-database.js' */
import { CATALOG, persist, loadRecords, queryCatalog, afterSaving, showIoStatus, startPage, byId, fieldById, spell, buildElement, fillElement, joined, creditPageHref,
	fillExternalFields, readExternalFields, externalFields, lookupHardcoverField, idFromAddress, hardcoverCompareHref, audiobookdbCompareHref, seriesPageHref, standalonePageHref } from './store.js';
/** @import {Child} from './store.js' */
import { BookList, STANDALONE, bookGroups, readOrdered, statusTag, seriesLinks, totalText, watchCoversBox, showEmptyCatalog, showBackupNudge,
	hashParts, hashText, hashOf, setAddress, watchSearchAndFilters } from './book-list.js';

// Series are known by the ids they are stored under, so a series renamed (here or in another tab) is still the one shown.
/** @type {string | null} */
export let SERIES_FILTER = null;      // the id of the series shown, STANDALONE, or null for every series
/** @type {string | null} */
let EDIT_SERIES = null;        // the id of the series being edited, or null
/** @type {string | null} */
let REMOVING_SERIES = null;    // the series Remove series was pressed for once, which a second press removes
/** @type {string | null} */
let JOIN_SERIES = null;        // the existing series a rename was asked to join, once Save was pressed for it

// The page holds only what it shows, read from the stored catalog by loadView(): every series' row, or the
// books of the series shown.
/**
 * The series' rows: every series (with books or not), the names of their authors, and how many books are in no series.
 * @typedef {{series: SeriesRecord[], authors: Map<string, string>, standalone: number}} Overview
 */
/** @type {Overview} */
let OVERVIEW = {series: [], authors: new Map(), standalone: 0};
const LIST = new BookList(()=> true);
export let TOTAL_BOOKS = 0;

/** @returns {string | null} the name of the series SERIES_FILTER shows, if it shows one */
function shownSeriesName(){
	return SERIES_FILTER === null || SERIES_FILTER === STANDALONE ? null : CATALOG.nameOf('series', SERIES_FILTER) ?? null;
}

/**
 * Show what SERIES_FILTER and the search say, once the saves asked for are done and it is read.
 * @returns {Promise<void>} once it is drawn
 */
function showView(){
	// a series shown on its own has nothing to search
	byId('controls').style.display = SERIES_FILTER === null ? '' : 'none';
	showFilterCount();
	return afterSaving(async ()=>{ await loadView(); render(); });
}

/**
 * Read what the page shows from the stored catalog: every series' row, or the books of the series shown
 * (at least `showing` of them, so a redraw after an edit shows as many as before).
 * @param {number} [showing]
 * @returns {Promise<void>}
 */
async function loadView(showing = 0){
	await resolveAddress();
	TOTAL_BOOKS = await queryCatalog(r=> r.count('books'));
	if(SERIES_FILTER === null){ OVERVIEW = await queryCatalog(readOverview); return; }
	const series = SERIES_FILTER;
	await LIST.show(await queryCatalog(r=> readOrdered(r, series)), showing);
	if(series !== STANDALONE) await loadRecords({series: [series]});
}

/**
 * A series named in the address the way addresses had it before (by its name): the id it is stored under,
 * put in the address instead.
 * @returns {Promise<void>}
 */
async function resolveAddress(){
	if(SERIES_FILTER === null || SERIES_FILTER === STANDALONE) return;
	const text = SERIES_FILTER;
	const id = await queryCatalog(async r=>{
		if((await r.count('series', undefined, text))) return text;
		const [rec] = await r.all('series', 'name', text);
		return rec ? rec.id : text;
	});
	if(id !== text){ SERIES_FILTER = id; setAddress('replace', addressNow()); }
}

/**
 * The series' rows (see Overview), without reading any book.
 * @param {CatalogReader} r
 * @returns {Promise<Overview>}
 */
async function readOverview(r){
	/** @type {SeriesRecord[]} */
	const series = await r.all('series', 'byName');
	const people = await r.get('contributors', [...new Set(series.flatMap(s=> s.authorIds))]);
	return {series, authors: new Map(people.map(c=> [c.id, c.name])), standalone: await r.count('books', 'standalone')};
}

/**
 * Read what the page shows again from the stored catalog, once the saves asked for are done (after an
 * edit, or another tab's), keeping as many books shown as there were.
 * @returns {Promise<void>}
 */
export function refreshView(){
	return afterSaving(async ()=>{ await loadView(LIST.showing); render(); });
}

// The Show more button at the end of a series' books.
export function showMore(){
	return afterSaving(async ()=>{ await LIST.more(); render(); });
}

export function render(){
	if(!TOTAL_BOOKS && !CATALOG.books.length){ showEmptyCatalog(); return; }
	const name = shownSeriesName();
	const label = SERIES_FILTER === null ? null : SERIES_FILTER === STANDALONE ? 'Standalone books' : name || 'No such series';
	byId('crumb').classList.toggle('show', label !== null);
	byId('crumbLabel').textContent = label || '';
	document.title = (label ? label + ' — ' : '') + spell('Audiobook Catalog');
	// books are added to a series shown, starting in it
	byId('toggleAdd').style.display = SERIES_FILTER === null ? 'none' : '';
	byId('toggleAdd').setAttribute('href', 'book.html' + hashOf([['add', true], ['series', name !== null && SERIES_FILTER || '']]));
	if(SERIES_FILTER === null){ renderOverview(); return; }

	const books = LIST.books().filter(b=> SERIES_FILTER === STANDALONE ? !b.series : b.series === name);
	byId('subtitle').textContent = spell(`${TOTAL_BOOKS} audiobooks in the catalog`);
	byId('resultCount').textContent = '';
	fillElement(byId('results'), books.length ? bookGroups(books, {more: LIST.rest, onMore: ()=> showMore(),
		// it can be compared with Hardcover and AudiobookDB, and edited, after its books
		heading: id=> [' ', buildElement('a', {class: 'hardcoverCompare', href: hardcoverCompareHref('series', id)}, 'Compare with Hardcover'),
			' ', buildElement('a', {class: 'audiobookdbCompare', href: audiobookdbCompareHref('series', id)}, 'Compare with AudiobookDB')],
		after: id=> seriesEditButton(id)})
		: [buildElement('p', {class: 'empty'}, name === null ? 'No books in this series.' : `No books in ${name} yet.`),
			SERIES_FILTER !== STANDALONE && name !== null && seriesEditButton(SERIES_FILTER)]);
}

/**
 * A series' info, from its record; undefined when it has none.
 * @param {SeriesRecord} rec
 * @returns {Series | undefined}
 */
const seriesInfoOf = rec=> CatalogRecords.hasInfo('series', rec)
	? new Series(rec.name, {total: rec.total, status: rec.status, note: rec.note, external: rec.external}) : undefined;

function renderOverview(){
	const q = fieldById('q').value.trim().toLowerCase();
	let rows = OVERVIEW.series.map(rec=> ({rec, info: seriesInfoOf(rec),
		authors: [...new Set(rec.authorIds)].filter(id=> OVERVIEW.authors.has(id))
			.map(id=> ({id, name: /** @type {string} */ (OVERVIEW.authors.get(id))})).sort((x, y)=> x.name.localeCompare(y.name))}))
		.sort((x, y)=> x.rec.name.localeCompare(y.rec.name));
	if(q) rows = rows.filter(({rec, authors})=> [rec.name, ...authors.map(a=> a.name)].join(' ').toLowerCase().includes(q));
	const onlyMissing = fieldById('missingFilter').value === 'missing';
	if(onlyMissing) rows = rows.filter(({rec})=> (rec.missing || []).length);

	byId('subtitle').textContent =
		`${OVERVIEW.series.length} series across ${TOTAL_BOOKS} audiobooks — tap a series to see its titles`;
	byId('resultCount').textContent = `${rows.length} series shown`;

	/** @type {Child[]} */
	const out = [];
	const showStandalone = !onlyMissing && (!q || 'standalone'.includes(q));
	if(rows.length === 0 && !showStandalone){
		out.push(buildElement('p', {class: 'empty'}, onlyMissing ? 'No series with missing books.' : 'No series match your search.'));
	}

	rows.forEach(({rec, info, authors})=>{
		const missing = rec.missing;
		out.push(buildElement('div', {class: 'srow'},
			buildElement('div', {class: 'srow-head'},
				buildElement('a', {class: 'srow-title', href: seriesPageHref(rec.id)}, rec.name), ' ',
				buildElement('span', {class: 'srow-owned'}, rec.bookCount ? `${rec.owned} owned${info ? ' of ' + totalText(info) : ''}`
					: `no books yet${info ? ', ' + totalText(info) + ' released' : ''}`)),
			buildElement('div', {class: 'srow-foot'}, buildElement('span', {class: 'tag'},
				joined(authors.map(a=> buildElement('a', {href: creditPageHref('authors', a.id)}, a.name)), ', ')),
				info && [' ', statusTag(info.status), seriesLinks(info)],
				missing && missing.length > 0 && [' ', buildElement('span', {class: 'missing'}, `missing ${Series.numberList(missing)}`)]),
			info && info.note && buildElement('p', {class: 'srow-note'}, info.note)));
	});

	if(showStandalone){
		out.push(buildElement('div', {class: 'srow'}, buildElement('div', {class: 'srow-head'},
			buildElement('a', {class: 'srow-title', href: standalonePageHref()}, 'Standalone'), ' ',
			buildElement('span', {class: 'srow-owned'}, `${OVERVIEW.standalone} owned`))));
	}

	fillElement(byId('results'), out);
}

// ------------------------------------------------------------------ the address
// What is shown lives in the address after the #, so a series or a search can be linked to, bookmarked and
// reloaded, and the browser's back and forward buttons step through what you looked at:
//   (nothing)   every series     #q=gull&missing   ...searched, only series with gaps
//   #series=<id>, #standalone    a series' books
// A series is named by the id it is stored under, so a link holds when it is renamed; an address from
// before, with its name, is still understood. This page showed all books and each book's details too,
// and its addresses for them (#books..., #book=<id>) go to the books page and the book's page.

/**
 * Where an address of this page from before goes now: the books page or a book's page; null when it is this page's.
 * @param {string} hash
 * @returns {string | null}
 */
export function movedAddress(hash){
	const p = hashParts(hash);
	const book = hashText(p, 'book');
	if(book) return 'book.html' + hashOf([['book', book]]);
	if(!p.has('books')) return null;
	return 'books.html' + hashOf(['q', 'author', 'genre', 'read', 'sort'].map(k=> [k, hashText(p, k)]));
}

/**
 * The address's #... -> what it shows; anything it does not understand is ignored.
 * @param {string | null} hash
 * @returns {{series: string | null, q: string, missing: boolean}}
 */
function stateFromHash(hash){
	const p = hashParts(hash);
	const series = hashText(p, 'series');
	// by id, or by a name as addresses had them before (loadView finds the id then)
	return {series: p.has('standalone') ? STANDALONE : series ? idFromAddress('series', series) ?? series : null,
		q: hashText(p, 'q'), missing: p.get('missing') === true};
}

/** @returns {string} the address of what is shown now */
function addressNow(){
	return hashOf(SERIES_FILTER === STANDALONE ? [['standalone', true]] : SERIES_FILTER !== null ? [['series', SERIES_FILTER]]
		: [['q', fieldById('q').value.trim()], ['missing', fieldById('missingFilter').value === 'missing']]);
}

/**
 * Show a series (an id, STANDALONE) or every series, recorded in the address: a new history entry, so Back
 * returns here. Going to another series closes the form and starts at the top of the page.
 * @param {string | null} series
 * @returns {Promise<void>} once it is drawn
 */
export function openSeries(series){
	const moved = series !== SERIES_FILTER;
	if(moved) closeSeriesForm();
	SERIES_FILTER = series;
	const drawn = showView();
	if(addressNow() !== location.hash) setAddress('push', addressNow());
	if(moved && typeof scrollTo === 'function') scrollTo(0, 0);
	return drawn;
}

// Back and forward (and an address typed, pasted or followed): show what the address says. The browser puts
// the scroll position back itself, as the page is redrawn before this returns.
function showAddress(){
	const moved = movedAddress(location.hash);
	if(moved){ location.replace(moved); return; }
	const st = stateFromHash(location.hash);
	const box = fieldById('q');
	// the address's search is trimmed; leave the box alone when it already says that, or a space being typed is lost
	if(box.value.trim() !== st.q) box.value = st.q;
	fieldById('missingFilter').value = st.missing ? 'missing' : '';
	if(st.series !== SERIES_FILTER) closeSeriesForm();
	SERIES_FILTER = st.series;
	showView();
}
addEventListener('popstate', showAddress);
addEventListener('hashchange', showAddress);

byId('missingFilter').addEventListener('change', ()=>{ setAddress('push', addressNow()); showView(); });
// On a phone the filter folds away behind a button (styles.css), which says when it is on.
function showFilterCount(){
	byId('filtersBtn').textContent = fieldById('missingFilter').value ? 'Filters · 1' : 'Filters';
}
watchSearchAndFilters(addressNow, showView);
watchCoversBox(()=> render());

// ------------------------------------------------------------------ the series form
// Edits the series: its name, which is renamed on every book in the series, and what CATALOG.series keeps
// about it (released total, status, note, author site). Like book edits, it is kept in this browser (see
// persist). Remove series takes it off its books and removes it.
/**
 * The Edit button at the end of a series' own page, which opens its form.
 * @param {string} id the series'
 * @returns {HTMLDivElement}
 */
function seriesEditButton(id){
	return buildElement('div', {class: 'page-actions'},
		buildElement('button', {type: 'button', class: 'sedit', 'data-series': id, onclick: ()=> openSeriesForm(id)}, 'Edit'));
}

/**
 * Open the series form, once the series and its books are loaded (a rename or a removal changes them all).
 * @param {string} id the series'
 * @returns {Promise<void>}
 */
export async function openSeriesForm(id){
	await loadRecords({seriesBooks: [id], series: [id]});
	const name = CATALOG.nameOf('series', id);
	if(name === undefined) return;
	const info = CATALOG.series.get(id);
	EDIT_SERIES = id; JOIN_SERIES = null; REMOVING_SERIES = null;
	fieldById('sf_name').value = name;
	byId('seriesFormTitle').textContent = 'Edit series: ' + name;
	fieldById('sf_total').value = info ? totalText(info) : '';
	fieldById('sf_status').value = info ? String(info.toJSON().status ?? '') : 'ongoing';
	fieldById('sf_note').value = info ? info.note || '' : '';
	fillExternalFields('sf_ext_', 'series', info ? info.external : {});
	byId('seriesFormError').textContent = '';
	const form = byId('seriesForm');
	form.classList.add('open');
	form.scrollIntoView({behavior:'smooth', block:'center'});
}

function closeSeriesForm(){
	EDIT_SERIES = null; JOIN_SERIES = null; REMOVING_SERIES = null;
	byId('seriesForm').classList.remove('open');
	/** @type {HTMLFormElement} */ (byId('seriesForm')).reset();
	byId('seriesFormError').textContent = '';
}

async function saveSeriesForm(){
	const id = EDIT_SERIES;
	const name = id === null ? undefined : CATALOG.nameOf('series', id);
	if(id === null || name === undefined) return;
	const showError = (/** @type {string} */ text)=> { byId('seriesFormError').textContent = text; };
	// a Hardcover address is looked up for its number first, unless the form is closed or moved meanwhile
	const lookup = lookupHardcoverField('sf_ext_', 'series');
	const hardcover = lookup ? await lookup : {error: '', note: ''};
	// the series may have been renamed in another tab meanwhile, so its name is read again
	const now = CATALOG.nameOf('series', id);
	if(EDIT_SERIES !== id || now === undefined) return;
	if(now !== name) return saveSeriesForm();
	if(hardcover.error) return showError(hardcover.error);
	const newName = Text.tidy(fieldById('sf_name').value);
	if(!newName) return showError('Give the series a name.');
	const renamed = newName !== name;
	const totalTyped = fieldById('sf_total').value.trim();
	const note = Text.tidy(fieldById('sf_note').value);
	const had = CATALOG.series.get(id);
	const external = readExternalFields('sf_ext_', 'series', had ? had.external : {});
	if(external.bad.length) return showError(`Not an id or address there: ${external.bad.join('; ')}.`);
	// a series needs none of these; with all of them empty, it keeps none
	const typedAny = totalTyped || note || Object.keys(external.ids).length;
	/** @type {Series | null} */
	let entry = null;
	if(typedAny){
		// unchecked as typed: the Check below says what is wrong with the total or status
		/** @type {Record<string, unknown>} */
		const typed = {total: /^\d+$/.test(totalTyped) ? parseInt(totalTyped, 10) : totalTyped.toLowerCase(),
			status: fieldById('sf_status').value, note};
		if(Object.keys(external.ids).length) typed.ext = ExternalCatalog.order(external.ids);
		// the same rules as Check, applied to just this series (checked before the rename,
		// under the name its books have now)
		const {errors} = Validator.validate(JSON.parse(JSON.stringify(CATALOG.books)), {[name]: typed});
		const problems = errors.filter(e=> e.startsWith('series-info')).map(e=> e.replace(/^series-info(\[[^\]]*\])?: /, ''));
		if(problems.length) return showError(problems.join('; '));
		entry = Series.fromJSON(newName, typed);
	}
	// Joining another series is easy to do by mistake (and replaces what it has), so the first Save says so.
	// the series it would join, with its books, which move into it with these
	if(renamed) await loadRecords({seriesNamed: [newName]});
	if(EDIT_SERIES !== id) return;
	const exists = CATALOG.nameIds.series.has(newName);
	if(renamed && exists && JOIN_SERIES !== newName){
		JOIN_SERIES = newName;
		return showError(`There is already a series called ${newName}. Press Save again to move these books into it` +
			(entry && CATALOG.seriesInfo(newName) ? '; its total, status, note and links will be replaced by these.' : '.'));
	}

	// renamed on its books, keeping the id it is stored under (or taking the id of the one it joins)
	const count = renamed ? CATALOG.renameEntry('series', name, newName) : 0;
	const newId = CATALOG.idFor('series', newName);
	// with every field emptied it keeps none, but a series it joins keeps its own
	if(entry) CATALOG.series.set(newId, entry); else if(!(renamed && exists)) CATALOG.series.delete(newId);
	closeSeriesForm();
	// the series shown keeps showing, under its new name
	if(SERIES_FILTER === id && newId !== id){ SERIES_FILTER = newId; setAddress('replace', addressNow()); }
	showView();
	persist();
	showIoStatus((renamed
		? `Renamed ${name} to ${newName} on ${Text.plural(count, 'book')}.`
		: `Saved ${name}.`) + (hardcover.note ? ' ' + hardcover.note : ''));
}

/**
 * Remove series: the first press says what it does, the second takes the series off its books (they keep
 * everything else, but their number in it) and removes it. The form loaded all its books.
 */
function removeSeries(){
	const id = EDIT_SERIES, name = id === null ? undefined : CATALOG.nameOf('series', id);
	if(id === null || name === undefined) return;
	const count = CATALOG.booksOf('series', id).length;
	if(REMOVING_SERIES !== id){
		REMOVING_SERIES = id;
		byId('seriesFormError').textContent = (count
			? `This takes ${name} off its ${Text.plural(count, 'book')}, which stay in the catalog without a series or a number in it, and removes the series.`
			: `This removes ${name}, which no book is in.`) + ' Press Remove series again to do it.';
		return;
	}
	CATALOG.removeEntry('series', id);
	closeSeriesForm();
	// its page is gone, so every series shows
	if(SERIES_FILTER === id){ SERIES_FILTER = null; setAddress('replace', addressNow()); }
	showView();
	persist();
	showIoStatus(count ? `Removed the series ${name} from ${Text.plural(count, 'book')}.` : `Removed the series ${name}.`);
}

byId('seriesForm').addEventListener('submit', e=>{ e.preventDefault(); return saveSeriesForm(); });
byId('seriesRemoveBtn').addEventListener('click', removeSeries);
byId('cancelSeries').addEventListener('click', closeSeriesForm);
fillElement(byId('sf_ext'), externalFields('sf_ext_', 'series'));

// After a save took in what another tab changed (store.js): the series being edited stays open
// unless the other tab removed it.
function redraw(){
	if(EDIT_SERIES !== null && CATALOG.nameOf('series', EDIT_SERIES) === undefined) closeSeriesForm();
	refreshView();
}

// An address from when this page showed the books too goes where they are now; the page starts on what the
// address shows (a link, a bookmark, or Back from another page).
const MOVED = movedAddress(location.hash);
if(MOVED) location.replace(MOVED);
export const READY = MOVED ? Promise.resolve() : startPage(async ()=>{
	const st = stateFromHash(location.hash);
	fieldById('q').value = st.q;
	fieldById('missingFilter').value = st.missing ? 'missing' : '';
	SERIES_FILTER = st.series;
	const drawn = showView();
	setAddress('replace', addressNow());
	await drawn;
	await showBackupNudge();
}, {refresh: redraw});
