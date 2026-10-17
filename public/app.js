// The catalog page: the series overview, all books, and editing books and series info.
// Loading and saving live in store.js.
import {Text} from './modules/text.js';
import {Isbn} from './modules/isbn.js';
import {Edition} from './modules/edition.js';
import {Book} from './modules/book.js';
import {Series} from './modules/series.js';
import {Validator} from './modules/validator.js';
import {HardcoverClient} from './modules/hardcover-client.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import { CATALOG, persist, addExclusions, showIoStatus, lookupHardcoverBook, startPage, byId, fieldById, spell, buildElement, fillElement, joined, authorPageHref, narratorPageHref, publisherPageHref,
	externalFields, fillExternalFields, readExternalFields, externalLinks } from './store.js';
/** @import {Child} from './store.js' */

/** @typedef {{b: Book, i: number}} ListedBook a book shown, with its index in CATALOG.books */

/** @type {'series' | 'library'} */
export let VIEW = 'series';           // 'series' | 'library'
/** @type {string | null} */
export let SERIES_FILTER = null;      // series name, '__standalone__', or null
/** @type {string | null} */
export let BOOK_FILTER = null;        // title of the book linked to (#book=...), or null
/** @type {number | null} */
export let EDIT_INDEX = null;         // index into CATALOG.books being edited, or null when adding new
/** @type {string | null} */
let EDIT_SERIES = null;        // name of the series whose info is being edited, or null
/** @type {string | null} */
let JOIN_SERIES = null;        // the existing series a rename was asked to join, once Save was pressed for it
/** @type {number | null} */
let MERGE_FROM = null;         // index of the first book picked with its merge button, or null

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
 * A book's authors, one name each: the author filter offers each of them on its own.
 * @param {Book} b
 * @returns {string[]}
 */
function authorsOf(b){ return b.authors; }
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

function populateFilters(){
	const authors = uniqueSorted(CATALOG.books.flatMap(authorsOf));
	const genres = uniqueSorted(CATALOG.books.flatMap(b=>b.genres));
	const aSel = fieldById('authorFilter');
	const gSel = fieldById('genreFilter');
	const rSel = fieldById('readFilter');
	const years = uniqueSorted(CATALOG.books.flatMap(readYears)).reverse();
	const aCur = aSel.value, gCur = gSel.value, rCur = rSel.value;
	/** @type {(value: string, text: string) => HTMLOptionElement} */
	const option = (value, text)=> buildElement('option', {value}, text);
	fillElement(aSel, option('', 'All authors'), authors.map(a=> option(a, a)));
	fillElement(gSel, option('', 'All genres'), genres.map(g=> option(g, g)));
	fillElement(rSel, option('', 'Read any time'), years.map(y=> option(y, `Read in ${y}`)), option(UNDATED, 'No date read'));
	aSel.value = aCur; gSel.value = gCur; rSel.value = rCur;
	MERGE_FROM = null;             // the books changed, so an index picked for merging may be stale
}

/**
 * @param {Book} b
 * @param {string} q
 * @param {string} author
 * @param {string} genre
 * @param {string} read
 * @returns {boolean}
 */
function matches(b, q, author, genre, read){
	if(BOOK_FILTER !== null && b.title !== BOOK_FILTER) return false;
	if(SERIES_FILTER){
		if(SERIES_FILTER === '__standalone__'){ if(b.series) return false; }
		else if(b.series !== SERIES_FILTER) return false;
	}
	if(author && !authorsOf(b).includes(author)) return false;
	if(genre && !b.genres.includes(genre)) return false;
	if(read === UNDATED){ if(b.read.length) return false; }
	else if(read && !readYears(b).includes(read)) return false;
	if(q){
		const hay = [b.title,...authorsOf(b),b.series,...b.genres,...b.editions.flatMap(ed=>[...ed.externalList().map(([, id])=> id),
			Text.namesText(ed.narrators), ed.publisher, ed.description, ed.isbn]), ...Object.values(b.external)]
			.filter(x=> typeof x === 'string').join(' ').toLowerCase();
		// an ISBN matches however it is typed: with hyphens, or as the ISBN-10 of the same edition
		const isbn = Isbn.parse(q);
		if(!hay.includes(q.toLowerCase()) && !(isbn && b.isbns().includes(isbn))) return false;
	}
	return true;
}

