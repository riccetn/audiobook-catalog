// The Check: what is wrong with a catalog as it is stored (errors, which block imports and merges) and
// what is worth a look (warnings). It reads the stored form (Catalog.toJSON(), a backup, a merged copy),
// as that is where a wrong value shows: a class keeps one aside as it is (see Book.fromJSON).
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Edition} from './edition.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import type {ContributorKind} from './contributor.js';
import {ExternalCatalog} from './external-catalog.js';
import {Cover} from './cover.js';
import type {Unchecked} from './text.js';
import type {Catalog} from './catalog.js';

/** what the Check found */
export type Problems = {errors: string[]; warnings: string[]};

const repr = Text.repr;
function nonEmpty(v: unknown): v is string {
	return typeof v === 'string' && v.trim() !== '';
}
// A list of names, as authors and narrators are kept.
const nameList: (v: unknown) => boolean = v =>
	Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.trim() !== '');

/** Checks a stored catalog; every method is static. */
export class Validator {
	/**
	 * What is wrong with a catalog's books and series info (validate()), and with its author, narrator and
	 * publisher info when `contributors` (validateContributors()): the Check.
	 */
	static check(catalog: Catalog, {contributors = false}: {contributors?: boolean} = {}): Problems {
		const json = JSON.parse(JSON.stringify(catalog));
		const problems = Validator.validate(json.books, json.seriesInfo);
		if (contributors) {
			for (const kind of Contributor.KINDS) {
				const found = Validator.validateContributors(json.books, kind, json[kind]);
				problems.errors.push(...found.errors);
				problems.warnings.push(...found.warnings);
			}
		}
		return problems;
	}

	/**
	 * check()'s errors about the books, which stop an import, a merge or the box sets; one about series
	 * info is not their doing (a series renamed in the page).
	 */
	static bookErrors(catalog: Catalog): string[] {
		return Validator.check(catalog).errors.filter(e => !e.startsWith('series-info'));
	}

