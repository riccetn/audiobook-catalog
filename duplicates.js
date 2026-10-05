// The duplicates page: books that look like one title entered twice (the way an import would match
// them; see findDuplicates), plus a pair picked by hand with the merge button on the catalogue page
// (duplicates.html#merge=3,7). Merging keeps one entry, with the title, author and series you
// pick, and every genre, date read and edition of the others; the rest are removed without excluding
// them from imports (the kept book carries their ids, so an import finds it). Pairs marked
// "Not duplicates" are remembered in this browser, in data/not-duplicates.txt with `make serve`, and in backups (store.js).
// The editions of the merged entries become one edition when none disagree on an ASIN or Goodreads id
// (one book imported from both Audible and Goodreads), unless you untick that. Books merged before
// that, whose editions still look like one, are listed below the duplicates to be joined the same way.
import * as CatalogImport from './importers.js';
import { DATA, SERIES_INFO, setData, DISK_SAVE, NOT_DUPLICATES, addNotDuplicates, readDates, esc, updateNav, persist, keepHint, showIoStatus, startPage } from './store.js';

export let DUP_GROUPS = [];           // groups of DATA indexes shown
export let DUP_PICKS = [];            // per group: which book's title, author and series to keep
export let DUP_MANUAL = null;         // the pair picked by hand, until it is merged or kept apart
let DUP_FOUND = 0;             // how many of DUP_GROUPS findDuplicates found (the rest is DUP_MANUAL)
export let SPLIT = [];                // indexes of books whose editions look like one edition recorded twice

const DUP_FIELDS = [['t', 'Title'], ['a', 'Author'], ['series', 'Series']];   // narrators are on the editions, which are all kept
const dupValue = (b, f)=> f === 'series' ? (b.s ? b.s + (b.sn ? ` #${b.sn}` : '') : '') : f === 'a' ? CatalogImport.namesText(b.a) : (b[f] || '');

// The pair in the address (#merge=3,7), if it names two books.
function manualPair(){
  const m = /^#merge=(\d+),(\d+)$/.exec(location.hash || '');
  if(!m) return null;
  const pair = [parseInt(m[1], 10), parseInt(m[2], 10)];
  return pair[0] !== pair[1] && pair.every(i=> i < DATA.length) ? pair : null;
}

function forgetManualPair(){
  DUP_MANUAL = null;
  try{ history.replaceState(null, '', location.pathname); }catch(e){}
}

// Find the groups again (DATA changed), keeping the choices made for a group that is still there.
function refreshPage(){
  const found = CatalogImport.findDuplicates(DATA, NOT_DUPLICATES);
  const manual = DUP_MANUAL && !found.some(g=> DUP_MANUAL.every(i=> g.includes(i))) ? [DUP_MANUAL] : [];
  const groups = [...manual, ...found];
  DUP_FOUND = found.length;
  const before = new Map(DUP_GROUPS.map((g, k)=> [g.join(','), DUP_PICKS[k]]));
  DUP_GROUPS = groups;
  DUP_PICKS = groups.map(g=> before.get(g.join(',')) || {});
  SPLIT = CatalogImport.splitEditions(DATA, NOT_DUPLICATES);
  renderDuplicates();
}

// Whether any of `editions` is also on a book outside `idx` (a box set): joining it would change those too.
function sharedOutside(editions, idx){
  return DATA.some((b, i)=> !idx.includes(i) &&
    CatalogImport.bookEditions(b).some(x=> editions.some(ed=> CatalogImport.sameEdition(x, ed))));
}

// The choices for group `g`, with joinEditions on by default when the editions can be joined.
function groupPicks(g){
  const idx = DUP_GROUPS[g], picks = DUP_PICKS[g];
  const separate = CatalogImport.bookEditions(CatalogImport.mergeBooks(idx.map(i=> DATA[i]), {...picks, joinEditions: false}));
  const joinable = CatalogImport.editionsJoinable(separate) && !sharedOutside(separate, idx);
  return {...picks, joinable, joinEditions: joinable && picks.joinEditions !== false};
}

const editionLines = rec=> CatalogImport.bookEditions(rec).map(ed=> `<div class="dup-extra">${esc(CatalogImport.formatEdition(ed))}</div>`).join('');

