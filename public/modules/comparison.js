// The catalog side by side with the books of another source (an Audible or Goodreads export, your Hardcover
// shelf): for each book there, whether it is new here, what an import would fill in, and where both have a
// value and the values differ. Applying it takes only what was picked: the books to import (as an import
// would, through Merger) and the values of the other source to put in place of this catalog's.
import {Text} from './text.js';
import {Series} from './series.js';
import {ExternalCatalog} from './external-catalog.js';
/** @import {Book} from './book.js' */
/** @import {Catalog} from './catalog.js' */
/** @import {Edition} from './edition.js' */
/** @import {MergeOptions, MergeReport} from './merger.js' */

/** @typedef {'t' | 'a' | 's' | 'sn' | 'r'} BookField */
/** @typedef {'n' | 'p' | 'd' | 'len'} EditionField */

/**
 * A value both have, or only the other source has where an import doesn't fill it in, that differs.
 * @typedef {object} Difference
 * @property {string} key what picks it: "<incoming place>:<field>" and, for an edition's value, ":<edition place>"
 * @property {BookField | EditionField} field
 * @property {string} label
 * @property {number} book the book's place in the catalog's books
 * @property {number | null} edition the edition's place in the book's editions, for an edition's value
 * @property {string} here this catalog's value as text ('' when it has none)
 * @property {string} there the other source's, as text
 * @property {string | string[] | number} value the other source's value, as the book or edition keeps it
 */

/**
 * One book of the other source, beside what it is in this catalog.
 * @typedef {object} ComparedBook
 * @property {number} at its place among the incoming books
 * @property {Book} theirs
 * @property {'new' | 'gains' | 'same' | 'excluded' | 'notAdded'} kind new here, has more to give, the same, or can't be added
 * @property {Book[]} books this catalog's books it is (as they are now)
 * @property {Book[]} added what importing it adds (a box set's titles, a new book)
 * @property {string[]} gains what importing it fills in on the books it is, besides their editions
 * @property {string[]} editionGains what its edition fills in on theirs, or the edition it adds
 * @property {Difference[]} differences
 * @property {boolean} boxSet
 */

/**
 * @typedef {object} ComparisonResult
 * @property {ComparedBook[]} books one for each incoming book, in order
 * @property {Book[]} onlyHere this catalog's books that none of the incoming books are
 * @property {Catalog} merged a copy of the catalog with every incoming book imported
 * @property {MergeReport} report what that import did
 */

/** @type {[BookField, string][]} */
const BOOK_FIELDS = [
	['t', 'Title'],
	['a', 'Authors'],
	['s', 'Series'],
	['sn', 'Number in series'],
	['r', 'Dates read'],
];
/** @type {[EditionField, string][]} */
const EDITION_FIELDS = [
	['n', 'Narrators'],
	['p', 'Publisher'],
	['d', 'Released'],
	['len', 'Length'],
];
/** @type {Record<string, string>} what an edition's key is called in what an import fills in */
const EDITION_LABELS = {
	isbn: 'ISBN',
	n: 'narrators',
	p: 'publisher',
	d: 'release date',
	len: 'length',
	desc: 'description',
	img: 'cover',
};

/** Compares the catalog with another source's books, and takes what was picked from them. */
export class Comparison {
	/**
	 * How the catalog and `incoming` compare: each incoming book's place here and what importing it would
	 * do (as catalog.merge would, with `opts`), and the values both have that differ. The catalog is not changed.
	 * @param {Catalog} catalog
	 * @param {Book[]} incoming
	 * @param {MergeOptions} [opts]
	 * @returns {ComparisonResult}
	 */
	static compare(catalog, incoming, opts) {
		const merged = catalog.clone();
		const report = merged.merge(incoming, opts);
		const mine = catalog.books,
			count = mine.length;
		/** @type {Map<Book, number>} */
		const places = new Map(merged.books.map((b, i) => [b, i]));
		const seen = new Set();
		const spellings = Comparison.seriesSpellings(mine);
		const books = report.matches.map((m, at) => {
			const found = m.books.map(b => /** @type {number} */ (places.get(b))).filter(i => i < count);
			found.forEach(i => seen.add(i));
			const gained = found.map(i =>
				Comparison.gains(mine[i], merged.books[i], found.length > 1 ? merged.books[i].title : ''),
			);
			const gains = gained.flatMap(g => g.book),
				editionGains = gained.flatMap(g => g.editions);
			const differences =
				m.boxSet || !found.length
					? []
					: Comparison.differences(
							at,
							found[0],
							mine[found[0]],
							m.incoming,
							spellings,
							!!(opts && opts.allDates),
						);
			/** @type {ComparedBook['kind']} */
			const kind =
				m.excluded && !found.length
					? 'excluded'
					: m.notAdded && !found.length
						? 'notAdded'
						: !found.length
							? 'new'
							: gains.length || editionGains.length || m.added.length
								? 'gains'
								: 'same';
			return {
				at,
				theirs: m.incoming,
				kind,
				books: found.map(i => mine[i]),
				added: m.added,
				gains,
				editionGains,
				differences,
				boxSet: m.boxSet,
			};
		});
		return {books, onlyHere: mine.filter((b, i) => !seen.has(i)), merged, report};
	}

