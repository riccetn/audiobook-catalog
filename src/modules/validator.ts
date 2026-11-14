// The Check: what is wrong with a catalog as it is stored (errors, which block imports and merges) and
// what is worth a look (warnings). It reads the stored form (Catalog.toJSON(), a backup, a merged copy),
// as that is where a wrong value shows: a class keeps one aside as it is (see Book.fromJSON). Its messages
// are Phrases, which name what they are about with a label of their own ("book #3 ('Title')").
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Edition} from './edition.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import type {ContributorKind} from './contributor.js';
import {ExternalCatalog} from './external-catalog.js';
import {Cover} from './cover.js';
import type {Unchecked, Phrase, PhraseValue} from './text.js';
import type {Catalog} from './catalog.js';

/** what the Check found */
export type Problems = {errors: Phrase[]; warnings: Phrase[]};

const repr = Text.repr;
const nonEmpty = Text.nonEmpty;
const nameList = Text.isNameList;
const P = Text.phrase;

/** A Check message about `label` (a book, an edition, a series' or a person's info): "{label}: ...". */
function about(label: Phrase, template: string, values: Record<string, PhraseValue> = {}): Phrase {
	return P(`{label}: ${template}`, {label, ...values});
}

/** Adds the `ext` problems (ExternalCatalog.problems) of `label` to `errors` and `warnings`. */
function idProblems(found: Problems, label: Phrase, errors: Phrase[], warnings: Phrase[]) {
	errors.push(...found.errors.map(e => about(label, '{problem}', {problem: e})));
	warnings.push(...found.warnings.map(w => about(label, '{problem}', {problem: w})));
}

/** Checks a stored catalog; every method is static. */
export class Validator {
	/** the template of pageOnCatalog's warning (after its label), which a page can tell apart */
	static PAGE_ON_CATALOG = 'link {link} is a page on {catalog}; keep its id {id} instead';

	/** the label of a series' info (see labelOf) */
	static SERIES_LABEL = 'series-info[{name}]';

	/** the label of a book's edition (see labelOf): `book` the book's label, `n` its place from 1 */
	static EDITION_LABEL = '{book} edition #{n}';

	/** The label a Check message names what it is about by ("book #3 ('Title')"), or null when it has none. */
	static labelOf(problem: Phrase): Phrase | null {
		const label = problem.values.label;
		return problem.template.startsWith('{label}: ') && Text.isPhrase(label) ? label : null;
	}

	/** A Check message without its label (see labelOf): what a form says about the one thing it holds. */
	static unlabeled(problem: Phrase): Phrase {
		return Validator.labelOf(problem) ? P(problem.template.slice('{label}: '.length), problem.values) : problem;
	}

	/**
	 * What is wrong with a catalog's books and series info (validate()), and with its author, narrator and
	 * publisher info when `contributors` (validateContributors()): the Check.
	 */
	static check(catalog: Catalog, {contributors = false}: {contributors?: boolean} = {}): Problems {
		const json = JSON.parse(JSON.stringify(catalog));
		const problems = Validator.validate(json.books, json.seriesInfo);
		if (contributors) {
			for (const kind of Contributor.KINDS) {
				const found = Validator.validateContributors(kind, json[kind]);
				problems.errors.push(...found.errors);
				problems.warnings.push(...found.warnings);
			}
		}
		// a test's catalog may be its books alone
		for (const line of catalog.exclusions?.unreadable ?? [])
			problems.warnings.push(
				P(
					'exclusions: {line} is not an ASIN, "ISBN 978…", "Goodreads 12345", "Hardcover 12345" or "Title | Author", so it keeps nothing out',
					{line: repr(line)},
				),
			);
		return problems;
	}

	/**
	 * check()'s errors about the books, which stop an import, a merge or the box sets; one about series
	 * info is not their doing (a series renamed in the page).
	 */
	static bookErrors(catalog: Catalog): Phrase[] {
		return Validator.check(catalog).errors.filter(e => Validator.labelOf(e)?.template !== Validator.SERIES_LABEL);
	}

