// The catalog page: the series overview, all books, and editing books and series info.
// Loading and saving live in store.js.
import {Text} from './modules/text.js';
import {Edition} from './modules/edition.js';
import {Book} from './modules/book.js';
import {Series} from './modules/series.js';
import {Validator} from './modules/validator.js';
import {HardcoverClient} from './modules/hardcover-client.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import {CatalogRecords} from './modules/catalog-records.js';
/** @import {SeriesRecord} from './modules/catalog-records.js' */
/** @import {CatalogReader} from './modules/catalog-database.js' */
import { CATALOG, persist, loadRecords, queryCatalog, afterSaving, addExclusions, showIoStatus, lookupHardcoverBook, startPage, byId, fieldById, spell, buildElement, fillElement, joined, authorPageHref, narratorPageHref, publisherPageHref, creditPageHref,
	externalFields, fillExternalFields, readExternalFields, externalLinks, lookupHardcoverField, idFromAddress, hardcoverCompareHref } from './store.js';
/** @import {Child} from './store.js' */

/** @type {'series' | 'library'} */
export let VIEW = 'series';           // 'series' | 'library'
// Series and books are known by the ids they are stored under, so a series renamed or a book retitled
// (here or in another tab) is still the one shown or edited.
/** @type {string | null} */
export let SERIES_FILTER = null;      // the id of the series shown, '__standalone__', or null
/** @type {string | null} */
export let BOOK_FILTER = null;        // the id of the book linked to (#book=...), or null
/** @type {string | null} */
export let EDIT_ID = null;            // the id of the book being edited, or null when adding new
/** @type {string | null} */
let EDIT_SERIES = null;        // the id of the series whose info is being edited, or null
/** @type {string | null} */
let JOIN_SERIES = null;        // the existing series a rename was asked to join, once Save was pressed for it
/** @type {string | null} */
let MERGE_FROM = null;         // the id of the first book picked with its merge button, or null

// The page holds only what it shows, read from the stored catalog by loadView(): for all books (or a
// series', or what the search and filters find), the ids of the books listed, in the order they are listed,
// of which the first SHOWING are drawn (Show more draws more); for the series overview, its rows.
const PAGE_SIZE = 50;
/** @type {string[]} */
let LISTED = [];
let SHOWING = 0;
/**
 * The series overview's rows: the series with books, the names of their authors, and how many books are in no series.
 * @typedef {{series: SeriesRecord[], authors: Map<string, string>, standalone: number}} Overview
 */
/** @type {Overview} */
let OVERVIEW = {series: [], authors: new Map(), standalone: 0};
export let TOTAL_BOOKS = 0;
/** @type {{authors: string[], genres: string[], years: string[]}} the filters' choices */
let FILTER_CHOICES = {authors: [], genres: [], years: []};

// Filter value for books with no date read, in the "Read any time" select.
const UNDATED = '__undated__';

/**
 * Year a book was (last) read in, for the read filter: '2024' from ['2021-05', '2024-03-15'].
 * @type {(b: Book) => string[]}
 */
const readYears = b => b.read.map(d => d.slice(0, 4));

/** @param {string[]} arr */
function uniqueSorted(arr){ return [...new Set(arr)].sort((a,b)=>a.localeCompare(b)); }
/**
 * Authors' names, each a link to their page on the authors page.
 * @type {(names: string[]) => Child[]}
 */
const authorLinks = names => joined(names.map(x=> buildElement('a', {href: authorPageHref(x)}, x)), ', ');
/**
 * Narrators' names, each a link to their page on the narrators page.
 * @type {(names: string[]) => Child[]}
 */
const narratorLinks = names => joined(names.map(x=> buildElement('a', {href: narratorPageHref(x)}, x)), ', ');
/**
 * A series' status, as a tag.
 * @type {(status: string | undefined) => HTMLSpanElement}
 */
const statusTag = status=> buildElement('span', {class: `status ${status}`}, status === 'complete' ? 'complete' : 'ongoing');
/** @type {(url: string) => HTMLAnchorElement} */
const authorSiteLink = url=> buildElement('a', {class: 'authorlink', href: url, target: '_blank', rel: 'noopener'}, 'author site \u2197');
/** @type {(info: Series) => Child[]} the series' pages in external catalogs */
const seriesLinks = info=> externalLinks(info.external, 'series').map(a=> [' ', a]);

/**
 * Series numbers you don't own yet, from series-info.json's released total; null when that is unknown.
 * @param {string} name
 * @returns {number[] | null}
 */
function seriesMissing(name){
	return CATALOG.missing(name);
}

/**
 * A series' released total as its info has it (as typed, should it not be a number).
 * @param {Series} info
 * @returns {string}
 */
const totalText = info=> String(info.toJSON().total ?? '');

/**
 * A series' books by number, unnumbered ones first, and its collections (box sets, "1-3") last.
 * @param {Book} a
 * @param {Book} b
 * @returns {number}
 */
function seriesOrder(a, b){
	const last = (/** @type {Book} */ x)=> (Series.range(x.number) || [0, 0])[1];
	return (Number(a.isCollection()) - Number(b.isCollection())) ||
		(parseFloat(a.number || '')||0) - (parseFloat(b.number || '')||0) || last(a) - last(b);
}

/**
 * "3 owned + 1 box set": a box set kept as its own book is not one more title.
 * @param {Book[]} books
 * @returns {string}
 */
function ownedText(books){
	const sets = books.filter(b=> b.isCollection()).length;
	return `${Series.owned(books)} owned` + (sets ? ` + ${sets} box set${sets > 1 ? 's' : ''}` : '');
}

/**
 * [3, 5, 6, 7] -> "#3, #5-7"
 * @param {number[]} nums
 * @returns {string}
 */
