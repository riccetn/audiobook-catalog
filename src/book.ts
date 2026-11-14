// A book's page (book.html#book=<id>): everything about the book, its + Read today, and its Edit (the Edit
// page, edit.html#book=<id>) and Merge. Adding a book is the Edit page's too (edit.html#add), where an address
// from before (book.html#add) goes. The covers and links are book-list.ts's; loading and saving live in store.ts.
import {Text} from './modules/text.js';
import {Edition} from './modules/edition.js';
import {Book} from './modules/book.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {
	CATALOG,
	persist,
	loadRecords,
	queryCatalog,
	storedBookId,
	afterSaving,
	startPage,
	publisherPageHref,
	bookPageHref,
	seriesPageHref,
	editPageHref,
} from './store.js';
import {showIoStatus, byId, spell, spellParts, buildElement, fillElement, joined} from './dom.js';
import {webLinks} from './id-fields.js';
import type {Child} from './dom.js';
import {
	authorLinks,
	nameLinks,
	narratorLinks,
	bookNarrators,
	coverImage,
	hashParts,
	hashText,
	hashOf,
	setAddress,
	alsoPublishedAs,
} from './book-list.js';

// Books and series are known by the ids they are stored under, so a book retitled (here or in another tab)
// is still the one shown or edited.
export let BOOK_FILTER: string | null = null; // the id of the book shown (#book=...), or null
let MERGE_SEARCH: {id: string; q: string; found: string[]; more: number} | null = null; // the book whose Merge was pressed, what was typed to find the other one, and the books found

/**
 * Show what BOOK_FILTER says, once the saves asked for are done and it is read (again, after an
 * edit, or another tab's).
 * @returns once it is drawn
 */
export function refreshView(): Promise<void> {
	return afterSaving(async () => {
		await loadView();
		render();
	});
}

/**
 * Read what the page shows from the stored catalog: the book (and the other books sharing an edition with
 * it, a box set's).
 */
async function loadView(): Promise<void> {
	await resolveAddress();
	if (BOOK_FILTER === null) return;
	await loadRecords({books: [BOOK_FILTER]});
	const b = CATALOG.book(BOOK_FILTER);
	const keys = b ? [...new Set(b.editions.flatMap(ed => ed.idAndIsbnKeys()))] : [];
	if (keys.length) await loadRecords({editionKeys: keys});
}

/**
 * A book named in the address the way addresses had it before (by its title): the id it is stored under,
 * put in the address instead.
 */
async function resolveAddress(): Promise<void> {
	if (BOOK_FILTER === null) return;
	const text = BOOK_FILTER;
	const id = (await storedBookId(text)) ?? text;
	if (id !== text) {
		BOOK_FILTER = id;
		setAddress('replace', addressNow());
	}
}

export function render() {
	const shown = CATALOG.book(BOOK_FILTER);
	// a book in a series links back to it
	const series = shown && shown.series && CATALOG.idFor('series', shown.series);
	const label = shown ? shown.title : spell('No such book');
	fillElement(
		byId('crumbLabel'),
		shown && series
			? [buildElement('a', {href: seriesPageHref(series)}, shown.series as string), ' › ', label]
			: label,
	);
	document.title = spell('{page} — Audiobook Catalog', {page: label});
	SHARED = sharedEditions();
	fillElement(
		byId('results'),
		shown
			? bookDetails(shown)
			: buildElement(
					'p',
					{class: 'empty'},
					spellParts('This book is not in the catalog. {all}', {
						all: buildElement('a', {href: 'books.html'}, spell('All books')),
					}),
				),
	);
}

// ------------------------------------------------------------------ the address
// #book=<id> shows a book, by the id it is stored under, so a link holds when the book is retitled (an
// address from before, with its title, is still understood). #add, from when this page added books, goes to
// the Edit page, which does (with its &series=<id> and &author=<name>).

/** The address's #... -> the book it shows. */
function bookFromHash(hash: string | null): string | null {
	return hashText(hashParts(hash), 'book') || null;
}

/** @returns the address of what is shown now */
function addressNow(): string {
	return hashOf([['book', BOOK_FILTER || '']]);
}

/** Whether the address is one from when this page added books (#add), which the Edit page does now. */
function movedAddress(): boolean {
	if (!hashParts(location.hash).has('add')) return false;
	location.replace('edit.html' + location.hash);
	return true;
}

// Back and forward (and a link to another book, a box set's): show what the address says, from the top of
// the page when it is another book.
function showAddress() {
	if (movedAddress()) return;
	const book = bookFromHash(location.hash);
	if (book === BOOK_FILTER) return refreshView();
	MERGE_SEARCH = null;
	BOOK_FILTER = book;
	if (typeof scrollTo === 'function') scrollTo(0, 0);
	return afterSaving(async () => {
		await loadView();
		render();
	});
}
addEventListener('popstate', showAddress);
addEventListener('hashchange', () => {
	if (addressNow() !== location.hash) showAddress();
});