function renderSplit(){
  if(!SPLIT.length) return '';
  let html = '<h2 class="dup-heading">Editions that look like one</h2>' +
    '<p class="hint">These books have editions that don\'t disagree on an ASIN or Goodreads id, such as one from Audible and one from Goodreads.</p>';
  SPLIT.forEach(i=>{
    const b = DATA[i];
    const joined = CatalogImport.joinEditions(CatalogImport.bookEditions(b));
    html += `<div class="dup-group"><div class="dup-books"><div class="dup-book">` +
      `<div class="dup-field"><span class="dup-label">Title</span> ${esc(b.t)}</div>` +
      `<div class="dup-field"><span class="dup-label">Author</span> ${esc(CatalogImport.namesText(b.a))}</div>${editionLines(b)}</div></div>` +
      `<p class="dup-result">Becomes one edition: ${esc(CatalogImport.formatEdition(joined))}</p>` +
      `<div class="formbtns"><button type="button" class="save split-join" data-i="${i}">Make one edition</button>` +
      `<button type="button" class="split-apart" data-i="${i}">Keep separate</button></div></div>`;
  });
  return html;
}

export function renderDuplicates(){
  document.getElementById('subtitle').textContent = (DUP_FOUND
    ? `${DUP_FOUND} possible duplicate${DUP_FOUND === 1 ? '' : 's'} among ${DATA.length} audiobooks`
    : `No duplicates among ${DATA.length} audiobooks`) +
    (SPLIT.length ? `; ${SPLIT.length} book${SPLIT.length === 1 ? '' : 's'} with editions that look like one` : '');
  let html = DUP_GROUPS.length ? '' : '<p class="empty">No books look like duplicates. To merge two books anyway, ' +
    'press &#8644; on one of them in the catalogue and then on the other.</p>';
  DUP_GROUPS.forEach((idx, g)=>{
    const books = idx.map(i=> DATA[i]);
    const picks = groupPicks(g);
    const merged = CatalogImport.mergeBooks(books, picks);
    html += `<div class="dup-group">${DUP_MANUAL && g === 0 && DUP_MANUAL.join() === idx.join() ? '<p class="dup-note">Picked by hand</p>' : ''}<div class="dup-books">`;
    books.forEach((b, k)=>{
      html += '<div class="dup-book">';
      DUP_FIELDS.forEach(([f, label])=>{
        const value = dupValue(b, f);
        if(!value) return;
        const choices = new Set(books.map(x=> dupValue(x, f)).filter(Boolean));
        const line = `<span class="dup-label">${label}</span> ${esc(value)}`;
        if(choices.size < 2){ html += `<div class="dup-field">${line}</div>`; return; }
        const checked = dupValue(merged, f) === value && books.findIndex(x=> dupValue(x, f) === value) === k;
        html += `<label class="dup-field dup-choice"><input type="radio" name="dup-${g}-${f}" data-g="${g}" data-f="${f}" data-k="${k}"${checked ? ' checked' : ''}> ${line}</label>`;
      });
      const extra = [
        (b.g || []).length ? esc(b.g.join(', ')) : '',
        readDates(b).length ? 'Read ' + esc(readDates(b).join(', ')) : '',
        ...CatalogImport.bookEditions(b).map(ed=> esc(CatalogImport.formatEdition(ed))),
      ].filter(Boolean);
      html += extra.map(x=> `<div class="dup-extra">${x}</div>`).join('') + '</div>';
    });
    const editions = CatalogImport.bookEditions(merged).length;
    html += `</div><p class="dup-result">Becomes: ${esc(merged.t)} — ${esc(CatalogImport.namesText(merged.a))}` +
      (merged.s ? ` — ${esc(dupValue(merged, 'series'))}` : '') +
      (editions ? `, ${editions} edition${editions === 1 ? '' : 's'}` : '') +
      (readDates(merged).length ? `, read ${esc(readDates(merged).join(', '))}` : '') + '</p>' + editionLines(merged);
    if(picks.joinable){
      html += `<label class="dup-join"><input type="checkbox" class="dup-joinbox" data-g="${g}"${picks.joinEditions ? ' checked' : ''}> ` +
        'Make the editions one edition (they don\'t disagree on an ASIN or Goodreads id)</label>';
    }
    html += `<div class="formbtns"><button type="button" class="save dup-merge" data-g="${g}">Merge into one</button>` +
      `<button type="button" class="dup-apart" data-g="${g}">Not duplicates</button></div></div>`;
  });
  html += renderSplit();
  document.getElementById('dupBody').innerHTML = html;
  document.querySelectorAll('#dupBody .dup-joinbox').forEach(input=>{
    input.addEventListener('change', e=>{
      DUP_PICKS[e.currentTarget.dataset.g].joinEditions = e.currentTarget.checked;
      renderDuplicates();
    });
  });
  document.querySelectorAll('#dupBody .split-join').forEach(btn=>{
    btn.addEventListener('click', e=> joinBookEditions(parseInt(e.currentTarget.dataset.i, 10)));
  });
  document.querySelectorAll('#dupBody .split-apart').forEach(btn=>{
    btn.addEventListener('click', e=> keepEditionsApart(parseInt(e.currentTarget.dataset.i, 10)));
  });
  document.querySelectorAll('#dupBody input[type=radio]').forEach(input=>{
    input.addEventListener('change', e=>{
      const {g, f, k} = e.currentTarget.dataset;
      DUP_PICKS[g][f] = parseInt(k, 10);
      renderDuplicates();
    });
  });
  document.querySelectorAll('#dupBody .dup-merge').forEach(btn=>{
    btn.addEventListener('click', e=> mergeGroup(parseInt(e.currentTarget.dataset.g, 10)));
  });
  document.querySelectorAll('#dupBody .dup-apart').forEach(btn=>{
    btn.addEventListener('click', e=> keepApart(parseInt(e.currentTarget.dataset.g, 10)));
  });
}

