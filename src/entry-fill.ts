// Fill in from other catalogs, for a series (the Edit page's series panel, by its Ask the catalogs) and for an author, a narrator or a
// publisher (their form): the catalogs a page may read are asked about them (modules/entry-lookup.ts, through
// the sources CatalogConnectors lists, so nothing here names a catalog), and what they have that the form lacks
// is listed under the form, each value with a tick. Nothing is changed by asking: only Add puts the ticked
// values in the form's empty fields, and only the form's own Save keeps them. A page loads this with import()
// when Fill in is pressed, as only then are the catalogs' connectors needed.
import {Text} from './modules/text.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import {EntryLookup} from './modules/entry-lookup.js';
import {CatalogConnectors} from './modules/catalog-connectors.js';
import type {EntryOffer, EntriesFound} from './modules/entry-lookup.js';
import type {EntryKind, EntryInfo, EntryAnswer} from './modules/book-source.js';
import type {Book} from './modules/book.js';
import {spell, spellParts, plural, buildElement, fillElement} from './dom.js';
import type {Child} from './dom.js';
import {keyedClients, savedServer, fetchViaProxy} from './connections.js';

/** What a form's Fill in is given. */
export interface EntryFillOptions {
	kind: EntryKind;
	/** the name the catalog has them under */
	name: string;
	/** what the form holds now; read when the catalogs have answered, and again when Add is pressed */
	current: () => EntryInfo;
	/** their books in the catalog, whose ids find them in the other catalogs */
	books: Book[];
	/** where the answers are listed; its id starts the ids of what is drawn in it */
	box: HTMLElement;
	/** whether the form is still the one Fill in was pressed on */
	still: () => boolean;
	/** puts what was picked in the form: `info` is `current()` with the picked values in its gaps */
	onAdd: (info: EntryInfo, added: EntryOffer[]) => void;
	/** the catalogs (by their group's key, 'audible' for every Audible site) not to ask, as unticked on the page */
	skip?: Set<string>;
}

/** How an answer was found, as its heading says it: a whole sentence for each case. */
const FOUND_BY: Record<EntryAnswer['by'], string> = {
	id: '{catalog}: {name}, by the id kept here',
	books: '{catalog}: {name}, named on your books there',
	name: '{catalog}: {name}, found by name alone, so it may be another of that name',
};
/** What an offer fills, before its value. */
const OFFERED: Record<EntryOffer['field'], string> = {
	bio: 'Bio: {value}',
	url: 'Website: {value}',
	total: 'Books released so far: {value}',
	status: 'Status: {value}',
	id: 'Its id on {catalog}: {value}',
	link: 'Link: {value}',
};

/** A link to a page elsewhere, opened beside this one. */
const outLink = (href: string, text: string): HTMLAnchorElement =>
	buildElement('a', {href, target: '_blank', rel: 'noopener'}, text);

/** An offer's line: what it fills and its value, an id and an address as links to check before ticking. */
function offerText(kind: EntryKind, o: EntryOffer): Child[] {
	const value = String(o.value);
	if (o.field === 'id' && o.catalog) {
		const url = ExternalCatalog.url(o.catalog, kind, value);
		return spellParts(OFFERED.id, {
			catalog: ExternalCatalog.name(o.catalog),
			value: url ? outLink(url, value) : value,
		});
	}
	if (o.field === 'url' || o.field === 'link') return spellParts(OFFERED[o.field], {value: outLink(value, value)});
	return spellParts(OFFERED[o.field], {value: o.field === 'status' ? spell(value) : value});
}

/**
 * Ask the catalogs about a series or person and list under the form what they have that it lacks, to tick; Add
 * hands the ticked values to the form (`onAdd`), which keeps nothing until it is saved. Resolves when the
 * answers are listed (or the form was closed meanwhile).
 */
