// What every page draws with: its own text in the spelling the browser prefers, elements built with the DOM API
// (never HTML strings), the page's elements by id, and the status line.
import {Text} from './modules/text.js';
import type {Phrase, PhraseValue} from './modules/text.js';

// British spelling ("catalogue") when the browser's first English language is a British one, else American.
const BRITISH = (() => {
	try {
		return Text.prefersBritish(navigator.languages || [navigator.language]);
	} catch {
		return false;
	}
})();

/**
 * The page's own text in the spelling this browser prefers (see BRITISH). Every text a page shows goes through
 * it but a book's title, a name or other data, which is never respelled: a sentence holding one is a template,
 * with a `{marker}` where each value goes and the values in `values`, filled in as they are (Text.filled). Never
 * piece a sentence together from parts around a value: the whole sentence is one template. A module's message
 * is a Phrase, its template and values together (Text.phrase), spelled the same way; a value may be one too.
 * Without `values` a text is only respelled, braces and all (the page's own HTML).
 */
export function spell(template: string | Phrase, values?: Record<string, PhraseValue>): string {
	return values || typeof template !== 'string'
		? Text.filled(template, BRITISH, values)
		: Text.spelled(template, BRITISH);
}

/**
 * A template's sentence as children for buildElement() or fillElement() (see spell), where a value may be an
 * element too: spellParts('No books yet. {add} or import some.', {add: buildElement('a', {href}, spell('Add one'))}).
 */
export function spellParts(template: string | Phrase, values: Record<string, Child | Phrase> = {}): Child[] {
	return Text.templateParts<Child>(template, BRITISH, values);
}

/**
 * The first three of `items`, saying how many more there are: "a, b, c and 2 more", spelled (see spell):
 * Text.firstThree for the page.
 */
export function firstThree(items: string[], separator: string = ', '): string {
	const shown = items.slice(0, 3).join(separator);
	return items.length > 3 ? spell('{items} and {count} more', {items: shown, count: items.length - 3}) : shown;
}

/**
 * A count with its word, "1 book", "3 books", spelled (see spell): Text.plural for the page.
 */
export function plural(n: number, word: string, many?: string): string {
	return spell(Text.plural(n, word, many));
}

// Attributes of the page's own elements that hold text a reader sees.
const TEXT_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

/**
 * Respell the text in `node` and below, in place (see spell).
 */
function respell(node: Node) {
	for (const child of node.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) child.nodeValue = spell(child.nodeValue || '');
		else if (child.nodeType === Node.ELEMENT_NODE) {
			const el = child as Element;
			for (const name of TEXT_ATTRIBUTES) {
				const value = el.getAttribute(name);
				if (value !== null) el.setAttribute(name, spell(value));
			}
			respell(el);
		}
	}
}

// The page as written is American, so respell it before the page's module finds its elements and
// fills them in; at this point it holds only the page's own text.
if (BRITISH) {
	document.title = spell(document.title);
	respell(document.body);
}

/**
 * Something to put in an element: an element, or text (always as text, never read as HTML). Null, undefined,
 * false and '' stand for nothing, so a part shown only sometimes can be `cond && buildElement(...)`; lists are flattened.
 */
export type Child = Node | string | number | null | undefined | false | Child[];

/**
 * The nodes and text of `children`, flattened, without the empty ones.
 */
export function nodes(children: Child[]): (Node | string)[] {
	const out: (Node | string)[] = [];
	for (const c of children) {
		if (Array.isArray(c)) out.push(...nodes(c));
		else if (c !== null && c !== undefined && c !== false && c !== '')
			out.push(typeof c === 'number' ? String(c) : c);
	}
	return out;
}

/**
 * A new element: buildElement('a', {class: 'srow-title', href}, name). Attributes are set as given: null, undefined
 * and false leave one out, true sets it empty (checked); a function under an on... name listens to that
 * event (onclick: fn). The children go in in order (see Child).
 */
export function buildElement<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number | boolean | null | undefined | ((e: Event) => void)> = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) {
		if (typeof value === 'function') el.addEventListener(name.slice(2), value);
		else if (value === true) el.setAttribute(name, '');
		else if (value !== null && value !== undefined && value !== false) el.setAttribute(name, String(value));
	}
	el.append(...nodes(children));
	return el;
}

/**
 * Replace what `el` holds with `children` (see Child).
 */
export function fillElement(el: Element, ...children: Child[]) {
	el.replaceChildren(...nodes(children));
}

/**
 * `items` with `separator` between each two, as children for buildElement() or fillElement(): links joined with ', '.
 */
export function joined(items: Child[], separator: string): Child[] {
	return items.flatMap((x, i) => (i ? [separator, x] : [x]));
}

let ioStatusTimer: ReturnType<typeof setTimeout> | undefined;

/** How long the status line shows a message, and so how long its Undo can be pressed. */
export const STATUS_TIME = 5000;

/**
 * Say something on the status line for a few seconds; `isErr` shows it as an error, which stays (with a
 * Dismiss button) until the next message, as it may say something wasn't saved. With `undo`, the line has
 * an Undo button that runs it and clears the line.
 */
export function showIoStatus(msg: string, isErr?: boolean, undo?: () => void) {
	const el = byId('ioStatus');
	const clear = () => {
		clearTimeout(ioStatusTimer);
		fillElement(el);
	};
	fillElement(
		el,
		msg,
		undo && [
			' ',
			buildElement(
				'button',
				{
					type: 'button',
					class: 'undo',
					onclick: () => {
						clear();
						undo();
					},
				},
				spell('Undo'),
			),
		],
		isErr && [' ', buildElement('button', {type: 'button', class: 'dismiss', onclick: clear}, spell('Dismiss'))],
	);
	el.classList.toggle('err', !!isErr);
	clearTimeout(ioStatusTimer);
	if (!isErr) ioStatusTimer = setTimeout(clear, STATUS_TIME);
}

/**
 * The page's element with this id. Throws when there is none, which is a mistake in the page.
 */
export function byId(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) throw new Error(`the page has no #${id}`);
	return el;
}

export type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * The page's form field (an <input>, <select> or <textarea>) with this id, for its value; byId() for anything else.
 */
export function fieldById(id: string): FormField {
	return byId(id) as FormField;
}
