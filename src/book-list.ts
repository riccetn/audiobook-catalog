// What the series page (index.html, series.ts), the books page (books.html, books.ts) and a book's page
// (book.html, book.ts) share: the book cards and covers, the lists of books grouped by series, the links
// on them, and the reminder of the last backup.
import {Text} from './modules/text.js';
import {Book} from './modules/book.js';
import type {Edition} from './modules/edition.js';
import {Series} from './modules/series.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {Cover} from './modules/cover.js';
import type {CoverSize} from './modules/cover.js';
import type {CatalogReader} from './modules/catalog-database.js';
import {
	CATALOG,
	backupAge,
	needsBackup,
	loadRecords,
	byId,
	spell,
	buildElement,
	fillElement,
	joined,
	authorPageHref,
	narratorPageHref,
	externalLinks,
	bookPageHref,
	seriesPageHref,
	hashValue,
} from './store.js';
import type {Child} from './store.js';

// How many books a list draws at a time; Show more draws more.
const PAGE_SIZE = 50;
// The series filter's value for the books in no series.
export const STANDALONE = '__standalone__';

/**
 * Names, each a link to the address `href` gives it, joined with commas.
 */
export const nameLinks: (names: string[], href: (name: string) => string) => Child[] = (names, href) =>
	joined(
		names.map(x => buildElement('a', {href: href(x)}, x)),
		', ',
	);
/**
 * Authors' names, each a link to their page.
 */
export const authorLinks: (names: string[]) => Child[] = names => nameLinks(names, authorPageHref);
/**
 * Narrators' names, each a link to their page.
 */
export const narratorLinks: (names: string[]) => Child[] = names => nameLinks(names, narratorPageHref);
/**
 * A series' status, as a tag.
 */
export const statusTag: (status: string | undefined) => HTMLSpanElement = status =>
	buildElement('span', {class: `status ${status}`}, status === 'complete' ? 'complete' : 'ongoing');
/** the series' pages in external catalogs */
export const seriesLinks: (info: Series) => Child[] = info => externalLinks(info.external, 'series').map(a => [' ', a]);
/**
 * A series' released total as its info has it (as typed, should it not be a number).
 */
export const totalText = (info: Series): string => String(info.toJSON().total ?? '');

/**
 * A series' books by number, unnumbered ones first, and its collections (box sets, "1-3") last.
 */
function seriesOrder(a: Book, b: Book): number {
	const last = (x: Book) => (Series.range(x.number) || [0, 0])[1];
	return (
		Number(a.isCollection()) - Number(b.isCollection()) ||
		(parseFloat(a.number || '') || 0) - (parseFloat(b.number || '') || 0) ||
		last(a) - last(b)
	);
}

/**
 * "3 owned + 1 box set": a box set kept as its own book is not one more title.
 */
function ownedText(books: Book[]): string {
	const sets = books.filter(b => b.isCollection()).length;
	return `${Series.owned(books)} owned` + (sets ? ` + ${Text.plural(sets, 'box set')}` : '');
}

/**
 * The narrators of all of a book's editions, each edition's together ("Ann Vale, Bo Reed / Cy Hale").
 */
export function bookNarrators(b: Book): Child {
	const narrators = [
		...new Map(
			b.editions.filter(ed => ed.narrators.length).map(ed => [Text.namesText(ed.narrators), ed.narrators]),
		).values(),
	];
	return narrators.length > 0 && ['narr. ', joined(narrators.map(narratorLinks), ' / ')];
}

// Covers come from Amazon and Open Library, which then learn the ids asked for, so they can be turned off;
// the choice is this browser's.
const COVERS_KEY = 'audiobook-catalog-covers';
/** @returns whether books show their covers (they do unless turned off) */
function coversShown(): boolean {
	try {
		return localStorage.getItem(COVERS_KEY) !== 'off';
	} catch {
		return true;
	}
}

/**
 * The Covers box of a list: ticked as the choice is, which it changes, and then the list is drawn again.
 */
export function watchCoversBox(redraw: () => void) {
	const box = byId('showCovers') as HTMLInputElement;
	box.checked = coversShown();
	box.addEventListener('change', () => {
		try {
			localStorage.setItem(COVERS_KEY, box.checked ? 'on' : 'off');
		} catch {
			/* the choice holds on this page, just not the next time */
		}
		redraw();
	});
}

/**
 * A book's cover, trying each address Cover.addresses gives until one loads; hidden until then, and for good
 * when none does. Nothing when covers are off or its editions have no id a cover can be found by.
 */
