// What the external catalogs say about the books the Edit series page shows, book by book (the page's
// view of several ShelfComparisons): for each of its books, the values the catalogs have that differ from
// yours (to fill a field in with), what each catalog's book would add to it (ids, covers, dates read,
// editions), its editions a catalog says may not be audiobooks, and the editions it lists that you keep out
// of imports; then the books none of yours are. It reads the comparisons and changes nothing; take() puts a
// catalog's book into a copy of one of yours, as an import would.
import {Book} from './book.js';
import type {Edition} from './edition.js';
import {Merger} from './merger.js';
import {ExternalCatalog} from './external-catalog.js';
import {MultiComparison} from './multi-comparison.js';
import type {Catalog} from './catalog.js';
import type {Exclusions} from './exclusions.js';
import type {MergeOptions} from './merger.js';
import type {NewBook} from './multi-comparison.js';
import type {InfoId, NotAudio, ShelfComparison} from './shelf-sync.js';

/** One catalog compared: its name, its key in ExternalCatalog, and its comparison. */
export type ReviewSource = {label: string; catalog: string; result: ShelfComparison};
/** A value a catalog has for a field, as the field's input takes it, and the catalogs that have it. */
export type ValueChoice = {text: string; labels: string[]};
/**
 * A field of a book (`edition` null) or of one of its editions (by its stored id; its place in the book as
 * compared, when it has no id) that the catalogs have other values for.
 */
export interface FieldChoices {
	field: string;
	label: string;
	edition: string | null;
	editionPlace: number | null;
	choices: ValueChoice[];
}
/**
 * A catalog's book that is one of yours: where it is there (`url`), and what taking it in would add, as an
 * import would (`gains`, and what its edition would fill in or add, `edition`, which is taken apart). `at` is
 * its place among that catalog's books.
 */
export interface CatalogEntry {
	source: number;
	at: number;
	theirs: Book;
	url: string | null;
	gains: string[];
	edition: string[];
	/** its editions you keep out of imports (an `Edition …` exclusion), which taking it leaves out */
	excluded: Edition[];
}
/** What the catalogs say about one of your books. */
export interface ReviewedBook {
	fields: FieldChoices[];
	entries: CatalogEntry[];
	/** the catalogs (by place) that don't have it, as compared */
	notFound: number[];
	/** its editions the catalogs say may not be audiobooks */
	notAudio: {source: number; note: NotAudio}[];
}
/** What the catalogs say about the books shown (by book id), and what they have besides. */
export interface ReviewResult {
	books: Map<string, ReviewedBook>;
	/** the books none of yours are, each once with the catalogs that have it */
	fresh: NewBook[];
	/** each catalog's books of the series that aren't in the catalog (as it says them) */
	missing: {source: number; titles: string[]}[];
	/** what the catalogs read on your shelves as something else */
	otherNotAudio: {source: number; note: NotAudio}[];
	/** ids found there for the series and people */
	infoIds: {source: number; ids: InfoId[]}[];
}

