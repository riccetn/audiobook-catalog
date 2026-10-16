// The narrators and publishers pages: everyone who narrates (or publishes) an edition in the catalog, and
// one narrator's or publisher's page (narrators.html#n=Name, publishers.html#p=Name) with the series and
// titles of theirs you have, worked out from the books' editions. Nothing is kept about them but their
// name on the editions. Each page's own script (narrators.js, publishers.js) starts this one with its kind.
import {Catalog} from './modules/catalog.js';
import { CATALOG, startPage, byId, fieldById, spell, buildElement, fillElement, joined, authorPageHref, narratorPageHref, publisherPageHref, nameFromPageHash } from './store.js';
/** @import {Book} from './modules/book.js' */
/** @import {Child} from './store.js' */

/**
 * What differs between the two pages.
 * @typedef {object} CreditKind
 * @property {string} hashKey the address's key: #n=Name
 * @property {string} one 'narrator'
 * @property {string} many 'narrators'
 * @property {string} title the page's title: 'Narrators'
 * @property {string} none the subtitle of someone with no books
 * @property {(name: string) => string} href the address of someone's page
 * @property {(b: Book) => string[]} namesOf who the kind credits on a book
 * @property {() => {name: string, books: number, series: number}[]} list
 * @property {(name: string) => {series: {name: string, books: Book[]}[], titles: Book[]}} works
 */

/** @type {Record<'narrator' | 'publisher', CreditKind>} */
export const CREDIT_KINDS = {
	narrator: {hashKey: 'n', one: 'narrator', many: 'narrators', title: 'Narrators', none: 'No books narrated by them in the catalog.',
		href: narratorPageHref, namesOf: Catalog.narratorsOf, list: ()=> CATALOG.narratorList(), works: name=> CATALOG.narratorWorks(name)},
	publisher: {hashKey: 'p', one: 'publisher', many: 'publishers', title: 'Publishers', none: 'No books from this publisher in the catalog.',
		href: publisherPageHref, namesOf: Catalog.publishersOf, list: ()=> CATALOG.publisherList(), works: name=> CATALOG.publisherWorks(name)},
};

/** @type {CreditKind} */
export let KIND = CREDIT_KINDS.narrator;
/** @type {string | null} */
export let SHOWN = null;              // the narrator or publisher shown (#n=...), or null for the list

const bookHref = (/** @type {string} */ title)=> 'index.html#book=' + encodeURIComponent(title).replace(/%20/g, '+');
const seriesHref = (/** @type {string} */ name)=> 'index.html#series=' + encodeURIComponent(name).replace(/%20/g, '+');
const plural = (/** @type {number} */ n, /** @type {string} */ word, many = word + 's')=> `${n} ${n === 1 ? word : many}`;
/** @type {(names: string[]) => Child[]} */
const authorLinks = names=> joined(names.map(x=> buildElement('a', {href: authorPageHref(x)}, x)), ', ');

export function render(){
	byId('crumb').classList.toggle('show', SHOWN !== null);
	byId('creditControls').style.display = SHOWN === null ? '' : 'none';
	document.title = (SHOWN === null ? KIND.title : SHOWN) + spell(' · Audiobook Catalog');
	if(SHOWN === null) renderCreditList(); else renderCreditPage(SHOWN);
}

function renderCreditList(){
	const q = fieldById('q').value.trim().toLowerCase();
	const all = KIND.list();
	const shown = q ? all.filter(x=> x.name.toLowerCase().includes(q)) : all;
	byId('subtitle').textContent = `${plural(all.length, KIND.one)} across ${plural(CATALOG.books.length, 'audiobook')}`;
	fillElement(byId('creditBody'), shown.length ? shown.map(x=> buildElement('div', {class: 'srow'},
		buildElement('div', {class: 'srow-head'},
			buildElement('a', {class: 'srow-title', href: KIND.href(x.name)}, x.name), ' ',
			buildElement('span', {class: 'srow-owned'}, `${plural(x.books, 'book')}${x.series ? ', ' + plural(x.series, 'series', 'series') : ''}`)),
		topAuthorsLine(x.name)))
		: buildElement('p', {class: 'empty'}, all.length ? `No ${KIND.many} match your search.` : `No ${KIND.many} yet: they come from the books' editions.`));
}

