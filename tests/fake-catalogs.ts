// A fake of Open Library's and Wikidata's APIs, for the tests (not a test suite itself). Every book in it is
// invented; the shapes are those the real APIs answer (checked against them on 2026-10-22).

/**
 * Answers Open Library's /works, /books, /authors and /isbn pages and its searches for titles and authors, and Wikidata's
 * wbgetentities and wbsearchentities, from `state` (openCatalogState()); `sent` lists the addresses asked.
 */
export function fakeCatalogs(state: any = openCatalogState()) {
	const sent: string[] = [];
	const json = (status: number, body: unknown) => ({ok: status < 400, status, json: async () => body});
	const fetch = async (url: string) => {
		sent.push(url);
		const u = new URL(url);
		if (u.hostname === 'openlibrary.org' && u.pathname === '/search/authors.json') {
			// as Open Library searches: any author with the words in their name, the id without its path
			const q = u.searchParams.get('q')!.toLowerCase();
			const docs = Object.values<any>(state.openLibrary.authors)
				.filter(a => a.name.toLowerCase().includes(q))
				.map(a => ({
					key: a.key.replace('/authors/', ''),
					name: a.name,
					type: 'author',
					...(state.openLibrary.found[a.key.replace('/authors/', '')] || {work_count: 0}),
				}));
			return json(200, {numFound: docs.length, start: 0, numFoundExact: true, docs});
		}
		if (u.hostname === 'openlibrary.org' && u.pathname === '/search.json') {
			// as Open Library searches by title: the works with the words in their title, with their authors' names
			const q = u.searchParams.get('title')!.toLowerCase();
			const {works, authors} = state.openLibrary;
			const docs = Object.values<any>(works)
				.filter(w => w.title.toLowerCase().includes(q))
				.map(w => ({
					key: w.key,
					title: w.title,
					author_name: w.authors
						.map((a: any) => authors[a.author.key.replace('/authors/', '')]?.name)
						.filter(Boolean),
				}));
			return json(200, {numFound: docs.length, start: 0, numFoundExact: true, docs});
		}
		if (u.hostname === 'openlibrary.org') {
			const m = /^\/(works|books|authors|isbn)\/([^/]+)\.json$/.exec(u.pathname);
			const page =
				m &&
				(m[1] === 'isbn'
					? state.openLibrary.books[state.openLibrary.isbn[m[2]]]
					: state.openLibrary[m[1]][m[2]]);
			return page ? json(200, page) : json(404, {error: 'notfound'});
		}
		if (
			u.hostname === 'www.wikidata.org' &&
			u.pathname === '/w/api.php' &&
			u.searchParams.get('action') === 'wbsearchentities'
		) {
			// as Wikidata searches: the items whose label starts with the words
			const q = u.searchParams.get('search')!.toLowerCase();
			const search = Object.values<any>(state.wikidata)
				.filter(item => item.labels.en.value.toLowerCase().startsWith(q))
				.map(item => ({
					id: item.id,
					label: item.labels.en.value,
					...(item.descriptions ? {description: item.descriptions.en.value} : {}),
					match: {type: 'label', language: 'en', text: item.labels.en.value},
				}));
			return json(200, {searchinfo: {search: q}, search, success: 1});
		}
		if (u.hostname === 'www.wikidata.org' && u.pathname === '/w/api.php') {
			const entities = Object.fromEntries(
				u.searchParams
					.get('ids')!
					.split('|')
					.map(id => {
						const item = state.wikidata[id];
						if (!item) return [id, {id, missing: ''}];
						return [id, u.searchParams.get('props')!.includes('claims') ? item : {id, labels: item.labels}];
					}),
			);
			return json(200, {entities, success: 1});
		}
		throw new Error(`the page fetched ${url}`);
	};
	// its answers have what the sources read of a Response: ok, status and json()
	return {fetch: fetch as unknown as (url: string, init?: any) => Promise<Response>, sent};
}

