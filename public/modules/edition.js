// An edition of a book: its ids in external catalogs (an ASIN per Audible and Amazon site, Goodreads,
// Hardcover, Open Library, ...; see ExternalCatalog), its ISBN, narrators, publisher, release date, length and your own
// description of it ("UK edition"). A box set is one edition on each of its titles, linked by the ids the
// copies share (sameAs).
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {ExternalCatalog} from './external-catalog.js';
/** @import {Unchecked} from './text.js' */

/** @typedef {'ext' | 'isbn' | 'n' | 'p' | 'd' | 'len' | 'desc'} EditionKey the keys of an edition as it is stored */

/**
 * What a new Edition is made of; every part is optional.
 * @typedef {object} EditionInit
 * @property {Record<string, string>} [external] its ids by external catalog: {"audible.com": "B0…", "goodreads": "4242", "hardcover": "501"}
 * @property {string} [isbn] one ISBN, the 13-digit form (another ISBN is another edition)
 * @property {string[]} [narrators]
 * @property {string} [publisher]
 * @property {string} [released] release date: "2021-05-04", "2021-05" or "2021"
 * @property {number} [minutes] length in whole minutes
 * @property {string} [description] your own description of the edition ("UK edition")
 * @property {string} [id] the id it is stored under in this browser, which never changes; a box set's copies share it
 */

// The catalogs other than Audible's and Amazon's sites, as format() names them: "Open Library OL1M"
// (an edition's id), "Hardcover book 77" (the book's).
const OTHER_CATALOGS = ExternalCatalog.ALL.filter(def => def.family !== 'asin');
const CATALOG_LABEL = `(?:${OTHER_CATALOGS.map(def => Text.escapeRegExp(def.name).replace(/ /g, '\\s+')).join('|')})(?:\\s+(?:book|edition))?(?:\\s+id)?`;
const EDITION_PART = new RegExp(`^(asin|${CATALOG_LABEL}|gr|isbns?|publisher|released?|length|narrated\\s+by|narrators?|description)\\b:?\\s*(.*)$`, 'i');
// Before ids were kept by external catalog, an edition kept them under keys of their own: its ASINs by
// site ("asin"), before that one ASIN ("id", audible.com's), its Goodreads id ("gr") and Hardcover id ("hc").
/** @type {Record<string, string>} */
const OLD_ID_KEYS = {gr: 'goodreads', hc: 'hardcover'};

// A list of names, as the narrators are kept.
/**
 * @param {unknown} v
 * @returns {v is string[]}
 */
function nameList(v){ return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.trim() !== ''); }
/**
 * @param {unknown} v
 * @returns {v is string}
 */
function nonEmpty(v){ return typeof v === 'string' && v.trim() !== ''; }
/** @type {(key: string) => boolean} whether a catalog's ids are ASINs */
const isAsinSite = key => ExternalCatalog.family(key) === 'asin';

/** An edition of a book. */
export class Edition {
	/** @type {EditionKey[]} the keys of a stored edition, in order */
	static KEYS = ['ext', 'isbn', 'n', 'p', 'd', 'len', 'desc'];
	// The key a backup keeps the edition's id under, before the others; like Book.ID_KEY it is not one of KEYS.
	// ("id" was an edition's ASIN before ASINs were kept by site; see fixIds.)
	static ID_KEY = 'uid';
	// The fields of the page's edition editor: [key, the label parse() reads, the label the page shows].
	// 'ext' stands for the external ids, a field for each catalog (fieldLabel()).
	/** @type {[EditionKey, string, string][]} */
	static FIELDS = [
		['desc', 'Description', 'Description'], ['n', 'Narrated by', 'Narrators'], ['ext', '', 'ASINs'],
		['isbn', 'ISBN', 'ISBN'], ['p', 'Publisher', 'Publisher'], ['d', 'Released', 'Released'], ['len', 'Length', 'Length'],
	];