// Merge group `g` into its first book: on a copy of DATA, so nothing changes unless the result validates.
export function mergeGroup(g){
  const idx = DUP_GROUPS[g];
  if(!idx) return;
  const merged = CatalogImport.mergeBooks(idx.map(i=> DATA[i]), groupPicks(g));
  const data = JSON.parse(JSON.stringify(DATA));
  const keep = Math.min(...idx);
  // an edition a box set shares with other titles gets what the merged one gained there too
  CatalogImport.saveBook(data, keep, merged);
  idx.filter(i=> i !== keep).sort((x, y)=> y - x).forEach(i=> data.splice(i, 1));
  const errors = CatalogImport.validate(data, SERIES_INFO).errors.filter(e=> !e.startsWith('series-info'));
  if(errors.length){
    showIoStatus(`Couldn't merge ${merged.t}: ${errors[0]}`, true);
    return;
  }
  setData(data);
  forgetManualPair();            // its indexes are stale now
  refreshPage(); persist();
  showIoStatus(`Merged ${idx.length} entries into ${merged.t}.` + keepHint('data/books.json'));
}

// Remember that the books of group `g` are different books (see addNotDuplicates).
export function keepApart(g){
  const books = (DUP_GROUPS[g] || []).map(i=> DATA[i]);
  addNotDuplicates(books.flatMap((x, k)=> books.slice(k + 1).map(y=> CatalogImport.duplicatePairKey(x, y))));
  if(DUP_MANUAL && DUP_MANUAL.join() === (DUP_GROUPS[g] || []).join()) forgetManualPair();
  if(DISK_SAVE) persist(); else updateNav();      // a save takes the mark to data/not-duplicates.txt
  refreshPage();
}

// Make the editions of book `i` one edition (it is in SPLIT).
export function joinBookEditions(i){
  const b = DATA[i];
  if(!b || !CatalogImport.editionsJoinable(CatalogImport.bookEditions(b))) return;
  const data = JSON.parse(JSON.stringify(DATA));
  CatalogImport.saveBook(data, i, {...b, e: [CatalogImport.joinEditions(CatalogImport.bookEditions(b))]});
  const errors = CatalogImport.validate(data, SERIES_INFO).errors.filter(e=> !e.startsWith('series-info'));
  if(errors.length){
    showIoStatus(`Couldn't join the editions of ${b.t}: ${errors[0]}`, true);
    return;
  }
  setData(data);
  forgetManualPair();
  refreshPage(); persist();
  showIoStatus(`${b.t} now has one edition.` + keepHint('data/books.json'));
}

// Remember that the editions of book `i` are different editions (see addNotDuplicates).
export function keepEditionsApart(i){
  if(!DATA[i]) return;
  addNotDuplicates([CatalogImport.editionsKey(DATA[i])]);
  if(DISK_SAVE) persist(); else updateNav();      // a save takes the mark to data/not-duplicates.txt
  refreshPage();
}

export const READY = startPage(()=>{ DUP_MANUAL = manualPair(); refreshPage(); }, {refresh: refreshPage});