const item = (id: string) => ({type: 'wikibase-entityid', value: {'entity-type': 'item', id}});
const claim = (datavalue: unknown, qualifiers?: unknown) => ({
	mainsnak: {snaktype: 'value', datavalue},
	rank: 'normal',
	...(qualifiers ? {qualifiers} : {}),
});

/**
 * An invented book in both: "The Lantern Keeper" by Ann Vale, book 2 of Gull Isle. Its author has a page in both
 * (with a bio, a link and her ids elsewhere on Open Library, her site and ids on Wikidata), and a namesake on
 * each; the series is an item on Wikidata.
 */
export const openCatalogState = (): any => ({
	openLibrary: {
		works: {
			OL900W: {
				key: '/works/OL900W',
				title: 'The Lantern Keeper',
				authors: [{author: {key: '/authors/OL70A'}, type: {key: '/type/author_role'}}],
				subjects: ['Fiction'],
			},
		},
		books: {
			OL901M: {
				key: '/books/OL901M',
				title: 'The lantern keeper',
				works: [{key: '/works/OL900W'}],
				publishers: ['Gullwing Audio'],
				publish_date: 'March 4, 2021',
				isbn_13: ['9780000000019'],
				series: ['Gull Isle (2)'],
				identifiers: {goodreads: ['5151'], amazon: ['B0LANTERN2']},
				contributors: [{role: 'Narrator', name: 'Hollis Marr'}],
			},
		},
		authors: {
			OL70A: {
				key: '/authors/OL70A',
				name: 'Ann Vale',
				bio: {type: '/type/text', value: 'Ann Vale writes  of tides.\r\n\r\nShe lives by an estuary.'},
				links: [
					{title: 'Her readers', url: 'https://valereaders.example/', type: {key: '/type/link'}},
					{title: 'On ISFDB', url: 'https://www.isfdb.org/cgi-bin/ea.cgi?3301', type: {key: '/type/link'}},
				],
				remote_ids: {wikidata: 'Q9002', goodreads: '8801', amazon: 'B0AUTHOR01', viaf: '1234'},
			},
			OL71A: {key: '/authors/OL71A', name: 'Ann Vale', bio: 'Ann Vale edits tide tables.'},
			OL72A: {key: '/authors/OL72A', name: 'Ann Valerian'},
		},
		// what its search says of an author it found
		found: {
			OL70A: {top_work: 'The Lantern Keeper', work_count: 4},
			OL71A: {top_work: 'Tide Tables 1988', work_count: 1},
		},
		isbn: {9780000000019: 'OL901M'},
	},
	wikidata: {
		Q9001: {
			id: 'Q9001',
			labels: {en: {language: 'en', value: 'The Lantern Keeper'}},
			claims: {
				P1476: [claim({type: 'monolingualtext', value: {text: 'The Lantern Keeper', language: 'en'}})],
				P50: [claim(item('Q9002'))],
				P179: [claim(item('Q9003'), {P1545: [{snaktype: 'value', datavalue: {type: 'string', value: '2'}}]})],
				P136: [claim(item('Q9004'))],
				P648: [claim({type: 'string', value: 'OL900W'})],
				P8383: [claim({type: 'string', value: '7171'})],
			},
		},
		Q9002: {
			id: 'Q9002',
			labels: {en: {language: 'en', value: 'Ann Vale'}},
			descriptions: {en: {language: 'en', value: 'writer of sea stories'}},
			claims: {
				P856: [claim({type: 'string', value: 'https://annvale.example'})],
				P648: [claim({type: 'string', value: 'OL70A'})],
				P2963: [claim({type: 'string', value: '8801'})],
				P1233: [claim({type: 'string', value: '3301'})],
			},
		},
		Q9003: {
			id: 'Q9003',
			labels: {en: {language: 'en', value: 'Gull Isle'}},
			descriptions: {en: {language: 'en', value: 'series of novels by Ann Vale'}},
			claims: {P6947: [claim({type: 'string', value: '6611'})]},
		},
		Q9005: {
			id: 'Q9005',
			labels: {en: {language: 'en', value: 'Ann Vale'}},
			descriptions: {en: {language: 'en', value: 'village in a valley'}},
			claims: {},
		},
		Q9006: {id: 'Q9006', labels: {en: {language: 'en', value: 'Ann Vale bibliography'}}, claims: {}},
		Q9004: {id: 'Q9004', labels: {en: {language: 'en', value: 'fantasy'}}, claims: {}},
	},
});