	/** @param {EditionInit} [init] */
	constructor({external = {}, isbn, narrators = [], publisher, released, minutes, description, id} = {}){
		/** @type {string | undefined} the id it is stored under (CatalogRecords gives one to an edition that has none) */
		this.id = id;
		/** @type {Record<string, string>} its ids by external catalog */
		this.external = {...external};
		/** @type {string | undefined} */
		this.isbn = isbn;
		/** @type {string[]} */
		this.narrators = [...narrators];
		/** @type {string | undefined} */
		this.publisher = publisher;
		/** @type {string | undefined} */
		this.released = released;
		/** @type {number | undefined} */
		this.minutes = minutes;
		/** @type {string | undefined} */
		this.description = description;
		/** @type {Record<string, unknown>} what the stored edition holds that is not an edition's value (the Check reports it) */
		this.extra = {};
	}

	/**
	 * An edition from the way it is stored (`{ext, isbn, n, p, d, len, desc}`), in the current format. A
	 * value that is not what its key holds, and a key an edition has not, is kept aside as it is and written
	 * back by toJSON(), so the Check still reports it. Throws when it is not an object.
	 * @param {Unchecked} json
	 * @returns {Edition}
	 */
	static fromJSON(json){
		if(!Text.isObject(json)) throw new Error('an edition is not an object');
		const ed = new Edition();
		for(const [k, v] of Object.entries(json)) ed.set(k, v);
		return ed;
	}

	/**
	 * Set the value of one of the stored edition's keys (as fromJSON() reads it).
	 * @param {string} key
	 * @param {unknown} v
	 */
	set(key, v){
		delete this.extra[key];
		if(key === Edition.ID_KEY){
			this.id = undefined;
			if(nonEmpty(v)) this.id = v;
			else if(v !== undefined) this.extra[key] = v;
		}
		else if(key === 'ext'){
			this.external = {};
			if(ExternalCatalog.isIds(v)) this.external = {...v};
			else if(v !== undefined) this.extra[key] = v;
		}
		else if(key === 'n'){
			this.narrators = [];
			if(nameList(v)) this.narrators = [...v];
			else if(v !== undefined) this.extra[key] = v;
		}
		else if(key === 'len'){
			this.minutes = undefined;
			if(typeof v === 'number') this.minutes = v;
			else if(v !== undefined) this.extra[key] = v;
		}
		else if(Object.hasOwn(TEXT_FIELDS, key)){
			const field = TEXT_FIELDS[key];
			this[field] = undefined;
			if(nonEmpty(v)) this[field] = v;
			else if(v !== undefined) this.extra[key] = v;
		}
		else if(v !== undefined) this.extra[key] = v;
	}

	/**
	 * The value one of the stored edition's keys has, as toJSON() writes it; undefined when it has none.
	 * @param {string} key
	 * @returns {unknown}
	 */
	value(key){
		/** @type {unknown} */
		let v;
		if(key === Edition.ID_KEY) v = this.id;
		else if(key === 'ext') v = ExternalCatalog.order(this.external) || undefined;
		else if(key === 'n') v = this.narrators.length ? [...this.narrators] : undefined;
		else if(key === 'len') v = this.minutes;
		else if(Object.hasOwn(TEXT_FIELDS, key)) v = this[TEXT_FIELDS[key]];
		return v === undefined ? this.extra[key] : v;
	}

	/** @returns {Record<string, unknown>} the edition as it is stored, its keys in the usual order */
	toJSON(){
		/** @type {Record<string, unknown>} */
		const out = {};
		for(const k of [Edition.ID_KEY, ...Edition.KEYS]){ const v = this.value(k); if(v !== undefined) out[k] = v; }
		for(const [k, v] of Object.entries(this.extra)) if(!(k in out)) out[k] = v;
		return out;
	}

	/** @returns {Edition} a copy, sharing nothing with this one */
	clone(){ return Edition.fromJSON(JSON.parse(JSON.stringify(this))); }

	// ------------------------------------------------------------------ ids
	/**
	 * Its external ids as [catalog, id] pairs in the usual order, e.g. [["audible.com", "B0X"], ["goodreads", "4242"]].
	 * @returns {[string, string][]}
	 */
	externalList(){
		return /** @type {[string, string][]} */ (Object.entries(ExternalCatalog.order(this.external) || {}));
	}

