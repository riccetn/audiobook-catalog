// The authors, narrators and publishers pages: everyone the books credit as one of them, and one
// person's or publisher's page (authors.html#a=Name, narrators.html#n=Name, publishers.html#p=Name) with
// what you keep about them (CATALOG.authors, .narrators, .publishers: a short bio, their own site and their
// pages on Audible, Goodreads and Hardcover) and the series and titles of theirs you have, worked out from
// the books. Each page's own script (authors.js, narrators.js, publishers.js) starts this one with its kind.
// Loading and saving live in store.js.
import {Catalog} from './modules/catalog.js';
import {Contributor} from './modules/contributor.js';
import {Series} from './modules/series.js';
import {Validator} from './modules/validator.js';
import { CATALOG, persist, showIoStatus, startPage, byId, fieldById, spell, buildElement, fillElement, joined,
	authorPageHref, narratorPageHref, publisherPageHref, nameFromPageHash } from './store.js';
/** @import {Book} from './modules/book.js' */
/** @import {ContributorKind} from './modules/contributor.js' */
/** @import {Child} from './store.js' */

/**
 * What differs between the three pages.
 * @typedef {object} CreditKind
 * @property {ContributorKind} infoKey where the catalog keeps their info: CATALOG.narrators
 * @property {string} hashKey the address's key: #n=Name
 * @property {string} one 'narrator'
 * @property {string} many 'narrators'
 * @property {string} title the page's title: 'Narrators'
 * @property {string} none the subtitle of someone with no books
 * @property {Record<'url' | 'audible' | 'goodreads' | 'hardcover', [string, string]>} fields each link's form label and example
 * @property {(name: string) => string} href the address of someone's page
 * @property {(b: Book) => string[]} namesOf who the kind credits on a book
 * @property {() => {name: string, books: number, series: number}[]} list
 * @property {(name: string) => {series: {name: string, books: Book[]}[], titles: Book[]}} works
 */

/** @type {Record<'author' | 'narrator' | 'publisher', CreditKind>} */
export const CREDIT_KINDS = {
	author: {infoKey: 'authors', hashKey: 'a', one: 'author', many: 'authors', title: 'Authors', none: 'No books by this author in the catalog.',
		fields: {url: ['Personal website', 'https://'], audible: ['Audible author page', 'https://www.audible.com/author/...'],
			goodreads: ['Goodreads author page', 'https://www.goodreads.com/author/show/...'], hardcover: ['Hardcover author page', 'https://hardcover.app/authors/...']},
		href: authorPageHref, namesOf: Catalog.authorsOf, list: ()=> CATALOG.authorList(), works: name=> CATALOG.authorWorks(name)},
	narrator: {infoKey: 'narrators', hashKey: 'n', one: 'narrator', many: 'narrators', title: 'Narrators', none: 'No books narrated by them in the catalog.',
		fields: {url: ['Personal website', 'https://'], audible: ['Audible narrator search', 'https://www.audible.com/search?searchNarrator=...'],
			goodreads: ['Goodreads author page', 'https://www.goodreads.com/author/show/...'], hardcover: ['Hardcover page', 'https://hardcover.app/authors/...']},
		href: narratorPageHref, namesOf: Catalog.narratorsOf, list: ()=> CATALOG.narratorList(), works: name=> CATALOG.narratorWorks(name)},
	publisher: {infoKey: 'publishers', hashKey: 'p', one: 'publisher', many: 'publishers', title: 'Publishers', none: 'No books from this publisher in the catalog.',
		fields: {url: ['Website', 'https://'], audible: ['Audible publisher search', 'https://www.audible.com/search?searchProvider=...'],
			goodreads: ['Goodreads page', 'https://www.goodreads.com/...'], hardcover: ['Hardcover publisher page', 'https://hardcover.app/publishers/...']},
		href: publisherPageHref, namesOf: Catalog.publishersOf, list: ()=> CATALOG.publisherList(), works: name=> CATALOG.publisherWorks(name)},
};

/** @type {CreditKind} */
export let KIND = CREDIT_KINDS.author;
/** @type {string | null} */
export let SHOWN = null;              // the author, narrator or publisher shown (#a=...), or null for the list
/** @type {string | null} */
let EDITING = null;                   // whose info the form is editing, or null

// The links a page can have, in the order they are shown, with their names there.
/** @type {['url' | 'audible' | 'goodreads' | 'hardcover', string][]} */
const LINKS = [['url', 'Website'], ['audible', 'Audible'], ['goodreads', 'Goodreads'], ['hardcover', 'Hardcover']];