function numberList(nums){
	/** @type {[number, number][]} */
	const runs = [];
	nums.forEach(n=>{
		const last = runs[runs.length - 1];
		if(last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
	});
	return runs.map(([a,b])=> a === b ? `#${a}` : `#${a}\u2013${b}`).join(', ');
}

/**
 * The filters' choices, from the stored catalog: its authors, genres and the years books were read in.
 * @param {CatalogReader} r
 * @returns {Promise<typeof FILTER_CHOICES>}
 */
async function readFilterChoices(r){
	// the authors' names are the keys of an index, so no record is read for them
	const authors = (await r.indexKeys('contributors', 'kindName', r.keyRange.bound(['author'], ['author', []]))).map(([key])=> String(/** @type {IDBValidKey[]} */ (key)[1]));
	const years = /** @type {string[]} */ (await r.keys('books', 'readYears')).filter(y=> y !== CatalogRecords.UNDATED);
	return {authors: uniqueSorted(authors), genres: uniqueSorted(/** @type {string[]} */ (await r.keys('books', 'genres'))), years: uniqueSorted(years).reverse()};
}

function populateFilters(){
	const {authors, genres, years} = FILTER_CHOICES;
	const aSel = fieldById('authorFilter');
	const gSel = fieldById('genreFilter');
	const rSel = fieldById('readFilter');
	const aCur = aSel.value, gCur = gSel.value, rCur = rSel.value;
	/** @type {(value: string, text: string) => HTMLOptionElement} */
	const option = (value, text)=> buildElement('option', {value}, text);
	fillElement(aSel, option('', 'All authors'), authors.map(a=> option(a, a)));
	fillElement(gSel, option('', 'All genres'), genres.map(g=> option(g, g)));
	fillElement(rSel, option('', 'Read any time'), years.map(y=> option(y, `Read in ${y}`)), option(UNDATED, 'No date read'));
	aSel.value = aCur; gSel.value = gCur; rSel.value = rCur;
	if(!CATALOG.book(MERGE_FROM)) MERGE_FROM = null;   // the book picked for merging is gone
}

/** @returns {string | null} the name of the series SERIES_FILTER shows, if it shows one */
function shownSeriesName(){
	return SERIES_FILTER === null || SERIES_FILTER === '__standalone__' ? null : CATALOG.nameOf('series', SERIES_FILTER) ?? null;
}

/**
 * @param {Book} b
 * @param {string} q
 * @param {string} author
 * @param {string} genre
 * @param {string} read
 * @param {string | null} series the name of the series shown (shownSeriesName)
 * @returns {boolean}
 */
function matches(b, q, author, genre, read, series){
	if(BOOK_FILTER !== null && b.id !== BOOK_FILTER) return false;
	if(SERIES_FILTER){
		if(SERIES_FILTER === '__standalone__'){ if(b.series) return false; }
		else if(series === null || b.series !== series) return false;
	}
	if(author && !b.authors.includes(author)) return false;
	if(genre && !b.genres.includes(genre)) return false;
	if(read === UNDATED){ if(b.read.length) return false; }
	else if(read && !readYears(b).includes(read)) return false;
	// an ISBN matches however it is typed: with hyphens, or as the ISBN-10 of the same edition
	if(q && !CatalogRecords.searchMatches(CatalogRecords.searchText(b), q)) return false;
	return true;
}

// Show VIEW with SERIES_FILTER / BOOK_FILTER and the filters as they are; navigate() is how they change.
// What it shows is read from the stored catalog first (loadView), once the saves asked for are done.
/** @returns {Promise<void>} once it is drawn */
function showView(){
	const v = VIEW;
	byId('btnSeriesView').classList.toggle('active', v==='series');
	byId('btnLibraryView').classList.toggle('active', v==='library');
	const showLibControls = v === 'library';
	byId('authorFilter').style.display = showLibControls ? '' : 'none';
	byId('genreFilter').style.display = showLibControls ? '' : 'none';
	byId('readFilter').style.display = showLibControls ? '' : 'none';
	byId('toggleAdd').style.display = showLibControls ? '' : 'none';
	byId('missingFilter').style.display = showLibControls ? 'none' : '';
	// a book shown on its own has nothing to search or filter
	byId('controls').style.display = BOOK_FILTER !== null ? 'none' : '';
	showFilterCount();
	return afterSaving(async ()=>{ await loadView(); drawView(); });
}

// The crumb, the title and the list, from what loadView() read.
function drawView(){
	const v = VIEW;
	const crumb = byId('crumb');
	const book = CATALOG.book(BOOK_FILTER);
	const label = v !== 'library' ? null : BOOK_FILTER !== null ? (book ? book.title : 'No such book')
		: SERIES_FILTER === '__standalone__' ? 'Standalone books' : SERIES_FILTER !== null ? shownSeriesName() || 'No such series' : null;
	crumb.classList.toggle('show', !!label);
	byId('crumbLabel').textContent = label || '';
	document.title = (label ? label + ' — ' : v === 'library' ? 'All books — ' : '') + spell('Audiobook Catalog');
	render();
}

/**
 * Read what the view shows from the stored catalog: the overview's rows, or the books listed (their ids)
 * and the first of them (at least `showing`, so a redraw after an edit shows as many as before), each
 * with every book of its series, as the series' heading counts them.
 * @param {number} [showing]
 * @returns {Promise<void>}
 */
async function loadView(showing = 0){
	await resolveAddress();
	TOTAL_BOOKS = await queryCatalog(r=> r.count('books'));
	if(VIEW === 'series'){ OVERVIEW = await queryCatalog(readOverview); return; }
	LISTED = await queryCatalog(readListed);
	SHOWING = 0;
	await loadMore(Math.max(showing, PAGE_SIZE));
	if(SERIES_FILTER !== null && SERIES_FILTER !== '__standalone__') await loadRecords({series: [SERIES_FILTER]});
}

/**
 * Show `count` more of the books listed, or a few more, so a series' books aren't split between two pages.
 * @param {number} [count]
 * @returns {Promise<void>}
 */
async function loadMore(count = PAGE_SIZE){
	let end = Math.min(LISTED.length, SHOWING + count);
	const ids = LISTED.slice(SHOWING, end);
	await loadRecords({books: ids});
	/** @type {(id: string) => string | undefined} */
	const seriesOf = id=> { const b = CATALOG.book(id); return b && b.series; };
	const series = [...new Set(ids.map(seriesOf))].filter(x=> x !== undefined).map(name=> CATALOG.nameIds.series.get(/** @type {string} */ (name)));
	if(series.length) await loadRecords({seriesBooks: /** @type {string[]} */ (series.filter(Boolean))});
	// the rest of the last series shown, which is loaded now
	const last = ids.length ? seriesOf(ids[ids.length - 1]) : undefined;
	while(last !== undefined && end < LISTED.length && seriesOf(LISTED[end]) === last) end++;
	SHOWING = end;
}

// The Show more button at the end of a list.
export function showMore(){
	return afterSaving(async ()=>{ await loadMore(); render(); });
}

/**
 * A book or series named in the address the way addresses had them before (by its title or name): the
 * id it is stored under, put in the address instead.
 * @returns {Promise<void>}
 */
async function resolveAddress(){
	if(BOOK_FILTER !== null){
		const text = BOOK_FILTER;
		const id = await queryCatalog(async r=>{
			if((await r.count('books', undefined, text))) return text;
			const sortTitle = CatalogRecords.sortKey(text);
			const found = await r.under('books', 'byTitle', [sortTitle]);
			const book = found.find(b=> b.title === text);
			return book ? book.id : text;
		});
		if(id !== text){ BOOK_FILTER = id; setAddress('replace', viewState()); }
	}
	if(SERIES_FILTER !== null && SERIES_FILTER !== '__standalone__'){
		const text = SERIES_FILTER;
		const id = await queryCatalog(async r=>{
			if((await r.count('series', undefined, text))) return text;
			const [rec] = await r.all('series', 'name', text);
			return rec ? rec.id : text;
		});
		if(id !== text){ SERIES_FILTER = id; setAddress('replace', viewState()); }
	}
}

/**
 * The series overview's rows (see Overview), without reading any book.
 * @param {CatalogReader} r
 * @returns {Promise<Overview>}
 */
async function readOverview(r){
	/** @type {SeriesRecord[]} */
	const series = (await r.all('series', 'byName')).filter(s=> s.bookCount > 0);
	const people = await r.get('contributors', [...new Set(series.flatMap(s=> s.authorIds))]);
	return {series, authors: new Map(people.map(c=> [c.id, c.name])), standalone: await r.count('books', 'standalone')};
}

/**
 * The ids of the books the list shows, in the order it shows them: the series by name, each in reading
 * order (box sets last), then the books in no series by title. A search and the filters narrow them, by
 * the indexes for them; only the indexes' keys are read, not the books.
 * @param {CatalogReader} r
 * @returns {Promise<string[]>}
 */
async function readListed(r){
	if(BOOK_FILTER !== null) return (await r.allKeys('books', undefined, BOOK_FILTER)).map(String);
	const q = fieldById('q').value.trim();
	const author = fieldById('authorFilter').value;
	const genre = fieldById('genreFilter').value;
	const read = fieldById('readFilter').value;
	/** @type {Set<string> | null} */
	let only = null;
	/** @type {(ids: IDBValidKey[]) => void} */
	const narrow = ids=>{ const found = new Set(ids.map(String)); only = only ? new Set([...only].filter(id=> found.has(id))) : found; };
	if(author){
		const [rec] = await r.all('contributors', 'kindName', ['author', author]);
		narrow(rec ? (await r.allKeys('credits', 'byTitle', r.keyRange.bound([rec.id], [rec.id, []]))).map(key=> /** @type {IDBValidKey[]} */ (key)[1]) : []);
	}
	if(genre) narrow(await r.allKeys('books', 'genres', genre));
	if(read) narrow(await r.allKeys('books', 'readYears', read === UNDATED ? CatalogRecords.UNDATED : read));
	if(q) narrow((await r.indexKeys('books', 'search')).filter(([text])=> CatalogRecords.searchMatches(String(text), q)).map(([, id])=> id));
	/** @type {Map<string, string>} */
	const names = new Map((await r.indexKeys('series', 'name')).map(([name, id])=> [String(id), String(name)]));
	const numbered = (/** @type {unknown} */ n)=> n === CatalogRecords.UNNUMBERED ? 0 : Number(n);
	const inSeries = (await r.indexKeys('books', 'bySeries')).map(([key, id])=> ({id: String(id), key: /** @type {any[]} */ (key)}))
		.filter(x=> SERIES_FILTER === null || x.key[0] === SERIES_FILTER);
	// as seriesOrder() puts a series' books
	inSeries.sort((x, y)=> (names.get(x.key[0]) || '').localeCompare(names.get(y.key[0]) || '') || (x.key[0] < y.key[0] ? -1 : x.key[0] > y.key[0] ? 1 : 0)
		|| x.key[1] - y.key[1] || numbered(x.key[2]) - numbered(y.key[2]) || numbered(x.key[3]) - numbered(y.key[3]));
	const standalone = SERIES_FILTER === null || SERIES_FILTER === '__standalone__' ? (await r.indexKeys('books', 'standalone')).map(([, id])=> String(id)) : [];
	const ids = [...SERIES_FILTER === '__standalone__' ? [] : inSeries.map(x=> x.id), ...standalone];
	const found = /** @type {Set<string> | null} */ (only);
	return found ? ids.filter(id=> found.has(id)) : ids;
}

/**
 * Read what the page shows again from the stored catalog, once the saves asked for are done (after an
 * edit, or another tab's), keeping as many books shown as there were.
 * @returns {Promise<void>}
 */
export function refreshView(){
	return afterSaving(async ()=>{
		FILTER_CHOICES = await queryCatalog(readFilterChoices);
		populateFilters();
		await loadView(SHOWING);
		drawView();
	});
}

// ------------------------------------------------------------------ the address
// What is shown lives in the address after the #, so a series, a book or a search can be linked to,
// bookmarked and reloaded, and the browser's back and forward buttons step through what you looked at:
//   (nothing)            the series overview      #q=gull&missing     ...searched, only series with gaps
//   #books               all books                #series=<id>, #standalone, #book=<id>
//   &q=...&author=...&genre=...&read=2024 (or read=undated) narrow the books shown.
// A series and a book are named by the id they are stored under, so a link holds when they are renamed;
// an address from before, with a series' name or a book's title, is still understood.

/**
 * What is shown: the view, the series or book shown on its own, and the search and filters.
 * @typedef {object} ViewState
 * @property {'series' | 'library'} view
 * @property {string | null} series a series' id, '__standalone__', or null
 * @property {string | null} book a book's id, or null
 * @property {string} q
 * @property {string} author
 * @property {string} genre
 * @property {string} read a year, UNDATED, or ''
 * @property {boolean} missing only series with gaps
 */

/**
 * What the page shows now, as navigate() and the address take it.
 * @returns {ViewState}
 */
function viewState(){
	const val = (/** @type {string} */ id)=> fieldById(id).value;
	return {view: VIEW, series: SERIES_FILTER, book: BOOK_FILTER, q: val('q').trim(),
		author: val('authorFilter'), genre: val('genreFilter'), read: val('readFilter'), missing: val('missingFilter') === 'missing'};
}

/**
 * A view state -> the address's #... ('' for the plain series overview).
 * @param {Pick<ViewState, 'view' | 'series' | 'book'> & Partial<ViewState>} st the search and filters may be left out
 * @returns {string}
 */
function stateHash(st){
	const enc = (/** @type {string} */ v)=> encodeURIComponent(v).replace(/%20/g, '+');
	/** @type {string[]} */
	const parts = [];
	if(st.view === 'library'){
		if(st.book !== null) parts.push('book=' + enc(st.book));
		else if(st.series === '__standalone__') parts.push('standalone');
		else if(st.series !== null) parts.push('series=' + enc(st.series));
		else parts.push('books');
	}
	if(st.q) parts.push('q=' + enc(st.q));
	if(st.view === 'library'){
		if(st.author) parts.push('author=' + enc(st.author));
		if(st.genre) parts.push('genre=' + enc(st.genre));
		if(st.read) parts.push('read=' + enc(st.read === UNDATED ? 'undated' : st.read));
	} else if(st.missing) parts.push('missing');
	return parts.length ? '#' + parts.join('&') : '';
}

/**
 * The address's #... -> a view state; anything it does not understand is ignored.
 * @param {string | null} hash
 * @returns {ViewState}
 */
function stateFromHash(hash){
	const dec = (/** @type {string} */ v)=>{ try{ return decodeURIComponent(v.replace(/\+/g, ' ')); }catch(e){ return v; } };
	/** @type {Map<string, string | true>} */
	const p = new Map();
	String(hash || '').replace(/^#/, '').split('&').filter(Boolean).forEach(part=>{
		const i = part.indexOf('=');
		if(i < 0) p.set(dec(part), true); else p.set(dec(part.slice(0, i)), dec(part.slice(i + 1)));
	});
	const text = (/** @type {string} */ k)=>{ const v = p.get(k); return typeof v === 'string' ? v.trim() : ''; };
	const bookText = text('book'), seriesText = text('series');
	// by id, or by a title or name as addresses had them before (loadView finds the id then)
	const book = bookText || null;
	const series = book ? null : p.has('standalone') ? '__standalone__' : seriesText ? idFromAddress('series', seriesText) ?? seriesText : null;
	const read = text('read');
	return {view: book || series || p.has('books') ? 'library' : 'series', series, book, q: text('q'),
		author: text('author'), genre: text('genre'), read: read === 'undated' ? UNDATED : read, missing: p.get('missing') === true};
}