// ------------------------------------------------------------------ the book's details
// Edition object -> the other books it is also on (a box set), for the book shown.
let SHARED: Map<Edition, Book[]> = new Map();

function sharedEditions(): Map<Edition, Book[]> {
	const byKey: Map<string, [Book, Edition][]> = new Map();
	CATALOG.books.forEach(b =>
		b.editions.forEach(ed =>
			ed.idAndIsbnKeys().forEach(k => {
				let list = byKey.get(k);
				if (!list) byKey.set(k, (list = []));
				list.push([b, ed]);
			}),
		),
	);
	const shared: Map<Edition, Book[]> = new Map();
	CATALOG.books.forEach(b =>
		b.editions.forEach(ed => {
			const others: Set<Book> = new Set();
			for (const k of ed.idAndIsbnKeys())
				for (const [other, x] of byKey.get(k) || []) if (other !== b && x.sameAs(ed)) others.add(other);
			if (others.size) shared.set(ed, [...others]);
		}),
	);
	return shared;
}

/**
 * An id, linking to its page in its external catalog (ExternalCatalog.url); just the id when there is none.
 */
const idLink: (catalog: string, kind: 'book' | 'edition', id: string) => Child = (catalog, kind, id) => {
	const url = ExternalCatalog.url(catalog, kind, id);
	return url ? buildElement('a', {href: url, target: '_blank', rel: 'noopener'}, id) : id;
};

/**
 * An edition's parts as a details list's rows (Edition.parts()), with each ASIN linking to the book on its
 * site, and its other external ids to the book there (Hardcover's links by id keep working when it renames
 * the book); its description heads it instead.
 */
function editionRows(ed: Edition): [string, Child][] {
	const asins = () =>
		joined(
			ed.asinList().map(([site, asin]) => [site + ' ', idLink(site, 'edition', asin)]),
			', ',
		);
	return ed
		.parts()
		.filter(([k]) => k !== 'desc')
		.map(([k, label, value]) => [
			spell(label),
			k === 'asin'
				? asins()
				: k === 'n'
					? narratorLinks(ed.narrators)
					: k === 'p'
						? nameLinks(ed.publishers, publisherPageHref)
						: k === 'links'
							? joined(webLinks(ed.links, 'weblink'), ' ')
							: k.startsWith('ext:')
								? idLink(k.slice(4), 'edition', value)
								: value,
		]);
}

/**
 * A details list (dl) of the rows that have a value.
 */
function detailList(rows: [string, Child | false | undefined][]): HTMLElement {
	return buildElement(
		'dl',
		{class: 'details'},
		rows
			.filter(([, value]) => value)
			.map(([label, value]) => [buildElement('dt', {}, label), buildElement('dd', {}, value)]),
	);
}

/**
 * A book's Edit and Merge, under its details: viewing a book comes first, so they come last. Edit opens the
 * Edit page for the book; Merge opens a search for the other book (mergeSearch).
 * @param id the book's
 */
function bookActions(id: string): Child[] {
	const searching = MERGE_SEARCH?.id === id;
	return [
		buildElement(
			'div',
			{class: 'book-actions'},
			buildElement('a', {class: 'edit', href: editPageHref(id, 'book')}, spell('Edit')),
			buildElement(
				'button',
				{
					type: 'button',
					class: 'merge',
					'aria-expanded': String(searching),
					onclick: () => toggleMergeSearch(id),
				},
				spell('Merge'),
			),
		),
		searching && mergeSearch(id),
	];
}

/**
 * Merge's search for the book to merge with: what is typed finds books as the books page's search does, and
 * each found links to the duplicates page with the two (which checks they are still the same books).
 * @param id the book's
 */
function mergeSearch(id: string): HTMLDivElement {
	const q = MERGE_SEARCH ? MERGE_SEARCH.q : '';
	return buildElement(
		'div',
		{class: 'mergeSearch'},
		buildElement('label', {for: 'mergeQuery'}, spell('Find the book to merge it with')),
		buildElement('input', {
			type: 'search',
			id: 'mergeQuery',
			value: q,
			placeholder: spell('Title, author, series or ISBN'),
			autocomplete: 'off',
			oninput: (e: Event) => findMergeBooks(id, (e.currentTarget as HTMLInputElement).value),
		}),
		buildElement('ul', {class: 'mergeFound', id: 'mergeFound'}, mergeFoundItems(id)),
	);
}

/**
 * The books Merge's search found, each a link to merging it with book `id`.
 * @param id the book's
 */
