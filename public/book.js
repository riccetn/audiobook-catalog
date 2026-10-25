// A book's page (book.html#book=<id>): everything about the book, its Edit and Merge, and the book form,
// which also adds a book (book.html#add, with &series=<id> or &author=<name> to start it with).
// The covers and links are book-list.js's; loading and saving live in store.js.
import {Text} from './modules/text.js';
import {Edition} from './modules/edition.js';
import {Book} from './modules/book.js';
import {Catalog} from './modules/catalog.js';
import {Validator} from './modules/validator.js';
import {HardcoverClient} from './modules/hardcover-client.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {CatalogLookup} from './modules/catalog-lookup.js';
import {
	CATALOG,
	STATUS_TIME,
	persist,
	loadRecords,
	queryCatalog,
	afterSaving,
	showIoStatus,
	lookupHardcoverBook,
	keyedClients,
	browserProxy,
	fetchViaProxy,
	startPage,
	byId,
	fieldById,
	spell,
	buildElement,
	fillElement,
	joined,
	publisherPageHref,
	externalFields,
	fillExternalFields,
	readExternalFields,
	bookPageHref,
	seriesPageHref,
} from './store.js';
/** @import {Child} from './store.js' */
import {
	authorLinks,
	narratorLinks,
	bookNarrators,
	coverImage,
	hashParts,
	hashText,
	hashOf,
	setAddress,
} from './book-list.js';
import {comboBox, comboField, newNames, refreshNewNotes} from './combo-box.js';

// Books and series are known by the ids they are stored under, so a book retitled (here or in another tab)
// is still the one shown or edited.
/** @type {string | null} */
export let BOOK_FILTER = null; // the id of the book shown (#book=...), or null
/** @type {{series: string, author: string} | null} */
let ADDING = null; // what a book being added starts with (#add): a series' id and an author's name, or ''
/** @type {string | null} */
export let EDIT_ID = null; // the id of the book being edited, or null when adding one
/** @type {{id: string, q: string, found: string[], more: number} | null} */
let MERGE_SEARCH = null; // the book whose Merge was pressed, what was typed to find the other one, and the books found
/** @type {{id: string, timer: ReturnType<typeof setTimeout>} | null} */
let REMOVING = null; // a book removed but kept until its Undo is gone (removeBook), or null
/** @type {string | null} */
let REMOVED = null; // the id of the book last removed here, so its page says so

/**
 * Show what BOOK_FILTER or ADDING say, once the saves asked for are done and it is read (again, after an
 * edit, or another tab's).
 * @returns {Promise<void>} once it is drawn
 */
export function refreshView() {
	return afterSaving(async () => {
		await loadView();
		render();
	});
}

/**
 * Read what the page shows from the stored catalog: the book (and the other books sharing an edition with
 * it, a box set's), or the series a book being added starts in, with its books.
 * @returns {Promise<void>}
 */
async function loadView() {
	await resolveAddress();
	if (ADDING && ADDING.series) await loadRecords({seriesBooks: [ADDING.series], series: [ADDING.series]});
	if (BOOK_FILTER === null) return;
	await loadRecords({books: [BOOK_FILTER]});
	const b = CATALOG.book(BOOK_FILTER);
	const keys = b ? [...new Set(b.editions.flatMap(ed => ed.idAndIsbnKeys()))] : [];
	if (keys.length) await loadRecords({editionKeys: keys});
}

/**
 * A book named in the address the way addresses had it before (by its title): the id it is stored under,
 * put in the address instead.
 * @returns {Promise<void>}
 */
async function resolveAddress() {
	if (BOOK_FILTER === null) return;
	const text = BOOK_FILTER;
	const id = await queryCatalog(async r => {
		if (await r.count('books', undefined, text)) return text;
		const found = await r.under('books', 'byTitle', [CatalogRecords.sortKey(text)]);
		const book = found.find(b => b.title === text);
		return book ? book.id : text;
	});
	if (id !== text) {
		BOOK_FILTER = id;
		setAddress('replace', addressNow());
	}
}

export function render() {
	homeBookForm(); // out of the page before it is redrawn, which would drop it
	const book = CATALOG.book(BOOK_FILTER);
	const shown = book && REMOVING?.id !== book.id ? book : undefined;
	// a book in a series links back to it
	const series = shown && shown.series && CATALOG.idFor('series', shown.series);
	const label = ADDING
		? 'Add a book'
		: shown
			? shown.title
			: REMOVED !== null && REMOVED === BOOK_FILTER
				? 'Removed'
				: 'No such book';
	fillElement(
		byId('crumbLabel'),
		shown && series
			? [buildElement('a', {href: seriesPageHref(series)}, /** @type {string} */ (shown.series)), ' › ', label]
			: label,
	);
	document.title = label + ' — ' + spell('Audiobook Catalog');
	SHARED = sharedEditions();
	fillElement(
		byId('results'),
		shown
			? bookDetails(shown)
			: !ADDING &&
					buildElement(
						'p',
						{class: 'empty'},
						label === 'Removed'
							? 'Removed; imports will skip it. '
							: spell('This book is not in the catalog. '),
						buildElement('a', {href: 'books.html'}, 'All books'),
					),
	);
	placeBookForm();
}

// ------------------------------------------------------------------ the address
// #book=<id> shows a book, by the id it is stored under, so a link holds when the book is retitled (an
// address from before, with its title, is still understood); #add opens the form for a new book, with
// &series=<id> and &author=<name> to start it with.

/**
 * The address's #... -> what it shows.
 * @param {string | null} hash
 * @returns {{book: string | null, adding: {series: string, author: string} | null}}
 */
function stateFromHash(hash) {
	const p = hashParts(hash);
	return {
		book: hashText(p, 'book') || null,
		adding: p.has('add') ? {series: hashText(p, 'series'), author: hashText(p, 'author')} : null,
	};
}

/** @returns {string} the address of what is shown now */
function addressNow() {
	return ADDING
		? hashOf([
				['add', true],
				['series', ADDING.series],
				['author', ADDING.author],
			])
		: hashOf([['book', BOOK_FILTER || '']]);
}

