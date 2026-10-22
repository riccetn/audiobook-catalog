// Hardcover's GraphQL API: asking it, the queries, and its addresses. Hardcover allows browser requests (its
// API answers with open CORS headers), so the page asks it itself, with your personal token, which the
// page keeps in this browser only. The client only ever reaches Hardcover through the fetch it is given,
// so the tests give it a fake. Queries stay within three levels of nesting, which Hardcover plans to enforce.
import {Text} from './text.js';
/** @import {Unchecked} from './text.js' */

/** @typedef {(text: string, done?: number, total?: number) => void} Step reports a run's progress */
/** @typedef {{hc?: unknown[], asin?: unknown[], isbn?: unknown[], gr?: unknown[]}} HardcoverLookups your ids to find on Hardcover */
/** @typedef {{hc: string | null, hcb: string}} HardcoverHit a Hardcover edition id (or null) and book id */
/**
 * Your ids (Hardcover edition ids, ASINs, ISBNs, Goodreads ids) -> what Hardcover has for them.
 * @typedef {{hc: Map<string, HardcoverHit>, asin: Map<string, HardcoverHit>, isbn: Map<string, HardcoverHit>, gr: Map<string, HardcoverHit>}} HardcoverFound
 */

// Hardcover's own ids, as books keep them (a book's Hardcover id, an edition's).
const HARDCOVER_ID = /^\d+$/;
const PAGE = 100;         // shelf entries per request
const BATCH = 50;         // ids per lookup

/** Asks Hardcover's API, one request at a time. */
export class HardcoverClient {
	static API = 'https://api.hardcover.app/v1/graphql';
	static ID = HARDCOVER_ID;
	// Hardcover's shelves (user_books.status_id): only "Read" is a finished book.
	/** @type {Record<number, string>} */
	static STATUSES = {1: 'Want to Read', 2: 'Currently Reading', 3: 'Read', 4: 'Paused', 5: 'Did Not Finish', 6: 'Ignored'};
	static READ = 3;
	static AUDIO = 2;          // editions.reading_format_id of an audiobook
	static PAGE = PAGE;
	static BATCH = BATCH;
	static QUERIES = {
		me: 'query { me { id } }',
		shelf: `query Shelf($user: Int!, $offset: Int!) {
	user_books(where: {user_id: {_eq: $user}}, order_by: {id: asc}, limit: ${PAGE}, offset: $offset) {
		id book_id edition_id status_id
		user_book_reads(order_by: {id: asc}) { finished_at edition_id }
	}
}`,
		// the part of your shelves of some series or authors (by their ids), or of some books; Hardcover refuses
		// _ilike and its kin, so a name can only be matched as it is (seriesByName, authorsByName)
		shelfBySeries: `query ShelfBySeries($user: Int!, $offset: Int!, $ids: [Int!]) {
	user_books(where: {user_id: {_eq: $user}, book: {book_series: {series_id: {_in: $ids}}}}, order_by: {id: asc}, limit: ${PAGE}, offset: $offset) {
		id book_id edition_id status_id
		user_book_reads(order_by: {id: asc}) { finished_at edition_id }
	}
}`,
		shelfByAuthor: `query ShelfByAuthor($user: Int!, $offset: Int!, $ids: [Int!]) {
	user_books(where: {user_id: {_eq: $user}, book: {contributions: {author_id: {_in: $ids}}}}, order_by: {id: asc}, limit: ${PAGE}, offset: $offset) {
		id book_id edition_id status_id
		user_book_reads(order_by: {id: asc}) { finished_at edition_id }
	}
}`,
		shelfByBooks: `query ShelfByBooks($user: Int!, $offset: Int!, $books: [Int!]) {
	user_books(where: {user_id: {_eq: $user}, book_id: {_in: $books}}, order_by: {id: asc}, limit: ${PAGE}, offset: $offset) {
		id book_id edition_id status_id
		user_book_reads(order_by: {id: asc}) { finished_at edition_id }
	}
}`,
		seriesByName: `query SeriesByName($names: [String!]) { series(where: {name: {_in: $names}}) { id name } }`,
		authorsByName: `query AuthorsByName($names: [String!]) { authors(where: {name: {_in: $names}}) { id name } }`,
		// the series and authors of some books, to find a series' or author's id from your books of it
		bookParts: `query BookParts($ids: [Int!]) {
	books(where: {id: {_in: $ids}}) {
		id
		book_series { series { id name } }
		contributions { author { id name } }
	}
}`,
		books: `query Books($ids: [Int!]) {
	books(where: {id: {_in: $ids}}) {
		id title
		contributions { contribution author { name } }
		featured_book_series { position series { name } }
	}
}`,
		editions: `query Editions($ids: [Int!]) {
	editions(where: {id: {_in: $ids}}) {
		id book_id asin isbn_13 isbn_10 release_date audio_seconds reading_format_id
		publisher { name }
		contributions { contribution author { name } }
	}
}`,
		addBook: `mutation AddBook($object: UserBookCreateInput!) { insert_user_book(object: $object) { id error } }`,
		bookBySlug: `query BookBySlug($slug: String!) {
	books(where: {slug: {_eq: $slug}}, limit: 1) { id canonical_id title }
}`,
		// a series, author (narrators are authors there) or publisher by the name in its page's address
		seriesBySlug: `query SeriesBySlug($slug: String!) {
	series(where: {slug: {_eq: $slug}}, limit: 1) { id canonical_id name }
}`,
		authorBySlug: `query AuthorBySlug($slug: String!) {
	authors(where: {slug: {_eq: $slug}}, limit: 1) { id canonical_id name }
}`,
		publisherBySlug: `query PublisherBySlug($slug: String!) {
	publishers(where: {slug: {_eq: $slug}}, limit: 1) { id canonical_id name }
}`,
		// a book's audiobook editions, for a book named without one
		audioEditions: `query AudioEditions($book: Int!) {
	editions(where: {book_id: {_eq: $book}, reading_format_id: {_eq: 2}}, order_by: {id: asc}, limit: 1) {
		id book_id asin isbn_13 isbn_10 release_date audio_seconds reading_format_id
		publisher { name }
		contributions { contribution author { name } }
	}
}`,
		editionBook: `query EditionBook($id: Int!) {
	editions(where: {id: {_eq: $id}}) { book_id book { title } }
}`,
		addRead: `mutation AddRead($id: Int!, $read: DatesReadInput!) { insert_user_book_read(user_book_id: $id, user_book_read: $read) { id error } }`,
	};