/** The catalogs' view of the books on the Edit series page. */
export class BookReview {
	/**
	 * What `sources` (comparisons with `catalog`, not changed) say about the books whose ids are `ids`.
	 */
	static compare(catalog: Catalog, sources: ReviewSource[], ids: string[]): ReviewResult {
		const books: Map<string, ReviewedBook> = new Map(
			ids.map(id => [id, {fields: [], entries: [], notFound: [], notAudio: []}]),
		);
		// the editions you keep out of imports offer nothing: their values are left out of the choices
		const exclusions = catalog.exclusions;
		const offered = sources.map(s => ({
			...s,
			result: {
				...s.result,
				comparison: {
					...s.result.comparison,
					books: s.result.comparison.books.map(b => ({
						...b,
						theirs: BookReview.without(b.theirs, exclusions),
					})),
				},
			},
		}));
		const multi = MultiComparison.compare(catalog, offered);
		for (const differing of multi.differing) {
			const reviewed = differing.book.id === undefined ? undefined : books.get(differing.book.id);
			if (!reviewed) continue;
			for (const f of differing.fields) {
				const [, field, place] = f.id.split(':');
				const editionPlace = place === undefined ? null : Number(place);
				const ed = editionPlace === null ? undefined : differing.book.editions[editionPlace];
				reviewed.fields.push({
					field,
					label: f.label,
					edition: ed ? (ed.id ?? null) : null,
					editionPlace,
					choices: f.choices.map(c => ({
						text: c.text,
						labels: [...new Set(c.from.map(x => sources[x.source].label))],
					})),
				});
			}
		}
		sources.forEach(({catalog: key, result}, source) => {
			const seen: Set<string> = new Set();
			for (const b of result.comparison.books) {
				if (b.boxSet) continue;
				for (const mine of b.books) {
					const reviewed = mine.id === undefined ? undefined : books.get(mine.id);
					if (!reviewed) continue;
					seen.add(mine.id as string);
					reviewed.entries.push({
						source,
						at: b.at,
						theirs: b.theirs,
						url: BookReview.urlOf(b.theirs, key),
						gains: b.kind === 'gains' ? b.gains : [],
						edition: b.kind === 'gains' ? b.editionGains : [],
						excluded: b.theirs.editions.filter(ed => exclusions.coversEdition(ed)),
					});
				}
			}
			for (const [id, reviewed] of books) if (!seen.has(id)) reviewed.notFound.push(source);
		});
		const otherNotAudio: {source: number; note: NotAudio}[] = [];
		sources.forEach(({result}, source) => {
			for (const note of result.notAudio) {
				const reviewed = note.yours && note.book.id !== undefined ? books.get(note.book.id) : undefined;
				if (reviewed) reviewed.notAudio.push({source, note});
				else if (!note.yours) otherNotAudio.push({source, note});
			}
		});
		return {
			books,
			fresh: multi.fresh,
			missing: sources.map(({result}, source) => ({source, titles: result.missing})).filter(m => m.titles.length),
			otherNotAudio,
			infoIds: sources.map(({result}, source) => ({source, ids: result.infoIds})).filter(x => x.ids.length),
		};
	}

	/** A catalog's book without the editions `exclusions` keep out (itself when it has none of them). */
	static without(theirs: Book, exclusions: Exclusions): Book {
		if (!theirs.editions.some(ed => exclusions.coversEdition(ed))) return theirs;
		const copy = theirs.clone();
		copy.editions = copy.editions.filter(ed => !exclusions.coversEdition(ed));
		return copy;
	}

	/**
	 * The page of a catalog's book there: its book id on that catalog, else the first id its editions have.
	 * @param key the catalog's key in ExternalCatalog
	 */
	static urlOf(theirs: Book, key: string): string | null {
		const own = theirs.idOn(key);
		if (own) return ExternalCatalog.url(key, 'book', own);
		for (const ed of theirs.editions)
			for (const [site, id] of ed.externalList()) {
				const url = ExternalCatalog.url(site, 'edition', id);
				if (url) return url;
			}
		return null;
	}

	/**
	 * `book` with a catalog's book taken in, as an import would take it (Merger, with `opts`): the ids, dates
	 * read and edition details it lacks, and, with `withEdition`, the catalog's edition (filled into the one
	 * it is, or added). Editions `exclusions` keep out stay out. `book` is not changed; null when the catalog's
	 * book isn't this one (an import would add it as a book of its own).
	 */
	static take(
		book: Book,
		theirs: Book,
		exclusions: Exclusions,
		opts: MergeOptions,
		withEdition: boolean,
	): Book | null {
		const copy = book.clone();
		const report = new Merger([copy], exclusions, {...opts, withEditions: () => withEdition}).merge([theirs]);
		const match = report.matches[0];
		if (!match || match.books[0] !== copy || match.added.length) return null;
		return copy;
	}

	/**
	 * The ids and covers a catalog found for `book` (its sync's addIds with the comparison's `found`), on a
	 * copy; null when it found nothing new.
	 */
	static withIds(book: Book, addIds: (books: Book[], found: unknown) => Book[], found: unknown): Book | null {
		const copy = book.clone();
		return addIds([copy], found).length || copy.text() !== book.text() ? copy : null;
	}
}