// Back and forward (and a link to another book, a box set's): show what the address says, from the top of
// the page when it is another book.
function showAddress() {
	const st = stateFromHash(location.hash);
	if (st.book === BOOK_FILTER && JSON.stringify(st.adding) === JSON.stringify(ADDING)) return refreshView();
	closeForm();
	MERGE_SEARCH = null;
	BOOK_FILTER = st.book;
	ADDING = st.adding;
	if (typeof scrollTo === 'function') scrollTo(0, 0);
	return afterSaving(async () => {
		await loadView();
		render();
		if (ADDING) openAddForm();
	});
}
addEventListener('popstate', showAddress);
addEventListener('hashchange', () => {
	if (addressNow() !== location.hash) showAddress();
});

// ------------------------------------------------------------------ the book's details
// Edition object -> the other books it is also on (a box set), for the book shown.
/** @type {Map<Edition, Book[]>} */
let SHARED = new Map();

/** @returns {Map<Edition, Book[]>} */
function sharedEditions() {
	/** @type {Map<string, [Book, Edition][]>} */
	const byKey = new Map();
	CATALOG.books.forEach(b =>
		b.editions.forEach(ed =>
			ed.idAndIsbnKeys().forEach(k => {
				let list = byKey.get(k);
				if (!list) byKey.set(k, (list = []));
				list.push([b, ed]);
			}),
		),
	);
	/** @type {Map<Edition, Book[]>} */
	const shared = new Map();
	CATALOG.books.forEach(b =>
		b.editions.forEach(ed => {
			/** @type {Set<Book>} */
			const others = new Set();
			for (const k of ed.idAndIsbnKeys())
				for (const [other, x] of byKey.get(k) || []) if (other !== b && x.sameAs(ed)) others.add(other);
			if (others.size) shared.set(ed, [...others]);
		}),
	);
	return shared;
}

/**
 * An id, linking to its page in its external catalog (ExternalCatalog.url); just the id when there is none.
 * @type {(catalog: string, kind: 'book' | 'edition', id: string) => Child}
 */
