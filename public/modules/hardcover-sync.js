// Your Hardcover shelves beside the catalog, and putting books and reads on them: Hardcover allows browser
// requests (its API answers with open CORS headers), so the page asks it. It is only ever reached through a
// HardcoverClient, and the catalog is never changed here. The reading of answers and the planning are static,
// so the tests run them offline.
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Edition} from './edition.js';
import {Book} from './book.js';
import {HardcoverClient} from './hardcover-client.js';
import {ShelfSync} from './shelf-sync.js';
import {ExternalCatalog} from './external-catalog.js';
import {Comparison} from './comparison.js';
/** @import {Unchecked} from './text.js' */
/** @import {HardcoverLookups, HardcoverFound, HardcoverHit} from './hardcover-client.js' */
/** @import {Step} from './catalog-client.js' */
/** @import {ShelfPart, PlanEntry, Sent, PlanGroup, InfoId, NotAudio} from './shelf-sync.js' */
/** @import {Catalog} from './catalog.js' */
/** @import {MergeOptions} from './merger.js' */
/** @import {ComparisonResult} from './comparison.js' */

/**
 * What an export to Hardcover would do (HardcoverSync.planExport()).
 * @typedef {object} HardcoverPlan
 * @property {string} name
 * @property {{book: number, edition: number | null, dates: string[], books: Book[]}[]} add
 * @property {{userBook: number, edition: number | null, dates: string[], books: Book[]}[]} reads
 * @property {[Book, string][]} otherShelf
 * @property {Book[]} unknown
 * @property {[Book, string][]} inexact
 */
/**
 * Your Hardcover shelves beside the catalog (HardcoverSync.compare()).
 * @typedef {object} HardcoverComparison
 * @property {ComparisonResult} comparison the books on your Read shelf beside the catalog's
 * @property {Book[]} incoming the books on your Read shelf compared (those in the scope asked for)
 * @property {MergeOptions} opts how they are imported (Comparison.apply() takes them)
 * @property {string[]} warnings
 * @property {number} otherShelves how many of your Hardcover books are on other shelves
 * @property {HardcoverFound} found the Hardcover ids of your editions' ids (addIds() gives them)
 * @property {Book[]} idsFound the books that gain a Hardcover id from them, in the comparison's merged copy
 * @property {InfoId[]} infoIds none: Hardcover's series and people ids are found in their forms
 * @property {HardcoverPlan} plan what putting your books on Hardcover would do
 * @property {string[]} missing none
 * @property {NotAudio[]} notAudio your editions Hardcover has as print books or ebooks, and the books on your Read shelf read as one
 */
/**
 * Your Read shelf as books (HardcoverSync.read()), and those read as a print book or an ebook (`notAudio`).
 * @typedef {{books: Book[], audio: Set<Book>, otherShelves: number, warnings: string[], notAudio: NotAudio[]}} HardcoverShelf
 */

const READ = HardcoverClient.READ;

/** Compares the catalog with your Hardcover shelves, and puts books and reads on them. */
export class HardcoverSync extends ShelfSync {
	static CLIENT = HardcoverClient;
	static SENDS_READS = true;
	// a request Hardcover refuses (the token, its rate limit) refuses the next one too
	static STOP_AFTER = 1;
	static NOT_FOUND =
		'No ASIN, ISBN or Goodreads id Hardcover knows: give the book a "Hardcover <edition id>" in its edit form.';

	/** @param {HardcoverClient} client */
	constructor(client) {
		super(client);
		this.client = client;
	}

