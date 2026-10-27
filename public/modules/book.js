// A title in the catalog: its authors, series and number in it, genres, the dates you read it, its ids
// in external catalogs (Hardcover's and Goodreads' book, which every edition of it is an edition of) and
// its editions. What makes two records one book (the keys imports match by), and
// how books stored in an older format are read.
import {Text} from './text.js';
import {Edition} from './edition.js';
import {Series} from './series.js';
import {ExternalCatalog} from './external-catalog.js';
/** @import {Unchecked} from './text.js' */

/**
 * What a new Book is made of; all but the title and authors is optional.
 * @typedef {object} BookInit
 * @property {string} [title]
 * @property {string[]} [authors]
 * @property {string} [series] the series' name
 * @property {string} [number] number in the series, as text: "3", "2.5", or a box set's range "4-6"
 * @property {string[]} [genres]
 * @property {string[]} [read] dates read, oldest first: "2024-03-15", "2024-03" or "2024"; none means unknown, not unread
 * @property {Record<string, string>} [external] its ids by external catalog: {"hardcover": "77", "goodreads": "1234"}
 * @property {Edition[]} [editions]
 * @property {string} [id] the id it is stored under in this browser, which never changes (see CatalogRecords)
 */

/**
 * Which book's value Book.merge() keeps, as an index into the books merged; by default the first that has one.
 * For `external`, the picked book's ids come first, and the others add the catalogs it has no id in.
 * @typedef {{title?: number, authors?: number, series?: number, external?: number, joinEditions?: boolean}} Picks
 */

const TRAILING_BOOK_N = new RegExp(',?\\s*' + Text.WORD_START + 'book\\s*\\d+\\s*$', 'iu');
// A part after a colon that says the book holds several ("Books 1-3", "The Complete Trilogy"), so it is no
// mere subtitle: a title without it would be the first book's, or the series'.
const SEVERAL = new RegExp(
	Text.WORD_START + '(?:books|volumes|vols|collection|box(?:ed)?\\s*set|omnibus|trilogy|series|complete|\\d)',
	'iu',
);
// The stored keys that hold a text, and the field each is kept in.
/** @type {Record<string, 'title' | 'series' | 'number'>} */
const TEXT_FIELDS = {t: 'title', s: 'series', sn: 'number'};

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function nonEmpty(v) {
	return typeof v === 'string' && v.trim() !== '';
}
/**
 * @param {unknown} v
 * @returns {v is string[]}
 */
function textList(v) {
	return Array.isArray(v) && v.every(nonEmpty);
}

/** A title in the catalog. */
export class Book {
	/**
	 * The editions of a stored book that are objects.
	 * @param {Unchecked} rec
	 * @returns {Record<string, any>[]}
	 */
	static storedEditions(rec) {
		return rec && Array.isArray(rec.e) ? rec.e.filter(Text.isObject) : [];
	}

	/** the keys of a stored book, in order */
	static KEYS = ['t', 'a', 's', 'sn', 'g', 'r', 'ext', 'e'];
	// The key a backup keeps the book's id under, before the others. It is not one of KEYS, as it says which
	// record the book is, not what the book is: text() and the comparisons built on it leave it out.
	static ID_KEY = 'uid';

	/** @param {BookInit} [init] */
	constructor({
		title = '',
		authors = [],
		series,
		number,
		genres = [],
		read = [],
		external = {},
		editions = [],
		id,
	} = {}) {
		/** @type {string | undefined} the id it is stored under (CatalogRecords gives one to a book that has none) */
		this.id = id;
		this.title = title;
		/** @type {string[]} */
		this.authors = [...authors];
		/** @type {string | undefined} */
		this.series = series;
		/** @type {string | undefined} */
		this.number = number;
		/** @type {string[]} */
		this.genres = [...genres];
		/** @type {string[]} none means the date is unknown, not that it is unread */
		this.read = [...read];
		/** @type {Record<string, string>} its ids by external catalog */
		this.external = {...external};
		/** @type {Edition[]} */
		this.editions = [...editions];
		/** @type {Record<string, unknown>} what the stored book holds that is not a book's value (the Check reports it) */
		this.extra = {};
	}