export function coverImage(b: Book, size: CoverSize): HTMLImageElement | null {
	const addresses = coversShown() ? Cover.addresses(b, size) : [];
	if (!addresses.length) return null;
	let at = 0;
	const next = () => {
		if (++at < addresses.length) img.setAttribute('src', addresses[at]);
		else img.classList.add('missing');
	};
	const img = buildElement('img', {
		class: `cover ${size}`,
		src: addresses[0],
		alt: '',
		loading: 'lazy',
		decoding: 'async',
		referrerpolicy: 'no-referrer',
		onload: () => {
			if (Cover.isCover(img.naturalWidth, img.naturalHeight)) img.classList.add('loaded');
			else next();
		},
		onerror: next,
	}) as HTMLImageElement;
	return img;
}

/**
 * "Also published as The Keeper of Lanterns, Lanterns in the Dark": the titles a book's editions were
 * released under besides its own (Book.alternativeTitles), or nothing when there are none.
 */
export function alsoPublishedAs(titles: string[]): HTMLDivElement | false {
	return (
		titles.length > 0 &&
		buildElement(
			'div',
			{class: 'alsoTitled'},
			'Also published as ',
			joined(
				titles.map(t => buildElement('cite', {}, t)),
				', ',
			),
		)
	);
}

/**
 * A book in a list: only what tells it apart (its title, authors, narrators and when it was read); its
 * title links to its page. `withSeries` names its series too, in a list not grouped by series. When the
 * search `q` finds it by a title one of its editions was released under, that title is shown too.
 * @param q what was searched for
 * @param shared Book.sharedEditionTest() of the books listed
 */
function bookCard(
	b: Book,
	withSeries: boolean = false,
	q: string = '',
	shared: (ed: Edition) => boolean = () => false,
): HTMLDivElement {
	const id = b.id as string;
	const wanted = q.trim().toLowerCase();
	const foundBy = wanted
		? b
				.alternativeTitles(shared)
				.filter(t => t.toLowerCase().includes(wanted) && !b.title.toLowerCase().includes(wanted))
		: [];
	return buildElement(
		'div',
		{class: 'book', 'data-id': id},
		buildElement('div', {class: 'num'}, b.number || '•'),
		coverImage(b, 'small'),
		buildElement(
			'div',
			{class: 'info'},
			buildElement('div', {class: 'title'}, buildElement('a', {href: bookPageHref(id)}, b.title)),
			alsoPublishedAs(foundBy),
			withSeries &&
				b.series &&
				buildElement(
					'div',
					{class: 'meta'},
					buildElement('a', {href: seriesPageHref(CATALOG.idFor('series', b.series))}, b.series),
					b.number && ` #${b.number}`,
				),
			buildElement(
				'div',
				{class: 'meta'},
				joined([authorLinks(b.authors), bookNarrators(b)].filter(Boolean), ' — '),
			),
			b.read.length > 0 && buildElement('div', {class: 'read'}, 'Read ' + b.read.join(', ')),
		),
	);
}

/**
 * The ids of the books in a list, in the order it shows them: the series by name, each in reading order
 * (box sets last), then the books in no series by title; only `series`' (a series' id, or STANDALONE), and
 * only those in `only`, when given. Only the indexes' keys are read, not the books.
 */
export async function readOrdered(
	r: CatalogReader,
	series: string | null,
	only: Set<string> | null = null,
): Promise<string[]> {
	const names: Map<string, string> = new Map(
		(await r.indexKeys('series', 'name')).map(([name, id]) => [String(id), String(name)]),
	);
	const numbered = (n: unknown) => (n === CatalogRecords.UNNUMBERED ? 0 : Number(n));
	const inSeries =
		series === STANDALONE
			? []
			: (await r.indexKeys('books', 'bySeries'))
					.map(([key, id]) => ({id: String(id), key: key as any[]}))
					.filter(x => series === null || x.key[0] === series);
	// as seriesOrder() puts a series' books
	inSeries.sort(
		(x, y) =>
			(names.get(x.key[0]) || '').localeCompare(names.get(y.key[0]) || '') ||
			(x.key[0] < y.key[0] ? -1 : x.key[0] > y.key[0] ? 1 : 0) ||
			x.key[1] - y.key[1] ||
			numbered(x.key[2]) - numbered(y.key[2]) ||
			numbered(x.key[3]) - numbered(y.key[3]),
	);
	const standalone =
		series === null || series === STANDALONE
			? (await r.indexKeys('books', 'standalone')).map(([, id]) => String(id))
			: [];
	const ids = [...inSeries.map(x => x.id), ...standalone];
	return only ? ids.filter(id => only.has(id)) : ids;
}

