// What the series page (index.html, series.js), the books page (books.html, books.js) and a book's page
// (book.html, book.js) share: the book cards and covers, the lists of books grouped by series, the links
// on them, and the reminder of the last backup.
import {Text} from './modules/text.js';
/** @import {Book} from './modules/book.js' */
import {Series} from './modules/series.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {Cover} from './modules/cover.js';
/** @import {CoverSize} from './modules/cover.js' */
/** @import {CatalogReader} from './modules/catalog-database.js' */
import { CATALOG, backupAge, needsBackup, loadRecords, byId, spell, buildElement, fillElement, joined, authorPageHref, narratorPageHref,
	externalLinks, bookPageHref, seriesPageHref } from './store.js';
/** @import {Child} from './store.js' */

// How many books a list draws at a time; Show more draws more.
export const PAGE_SIZE = 50;
// The series filter's value for the books in no series.
export const STANDALONE = '__standalone__';

/**
 * Authors' names, each a link to their page on the authors page.
 * @type {(names: string[]) => Child[]}
 */
export const authorLinks = names => joined(names.map(x=> buildElement('a', {href: authorPageHref(x)}, x)), ', ');
/**
 * Narrators' names, each a link to their page on the narrators page.
 * @type {(names: string[]) => Child[]}
 */
export const narratorLinks = names => joined(names.map(x=> buildElement('a', {href: narratorPageHref(x)}, x)), ', ');
/**
 * A series' status, as a tag.
 * @type {(status: string | undefined) => HTMLSpanElement}
 */
export const statusTag = status=> buildElement('span', {class: `status ${status}`}, status === 'complete' ? 'complete' : 'ongoing');
/** @type {(url: string) => HTMLAnchorElement} */
export const authorSiteLink = url=> buildElement('a', {class: 'authorlink', href: url, target: '_blank', rel: 'noopener'}, 'author site ↗');
/** @type {(info: Series) => Child[]} the series' pages in external catalogs */
export const seriesLinks = info=> externalLinks(info.external, 'series').map(a=> [' ', a]);
/**
 * A series' released total as its info has it (as typed, should it not be a number).
 * @param {Series} info
 * @returns {string}
 */
export const totalText = info=> String(info.toJSON().total ?? '');

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
 * The narrators of all of a book's editions, each edition's together ("Ann Vale, Bo Reed / Cy Hale").
 * @param {Book} b
 * @returns {Child}
 */
export function bookNarrators(b){
	const narrators = [...new Map(b.editions.filter(ed=> ed.narrators.length).map(ed=> [Text.namesText(ed.narrators), ed.narrators])).values()];
	return narrators.length > 0 && ['narr. ', joined(narrators.map(narratorLinks), ' / ')];
}

// Covers come from Amazon and Open Library, which then learn the ids asked for, so they can be turned off;
// the choice is this browser's.
const COVERS_KEY = 'audiobook-catalog-covers';
/** @returns {boolean} whether books show their covers (they do unless turned off) */
export function coversShown(){ try{ return localStorage.getItem(COVERS_KEY) !== 'off'; }catch{ return true; } }

/**
 * The Covers box of a list: ticked as the choice is, which it changes, and then the list is drawn again.
 * @param {() => void} redraw
 */
export function watchCoversBox(redraw){
	const box = /** @type {HTMLInputElement} */ (byId('showCovers'));
	box.checked = coversShown();
	box.addEventListener('change', ()=>{
		try{ localStorage.setItem(COVERS_KEY, box.checked ? 'on' : 'off'); }catch{ /* the choice holds on this page, just not the next time */ }
		redraw();
	});
}

/**
 * A book's cover, trying each address Cover.addresses gives until one loads; hidden until then, and for good
 * when none does. Nothing when covers are off or its editions have no id a cover can be found by.
 * @param {Book} b
 * @param {CoverSize} size
 * @returns {HTMLImageElement | null}
 */
export function coverImage(b, size){
	const addresses = coversShown() ? Cover.addresses(b, size) : [];
	if(!addresses.length) return null;
	let at = 0;
	const next = ()=>{
		if(++at < addresses.length) img.setAttribute('src', addresses[at]);
		else img.classList.add('missing');
	};
	const img = /** @type {HTMLImageElement} */ (buildElement('img', {class: `cover ${size}`, src: addresses[0], alt: '', loading: 'lazy', decoding: 'async',
		referrerpolicy: 'no-referrer',
		onload: ()=>{ if(Cover.isCover(img.naturalWidth, img.naturalHeight)) img.classList.add('loaded'); else next(); },
		onerror: next}));
	return img;
}

/**
 * A book in a list: only what tells it apart (its title, authors, narrators and when it was read); its
 * title links to its page. `withSeries` names its series too, in a list not grouped by series.
 * @param {Book} b
 * @param {boolean} [withSeries]
 * @returns {HTMLDivElement}
 */
