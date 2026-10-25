// The books page (books.html): every book, 50 at a time, searched, filtered and sorted.
// The book cards and lists are book-list.js's; loading and saving live in store.js.
import {CatalogRecords} from './modules/catalog-records.js';
/** @import {CatalogReader} from './modules/catalog-database.js' */
import {
	CATALOG,
	queryCatalog,
	afterSaving,
	startPage,
	byId,
	fieldById,
	spell,
	buildElement,
	fillElement,
} from './store.js';
import {
	BookList,
	bookGroups,
	readOrdered,
	watchCoversBox,
	showEmptyCatalog,
	showBackupNudge,
	hashParts,
	hashText,
	hashOf,
	setAddress,
	watchSearchAndFilters,
} from './book-list.js';

// The page holds only what it shows, read from the stored catalog by loadView(): the ids of the books the
// search and filters find, in the order they are listed, of which the first are drawn (Show more draws more).
// Sorted by date, a series' books need not stay together.
const LIST = new BookList(() => !fieldById('sortBy').value);
export let TOTAL_BOOKS = 0;
/** @type {{authors: string[], genres: string[], years: string[]}} the filters' choices */
let FILTER_CHOICES = {authors: [], genres: [], years: []};

// Filter value for books with no date read, in the "Read any time" select.
const UNDATED = '__undated__';
const FILTERS = ['authorFilter', 'genreFilter', 'readFilter', 'sortBy']; // the order folds away with them

/** @param {string[]} arr */
function uniqueSorted(arr) {
	return [...new Set(arr)].sort((a, b) => a.localeCompare(b));
}

/**
 * The filters' choices, from the stored catalog: its authors, genres and the years books were read in.
 * @param {CatalogReader} r
 * @returns {Promise<typeof FILTER_CHOICES>}
 */
async function readFilterChoices(r) {
	// the authors' names are the keys of an index, so no record is read for them
	const authors = (await r.indexKeys('contributors', 'kindName', r.keyRange.bound(['author'], ['author', []]))).map(
		([key]) => String(/** @type {IDBValidKey[]} */ (key)[1]),
	);
	const years = /** @type {string[]} */ (await r.keys('books', 'readYears')).filter(
		y => y !== CatalogRecords.UNDATED,
	);
	return {
		authors: uniqueSorted(authors),
		genres: uniqueSorted(/** @type {string[]} */ (await r.keys('books', 'genres'))),
		years: uniqueSorted(years).reverse(),
	};
}

function populateFilters() {
	const {authors, genres, years} = FILTER_CHOICES;
	const aSel = fieldById('authorFilter');
	const gSel = fieldById('genreFilter');
	const rSel = fieldById('readFilter');
	const aCur = aSel.value,
		gCur = gSel.value,
		rCur = rSel.value;
	/** @type {(value: string, text: string) => HTMLOptionElement} */
	const option = (value, text) => buildElement('option', {value}, text);
	fillElement(
		aSel,
		option('', 'All authors'),
		authors.map(a => option(a, a)),
	);
	fillElement(
		gSel,
		option('', 'All genres'),
		genres.map(g => option(g, g)),
	);
	fillElement(
		rSel,
		option('', 'Read any time'),
		years.map(y => option(y, `Read in ${y}`)),
		option(UNDATED, 'No date read'),
	);
	aSel.value = aCur;
	gSel.value = gCur;
	rSel.value = rCur;
}

/**
 * The ids of the books the list shows, in the order it shows them (readOrdered's, or newest first when
 * sorted). The search and the filters narrow them, by the indexes for them; only the indexes' keys are read.
 * @param {CatalogReader} r
 * @returns {Promise<string[]>}
 */
async function readListed(r) {
	const q = fieldById('q').value.trim();
	const author = fieldById('authorFilter').value;
	const genre = fieldById('genreFilter').value;
	const read = fieldById('readFilter').value;
	/** @type {Set<string> | null} */
	let only = null;
	/** @type {(ids: IDBValidKey[]) => void} */
	const narrow = ids => {
		const found = new Set(ids.map(String));
		only = only ? new Set([...only].filter(id => found.has(id))) : found;
	};
	if (author) {
		const [rec] = await r.all('contributors', 'kindName', ['author', author]);
		narrow(
			rec
				? (await r.allKeys('credits', 'byTitle', r.keyRange.bound([rec.id], [rec.id, []]))).map(
						key => /** @type {IDBValidKey[]} */ (key)[1],
					)
				: [],
		);
	}
	if (genre) narrow(await r.allKeys('books', 'genres', genre));
	if (read) narrow(await r.allKeys('books', 'readYears', read === UNDATED ? CatalogRecords.UNDATED : read));
	// an ISBN matches however it is typed: with hyphens, or as the ISBN-10 of the same edition
	if (q)
		narrow(
			(await r.indexKeys('books', 'search'))
				.filter(([text]) => CatalogRecords.searchMatches(String(text), q))
				.map(([, id]) => id),
		);
	const listed = await readOrdered(r, null, only);
	const sort = fieldById('sortBy').value;
	if (!sort) return listed;
	// newest first: by the latest date read (books without one keep series order, after those with one), or
	// by place in the catalog, where an import or a new book goes last
	const order = (await r.indexKeys('books', sort === 'read' ? 'byLastRead' : 'byPosition'))
		.map(([, id]) => String(id))
		.reverse();
	const rank = new Map(order.map((id, i) => [id, i]));
	return [...listed].sort((x, y) => (rank.get(x) ?? order.length) - (rank.get(y) ?? order.length));
}

