// A search combo box: a text field that, as a name is typed, lists the names the catalog already has that
// match it, to pick with the mouse or the arrow keys and Enter. The field stays a text field, so a new name is
// typed as before. A field of several names (authors, narrators: separated by commas) looks up the name the
// cursor is in, and picking one puts it in place of what was typed there. A name the catalog doesn't have yet
// is said to be new under the field, as saving adds it as a series or person of its own. The book form's
// author, series, narrator and publisher fields are ones (book.js).
import { buildElement, fillElement } from './store.js';
import {Text} from './modules/text.js';

// How many names the list shows at most; typing more narrows it down.
export const COMBO_MAX = 8;

/**
 * The names matching what was typed, best first: those starting with it, then those with a word starting
 * with it, then those holding it anywhere; accents, case and punctuation don't count (Text.norm). Names in
 * `skip` (the field's other names) are left out, and so is the list when all it holds is what was typed.
 * @param {string[]} names
 * @param {string} typed
 * @param {string[]} [skip]
 * @returns {string[]}
 */
export function matchingNames(names, typed, skip = []){
	const q = Text.norm(typed);
	if(!q) return [];
	const left = new Set(skip.map(x=> Text.norm(x)));
	/** @type {[number, string][]} */
	const ranked = [];
	for(const name of names){
		const n = Text.norm(name);
		if(left.has(n)) continue;
		const rank = n.startsWith(q) ? 0 : (' ' + n).includes(' ' + q) ? 1 : n.includes(q) ? 2 : -1;
		if(rank >= 0) ranked.push([rank, name]);
	}
	ranked.sort((x, y)=> x[0] - y[0] || x[1].localeCompare(y[1]));
	const found = ranked.slice(0, COMBO_MAX).map(([, name])=> name);
	return found.length === 1 && Text.norm(found[0]) === q ? [] : found;
}

/**
 * Where the name the cursor is in sits in a field of names separated by commas (or semicolons): [start, end].
 * @param {string} text
 * @param {number} at the cursor
 * @returns {[number, number]}
 */
export function namePart(text, at){
	const before = text.slice(0, at), after = text.slice(at);
	const start = Math.max(before.lastIndexOf(','), before.lastIndexOf(';')) + 1;
	const stop = after.search(/[,;]/);
	return [start, stop < 0 ? text.length : at + stop];
}

/**
 * What a field says is new: which kind (its noun, and its plural) and whether the names are read yet.
 * @typedef {{nouns: [string, string], ready: () => boolean}} NewNote
 */

/**
 * The names in a field (one, or several separated by commas) that are not among `names`, as they will be saved.
 * @param {string[]} names
 * @param {string} value
 * @param {boolean} multiple
 * @returns {string[]}
 */
export function newNames(names, value, multiple){
	const known = new Set(names);
	const typed = multiple ? Text.splitNames(value) : [Text.tidy(value)].filter(Boolean);
	return typed.filter(name=> !known.has(name));
}

// The notes of the fields on the page, by the field's id, so refreshNewNotes() can redraw them.
/** @type {Map<string, () => void>} */
const NOTES = new Map();

// Redraw every field's note: once the names are read, or after the form filled its fields in.
export function refreshNewNotes(){ for(const draw of NOTES.values()) draw(); }

/**
 * Make `input` a combo box over `names()`, its list in `list` (a <ul> with an id, below the field). Picking a name
 * puts it in the field and calls `onPick` with the field's new text (as typing would have changed it). With
 * `note` (an element below the field) and `newNote`, it says which names typed the catalog doesn't have.
 * @param {HTMLInputElement} input
 * @param {HTMLElement} list
 * @param {{names: () => string[], multiple?: boolean, onPick?: (value: string) => void, note?: HTMLElement, newNote?: NewNote}} options
 */
