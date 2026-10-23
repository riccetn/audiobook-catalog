// An author, narrator or publisher, by their name as the books write it, with what you keep about them:
// a short bio, their own site, their ids in external catalogs (Audible, Amazon, Goodreads, Hardcover; see
// ExternalCatalog) and any other links. Their series and titles are not kept here: they come from the
// books (Catalog.authorWorks, narratorWorks, publisherWorks).
import {Text} from './text.js';
import {ExternalCatalog} from './external-catalog.js';
/** @import {Unchecked} from './text.js' */
/** @import {ExternalKind} from './external-catalog.js' */

/** @typedef {'bio' | 'url' | 'ext' | 'links'} ContributorKey */
/** @typedef {'authors' | 'narrators' | 'publishers'} ContributorKind the catalog's (and a backup's) key for each kind's info */
/**
 * What a new Contributor's info is made of; every part is optional.
 * @typedef {object} ContributorInit
 * @property {string} [bio]
 * @property {string} [url]
 * @property {Record<string, string>} [external]
 * @property {string[]} [links]
 */

// Before ids were kept by external catalog, an entry kept the address of its page on Audible, Goodreads
// and Hardcover under keys of their own; fixLinks() reads the id out of each.
/** @type {Record<string, string>} */
const OLD_LINKS = {audible: 'audible', goodreads: 'goodreads', hardcover: 'hardcover'};

/** An author, narrator or publisher and what you keep about them. */
export class Contributor {
	/** @type {ContributorKind[]} the kinds, in the order backups and the Check list them */
	static KINDS = ['authors', 'narrators', 'publishers'];
	/** @type {Record<ContributorKind, 'author' | 'narrator' | 'publisher'>} one of each kind, as an external catalog and the stored records call them */
	static ONE = {authors: 'author', narrators: 'narrator', publishers: 'publisher'};
	/** @type {ContributorKey[]} the keys of a stored entry, in order */
	static KEYS = ['bio', 'url', 'ext', 'links'];

	/**
	 * @param {string} name
	 * @param {ContributorInit} [info]
	 */
	constructor(name, {bio, url, external = {}, links = []} = {}){
		this.name = name;
		/** @type {string | undefined} a few paragraphs, one per line */
		this.bio = bio;
		/** @type {string | undefined} their own site */
		this.url = url;
		/** @type {Record<string, string>} their ids by external catalog */
		this.external = {...external};
		/** @type {string[]} other pages about them, as addresses */
		this.links = [...links];
		/** @type {Record<string, unknown>} what the stored entry holds that is not their info (the Check reports it) */
		this.extra = {};
	}

	/**
	 * Someone from their entry in the stored info, in the current format (fixLinks() brings an older one
	 * to it). A value that is not what its key holds, and a key an entry has not, is kept aside as it is and
	 * written back by toJSON(), so the Check still reports it. Throws when the entry is not an object.
	 * @param {string} name
	 * @param {Unchecked} json
	 * @returns {Contributor}
	 */
	static fromJSON(name, json){
		if(!Text.isObject(json)) throw new Error(`the info of ${Text.repr(name)} is not an object`);
		const info = new Contributor(name);
		for(const [k, v] of Object.entries(json)){
			if((k === 'bio' || k === 'url') && typeof v === 'string') info[k] = v;
			else if(k === 'ext' && ExternalCatalog.isIds(v)) info.external = {...v};
			else if(k === 'links' && Array.isArray(v) && v.length && v.every(x => typeof x === 'string' && x.trim())) info.links = [...v];
			else info.extra[k] = v;
		}
		return info;
	}

	/**
	 * The value one of the stored entry's keys has, as toJSON() writes it; undefined when it has none.
	 * @param {ContributorKey} key
	 * @returns {unknown}
	 */
	value(key){
		if(key === 'ext') return ExternalCatalog.order(this.external) || undefined;
		if(key === 'links') return this.links.length ? [...this.links] : undefined;
		return this[key];
	}

