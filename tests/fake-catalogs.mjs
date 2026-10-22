// A fake of Open Library's and Wikidata's APIs, for the tests (not a test suite itself). Every book in it is
// invented; the shapes are those the real APIs answer (checked against them on 2026-10-22).

/**
 * Answers Open Library's /works, /books, /authors and /isbn pages and Wikidata's wbgetentities from `state`
 * (openCatalogState()); `sent` lists the addresses asked.
 * @param {ReturnType<typeof openCatalogState>} state
 */
export function fakeCatalogs(state = openCatalogState()) {
	const sent = [];
	const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
	const fetch = async url => {
		sent.push(url);
		const u = new URL(url);
		if (u.hostname === 'openlibrary.org') {
			const m = /^\/(works|books|authors|isbn)\/([^/]+)\.json$/.exec(u.pathname);
			const page = m && (m[1] === 'isbn' ? state.openLibrary.books[state.openLibrary.isbn[m[2]]] : state.openLibrary[m[1]][m[2]]);
			return page ? json(200, page) : json(404, { error: 'notfound' });
		}
		if (u.hostname === 'www.wikidata.org' && u.pathname === '/w/api.php') {
			const entities = Object.fromEntries(u.searchParams.get('ids').split('|').map(id => {
				const item = state.wikidata[id];
				if (!item) return [id, { id, missing: '' }];
				return [id, u.searchParams.get('props').includes('claims') ? item : { id, labels: item.labels }];
			}));
			return json(200, { entities, success: 1 });
		}
		throw new Error(`the page fetched ${url}`);
	};
	return { fetch, sent };
}

const item = id => ({ type: 'wikibase-entityid', value: { 'entity-type': 'item', id } });
const claim = (datavalue, qualifiers) => ({ mainsnak: { snaktype: 'value', datavalue }, rank: 'normal', ...(qualifiers ? { qualifiers } : {}) });

/** An invented book in both: "The Lantern Keeper" by Ann Vale, book 2 of Gull Isle. */
export const openCatalogState = () => ({
	openLibrary: {
		works: {
			OL900W: { key: '/works/OL900W', title: 'The Lantern Keeper', authors: [{ author: { key: '/authors/OL70A' }, type: { key: '/type/author_role' } }], subjects: ['Fiction'] },
		},
		books: {
			OL901M: { key: '/books/OL901M', title: 'The lantern keeper', works: [{ key: '/works/OL900W' }], publishers: ['Gullwing Audio'], publish_date: 'March 4, 2021',
				isbn_13: ['9780000000019'], series: ['Gull Isle (2)'], identifiers: { goodreads: ['5151'], amazon: ['B0LANTERN2'] },
				contributors: [{ role: 'Narrator', name: 'Hollis Marr' }] },
		},
		authors: { OL70A: { key: '/authors/OL70A', name: 'Ann Vale' } },
		isbn: { '9780000000019': 'OL901M' },
	},
	wikidata: {
		Q9001: { id: 'Q9001', labels: { en: { language: 'en', value: 'The Lantern Keeper' } }, claims: {
			P1476: [claim({ type: 'monolingualtext', value: { text: 'The Lantern Keeper', language: 'en' } })],
			P50: [claim(item('Q9002'))],
			P179: [claim(item('Q9003'), { P1545: [{ snaktype: 'value', datavalue: { type: 'string', value: '2' } }] })],
			P136: [claim(item('Q9004'))],
			P648: [claim({ type: 'string', value: 'OL900W' })],
			P8383: [claim({ type: 'string', value: '7171' })],
		} },
		Q9002: { id: 'Q9002', labels: { en: { language: 'en', value: 'Ann Vale' } }, claims: {} },
		Q9003: { id: 'Q9003', labels: { en: { language: 'en', value: 'Gull Isle' } }, claims: {} },
		Q9004: { id: 'Q9004', labels: { en: { language: 'en', value: 'fantasy' } }, claims: {} },
	},
});