	/**
	 * What book `after` (book `before` once imported into) gained, as short lines: the book's ("read
	 * 2024-03-01", "Hardcover id") and its editions' ("narrators", "another edition (...)"). `title` names
	 * the book, when the lines are about several.
	 * @param {Book} before
	 * @param {Book} after
	 * @param {string} title
	 * @returns {{book: string[], editions: string[]}}
	 */
	static gains(before, after, title) {
		/** @type {string[]} */
		const lines = [];
		/** @type {string[]} */
		const editions = [];
		const dates = after.read.filter(d => !before.read.includes(d));
		if (dates.length) lines.push(`read ${dates.join(', ')}`);
		for (const [key] of Object.entries(after.external))
			if (!before.idOn(key)) lines.push(`${ExternalCatalog.name(key)} id`);
		after.editions.forEach((ed, i) => {
			const was = before.editions[i];
			if (!was) {
				editions.push(
					`${before.editions.length ? 'another edition' : 'an edition'} (${ed.format() || 'no details'})`,
				);
				return;
			}
			/** @type {string[]} */
			const filled = [];
			for (const [key] of ed.externalList()) if (!was.idOn(key)) filled.push(`${ExternalCatalog.name(key)} id`);
			for (const k of /** @type {(keyof typeof EDITION_LABELS)[]} */ (Object.keys(EDITION_LABELS))) {
				if (was.value(k) === undefined && ed.value(k) !== undefined) filled.push(EDITION_LABELS[k]);
			}
			if (filled.length)
				editions.push((before.editions.length > 1 ? `edition ${i + 1}: ` : '') + filled.join(', '));
		});
		/** @type {(list: string[]) => string[]} */
		const named = list => (title ? list.map(l => `${title}: ${l}`) : list);
		return {book: named(lines), editions: named(editions)};
	}

	/**
	 * The series' names in `books` by Series.norm, as first spelled: an incoming series takes the spelling in use.
	 * @param {Book[]} books
	 * @returns {Map<string, string>}
	 */
	static seriesSpellings(books) {
		/** @type {Map<string, string>} */
		const out = new Map();
		for (const b of books)
			if (b.series && !out.has(Series.norm(b.series))) out.set(Series.norm(b.series), b.series);
		return out;
	}

	/**
	 * Where `theirs` (incoming book `at`) and `book` (the catalog's book at `place`) differ: the title,
	 * authors, series and number, and the narrators, publisher, release date and length of an edition they
	 * both have (as merge pairs them), and the dates read when the other source has some the book lacks
	 * (unless `allDates`, as importing then adds them). Only a value the other source has counts; an
	 * edition's value this catalog lacks is no difference, as importing fills it in, but a series is not.
	 * @param {number} at
	 * @param {number} place
	 * @param {Book} book
	 * @param {Book} theirs
	 * @param {Map<string, string>} spellings
	 * @param {boolean} [allDates]
	 * @returns {Difference[]}
	 */
	static differences(at, place, book, theirs, spellings, allDates = false) {
		/** @type {Difference[]} */
		const out = [];
		/** @type {(field: BookField | EditionField, label: string, edition: number | null, here: string, there: string, value: string | string[] | number) => void} */
		const add = (field, label, edition, here, there, value) =>
			out.push({
				key: `${at}:${field}${edition === null ? '' : ':' + edition}`,
				field,
				label,
				book: place,
				edition,
				here,
				there,
				value,
			});
		const theirSeries = theirs.series ? spellings.get(Series.norm(theirs.series)) || theirs.series : undefined;
		// Audible's long form of a title ("A Crown of Embers 5: A Spark of Dawn") is the same title, as imports read it
		const sameTitle = theirs.lookupKeys().includes(Text.key('title', Text.norm(book.title), theirs.authorKey()));
		for (const [field, label] of BOOK_FIELDS) {
			if (field === 't' && !sameTitle) add(field, label, null, book.title, theirs.title, theirs.title);
			if (
				field === 'a' &&
				theirs.authors.length &&
				theirs.authors.map(Text.norm).join('|') !== book.authors.map(Text.norm).join('|')
			) {
				add(field, label, null, Text.namesText(book.authors), Text.namesText(theirs.authors), [
					...theirs.authors,
				]);
			}
			if (field === 's' && theirSeries && Series.norm(book.series || '') !== Series.norm(theirSeries))
				add(field, label, null, book.series || '', theirSeries, theirSeries);
			if (field === 'sn' && theirs.number && String(book.number || '').trim() !== theirs.number.trim())
				add(field, label, null, book.number || '', theirs.number, theirs.number);
			// a book without dates read gains them on importing
			if (field === 'r' && !allDates && book.read.length && theirs.read.some(d => !book.hasReadDate(d))) {
				add(field, label, null, book.read.join(', '), theirs.read.join(', '), [...theirs.read]);
			}
		}
		for (const ed of theirs.editions) {
			let i = book.editions.findIndex(x => x.sameAs(ed));
			if (i < 0 && book.editions.length === 1 && !book.editions[0].conflictsWith(ed)) i = 0;
			if (i < 0) continue;
			const mine = book.editions[i];
			for (const [field, label] of EDITION_FIELDS) {
				const v = Comparison.editionValue(mine, field),
					w = Comparison.editionValue(ed, field);
				if (v === null || w === null || v.text === w.text) continue;
				if (field === 'len' && Math.abs(/** @type {number} */ (v.value) - /** @type {number} */ (w.value)) <= 1)
					continue; // rounding
				if (field !== 'len' && field !== 'd' && Text.norm(v.text) === Text.norm(w.text)) continue;
				add(field, label, i, v.text, w.text, w.value);
			}
		}
		return out;
	}

