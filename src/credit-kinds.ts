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
	/** the page's sentences that name the kind, as spell() templates (whole, so they can be put in another language) */
	texts: CreditTexts;
	/** the address of someone's page */
	href: (name: string) => string;
}

/** The sentences of a kind's list and pages that name the kind, as spell() templates. */
export interface CreditTexts {
	/** the form's title: {name} */
	editTitle: string;
	/** the form's Save button */
	save: string;
	/** the form's Remove button */
	remove: string;
	/** a Save without a name */
	noName: string;
	/** a name read as several: {name} */
	several: string;
	/** the first Save of a name another has: {name} */
	joins: string;
	/** the first Remove of one with books: {name}, {books} ("3 books") */
	removeBooks: string;
	/** the first Remove of one without books: {name} */
	removeNone: string;
	/** the link to the list */
	all: string;
	/** the list when the search finds none */
	noMatch: string;
	/** the list of an empty catalog */
	noneYet: string;
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
		texts: {
			editTitle: 'Edit author: {name}',
			save: 'Save author',
			remove: 'Remove author',
			noName: 'Give the author a name.',
			several: '{name} would be read as several authors: a comma, a semicolon, "&" or "and" separates names.',
			joins: 'There is already an author called {name}. Press Save again to join them: every book of either will credit {name}, with what this form has, and what {name} has where this form is empty.',
			removeBooks:
				'This takes {name} off {books}, which stay in the catalog, and removes them. Press Remove author again to do it.',
			removeNone: 'This removes {name}, whom no book credits. Press Remove author again to do it.',
			all: 'All authors',
			noMatch: 'No authors match your search.',
			noneYet: 'No books yet.',
		},
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
		texts: {
			editTitle: 'Edit narrator: {name}',
			save: 'Save narrator',
			remove: 'Remove narrator',
			noName: 'Give the narrator a name.',
			several: '{name} would be read as several narrators: a comma, a semicolon, "&" or "and" separates names.',
			joins: 'There is already a narrator called {name}. Press Save again to join them: every book of either will credit {name}, with what this form has, and what {name} has where this form is empty.',
			removeBooks:
				"This takes {name} off {books}' editions, which stay in the catalog, and removes them. Press Remove narrator again to do it.",
			removeNone: 'This removes {name}, whom no book credits. Press Remove narrator again to do it.',
			all: 'All narrators',
			noMatch: 'No narrators match your search.',
			noneYet: "No narrators yet: they come from the books' editions.",
		},
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
		texts: {
			editTitle: 'Edit publisher: {name}',
			save: 'Save publisher',
			remove: 'Remove publisher',
			noName: 'Give the publisher a name.',
			several: '{name} would be read as several publishers: a comma or a semicolon separates names.',
			joins: 'There is already a publisher called {name}. Press Save again to join them: every book of either will credit {name}, with what this form has, and what {name} has where this form is empty.',
			removeBooks:
				"This takes {name} off {books}' editions, which stay in the catalog, and removes them. Press Remove publisher again to do it.",
			removeNone: 'This removes {name}, whom no book credits. Press Remove publisher again to do it.',
			all: 'All publishers',
			noMatch: 'No publishers match your search.',
			noneYet: "No publishers yet: they come from the books' editions.",
		},
		href: publisherPageHref,
	},
};
