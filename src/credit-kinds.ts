// What differs between the authors, narrators and publishers: their lists (credits.ts) and their pages (credit.ts).
import {authorPageHref, narratorPageHref, publisherPageHref} from './store.js';
import type {ContributorKind} from './modules/contributor.js';

/** What differs between the three kinds, on their lists (credits.ts) and their pages. */
export interface CreditKind {
	/** where the catalog keeps their info: CATALOG.narrators */
	infoKey: ContributorKind;
	/** the address's key: #n=id */
	hashKey: string;
	/** 'narrator' (also what an external catalog calls them) */
	one: 'author' | 'narrator' | 'publisher';
	/** 'narrators' */
	many: string;
	/** the list's title: 'Narrators' */
	title: string;
	/** the list's page: 'narrators.html' */
	list: string;
	/** someone's page: 'narrator.html' */
	page: string;
	/** the subtitle of someone with no books */
	none: string;
	/** their own site's form label and example */
	site: [string, string];
	/** the address of someone's page */
	href: (name: string) => string;
}

export const CREDIT_KINDS: Record<'author' | 'narrator' | 'publisher', CreditKind> = {
	author: {
		infoKey: 'authors',
		hashKey: 'a',
		one: 'author',
		many: 'authors',
		title: 'Authors',
		list: 'authors.html',
		page: 'author.html',
		none: 'No books by this author in the catalog.',
		site: ['Personal website', 'https://'],
		href: authorPageHref,
	},
	narrator: {
		infoKey: 'narrators',
		hashKey: 'n',
		one: 'narrator',
		many: 'narrators',
		title: 'Narrators',
		list: 'narrators.html',
		page: 'narrator.html',
		none: 'No books narrated by them in the catalog.',
		site: ['Personal website', 'https://'],
		href: narratorPageHref,
	},
	publisher: {
		infoKey: 'publishers',
		hashKey: 'p',
		one: 'publisher',
		many: 'publishers',
		title: 'Publishers',
		list: 'publishers.html',
		page: 'publisher.html',
		none: 'No books from this publisher in the catalog.',
		site: ['Website', 'https://'],
		href: publisherPageHref,
	},
};
