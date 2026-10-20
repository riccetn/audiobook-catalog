// The authors, narrators and publishers pages: everyone of the kind in the catalog (whether or not a book
// credits them still), searched by name,
// each linking to their own page (author.html, narrator.html, publisher.html: credit.js). Each list's own
// script (authors.js, narrators.js, publishers.js) starts this one with its kind. The list reads only the
// kind's records (each keeps how many books and series they have). Loading lives in store.js.
import {Text} from './modules/text.js';
import { startPage, afterSaving, queryCatalog, byId, fieldById, spell, buildElement, fillElement, creditPageHref, valueFromPageHash } from './store.js';
import {CREDIT_KINDS} from './credit-kinds.js';
/** @import {CreditKind} from './credit-kinds.js' */
/** @import {CatalogReader} from './modules/catalog-database.js' */
/** @import {ContributorRecord} from './modules/catalog-records.js' */

/** @type {CreditKind} */
let KIND = CREDIT_KINDS.author;
/**
 * Someone on the list: their name, how many books and series they have, the first line of their bio, and
 * for a narrator or publisher the authors of most of their books (and how many authors there are).
 * @typedef {{id: string, name: string, books: number, series: number, bio: string, topAuthors: string[], authorCount: number}} ListEntry
 */
/** @type {ListEntry[]} */
let LIST = [];                 // the list
let TOTAL_BOOKS = 0;                  // how many books the catalog has, for the list's subtitle

export function render(){
	document.title = KIND.title + spell(' · Audiobook Catalog');
	const q = fieldById('q').value.trim().toLowerCase();
	const all = LIST;
	const shown = q ? all.filter(x=> x.name.toLowerCase().includes(q)) : all;
	byId('subtitle').textContent = `${Text.plural(all.length, KIND.one)} across ${Text.plural(TOTAL_BOOKS, 'audiobook')}`;
	fillElement(byId('creditBody'), shown.length ? shown.map(x=> buildElement('div', {class: 'srow'},
		buildElement('div', {class: 'srow-head'},
			buildElement('a', {class: 'srow-title', href: creditPageHref(KIND.infoKey, x.id)}, x.name), ' ',
			buildElement('span', {class: 'srow-owned'}, x.books ? `${Text.plural(x.books, 'book')}${x.series ? ', ' + Text.plural(x.series, 'series', 'series') : ''}` : 'no books yet')),
		bioLine(x) || (KIND !== CREDIT_KINDS.author && topAuthorsLine(x))))
		: buildElement('p', {class: 'empty'}, all.length ? `No ${KIND.many} match your search.`
			: KIND === CREDIT_KINDS.author ? 'No books yet.' : `No ${KIND.many} yet: they come from the books' editions.`));
}

/**
 * The first line of someone's bio, for the list; null when there is none.
 * @param {ListEntry} x
 * @returns {HTMLParagraphElement | null}
 */
function bioLine(x){
	return x.bio ? buildElement('p', {class: 'srow-note'}, x.bio.split('\n')[0]) : null;
}

/**
 * The authors whose books someone narrates or publishes most, for the list: "Mostly Ann Vale, Bo Reed".
 * @param {ListEntry} x
 * @returns {HTMLParagraphElement | null}
 */
function topAuthorsLine(x){
	return x.topAuthors.length ? buildElement('p', {class: 'srow-note'}, (x.authorCount > x.topAuthors.length ? 'Mostly ' : 'Books by ') + x.topAuthors.join(', ')) : null;
}

/**
 * The list, from the kind's records alone (and the names of the authors they name).
 * @param {CatalogReader} r
 * @returns {Promise<{list: ListEntry[], total: number}>}
 */
async function readList(r){
	/** @type {ContributorRecord[]} */
	const records = await r.under('contributors', 'byName', [KIND.one]);
	/** @type {ContributorRecord[]} */
	const authors = await r.get('contributors', records.flatMap(c=> c.topAuthorIds || []));
	const authorName = new Map(authors.map(a=> [a.id, a.name]));
	const list = records.map(c=> ({id: c.id, name: c.name, books: c.bookCount, series: c.seriesCount, bio: c.bio || '',
		topAuthors: /** @type {string[]} */ ((c.topAuthorIds || []).map(id=> authorName.get(id)).filter(x=> x !== undefined)), authorCount: c.authorCount || 0}));
	return {list: list.sort((x, y)=> x.name.localeCompare(y.name)), total: await r.count('books')};
}

async function loadList(){
	const {list, total} = await queryCatalog(readList);
	LIST = list;
	TOTAL_BOOKS = total;
}

// Someone's page was on this page, before it had its own (authors.html#a=id): that address goes there.
/** @returns {string | null} where the address goes instead, or null when it is the list's */
function movedAddress(){
	return valueFromPageHash(location.hash, KIND.hashKey) === null ? null : KIND.page + location.hash;
}

/**
 * Start the authors, narrators or publishers page.
 * @param {'author' | 'narrator' | 'publisher'} kind
 * @returns {Promise<void>}
 */
export function startCreditsPage(kind){
	KIND = CREDIT_KINDS[kind];
	const moved = movedAddress();
	if(moved){ location.replace(moved); return Promise.resolve(); }
	byId('q').addEventListener('input', render);
	addEventListener('hashchange', ()=>{ const to = movedAddress(); if(to) location.replace(to); });
	return startPage(async ()=>{ await loadList(); render(); }, {refresh: ()=> afterSaving(async ()=>{ await loadList(); render(); })});
}