	/**
	 * An edition's value of `field`, as text and as kept; null when it has none.
	 * @param {Edition} ed
	 * @param {EditionField} field
	 * @returns {{text: string, value: string | string[] | number} | null}
	 */
	static editionValue(ed, field) {
		if (field === 'n')
			return ed.narrators.length ? {text: Text.namesText(ed.narrators), value: [...ed.narrators]} : null;
		if (field === 'len')
			return typeof ed.minutes === 'number' && Number.isInteger(ed.minutes)
				? {text: Text.formatLength(ed.minutes), value: ed.minutes}
				: null;
		const v = field === 'p' ? ed.publisher : ed.released;
		return v ? {text: v, value: v} : null;
	}

	/**
	 * Take into `catalog` (changed in place) what was picked of comparing it with `incoming` (compare(),
	 * with the same `opts`): the incoming books whose places are in `take` are imported (the editions of
	 * those that find a book here only when their places are in `editions`, when it is given), and the
	 * differences whose keys are in `patch` get the other source's value. A difference is looked for again
	 * in the catalog as it is now, so one that no longer differs is left alone. Returns the import's report
	 * and how many values were changed.
	 * @param {Catalog} catalog
	 * @param {Book[]} incoming
	 * @param {{take: Set<number>, patch: Set<string>, editions?: Set<number>}} picks
	 * @param {MergeOptions} [opts]
	 * @returns {{report: MergeReport, patched: number}}
	 */
	static apply(catalog, incoming, picks, opts) {
		const differences = Comparison.compare(catalog, incoming, opts)
			.books.flatMap(b => b.differences)
			.filter(d => picks.patch.has(d.key));
		const editions = picks.editions;
		const withEditions = editions ? (/** @type {Book} */ b) => editions.has(incoming.indexOf(b)) : undefined;
		const report = catalog.merge(
			incoming.filter((b, i) => picks.take.has(i)),
			{...opts, withEditions},
		);
		// the catalog's own books keep their places, as an import only adds books after them
		for (const d of differences) Comparison.patch(catalog.books, d);
		return {report, patched: differences.length};
	}

	/**
	 * Put a difference's value in place of the book's (or its edition's, and of each copy of that edition
	 * on a box set's other titles).
	 * @param {Book[]} books
	 * @param {Difference} d
	 */
	static patch(books, d) {
		const book = books[d.book];
		if (d.edition === null) {
			const v = d.value;
			if (d.field === 't' && typeof v === 'string') book.title = v;
			if (d.field === 'a' && Array.isArray(v)) book.authors = [...v];
			if (d.field === 's' && typeof v === 'string') book.series = v;
			if (d.field === 'sn' && typeof v === 'string') book.number = v;
			if (d.field === 'r' && Array.isArray(v)) book.read = [...v];
			return;
		}
		const ed = book.editions[d.edition];
		const copies = books.flatMap(b => b.editions.filter(x => x !== ed && x.sameAs(ed)));
		for (const x of [ed, ...copies]) x.set(d.field, Array.isArray(d.value) ? [...d.value] : d.value);
	}

	/**
	 * Whether a book is in a part of the catalog: the series `name` (spelled any way Series.norm takes as
	 * the same), or by the author `name` (one of its authors, ignoring case and accents).
	 * @param {'series' | 'author'} kind
	 * @param {string} name
	 * @returns {(book: Book) => boolean}
	 */
	static scope(kind, name) {
		if (kind === 'series') {
			const series = Series.norm(name);
			return book => Boolean(book.series) && Series.norm(/** @type {string} */ (book.series)) === series;
		}
		const author = Text.norm(name);
		return book => book.authors.some(a => Text.norm(a) === author);
	}

	/**
	 * The book as one line: "Title — Author  [Series #2]".
	 * @param {Book} b
	 * @returns {string}
	 */
	static bookLine(b) {
		const series = b.series ? `  [${b.series}${b.number ? ' #' + b.number : ''}]` : '';
		return `${b.title} — ${Text.namesText(b.authors)}${series}`;
	}
}