	/**
	 * Take a site that was kept elsewhere (a series' site, Series.moveSite): it becomes their own site when
	 * they have none, else one of their other links. Returns false, changing nothing, when their site or
	 * links are not what those hold (the Check reports them).
	 * @param {string} site
	 * @returns {boolean}
	 */
	addSite(site){
		if('url' in this.extra || 'links' in this.extra) return false;
		if(!this.url) this.url = site;
		else if(this.url !== site && !this.links.includes(site)) this.links.push(site);
		return true;
	}

	/** @returns {Record<string, unknown>} the entry as the stored info keeps it */
	toJSON(){
		/** @type {Record<string, unknown>} */
		const out = {};
		for(const k of Contributor.KEYS){
			const v = this.value(k);
			if(v !== undefined) out[k] = v;
			else if(k in this.extra) out[k] = this.extra[k];
		}
		for(const [k, v] of Object.entries(this.extra)) if(!(k in out)) out[k] = v;
		return out;
	}

	/**
	 * An entry with tidy text: a bio keeps its paragraphs (lines) but loses stray spacing, links are
	 * trimmed, and empty fields are left out. Returns null when nothing is left.
	 * @param {string} name
	 * @param {Unchecked} entry the entry as typed or stored
	 * @returns {Contributor | null}
	 */
	static tidy(name, entry){
		if(!Text.isObject(entry)) return null;
		const info = new Contributor(name);
		if(typeof entry.bio === 'string') info.bio = entry.bio.split(/\r\n|\r|\n/).map(Text.tidy).join('\n').replace(/\n{3,}/g, '\n\n').trim() || undefined;
		if(typeof entry.url === 'string') info.url = entry.url.trim() || undefined;
		if(Text.isObject(entry.ext)){
			const ext = ExternalCatalog.tidy(entry.ext);
			info.external = /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(ext).filter(([, v]) => typeof v === 'string' && v)));
		}
		if(Array.isArray(entry.links)) info.links = entry.links.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean);
		return info.bio || info.url || Object.keys(info.external).length || info.links.length ? info : null;
	}

	/**
	 * A stored entry with its pages on Audible, Goodreads and Hardcover kept as ids, as they are kept now: the
	 * address it kept under "audible", "goodreads" or "hardcover" becomes the id it names (an Audible site's
	 * own, `ext["audible.co.uk"]`). An address the catalog's patterns can't read, or whose id disagrees with
	 * one `ext` has, is not lost: it goes on the entry's other links.
	 * @param {Unchecked} entry
	 * @param {ContributorKind} kind
	 * @returns {Unchecked}
	 */
	static fixLinks(entry, kind){
		if(!Text.isObject(entry) || !Object.keys(OLD_LINKS).some(k => k in entry)) return entry;
		if((entry.ext !== undefined && !Text.isObject(entry.ext)) || (entry.links !== undefined && !Array.isArray(entry.links))) return entry;
		/** @type {Record<string, any>} */
		const out = {};
		/** @type {Record<string, unknown>} */
		const ext = {...(entry.ext || {})};
		/** @type {unknown[]} */
		const links = [...(entry.links || [])];
		for(const [k, v] of Object.entries(entry)){
			if(!(k in OLD_LINKS)){ if(k !== 'ext' && k !== 'links') out[k] = v; continue; }
			if(typeof v !== 'string'){ out[k] = v; continue; }
			if(!v.trim()) continue;
			const found = ExternalCatalog.fromAddress(v, Contributor.ONE[kind], ExternalCatalog.keysOf(OLD_LINKS[k]));
			if(found && (ext[found.catalog] === undefined || ext[found.catalog] === found.id)) ext[found.catalog] = found.id;
			else if(!links.includes(v.trim())) links.push(v.trim());
		}
		const ordered = ExternalCatalog.order(ext);
		// in the usual order: bio, url, ext, links, then anything else for the Check
		return Object.fromEntries([...Contributor.KEYS.flatMap(k => k === 'ext' ? (ordered ? [[k, ordered]] : []) : k === 'links' ? (links.length ? [[k, links]] : [])
			: k in out ? [[k, out[k]]] : []), ...Object.entries(out).filter(([k]) => !(/** @type {string[]} */ (Contributor.KEYS)).includes(k))]);
	}
}