/**
 * Show a view state (from navigate() or the address).
 * @param {ViewState} st
 * @returns {Promise<void>} once it is drawn
 */
function applyState(st){
	VIEW = st.view; SERIES_FILTER = st.series; BOOK_FILTER = st.book;
	// st.q is trimmed; leave the box alone when it already says that, or a space being typed is lost
	const box = fieldById('q');
	if(box.value.trim() !== st.q) box.value = st.q;
	fieldById('authorFilter').value = st.author;
	fieldById('genreFilter').value = st.genre;
	fieldById('readFilter').value = st.read;
	fieldById('missingFilter').value = st.missing ? 'missing' : '';
	return showView();
}

/** @type {(st: ViewState) => string} */
const placeOf = st=> [st.view, st.series, st.book].join('\n');

/**
 * @param {'push' | 'replace'} how
 * @param {ViewState} st
 * @param {{search: boolean} | null} [data]
 */
function setAddress(how, st, data){
	const hash = stateHash(st);
	try{ history[how === 'replace' ? 'replaceState' : 'pushState'](data || null, '', hash || location.pathname + (location.search || '')); }catch(e){}
}

/**
 * Change what is shown (`change` is part of a view state) and record it in the address: a new history
 * entry, so Back returns here, unless `how` is 'replace'. Going to another series, book or view closes
 * the forms and starts at the top of the page.
 * @param {Partial<ViewState>} change
 * @param {'push' | 'replace'} [how]
 * @param {{search: boolean} | null} [data]
 */
function navigate(change, how = 'push', data = null){
	const before = viewState();
	const st = {...before, ...change};
	const moved = placeOf(st) !== placeOf(before);
	if(moved){ closeForm(); closeSeriesForm(); }
	applyState(st);
	// compared with the address, not `before`: the search box or a select already holds its new value
	const after = viewState();
	if(how === 'replace' || stateHash(after) !== stateHash(stateFromHash(location.hash))) setAddress(how, after, data);
	if(moved && how !== 'replace' && typeof scrollTo === 'function') scrollTo(0, 0);
}

/** @param {'series' | 'library'} v */
export function setView(v){ navigate({view: v, series: null, book: null}); }
/** @param {string} id the series' */
export function openSeries(id){ navigate({view: 'library', series: id, book: null}); }
/**
 * A book is shown on its own, without the filters, which might hide it.
 * @param {string} id
 */
export function openBook(id){ navigate({view: 'library', series: null, book: id, q: '', author: '', genre: '', read: ''}); }

// Back and forward (and an address typed or pasted in): show what the address says. The browser puts
// the scroll position back itself, as the page is redrawn before this returns.
function showAddress(){
	const st = stateFromHash(location.hash);
	if(stateHash(st) === stateHash(viewState())) return;
	if(placeOf(st) !== placeOf(viewState())){ closeForm(); closeSeriesForm(); }
	applyState(st);
}
addEventListener('popstate', showAddress);
addEventListener('hashchange', showAddress);

