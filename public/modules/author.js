// An author, by their name as books write it, with what you keep about them: a short bio and links to
// their own site and their pages on Audible, Goodreads and Hardcover. Their series and titles are not
// kept here: they come from the books (Catalog.authorWorks).
import {Text} from './text.js';
/** @import {Unchecked} from './text.js' */

/** @typedef {'bio' | 'url' | 'audible' | 'goodreads' | 'hardcover'} AuthorKey */

/** An author and what you keep about them. */
export class Author {
	/** @type {AuthorKey[]} the keys of an author's stored entry, in order */
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
	 * @param {Partial<Record<AuthorKey, string>>} [info]
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
		/** @type {Record<string, unknown>} what the stored entry holds that is not an author's info (the Check reports it) */
		this.extra = {};
	}

	/**
	 * An author from their entry in the stored author info. A value that is not text, and a key an
	 * author's entry has not, is kept aside as it is and written back by toJSON(), so the Check still
	 * reports it. Throws when the entry is not an object.
	 * @param {string} name
	 * @param {Unchecked} json
	 * @returns {Author}
	 */
	static fromJSON(name, json){
		if(!Text.isObject(json)) throw new Error(`the author info of ${Text.repr(name)} is not an object`);
		const author = new Author(name);
		for(const [k, v] of Object.entries(json)){
			if(/** @type {string[]} */ (Author.KEYS).includes(k) && typeof v === 'string') author[/** @type {AuthorKey} */ (k)] = v;
			else author.extra[k] = v;
		}
		return author;
	}

	/** @returns {Record<string, unknown>} the entry as the stored author info keeps it */
	toJSON(){
		/** @type {Record<string, unknown>} */
		const out = {};
		for(const k of Author.KEYS){
			if(this[k] !== undefined) out[k] = this[k];
			else if(k in this.extra) out[k] = this.extra[k];
		}
		for(const [k, v] of Object.entries(this.extra)) if(!(k in out)) out[k] = v;
		return out;
	}

	/**
	 * An author's entry with tidy text: a bio keeps its paragraphs (lines) but loses stray spacing, links
	 * are trimmed, and empty fields are left out. Returns null when nothing is left.
	 * @param {string} name
	 * @param {Unchecked} entry the entry as typed or stored
	 * @returns {Author | null}
	 */
	static tidy(name, entry){
		if(!Text.isObject(entry)) return null;
		const author = new Author(name);
		let any = false;
		for(const k of Author.KEYS){
			if(typeof entry[k] !== 'string') continue;
			const v = k === 'bio'
				? entry[k].split(/\r\n|\r|\n/).map(Text.tidy).join('\n').replace(/\n{3,}/g, '\n\n').trim()
				: entry[k].trim();
			if(v){ author[k] = v; any = true; }
		}
		return any ? author : null;
	}
}