/**
 * The books a list shows, by id in the order it shows them (`ids`), of which the first `showing` are loaded
 * (each with every book of its series, as the series' heading counts them) and drawn.
 */
export class BookList {
	ids: string[];
	showing: number;
	together: () => boolean;

	/** @param together whether a series' books stay together, so one isn't split between two pages */
	constructor(together: () => boolean) {
		this.ids = [];
		this.showing = 0;
		this.together = together;
	}

	/**
	 * List `ids`, loading the first of them: at least `showing`, so a redraw after an edit shows as many as before.
	 */
	async show(ids: string[], showing: number = 0): Promise<void> {
		this.ids = ids;
		this.showing = 0;
		await this.more(Math.max(showing, PAGE_SIZE));
	}

	/**
	 * Load `count` more of the books listed, or a few more, so a series' books aren't split between two pages.
	 */
	async more(count: number = PAGE_SIZE): Promise<void> {
		const listed = this.ids;
		let end = Math.min(listed.length, this.showing + count);
		const ids = listed.slice(this.showing, end);
		await loadRecords({books: ids});
		const seriesOf: (id: string) => string | undefined = id => {
			const b = CATALOG.book(id);
			return b && b.series;
		};
		const series = [...new Set(ids.map(seriesOf))]
			.filter(x => x !== undefined)
			.map(name => CATALOG.nameIds.series.get(name as string));
		if (series.length) await loadRecords({seriesBooks: series.filter(Boolean) as string[]});
		// the rest of the last series shown, which is loaded now
		const last = ids.length ? seriesOf(ids[ids.length - 1]) : undefined;
		while (this.together() && last !== undefined && end < listed.length && seriesOf(listed[end]) === last) end++;
		this.showing = end;
	}

	/** @returns how many books listed are not shown yet */
	get rest(): number {
		return this.ids.length - this.showing;
	}

	/**
	 * The books shown, as loaded (one removed meanwhile is gone).
	 */
	books(): Book[] {
		return this.ids
			.slice(0, this.showing)
			.map(id => CATALOG.book(id))
			.filter(Boolean) as Book[];
	}
}

/**
 * Books as a list draws them: grouped by series, each under its heading (its info, and `heading(id)` after
 * it) and followed by `after(id)`, then the books in no series; or, `sorted`, one list with each book's series.
 * Then a Show more button that calls `onMore`, when `more` books are not shown yet. A book the search `q`
 * found by a title one of its editions was released under shows that title.
 */
export function bookGroups(
	books: Book[],
	{
		sorted = false,
		more = 0,
		onMore = () => {},
		heading = () => null,
		after = () => null,
		q = '',
	}: {
		sorted?: boolean;
		more?: number;
		onMore?: () => void;
		heading?: (id: string) => Child;
		after?: (id: string) => Child;
		q?: string;
	} = {},
): Child[] {
	const out: Child[] = [];
	const shared = q ? Book.sharedEditionTest(CATALOG.books) : () => false;
	const card: (b: Book, withSeries?: boolean) => HTMLDivElement = (b, withSeries = false) =>
		bookCard(b, withSeries, q, shared);
	if (sorted) out.push(...books.map(b => card(b, true)));
	else {
		const groups: Map<string, Book[]> = new Map();
		const standalone: Book[] = [];
		books.forEach(b => {
			if (!b.series) {
				standalone.push(b);
				return;
			}
			const group = groups.get(b.series);
			if (group) group.push(b);
			else groups.set(b.series, [b]);
		});
		[...groups.keys()]
			.sort((a, b) => a.localeCompare(b))
			.forEach(name => {
				const group = (groups.get(name) as Book[]).sort(seriesOrder);
				const info = CATALOG.seriesInfo(name);
				const note: string[] = [];
				if (info) {
					const missing = CATALOG.missing(name);
					note.push(`${totalText(info)} released total`);
					if (missing && missing.length) note.push(`missing ${Series.numberList(missing)}`);
					if (info.note) note.push(info.note);
				}
				const id = CATALOG.idFor('series', name);
				out.push(
					buildElement(
						'div',
						{class: 'series-group'},
						buildElement(
							'p',
							{class: 'series-title'},
							buildElement('a', {href: seriesPageHref(id)}, name),
							' ',
							buildElement('span', {class: 'n'}, ownedText(group)),
							info && [' ', statusTag(info.status), seriesLinks(info)],
							heading(id),
						),
						note.length > 0 && buildElement('p', {class: 'series-note'}, note.join(' — ')),
						group.map(b => card(b)),
						after(id),
					),
				);
			});
		if (standalone.length) {
			standalone.sort((x, y) => x.title.localeCompare(y.title));
			out.push(
				buildElement(
					'div',
					{class: 'series-group'},
					buildElement(
						'p',
						{class: 'series-title'},
						'Standalone ',
						buildElement('span', {class: 'n'}, Text.plural(standalone.length, 'book')),
					),
					standalone.map(b => card(b)),
				),
			);
		}
	}
	if (more > 0)
		out.push(
			buildElement(
				'p',
				{class: 'more'},
				buildElement(
					'button',
					{type: 'button', id: 'showMore', onclick: onMore},
					`Show ${Math.min(more, PAGE_SIZE)} more`,
				),
			),
		);
	return out;
}