// Links to a series or a book (#series=..., #book=...) in the list: a plain click shows it here and
// records it in the history; with a modifier key, or opened from the menu, they work as links.
byId('results').addEventListener('click', e=>{
	const target = /** @type {Element | null} */ (e.target);
	const a = target && target.closest ? target.closest('a[href^="#"]') : null;
	if(!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	e.preventDefault();
	const st = stateFromHash(a.getAttribute('href'));
	if(st.book !== null) openBook(st.book); else navigate({view: st.view, series: st.series, book: null});
});

// A new catalog, with nothing in it yet: where books come from.
function renderEmpty(){
	byId('subtitle').textContent = spell('Your catalog is empty');
	byId('resultCount').textContent = '';
	fillElement(byId('results'), buildElement('p', {class: 'empty'}, 'No books yet. Add one with + Add a book under ', buildElement('a', {href: '#books'}, 'All Books'),
		', import your Audible, Goodreads or Hardcover library on ', buildElement('a', {href: 'import.html'}, 'Import & export'), ', or restore a backup there.'));
}

export function render(){
	homeBookForm();   // out of the list before it is redrawn, which would drop it
	if(!TOTAL_BOOKS && !CATALOG.books.length){ renderEmpty(); return; }
	if(VIEW === 'series'){ renderSeriesOverview(); return; }

	const q = fieldById('q').value.trim();
	const author = fieldById('authorFilter').value;
	const genre = fieldById('genreFilter').value;
	const read = fieldById('readFilter').value;
	const series = shownSeriesName();
	// the books listed and loaded so far (one removed is gone, one edited may not match any more)
	const filtered = /** @type {Book[]} */ (LISTED.slice(0, SHOWING).map(id=> CATALOG.book(id)).filter(b=> b && matches(b, q, author, genre, read, series)));
	const more = LISTED.length - SHOWING;

	byId('subtitle').textContent =
		`${TOTAL_BOOKS} audiobooks, merged from your Audible library and Goodreads history`;
	byId('resultCount').textContent = more > 0 ? `${filtered.length} of ${filtered.length + more} shown` : `${filtered.length} shown`;

	/** @type {Record<string, Book[]>} */
	const groups = {};
	/** @type {Book[]} */
	const standalone = [];
	filtered.forEach(b=>{
		if(b.series){ (groups[b.series] = groups[b.series]||[]).push(b); }
		else standalone.push(b);
	});

	const seriesNames = Object.keys(groups).sort((a,b)=>a.localeCompare(b));
	/** @type {Child[]} */
	const out = [];
	SHARED = sharedEditions();

	if(filtered.length === 0){
		out.push(buildElement('p', {class: 'empty'}, 'No books match. Try clearing a filter.'));
	} else if(BOOK_FILTER !== null){
		fillElement(byId('results'), filtered.map(bookDetails));
		placeBookForm();
		return;
	}

	seriesNames.forEach(name=>{
		const books = groups[name].sort(seriesOrder);
		const info = CATALOG.seriesInfo(name);
		/** @type {string[]} */
		const note = [];
		if(info){
			const missing = seriesMissing(name);
			note.push(`${totalText(info)} released total`);
			if(missing && missing.length) note.push(`missing ${numberList(missing)}`);
			if(info.note) note.push(info.note);
		}
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, buildElement('a', {href: seriesHref(CATALOG.idFor('series', name))}, name), ' ', buildElement('span', {class: 'n'}, ownedText(books)),
				' ', seriesEditButton(CATALOG.idFor('series', name), !!info), info && [' ', statusTag(info.status), info.url && [' ', authorSiteLink(info.url)], seriesLinks(info)],
				// a series shown on its own can be compared with Hardcover
				SERIES_FILTER === CATALOG.idFor('series', name) && [' ', buildElement('a', {class: 'hardcoverCompare', href: hardcoverCompareHref('series', SERIES_FILTER)}, 'Compare with Hardcover')]),
			note.length > 0 && buildElement('p', {class: 'series-note'}, note.join(' \u2014 ')),
			books.map(bookCard)));
	});

	if(standalone.length){
		standalone.sort((x,y)=>x.title.localeCompare(y.title));
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, 'Standalone ', buildElement('span', {class: 'n'}, `${standalone.length} book${standalone.length>1?'s':''}`)),
			standalone.map(bookCard)));
	}
	if(more > 0) out.push(buildElement('p', {class: 'more'}, buildElement('button', {type: 'button', id: 'showMore', onclick: ()=> showMore()},
		`Show ${Math.min(more, PAGE_SIZE)} more`)));

	fillElement(byId('results'), out);
	placeBookForm();
}

/**
 * A series' info, from its record; undefined when it has none.
 * @param {SeriesRecord} rec
 * @returns {Series | undefined}
 */
const seriesInfoOf = rec=> CatalogRecords.hasInfo('series', rec)
	? new Series(rec.name, {total: rec.total, status: rec.status, note: rec.note, url: rec.url, external: rec.external}) : undefined;

function renderSeriesOverview(){
	const q = fieldById('q').value.trim().toLowerCase();
	let rows = OVERVIEW.series.map(rec=> ({rec, info: seriesInfoOf(rec),
		authors: [...new Set(rec.authorIds)].filter(id=> OVERVIEW.authors.has(id))
			.map(id=> ({id, name: /** @type {string} */ (OVERVIEW.authors.get(id))})).sort((x, y)=> x.name.localeCompare(y.name))}))
		.sort((x, y)=> x.rec.name.localeCompare(y.rec.name));
	if(q) rows = rows.filter(({rec, authors})=> [rec.name, ...authors.map(a=> a.name)].join(' ').toLowerCase().includes(q));
	const onlyMissing = fieldById('missingFilter').value === 'missing';
	if(onlyMissing) rows = rows.filter(({rec})=> (rec.missing || []).length);

	byId('subtitle').textContent =
		`${OVERVIEW.series.length} series across ${TOTAL_BOOKS} audiobooks \u2014 tap a series to see its titles`;
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
				buildElement('a', {class: 'srow-title', href: seriesHref(rec.id)}, rec.name), ' ',
				buildElement('span', {class: 'srow-owned'}, `${rec.owned} owned${info ? ' of ' + totalText(info) : ''}`), ' ',
				seriesEditButton(rec.id, !!info)),
			buildElement('div', {class: 'srow-foot'}, buildElement('span', {class: 'tag'},
				joined(authors.map(a=> buildElement('a', {href: creditPageHref('authors', a.id)}, a.name)), ', ')),
				info && [' ', statusTag(info.status), info.url && [' ', authorSiteLink(info.url)], seriesLinks(info)],
				missing && missing.length > 0 && [' ', buildElement('span', {class: 'missing'}, `missing ${numberList(missing)}`)]),
			info && info.note && buildElement('p', {class: 'srow-note'}, info.note)));
	});

	if(showStandalone){
		out.push(buildElement('div', {class: 'srow'}, buildElement('div', {class: 'srow-head'},
			buildElement('a', {class: 'srow-title', href: '#standalone'}, 'Standalone'), ' ',
			buildElement('span', {class: 'srow-owned'}, `${OVERVIEW.standalone} owned`))));
	}

	fillElement(byId('results'), out);
}

// ------------------------------------------------------------------ series info
// Edits the series' entry in CATALOG.series (released total, status, note, author site) and its name,
// which is renamed on every book in the series. Like book edits, it is kept in this browser (see persist).
/**
 * @param {string} id the series'
 * @param {boolean} hasInfo
 * @returns {HTMLButtonElement}
 */
function seriesEditButton(id, hasInfo){
	const label = hasInfo ? 'Edit series info' : 'Add series info';
	return buildElement('button', {class: 'iconbtn sedit', 'data-series': id, title: label, 'aria-label': label, onclick: ()=> openSeriesForm(id)}, '\u270E');
}

/**
 * Open the series info form, once the series and its books are loaded (a rename renames them all).
 * @param {string} id the series'
 * @returns {Promise<void>}
 */
export async function openSeriesForm(id){
	await loadRecords({seriesBooks: [id], series: [id]});
	const name = CATALOG.nameOf('series', id);
	if(name === undefined) return;
	closeForm();
	const info = CATALOG.series.get(id);
	EDIT_SERIES = id; JOIN_SERIES = null;
	fieldById('sf_name').value = name;
	byId('seriesFormTitle').textContent = (info ? 'Series info: ' : 'Add series info: ') + name;
	fieldById('sf_total').value = info ? totalText(info) : '';
	fieldById('sf_status').value = info ? String(info.toJSON().status ?? '') : 'ongoing';
	fieldById('sf_note').value = info ? info.note || '' : '';
	fieldById('sf_url').value = info ? info.url || '' : '';
	fillExternalFields('sf_ext_', 'series', info ? info.external : {});
	byId('seriesFormError').textContent = '';
	byId('seriesRemoveBtn').style.display = info ? '' : 'none';
	const form = byId('seriesForm');
	form.classList.add('open');
	form.scrollIntoView({behavior:'smooth', block:'center'});
}

