// The Check: what is wrong with a catalog as it is stored (errors, which block imports and merges) and
// what is worth a look (warnings). It reads the stored form (Catalog.toJSON(), a backup, a merged copy),
// as that is where a wrong value shows: a class keeps one aside as it is (see Book.fromJSON).
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Edition} from './edition.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
/** @import {ContributorKind} from './contributor.js' */
import {HardcoverClient} from './hardcover-client.js';
/** @import {Unchecked} from './text.js' */

/** @typedef {{errors: string[], warnings: string[]}} Problems what the Check found */

const repr = Text.repr;
/**
 * @param {unknown} v
 * @returns {v is string}
 */
function nonEmpty(v){ return typeof v === 'string' && v.trim() !== ''; }
// A list of names, as authors and narrators are kept.
/** @type {(v: unknown) => boolean} */
const nameList = v => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.trim() !== '');
// The editions of a stored book that are objects.
/** @type {(rec: Unchecked) => Record<string, any>[]} */
const storedEditions = rec => rec && Array.isArray(rec.e) ? rec.e.filter(Text.isObject) : [];

/** Checks a stored catalog; every method is static. */
export class Validator {
	/**
	 * Check stored books and their series info. Returns {errors, warnings}: errors block imports; warnings are worth a look.
	 * @param {unknown} books
	 * @param {Unchecked} [info]
	 * @returns {Problems}
	 */
	static validate(books, info){
		/** @type {string[]} */
		const errors = [];
		/** @type {string[]} */
		const warnings = [];
		if(!Array.isArray(books)) return {errors: ['books.json must contain a list'], warnings};
		const isObj = Text.isObject;

		// ASIN / Goodreads id -> the first edition seen with it; a box set is one edition on several titles
		const seen = {asin: new Map(), gr: new Map(), hc: new Map()};
		const names = {asin: 'ASIN', gr: 'Goodreads id', hc: 'Hardcover id'};
		books.forEach((b, i) => {
			const label = isObj(b) ? `book #${i} (${repr(b.t === undefined ? '?' : b.t)})` : `book #${i}`;
			if(!isObj(b)){ errors.push(`${label}: not an object`); return; }
			for(const k of Object.keys(b)){
				if(!Book.KEYS.includes(k)) errors.push(`${label}: unknown key ${repr(k)}`);
			}
			if(!nonEmpty(b.t)) errors.push(`${label}: missing 't'`);
			if(!('a' in b)) errors.push(`${label}: missing 'a'`);
			else if(!nameList(b.a)) errors.push(`${label}: 'a' must be a non-empty list of authors' names`);
			for(const k of ['s', 'sn', 'hcb']){
				if(k in b && !nonEmpty(b[k])) errors.push(`${label}: ${repr(k)} must be a non-empty string when present`);
			}
			if(nonEmpty(b.hcb) && !HardcoverClient.ID.test(b.hcb.trim())) errors.push(`${label}: 'hcb' must be a Hardcover book id (digits only), not ${repr(b.hcb)}`);
			if('g' in b && !(Array.isArray(b.g) && b.g.every(nonEmpty))){
				errors.push(`${label}: 'g' must be a list of non-empty strings`);
			}
			if('r' in b){
				if(!(Array.isArray(b.r) && b.r.length && b.r.every(d => typeof d === 'string' && Text.parseDate(d) === d))){
					errors.push(`${label}: 'r' must be a non-empty list of dates read (YYYY-MM-DD, YYYY-MM or YYYY)`);
				} else if(b.r.some((d, j) => j > 0 && b.r[j - 1] >= d)){
					warnings.push(`${label}: dates read ${repr(b.r)} are not in order (or repeat one)`);
				}
			}
			if('e' in b && !(Array.isArray(b.e) && b.e.length)){
				errors.push(`${label}: 'e' must be a non-empty list of editions`);
			} else if('e' in b){
				b.e.forEach((/** @type {unknown} */ ed, /** @type {number} */ j) => Validator.validateEdition(ed, `${label} edition #${j + 1}`, errors, warnings));
			}
			if(b.sn && !b.s) errors.push(`${label}: has a series number but no series`);
			if(b.sn && typeof b.sn === 'string' && !Series.NUMBER.test(b.sn.trim())){
				warnings.push(`${label}: unusual series number ${repr(b.sn)}`);
			}
			const titleKey = Text.key(Text.norm(b.t), Book.firstAuthor(b.a));
			const editions = storedEditions(b).map(Edition.fromJSON);
			const isbns = editions.flatMap(ed => ed.isbns());
			for(const isbn of new Set(isbns.filter((x, j) => isbns.indexOf(x) !== j))) warnings.push(`${label}: lists ISBN ${isbn} on two editions`);
			editions.forEach((ed, j) => {
				const stored = storedEditions(b)[j];
				for(const field of Edition.IDS) for(const v of ed.ids(field)){
					const other = seen[field].get(v);
					if(!other){ seen[field].set(v, {i, label, titleKey, ed, stored}); continue; }
					if(other.i === i) errors.push(`${label}: lists the edition with ${names[field]} ${v} twice`);
					else if(other.titleKey === titleKey) errors.push(`${label}: duplicate ${names[field]} ${v} (also ${other.label})`);
					else if(field === 'asin' || !ed.ids('asin').length || !other.ed.ids('asin').length){
						// a box set's edition on each of its titles: fine, as long as the copies agree
						if(JSON.stringify(Edition.order(Edition.tidyJSON(stored))) !== JSON.stringify(Edition.order(Edition.tidyJSON(other.stored)))){
							warnings.push(`${label}: the edition with ${names[field]} ${v} differs from its copy on ${other.label}`);
						}
					}
				}
			});
		});

		const seriesNames = new Set(books.filter(b => isObj(b) && b.s).map(b => b.s));

		const untidy = new Map();
		const labels = {t: 'title', a: 'author', s: 'series', g: 'genre'};
		for(const b of books){
			if(!isObj(b)) continue;
			for(const [k, label] of Object.entries(labels)){
				const values = Array.isArray(b[k]) ? b[k] : [b[k]];
				for(const value of values){
					if(typeof value !== 'string') continue;
					const expected = k === 'a' ? Text.normalizeName(value) : Text.tidy(value);
					if(expected !== value) untidy.set(Text.key(label, value), [label, value, expected]);
				}
			}
		}
		for(const ed of books.flatMap(storedEditions)){
			if(typeof ed.p === 'string' && Text.tidy(ed.p) !== ed.p) untidy.set(Text.key('publisher', ed.p), ['publisher', ed.p, Text.tidy(ed.p)]);
			for(const n of Array.isArray(ed.n) ? ed.n : []){
				if(typeof n === 'string' && Text.normalizeName(n) !== n) untidy.set(Text.key('narrator', n), ['narrator', n, Text.normalizeName(n)]);
			}
			if(typeof ed.desc === 'string' && Text.tidy(ed.desc) !== ed.desc) untidy.set(Text.key('description', ed.desc), ['description', ed.desc, Text.tidy(ed.desc)]);
		}
		const byText = (/** @type {string} */ x, /** @type {string} */ y) => x < y ? -1 : x > y ? 1 : 0;
		for(const [label, value, expected] of [...untidy.values()].sort((x, y) => byText(x[0], y[0]) || byText(x[1], y[1]))){
			warnings.push(`${label} ${repr(value)} has stray spacing or run-together initials; use ${repr(expected)}`);
		}

		const sortedSeries = [...seriesNames].sort();
		for(const name of sortedSeries){
			if(new RegExp('\\(' + 'books?' + '(?![\\p{L}\\p{N}_])', 'iu').test(name)){
				warnings.push(`series name ${repr(name)} looks like leftover Audible markup (several series joined together?)`);
			}
		}

		const byNorm = new Map();
		for(const name of seriesNames){
			const k = Series.norm(name);
			if(!byNorm.has(k)) byNorm.set(k, new Set());
			byNorm.get(k).add(name);
		}
		for(const variants of byNorm.values()){
			if(variants.size > 1) warnings.push('series names that look like the same series: ' + [...variants].sort().join(' / '));
		}

		for(const [name, entry] of Object.entries(info || {})){
			if(!seriesNames.has(name)) errors.push(`series-info: ${repr(name)} matches no series in books.json`);
			if(!isObj(entry)){ errors.push(`series-info[${repr(name)}]: not an object`); continue; }
			if(!Series.STATUSES.includes(entry.status)) errors.push(`series-info[${repr(name)}]: status must be one of ${repr(Series.STATUSES.slice().sort())}`);
			const total = entry.total;
			if(!(Number.isInteger(total) && total > 0) && total !== 'many'){
				errors.push(`series-info[${repr(name)}]: total must be a positive integer (or "many")`);
			}
			if('url' in entry && !(typeof entry.url === 'string' && /^https?:\/\//.test(entry.url))){
				errors.push(`series-info[${repr(name)}]: url must start with http:// or https://`);
			}
			const unknown = Object.keys(entry).filter(k => !Series.KEYS.includes(k)).sort();
			if(unknown.length) errors.push(`series-info[${repr(name)}]: unknown keys ${repr(unknown)}`);
		}
		return {errors, warnings};
	}

	/**
	 * Check one stored edition of a book; adds to `errors` and `warnings`.
	 * @param {Unchecked} ed
	 * @param {string} label
	 * @param {string[]} errors
	 * @param {string[]} warnings
	 */
	static validateEdition(ed, label, errors, warnings){
		if(!Text.isObject(ed)){ errors.push(`${label}: not an object`); return; }
		for(const k of Object.keys(ed)){
			if(!/** @type {string[]} */ (Edition.KEYS).includes(k)) errors.push(`${label}: unknown key ${repr(k)}`);
		}
		for(const k of ['gr', 'hc', 'p', 'd', 'desc']){
			if(k in ed && !nonEmpty(ed[k])) errors.push(`${label}: ${repr(k)} must be a non-empty string when present`);
		}
		if('asin' in ed){
			const pairs = Text.isObject(ed.asin) ? Object.entries(ed.asin) : [];
			if(!pairs.length) errors.push(`${label}: 'asin' must be the edition's ASINs by site, e.g. {"audible.com": "B0..."}`);
			for(const [site, v] of pairs){
				if(!Edition.ASIN_SITE.test(site)) errors.push(`${label}: ${repr(site)} is not an Amazon or Audible site (e.g. audible.com, amazon.co.uk)`);
				if(!nonEmpty(v)) errors.push(`${label}: the ASIN on ${site} must be a non-empty string`);
			}
		}
		if('n' in ed && !nameList(ed.n)) errors.push(`${label}: 'n' must be a non-empty list of narrators' names`);
		if(!Object.keys(ed).length) errors.push(`${label}: is empty`);
		if(nonEmpty(ed.gr) && !Edition.GOODREADS_ID.test(ed.gr.trim())){
			errors.push(`${label}: 'gr' must be a Goodreads book id (digits only), not ${repr(ed.gr)}`);
		}
		if(nonEmpty(ed.hc) && !HardcoverClient.ID.test(ed.hc.trim())) errors.push(`${label}: 'hc' must be a Hardcover id (digits only), not ${repr(ed.hc)}`);
		if(nonEmpty(ed.d) && Text.parseDate(ed.d) !== ed.d){
			errors.push(`${label}: 'd' must be a release date (YYYY-MM-DD, YYYY-MM or YYYY), not ${repr(ed.d)}`);
		}
		if('len' in ed && !(Number.isInteger(ed.len) && ed.len > 0)){
			errors.push(`${label}: 'len' must be the length in whole minutes`);
		}
		if('isbn' in ed){
			const isbn = nonEmpty(ed.isbn) ? Isbn.parse(ed.isbn) : null;
			if(!nonEmpty(ed.isbn)) errors.push(`${label}: 'isbn' must be one ISBN (another ISBN is another edition)`);
			else if(!isbn) errors.push(`${label}: ${repr(ed.isbn)} is not a valid ISBN`);
			else if(isbn !== ed.isbn) warnings.push(`${label}: write ISBN ${repr(ed.isbn)} as ${repr(isbn)}`);
		}
	}

	/**
	 * Check stored author, narrator or publisher info (`kind`) against the stored books. Returns {errors,
	 * warnings}: a malformed entry is an error; an entry for a name no book has (an author renamed on their
	 * books) and a link to another site than its field says are warnings.
	 * @param {Unchecked} books
	 * @param {ContributorKind} kind
	 * @param {Unchecked} entries
	 * @returns {Problems}
	 */
	static validateContributors(books, kind, entries){
		/** @type {string[]} */
		const errors = [];
		/** @type {string[]} */
		const warnings = [];
		const one = {authors: 'author', narrators: 'narrator', publishers: 'publisher'}[kind];
		if(entries === undefined || entries === null) return {errors, warnings};
		if(!Text.isObject(entries)) return {errors: [`${kind}: must map ${one} names to their info`], warnings};
		const names = new Set((Array.isArray(books) ? books : []).flatMap(b => Validator.contributorNames(b, kind)));
		for(const [name, entry] of Object.entries(entries)){
			const label = `${kind}[${repr(name)}]`;
			if(!names.has(name)) warnings.push(`${kind}: ${repr(name)} matches no ${one} in books.json`);
			if(!Text.isObject(entry)){ errors.push(`${label}: not an object`); continue; }
			const unknown = Object.keys(entry).filter(k => !/** @type {string[]} */ (Contributor.KEYS).includes(k)).sort();
			if(unknown.length) errors.push(`${label}: unknown keys ${repr(unknown)}`);
			for(const k of Contributor.KEYS){
				if(!(k in entry)) continue;
				const v = entry[k];
				if(typeof v !== 'string' || !v.trim()){ errors.push(`${label}: ${repr(k)} must be a non-empty string when present`); continue; }
				if(k === 'bio') continue;
				const host = Text.webHost(v.trim());
				if(!host){ errors.push(`${label}: ${repr(k)} must be a web address starting with http:// or https://`); continue; }
				const site = Contributor.SITES[k];
				if(site && !site[1](host)) warnings.push(`${label}: ${repr(k)} should be an address on ${site[0]}, not ${repr(v)}`);
			}
		}
		return {errors, warnings};
	}

	/**
	 * The names a stored book gives for `kind`: its authors, or its editions' narrators or publishers.
	 * @param {Unchecked} b
	 * @param {ContributorKind} kind
	 * @returns {unknown[]}
	 */
	static contributorNames(b, kind){
		if(!Text.isObject(b)) return [];
		if(kind === 'authors') return Array.isArray(b.a) ? b.a : [];
		const editions = Array.isArray(b.e) ? b.e.filter(Text.isObject) : [];
		return kind === 'narrators' ? editions.flatMap(ed => Array.isArray(ed.n) ? ed.n : []) : editions.map(ed => ed.p);
	}
}