const bookHref = (/** @type {string} */ title)=> 'index.html#book=' + encodeURIComponent(title).replace(/%20/g, '+');
const seriesHref = (/** @type {string} */ name)=> 'index.html#series=' + encodeURIComponent(name).replace(/%20/g, '+');
const plural = (/** @type {number} */ n, /** @type {string} */ word, many = word + 's')=> `${n} ${n === 1 ? word : many}`;
/** @type {(names: string[], href: (name: string) => string) => Child[]} */
const nameLinks = (names, href)=> joined(names.map(x=> buildElement('a', {href: href(x)}, x)), ', ');
/** @returns {Map<string, Contributor>} what the catalog keeps about the page's kind */
const kept = ()=> CATALOG[KIND.infoKey];

/**
 * A bio as paragraphs: a blank line starts a new one, a single line break stays a line break.
 * @param {string} bio
 * @returns {HTMLParagraphElement[]}
 */
function bioParagraphs(bio){
	return bio.split(/\n{2,}/).map(p=> buildElement('p', {}, p.split('\n').flatMap((line, i)=> i ? [buildElement('br'), line] : [line])));
}

export function render(){
	homeCreditForm();
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
		bioLine(x.name) || (KIND !== CREDIT_KINDS.author && topAuthorsLine(x.name))))
		: buildElement('p', {class: 'empty'}, all.length ? `No ${KIND.many} match your search.`
			: KIND === CREDIT_KINDS.author ? 'No books yet.' : `No ${KIND.many} yet: they come from the books' editions.`));
}

/**
 * The first line of someone's bio, for the list; null when there is none.
 * @param {string} name
 * @returns {HTMLParagraphElement | null}
 */
function bioLine(name){
	const info = kept().get(name);
	return info && info.bio ? buildElement('p', {class: 'srow-note'}, info.bio.split('\n')[0]) : null;
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
 * A book on someone's page: its number in the series, its title (a link to it in the catalog), and on an
 * author's page who else wrote it; on a narrator's or publisher's page its authors, and for a narrator who
 * else reads the editions they read.
 * @param {Book} b
 * @param {string} name
 * @returns {HTMLLIElement}
 */
function creditBookLine(b, name){
	const isAuthor = KIND === CREDIT_KINDS.author;
	const others = isAuthor ? b.authors.filter(x=> x !== name)
		: KIND === CREDIT_KINDS.narrator ? [...new Set(b.editions.filter(ed=> ed.narrators.includes(name)).flatMap(ed=> ed.narrators))].filter(x=> x !== name)
		: [];
	return buildElement('li', {}, b.number && [buildElement('span', {class: 'num'}, '#' + b.number), ' '], buildElement('a', {href: bookHref(b.title)}, b.title),
		!isAuthor && b.authors.length > 0 && [' ', buildElement('span', {class: 'with'}, 'by ', nameLinks(b.authors, authorPageHref))],
		others.length > 0 && [' ', buildElement('span', {class: 'with'}, 'with ', nameLinks(others, KIND.href))]);
}

/**
 * The heading of a series on someone's page: on an author's, how many of it you own (of the released
 * total, with its status); otherwise how many of its books are theirs.
 * @param {{name: string, books: Book[]}} s
 * @returns {HTMLParagraphElement}
 */
function seriesHeading(s){
	const link = buildElement('a', {href: seriesHref(s.name)}, s.name);
	if(KIND !== CREDIT_KINDS.author) return buildElement('p', {class: 'series-title'}, link, ' ', buildElement('span', {class: 'n'}, plural(s.books.length, 'book')));
	const si = CATALOG.series.get(s.name);
	return buildElement('p', {class: 'series-title'}, link,
		' ', buildElement('span', {class: 'n'}, `${Series.owned(s.books)} owned${si ? ' of ' + si.total : ''}`),
		si && [' ', buildElement('span', {class: `status ${si.status}`}, si.status === 'complete' ? 'complete' : 'ongoing')]);
}

/** @param {string} name */
function renderCreditPage(name){
	const info = kept().get(name) || new Contributor(name);
	const {series, titles} = KIND.works(name);
	const count = series.reduce((n, s)=> n + s.books.length, 0) + titles.length;
	byId('subtitle').textContent = count
		? `${plural(count, 'audiobook')}${series.length ? ' in ' + plural(series.length, 'series', 'series') : ''}${series.length && titles.length ? ` and ${titles.length} outside a series` : ''}`
		: spell(KIND.none);
	const label = kept().has(name) ? `Edit ${KIND.one} info` : `Add ${KIND.one} info`;
	const links = LINKS.filter(([k])=> info[k]).map(([k, text])=>
		buildElement('a', {class: 'authorlink', href: info[k] || '', target: '_blank', rel: 'noopener'}, `${text} ↗`));
	/** @type {Child[]} */
	const out = [
		buildElement('div', {class: 'author-head'}, buildElement('h2', {class: 'author-name'}, name),
			buildElement('button', {class: 'iconbtn aedit', title: label, 'aria-label': label, onclick: ()=> openCreditForm(name)}, '✎')),
		info.bio && buildElement('div', {class: 'author-bio'}, bioParagraphs(info.bio)),
		links.length > 0 && buildElement('p', {class: 'author-links'}, joined(links, ' ')),
		!info.bio && !links.length && buildElement('p', {class: 'hint'}, 'No bio or links yet: add them with ✎.'),
	];
	series.forEach(s=> out.push(buildElement('div', {class: 'series-group'}, seriesHeading(s),
		buildElement('ul', {class: 'author-books'}, s.books.map(b=> creditBookLine(b, name))))));
	if(titles.length){
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, series.length ? 'Outside a series' : 'Titles', ' ', buildElement('span', {class: 'n'}, plural(titles.length, 'book'))),
			buildElement('ul', {class: 'author-books'}, titles.map(b=> creditBookLine(b, name)))));
	}
	fillElement(byId('creditBody'), out);
}

