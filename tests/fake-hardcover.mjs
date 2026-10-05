// A fake of Hardcover's GraphQL API, shared by the CLI and page tests (not a test suite itself).
import assert from 'node:assert/strict';

/**
 * A stand-in for Hardcover's GraphQL API, answering the queries catalog.js and the page send from `state`: {shelf
 * (user_books rows), books, editions (rows by id), goodreads ({Goodreads id: Hardcover book id})}.
 * Mutations change `state.shelf`. Built from Hardcover's published schema; the real API is not reached.
 */
export function fakeHardcover(state) {
  const sent = [];
  const fetch = async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    sent.push({ url, auth: init.headers.authorization, query, variables });
    const answer = data => ({ ok: true, status: 200, json: async () => ({ data }) });
    if (init.headers.authorization !== 'Bearer tok-123') return { ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) };
    const pick = ids => ids.map(id => state.editions[id]).filter(Boolean);
    if (query.startsWith('query { me')) return answer({ me: [{ id: 42 }] });
    if (query.startsWith('query Shelf')) {
      assert.equal(variables.user, 42);
      return answer({ user_books: state.shelf.slice(variables.offset, variables.offset + 100) });
    }
    if (query.startsWith('query Books')) return answer({ books: variables.ids.map(id => state.books[id]).filter(Boolean) });
    if (query.startsWith('query Editions')) return answer({ editions: pick(variables.ids) });
    if (query.startsWith('query BookBySlug')) return answer({ books: Object.values(state.books).filter(b => b.slug === variables.slug).slice(0, 1) });
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
    77: { id: 77, slug: 'tidewater', title: 'Tidewater', contributions: [{ contribution: null, author: { name: 'Ann Vale' } }], featured_book_series: { position: 1, series: { name: 'Gull Isle' } } },
    78: { id: 78, slug: 'the-paper-fen', title: 'The Paper Fen', contributions: [{ contribution: null, author: { name: 'Ann Vale' } }] },
    79: { id: 79, slug: 'tidewater-2', canonical_id: 77, title: 'Tidewater', contributions: [] },   // merged into 77
    80: { id: 80, title: 'Lantern Hours', contributions: [{ contribution: null, author: { name: 'R. T. Hale' } }] },
    81: { id: 81, title: 'Brine Songs', contributions: [{ contribution: null, author: { name: 'Ann Vale' } }] },
  },
  editions: {
    501: { id: 501, book_id: 77, asin: 'B0TIDEWAT1', reading_format_id: 2, audio_seconds: 36000, contributions: [{ contribution: 'Narrator', author: { name: 'Hollis Marr' } }] },
    601: { id: 601, book_id: 78, reading_format_id: 1, contributions: [] },
    801: { id: 801, book_id: 80, asin: 'B0LANTERN1', reading_format_id: 2, contributions: [] },
    811: { id: 811, book_id: 81, isbn_13: '9780000000002', reading_format_id: 1, contributions: [] },
  },
  goodreads: { 4242: 81 },
  shelf: [
    { id: 1, book_id: 77, edition_id: 501, status_id: 3, user_book_reads: [{ finished_at: '2024-03-15' }] },
    { id: 2, book_id: 78, edition_id: 601, status_id: 3, user_book_reads: [] },
  ],
});
