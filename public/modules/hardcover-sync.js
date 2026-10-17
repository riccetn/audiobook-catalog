// The Hardcover import, export and sync: Hardcover allows browser requests (its API answers with open CORS
// headers), so the page runs them. They only ever reach Hardcover through a HardcoverClient, and write only
// through `save`. The reading of answers and the planning are static, so the tests run them offline.
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Edition} from './edition.js';
import {Book} from './book.js';
import {Importer} from './importer.js';
import {HardcoverClient} from './hardcover-client.js';
import {ExternalCatalog} from './external-catalog.js';
/** @import {Unchecked} from './text.js' */
/** @import {Step, HardcoverLookups, HardcoverFound} from './hardcover-client.js' */
/** @import {Catalog} from './catalog.js' */
/** @import {MergeReport} from './merger.js' */

/**
 * What an export to Hardcover would do (HardcoverSync.planExport()).
 * @typedef {object} HardcoverPlan
 * @property {{book: number, edition: number | null, dates: string[], books: Book[]}[]} add
 * @property {{userBook: number, edition: number | null, dates: string[], books: Book[]}[]} reads
 * @property {[Book, string][]} otherShelf
 * @property {Book[]} unknown
 * @property {[Book, string][]} inexact
 */
/**
 * @typedef {object} HardcoverRunOptions
 * @property {boolean} [dryRun]
 * @property {(changed: boolean) => boolean | Promise<boolean>} save
 * @property {(line: string) => void} [out]
 * @property {(line: string) => void} [err]
 * @property {Step} [step]
 * @property {boolean} [british] say it in British spelling (Text.spelled())
 */
/** @typedef {{books: Book[], audio: Set<Book>, otherShelves: number, warnings: string[]}} HardcoverShelf your Read shelf as books (HardcoverSync.read()) */

const READ = HardcoverClient.READ;

/** Runs the Hardcover import, export and sync. */
export class HardcoverSync {
	/** @param {HardcoverClient} client */
	constructor(client){
		this.client = client;
	}