// A new catalog, with nothing in it yet: where books come from.
export function showEmptyCatalog() {
	byId('subtitle').textContent = spell('Your catalog is empty');
	byId('resultCount').textContent = '';
	fillElement(
		byId('results'),
		buildElement(
			'p',
			{class: 'empty'},
			'No books yet. ',
			buildElement('a', {href: 'book.html#add'}, 'Add one'),
			', import your Audible, Goodreads or Hardcover library on ',
			buildElement('a', {href: 'import.html'}, 'Import & export'),
			', or restore a backup there.',
		),
	);
}

// The catalog lives only in this browser, so the series and books pages say when its last backup is getting old (needsBackup).
export async function showBackupNudge() {
	const age = await backupAge();
	fillElement(
		byId('backupNudge'),
		needsBackup(age) && [
			spell(
				age.days === null
					? `No backup of this catalog yet, and ${Text.plural(age.changes, 'change')} saved: `
					: `Last backup ${age.days} days ago, and ${Text.plural(age.changes, 'change')} saved since: `,
			),
			buildElement('a', {href: 'import.html'}, 'download one on Import & export'),
			'.',
		],
	);
}

/**
 * A list page's search box and Filters button. Typing a search is one step back, however many letters it
 * took: the first change of the search adds a history entry, the rest of the typing updates it. On a phone
 * the filters fold away behind the button (styles.css), which opens them.
 * @param addressNow the address of what the page shows now
 * @param showView shows what the search says
 */
export function watchSearchAndFilters(addressNow: () => string, showView: () => unknown) {
	byId('q').addEventListener('input', () => {
		const typing = !!(history.state && history.state.search);
		setAddress(typing ? 'replace' : 'push', addressNow(), {search: true});
		showView();
	});
	byId('filtersBtn').addEventListener('click', () => {
		const open = byId('controls').classList.toggle('filtersOpen');
		byId('filtersBtn').setAttribute('aria-expanded', String(open));
	});
}

/**
 * The address's #a=1&b -> its parts, by name (true for a part without a value); anything malformed is read as best it can be.
 */
export function hashParts(hash: string | null): Map<string, string | true> {
	const dec = (v: string) => {
		try {
			return decodeURIComponent(v.replace(/\+/g, ' '));
		} catch {
			return v;
		}
	};
	const p: Map<string, string | true> = new Map();
	String(hash || '')
		.replace(/^#/, '')
		.split('&')
		.filter(Boolean)
		.forEach(part => {
			const i = part.indexOf('=');
			if (i < 0) p.set(dec(part), true);
			else p.set(dec(part.slice(0, i)), dec(part.slice(i + 1)));
		});
	return p;
}

/**
 * A part of an address's parts (hashParts), trimmed; '' when it has no value.
 */
export function hashText(parts: Map<string, string | true>, key: string): string {
	const v = parts.get(key);
	return typeof v === 'string' ? v.trim() : '';
}

/**
 * Parts -> an address's #a=1&b ('' for none); a part whose value is '' or false is left out.
 */
export function hashOf(parts: [string, string | boolean][]): string {
	const kept = parts
		.filter(([, v]) => v !== '' && v !== false)
		.map(([k, v]) => (v === true ? k : k + '=' + hashValue(String(v))));
	return kept.length ? '#' + kept.join('&') : '';
}

/**
 * Put `hash` in the address: a new history entry, so Back returns to what was shown, unless `how` is 'replace'.
 */
export function setAddress(how: 'push' | 'replace', hash: string, data: {search: boolean} | null = null) {
	try {
		history[how === 'replace' ? 'replaceState' : 'pushState'](
			data,
			'',
			hash || location.pathname + (location.search || ''),
		);
	} catch {
		/* the address just stays as it was */
	}
}