	/**
	 * Your Hardcover shelves beside `catalog` (not changed): the books on your Read shelf compared with
	 * the catalog's as an import would take them (an audiobook edition read is a book that may be added; any
	 * other only fills in a book you have), and what putting your books on Hardcover would do, planned on
	 * the catalog with all of them imported and the Hardcover ids of your editions found. With `part` (a
	 * series or an author, with its Hardcover id when you gave it one), only its books on either side are
	 * compared and planned, and only they are read from Hardcover: the shelf entries of books of that series
	 * or author there, and of the Hardcover books your books of it are. Only reads Hardcover;
	 * `step(text, done, total)` hears how far it has got.
	 * @param {Catalog} catalog
	 * @param {Step} step
	 * @param {ShelfPart} [part]
	 * @returns {Promise<HardcoverComparison>}
	 */
	async compare(catalog, step, part) {
		if (part) return this.comparePart(catalog, step, part);
		const client = this.client;
		step('Reading your Hardcover shelves');
		const shelf = await client.shelf(step);
		const {result, opts} = await this.readShelfBooks(shelf, step);
		const incoming = result.books;
		const comparison = Comparison.compare(catalog, incoming, opts);
		const books = comparison.merged.books;
		const ids = await client.find(HardcoverSync.lookups(books), step);
		const idsFound = HardcoverSync.addIds(books, ids);
		const {plan, notAudio} = await this.planFor(books, shelf, step, ids);
		return {
			comparison,
			incoming,
			opts,
			warnings: result.warnings,
			otherShelves: result.otherShelves,
			found: ids,
			idsFound,
			infoIds: [],
			plan,
			missing: [],
			notAudio: [...notAudio, ...result.notAudio],
		};
	}

	/**
	 * compare() for a series' or an author's books only. Your books of it are found on Hardcover first, so
	 * their shelf entries are read even where Hardcover files them under another series or author; the
	 * series or author is known there by its id (Hardcover lets no name be matched loosely): the one you gave
	 * it, those named exactly so, and those of your books of it on Hardcover whose name is the same (spelled
	 * any way Comparison.scope takes as the same).
	 * @param {Catalog} catalog
	 * @param {Step} step
	 * @param {ShelfPart} part
	 * @returns {Promise<HardcoverComparison>}
	 */
	async comparePart(catalog, step, part) {
		const client = this.client;
		const scope = Comparison.scope(part.kind, part.name);
		const mine = catalog.books.filter(scope).map(b => b.clone());
		const ids = await client.find(HardcoverSync.lookups(mine), step);
		HardcoverSync.addIds(mine, ids);
		const theirs = [
			...new Set(
				mine
					.map(b => b.idOn('hardcover'))
					.filter(id => id && HardcoverClient.ID.test(id))
					.map(Number),
			),
		];
		step(`Finding ${part.kind === 'series' ? 'the series' : 'the author'} ${part.name} on Hardcover`);
		const partIds = await this.partIds(part, theirs, step);
		step(`Reading your Hardcover shelves: ${part.kind === 'series' ? 'the series' : 'the books by'} ${part.name}`);
		const shelf = [];
		const seen = new Set();
		for (const ub of [
			...(await client.shelfOf(part.kind, partIds, step)),
			...(await client.shelfOfBooks(theirs, step)),
		]) {
			if (Text.isObject(ub) && !seen.has(ub.id)) {
				seen.add(ub.id);
				shelf.push(ub);
			}
		}
		const {result, opts} = await this.readShelfBooks(shelf, step);
		// a book Hardcover has under another name of the series or author is in it when it is one of yours
		const incoming = result.books.filter(b => scope(b) || theirs.includes(Number(b.idOn('hardcover'))));
		const comparison = Comparison.compare(catalog, incoming, opts);
		const books = comparison.merged.books.filter(scope);
		const idsFound = HardcoverSync.addIds(books, ids);
		const {plan, notAudio} = await this.planFor(books, shelf, step, ids);
		const shelved = new Set(incoming);
		return {
			comparison,
			incoming,
			opts,
			warnings: result.warnings,
			otherShelves: result.otherShelves,
			found: ids,
			idsFound,
			infoIds: [],
			plan,
			missing: [],
			notAudio: [...notAudio, ...result.notAudio.filter(n => shelved.has(n.book))],
		};
	}

	/**
	 * @param {number} count
	 * @returns {string}
	 */
	static notAdded(count) {
		return `Not added, as Hardcover has no audiobook edition picked for them: ${count}`;
	}