	/**
	 * Its id in one external catalog ("audible.com", "goodreads"), or null.
	 * @param {string} catalog
	 * @returns {string | null}
	 */
	idOn(catalog){
		const v = Object.hasOwn(this.external, catalog) ? this.external[catalog] : null;
		return typeof v === 'string' && v ? v : null;
	}

	/**
	 * The ASINs as [site, ASIN] pairs, Audible's sites first, e.g. [["audible.com", "B0X"], ["amazon.com", "B0Y"]].
	 * @returns {[string, string][]}
	 */
	asinList(){ return this.externalList().filter(([key]) => isAsinSite(key)); }

	/**
	 * Its ids of one family (ExternalCatalog.family), each once: 'asin' gives the ASINs of every site.
	 * @param {string} family
	 * @returns {string[]}
	 */
	ids(family){ return [...new Set(this.externalList().filter(([key]) => ExternalCatalog.family(key) === family).map(([, v]) => v))]; }

	/**
	 * Its external ids as matching compares them, each once: "asin B0X" (whichever site), "goodreads 4242".
	 * @returns {string[]}
	 */
	idKeys(){ return [...new Set(this.externalList().map(([key, v]) => ExternalCatalog.family(key) + ' ' + v))]; }

	/**
	 * idKeys() and its ISBN as "isbn 978…": what the editions index finds it by, and what tells a box set's
	 * copies of it on other books.
	 * @returns {string[]}
	 */
	idAndIsbnKeys(){ return [...this.idKeys(), ...this.isbns().map(x => 'isbn ' + x)]; }

	/** @returns {string[]} the ISBN, 13-digit, in a list; [] when there is none (or not a valid one) */
	isbns(){
		const isbn = this.isbn ? Isbn.parse(this.isbn) : null;
		return isbn ? [isbn] : [];
	}

	/**
	 * Whether both editions have an external id in common (an ASIN counts whatever site it is on).
	 * @param {Edition} other
	 * @returns {boolean}
	 */
	sharesId(other){
		const theirs = other.idKeys();
		return this.idKeys().some(k => theirs.includes(k));
	}

	/**
	 * Whether the editions disagree on an id, so they cannot be one edition: another id in the same
	 * catalog (another ASIN on the same site, another Goodreads or Hardcover id), or another ISBN.
	 * @param {Edition} other
	 * @returns {boolean}
	 */
	conflictsWith(other){
		if(this.externalList().some(([key, v]) => other.idOn(key) !== null && other.idOn(key) !== v)) return true;
		const a = this.isbns(), b = other.isbns();
		return a.length > 0 && b.length > 0 && a[0] !== b[0];
	}

	/**
	 * Whether two editions are the same edition: they share an external id (an ASIN on any site) or the
	 * ISBN, and disagree on none of them. A box set is one edition listed on each of its titles.
	 * @param {Edition} other
	 * @returns {boolean}
	 */
	sameAs(other){
		if(this.conflictsWith(other)) return false;
		if(this.sharesId(other)) return true;
		const isbns = other.isbns();
		return this.isbns().some(isbn => isbns.includes(isbn));
	}

	/**
	 * Give this edition (in place) what `from` has and it lacks, including the ids of catalogs it has none
	 * in. Nothing it has is changed. Returns what it gained: its keys, and "ext:" and the catalog for each id.
	 * @param {Edition} from
	 * @returns {string[]}
	 */
	fillFrom(from){
		/** @type {string[]} */
		const gained = [];
		for(const k of Edition.KEYS){
			if(k === 'ext'){
				for(const [key, v] of from.externalList()){
					if(this.idOn(key) !== null || (this.value('ext') === undefined && 'ext' in this.extra)) continue;
					this.external = {...this.external, [key]: v};
					gained.push('ext:' + key);
				}
				continue;
			}
			const theirs = from.value(k);
			if(theirs === undefined) continue;
			if(this.value(k) === undefined){
				this.set(k, JSON.parse(JSON.stringify(theirs)));
				gained.push(k);
			}
		}
		return gained;
	}

