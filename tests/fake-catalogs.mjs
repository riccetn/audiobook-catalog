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

/**
 * A fake of what the catalog proxy answers for Audible's catalog API and AudiobookDB's API, by route
 * (`audible/audible.com/catalog/products/B0…`, `audiobookdb/releases/…`), in the shapes the real APIs answer
 * (checked against them on 2026-10-22); `sent` lists the routes asked. The book is invented: "The Lantern
 * Keeper", book 2 of Gull Isle (and of no number in the Tidewater Cycle, an umbrella series).
 */
export function fakeProxyCatalogs() {
	const sent = [];
	const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
	const ladder = (...names) => ({ root: 'Genres', ladder: names.map((name, i) => ({ id: String(1000 + i), name })) });
	const audible = {
		'audible.com/B0LANTERN2': { asin: 'B0LANTERN2', title: 'The Lantern Keeper', subtitle: 'Gull Isle, Book 2',
			authors: [{ asin: 'B0AUTHOR01', name: 'Ann Vale' }], narrators: [{ name: 'Hollis Marr' }, { name: 'Dana Fenwick' }],
			series: [{ asin: 'B0SERIES01', sequence: '', title: 'The Tidewater Cycle' }, { asin: 'B0SERIES02', sequence: '2', title: 'Gull Isle' }],
			publisher_name: 'Gullwing Audio', release_date: '2021-03-04', runtime_length_min: 612, isbn: '9780000000019', format_type: 'unabridged',
			publisher_summary: '<p><b>The second Gull Isle book.</b></p>',
			category_ladders: [ladder('Science Fiction & Fantasy', 'Fantasy', 'Epic'), ladder('Science Fiction &amp; Fantasy', 'Fantasy', 'Coming of Age'), ladder('Literature & Fiction', 'Literary Fiction')] },
		'audible.co.uk/B0LANTERNU': { asin: 'B0LANTERNU', title: 'The Lantern Keeper', authors: [{ name: 'Ann Vale' }], narrators: [{ name: 'Hollis Marr' }],
			series: [{ sequence: '2', title: 'Gull Isle' }], publisher_name: 'Gullwing Audio UK', release_date: '2021-05-01', runtime_length_min: 611 },
	};
	const people = (role, ...names) => names.map((name, i) => ({ role: { name: role }, person: { id: `Prsn${role.slice(0, 4)}${i}00000`.slice(0, 12), name } }));
	const releaseUs = { id: 'RlsLntrnUS01', title: 'The Lantern Keeper', releaseDate: '2021-03-04T00:00:00Z', duration: '10:12:20', disambiguation: 'unabridged',
		publisher: { id: 'PblshrGullw1', name: 'Gullwing Audio' }, people: people('Narrator', 'Hollis Marr', 'Dana Fenwick') };
	const releaseUk = { id: 'RlsLntrnUK01', title: 'The Lantern Keeper', releaseDate: '2021-05-01T00:00:00Z', duration: '10:11:00',
		publisher: { id: 'PblshrGullw2', name: 'Gullwing Audio UK' }, people: people('Narrator', 'Hollis Marr') };
	const book = { id: 'LnTrnKpr2xYz', title: 'The Lantern Keeper', subtitle: 'Gull Isle, Book 2', copyright: 2021, type: 'fiction',
		genres: [{ id: 'GnrFantasy01', title: 'Fantasy' }], tags: [{ id: 'TgCozy000001', title: 'Cozy' }], people: people('Author', 'Ann Vale'),
		series: [{ ordinal: '0', series: { id: 'SrsTidewater', title: 'The Tidewater Cycle', bookCount: 4 } }, { ordinal: '2', series: { id: 'SrsGullIsle1', title: 'Gull Isle', bookCount: 3 } }],
		releases: [releaseUs, releaseUk] };
	const releases = {
		RlsLntrnUS01: { ...releaseUs, isbn: '9780000000019', runtimeLengthSec: 36740, book: { id: book.id, title: book.title },
			external: [{ id: 'ExtLntrnUS01', itemId: 'B0LANTERN2', category: { title: 'Audible', url: 'https://www.audible.com' } }] },
	};
	const notFound = detail => json(404, { errors: [{ status: '404', title: 'Not Found', detail }] });
	const route = async path => {
		sent.push(path);
		const u = new URL(path, 'https://proxy.invalid/');
		let m = /^\/audible\/([^/]+)\/catalog\/products\/([^/]+)$/.exec(u.pathname);
		if (m) {
			assert(u.searchParams.get('response_groups').includes('series'), 'Audible is asked for the series');
			return json(200, { product: audible[`${m[1]}/${m[2]}`] || { asin: m[2], asset_details: [] }, response_groups: ['always-returned'] });
		}
		m = /^\/audiobookdb\/(audiobooks\/external\/audible|books|releases)\/([^/]+)$/.exec(u.pathname);
		if (m && m[1] === 'audiobooks/external/audible') return m[2] === 'B0LANTERN2' ? json(200, { ...book, matchedReleaseId: 'RlsLntrnUS01' }) : notFound(`audiobook with id audible/${m[2]} not found`);
		if (m && m[1] === 'books') return m[2] === book.id ? json(200, book) : notFound(`book with id ${m[2]} not found`);
		if (m && m[1] === 'releases') return releases[m[2]] ? json(200, releases[m[2]]) : notFound(`release with id ${m[2]} not found`);
		throw new Error(`the proxy was asked for ${path}`);
	};
	return { route, sent };
}

function assert(ok, message) { if (!ok) throw new Error(message); }