	/**
	 * What a comparison's first line says it read.
	 * @param {HardcoverComparison} result
	 * @param {Catalog} catalog
	 * @param {{kind: 'series' | 'author', name: string, label: string} | null} scope
	 * @returns {string}
	 */
	summary(result, catalog, scope) {
		if (scope)
			return `Only ${scope.label}: ${Text.plural(ShelfSync.inScope(catalog, scope).length, 'book')} in this catalog, ${result.incoming.length} on your Hardcover Read shelf`;
		return (
			`${Text.plural(result.incoming.length, 'book')} on your Hardcover Read shelf` +
			(result.otherShelves ? `, ${result.otherShelves} on other shelves` : '')
		);
	}

	/**
	 * The books on the Read shelf among `shelf` (your shelf entries), with the books and editions they are
	 * read from Hardcover, and the options an import of them takes: an audiobook edition read is a book
	 * that may be added.
	 * @param {Unchecked[]} shelf
	 * @param {Step} step
	 * @returns {Promise<{result: HardcoverShelf, opts: MergeOptions}>}
	 */
	async readShelfBooks(shelf, step) {
		const read = shelf.filter(ub => ub && ub.status_id === READ);
		const found = await this.client.rows('books', [...new Set(read.map(ub => ub.book_id))], step);
		const editions = await this.client.rows(
			'editions',
			[...new Set(read.map(ub => ub.edition_id).filter(Boolean))],
			step,
		);
		const result = HardcoverSync.read(shelf, found, editions);
		const audio = result.audio;
		return {result, opts: {allDates: true, addable: book => audio.has(book)}};
	}

	/**
	 * What putting `books` on Hardcover would do, beside `shelf` (planExport), once it is known which
	 * Hardcover book each of their editions belongs to, so a box set's edition is never sent as a title's;
	 * one Hardcover has as a print book or an ebook is never sent, and is with those `found` names so
	 * (HardcoverClient.find()) in `notAudio` (yourNotAudio()).
	 * @param {Book[]} books
	 * @param {Unchecked[]} shelf
	 * @param {Step} step
	 * @param {HardcoverFound} found
	 * @returns {Promise<{plan: HardcoverPlan, notAudio: NotAudio[]}>}
	 */
	async planFor(books, shelf, step, found) {
		/** @type {Map<string, string>} */
		const editionBooks = new Map();
		/** @type {Map<string, string>} */
		const notAudio = new Map();
		const rows = await this.client.rows(
			'editions',
			HardcoverSync.exportEditions(books),
			step,
			'Checking your editions on Hardcover',
		);
		for (const [id, row] of rows) {
			const said = HardcoverClient.notAudio(row);
			if (said) notAudio.set(String(id), said);
			else editionBooks.set(String(id), String(row.book_id));
		}
		return {
			plan: HardcoverSync.planExport(books, shelf, editionBooks),
			notAudio: HardcoverSync.yourNotAudio(books, found, notAudio),
		};
	}

	/**
	 * The editions of `books` Hardcover has as print books or ebooks: by their Hardcover edition id
	 * (`formats`: what its edition is, by id, else `found.hc`), else by their ASIN or ISBN (`found`), one
	 * entry per edition of a book.
	 * @param {Book[]} books
	 * @param {HardcoverFound} found
	 * @param {Map<string, string>} formats
	 * @returns {NotAudio[]}
	 */
	static yourNotAudio(books, found, formats) {
		/** @type {NotAudio[]} */
		const out = [];
		const url = (/** @type {string} */ id) => ExternalCatalog.url('hardcover', 'edition', id);
		for (const book of books)
			for (const ed of book.editions) {
				const hc = ed.idOn('hardcover');
				const byId = hc ? formats.get(hc) || found.hc.get(hc)?.other?.said : undefined;
				if (hc && byId) {
					out.push({book, yours: true, edition: `Hardcover edition ${hc}`, said: byId, url: url(hc)});
					continue;
				}
				/** @type {[string, HardcoverHit | undefined][]} */
				const hits = [
					...ed
						.ids('asin')
						.map(a => /** @type {[string, HardcoverHit | undefined]} */ ([`ASIN ${a}`, found.asin.get(a)])),
					...ed
						.isbns()
						.map(i => /** @type {[string, HardcoverHit | undefined]} */ ([`ISBN ${i}`, found.isbn.get(i)])),
				];
				const hit = hits.find(([, h]) => h && h.other);
				const other = hit && hit[1] && hit[1].other;
				if (hit && other) out.push({book, yours: true, edition: hit[0], said: other.said, url: url(other.id)});
			}
		return out;
	}