	/**
	 * A book from the way it is stored (`{t, a, s, sn, g, r, ext, e}`), in the current format (BackupV1.fixBooks()
	 * brings one from an older backup to it). A value that is not what its key holds, and a key a book has not, is
	 * kept aside as it is and written back by toJSON(), so the Check still reports it. Throws when it is
	 * not an object.
	 * @param {Unchecked} json
	 * @returns {Book}
	 */
	static fromJSON(json) {
		if (!Text.isObject(json)) throw new Error('a book is not an object');
		const book = new Book();
		for (const [k, v] of Object.entries(json)) book.set(k, v);
		return book;
	}

	/**
	 * A book made of what another catalog or an export holds, in the stored form, tidied the way the catalog
	 * keeps it (tidyJSON()).
	 * @param {Unchecked} rec
	 * @returns {Book}
	 */
	static fromRecord(rec) {
		return Book.fromJSON(Book.tidyJSON(rec));
	}

	/**
	 * Set the value of one of the stored book's keys (as fromJSON() reads it).
	 * @param {string} key
	 * @param {unknown} v
	 */
	set(key, v) {
		delete this.extra[key];
		/** @type {(ok: boolean, apply: () => void, reset: () => void) => void} */
		const put = (ok, apply, reset) => {
			reset();
			if (ok) apply();
			else if (v !== undefined) this.extra[key] = v;
		};
		if (key === Book.ID_KEY)
			put(
				nonEmpty(v),
				() => {
					this.id = /** @type {string} */ (v);
				},
				() => {
					this.id = undefined;
				},
			);
		else if (key === 't')
			put(
				nonEmpty(v),
				() => {
					this.title = /** @type {string} */ (v);
				},
				() => {
					this.title = '';
				},
			);
		else if (key === 'a')
			put(
				textList(v) && v.length > 0,
				() => {
					this.authors = [.../** @type {string[]} */ (v)];
				},
				() => {
					this.authors = [];
				},
			);
		else if (key === 'g')
			put(
				textList(v),
				() => {
					this.genres = [.../** @type {string[]} */ (v)];
				},
				() => {
					this.genres = [];
				},
			);
		else if (key === 'r')
			put(
				Array.isArray(v) && v.length > 0 && v.every(d => typeof d === 'string'),
				() => {
					this.read = [.../** @type {string[]} */ (v)];
				},
				() => {
					this.read = [];
				},
			);
		else if (key === 'ext')
			put(
				ExternalCatalog.isIds(v),
				() => {
					this.external = {.../** @type {Record<string, string>} */ (v)};
				},
				() => {
					this.external = {};
				},
			);
		else if (key === 'e') {
			put(
				Array.isArray(v) && v.length > 0 && v.every(Text.isObject),
				() => {
					this.editions = /** @type {unknown[]} */ (v).map(Edition.fromJSON);
				},
				() => {
					this.editions = [];
				},
			);
		} else if (Object.hasOwn(TEXT_FIELDS, key)) {
			const field = TEXT_FIELDS[key];
			put(
				nonEmpty(v),
				() => {
					this[field] = /** @type {string} */ (v);
				},
				() => {
					if (field === 'title') this.title = '';
					else this[field] = undefined;
				},
			);
		} else if (v !== undefined) this.extra[key] = v;
	}

	/**
	 * The value one of the stored book's keys has, as toJSON() writes it; undefined when it has none.
	 * @param {string} key
	 * @returns {unknown}
	 */
	value(key) {
		/** @type {unknown} */
		let v;
		if (key === Book.ID_KEY) v = this.id;
		else if (key === 't') v = this.title || undefined;
		else if (key === 'a') v = this.authors.length ? [...this.authors] : undefined;
		else if (key === 'g') v = this.genres.length ? [...this.genres] : undefined;
		else if (key === 'r') v = this.read.length ? [...this.read] : undefined;
		else if (key === 'ext') v = ExternalCatalog.order(this.external) || undefined;
		else if (key === 'e') v = this.editions.length ? this.editions.map(ed => ed.toJSON()) : undefined;
		else if (Object.hasOwn(TEXT_FIELDS, key)) v = this[TEXT_FIELDS[key]];
		return v === undefined ? this.extra[key] : v;
	}