	/**
	 * Check stored books and their series info. Returns {errors, warnings}: errors block imports; warnings are worth a look.
	 */
	static validate(books: unknown, info?: Unchecked): Problems {
		const errors: string[] = [];
		const warnings: string[] = [];
		if (!Array.isArray(books)) return {errors: ['books.json must contain a list'], warnings};
		const isObj = Text.isObject;

		// an external id ("asin B0…", "goodreads 4242") -> the first edition seen with it; a box set is one edition on several titles
		const seen = new Map();
		const nameOf: (family: string) => string = family =>
			family === 'asin' ? 'ASIN' : `${ExternalCatalog.name(family)} id`;
		books.forEach((b, i) => {
			const label = isObj(b) ? `book #${i} (${repr(b.t === undefined ? '?' : b.t)})` : `book #${i}`;
			if (!isObj(b)) {
				errors.push(`${label}: not an object`);
				return;
			}
			for (const k of Object.keys(b)) {
				if (!Book.KEYS.includes(k) && k !== Book.ID_KEY) errors.push(`${label}: unknown key ${repr(k)}`);
			}
			if (Book.ID_KEY in b && !nonEmpty(b[Book.ID_KEY]))
				errors.push(`${label}: ${repr(Book.ID_KEY)} must be a non-empty string when present`);
			if (!nonEmpty(b.t)) errors.push(`${label}: missing 't'`);
			if (!('a' in b)) errors.push(`${label}: missing 'a'`);
			else if (!nameList(b.a)) errors.push(`${label}: 'a' must be a non-empty list of authors' names`);
			for (const k of ['s', 'sn']) {
				if (k in b && !nonEmpty(b[k]))
					errors.push(`${label}: ${repr(k)} must be a non-empty string when present`);
			}
			if ('ext' in b) {
				const found = ExternalCatalog.problems(b.ext, 'book');
				errors.push(...found.errors.map(e => `${label}: ${e}`));
				warnings.push(...found.warnings.map(w => `${label}: ${w}`));
			}
			if ('g' in b && !(Array.isArray(b.g) && b.g.every(nonEmpty))) {
				errors.push(`${label}: 'g' must be a list of non-empty strings`);
			}
			if ('r' in b) {
				if (!(
					Array.isArray(b.r) &&
					b.r.length &&
					b.r.every(d => typeof d === 'string' && Text.parseDate(d) === d)
				)) {
					errors.push(`${label}: 'r' must be a non-empty list of dates read (YYYY-MM-DD, YYYY-MM or YYYY)`);
				} else if (b.r.some((d, j) => j > 0 && b.r[j - 1] >= d)) {
					warnings.push(`${label}: dates read ${repr(b.r)} are not in order (or repeat one)`);
				}
			}
			if ('e' in b && !(Array.isArray(b.e) && b.e.length)) {
				errors.push(`${label}: 'e' must be a non-empty list of editions`);
			} else if ('e' in b) {
				b.e.forEach((ed: unknown, j: number) =>
					Validator.validateEdition(ed, `${label} edition #${j + 1}`, errors, warnings),
				);
			}
			if (b.sn && !b.s) errors.push(`${label}: has a series number but no series`);
			if (b.sn && typeof b.sn === 'string' && !Series.NUMBER.test(b.sn.trim())) {
				warnings.push(`${label}: unusual series number ${repr(b.sn)}`);
			}
			const titleKey = Text.key(Text.norm(b.t), Book.firstAuthor(b.a));
			const editions = Book.storedEditions(b).map(Edition.fromJSON);
			const isbns = editions.flatMap(ed => ed.isbns());
			for (const isbn of new Set(isbns.filter((x, j) => isbns.indexOf(x) !== j)))
				warnings.push(`${label}: lists ISBN ${isbn} on two editions`);
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
					if (other.i === i) errors.push(`${label}: lists the edition with ${nameOf(family)} ${v} twice`);
					else if (other.titleKey === titleKey)
						errors.push(`${label}: duplicate ${nameOf(family)} ${v} (also ${other.label})`);
					else if (family === 'asin' || !ed.ids('asin').length || !other.ed.ids('asin').length) {
						// a box set's edition on each of its titles: fine, as long as the copies agree (on more than their id)
						const values: (x: Unchecked) => string = x => {
							const rest = Edition.order(Edition.tidyJSON(x));
							delete rest[Edition.ID_KEY];
							return JSON.stringify(rest);
						};
						if (values(stored) !== values(other.stored)) {
							warnings.push(
								`${label}: the edition with ${nameOf(family)} ${v} differs from its copy on ${other.label}`,
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
			if (typeof ed.p === 'string' && Text.tidy(ed.p) !== ed.p)
				untidy.set(Text.key('publisher', ed.p), ['publisher', ed.p, Text.tidy(ed.p)]);
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
			warnings.push(`${label} ${repr(value)} has stray spacing or run-together initials; use ${repr(expected)}`);
		}

		const sortedSeries = [...seriesNames].sort();
		for (const name of sortedSeries) {
			if (new RegExp('\\(' + 'books?' + '(?![\\p{L}\\p{N}_])', 'iu').test(name)) {
				warnings.push(
					`series name ${repr(name)} looks like leftover Audible markup (several series joined together?)`,
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
				warnings.push('series names that look like the same series: ' + [...variants].sort().join(' / '));
		}

		for (const [name, entry] of Object.entries(info || {})) {
			if (!isObj(entry)) {
				errors.push(`series-info[${repr(name)}]: not an object`);
				continue;
			}
			if (!Series.STATUSES.includes(entry.status))
				errors.push(
					`series-info[${repr(name)}]: status must be one of ${repr(Series.STATUSES.slice().sort())}`,
				);
			const total = entry.total;
			if (!(Number.isInteger(total) && total > 0) && total !== 'many') {
				errors.push(`series-info[${repr(name)}]: total must be a positive integer (or "many")`);
			}
			if ('ext' in entry) {
				const found = ExternalCatalog.problems(entry.ext, 'series');
				errors.push(...found.errors.map(e => `series-info[${repr(name)}]: ${e}`));
				warnings.push(...found.warnings.map(w => `series-info[${repr(name)}]: ${w}`));
			}
			const unknown = Object.keys(entry)
				.filter(k => !Series.KEYS.includes(k))
				.sort();
			if (unknown.length) errors.push(`series-info[${repr(name)}]: unknown keys ${repr(unknown)}`);
		}
		return {errors, warnings};
	}

	/**
	 * Check one stored edition of a book; adds to `errors` and `warnings`.
	 */
	static validateEdition(ed: Unchecked, label: string, errors: string[], warnings: string[]) {
		if (!Text.isObject(ed)) {
			errors.push(`${label}: not an object`);
			return;
		}
		for (const k of Object.keys(ed)) {
			if (!(Edition.KEYS as string[]).includes(k) && k !== Edition.ID_KEY)
				errors.push(`${label}: unknown key ${repr(k)}`);
		}
		if (Edition.ID_KEY in ed && !nonEmpty(ed[Edition.ID_KEY]))
			errors.push(`${label}: ${repr(Edition.ID_KEY)} must be a non-empty string when present`);
		for (const k of ['t', 'p', 'd', 'desc']) {
			if (k in ed && !nonEmpty(ed[k]))
				errors.push(`${label}: ${repr(k)} must be a non-empty string when present`);
		}
		if ('ext' in ed) {
			const found = ExternalCatalog.problems(ed.ext, 'edition');
			errors.push(...found.errors.map(e => `${label}: ${e}`));
			warnings.push(...found.warnings.map(w => `${label}: ${w}`));
		}
		if ('n' in ed && !nameList(ed.n)) errors.push(`${label}: 'n' must be a non-empty list of narrators' names`);
		if ('img' in ed && !Cover.isKeys(ed.img))
			errors.push(`${label}: 'img' must map a catalog (${Cover.CATALOGS.join(', ')}) to its cover's key`);
		// a cover alone is no edition
		if (!Object.keys(ed).some(k => k !== Edition.ID_KEY && k !== 'img')) errors.push(`${label}: is empty`);
		if (nonEmpty(ed.d) && Text.parseDate(ed.d) !== ed.d) {
			errors.push(`${label}: 'd' must be a release date (YYYY-MM-DD, YYYY-MM or YYYY), not ${repr(ed.d)}`);
		}
		if ('len' in ed && !(Number.isInteger(ed.len) && ed.len > 0)) {
			errors.push(`${label}: 'len' must be the length in whole minutes`);
		}
		if ('isbn' in ed) {
			const isbn = nonEmpty(ed.isbn) ? Isbn.parse(ed.isbn) : null;
			if (!nonEmpty(ed.isbn)) errors.push(`${label}: 'isbn' must be one ISBN (another ISBN is another edition)`);
			else if (!isbn) errors.push(`${label}: ${repr(ed.isbn)} is not a valid ISBN`);
			else if (isbn !== ed.isbn) warnings.push(`${label}: write ISBN ${repr(ed.isbn)} as ${repr(isbn)}`);
		}
	}

	/**
	 * Check stored author, narrator or publisher info (`kind`). Returns {errors,
	 * warnings}: a malformed entry, or an id that isn't one, is an error, and an id in a catalog this app
	 * doesn't know is a warning. An entry for a name no book has is fine: they are entries of their own.
	 * @param _books the stored books, which entries no longer have to match
	 */
	static validateContributors(_books: Unchecked, kind: ContributorKind, entries: Unchecked): Problems {
		const errors: string[] = [];
		const warnings: string[] = [];
		const one = Contributor.ONE[kind];
		if (entries === undefined || entries === null) return {errors, warnings};
		if (!Text.isObject(entries)) return {errors: [`${kind}: must map ${one} names to their info`], warnings};
		for (const [name, entry] of Object.entries(entries)) {
			const label = `${kind}[${repr(name)}]`;
			if (!Text.isObject(entry)) {
				errors.push(`${label}: not an object`);
				continue;
			}
			const unknown = Object.keys(entry)
				.filter(k => !(Contributor.KEYS as string[]).includes(k))
				.sort();
			if (unknown.length) errors.push(`${label}: unknown keys ${repr(unknown)}`);
			for (const k of ['bio', 'url']) {
				if (!(k in entry)) continue;
				const v = entry[k];
				if (typeof v !== 'string' || !v.trim())
					errors.push(`${label}: ${repr(k)} must be a non-empty string when present`);
				else if (k === 'url' && !Text.webHost(v.trim()))
					errors.push(`${label}: 'url' must be a web address starting with http:// or https://`);
			}
			if ('ext' in entry) {
				const found = ExternalCatalog.problems(entry.ext, Contributor.ONE[kind]);
				errors.push(...found.errors.map(e => `${label}: ${e}`));
				warnings.push(...found.warnings.map(w => `${label}: ${w}`));
			}
			if ('links' in entry) {
				const links = entry.links;
				if (!Array.isArray(links) || !links.length)
					errors.push(`${label}: 'links' must be a list of web addresses`);
				else
					for (const v of links) {
						if (typeof v !== 'string' || !Text.webHost(v.trim()))
							errors.push(
								`${label}: link ${repr(v)} must be a web address starting with http:// or https://`,
							);
						else {
							// a page the patterns can read is better kept as its id, so it can be matched and linked
							const found = ExternalCatalog.fromAddress(v, Contributor.ONE[kind]);
							if (found)
								warnings.push(
									`${label}: link ${repr(v)} is a page on ${ExternalCatalog.name(found.catalog)}; keep its id ${repr(found.id)} instead`,
								);
						}
					}
			}
		}
		return {errors, warnings};
	}
}