/**
 * A fake of what the catalog proxy answers for Audible's catalog API and AudiobookDB's API, by route
 * (`audible/audible.com/catalog/products/B0…`, `audiobookdb/releases/…`), in the shapes the real APIs answer
 * (checked against them on 2026-10-22); `sent` lists the routes asked. The book is invented: "The Lantern
 * Keeper", book 2 of Gull Isle (and of no number in the Tidewater Cycle, an umbrella series).
 */
export function fakeProxyCatalogs() {
	const sent: string[] = [];
	const json = (status: number, body: unknown) => ({ok: status < 400, status, json: async () => body});
	const ladder = (...names: string[]) => ({
		root: 'Genres',
		ladder: names.map((name, i) => ({id: String(1000 + i), name})),
	});
	const gullIsle = (asin: string, title: string, sequence: string, more = {}) => ({
		asin,
		title,
		authors: [{name: 'Ann Vale'}],
		series: [{asin: 'B0SERIES02', sequence, title: 'Gull Isle'}],
		publisher_name: 'Gullwing Audio',
		release_date: '2020-01-01',
		format_type: 'unabridged',
		category_ladders: [ladder('Science Fiction & Fantasy', 'Fantasy')],
		...more,
	});
	const audible: Record<string, any> = {
		'audible.com/B0LANTERN2': {
			asin: 'B0LANTERN2',
			title: 'The Lantern Keeper',
			subtitle: 'Gull Isle, Book 2',
			authors: [{asin: 'B0AUTHOR01', name: 'Ann Vale'}],
			narrators: [{name: 'Hollis Marr'}, {name: 'Dana Fenwick'}],
			series: [
				{asin: 'B0SERIES01', sequence: '', title: 'The Tidewater Cycle'},
				{asin: 'B0SERIES02', sequence: '2', title: 'Gull Isle'},
			],
			publisher_name: 'Gullwing Audio',
			release_date: '2021-03-04',
			runtime_length_min: 612,
			isbn: '9780000000019',
			format_type: 'unabridged',
			publisher_summary: '<p><b>The second Gull Isle book.</b></p>',
			category_ladders: [
				ladder('Science Fiction & Fantasy', 'Fantasy', 'Epic'),
				ladder('Science Fiction &amp; Fantasy', 'Fantasy', 'Coming of Age'),
				ladder('Literature & Fiction', 'Literary Fiction'),
			],
		},
		// the series Gull Isle as Audible answers it: every edition it sells of its books, unordered, numbered
		// by `sequence` (text) and placed by `sort`, with a placeholder, a box set, a companion without a number,
		// one the site doesn't sell and a sub-series (checked against the real API on 2026-10-25)
		'audible.com/B0SERIES02': {
			asin: 'B0SERIES02',
			title: 'Gull Isle',
			content_delivery_type: 'BookSeries',
			release_date: '2200-01-01',
			relationships: [
				['B0BRINETD4', '4', 6],
				['B0SALTRDAB', '1', 3],
				['B0LANTERN2', '2', 4],
				['B0BOXSET13', '1-3', 1],
				['B0SALTRD01', '1', 2],
				['B0GULLSNG3', '3', 5],
				['B0PLACEHL5', '5', 7],
				['B0STORIES0', '', 8],
				['B0NOTSOLD1', '6', 9],
			]
				.map(([asin, sequence, sort]): Record<string, string> => ({
					asin: String(asin),
					relationship_to_product: 'child',
					relationship_type: 'series',
					sequence: String(sequence),
					sort: String(sort),
					sku: `SKU${asin}`,
				}))
				.concat([
					{
						asin: 'B0SUBSER01',
						relationship_to_product: 'child',
						relationship_type: 'merchant_title_authority',
						sort: '1',
					},
				]),
		},
		'audible.com/B0SALTRD01': gullIsle('B0SALTRD01', 'Salt Road', '1', {
			narrators: [{name: 'Hollis Marr'}],
			runtime_length_min: 540,
		}),
		'audible.com/B0SALTRDAB': gullIsle('B0SALTRDAB', 'Salt Road', '1', {
			format_type: 'abridged',
			publisher_name: 'Short Reads Audio',
			runtime_length_min: 200,
		}),
		'audible.com/B0GULLSNG3': gullIsle('B0GULLSNG3', 'Gull Song', '3'),
		'audible.com/B0BRINETD4': gullIsle('B0BRINETD4', 'Brine Tide', '4', {
			narrators: [{name: 'Dana Fenwick'}],
			runtime_length_min: 480,
			release_date: '2023-09-12',
		}),
		'audible.com/B0PLACEHL5': gullIsle('B0PLACEHL5', 'Gull Isle Book 5', '5', {
			publisher_name: 'ZZZ - Series Advisor Placeholder',
		}),
		'audible.com/B0BOXSET13': gullIsle('B0BOXSET13', 'Gull Isle: Books 1-3', '1-3'),
		'audible.com/B0STORIES0': gullIsle('B0STORIES0', 'Gull Isle Stories', ''),
		'audible.co.uk/B0LANTERNU': {
			asin: 'B0LANTERNU',
			title: 'The Lantern Keeper',
			authors: [{name: 'Ann Vale'}],
			narrators: [{name: 'Hollis Marr'}],
			series: [{sequence: '2', title: 'Gull Isle'}],
			publisher_name: 'Gullwing Audio UK',
			release_date: '2021-05-01',
			runtime_length_min: 611,
		},
	};
	const people = (role: string, ...names: string[]) =>
		names.map((name, i) => ({
			role: {name: role},
			person: {id: `Prsn${role.slice(0, 4)}${i}00000`.slice(0, 12), name},
		}));
	const releaseUs = {
		id: 'RlsLntrnUS01',
		title: 'The Lantern Keeper',
		releaseDate: '2021-03-04T00:00:00Z',
		duration: '10:12:20',
		disambiguation: 'unabridged',
		publisher: {id: 'PblshrGullw1', name: 'Gullwing Audio'},
		people: people('Narrator', 'Hollis Marr', 'Dana Fenwick'),
		images: [abdbImage('ImgLntrnUS01', 'c1'.repeat(32))],
	};
	const releaseUk = {
		id: 'RlsLntrnUK01',
		title: 'The Lantern Keeper',
		releaseDate: '2021-05-01T00:00:00Z',
		duration: '10:11:00',
		publisher: {id: 'PblshrGullw2', name: 'Gullwing Audio UK'},
		people: people('Narrator', 'Hollis Marr'),
	};
	const book = {
		id: 'LnTrnKpr2xYz',
		title: 'The Lantern Keeper',
		subtitle: 'Gull Isle, Book 2',
		copyright: 2021,
		type: 'fiction',
		genres: [{id: 'GnrFantasy01', title: 'Fantasy'}],
		tags: [{id: 'TgCozy000001', title: 'Cozy'}],
		people: people('Author', 'Ann Vale'),
		images: [abdbImage('ImgLntrnKpr1', 'b0'.repeat(32))],
		series: [
			{ordinal: '0', series: {id: 'SrsTidewater', title: 'The Tidewater Cycle', bookCount: 4}},
			{ordinal: '2', series: {id: 'SrsGullIsle1', title: 'Gull Isle', bookCount: 3}},
		],
		releases: [releaseUs, releaseUk],
	};
	const releases: Record<string, object> = {
		RlsLntrnUS01: {
			...releaseUs,
			isbn: '9780000000019',
			runtimeLengthSec: 36740,
			book: {id: book.id, title: book.title},
			external: [
				{
					id: 'ExtLntrnUS01',
					itemId: 'B0LANTERN2',
					category: {title: 'Audible', url: 'https://www.audible.com'},
				},
			],
		},
	};
	// a series' or a person's ASIN is a link of theirs, as a release's is
	const onAudible = (asin: string) => [
		{id: `Ext${asin.slice(2)}00`, itemId: asin, category: {title: 'Audible', url: 'https://www.audible.com'}},
	];
	const entries: Record<string, Record<string, any>> = {
		series: {
			SrsGullIsle1: {id: 'SrsGullIsle1', title: 'Gull Isle', external: onAudible('B0SERIES02'), books: []},
		},
		people: {
			PrsnAuth0000: {
				id: 'PrsnAuth0000',
				name: 'Ann Vale',
				description: 'Ann Vale writes of the sea.',
				external: onAudible('B0AUTHOR01'),
			},
			PrsnNarr0000: {id: 'PrsnNarr0000', name: 'Hollis Marr', description: 'Hollis Marr reads aloud.'},
			PrsnHllsMrr2: {id: 'PrsnHllsMrr2', name: 'Hollis Marr'},
		},
		publishers: {PblshrGullw1: {id: 'PblshrGullw1', name: 'Gullwing Audio'}},
	};
	// what a search says of what it found
	const found: Record<string, object> = {
		SrsGullIsle1: {bookCount: 3},
		PrsnAuth0000: {
			roleNames: ['Author'],
			sampleCredits: [{role: 'Author', book: {id: book.id, title: book.title}}],
		},
		PrsnNarr0000: {
			roleNames: ['Narrator'],
			sampleCredits: [{role: 'Narrator', book: {id: book.id, title: book.title}}],
		},
		PrsnHllsMrr2: {roleNames: ['Author'], sampleCredits: []},
		PblshrGullw1: {releaseCount: 2},
	};
	const notFound = (detail: string) => json(404, {errors: [{status: '404', title: 'Not Found', detail}]});
	const route = async (path: string) => {
		sent.push(path);
		const u = new URL(path, 'https://proxy.invalid/');
		const stub = (asin: string) => ({asin, asset_details: [], is_vvab: false}); // what a site that doesn't sell it answers
		// as Audible answers: the title comes with product_desc or media, not with product_attrs (checked 2026-10-25)
		const asked = (product: any, groups: string) => {
			if (!product || /\b(product_desc|media)\b/.test(groups)) return product;
			const rest = {...product};
			delete rest.title;
			return rest;
		};
		let m = /^\/audible\/([^/]+)\/catalog\/products\/([^/]+)$/.exec(u.pathname);
		if (m) {
			const groups = u.searchParams.get('response_groups')!;
			assert(
				groups.includes(m[2] === 'B0SERIES02' ? 'relationships' : 'series'),
				'Audible is asked for the series',
			);
			return json(200, {
				product: asked(audible[`${m[1]}/${m[2]}`], groups) || stub(m[2]),
				response_groups: ['always-returned'],
			});
		}
		m = /^\/audible\/([^/]+)\/catalog\/products$/.exec(u.pathname);
		if (m && u.searchParams.has('title')) {
			// a title search on the site: the products with the words in their title, with what was asked of them
			const q = u.searchParams.get('title')!.toLowerCase();
			const groups = u.searchParams.get('response_groups')!;
			const site = m[1];
			const products = Object.entries(audible)
				.filter(([key, p]) => key.startsWith(`${site}/`) && p.title?.toLowerCase().includes(q))
				.map(([, p]) => asked(p, groups));
			return json(200, {products, response_groups: ['always-returned'], total_results: products.length});
		}
		if (m) {
			const asins = u.searchParams.get('asins')!.split(',');
			if (asins.length > 50)
				return json(400, {
					message: `Number of requested asins ${asins.length} is greater than maximum allowed asins 50`,
				});
			const groups = u.searchParams.get('response_groups')!;
			const site = m[1];
			const products = asins.map(a => asked(audible[`${site}/${a}`], groups) || stub(a));
			return json(200, {products, response_groups: ['always-returned'], total_results: products.length});
		}
		if (u.pathname === '/audiobookdb/books') {
			// a title search: list items, with up to 3 authors; another author's book of the same title too
			const q = u.searchParams.get('q')!.toLowerCase();
			const items = [
				{id: book.id, title: book.title, authors: [{id: 'PrsnAuth0000', name: 'Ann Vale'}], releaseCount: 2},
				{
					id: 'LnTrnKprBoR1',
					title: 'The Lantern Keeper',
					authors: [{id: 'PrsnBoReed01', name: 'Bo Reed'}],
					releaseCount: 1,
				},
				{
					id: 'LnTrnKprsGd1',
					title: "The Lantern Keeper's Guide",
					authors: [{id: 'PrsnAuth0000', name: 'Ann Vale'}],
					releaseCount: 1,
				},
			];
			return json(
				200,
				items.filter(i => i.title.toLowerCase().includes(q)),
			);
		}
		// its series, people and publishers: one by its id, or those a search finds (any with the words in its name)
		m = /^\/audiobookdb\/(series|people|publishers)(?:\/([^/]+))?$/.exec(u.pathname);
		if (m && m[2])
			return entries[m[1]][m[2]] ? json(200, entries[m[1]][m[2]]) : notFound(`${m[1]} with id ${m[2]} not found`);
		if (m) {
			const q = u.searchParams.get('q')!.toLowerCase();
			return json(
				200,
				Object.values(entries[m[1]])
					.filter(e => (e.title || e.name).toLowerCase().includes(q))
					.map(e => ({id: e.id, ...(e.title ? {title: e.title} : {name: e.name}), ...found[e.id]})),
			);
		}
		m = /^\/audiobookdb\/(audiobooks\/external\/audible|books|releases)\/([^/]+)$/.exec(u.pathname);
		if (m && m[1] === 'audiobooks/external/audible')
			return m[2] === 'B0LANTERN2'
				? json(200, {...book, matchedReleaseId: 'RlsLntrnUS01'})
				: notFound(`audiobook with id audible/${m[2]} not found`);
		if (m && m[1] === 'books')
			return m[2] === book.id ? json(200, book) : notFound(`book with id ${m[2]} not found`);
		if (m && m[1] === 'releases')
			return releases[m[2]] ? json(200, releases[m[2]]) : notFound(`release with id ${m[2]} not found`);
		throw new Error(`the proxy was asked for ${path}`);
	};
	// its answers have what the clients read of a Response: ok, status and json()
	return {route: route as unknown as (path: string) => Promise<Response>, sent};
}

