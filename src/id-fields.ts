// The fields for external ids and links in the forms (the Edit page's, a series' and a person's), and the links to
// an entry's pages elsewhere.
import {Text} from './modules/text.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import type {ExternalKind, ExternalId} from './modules/external-catalog.js';
import {buildElement, fieldById, showIoStatus, spell} from './dom.js';
import type {FormField} from './dom.js';
import {lookupHardcoverField} from './connections.js';

// A form has a field per group of external catalogs (Audible, Amazon, Goodreads, Hardcover) that has pages
// for what the form edits; each takes an id or the address of the page there, and the catalog keeps the id.

/**
 * The fields for the external ids of a kind of thing, each a <div> with a label and an input whose id is
 * `prefix` and the group ("sf_ext_goodreads"); `except` leaves groups out (a field of their own elsewhere).
 */
export function externalFields(prefix: string, kind: ExternalKind, except: string[] = []): HTMLDivElement[] {
	return ExternalCatalog.groupsFor(kind)
		.filter(g => !except.includes(g.key))
		.map(g => {
			const sites = ExternalCatalog.forKind(kind).filter(def => def.group === g.key);
			const example =
				sites.length > 1
					? g.default
					: ((ExternalCatalog.url(sites[0].key, kind, 'x') || '')
							.replace(/^https?:\/\/(www\.)?/, '')
							.split('/')[0] as string);
			// Hardcover's address of a series or person is looked up for its number as soon as the field is left
			const lookup =
				g.key === 'hardcover' && kind !== 'book' && kind !== 'edition'
					? {
							onchange: async () => {
								const found = await lookupHardcoverField(prefix, kind);
								if (found && found.note) showIoStatus(found.note);
							},
						}
					: {};
			return buildElement(
				'div',
				{},
				buildElement('label', {for: prefix + g.key}, g.name),
				buildElement('input', {
					id: prefix + g.key,
					'data-group': g.key,
					placeholder: spell('id, or its address on {site}', {site: example}),
					...lookup,
					onfocusout: () => externalFieldToId(prefix, kind, g.key),
				}),
			);
		});
}

/**
 * When a field externalFields() made is left holding a page's address, it is given the id the address names,
 * which is what is kept. An address on another of the group's sites (audible.co.uk in the Audible field)
 * stays an address, tidied, as the id alone would be read as the usual site's. An address pasted into another
 * catalog's field moves to that catalog's field, when the form has one that is empty or holds the same id.
 * Anything else is left for Save to refuse, saying why.
 */
function externalFieldToId(prefix: string, kind: ExternalKind, group: string) {
	const field = document.getElementById(prefix + group) as HTMLInputElement | null;
	const text = field ? Text.tidy(field.value) : '';
	if (!field || !text) return;
	const shown = (found: ExternalId, into: string) => idFieldText(found, kind, into, text);
	const found = ExternalCatalog.readId(text, kind, group);
	if (found) {
		field.value = shown(found, group);
		return;
	}
	const elsewhere = ExternalCatalog.fromAddress(text, kind),
		g = elsewhere && ExternalCatalog.groupOf(elsewhere.catalog);
	const other = g ? (document.getElementById(prefix + g.key) as HTMLInputElement | null) : null;
	if (!elsewhere || !g || !other) return;
	const value = shown(elsewhere, g.key),
		there = Text.tidy(other.value);
	if (there && there !== value) return;
	other.value = value;
	field.value = '';
}

/**
 * What a group's id field shows for an id found: the id alone, or the address of its page when the id alone
 * would be read as another of the group's sites' (audible.co.uk's in the Audible field).
 * @param into the group of the field it goes in
 * @param text what was typed, when there is no such address
 */
function idFieldText(found: ExternalId, kind: ExternalKind, into: string, text: string): string {
	const bare = ExternalCatalog.readId(found.id, kind, into);
	return bare && bare.catalog === found.catalog
		? found.id
		: ExternalCatalog.url(found.catalog, kind, found.id) || text;
}

/**
 * The field for links, one per line (Text.parseLinks reads them): a <div> with a label and a <textarea> whose id
 * is `id`. When it is left, an address that is a page of a catalog the form has an id field for moves to that
 * field, when it is empty or holds the same id (moveCatalogLinks), and `onMoved` is called.
 * @param fieldFor the form's id field for a group of catalogs, or null when it has none
 * @param attrs the textarea's other attributes
 */
