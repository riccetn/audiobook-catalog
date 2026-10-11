// The catalog page: the series overview, all books, and editing books and series info.
// Loading and saving live in store.js.
import * as CatalogImport from './importers.js';
import { DATA, SERIES_INFO, setSeriesInfo, readDates, esc, persist, addExclusions, showIoStatus, lookupHardcoverBook, startPage, byId, fieldById, spell } from './store.js';
/** @import {Book, Edition, IndexedBook, SeriesEntry} from './importers.js' */

/** @type {'series' | 'library'} */
export let VIEW = 'series';           // 'series' | 'library'
/** @type {string | null} */
export let SERIES_FILTER = null;      // series name, '__standalone__', or null
/** @type {string | null} */
export let BOOK_FILTER = null;        // title of the book linked to (#book=...), or null
/** @type {number | null} */
let EDIT_INDEX = null;         // index into DATA being edited, or null when adding new
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
const readYears = b => readDates(b).map(d => d.slice(0, 4));

/** @param {string[]} arr */
function uniqueSorted(arr){ return [...new Set(arr)].sort((a,b)=>a.localeCompare(b)); }
/**
 * A book's authors, one name each: the author filter offers each of them on its own.
 * @param {Book} b
 * @returns {string[]}
 */
function authorsOf(b){ return Array.isArray(b.a) ? b.a.filter(x=> typeof x === 'string') : []; }
/**
 * Authors' names, each a link to their page on the authors page.
 * @type {(names: string[]) => string}
 */
const authorLinks = names => names.map(x=> `<a href="authors.html#a=${esc(encodeURIComponent(x).replace(/%20/g, '+'))}">${esc(x)}</a>`).join(', ');

/**
 * Series numbers you don't own yet, from series-info.json's released total; null when that is unknown.
 * @param {string} name
 * @returns {number[] | null}
 */
function seriesMissing(name){
	const info = SERIES_INFO[name];
	return info ? CatalogImport.missingNumbers(DATA.filter(b=> b.s === name), info.total) : null;
}

/**
 * A series' books by number, unnumbered ones first, and its collections (box sets, "1-3") last.
 * @param {Book} a
 * @param {Book} b
 * @returns {number}
 */
function seriesOrder(a, b){
	const last = (/** @type {Book} */ x)=> (CatalogImport.seriesRange(x.sn) || [0, 0])[1];
	return (Number(CatalogImport.isCollection(a)) - Number(CatalogImport.isCollection(b))) ||
		(parseFloat(a.sn || '')||0) - (parseFloat(b.sn || '')||0) || last(a) - last(b);
}

/**
 * "3 owned + 1 box set": a box set kept as its own book is not one more title.
 * @param {Book[]} books
 * @returns {string}
 */
