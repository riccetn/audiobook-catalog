// A fake of Hardcover's GraphQL API, for the page tests (not a test suite itself).
import assert from 'node:assert/strict';

/**
 * A stand-in for Hardcover's GraphQL API, answering the queries the page sends from `state`: {shelf
 * (user_books rows), books, editions (rows by id), goodreads ({Goodreads id: Hardcover book id}), series, authors,
 * publishers (lists of rows with a slug)}.
 * Mutations change `state.shelf`. Built from Hardcover's published schema; the real API is not reached.
 */
export function fakeHardcover(state) {
	const sent = [];
	const fetch = async (url, init) => {
		const { query, variables } = JSON.parse(init.body);
		sent.push({ url, auth: init.headers.authorization, query, variables });
		const answer = data => ({ ok: true, status: 200, json: async () => ({ data }) });
		if (init.headers.authorization !== 'Bearer tok-123') return { ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) };
		// as Hardcover answers it
		if (/_n?i?like|_similar|_regex/.test(query)) return { ok: false, status: 403, json: async () => ({ error: 'ilike and related operations are not permitted on this server.' }) };
		const pick = ids => ids.map(id => state.editions[id]).filter(Boolean);
		if (query.startsWith('query { me')) return answer({ me: [{ id: 42 }] });
		if (query.startsWith('query Shelf')) {
			assert.equal(variables.user, 42);
			return answer({ user_books: state.shelf.slice(variables.offset, variables.offset + 100) });
		}
		const part = /^query ShelfBy(Series|Author|Books)/.exec(query);
		if (part) {
			assert.equal(variables.user, 42);
			const has = {
				Series: ub => variables.ids.includes(state.books[ub.book_id]?.featured_book_series?.series?.id),
				Author: ub => (state.books[ub.book_id]?.contributions || []).some(c => variables.ids.includes(c.author.id)),
				Books: ub => variables.books.includes(ub.book_id),
			}[part[1]];
			return answer({ user_books: state.shelf.filter(has).slice(variables.offset, variables.offset + 100) });
		}
		if (query.startsWith('query SeriesByName')) {
			const all = Object.values(state.books).map(b => b.featured_book_series?.series).filter(Boolean);
			return answer({ series: [...new Map(all.filter(s => variables.names.includes(s.name)).map(s => [s.id, s])).values()] });
		}
		if (query.startsWith('query AuthorsByName')) {
			const all = Object.values(state.books).flatMap(b => b.contributions.map(c => c.author));
			return answer({ authors: [...new Map(all.filter(a => variables.names.includes(a.name)).map(a => [a.id, a])).values()] });
		}
		if (query.startsWith('query BookParts')) {
			return answer({ books: variables.ids.map(id => state.books[id]).filter(Boolean).map(b => ({ id: b.id,
				book_series: b.featured_book_series ? [{ series: b.featured_book_series.series }] : [], contributions: b.contributions })) });
		}
		if (query.startsWith('query Books')) return answer({ books: variables.ids.map(id => state.books[id]).filter(Boolean) });
		if (query.startsWith('query Editions')) return answer({ editions: pick(variables.ids) });
		if (query.startsWith('query BookBySlug')) return answer({ books: Object.values(state.books).filter(b => b.slug === variables.slug).slice(0, 1) });
		const bySlug = /^query (Series|Author|Publisher)BySlug/.exec(query);
		if (bySlug) {
			const table = { Series: 'series', Author: 'authors', Publisher: 'publishers' }[bySlug[1]];
			return answer({ [table]: (state[table] || []).filter(row => row.slug === variables.slug).slice(0, 1) });
		}
		if (query.startsWith('query EditionBook')) {
			const e = state.editions[variables.id];
			return answer({ editions: e ? [{ book_id: e.book_id, book: { title: state.books[e.book_id].title } }] : [] });
		}
		if (query.startsWith('query Find')) {
			const all = Object.values(state.editions);
			return answer({
				...(variables.hc ? { byId: pick(variables.hc) } : {}),
				...(variables.asin ? { byAsin: all.filter(e => variables.asin.includes(e.asin)) } : {}),
				...(variables.isbn ? { byIsbn: all.filter(e => variables.isbn.includes(e.isbn_13)) } : {}),
				...(variables.gr ? { byGoodreads: variables.gr.filter(g => state.goodreads[g]).map(g => ({ book_id: state.goodreads[g], external_id: g })) } : {}),
			});
		}
		if (query.startsWith('mutation AddBook')) {
			const { book_id, edition_id, status_id } = variables.object;
			if (state.shelf.some(ub => ub.book_id === book_id)) return answer({ insert_user_book: { id: null, error: 'already on a shelf' } });
			const ub = { id: 100 + state.shelf.length, book_id, edition_id: edition_id || null, status_id, user_book_reads: [] };
			state.shelf.push(ub);
			return answer({ insert_user_book: { id: ub.id, error: null } });
		}
		if (query.startsWith('mutation AddRead')) {
			state.shelf.find(ub => ub.id === variables.id).user_book_reads.push({ ...variables.read });
			return answer({ insert_user_book_read: { id: 1, error: null } });
		}
		throw new Error('unexpected query ' + query);
	};
	return { fetch, sent };
}

/** A small invented Hardcover library: four books (and one merged into another), two of them on the Read shelf. */
export const hardcoverState = () => ({
	books: {
		77: { id: 77, slug: 'tidewater', title: 'Tidewater', contributions: [{ contribution: null, author: { id: 4103, name: 'Ann Vale' } }], featured_book_series: { position: 1, series: { id: 3102, name: 'Gull Isle' } } },
		78: { id: 78, slug: 'the-paper-fen', title: 'The Paper Fen', contributions: [{ contribution: null, author: { id: 4103, name: 'Ann Vale' } }] },
		79: { id: 79, slug: 'tidewater-2', canonical_id: 77, title: 'Tidewater', contributions: [] },   // merged into 77
		80: { id: 80, title: 'Lantern Hours', contributions: [{ contribution: null, author: { id: 4104, name: 'R. T. Hale' } }] },
		81: { id: 81, title: 'Brine Songs', contributions: [{ contribution: null, author: { id: 4103, name: 'Ann Vale' } }] },
	},
	editions: {
		501: { id: 501, book_id: 77, asin: 'B0TIDEWAT1', reading_format_id: 2, audio_seconds: 36000, contributions: [{ contribution: 'Narrator', author: { name: 'Hollis Marr' } }] },
		601: { id: 601, book_id: 78, reading_format_id: 1, contributions: [] },
		801: { id: 801, book_id: 80, asin: 'B0LANTERN1', reading_format_id: 2, contributions: [] },
		811: { id: 811, book_id: 81, isbn_13: '9780000000002', reading_format_id: 1, contributions: [] },
	},
	goodreads: { 4242: 81 },
	series: [{ id: 3101, slug: 'the-lantern-coast', name: 'The Lantern Coast' }],
	authors: [{ id: 4101, slug: 'wendell-ashcombe', name: 'Wendell Ashcombe' }, { id: 4102, slug: 'w-ashcombe', canonical_id: 4101, name: 'W. Ashcombe' }],
	publishers: [{ id: 5101, slug: 'kestrel-row-audio', name: 'Kestrel Row Audio' }],
	shelf: [
		{ id: 1, book_id: 77, edition_id: 501, status_id: 3, user_book_reads: [{ finished_at: '2024-03-15' }] },
		{ id: 2, book_id: 78, edition_id: 601, status_id: 3, user_book_reads: [] },
	],
});
