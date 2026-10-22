// A book looked up in the external catalogs a web page may read, to fill in the book form: Open Library and
// Wikidata answer any page without an account (open CORS, no key), and Hardcover does with the token saved in
// this browser. Audible's, Amazon's and Goodreads' pages can't be read from a page, so their ASINs and ids are
// looked up on Hardcover, which knows them. Nothing here changes the catalog; the requests are passed in, so
// the tests run it offline.
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {Edition} from './edition.js';
import {Importer} from './importer.js';
import {ExternalCatalog} from './external-catalog.js';
import {HardcoverClient} from './hardcover-client.js';
import {HardcoverSync} from './hardcover-sync.js';
/** @import {Unchecked} from './text.js' */

/** @typedef {(url: string) => Promise<{ok: boolean, status: number, json: () => Promise<unknown>}>} Get a fetch of an address */
/**
 * What was pasted: an ISBN, or an id in an external catalog of a book or an edition (`slug` for a Hardcover
 * book's page, whose id only Hardcover knows).
 * @typedef {{catalog: string, kind: 'book' | 'edition' | 'isbn', id: string, slug?: string}} Pasted
 */
/**
 * What a lookup found: the book (with one edition at most), the catalogs that gave it, and what could not be
 * asked and why.
 * @typedef {{book: Book, sources: string[], notes: string[]}} Found
 */

const OPEN_LIBRARY = 'https://openlibrary.org';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
// Wikidata's properties of a book: its title, authors, series (with the number as a qualifier), genres, and
// its ids in catalogs this app knows
const P = {title: 'P1476', author: 'P50', series: 'P179', number: 'P1545', genre: 'P136', openLibrary: 'P648', goodreadsWork: 'P8383', isfdbTitle: 'P1274'};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NO_HARDCOVER = 'save your Hardcover API token on the Import & export page';

/** Looks books up in the external catalogs a page may read. */
export class CatalogLookup {
	/**
	 * @param {Get} get asks Open Library and Wikidata
	 * @param {HardcoverClient | null} hardcover asks Hardcover, or null when there is no token
	 */
	constructor(get, hardcover){
		this.get = get;
		this.hardcover = hardcover;
	}

	/**
	 * What a pasted address or id names: an ISBN; an address of a book's or edition's page in an external
	 * catalog (also a Hardcover book's page by its name); a bare Open Library id (OL…W, OL…M), Wikidata item
	 * (Q…) or ASIN (audible.com's, as the book form takes a bare one). null when it is none of them.
	 * @param {unknown} text
	 * @returns {Pasted | null}
	 */
	static read(text){
		const value = Text.tidy(String(text || ''));
		if(!value) return null;
		const isbn = Isbn.parse(value.replace(/^isbn(?:-1[03])?:?\s*/i, ''));
		if(isbn) return {catalog: 'isbn', kind: 'isbn', id: isbn};
		const hardcover = HardcoverClient.parseUrl(value);
		if(hardcover){
			if(hardcover.edition) return {catalog: 'hardcover', kind: 'edition', id: hardcover.edition};
			if(hardcover.book) return {catalog: 'hardcover', kind: 'book', id: hardcover.book};
			return {catalog: 'hardcover', kind: 'book', id: '', slug: hardcover.slug};
		}
		for(const kind of /** @type {const} */ (['edition', 'book'])){
			const found = ExternalCatalog.fromAddress(value, kind);
			if(found) return {...found, kind};
		}
		if(/^OL\d+M$/i.test(value)) return {catalog: 'openlibrary', kind: 'edition', id: value.toUpperCase()};
		if(/^OL\d+W$/i.test(value)) return {catalog: 'openlibrary', kind: 'book', id: value.toUpperCase()};
		if(/^Q\d+$/i.test(value)) return {catalog: 'wikidata', kind: 'book', id: value.toUpperCase()};
		if(/^B0[A-Z0-9]{8}$/i.test(value)) return {catalog: ExternalCatalog.AUDIBLE_SITE, kind: 'edition', id: value.toUpperCase()};
		return null;
	}