/**
 * Read the books listed and the first of them from the stored catalog (at least `showing`, so a redraw after
 * an edit shows as many as before).
 * @param {number} [showing]
 * @returns {Promise<void>}
 */
async function loadView(showing = 0) {
	TOTAL_BOOKS = await queryCatalog(r => r.count('books'));
	await LIST.show(await queryCatalog(readListed), showing);
}

/**
 * Show what the search and filters say, once the saves asked for are done and it is read.
 * @returns {Promise<void>} once it is drawn
 */
function showView() {
	showFilterCount();
	return afterSaving(async () => {
		await loadView();
		render();
	});
}

/**
 * Read what the page shows again from the stored catalog, once the saves asked for are done (after another
 * tab's), keeping as many books shown as there were.
 * @returns {Promise<void>}
 */
export function refreshView() {
	return afterSaving(async () => {
		FILTER_CHOICES = await queryCatalog(readFilterChoices);
		populateFilters();
		await loadView(LIST.showing);
		render();
	});
}

// The Show more button at the end of the list.
export function showMore() {
	return afterSaving(async () => {
		await LIST.more();
		render();
	});
}

export function render() {
	const author = fieldById('authorFilter').value;
	// a new book starts with the author picked
	byId('toggleAdd').setAttribute(
		'href',
		'book.html' +
			hashOf([
				['add', true],
				['author', author],
			]),
	);
	if (!TOTAL_BOOKS && !CATALOG.books.length) {
		showEmptyCatalog();
		return;
	}
	const books = LIST.books();
	const more = LIST.rest;
	byId('subtitle').textContent = spell(`${TOTAL_BOOKS} audiobooks in the catalog`);
	byId('resultCount').textContent =
		more > 0 ? `${books.length} of ${books.length + more} shown` : `${books.length} shown`;
	fillElement(
		byId('results'),
		books.length
			? bookGroups(books, {sorted: !!fieldById('sortBy').value, more, onMore: () => showMore()})
			: buildElement('p', {class: 'empty'}, 'No books match. Try clearing a filter.'),
	);
}

// ------------------------------------------------------------------ the address
// The search, filters and order live in the address after the #, so they can be linked to, bookmarked and
// reloaded, and Back and Forward step through them: #q=gull&author=...&genre=...&read=2024 (or read=undated)&sort=read.

/** @returns {string} the address of what is shown now */
function addressNow() {
	const val = (/** @type {string} */ id) => fieldById(id).value;
	const read = val('readFilter');
	return hashOf([
		['q', val('q').trim()],
		['author', val('authorFilter')],
		['genre', val('genreFilter')],
		['read', read === UNDATED ? 'undated' : read],
		['sort', val('sortBy')],
	]);
}

// Back and forward (and an address typed or pasted in): show what the address says.
function showAddress() {
	const p = hashParts(location.hash);
	// the address's search is trimmed; leave the box alone when it already says that, or a space being typed is lost
	const box = fieldById('q');
	if (box.value.trim() !== hashText(p, 'q')) box.value = hashText(p, 'q');
	fieldById('authorFilter').value = hashText(p, 'author');
	fieldById('genreFilter').value = hashText(p, 'genre');
	fieldById('readFilter').value = hashText(p, 'read') === 'undated' ? UNDATED : hashText(p, 'read');
	fieldById('sortBy').value = ['read', 'added'].includes(hashText(p, 'sort')) ? hashText(p, 'sort') : '';
	if (addressNow() !== location.hash) setAddress('replace', addressNow());
	return showView();
}
addEventListener('popstate', showAddress);
addEventListener('hashchange', () => {
	if (addressNow() !== location.hash) showAddress();
});

FILTERS.forEach(id =>
	byId(id).addEventListener('change', () => {
		setAddress('push', addressNow());
		showView();
	}),
);

// On a phone the filters fold away behind a button (styles.css), which says how many are on.
function showFilterCount() {
	const on = FILTERS.filter(id => fieldById(id).value).length;
	byId('filtersBtn').textContent = on ? `Filters · ${on}` : 'Filters';
}
watchSearchAndFilters(addressNow, showView);
watchCoversBox(() => render());

// The search and filters in the address (a link, a bookmark, or Back from another page), once the filters have their options.
export const READY = startPage(
	async () => {
		FILTER_CHOICES = await queryCatalog(readFilterChoices);
		populateFilters();
		await showAddress();
		await showBackupNudge();
	},
	{refresh: () => refreshView()},
);