// Show VIEW with SERIES_FILTER / BOOK_FILTER and the filters as they are; navigate() is how they change.
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
	const crumb = byId('crumb');
	const label = v !== 'library' ? null : BOOK_FILTER !== null ? BOOK_FILTER
		: SERIES_FILTER === '__standalone__' ? 'Standalone books' : SERIES_FILTER;
	crumb.classList.toggle('show', !!label);
	byId('crumbLabel').textContent = label || '';
	document.title = (label ? label + ' — ' : v === 'library' ? 'All books — ' : '') + spell('Audiobook Catalog');
	render();
}

// ------------------------------------------------------------------ the address
// What is shown lives in the address after the #, so a series, a book or a search can be linked to,
// bookmarked and reloaded, and the browser's back and forward buttons step through what you looked at:
//   (nothing)            the series overview      #q=gull&missing     ...searched, only series with gaps
//   #books               all books                #series=The+Gull+Saga, #standalone, #book=Ember+Road
//   &q=...&author=...&genre=...&read=2024 (or read=undated) narrow the books shown.

/**
 * What is shown: the view, the series or book shown on its own, and the search and filters.
 * @typedef {object} ViewState
 * @property {'series' | 'library'} view
 * @property {string | null} series a series name, '__standalone__', or null
 * @property {string | null} book a book's title, or null
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
	const book = text('book') || null;
	const series = book ? null : p.has('standalone') ? '__standalone__' : text('series') || null;
	const read = text('read');
	return {view: book || series || p.has('books') ? 'library' : 'series', series, book, q: text('q'),
		author: text('author'), genre: text('genre'), read: read === 'undated' ? UNDATED : read, missing: p.get('missing') === true};
}

/**
 * Show a view state (from navigate() or the address).
 * @param {ViewState} st
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
	showView();
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
/** @param {string} name */
export function openSeries(name){ navigate({view: 'library', series: name, book: null}); }
/**
 * A book is shown on its own, without the filters, which might hide it.
 * @param {string} title
 */
function openBook(title){ navigate({view: 'library', series: null, book: title, q: '', author: '', genre: '', read: ''}); }

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
	if(!CATALOG.books.length){ renderEmpty(); return; }
	if(VIEW === 'series'){ renderSeriesOverview(); return; }

	const q = fieldById('q').value.trim();
	const author = fieldById('authorFilter').value;
	const genre = fieldById('genreFilter').value;
	const read = fieldById('readFilter').value;
	/** @type {ListedBook[]} */
	const filtered = CATALOG.books.map((b,i)=>({b, i})).filter(({b})=>matches(b,q,author,genre,read));

	byId('subtitle').textContent =
		`${CATALOG.books.length} audiobooks, merged from your Audible library and Goodreads history`;
	byId('resultCount').textContent = `${filtered.length} shown`;

	/** @type {Record<string, ListedBook[]>} */
	const groups = {};
	/** @type {ListedBook[]} */
	const standalone = [];
	filtered.forEach(x=>{
		if(x.b.series){ (groups[x.b.series] = groups[x.b.series]||[]).push(x); }
		else standalone.push(x);
	});

	const seriesNames = Object.keys(groups).sort((a,b)=>a.localeCompare(b));
	/** @type {Child[]} */
	const out = [];
	SHARED = sharedEditions();

	if(filtered.length === 0){
		out.push(buildElement('p', {class: 'empty'}, 'No books match. Try clearing a filter.'));
	}

	seriesNames.forEach(name=>{
		const books = groups[name].sort((x, y)=> seriesOrder(x.b, y.b));
		const info = CATALOG.series.get(name);
		/** @type {string[]} */
		const note = [];
		if(info){
			const missing = seriesMissing(name);
			note.push(`${totalText(info)} released total`);
			if(missing && missing.length) note.push(`missing ${numberList(missing)}`);
			if(info.note) note.push(info.note);
		}
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, buildElement('a', {href: bookHref(name, 'series')}, name), ' ', buildElement('span', {class: 'n'}, ownedText(books.map(x=> x.b))),
				' ', seriesEditButton(name), info && [' ', statusTag(info.status), info.url && [' ', authorSiteLink(info.url)], seriesLinks(info)]),
			note.length > 0 && buildElement('p', {class: 'series-note'}, note.join(' \u2014 ')),
			books.map(bookCard)));
	});

	if(standalone.length){
		standalone.sort((x,y)=>x.b.title.localeCompare(y.b.title));
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, 'Standalone ', buildElement('span', {class: 'n'}, `${standalone.length} book${standalone.length>1?'s':''}`)),
			standalone.map(bookCard)));
	}

	fillElement(byId('results'), out);
	placeBookForm();
}