	/**
	 * The book `text` names, from the catalogs that have it: the one pasted first, then Hardcover (when it
	 * wasn't the one) by the edition's ISBN or ASIN, for the narrators and length Open Library and Wikidata
	 * don't have. What the first has wins; the others only fill in what it lacks. Throws with a short reason
	 * when `text` names nothing this can look up, or no catalog has it.
	 * @param {unknown} text
	 * @returns {Promise<Found>}
	 */
	async find(text){
		const pasted = CatalogLookup.read(text);
		if(!pasted) throw new Error('paste the address of a book or edition on Open Library, Wikidata, Hardcover, Audible, Amazon or Goodreads, or an ISBN');
		/** @type {Found} */
		const found = {book: new Book(), sources: [], notes: []};
		/** @type {(source: string, book: Book | null) => void} */
		const take = (source, book) => {
			if(!book) return;
			CatalogLookup.fill(found.book, book);
			if(!found.sources.includes(source)) found.sources.push(source);
		};
		const family = ExternalCatalog.family(pasted.catalog);
		if(pasted.catalog === 'openlibrary') take('Open Library', pasted.kind === 'edition' ? await this.openLibraryEdition(pasted.id) : await this.openLibraryWork(pasted.id));
		else if(pasted.catalog === 'wikidata') take('Wikidata', await this.wikidata(pasted.id));
		else if(pasted.kind === 'isbn'){
			// Hardcover first, as it knows audiobooks best
			take('Hardcover', await this.hardcoverBy('isbn', pasted.id, found));
			take('Open Library', await this.openLibraryIsbn(pasted.id));
		}
		else if(pasted.catalog === 'hardcover'){
			if(!this.hardcover) throw new Error(`to look it up on Hardcover, ${NO_HARDCOVER} first`);
			take('Hardcover', await this.hardcoverPasted(pasted));
		}
		else if(family === 'asin' || pasted.catalog === 'goodreads'){
			const name = family === 'asin' ? ExternalCatalog.groupOf(pasted.catalog)?.name || 'Audible' : 'Goodreads';
			if(!this.hardcover) throw new Error(`${name} can't be read from a web page; to look its ${family === 'asin' ? 'ASIN' : 'id'} up on Hardcover, ${NO_HARDCOVER} first`);
			if(family === 'goodreads' && pasted.kind === 'book') throw new Error('Hardcover knows Goodreads editions (goodreads.com/book/show/…), not their works; paste the edition\'s address');
			const book = await this.hardcoverBy(family === 'asin' ? 'asin' : 'gr', pasted.id, found);
			if(!book) throw new Error(`Hardcover has no edition with ${family === 'asin' ? 'ASIN' : 'Goodreads id'} ${pasted.id}`);
			take('Hardcover', book);
		}
		else throw new Error(`${ExternalCatalog.name(pasted.catalog)} can't be read from a web page; paste an address on Open Library, Wikidata or Hardcover, or an ISBN`);
		// the id pasted stays, on the book or its edition
		if(pasted.kind === 'book' && pasted.id && !found.book.external[pasted.catalog]) found.book.external[pasted.catalog] = pasted.id;
		if(!found.sources.length){
			const where = pasted.kind === 'isbn' ? `with ISBN ${pasted.id}` : pasted.id;
			throw new Error(`no catalog has a book ${where}${this.hardcover ? '' : ` (to ask Hardcover too, ${NO_HARDCOVER})`}`);
		}
		if(pasted.kind === 'edition'){
			if(!found.book.editions.length) found.book.editions = [new Edition()];
			const [ed] = found.book.editions;
			if(!ed.external[pasted.catalog]) ed.external = ExternalCatalog.order({[pasted.catalog]: pasted.id, ...ed.external}) || {};
		}
		// Hardcover for what the others lack (narrators, length), by the edition's ISBN or ASIN
		const ed = found.book.editions[0];
		if(!found.sources.includes('Hardcover') && ed){
			const asin = ed.ids('asin')[0], isbn = ed.isbns()[0];
			if(this.hardcover && (asin || isbn)) take('Hardcover', await this.hardcoverBy(asin ? 'asin' : 'isbn', asin || isbn, found));
			else if(!this.hardcover) found.notes.push(`to fill in narrators and length from Hardcover too, ${NO_HARDCOVER}`);
		}
		return found;
	}

