// An edition of a book: its ids on Audible and Amazon (an ASIN per site), Goodreads and Hardcover, its
// ISBN, narrators, publisher, release date, length and your own description of it ("UK edition"). A box
// set is one edition on each of its titles, linked by the ids the copies share (sameAs).
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {HardcoverClient} from './hardcover-client.js';
/** @import {Unchecked} from './text.js' */

/** @typedef {'asin' | 'gr' | 'hc'} EditionId the ids that name an edition (Edition.IDS) */
/** @typedef {'asin' | 'gr' | 'hc' | 'isbn' | 'n' | 'p' | 'd' | 'len' | 'desc'} EditionKey the keys of an edition as it is stored */

/**
 * What a new Edition is made of; every part is optional.
 * @typedef {object} EditionInit
 * @property {Record<string, string>} [asins] ASINs by site: {"audible.com": "B0…", "amazon.com": "B0…"}
 * @property {string} [goodreadsId]
 * @property {string} [hardcoverId] Hardcover's edition id
 * @property {string} [isbn] one ISBN, the 13-digit form (another ISBN is another edition)
 * @property {string[]} [narrators]
 * @property {string} [publisher]
 * @property {string} [released] release date: "2021-05-04", "2021-05" or "2021"
 * @property {number} [minutes] length in whole minutes
 * @property {string} [description] your own description of the edition ("UK edition")
 */

// A Goodreads book id, as an edition keeps it: the number in goodreads.com/book/show/12345.
const GOODREADS_ID = /^\d+$/;
// Each Amazon and Audible site may give one edition an ASIN of its own, so an edition keeps them by the
// site's address: {"audible.com": "B0...", "amazon.com": "B0..."}. An ASIN from before sites were kept
// (the edition's "id") and one from an Audible import is audible.com's; one that Hardcover or Goodreads
// gives is amazon.com's, the site they use.
const ASIN_SITE = /^(?:audible|amazon)\.(?:[a-z]{2,3}|com?\.[a-z]{2})$/;
const AUDIBLE_SITE = 'audible.com', AMAZON_SITE = 'amazon.com';
// Audible's stores and their sites, for the ASIN fields of the book form.
/** @type {Record<string, string>} */
const AUDIBLE_STORES = {us: 'audible.com', uk: 'audible.co.uk', de: 'audible.de', fr: 'audible.fr', it: 'audible.it',
	es: 'audible.es', ca: 'audible.ca', au: 'audible.com.au', in: 'audible.in', jp: 'audible.co.jp'};