function closeSeriesForm(){
	EDIT_SERIES = null; JOIN_SERIES = null;
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
	const url = fieldById('sf_url').value.trim();
	const had = CATALOG.series.get(id);
	const external = readExternalFields('sf_ext_', 'series', had ? had.external : {});
	if(external.bad.length) return showError(`Not an id or address there: ${external.bad.join('; ')}.`);
	// a rename of a series without info doesn't have to add some
	const keepInfo = !renamed || CATALOG.series.has(id) || totalTyped || note || url || Object.keys(external.ids).length;
	/** @type {Series | null} */
	let entry = null;
	if(keepInfo){
		// unchecked as typed: the Check below says what is wrong with the total or status
		/** @type {Record<string, unknown>} */
		const typed = {total: /^\d+$/.test(totalTyped) ? parseInt(totalTyped, 10) : totalTyped.toLowerCase(),
			status: fieldById('sf_status').value, note};
		if(url) typed.url = url;
		if(Object.keys(external.ids).length) typed.ext = ExternalCatalog.order(external.ids);
		// the same rules as Check, applied to just this series (checked before the rename,
		// under the name its books have now)
		const {errors} = Validator.validate(JSON.parse(JSON.stringify(CATALOG.books)), {[name]: typed});
		const problems = errors.filter(e=> e.startsWith('series-info')).map(e=> e.replace(/^series-info(\[[^\]]*\])?: /, ''));
		if(problems.length) return showError(problems.join('; '));
		entry = Series.fromJSON(newName, typed);
	}
	// Joining another series is easy to do by mistake (and replaces its info), so the first Save says so.
	// the series it would join, with its books, which move into it with these
	if(renamed) await loadRecords({seriesNamed: [newName]});
	if(EDIT_SERIES !== id) return;
	const exists = CATALOG.books.some(b=> b.series === newName) || !!CATALOG.seriesInfo(newName);
	if(renamed && exists && JOIN_SERIES !== newName){
		JOIN_SERIES = newName;
		return showError(`There is already a series called ${newName}. Press Save again to move these books into it` +
			(entry && CATALOG.seriesInfo(newName) ? '; its series info will be replaced by this.' : '.'));
	}

	// renamed on its books and in its info, keeping the id it is stored under (or taking the id of the one it joins)
	const count = renamed ? CATALOG.renameSeries(name, newName) : 0;
	const newId = CATALOG.idFor('series', newName);
	if(entry) CATALOG.series.set(newId, entry);
	closeSeriesForm();
	// the series shown keeps showing, under its new name
	if(SERIES_FILTER === id && newId !== id) navigate({series: newId}, 'replace');
	else showView();
	persist();
	showIoStatus((renamed
		? `Renamed ${name} to ${newName} on ${Text.plural(count, 'book')}.`
		: `Saved series info for ${name}.`) + (hardcover.note ? ' ' + hardcover.note : ''));
}

function removeSeriesInfo(){
	const id = EDIT_SERIES, name = id === null ? undefined : CATALOG.nameOf('series', id);
	if(id === null || name === undefined || !CATALOG.series.has(id)) return;
	CATALOG.series.delete(id);
	closeSeriesForm(); render(); persist(); refreshView();
	showIoStatus(`Removed series info for ${name}.`);
}

byId('seriesForm').addEventListener('submit', e=>{ e.preventDefault(); return saveSeriesForm(); });
byId('seriesRemoveBtn').addEventListener('click', removeSeriesInfo);
byId('cancelSeries').addEventListener('click', closeSeriesForm);

// Edition object -> the other books it is also on (a box set), for the books being shown.
/** @type {Map<Edition, Book[]>} */
let SHARED = new Map();

/** @returns {Map<Edition, Book[]>} */
function sharedEditions(){
	/** @type {Map<string, [Book, Edition][]>} */
	const byKey = new Map();
	/** @type {(ed: Edition) => string[]} */
	const keys = ed=> [...ed.idKeys(), ...ed.isbns().map(x=> 'isbn ' + x)];
	CATALOG.books.forEach(b=> b.editions.forEach(ed=> keys(ed).forEach(k=>{
		let list = byKey.get(k);
		if(!list) byKey.set(k, list = []);
		list.push([b, ed]);
	})));
	/** @type {Map<Edition, Book[]>} */
	const shared = new Map();
	CATALOG.books.forEach(b=> b.editions.forEach(ed=>{
		/** @type {Set<Book>} */
		const others = new Set();
		for(const k of keys(ed)) for(const [other, x] of byKey.get(k) || []) if(other !== b && x.sameAs(ed)) others.add(other);
		if(others.size) shared.set(ed, [...others]);
	}));
	return shared;
}

/**
 * An id, linking to its page in its external catalog (ExternalCatalog.url); just the id when there is none.
 * @type {(catalog: string, kind: 'book' | 'edition', id: string) => Child}
 */
const idLink = (catalog, kind, id)=>{
	const url = ExternalCatalog.url(catalog, kind, id);
	return url ? buildElement('a', {href: url, target: '_blank', rel: 'noopener'}, id) : id;
};

/**
 * An edition's parts as a details list's rows (Edition.parts()), with each ASIN linking to the book on its
 * site, and its other external ids to the book there (Hardcover's links by id keep working when it renames
 * the book); its description heads it instead.
 * @param {Edition} ed
 * @returns {[string, Child][]}
 */
function editionRows(ed){
	const asins = ()=> joined(ed.asinList().map(([site, asin])=> [site + ' ', idLink(site, 'edition', asin)]), ', ');
	return ed.parts().filter(([k])=> k !== 'desc').map(([k, label, value])=> [label, k === 'asin' ? asins() : k === 'n' ? narratorLinks(ed.narrators)
		: k === 'p' ? buildElement('a', {href: publisherPageHref(value)}, value) : k.startsWith('ext:') ? idLink(k.slice(4), 'edition', value) : value]);
}

/**
 * A details list (dl) of the rows that have a value.
 * @param {[string, Child | false | undefined][]} rows
 * @returns {HTMLElement}
 */
function detailList(rows){
	return buildElement('dl', {class: 'details'}, rows.filter(([, value])=> value).map(([label, value])=> [buildElement('dt', {}, label), buildElement('dd', {}, value)]));
}

/**
 * The address of a book shown on its own.
 * @param {Book} b
 * @returns {string}
 */
function bookHref(b){
	return stateHash({view: 'library', series: null, book: b.id || null});
}

/**
 * The address of a series' books.
 * @param {string} id the series'
 * @returns {string}
 */
function seriesHref(id){
	return stateHash({view: 'library', series: id, book: null});
}

/**
 * The narrators of all of a book's editions, each edition's together ("Ann Vale, Bo Reed / Cy Hale").
 * @param {Book} b
 * @returns {Child}
 */
function bookNarrators(b){
	const narrators = [...new Map(b.editions.filter(ed=> ed.narrators.length).map(ed=> [Text.namesText(ed.narrators), ed.narrators])).values()];
	return narrators.length > 0 && ['narr. ', joined(narrators.map(narratorLinks), ' / ')];
}

/**
 * A book's edit, merge and remove buttons.
 * @param {string} id the book's
 * @returns {HTMLDivElement}
 */
function bookActions(id){
	const picked = MERGE_FROM === id, from = CATALOG.book(MERGE_FROM);
	const mergeLabel = picked ? 'Cancel merge' : !from ? 'Merge with another book' : `Merge with ${from.title}`;
	return buildElement('div', {class: 'book-actions'},
		buildElement('button', {class: 'iconbtn edit', 'data-id': id, title: 'Edit', 'aria-label': 'Edit', onclick: ()=> openEditForm(id)}, '✎'), ' ',
		buildElement('button', {class: 'iconbtn merge', 'data-id': id, title: mergeLabel, 'aria-label': mergeLabel, onclick: ()=> pickMergeBook(id)}, '⇄'), ' ',
		buildElement('button', {class: 'iconbtn del', 'data-id': id, title: 'Remove', 'aria-label': 'Remove', onclick: removeBookClick}, '×'));
}

/**
 * A book in the list: only what tells it apart (its title, authors, narrators and when it was read); its
 * title links to its details (bookDetails).
 * @param {Book} b
 * @returns {HTMLDivElement}
 */
function bookCard(b){
	const id = /** @type {string} */ (b.id);
	return buildElement('div', {class: 'book' + (MERGE_FROM === id ? ' picked' : ''), 'data-id': id},
		buildElement('div', {class: 'num'}, b.number || '•'),
		buildElement('div', {class: 'info'},
			buildElement('div', {class: 'title'}, buildElement('a', {href: bookHref(b)}, b.title)),
			buildElement('div', {class: 'meta'}, joined([authorLinks(b.authors), bookNarrators(b)].filter(Boolean), ' — ')),
			b.read.length > 0 && buildElement('div', {class: 'read'}, 'Read ' + b.read.join(', '))),
		bookActions(id));
}

/**
 * A book shown on its own (#book=<id>): everything about it, with each edition's parts.
 * @param {Book} b
 * @returns {HTMLDivElement}
 */
