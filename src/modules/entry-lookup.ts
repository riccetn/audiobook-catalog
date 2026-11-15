// A series, author, narrator or publisher looked up in the external catalogs a page may read, to fill in what the
// catalog keeps about them: their ids there, a person's bio and site, a series' count and status. Each catalog is
// a BookSource that says which kinds it knows (ENTRIES, CatalogConnectors.SOURCES); this asks them in turn: by
// the id the entry has there, else by the entry's books there and its name, and then by the ids the catalogs
// gave for each other. What each needs (a token, the catalog proxy) the sources say, so nothing here names a
// catalog. Nothing here changes the catalog: what was found is offered (offers), and only what is picked is put
// in a copy (apply). The requests are passed in, so the tests run it offline.
import {Text, PhraseError} from './text.js';
import type {Phrase} from './text.js';
import type {Book} from './book.js';
import type {BookSource, Get, EntryKind, EntryInfo, EntryQuery, EntryAnswer} from './book-source.js';
import {CatalogConnectors} from './catalog-connectors.js';
import type {CatalogClient} from './catalog-client.js';

/** What a lookup found: each catalog's answers, in the order the catalogs are asked, and what could not be asked and why. */
export type EntriesFound = {answers: EntryAnswer[]; notes: Phrase[]};
/**
 * A value an answer gives that the entry lacks. `key` names what it fills ('bio', 'url', 'total', 'status',
 * 'id:<catalog>' or 'link:<address>'): of the offers with one key only one can be taken. `answer` is the place of
 * its answer among the lookup's, and `ticked` whether it is picked at first: the first sure one of its key.
 */
export type EntryOffer = {
	key: string;
	field: 'bio' | 'url' | 'total' | 'status' | 'id' | 'link';
	/** the catalog an id is in */
	catalog?: string;
	value: string | number;
	answer: number;
	ticked: boolean;
};

/** Looks series and people up in the external catalogs a page may read. */
export class EntryLookup {
	sources: BookSource[];

	/**
	 * @param get asks the catalogs that answer web pages
	 * @param clients ask the catalogs whose key is saved
	 * @param proxy asks through the catalog proxy, given a route, or null when none is saved
	 * @param sources the catalogs asked, in order
	 */
	constructor(
		get: Get,
		clients: CatalogClient[],
		proxy: Get | null = null,
		sources: (typeof BookSource)[] = CatalogConnectors.SOURCES,
	) {
		const context = {get, clients, proxy};
		this.sources = sources.map(Source => new Source(context));
	}

	/**
	 * What the catalogs have for the series or person called `name`, who has `info` (its ids name it in the
	 * catalogs that have one) and `books` in the catalog. A catalog is asked for the id the entry has there;
	 * one without is asked for whom the books and the name point to; and an id a sure answer gives for another
	 * catalog is asked of that one in turn. A catalog that can't be asked is noted, not thrown. Throws with a
	 * short reason only when no catalog can be asked about this kind.
	 */
	async find(kind: EntryKind, name: string, info: EntryInfo, books: Book[] = []): Promise<EntriesFound> {
		const query: EntryQuery = {kind, name: Text.tidy(name), books};
		const sources = this.sources.filter(s => s.kind.ENTRIES.includes(kind));
		const usable = sources.filter(s => s.available);
		const unasked = sources.filter(s => !s.available);
		const notes: Phrase[] = unasked.map(s =>
			Text.phrase('to ask {catalog} too, {needs} on the Import & export page', {
				catalog: s.label,
				needs: s.needsText || '',
			}),
		);
		if (!usable.length)
			throw new PhraseError(
				sources.length ? 'no catalog can be asked yet: {notes}' : 'no catalog can be asked about this',
				{notes: Text.joinPhrases(notes)},
			);
		const answers: EntryAnswer[] = [];
		const settled: Set<BookSource> = new Set(); // those that gave a sure answer
		const failed: Set<BookSource> = new Set();
		const tried: Map<BookSource, string> = new Map(); // the id each was last asked for
		const ask = async <T>(source: BookSource, what: () => Promise<T>): Promise<T | null> => {
			try {
				return await what();
			} catch (err) {
				failed.add(source);
				notes.push(
					Text.phrase("{catalog} couldn't be asked: {error}", {
						catalog: source.label,
						error: Text.errorPhrase(err),
					}),
				);
				return null;
			}
		};
		/** the entry's ids, and those the sure answers gave for catalogs it has none in */
		const known = (): Record<string, string> => {
			const ids: Record<string, string> = {};
			for (const a of answers)
				if (a.by !== 'name') for (const [k, v] of Object.entries(a.info.external)) ids[k] ??= v;
			return {...ids, ...info.external};
		};
		const byId = async () => {
			for (let again = true; again;) {
				again = false;
				for (const source of usable) {
					const id = known()[source.kind.CATALOG];
					if (!id || settled.has(source) || failed.has(source) || tried.get(source) === id) continue;
					tried.set(source, id);
					const found = await ask(source, () => source.entry(kind, id));
					if (!found) continue;
					settled.add(source);
					// the namesakes it gave are no longer in question
					for (let i = answers.length - 1; i >= 0; i--)
						if (answers[i].source === source.label && answers[i].by === 'name') answers.splice(i, 1);
					answers.push({...found, by: 'id'});
					again = true;
				}
			}
		};
		await byId();
		for (const source of usable) {
			if (settled.has(source) || failed.has(source)) continue;
			const found = (await ask(source, () => source.findEntries(query))) || [];
			answers.push(...found);
			if (found.some(a => a.by !== 'name')) settled.add(source);
		}
		await byId();
		const order = (a: EntryAnswer) => sources.findIndex(s => s.label === a.source);
		answers.sort((x, y) => order(x) - order(y));
		return {answers, notes};
	}

