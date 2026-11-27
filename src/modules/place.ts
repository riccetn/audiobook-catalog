// A place: where a story takes place. A world (Earth, or one made up for a story: a fantasy or science fiction
// world) or a place within one (a country, a city, a school), by its name as the books write it, with what you
// keep about it: the places it is part of (London is part of England; a made-up world may be part of Earth),
// who created it and who holds its rights (an invented world's author, or an open world's owner), a note, its ids
// in external catalogs and links. The places it is part of make a hierarchy, so a story set in London is also
// set in England and on Earth (Catalog.placeAncestors). A place says nothing about a book's genre, and when a
// story takes place is not kept.
import {Text, PhraseError} from './text.js';
import {ExternalCatalog} from './external-catalog.js';
import type {Unchecked} from './text.js';

/** What a new Place's info is made of; every part is optional. */
export interface PlaceInit {
	/** the names of the places it is part of */
	parents?: string[];
	/** the authors who created it, by their names as the books have them */
	creators?: string[];
	/** who holds its rights, when that is not its creators (a company) */
	owner?: string;
	note?: string;
	external?: Record<string, string>;
	links?: string[];
}

const isTextList: (v: unknown) => v is string[] = (v): v is string[] =>
	Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.trim() !== '');

/** A place, and what you keep about it. */
export class Place {
	/** the keys of a stored entry, in order: the places it is part of, its creators, its rights holder, a note, ids, links */
	static KEYS = ['in', 'by', 'owner', 'note', 'ext', 'links'];

	name: string;
	/** the names of the places it is part of: London's are ["England"] */
	parents: string[];
	/** the authors who created it (an invented world's), by name */
	creators: string[];
	/** who holds its rights (an open world's: the company that publishes its stories) */
	owner: string | undefined;
	/** a few words about it */
	note: string | undefined;
	/** its ids by external catalog */
	external: Record<string, string>;
	/** other pages about it, as addresses */
	links: string[];
	/** what the stored entry holds that is not a place's info (the Check reports it) */
	extra: Record<string, unknown>;

	constructor(name: string, {parents = [], creators = [], owner, note, external = {}, links = []}: PlaceInit = {}) {
		this.name = name;
		this.parents = [...parents];
		this.creators = [...creators];
		this.owner = owner;
		this.note = note;
		this.external = {...external};
		this.links = [...links];
		this.extra = {};
	}

	/**
	 * A place from its entry in the stored info (`{in, by, owner, note, ext, links}`). A value that is not what its
	 * key holds, and a key an entry has not, is kept aside as it is and written back by toJSON(), so the Check still
	 * reports it. Throws when the entry is not an object.
	 */
	static fromJSON(name: string, json: Unchecked): Place {
		if (!Text.isObject(json)) throw new PhraseError('the place {name} is not an object', {name: Text.repr(name)});
		const info = new Place(name);
		for (const [k, v] of Object.entries(json)) {
			if (k === 'in' && isTextList(v)) info.parents = [...v];
			else if (k === 'by' && isTextList(v)) info.creators = [...v];
			else if ((k === 'owner' || k === 'note') && typeof v === 'string') info[k] = v;
			else if (k === 'ext' && ExternalCatalog.isIds(v)) info.external = {...v};
			else if (k === 'links' && isTextList(v)) info.links = [...v];
			else info.extra[k] = v;
		}
		return info;
	}

	/**
	 * The value one of the stored entry's keys has, as toJSON() writes it; undefined when it has none.
	 */
	value(key: string): unknown {
		if (key === 'in') return this.parents.length ? [...this.parents] : undefined;
		if (key === 'by') return this.creators.length ? [...this.creators] : undefined;
		if (key === 'owner') return this.owner;
		if (key === 'note') return this.note;
		if (key === 'ext') return ExternalCatalog.order(this.external) || undefined;
		if (key === 'links') return this.links.length ? [...this.links] : undefined;
		return undefined;
	}

	/** @returns the entry as the stored info keeps it */
	toJSON(): Record<string, unknown> {
		return Text.storedJSON(Place.KEYS, k => this.value(k), this.extra);
	}

	/**
	 * An entry with tidy text: names tidied and each once (a place is never part of itself), a note's spacing,
	 * links as Text.tidyLinks() does, and empty fields left out. Returns null when nothing is left.
	 * @param entry the entry as typed or stored
	 */
	static tidy(name: string, entry: Unchecked): Place | null {
		if (!Text.isObject(entry)) return null;
		const info = new Place(name);
		const names: (v: unknown) => string[] = v =>
			Array.isArray(v)
				? [...new Set(v.filter(x => typeof x === 'string').map(x => Text.tidy(x)))].filter(Boolean)
				: [];
		info.parents = names(entry.in).filter(x => x !== name);
		info.creators = names(entry.by);
		if (typeof entry.owner === 'string') info.owner = Text.tidy(entry.owner) || undefined;
		if (typeof entry.note === 'string') info.note = Text.tidy(entry.note) || undefined;
		info.external = ExternalCatalog.tidyIds(entry.ext);
		info.links = Text.tidyLinkTexts(entry.links);
		return Object.keys(info.toJSON()).length ? info : null;
	}
}
