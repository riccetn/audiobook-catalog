// The places page (places.html): every place in the catalog (where a book's story takes place, its setting), as a
// tree: the worlds and places that are part of none at the top, and within each the places that are part of it
// (place-tree.ts). A search lists the places whose name matches, each with what it is within. Each links to its own
// page (place.html: place.ts); + Add a place opens a new place's form there (place.html#new). The list reads only
// the places' records (each keeps how many books are set there).
import {startPage, afterSaving, queryCatalog} from './store.js';
import {byId, fieldById, spell, plural, buildElement, fillElement} from './dom.js';
import {Text} from './modules/text.js';
import {PlaceTree, readPlaces} from './place-tree.js';
import type {PlaceEntry} from './place-tree.js';

let LIST: PlaceEntry[] = []; // the list, by name
let TOTAL_BOOKS = 0; // how many books the catalog has, for the subtitle

export function render() {
	document.title = spell('{page} · Audiobook Catalog', {page: spell('Places')});
	const q = Text.norm(fieldById('q').value);
	const tree = new PlaceTree(LIST);
	byId('subtitle').textContent = spell('{places} across {books}', {
		places: plural(LIST.length, 'place'),
		books: plural(TOTAL_BOOKS, 'audiobook'),
	});
	if (!LIST.length) {
		fillElement(
			byId('placeBody'),
			buildElement(
				'p',
				{class: 'empty'},
				spell("No places yet: add one, or type where a book's story takes place on its Edit page."),
			),
		);
		return;
	}
	if (q) {
		const found = LIST.filter(x => Text.norm(x.name).includes(q));
		fillElement(
			byId('placeBody'),
			found.length
				? found.map(x => {
						const within = x.parentIds
							.map(p => tree.byId.get(p)?.name)
							.filter(Boolean)
							.join(', ');
						return buildElement(
							'div',
							{class: 'srow'},
							tree.row(
								x,
								within
									? [
											' ',
											buildElement(
												'span',
												{class: 'within'},
												spell('in {places}', {places: within}),
											),
										]
									: [],
							),
						);
					})
				: buildElement('p', {class: 'empty'}, spell('No places match your search.')),
		);
		return;
	}
	fillElement(byId('placeBody'), tree.draw(tree.roots()));
}

async function loadList() {
	const {list, total} = await queryCatalog(async r => ({list: await readPlaces(r), total: await r.count('books')}));
	LIST = list;
	TOTAL_BOOKS = total;
}

export const READY = startPage(
	async () => {
		byId('q').addEventListener('input', render);
		await loadList();
		render();
	},
	{
		refresh: () =>
			afterSaving(async () => {
				await loadList();
				render();
			}),
	},
);
