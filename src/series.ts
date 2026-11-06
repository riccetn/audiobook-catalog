// The series page (index.html): every series, and a series' own page (its books, and editing or removing it).
// The book cards and lists are book-list.ts's; loading and saving live in store.ts.
import {Series} from './modules/series.js';
import {CatalogRecords} from './modules/catalog-records.js';
import type {SeriesRecord} from './modules/catalog-records.js';
import type {CatalogReader} from './modules/catalog-database.js';
import {
	CATALOG,
	loadRecords,
	queryCatalog,
	afterSaving,
	startPage,
	byId,
	fieldById,
	spell,
	buildElement,
	fillElement,
	joined,
	creditPageHref,
	idFromAddress,
	seriesPageHref,
	standalonePageHref,
	editPageHref,
} from './store.js';
import type {Child} from './store.js';
import {
	BookList,
	STANDALONE,
	bookGroups,
	readOrdered,
	statusTag,
	seriesLinks,
	totalText,
	watchCoversBox,
	showEmptyCatalog,
	showBackupNudge,
	hashParts,
	hashText,
	hashOf,
	setAddress,
	watchSearchAndFilters,
} from './book-list.js';

// Series are known by the ids they are stored under, so a series renamed (here or in another tab) is still the one shown.
export let SERIES_FILTER: string | null = null; // the id of the series shown, STANDALONE, or null for every series

// The page holds only what it shows, read from the stored catalog by loadView(): every series' row, or the
// books of the series shown.
/**
 * The series' rows: every series (with books or not), the names of their authors, and how many books are in no series.
 */
export type Overview = {series: SeriesRecord[]; authors: Map<string, string>; standalone: number};
let OVERVIEW: Overview = {series: [], authors: new Map(), standalone: 0};
const LIST = new BookList(() => true);
export let TOTAL_BOOKS = 0;

/** @returns the name of the series SERIES_FILTER shows, if it shows one */
function shownSeriesName(): string | null {
	return SERIES_FILTER === null || SERIES_FILTER === STANDALONE
		? null
		: (CATALOG.nameOf('series', SERIES_FILTER) ?? null);
}

/**
 * Show what SERIES_FILTER and the search say, once the saves asked for are done and it is read.
 * @returns once it is drawn
 */
function showView(): Promise<void> {
	// a series shown on its own has nothing to search
	byId('controls').style.display = SERIES_FILTER === null ? '' : 'none';
	showFilterCount();
	return afterSaving(async () => {
		await loadView();
		render();
	});
}

/**
 * Read what the page shows from the stored catalog: every series' row, or the books of the series shown
 * (at least `showing` of them, so a redraw after an edit shows as many as before).
 */
async function loadView(showing: number = 0): Promise<void> {
	await resolveAddress();
	TOTAL_BOOKS = await queryCatalog(r => r.count('books'));
	if (SERIES_FILTER === null) {
		OVERVIEW = await queryCatalog(readOverview);
		return;
	}
	const series = SERIES_FILTER;
	await LIST.show(await queryCatalog(r => readOrdered(r, series)), showing);
	if (series !== STANDALONE) await loadRecords({series: [series]});
}

/**
 * A series named in the address the way addresses had it before (by its name): the id it is stored under,
 * put in the address instead.
 */
async function resolveAddress(): Promise<void> {
	if (SERIES_FILTER === null || SERIES_FILTER === STANDALONE) return;
	const text = SERIES_FILTER;
	const id = await queryCatalog(async r => {
		if (await r.count('series', undefined, text)) return text;
		const [rec] = await r.all('series', 'name', text);
		return rec ? rec.id : text;
	});
	if (id !== text) {
		SERIES_FILTER = id;
		setAddress('replace', addressNow());
	}
}

/**
 * The series' rows (see Overview), without reading any book.
 */
async function readOverview(r: CatalogReader): Promise<Overview> {
	const series: SeriesRecord[] = await r.all('series', 'byName');
	const people = await r.get('contributors', [...new Set(series.flatMap(s => s.authorIds))]);
	return {
		series,
		authors: new Map(people.map(c => [c.id, c.name])),
		standalone: await r.count('books', 'standalone'),
	};
}

/**
 * Read what the page shows again from the stored catalog, once the saves asked for are done (after an
 * edit, or another tab's), keeping as many books shown as there were.
 */
export function refreshView(): Promise<void> {
	return afterSaving(async () => {
		await loadView(LIST.showing);
		render();
	});
}

// The Show more button at the end of a series' books.
export function showMore() {
	return afterSaving(async () => {
		await LIST.more();
		render();
	});
}