function bookDetails(b){
	const id = /** @type {string} */ (b.id);
	const series = b.series && CATALOG.idFor('series', b.series);
	const editions = b.editions.map((ed, i)=>{
		const also = (SHARED.get(ed) || []).map(other=>
			buildElement('a', {href: bookHref(other)}, other.title + (other.number ? ` #${other.number}` : '')));
		return buildElement('div', {class: 'edition'},
			buildElement('h3', {}, b.editions.length > 1 ? `Edition ${i + 1}` : 'Edition', ed.description && ': ' + ed.description),
			detailList([...editionRows(ed), ['Also in this edition', also.length > 0 && joined(also, ', ')]]));
	});
	return buildElement('div', {class: 'book book-details' + (MERGE_FROM === id ? ' picked' : ''), 'data-id': id},
		buildElement('div', {class: 'num'}, b.number || '•'),
		buildElement('div', {class: 'info'},
			buildElement('h2', {class: 'title'}, b.title),
			buildElement('div', {class: 'meta'}, joined([authorLinks(b.authors), bookNarrators(b)].filter(Boolean), ' — ')),
			detailList([
				['Series', series && [buildElement('a', {href: seriesHref(series)}, b.series), b.number && ` #${b.number}`]],
				['Read', b.read.length > 0 && b.read.join(', ')],
				['Genres', b.genres.length > 0 && buildElement('span', {class: 'genres'}, b.genres.map(g=> buildElement('span', {class: 'tag'}, g)))],
				...Object.entries(ExternalCatalog.order(b.external) || {}).map(([key, value])=>
					/** @type {[string, Child]} */ ([`${ExternalCatalog.name(key)} book`, idLink(key, 'book', value)]))]),
			editions),
		bookActions(id));
}

/**
 * A book's remove button: the first press asks for a second one, which removes the book (its data-id).
 * @param {Event} e
 */
function removeBookClick(e){
	const el = /** @type {HTMLElement & {_resetTimer?: ReturnType<typeof setTimeout>}} */ (e.currentTarget);
	const id = el.dataset.id;
	if(el.dataset.confirm === '1'){
		const i = CATALOG.books.findIndex(b=> b.id === id);
		if(i < 0) return;
		const [removed] = CATALOG.books.splice(i,1);
		addExclusions(removed.exclusionEntries());   // so the next import does not bring it back
		if(EDIT_ID === id) closeForm();
		render(); persist(); refreshView();
		showIoStatus(`Removed ${removed.title}; imports will skip it.`);
	} else {
		el.dataset.confirm = '1';
		el.textContent = '\u2713';
		el.title = 'Click again to confirm removal';
		el.style.color = '#b0453f';
		clearTimeout(el._resetTimer);
		el._resetTimer = setTimeout(()=>{
			el.dataset.confirm = '';
			el.textContent = '\u00D7';
			el.title = 'Remove';
			el.style.color = '';
		}, 3000);
	}
}

// Typing a search is one step back, however many letters it took: the first change of the search
// adds a history entry, the rest of the typing updates it.
byId('q').addEventListener('input', ()=>{
	const typing = !!(history.state && history.state.search);
	navigate({}, typing ? 'replace' : 'push', {search: true});
});
const FILTERS = ['authorFilter', 'genreFilter', 'readFilter', 'missingFilter'];
FILTERS.forEach(id=> byId(id).addEventListener('change', ()=>{ showFilterCount(); navigate({}); }));

// On a phone the filters fold away behind a button (styles.css), which says how many are on.
function showFilterCount(){
	const on = FILTERS.filter(id=> fieldById(id).style.display !== 'none' && fieldById(id).value).length;
	byId('filtersBtn').textContent = on ? `Filters · ${on}` : 'Filters';
}
byId('filtersBtn').addEventListener('click', ()=>{
	const open = byId('controls').classList.toggle('filtersOpen');
	byId('filtersBtn').setAttribute('aria-expanded', String(open));
});
byId('btnSeriesView').addEventListener('click', ()=> setView('series'));
byId('btnLibraryView').addEventListener('click', ()=> setView('library'));
byId('backToSeries').addEventListener('click', ()=> setView('series'));
byId('toggleAdd').addEventListener('click', ()=>{
	const form = byId('addForm');
	if(form.classList.contains('open') && EDIT_ID === null){
		closeForm();
	} else {
		closeSeriesForm();
		EDIT_ID = null;
		byId('formTitle').textContent = 'Add a book';
		byId('formSaveBtn').textContent = 'Add book';
		byId('formError').textContent = '';
		/** @type {HTMLFormElement} */ (form).reset();
		setFormEditions([], null);
		const {series, authors} = newBookDefaults();
		fieldById('f_s').value = series;
		fieldById('f_a').value = authors.join(', ');
		placeBookForm();
		form.classList.add('open');
	}
});
byId('cancelAdd').addEventListener('click', closeForm);

/**
 * What a new book starts with, from what the list shows: the series shown, and the author picked in the
 * author filter, else the authors every book of the series shown has (its co-authors on some books left out).
 * @returns {{series: string, authors: string[]}}
 */
function newBookDefaults(){
	const series = shownSeriesName() || '';
	const author = fieldById('authorFilter').value;
	if(author) return {series, authors: [author]};
	const books = series ? CATALOG.books.filter(b=> b.series === series) : [];
	const authors = books.length ? books[0].authors.filter(a=> books.every(b=> b.authors.includes(a))) : [];
	return {series, authors};
}