const idLink = (catalog, kind, id) => {
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
function editionRows(ed) {
	const asins = () =>
		joined(
			ed.asinList().map(([site, asin]) => [site + ' ', idLink(site, 'edition', asin)]),
			', ',
		);
	return ed
		.parts()
		.filter(([k]) => k !== 'desc')
		.map(([k, label, value]) => [
			label,
			k === 'asin'
				? asins()
				: k === 'n'
					? narratorLinks(ed.narrators)
					: k === 'p'
						? buildElement('a', {href: publisherPageHref(value)}, value)
						: k.startsWith('ext:')
							? idLink(k.slice(4), 'edition', value)
							: value,
		]);
}

/**
 * A details list (dl) of the rows that have a value.
 * @param {[string, Child | false | undefined][]} rows
 * @returns {HTMLElement}
 */
function detailList(rows) {
	return buildElement(
		'dl',
		{class: 'details'},
		rows
			.filter(([, value]) => value)
			.map(([label, value]) => [buildElement('dt', {}, label), buildElement('dd', {}, value)]),
	);
}

/**
 * A book's Edit and Merge buttons, under its details: viewing a book comes first, so they come last. Merge
 * opens a search for the other book (mergeSearch).
 * @param {string} id the book's
 * @returns {Child[]}
 */
function bookActions(id) {
	const searching = MERGE_SEARCH?.id === id;
	return [
		buildElement(
			'div',
			{class: 'book-actions'},
			buildElement('button', {type: 'button', class: 'edit', onclick: () => openEditForm(id)}, 'Edit'),
			buildElement(
				'button',
				{
					type: 'button',
					class: 'merge',
					'aria-expanded': String(searching),
					onclick: () => toggleMergeSearch(id),
				},
				'Merge',
			),
		),
		searching && mergeSearch(id),
	];
}

/**
 * Merge's search for the book to merge with: what is typed finds books as the books page's search does, and
 * each found links to the duplicates page with the two (which checks they are still the same books).
 * @param {string} id the book's
 * @returns {HTMLDivElement}
 */
function mergeSearch(id) {
	const q = MERGE_SEARCH ? MERGE_SEARCH.q : '';
	return buildElement(
		'div',
		{class: 'mergeSearch'},
		buildElement('label', {for: 'mergeQuery'}, 'Find the book to merge it with'),
		buildElement('input', {
			type: 'search',
			id: 'mergeQuery',
			value: q,
			placeholder: 'Title, author, series or ISBN',
			autocomplete: 'off',
			oninput: (/** @type {Event} */ e) =>
				findMergeBooks(id, /** @type {HTMLInputElement} */ (e.currentTarget).value),
		}),
		buildElement('ul', {class: 'mergeFound', id: 'mergeFound'}, mergeFoundItems(id)),
	);
}

/**
 * The books Merge's search found, each a link to merging it with book `id`.
 * @param {string} id the book's
 * @returns {Child[]}
 */
function mergeFoundItems(id) {
	if (!MERGE_SEARCH || !MERGE_SEARCH.q.trim()) return [];
	const found = /** @type {Book[]} */ (MERGE_SEARCH.found.map(other => CATALOG.book(other)).filter(Boolean));
	if (!found.length) return [buildElement('li', {class: 'none'}, 'No other book matches.')];
	return [
		...found.map(b =>
			buildElement(
				'li',
				{},
				buildElement(
					'a',
					{
						href:
							'duplicates.html#merge=' +
							[id, /** @type {string} */ (b.id)].map(encodeURIComponent).join(','),
					},
					b.title,
				),
				b.series && ` (${b.series}${b.number ? ' #' + b.number : ''})`,
				b.authors.length > 0 && ' — ' + Text.namesText(b.authors),
			),
		),
		MERGE_SEARCH.more > 0 &&
			buildElement('li', {class: 'none'}, `and ${MERGE_SEARCH.more} more; type more to narrow it down.`),
	];
}

/**
 * Merge on a book's details: opens the search for the book to merge it with, or closes it.
 * @param {string} id the book's
 */
export function toggleMergeSearch(id) {
	MERGE_SEARCH = MERGE_SEARCH?.id === id ? null : {id, q: '', found: [], more: 0};
	render();
	if (MERGE_SEARCH) byId('mergeQuery').focus();
}

// How many books Merge's search lists at most.
const MERGE_FOUND_MAX = 20;

/**
 * Find the books matching `q` for Merge's search, from the stored catalog as the books page's search does,
 * and show them; a search typed over meanwhile is dropped.
 * @param {string} id the book being merged
 * @param {string} q
 * @returns {Promise<void>}
 */
export async function findMergeBooks(id, q) {
	if (MERGE_SEARCH?.id !== id) return;
	MERGE_SEARCH.q = q;
	const text = q.trim();
	const ids = !text
		? []
		: (await queryCatalog(r => r.indexKeys('books', 'search')))
				.filter(([search, other]) => other !== id && CatalogRecords.searchMatches(String(search), text))
				.map(([, other]) => String(other));
	const shown = ids.slice(0, MERGE_FOUND_MAX);
	if (shown.length) await loadRecords({books: shown});
	if (MERGE_SEARCH?.id !== id || MERGE_SEARCH.q !== q) return;
	MERGE_SEARCH.found = shown.sort((x, y) =>
		(CATALOG.book(x)?.title || '').localeCompare(CATALOG.book(y)?.title || ''),
	);
	MERGE_SEARCH.more = ids.length - shown.length;
	const list = document.getElementById('mergeFound');
	if (list) fillElement(list, mergeFoundItems(id));
}

/**
 * Everything about a book, with each edition's parts, and then its Edit and Merge buttons. Its parts are laid
 * out by styles.css: the cover beside the rest, or across the whole card on a phone.
 * @param {Book} b
 * @returns {HTMLDivElement}
 */
function bookDetails(b) {
	const id = /** @type {string} */ (b.id);
	const series = b.series && CATALOG.idFor('series', b.series);
	const editions = b.editions.map((ed, i) => {
		const also = (SHARED.get(ed) || []).map(other =>
			buildElement(
				'a',
				{href: bookPageHref(/** @type {string} */ (other.id))},
				other.title + (other.number ? ` #${other.number}` : ''),
			),
		);
		return buildElement(
			'div',
			{class: 'edition'},
			buildElement(
				'h3',
				{},
				b.editions.length > 1 ? `Edition ${i + 1}` : 'Edition',
				ed.description && ': ' + ed.description,
			),
			detailList([...editionRows(ed), ['Also in this edition', also.length > 0 && joined(also, ', ')]]),
		);
	});
	return buildElement(
		'div',
		{class: 'book book-details', 'data-id': id},
		buildElement('div', {class: 'num'}, b.number || '•'),
		buildElement(
			'div',
			{class: 'head'},
			buildElement('h2', {class: 'title'}, b.title),
			buildElement(
				'div',
				{class: 'meta'},
				joined([authorLinks(b.authors), bookNarrators(b)].filter(Boolean), ' — '),
			),
		),
		coverImage(b, 'large'),
		buildElement(
			'div',
			{class: 'info'},
			detailList([
				[
					'Series',
					series && [
						buildElement('a', {href: seriesPageHref(series)}, b.series),
						b.number && ` #${b.number}`,
					],
				],
				[
					'Read',
					[
						b.read.length > 0 && b.read.join(', ') + ' ',
						!b.read.includes(today()) &&
							buildElement(
								'button',
								{type: 'button', class: 'readToday', onclick: () => readToday(id)},
								'+ Read today',
							),
					],
				],
				[
					'Genres',
					b.genres.length > 0 &&
						buildElement(
							'span',
							{class: 'genres'},
							b.genres.map(g => buildElement('span', {class: 'tag'}, g)),
						),
				],
				...Object.entries(ExternalCatalog.order(b.external) || {}).map(
					([key, value]) =>
						/** @type {[string, Child]} */ ([
							`${ExternalCatalog.name(key)} book`,
							idLink(key, 'book', value),
						]),
				),
			]),
			editions,
			bookActions(id),
		),
	);
}

/**
 * Add today to a book's dates read, from its details, with an Undo.
 * @param {string} id the book's
 */
export function readToday(id) {
	const b = CATALOG.book(id);
	if (!b || b.read.includes(today())) return;
	const before = b.read;
	b.read = [...b.read, today()].sort();
	render();
	persist();
	refreshView();
	showIoStatus(`Read ${b.title} today.`, false, () => {
		const now = CATALOG.book(id);
		if (!now) return;
		now.read = before;
		render();
		persist();
		refreshView();
	});
}

/**
 * The book form's Remove book: the book being edited leaves the page at once, with an Undo on the status
 * line; it is taken out of the catalog, and added to the exclusions so imports skip it, once the Undo is gone
 * (finishRemoving).
 */
function removeEditedBook() {
	const id = EDIT_ID;
	const b = CATALOG.book(id);
	if (!id || !b) return;
	finishRemoving();
	closeForm();
	REMOVING = {id, timer: setTimeout(finishRemoving, STATUS_TIME)};
	REMOVED = id;
	render();
	showIoStatus(`Removed ${b.title}; imports will skip it.`, false, () => {
		if (REMOVING?.id !== id) return;
		clearTimeout(REMOVING.timer);
		REMOVING = null;
		REMOVED = null;
		render();
	});
}

// Takes the book being removed out of the catalog for good. Leaving the page does it too, so a removal is
// saved unless it was undone.
export function finishRemoving() {
	if (!REMOVING) return;
	const {id, timer} = REMOVING;
	clearTimeout(timer);
	REMOVING = null;
	const i = CATALOG.books.findIndex(b => b.id === id);
	if (i < 0) return;
	const [removed] = CATALOG.books.splice(i, 1);
	CATALOG.addExclusions(removed.exclusionEntries()); // so the next import does not bring it back
	render();
	persist();
	refreshView();
}
addEventListener('pagehide', finishRemoving);
addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') finishRemoving();
});

// ------------------------------------------------------------------ the book form
// The names the catalog has for series, authors, narrators and publishers, which the form's fields offer as
// they are typed in, and say a name is new when it isn't one of them (combo-box.js); read when the form
// opens, from the series' and contributors' indexes alone.
/** @type {Record<'series' | 'author' | 'narrator' | 'publisher', string[]>} */
export const FORM_NAMES = {series: [], author: [], narrator: [], publisher: []};
let FORM_NAMES_READ = false; // whether FORM_NAMES holds the names, so a name not among them is new
/** @type {Record<'series' | 'author' | 'narrator' | 'publisher', [string, string]>} */
const NOUNS = {
	series: ['series', 'series'],
	author: ['author', 'authors'],
	narrator: ['narrator', 'narrators'],
	publisher: ['publisher', 'publishers'],
};
/** @type {(kind: 'series' | 'author' | 'narrator' | 'publisher') => import('./combo-box.js').NewNote} */
const newNote = kind => ({nouns: NOUNS[kind], ready: () => FORM_NAMES_READ});