	/**
	 * A client that asks Hardcover through `get` (a fetch), calling `pause()` between requests (Hardcover
	 * allows 60 a minute). `headers` are added to each request.
	 * @param {string} token
	 * @param {(url: string, init: RequestInit) => Promise<Response>} get
	 * @param {() => Promise<unknown>} pause
	 * @param {Record<string, string>} [headers]
	 */
	constructor(token, get, pause, headers){
		this.token = HardcoverClient.cleanToken(token);
		this.get = get;
		this.pause = pause;
		this.headers = headers || {};
		this.asked = 0;
		/** @type {number | undefined} whose shelves they are, once Hardcover said */
		this.user = undefined;
	}

	/**
	 * Ask Hardcover one query (with its variables) and return the answer's `data`. Throws with a short
	 * reason when Hardcover says no.
	 * @param {string} query
	 * @param {Record<string, unknown>} [variables]
	 * @returns {Promise<Unchecked>}
	 */
	async ask(query, variables){
		if(this.asked++) await this.pause();
		const res = await this.get(HardcoverClient.API, {method: 'POST', body: JSON.stringify({query, variables: variables || {}}), headers: {
			'content-type': 'application/json', authorization: `Bearer ${this.token}`, ...this.headers}});
		let json = null;
		try{ json = await res.json(); }catch{ /* reported below */ }
		if(res.status === 401) throw new Error('Hardcover refused your token (expired, or missing a scope? make a new one at hardcover.app/account/api)');
		if(res.status === 429) throw new Error('Hardcover\'s rate limit was reached; try again later');
		if(!res.ok || !json) throw new Error(`Hardcover answered ${res.status}${json && json.error ? ` (${json.error})` : ''}`);
		if(Array.isArray(json.errors) && json.errors.length) throw new Error(`Hardcover: ${json.errors.map((/** @type {any} */ e) => e && e.message).join('; ')}`);
		return json.data || {};
	}

	/**
	 * Every book on your Hardcover shelves (user_books rows, with their reads).
	 * @param {Step} step
	 * @returns {Promise<Unchecked[]>}
	 */
	async shelf(step){
		return this.shelfPages(HardcoverClient.QUERIES.shelf, {}, step);
	}

