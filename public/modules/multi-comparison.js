// A series' or an author's books beside several catalogs at once (each one's ShelfComparison): where your books'
// values and theirs differ, every value in one place with the catalogs that have it, to pick one; the books
// none of yours are, once each however many catalogs have them; and what each catalog would fill in. Nothing is
// picked at first, so applying the picks as they start changes nothing. Applying takes, from each catalog, what
// was picked of it, as that catalog's own comparison would (Comparison), and then puts the picked values in.
import {Text} from './text.js';
import {Comparison} from './comparison.js';
/** @import {Book} from './book.js' */
/** @import {Catalog} from './catalog.js' */
/** @import {MergeOptions, MergeReport} from './merger.js' */
/** @import {ComparedBook, Difference, SeriesRename} from './comparison.js' */
/** @import {ShelfComparison} from './shelf-sync.js' */

/**
 * One catalog compared: its name as the page says it, and its comparison.
 * @typedef {{label: string, result: ShelfComparison}} ComparedSource
 */
/**
 * A value a field could take: its text, and the catalogs that have it, each by its place in the sources and
 * the key of its Difference there.
 * @typedef {{text: string, from: {source: number, key: string}[]}} FieldChoice
 */
/**
 * A field of one of your books that some catalog has another value for (or has where yours has none).
 * @typedef {object} FieldChoices
 * @property {string} id what picks it: "<book place>:<field>" and, for an edition's value, ":<edition place>"
 * @property {string} label
 * @property {string} here your value as text ('' for none)
 * @property {FieldChoice[]} choices the catalogs' values, each once, in the order of the sources
 */
/**
 * One of your books whose values differ somewhere.
 * @typedef {{book: Book, place: number, fields: FieldChoices[]}} DifferingBook
 */
/**
 * A book none of yours are, with each catalog that has it (its place there, and the line it would be added as).
 * @typedef {{from: {source: number, at: number, line: string}[]}} NewBook
 */
/**
 * What a catalog's book would fill in on yours (and the box set's titles it would add); `edition` is what its
 * edition fills in, which is picked apart, as the edition picked there may not be yours.
 * @typedef {{source: number, at: number, book: Book, gains: string[], edition: string[]}} Gain
 */
/**
 * @typedef {object} MultiResult
 * @property {DifferingBook[]} differing
 * @property {NewBook[]} fresh
 * @property {Gain[]} gains
 */
/**
 * What is picked: the value for each field (by FieldChoices id, the place of its choice), the catalog each new
 * book is added from (by place in `fresh`, the source's place), the catalogs' books whose gains and whose
 * editions are taken ("<source>:<at>"), and the sources whose ids found are kept.
 * @typedef {{values: Map<string, number>, fresh: Map<number, number>, take: Set<string>, editions: Set<string>, ids: Set<number>}} MultiPicks
 */

/** Several catalogs' comparisons with the catalog, side by side. */
export class MultiComparison {
	/**
	 * Nothing picked: applying it changes nothing.
	 * @returns {MultiPicks}
	 */
	static noPicks() {
		return {values: new Map(), fresh: new Map(), take: new Set(), editions: new Set(), ids: new Set()};
	}

	/**
	 * The differences of each source's books with `catalog`'s, values the catalog lacks included (where the
	 * catalogs may differ too), as `[source, Difference]`.
	 * @param {Catalog} catalog
	 * @param {{incoming: Book[], comparison: {books: ComparedBook[]}, opts?: MergeOptions}[]} sources
	 * @returns {[number, Difference][]}
	 */
	static differences(catalog, sources) {
		const spellings = Comparison.seriesSpellings(catalog.books);
		/** @type {[number, Difference][]} */
		const out = [];
		sources.forEach((s, source) => {
			for (const b of s.comparison.books) {
				if (b.boxSet || !b.books.length) continue;
				const place = catalog.books.indexOf(b.books[0]);
				if (place < 0) continue;
				const allDates = !!(s.opts && s.opts.allDates);
				for (const d of Comparison.differences(b.at, place, b.books[0], b.theirs, spellings, allDates, true))
					out.push([source, d]);
			}
		});
		return out;
	}

	/**
	 * The sources' comparisons with `catalog` (not changed) side by side.
	 * @param {Catalog} catalog
	 * @param {ComparedSource[]} sources
	 * @returns {MultiResult}
	 */
	static compare(catalog, sources) {
		/** @type {Map<number, DifferingBook>} */
		const books = new Map();
		const results = sources.map(s => s.result);
		for (const [source, d] of MultiComparison.differences(catalog, results)) {
			const entry =
				books.get(d.book) ||
				books.set(d.book, {book: catalog.books[d.book], place: d.book, fields: []}).get(d.book);
			if (!entry) continue;
			const id = `${d.book}:${d.field}${d.edition === null ? '' : ':' + d.edition}`;
			let field = entry.fields.find(f => f.id === id);
			if (!field) entry.fields.push((field = {id, label: d.label, here: d.here, choices: []}));
			const same = (/** @type {FieldChoice} */ c) =>
				d.field === 'len' || d.field === 'd' ? c.text === d.there : Text.norm(c.text) === Text.norm(d.there);
			const choice = field.choices.find(same);
			if (choice) choice.from.push({source, key: d.key});
			else field.choices.push({text: d.there, from: [{source, key: d.key}]});
		}
		const differing = [...books.values()].sort((x, y) => x.place - y.place);
		return {differing, fresh: MultiComparison.fresh(catalog, sources), gains: MultiComparison.gains(sources)};
	}