	/**
	 * A Hardcover import, export or sync (`mode` 'import', 'export' or 'sync': import, then export) of
	 * `catalog` (changed in place, so pass a copy). Import adds the books on your Hardcover Read shelf like
	 * any import; export puts your books on that shelf with their dates read. Neither ever changes or
	 * removes anything, here or on Hardcover. Options: `dryRun`, `out(line)` and `err(line)` (what it has to
	 * say), `step(text, done, total)` (progress), `british` (spelling) and `save()`, which keeps the changed
	 * catalog before anything is sent to Hardcover and returns false (having said why) when it can't.
	 * Returns a promise of the exit code.
	 * @param {Catalog} catalog
	 * @param {'import' | 'export' | 'sync'} mode
	 * @param {HardcoverRunOptions} opts
	 * @returns {Promise<number>}
	 */
	async run(catalog, mode, opts){
		const {dryRun, save} = opts;
		const out = opts.out || (() => {}), err = opts.err || (() => {}), step = opts.step || (() => {});
		const client = this.client;
		const before = JSON.stringify(catalog.books);
		const stop = (/** @type {unknown} */ exc) => { err(`error: ${Text.errorText(exc)}; nothing written`); return 1; };
		let shelf;
		try{
			step('Reading your Hardcover shelves');
			shelf = await client.shelf(step);
		}catch(exc){ return stop(exc); }

		if(mode !== 'export'){
			const read = shelf.filter(ub => ub && ub.status_id === READ);
			let result;
			try{
				const found = await client.rows('books', [...new Set(read.map(ub => ub.book_id))], step);
				const editions = await client.rows('editions', [...new Set(read.map(ub => ub.edition_id).filter(Boolean))], step);
				result = HardcoverSync.read(shelf, found, editions);
			}catch(exc){ return stop(exc); }
			const audio = result.audio;
			const report = catalog.merge(result.books, {allDates: true, addable: book => audio.has(book)});
			out(`Hardcover: ${result.books.length} books on your Read shelf`);
			HardcoverSync.mergeLines(report, result.warnings, opts.british).forEach(line => out(line));
			if(report.notAdded.length){
				out(`  not added, as Hardcover has no audiobook edition picked for them: ${report.notAdded.length}`);
				HardcoverSync.bookLines(report.notAdded, 5).forEach(line => out(line));
			}
		}

		let plan = null;
		if(mode !== 'import'){
			const books = catalog.books;
			// which Hardcover book each edition belongs to, so a box set's edition is never sent as a title's
			/** @type {Map<string, string>} */
			const editionBooks = new Map();
			let filled;
			try{
				filled = HardcoverSync.addIds(books, await client.find(HardcoverSync.lookups(books), step));
				const rows = await client.rows('editions', HardcoverSync.exportEditions(books), step, 'Checking your editions on Hardcover');
				for(const [id, row] of rows) editionBooks.set(String(id), String(row.book_id));
			}catch(exc){ return stop(exc); }
			plan = HardcoverSync.planExport(books, shelf, editionBooks);
			const reads = plan.add.reduce((n, a) => n + a.dates.length, 0) + plan.reads.reduce((n, a) => n + a.dates.length, 0);
			out('to Hardcover:');
			out(`  Hardcover ids filled in on your books: ${filled.length}`);
			out(`  books to put on your Read shelf: ${plan.add.length}`);
			HardcoverSync.bookLines(plan.add.flatMap(a => a.books)).forEach(line => out(line));
			out(`  dates read to add: ${reads}`);
			if(plan.otherShelf.length){
				out(`  on another Hardcover shelf, left alone: ${plan.otherShelf.length}`);
				for(const [book, status] of plan.otherShelf.slice(0, 15)) out(`    ! ${book.title} - ${Text.namesText(book.authors)}: ${status}`);
			}
			if(plan.inexact.length) out(`  dates read without a day, not sent (a Hardcover read needs one): ${plan.inexact.length}`);
			if(plan.unknown.length){
				out(`  not found on Hardcover (no ASIN, ISBN or Goodreads id it knows; add "Hardcover <edition id>" by hand): ${plan.unknown.length}`);
				HardcoverSync.bookLines(plan.unknown, 5).forEach(line => out(line));
			}
		}

		const {errors} = catalog.validate();
		if(errors.length){
			err('Validation failed, nothing written:\n  ' + errors.slice(0, 10).join('\n  '));
			return 1;
		}
		if(dryRun){
			out('(dry run: nothing written)');
			return 0;
		}
		// the ids first, so they are kept even if Hardcover stops answering halfway
		if(!(await save(JSON.stringify(catalog.books) !== before))) return 1;
		if(!plan) return 0;
		return this.push(plan, out, err, step);
	}

	/**
	 * Carry out planExport()'s plan on Hardcover. Returns a promise of the exit code.
	 * @param {HardcoverPlan} plan
	 * @param {(line: string) => void} out
	 * @param {(line: string) => void} err
	 * @param {Step} step
	 * @returns {Promise<number>}
	 */
	async push(plan, out, err, step){
		const client = this.client, QUERIES = HardcoverClient.QUERIES;
		let shelved = 0, reads = 0, done = 0;
		const total = plan.add.length + plan.reads.length;
		/** @type {string[]} */
		const problems = [];
		/** @type {(userBook: number, edition: number | null, date: string, book: Book) => Promise<void>} */
		const addRead = async (userBook, edition, date, book) => {
			const r = (await client.ask(QUERIES.addRead, {id: userBook, read: {finished_at: date, ...(edition ? {edition_id: edition} : {})}})).insert_user_book_read;
			if(!r || r.error) problems.push(`${book.title}: read ${date} not added (${r && r.error || 'no answer'})`); else reads++;
		};
		try{
			for(const a of plan.add){
				step('Putting books on your Hardcover Read shelf', done++, total);
				const object = {book_id: a.book, status_id: READ, ...(a.edition ? {edition_id: a.edition} : {})};
				const r = (await client.ask(QUERIES.addBook, {object})).insert_user_book;
				if(!r || r.error || !r.id){ problems.push(`${a.books[0].title}: not added (${r && r.error || 'no answer'})`); continue; }
				shelved++;
				for(const d of a.dates) await addRead(r.id, a.edition, d, a.books[0]);
			}
			for(const a of plan.reads){
				step('Adding reads to books on your Read shelf', done++, total);
				for(const d of a.dates) await addRead(a.userBook, a.edition, d, a.books[0]);
			}
		}catch(exc){
			err(`error: ${Text.errorText(exc)}; stopped after putting ${shelved} book(s) on Hardcover and adding ${reads} read(s). ` +
				'Run it again to carry on: what is already there is not added twice.');
			return 1;
		}
		out(`put ${shelved} book(s) on your Hardcover Read shelf and added ${reads} read(s)`);
		for(const p of problems.slice(0, 15)) out('    ! ' + p);
		return problems.length ? 1 : 0;
	}