// An ASIN's page: amazon.com/dp/B0X, audible.com/pd/Some-Title-Audiobook/B0X, amazon.com/gp/product/B0X.
const ASIN_URL = /^(?:https?:\/\/)?(?:www\.)?((?:audible|amazon)\.[a-z.]+)\/(?:[^?#]*\/)?(?:dp|pd|product)\/(?:[^/?#]*\/)?([A-Za-z0-9]{10})(?=[/?#]|$)/i;
const EDITION_PART = /^(asin|goodreads(?:\s+id)?|gr|hardcover(?:\s+book)?(?:\s+id)?|isbns?|publisher|released?|length|narrated\s+by|narrators?|description)\b:?\s*(.*)$/i;

// Audible's sites before Amazon's, then by address, so an edition's ASINs are always listed alike.
/** @type {(x: string, y: string) => number} */
const siteOrder = (x, y) => (Number(y.startsWith('audible.')) - Number(x.startsWith('audible.'))) || (x < y ? -1 : x > y ? 1 : 0);
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
// The ASIN a stored edition has on one site, or null.
/** @type {(ed: Unchecked, site: string) => string | null} */
const storedAsinOn = (ed, site) => {
	const v = Text.isObject(ed) && Text.isObject(ed.asin) ? ed.asin[site] : null;
	return typeof v === 'string' && v ? v : null;
};

/** An edition of a book. */
export class Edition {
	/** @type {EditionKey[]} the keys of a stored edition, in order */
	static KEYS = ['asin', 'gr', 'hc', 'isbn', 'n', 'p', 'd', 'len', 'desc'];
	// The ids that name one edition (and match books in imports). An ISBN names one edition too, but one
	// ISBN may be on several books (a boxed set's), so it never makes two books the same.
	/** @type {EditionId[]} */
	static IDS = ['asin', 'gr', 'hc'];
	// The fields of the page's edition editor: [key, the label parse() reads, the label the page shows].
	/** @type {[EditionKey, string, string][]} */
	static FIELDS = [
		['desc', 'Description', 'Description'], ['n', 'Narrated by', 'Narrators'],
		['asin', 'ASIN', 'ASINs'], ['gr', 'Goodreads', 'Goodreads id'], ['hc', 'Hardcover', 'Hardcover edition'],
		['isbn', 'ISBN', 'ISBN'], ['p', 'Publisher', 'Publisher'], ['d', 'Released', 'Released'], ['len', 'Length', 'Length'],
	];
	static GOODREADS_ID = GOODREADS_ID;
	static ASIN_SITE = ASIN_SITE;
	static AUDIBLE_SITE = AUDIBLE_SITE;
	static AMAZON_SITE = AMAZON_SITE;
	static AUDIBLE_STORES = AUDIBLE_STORES;
	// The sites the book form offers an ASIN field for: each Audible store's site and its Amazon twin, and
	// a few Amazon sites without an Audible store. An edition's ASIN on another site still gets its field.
	static ASIN_SITES = [...new Set([
		...Object.values(AUDIBLE_STORES).flatMap(site => [site, site.replace(/^audible\./, 'amazon.')]),
		'amazon.se', 'amazon.nl', 'amazon.pl', 'amazon.com.br', 'amazon.com.mx',
	])];

	/** @param {EditionInit} [init] */
	constructor({asins = {}, goodreadsId, hardcoverId, isbn, narrators = [], publisher, released, minutes, description} = {}){
		/** @type {Record<string, string>} ASINs by site */
		this.asins = {...asins};
		/** @type {string | undefined} */
		this.goodreadsId = goodreadsId;
		/** @type {string | undefined} Hardcover's edition id */
		this.hardcoverId = hardcoverId;
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
	 * An edition from the way it is stored (`{asin, gr, hc, isbn, n, p, d, len, desc}`), in the current
	 * format. A value that is not what its key holds, and a key an edition has not, is kept aside as it is
	 * and written back by toJSON(), so the Check still reports it. Throws when it is not an object.
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
		if(key === 'asin'){
			this.asins = {};
			if(Text.isObject(v) && Object.keys(v).length && Object.entries(v).every(([site, x]) => site && nonEmpty(x))) this.asins = {...v};
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
		if(key === 'asin') v = Object.keys(this.asins).length ? Edition.orderAsins(this.asins) : undefined;
		else if(key === 'n') v = this.narrators.length ? [...this.narrators] : undefined;
		else if(key === 'len') v = this.minutes;
		else if(Object.hasOwn(TEXT_FIELDS, key)) v = this[TEXT_FIELDS[key]];
		return v === undefined ? this.extra[key] : v;
	}

	/** @returns {Record<string, unknown>} the edition as it is stored, its keys in the usual order */
	toJSON(){
		/** @type {Record<string, unknown>} */
		const out = {};
		for(const k of Edition.KEYS){ const v = this.value(k); if(v !== undefined) out[k] = v; }
		for(const [k, v] of Object.entries(this.extra)) if(!(k in out)) out[k] = v;
		return out;
	}

	/** @returns {Edition} a copy, sharing nothing with this one */
	clone(){ return Edition.fromJSON(JSON.parse(JSON.stringify(this))); }

	/** Whether it holds nothing at all (an edition must not be empty). */
	isEmpty(){ return !Object.keys(this.toJSON()).length; }

	/** @returns {Edition} a copy with tidy text in every field, and its ISBN in the 13-digit form */
	tidied(){ return Edition.fromJSON(Edition.tidyJSON(this.toJSON())); }

	// ------------------------------------------------------------------ ids
	/**
	 * The ASINs as [site, ASIN] pairs, Audible's sites first, e.g. [["audible.com", "B0X"], ["amazon.com", "B0Y"]].
	 * @returns {[string, string][]}
	 */
	asinList(){
		return Object.entries(this.asins).filter(([site, v]) => site && typeof v === 'string' && v).sort(([x], [y]) => siteOrder(x, y));
	}

	/**
	 * The ASIN on one site ("audible.com"), or null.
	 * @param {string} site
	 * @returns {string | null}
	 */
	asinOn(site){
		const v = Object.hasOwn(this.asins, site) ? this.asins[site] : null;
		return typeof v === 'string' && v ? v : null;
	}

	/**
	 * The values of one of the ids, as a list: the ASINs of every site (`field` 'asin', each once), or the
	 * Goodreads id ('gr') or Hardcover edition id ('hc').
	 * @param {EditionId} field
	 * @returns {string[]}
	 */
	ids(field){
		if(field === 'asin') return [...new Set(this.asinList().map(([, v]) => v))];
		const v = field === 'gr' ? this.goodreadsId : this.hardcoverId;
		return v ? [v] : [];
	}

	/** @returns {string[]} the ISBN, 13-digit, in a list; [] when there is none (or not a valid one) */
	isbns(){
		const isbn = this.isbn ? Isbn.parse(this.isbn) : null;
		return isbn ? [isbn] : [];
	}

	/**
	 * Whether both editions have an id of this kind in common (an ASIN counts whatever site it is on).
	 * @param {Edition} other
	 * @param {EditionId} field
	 * @returns {boolean}
	 */
	sharesId(other, field){
		const theirs = other.ids(field);
		return this.ids(field).some(v => theirs.includes(v));
	}

	/**
	 * Whether the editions have different ids of this kind: another ASIN on the same site, another Goodreads or Hardcover id.
	 * @param {Edition} other
	 * @param {EditionId} field
	 * @returns {boolean}
	 */
	idsDisagree(other, field){
		if(field === 'asin') return this.asinList().some(([site, v]) => other.asinOn(site) !== null && other.asinOn(site) !== v);
		const [mine] = this.ids(field), [theirs] = other.ids(field);
		return !!(mine && theirs && mine !== theirs);
	}

	/**
	 * Whether the editions disagree on an ASIN (on one site), their Goodreads id, Hardcover id or ISBN, so they cannot be one edition.
	 * @param {Edition} other
	 * @returns {boolean}
	 */
	conflictsWith(other){
		if(Edition.IDS.some(k => this.idsDisagree(other, k))) return true;
		const a = this.isbns(), b = other.isbns();
		return a.length > 0 && b.length > 0 && a[0] !== b[0];
	}

	/**
	 * Whether two editions are the same edition: they share an ASIN (on any site), a Goodreads id, a
	 * Hardcover id or the ISBN, and disagree on none of them. A box set is one edition listed on each of its titles.
	 * @param {Edition} other
	 * @returns {boolean}
	 */
	sameAs(other){
		if(this.conflictsWith(other)) return false;
		if(Edition.IDS.some(k => this.sharesId(other, k))) return true;
		const isbns = other.isbns();
		return this.isbns().some(isbn => isbns.includes(isbn));
	}

	/**
	 * Give this edition (in place) what `from` has and it lacks, including the ASINs of sites it has none for.
	 * Nothing it has is changed. Returns the keys it gained.
	 * @param {Edition} from
	 * @returns {EditionKey[]}
	 */
	fillFrom(from){
		/** @type {EditionKey[]} */
		const gained = [];
		for(const k of Edition.KEYS){
			const theirs = from.value(k);
			if(theirs === undefined) continue;
			if(k === 'asin' && Object.keys(this.asins).length && Object.keys(from.asins).length){
				const more = from.asinList().filter(([site]) => this.asinOn(site) === null);
				if(more.length){ this.asins = {...this.asins, ...Object.fromEntries(more)}; gained.push(k); }
			}
			else if(this.value(k) === undefined){
				this.set(k, JSON.parse(JSON.stringify(theirs)));
				gained.push(k);
			}
		}
		return gained;
	}

	/**
	 * Whether several editions could all be one edition: none disagree with another on the ASIN or
	 * Goodreads id. The usual case is one book imported twice, once with its Audible ASIN and once with
	 * its Goodreads id.
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
	 * The parts of the edition as format() writes them, as [key, label, value] (the description has
	 * no label), so the page can turn some of them into links.
	 * @returns {[EditionKey, string, string][]}
	 */
	parts(){
		/** @type {[EditionKey, string, string][]} */
		const parts = [];
		if(this.description) parts.push(['desc', '', this.description]);
		if(this.narrators.length) parts.push(['n', 'Narrated by', Text.namesText(this.narrators)]);
		if(this.asinList().length) parts.push(['asin', 'ASIN', this.asinsText()]);
		if(this.goodreadsId) parts.push(['gr', 'Goodreads', this.goodreadsId]);
		if(this.hardcoverId) parts.push(['hc', 'Hardcover', this.hardcoverId]);
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
	 * The edition as the text of each of the editor's fields, e.g. {'asin:audible.com': 'B0X', len: '10h 42m',
	 * n: 'Ann Vale, Bo Reed', ...}: each site's ASIN has a field of its own, `asin:` and the site.
	 * @returns {Record<string, string>}
	 */
	fields(){
		/** @type {Record<string, string>} */
		const fields = Object.fromEntries(this.parts().filter(([k]) => k !== 'asin').map(([k, , value]) => [k, value]));
		for(const [site, asin] of this.asinList()) fields['asin:' + site] = asin;
		return fields;
	}

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
		const tokens = String(text || '').split(/[\s,;]+/).map(x => x.replace(/^[(\[]+|[)\]:]+$/g, '')).filter(Boolean);
		const siteOf = (/** @type {string} */ t) => { const s = t.toLowerCase().replace(/^www\./, ''); return ASIN_SITE.test(s) ? s : null; };
		// an ASIN is ten letters and digits; a shorter one, from a hand-made catalog, is taken as it is
		const isAsin = (/** @type {string} */ t) => /^[A-Za-z0-9]+$/.test(t);
		for(let i = 0; i < tokens.length; i++){
			const t = tokens[i], url = ASIN_URL.exec(t), s = siteOf(t);
			if(url){ found.push([siteOf(url[1]), url[2].toUpperCase()]); if(!siteOf(url[1])) bad.push(t); }
			else if(s && i + 1 < tokens.length && isAsin(tokens[i + 1])) found.push([s, tokens[++i].toUpperCase()]);
			else if(s && found.length && found[found.length - 1][0] === null && isAsin(tokens[i - 1])) found[found.length - 1][0] = s;
			else if(isAsin(t)) found.push([null, t.toUpperCase()]);
			else bad.push(t);
		}
		/** @type {Record<string, string>} */
		const asins = {};
		for(const [s, v] of found){
			const at = s || site || AUDIBLE_SITE;
			if(asins[at] && asins[at] !== v) bad.push(`${at} ${v}`); else asins[at] = v;
		}
		return {asins: Edition.orderAsins(asins), bad};
	}

	/**
	 * Read editions written one per line as format() writes them. Parts are separated by ';' and
	 * start with their label; a bare ISBN, date or length is recognized without one, and other text
	 * without a label is the edition's description (one per edition). A line with several ISBNs is that
	 * many editions (splitIsbns). "Hardcover book 123" names the book, not the edition. An edition's address
	 * on Hardcover (hardcover.app/books/the-salt-road/editions/501, with or without the label) gives its id.
	 * Returns {editions, bad (the parts that could not be read), hcb (the Hardcover book id, or null)}.
	 * @param {unknown} text
	 * @returns {{editions: Edition[], bad: string[], hcb: string | null}}
	 */
	static parse(text){
		/** @type {Edition[]} */
		const editions = [];
		/** @type {string[]} */
		const bad = [];
		/** @type {string | null} */
		let hcb = null;
		for(const line of String(text || '').split(/\r\n|\r|\n/)){
			// a stored edition once splitIsbns() has made one per ISBN: until then `isbn` is a list
			/** @type {Record<string, any>} */
			const ed = {};
			for(const part of line.split(';').map(x => Text.tidy(x)).filter(Boolean)){
				// an edition's address on Hardcover names the edition, a book's /id/ address the book
				const url = HardcoverClient.parseUrl(part);
				if(url){
					if(url.edition) ed.hc = url.edition; else if(url.book) hcb = hcb || url.book; else bad.push(part);
					continue;
				}
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
					if(read.bad.length || !read.asins){ bad.push(part); continue; }
					const both = {...(ed.asin || {})};
					if(Object.entries(read.asins).some(([site, x]) => both[site] && both[site] !== x)){ bad.push(part); continue; }
					ed.asin = Edition.orderAsins({...both, ...read.asins});
					continue;
				}
				else if(label === 'goodreads' || label === 'gr') [field, v] = ['gr', GOODREADS_ID.test(value) ? value : null];
				else if(label.startsWith('hardcover')){
					const kind = /book$/.test(label) ? 'book' : 'edition', url = HardcoverClient.parseUrl(value);
					[field, v] = [kind === 'book' ? 'hcb' : 'hc', HardcoverClient.ID.test(value) ? value : url && url[/** @type {'book' | 'edition'} */ (kind)] || null];
				}
				else if(label === 'publisher') [field, v] = ['p', value];
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
				else if(field === 'hcb') hcb = hcb || v;
				else if(field) ed[field] = v;
			}
			if(Object.keys(ed).length) editions.push(...Edition.splitIsbns(Edition.order(ed)).map(Edition.fromJSON));
		}
		return {editions, bad, hcb};
	}

	/**
	 * Read one edition from the editor's fields (as fields() gives them), checking each the way parse()
	 * checks a part with that label. Each field is read on its own, so a description or narrator list may
	 * hold a ';'. Several ISBNs make that many editions (splitIsbns); a Hardcover book's address in the
	 * Hardcover field names the book. Returns {editions (none when every field is empty), bad (the fields
	 * that could not be read, as "Label value"), hcb (or null)}.
	 * @param {Record<string, string | undefined>} fields
	 * @returns {{editions: Edition[], bad: string[], hcb: string | null}}
	 */
	static fromFields(fields){
		// a stored edition once splitIsbns() has made one per ISBN: until then `isbn` is a list
		/** @type {Record<string, any>} */
		const ed = {};
		/** @type {string[]} */
		const bad = [];
		/** @type {string | null} */
		let hcb = null;
		// each site's field holds that site's ASIN (or the address of the book's page there)
		for(const [k, text] of Object.entries(fields)){
			const site = k.startsWith('asin:') ? k.slice(5) : null, value = Text.tidy(String(text || ''));
			if(!site || !value) continue;
			const read = Edition.parseAsins(value, site);
			const both = {...(ed.asin || {})};
			if(read.bad.length || !read.asins || Object.entries(read.asins).some(([at, x]) => both[at] && both[at] !== x)){ bad.push(`ASIN ${site} ${value}`); continue; }
			ed.asin = Edition.orderAsins({...both, ...read.asins});
		}
		for(const [k, label, shown] of Edition.FIELDS){
			const value = Text.tidy(String(fields[k] || ''));
			if(!value) continue;
			if(k === 'desc'){ ed.desc = value; continue; }
			if(k === 'n'){ ed.n = Text.splitNames(value); if(!ed.n.length) delete ed.n; continue; }
			const read = Edition.parse(k === 'hc' && HardcoverClient.parseUrl(value) ? value : `${label} ${value.replace(/;/g, ',')}`);
			// each field's own values: ISBNs, a site -> ASIN object, a list of narrators, a text
			/** @type {any[]} */
			const got = read.editions.flatMap(x => k === 'isbn' ? x.isbns() : x.value(k) !== undefined ? [x.value(k)] : []);
			if(read.hcb && k === 'hc') hcb = read.hcb;
			else if(read.bad.length || !got.length) bad.push(`${shown} ${value}`);
			else if(k === 'asin'){
				if(Object.entries(got[0]).some(([at, x]) => ed.asin && ed.asin[at] && ed.asin[at] !== x)) bad.push(`${shown} ${value}`);
				else ed.asin = Edition.orderAsins({...(ed.asin || {}), ...got[0]});
			}
			else ed[k] = k === 'isbn' ? got : got[0];
		}
		return {editions: Object.keys(ed).length ? Edition.splitIsbns(Edition.order(ed)).map(Edition.fromJSON) : [], bad, hcb};
	}

	// ------------------------------------------------------------------ as stored
	// What follows works on editions as they are stored, which may be in an older format or not right at
	// all; reading the catalog (Book.fixBooks) brings them to the current format.

	/**
	 * ASINs ordered by site (Audible's sites first), as an object; null when there are none.
	 * @param {Record<string, unknown>} asins
	 * @returns {Record<string, string> | null}
	 */
	static orderAsins(asins){
		const pairs = /** @type {[string, string][]} */ (Object.entries(asins).filter(([site, v]) => site && typeof v === 'string' && v))
			.sort(([x], [y]) => siteOrder(x, y));
		return pairs.length ? Object.fromEntries(pairs) : null;
	}

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
		for(const k of Edition.KEYS) if(from[k] !== undefined) out[k] = from[k];
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
	 * A stored edition with the ASIN it kept as "id", from before ASINs were kept by site, as its audible.com ASIN.
	 * An "id" that disagrees with the audible.com ASIN the edition has is left for the Check to report.
	 * @param {Unchecked} ed
	 * @returns {Unchecked}
	 */
	static fixAsin(ed){
		if(!Text.isObject(ed) || !('id' in ed)) return ed;
		const {id, ...rest} = ed;
		if(typeof id === 'string' && !id.trim()) return rest;
		if(typeof id !== 'string' || !(rest.asin === undefined || Text.isObject(rest.asin))) return ed;
		const had = storedAsinOn(rest, AUDIBLE_SITE);
		if(had && had !== id.trim()) return ed;
		return Edition.order({...rest, asin: Edition.orderAsins({...(rest.asin || {}), [AUDIBLE_SITE]: id.trim()})});
	}

	/**
	 * A copy of a stored edition with tidy text in every value, and its ISBN in the 13-digit form.
	 * @param {Unchecked} ed
	 * @returns {Unchecked}
	 */
	static tidyJSON(ed){
		if(!Text.isObject(ed)) return ed;
		const out = Text.fixPeople({...ed});
		for(const key of ['gr', 'hc', 'p', 'd', 'desc']){
			if(typeof out[key] === 'string') out[key] = Text.tidy(out[key]);
		}
		if(Text.isObject(out.asin)){
			out.asin = Object.fromEntries(Object.entries(out.asin).map(([site, v]) => [Text.tidy(site).toLowerCase(), typeof v === 'string' ? Text.tidy(v) : v])
				.sort(([x], [y]) => siteOrder(x, y)));
		}
		if(Array.isArray(out.n)) out.n = Text.tidyNames(out.n);
		// the 13-digit form; anything that is not an ISBN is kept (tidied) for the Check to report
		if(typeof out.isbn === 'string') out.isbn = Isbn.parse(out.isbn) || Text.tidy(out.isbn);
		return out;
	}
}

// The stored keys that hold a text, and the field each is kept in.
/** @type {Record<string, 'goodreadsId' | 'hardcoverId' | 'isbn' | 'publisher' | 'released' | 'description'>} */
const TEXT_FIELDS = {gr: 'goodreadsId', hc: 'hardcoverId', isbn: 'isbn', p: 'publisher', d: 'released', desc: 'description'};