	/** @returns {Record<string, unknown>} the book as it is stored, its keys in the usual order */
	toJSON() {
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const k of [Book.ID_KEY, ...Book.KEYS]) {
			const v = this.value(k);
			if (v !== undefined) out[k] = v;
		}
		for (const [k, v] of Object.entries(this.extra)) if (!(k in out)) out[k] = v;
		return out;
	}

	/** @returns {Book} a copy, sharing nothing with this one */
	clone() {
		return Book.fromJSON(JSON.parse(JSON.stringify(this)));
	}

	/**
	 * The book as text that ignores the order of its dates read, and anything that is not a book's or an
	 * edition's value, for "did it change?".
	 * @returns {string}
	 */
	text() {
		const j = this.toJSON();
		/** @type {(ed: unknown) => unknown} */
		const edition = ed =>
			Text.isObject(ed) ? Edition.KEYS.filter(k => ed[k] !== undefined).map(k => [k, ed[k]]) : ed;
		return JSON.stringify(
			Book.KEYS.filter(k => j[k] !== undefined).map(k =>
				k === 'e' && Array.isArray(j.e)
					? [k, j.e.map(edition)]
					: k === 'r' && Array.isArray(j.r)
						? [k, [...j.r].sort()]
						: [k, j[k]],
			),
		);
	}

	/**
	 * Put its editions in order of release, earliest first (a release known only by its year or month before
	 * the dated ones in it), and those without a release date last; editions that tie keep their order.
	 */
	sortEditions() {
		// '~' sorts after every date, so the undated go last; sort() is stable, so ties keep their order
		const keyed = this.editions.map(ed => ({ed, date: Text.parseDate(ed.released) || '~'}));
		keyed.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
		this.editions = keyed.map(k => k.ed);
	}

	// ------------------------------------------------------------------ what it is
	/**
	 * Its own id in an external catalog ("hardcover"), or null; its editions have ids of their own.
	 * @param {string} catalog
	 * @returns {string | null}
	 */
	idOn(catalog) {
		const v = Object.hasOwn(this.external, catalog) ? this.external[catalog] : null;
		return typeof v === 'string' && v ? v : null;
	}

	/**
	 * Its editions' ids of one family (ExternalCatalog.family): 'asin' (of every site), 'goodreads' or 'hardcover'.
	 * @param {string} family
	 * @returns {string[]}
	 */
	ids(family) {
		return [...new Set(this.editions.flatMap(ed => ed.ids(family)))];
	}

	/** @returns {string[]} the ISBNs of all its editions, without repeats */
	isbns() {
		return [...new Set(this.editions.flatMap(ed => ed.isbns()))];
	}

	/** @returns {string[]} the narrators of its editions, without repeats, e.g. ["Ann Vale", "R. T. Hale"] */
	narrators() {
		return [...new Set(this.editions.flatMap(ed => ed.narrators))];
	}

	/** @returns {string} the first author, as matching compares them (firstAuthor()) */
	authorKey() {
		return Book.firstAuthor(this.authors);
	}

	/** Whether it is a collection of several titles of its series (a box set): its number is a range. */
	isCollection() {
		return !!(this.series && Series.range(this.number));
	}

	/**
	 * [first, last] of a box set's series range ("1-3" -> [1, 3]), or null for a single title or no series.
	 * @returns {[number, number] | null}
	 */
	boxRange() {
		const m = this.series && Series.BOX_RANGE.exec(String(this.number || '').trim());
		if (!m) return null;
		const lo = Number(m[1]),
			hi = Number(m[2]);
		return lo < hi && hi - lo < Series.BOX_MAX ? [lo, hi] : null;
	}

	/**
	 * Whether it has the date read `date`: the same date, or a less exact one it falls in ("2024-03" has
	 * "2024-03-15"), or a more exact one in it ("2024-03-15" has "2024-03").
	 * @param {string} date
	 * @returns {boolean}
	 */
	hasReadDate(date) {
		return this.read.some(d => d === date || date.startsWith(d + '-') || d.startsWith(date + '-'));
	}

	/**
	 * The titles its editions were released under besides its own (a UK edition's, say), each once and in
	 * the editions' order. An edition that `shared` says is also on other books is a box set's, and its title
	 * the set's: only the set's own book (isCollection()) has it, never one of its titles.
	 * @param {(ed: Edition) => boolean} [shared] Book.sharedEditionTest() of the books it is among
	 * @returns {string[]}
	 */
	alternativeTitles(shared = () => false) {
		const seen = new Set([Text.norm(this.title)]);
		/** @type {string[]} */
		const out = [];
		for (const ed of this.editions) {
			const k = Text.norm(ed.title || '');
			if (!k || seen.has(k) || (!this.isCollection() && shared(ed))) continue;
			seen.add(k);
			out.push(/** @type {string} */ (ed.title));
		}
		return out;
	}

	/**
	 * Make `title` its own title (in place). When it is the title one of its editions was released under,
	 * that edition loses it (it has the book's title now) and the editions without one of their own keep the
	 * title they were released under, the book's before: every edition keeps its title. A box set's edition
	 * (`shared`) is left as it is, as its title is the set's.
	 * @param {string} title
	 * @param {(ed: Edition) => boolean} [shared]
	 */
	useTitle(title, shared = () => false) {
		const was = this.title,
			wanted = Text.norm(title);
		const own = this.editions.filter(ed => !shared(ed));
		if (wanted !== Text.norm(was) && own.some(ed => Text.norm(ed.title || '') === wanted))
			for (const ed of own) {
				if (Text.norm(ed.title || '') === wanted) ed.title = undefined;
				else if (!ed.title && was) ed.title = was;
			}
		this.title = title;
	}

	/**
	 * Whether `title` is one of its titles (its own or an edition's, alternativeTitles()), forgiving
	 * Audible's long form ("A Crown of Embers 5: A Spark of Dawn"), a trailing "Book 2" and a subtitle
	 * ("The Lantern Keeper: A Novel") on either.
	 * @param {string} title
	 * @param {(ed: Edition) => boolean} [shared]
	 * @returns {boolean}
	 */
	hasTitle(title, shared) {
		return [this.title, ...this.alternativeTitles(shared)].some(t => Book.sameTitle(t, title));
	}

	/**
	 * Whether two titles name the same book: they are the same (norm()), or one is a shorter form of the
	 * other (titleForms(): without Audible's series part, a trailing "Book 2" or a subtitle).
	 * @param {string} x
	 * @param {string} y
	 * @returns {boolean}
	 */
	static sameTitle(x, y) {
		const a = Text.norm(x),
			b = Text.norm(y);
		return !!a && !!b && (a === b || Book.titleForms(x).includes(b) || Book.titleForms(y).includes(a));
	}

	/**
	 * A title and the shorter forms of it that name the same book (norm()), each once: the part after the
	 * last colon ("A Crown of Embers 5: A Spark of Dawn" -> "a spark of dawn"), the part before the first
	 * colon when the rest is a subtitle ("The Lantern Keeper: A Novel" -> "the lantern keeper", but never a
	 * box set's "Lanterns: Books 1-3"), and the title without a trailing "Book 2".
	 * @param {string} title
	 * @returns {string[]}
	 */
	static titleForms(title) {
		const forms = [title];
		if (title.includes(':')) {
			forms.push(title.slice(title.lastIndexOf(':') + 1));
			const subtitle = title.slice(title.indexOf(':') + 1);
			if (!SEVERAL.test(subtitle)) forms.push(title.slice(0, title.indexOf(':')));
		}
		forms.push(title.replace(TRAILING_BOOK_N, ''));
		return [...new Set(forms.map(Text.norm).filter(Boolean))];
	}

	/**
	 * Identity keys, strongest first: its editions' external ids (ASINs, Goodreads and Hardcover ids), then
	 * its own (another edition of it), then series, then title, then the titles its editions were released
	 * under (alternativeTitles(), with `shared`).
	 * @param {(ed: Edition) => boolean} [shared]
	 * @returns {string[]}
	 */
	keys(shared) {
		const keys = [];
		for (const id of new Set(this.editions.flatMap(ed => ed.idKeys()))) keys.push(Text.key('ext', id));
		for (const [catalog, id] of Object.entries(ExternalCatalog.order(this.external) || {}))
			keys.push(Text.key('book', catalog, id));
		// a title or series of only punctuation or symbols has an empty key, which must not match anything
		if (this.series && this.number && Series.norm(this.series))
			keys.push(Text.key('series', this.authorKey(), Series.norm(this.series), this.number.trim()));
		if (Text.norm(this.title)) keys.push(Text.key('title', Text.norm(this.title), this.authorKey()));
		for (const t of this.alternativeTitles(shared)) keys.push(Text.key('title', Text.norm(t), this.authorKey()));
		return keys;
	}

	/**
	 * Keys used to *find* an incoming book among existing books, with forgiving title variants of each of
	 * its titles (titleForms()): "A Crown of Embers 5: A Spark of Dawn" -> "A Spark of Dawn", "X, Book 1" ->
	 * "X", "X: A Novel" -> "X". One-directional (long incoming vs short existing) so a boxed set is never
	 * mistaken for its first book.
	 * @param {(ed: Edition) => boolean} [shared]
	 * @returns {string[]}
	 */
	lookupKeys(shared) {
		const keys = this.keys(shared);
		const author = this.authorKey();
		for (const title of [this.title, ...this.alternativeTitles(shared)])
			for (const v of Book.titleForms(title)) {
				const k = Text.key('title', v, author);
				if (!keys.includes(k)) keys.push(k);
			}
		return keys;
	}

	/**
	 * The exclusions list entries that keep it out of later imports once removed: the ASINs, Goodreads book
	 * ids and Hardcover edition ids of its editions, and "Title | Author" for each of its titles (its own and
	 * its editions', alternativeTitles() with `shared`; for books with no ids). '#' and '|' would break the
	 * line, and matching ignores punctuation anyway, so they are dropped.
	 * @param {(ed: Edition) => boolean} [shared]
	 * @returns {string[]}
	 */
	exclusionEntries(shared) {
		/** @type {(v: unknown) => string} */
		const clean = v => Text.tidy(String(v || '').replace(/[#|]/g, ' '));
		const entries = [];
		for (const id of this.ids('asin')) if (clean(id)) entries.push(clean(id));
		for (const gr of this.ids('goodreads'))
			if (ExternalCatalog.isId('goodreads', 'edition', gr.trim())) entries.push(`Goodreads ${gr.trim()}`);
		for (const hc of this.ids('hardcover'))
			if (ExternalCatalog.isId('hardcover', 'edition', hc.trim())) entries.push(`Hardcover ${hc.trim()}`);
		const authors = clean(Text.namesText(this.authors));
		for (const title of [this.title, ...this.alternativeTitles(shared)])
			if (clean(title) && authors) entries.push(`${clean(title)} | ${authors}`);
		return entries;
	}

	/**
	 * The first author, cut as before authors were a list (a name with a comma in it is cut there), so keys
	 * made from it, like those of "Not duplicates" marks, stay the same.
	 * @param {unknown} authors a list of names, or names as text
	 * @returns {string}
	 */
	static firstName(authors) {
		return String((Array.isArray(authors) ? authors[0] : authors) || '').split(/,| and | & /)[0];
	}

	/**
	 * The first author as matching compares them (norm()).
	 * @param {unknown} authors a list of names, or names as text
	 * @returns {string}
	 */
	static firstAuthor(authors) {
		return Text.norm(Book.firstName(authors));
	}

	/**
	 * Order of books in a series: by number ("2", "2.5"), unnumbered ones after them, and collections ("4-6")
	 * last, by their first and then last number; then by title.
	 * @param {Book} x
	 * @param {Book} y
	 * @returns {number}
	 */
	static bySeriesNumber(x, y) {
		const n = (/** @type {Book} */ b) => {
			const v = parseFloat(b.number || '');
			return Number.isFinite(v) ? v : Infinity;
		};
		const last = (/** @type {Book} */ b) => (Series.range(b.number) || [0, 0])[1];
		return (
			Number(x.isCollection()) - Number(y.isCollection()) ||
			n(x) - n(y) ||
			last(x) - last(y) ||
			x.title.localeCompare(y.title)
		);
	}

	/**
	 * A test of whether an edition is also on another of `books` (a box set's edition, on each of its
	 * titles): it shares an external id or ISBN with an edition of another book.
	 * @param {Book[]} books
	 * @returns {(ed: Edition) => boolean}
	 */
	static sharedEditionTest(books) {
		/** @type {Map<string, number>} */
		const owners = new Map();
		for (const b of books)
			for (const id of new Set(b.editions.flatMap(ed => ed.idAndIsbnKeys())))
				owners.set(id, (owners.get(id) || 0) + 1);
		return ed => ed.idAndIsbnKeys().some(id => (owners.get(id) || 0) > 1);
	}

	/**
	 * One book made of several entries for the same title. `pick` says, for the title, the authors, the
	 * series (and its number) and the external ids, which entry's value to keep, as an index into
	 * `books`; by default the first entry that has one. Genres and dates read are combined, and so are
	 * editions: an edition that shares an ASIN, Goodreads id or ISBN with one already kept fills in what it
	 * lacks, the others are added. With `pick.joinEditions`, editions that do not disagree on an ASIN or
	 * Goodreads id become one edition (see Edition.joinable).
	 * @param {Book[]} books
	 * @param {Picks} [pick]
	 * @returns {Book}
	 */
	static merge(books, pick = {}) {
		/** @type {(field: 'title' | 'authors' | 'series' | 'external', has: (b: Book) => boolean) => Book | undefined} */
		const from = (field, has) => {
			const i = pick[field];
			return i !== undefined && Number.isInteger(i) && books[i] && has(books[i]) ? books[i] : books.find(has);
		};
		const out = new Book();
		// the merged book is the first one that has an id, so its record stays
		const kept = books.find(b => b.id);
		if (kept) out.id = kept.id;
		const title = from('title', b => b.title !== '');
		if (title) out.title = title.title;
		const authors = from('authors', b => b.authors.length > 0);
		if (authors) out.authors = [...authors.authors];
		const series = from('series', b => !!b.series);
		if (series) {
			out.series = series.series;
			if (series.number) out.number = series.number;
		}
		out.genres = [...new Set(books.flatMap(b => b.genres))];
		out.read = [...new Set(books.flatMap(b => b.read))].sort();
		const external = from('external', b => Object.keys(b.external).length > 0);
		for (const b of external ? [external, ...books] : books) {
			for (const [catalog, id] of Object.entries(b.external)) if (!out.idOn(catalog)) out.external[catalog] = id;
		}
		/** @type {Edition[]} */
		const editions = [];
		for (const ed of books.flatMap(b => b.editions)) {
			const same = editions.find(x => x.sameAs(ed));
			if (same) same.fillFrom(ed);
			else editions.push(ed.clone());
		}
		out.editions = pick.joinEditions && Edition.joinable(editions) ? [Edition.join(editions)] : editions;
		return out;
	}

	// ------------------------------------------------------------------ as stored
	// What follows works on books as they are stored, which may not be right at all (a backup from before
	// version 2 is brought to the current format by BackupV1 first); the Check (Validator) says what is wrong.

	/**
	 * Take the series out of the title of a stored book imported before titles were split ("Title: Series,
	 * Book 3"). A book without a series gets the one in its title; a book that already has that series only
	 * loses it from the title (and gains the number if it had none). A different series or number is never
	 * changed; then the title stays as it is.
	 * @template T
	 * @param {T} rec
	 * @returns {T}
	 */
	static fixSeriesTitle(rec) {
		if (!Text.isObject(rec) || typeof rec.t !== 'string') return rec;
		const split = Series.splitTitle(rec.t);
		if (!split || !split[0]) return rec;
		const [t, s, sn] = split;
		if (!rec.s && !rec.sn) return {...rec, t, s, sn};
		if (typeof rec.s !== 'string' || Series.norm(rec.s) !== Series.norm(s)) return rec;
		if (rec.sn && Number(rec.sn) !== Number(sn)) return rec;
		return {...rec, t, ...(rec.sn ? {} : {sn})};
	}

	/**
	 * A copy of a stored book with tidy text in every value, and one edition per ISBN (an import's edition may
	 * list several, Edition.splitIsbns); no editions is no `e`.
	 * @param {Unchecked} rec
	 * @returns {Unchecked}
	 */
	static tidyJSON(rec) {
		if (!Text.isObject(rec)) return rec;
		const out = {...rec};
		if (Array.isArray(out.e))
			out.e = out.e.flatMap((/** @type {Unchecked} */ ed) => (Text.isObject(ed) ? Edition.splitIsbns(ed) : [ed]));
		if (Array.isArray(out.e) && !out.e.length) delete out.e;
		for (const key of ['t', 's', 'sn']) {
			if (typeof out[key] === 'string') out[key] = Text.tidy(out[key]);
		}
		if (Text.isObject(out.ext)) out.ext = ExternalCatalog.tidy(out.ext);
		if (Array.isArray(out.a)) out.a = Text.tidyNames(out.a);
		if (Array.isArray(out.g)) {
			out.g = out.g
				.map((/** @type {unknown} */ x) => (typeof x === 'string' ? Text.tidy(x) : x))
				.filter((/** @type {unknown} */ x) => x !== '');
		}
		if (Array.isArray(out.r)) {
			out.r = out.r.map((/** @type {unknown} */ x) => (typeof x === 'string' ? Text.tidy(x) : x));
		}
		if (Array.isArray(out.e)) out.e = out.e.map(Edition.tidyJSON);
		return out;
	}
}
