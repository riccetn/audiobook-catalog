// An author, narrator or publisher, by their name as the books write it, with what you keep about them:
// a short bio and links to their own site and their pages on Audible, Goodreads and Hardcover. Their
// series and titles are not kept here: they come from the books (Catalog.authorWorks, narratorWorks,
// publisherWorks).
import {Text} from './text.js';
/** @import {Unchecked} from './text.js' */

/** @typedef {'bio' | 'url' | 'audible' | 'goodreads' | 'hardcover'} ContributorKey */
/** @typedef {'authors' | 'narrators' | 'publishers'} ContributorKind the catalog's (and a backup's) key for each kind's info */

/** An author, narrator or publisher and what you keep about them. */
export class Contributor {
	/** @type {ContributorKind[]} the kinds, in the order backups and the Check list them */
	static KINDS = ['authors', 'narrators', 'publishers'];
	/** @type {ContributorKey[]} the keys of a stored entry, in order */
	static KEYS = ['bio', 'url', 'audible', 'goodreads', 'hardcover'];
	// Each link, and a test of the site it should point at (Audible has a store per country).
	/** @type {Record<string, [string, (host: string) => boolean]>} */
	static SITES = {
		audible: ['Audible', host => /(^|\.)audible\.[a-z.]+$/.test(host)],
		goodreads: ['Goodreads', host => /(^|\.)goodreads\.com$/.test(host)],
		hardcover: ['Hardcover', host => /(^|\.)hardcover\.app$/.test(host)],
	};

	/**
	 * @param {string} name
	 * @param {Partial<Record<ContributorKey, string>>} [info]
	 */
	constructor(name, {bio, url, audible, goodreads, hardcover} = {}){
		this.name = name;
		/** @type {string | undefined} a few paragraphs, one per line */
		this.bio = bio;
		/** @type {string | undefined} their own site */
		this.url = url;
		/** @type {string | undefined} */
		this.audible = audible;
		/** @type {string | undefined} */
		this.goodreads = goodreads;
		/** @type {string | undefined} */
		this.hardcover = hardcover;
		/** @type {Record<string, unknown>} what the stored entry holds that is not their info (the Check reports it) */
		this.extra = {};
	}

	/**
	 * Someone from their entry in the stored info. A value that is not text, and a key an
	 * entry has not, is kept aside as it is and written back by toJSON(), so the Check still
	 * reports it. Throws when the entry is not an object.
	 * @param {string} name
	 * @param {Unchecked} json
	 * @returns {Contributor}
	 */
	static fromJSON(name, json){
		if(!Text.isObject(json)) throw new Error(`the info of ${Text.repr(name)} is not an object`);
		const info = new Contributor(name);
		for(const [k, v] of Object.entries(json)){
			if(/** @type {string[]} */ (Contributor.KEYS).includes(k) && typeof v === 'string') info[/** @type {ContributorKey} */ (k)] = v;
			else info.extra[k] = v;
		}
		return info;
	}

	/** @returns {Record<string, unknown>} the entry as the stored info keeps it */
	toJSON(){
		/** @type {Record<string, unknown>} */
		const out = {};
		for(const k of Contributor.KEYS){
			if(this[k] !== undefined) out[k] = this[k];
			else if(k in this.extra) out[k] = this.extra[k];
		}
		for(const [k, v] of Object.entries(this.extra)) if(!(k in out)) out[k] = v;
		return out;
	}

	/**
	 * An entry with tidy text: a bio keeps its paragraphs (lines) but loses stray spacing, links
	 * are trimmed, and empty fields are left out. Returns null when nothing is left.
	 * @param {string} name
	 * @param {Unchecked} entry the entry as typed or stored
	 * @returns {Contributor | null}
	 */
	static tidy(name, entry){
		if(!Text.isObject(entry)) return null;
		const info = new Contributor(name);
		let any = false;
		for(const k of Contributor.KEYS){
			if(typeof entry[k] !== 'string') continue;
			const v = k === 'bio'
				? entry[k].split(/\r\n|\r|\n/).map(Text.tidy).join('\n').replace(/\n{3,}/g, '\n\n').trim()
				: entry[k].trim();
			if(v){ info[k] = v; any = true; }
		}
		return any ? info : null;
	}
}