	// ------------------------------------------------------------ reading answers
	/**
	 * Names from a Hardcover contributions list, as a list: the authors (no role, or "Author"), or those with `role`.
	 * @param {unknown} contributions
	 * @param {string} [role]
	 * @returns {string[]}
	 */
	static people(contributions, role){
		const names = (Array.isArray(contributions) ? contributions : []).filter(c => Text.isObject(c) &&
			(role ? c.contribution === role : !c.contribution || c.contribution === 'Author'))
			.map(c => Text.isObject(c.author) && typeof c.author.name === 'string' ? Text.tidy(c.author.name) : '').filter(Boolean);
		return [...new Set(names)];
	}

	/**
	 * One of your editions made from a Hardcover edition.
	 * @param {Unchecked} edition a row of Hardcover's editions
	 * @returns {Edition}
	 */
	static edition(edition){
		// Hardcover's ASIN is amazon.com's
		const asin = typeof edition.asin === 'string' && /^[A-Z0-9]{10}$/.test(edition.asin.trim()) ? edition.asin.trim() : null;
		const ed = new Edition({external: {...asin ? {[ExternalCatalog.AMAZON_SITE]: asin} : {}, hardcover: String(edition.id)}});
		// the ISBN-10 and ISBN-13 of an edition are one ISBN; should they differ, the ISBN-13 wins
		const isbn = [edition.isbn_13, edition.isbn_10].map(Isbn.parse).find(Boolean);
		if(isbn) ed.isbn = isbn;
		ed.narrators = HardcoverSync.people(edition.contributions, 'Narrator');
		if(Text.isObject(edition.publisher) && typeof edition.publisher.name === 'string' && Text.tidy(edition.publisher.name)) ed.publisher = Text.tidy(edition.publisher.name);
		const released = Text.parseDate(edition.release_date);
		if(released) ed.released = released;
		if(Number.isInteger(edition.audio_seconds) && edition.audio_seconds >= 60) ed.minutes = Math.round(edition.audio_seconds / 60);
		return ed;
	}

	/**
	 * "2" for a position of 2, "2.5" for 2.5; null when there is none.
	 * @param {unknown} position
	 * @returns {string | null}
	 */
	static position(position){
		return typeof position === 'number' && position >= 0 ? String(position) : null;
	}

	/**
	 * Your books from your Hardcover shelf: `userBooks` (user_books rows), with `books` and `editions` as
	 * Maps of id -> the rows the books and editions queries answered. Only books on the Read shelf are kept,
	 * each with its finished dates (no date stays unknown, as in the catalog). Returns {books, audio
	 * (the books whose edition is an audiobook), otherShelves (how many are on other shelves), warnings}.
	 * @param {Unchecked[]} userBooks
	 * @param {Map<unknown, Unchecked>} books
	 * @param {Map<unknown, Unchecked>} editions
	 * @returns {HardcoverShelf}
	 */
	static read(userBooks, books, editions){
		/** @type {HardcoverShelf} */
		const result = {books: [], audio: new Set(), otherShelves: 0, warnings: []};
		for(const ub of userBooks){
			if(!Text.isObject(ub)) continue;
			if(ub.status_id !== READ){ result.otherShelves++; continue; }
			const book = books.get(ub.book_id);
			if(!book || typeof book.title !== 'string' || !Text.tidy(book.title)){
				result.warnings.push(`Hardcover book ${ub.book_id}: not found, skipped`);
				continue;
			}
			const edition = ub.edition_id ? editions.get(ub.edition_id) : null;
			/** @type {Record<string, any>} */
			const rec = {t: Text.tidy(book.title), a: HardcoverSync.people(book.contributions)};
			if(!rec.a.length){
				result.warnings.push(`${Text.repr(rec.t)}: no author on Hardcover, skipped`);
				continue;
			}
			const series = Text.isObject(book.featured_book_series) ? book.featured_book_series : null;
			if(series && Text.isObject(series.series) && typeof series.series.name === 'string' && Text.tidy(series.series.name)){
				rec.s = Text.tidy(series.series.name);
				const number = HardcoverSync.position(series.position);
				if(number) rec.sn = number;
			}
			const reads = Array.isArray(ub.user_book_reads) ? ub.user_book_reads : [];
			const dates = [...new Set(reads.map((/** @type {unknown} */ r) => Text.isObject(r) && Text.parseDate(r.finished_at)).filter(d => typeof d === 'string'))].sort();
			if(dates.length) rec.r = dates;
			rec.ext = {hardcover: String(ub.book_id)};
			if(Text.isObject(edition)) rec.e = [HardcoverSync.edition(edition).toJSON()];
			const read = Importer.book(Book.fixSeriesTitle(rec));
			result.books.push(read);
			if(edition && edition.reading_format_id === HardcoverClient.AUDIO) result.audio.add(read);
		}
		return result;
	}