/**
 * An image as AudiobookDB lists it: `url` is its key under the image server, which only answers with a size added.
 */
function abdbImage(id: string, hash: string) {
	const url = `https://cdn.audiobookdb.org/${hash}`;
	return {
		id,
		url,
		sourceUrl: `${url}/source.jpg:book`,
		width: 2400,
		height: 2400,
		blurdata: 'U00000fQfQfQfQfQfQfQfQfQfQfQ',
	};
}

function assert(ok: unknown, message: string) {
	if (!ok) throw new Error(message);
}

/**
 * Your account and AudiobookDB's catalog for fakeAudiobookdb(), every book invented: your key and username,
 * your shelves, laid out as AudiobookDB makes them (To Listen, empty; Currently Listening holds Brine Tide; Listened,
 * its Read shelf, holds Tidewater and The Paper Fen; Favorites, not exclusive, holds Lantern Hours; an empty
 * shelf comes without `books`), and the books, series and people, in the shapes of AudiobookDB's OpenAPI file
 * (1.0.0) and its answers (checked on 2026-10-22 and 2026-10-23).
 */
export function audiobookdbState(): any {
	const person = (role: string, id: string, name: string) => ({role: {name: role}, person: {id, name}});
	// a release's link names the site its ASIN is on
	const audible = (asin: string, site = 'audible.com') => ({
		id: `Ext${asin.slice(2, 11)}`,
		itemId: asin,
		category: {title: 'Audible', url: `https://www.${site}`},
	});
	const release = (id: string, title: string, asin: string | null, extra = {}) => ({
		id,
		title,
		releaseDate: '2020-02-02T00:00:00Z',
		duration: '8:00:00',
		publisher: {id: 'PblshrGullw1', name: 'Gullwing Audio'},
		external: asin ? [audible(asin)] : [],
		...extra,
	});
	const vale = person('Author', 'PrsnVale0001', 'Ann Vale');
	// Lantern Hours has a cover only on its book, Tidewater on its release, Brine Tide none
	const gullIsle = (n: string) => ({
		ordinal: n,
		position: {value: n, label: n},
		series: {id: 'SrsGullIsle1', title: 'Gull Isle', bookCount: 3},
	});
	const books: Record<string, any> = {
		LntrnHours01: {
			id: 'LntrnHours01',
			title: 'Lantern Hours',
			people: [person('Author', 'PrsnHale0001', 'R. T. Hale')],
			series: [],
			images: [abdbImage('ImgLntrnHrs1', 'a1'.repeat(32))],
			releases: [
				release('RlsLntrnHrs1', 'Lantern Hours', 'B0LANTERN1', {
					people: [person('Narrator', 'PrsnMarr0001', 'Hollis Marr')],
				}),
			],
		},
		Tidewater001: {
			id: 'Tidewater001',
			title: 'Tidewater',
			people: [vale],
			series: [gullIsle('1')],
			releases: [
				release('RlsTidewatr1', 'Tidewater', 'B0TIDEWAT1', {
					duration: '9:30:00',
					images: [abdbImage('ImgTidewatr1', 'd2'.repeat(32))],
					people: [person('Narrator', 'PrsnFnwk0001', 'Dana Fenwick')],
				}),
			],
		},
		BrineTide001: {
			id: 'BrineTide001',
			title: 'Brine Tide',
			people: [vale],
			series: [gullIsle('2')],
			releases: [
				release('RlsBrineUS01', 'Brine Tide', 'B0BRINETD1'),
				release('RlsBrineUK01', 'Brine Tide', 'B0BRINEUK1', {
					external: [audible('B0BRINEUK1', 'audible.co.uk')],
				}),
			],
		},
		PaperFen0001: {
			id: 'PaperFen0001',
			title: 'The Paper Fen',
			people: [vale],
			series: [],
			releases: [release('RlsPaperUS01', 'The Paper Fen', null), release('RlsPaperUK01', 'The Paper Fen', null)],
		},
		GullSong0001: {
			id: 'GullSong0001',
			title: 'Gull Song',
			people: [vale],
			series: [gullIsle('3')],
			releases: [release('RlsGullSng01', 'Gull Song', null)],
		},
	};
	const onShelf = (id: string) => ({
		id,
		title: books[id].title,
		people: books[id].people,
		addedAt: '2026-01-01T00:00:00Z',
	});
	const shelf = (slug: string, name: string, isExclusive: boolean, ids: string[]) => ({
		id: `Shlf${slug.replace(/-/g, '').slice(0, 8).padEnd(8, '0')}`,
		slug,
		name,
		description: '',
		isDefault: true,
		isExclusive,
		position: 0,
		...(ids.length ? {books: ids.map(onShelf)} : {}),
		bookCount: ids.length,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
	});
	return {
		key: 'abdb-key-1',
		username: 'reader',
		books,
		shelves: [
			shelf('to-listen', 'To Listen', true, []),
			shelf('currently-listening', 'Currently Listening', true, ['BrineTide001']),
			shelf('listened', 'Listened', true, ['Tidewater001', 'PaperFen0001']),
			shelf('favorites', 'Favorites', false, ['LntrnHours01']),
		],
		series: {
			SrsGullIsle1: {
				id: 'SrsGullIsle1',
				title: 'Gull Isle',
				books: ['Tidewater001', 'BrineTide001', 'GullSong0001'].map((id, i) => ({
					ordinal: String(i + 1),
					book: {id, title: books[id].title},
				})),
			},
		},
		people: {
			PrsnVale0001: {
				id: 'PrsnVale0001',
				name: 'Ann Vale',
				roles: ['Tidewater001', 'BrineTide001', 'PaperFen0001', 'GullSong0001'].map(id => ({
					role: {name: 'Author'},
					book: {id, title: books[id].title},
				})),
			},
		},
		onAdd: null, // called with each book put on a shelf, before it is
	};
}