	/**
	 * The entries on your Hardcover shelves of books in these Hardcover series, or by these authors.
	 * @param {'series' | 'author'} kind
	 * @param {number[]} ids
	 * @param {Step} step
	 * @returns {Promise<Unchecked[]>}
	 */
	async shelfOf(kind, ids, step){
		/** @type {Unchecked[]} */
		const shelf = [];
		const query = kind === 'series' ? HardcoverClient.QUERIES.shelfBySeries : HardcoverClient.QUERIES.shelfByAuthor;
		for(let i = 0; i < ids.length; i += BATCH) shelf.push(...await this.shelfPages(query, {ids: ids.slice(i, i + BATCH)}, step));
		return shelf;
	}

	/**
	 * The Hardcover series or authors named exactly one of `names`, as {id, name} rows.
	 * @param {'series' | 'author'} kind
	 * @param {string[]} names
	 * @returns {Promise<Unchecked[]>}
	 */
	async named(kind, names){
		if(!names.length) return [];
		const data = await this.ask(kind === 'series' ? HardcoverClient.QUERIES.seriesByName : HardcoverClient.QUERIES.authorsByName, {names});
		const rows = kind === 'series' ? data.series : data.authors;
		return Array.isArray(rows) ? rows.filter(Text.isObject) : [];
	}

	/**
	 * The series and authors of these Hardcover books, as {id, book_series, contributions} rows.
	 * @param {number[]} ids
	 * @param {Step} step
	 * @returns {Promise<Unchecked[]>}
	 */
	async bookParts(ids, step){
		/** @type {Unchecked[]} */
		const rows = [];
		for(let i = 0; i < ids.length; i += BATCH){
			step('Finding the series or author on Hardcover', i, ids.length);
			const books = (await this.ask(HardcoverClient.QUERIES.bookParts, {ids: ids.slice(i, i + BATCH)})).books;
			if(Array.isArray(books)) rows.push(...books.filter(Text.isObject));
		}
		return rows;
	}

	/**
	 * The entries on your Hardcover shelves of these Hardcover books.
	 * @param {number[]} books
	 * @param {Step} step
	 * @returns {Promise<Unchecked[]>}
	 */
	async shelfOfBooks(books, step){
		/** @type {Unchecked[]} */
		const shelf = [];
		for(let i = 0; i < books.length; i += BATCH) shelf.push(...await this.shelfPages(HardcoverClient.QUERIES.shelfByBooks, {books: books.slice(i, i + BATCH)}, step));
		return shelf;
	}

	/**
	 * Your shelves' entries a shelf query (with `variables`) answers, a page at a time.
	 * @param {string} query
	 * @param {Record<string, unknown>} variables
	 * @param {Step} step
	 * @returns {Promise<Unchecked[]>}
	 */
	async shelfPages(query, variables, step){
		if(this.user === undefined){
			const me = await this.ask(HardcoverClient.QUERIES.me);
			const user = Array.isArray(me.me) && me.me[0] && me.me[0].id;
			if(!Number.isInteger(user)) throw new Error('Hardcover did not say who the token belongs to');
			this.user = user;
		}
		const shelf = [];
		for(let offset = 0; ; offset += PAGE){
			const page = (await this.ask(query, {...variables, user: this.user, offset})).user_books || [];
			shelf.push(...page);
			step(`Reading your Hardcover shelves: ${shelf.length} books`);
			if(page.length < PAGE) return shelf;
		}
	}

	/**
	 * Hardcover rows (`kind` 'books' or 'editions') by id, asked in batches; `doing` is the progress step's text.
	 * @param {'books' | 'editions'} kind
	 * @param {unknown[]} ids
	 * @param {Step} step
	 * @param {string} [doing]
	 * @returns {Promise<Map<unknown, Unchecked>>}
	 */
	async rows(kind, ids, step, doing){
		const rows = new Map();
		for(let i = 0; i < ids.length; i += BATCH){
			step(doing || `Reading the ${kind} on your Read shelf`, i, ids.length);
			for(const row of (await this.ask(HardcoverClient.QUERIES[kind], {ids: ids.slice(i, i + BATCH)}))[kind] || []) rows.set(row.id, row);
		}
		return rows;
	}

	/**
	 * The Hardcover ids of your editions' ASINs, ISBNs and Goodreads ids (see matches()).
	 * @param {HardcoverLookups} lookups
	 * @param {Step} step
	 * @returns {Promise<HardcoverFound>}
	 */
	async find(lookups, step){
		/** @type {HardcoverFound} */
		const found = {hc: new Map(), asin: new Map(), isbn: new Map(), gr: new Map()};
		const longest = Math.max(0, ...Object.values(lookups).map(l => l.length));
		for(let i = 0; i < longest; i += BATCH){
			step('Finding your books on Hardcover', i, longest);
			const slice = Object.fromEntries(Object.entries(lookups).map(([k, l]) => [k, l.slice(i, i + BATCH)]));
			const q = HardcoverClient.findQuery(slice);
			if(!q) continue;
			const matches = HardcoverClient.matches(await this.ask(q.query, q.variables));
			for(const k of /** @type {(keyof HardcoverFound)[]} */ (Object.keys(found))) for(const [id, hit] of matches[k]) if(!found[k].has(id)) found[k].set(id, hit);
		}
		return found;
	}

