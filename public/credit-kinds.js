// What differs between the authors, narrators and publishers: their lists (credits.js) and their pages (credit.js).
import { CATALOG, authorPageHref, narratorPageHref, publisherPageHref } from './store.js';
/** @import {Book} from './modules/book.js' */
/** @import {ContributorKind} from './modules/contributor.js' */

/**
 * What differs between the three kinds, on their lists (credits.js) and their pages.
 * @typedef {object} CreditKind
 * @property {ContributorKind} infoKey where the catalog keeps their info: CATALOG.narrators
 * @property {string} hashKey the address's key: #n=id
 * @property {'author' | 'narrator' | 'publisher'} one 'narrator' (also what an external catalog calls them)
 * @property {string} many 'narrators'
 * @property {string} title the list's title: 'Narrators'
 * @property {string} list the list's page: 'narrators.html'
 * @property {string} page someone's page: 'narrator.html'
 * @property {string} none the subtitle of someone with no books
 * @property {[string, string]} site their own site's form label and example
 * @property {(name: string) => string} href the address of someone's page
 * @property {(name: string) => {series: {name: string, books: Book[]}[], titles: Book[]}} works
 */

/** @type {Record<'author' | 'narrator' | 'publisher', CreditKind>} */
export const CREDIT_KINDS = {
	author: {infoKey: 'authors', hashKey: 'a', one: 'author', many: 'authors', title: 'Authors', list: 'authors.html', page: 'author.html',
		none: 'No books by this author in the catalog.', site: ['Personal website', 'https://'],
		href: authorPageHref, works: name=> CATALOG.authorWorks(name)},
	narrator: {infoKey: 'narrators', hashKey: 'n', one: 'narrator', many: 'narrators', title: 'Narrators', list: 'narrators.html', page: 'narrator.html',
		none: 'No books narrated by them in the catalog.', site: ['Personal website', 'https://'],
		href: narratorPageHref, works: name=> CATALOG.narratorWorks(name)},
	publisher: {infoKey: 'publishers', hashKey: 'p', one: 'publisher', many: 'publishers', title: 'Publishers', list: 'publishers.html', page: 'publisher.html',
		none: 'No books from this publisher in the catalog.', site: ['Website', 'https://'],
		href: publisherPageHref, works: name=> CATALOG.publisherWorks(name)},
};