	/**
	 * Whether several editions could all be one edition: none disagree with another on an id. The usual
	 * case is one book imported twice, once with its Audible ASIN and once with its Goodreads id.
	 * @param {Edition[]} editions
	 * @returns {boolean}
	 */
	static joinable(editions){
		return editions.length > 1 && editions.every((x, i) => editions.slice(i + 1).every(y => !x.conflictsWith(y)));
	}

	/**
	 * Editions made into one: the first, filled in from the others (nothing it has is changed).
	 * @param {Edition[]} editions
	 * @returns {Edition}
	 */
	static join(editions){
		const out = editions[0].clone();
		for(const ed of editions.slice(1)) out.fillFrom(ed);
		return out;
	}

	// ------------------------------------------------------------------ as text
	/**
	 * The parts of the edition as format() writes them, as [key, label, value] (the description has no
	 * label): the ASINs are one part ('asin'), each other external id one of its own ('ext:goodreads'), so
	 * the page can turn them into links.
	 * @returns {[string, string, string][]}
	 */
	parts(){
		/** @type {[string, string, string][]} */
		const parts = [];
		if(this.description) parts.push(['desc', '', this.description]);
		if(this.narrators.length) parts.push(['n', 'Narrated by', Text.namesText(this.narrators)]);
		if(this.asinList().length) parts.push(['asin', 'ASIN', this.asinsText()]);
		for(const [key, v] of this.externalList()) if(!isAsinSite(key)) parts.push(['ext:' + key, ExternalCatalog.name(key), v]);
		if(this.isbn) parts.push(['isbn', 'ISBN', this.isbn]);
		if(this.publisher) parts.push(['p', 'Publisher', this.publisher]);
		if(this.released) parts.push(['d', 'Released', this.released]);
		if(this.minutes !== undefined && Number.isInteger(this.minutes)) parts.push(['len', 'Length', Text.formatLength(this.minutes)]);
		return parts;
	}

	/**
	 * The edition as one line of text, the way the page shows it: "UK edition; Narrated by Ann Vale; ASIN
	 * audible.com B0X, amazon.com B0Y; Goodreads 4242; ISBN 9780000000002; Publisher Gull Audio; Released 2021-05;
	 * Length 10h 42m" (what parse() reads).
	 * @returns {string}
	 */
	format(){
		return this.parts().map(([, label, value]) => label ? `${label} ${value}` : value).join('; ');
	}

	/** @returns {string} the ASINs as text, each after its site: "audible.com B0X, amazon.com B0Y" (what parseAsins() reads) */
	asinsText(){
		return this.asinList().map(([site, v]) => `${site} ${v}`).join(', ');
	}

	/**
	 * The edition as the text of each of the editor's fields, e.g. {'ext:audible.com': 'B0X', 'ext:goodreads':
	 * '4242', len: '10h 42m', n: 'Ann Vale, Bo Reed', ...}: each external catalog's id has a field of its own,
	 * `ext:` and the catalog.
	 * @returns {Record<string, string>}
	 */
	fields(){
		/** @type {Record<string, string>} */
		const fields = Object.fromEntries(this.parts().filter(([k]) => k !== 'asin' && !k.startsWith('ext:')).map(([k, , value]) => [k, value]));
		for(const [key, v] of this.externalList()) fields['ext:' + key] = v;
		return fields;
	}

	/**
	 * The editor's label for a catalog's id field: an Audible or Amazon site for an ASIN ("audible.co.uk"),
	 * else the catalog and "edition" ("Hardcover edition").
	 * @param {string} catalog
	 * @returns {string}
	 */
	static fieldLabel(catalog){ return isAsinSite(catalog) ? catalog : `${ExternalCatalog.name(catalog)} edition`; }