	/**
	 * Check stored books and their series info. Returns {errors, warnings}: errors block imports; warnings are worth a look.
	 */
	static validate(books: unknown, info?: Unchecked): Problems {
		const errors: Phrase[] = [];
		const warnings: Phrase[] = [];
		if (!Array.isArray(books)) return {errors: [P('books.json must contain a list')], warnings};
		const isObj = Text.isObject;

		// an external id ("asin B0…", "goodreads 4242") -> the first edition seen with it; a box set is one edition on several titles
		const seen = new Map();
		const nameOf: (family: string, id: string) => Phrase = (family, id) =>
			family === 'asin'
				? P('ASIN {id}', {id})
				: P('{catalog} id {id}', {catalog: ExternalCatalog.name(family), id});
		books.forEach((b, i) => {
			const label = isObj(b)
				? P('book #{i} ({title})', {i, title: repr(b.t === undefined ? '?' : b.t)})
				: P('book #{i}', {i});
			if (!isObj(b)) {
				errors.push(about(label, 'not an object'));
				return;
			}
			for (const k of Object.keys(b)) {
				if (!Book.KEYS.includes(k) && k !== Book.ID_KEY)
					errors.push(about(label, 'unknown key {key}', {key: repr(k)}));
			}
			if (Book.ID_KEY in b && !nonEmpty(b[Book.ID_KEY]))
				errors.push(about(label, '{key} must be a non-empty string when present', {key: repr(Book.ID_KEY)}));
			if (!nonEmpty(b.t)) errors.push(about(label, "missing 't'"));
			if (!('a' in b)) errors.push(about(label, "missing 'a'"));
			else if (!nameList(b.a)) errors.push(about(label, "'a' must be a non-empty list of authors' names"));
			for (const k of ['s', 'sn']) {
				if (k in b && !nonEmpty(b[k]))
					errors.push(about(label, '{key} must be a non-empty string when present', {key: repr(k)}));
			}
			if ('ext' in b) idProblems(ExternalCatalog.problems(b.ext, 'book'), label, errors, warnings);
			if ('links' in b) Validator.checkLinks(b.links, 'book', label, errors, warnings);
			if ('g' in b && !(Array.isArray(b.g) && b.g.every(nonEmpty))) {
				errors.push(about(label, "'g' must be a list of non-empty strings"));
			}
			if ('r' in b) {
				if (!(
					Array.isArray(b.r) &&
					b.r.length &&
					b.r.every(d => typeof d === 'string' && Text.parseDate(d) === d)
				)) {
					errors.push(
						about(label, "'r' must be a non-empty list of dates read (YYYY-MM-DD, YYYY-MM or YYYY)"),
					);
				} else if (b.r.some((d, j) => j > 0 && b.r[j - 1] >= d)) {
					warnings.push(
						about(label, 'dates read {dates} are not in order (or repeat one)', {dates: repr(b.r)}),
					);
				}
			}
			if ('e' in b && !(Array.isArray(b.e) && b.e.length)) {
				errors.push(about(label, "'e' must be a non-empty list of editions"));
			} else if ('e' in b) {
				b.e.forEach((ed: unknown, j: number) =>
					Validator.validateEdition(
						ed,
						P(Validator.EDITION_LABEL, {book: label, n: j + 1}),
						errors,
						warnings,
					),
				);
			}
			if (b.sn && !b.s) errors.push(about(label, 'has a series number but no series'));
			if (b.sn && typeof b.sn === 'string' && !Series.NUMBER.test(b.sn.trim())) {
				warnings.push(about(label, 'unusual series number {number}', {number: repr(b.sn)}));
			}
			const range = Series.range(b.sn);
			if (range && range[1] - range[0] >= Series.BOX_MAX)
				warnings.push(
					about(label, 'series number {number} covers more than {max} titles', {
						number: repr(b.sn),
						max: Series.BOX_MAX,
					}),
				);
			const titleKey = Text.key(Text.norm(b.t), Book.firstAuthor(b.a));
			const editions = Book.storedEditions(b).map(Edition.fromJSON);
			const isbns = editions.flatMap(ed => ed.isbns());
			for (const isbn of new Set(isbns.filter((x, j) => isbns.indexOf(x) !== j)))
				warnings.push(about(label, 'lists ISBN {isbn} on two editions', {isbn}));
			editions.forEach((ed, j) => {
				const stored = Book.storedEditions(b)[j];
				for (const key of ed.idKeys()) {
					const family = key.slice(0, key.indexOf(' ')),
						v = key.slice(key.indexOf(' ') + 1);
					const other = seen.get(key);
					if (!other) {
						seen.set(key, {i, label, titleKey, ed, stored});
						continue;
					}
					if (other.i === i)
						errors.push(about(label, 'lists the edition with {id} twice', {id: nameOf(family, v)}));
					else if (other.titleKey === titleKey)
						errors.push(
							about(label, 'duplicate {id} (also {other})', {id: nameOf(family, v), other: other.label}),
						);
					else if (family === 'asin' || !ed.ids('asin').length || !other.ed.ids('asin').length) {
						// a box set's edition on each of its titles: fine, as long as the copies agree (on more than their id)
						const values: (x: Unchecked) => string = x => {
							const rest = Edition.order(Edition.tidyJSON(x));
							delete rest[Edition.ID_KEY];
							return JSON.stringify(rest);
						};
						if (values(stored) !== values(other.stored)) {
							warnings.push(
								about(label, 'the edition with {id} differs from its copy on {other}', {
									id: nameOf(family, v),
									other: other.label,
								}),
							);
						}
					}
				}
			});
		});

		const seriesNames = new Set(books.filter(b => isObj(b) && b.s).map(b => b.s));

		const untidy = new Map();
		const labels = {t: 'title', a: 'author', s: 'series', g: 'genre'};
		for (const b of books) {
			if (!isObj(b)) continue;
			for (const [k, label] of Object.entries(labels)) {
				const values = Array.isArray(b[k]) ? b[k] : [b[k]];
				for (const value of values) {
					if (typeof value !== 'string') continue;
					const expected = k === 'a' ? Text.normalizeName(value) : Text.tidy(value);
					if (expected !== value) untidy.set(Text.key(label, value), [label, value, expected]);
				}
			}
		}
		for (const ed of books.flatMap(Book.storedEditions)) {
			for (const p of Array.isArray(ed.p) ? ed.p : []) {
				if (typeof p === 'string' && Text.tidy(p) !== p)
					untidy.set(Text.key('publisher', p), ['publisher', p, Text.tidy(p)]);
			}
			for (const n of Array.isArray(ed.n) ? ed.n : []) {
				if (typeof n === 'string' && Text.normalizeName(n) !== n)
					untidy.set(Text.key('narrator', n), ['narrator', n, Text.normalizeName(n)]);
			}
			if (typeof ed.t === 'string' && Text.tidy(ed.t) !== ed.t)
				untidy.set(Text.key('edition title', ed.t), ['edition title', ed.t, Text.tidy(ed.t)]);
			if (typeof ed.desc === 'string' && Text.tidy(ed.desc) !== ed.desc)
				untidy.set(Text.key('description', ed.desc), ['description', ed.desc, Text.tidy(ed.desc)]);
		}
		const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
		for (const [label, value, expected] of [...untidy.values()].sort(
			(x, y) => byText(x[0], y[0]) || byText(x[1], y[1]),
		)) {
			warnings.push(
				P(`${label} {value} has stray spacing or run-together initials; use {expected}`, {
					value: repr(value),
					expected: repr(expected),
				}),
			);
		}

		const sortedSeries = [...seriesNames].sort();
		for (const name of sortedSeries) {
			if (new RegExp('\\(' + 'books?' + '(?![\\p{L}\\p{N}_])', 'iu').test(name)) {
				warnings.push(
					P('series name {name} looks like leftover Audible markup (several series joined together?)', {
						name: repr(name),
					}),
				);
			}
		}

		const byNorm = new Map();
		for (const name of seriesNames) {
			const k = Series.norm(name);
			if (!byNorm.has(k)) byNorm.set(k, new Set());
			byNorm.get(k).add(name);
		}
		for (const variants of byNorm.values()) {
			if (variants.size > 1)
				warnings.push(
					P('series names that look like the same series: {names}', {
						names: [...variants].sort().join(' / '),
					}),
				);
		}

		for (const [name, entry] of Object.entries(info || {})) {
			const label = P(Validator.SERIES_LABEL, {name: repr(name)});
			if (!isObj(entry)) {
				errors.push(about(label, 'not an object'));
				continue;
			}
			// a series may have neither yet (one kept only by its id on another catalog): Stats lists what it lacks
			if (entry.status !== undefined && !Series.STATUSES.includes(entry.status))
				errors.push(
					about(label, 'status must be one of {statuses}', {statuses: repr(Series.STATUSES.slice().sort())}),
				);
			const total = entry.total;
			if (total !== undefined && !(Number.isInteger(total) && total > 0) && total !== 'many') {
				errors.push(about(label, 'total must be a positive integer (or "many")'));
			} else if (typeof total === 'number' && total > Series.TOTAL_MAX) {
				warnings.push(
					about(
						label,
						'total {total} is over {max}, which looks like a typo (no missing books are listed for it)',
						{
							total,
							max: Series.TOTAL_MAX,
						},
					),
				);
			}
			if ('ext' in entry) idProblems(ExternalCatalog.problems(entry.ext, 'series'), label, errors, warnings);
			if ('links' in entry) Validator.checkLinks(entry.links, 'series', label, errors, warnings);
			const unknown = Object.keys(entry)
				.filter(k => !Series.KEYS.includes(k))
				.sort();
			if (unknown.length) errors.push(about(label, 'unknown keys {keys}', {keys: repr(unknown)}));
		}
		return {errors, warnings};
	}