/** @returns {Promise<void>} once FORM_NAMES holds the stored names, and the ones this page holds */
export async function loadFormNames() {
	FORM_NAMES_READ = false;
	refreshNewNotes();
	const [keys, series] = await queryCatalog(r =>
		Promise.all([r.keys('contributors', 'kindName'), r.keys('series', 'name')]),
	);
	for (const kind of /** @type {const} */ (['author', 'narrator', 'publisher'])) {
		const stored = keys
			.filter(k => Array.isArray(k) && k[0] === kind)
			.map(k => String(/** @type {IDBValidKey[]} */ (k)[1]));
		FORM_NAMES[kind] = [...new Set([...stored, ...CATALOG.namesOf(`${kind}s`)])];
	}
	FORM_NAMES.series = [...new Set([...series.map(k => String(k)), ...CATALOG.namesOf('series')])];
	FORM_NAMES_READ = true;
	refreshNewNotes();
}

/**
 * What saving `b` adds to the catalog: the names on it the catalog doesn't have yet, as "the author X".
 * @param {Book} b
 * @returns {string[]}
 */
function newEntries(b) {
	if (!FORM_NAMES_READ) return [];
	/** @type {['series' | 'author' | 'narrator' | 'publisher', import('./modules/catalog.js').NamedKind][]} */
	const kinds = [
		['series', 'series'],
		['author', 'authors'],
		['narrator', 'narrators'],
		['publisher', 'publishers'],
	];
	return kinds.flatMap(([kind, named]) =>
		newNames(FORM_NAMES[kind], Catalog.namesOn(named)(b).join(', '), true).map(
			name => `the ${NOUNS[kind][0]} ${name}`,
		),
	);
}

/**
 * What a new book starts with, from the address: the series named, and the author named, else the authors
 * every book of the series has (its co-authors on some books left out).
 * @returns {{series: string, authors: string[]}}
 */
function newBookDefaults() {
	const series = ADDING && ADDING.series ? CATALOG.nameOf('series', ADDING.series) || '' : '';
	if (ADDING && ADDING.author) return {series, authors: [ADDING.author]};
	const books = series ? CATALOG.books.filter(b => b.series === series) : [];
	const authors = books.length ? books[0].authors.filter(a => books.every(b => b.authors.includes(a))) : [];
	return {series, authors};
}

// The form for a new book, empty but for what it starts with.
function openAddForm() {
	EDIT_ID = null;
	const form = byId('addForm');
	byId('formTitle').textContent = 'Add a book';
	byId('formSaveBtn').textContent = 'Add book';
	byId('formRemoveBtn').style.display = 'none';
	byId('formError').textContent = '';
	/** @type {HTMLFormElement} */ (form).reset();
	setFormEditions([], null);
	showBookIds([]);
	const {series, authors} = newBookDefaults();
	fieldById('f_s').value = series;
	fieldById('f_a').value = authors.join(', ');
	loadFormNames();
	placeBookForm();
	form.classList.add('open');
}

// Cancel: closes the form; for a new book, this page was only for it, so it goes back to its series or the books.
byId('cancelAdd').addEventListener('click', () => {
	const adding = ADDING;
	closeForm();
	if (adding) location.replace(adding.series ? seriesPageHref(adding.series) : 'books.html');
});
byId('formRemoveBtn').addEventListener('click', removeEditedBook);