	/**
	 * The Hardcover ids of a series or an author (`part`): the one given, those named exactly as it is, and
	 * those of `books` (Hardcover books) with the same name, as Comparison.scope compares names.
	 * @param {ShelfPart} part
	 * @param {number[]} books
	 * @param {Step} step
	 * @returns {Promise<number[]>}
	 */
	async partIds(part, books, step) {
		// whether a Hardcover series or author of that name is the one asked for
		const same = ShelfSync.sameName(part);
		/** @type {Set<number>} */
		const ids = new Set();
		if (part.id && HardcoverClient.ID.test(part.id)) ids.add(Number(part.id));
		for (const row of await this.client.named(part.kind, [part.name]))
			if (Number.isInteger(row.id)) ids.add(row.id);
		for (const book of await this.client.bookParts(books, step)) {
			const rows =
				part.kind === 'series'
					? (Array.isArray(book.book_series) ? book.book_series : []).map(
							(/** @type {any} */ x) => x && x.series,
						)
					: (Array.isArray(book.contributions) ? book.contributions : []).map(
							(/** @type {any} */ x) => x && x.author,
						);
			for (const row of rows)
				if (Text.isObject(row) && Number.isInteger(row.id) && same(row.name)) ids.add(row.id);
		}
		return [...ids];
	}

	/**
	 * Send one entry of planExport()'s plan to Hardcover: put its book on your Read shelf with its reads
	 * (`add`), or add its reads to the book there (`reads`).
	 * @param {PlanEntry} entry
	 * @param {HardcoverPlan} _plan
	 * @param {PlanGroup} group
	 * @returns {Promise<Sent>}
	 */
	async send(entry, _plan, group) {
		const client = this.client,
			QUERIES = HardcoverClient.QUERIES;
		/** @type {Sent} */
		const sent = {shelved: 0, reads: 0, problems: []};
		const a = /** @type {HardcoverPlan['add'][number] & HardcoverPlan['reads'][number]} */ (entry);
		/** @type {(userBook: number, date: string) => Promise<void>} */
		const addRead = async (userBook, date) => {
			const r = (
				await client.ask(QUERIES.addRead, {
					id: userBook,
					read: {finished_at: date, ...(a.edition ? {edition_id: a.edition} : {})},
				})
			).insert_user_book_read;
			if (!r || r.error)
				sent.problems.push(`${a.books[0].title}: read ${date} not added (${(r && r.error) || 'no answer'})`);
			else sent.reads++;
		};
		if (group === 'reads') {
			for (const d of a.dates) await addRead(a.userBook, d);
			return sent;
		}
		const object = {book_id: a.book, status_id: READ, ...(a.edition ? {edition_id: a.edition} : {})};
		const r = (await client.ask(QUERIES.addBook, {object})).insert_user_book;
		if (!r || r.error || !r.id) {
			sent.problems.push(`${a.books[0].title}: not added (${(r && r.error) || 'no answer'})`);
			return sent;
		}
		sent.shelved++;
		for (const d of a.dates) await addRead(r.id, d);
		return sent;
	}

	// ------------------------------------------------------------ reading answers
	/**
	 * Names from a Hardcover contributions list, as a list: the authors (no role, or "Author"), or those with `role`.
	 * @param {unknown} contributions
	 * @param {string} [role]
	 * @returns {string[]}
	 */
	static people(contributions, role) {
		const names = (Array.isArray(contributions) ? contributions : [])
			.filter(
				c =>
					Text.isObject(c) &&
					(role ? c.contribution === role : !c.contribution || c.contribution === 'Author'),
			)
			.map(c => (Text.isObject(c.author) && typeof c.author.name === 'string' ? Text.tidy(c.author.name) : ''))
			.filter(Boolean);
		return [...new Set(names)];
	}