export function render() {
	if (!TOTAL_BOOKS && !CATALOG.books.length) {
		showEmptyCatalog();
		return;
	}
	const name = shownSeriesName();
	const label =
		SERIES_FILTER === null ? null : SERIES_FILTER === STANDALONE ? 'Standalone books' : name || 'No such series';
	byId('crumb').classList.toggle('show', label !== null);
	byId('crumbLabel').textContent = label || '';
	document.title = (label ? label + ' — ' : '') + spell('Audiobook Catalog');
	// books are added to a series shown, starting in it
	byId('toggleAdd').style.display = SERIES_FILTER === null ? 'none' : '';
	byId('toggleAdd').setAttribute(
		'href',
		'book.html' +
			hashOf([
				['add', true],
				['series', (name !== null && SERIES_FILTER) || ''],
			]),
	);
	if (SERIES_FILTER === null) {
		renderOverview();
		return;
	}

	const books = LIST.books().filter(b => (SERIES_FILTER === STANDALONE ? !b.series : b.series === name));
	byId('subtitle').textContent = spell(`${TOTAL_BOOKS} audiobooks in the catalog`);
	byId('resultCount').textContent = '';
	fillElement(
		byId('results'),
		books.length
			? bookGroups(books, {
					more: LIST.rest,
					onMore: () => showMore(),
					// it can be edited, and compared with the catalogs, after its books
					after: id => seriesEditButton(id),
				})
			: [
					buildElement(
						'p',
						{class: 'empty'},
						name === null ? 'No books in this series.' : `No books in ${name} yet.`,
					),
					SERIES_FILTER !== STANDALONE && name !== null && seriesEditButton(SERIES_FILTER),
				],
	);
}

/**
 * A series' info, from its record; undefined when it has none.
 */
const seriesInfoOf = (rec: SeriesRecord): Series | undefined =>
	CatalogRecords.hasInfo('series', rec)
		? new Series(rec.name, {total: rec.total, status: rec.status, note: rec.note, external: rec.external})
		: undefined;

