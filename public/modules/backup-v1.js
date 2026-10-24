// Everything about backups from before version 2, which have no `version`: the catalog by name ({books,
// seriesInfo, authors, narrators, publishers, excluded, notDuplicates, ids}), a plain list of books from
// before series info was exported, the data/ files a catalog kept before it lived in the browser (several
// files picked together), and the old shapes of books and editions they may hold, brought to the current
// one. The localStorage catalog from before IndexedDB is a version 1 backup too. Backup.read() hands such a
// backup here, and nothing else uses this module, so support for version 1 goes with this file and that call.
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Edition} from './edition.js';
import {ExternalCatalog} from './external-catalog.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import {Exclusions} from './exclusions.js';
import {Duplicates} from './duplicates.js';
/** @import {NameIds, NamedKind} from './catalog.js' */
/** @import {Unchecked} from './text.js' */
/** @import {ContributorKind} from './contributor.js' */
/** @import {BackupInit} from './backup.js' */

// Before editions, a book held its ASIN, Goodreads id and ISBNs itself; fixEditions() moves them.
const LEGACY_KEYS = ['id', 'gr', 'isbn'];
// Before ids were kept by external catalog, an edition kept them under keys of their own: its ASINs by
// site ("asin"), before that one ASIN ("id", audible.com's), its Goodreads id ("gr") and Hardcover id ("hc").
/** @type {Record<string, string>} */
const OLD_ID_KEYS = {gr: 'goodreads', hc: 'hardcover'};
// The ISBN of a stored edition, 13-digit, in a list; [] when it has none (or not a valid one).
/** @type {(ed: Unchecked) => string[]} */
const storedIsbns = ed => { const isbn = Text.isObject(ed) && typeof ed.isbn === 'string' ? Isbn.parse(ed.isbn) : null; return isbn ? [isbn] : []; };
// A list of the files Restore was given, [{name, text}], rather than a list of books.
/** @type {(data: unknown) => boolean} */
const isFileList = data => Array.isArray(data) && data.length > 0 && data.every(f => Text.isObject(f) && typeof f.name === 'string' && typeof f.text === 'string');

/**
 * Stored books as Books, saying which one could not be read.
 * @param {Unchecked[]} list stored books, in the current format
 * @returns {Book[]}
 */
function readBooks(list){
	return list.map((b, i) => {
		try{ return Book.fromJSON(b); }
		catch(exc){ throw new Error(`book #${i}: ${Text.errorText(exc)}`, {cause: exc}); }
	});
}

/** Reads version 1 backups and the old data/ files; every method is static. */
export class BackupV1 {
	/**
	 * The parts of a version 1 backup: the files Restore was given, several picked together (fromFiles()), or {books: [...], seriesInfo: {...}, authors: {...}, narrators: {...},
	 * publishers: {...}, excluded: [...], notDuplicates: [...], ids: {...}}, or a plain array of books from
	 * before series info was exported. The books are brought to the current format (Book.fixBooks). Series
	 * info, author, narrator and publisher info, the exclusions list entries and the "Not duplicates" marks
	 * are null when the backup predates them, so callers leave theirs alone. Throws when it is neither, or a
	 * part of it is not what it should be.
	 * @param {Unchecked} data
	 * @returns {BackupInit}
	 */
	static read(data){
		if(isFileList(data)) return BackupV1.read(BackupV1.fromFiles(/** @type {{name: string, text: string}[]} */ (data)));
		if(Array.isArray(data)) return {books: readBooks(BackupV1.fixBooks(data))};
		if(data && typeof data === 'object' && Array.isArray(data.books)){
			const {seriesInfo: info, excluded, notDuplicates} = data;
			if(info !== undefined && !Text.isObject(info)) throw new Error('seriesInfo is not an object');
			for(const kind of Contributor.KINDS) if(data[kind] !== undefined && !Text.isObject(data[kind])) throw new Error(`${kind} is not an object`);
			/** @type {(kind: ContributorKind) => Map<string, Contributor> | null} */
			const people = kind => data[kind] === undefined ? null
				: new Map(Object.entries(data[kind]).map(([name, entry]) => [name, Contributor.fromJSON(name, Contributor.fixLinks(entry, kind))]));
			for(const [name, list] of [['excluded', excluded], ['notDuplicates', notDuplicates]]){
				if(list !== undefined && !(Array.isArray(list) && list.every(x => typeof x === 'string'))){
					throw new Error(`${name} is not a list of strings`);
				}
			}
			const parts = {
				nameIds: BackupV1.readIds(data.ids),
				books: readBooks(BackupV1.fixBooks(data.books)),
				series: info === undefined ? null : new Map(Object.entries(info).map(([name, entry]) => [name, Series.fromJSON(name, entry)])),
				authors: people('authors'), narrators: people('narrators'), publishers: people('publishers'),
				excluded: excluded === undefined ? null : excluded,
				notDuplicates: notDuplicates === undefined ? null : notDuplicates,
			};
			// a series' site, from before authors and publishers kept their own, goes to them
			if(parts.series) Series.moveSites(parts.series, parts.books, parts, (_kind, name) => name);
			return parts;
		}
		throw new Error('expected a list of books or {books, seriesInfo, excluded}');
	}