	/**
	 * One of your editions made from a Hardcover edition.
	 * @param {Unchecked} edition a row of Hardcover's editions
	 * @returns {Edition}
	 */
	static edition(edition) {
		// Hardcover's ASIN is amazon.com's
		const asin =
			typeof edition.asin === 'string' && /^[A-Z0-9]{10}$/.test(edition.asin.trim()) ? edition.asin.trim() : null;
		const ed = new Edition({
			external: {...(asin ? {[ExternalCatalog.AMAZON_SITE]: asin} : {}), hardcover: String(edition.id)},
		});
		// the ISBN-10 and ISBN-13 of an edition are one ISBN; should they differ, the ISBN-13 wins
		const isbn = [edition.isbn_13, edition.isbn_10].map(Isbn.parse).find(Boolean);
		if (isbn) ed.isbn = isbn;
		ed.narrators = HardcoverSync.people(edition.contributions, 'Narrator');
		if (
			Text.isObject(edition.publisher) &&
			typeof edition.publisher.name === 'string' &&
			Text.tidy(edition.publisher.name)
		)
			ed.publisher = Text.tidy(edition.publisher.name);
		const released = Text.parseDate(edition.release_date);
		if (released) ed.released = released;
		if (Number.isInteger(edition.audio_seconds) && edition.audio_seconds >= 60)
			ed.minutes = Math.round(edition.audio_seconds / 60);
		return ed;
	}

	/**
	 * A Hardcover book as a stored book's start: its title, authors, and featured series with its number there.
	 * @param {Unchecked} book one with a title
	 * @returns {Record<string, any>}
	 */
	static bookRecord(book) {
		/** @type {Record<string, any>} */
		const rec = {t: Text.tidy(book.title), a: HardcoverSync.people(book.contributions)};
		const series = Text.isObject(book.featured_book_series) ? book.featured_book_series : null;
		if (
			series &&
			Text.isObject(series.series) &&
			typeof series.series.name === 'string' &&
			Text.tidy(series.series.name)
		) {
			rec.s = Text.tidy(series.series.name);
			const number = HardcoverSync.position(series.position);
			if (number) rec.sn = number;
		}
		return rec;
	}

	/**
	 * "2" for a position of 2, "2.5" for 2.5; null when there is none.
	 * @param {unknown} position
	 * @returns {string | null}
	 */
	static position(position) {
		return typeof position === 'number' && position >= 0 ? String(position) : null;
	}

	/**
	 * Your books from your Hardcover shelf: `userBooks` (user_books rows), with `books` and `editions` as
	 * Maps of id -> the rows the books and editions queries answered. Only books on the Read shelf are kept,
	 * each with its finished dates (no date stays unknown, as in the catalog); an edition Hardcover has as a
	 * print book or an ebook is left out of the book, and listed in `notAudio`. Returns {books, audio
	 * (the books whose edition is an audiobook), otherShelves (how many are on other shelves), warnings, notAudio}.
	 * @param {Unchecked[]} userBooks
	 * @param {Map<unknown, Unchecked>} books
	 * @param {Map<unknown, Unchecked>} editions
	 * @returns {HardcoverShelf}
	 */
	static read(userBooks, books, editions) {
		/** @type {HardcoverShelf} */
		const result = {books: [], audio: new Set(), otherShelves: 0, warnings: [], notAudio: []};
		for (const ub of userBooks) {
			if (!Text.isObject(ub)) continue;
			if (ub.status_id !== READ) {
				result.otherShelves++;
				continue;
			}
			const book = books.get(ub.book_id);
			if (!book || typeof book.title !== 'string' || !Text.tidy(book.title)) {
				result.warnings.push(`Hardcover book ${ub.book_id}: not found, skipped`);
				continue;
			}
			const edition = ub.edition_id ? editions.get(ub.edition_id) : null;
			const rec = HardcoverSync.bookRecord(book);
			if (!rec.a.length) {
				result.warnings.push(`${Text.repr(rec.t)}: no author on Hardcover, skipped`);
				continue;
			}
			const reads = Array.isArray(ub.user_book_reads) ? ub.user_book_reads : [];
			const dates = [
				...new Set(
					reads
						.map((/** @type {unknown} */ r) => Text.isObject(r) && Text.parseDate(r.finished_at))
						.filter(d => typeof d === 'string'),
				),
			].sort();
			if (dates.length) rec.r = dates;
			rec.ext = {hardcover: String(ub.book_id)};
			// a print book's or an ebook's edition is not one to fill in yours with
			const said = HardcoverClient.notAudio(edition);
			if (Text.isObject(edition) && !said) rec.e = [HardcoverSync.edition(edition).toJSON()];
			const read = Book.fromRecord(Book.fixSeriesTitle(rec));
			result.books.push(read);
			if (edition && edition.reading_format_id === HardcoverClient.AUDIO) result.audio.add(read);
			if (said)
				result.notAudio.push({
					book: read,
					yours: false,
					edition: `Hardcover edition ${ub.edition_id}`,
					said,
					url: ExternalCatalog.url('hardcover', 'edition', String(ub.edition_id)),
				});
		}
		return result;
	}