// ------------------------------------------------------------------ the info form
/**
 * Edits someone's entry in CATALOG.authors (or .narrators, .publishers); like every edit, it is kept in
 * this browser (see persist in store.js).
 * @param {string} name
 */
export function openCreditForm(name){
	const info = kept().get(name) || new Contributor(name);
	EDITING = name;
	const one = KIND.one[0].toUpperCase() + KIND.one.slice(1);
	byId('creditFormTitle').textContent = (kept().has(name) ? `${one} info: ` : `Add ${KIND.one} info: `) + name;
	fieldById('cf_bio').value = info.bio || '';
	LINKS.forEach(([k])=> { fieldById('cf_' + k).value = info[k] || ''; });
	byId('creditFormError').textContent = '';
	byId('creditSaveBtn').textContent = `Save ${KIND.one} info`;
	byId('creditRemoveBtn').style.display = kept().has(name) ? '' : 'none';
	const form = byId('creditForm');
	form.classList.add('open');
	form.scrollIntoView({behavior: 'smooth', block: 'center'});
}

function closeCreditForm(){
	EDITING = null;
	const form = /** @type {HTMLFormElement} */ (byId('creditForm'));
	form.classList.remove('open');
	form.reset();
	byId('creditFormError').textContent = '';
}

// The form belongs to the page shown; another page, or the list, closes it.
function homeCreditForm(){
	if(EDITING !== null && EDITING !== SHOWN) closeCreditForm();
}

function saveCreditForm(){
	const name = EDITING;
	if(name === null) return;
	const entry = Contributor.tidy(name, {
		bio: fieldById('cf_bio').value,
		...Object.fromEntries(LINKS.map(([k])=> [k, fieldById('cf_' + k).value])),
	});
	// the same rules as Check, applied to this entry alone; a link to the wrong site is only a warning
	// there, but here it is most likely pasted into the wrong field
	if(entry){
		const {errors, warnings} = Validator.validateContributors(JSON.parse(JSON.stringify(CATALOG.books)), KIND.infoKey, {[name]: entry.toJSON()});
		const problems = [...errors, ...warnings.filter(w=> !/matches no/.test(w))].map(e=> e.replace(/^\w+\[[^\]]*\]: /, ''));
		if(problems.length){ byId('creditFormError').textContent = problems.join('; '); return; }
	}
	if(entry) kept().set(name, entry); else kept().delete(name);
	closeCreditForm(); render(); persist();
	showIoStatus((entry ? `Saved ${KIND.one} info for ${name}.` : `Removed ${KIND.one} info for ${name}.`));
}

function removeCreditInfo(){
	const name = EDITING;
	if(name === null || !kept().has(name)) return;
	kept().delete(name);
	closeCreditForm(); render(); persist();
	showIoStatus(`Removed ${KIND.one} info for ${name}.`);
}

// ------------------------------------------------------------------ the address
// authors.html is the list, authors.html#a=Name an author's page (likewise #n= and #p=); links between
// them change the address, so Back and Forward step through them.
export function showAddress(){
	const name = nameFromPageHash(location.hash, KIND.hashKey);
	if(name === SHOWN && byId('creditBody').hasChildNodes()) return;
	const moved = name !== SHOWN;
	SHOWN = name;
	render();
	if(moved && typeof scrollTo === 'function') scrollTo(0, 0);
}

/**
 * Start the authors, narrators or publishers page.
 * @param {'author' | 'narrator' | 'publisher'} kind
 * @returns {Promise<void>}
 */
export function startCreditsPage(kind){
	KIND = CREDIT_KINDS[kind];
	for(const [k, [label, example]] of Object.entries(KIND.fields)){
		byId(`cf_${k}_label`).textContent = label;
		byId('cf_' + k).setAttribute('placeholder', example);
	}
	byId('creditForm').addEventListener('submit', e=>{ e.preventDefault(); saveCreditForm(); });
	byId('creditRemoveBtn').addEventListener('click', removeCreditInfo);
	byId('cancelCredit').addEventListener('click', closeCreditForm);
	byId('q').addEventListener('input', render);
	addEventListener('hashchange', showAddress);
	addEventListener('popstate', showAddress);
	return startPage(()=>{ SHOWN = nameFromPageHash(location.hash, KIND.hashKey); render(); });
}