	/**
	 * What `answers` give that the entry lacks, in their order: a bio, a site, a series' count and status, an id
	 * in a catalog it has none in, and links it doesn't have. Nothing the entry has is ever offered a change. A
	 * value is offered once; of the values for one thing the first from a sure answer is ticked, and never a
	 * link, or anything from an answer found by name alone, which may be someone else.
	 */
	static offers(current: EntryInfo, answers: EntryAnswer[]): EntryOffer[] {
		const out: EntryOffer[] = [];
		const ticked: Set<string> = new Set();
		answers.forEach((a, answer) => {
			const offer = (field: EntryOffer['field'], key: string, value: string | number, catalog?: string) => {
				if (out.some(o => o.key === key && o.value === value)) return;
				const tick = a.by !== 'name' && field !== 'link' && !ticked.has(key);
				if (tick) ticked.add(key);
				out.push({key, field, ...(catalog ? {catalog} : {}), value, answer, ticked: tick});
			};
			const {bio, url, total, status, external, links} = a.info;
			if (bio && !current.bio) offer('bio', 'bio', bio);
			if (url && !current.url && !current.links.includes(url)) offer('url', 'url', url);
			if (total && current.total === undefined) offer('total', 'total', total);
			if (status && !current.status) offer('status', 'status', status);
			for (const [catalog, id] of Object.entries(external))
				if (!current.external[catalog]) offer('id', `id:${catalog}`, id, catalog);
			for (const link of links)
				if (link !== current.url && link !== url && !current.links.includes(link))
					offer('link', `link:${link}`, link);
		});
		return out;
	}

	/**
	 * A copy of `current` with the offers picked put in its gaps; of several picked for one thing the first is
	 * taken, and a value the entry has is left as it is. Returns the copy and the offers that were put in.
	 */
	static apply(current: EntryInfo, picked: EntryOffer[]): {info: EntryInfo; added: EntryOffer[]} {
		const info: EntryInfo = {...current, external: {...current.external}, links: [...current.links]};
		const added: EntryOffer[] = [];
		for (const o of picked) {
			if (added.some(x => x.key === o.key)) continue;
			if (o.field === 'bio' && !info.bio) info.bio = String(o.value);
			else if (o.field === 'url' && !info.url) info.url = String(o.value);
			else if (o.field === 'total' && info.total === undefined && typeof o.value === 'number')
				info.total = o.value;
			else if (o.field === 'status' && !info.status && (o.value === 'ongoing' || o.value === 'complete'))
				info.status = o.value;
			else if (o.field === 'id' && o.catalog && !info.external[o.catalog])
				info.external[o.catalog] = String(o.value);
			else if (o.field === 'link' && !info.links.includes(String(o.value)) && info.url !== o.value)
				info.links.push(String(o.value));
			else continue;
			added.push(o);
		}
		return {info, added};
	}
}