	/**
	 * Read ASINs written as asinsText() writes them, "audible.com B0X, amazon.com B0Y": each ASIN after (or
	 * before) the site it belongs to, or as the address of its page there. An ASIN without a site is
	 * `site`'s (by default audible.com's, as before ASINs were kept by site). Returns {asins (an object of
	 * site -> ASIN, null when there are none), bad (what could not be read, e.g. a second ASIN for one site)}.
	 * @param {unknown} text
	 * @param {string} [site]
	 * @returns {{asins: Record<string, string> | null, bad: string[]}}
	 */
	static parseAsins(text, site){
		/** @type {[string | null, string][]} */
		const found = [];   // [site or null, ASIN]
		/** @type {string[]} */
		const bad = [];
		const tokens = String(text || '').split(/[\s,;]+/).map(x => x.replace(/^[([]+|[)\]:]+$/g, '')).filter(Boolean);
		const siteOf = (/** @type {string} */ t) => { const s = t.toLowerCase().replace(/^www\./, ''); return ExternalCatalog.ASIN_SITE.test(s) ? s : null; };
		// an ASIN is ten letters and digits; a shorter one, from a hand-made catalog, is taken as it is
		const isAsin = (/** @type {string} */ t) => /^[A-Za-z0-9]+$/.test(t);
		for(let i = 0; i < tokens.length; i++){
			const t = tokens[i], s = siteOf(t);
			const url = ExternalCatalog.fromAddress(t, 'edition', ExternalCatalog.ASIN_SITES);
			if(url) found.push([url.catalog, url.id]);
			else if(/^(?:https?:\/\/)?(?:www\.)?(?:audible|amazon)\.[a-z.]+\//i.test(t)) bad.push(t);
			else if(s && i + 1 < tokens.length && isAsin(tokens[i + 1])) found.push([s, tokens[++i].toUpperCase()]);
			else if(s && found.length && found[found.length - 1][0] === null && isAsin(tokens[i - 1])) found[found.length - 1][0] = s;
			else if(isAsin(t)) found.push([null, t.toUpperCase()]);
			else bad.push(t);
		}
		/** @type {Record<string, string>} */
		const asins = {};
		for(const [s, v] of found){
			const at = s || site || ExternalCatalog.AUDIBLE_SITE;
			if(asins[at] && asins[at] !== v) bad.push(`${at} ${v}`); else asins[at] = v;
		}
		return {asins: /** @type {Record<string, string> | null} */ (ExternalCatalog.order(asins)), bad};
	}

	/**
	 * The id a pasted address names, and the book form's field it belongs in: {field: 'ext:audible.co.uk',
	 * id: 'B0X'} for a book's page on an Audible or Amazon site (each site has a field of its own), {field:
	 * 'ext:goodreads', id: '12345'} for its page on Goodreads, {field: 'ext:hardcover', id: '501'} for an
	 * edition's page on Hardcover. null for anything else: an id, or a Hardcover book's address, which names
	 * the book, not the edition.
	 * @param {unknown} text
	 * @returns {{field: string, id: string} | null}
	 */
	static idFromAddress(text){
		const found = ExternalCatalog.fromAddress(text, 'edition');
		return found ? {field: 'ext:' + found.catalog, id: found.id} : null;
	}

	/**
	 * Read editions written one per line as format() writes them. Parts are separated by ';' and
	 * start with their label; a bare ISBN, date or length is recognized without one, and other text
	 * without a label is the edition's description (one per edition). A line with several ISBNs is that
	 * many editions (splitIsbns). "Hardcover book 123" names the book, not the edition. The address of an
	 * edition's page in an external catalog (hardcover.app/books/the-salt-road/editions/501, with or
	 * without the label) gives its id, and the address of a book's page the book's.
	 * Returns {editions, bad (the parts that could not be read), book (the book's external ids found)}.
	 * @param {unknown} text
	 * @returns {{editions: Edition[], bad: string[], book: Record<string, string>}}
	 */
	static parse(text){
		/** @type {Edition[]} */
		const editions = [];
		/** @type {string[]} */
		const bad = [];
		/** @type {Record<string, string>} */
		const book = {};
		/** @type {(found: {catalog: string, id: string}, ext: Record<string, string>, part: string) => void} */
		const put = ({catalog, id}, ext, part) => { if(ext[catalog] && ext[catalog] !== id) bad.push(part); else ext[catalog] = id; };
		for(const line of String(text || '').split(/\r\n|\r|\n/)){
			// a stored edition once splitIsbns() has made one per ISBN: until then `isbn` is a list
			/** @type {Record<string, any>} */
			const ed = {};
			/** @type {Record<string, string>} */
			const ext = {};
			for(const part of line.split(';').map(x => Text.tidy(x)).filter(Boolean)){
				// an edition's address names the edition, a book's address the book
				const edition = ExternalCatalog.fromAddress(part, 'edition');
				const ofBook = edition ? null : ExternalCatalog.fromAddress(part, 'book');
				if(edition){ put(edition, ext, part); continue; }
				if(ofBook){ if(!book[ofBook.catalog]) book[ofBook.catalog] = ofBook.id; continue; }
				// another page there (a book's by its name, say) names nothing the edition keeps
				if(ExternalCatalog.siteOf(part)){ bad.push(part); continue; }
				const m = EDITION_PART.exec(part);
				const label = m ? m[1].toLowerCase().replace(/\s+id$/, '') : '', value = m ? m[2].trim() : part;
				const isbns = Isbn.parseList(value), date = Text.parseDate(value), minutes = Text.parseLength(value);
				const allIsbns = isbns.isbns.length > 0 && !isbns.bad.length;
				/** @type {string | null} */
				let field = null;
				/** @type {any} */
				let v = null;
				if(label === 'asin'){
					const read = Edition.parseAsins(value);
					if(read.bad.length || !read.asins || Object.entries(read.asins).some(([site, x]) => ext[site] && ext[site] !== x)){ bad.push(part); continue; }
					Object.assign(ext, read.asins);
					continue;
				}
				const named = label === 'gr' ? ExternalCatalog.get('goodreads') : OTHER_CATALOGS.find(def => label.replace(/\s+/g, ' ').startsWith(def.name.toLowerCase()));
				if(named){
					const catalog = named.key, kind = /\sbook$/.test(label) ? 'book' : 'edition';
					const found = ExternalCatalog.readId(value, kind, catalog);
					if(!found){ bad.push(part); continue; }
					if(kind === 'book'){ if(!book[catalog]) book[catalog] = found.id; }
					else put(found, ext, part);
					continue;
				}
				if(label === 'publisher') [field, v] = ['p', value];
				else if(label.startsWith('narrat')) [field, v] = ['n', Text.splitNames(value).length ? Text.splitNames(value) : null];
				else if(label === 'description') [field, v] = ['desc', ed.desc ? null : value];
				else if(label.startsWith('releas')) [field, v] = ['d', date];
				else if(label === 'length') [field, v] = ['len', minutes];
				else if(label.startsWith('isbn') || (!label && allIsbns)) [field, v] = ['isbn', allIsbns ? isbns.isbns : null];
				else if(!label && date) [field, v] = ['d', date];
				else if(!label && minutes) [field, v] = ['len', minutes];
				else if(!label && !ed.desc) [field, v] = ['desc', value];
				if(!v){ bad.push(part); continue; }
				if(field === 'isbn') ed.isbn = [...new Set([...(ed.isbn || []), ...v])];
				else if(field) ed[field] = v;
			}
			if(Object.keys(ext).length) ed.ext = ExternalCatalog.order(ext);
			if(Object.keys(ed).length) editions.push(...Edition.splitIsbns(Edition.order(ed)).map(Edition.fromJSON));
		}
		return {editions, bad, book};
	}

	/**
	 * Read one edition from the editor's fields (as fields() gives them), checking each the way parse()
	 * checks a part with that label. Each field is read on its own, so a description or narrator list may
	 * hold a ';'. An external catalog's field holds an id or the address of the edition's page there (an
	 * Audible or Amazon page names its own site); the address of a book's page names the book. Several ISBNs
	 * make that many editions (splitIsbns). Returns {editions (none when every field is empty), bad (the
	 * fields that could not be read, as "Label value"), book (the book's external ids found)}.
	 * @param {Record<string, string | undefined>} fields
	 * @returns {{editions: Edition[], bad: string[], book: Record<string, string>}}
	 */
	static fromFields(fields){
		// a stored edition once splitIsbns() has made one per ISBN: until then `isbn` is a list
		/** @type {Record<string, any>} */
		const ed = {};
		/** @type {Record<string, string>} */
		const ext = {};
		/** @type {string[]} */
		const bad = [];
		/** @type {Record<string, string>} */
		const book = {};
		for(const [k, text] of Object.entries(fields)){
			const catalog = k.startsWith('ext:') ? k.slice(4) : null, value = Text.tidy(String(text || ''));
			if(!catalog || !value) continue;
			const label = isAsinSite(catalog) ? `ASIN ${catalog}` : Edition.fieldLabel(catalog);
			// the id, or an address: of the edition on this catalog, or (for an ASIN) on another site, or of the book
			const found = ExternalCatalog.readId(value, 'edition', catalog)
				|| [ExternalCatalog.fromAddress(value, 'edition')].find(x => x && ExternalCatalog.family(x.catalog) === ExternalCatalog.family(catalog)) || null;
			const ofBook = found ? null : ExternalCatalog.fromAddress(value, 'book', [catalog]);
			if(ofBook){ if(!book[catalog]) book[catalog] = ofBook.id; continue; }
			if(!found || (ext[found.catalog] && ext[found.catalog] !== found.id)){ bad.push(`${label} ${value}`); continue; }
			ext[found.catalog] = found.id;
		}
		for(const [k, label, shown] of Edition.FIELDS){
			const value = Text.tidy(String(fields[k] || ''));
			if(!value || k === 'ext') continue;
			if(k === 'desc'){ ed.desc = value; continue; }
			if(k === 'n'){ ed.n = Text.splitNames(value); if(!ed.n.length) delete ed.n; continue; }
			const read = Edition.parse(`${label} ${value.replace(/;/g, ',')}`);
			// each field's own values: ISBNs, a list of narrators, a text
			/** @type {any[]} */
			const got = read.editions.flatMap(x => k === 'isbn' ? x.isbns() : x.value(k) !== undefined ? [x.value(k)] : []);
			if(read.bad.length || !got.length) bad.push(`${shown} ${value}`);
			else ed[k] = k === 'isbn' ? got : got[0];
		}
		if(Object.keys(ext).length) ed.ext = ExternalCatalog.order(ext);
		return {editions: Object.keys(ed).length ? Edition.splitIsbns(Edition.order(ed)).map(Edition.fromJSON) : [], bad, book};
	}

	// ------------------------------------------------------------------ as stored
	// What follows works on editions as they are stored, which may be in an older format or not right at
	// all; reading the catalog (Book.fixBooks) brings them to the current format.

	/**
	 * A stored edition with its keys in the usual order (unknown keys last, for the Check to report).
	 * @template {Unchecked} T
	 * @param {T} ed
	 * @returns {T}
	 */
	static order(ed){
		const from = /** @type {Record<string, any>} */ (ed);
		/** @type {Record<string, any>} */
		const out = {};
		for(const k of [Edition.ID_KEY, ...Edition.KEYS]) if(from[k] !== undefined) out[k] = from[k];
		for(const k of Object.keys(from)) if(!(k in out)) out[k] = from[k];
		return /** @type {T} */ (out);
	}

	/**
	 * A stored edition as editions with one ISBN each, since an ISBN names one edition: "isbn": "978-0-441-01359-3"
	 * becomes "9780441013593", and an edition with several (a list, from before one ISBN per edition, or
	 * comma separated) keeps the first, each other one becoming an edition of its own with just that ISBN.
	 * An empty value drops the key; what is not an ISBN is kept, tidied, for the Check to report.
	 * @param {Unchecked} ed
	 * @returns {Unchecked[]}
	 */
	static splitIsbns(ed){
		if(!Text.isObject(ed) || !('isbn' in ed) || (typeof ed.isbn !== 'string' && !Array.isArray(ed.isbn))) return [ed];
		const {isbn, ...rest} = ed;
		/** @type {unknown[]} */
		const parts = [];
		for(const x of Array.isArray(isbn) ? isbn : [isbn]){
			if(typeof x !== 'string'){ parts.push(x); continue; }
			if(!x.trim()) continue;
			const {isbns, bad} = Isbn.parseList(x);
			parts.push(...(bad.length ? [Text.tidy(x)] : isbns));
		}
		const unique = parts.filter((x, i) => typeof x !== 'string' || parts.indexOf(x) === i);
		if(!unique.length) return Object.keys(rest).length ? [rest] : [];
		return [Edition.order({...rest, isbn: unique[0]}), ...unique.slice(1).map(x => ({isbn: x}))];
	}

	/**
	 * A stored edition with its ids under `ext`, by external catalog, as they are kept now: the ASINs it kept
	 * by site ("asin"), the ASIN it kept as "id" before that (audible.com's), its Goodreads id ("gr") and
	 * Hardcover id ("hc"). An old id that disagrees with the one `ext` has for its catalog, or that is not
	 * text, is left where it is for the Check to report.
	 * @param {Unchecked} ed
	 * @returns {Unchecked}
	 */
	static fixIds(ed){
		if(!Text.isObject(ed) || !['id', 'asin', 'gr', 'hc'].some(k => k in ed)) return ed;
		if(ed.ext !== undefined && !Text.isObject(ed.ext)) return ed;
		/** @type {Record<string, any>} */
		const out = {...ed};
		/** @type {Record<string, unknown>} */
		const ext = {...(ed.ext || {})};
		/** @type {(catalog: string, v: unknown) => boolean} whether the old key's id went into ext */
		const move = (catalog, v) => {
			if(typeof v !== 'string') return false;
			if(!v.trim()) return true;
			if(ext[catalog] !== undefined && ext[catalog] !== v.trim()) return false;
			ext[catalog] = v.trim();
			return true;
		};
		if('asin' in out && Text.isObject(out.asin) && Object.entries(out.asin).every(([site, v]) => typeof v === 'string' && !(ext[site] !== undefined && ext[site] !== v.trim()))){
			for(const [site, v] of Object.entries(out.asin)) move(site, v);
			delete out.asin;
		}
		if('id' in out && move(ExternalCatalog.AUDIBLE_SITE, out.id)) delete out.id;
		for(const [key, catalog] of Object.entries(OLD_ID_KEYS)) if(key in out && move(catalog, out[key])) delete out[key];
		const ordered = ExternalCatalog.order(ext);
		if(ordered) out.ext = ordered; else delete out.ext;
		return Edition.order(out);
	}

	/**
	 * A copy of a stored edition with tidy text in every value, and its ISBN in the 13-digit form.
	 * @param {Unchecked} ed
	 * @returns {Unchecked}
	 */
	static tidyJSON(ed){
		if(!Text.isObject(ed)) return ed;
		const out = Text.fixPeople({...ed});
		for(const key of ['p', 'd', 'desc']){
			if(typeof out[key] === 'string') out[key] = Text.tidy(out[key]);
		}
		if(Text.isObject(out.ext)) out.ext = ExternalCatalog.tidy(out.ext);
		if(Array.isArray(out.n)) out.n = Text.tidyNames(out.n);
		// the 13-digit form; anything that is not an ISBN is kept (tidied) for the Check to report
		if(typeof out.isbn === 'string') out.isbn = Isbn.parse(out.isbn) || Text.tidy(out.isbn);
		return out;
	}
}

// The stored keys that hold a text, and the field each is kept in.
/** @type {Record<string, 'isbn' | 'publisher' | 'released' | 'description'>} */
const TEXT_FIELDS = {isbn: 'isbn', p: 'publisher', d: 'released', desc: 'description'};