function mergeFoundItems(id: string): Child[] {
	if (!MERGE_SEARCH || !MERGE_SEARCH.q.trim()) return [];
	const found = MERGE_SEARCH.found.map(other => CATALOG.book(other)).filter(Boolean) as Book[];
	if (!found.length) return [buildElement('li', {class: 'none'}, spell('No other book matches.'))];
	return [
		...found.map(b =>
			buildElement(
				'li',
				{},
				buildElement(
					'a',
					{
						href: 'duplicates.html#merge=' + [id, b.id as string].map(encodeURIComponent).join(','),
					},
					b.title,
				),
				b.series && ` (${b.series}${b.number ? ' #' + b.number : ''})`,
				b.authors.length > 0 && ' — ' + Text.namesText(b.authors),
			),
		),
		MERGE_SEARCH.more > 0 &&
			buildElement(
				'li',
				{class: 'none'},
				spell('and {count} more; type more to narrow it down.', {count: MERGE_SEARCH.more}),
			),
	];
}

/**
 * Merge on a book's details: opens the search for the book to merge it with, or closes it.
 * @param id the book's
 */
export function toggleMergeSearch(id: string) {
	MERGE_SEARCH = MERGE_SEARCH?.id === id ? null : {id, q: '', found: [], more: 0};
	render();
	if (MERGE_SEARCH) byId('mergeQuery').focus();
}

// How many books Merge's search lists at most.
const MERGE_FOUND_MAX = 20;

/**
 * Find the books matching `q` for Merge's search, from the stored catalog as the books page's search does,
 * and show them; a search typed over meanwhile is dropped.
 * @param id the book being merged
 */
export async function findMergeBooks(id: string, q: string): Promise<void> {
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
 */
function bookDetails(b: Book): HTMLDivElement {
	const id = b.id as string;
	const series = b.series && CATALOG.idFor('series', b.series);
	const editions = b.editions.map((ed, i) => {
		const also = (SHARED.get(ed) || []).map(other =>
			buildElement(
				'a',
				{href: bookPageHref(other.id as string)},
				other.title + (other.number ? ` #${other.number}` : ''),
			),
		);
		return buildElement(
			'div',
			{class: 'edition'},
			buildElement(
				'h3',
				{},
				b.editions.length > 1 ? spell('Edition {n}', {n: i + 1}) : spell('Edition'),
				ed.description && ': ' + ed.description,
			),
			detailList([...editionRows(ed), [spell('Also in this edition'), also.length > 0 && joined(also, ', ')]]),
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
			alsoPublishedAs(b.alternativeTitles(ed => SHARED.has(ed))),
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
					spell('Series'),
					series && [
						buildElement('a', {href: seriesPageHref(series)}, b.series),
						b.number && ` #${b.number}`,
					],
				],
				[
					spell('Read'),
					[
						b.read.length > 0 && b.read.join(', ') + ' ',
						!b.read.includes(Text.today()) &&
							buildElement(
								'button',
								{type: 'button', class: 'readToday', onclick: () => readToday(id)},
								spell('+ Read today'),
							),
					],
				],
				[
					spell('Genres'),
					b.genres.length > 0 &&
						buildElement(
							'span',
							{class: 'genres'},
							b.genres.map(g => buildElement('span', {class: 'tag'}, g)),
						),
				],
				...Object.entries(ExternalCatalog.order(b.external) || {}).map(
					([key, value]) =>
						[spell('{site} book', {site: ExternalCatalog.name(key)}), idLink(key, 'book', value)] as [
							string,
							Child,
						],
				),
				[
					spell(b.links.length > 1 ? 'Links' : 'Link'),
					b.links.length > 0 && joined(webLinks(b.links, 'weblink'), ' '),
				],
			]),
			editions,
			bookActions(id),
		),
	);
}

/**
 * Add today to a book's dates read, from its details, with an Undo.
 * @param id the book's
 */
export function readToday(id: string) {
	const b = CATALOG.book(id);
	if (!b || b.read.includes(Text.today())) return;
	const before = b.read;
	b.read = [...b.read, Text.today()].sort();
	render();
	persist();
	refreshView();
	showIoStatus(spell('Read {title} today.', {title: b.title}), false, () => {
		const now = CATALOG.book(id);
		if (!now) return;
		now.read = before;
		render();
		persist();
		refreshView();
	});
}

/** After a save took in what another tab changed (store.ts): the page shows the book as stored now. */
function redraw() {
	refreshView();
}

// The book in the address (a link, a bookmark, or Back from another page).
export const READY = startPage(
	async () => {
		if (movedAddress()) return;
		BOOK_FILTER = bookFromHash(location.hash);
		setAddress('replace', addressNow());
		await afterSaving(async () => {
			await loadView();
			render();
		});
	},
	{refresh: redraw},
);