	/**
	 * The query that finds Hardcover editions and books for your editions' ids: by Hardcover edition id,
	 * ASIN, ISBN-13 and Goodreads id (Hardcover's mapping of Goodreads books), only the parts with ids.
	 * Returns {query, variables}, or null when there is nothing to look up.
	 * @param {HardcoverLookups} ids
	 * @returns {{query: string, variables: Record<string, unknown[]>} | null}
	 */
	static findQuery(ids){
		/** @type {string[]} */
		const parts = [];
		/** @type {string[]} */
		const vars = [];
		/** @type {Record<string, unknown[]>} */
		const variables = {};
		const fields = 'id book_id asin isbn_13 reading_format_id';
		/** @type {(name: string, type: string, list: unknown[] | undefined, part: string) => void} */
		const add = (name, type, list, part) => {
			if(!list || !list.length) return;
			vars.push(`$${name}: ${type}`);
			variables[name] = list;
			parts.push(part);
		};
		add('hc', '[Int!]', ids.hc, `byId: editions(where: {id: {_in: $hc}}) { ${fields} }`);
		add('asin', '[String!]', ids.asin, `byAsin: editions(where: {asin: {_in: $asin}}) { ${fields} }`);
		add('isbn', '[String!]', ids.isbn, `byIsbn: editions(where: {isbn_13: {_in: $isbn}}) { ${fields} }`);
		add('gr', '[String!]', ids.gr,
			'byGoodreads: book_mappings(where: {platform: {name: {_eq: "Goodreads"}}, external_id: {_in: $gr}}) { book_id external_id }');
		if(!parts.length) return null;
		return {query: `query Find(${vars.join(', ')}) {\n  ${parts.join('\n  ')}\n}`, variables};
	}

	/**
	 * What a Find query answered, as the Hardcover ids of each of your ids: {hc, asin, isbn, gr}, Maps of
	 * your id -> {hc (null when only the book is known, or the edition is not an audiobook), hcb}. An ISBN or
	 * Goodreads id names a book, but its edition is often the print one, so only an audiobook edition counts.
	 * @param {Unchecked} data
	 * @returns {HardcoverFound}
	 */
	static matches(data){
		/** @type {HardcoverFound} */
		const out = {hc: new Map(), asin: new Map(), isbn: new Map(), gr: new Map()};
		/** @type {(name: string) => Record<string, any>[]} */
		const list = name => data && Array.isArray(data[name]) ? data[name].filter(Text.isObject) : [];
		const audio = (/** @type {Record<string, any>} */ ed) => ed.reading_format_id === HardcoverClient.AUDIO;
		/** @type {(map: Map<string, HardcoverHit>, k: string, v: HardcoverHit) => void} */
		const put = (map, k, v) => { const had = map.get(k); if(!had || (!had.hc && v.hc)) map.set(k, v); };
		for(const ed of list('byId')) put(out.hc, String(ed.id), {hc: String(ed.id), hcb: String(ed.book_id)});
		for(const ed of list('byAsin')) if(ed.asin) put(out.asin, ed.asin, {hc: String(ed.id), hcb: String(ed.book_id)});
		for(const ed of list('byIsbn')) if(ed.isbn_13) put(out.isbn, ed.isbn_13, {hc: audio(ed) ? String(ed.id) : null, hcb: String(ed.book_id)});
		for(const m of list('byGoodreads')) if(m.external_id) put(out.gr, String(m.external_id), {hc: null, hcb: String(m.book_id)});
		return out;
	}

	// ------------------------------------------------------------------ tokens and addresses
	/**
	 * A token as Hardcover shows it ("Bearer eyJ..."), without the "Bearer" and spacing; '' when there is none.
	 * @param {unknown} t
	 * @returns {string}
	 */
	static cleanToken(t){
		return String(t || '').trim().replace(/^bearer\s+/i, '').trim();
	}