function renderSeriesOverview(){
	const q = fieldById('q').value.trim().toLowerCase();
	/** @type {Record<string, Book[]>} */
	const groups = {};
	let standaloneCount = 0;
	CATALOG.books.forEach(b=>{
		if(b.series){ (groups[b.series] = groups[b.series]||[]).push(b); }
		else standaloneCount++;
	});

	let seriesNames = Object.keys(groups).sort((a,b)=>a.localeCompare(b));
	if(q){
		seriesNames = seriesNames.filter(name=>{
			const books = groups[name];
			const hay = [name, ...books.flatMap(authorsOf)].join(' ').toLowerCase();
			return hay.includes(q);
		});
	}
	const onlyMissing = fieldById('missingFilter').value === 'missing';
	if(onlyMissing) seriesNames = seriesNames.filter(name=> (seriesMissing(name) || []).length);

	byId('subtitle').textContent =
		`${Object.keys(groups).length} series across ${CATALOG.books.length} audiobooks \u2014 tap a series to see its titles`;
	byId('resultCount').textContent = `${seriesNames.length} series shown`;

	/** @type {Child[]} */
	const out = [];
	const showStandalone = !onlyMissing && (!q || 'standalone'.includes(q));
	if(seriesNames.length === 0 && !showStandalone){
		out.push(buildElement('p', {class: 'empty'}, onlyMissing ? 'No series with missing books.' : 'No series match your search.'));
	}

	seriesNames.forEach(name=>{
		const books = groups[name];
		const authors = uniqueSorted(books.flatMap(authorsOf));
		const info = CATALOG.series.get(name);
		const missing = seriesMissing(name);
		out.push(buildElement('div', {class: 'srow'},
			buildElement('div', {class: 'srow-head'},
				buildElement('a', {class: 'srow-title', href: stateHash({view: 'library', series: name, book: null})}, name), ' ',
				buildElement('span', {class: 'srow-owned'}, `${Series.owned(books)} owned${info ? ' of ' + totalText(info) : ''}`), ' ',
				seriesEditButton(name)),
			buildElement('div', {class: 'srow-foot'}, buildElement('span', {class: 'tag'}, authorLinks(authors)),
				info && [' ', statusTag(info.status), info.url && [' ', authorSiteLink(info.url)], seriesLinks(info)],
				missing && missing.length > 0 && [' ', buildElement('span', {class: 'missing'}, `missing ${numberList(missing)}`)]),
			info && info.note && buildElement('p', {class: 'srow-note'}, info.note)));
	});

	if(showStandalone){
		out.push(buildElement('div', {class: 'srow'}, buildElement('div', {class: 'srow-head'},
			buildElement('a', {class: 'srow-title', href: '#standalone'}, 'Standalone'), ' ',
			buildElement('span', {class: 'srow-owned'}, `${standaloneCount} owned`))));
	}

	fillElement(byId('results'), out);
}

// ------------------------------------------------------------------ series info
// Edits the series' entry in CATALOG.series (released total, status, note, author site) and its name,
// which is renamed on every book in the series. Like book edits, it is kept in this browser (see persist).
/**
 * @param {string} name
 * @returns {HTMLButtonElement}
 */
function seriesEditButton(name){
	const label = CATALOG.series.has(name) ? 'Edit series info' : 'Add series info';
	return buildElement('button', {class: 'iconbtn sedit', 'data-series': name, title: label, 'aria-label': label, onclick: ()=> openSeriesForm(name)}, '\u270E');
}