	// --------------------------------------------------------------- the export
	/**
	 * The Hardcover edition ids planExport() may send, as numbers: those of books with a Hardcover book id.
	 * @param {Book[]} books
	 * @returns {number[]}
	 */
	static exportEditions(books) {
		const ids = books
			.filter(b => b.idOn('hardcover'))
			.flatMap(b => b.editions)
			.map(ed => ed.idOn('hardcover'))
			.filter(hc => typeof hc === 'string' && HardcoverClient.ID.test(hc));
		return [...new Set(ids)].map(Number);
	}

	/**
	 * The ids that HardcoverClient.find() should look up: those of the editions of books without a Hardcover
	 * book id, and the ASINs and ISBNs of the other editions without a Hardcover edition id (to tell whether
	 * Hardcover has them as print books or ebooks).
	 * @param {Book[]} books
	 * @returns {HardcoverLookups}
	 */
	static lookups(books) {
		const ids = {hc: new Set(), asin: new Set(), isbn: new Set(), gr: new Set()};
		for (const b of books)
			for (const ed of b.editions) {
				const hc = ed.idOn('hardcover'),
					gr = ed.idOn('goodreads');
				if (b.idOn('hardcover') && hc) continue;
				ed.ids('asin').forEach(asin => ids.asin.add(asin));
				ed.isbns().forEach(isbn => ids.isbn.add(isbn));
				if (b.idOn('hardcover')) continue;
				if (hc && HardcoverClient.ID.test(hc)) ids.hc.add(Number(hc));
				if (gr) ids.gr.add(gr);
			}
		return Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, [...v]]));
	}

	/**
	 * Give your books and editions the Hardcover ids found for them (`found`: HardcoverClient.find()),
	 * strongest id first: the Hardcover edition id, the ASIN, the ISBN, the Goodreads id. A book without a
	 * Hardcover book id gets the one of its editions' Hardcover book (an edition of its own before a box
	 * set's), and its editions their Hardcover edition ids. Only empty values are filled. Changes `books`
	 * in place (a box set's copies alike, as they carry the same ids); returns the books that gained an id.
	 * @param {Book[]} books
	 * @param {HardcoverFound} found
	 * @returns {Book[]}
	 */
	static addIds(books, found) {
		const filled = [],
			shared = Book.sharedEditionTest(books);
		for (const b of books) {
			if (b.idOn('hardcover')) continue;
			let gained = false;
			for (const ed of [...b.editions.filter(x => !shared(x)), ...b.editions.filter(shared)]) {
				const hc = ed.idOn('hardcover'),
					gr = ed.idOn('goodreads');
				const hit =
					(hc && found.hc.get(hc)) ||
					ed
						.ids('asin')
						.map(asin => found.asin.get(asin))
						.find(Boolean) ||
					ed
						.isbns()
						.map(isbn => found.isbn.get(isbn))
						.find(Boolean) ||
					(gr && found.gr.get(gr));
				if (!hit) continue;
				if (hit.hc && !ed.idOn('hardcover')) {
					ed.external = {...ed.external, hardcover: hit.hc};
					gained = true;
				}
				if (!b.idOn('hardcover')) {
					b.external = {...b.external, hardcover: hit.hcb};
					gained = true;
				}
			}
			if (gained) filled.push(b);
		}
		return filled;
	}

	/**
	 * What an export to Hardcover would do: each of your books goes on your Read shelf as its Hardcover book,
	 * as the Hardcover edition of an edition of its own (or a box set's, when the box set is the Hardcover
	 * book), with its exact dates read as reads.
	 * `shelf` is your user_books rows. Nothing on Hardcover is changed: a book already on another shelf is
	 * left alone, and a book already on Read only gains the reads it lacks. Dates you only know to the month
	 * or year can't be a Hardcover read, so they are listed instead.
	 * `editionBooks`, when given, maps your editions' Hardcover edition ids to the Hardcover book each is an
	 * edition of (as Hardcover says): only an edition of the book's own Hardcover book is sent, since a box
	 * set's edition can be on a title whose Hardcover book is that title. Without it, a box set's edition
	 * (one on several of your books) is only sent for a box set (a Hardcover book several books are, or a
	 * book whose series number is a range).
	 * Returns {add: [{book (Hardcover book id), edition (or null), dates, books}], reads: [{userBook, edition,
	 * dates, books}], otherShelf: [[book, status name]], unknown: [books without a Hardcover book], inexact: [[book, date]]}.
	 * @param {Book[]} books
	 * @param {Unchecked[]} shelf
	 * @param {Map<string, string>} [editionBooks]
	 * @returns {HardcoverPlan}
	 */
	static planExport(books, shelf, editionBooks) {
		/** @type {HardcoverPlan} */
		const plan = {name: 'Read', add: [], reads: [], otherShelf: [], unknown: [], inexact: []};
		const onShelf = new Map();
		for (const ub of shelf) if (Text.isObject(ub) && !onShelf.has(ub.book_id)) onShelf.set(ub.book_id, ub);
		/** @type {Map<string, number>} */
		const owners = new Map(); // Hardcover book id -> how many of your books are it
		for (const b of books) {
			const hcb = b.idOn('hardcover');
			if (hcb) owners.set(hcb, (owners.get(hcb) || 0) + 1);
		}
		const shared = Book.sharedEditionTest(books);
		/** @type {Map<string, {edition: string | null, dates: Set<string>, books: Book[]}>} */
		const wanted = new Map(); // Hardcover book id -> {edition, dates, books}
		for (const b of books) {
			const hcb = b.idOn('hardcover');
			if (!hcb) {
				plan.unknown.push(b);
				continue;
			}
			const editions = b.editions.filter(ed => ed.idOn('hardcover'));
			const ed = editionBooks
				? editions.find(x => editionBooks.get(x.idOn('hardcover') || '') === hcb)
				: editions.find(x => !shared(x)) ||
					((owners.get(hcb) || 0) > 1 || b.isCollection() ? editions[0] : null);
			const exact = b.read.filter(d => /^\d{4}-\d\d-\d\d$/.test(d));
			for (const d of b.read) if (!exact.includes(d)) plan.inexact.push([b, d]);
			const w = wanted.get(hcb) || {edition: null, dates: new Set(), books: []};
			if (!w.edition && ed && ed.idOn('hardcover')) w.edition = ed.idOn('hardcover');
			exact.forEach(d => w.dates.add(d));
			w.books.push(b);
			wanted.set(hcb, w);
		}
		for (const [hcb, w] of wanted) {
			const book = Number(hcb),
				edition = w.edition ? Number(w.edition) : null,
				dates = [...w.dates].sort();
			const ub = onShelf.get(book);
			if (!ub) {
				plan.add.push({book, edition, dates, books: w.books});
				continue;
			}
			if (ub.status_id !== READ) {
				/** @type {Record<number, string>} */
				const statuses = HardcoverClient.STATUSES;
				for (const b of w.books) plan.otherShelf.push([b, statuses[ub.status_id] || `status ${ub.status_id}`]);
				continue;
			}
			const have = (Array.isArray(ub.user_book_reads) ? ub.user_book_reads : [])
				.map((/** @type {unknown} */ r) => Text.isObject(r) && r.finished_at)
				.filter(Boolean);
			const missing = dates.filter(d => !have.includes(d));
			if (missing.length) plan.reads.push({userBook: ub.id, edition, dates: missing, books: w.books});
		}
		return plan;
	}
}