	/**
	 * The ids of series and people by name, as a version 1 backup keeps them (`ids`: {series: {name: id}, authors: ...});
	 * null when it has none. Throws when they are not that.
	 * @param {unknown} ids
	 * @returns {NameIds | null}
	 */
	static readIds(ids){
		if(ids === undefined) return null;
		if(!Text.isObject(ids)) throw new Error('ids is not an object');
		/** @type {NameIds} */
		const out = {series: new Map(), authors: new Map(), narrators: new Map(), publishers: new Map()};
		for(const kind of /** @type {NamedKind[]} */ (['series', ...Contributor.KINDS])){
			const named = ids[kind];
			if(named === undefined) continue;
			if(!Text.isObject(named) || !Object.values(named).every(v => typeof v === 'string' && v.trim())) throw new Error(`ids.${kind} must map names to ids`);
			out[kind] = new Map(/** @type {[string, string][]} */ (Object.entries(named)));
		}
		return out;
	}

	/**
	 * The version 1 backup the data files a catalog kept before it lived in the browser make, picked together
	 * and told apart by name (books.json, series-info.json, authors.json (and narrators.json, publishers.json),
	 * excluded.txt, not-duplicates.txt; a file renamed with a date, say, still counts); a version 1 backup
	 * among them is their base. `files` are [{name, text}]. Throws when there are no books among them.
	 * @param {{name: string, text: string}[]} files
	 * @returns {Unchecked}
	 */
	static fromFiles(files){
		let backup = null;
		/** @type {Record<string, unknown>} */
		const picked = {};
		for(const {name, text} of files){
			const base = String(name).toLowerCase().replace(/^.*[\\/]/, '');
			if(base.endsWith('.txt')){
				if(base.includes('not-duplicates')) picked.notDuplicates = Duplicates.parseMarks(text);
				else if(base.includes('excluded')) picked.excluded = Exclusions.parse(text).entries;
				else throw new Error(`${name}: not one of the catalog's files`);
				continue;
			}
			const json = JSON.parse(text);
			if(base.startsWith('series-info')) picked.seriesInfo = json;
			else if(base.startsWith('authors')) picked.authors = json;
			else if(base.startsWith('narrators')) picked.narrators = json;
			else if(base.startsWith('publishers')) picked.publishers = json;
			else if(Array.isArray(json)) picked.books = json;
			else if(Text.isObject(json) && Array.isArray(json.books)) backup = json;
			else throw new Error(`${name}: not one of the catalog's files`);
		}
		const all = {...backup, ...picked};
		if(!Array.isArray(all.books)) throw new Error('no books.json or backup among the files');
		return all;
	}