	/**
	 * Check one stored edition of a book; adds to `errors` and `warnings`.
	 */
	static validateEdition(ed: Unchecked, label: Phrase, errors: Phrase[], warnings: Phrase[]) {
		if (!Text.isObject(ed)) {
			errors.push(about(label, 'not an object'));
			return;
		}
		for (const k of Object.keys(ed)) {
			if (!(Edition.KEYS as string[]).includes(k) && k !== Edition.ID_KEY)
				errors.push(about(label, 'unknown key {key}', {key: repr(k)}));
		}
		if (Edition.ID_KEY in ed && !nonEmpty(ed[Edition.ID_KEY]))
			errors.push(about(label, '{key} must be a non-empty string when present', {key: repr(Edition.ID_KEY)}));
		for (const k of ['t', 'd', 'desc']) {
			if (k in ed && !nonEmpty(ed[k]))
				errors.push(about(label, '{key} must be a non-empty string when present', {key: repr(k)}));
		}
		if ('ext' in ed) idProblems(ExternalCatalog.problems(ed.ext, 'edition'), label, errors, warnings);
		if ('links' in ed) Validator.checkLinks(ed.links, 'edition', label, errors, warnings);
		if ('n' in ed && !nameList(ed.n)) errors.push(about(label, "'n' must be a non-empty list of narrators' names"));
		if ('p' in ed && !nameList(ed.p))
			errors.push(about(label, "'p' must be a non-empty list of publishers' names"));
		if ('img' in ed && !Cover.isKeys(ed.img))
			errors.push(
				about(label, "'img' must map a catalog ({catalogs}) to its cover's key", {
					catalogs: Cover.CATALOGS.join(', '),
				}),
			);
		// a cover alone is no edition
		if (!Object.keys(ed).some(k => k !== Edition.ID_KEY && k !== 'img')) errors.push(about(label, 'is empty'));
		if (nonEmpty(ed.d) && Text.parseDate(ed.d) !== ed.d) {
			errors.push(
				about(label, "'d' must be a release date (YYYY-MM-DD, YYYY-MM or YYYY), not {date}", {
					date: repr(ed.d),
				}),
			);
		}
		if ('len' in ed && !(Number.isInteger(ed.len) && ed.len > 0)) {
			errors.push(about(label, "'len' must be the length in whole minutes"));
		}
		if ('isbn' in ed) {
			const isbn = nonEmpty(ed.isbn) ? Isbn.parse(ed.isbn) : null;
			if (!nonEmpty(ed.isbn))
				errors.push(about(label, "'isbn' must be one ISBN (another ISBN is another edition)"));
			else if (!isbn) errors.push(about(label, '{isbn} is not a valid ISBN', {isbn: repr(ed.isbn)}));
			else if (isbn !== ed.isbn)
				warnings.push(about(label, 'write ISBN {isbn} as {tidy}', {isbn: repr(ed.isbn), tidy: repr(isbn)}));
		}
	}