function ownedText(books){
	const sets = books.filter(CatalogImport.isCollection).length;
	return `${CatalogImport.seriesOwned(books)} owned` + (sets ? ` + ${sets} box set${sets > 1 ? 's' : ''}` : '');
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
	const authors = uniqueSorted(DATA.flatMap(authorsOf));
	const genres = uniqueSorted(DATA.flatMap(b=>b.g||[]));
	const aSel = fieldById('authorFilter');
	const gSel = fieldById('genreFilter');
	const rSel = fieldById('readFilter');
	const years = uniqueSorted(DATA.flatMap(readYears)).reverse();
	const aCur = aSel.value, gCur = gSel.value, rCur = rSel.value;
	aSel.innerHTML = '<option value="">All authors</option>' + authors.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('');
	gSel.innerHTML = '<option value="">All genres</option>' + genres.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join('');
	rSel.innerHTML = '<option value="">Read any time</option>' + years.map(y=>`<option value="${esc(y)}">Read in ${esc(y)}</option>`).join('')
		+ `<option value="${UNDATED}">No date read</option>`;
	aSel.value = aCur; gSel.value = gCur; rSel.value = rCur;
	MERGE_FROM = null;             // DATA changed, so an index picked for merging may be stale
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
	if(BOOK_FILTER !== null && b.t !== BOOK_FILTER) return false;
	if(SERIES_FILTER){
		if(SERIES_FILTER === '__standalone__'){ if(b.s) return false; }
		else if(b.s !== SERIES_FILTER) return false;
	}
	if(author && !authorsOf(b).includes(author)) return false;
	if(genre && !(b.g||[]).includes(genre)) return false;
	if(read === UNDATED){ if(readDates(b).length) return false; }
	else if(read && !readYears(b).includes(read)) return false;
	if(q){
		const editions = CatalogImport.bookEditions(b);
		const hay = [b.t,...authorsOf(b),b.s,...(b.g||[]),...editions.flatMap(ed=>[...CatalogImport.editionAsins(ed).map(([, asin])=> asin), ed.gr, ed.hc, CatalogImport.namesText(ed.n), ed.p, ed.desc, ed.isbn]), b.hcb]
			.filter(x=> typeof x === 'string').join(' ').toLowerCase();
		// an ISBN matches however it is typed: with hyphens, or as the ISBN-10 of the same edition
		const isbn = CatalogImport.parseIsbn(q);
		if(!hay.includes(q.toLowerCase()) && !(isbn && CatalogImport.bookIsbns(b).includes(isbn))) return false;
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
	byId('results').innerHTML = '<p class="empty">No books yet. Add one with + Add a book under <a href="#books">All Books</a>, ' +
		'import your Audible, Goodreads or Hardcover library on <a href="import.html">Import &amp; export</a>, or restore a backup there.</p>';
}

export function render(){
	homeBookForm();   // out of the list before it is redrawn, which would drop it
	if(!DATA.length){ renderEmpty(); return; }
	if(VIEW === 'series'){ renderSeriesOverview(); return; }

	const q = fieldById('q').value.trim();
	const author = fieldById('authorFilter').value;
	const genre = fieldById('genreFilter').value;
	const read = fieldById('readFilter').value;
	/** @type {IndexedBook[]} */
	const filtered = DATA.map((b,i)=>({...b, _i:i})).filter(b=>matches(b,q,author,genre,read));

	byId('subtitle').textContent =
		`${DATA.length} audiobooks, merged from your Audible library and Goodreads history`;
	byId('resultCount').textContent = `${filtered.length} shown`;

	/** @type {Record<string, IndexedBook[]>} */
	const groups = {};
	/** @type {IndexedBook[]} */
	const standalone = [];
	filtered.forEach(b=>{
		if(b.s){ (groups[b.s] = groups[b.s]||[]).push(b); }
		else standalone.push(b);
	});

	const seriesNames = Object.keys(groups).sort((a,b)=>a.localeCompare(b));
	let html = '';
	SHARED = sharedEditions();

	if(filtered.length === 0){
		html = '<p class="empty">No books match. Try clearing a filter.</p>';
	}

	seriesNames.forEach(name=>{
		const books = groups[name].sort(seriesOrder);
		const info = SERIES_INFO[name];
		let head = `<p class="series-title"><a href="${esc(bookHref(name, 'series'))}">${esc(name)}</a> <span class="n">${ownedText(books)}</span>`;
		head += ` ${seriesEditButton(name)}`;
		if(info){
			head += ` <span class="status ${info.status}">${info.status === 'complete' ? 'complete' : 'ongoing'}</span>`;
			if(info.url){
				head += ` <a class="authorlink" href="${esc(info.url)}" target="_blank" rel="noopener">author site \u2197</a>`;
			}
		}
		head += '</p>';
		if(info){
			const missing = seriesMissing(name);
			const note = [`${esc(info.total)} released total`];
			if(missing && missing.length) note.push(`missing ${numberList(missing)}`);
			if(info.note) note.push(esc(info.note));
			head += `<p class="series-note">${note.join(' \u2014 ')}</p>`;
		}
		html += `<div class="series-group">${head}`;
		books.forEach(b=> html += bookCard(b));
		html += '</div>';
	});

	if(standalone.length){
		standalone.sort((a,b)=>a.t.localeCompare(b.t));
		html += `<div class="series-group"><p class="series-title">Standalone <span class="n">${standalone.length} book${standalone.length>1?'s':''}</span></p>`;
		standalone.forEach(b=> html += bookCard(b));
		html += '</div>';
	}

	byId('results').innerHTML = html;
	document.querySelectorAll('.iconbtn.del').forEach(btn=>{
		btn.addEventListener('click', e=>{
			const el = /** @type {HTMLElement & {_resetTimer?: ReturnType<typeof setTimeout>}} */ (e.currentTarget);
			const i = parseInt(el.dataset.i || '',10);
			if(el.dataset.confirm === '1'){
				const [removed] = DATA.splice(i,1);
				addExclusions(CatalogImport.exclusionEntries(removed));   // so the next import does not bring it back
				// the book being edited moves up one when a book before it goes, and Save must still find it
				if(EDIT_INDEX === i){ closeForm(); }
				else if(EDIT_INDEX !== null && EDIT_INDEX > i) EDIT_INDEX--;
				populateFilters(); render(); persist();
				showIoStatus(`Removed ${removed.t}; imports will skip it.`);
			} else {
				el.dataset.confirm = '1';
				el.innerHTML = '&check;';
				el.title = 'Click again to confirm removal';
				el.style.color = '#b0453f';
				clearTimeout(el._resetTimer);
				el._resetTimer = setTimeout(()=>{
					el.dataset.confirm = '';
					el.innerHTML = '&times;';
					el.title = 'Remove';
					el.style.color = '';
				}, 3000);
			}
		});
	});
	document.querySelectorAll('.iconbtn.edit').forEach(btn=>{
		btn.addEventListener('click', e=>{
			const i = parseInt(/** @type {HTMLElement} */ (e.currentTarget).dataset.i || '',10);
			openEditForm(i);
		});
	});
	document.querySelectorAll('.iconbtn.merge').forEach(btn=>{
		btn.addEventListener('click', e=> pickMergeBook(parseInt(/** @type {HTMLElement} */ (e.currentTarget).dataset.i || '',10)));
	});
	bindSeriesEditButtons();
	placeBookForm();
}

function renderSeriesOverview(){
	const q = fieldById('q').value.trim().toLowerCase();
	/** @type {Record<string, Book[]>} */
	const groups = {};
	let standaloneCount = 0;
	DATA.forEach(b=>{
		if(b.s){ (groups[b.s] = groups[b.s]||[]).push(b); }
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
		`${Object.keys(groups).length} series across ${DATA.length} audiobooks \u2014 tap a series to see its titles`;
	byId('resultCount').textContent = `${seriesNames.length} series shown`;

	let html = '';
	const showStandalone = !onlyMissing && (!q || 'standalone'.includes(q));
	if(seriesNames.length === 0 && !showStandalone){
		html = onlyMissing ? '<p class="empty">No series with missing books.</p>' : '<p class="empty">No series match your search.</p>';
	}

	seriesNames.forEach(name=>{
		const books = groups[name];
		const authors = uniqueSorted(books.flatMap(authorsOf));
		const info = SERIES_INFO[name];
		html += `<div class="srow"><div class="srow-head">
			<a class="srow-title" href="${esc(stateHash({view: 'library', series: name, book: null}))}">${esc(name)}</a>
			<span class="srow-owned">${CatalogImport.seriesOwned(books)} owned${info ? ' of ' + esc(info.total) : ''}</span>
			${seriesEditButton(name)}
		</div>`;
		let foot = `<div class="srow-foot"><span class="tag">${authorLinks(authors)}</span>`;
		if(info){
			foot += ` <span class="status ${info.status}">${info.status === 'complete' ? 'complete' : 'ongoing'}</span>`;
			if(info.url) foot += ` <a class="authorlink" href="${esc(info.url)}" target="_blank" rel="noopener">author site \u2197</a>`;
		}
		const missing = seriesMissing(name);
		if(missing && missing.length) foot += ` <span class="missing">missing ${numberList(missing)}</span>`;
		foot += '</div>';
		html += foot;
		if(info && info.note) html += `<p class="srow-note">${esc(info.note)}</p>`;
		html += '</div>';
	});

	if(showStandalone){
		html += `<div class="srow"><div class="srow-head">
			<a class="srow-title" href="#standalone">Standalone</a>
			<span class="srow-owned">${standaloneCount} owned</span>
		</div></div>`;
	}

	byId('results').innerHTML = html;
	bindSeriesEditButtons();
}

// ------------------------------------------------------------------ series info
// Edits the series' entry in SERIES_INFO (released total, status, note, author site) and its name,
// which is renamed on every book in the series. Like book edits, it is kept in this browser (see persist).
/** @param {string} name */
function seriesEditButton(name){
	const label = SERIES_INFO[name] ? 'Edit series info' : 'Add series info';
	return `<button class="iconbtn sedit" data-series="${esc(name)}" title="${label}" aria-label="${label}">&#9998;</button>`;
}

function bindSeriesEditButtons(){
	document.querySelectorAll('.iconbtn.sedit').forEach(btn=>{
		btn.addEventListener('click', e=> openSeriesForm(/** @type {HTMLElement} */ (e.currentTarget).dataset.series || ''));
	});
}

/** @param {string} name */
export function openSeriesForm(name){
	closeForm();
	const info = SERIES_INFO[name];
	EDIT_SERIES = name; JOIN_SERIES = null;
	fieldById('sf_name').value = name;
	byId('seriesFormTitle').textContent = (info ? 'Series info: ' : 'Add series info: ') + name;
	fieldById('sf_total').value = info ? String(info.total) : '';
	fieldById('sf_status').value = info ? info.status : 'ongoing';
	fieldById('sf_note').value = info ? info.note || '' : '';
	fieldById('sf_url').value = info ? info.url || '' : '';
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
	const newName = CatalogImport.tidyText(fieldById('sf_name').value);
	if(!newName) return showError('Give the series a name.');
	const renamed = newName !== name;
	const totalText = fieldById('sf_total').value.trim();
	const note = CatalogImport.tidyText(fieldById('sf_note').value);
	const url = fieldById('sf_url').value.trim();
	// a rename of a series without info doesn't have to add some
	const keepInfo = !renamed || SERIES_INFO[name] || totalText || note || url;
	/** @type {SeriesEntry | null} */
	let entry = null;
	if(keepInfo){
		// unchecked as typed: validate() below says what is wrong with the total or status
		entry = /** @type {SeriesEntry} */ ({total: /^\d+$/.test(totalText) ? parseInt(totalText, 10) : totalText.toLowerCase(),
			status: fieldById('sf_status').value, note});
		if(url) entry.url = url;
		// the same rules as Check, applied to just this series (checked before the rename,
		// under the name its books have now)
		const {errors} = CatalogImport.validate(DATA, {[name]: entry});
		const problems = errors.filter(e=> e.startsWith('series-info')).map(e=> e.replace(/^series-info(\[[^\]]*\])?: /, ''));
		if(problems.length) return showError(problems.join('; '));
	}
	// Joining another series is easy to do by mistake (and replaces its info), so the first Save says so.
	const exists = DATA.some(b=> b.s === newName) || newName in SERIES_INFO;
	if(renamed && exists && JOIN_SERIES !== newName){
		JOIN_SERIES = newName;
		return showError(`There is already a series called ${newName}. Press Save again to move these books into it` +
			(entry && SERIES_INFO[newName] ? '; its series info will be replaced by this.' : '.'));
	}

	let count = 0;
	if(renamed) DATA.forEach(b=>{ if(b.s === name){ b.s = newName; count++; } });
	const {[name]: _old, ...rest} = SERIES_INFO;
	setSeriesInfo(entry ? {...rest, [newName]: entry} : rest);
	closeSeriesForm();
	if(renamed && SERIES_FILTER === name) navigate({series: newName}, 'replace');
	render(); persist();
	showIoStatus(renamed
		? `Renamed ${name} to ${newName} on ${count} book${count === 1 ? '' : 's'}.`
		: `Saved series info for ${name}.`);
}

function removeSeriesInfo(){
	const name = EDIT_SERIES;
	if(name === null || !SERIES_INFO[name]) return;
	const {[name]: _removed, ...rest} = SERIES_INFO;
	setSeriesInfo(rest);
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
	const keys = ed=> [...CatalogImport.editionAsins(ed).map(([, asin])=> 'asin ' + asin), ...(/** @type {('gr' | 'hc')[]} */ (['gr','hc'])).filter(k=> ed[k]).map(k=> k + ' ' + ed[k]),
		...CatalogImport.editionIsbns(ed).map(x=> 'isbn ' + x)];
	DATA.forEach((b,i)=> CatalogImport.bookEditions(b).forEach(ed=> keys(ed).forEach(k=>{
		let list = byKey.get(k);
		if(!list) byKey.set(k, list = []);
		list.push([i, ed]);
	})));
	/** @type {Map<Edition, number[]>} */
	const shared = new Map();
	DATA.forEach((b,i)=> CatalogImport.bookEditions(b).forEach(ed=>{
		/** @type {Set<number>} */
		const others = new Set();
		for(const k of keys(ed)) for(const [j, x] of byKey.get(k) || []) if(j !== i && CatalogImport.sameEdition(x, ed)) others.add(j);
		if(others.size) shared.set(ed, [...others]);
	}));
	return shared;
}

const GOODREADS_URL = 'https://www.goodreads.com/book/show/';

/**
 * An ASIN's page on its site: audible.co.uk/pd/B0X, amazon.com/dp/B0X.
 * @type {(site: string) => string}
 */
const asinUrl = site=> `https://www.${site}/${site.startsWith('audible.') ? 'pd' : 'dp'}/`;

/**
 * An edition as formatEdition() writes it, with each ASIN linking to the book on its site, and the
 * Goodreads id and Hardcover ids to the book there (Hardcover's links by id keep working when it renames the book).
 * @type {(url: string, id: string) => string}
 */
const idLink = (url, id)=> `<a href="${esc(url + encodeURIComponent(id))}" target="_blank" rel="noopener">${esc(id)}</a>`;

/**
 * @param {Edition} ed
 * @returns {string}
 */
function editionHtml(ed){
	/** @type {Partial<Record<keyof Edition, string>>} */
	const urls = {gr: GOODREADS_URL, hc: CatalogImport.hardcoverUrl('edition', '')};
	const asins = ()=> CatalogImport.editionAsins(ed).map(([site, asin])=> `${esc(site)} ${idLink(asinUrl(site), asin)}`).join(', ');
	return CatalogImport.editionParts(ed).map(([k, label, value])=>{
		const url = urls[k];
		return (label ? esc(label) + ' ' : '') + (k === 'asin' ? asins() : url ? idLink(url, value) : esc(value));
	}).join('; ');
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
 * @param {IndexedBook} b
 * @returns {string}
 */
function bookCard(b){
	const num = b.sn ? `<div class="num">${esc(b.sn)}</div>` : '<div class="num">&bull;</div>';
	// the narrators of all its editions ("Ann Vale, Bo Reed / Cy Hale"); each edition line names its own only when they differ
	const narrators = [...new Set(CatalogImport.bookEditions(b).map(ed=> CatalogImport.namesText(ed.n)).filter(Boolean))];
	const differ = narrators.length > 1;
	const meta = [authorLinks(authorsOf(b)), narrators.length ? esc('narr. '+narrators.join(' / ')) : null].filter(Boolean).join(' \u2014 ');
	const genres = (b.g||[]).map(g=>`<span class="tag">${esc(g)}</span>`).join('');
	const read = readDates(b).length ? `<div class="read">Read ${esc(readDates(b).join(', '))}</div>` : '';
	const editions = CatalogImport.bookEditions(b).map(ed=>{
		const also = (SHARED.get(ed) || []).map(k=>
			`<a href="${esc(bookHref(DATA[k].t))}">${esc(DATA[k].t + (DATA[k].sn ? ` #${DATA[k].sn}` : ''))}</a>`);
		return `<div class="edition">${editionHtml(differ ? ed : {...ed, n: undefined})}` +
			(also.length ? `<br><span class="also">Also in this edition: ${also.join(', ')}</span>` : '') + '</div>';
	}).join('');
	const picked = MERGE_FROM === b._i;
	const mergeLabel = picked ? 'Cancel merge' : MERGE_FROM === null ? 'Merge with another book' : `Merge with ${DATA[MERGE_FROM].t}`;
	return `<div class="book${picked ? ' picked' : ''}" data-i="${b._i}">${num}<div class="info">
		<div class="title"><a href="${esc(bookHref(b.t))}">${esc(b.t)}</a></div>
		<div class="meta">${meta}</div>
		${read}
		${b.hcb ? `<div class="ids">Hardcover book ${idLink(CatalogImport.hardcoverUrl('book', ''), b.hcb)}</div>` : ''}
		${editions}
		${genres ? `<div class="genres">${genres}</div>` : ''}
	</div><div class="book-actions">
		<button class="iconbtn edit" data-i="${b._i}" title="Edit" aria-label="Edit">&#9998;</button>
		<button class="iconbtn merge" data-i="${b._i}" title="${esc(mergeLabel)}" aria-label="${esc(mergeLabel)}">&#8644;</button>
		<button class="iconbtn del" data-i="${b._i}" title="Remove" aria-label="Remove">&times;</button>
	</div></div>`;
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
		placeBookForm();
		form.classList.add('open');
	}
});
byId('cancelAdd').addEventListener('click', closeForm);

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
	const b = DATA[i];
	closeSeriesForm();
	EDIT_INDEX = i;
	fieldById('f_t').value = b.t || '';
	fieldById('f_a').value = authorsOf(b).join(', ');
	fieldById('f_g').value = (b.g||[]).join(', ');
	fieldById('f_hcb').value = b.hcb || '';
	fieldById('f_s').value = b.s || '';
	fieldById('f_sn').value = b.sn || '';
	fieldById('f_r').value = readDates(b).join(', ');
	setFormEditions(CatalogImport.bookEditions(b), i);
	byId('formError').textContent = '';
	byId('formTitle').textContent = 'Edit book';
	byId('formSaveBtn').textContent = 'Save changes';
	placeBookForm();
	byId('addForm').classList.add('open');
	byId('addForm').scrollIntoView({behavior:'smooth', block:'center'});
}

// The book form's editions: a card per edition with a field for each part, kept in FORM_EDITIONS as
// the fields' text ({fields, also}) and read back only on Save, so a half-typed value is never lost
// to a redraw. `also` names the other books an edition is on (a box set), as editing it edits it there.
/** @type {{fields: Record<string, string>, also: string[]}[]} */
export let FORM_EDITIONS = [];

/**
 * @param {Edition[]} editions
 * @param {number | null} index the book they are of, or null for a new book
 */
function setFormEditions(editions, index){
	const others = DATA.map((b, k)=> k).filter(k=> k !== index);
	FORM_EDITIONS = editions.map(ed=> ({
		fields: CatalogImport.editionFields(ed),
		also: others.filter(k=> CatalogImport.bookEditions(DATA[k]).some(x=> CatalogImport.sameEdition(x, ed))).map(k=> DATA[k].t),
	}));
	if(!FORM_EDITIONS.length) FORM_EDITIONS.push({fields: {}, also: []});
	renderFormEditions();
}

/** @type {Record<string, string>} */
const EDITION_HINTS = {desc: 'e.g. UK edition', n: 'e.g. Ann Vale, Bo Reed', asin: 'B0…', gr: 'e.g. 4242',
	hc: 'id or hardcover.app address', isbn: '978…', p: 'e.g. Gullwing Audio', d: 'e.g. 2021-05', len: 'e.g. 10h 42m'};

// An edition's ASINs: a field for each site it has one on (audible.com's always, as an ASIN usually is),
// and a list to add a field for another site, so the card only shows the sites in use.
const DEFAULT_ASIN_SITE = 'audible.com';
/** @type {(fields: Record<string, string>) => string[]} */
const asinSitesOf = fields=> [DEFAULT_ASIN_SITE, ...Object.keys(fields).filter(k=> k.startsWith('asin:')).map(k=> k.slice(5))]
	.filter((site, j, all)=> all.indexOf(site) === j);

/**
 * @param {Record<string, string>} fields
 * @param {number} i the edition's card
 * @returns {string}
 */
function asinFieldsHtml(fields, i){
	const sites = asinSitesOf(fields);
	const more = CatalogImport.ASIN_SITES.filter(site=> !sites.includes(site));
	return sites.map(site=> `<div class="ef-site"><label>${esc(site)}</label>` +
			`<input data-i="${i}" data-k="asin:${esc(site)}" value="${esc(fields['asin:' + site] || '')}" placeholder="${esc(EDITION_HINTS.asin)}"></div>`).join('') +
		(more.length ? `<div class="ef-site"><label>&nbsp;</label><select data-add-site="${i}" aria-label="Add an ASIN for another site">` +
			'<option value="">+ Another site</option>' + more.map(site=> `<option value="${esc(site)}">${esc(site)}</option>`).join('') +
			'</select></div>' : '');
}

function renderFormEditions(){
	byId('f_editions').innerHTML = FORM_EDITIONS.map(({fields, also}, i)=>
		`<div class="editionCard" role="group" aria-label="Edition ${i + 1}"><div class="editionCardHead"><span>Edition ${i + 1}</span>` +
		`<button type="button" class="removeEdition" data-remove="${i}" title="Remove this edition">Remove</button></div>` +
		(also.length ? `<p class="editionAlso">Also on ${also.map(esc).join(', ')}: changes here change it there too.</p>` : '') +
		'<div class="editionFields">' + CatalogImport.EDITION_FIELDS.map(([k, , label])=> k === 'asin'
			? `<div class="ef-asin" role="group" aria-label="${label}"><label>${label}</label><div class="asinSites">${asinFieldsHtml(fields, i)}</div></div>`
			: `<div class="ef-${k}"><label>${label}</label><input data-i="${i}" data-k="${k}" value="${esc(fields[k] || '')}" placeholder="${esc(EDITION_HINTS[k])}"></div>`
		).join('') + '</div></div>'
	).join('');
}

const editionsEditor = byId('f_editions');
editionsEditor.addEventListener('input', e=>{
	// the editor holds only <input>s and <select>s
	const target = /** @type {HTMLInputElement} */ (e.target);
	const {i, k} = target.dataset || {};
	if(k && FORM_EDITIONS[Number(i)]) FORM_EDITIONS[Number(i)].fields[k] = target.value;
});
// "+ ASIN on another site": a field for that site, ready to type in
editionsEditor.addEventListener('change', e=>{
	const target = /** @type {HTMLSelectElement | null} */ (e.target);
	const i = target && target.dataset ? target.dataset.addSite : undefined, site = target ? target.value : '';
	if(i === undefined || !site || !FORM_EDITIONS[Number(i)]) return;
	FORM_EDITIONS[Number(i)].fields['asin:' + site] = FORM_EDITIONS[Number(i)].fields['asin:' + site] || '';
	renderFormEditions();
	const input = editionsEditor.querySelector ? /** @type {HTMLInputElement | null} */ (editionsEditor.querySelector(`input[data-i="${i}"][data-k="asin:${site}"]`)) : null;
	if(input) input.focus();
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
 * The editions in the form, as {editions, bad (e.g. "edition 2: Released 2021-13"), hcb}.
 * @returns {{editions: Edition[], bad: string[], hcb: string | null}}
 */
function readFormEditions(){
	/** @type {Edition[]} */
	const editions = [];
	/** @type {string[]} */
	const bad = [];
	/** @type {string | null} */
	let hcb = null;
	FORM_EDITIONS.forEach(({fields}, i)=>{
		const read = CatalogImport.editionFromFields(fields);
		editions.push(...read.editions);
		bad.push(...read.bad.map(x=> `edition ${i + 1}: ${x}`));
		hcb = hcb || read.hcb;
	});
	return {editions, bad, hcb};
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
	if(!CatalogImport.parseHardcoverUrl(text)) return Promise.resolve(text);
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
			byId('formError').textContent = `Couldn't find the Hardcover book: ${CatalogImport.errorText(err)}. ` +
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

byId('addForm').addEventListener('submit', async e=>{
	e.preventDefault();
	if(CatalogImport.parseHardcoverUrl(fieldById('f_hcb').value)){
		// look the address up first, unless the form was closed or moved to another book meanwhile
		const index = EDIT_INDEX;
		const id = await resolveHardcoverField();
		if(id === null || EDIT_INDEX !== index || !byId('addForm').classList.contains('open')) return;
	}
	/** @type {Book} */
	const b = {
		t: fieldById('f_t').value.trim(),
		a: CatalogImport.splitNames(fieldById('f_a').value),
	};
	const s = fieldById('f_s').value.trim(); if(s) b.s = s;
	const sn = fieldById('f_sn').value.trim(); if(sn) b.sn = sn;
	const g = fieldById('f_g').value.trim();
	if(g) b.g = g.split(',').map(x=>x.trim()).filter(Boolean);
	if(!b.t || !b.a.length) return;
	const {dates, bad} = CatalogImport.parseReadDates(fieldById('f_r').value);
	if(bad.length){
		byId('formError').textContent =
			`Not a date: ${bad.join(', ')}. Use YYYY-MM-DD, or YYYY-MM / YYYY if you don't remember the day.`;
		return;
	}
	if(dates.length) b.r = dates;
	const {editions, bad: badParts, hcb} = readFormEditions();
	const hardcover = fieldById('f_hcb').value.trim() || hcb;
	if(hardcover && !/^\d+$/.test(hardcover)){
		byId('formError').textContent = `Not a Hardcover book id: ${hardcover}. It is the number in hardcover.app/id/book/12345, or paste the address of the book's page on hardcover.app in the Hardcover book field.`;
		return;
	}
	if(hardcover) b.hcb = hardcover;
	// "book #0 ('Title') edition #2: needs an ..." -> "edition #2: needs an ..."
	const problems = (editions.length ? CatalogImport.validate([{t: b.t, a: b.a, e: editions}], {}).errors : [])
		.map(e=> e.includes(' edition #') ? e.slice(e.indexOf(' edition #') + 1) : e);
	if(badParts.length || problems.length){
		byId('formError').textContent = badParts.length
			? `Not understood: ${badParts.join('; ')}. A Goodreads or Hardcover id is a number, an ISBN 10 or 13 digits, Released e.g. 2021-05, Length e.g. 10h 42m.`
			: problems.join('; ');
		return;
	}
	if(editions.length) b.e = editions;

	// editing an edition a box set shares with other books edits it there too
	const others = CatalogImport.saveBook(DATA, EDIT_INDEX, b);
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
		showIoStatus(`Now press \u21c4 on the book to merge ${DATA[i].t} with.`);
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

// After a save to disk tidied the books (store.js).
// The view in the address (a link, a bookmark, or Back from another page), once the filters have their options.
export const READY = startPage(()=>{ populateFilters(); applyState(stateFromHash(location.hash)); setAddress('replace', viewState()); });
