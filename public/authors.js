// The authors page: every author in the catalog, and one author's page (authors.html#a=Name) with what
// you keep about them (CATALOG.authors) (a short bio, their own site and their pages on Audible,
// Goodreads and Hardcover) and the series and titles of theirs you have, worked out from the books.
// Loading and saving live in store.js.
import {Author} from './modules/author.js';
import {Series} from './modules/series.js';
import {Validator} from './modules/validator.js';
import { CATALOG, persist, showIoStatus, startPage, byId, fieldById, spell, buildElement, fillElement, joined } from './store.js';
/** @import {Book} from './modules/book.js' */
/** @import {Child} from './store.js' */

/** @type {string | null} */
export let AUTHOR = null;             // the author shown (#a=...), or null for the list of authors
/** @type {string | null} */
let EDITING = null;            // the author whose info the form is editing, or null

// The links an author's page can have, in the order they are shown, with their form fields.
/** @type {['url' | 'audible' | 'goodreads' | 'hardcover', string][]} */
const LINKS = [['url', 'Website'], ['audible', 'Audible'], ['goodreads', 'Goodreads'], ['hardcover', 'Hardcover']];

// Addresses as the catalog page writes them (spaces as +), so its links and these look the same.
const enc = (/** @type {string} */ v)=> encodeURIComponent(v).replace(/%20/g, '+');
const dec = (/** @type {string} */ v)=>{ try{ return decodeURIComponent(v.replace(/\+/g, ' ')); }catch(e){ return v; } };
/** @type {(name: string) => string} */
export const authorHref = name=> 'authors.html#a=' + enc(name);
const bookHref = (/** @type {string} */ title)=> 'index.html#book=' + enc(title);
const seriesHref = (/** @type {string} */ name)=> 'index.html#series=' + enc(name);

/**
 * The author an address names (#a=Name), or null.
 * @param {string} hash
 * @returns {string | null}
 */
function authorFromHash(hash){
	const m = /^#a=(.*)$/.exec(String(hash || ''));
	const name = m ? dec(m[1]).trim() : '';
	return name || null;
}

/**
 * A bio as paragraphs: a blank line starts a new one, a single line break stays a line break.
 * @param {string} bio
 * @returns {HTMLParagraphElement[]}
 */
function bioParagraphs(bio){
	return bio.split(/\n{2,}/).map(p=> buildElement('p', {}, p.split('\n').flatMap((line, i)=> i ? [buildElement('br'), line] : [line])));
}

const plural = (/** @type {number} */ n, /** @type {string} */ word, many = word + 's')=> `${n} ${n === 1 ? word : many}`;

export function render(){
	homeAuthorForm();
	byId('crumb').classList.toggle('show', AUTHOR !== null);
	byId('authorControls').style.display = AUTHOR === null ? '' : 'none';
	document.title = (AUTHOR === null ? 'Authors' : AUTHOR) + spell(' · Audiobook Catalog');
	if(AUTHOR === null) renderList(); else renderAuthor(AUTHOR);
}

function renderList(){
	const q = fieldById('q').value.trim().toLowerCase();
	const all = CATALOG.authorList();
	const shown = q ? all.filter(a=> a.name.toLowerCase().includes(q)) : all;
	byId('subtitle').textContent = `${plural(all.length, 'author')} across ${plural(CATALOG.books.length, 'audiobook')}`;
	fillElement(byId('authorBody'), shown.length ? shown.map(a=> buildElement('div', {class: 'srow'},
		buildElement('div', {class: 'srow-head'},
			buildElement('a', {class: 'srow-title', href: authorHref(a.name)}, a.name), ' ',
			buildElement('span', {class: 'srow-owned'}, `${plural(a.books, 'book')}${a.series ? ', ' + plural(a.series, 'series', 'series') : ''}`)),
		bioLine(a.name)))
		: buildElement('p', {class: 'empty'}, all.length ? 'No authors match your search.' : 'No books yet.'));
}

/**
 * The first line of an author's bio, for the list of authors; null when there is none.
 * @param {string} name
 * @returns {HTMLParagraphElement | null}
 */
function bioLine(name){
	const info = CATALOG.authors.get(name);
	return info && info.bio ? buildElement('p', {class: 'srow-note'}, info.bio.split('\n')[0]) : null;
}

/**
 * A book of the author's: its number in the series, its title (a link to it in the catalog), and who
 * else wrote it.
 * @param {Book} b
 * @param {string} name
 * @returns {HTMLLIElement}
 */
function bookLine(b, name){
	const others = b.authors.filter(x=> x !== name);
	return buildElement('li', {}, b.number && [buildElement('span', {class: 'num'}, '#' + b.number), ' '], buildElement('a', {href: bookHref(b.title)}, b.title),
		others.length > 0 && [' ', buildElement('span', {class: 'with'}, 'with ', joined(others.map(x=> buildElement('a', {href: authorHref(x)}, x)), ', '))]);
}

