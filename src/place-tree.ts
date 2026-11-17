// The tree of places that the places list (places.ts) and a place's page (place.ts) draw: a place, and below it the
// places within it, each with how many books are set there. A place part of several shows under each, but the
// places within it only once, under the first; elsewhere it says where they are. Read from the places' records
// and the keys of the books' `placeIds` index (never the books themselves), so a book is counted once in a place
// however many of the places within it it is set in.
import {placePageHref} from './store.js';
import {spell, spellParts, plural, buildElement} from './dom.js';
import type {CatalogReader} from './modules/catalog-database.js';
import type {PlaceRecord} from './modules/catalog-records.js';

/**
 * A place in the tree: its name, the places it is part of (by id), how many books are set there and their ids, its
 * note.
 */
export type PlaceEntry = {
	id: string;
	name: string;
	parentIds: string[];
	books: number;
	bookIds: string[];
	note: string;
};

/**
 * Every place, by name, from the places' records and the books' `placeIds` index (the ids of the books set in each,
 * so a book set in two places within a third counts once there).
 */
export async function readPlaces(r: CatalogReader): Promise<PlaceEntry[]> {
	const records: PlaceRecord[] = await r.all('places', 'byName');
	const entries = await Promise.all(
		records.map(async s => ({
			id: s.id,
			name: s.name,
			parentIds: s.parentIds || [],
			books: s.bookCount || 0,
			bookIds: s.bookCount ? ((await r.allKeys('books', 'placeIds', s.id)) as string[]) : [],
			note: s.note || '',
		})),
	);
	return entries.sort((x, y) => x.name.localeCompare(y.name));
}

/** The places of a list, with the places within each (by id), from the places they are part of. */
export class PlaceTree {
	byId: Map<string, PlaceEntry>;
	children: Map<string, PlaceEntry[]>;

	constructor(list: PlaceEntry[]) {
		this.byId = new Map(list.map(x => [x.id, x]));
		this.children = new Map();
		for (const x of list)
			for (const p of x.parentIds) {
				const kids = this.children.get(p);
				if (kids) kids.push(x);
				else this.children.set(p, [x]);
			}
	}

	/** The places part of none the list has: worlds, or places whose world isn't kept. */
	roots(): PlaceEntry[] {
		return [...this.byId.values()].filter(x => !x.parentIds.some(p => this.byId.has(p)));
	}

	/**
	 * How many books are set in the places within `id`, however deep, but not in `id` itself: each book once, however
	 * many of those places it is set in.
	 */
	booksWithin(id: string): number {
		const seen = new Set([id]);
		const own = new Set(this.byId.get(id)?.bookIds || []);
		const books: Set<string> = new Set();
		const walk = (at: string) => {
			for (const c of this.children.get(at) || [])
				if (!seen.has(c.id)) {
					seen.add(c.id);
					for (const b of c.bookIds) if (!own.has(b)) books.add(b);
					walk(c.id);
				}
		};
		walk(id);
		return books.size;
	}

	/** How many books are set in a place, and in the places within it: "3 books, 5 more within". */
	countText(x: PlaceEntry): string {
		const within = this.booksWithin(x.id);
		if (!x.books && !within) return spell('no books yet');
		if (!within) return plural(x.books, 'book');
		if (!x.books) return spell('{books} within', {books: plural(within, 'book')});
		return spell('{books}, {within} more within', {books: plural(x.books, 'book'), within});
	}

	/**
	 * A place's line: its name (a link to its page) and `extra` after it, its counts at the end of the line, and its
	 * note below.
	 */
	row(x: PlaceEntry, extra: (HTMLElement | string)[] = []): HTMLElement {
		return buildElement(
			'div',
			{class: 'place-row'},
			buildElement(
				'div',
				{class: 'srow-head'},
				buildElement(
					'span',
					{class: 'place-name'},
					buildElement('a', {class: 'srow-title', href: placePageHref(x.id)}, x.name),
					extra,
				),
				buildElement('span', {class: 'srow-owned'}, this.countText(x)),
			),
			x.note && buildElement('p', {class: 'srow-note'}, x.note),
		);
	}

	/**
	 * `roots` as a tree: each, and below it the places within it, in turn. A place drawn already (part of several)
	 * shows its line again, but not the places within it: it says where they are.
	 */
	draw(roots: PlaceEntry[], top: boolean = true): HTMLUListElement {
		const drawn: Map<string, PlaceEntry | null> = new Map(); // a place drawn, and the place it was drawn under
		const node = (x: PlaceEntry, under: PlaceEntry | null, path: Set<string>): HTMLLIElement => {
			const kids = (this.children.get(x.id) || []).filter(c => !path.has(c.id));
			const first = drawn.get(x.id);
			if (first !== undefined && kids.length)
				return buildElement(
					'li',
					{},
					this.row(x, [
						' ',
						buildElement(
							'span',
							{class: 'within'},
							first
								? spellParts('(the places within it are under {place})', {
										place: buildElement('a', {href: placePageHref(first.id)}, first.name),
									})
								: spell('(the places within it are above)'),
						),
					]),
				);
			if (first === undefined) drawn.set(x.id, under);
			const down = new Set([...path, x.id]);
			return buildElement(
				'li',
				{},
				this.row(x),
				first === undefined &&
					kids.length > 0 &&
					buildElement(
						'ul',
						{class: 'place-tree'},
						kids.map(c => node(c, x, down)),
					),
			);
		};
		return buildElement(
			'ul',
			{class: top ? 'place-tree top' : 'place-tree'},
			roots.map(x => node(x, null, new Set())),
		);
	}
}