function bookCard(b, withSeries = false){
	const id = /** @type {string} */ (b.id);
	return buildElement('div', {class: 'book', 'data-id': id},
		buildElement('div', {class: 'num'}, b.number || '•'),
		coverImage(b, 'small'),
		buildElement('div', {class: 'info'},
			buildElement('div', {class: 'title'}, buildElement('a', {href: bookPageHref(id)}, b.title)),
			withSeries && b.series && buildElement('div', {class: 'meta'},
				buildElement('a', {href: seriesPageHref(CATALOG.idFor('series', b.series))}, b.series), b.number && ` #${b.number}`),
			buildElement('div', {class: 'meta'}, joined([authorLinks(b.authors), bookNarrators(b)].filter(Boolean), ' — ')),
			b.read.length > 0 && buildElement('div', {class: 'read'}, 'Read ' + b.read.join(', '))));
}

/**
 * The ids of the books in a list, in the order it shows them: the series by name, each in reading order
 * (box sets last), then the books in no series by title; only `series`' (a series' id, or STANDALONE), and
 * only those in `only`, when given. Only the indexes' keys are read, not the books.
 * @param {CatalogReader} r
 * @param {string | null} series
 * @param {Set<string> | null} [only]
 * @returns {Promise<string[]>}
 */
export async function readOrdered(r, series, only = null){
	/** @type {Map<string, string>} */
	const names = new Map((await r.indexKeys('series', 'name')).map(([name, id])=> [String(id), String(name)]));
	const numbered = (/** @type {unknown} */ n)=> n === CatalogRecords.UNNUMBERED ? 0 : Number(n);
	const inSeries = series === STANDALONE ? [] : (await r.indexKeys('books', 'bySeries')).map(([key, id])=> ({id: String(id), key: /** @type {any[]} */ (key)}))
		.filter(x=> series === null || x.key[0] === series);
	// as seriesOrder() puts a series' books
	inSeries.sort((x, y)=> (names.get(x.key[0]) || '').localeCompare(names.get(y.key[0]) || '') || (x.key[0] < y.key[0] ? -1 : x.key[0] > y.key[0] ? 1 : 0)
		|| x.key[1] - y.key[1] || numbered(x.key[2]) - numbered(y.key[2]) || numbered(x.key[3]) - numbered(y.key[3]));
	const standalone = series === null || series === STANDALONE ? (await r.indexKeys('books', 'standalone')).map(([, id])=> String(id)) : [];
	const ids = [...inSeries.map(x=> x.id), ...standalone];
	return only ? ids.filter(id=> only.has(id)) : ids;
}

/**
 * The books a list shows, by id in the order it shows them (`ids`), of which the first `showing` are loaded
 * (each with every book of its series, as the series' heading counts them) and drawn.
 */
export class BookList {
	/** @param {() => boolean} together whether a series' books stay together, so one isn't split between two pages */
	constructor(together){
		/** @type {string[]} */
		this.ids = [];
		this.showing = 0;
		this.together = together;
	}

	/**
	 * List `ids`, loading the first of them: at least `showing`, so a redraw after an edit shows as many as before.
	 * @param {string[]} ids
	 * @param {number} [showing]
	 * @returns {Promise<void>}
	 */
	async show(ids, showing = 0){
		this.ids = ids;
		this.showing = 0;
		await this.more(Math.max(showing, PAGE_SIZE));
	}

	/**
	 * Load `count` more of the books listed, or a few more, so a series' books aren't split between two pages.
	 * @param {number} [count]
	 * @returns {Promise<void>}
	 */
	async more(count = PAGE_SIZE){
		const listed = this.ids;
		let end = Math.min(listed.length, this.showing + count);
		const ids = listed.slice(this.showing, end);
		await loadRecords({books: ids});
		/** @type {(id: string) => string | undefined} */
		const seriesOf = id=> { const b = CATALOG.book(id); return b && b.series; };
		const series = [...new Set(ids.map(seriesOf))].filter(x=> x !== undefined).map(name=> CATALOG.nameIds.series.get(/** @type {string} */ (name)));
		if(series.length) await loadRecords({seriesBooks: /** @type {string[]} */ (series.filter(Boolean))});
		// the rest of the last series shown, which is loaded now
		const last = ids.length ? seriesOf(ids[ids.length - 1]) : undefined;
		while(this.together() && last !== undefined && end < listed.length && seriesOf(listed[end]) === last) end++;
		this.showing = end;
	}

	/** @returns {number} how many books listed are not shown yet */
	get rest(){ return this.ids.length - this.showing; }

	/**
	 * The books shown, as loaded (one removed meanwhile is gone).
	 * @returns {Book[]}
	 */
	books(){ return /** @type {Book[]} */ (this.ids.slice(0, this.showing).map(id=> CATALOG.book(id)).filter(Boolean)); }
}

/**
 * Books as a list draws them: grouped by series, each under its heading (its info, and `heading(id)` after
 * it) and followed by `after(id)`, then the books in no series; or, `sorted`, one list with each book's series.
 * Then a Show more button that calls `onMore`, when `more` books are not shown yet.
 * @param {Book[]} books
 * @param {{sorted?: boolean, more?: number, onMore?: () => void, heading?: (id: string) => Child, after?: (id: string) => Child}} [options]
 * @returns {Child[]}
 */