/** @param {string} name */
function renderAuthor(name){
	const info = CATALOG.authors.get(name) || new Author(name);
	const {series, titles} = CATALOG.authorWorks(name);
	const count = series.reduce((n, s)=> n + s.books.length, 0) + titles.length;
	byId('subtitle').textContent = count
		? `${plural(count, 'audiobook')}${series.length ? ' in ' + plural(series.length, 'series', 'series') : ''}${series.length && titles.length ? ` and ${titles.length} outside a series` : ''}`
		: spell('No books by this author in the catalog.');
	const label = CATALOG.authors.has(name) ? 'Edit author info' : 'Add author info';
	const links = LINKS.filter(([k])=> info[k]).map(([k, text])=>
		buildElement('a', {class: 'authorlink', href: info[k] || '', target: '_blank', rel: 'noopener'}, `${text} \u2197`));
	/** @type {Child[]} */
	const out = [
		buildElement('div', {class: 'author-head'}, buildElement('h2', {class: 'author-name'}, name),
			buildElement('button', {class: 'iconbtn aedit', 'data-edit-author': '1', title: label, 'aria-label': label}, '\u270E')),
		info.bio && buildElement('div', {class: 'author-bio'}, bioParagraphs(info.bio)),
		links.length > 0 && buildElement('p', {class: 'author-links'}, joined(links, ' ')),
		!info.bio && !links.length && buildElement('p', {class: 'hint'}, 'No bio or links yet: add them with \u270E.'),
	];
	series.forEach(s=>{
		const si = CATALOG.series.get(s.name);
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, buildElement('a', {href: seriesHref(s.name)}, s.name),
				' ', buildElement('span', {class: 'n'}, `${Series.owned(s.books)} owned${si ? ' of ' + si.total : ''}`),
				si && [' ', buildElement('span', {class: `status ${si.status}`}, si.status === 'complete' ? 'complete' : 'ongoing')]),
			buildElement('ul', {class: 'author-books'}, s.books.map(b=> bookLine(b, name)))));
	});
	if(titles.length){
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, series.length ? 'Outside a series' : 'Titles', ' ', buildElement('span', {class: 'n'}, plural(titles.length, 'book'))),
			buildElement('ul', {class: 'author-books'}, titles.map(b=> bookLine(b, name)))));
	}
	fillElement(byId('authorBody'), out);
}

// ------------------------------------------------------------------ the author info form
/**
 * Edits the author's entry in CATALOG.authors; like every edit, it is kept in this browser (see persist in store.js).
 * @param {string} name
 */
export function openAuthorForm(name){
	const info = CATALOG.authors.get(name) || new Author(name);
	EDITING = name;
	byId('authorFormTitle').textContent = (CATALOG.authors.has(name) ? 'Author info: ' : 'Add author info: ') + name;
	fieldById('af_bio').value = info.bio || '';
	LINKS.forEach(([k])=> { fieldById('af_' + k).value = info[k] || ''; });
	byId('authorFormError').textContent = '';
	byId('authorRemoveBtn').style.display = CATALOG.authors.has(name) ? '' : 'none';
	const form = byId('authorForm');
	form.classList.add('open');
	form.scrollIntoView({behavior: 'smooth', block: 'center'});
}

function closeAuthorForm(){
	EDITING = null;
	const form = /** @type {HTMLFormElement} */ (byId('authorForm'));
	form.classList.remove('open');
	form.reset();
	byId('authorFormError').textContent = '';
}

// The form belongs to the author shown; another author's page, or the list, closes it.
function homeAuthorForm(){
	if(EDITING !== null && EDITING !== AUTHOR) closeAuthorForm();
}

function saveAuthorForm(){
	const name = EDITING;
	if(name === null) return;
	const entry = Author.tidy(name, {
		bio: fieldById('af_bio').value,
		...Object.fromEntries(LINKS.map(([k])=> [k, fieldById('af_' + k).value])),
	});
	// the same rules as Check, applied to this author alone; a link to the wrong site is
	// only a warning there, but here it is most likely pasted into the wrong field
	if(entry){
		const {errors, warnings} = Validator.validateAuthors(JSON.parse(JSON.stringify(CATALOG.books)), {[name]: entry.toJSON()});
		const problems = [...errors, ...warnings.filter(w=> !/matches no author/.test(w))].map(e=> e.replace(/^authors\[[^\]]*\]: /, ''));
		if(problems.length){ byId('authorFormError').textContent = problems.join('; '); return; }
	}
	if(entry) CATALOG.authors.set(name, entry); else CATALOG.authors.delete(name);
	closeAuthorForm(); render(); persist();
	showIoStatus((entry ? `Saved author info for ${name}.` : `Removed author info for ${name}.`));
}

function removeAuthorInfo(){
	const name = EDITING;
	if(name === null || !CATALOG.authors.has(name)) return;
	CATALOG.authors.delete(name);
	closeAuthorForm(); render(); persist();
	showIoStatus(`Removed author info for ${name}.`);
}

byId('authorForm').addEventListener('submit', e=>{ e.preventDefault(); saveAuthorForm(); });
byId('authorRemoveBtn').addEventListener('click', removeAuthorInfo);
byId('cancelAuthor').addEventListener('click', closeAuthorForm);
byId('authorBody').addEventListener('click', e=>{
	const target = /** @type {Element | null} */ (e.target);
	const btn = target && target.closest ? target.closest('[data-edit-author]') : null;
	if(btn && AUTHOR !== null) openAuthorForm(AUTHOR);
});
byId('q').addEventListener('input', render);

// ------------------------------------------------------------------ the address
// authors.html is the list, authors.html#a=Name an author's page; links between them change the
// address, so Back and Forward step through them.
export function showAddress(){
	const name = authorFromHash(location.hash);
	if(name === AUTHOR && byId('authorBody').hasChildNodes()) return;
	const moved = name !== AUTHOR;
	AUTHOR = name;
	render();
	if(moved && typeof scrollTo === 'function') scrollTo(0, 0);
}
addEventListener('hashchange', showAddress);
addEventListener('popstate', showAddress);

// After a save to disk tidied the books or the author info (store.js).
export const READY = startPage(()=>{ AUTHOR = authorFromHash(location.hash); render(); });