	/**
	 * Fill `book` in (in place) from `from`: its title, authors, series and number,
	 * genres where it has none; ids in catalogs it has none in; the edition where it has none, else the
	 * edition's gaps when the two don't disagree.
	 * @param {Book} book
	 * @param {Book} from
	 */
	static fill(book, from){
		if(!book.title) book.title = from.title;
		if(!book.authors.length) book.authors = [...from.authors];
		if(!book.series && from.series){
			book.series = from.series;
			if(from.number) book.number = from.number;
		}
		else if(book.series && !book.number && from.number && from.series === book.series) book.number = from.number;
		if(!book.genres.length) book.genres = [...from.genres];
		for(const [key, id] of Object.entries(from.external)) if(!book.external[key]) book.external[key] = id;
		const [ed] = from.editions;
		if(!ed) return;
		if(!book.editions.length) book.editions = [ed];
		else if(!book.editions[0].conflictsWith(ed)) book.editions[0].fillFrom(ed);
	}

	// ------------------------------------------------------------------ Open Library
	/**
	 * An Open Library answer, or null when it has no such page.
	 * @param {string} path
	 * @returns {Promise<Unchecked | null>}
	 */
	async openLibrary(path){
		return this.json('Open Library', OPEN_LIBRARY + path);
	}

	/**
	 * @param {string} source what the reasons call it
	 * @param {string} url
	 * @returns {Promise<Unchecked | null>} the answer, null for a 404; throws with a short reason otherwise
	 */
	async json(source, url){
		let res;
		try{ res = await this.get(url); }
		catch(e){ throw new Error(`this browser could not reach ${source} (offline?)`, {cause: e}); }
		if(res.status === 404) return null;
		if(!res.ok) throw new Error(`${source} answered ${res.status}`);
		const json = await res.json().catch(() => null);
		if(!Text.isObject(json)) throw new Error(`${source} sent something that isn't a book`);
		return json;
	}

	/**
	 * The names of Open Library's authors, by their keys ("/authors/OL1A"); those it doesn't have are left out.
	 * @param {unknown[]} keys
	 * @returns {Promise<string[]>}
	 */
	async openLibraryAuthors(keys){
		const names = [];
		for(const key of keys.filter(k => typeof k === 'string' && /^\/authors\/OL\d+A$/.test(k)).slice(0, 10)){
			const author = await this.openLibrary(`${key}.json`);
			if(author && typeof author.name === 'string' && Text.tidy(author.name)) names.push(Text.tidy(author.name));
		}
		return [...new Set(names)];
	}

	/**
	 * A book from Open Library's work.
	 * @param {string} id OL…W
	 * @returns {Promise<Book>}
	 */
	async openLibraryWork(id){
		const work = await this.openLibrary(`/works/${id}.json`);
		if(!work) throw new Error(`Open Library has no work ${id}`);
		const authors = await this.openLibraryAuthors((Array.isArray(work.authors) ? work.authors : [])
			.map((/** @type {unknown} */ a) => Text.isObject(a) && Text.isObject(a.author) ? a.author.key : null));
		return CatalogLookup.openLibraryBook(work, null, authors);
	}

	/**
	 * A book with its edition from Open Library's edition (and its work, for the authors when the edition
	 * names none).
	 * @param {string} id OL…M
	 * @returns {Promise<Book>}
	 */
	async openLibraryEdition(id){
		const edition = await this.openLibrary(`/books/${id}.json`);
		if(!edition) throw new Error(`Open Library has no edition ${id}`);
		return this.openLibraryOf(edition);
	}

	/**
	 * The book of the edition with this ISBN on Open Library; null when it has none.
	 * @param {string} isbn
	 * @returns {Promise<Book | null>}
	 */
	async openLibraryIsbn(isbn){
		const edition = await this.openLibrary(`/isbn/${isbn}.json`);
		return edition ? this.openLibraryOf(edition) : null;
	}

	/**
	 * @param {Unchecked} edition an Open Library edition
	 * @returns {Promise<Book>}
	 */
	async openLibraryOf(edition){
		const workKey = Array.isArray(edition.works) && Text.isObject(edition.works[0]) && typeof edition.works[0].key === 'string' ? edition.works[0].key : null;
		const work = workKey && /^\/works\/OL\d+W$/.test(workKey) ? await this.openLibrary(`${workKey}.json`) : null;
		const of = (/** @type {Unchecked | null} */ x) => x && Array.isArray(x.authors) ? x.authors.map((/** @type {unknown} */ a) =>
			Text.isObject(a) ? Text.isObject(a.author) ? a.author.key : a.key : null) : [];
		const editionAuthors = of(edition);
		const authors = await this.openLibraryAuthors(editionAuthors.length ? editionAuthors : of(work));
		return CatalogLookup.openLibraryBook(work || {}, edition, authors);
	}