	/**
	 * Check the links of a stored book, edition or series (`kind`); adds to `errors` and `warnings`. They must be a
	 * list of texts; a link that is no http or https address, one listed twice, and a page of a catalog the
	 * patterns read (better kept as its id, which matches and links) are worth a look.
	 */
	static checkLinks(
		links: unknown,
		kind: 'book' | 'edition' | 'series',
		label: Phrase,
		errors: Phrase[],
		warnings: Phrase[],
	) {
		if (!(Array.isArray(links) && links.length && links.every(nonEmpty))) {
			errors.push(about(label, "'links' must be a non-empty list of web addresses"));
			return;
		}
		links.forEach((v: string, j: number) => {
			if (links.indexOf(v) !== j) warnings.push(about(label, 'lists the link {link} twice', {link: repr(v)}));
			else if (!Text.webHost(v.trim()))
				warnings.push(
					about(label, 'link {link} is not a web address starting with http:// or https://', {link: repr(v)}),
				);
			else {
				// a book's page there, or one of its editions' (an Audible page is an edition's)
				const found =
					ExternalCatalog.fromAddress(v, kind) ||
					(kind === 'book' ? ExternalCatalog.fromAddress(v, 'edition') : null);
				if (found) warnings.push(Validator.pageOnCatalog(label, v, found));
			}
		});
	}