export function linksField(
	id: string,
	kind: ExternalKind,
	fieldFor: (group: string) => FormField | null,
	{
		label = spell('Links, one per line'),
		value = '',
		onMoved,
		attrs = {},
	}: {label?: string; value?: string; onMoved?: () => void; attrs?: Record<string, any>} = {},
): HTMLDivElement {
	const textarea = buildElement('textarea', {
		id,
		rows: 2,
		placeholder: spell("https://… a page about it, such as its publisher's"),
		...attrs,
		onfocusout: () => {
			const now = moveCatalogLinks(textarea.value, kind, fieldFor);
			if (now === textarea.value) return;
			textarea.value = now;
			if (onMoved) onMoved();
		},
	});
	// a textarea's value is its own, not an attribute's
	textarea.value = value;
	return buildElement('div', {class: 'linksField'}, buildElement('label', {for: id}, label), textarea);
}

/**
 * Links typed one per line, without the pages of catalogs the form has an id field for, which go to that field
 * when it is empty or holds the same id (as an id is what the catalog keeps of such a page); the rest stay as typed.
 * `text` as it is when none moves.
 * @param fieldFor the form's id field for a group of catalogs, or null when it has none
 */
export function moveCatalogLinks(
	text: string,
	kind: ExternalKind,
	fieldFor: (group: string) => FormField | null,
): string {
	const kept: string[] = [];
	let moved = false;
	for (const line of text.split(/\r\n|\r|\n/)) {
		const link = line.trim();
		const found = link ? ExternalCatalog.fromAddress(link, kind) : null;
		const g = found && ExternalCatalog.groupOf(found.catalog);
		const field = g ? fieldFor(g.key) : null;
		if (found && g && field) {
			const value = idFieldText(found, kind, g.key, link),
				there = Text.tidy(field.value);
			if (!there || there === value || ExternalCatalog.readId(there, kind, g.key)?.id === found.id) {
				field.value = there || value;
				moved = true;
				continue;
			}
		}
		kept.push(line);
	}
	return moved ? kept.join('\n').trim() : text;
}

/**
 * Links to other pages about something (Book.links and the like), each named by its site ("gullwing.example ↗").
 * @param cls the links' class
 */
export function webLinks(links: string[], cls: string = 'authorlink'): HTMLAnchorElement[] {
	return links.map(href =>
		buildElement('a', {class: cls, href, target: '_blank', rel: 'noopener'}, `${Text.linkLabel(href)} ↗`),
	);
}

/**
 * Put an entry's external ids in the fields externalFields() made.
 */
export function fillExternalFields(prefix: string, kind: ExternalKind, ids: Record<string, string>) {
	for (const g of ExternalCatalog.groupsFor(kind)) {
		const field = document.getElementById(prefix + g.key);
		if (field) (field as HTMLInputElement).value = ExternalCatalog.fieldText(ids, kind, g.key);
	}
}

/**
 * The external ids in the fields externalFields() made, as {ids, bad (the fields that hold neither an id nor
 * an address there, as "Goodreads: text")}. The ids an entry has in catalogs no field stands for are kept.
 * @param had the entry's ids before
 */
export function readExternalFields(
	prefix: string,
	kind: ExternalKind,
	had: Record<string, string> = {},
): {ids: Record<string, string>; bad: string[]} {
	const groups = ExternalCatalog.groupsFor(kind).filter(g => document.getElementById(prefix + g.key));
	const shown = new Set(groups.map(g => g.key));
	const ids: Record<string, string> = Object.fromEntries(
		Object.entries(had).filter(([key]) => {
			const g = ExternalCatalog.groupOf(key);
			return !g || !shown.has(g.key);
		}),
	);
	const bad: string[] = [];
	for (const g of groups) {
		const text = Text.tidy(fieldById(prefix + g.key).value);
		if (!text) continue;
		const found = ExternalCatalog.readId(text, kind, g.key);
		if (found) ids[found.catalog] = found.id;
		else bad.push(`${g.name}: ${text}`);
	}
	return {ids, bad};
}

/**
 * Links to an entry's pages in external catalogs ("Goodreads ↗"), one per id; an Audible or Amazon site
 * other than the group's usual one says which ("Audible (audible.co.uk) ↗").
 * @param cls the links' class
 */
export function externalLinks(
	ids: Record<string, string>,
	kind: ExternalKind,
	cls: string = 'authorlink',
): HTMLAnchorElement[] {
	return Object.entries(ExternalCatalog.order(ids) || {}).flatMap(([key, id]) => {
		const url = ExternalCatalog.url(key, kind, id),
			g = ExternalCatalog.groupOf(key);
		if (!url) return [];
		const name = g ? (g.default === key ? g.name : `${g.name} (${key})`) : ExternalCatalog.name(key);
		return [buildElement('a', {class: cls, href: url, target: '_blank', rel: 'noopener'}, `${name} \u2197`)];
	});
}