/**
 * A fake of AudiobookDB's API behind the catalog proxy: `fetch` takes the Request the proxy sends
 * (https://audiobookdb.org/api/...) and answers from `state` (audiobookdbState()), as AudiobookDB would:
 * your session and shelves only with your key (X-API-Key), a book put on a shelf only once. `sent` lists
 * what was asked: {method, path, key}.
 */
export function fakeAudiobookdb(state: any = audiobookdbState()) {
	const sent: {method: string; path: string; key: string | null}[] = [];
	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
	const error = (status: number, title: string) => json(status, {errors: [{status: String(status), title}]});
	const fetch = async (request: Request) => {
		const u = new URL(request.url);
		assert(
			u.origin === 'https://audiobookdb.org' && u.pathname.startsWith('/api/'),
			`AudiobookDB was asked for ${request.url}`,
		);
		const path = u.pathname.slice('/api/'.length);
		const key = request.headers.get('x-api-key');
		const body = request.method === 'POST' ? JSON.parse(await request.text()) : null;
		sent.push({method: request.method, path: path + u.search, key});
		const mine = key === state.key;
		let m: RegExpExecArray | null;
		if (path === 'auth/session')
			return mine
				? json(200, {id: 'user-1', username: state.username, role: 'user'})
				: error(401, 'Unauthorized');
		if ((m = /^users\/username\/([^/]+)\/shelves(?:\/([^/]+)(\/books)?)?$/.exec(path))) {
			if (m[1] !== state.username) return error(404, 'Not Found');
			if (!mine) return error(key ? 401 : 403, key ? 'Unauthorized' : 'shelves are private');
			const slug = m[2];
			const shelf = slug && state.shelves.find((s: any) => s.slug === slug);
			if (m[2] && !shelf) return error(404, 'Not Found');
			if (m[3]) {
				assert(request.method === 'POST', 'only putting books on shelves');
				const book = state.books[body.bookId];
				if (!book) return error(404, 'Not Found');
				if (state.onAdd) state.onAdd(body.bookId);
				if (!shelf.books) shelf.books = [];
				if (!shelf.books.some((b: any) => b.id === body.bookId))
					shelf.books.push({
						id: book.id,
						title: book.title,
						people: book.people,
						addedAt: '2026-10-23T00:00:00Z',
					});
				shelf.bookCount = shelf.books.length;
				return json(200, shelf);
			}
			return json(200, m[2] ? shelf : state.shelves);
		}
		assert(request.method === 'GET', `AudiobookDB was sent a ${request.method} to ${path}`);
		if ((m = /^audiobooks\/external\/audible\/([^/]+)$/.exec(path))) {
			const asin = m[1];
			const book = Object.values<any>(state.books).find(b =>
				b.releases.some((r: any) => r.external.some((x: any) => x.itemId === asin)),
			);
			return book
				? json(200, {
						...book,
						matchedReleaseId: book.releases.find((r: any) => r.external.some((x: any) => x.itemId === asin))
							.id,
					})
				: error(404, 'Not Found');
		}
		if ((m = /^books\/([^/]+)$/.exec(path)))
			return state.books[m[1]] ? json(200, state.books[m[1]]) : error(404, 'Not Found');
		if ((m = /^series\/([^/]+)$/.exec(path)))
			return state.series[m[1]] ? json(200, state.series[m[1]]) : error(404, 'Not Found');
		if ((m = /^people\/([^/]+)$/.exec(path)))
			return state.people[m[1]] ? json(200, state.people[m[1]]) : error(404, 'Not Found');
		throw new Error(`AudiobookDB was asked for ${path}`);
	};
	return {fetch, sent};
}