export async function fillEntry(opts: EntryFillOptions): Promise<void> {
	const {kind, name, box} = opts;
	const close = () => fillElement(box);
	fillElement(box, buildElement('p', {class: 'hint'}, spell('Asking the other catalogs about {name}…', {name})));
	const server = savedServer();
	const skip = opts.skip || new Set<string>();
	const sources = CatalogConnectors.SOURCES.filter(
		Source => !skip.has(ExternalCatalog.groupOf(Source.CATALOG)?.key ?? Source.CATALOG),
	);
	let found: EntriesFound;
	try {
		found = await new EntryLookup(
			url => fetch(url),
			keyedClients(CatalogConnectors.CLIENTS),
			server ? route => fetchViaProxy(route, server) : null,
			sources,
		).find(kind, name, opts.current(), opts.books);
	} catch (err) {
		if (opts.still())
			fillElement(
				box,
				buildElement(
					'p',
					{class: 'formError'},
					spell('Not filled in: {error}.', {error: Text.errorPhrase(err)}),
				),
			);
		return;
	}
	if (!opts.still()) return close();
	const offers = EntryLookup.offers(opts.current(), found.answers);
	const boxes: Map<EntryOffer, HTMLInputElement> = new Map();
	const notes =
		found.notes.length > 0 &&
		buildElement(
			'ul',
			{class: 'editNotes'},
			found.notes.map(note => buildElement('li', {}, spell(note))),
		);
	const closeBtn = buildElement('button', {type: 'button', id: `${box.id}Close`, onclick: close}, spell('Close'));
	if (!offers.length) {
		fillElement(
			box,
			buildElement(
				'p',
				{class: 'hint'},
				found.answers.length
					? spell('The other catalogs have nothing about {name} that is not here already.', {name})
					: spell('None of the other catalogs asked has {name}.', {name}),
			),
			notes,
			buildElement('div', {class: 'formbtns'}, closeBtn),
		);
		return;
	}
	const groups = found.answers.map((answer, at) => {
		const mine = offers.filter(o => o.answer === at);
		if (!mine.length) return false;
		const url = ExternalCatalog.url(answer.catalog, kind, answer.id);
		return buildElement(
			'div',
			{class: answer.by === 'name' ? 'entryAnswer unsure' : 'entryAnswer'},
			buildElement(
				'p',
				{class: 'entryFrom'},
				spellParts(FOUND_BY[answer.by], {
					catalog: answer.source,
					name: url ? outLink(url, answer.name || answer.id) : answer.name || answer.id,
				}),
			),
			answer.about && buildElement('p', {class: 'hint'}, spell(answer.about)),
			mine.map(o => {
				const id = `${box.id}-pick-${offers.indexOf(o)}`;
				const tick = buildElement('input', {
					type: 'checkbox',
					id,
					// one value for each thing: ticking one unticks the others offered for it
					onchange: () => {
						if (tick.checked)
							for (const [other, el] of boxes) if (other !== o && other.key === o.key) el.checked = false;
					},
				});
				tick.checked = o.ticked;
				boxes.set(o, tick);
				return buildElement(
					'label',
					{class: 'entryOffer', for: id},
					tick,
					buildElement('span', {}, offerText(kind, o)),
				);
			}),
		);
	});
	const add = () => {
		if (!opts.still()) return close();
		const {info, added} = EntryLookup.apply(
			opts.current(),
			offers.filter(o => boxes.get(o)?.checked),
		);
		close();
		opts.onAdd(info, added);
	};
	fillElement(
		box,
		buildElement(
			'p',
			{class: 'hint'},
			spell(
				'What the other catalogs have that is not here: tick what to add. Nothing is changed until you add it and save, and nothing here is replaced.',
			),
		),
		groups,
		notes,
		buildElement(
			'div',
			{class: 'formbtns'},
			buildElement(
				'button',
				{type: 'button', class: 'save', id: `${box.id}Add`, onclick: add},
				spell('Add the ticked'),
			),
			closeBtn,
		),
	);
}

/** What Add says it did: how many values went into the form, which its own Save keeps. */
export function addedText(added: EntryOffer[]): string {
	return added.length
		? spell('Added {values} to the form; save it to keep them.', {values: plural(added.length, 'value')})
		: spell('Nothing was ticked, so nothing was added.');
}