/** @param {string} name */
export function openSeriesForm(name){
	closeForm();
	const info = CATALOG.series.get(name);
	EDIT_SERIES = name; JOIN_SERIES = null;
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

function saveSeriesForm(){
	const name = EDIT_SERIES;
	if(name === null) return;
	const showError = (/** @type {string} */ text)=> { byId('seriesFormError').textContent = text; };
	const newName = Text.tidy(fieldById('sf_name').value);
	if(!newName) return showError('Give the series a name.');
	const renamed = newName !== name;
	const totalTyped = fieldById('sf_total').value.trim();
	const note = Text.tidy(fieldById('sf_note').value);
	const url = fieldById('sf_url').value.trim();
	const had = CATALOG.series.get(name);
	const external = readExternalFields('sf_ext_', 'series', had ? had.external : {});
	if(external.bad.length) return showError(`Not an id or address there: ${external.bad.join('; ')}.`);
	// a rename of a series without info doesn't have to add some
	const keepInfo = !renamed || CATALOG.series.has(name) || totalTyped || note || url || Object.keys(external.ids).length;
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
	const exists = CATALOG.books.some(b=> b.series === newName) || CATALOG.series.has(newName);
	if(renamed && exists && JOIN_SERIES !== newName){
		JOIN_SERIES = newName;
		return showError(`There is already a series called ${newName}. Press Save again to move these books into it` +
			(entry && CATALOG.series.has(newName) ? '; its series info will be replaced by this.' : '.'));
	}

	// renamed on its books and in its info, keeping the id it is stored under
	const count = renamed ? CATALOG.renameSeries(name, newName) : 0;
	if(entry) CATALOG.series.set(newName, entry);
	closeSeriesForm();
	if(renamed && SERIES_FILTER === name) navigate({series: newName}, 'replace');
	render(); persist();
	showIoStatus(renamed
		? `Renamed ${name} to ${newName} on ${count} book${count === 1 ? '' : 's'}.`
		: `Saved series info for ${name}.`);
}

function removeSeriesInfo(){
	const name = EDIT_SERIES;
	if(name === null || !CATALOG.series.has(name)) return;
	CATALOG.series.delete(name);
	closeSeriesForm(); render(); persist();
	showIoStatus(`Removed series info for ${name}.`);
}

byId('seriesForm').addEventListener('submit', e=>{ e.preventDefault(); saveSeriesForm(); });
byId('seriesRemoveBtn').addEventListener('click', removeSeriesInfo);
byId('cancelSeries').addEventListener('click', closeSeriesForm);

// Edition object -> indexes of the other books it is also on (a box set), for the books being shown.
/** @type {Map<Edition, number[]>} */
let SHARED = new Map();

/** @returns {Map<Edition, number[]>} */
function sharedEditions(){
	/** @type {Map<string, [number, Edition][]>} */
	const byKey = new Map();
	/** @type {(ed: Edition) => string[]} */
	const keys = ed=> [...ed.idKeys(), ...ed.isbns().map(x=> 'isbn ' + x)];
	CATALOG.books.forEach((b,i)=> b.editions.forEach(ed=> keys(ed).forEach(k=>{
		let list = byKey.get(k);
		if(!list) byKey.set(k, list = []);
		list.push([i, ed]);
	})));
	/** @type {Map<Edition, number[]>} */
	const shared = new Map();
	CATALOG.books.forEach((b,i)=> b.editions.forEach(ed=>{
		/** @type {Set<number>} */
		const others = new Set();
		for(const k of keys(ed)) for(const [j, x] of byKey.get(k) || []) if(j !== i && x.sameAs(ed)) others.add(j);
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
 * An edition as Edition.format() writes it, with each ASIN linking to the book on its site, and its other
 * external ids to the book there (Hardcover's links by id keep working when it renames the book).
 * @param {Edition} ed
 * @param {boolean} narrators whether to name its narrators (not when the book's line names them all)
 * @returns {Child[]}
 */
function editionParts(ed, narrators){
	const asins = ()=> joined(ed.asinList().map(([site, asin])=> [site + ' ', idLink(site, 'edition', asin)]), ', ');
	return joined(ed.parts().filter(([k])=> narrators || k !== 'n').map(([k, label, value])=>{
		const shown = k === 'asin' ? asins() : k === 'n' ? narratorLinks(ed.narrators)
			: k === 'p' ? buildElement('a', {href: publisherPageHref(value)}, value) : k.startsWith('ext:') ? idLink(k.slice(4), 'edition', value) : value;
		return [label ? label + ' ' : '', shown];
	}), '; ');
}

/**
 * The address of a book (or, with kind 'series', a series) shown on its own.
 * @param {string} name
 * @param {'book' | 'series'} [kind]
 * @returns {string}
 */
function bookHref(name, kind = 'book'){
	return stateHash({view: 'library', series: kind === 'series' ? name : null, book: kind === 'book' ? name : null});
}

/**
 * @param {ListedBook} listed
 * @returns {HTMLDivElement}
 */
function bookCard({b, i}){
	const books = CATALOG.books;
	// the narrators of all its editions ("Ann Vale, Bo Reed / Cy Hale"); each edition line names its own only when they differ
	const narrators = [...new Map(b.editions.filter(ed=> ed.narrators.length).map(ed=> [Text.namesText(ed.narrators), ed.narrators])).values()];
	const differ = narrators.length > 1;
	const meta = joined([authorLinks(authorsOf(b)), narrators.length > 0 && ['narr. ', joined(narrators.map(narratorLinks), ' / ')]].filter(Boolean), ' \u2014 ');
	const editions = b.editions.map(ed=>{
		const also = (SHARED.get(ed) || []).map(k=>
			buildElement('a', {href: bookHref(books[k].title)}, books[k].title + (books[k].number ? ` #${books[k].number}` : '')));
		return buildElement('div', {class: 'edition'}, editionParts(ed, differ),
			also.length > 0 && [buildElement('br'), buildElement('span', {class: 'also'}, 'Also in this edition: ', joined(also, ', '))]);
	});
	const picked = MERGE_FROM === i;
	const mergeLabel = picked ? 'Cancel merge' : MERGE_FROM === null ? 'Merge with another book' : `Merge with ${books[MERGE_FROM].title}`;
	return buildElement('div', {class: 'book' + (picked ? ' picked' : ''), 'data-i': i},
		buildElement('div', {class: 'num'}, b.number || '\u2022'),
		buildElement('div', {class: 'info'},
			buildElement('div', {class: 'title'}, buildElement('a', {href: bookHref(b.title)}, b.title)),
			buildElement('div', {class: 'meta'}, meta),
			b.read.length > 0 && buildElement('div', {class: 'read'}, 'Read ' + b.read.join(', ')),
			Object.keys(b.external).length > 0 && buildElement('div', {class: 'ids'},
				joined(Object.entries(ExternalCatalog.order(b.external) || {}).map(([key, id])=> [`${ExternalCatalog.name(key)} book `, idLink(key, 'book', id)]), '; ')),
			editions,
			b.genres.length > 0 && buildElement('div', {class: 'genres'}, b.genres.map(g=> buildElement('span', {class: 'tag'}, g)))),
		buildElement('div', {class: 'book-actions'},
			buildElement('button', {class: 'iconbtn edit', 'data-i': i, title: 'Edit', 'aria-label': 'Edit', onclick: ()=> openEditForm(i)}, '\u270E'), ' ',
			buildElement('button', {class: 'iconbtn merge', 'data-i': i, title: mergeLabel, 'aria-label': mergeLabel, onclick: ()=> pickMergeBook(i)}, '\u21C4'), ' ',
			buildElement('button', {class: 'iconbtn del', 'data-i': i, title: 'Remove', 'aria-label': 'Remove', onclick: removeBookClick}, '\u00D7')));
}

/**
 * A book's remove button: the first press asks for a second one, which removes the book (its data-i).
 * @param {Event} e
 */
function removeBookClick(e){
	const el = /** @type {HTMLElement & {_resetTimer?: ReturnType<typeof setTimeout>}} */ (e.currentTarget);
	const i = parseInt(el.dataset.i || '',10);
	if(el.dataset.confirm === '1'){
		const [removed] = CATALOG.books.splice(i,1);
		addExclusions(removed.exclusionEntries());   // so the next import does not bring it back
		// the book being edited moves up one when a book before it goes, and Save must still find it
		if(EDIT_INDEX === i){ closeForm(); }
		else if(EDIT_INDEX !== null && EDIT_INDEX > i) EDIT_INDEX--;
		populateFilters(); render(); persist();
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
['authorFilter', 'genreFilter', 'readFilter', 'missingFilter'].forEach(id=>
	byId(id).addEventListener('change', ()=> navigate({})));
byId('btnSeriesView').addEventListener('click', ()=> setView('series'));
byId('btnLibraryView').addEventListener('click', ()=> setView('library'));
byId('backToSeries').addEventListener('click', ()=> setView('series'));
byId('toggleAdd').addEventListener('click', ()=>{
	const form = byId('addForm');
	if(form.classList.contains('open') && EDIT_INDEX === null){
		closeForm();
	} else {
		closeSeriesForm();
		EDIT_INDEX = null;
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
export function newBookDefaults(){
	const series = SERIES_FILTER && SERIES_FILTER !== '__standalone__' ? SERIES_FILTER : '';
	const author = fieldById('authorFilter').value;
	if(author) return {series, authors: [author]};
	const books = series ? CATALOG.books.filter(b=> b.series === series) : [];
	const authors = books.length ? authorsOf(books[0]).filter(a=> books.every(b=> authorsOf(b).includes(a))) : [];
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
	EDIT_INDEX = null;
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
	const card = EDIT_INDEX === null ? null : document.querySelector(`#results .book[data-i="${EDIT_INDEX}"]`);
	if(!card){ homeBookForm(); return; }
	card.classList.add('editing');
	card.after(BOOK_FORM);
}

/** @param {number} i */
export function openEditForm(i){
	const b = CATALOG.books[i];
	closeSeriesForm();
	EDIT_INDEX = i;
	fieldById('f_t').value = b.title;
	fieldById('f_a').value = authorsOf(b).join(', ');
	fieldById('f_g').value = b.genres.join(', ');
	fieldById('f_hcb').value = b.idOn('hardcover') || '';
	fillExternalFields('f_ext_', 'book', b.external);
	fieldById('f_s').value = b.series || '';
	fieldById('f_sn').value = b.number || '';
	fieldById('f_r').value = b.read.join(', ');
	setFormEditions(b.editions, i);
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
 * @param {number | null} index the book they are of, or null for a new book
 */
function setFormEditions(editions, index){
	const books = CATALOG.books;
	const others = books.map((b, k)=> k).filter(k=> k !== index);
	FORM_EDITIONS = editions.map(ed=> ({
		fields: ed.fields(),
		also: others.filter(k=> books[k].editions.some(x=> x.sameAs(ed))).map(k=> books[k].title),
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
		const index = EDIT_INDEX;
		const id = await resolveHardcoverField();
		if(id === null || EDIT_INDEX !== index || !byId('addForm').classList.contains('open')) return;
	}
	const b = new Book({
		id: EDIT_INDEX === null ? undefined : CATALOG.books[EDIT_INDEX].id,   // an edited book stays the record it was
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
	const had = EDIT_INDEX === null ? {} : CATALOG.books[EDIT_INDEX].external;
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

	// editing an edition a box set shares with other books edits it there too
	const others = CATALOG.saveBook(EDIT_INDEX, b);
	populateFilters(); render(); persist();
	closeForm();
	if(others) showIoStatus(`Also updated the shared edition on ${others} other book${others === 1 ? '' : 's'}.`);
});

// The merge button on a book: the first press picks it, a press on another book opens the two on the
// duplicates page (which checks they are still the same books).
/** @param {number} i */
export function pickMergeBook(i){
	if(MERGE_FROM === null){
		MERGE_FROM = i;
		showIoStatus(`Now press \u21c4 on the book to merge ${CATALOG.books[i].title} with.`);
	} else if(MERGE_FROM === i){
		MERGE_FROM = null;
	} else {
		const pair = [MERGE_FROM, i].sort((x, y)=> x - y);
		MERGE_FROM = null;
		location.href = 'duplicates.html#merge=' + pair.join(',');
		return;
	}
	render();
}

/**
 * After a save took in what another tab changed (store.js): the book being edited is found again by its id,
 * as the other tab may have removed books before it, or the book itself.
 * @param {Book[]} before the books as they were
 */
function redraw(before){
	if(EDIT_INDEX !== null){
		const b = before[EDIT_INDEX], i = CATALOG.books.findIndex(x=> x.id === b.id);
		if(i >= 0) EDIT_INDEX = i;
		else { closeForm(); showIoStatus(spell(`${b.title} was removed in another tab.`), true); }
	}
	populateFilters(); render();
}

// The view in the address (a link, a bookmark, or Back from another page), once the filters have their options.
export const READY = startPage(()=>{ populateFilters(); applyState(stateFromHash(location.hash)); setAddress('replace', viewState()); }, {refresh: redraw});