export function bookGroups(books, {sorted = false, more = 0, onMore = ()=>{}, heading = ()=> null, after = ()=> null} = {}){
	/** @type {Child[]} */
	const out = [];
	if(sorted) out.push(...books.map(b=> bookCard(b, true)));
	else {
		/** @type {Map<string, Book[]>} */
		const groups = new Map();
		/** @type {Book[]} */
		const standalone = [];
		books.forEach(b=>{
			if(!b.series){ standalone.push(b); return; }
			const group = groups.get(b.series);
			if(group) group.push(b); else groups.set(b.series, [b]);
		});
		[...groups.keys()].sort((a, b)=> a.localeCompare(b)).forEach(name=>{
			const group = /** @type {Book[]} */ (groups.get(name)).sort(seriesOrder);
			const info = CATALOG.seriesInfo(name);
			/** @type {string[]} */
			const note = [];
			if(info){
				const missing = CATALOG.missing(name);
				note.push(`${totalText(info)} released total`);
				if(missing && missing.length) note.push(`missing ${Series.numberList(missing)}`);
				if(info.note) note.push(info.note);
			}
			const id = CATALOG.idFor('series', name);
			out.push(buildElement('div', {class: 'series-group'},
				buildElement('p', {class: 'series-title'}, buildElement('a', {href: seriesPageHref(id)}, name), ' ', buildElement('span', {class: 'n'}, ownedText(group)),
					info && [' ', statusTag(info.status), info.url && [' ', authorSiteLink(info.url)], seriesLinks(info)], heading(id)),
				note.length > 0 && buildElement('p', {class: 'series-note'}, note.join(' — ')),
				group.map(b=> bookCard(b)),
				after(id)));
		});
		if(standalone.length){
			standalone.sort((x, y)=> x.title.localeCompare(y.title));
			out.push(buildElement('div', {class: 'series-group'},
				buildElement('p', {class: 'series-title'}, 'Standalone ', buildElement('span', {class: 'n'}, Text.plural(standalone.length, 'book'))),
				standalone.map(b=> bookCard(b))));
		}
	}
	if(more > 0) out.push(buildElement('p', {class: 'more'}, buildElement('button', {type: 'button', id: 'showMore', onclick: onMore},
		`Show ${Math.min(more, PAGE_SIZE)} more`)));
	return out;
}

// A new catalog, with nothing in it yet: where books come from.
export function showEmptyCatalog(){
	byId('subtitle').textContent = spell('Your catalog is empty');
	byId('resultCount').textContent = '';
	fillElement(byId('results'), buildElement('p', {class: 'empty'}, 'No books yet. ', buildElement('a', {href: 'book.html#add'}, 'Add one'),
		', import your Audible, Goodreads or Hardcover library on ', buildElement('a', {href: 'import.html'}, 'Import & export'), ', or restore a backup there.'));
}

// The catalog lives only in this browser, so the series and books pages say when its last backup is getting old (needsBackup).
export async function showBackupNudge(){
	const age = await backupAge();
	fillElement(byId('backupNudge'), needsBackup(age) && [
		spell(age.days === null ? `No backup of this catalog yet, and ${Text.plural(age.changes, 'change')} saved: `
			: `Last backup ${age.days} days ago, and ${Text.plural(age.changes, 'change')} saved since: `),
		buildElement('a', {href: 'import.html'}, 'download one on Import & export'), '.']);
}

/**
 * The address's #a=1&b -> its parts, by name (true for a part without a value); anything malformed is read as best it can be.
 * @param {string | null} hash
 * @returns {Map<string, string | true>}
 */
export function hashParts(hash){
	const dec = (/** @type {string} */ v)=>{ try{ return decodeURIComponent(v.replace(/\+/g, ' ')); }catch{ return v; } };
	/** @type {Map<string, string | true>} */
	const p = new Map();
	String(hash || '').replace(/^#/, '').split('&').filter(Boolean).forEach(part=>{
		const i = part.indexOf('=');
		if(i < 0) p.set(dec(part), true); else p.set(dec(part.slice(0, i)), dec(part.slice(i + 1)));
	});
	return p;
}

/**
 * Parts -> an address's #a=1&b ('' for none); a part whose value is '' or false is left out.
 * @param {[string, string | boolean][]} parts
 * @returns {string}
 */
export function hashOf(parts){
	const enc = (/** @type {string} */ v)=> encodeURIComponent(v).replace(/%20/g, '+');
	const kept = parts.filter(([, v])=> v !== '' && v !== false).map(([k, v])=> v === true ? k : k + '=' + enc(String(v)));
	return kept.length ? '#' + kept.join('&') : '';
}

/**
 * Put `hash` in the address: a new history entry, so Back returns to what was shown, unless `how` is 'replace'.
 * @param {'push' | 'replace'} how
 * @param {string} hash
 * @param {{search: boolean} | null} [data]
 */
export function setAddress(how, hash, data = null){
	try{ history[how === 'replace' ? 'replaceState' : 'pushState'](data, '', hash || location.pathname + (location.search || '')); }catch{ /* the address just stays as it was */ }
}