	// ------------------------------------------------------------------ older shapes of a book
	/**
	 * Stored books in the current format: fixReadDates(), fixEditions(), fixBookIds(), fixPeople() and Book.fixSeriesTitle()
	 * on every book of a list; anything that is not a list is returned as is. A book whose editions name
	 * several Hardcover books keeps the one no other book's editions name (the others are a box set's,
	 * whose edition is on each of its titles).
	 * @param {Unchecked} books
	 * @returns {Unchecked}
	 */
	static fixBooks(books){
		if(!Array.isArray(books)) return books;
		const owners = new Map();   // Hardcover book id on editions -> how many books have it
		for(const b of books){
			// (editions held the Hardcover book id before it moved to the book)
			const ids = new Set(Book.storedEditions(b).map(ed => ed.hcb).filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()));
			for(const id of ids) owners.set(id, (owners.get(id) || 0) + 1);
		}
		const pickHcb = (/** @type {string[]} */ ids) => ids.find(id => owners.get(id) === 1) || ids[0];
		return books.map(b => Book.fixSeriesTitle(BackupV1.fixPeople(BackupV1.fixBookIds(BackupV1.fixEditions(BackupV1.fixReadDates(b), pickHcb)))));
	}

	/**
	 * A stored book with its dates read as a list. Hand-edited data may hold a single date as a plain
	 * string ("r": "2024-03-15", or "2023, 2024-03"); that becomes ["2024-03-15"]. An empty string drops
	 * the key; anything that still is not a list of dates is left for the Check to report.
	 * @param {Unchecked} rec
	 * @returns {Unchecked}
	 */
	static fixReadDates(rec){
		if(!rec || typeof rec !== 'object' || typeof rec.r !== 'string') return rec;
		const {r, ...rest} = rec;
		if(!r.trim()) return rest;
		const {dates, bad} = Text.parseDates(r);
		return {...rest, r: bad.length ? [Text.tidy(r)] : dates};
	}

	/**
	 * A stored book in the edition format. A book from before editions keeps its ASIN, Goodreads id and
	 * ISBNs itself ("id", "gr", "isbn"); they become its first edition (or fill in the edition that
	 * already has that ASIN or Goodreads id). A narrator on the book itself ("n", from before narrators
	 * moved to editions) goes on each of its editions that has none, or on a new edition when it has none.
	 * An edition with several ISBNs becomes one edition per ISBN (Edition.splitIsbns), and the Hardcover book
	 * id its editions held before it moved to the book ("hcb") goes on the book; when they name different
	 * Hardcover books, `pickHcb(ids)` chooses (by default the first). The editions' ids from before they were
	 * kept by external catalog go under `ext` (BackupV1.fixEditionIds). An empty `e` is dropped.
	 * @param {Unchecked} rec
	 * @param {(ids: string[]) => string} [pickHcb]
	 * @returns {Unchecked}
	 */
	static fixEditions(rec, pickHcb){
		if(!Text.isObject(rec)) return rec;
		/** @type {Record<string, any>} */
		const legacy = {};
		/** @type {Record<string, any>} */
		const out = {};
		for(const [k, v] of Object.entries(rec)){
			if(LEGACY_KEYS.includes(k)) legacy[k] = v; else if(k !== 'n') out[k] = v;
		}
		/** @type {Unchecked} */
		let editions = Array.isArray(rec.e) ? rec.e.flatMap((/** @type {Unchecked} */ ed) => Text.isObject(ed) ? Edition.splitIsbns(BackupV1.fixEditionIds(ed)) : [ed]) : rec.e;
		const fixedLegacy = Object.keys(legacy).length ? Edition.splitIsbns(BackupV1.fixEditionIds(legacy)) : [];
		if(fixedLegacy.length){
			editions = Array.isArray(editions) ? editions.map((/** @type {Unchecked} */ ed) => Text.isObject(ed) ? {...ed} : ed) : [];
			const [first, ...more] = fixedLegacy;
			const firstEd = Edition.fromJSON(first);
			const at = editions.findIndex((/** @type {Unchecked} */ ed) => {
				if(!Text.isObject(ed)) return false;
				const x = Edition.fromJSON(ed);
				return x.sameAs(firstEd) && x.sharesId(firstEd);
			});
			if(at >= 0){
				const same = Edition.fromJSON(editions[at]);
				same.fillFrom(firstEd);
				editions[at] = same.toJSON();
			}
			else editions.unshift(Edition.order(first));
			editions.push(...more);
		}
		// A Hardcover book id an edition carries belongs to the book now.
		/** @type {string[]} */
		const hcbs = [];
		if(Array.isArray(editions)){
			editions = editions.map((/** @type {Unchecked} */ ed) => {
				if(!Text.isObject(ed) || typeof ed.hcb !== 'string') return ed;
				const {hcb, ...rest} = ed;
				if(hcb.trim() && !hcbs.includes(hcb.trim())) hcbs.push(hcb.trim());
				return rest;
			}).filter((/** @type {Unchecked} */ ed) => !Text.isObject(ed) || Object.keys(ed).length);
			// an edition that is just an ISBN another edition of the book has is that edition
			editions = editions.filter((/** @type {Unchecked} */ ed, /** @type {number} */ j) => !(Text.isObject(ed) && Object.keys(ed).length === 1 && storedIsbns(ed).length &&
				editions.some((/** @type {Unchecked} */ x, /** @type {number} */ k) => k !== j && Text.isObject(x) && storedIsbns(x)[0] === storedIsbns(ed)[0] && (Object.keys(x).length > 1 || k < j))));
		}
		if('n' in rec && !(typeof rec.n === 'string' && !rec.n.trim())){
			if(editions === undefined || (Array.isArray(editions) && !editions.length)) editions = [{n: rec.n}];
			else if(Array.isArray(editions)) editions = editions.map((/** @type {Unchecked} */ ed) => Text.isObject(ed) && ed.n === undefined ? Edition.order({...ed, n: rec.n}) : ed);
			else out.n = rec.n;   // `e` is not a list: leave both for the Check to report
		}
		if(Array.isArray(editions) && !editions.length) editions = undefined;
		if(editions === undefined) delete out.e; else out.e = editions;
		if(hcbs.length && out.hcb === undefined && !(Text.isObject(out.ext) && out.ext.hardcover !== undefined)){
			// on the book, before its editions as usual
			const e = out.e;
			delete out.e;
			out.hcb = pickHcb ? pickHcb(hcbs) : hcbs[0];
			if(e !== undefined) out.e = e;
		}
		return out;
	}

	/**
	 * A stored book with its own ids under `ext`, by external catalog: the Hardcover book id it kept as "hcb"
	 * before goes in `ext.hardcover`, unless `ext` has another one, when it is left for the Check to report.
	 * @param {Unchecked} rec
	 * @returns {Unchecked}
	 */
	static fixBookIds(rec){
		if(!Text.isObject(rec) || !('hcb' in rec) || typeof rec.hcb !== 'string' || (rec.ext !== undefined && !Text.isObject(rec.ext))) return rec;
		const hcb = rec.hcb.trim(), had = Text.isObject(rec.ext) ? rec.ext.hardcover : undefined;
		if(hcb && had !== undefined && had !== hcb) return rec;
		const ext = hcb ? {...(rec.ext || {}), hardcover: hcb} : rec.ext;
		/** @type {Record<string, any>} */
		const out = {};
		// in its place among the keys, before the editions
		for(const [k, v] of Object.entries(rec)){
			if(k === 'hcb'){ if(ext && !('ext' in out)) out.ext = ExternalCatalog.order(ext); }
			else if(k === 'ext'){ if(!('ext' in out) && ext) out.ext = ExternalCatalog.order(ext); }
			else out[k] = v;
		}
		return out;
	}

	/**
	 * A stored edition with its ids under `ext`, by external catalog, as they are kept now: the ASINs it kept
	 * by site ("asin"), the ASIN it kept as "id" before that (audible.com's), its Goodreads id ("gr") and
	 * Hardcover id ("hc"). An old id that disagrees with the one `ext` has for its catalog, or that is not
	 * text, is left where it is for the Check to report.
	 * @param {Unchecked} ed
	 * @returns {Unchecked}
	 */
	static fixEditionIds(ed){
		if(!Text.isObject(ed) || !['id', 'asin', 'gr', 'hc'].some(k => k in ed)) return ed;
		if(ed.ext !== undefined && !Text.isObject(ed.ext)) return ed;
		/** @type {Record<string, any>} */
		const out = {...ed};
		/** @type {Record<string, unknown>} */
		const ext = {...(ed.ext || {})};
		/** @type {(catalog: string, v: unknown) => boolean} whether the old key's id went into ext */
		const move = (catalog, v) => {
			if(typeof v !== 'string') return false;
			if(!v.trim()) return true;
			if(ext[catalog] !== undefined && ext[catalog] !== v.trim()) return false;
			ext[catalog] = v.trim();
			return true;
		};
		if('asin' in out && Text.isObject(out.asin) && Object.entries(out.asin).every(([site, v]) => typeof v === 'string' && !(ext[site] !== undefined && ext[site] !== v.trim()))){
			for(const [site, v] of Object.entries(out.asin)) move(site, v);
			delete out.asin;
		}
		if('id' in out && move(ExternalCatalog.AUDIBLE_SITE, out.id)) delete out.id;
		for(const [key, catalog] of Object.entries(OLD_ID_KEYS)) if(key in out && move(catalog, out[key])) delete out[key];
		const ordered = ExternalCatalog.order(ext);
		if(ordered) out.ext = ordered; else delete out.ext;
		return Edition.order(out);
	}

	/**
	 * A stored book or edition with its authors ("a") and narrators ("n") as lists (fixNames()), its
	 * editions' too; the record itself is returned when nothing changes.
	 * @template T
	 * @param {T} rec
	 * @returns {T}
	 */
	static fixPeople(rec){
		if(!Text.isObject(rec)) return rec;
		/** @type {Record<string, any>} */
		let out = rec;
		for(const k of ['a', 'n']){
			if(!(k in rec)) continue;
			const names = BackupV1.fixNames(rec[k]);
			if(names === rec[k]) continue;
			if(out === rec) out = {...rec};
			if(names === null) delete out[k]; else out[k] = names;
		}
		if(Array.isArray(rec.e) && rec.e.some(ed => BackupV1.fixPeople(ed) !== ed)){
			if(out === rec) out = {...rec};
			out.e = rec.e.map(BackupV1.fixPeople);
		}
		return /** @type {T} */ (out);
	}

	/**
	 * Names as a list. Before they were lists, the authors ("a") and an edition's narrators ("n") were one
	 * comma separated string; that is split (splitNames). A list keeps its names as they are, without
	 * repeats or empty ones; anything else is left for the Check to report. Returns null for no names.
	 * @param {unknown} v
	 * @returns {unknown}
	 */
	static fixNames(v){
		if(typeof v === 'string') return Text.splitNames(v).length ? Text.splitNames(v) : null;
		if(!Array.isArray(v)) return v;
		const names = v.filter((x, i) => !(typeof x === 'string' && (!x.trim() || v.indexOf(x) !== i)));
		return !names.length ? null : names.length === v.length ? v : names;
	}
}