	/**
	 * The books new to the catalog in each source, each once: one source's book is another's when importing
	 * both one after the other would make them one book.
	 * @param {Catalog} catalog
	 * @param {ComparedSource[]} sources
	 * @returns {NewBook[]}
	 */
	static fresh(catalog, sources) {
		const scratch = catalog.clone();
		/** @type {NewBook[]} */
		const out = [];
		/** @type {Map<Book, NewBook>} */
		const known = new Map();
		sources.forEach(({result}, source) => {
			const fresh = result.comparison.books.filter(b => b.kind === 'new');
			const report = scratch.merge(
				fresh.map(b => b.theirs),
				result.opts,
			);
			report.matches.forEach((m, i) => {
				const b = fresh[i];
				const made = [...m.books, ...m.added];
				let entry = made.map(x => known.get(x)).find(Boolean);
				if (!entry) out.push((entry = {from: []}));
				entry.from.push({source, at: b.at, line: Comparison.bookLine(b.added[0] || b.theirs)});
				for (const x of made) known.set(x, entry);
			});
		});
		return out;
	}

	/**
	 * What each source's books would fill in on the catalog's (or add to them).
	 * @param {ComparedSource[]} sources
	 * @returns {Gain[]}
	 */
	static gains(sources) {
		return sources.flatMap(({result}, source) =>
			result.comparison.books
				.filter(b => b.kind === 'gains')
				.map(b => ({
					source,
					at: b.at,
					book: b.books[0] || b.theirs,
					gains: [...b.gains, ...b.added.map(a => `adds ${Comparison.bookLine(a)}`)],
					edition: b.editionGains,
				})),
		);
	}

	/**
	 * How many changes `picks` make.
	 * @param {MultiPicks} picks
	 * @returns {number}
	 */
	static pickedCount(picks) {
		const editionsAlone = [...picks.editions].filter(k => !picks.take.has(k)).length;
		return picks.values.size + picks.fresh.size + picks.take.size + editionsAlone + picks.ids.size;
	}

	/**
	 * Take into `catalog` (changed in place) what `picks` pick of `result` (compare() with these sources): each
	 * source's new books and gains picked, as importing them would (their editions only where picked), then
	 * the values picked. The differences are looked for again in the catalog as it is now, so a value that no
	 * longer differs is left alone; a series picked that renames the series (Comparison.seriesRenames, by
	 * every source) renames it on all its books. Ids found are kept by the page, as each catalog keeps its own.
	 * @param {Catalog} catalog
	 * @param {{incoming: Book[], opts?: MergeOptions}[]} sources
	 * @param {MultiResult} result
	 * @param {MultiPicks} picks
	 * @returns {{reports: MergeReport[], patched: number, renamed: SeriesRename[]}}
	 */
	static apply(catalog, sources, result, picks) {
		/** @type {Set<string>} "<source>:<key>" of the differences picked */
		const wanted = new Set();
		for (const b of result.differing)
			for (const f of b.fields) {
				const at = picks.values.get(f.id);
				const choice = at === undefined ? undefined : f.choices[at];
				if (choice) wanted.add(`${choice.from[0].source}:${choice.from[0].key}`);
			}
		/** @type {Set<string>} "<source>:<at>" of the books to import */
		const take = new Set([...picks.take, ...picks.editions]);
		picks.fresh.forEach((source, n) => {
			const from = result.fresh[n] && result.fresh[n].from.find(f => f.source === source);
			if (from) take.add(`${source}:${from.at}`);
		});
		const now = sources.map(s => ({...s, comparison: Comparison.compare(catalog, s.incoming, s.opts)}));
		const differences = MultiComparison.differences(catalog, now).filter(([source, d]) =>
			wanted.has(`${source}:${d.key}`),
		);
		// worked out before the imports, whose new books may be in the series by its new name
		const renames = Comparison.seriesRenames(
			catalog,
			now.flatMap(s => s.comparison.books),
		);
		const reports = sources.map((s, source) => {
			const picked = (/** @type {Set<string>} */ set) => (/** @type {Book} */ b) =>
				set.has(`${source}:${s.incoming.indexOf(b)}`);
			// a book of yours gains its edition only where that is picked (a new book comes with its own)
			return catalog.merge(s.incoming.filter(picked(take)), {...s.opts, withEditions: picked(picks.editions)});
		});
		const renamed = Comparison.patchAll(
			catalog,
			differences.map(([, d]) => d),
			renames,
		);
		return {reports, patched: differences.length, renamed};
	}
}