	/**
	 * What an address on Hardcover names: {book} for hardcover.app/id/book/77; {edition, slug} for an
	 * edition's page, hardcover.app/books/the-salt-road/editions/501 (or {edition} for /id/edition/501); {slug}
	 * for a book's page, hardcover.app/books/the-salt-road, which only Hardcover can turn into the book's id
	 * (bookId). The ids are text, as books and editions keep them. The scheme, "www." and anything after the id
	 * may be there or not. null when it is not such an address.
	 * @param {unknown} text
	 * @returns {{book?: string, edition?: string, slug?: string} | null}
	 */
	static parseUrl(text){
		const m = /^(?:https?:\/\/)?(?:www\.)?hardcover\.app(\/[^?#\s]*)?(?:[?#]\S*)?$/i.exec(String(text || '').trim());
		if(!m) return null;
		const [first, second, third, fourth] = (m[1] || '').split('/').filter(Boolean);
		const id = (/** @type {string | undefined} */ x) => HARDCOVER_ID.test(x || '') ? x : null;
		if(first === 'id' && id(third)){
			if(/^books?$/.test(second)) return {book: third};
			if(/^editions?$/.test(second)) return {edition: third};
		}
		if(first === 'books' && second){
			if(third === 'editions') return id(fourth) ? {edition: fourth, slug: second} : null;
			return {slug: second};
		}
		return null;
	}

	/**
	 * The Hardcover book that `text` names (a book id, or an address as parseUrl() reads it), asking
	 * Hardcover through `client` only when the address doesn't hold the book's id: a book's page by its slug,
	 * an edition by the edition's book. Returns {id, title (when Hardcover was asked)}; throws with a short
	 * reason when it is not an address of a book or edition, or Hardcover has no such book.
	 * @param {HardcoverClient | null} client null when `text` is sure to hold the book's id
	 * @param {unknown} text
	 * @returns {Promise<{id: string, title?: string}>}
	 */
	static async bookId(client, text){
		const value = String(text || '').trim();
		if(HARDCOVER_ID.test(value)) return {id: value};
		const url = HardcoverClient.parseUrl(value);
		if(!url) throw new Error('not a Hardcover book id, or the address of a book or edition on hardcover.app');
		if(url.book) return {id: url.book};
		if(!client) throw new Error('finding the book of this address needs Hardcover');
		if(url.edition){
			const [edition] = (await client.ask(HardcoverClient.QUERIES.editionBook, {id: Number(url.edition)})).editions || [];
			if(!Text.isObject(edition) || !Number.isInteger(edition.book_id)) throw new Error(`Hardcover has no edition ${url.edition}`);
			return {id: String(edition.book_id), title: Text.isObject(edition.book) && typeof edition.book.title === 'string' ? edition.book.title : ''};
		}
		const [book] = (await client.ask(HardcoverClient.QUERIES.bookBySlug, {slug: url.slug})).books || [];
		if(!Text.isObject(book) || !Number.isInteger(book.id)) throw new Error(`Hardcover has no book at hardcover.app/books/${url.slug}`);
		// a book merged into another one lives on as that one
		return {id: String(Number.isInteger(book.canonical_id) ? book.canonical_id : book.id), title: typeof book.title === 'string' ? book.title : ''};
	}

	/**
	 * The number of the Hardcover series, author (a narrator is one there) or publisher whose page's address
	 * has `slug` in it (hardcover.app/authors/ann-vale), as {id, name}; null when Hardcover has none. Throws
	 * with a short reason when Hardcover can't be asked.
	 * @param {HardcoverClient} client
	 * @param {'series' | 'author' | 'narrator' | 'publisher'} kind
	 * @param {string} slug
	 * @returns {Promise<{id: string, name: string} | null>}
	 */
	static async idBySlug(client, kind, slug){
		const [query, table] = kind === 'series' ? [HardcoverClient.QUERIES.seriesBySlug, 'series']
			: kind === 'publisher' ? [HardcoverClient.QUERIES.publisherBySlug, 'publishers'] : [HardcoverClient.QUERIES.authorBySlug, 'authors'];
		const [row] = (await client.ask(query, {slug}))[table] || [];
		// a publisher's id is a bigint, which Hardcover may send as text
		const number = (/** @type {unknown} */ x) => Number.isInteger(x) || (typeof x === 'string' && HARDCOVER_ID.test(x)) ? String(x) : null;
		if(!Text.isObject(row) || !number(row.id)) return null;
		// one merged into another lives on as that one
		return {id: /** @type {string} */ (number(row.canonical_id) || number(row.id)), name: typeof row.name === 'string' ? row.name : ''};
	}
}
