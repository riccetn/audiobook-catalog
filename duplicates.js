// The duplicates page: books that look like one title entered twice (the way an import would match
// them; see findDuplicates), plus a pair picked by hand with the merge button on the catalogue page
// (duplicates.html#merge=3,7). Merging keeps one entry, with the title, author, narrator and series you
// pick, and every genre, date read and edition of the others; the rest are removed without excluding
// them from imports (the kept book carries their ids, so an import finds it). Pairs marked
// "Not duplicates" are remembered in this browser (store.js).
let DUP_GROUPS = [];           // groups of DATA indexes shown
let DUP_PICKS = [];            // per group: which book's title, author, narrator and series to keep
let DUP_MANUAL = null;         // the pair picked by hand, until it is merged or kept apart
let DUP_FOUND = 0;             // how many of DUP_GROUPS findDuplicates found (the rest is DUP_MANUAL)

const DUP_FIELDS = [['t', 'Title'], ['a', 'Author'], ['n', 'Narrator'], ['series', 'Series']];
const dupValue = (b, f)=> f === 'series' ? (b.s ? b.s + (b.sn ? ` #${b.sn}` : '') : '') : (b[f] || '');

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
  renderDuplicates();
}

function renderDuplicates(){
  document.getElementById('subtitle').textContent = DUP_FOUND
    ? `${DUP_FOUND} possible duplicate${DUP_FOUND === 1 ? '' : 's'} among ${DATA.length} audiobooks`
    : `No duplicates among ${DATA.length} audiobooks`;
  if(!DUP_GROUPS.length){
    document.getElementById('dupBody').innerHTML = '<p class="empty">No books look like duplicates. To merge two books anyway, ' +
      'press &#8644; on one of them in the catalogue and then on the other.</p>';
    return;
  }
  let html = '';
  DUP_GROUPS.forEach((idx, g)=>{
    const books = idx.map(i=> DATA[i]);
    const merged = CatalogImport.mergeBooks(books, DUP_PICKS[g]);
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
    html += `</div><p class="dup-result">Becomes: ${esc(merged.t)} — ${esc(merged.a)}` +
      (merged.s ? ` — ${esc(dupValue(merged, 'series'))}` : '') +
      (editions ? `, ${editions} edition${editions === 1 ? '' : 's'}` : '') +
      (readDates(merged).length ? `, read ${esc(readDates(merged).join(', '))}` : '') + '</p>';
    html += `<div class="formbtns"><button type="button" class="save dup-merge" data-g="${g}">Merge into one</button>` +
      `<button type="button" class="dup-apart" data-g="${g}">Not duplicates</button></div></div>`;
  });
  document.getElementById('dupBody').innerHTML = html;
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
function mergeGroup(g){
  const idx = DUP_GROUPS[g];
  if(!idx) return;
  const merged = CatalogImport.mergeBooks(idx.map(i=> DATA[i]), DUP_PICKS[g]);
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
  DATA = data;
  forgetManualPair();            // its indexes are stale now
  refreshPage(); persist();
  showIoStatus(`Merged ${idx.length} entries into ${merged.t}.` + keepHint('data/books.json'));
}

// Remember that the books of group `g` are different books, in this browser.
function keepApart(g){
  const books = (DUP_GROUPS[g] || []).map(i=> DATA[i]);
  books.forEach((x, k)=> books.slice(k + 1).forEach(y=> NOT_DUPLICATES.add(CatalogImport.duplicatePairKey(x, y))));
  try{ localStorage.setItem(NOT_DUP_KEY, JSON.stringify([...NOT_DUPLICATES])); }catch(e){}
  if(DUP_MANUAL && DUP_MANUAL.join() === (DUP_GROUPS[g] || []).join()) forgetManualPair();
  refreshPage(); updateNav();
}

const READY = startPage(()=>{ DUP_MANUAL = manualPair(); refreshPage(); });