export function comboBox(input, list, {names, multiple = false, onPick, note, newNote}){
	const listId = list.id;
	input.setAttribute('role', 'combobox');
	input.setAttribute('aria-autocomplete', 'list');
	input.setAttribute('aria-controls', listId);
	input.setAttribute('aria-expanded', 'false');
	input.setAttribute('autocomplete', 'off');
	list.setAttribute('role', 'listbox');
	list.classList.add('comboList');
	/** @type {string[]} */
	let shown = [];
	let active = -1;

	/** @returns {[number, number]} where the name being typed is */
	const part = ()=> multiple ? namePart(input.value, input.selectionStart ?? input.value.length) : [0, input.value.length];

	function draw(){
		input.setAttribute('aria-expanded', String(shown.length > 0));
		if(active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
		else input.removeAttribute('aria-activedescendant');
		list.hidden = !shown.length;
		fillElement(list, shown.map((name, j)=> buildElement('li', {id: `${listId}-${j}`, role: 'option', 'aria-selected': String(j === active),
			class: j === active && 'active',
			// keeps the focus in the field, so it isn't left (which closes the list) before the click
			onmousedown: (/** @type {Event} */ e)=> e.preventDefault(),
			onclick: ()=> pick(name)}, name)));
	}

	function close(){
		if(!shown.length && active < 0) return;
		shown = []; active = -1;
		draw();
	}

	// what the cursor is in, looked up
	function search(){
		const [start, end] = part();
		const typed = input.value.slice(start, end);
		const others = multiple ? Text.splitNames(input.value.slice(0, start) + ',' + input.value.slice(end)) : [];
		shown = matchingNames(names(), typed, others);
		active = -1;
		draw();
	}

	/** @param {string} name */
	function pick(name){
		const [start, end] = part();
		const head = input.value.slice(0, start), tail = input.value.slice(end);
		// a name after a comma gets its space back; a field of several names is ready for the next one
		const before = head && !/\s$/.test(head) ? head + ' ' : head;
		const after = multiple && !tail.trim() ? ', ' : tail;
		input.value = before + name + after;
		const at = (before + name).length + (after === tail ? 0 : after.length);
		if(typeof input.setSelectionRange === 'function') input.setSelectionRange(at, at);
		close();
		if(onPick) onPick(input.value);
		drawNote();
		input.focus();
	}

	function drawNote(){
		if(!note || !newNote) return;
		const added = newNote.ready() ? newNames(names(), input.value, multiple) : [];
		note.hidden = !added.length;
		note.textContent = added.length ? `New ${newNote.nouns[added.length > 1 ? 1 : 0]}: ${added.join(', ')}, added to the catalog when this is saved.` : '';
	}
	if(note && newNote){
		note.classList.add('comboNew');
		NOTES.set(input.id, drawNote);
		input.addEventListener('input', drawNote);
		drawNote();
	}

	input.addEventListener('input', search);
	input.addEventListener('keydown', e=>{
		const key = /** @type {KeyboardEvent} */ (e).key;
		if(key === 'ArrowDown' || key === 'ArrowUp'){
			if(!shown.length){ if(key === 'ArrowDown') search(); return; }
			e.preventDefault();
			active = key === 'ArrowDown' ? (active + 1) % shown.length : active <= 0 ? shown.length - 1 : active - 1;
			draw();
		}else if(key === 'Enter' && active >= 0 && shown[active]){
			e.preventDefault();   // not the form's Save
			pick(shown[active]);
		}else if(key === 'Escape' && shown.length){
			e.preventDefault();
			close();
		}
	});
	input.addEventListener('blur', close);
	list.hidden = true;
}

/**
 * A field that is a combo box, built: the field and its list (its id and "List") in a <div class="combo">,
 * and with `newNote` the note below it (its id and "New").
 * @param {HTMLInputElement} input with an id
 * @param {{names: () => string[], multiple?: boolean, onPick?: (value: string) => void, newNote?: NewNote}} options
 * @returns {HTMLDivElement}
 */
export function comboField(input, options){
	const list = buildElement('ul', {id: input.id + 'List'});
	const note = options.newNote ? buildElement('p', {id: input.id + 'New'}) : undefined;
	const wrap = buildElement('div', {class: 'combo'}, input, list, note);
	comboBox(input, list, {...options, note});
	return wrap;
}