function renderOverview() {
	const q = fieldById('q').value.trim().toLowerCase();
	let rows = OVERVIEW.series
		.map(rec => ({
			rec,
			info: seriesInfoOf(rec),
			authors: [...new Set(rec.authorIds)]
				.filter(id => OVERVIEW.authors.has(id))
				.map(id => ({id, name: OVERVIEW.authors.get(id) as string}))
				.sort((x, y) => x.name.localeCompare(y.name)),
		}))
		.sort((x, y) => x.rec.name.localeCompare(y.rec.name));
	if (q)
		rows = rows.filter(({rec, authors}) =>
			[rec.name, ...authors.map(a => a.name)].join(' ').toLowerCase().includes(q),
		);
	const onlyMissing = fieldById('missingFilter').value === 'missing';
	if (onlyMissing) rows = rows.filter(({rec}) => (rec.missing || []).length);

	byId('subtitle').textContent =
		`${OVERVIEW.series.length} series across ${TOTAL_BOOKS} audiobooks — tap a series to see its titles`;
	byId('resultCount').textContent = `${rows.length} series shown`;

	const out: Child[] = [];
	const showStandalone = !onlyMissing && (!q || 'standalone'.includes(q));
	if (rows.length === 0 && !showStandalone) {
		out.push(
			buildElement(
				'p',
				{class: 'empty'},
				onlyMissing ? 'No series with missing books.' : 'No series match your search.',
			),
		);
	}

	rows.forEach(({rec, info, authors}) => {
		const missing = rec.missing;
		out.push(
			buildElement(
				'div',
				{class: 'srow'},
				buildElement(
					'div',
					{class: 'srow-head'},
					buildElement('a', {class: 'srow-title', href: seriesPageHref(rec.id)}, rec.name),
					' ',
					buildElement(
						'span',
						{class: 'srow-owned'},
						rec.bookCount
							? `${rec.owned} owned${info ? ' of ' + totalText(info) : ''}`
							: `no books yet${info ? ', ' + totalText(info) + ' released' : ''}`,
					),
				),
				buildElement(
					'div',
					{class: 'srow-foot'},
					buildElement(
						'span',
						{class: 'tag'},
						joined(
							authors.map(a => buildElement('a', {href: creditPageHref('authors', a.id)}, a.name)),
							', ',
						),
					),
					info && [' ', statusTag(info.status), seriesLinks(info)],
					missing &&
						missing.length > 0 && [
							' ',
							buildElement('span', {class: 'missing'}, `missing ${Series.numberList(missing)}`),
						],
				),
				info && info.note && buildElement('p', {class: 'srow-note'}, info.note),
			),
		);
	});

	if (showStandalone) {
		out.push(
			buildElement(
				'div',
				{class: 'srow'},
				buildElement(
					'div',
					{class: 'srow-head'},
					buildElement('a', {class: 'srow-title', href: standalonePageHref()}, 'Standalone'),
					' ',
					buildElement('span', {class: 'srow-owned'}, `${OVERVIEW.standalone} owned`),
				),
			),
		);
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
 */
export function movedAddress(hash: string): string | null {
	const p = hashParts(hash);
	const book = hashText(p, 'book');
	if (book) return 'book.html' + hashOf([['book', book]]);
	if (!p.has('books')) return null;
	return 'books.html' + hashOf(['q', 'author', 'genre', 'read', 'sort'].map(k => [k, hashText(p, k)]));
}

/**
 * The address's #... -> what it shows; anything it does not understand is ignored.
 */
function stateFromHash(hash: string | null): {series: string | null; q: string; missing: boolean} {
	const p = hashParts(hash);
	const series = hashText(p, 'series');
	// by id, or by a name as addresses had them before (loadView finds the id then)
	return {
		series: p.has('standalone') ? STANDALONE : series ? (idFromAddress('series', series) ?? series) : null,
		q: hashText(p, 'q'),
		missing: p.get('missing') === true,
	};
}

/** @returns the address of what is shown now */
function addressNow(): string {
	return hashOf(
		SERIES_FILTER === STANDALONE
			? [['standalone', true]]
			: SERIES_FILTER !== null
				? [['series', SERIES_FILTER]]
				: [
						['q', fieldById('q').value.trim()],
						['missing', fieldById('missingFilter').value === 'missing'],
					],
	);
}

/**
 * Show a series (an id, STANDALONE) or every series, recorded in the address: a new history entry, so Back
 * returns here. Going to another series starts at the top of the page.
 * @returns once it is drawn
 */
export function openSeries(series: string | null): Promise<void> {
	const moved = series !== SERIES_FILTER;
	SERIES_FILTER = series;
	const drawn = showView();
	if (addressNow() !== location.hash) setAddress('push', addressNow());
	if (moved && typeof scrollTo === 'function') scrollTo(0, 0);
	return drawn;
}

// Back and forward (and an address typed, pasted or followed): show what the address says. The browser puts
// the scroll position back itself, as the page is redrawn before this returns.
function showAddress() {
	const moved = movedAddress(location.hash);
	if (moved) {
		location.replace(moved);
		return;
	}
	const st = stateFromHash(location.hash);
	const box = fieldById('q');
	// the address's search is trimmed; leave the box alone when it already says that, or a space being typed is lost
	if (box.value.trim() !== st.q) box.value = st.q;
	fieldById('missingFilter').value = st.missing ? 'missing' : '';
	SERIES_FILTER = st.series;
	showView();
}
addEventListener('popstate', showAddress);
addEventListener('hashchange', showAddress);

byId('missingFilter').addEventListener('change', () => {
	setAddress('push', addressNow());
	showView();
});
// On a phone the filter folds away behind a button (styles.css), which says when it is on.
function showFilterCount() {
	byId('filtersBtn').textContent = fieldById('missingFilter').value ? 'Filters · 1' : 'Filters';
}
watchSearchAndFilters(addressNow, showView);
watchCoversBox(() => render());

// ------------------------------------------------------------------ the Edit button
/**
 * The Edit button at the end of a series' own page, which opens it on the Edit series page (where it is also
 * compared with the other catalogs).
 * @param id the series'
 */
function seriesEditButton(id: string): HTMLDivElement {
	return buildElement(
		'div',
		{class: 'page-actions'},
		buildElement('a', {class: 'sedit', 'data-series': id, href: editPageHref(id)}, 'Edit'),
	);
}

// After a save took in what another tab changed (store.ts): the page shows what is stored now.
function redraw() {
	refreshView();
}

// An address from when this page showed the books too goes where they are now; the page starts on what the
// address shows (a link, a bookmark, or Back from another page).
const MOVED = movedAddress(location.hash);
if (MOVED) location.replace(MOVED);
export const READY = MOVED
	? Promise.resolve()
	: startPage(
			async () => {
				const st = stateFromHash(location.hash);
				fieldById('q').value = st.q;
				fieldById('missingFilter').value = st.missing ? 'missing' : '';
				SERIES_FILTER = st.series;
				const drawn = showView();
				setAddress('replace', addressNow());
				await drawn;
				await showBackupNudge();
			},
			{refresh: redraw},
		);