	// --------------------------------------------------------------- the export
	/**
	 * The Hardcover edition ids planExport() may send, as numbers: those of books with a Hardcover book id.
	 * @param {Book[]} books
	 * @returns {number[]}
	 */
	static exportEditions(books){
		const ids = books.filter(b => b.idOn('hardcover')).flatMap(b => b.editions).map(ed => ed.idOn('hardcover'))
			.filter(hc => typeof hc === 'string' && HardcoverClient.ID.test(hc));
		return [...new Set(ids)].map(Number);
	}

	/**
	 * The ids that HardcoverClient.find() should look up: those of the editions of books without a Hardcover book id.
	 * @param {Book[]} books
	 * @returns {HardcoverLookups}
	 */
	static lookups(books){
		const ids = {hc: new Set(), asin: new Set(), isbn: new Set(), gr: new Set()};
		for(const ed of books.filter(b => !b.idOn('hardcover')).flatMap(b => b.editions)){
			const hc = ed.idOn('hardcover'), gr = ed.idOn('goodreads');
			if(hc && HardcoverClient.ID.test(hc)) ids.hc.add(Number(hc));
			ed.ids('asin').forEach(asin => ids.asin.add(asin));
			ed.isbns().forEach(isbn => ids.isbn.add(isbn));
			if(gr) ids.gr.add(gr);
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
	static addIds(books, found){
		const filled = [], shared = Book.sharedEditionTest(books);
		for(const b of books){
			if(b.idOn('hardcover')) continue;
			let gained = false;
			for(const ed of [...b.editions.filter(x => !shared(x)), ...b.editions.filter(shared)]){
				const hc = ed.idOn('hardcover'), gr = ed.idOn('goodreads');
				const hit = (hc && found.hc.get(hc)) || ed.ids('asin').map(asin => found.asin.get(asin)).find(Boolean) ||
					ed.isbns().map(isbn => found.isbn.get(isbn)).find(Boolean) || (gr && found.gr.get(gr));
				if(!hit) continue;
				if(hit.hc && !ed.idOn('hardcover')){ ed.external = {...ed.external, hardcover: hit.hc}; gained = true; }
				if(!b.idOn('hardcover')){ b.external = {...b.external, hardcover: hit.hcb}; gained = true; }
			}
			if(gained) filled.push(b);
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
	static planExport(books, shelf, editionBooks){
		/** @type {HardcoverPlan} */
		const plan = {add: [], reads: [], otherShelf: [], unknown: [], inexact: []};
		const onShelf = new Map();
		for(const ub of shelf) if(Text.isObject(ub) && !onShelf.has(ub.book_id)) onShelf.set(ub.book_id, ub);
		/** @type {Map<string, number>} */
		const owners = new Map();   // Hardcover book id -> how many of your books are it
		for(const b of books){ const hcb = b.idOn('hardcover'); if(hcb) owners.set(hcb, (owners.get(hcb) || 0) + 1); }
		const shared = Book.sharedEditionTest(books);
		/** @type {Map<string, {edition: string | null, dates: Set<string>, books: Book[]}>} */
		const wanted = new Map();   // Hardcover book id -> {edition, dates, books}
		for(const b of books){
			const hcb = b.idOn('hardcover');
			if(!hcb){ plan.unknown.push(b); continue; }
			const editions = b.editions.filter(ed => ed.idOn('hardcover'));
			const ed = editionBooks ? editions.find(x => editionBooks.get(x.idOn('hardcover') || '') === hcb)
				: editions.find(x => !shared(x)) || ((owners.get(hcb) || 0) > 1 || b.isCollection() ? editions[0] : null);
			const exact = b.read.filter(d => /^\d{4}-\d\d-\d\d$/.test(d));
			for(const d of b.read) if(!exact.includes(d)) plan.inexact.push([b, d]);
			const w = wanted.get(hcb) || {edition: null, dates: new Set(), books: []};
			if(!w.edition && ed && ed.idOn('hardcover')) w.edition = ed.idOn('hardcover');
			exact.forEach(d => w.dates.add(d));
			w.books.push(b);
			wanted.set(hcb, w);
		}
		for(const [hcb, w] of wanted){
			const book = Number(hcb), edition = w.edition ? Number(w.edition) : null, dates = [...w.dates].sort();
			const ub = onShelf.get(book);
			if(!ub){ plan.add.push({book, edition, dates, books: w.books}); continue; }
			if(ub.status_id !== READ){
				/** @type {Record<number, string>} */
				const statuses = HardcoverClient.STATUSES;
				for(const b of w.books) plan.otherShelf.push([b, statuses[ub.status_id] || `status ${ub.status_id}`]);
				continue;
			}
			const have = (Array.isArray(ub.user_book_reads) ? ub.user_book_reads : []).map((/** @type {unknown} */ r) => Text.isObject(r) && r.finished_at).filter(Boolean);
			const missing = dates.filter(d => !have.includes(d));
			if(missing.length) plan.reads.push({userBook: ub.id, edition, dates: missing, books: w.books});
		}
		return plan;
	}

	// ------------------------------------------------------------------ reports
	/**
	 * Books as report lines ("    + Title - Author  [Series #2]"), at most `limit` of them.
	 * @param {Book[]} books
	 * @param {number} [limit]
	 * @returns {string[]}
	 */
	static bookLines(books, limit = 15){
		const lines = books.slice(0, limit).map(b =>
			`    + ${b.title} - ${Text.namesText(b.authors)}${b.series ? `  [${b.series}${b.number ? ' #' + b.number : ''}]` : ''}`);
		if(books.length > limit) lines.push(`    ... and ${books.length - limit} more`);
		return lines;
	}

	/**
	 * What a merge did, as report lines.
	 * @param {MergeReport} report
	 * @param {string[]} [warnings]
	 * @param {boolean} [british] in British spelling
	 * @returns {string[]}
	 */
	static mergeLines(report, warnings, british = false){
		const lines = [Text.spelled(`  already in the catalog: ${report.matched}`, british)];
		/** @type {[keyof MergeReport, string][]} */
		const counts = [['backfilled', 'ASINs filled in on existing books'], ['goodreadsFilled', 'Goodreads ids filled in on existing books'],
			['hardcoverFilled', 'Hardcover ids filled in on existing books'], ['datesFilled', 'dates read filled in on existing books'],
			['isbnsFilled', 'ISBNs added to existing books'], ['detailsFilled', 'narrator, publisher, release date or length filled in on existing books'],
			['editionsAdded', 'other editions added to existing books'], ['excluded', 'skipped (excluded from imports)']];
		for(const [k, label] of counts){
			const list = report[k];
			if(Array.isArray(list) && list.length) lines.push(`  ${label}: ${list.length}`);
		}
		if(report.boxSets.length){
			lines.push(`  box sets kept as their own book and as their titles: ${report.boxSets.length}`);
			for(const b of report.boxSets.slice(0, 15)) lines.push(`    ${b.title} - ${Text.namesText(b.authors)}: ${b.titles} already here, ${b.added} added`);
			if(report.boxSets.some(b => b.added)) lines.push('    (a title not here yet is named "Series, Book N" until --series or the `series` command names it)');
		}
		lines.push(`  new: ${report.added.length}`, ...HardcoverSync.bookLines(report.added));
		if(warnings && warnings.length){
			lines.push(`  needs a look (${warnings.length}):`);
			for(const w of warnings.slice(0, 15)) lines.push('    ! ' + w);
		}
		return lines;
	}
}