// Today in the viewer's time zone, as YYYY-MM-DD.
export function today() {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

byId('readTodayBtn').addEventListener('click', () => {
	const input = fieldById('f_r');
	const current = input.value.trim();
	if (
		current
			.split(/[,;]/)
			.map(x => x.trim())
			.includes(today())
	)
		return;
	input.value = current ? current.replace(/[,;\s]*$/, '') + ', ' + today() : today();
});

function closeForm() {
	EDIT_ID = null;
	byId('formError').textContent = '';
	byId('addForm').classList.remove('open');
	/** @type {HTMLFormElement} */ (byId('addForm')).reset();
	setFormEditions([], null);
	placeBookForm();
}

// The book form, kept in a variable as it is out of the page while the details are redrawn.
const BOOK_FORM = byId('addForm');
// Its own place, above the details, where a new book is added.
function homeBookForm() {
	byId('results').before(BOOK_FORM);
}

/**
 * Put the book form where it belongs: in place of the book's details while it is edited, else (adding a book)
 * in its own place.
 */
function placeBookForm() {
	document.querySelectorAll('#results .book.editing').forEach(card => card.classList.remove('editing'));
	const card = EDIT_ID === null ? null : document.querySelector(`#results .book[data-id="${EDIT_ID}"]`);
	if (!card) {
		homeBookForm();
		return;
	}
	card.classList.add('editing');
	card.after(BOOK_FORM);
}

/**
 * The book's ids in other catalogs are folded away in the form; its summary names the catalogs it has one in.
 * @param {string[]} keys
 */
function showBookIds(keys) {
	/** @type {HTMLDetailsElement} */ (byId('f_ids')).open = false;
	byId('f_idsNote').textContent = keys.length ? '(' + keys.map(k => ExternalCatalog.name(k)).join(', ') + ')' : '';
}

/** @param {string} id the book's */
export function openEditForm(id) {
	const b = CATALOG.book(id);
	if (!b) return;
	EDIT_ID = id;
	fieldById('f_t').value = b.title;
	fieldById('f_a').value = b.authors.join(', ');
	fieldById('f_g').value = b.genres.join(', ');
	fieldById('f_hcb').value = b.idOn('hardcover') || '';
	fillExternalFields('f_ext_', 'book', b.external);
	showBookIds(Object.keys(ExternalCatalog.order(b.external) || {}));
	fieldById('f_s').value = b.series || '';
	fieldById('f_sn').value = b.number || '';
	fieldById('f_r').value = b.read.join(', ');
	setFormEditions(b.editions, id);
	loadFormNames();
	byId('formError').textContent = '';
	byId('formTitle').textContent = 'Edit book';
	byId('formSaveBtn').textContent = 'Save changes';
	byId('formRemoveBtn').style.display = '';
	placeBookForm();
	byId('addForm').classList.add('open');
	byId('addForm').scrollIntoView({behavior: 'smooth', block: 'center'});
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
function setFormEditions(editions, id) {
	const others = CATALOG.books.filter(b => id === null || b.id !== id);
	FORM_EDITIONS = editions.map(ed => ({
		fields: ed.fields(),
		also: others.filter(b => b.editions.some(x => x.sameAs(ed))).map(b => b.title),
		id: ed.id,
	}));
	if (!FORM_EDITIONS.length) FORM_EDITIONS.push({fields: {}, also: []});
	renderFormEditions();
}

/** @type {Record<string, string>} */
const EDITION_HINTS = {
	desc: 'e.g. UK edition',
	n: 'e.g. Ann Vale, Bo Reed',
	asin: 'B0… or its address',
	isbn: '978…',
	p: 'e.g. Gullwing Audio',
	d: 'e.g. 2021-05',
	len: 'e.g. 10h 42m',
};
/** @type {(catalog: string) => string} the hint in a catalog's id field: "id or goodreads.com address" */
const externalHint = catalog =>
	`id or ${(ExternalCatalog.url(catalog, 'edition', '0') || catalog).replace(/^https?:\/\/(www\.)?/, '').split('/')[0]} address`;
// The catalogs other than Audible's and Amazon's sites that an edition can have an id in: Goodreads' and
// Hardcover's fields are always there, the others' only once the edition has one or one is picked from a list.
const OTHER_EDITION_CATALOGS = ExternalCatalog.forKind('edition')
	.filter(def => def.family !== 'asin')
	.map(def => def.key);
const USUAL_EDITION_CATALOGS = ['goodreads', 'hardcover'];

/**
 * An edition's fields for its ids in catalogs other than Audible and Amazon, and a list to add one for another.
 * @param {Record<string, string>} fields
 * @param {number} i the edition's card
 * @returns {HTMLDivElement[]}
 */
function otherCatalogFields(fields, i) {
	const shown = OTHER_EDITION_CATALOGS.filter(
		catalog => USUAL_EDITION_CATALOGS.includes(catalog) || 'ext:' + catalog in fields,
	);
	const more = OTHER_EDITION_CATALOGS.filter(catalog => !shown.includes(catalog));
	return [
		...shown.map(catalog =>
			buildElement(
				'div',
				{class: `ef-ext ef-${catalog}`},
				buildElement('label', {}, Edition.fieldLabel(catalog)),
				buildElement('input', {
					'data-i': i,
					'data-k': 'ext:' + catalog,
					value: fields['ext:' + catalog] || '',
					placeholder: externalHint(catalog),
				}),
			),
		),
		...(more.length
			? [
					buildElement(
						'div',
						{class: 'ef-ext ef-more'},
						buildElement('label', {}, ' '),
						buildElement(
							'select',
							{'data-add-site': i, 'aria-label': 'Add an id in another catalog'},
							buildElement('option', {value: ''}, '+ Another catalog'),
							more.map(catalog =>
								buildElement('option', {value: catalog}, ExternalCatalog.name(catalog)),
							),
						),
					),
				]
			: []),
	];
}

// An edition's ASINs: a field for each site it has one on (audible.com's always, as an ASIN usually is),
// and a list to add a field for another site, so the card only shows the sites in use.
const DEFAULT_ASIN_SITE = ExternalCatalog.AUDIBLE_SITE;
/** @type {(fields: Record<string, string>) => string[]} */
const asinSitesOf = fields =>
	[
		DEFAULT_ASIN_SITE,
		...Object.keys(fields)
			.filter(k => k.startsWith('ext:') && ExternalCatalog.family(k.slice(4)) === 'asin')
			.map(k => k.slice(4)),
	].filter((site, j, all) => all.indexOf(site) === j);

/**
 * @param {Record<string, string>} fields
 * @param {number} i the edition's card
 * @returns {HTMLDivElement[]}
 */
function asinFields(fields, i) {
	const sites = asinSitesOf(fields);
	const more = ExternalCatalog.ASIN_SITES.filter(site => !sites.includes(site));
	return [
		...sites.map(site =>
			buildElement(
				'div',
				{class: 'ef-site'},
				buildElement('label', {}, site),
				buildElement('input', {
					'data-i': i,
					'data-k': 'ext:' + site,
					value: fields['ext:' + site] || '',
					placeholder: EDITION_HINTS.asin,
				}),
			),
		),
		...(more.length
			? [
					buildElement(
						'div',
						{class: 'ef-site'},
						buildElement('label', {}, ' '),
						buildElement(
							'select',
							{'data-add-site': i, 'aria-label': 'Add an ASIN for another site'},
							buildElement('option', {value: ''}, '+ Another site'),
							more.map(site => buildElement('option', {value: site}, site)),
						),
					),
				]
			: []),
	];
}

function renderFormEditions() {
	fillElement(
		byId('f_editions'),
		FORM_EDITIONS.map(({fields, also}, i) =>
			buildElement(
				'div',
				{class: 'editionCard', role: 'group', 'aria-label': `Edition ${i + 1}`},
				buildElement(
					'div',
					{class: 'editionCardHead'},
					buildElement('span', {}, `Edition ${i + 1}`),
					buildElement(
						'button',
						{type: 'button', class: 'removeEdition', 'data-remove': i, title: 'Remove this edition'},
						'Remove',
					),
				),
				also.length > 0 &&
					buildElement(
						'p',
						{class: 'editionAlso'},
						`Also on ${also.join(', ')}: changes here change it there too.`,
					),
				buildElement(
					'div',
					{class: 'editionFields'},
					Edition.FIELDS.map(([k, , label]) =>
						k === 'ext'
							? [
									buildElement(
										'div',
										{class: 'ef-asin', role: 'group', 'aria-label': label},
										buildElement('label', {}, label),
										buildElement('div', {class: 'asinSites'}, asinFields(fields, i)),
									),
									otherCatalogFields(fields, i),
								]
							: buildElement(
									'div',
									{class: `ef-${k}`},
									buildElement('label', {for: `f_e${i}_${k}`}, label),
									editionField(fields, i, k),
								),
					),
				),
			),
		),
	);
}

/**
 * An edition's field for one of its parts; the narrators' and the publisher's offer the names the catalog has.
 * @param {Record<string, string>} fields
 * @param {number} i the edition's card
 * @param {string} k the part
 * @returns {HTMLElement}
 */
function editionField(fields, i, k) {
	const input = /** @type {HTMLInputElement} */ (
		buildElement('input', {
			'data-i': i,
			'data-k': k,
			value: fields[k] || '',
			placeholder: EDITION_HINTS[k],
			id: `f_e${i}_${k}`,
		})
	);
	if (k !== 'n' && k !== 'p') return input;
	const kind = k === 'n' ? 'narrator' : 'publisher';
	return comboField(input, {
		names: () => FORM_NAMES[kind],
		multiple: k === 'n',
		newNote: newNote(kind),
		onPick: value => {
			if (FORM_EDITIONS[i]) FORM_EDITIONS[i].fields[k] = value;
		},
	});
}

comboBox(/** @type {HTMLInputElement} */ (byId('f_a')), byId('f_aList'), {
	names: () => FORM_NAMES.author,
	multiple: true,
	note: byId('f_aNew'),
	newNote: newNote('author'),
});
comboBox(/** @type {HTMLInputElement} */ (byId('f_s')), byId('f_sList'), {
	names: () => FORM_NAMES.series,
	note: byId('f_sNew'),
	newNote: newNote('series'),
});

const editionsEditor = byId('f_editions');
editionsEditor.addEventListener('input', e => {
	// the editor holds only <input>s and <select>s
	const target = /** @type {HTMLInputElement} */ (e.target);
	const {i, k} = target.dataset || {};
	if (k && FORM_EDITIONS[Number(i)]) FORM_EDITIONS[Number(i)].fields[k] = target.value;
});
// "+ Another site" (for an ASIN) or "+ Another catalog": a field for it, ready to type in
editionsEditor.addEventListener('change', e => {
	const target = /** @type {HTMLSelectElement | null} */ (e.target);
	const i = target && target.dataset ? target.dataset.addSite : undefined,
		site = target ? target.value : '';
	if (i === undefined || !site || !FORM_EDITIONS[Number(i)]) return;
	FORM_EDITIONS[Number(i)].fields['ext:' + site] = FORM_EDITIONS[Number(i)].fields['ext:' + site] || '';
	renderFormEditions();
	const input = editionsEditor.querySelector
		? /** @type {HTMLInputElement | null} */ (
				editionsEditor.querySelector(`input[data-i="${i}"][data-k="ext:${site}"]`)
			)
		: null;
	if (input) input.focus();
});
// An address pasted into an id field (an ASIN, Goodreads or Hardcover edition) becomes the id it names
// when the field is left, in the field for it: an Amazon or Audible page's ASIN goes to its site's field,
// which is added when the card has none. When that field holds another id the address stays, and Save says why.
editionsEditor.addEventListener('focusout', e => {
	const event = /** @type {FocusEvent} */ (e);
	const target = /** @type {HTMLInputElement | null} */ (event.target);
	const {i, k} = (target && target.dataset) || {};
	const edition = FORM_EDITIONS[Number(i)];
	if (!target || !k || !edition || !k.startsWith('ext:')) return;
	const found = Edition.idFromAddress(target.value);
	if (!found) return;
	const {field, id} = found,
		there = Text.tidy(edition.fields[field] || '');
	if (field !== k && there && there !== id) return;
	edition.fields[k] = '';
	edition.fields[field] = id;
	if (field === k) {
		target.value = id;
		return;
	}
	target.value = '';
	const input = /** @type {HTMLInputElement | null} */ (
		editionsEditor.querySelector(`input[data-i="${i}"][data-k="${field}"]`)
	);
	if (input) {
		input.value = id;
		return;
	}
	// a field for the address's site: draw the cards again, and keep the focus where it was going
	const next = /** @type {HTMLElement | null} */ (event.relatedTarget);
	const {i: nextI, k: nextK} = (next && next.dataset) || {};
	renderFormEditions();
	const refocus = nextK
		? /** @type {HTMLElement | null} */ (editionsEditor.querySelector(`[data-i="${nextI}"][data-k="${nextK}"]`))
		: null;
	if (refocus) refocus.focus();
});
editionsEditor.addEventListener('click', e => {
	const target = /** @type {Element | null} */ (e.target);
	// only the edition cards' Remove buttons have data-remove
	const btn = target && target.closest ? /** @type {HTMLElement | null} */ (target.closest('[data-remove]')) : null;
	if (!btn) return;
	FORM_EDITIONS.splice(Number(btn.dataset.remove), 1);
	if (!FORM_EDITIONS.length) FORM_EDITIONS.push({fields: {}, also: []});
	renderFormEditions();
});
byId('addEditionBtn').addEventListener('click', () => {
	FORM_EDITIONS.push({fields: {}, also: []});
	renderFormEditions();
	// the new card's first field, its description
	const input = editionsEditor.querySelector
		? /** @type {HTMLInputElement | null} */ (
				editionsEditor.querySelector(`input[data-i="${FORM_EDITIONS.length - 1}"][data-k="desc"]`)
			)
		: null;
	if (input) input.focus();
});

/**
 * The editions in the form, as {editions, bad (e.g. "edition 2: Released 2021-13"), book (the book's
 * external ids, from a book's address pasted in an edition's field)}.
 * @returns {{editions: Edition[], bad: string[], book: Record<string, string>}}
 */
function readFormEditions() {
	/** @type {Edition[]} */
	const editions = [];
	/** @type {string[]} */
	const bad = [];
	/** @type {Record<string, string>} */
	const book = {};
	FORM_EDITIONS.forEach(({fields, id}, i) => {
		const read = Edition.fromFields(fields);
		// the edition keeps its id (several ISBNs make more editions, which are new)
		if (read.editions.length) read.editions[0].id = id;
		editions.push(...read.editions);
		bad.push(...read.bad.map(x => `edition ${i + 1}: ${x}`));
		for (const [catalog, x] of Object.entries(read.book)) if (!book[catalog]) book[catalog] = x;
	});
	return {editions, bad, book};
}

// The Hardcover book field also takes the address of the book's or an edition's page on hardcover.app (the
// app shows no ids), which Hardcover turns into the book's id. Returns the id, or null when it was not
// found (the form says why); for anything else (an id, nothing, not an address) what was typed.
/** @typedef {Promise<string | null> & {text?: string}} HardcoverLookup a lookup, with the text it looks up */
/** @type {HardcoverLookup | null} */
let HARDCOVER_LOOKUP = null; // the field's lookup on its way, as a promise
/** @returns {Promise<string | null>} */
function resolveHardcoverField() {
	const field = fieldById('f_hcb'),
		text = field.value.trim();
	if (!HardcoverClient.parseUrl(text)) return Promise.resolve(text);
	if (HARDCOVER_LOOKUP && HARDCOVER_LOOKUP.text === text) return HARDCOVER_LOOKUP;
	// declared first, as the lookup's own finally compares with it (which runs after an await, once it is assigned)
	/** @type {HardcoverLookup | null} */
	let lookup = null;
	lookup = (async () => {
		try {
			const found = await lookupHardcoverBook(text);
			if (field.value.trim() === text) field.value = found.id;
			byId('formError').textContent = '';
			if (found.title) showIoStatus(`Found on Hardcover: ${found.title} (book ${found.id}).`);
			return found.id;
		} catch (err) {
			byId('formError').textContent =
				`Couldn't find the Hardcover book: ${Text.errorText(err)}. ` +
				'Paste the address of its page, or of one of its editions, on hardcover.app, or the number in hardcover.app/id/book/12345.';
			return null;
		} finally {
			if (HARDCOVER_LOOKUP === lookup) HARDCOVER_LOOKUP = null;
		}
	})();
	lookup.text = text;
	HARDCOVER_LOOKUP = lookup;
	return lookup;
}
byId('f_hcb').addEventListener('change', () => {
	resolveHardcoverField();
});
// the book's ids in external catalogs other than Hardcover (whose field looks the book up)
fillElement(byId('f_bookExt'), externalFields('f_ext_', 'book', ['hardcover']));

// Fill in from another catalog: the book a pasted address, id or ISBN names, looked up in the catalogs a page
// may read (catalog-lookup.js), fills in the form's empty fields only, so nothing typed is lost.
/** @type {string | null} */
let FILLING = null; // what is being looked up, so pressing again doesn't ask twice
export async function fillFromCatalog() {
	const field = fieldById('f_from'),
		text = field.value.trim();
	if (!text || FILLING === text) return;
	FILLING = text;
	const editing = EDIT_ID;
	showIoStatus('Looking it up…');
	try {
		const proxy = browserProxy();
		const found = await new CatalogLookup(
			url => fetch(url),
			keyedClients(),
			proxy ? route => fetchViaProxy(route, proxy) : null,
		).find(text, Text.splitNames(fieldById('f_a').value));
		// the form was closed, or moved to another book, meanwhile
		if (EDIT_ID !== editing || !byId('addForm').classList.contains('open')) return;
		const filled = fillForm(found.book);
		byId('formError').textContent = '';
		const from = found.sources.join(' and ');
		const notes = found.notes.length ? ` (${found.notes.join('; ')}.)` : '';
		showIoStatus(
			spell(
				filled.length
					? `Filled in from ${from}: ${filled.join(', ')}.${notes}`
					: `Found on ${from}, but the form already has all it gives.${notes}`,
			),
		);
		if (field.value.trim() === text) field.value = '';
	} catch (err) {
		showIoStatus('');
		byId('formError').textContent = `Couldn't fill in the book: ${Text.errorText(err)}.`;
	} finally {
		if (FILLING === text) FILLING = null;
	}
}
byId('fillFromBtn').addEventListener('click', () => {
	fillFromCatalog();
});
// Enter looks it up, rather than saving the book
byId('f_from').addEventListener('keydown', e => {
	const event = /** @type {KeyboardEvent} */ (e);
	if (event.key !== 'Enter') return;
	event.preventDefault();
	fillFromCatalog();
});

/**
 * Put what the catalog has for a book in the form's empty fields; returns what was filled in ("title", "an edition").
 * @param {Book} b
 * @returns {string[]}
 */
function fillForm(b) {
	/** @type {string[]} */
	const filled = [];
	/** @type {(id: string, value: string, label: string) => void} */
	const put = (id, value, label) => {
		const f = fieldById(id);
		if (value && !f.value.trim()) {
			f.value = value;
			filled.push(label);
		}
	};
	put('f_t', b.title, 'title');
	put('f_a', b.authors.join(', '), 'authors');
	// the number only goes with its own series
	const series = fieldById('f_s').value.trim();
	put('f_s', b.series || '', 'series');
	if (!series || series === b.series) put('f_sn', b.number || '', 'number in the series');
	put('f_g', b.genres.join(', '), 'genres');
	let ids = 0;
	for (const [key, id] of Object.entries(b.external)) {
		const g = ExternalCatalog.groupOf(key);
		const field =
			key === 'hardcover'
				? fieldById('f_hcb')
				: g && document.getElementById('f_ext_' + g.key)
					? fieldById('f_ext_' + g.key)
					: null;
		if (!field || field.value.trim()) continue;
		field.value = key === 'hardcover' || !g ? id : ExternalCatalog.fieldText({[key]: id}, 'book', g.key);
		ids++;
	}
	if (ids) {
		filled.push(ids === 1 ? "the book's id in another catalog" : "the book's ids in other catalogs");
		const keys = ExternalCatalog.GROUPS.filter(g => {
			const f = document.getElementById(g.key === 'hardcover' ? 'f_hcb' : 'f_ext_' + g.key);
			return f && /** @type {HTMLInputElement} */ (f).value.trim();
		});
		byId('f_idsNote').textContent = '(' + keys.map(g => g.name).join(', ') + ')';
	}
	const [ed] = b.editions;
	if (ed && fillFormEdition(ed)) filled.push('an edition');
	return filled;
}

/**
 * Put an edition in the form: in the gaps of the card that is the same edition (it shares an id with it, an ASIN
 * on any site, or its ISBN), else of the first card that has nothing else in its fields, else on a card of its own.
 * Returns whether anything was filled in.
 * @param {Edition} ed
 * @returns {boolean}
 */
function fillFormEdition(ed) {
	const fields = ed.fields();
	/** @type {(card: Record<string, string>, k: string) => string} */
	const has = (card, k) => Text.tidy(card[k] || '');
	/** @type {(c: {fields: Record<string, string>}) => Edition | undefined} */
	const editionOf = c => Edition.fromFields(c.fields).editions[0];
	let card =
		FORM_EDITIONS.find(c => editionOf(c)?.sharesId(ed)) ||
		FORM_EDITIONS.find(c => editionOf(c)?.sameAs(ed)) ||
		FORM_EDITIONS.find(c =>
			Object.entries(fields).every(([k, v]) => !has(c.fields, k) || has(c.fields, k) === Text.tidy(v)),
		);
	if (!card) {
		card = {fields: {}, also: []};
		FORM_EDITIONS.push(card);
	}
	let gained = false;
	for (const [k, v] of Object.entries(fields)) {
		if (v && !has(card.fields, k)) {
			card.fields[k] = v;
			gained = true;
		}
	}
	renderFormEditions();
	return gained;
}

byId('addForm').addEventListener('submit', async e => {
	e.preventDefault();
	if (HardcoverClient.parseUrl(fieldById('f_hcb').value)) {
		// look the address up first, unless the form was closed or moved to another book meanwhile
		const editing = EDIT_ID;
		const id = await resolveHardcoverField();
		if (id === null || EDIT_ID !== editing || !byId('addForm').classList.contains('open')) return;
	}
	// the book being edited may have been removed in another tab meanwhile
	const editing = EDIT_ID === null ? null : CATALOG.book(EDIT_ID) || null;
	if (EDIT_ID !== null && !editing) {
		closeForm();
		return;
	}
	const b = new Book({
		id: editing ? editing.id : undefined, // an edited book stays the record it was
		title: fieldById('f_t').value.trim(),
		authors: Text.splitNames(fieldById('f_a').value),
		genres: fieldById('f_g')
			.value.split(',')
			.map(x => x.trim())
			.filter(Boolean),
	});
	const s = fieldById('f_s').value.trim();
	if (s) b.series = s;
	const sn = fieldById('f_sn').value.trim();
	if (sn) b.number = sn;
	if (!b.title || !b.authors.length) return;
	const {dates, bad} = Text.parseDates(fieldById('f_r').value);
	if (bad.length) {
		byId('formError').textContent =
			`Not a date: ${bad.join(', ')}. Use YYYY-MM-DD, or YYYY-MM / YYYY if you don't remember the day.`;
		return;
	}
	b.read = dates;
	const {editions, bad: badParts, book: fromEditions} = readFormEditions();
	const hardcover = fieldById('f_hcb').value.trim() || fromEditions.hardcover;
	if (hardcover && !ExternalCatalog.isId('hardcover', 'book', hardcover)) {
		/** @type {HTMLDetailsElement} */ (byId('f_ids')).open = true;
		byId('formError').textContent =
			`Not a Hardcover book id: ${hardcover}. It is the number in hardcover.app/id/book/12345, or paste the address of the book's page on hardcover.app in the Hardcover book field.`;
		return;
	}
	// the book's other external ids (Goodreads' book), from their fields or a book's address in an edition's
	const had = editing ? editing.external : {};
	const external = readExternalFields('f_ext_', 'book', had);
	if (external.bad.length) {
		/** @type {HTMLDetailsElement} */ (byId('f_ids')).open = true;
		byId('formError').textContent = `Not a book's id or address there: ${external.bad.join('; ')}.`;
		return;
	}
	b.external = {...fromEditions, ...external.ids};
	delete b.external.hardcover;
	if (hardcover) b.external.hardcover = hardcover;
	// "book #0 ('Title') edition #2: needs an ..." -> "edition #2: needs an ..."
	const problems = (
		editions.length
			? Validator.validate([{t: b.title, a: b.authors, e: JSON.parse(JSON.stringify(editions))}], {}).errors
			: []
	).map(e => (e.includes(' edition #') ? e.slice(e.indexOf(' edition #') + 1) : e));
	if (badParts.length || problems.length) {
		byId('formError').textContent = badParts.length
			? `Not understood: ${badParts.join('; ')}. A Goodreads or Hardcover id is a number, an ISBN 10 or 13 digits, Released e.g. 2021-05, Length e.g. 10h 42m.`
			: problems.join('; ');
		return;
	}
	b.editions = editions;

	// editing an edition a box set shares with other books edits it there too, so those books are loaded first
	const keys = [...new Set(editions.flatMap(ed => ed.idAndIsbnKeys()))];
	if (keys.length) await loadRecords({editionKeys: keys});
	if (EDIT_ID !== null && !CATALOG.book(EDIT_ID)) {
		closeForm();
		return;
	}
	const added = newEntries(b);
	const others = CATALOG.saveBook(EDIT_ID, b);
	closeForm();
	// a book added: its page shows it, in place of the empty form (so Back doesn't open that again)
	if (ADDING) {
		ADDING = null;
		BOOK_FILTER = /** @type {string} */ (b.id);
		setAddress('replace', addressNow());
	}
	render();
	persist();
	refreshView();
	const news = added.length ? ` New in the catalog: ${added.join(', ')}.` : '';
	if (others) showIoStatus(`Also updated the shared edition on ${Text.plural(others, 'other book')}.${news}`);
	else if (!editing) showIoStatus(`Added ${b.title}.${news}`);
	else if (news) showIoStatus(`Saved ${b.title}.${news}`);
});

/**
 * After a save took in what another tab changed (store.js): the book being edited stays open unless the
 * other tab removed it.
 * @param {Book[]} before the books as they were
 */
function redraw(before) {
	if (EDIT_ID !== null && !CATALOG.book(EDIT_ID)) {
		const b = before.find(x => x.id === EDIT_ID);
		closeForm();
		showIoStatus(spell(`${b ? b.title : 'The book'} was removed in another tab.`), true);
	}
	refreshView();
}

// The book in the address (a link, a bookmark, or Back from another page), or the form for a new one.
export const READY = startPage(
	async () => {
		const st = stateFromHash(location.hash);
		BOOK_FILTER = st.book;
		ADDING = st.adding;
		setAddress('replace', addressNow());
		await afterSaving(async () => {
			await loadView();
			render();
		});
		if (ADDING) openAddForm();
	},
	{refresh: redraw},
);