	/**
	 * A book made of an Open Library work and edition (either may be all but empty) and its authors' names.
	 * @param {Unchecked} work
	 * @param {Unchecked | null} edition
	 * @param {string[]} authors
	 * @returns {Book}
	 */
	static openLibraryBook(work, edition, authors){
		/** @type {(x: unknown) => string} */
		const text = x => typeof x === 'string' ? Text.tidy(x) : '';
		/** @type {(x: unknown, re: RegExp) => string | null} */
		const idOf = (x, re) => { const m = re.exec(text(x)); return m ? m[1] : null; };
		/** @type {(x: unknown) => unknown} */
		const first = x => Array.isArray(x) ? x[0] : undefined;
		/** @type {Record<string, any>} */
		const rec = {t: text(work.title) || (edition ? text(edition.title) : ''), a: authors};
		const workId = idOf(work.key, /^\/works\/(OL\d+W)$/);
		if(workId) rec.ext = {openlibrary: workId};
		if(edition){
			const series = CatalogLookup.seriesOf(text(first(edition.series)));
			if(series){ rec.s = series.name; if(series.number) rec.sn = series.number; }
			/** @type {Record<string, any>} */
			const ed = {ext: {}};
			const editionId = idOf(edition.key, /^\/books\/(OL\d+M)$/);
			if(editionId) ed.ext.openlibrary = editionId;
			const ids = Text.isObject(edition.identifiers) ? edition.identifiers : {};
			const goodreads = text(first(ids.goodreads));
			if(/^\d+$/.test(goodreads)) ed.ext.goodreads = goodreads;
			// Open Library's Amazon id is amazon.com's; a print book's is its ISBN-10, which is no ASIN
			const amazon = text(first(ids.amazon)).toUpperCase();
			if(/^B[A-Z0-9]{9}$/.test(amazon)) ed.ext[ExternalCatalog.AMAZON_SITE] = amazon;
			const isbn = [first(edition.isbn_13), first(edition.isbn_10)].map(Isbn.parse).find(Boolean);
			if(isbn) ed.isbn = isbn;
			const publisher = text(first(edition.publishers));
			if(publisher) ed.p = publisher;
			const released = CatalogLookup.date(edition.publish_date);
			if(released) ed.d = released;
			const narrators = (Array.isArray(edition.contributors) ? edition.contributors : [])
				.filter((/** @type {unknown} */ c) => Text.isObject(c) && /narrat|read/i.test(text(c.role))).map((/** @type {Unchecked} */ c) => text(c.name)).filter(Boolean);
			if(narrators.length) ed.n = narrators;
			if(!Object.keys(ed.ext).length) delete ed.ext;
			if(Object.keys(ed).length) rec.e = [ed];
		}
		return Importer.book(Book.fixSeriesTitle(rec));
	}