/**
 * The authors whose books someone narrates or publishes most, for the list: "Mostly Ann Vale, Bo Reed".
 * @param {string} name
 * @returns {HTMLParagraphElement | null}
 */
function topAuthorsLine(name){
	/** @type {Map<string, number>} */
	const count = new Map();
	for(const b of CATALOG.books) if(KIND.namesOf(b).includes(name)) for(const a of b.authors) count.set(a, (count.get(a) || 0) + 1);
	const top = [...count].sort((x, y)=> y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([a])=> a);
	return top.length ? buildElement('p', {class: 'srow-note'}, (count.size > top.length ? 'Mostly ' : 'Books by ') + top.join(', ')) : null;
}

/**
 * A book on someone's page: its number in the series, its title (a link to it in the catalog), its
 * authors, and for a narrator who else reads the editions they read.
 * @param {Book} b
 * @param {string} name
 * @returns {HTMLLIElement}
 */
function creditBookLine(b, name){
	const others = KIND === CREDIT_KINDS.narrator
		? [...new Set(b.editions.filter(ed=> ed.narrators.includes(name)).flatMap(ed=> ed.narrators))].filter(x=> x !== name) : [];
	return buildElement('li', {}, b.number && [buildElement('span', {class: 'num'}, '#' + b.number), ' '], buildElement('a', {href: bookHref(b.title)}, b.title),
		b.authors.length > 0 && [' ', buildElement('span', {class: 'with'}, 'by ', authorLinks(b.authors))],
		others.length > 0 && [' ', buildElement('span', {class: 'with'}, 'with ', joined(others.map(x=> buildElement('a', {href: KIND.href(x)}, x)), ', '))]);
}

/** @param {string} name */
function renderCreditPage(name){
	const {series, titles} = KIND.works(name);
	const count = series.reduce((n, s)=> n + s.books.length, 0) + titles.length;
	byId('subtitle').textContent = count
		? `${plural(count, 'audiobook')}${series.length ? ' in ' + plural(series.length, 'series', 'series') : ''}${series.length && titles.length ? ` and ${titles.length} outside a series` : ''}`
		: spell(KIND.none);
	/** @type {Child[]} */
	const out = [buildElement('div', {class: 'author-head'}, buildElement('h2', {class: 'author-name'}, name))];
	series.forEach(s=>{
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, buildElement('a', {href: seriesHref(s.name)}, s.name),
				' ', buildElement('span', {class: 'n'}, plural(s.books.length, 'book'))),
			buildElement('ul', {class: 'author-books'}, s.books.map(b=> creditBookLine(b, name)))));
	});
	if(titles.length){
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, series.length ? 'Outside a series' : 'Titles', ' ', buildElement('span', {class: 'n'}, plural(titles.length, 'book'))),
			buildElement('ul', {class: 'author-books'}, titles.map(b=> creditBookLine(b, name)))));
	}
	fillElement(byId('creditBody'), out);
}

// ------------------------------------------------------------------ the address
// narrators.html is the list, narrators.html#n=Name a narrator's page; links between them change the
// address, so Back and Forward step through them.
export function showAddress(){
	const name = nameFromPageHash(location.hash, KIND.hashKey);
	if(name === SHOWN && byId('creditBody').hasChildNodes()) return;
	const moved = name !== SHOWN;
	SHOWN = name;
	render();
	if(moved && typeof scrollTo === 'function') scrollTo(0, 0);
}

/**
 * Start the narrators or the publishers page.
 * @param {'narrator' | 'publisher'} kind
 * @returns {Promise<void>}
 */
export function startCreditsPage(kind){
	KIND = CREDIT_KINDS[kind];
	byId('q').addEventListener('input', render);
	addEventListener('hashchange', showAddress);
	addEventListener('popstate', showAddress);
	return startPage(()=>{ SHOWN = nameFromPageHash(location.hash, KIND.hashKey); render(); });
}