// Today in the viewer's time zone, as YYYY-MM-DD.
export function today(){
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

byId('readTodayBtn').addEventListener('click', ()=>{
	const input = fieldById('f_r');
	const current = input.value.trim();
	if(current.split(/[,;]/).map(x=>x.trim()).includes(today())) return;
	input.value = current ? current.replace(/[,;\s]*$/, '') + ', ' + today() : today();
});

function closeForm(){
	EDIT_ID = null;
	byId('formError').textContent = '';
	byId('addForm').classList.remove('open');
	/** @type {HTMLFormElement} */ (byId('addForm')).reset();
	setFormEditions([], null);
	placeBookForm();
}

// The book form, kept in a variable as it is out of the page while the list is redrawn.
const BOOK_FORM = byId('addForm');
// Its own place, under the toolbar, where a new book is added.
function homeBookForm(){ byId('seriesForm').before(BOOK_FORM); }

/**
 * Put the book form where it belongs: in place of the card of the book being edited, so the book is
 * edited where it is in the list, else (adding a book, or the edited book not shown) under the toolbar.
 */
function placeBookForm(){
	document.querySelectorAll('#results .book.editing').forEach(card=> card.classList.remove('editing'));
	const card = EDIT_ID === null ? null : document.querySelector(`#results .book[data-id="${EDIT_ID}"]`);
	if(!card){ homeBookForm(); return; }
	card.classList.add('editing');
	card.after(BOOK_FORM);
}

/** @param {string} id the book's */
export function openEditForm(id){
	const b = CATALOG.book(id);
	if(!b) return;
	closeSeriesForm();
	EDIT_ID = id;
	fieldById('f_t').value = b.title;
	fieldById('f_a').value = b.authors.join(', ');
	fieldById('f_g').value = b.genres.join(', ');
	fieldById('f_hcb').value = b.idOn('hardcover') || '';
	fillExternalFields('f_ext_', 'book', b.external);
	fieldById('f_s').value = b.series || '';
	fieldById('f_sn').value = b.number || '';
	fieldById('f_r').value = b.read.join(', ');
	setFormEditions(b.editions, id);
	byId('formError').textContent = '';
	byId('formTitle').textContent = 'Edit book';
	byId('formSaveBtn').textContent = 'Save changes';
	placeBookForm();
	byId('addForm').classList.add('open');
	byId('addForm').scrollIntoView({behavior:'smooth', block:'center'});
}

// The book form's editions: a card per edition with a field for each part, kept in FORM_EDITIONS as
// the fields' text ({fields, also}) and read back only on Save, so a half-typed value is never lost
// to a redraw. `also` names the other books an edition is on (a box set), as editing it edits it there,
// and `id` is the id the edition is stored under, which it keeps when edited.
/** @type {{fields: Record<string, string>, also: string[], id?: string}[]} */
export let FORM_EDITIONS = [];

/**
 * @param {Edition[]} editions
 * @param {string | null} id the book they are of, or null for a new book
 */
function setFormEditions(editions, id){
	const others = CATALOG.books.filter(b=> id === null || b.id !== id);
	FORM_EDITIONS = editions.map(ed=> ({
		fields: ed.fields(),
		also: others.filter(b=> b.editions.some(x=> x.sameAs(ed))).map(b=> b.title),
		id: ed.id,
	}));
	if(!FORM_EDITIONS.length) FORM_EDITIONS.push({fields: {}, also: []});
	renderFormEditions();
}

/** @type {Record<string, string>} */
const EDITION_HINTS = {desc: 'e.g. UK edition', n: 'e.g. Ann Vale, Bo Reed', asin: 'B0… or its address', isbn: '978…', p: 'e.g. Gullwing Audio',
	d: 'e.g. 2021-05', len: 'e.g. 10h 42m'};
/** @type {(catalog: string) => string} the hint in a catalog's id field: "id or goodreads.com address" */
const externalHint = catalog=> `id or ${(ExternalCatalog.url(catalog, 'edition', '0') || catalog).replace(/^https?:\/\/(www\.)?/, '').split('/')[0]} address`;
// The catalogs other than Audible's and Amazon's sites that an edition can have an id in: Goodreads' and
// Hardcover's fields are always there, the others' only once the edition has one or one is picked from a list.
const OTHER_EDITION_CATALOGS = ExternalCatalog.forKind('edition').filter(def=> def.family !== 'asin').map(def=> def.key);
const USUAL_EDITION_CATALOGS = ['goodreads', 'hardcover'];

/**
 * An edition's fields for its ids in catalogs other than Audible and Amazon, and a list to add one for another.
 * @param {Record<string, string>} fields
 * @param {number} i the edition's card
 * @returns {HTMLDivElement[]}
 */
function otherCatalogFields(fields, i){
	const shown = OTHER_EDITION_CATALOGS.filter(catalog=> USUAL_EDITION_CATALOGS.includes(catalog) || ('ext:' + catalog) in fields);
	const more = OTHER_EDITION_CATALOGS.filter(catalog=> !shown.includes(catalog));
	return [
		...shown.map(catalog=> buildElement('div', {class: `ef-ext ef-${catalog}`}, buildElement('label', {}, Edition.fieldLabel(catalog)),
			buildElement('input', {'data-i': i, 'data-k': 'ext:' + catalog, value: fields['ext:' + catalog] || '', placeholder: externalHint(catalog)}))),
		...more.length ? [buildElement('div', {class: 'ef-ext ef-more'}, buildElement('label', {}, '\u00A0'),
			buildElement('select', {'data-add-site': i, 'aria-label': 'Add an id in another catalog'},
				buildElement('option', {value: ''}, '+ Another catalog'), more.map(catalog=> buildElement('option', {value: catalog}, ExternalCatalog.name(catalog)))))] : [],
	];
}

// An edition's ASINs: a field for each site it has one on (audible.com's always, as an ASIN usually is),
// and a list to add a field for another site, so the card only shows the sites in use.
const DEFAULT_ASIN_SITE = ExternalCatalog.AUDIBLE_SITE;
/** @type {(fields: Record<string, string>) => string[]} */
const asinSitesOf = fields=> [DEFAULT_ASIN_SITE, ...Object.keys(fields).filter(k=> k.startsWith('ext:') && ExternalCatalog.family(k.slice(4)) === 'asin').map(k=> k.slice(4))]
	.filter((site, j, all)=> all.indexOf(site) === j);

/**
 * @param {Record<string, string>} fields
 * @param {number} i the edition's card
 * @returns {HTMLDivElement[]}
 */
function asinFields(fields, i){
	const sites = asinSitesOf(fields);
	const more = ExternalCatalog.ASIN_SITES.filter(site=> !sites.includes(site));
	return [
		...sites.map(site=> buildElement('div', {class: 'ef-site'}, buildElement('label', {}, site),
			buildElement('input', {'data-i': i, 'data-k': 'ext:' + site, value: fields['ext:' + site] || '', placeholder: EDITION_HINTS.asin}))),
		...more.length ? [buildElement('div', {class: 'ef-site'}, buildElement('label', {}, '\u00A0'),
			buildElement('select', {'data-add-site': i, 'aria-label': 'Add an ASIN for another site'},
				buildElement('option', {value: ''}, '+ Another site'), more.map(site=> buildElement('option', {value: site}, site))))] : [],
	];
}

function renderFormEditions(){
	fillElement(byId('f_editions'), FORM_EDITIONS.map(({fields, also}, i)=>
		buildElement('div', {class: 'editionCard', role: 'group', 'aria-label': `Edition ${i + 1}`},
			buildElement('div', {class: 'editionCardHead'}, buildElement('span', {}, `Edition ${i + 1}`),
				buildElement('button', {type: 'button', class: 'removeEdition', 'data-remove': i, title: 'Remove this edition'}, 'Remove')),
			also.length > 0 && buildElement('p', {class: 'editionAlso'}, `Also on ${also.join(', ')}: changes here change it there too.`),
			buildElement('div', {class: 'editionFields'}, Edition.FIELDS.map(([k, , label])=> k === 'ext'
				? [buildElement('div', {class: 'ef-asin', role: 'group', 'aria-label': label}, buildElement('label', {}, label), buildElement('div', {class: 'asinSites'}, asinFields(fields, i))),
					otherCatalogFields(fields, i)]
				: buildElement('div', {class: `ef-${k}`}, buildElement('label', {}, label),
					buildElement('input', {'data-i': i, 'data-k': k, value: fields[k] || '', placeholder: EDITION_HINTS[k]})))))));
}

const editionsEditor = byId('f_editions');
editionsEditor.addEventListener('input', e=>{
	// the editor holds only <input>s and <select>s
	const target = /** @type {HTMLInputElement} */ (e.target);
	const {i, k} = target.dataset || {};
	if(k && FORM_EDITIONS[Number(i)]) FORM_EDITIONS[Number(i)].fields[k] = target.value;
});
// "+ Another site" (for an ASIN) or "+ Another catalog": a field for it, ready to type in
editionsEditor.addEventListener('change', e=>{
	const target = /** @type {HTMLSelectElement | null} */ (e.target);
	const i = target && target.dataset ? target.dataset.addSite : undefined, site = target ? target.value : '';
	if(i === undefined || !site || !FORM_EDITIONS[Number(i)]) return;
	FORM_EDITIONS[Number(i)].fields['ext:' + site] = FORM_EDITIONS[Number(i)].fields['ext:' + site] || '';
	renderFormEditions();
	const input = editionsEditor.querySelector ? /** @type {HTMLInputElement | null} */ (editionsEditor.querySelector(`input[data-i="${i}"][data-k="ext:${site}"]`)) : null;
	if(input) input.focus();
});
// An address pasted into an id field (an ASIN, Goodreads or Hardcover edition) becomes the id it names
// when the field is left, in the field for it: an Amazon or Audible page's ASIN goes to its site's field,
// which is added when the card has none. When that field holds another id the address stays, and Save says why.
editionsEditor.addEventListener('focusout', e=>{
	const event = /** @type {FocusEvent} */ (e);
	const target = /** @type {HTMLInputElement | null} */ (event.target);
	const {i, k} = target && target.dataset || {};
	const edition = FORM_EDITIONS[Number(i)];
	if(!target || !k || !edition || !k.startsWith('ext:')) return;
	const found = Edition.idFromAddress(target.value);
	if(!found) return;
	const {field, id} = found, there = Text.tidy(edition.fields[field] || '');
	if(field !== k && there && there !== id) return;
	edition.fields[k] = '';
	edition.fields[field] = id;
	if(field === k){ target.value = id; return; }
	target.value = '';
	const input = /** @type {HTMLInputElement | null} */ (editionsEditor.querySelector(`input[data-i="${i}"][data-k="${field}"]`));
	if(input){ input.value = id; return; }
	// a field for the address's site: draw the cards again, and keep the focus where it was going
	const next = /** @type {HTMLElement | null} */ (event.relatedTarget);
	const {i: nextI, k: nextK} = next && next.dataset || {};
	renderFormEditions();
	const refocus = nextK ? /** @type {HTMLElement | null} */ (editionsEditor.querySelector(`[data-i="${nextI}"][data-k="${nextK}"]`)) : null;
	if(refocus) refocus.focus();
});
editionsEditor.addEventListener('click', e=>{
	const target = /** @type {Element | null} */ (e.target);
	// only the edition cards' Remove buttons have data-remove
	const btn = target && target.closest ? /** @type {HTMLElement | null} */ (target.closest('[data-remove]')) : null;
	if(!btn) return;
	FORM_EDITIONS.splice(Number(btn.dataset.remove), 1);
	if(!FORM_EDITIONS.length) FORM_EDITIONS.push({fields: {}, also: []});
	renderFormEditions();
});
byId('addEditionBtn').addEventListener('click', ()=>{
	FORM_EDITIONS.push({fields: {}, also: []});
	renderFormEditions();
	// the new card's first field, its description
	const input = editionsEditor.querySelector ? /** @type {HTMLInputElement | null} */ (editionsEditor.querySelector(`input[data-i="${FORM_EDITIONS.length - 1}"][data-k="desc"]`)) : null;
	if(input) input.focus();
});

/**
 * The editions in the form, as {editions, bad (e.g. "edition 2: Released 2021-13"), book (the book's
 * external ids, from a book's address pasted in an edition's field)}.
 * @returns {{editions: Edition[], bad: string[], book: Record<string, string>}}
 */
function readFormEditions(){
	/** @type {Edition[]} */
	const editions = [];
	/** @type {string[]} */
	const bad = [];
	/** @type {Record<string, string>} */
	const book = {};
	FORM_EDITIONS.forEach(({fields, id}, i)=>{
		const read = Edition.fromFields(fields);
		// the edition keeps its id (several ISBNs make more editions, which are new)
		if(read.editions.length) read.editions[0].id = id;
		editions.push(...read.editions);
		bad.push(...read.bad.map(x=> `edition ${i + 1}: ${x}`));
		for(const [catalog, x] of Object.entries(read.book)) if(!book[catalog]) book[catalog] = x;
	});
	return {editions, bad, book};
}

// The Hardcover book field also takes the address of the book's or an edition's page on hardcover.app (the
// app shows no ids), which Hardcover turns into the book's id. Returns the id, or null when it was not
// found (the form says why); for anything else (an id, nothing, not an address) what was typed.
/** @typedef {Promise<string | null> & {text?: string}} HardcoverLookup a lookup, with the text it looks up */
/** @type {HardcoverLookup | null} */
let HARDCOVER_LOOKUP = null;   // the field's lookup on its way, as a promise
/** @returns {Promise<string | null>} */
function resolveHardcoverField(){
	const field = fieldById('f_hcb'), text = field.value.trim();
	if(!HardcoverClient.parseUrl(text)) return Promise.resolve(text);
	if(HARDCOVER_LOOKUP && HARDCOVER_LOOKUP.text === text) return HARDCOVER_LOOKUP;
	// declared first, as the lookup's own finally compares with it (which runs after an await, once it is assigned)
	/** @type {HardcoverLookup | null} */
	let lookup = null;
	lookup = (async ()=>{
		try{
			const found = await lookupHardcoverBook(text);
			if(field.value.trim() === text) field.value = found.id;
			byId('formError').textContent = '';
			if(found.title) showIoStatus(`Found on Hardcover: ${found.title} (book ${found.id}).`);
			return found.id;
		}catch(err){
			byId('formError').textContent = `Couldn't find the Hardcover book: ${Text.errorText(err)}. ` +
				'Paste the address of its page, or of one of its editions, on hardcover.app, or the number in hardcover.app/id/book/12345.';
			return null;
		}finally{
			if(HARDCOVER_LOOKUP === lookup) HARDCOVER_LOOKUP = null;
		}
	})();
	lookup.text = text;
	HARDCOVER_LOOKUP = lookup;
	return lookup;
}
byId('f_hcb').addEventListener('change', ()=>{ resolveHardcoverField(); });
// the book's ids in external catalogs other than Hardcover (whose field looks the book up), and the series'
fillElement(byId('f_bookExt'), externalFields('f_ext_', 'book', ['hardcover']));
fillElement(byId('sf_ext'), externalFields('sf_ext_', 'series'));

byId('addForm').addEventListener('submit', async e=>{
	e.preventDefault();
	if(HardcoverClient.parseUrl(fieldById('f_hcb').value)){
		// look the address up first, unless the form was closed or moved to another book meanwhile
		const editing = EDIT_ID;
		const id = await resolveHardcoverField();
		if(id === null || EDIT_ID !== editing || !byId('addForm').classList.contains('open')) return;
	}
	// the book being edited may have been removed in another tab meanwhile
	const editing = EDIT_ID === null ? null : CATALOG.book(EDIT_ID) || null;
	if(EDIT_ID !== null && !editing){ closeForm(); return; }
	const b = new Book({
		id: editing ? editing.id : undefined,   // an edited book stays the record it was
		title: fieldById('f_t').value.trim(),
		authors: Text.splitNames(fieldById('f_a').value),
		genres: fieldById('f_g').value.split(',').map(x=>x.trim()).filter(Boolean),
	});
	const s = fieldById('f_s').value.trim(); if(s) b.series = s;
	const sn = fieldById('f_sn').value.trim(); if(sn) b.number = sn;
	if(!b.title || !b.authors.length) return;
	const {dates, bad} = Text.parseDates(fieldById('f_r').value);
	if(bad.length){
		byId('formError').textContent =
			`Not a date: ${bad.join(', ')}. Use YYYY-MM-DD, or YYYY-MM / YYYY if you don't remember the day.`;
		return;
	}
	b.read = dates;
	const {editions, bad: badParts, book: fromEditions} = readFormEditions();
	const hardcover = fieldById('f_hcb').value.trim() || fromEditions.hardcover;
	if(hardcover && !ExternalCatalog.isId('hardcover', 'book', hardcover)){
		byId('formError').textContent = `Not a Hardcover book id: ${hardcover}. It is the number in hardcover.app/id/book/12345, or paste the address of the book's page on hardcover.app in the Hardcover book field.`;
		return;
	}
	// the book's other external ids (Goodreads' book), from their fields or a book's address in an edition's
	const had = editing ? editing.external : {};
	const external = readExternalFields('f_ext_', 'book', had);
	if(external.bad.length){
		byId('formError').textContent = `Not a book's id or address there: ${external.bad.join('; ')}.`;
		return;
	}
	b.external = {...fromEditions, ...external.ids};
	delete b.external.hardcover;
	if(hardcover) b.external.hardcover = hardcover;
	// "book #0 ('Title') edition #2: needs an ..." -> "edition #2: needs an ..."
	const problems = (editions.length ? Validator.validate([{t: b.title, a: b.authors, e: JSON.parse(JSON.stringify(editions))}], {}).errors : [])
		.map(e=> e.includes(' edition #') ? e.slice(e.indexOf(' edition #') + 1) : e);
	if(badParts.length || problems.length){
		byId('formError').textContent = badParts.length
			? `Not understood: ${badParts.join('; ')}. A Goodreads or Hardcover id is a number, an ISBN 10 or 13 digits, Released e.g. 2021-05, Length e.g. 10h 42m.`
			: problems.join('; ');
		return;
	}
	b.editions = editions;

	// editing an edition a box set shares with other books edits it there too, so those books are loaded first
	const keys = [...new Set(editions.flatMap(ed=> [...ed.idKeys(), ...ed.isbns().map(x=> 'isbn ' + x)]))];
	if(keys.length) await loadRecords({editionKeys: keys});
	if(EDIT_ID !== null && !CATALOG.book(EDIT_ID)){ closeForm(); return; }
	const others = CATALOG.saveBook(EDIT_ID, b);
	render(); persist(); refreshView();
	closeForm();
	if(others) showIoStatus(`Also updated the shared edition on ${Text.plural(others, 'other book')}.`);
});

// The merge button on a book: the first press picks it, a press on another book opens the two on the
// duplicates page (which checks they are still the same books).
/** @param {string} id the book's */
export function pickMergeBook(id){
	const b = CATALOG.book(id);
	if(!b) return;
	if(MERGE_FROM === null){
		MERGE_FROM = id;
		showIoStatus(`Now press \u21c4 on the book to merge ${b.title} with.`);
	} else if(MERGE_FROM === id){
		MERGE_FROM = null;
	} else {
		const pair = [MERGE_FROM, id].map(encodeURIComponent);
		MERGE_FROM = null;
		location.href = 'duplicates.html#merge=' + pair.join(',');
		return;
	}
	render();
}

/**
 * After a save took in what another tab changed (store.js): the book being edited stays open unless the
 * other tab removed it, and so does the series whose info is being edited.
 * @param {Book[]} before the books as they were
 */
function redraw(before){
	if(EDIT_ID !== null && !CATALOG.book(EDIT_ID)){
		const b = before.find(x=> x.id === EDIT_ID);
		closeForm();
		showIoStatus(spell(`${b ? b.title : 'The book'} was removed in another tab.`), true);
	}
	if(EDIT_SERIES !== null && CATALOG.nameOf('series', EDIT_SERIES) === undefined) closeSeriesForm();
	refreshView();
}

// The view in the address (a link, a bookmark, or Back from another page), once the filters have their options.
export const READY = startPage(async ()=>{
	FILTER_CHOICES = await queryCatalog(readFilterChoices);
	populateFilters();
	const drawn = applyState(stateFromHash(location.hash));
	setAddress('replace', viewState());
	await drawn;
}, {refresh: redraw});