	/**
	 * A series as Open Library writes it on an edition ("Discworld (3)", "The Expanse ; 1", "Discworld -- 3")
	 * as {name, number}; null when there is none.
	 * @param {string} text
	 * @returns {{name: string, number: string | null} | null}
	 */
	static seriesOf(text){
		const value = Text.tidy(text);
		if(!value) return null;
		const m = /^(.*?)[\s,;:(#-]+(?:(?:book|vol(?:ume)?|no|number)\.?\s*)?#?\s*(\d+(?:\.\d+)?)\)?$/i.exec(value);
		if(m && Text.tidy(m[1])) return {name: Text.tidy(m[1]), number: m[2]};
		return {name: value, number: null};
	}

	/**
	 * A date as catalogs write it ("1988", "October 1, 1988", "1 Oct 1988", "Oct 1988", "1988-10-01") in the
	 * catalog's form (YYYY-MM-DD, YYYY-MM or YYYY); null when it is none of them.
	 * @param {unknown} text
	 * @returns {string | null}
	 */
	static date(text){
		const value = Text.tidy(String(text || '')).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
		const iso = Text.parseDate(value.replace(/T.*$/, ''));
		if(iso) return iso;
		const month = (/** @type {string} */ name) => { const i = MONTHS.findIndex(m => name.length >= 3 && m.startsWith(name.toLowerCase())); return i < 0 ? null : i + 1; };
		/** @type {(y: string, mo: number | null, d?: string) => string | null} */
		const make = (y, mo, d) => mo ? Text.parseDate(d ? `${y}-${mo}-${d}` : `${y}-${mo}`) : null;
		let m = /^([a-z]+) (\d{1,2}) (\d{4})$/i.exec(value);
		if(m && month(m[1])) return make(m[3], month(m[1]), m[2]);
		m = /^(\d{1,2}) ([a-z]+) (\d{4})$/i.exec(value);
		if(m && month(m[2])) return make(m[3], month(m[2]), m[1]);
		m = /^([a-z]+) (\d{4})$/i.exec(value);
		if(m && month(m[1])) return make(m[2], month(m[1]));
		// a season, or words around the year
		m = /^(?:[a-z]+ )*(\d{4})$/i.exec(value);
		return m ? m[1] : null;
	}

	// ------------------------------------------------------------------ Wikidata
	/**
	 * Wikidata's items, by id, with their labels (in English) and claims.
	 * @param {string[]} ids
	 * @param {boolean} claims
	 * @returns {Promise<Record<string, Unchecked>>}
	 */
	async wikidataItems(ids, claims){
		if(!ids.length) return {};
		const params = new URLSearchParams({action: 'wbgetentities', ids: ids.slice(0, 50).join('|'), props: claims ? 'labels|claims' : 'labels',
			languages: 'en', languagefallback: '1', format: 'json', origin: '*'});
		const answer = await this.json('Wikidata', `${WIKIDATA_API}?${params}`);
		return answer && Text.isObject(answer.entities) ? answer.entities : {};
	}

	/**
	 * A book from its Wikidata item: its title, authors, series and number, genres, and its ids in Open Library
	 * (a work), Goodreads (a work) and ISFDB (a title).
	 * @param {string} id Q…
	 * @returns {Promise<Book>}
	 */
	async wikidata(id){
		const item = (await this.wikidataItems([id], true))[id];
		if(!Text.isObject(item) || 'missing' in item) throw new Error(`Wikidata has no item ${id}`);
		const claims = Text.isObject(item.claims) ? item.claims : {};
		/** @type {(prop: string) => Unchecked[]} */
		const of = prop => Array.isArray(claims[prop]) ? claims[prop].filter((/** @type {unknown} */ c) => Text.isObject(c) && c.rank !== 'deprecated') : [];
		/** @type {(claim: Unchecked) => unknown} */
		const value = claim => Text.isObject(claim.mainsnak) && Text.isObject(claim.mainsnak.datavalue) ? claim.mainsnak.datavalue.value : undefined;
		/** @type {(prop: string) => string[]} the items a property names */
		const items = prop => of(prop).map(c => { const v = value(c); return Text.isObject(v) && typeof v.id === 'string' ? v.id : ''; }).filter(Boolean);
		/** @type {(prop: string) => string} */
		const string = prop => { const v = of(prop).map(value).find(x => typeof x === 'string'); return typeof v === 'string' ? Text.tidy(v) : ''; };
		const authors = items(P.author), series = items(P.series), genres = items(P.genre).slice(0, 5);
		if(!authors.length) throw new Error(`Wikidata's ${id} names no author, so it is not a book`);
		const labels = await this.wikidataItems([...new Set([...authors, ...series.slice(0, 1), ...genres])], false);
		/** @type {(x: string) => string} */
		const label = x => { const l = labels[x] && Text.isObject(labels[x].labels) ? labels[x].labels.en : null; return Text.isObject(l) && typeof l.value === 'string' ? Text.tidy(l.value) : ''; };
		const own = Text.isObject(item.labels) && Text.isObject(item.labels.en) ? item.labels.en.value : '';
		const title = of(P.title).map(value).find(v => Text.isObject(v) && typeof v.text === 'string');
		/** @type {Record<string, any>} */
		const rec = {t: Text.tidy(Text.isObject(title) ? title.text : typeof own === 'string' ? own : ''), a: authors.map(label).filter(Boolean)};
		if(!rec.t || !rec.a.length) throw new Error(`Wikidata's ${id} has no title or author in English`);
		const [inSeries] = of(P.series);
		if(inSeries && label(series[0])){
			rec.s = label(series[0]);
			const qualifiers = Text.isObject(inSeries.qualifiers) && Array.isArray(inSeries.qualifiers[P.number]) ? inSeries.qualifiers[P.number] : [];
			const n = qualifiers.map((/** @type {Unchecked} */ q) => Text.isObject(q.datavalue) ? q.datavalue.value : null).find((/** @type {unknown} */ x) => typeof x === 'string');
			if(n && /^\d+(?:\.\d+)?$/.test(n.trim())) rec.sn = n.trim();
		}
		const g = genres.map(label).filter(Boolean);
		if(g.length) rec.g = g;
		/** @type {Record<string, string>} */
		const ext = {wikidata: id};
		const openLibrary = string(P.openLibrary).toUpperCase(), goodreads = string(P.goodreadsWork), isfdb = string(P.isfdbTitle);
		if(/^OL\d+W$/.test(openLibrary)) ext.openlibrary = openLibrary;
		if(/^\d+$/.test(goodreads)) ext.goodreads = goodreads;
		if(/^\d+$/.test(isfdb)) ext.isfdb = isfdb;
		rec.ext = ext;
		return Importer.book(rec);
	}

	// ------------------------------------------------------------------ Hardcover
	/**
	 * A book from Hardcover by its book or edition id, or its page's name (pasted).
	 * @param {Pasted} pasted
	 * @returns {Promise<Book>}
	 */
	async hardcoverPasted(pasted){
		const client = /** @type {HardcoverClient} */ (this.hardcover);
		if(pasted.kind === 'edition'){
			const book = await this.hardcoverBook(null, pasted.id);
			if(!book) throw new Error(`Hardcover has no edition ${pasted.id}`);
			return book;
		}
		const id = pasted.id || (await HardcoverClient.bookId(client, `hardcover.app/books/${pasted.slug}`)).id;
		const book = await this.hardcoverBook(id, null);
		if(!book) throw new Error(`Hardcover has no book ${id}`);
		return book;
	}

	/**
	 * A book from Hardcover by an edition's ASIN, ISBN or Goodreads id; null when Hardcover has none, or can't
	 * be asked (no token, or it refused: `found` notes why).
	 * @param {'asin' | 'isbn' | 'gr'} kind
	 * @param {string} id
	 * @param {Found} found
	 * @returns {Promise<Book | null>}
	 */
	async hardcoverBy(kind, id, found){
		if(!this.hardcover) return null;
		try{
			const hits = (await this.hardcover.find({[kind]: [id]}, () => {}))[kind];
			const hit = hits.get(id);
			if(!hit) return null;
			return await this.hardcoverBook(hit.hcb, hit.hc);
		}catch(err){
			found.notes.push(`Hardcover couldn't be asked: ${Text.errorText(err)}`);
			return null;
		}
	}

	/**
	 * A book from Hardcover: the book (by its id, or the edition's) with the edition, or with its audiobook
	 * edition when none is named; null when Hardcover has no such book or edition.
	 * @param {string | null} bookId
	 * @param {string | null} editionId
	 * @returns {Promise<Book | null>}
	 */
	async hardcoverBook(bookId, editionId){
		const client = /** @type {HardcoverClient} */ (this.hardcover);
		/** @type {Unchecked | null} */
		let edition = null;
		if(editionId){
			const [row] = (await client.ask(HardcoverClient.QUERIES.editions, {ids: [Number(editionId)]})).editions || [];
			if(!Text.isObject(row)) return null;
			edition = row;
			if(!bookId && Number.isInteger(row.book_id)) bookId = String(row.book_id);
		}
		if(!bookId) return null;
		const [book] = (await client.ask(HardcoverClient.QUERIES.books, {ids: [Number(bookId)]})).books || [];
		if(!Text.isObject(book) || typeof book.title !== 'string') return null;
		if(!edition){
			const [audio] = (await client.ask(HardcoverClient.QUERIES.audioEditions, {book: Number(bookId)})).editions || [];
			if(Text.isObject(audio)) edition = audio;
		}
		/** @type {Record<string, any>} */
		const rec = {t: Text.tidy(book.title), a: HardcoverSync.people(book.contributions), ext: {hardcover: bookId}};
		const series = Text.isObject(book.featured_book_series) ? book.featured_book_series : null;
		if(series && Text.isObject(series.series) && typeof series.series.name === 'string' && Text.tidy(series.series.name)){
			rec.s = Text.tidy(series.series.name);
			const number = HardcoverSync.position(series.position);
			if(number) rec.sn = number;
		}
		if(edition) rec.e = [HardcoverSync.edition(edition).toJSON()];
		return Importer.book(Book.fixSeriesTitle(rec));
	}
}