	/**
	 * Check stored author, narrator or publisher info (`kind`). Returns {errors,
	 * warnings}: a malformed entry, or an id that isn't one, is an error, and an id in a catalog this app
	 * doesn't know is a warning. An entry for a name no book has is fine: they are entries of their own.
	 */
	static validateContributors(kind: ContributorKind, entries: Unchecked): Problems {
		const errors: Phrase[] = [];
		const warnings: Phrase[] = [];
		const one = Contributor.ONE[kind];
		if (entries === undefined || entries === null) return {errors, warnings};
		if (!Text.isObject(entries)) return {errors: [P(`${kind}: must map ${one} names to their info`)], warnings};
		for (const [name, entry] of Object.entries(entries)) {
			const label = P(`${kind}[{name}]`, {name: repr(name)});
			if (!Text.isObject(entry)) {
				errors.push(about(label, 'not an object'));
				continue;
			}
			const unknown = Object.keys(entry)
				.filter(k => !(Contributor.KEYS as string[]).includes(k))
				.sort();
			if (unknown.length) errors.push(about(label, 'unknown keys {keys}', {keys: repr(unknown)}));
			for (const k of ['bio', 'url']) {
				if (!(k in entry)) continue;
				const v = entry[k];
				if (typeof v !== 'string' || !v.trim())
					errors.push(about(label, '{key} must be a non-empty string when present', {key: repr(k)}));
				else if (k === 'url' && !Text.webHost(v.trim()))
					errors.push(about(label, "'url' must be a web address starting with http:// or https://"));
			}
			if ('ext' in entry)
				idProblems(ExternalCatalog.problems(entry.ext, Contributor.ONE[kind]), label, errors, warnings);
			if ('links' in entry) {
				const links = entry.links;
				if (!Array.isArray(links) || !links.length)
					errors.push(about(label, "'links' must be a list of web addresses"));
				else
					for (const v of links) {
						if (typeof v !== 'string' || !Text.webHost(v.trim()))
							errors.push(
								about(label, 'link {link} must be a web address starting with http:// or https://', {
									link: repr(v),
								}),
							);
						else {
							// a page the patterns can read is better kept as its id, so it can be matched and linked
							const found = ExternalCatalog.fromAddress(v, Contributor.ONE[kind]);
							if (found) warnings.push(Validator.pageOnCatalog(label, v, found));
						}
					}
			}
		}
		return {errors, warnings};
	}

	/**
	 * The warning that `label`'s link is a page on a catalog whose id (`found`) is better kept instead
	 * (PAGE_ON_CATALOG after the label).
	 */
	static pageOnCatalog(label: Phrase, link: string, found: {catalog: string; id: string}): Phrase {
		return about(label, Validator.PAGE_ON_CATALOG, {
			link: repr(link),
			catalog: ExternalCatalog.name(found.catalog),
			id: repr(found.id),
		});
	}
}
