// The authors page: every author in the catalog, and one author's page (authors.html#a=Name) with what
// you keep about them (AUTHORS) (a short bio, their own site and their pages on Audible,
// Goodreads and Hardcover) and the series and titles of theirs you have, worked out from the books.
// Loading and saving live in store.js.
import * as CatalogImport from './importers.js';
import { DATA, SERIES_INFO, AUTHORS, setAuthors, esc, persist, showIoStatus, startPage, byId, fieldById, spell } from './store.js';
/** @import {Book, IndexedBook, AuthorEntry} from './importers.js' */

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
 * @returns {string}
 */
function bioHtml(bio){
	return bio.split(/\n{2,}/).map(p=> `<p>${p.split('\n').map(esc).join('<br>')}</p>`).join('');
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
	const all = CatalogImport.authorList(DATA);
	const shown = q ? all.filter(a=> a.name.toLowerCase().includes(q)) : all;
	byId('subtitle').textContent = `${plural(all.length, 'author')} across ${plural(DATA.length, 'audiobook')}`;
	const html = shown.map(a=> `<div class="srow"><div class="srow-head">
			<a class="srow-title" href="${esc(authorHref(a.name))}">${esc(a.name)}</a>
			<span class="srow-owned">${plural(a.books, 'book')}${a.series ? ', ' + plural(a.series, 'series', 'series') : ''}</span>
		</div>${AUTHORS[a.name] && AUTHORS[a.name].bio ? `<p class="srow-note">${esc((AUTHORS[a.name].bio || '').split('\n')[0])}</p>` : ''}</div>`).join('');
	byId('authorBody').innerHTML = html ||
		`<p class="empty">${all.length ? 'No authors match your search.' : 'No books yet.'}</p>`;
}

/**
 * A book of the author's: its number in the series, its title (a link to it in the catalog), and who
 * else wrote it.
 * @param {Book} b
 * @param {string} name
 * @returns {string}
 */
function bookLine(b, name){
	const others = b.a.filter(x=> x !== name);
	return `<li>${b.sn ? `<span class="num">#${esc(b.sn)}</span> ` : ''}<a href="${esc(bookHref(b.t))}">${esc(b.t)}</a>` +
		(others.length ? ` <span class="with">with ${others.map(x=> `<a href="${esc(authorHref(x))}">${esc(x)}</a>`).join(', ')}</span>` : '') + '</li>';
}

/** @param {string} name */
function renderAuthor(name){
	/** @type {AuthorEntry} */
	const info = AUTHORS[name] || {};
	const {series, titles} = CatalogImport.authorWorks(DATA, name);
	const count = series.reduce((n, s)=> n + s.books.length, 0) + titles.length;
	byId('subtitle').textContent = count
		? `${plural(count, 'audiobook')}${series.length ? ' in ' + plural(series.length, 'series', 'series') : ''}${series.length && titles.length ? ` and ${titles.length} outside a series` : ''}`
		: spell('No books by this author in the catalog.');
	const label = AUTHORS[name] ? 'Edit author info' : 'Add author info';
	let html = `<div class="author-head"><h2 class="author-name">${esc(name)}</h2>` +
		`<button class="iconbtn aedit" data-edit-author="1" title="${label}" aria-label="${label}">&#9998;</button></div>`;
	if(info.bio) html += `<div class="author-bio">${bioHtml(info.bio)}</div>`;
	const links = LINKS.filter(([k])=> info[k]).map(([k, text])=>
		`<a class="authorlink" href="${esc(info[k])}" target="_blank" rel="noopener">${text} ↗</a>`);
	if(links.length) html += `<p class="author-links">${links.join(' ')}</p>`;
	if(!info.bio && !links.length) html += '<p class="hint">No bio or links yet: add them with &#9998;.</p>';

	series.forEach(s=>{
		const si = SERIES_INFO[s.name];
		const owned = `${CatalogImport.seriesOwned(s.books)} owned${si ? ' of ' + esc(si.total) : ''}`;
		html += `<div class="series-group"><p class="series-title"><a href="${esc(seriesHref(s.name))}">${esc(s.name)}</a>` +
			` <span class="n">${owned}</span>` +
			(si ? ` <span class="status ${si.status}">${si.status === 'complete' ? 'complete' : 'ongoing'}</span>` : '') + '</p>' +
			`<ul class="author-books">${s.books.map(b=> bookLine(b, name)).join('')}</ul></div>`;
	});
	if(titles.length){
		html += `<div class="series-group"><p class="series-title">${series.length ? 'Outside a series' : 'Titles'} <span class="n">${plural(titles.length, 'book')}</span></p>` +
			`<ul class="author-books">${titles.map(b=> bookLine(b, name)).join('')}</ul></div>`;
	}
	byId('authorBody').innerHTML = html;
}

// ------------------------------------------------------------------ the author info form
/**
 * Edits the author's entry in AUTHORS; like every edit, it is kept in this browser (see persist in store.js).
 * @param {string} name
 */
export function openAuthorForm(name){
	/** @type {AuthorEntry} */
	const info = AUTHORS[name] || {};
	EDITING = name;
	byId('authorFormTitle').textContent = (AUTHORS[name] ? 'Author info: ' : 'Add author info: ') + name;
	fieldById('af_bio').value = info.bio || '';
	LINKS.forEach(([k])=> { fieldById('af_' + k).value = info[k] || ''; });
	byId('authorFormError').textContent = '';
	byId('authorRemoveBtn').style.display = AUTHORS[name] ? '' : 'none';
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
	const entry = CatalogImport.tidyAuthor({
		bio: fieldById('af_bio').value,
		...Object.fromEntries(LINKS.map(([k])=> [k, fieldById('af_' + k).value])),
	});
	// the same rules as Check, applied to this author alone; a link to the wrong site is
	// only a warning there, but here it is most likely pasted into the wrong field
	if(entry){
		const {errors, warnings} = CatalogImport.validateAuthors(DATA, {[name]: entry});
		const problems = [...errors, ...warnings.filter(w=> !/matches no author/.test(w))].map(e=> e.replace(/^authors\[[^\]]*\]: /, ''));
		if(problems.length){ byId('authorFormError').textContent = problems.join('; '); return; }
	}
	const {[name]: _old, ...rest} = AUTHORS;
	setAuthors(entry ? {...rest, [name]: entry} : rest);
	closeAuthorForm(); render(); persist();
	showIoStatus((entry ? `Saved author info for ${name}.` : `Removed author info for ${name}.`));
}

function removeAuthorInfo(){
	const name = EDITING;
	if(name === null || !AUTHORS[name]) return;
	const {[name]: _removed, ...rest} = AUTHORS;
	setAuthors(rest);
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
	if(name === AUTHOR && byId('authorBody').innerHTML) return;
	const moved = name !== AUTHOR;
	AUTHOR = name;
	render();
	if(moved && typeof scrollTo === 'function') scrollTo(0, 0);
}
addEventListener('hashchange', showAddress);
addEventListener('popstate', showAddress);

// After a save to disk tidied the books or the author info (store.js).
export const READY = startPage(()=>{ AUTHOR = authorFromHash(location.hash); render(); });
