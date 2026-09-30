const LS_KEY = 'audiobook-catalog-data';
// Served from the project root: your own catalogue in data/ if it exists, otherwise the bundled demo.
const DATA_DIRS = ['data/', 'data/sample/'];

let DATA = [];
let SERIES_INFO = {};
let BASELINE = '';
let INFO_BASELINE = '';        // same, for series-info.json
let STARTUP_NOTICE = '';
let VIEW = 'series';           // 'series' | 'library'
let SERIES_FILTER = null;      // series name, '__standalone__', or null
let EDIT_INDEX = null;         // index into DATA being edited, or null when adding new
let EXCLUSIONS = CatalogImport.parseExclusions('');   // data/excluded.txt: books imports must never re-add
let PENDING_IMPORT = null;     // records of a previewed CSV import awaiting confirmation
let EDIT_SERIES = null;        // name of the series whose info is being edited, or null
let DISK_SAVE = false;         // `make serve` saves edits straight to data/books.json and data/series-info.json
let SAVING = false;            // a save to disk is on its way
let SAVE_AGAIN = false;        // more edits came in while it was

// Filter value for books with no date read, in the "Read any time" select.
const UNDATED = '__undated__';

// Year a book was (last) read in, for the read filter: '2024' from ['2021-05', '2024-03-15'].
// Dates read of a book; [] when it has none (or something that is not a list of dates).
const readDates = b => Array.isArray(b.r) ? b.r.filter(d => typeof d === 'string') : [];
const readYears = b => readDates(b).map(d => d.slice(0, 4));

function uniqueSorted(arr){ return [...new Set(arr)].sort((a,b)=>a.localeCompare(b)); }

function populateFilters(){
  const authors = uniqueSorted(DATA.map(b=>b.a));
  const genres = uniqueSorted(DATA.flatMap(b=>b.g||[]));
  const aSel = document.getElementById('authorFilter');
  const gSel = document.getElementById('genreFilter');
  const rSel = document.getElementById('readFilter');
  const years = uniqueSorted(DATA.flatMap(readYears)).reverse();
  const aCur = aSel.value, gCur = gSel.value, rCur = rSel.value;
  aSel.innerHTML = '<option value="">All authors</option>' + authors.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('');
  gSel.innerHTML = '<option value="">All genres</option>' + genres.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join('');
  rSel.innerHTML = '<option value="">Read any time</option>' + years.map(y=>`<option value="${esc(y)}">Read in ${esc(y)}</option>`).join('')
    + `<option value="${UNDATED}">No date read</option>`;
  aSel.value = aCur; gSel.value = gCur; rSel.value = rCur;
}

function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function matches(b, q, author, genre, read){
  if(SERIES_FILTER){
    if(SERIES_FILTER === '__standalone__'){ if(b.s) return false; }
    else if(b.s !== SERIES_FILTER) return false;
  }
  if(author && b.a !== author) return false;
  if(genre && !(b.g||[]).includes(genre)) return false;
  if(read === UNDATED){ if(readDates(b).length) return false; }
  else if(read && !readYears(b).includes(read)) return false;
  if(q){
    const hay = [b.t,b.a,b.n,b.s,...(b.g||[])].filter(Boolean).join(' ').toLowerCase();
    if(!hay.includes(q.toLowerCase())) return false;
  }
  return true;
}

function setView(v){
  VIEW = v;
  document.getElementById('btnSeriesView').classList.toggle('active', v==='series');
  document.getElementById('btnLibraryView').classList.toggle('active', v==='library');
  const showLibControls = v === 'library';
  document.getElementById('authorFilter').style.display = showLibControls ? '' : 'none';
  document.getElementById('genreFilter').style.display = showLibControls ? '' : 'none';
  document.getElementById('readFilter').style.display = showLibControls ? '' : 'none';
  document.getElementById('toggleAdd').style.display = showLibControls ? '' : 'none';
  const crumb = document.getElementById('crumb');
  if(v === 'library' && SERIES_FILTER){
    crumb.classList.add('show');
    document.getElementById('crumbLabel').textContent =
      SERIES_FILTER === '__standalone__' ? 'Standalone books' : SERIES_FILTER;
  } else {
    crumb.classList.remove('show');
  }
  render();
}

function openSeries(name){
  SERIES_FILTER = name;
  setView('library');
}

function render(){
  if(VIEW === 'series'){ renderSeriesOverview(); return; }

  const q = document.getElementById('q').value.trim();
  const author = document.getElementById('authorFilter').value;
  const genre = document.getElementById('genreFilter').value;
  const read = document.getElementById('readFilter').value;
  const filtered = DATA.map((b,i)=>({...b, _i:i})).filter(b=>matches(b,q,author,genre,read));

  document.getElementById('subtitle').textContent =
    `${DATA.length} audiobooks, merged from your Audible library and Goodreads history`;
  document.getElementById('resultCount').textContent = `${filtered.length} shown`;

  const groups = {};
  const standalone = [];
  filtered.forEach(b=>{
    if(b.s){ (groups[b.s] = groups[b.s]||[]).push(b); }
    else standalone.push(b);
  });

  const seriesNames = Object.keys(groups).sort((a,b)=>a.localeCompare(b));
  let html = '';

  if(filtered.length === 0){
    html = '<p class="empty">No books match. Try clearing a filter.</p>';
  }

  seriesNames.forEach(name=>{
    const books = groups[name].sort((a,b)=> (parseFloat(a.sn)||0) - (parseFloat(b.sn)||0));
    const info = SERIES_INFO[name];
    let head = `<p class="series-title">${esc(name)} <span class="n">${books.length} owned</span>`;
    head += ` ${seriesEditButton(name)}`;
    if(info){
      head += ` <span class="status ${info.status}">${info.status === 'complete' ? 'complete' : 'ongoing'}</span>`;
      if(info.url){
        head += ` <a class="authorlink" href="${esc(info.url)}" target="_blank" rel="noopener">author site \u2197</a>`;
      }
    }
    head += '</p>';
    if(info){
      head += `<p class="series-note">${esc(info.total)} released total \u2014 ${esc(info.note)}</p>`;
    }
    html += `<div class="series-group">${head}`;
    books.forEach(b=> html += bookCard(b));
    html += '</div>';
  });

  if(standalone.length){
    standalone.sort((a,b)=>a.t.localeCompare(b.t));
    html += `<div class="series-group"><p class="series-title">Standalone <span class="n">${standalone.length} book${standalone.length>1?'s':''}</span></p>`;
    standalone.forEach(b=> html += bookCard(b));
    html += '</div>';
  }

  document.getElementById('results').innerHTML = html;
  document.querySelectorAll('.iconbtn.del').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const el = e.currentTarget;
      const i = parseInt(el.dataset.i,10);
      if(el.dataset.confirm === '1'){
        DATA.splice(i,1);
        if(EDIT_INDEX === i){ closeForm(); }
        populateFilters(); render(); persist();
      } else {
        el.dataset.confirm = '1';
        el.innerHTML = '&check;';
        el.title = 'Click again to confirm removal';
        el.style.color = '#b0453f';
        clearTimeout(el._resetTimer);
        el._resetTimer = setTimeout(()=>{
          el.dataset.confirm = '';
          el.innerHTML = '&times;';
          el.title = 'Remove';
          el.style.color = '';
        }, 3000);
      }
    });
  });
  document.querySelectorAll('.iconbtn.edit').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const i = parseInt(e.currentTarget.dataset.i,10);
      openEditForm(i);
    });
  });
  bindSeriesEditButtons();
}

function renderSeriesOverview(){
  const q = document.getElementById('q').value.trim().toLowerCase();
  const groups = {};
  let standaloneCount = 0;
  DATA.forEach(b=>{
    if(b.s){ (groups[b.s] = groups[b.s]||[]).push(b); }
    else standaloneCount++;
  });

  let seriesNames = Object.keys(groups).sort((a,b)=>a.localeCompare(b));
  if(q){
    seriesNames = seriesNames.filter(name=>{
      const books = groups[name];
      const hay = [name, ...books.map(b=>b.a)].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  document.getElementById('subtitle').textContent =
    `${Object.keys(groups).length} series across ${DATA.length} audiobooks \u2014 tap a series to see its titles`;
  document.getElementById('resultCount').textContent = `${seriesNames.length} series shown`;

  let html = '';
  if(seriesNames.length === 0 && !(!q || 'standalone'.includes(q))){
    html = '<p class="empty">No series match your search.</p>';
  }

  seriesNames.forEach(name=>{
    const books = groups[name];
    const authors = uniqueSorted(books.map(b=>b.a));
    const info = SERIES_INFO[name];
    html += `<div class="srow"><div class="srow-head">
      <button class="srow-title" data-series="${esc(name)}">${esc(name)}</button>
      <span class="srow-owned">${books.length} owned${info ? ' of ' + esc(info.total) : ''}</span>
      ${seriesEditButton(name)}
    </div>`;
    let foot = `<div class="srow-foot"><span class="tag">${esc(authors.join(', '))}</span>`;
    if(info){
      foot += ` <span class="status ${info.status}">${info.status === 'complete' ? 'complete' : 'ongoing'}</span>`;
      if(info.url) foot += ` <a class="authorlink" href="${esc(info.url)}" target="_blank" rel="noopener">author site \u2197</a>`;
    }
    foot += '</div>';
    html += foot;
    if(info && info.note !== '') html += `<p class="srow-note">${esc(info.note)}</p>`;
    html += '</div>';
  });

  if(!q || 'standalone'.includes(q)){
    html += `<div class="srow"><div class="srow-head">
      <button class="srow-title" data-series="__standalone__">Standalone</button>
      <span class="srow-owned">${standaloneCount} owned</span>
    </div></div>`;
  }

  document.getElementById('results').innerHTML = html;
  document.querySelectorAll('.srow-title').forEach(btn=>{
    btn.addEventListener('click', e=> openSeries(e.currentTarget.dataset.series));
  });
  bindSeriesEditButtons();
}

// ------------------------------------------------------------------ series info
// Edits the series' entry in series-info.json (released total, status, note, author site). Like book
// edits, it is saved to disk by `make serve` (see persist).
function seriesEditButton(name){
  const label = SERIES_INFO[name] ? 'Edit series info' : 'Add series info';
  return `<button class="iconbtn sedit" data-series="${esc(name)}" title="${label}" aria-label="${label}">&#9998;</button>`;
}

function bindSeriesEditButtons(){
  document.querySelectorAll('.iconbtn.sedit').forEach(btn=>{
    btn.addEventListener('click', e=> openSeriesForm(e.currentTarget.dataset.series));
  });
}

function openSeriesForm(name){
  closeForm();
  const info = SERIES_INFO[name];
  EDIT_SERIES = name;
  document.getElementById('seriesFormTitle').textContent = (info ? 'Series info: ' : 'Add series info: ') + name;
  document.getElementById('sf_total').value = info ? String(info.total) : '';
  document.getElementById('sf_status').value = info ? info.status : 'ongoing';
  document.getElementById('sf_note').value = info ? info.note || '' : '';
  document.getElementById('sf_url').value = info ? info.url || '' : '';
  document.getElementById('seriesFormError').textContent = '';
  document.getElementById('seriesRemoveBtn').style.display = info ? '' : 'none';
  const form = document.getElementById('seriesForm');
  form.classList.add('open');
  form.scrollIntoView({behavior:'smooth', block:'center'});
}

function closeSeriesForm(){
  EDIT_SERIES = null;
  document.getElementById('seriesForm').classList.remove('open');
  document.getElementById('seriesForm').reset();
  document.getElementById('seriesFormError').textContent = '';
}

function saveSeriesForm(){
  const name = EDIT_SERIES;
  if(name === null) return;
  const totalText = document.getElementById('sf_total').value.trim();
  const entry = {
    total: /^\d+$/.test(totalText) ? parseInt(totalText, 10) : totalText.toLowerCase(),
    status: document.getElementById('sf_status').value,
    note: CatalogImport.tidyText(document.getElementById('sf_note').value),
  };
  const url = document.getElementById('sf_url').value.trim();
  if(url) entry.url = url;
  // the same rules as `make validate`, applied to just this series
  const {errors} = CatalogImport.validate(DATA, {[name]: entry});
  const problems = errors.filter(e=> e.startsWith('series-info')).map(e=> e.replace(/^series-info(\[[^\]]*\])?: /, ''));
  if(problems.length){
    document.getElementById('seriesFormError').textContent = problems.join('; ');
    return;
  }
  SERIES_INFO = {...SERIES_INFO, [name]: entry};
  closeSeriesForm(); render(); persist();
  showIoStatus(`Saved series info for ${name}.` + keepHint('data/series-info.json'));
}

function removeSeriesInfo(){
  const name = EDIT_SERIES;
  if(name === null || !SERIES_INFO[name]) return;
  const {[name]: _removed, ...rest} = SERIES_INFO;
  SERIES_INFO = rest;
  closeSeriesForm(); render(); persist();
  showIoStatus(`Removed series info for ${name}.`);
}

document.getElementById('seriesForm').addEventListener('submit', e=>{ e.preventDefault(); saveSeriesForm(); });
document.getElementById('seriesRemoveBtn').addEventListener('click', removeSeriesInfo);
document.getElementById('cancelSeries').addEventListener('click', closeSeriesForm);

function bookCard(b){
  const num = b.sn ? `<div class="num">${esc(b.sn)}</div>` : '<div class="num">&bull;</div>';
  const meta = [b.a, b.n ? 'narr. '+b.n : null].filter(Boolean).join(' \u2014 ');
  const genres = (b.g||[]).map(g=>`<span class="tag">${esc(g)}</span>`).join('');
  const read = readDates(b).length ? `<div class="read">Read ${esc(readDates(b).join(', '))}</div>` : '';
  return `<div class="book">${num}<div class="info">
    <div class="title">${esc(b.t)}</div>
    <div class="meta">${esc(meta)}</div>
    ${read}
    ${genres ? `<div class="genres">${genres}</div>` : ''}
  </div><div class="book-actions">
    <button class="iconbtn edit" data-i="${b._i}" title="Edit" aria-label="Edit">&#9998;</button>
    <button class="iconbtn del" data-i="${b._i}" title="Remove" aria-label="Remove">&times;</button>
  </div></div>`;
}

// Where edits go: with `make serve` and your own data/books.json, straight to disk (saveToDisk).
// Every edit is also kept in localStorage until the disk has it, so nothing is lost if a save fails
// (server stopped, or the files changed on disk meanwhile); with any other server, or the demo data,
// localStorage is all there is, and Export + `node catalog.js sync-export` bring edits back to data/.
function persist(){
  saveLocally();
  if(DISK_SAVE) saveToDisk();
}

function saveLocally(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify({base: BASELINE, data: DATA, infoBase: INFO_BASELINE, info: SERIES_INFO})); }catch(e){}
}

// The end of a status message about an edit: how to get it into the data file, unless that happens anyway.
function keepHint(file){
  return DISK_SAVE ? '' : ` Export and run sync-export to keep it in ${file}.`;
}

async function saveToDisk(){
  if(SAVING){ SAVE_AGAIN = true; return; }
  SAVING = true;
  SAVE_AGAIN = false;
  let res, body;
  try{
    res = await fetch('api/save', {
      method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({books: DATA, seriesInfo: SERIES_INFO, base: BASELINE, infoBase: INFO_BASELINE}),
    });
    body = await res.json();
  }catch(e){
    SAVING = false;
    showIoStatus('Not saved to disk (is `make serve` still running?). Your edits are kept in this browser.', true);
    return;
  }
  SAVING = false;
  if(!res.ok){
    const why = body.conflict
      ? 'data/books.json changed on disk since this page loaded it. Export your edits here, then reload the page.'
      : [body.error, ...(body.errors || [])].filter(Boolean).join('; ');
    showIoStatus(`Not saved to disk: ${why} Your edits are kept in this browser.`, true);
    return;
  }
  BASELINE = body.base;
  INFO_BASELINE = body.infoBase;
  if(SAVE_AGAIN){ saveLocally(); saveToDisk(); return; }
  // the disk has everything now (tidied the way sync-export tidies); the browser copy is no longer needed
  if(JSON.stringify(body.books) !== JSON.stringify(DATA)){ DATA = body.books; populateFilters(); render(); }
  try{ localStorage.removeItem(LS_KEY); }catch(e){}
  if(!document.getElementById('ioStatus').textContent) showIoStatus('Saved.');
}

// Whether the server saves edits (only `make serve`, and only to your own data/books.json).
async function detectDiskSave(dir){
  if(dir !== 'data/') return false;
  try{
    const res = await fetch('api/save', {cache: 'no-cache'});
    return res.ok && (await res.json()).writable === true;
  }catch(e){ return false; }
}

function showIoStatus(msg, isErr){
  const el = document.getElementById('ioStatus');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.textContent = ''; }, 5000);
}

function exportBackup(){
  const blob = new Blob([JSON.stringify({books: DATA, seriesInfo: SERIES_INFO}, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'audiobook-catalog-backup-' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showIoStatus('Backup downloaded.');
}

function importBackup(file){
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const {books, seriesInfo} = CatalogImport.readBackup(JSON.parse(e.target.result));
      const bad = books.some(b=> !b || typeof b !== 'object' || !b.t || !b.a);
      if(bad) throw new Error('missing title/author');
      DATA = books;
      if(seriesInfo) SERIES_INFO = seriesInfo;     // older backups have no series info: keep the current one
      populateFilters(); render(); persist();
      showIoStatus(`Imported ${books.length} books` + (seriesInfo ? ` and info for ${Object.keys(seriesInfo).length} series.` : '.'));
    }catch(err){
      showIoStatus("Couldn't read that file \u2014 make sure it's a catalogue backup JSON.", true);
    }
  };
  reader.readAsText(file);
}

// ------------------------------------------------------------ Audible / Goodreads CSV import
// The same pipeline as `node catalog.js import-audible|import-goodreads` (both use importers.js):
// read the export, merge it into a copy of the catalogue, show what would change, and only
// apply it when confirmed. Like every edit in the page, the result is then saved (see persist).
const IMPORTERS = {
  audible: {label: 'Audible', read: CatalogImport.readAudible},
  goodreads: {label: 'Goodreads', read: CatalogImport.readGoodreads},
};
let IMPORT_KIND = 'audible';

// Merge into a copy of DATA, so nothing changes until the result is known to be valid.
function mergeIntoCopy(records){
  const data = JSON.parse(JSON.stringify(DATA));
  const report = CatalogImport.merge(data, records, EXCLUSIONS);
  // series-info problems are not the import's doing (a series renamed in the page); only block on the books
  const errors = CatalogImport.validate(data, SERIES_INFO).errors.filter(e=> !e.startsWith('series-info'));
  return {data, report, errors};
}

function previewImport(kind, text, fileName){
  const importer = IMPORTERS[kind];
  const result = importer.read(text);
  const {report, errors} = mergeIntoCopy(result.records);
  const changes = report.added.length + report.backfilled.length + report.datesFilled.length;
  PENDING_IMPORT = errors.length || !changes ? null : result.records;

  const li = rec => {
    const series = rec.s ? `  [${rec.s}${rec.sn ? ' #' + rec.sn : ''}]` : '';
    return `<li>${esc(rec.t)} &mdash; ${esc(rec.a)}${esc(series)}</li>`;
  };
  let html = `<p>${result.records.length} finished book${result.records.length === 1 ? '' : 's'} read from ${esc(fileName)}</p>`;
  html += `<p>Already in the catalogue: ${report.matched}</p>`;
  if(result.skippedUnfinished) html += `<p>Not finished yet, skipped: ${result.skippedUnfinished}</p>`;
  if(report.backfilled.length) html += `<p>Audible ids filled in on existing books: ${report.backfilled.length}</p>`;
  if(report.datesFilled.length) html += `<p>Dates read filled in on existing books: ${report.datesFilled.length}</p>`;
  if(report.excluded.length) html += `<p>Skipped (listed in data/excluded.txt): ${report.excluded.length}</p>`;
  html += `<p>New: ${report.added.length}</p>`;
  if(report.added.length) html += `<ul>${report.added.map(li).join('')}</ul>`;
  if(result.warnings.length){
    html += `<p class="warn">Needs a look (${result.warnings.length}):</p><ul>${result.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`;
  }
  if(errors.length){
    html += `<p class="warn">Validation failed, nothing will be changed:</p><ul>${errors.slice(0, 10).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`;
  } else if(!changes){
    html += '<p>Nothing new to add.</p>';
  }

  document.getElementById('importPreviewTitle').textContent = `${importer.label} import`;
  document.getElementById('importPreviewBody').innerHTML = html;
  const confirmBtn = document.getElementById('importConfirm');
  confirmBtn.style.display = PENDING_IMPORT ? '' : 'none';
  confirmBtn.textContent = report.added.length
    ? `Add ${report.added.length} book${report.added.length === 1 ? '' : 's'}`
    : report.backfilled.length ? 'Save Audible ids' : 'Save dates read';
  document.getElementById('importCancel').textContent = PENDING_IMPORT ? 'Cancel' : 'Close';
  document.getElementById('importPreview').classList.add('open');
}

function applyImport(){
  if(!PENDING_IMPORT) return;
  // merged again, in case books were edited while the preview was open
  const {data, report, errors} = mergeIntoCopy(PENDING_IMPORT);
  closeImportPreview();
  if(errors.length){ showIoStatus('The catalogue changed and the import no longer validates; nothing was added.', true); return; }
  const added = report.added.length, backfilled = report.backfilled.length, dated = report.datesFilled.length;
  DATA = data;
  populateFilters(); render(); persist();
  showIoStatus(`Added ${added} book${added === 1 ? '' : 's'}` +
    (backfilled ? `, filled in ${backfilled} Audible id${backfilled === 1 ? '' : 's'}` : '') +
    (dated ? `, filled in dates read on ${dated} book${dated === 1 ? '' : 's'}` : '') +
    '.' + keepHint('data/books.json'));
}

function closeImportPreview(){
  PENDING_IMPORT = null;
  document.getElementById('importPreview').classList.remove('open');
}

function importCsv(kind, file){
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      previewImport(kind, e.target.result, file.name);
    }catch(err){
      closeImportPreview();
      showIoStatus(`Couldn't read that file as a ${IMPORTERS[kind].label} export.`, true);
    }
  };
  reader.readAsText(file);
}

document.getElementById('importAudibleBtn').addEventListener('click', ()=>{ IMPORT_KIND = 'audible'; document.getElementById('importCsvFile').click(); });
document.getElementById('importGoodreadsBtn').addEventListener('click', ()=>{ IMPORT_KIND = 'goodreads'; document.getElementById('importCsvFile').click(); });
document.getElementById('importCsvFile').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(file) importCsv(IMPORT_KIND, file);
  e.target.value = '';
});
document.getElementById('importConfirm').addEventListener('click', applyImport);
document.getElementById('importCancel').addEventListener('click', closeImportPreview);

document.getElementById('q').addEventListener('input', render);
document.getElementById('authorFilter').addEventListener('change', render);
document.getElementById('genreFilter').addEventListener('change', render);
document.getElementById('readFilter').addEventListener('change', render);
document.getElementById('btnSeriesView').addEventListener('click', ()=>{ SERIES_FILTER=null; closeForm(); closeSeriesForm(); setView('series'); });
document.getElementById('btnLibraryView').addEventListener('click', ()=>{ SERIES_FILTER=null; closeForm(); closeSeriesForm(); setView('library'); });
document.getElementById('backToSeries').addEventListener('click', ()=>{ SERIES_FILTER=null; closeForm(); closeSeriesForm(); setView('series'); });
document.getElementById('exportBtn').addEventListener('click', exportBackup);
document.getElementById('importBtn').addEventListener('click', ()=> document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(file) importBackup(file);
  e.target.value = '';
});

document.getElementById('toggleAdd').addEventListener('click', ()=>{
  const form = document.getElementById('addForm');
  if(form.classList.contains('open') && EDIT_INDEX === null){
    closeForm();
  } else {
    closeSeriesForm();
    EDIT_INDEX = null;
    document.getElementById('formTitle').textContent = 'Add a book';
    document.getElementById('formSaveBtn').textContent = 'Add book';
    document.getElementById('formError').textContent = '';
    form.reset();
    form.classList.add('open');
  }
});
document.getElementById('cancelAdd').addEventListener('click', closeForm);

// Today in the viewer's time zone, as YYYY-MM-DD.
function today(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

document.getElementById('readTodayBtn').addEventListener('click', ()=>{
  const input = document.getElementById('f_r');
  const current = input.value.trim();
  if(current.split(/[,;]/).map(x=>x.trim()).includes(today())) return;
  input.value = current ? current.replace(/[,;\s]*$/, '') + ', ' + today() : today();
});

function closeForm(){
  EDIT_INDEX = null;
  document.getElementById('formError').textContent = '';
  document.getElementById('addForm').classList.remove('open');
  document.getElementById('addForm').reset();
}

function openEditForm(i){
  const b = DATA[i];
  closeSeriesForm();
  EDIT_INDEX = i;
  document.getElementById('f_t').value = b.t || '';
  document.getElementById('f_a').value = b.a || '';
  document.getElementById('f_n').value = b.n || '';
  document.getElementById('f_g').value = (b.g||[]).join(', ');
  document.getElementById('f_s').value = b.s || '';
  document.getElementById('f_sn').value = b.sn || '';
  document.getElementById('f_r').value = readDates(b).join(', ');
  document.getElementById('formError').textContent = '';
  document.getElementById('formTitle').textContent = 'Edit book';
  document.getElementById('formSaveBtn').textContent = 'Save changes';
  document.getElementById('addForm').classList.add('open');
  document.getElementById('addForm').scrollIntoView({behavior:'smooth', block:'center'});
}

document.getElementById('addForm').addEventListener('submit', e=>{
  e.preventDefault();
  const b = {
    t: document.getElementById('f_t').value.trim(),
    a: document.getElementById('f_a').value.trim(),
  };
  const n = document.getElementById('f_n').value.trim(); if(n) b.n = n;
  const s = document.getElementById('f_s').value.trim(); if(s) b.s = s;
  const sn = document.getElementById('f_sn').value.trim(); if(sn) b.sn = sn;
  const g = document.getElementById('f_g').value.trim();
  if(g) b.g = g.split(',').map(x=>x.trim()).filter(Boolean);
  if(!b.t || !b.a) return;
  const {dates, bad} = CatalogImport.parseReadDates(document.getElementById('f_r').value);
  if(bad.length){
    document.getElementById('formError').textContent =
      `Not a date: ${bad.join(', ')}. Use YYYY-MM-DD, or YYYY-MM / YYYY if you don't remember the day.`;
    return;
  }
  if(dates.length) b.r = dates;

  if(EDIT_INDEX !== null){
    const prev = DATA[EDIT_INDEX];
    if(prev && prev.id) b.id = prev.id;   // keep the Audible ASIN so re-imports still match this book
    DATA[EDIT_INDEX] = b;
  } else {
    DATA.push(b);
  }
  populateFilters(); render(); persist();
  closeForm();
});

async function fetchText(url){
  const res = await fetch(url, {cache: 'no-cache'});
  if(!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function loadData(){
  for(const dir of DATA_DIRS){
    let booksText;
    try{ booksText = await fetchText(dir + 'books.json'); }catch(e){ continue; }
    let infoText = '{}';
    try{ infoText = await fetchText(dir + 'series-info.json'); }catch(e){}
    let excludedText = '';
    try{ excludedText = await fetchText(dir + 'excluded.txt'); }catch(e){}
    return {dir, booksText, infoText, excludedText};
  }
  throw new Error('no books.json found');
}

// Local edits are only reused if they were made against *this* books.json (and series-info.json, for
// saves that carry series info); otherwise an updated data file would keep showing stale data.
// Returns whether there were edits to reuse.
function restoreLocalEdits(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return false;
    const saved = JSON.parse(raw);
    const hasInfo = saved && typeof saved.info === 'object' && saved.info !== null && !Array.isArray(saved.info);
    if(saved && saved.base === BASELINE && Array.isArray(saved.data) && (!hasInfo || saved.infoBase === INFO_BASELINE)){
      DATA = CatalogImport.fixBooks(saved.data);
      if(hasInfo) SERIES_INFO = saved.info;
      return true;
    } else {
      localStorage.setItem(LS_KEY + '.backup', raw);
      localStorage.removeItem(LS_KEY);
      STARTUP_NOTICE = 'The catalogue data has changed; earlier local edits were set aside, not deleted.';
    }
  }catch(e){}
  return false;
}

async function start(){
  try{
    const {dir, booksText, infoText, excludedText} = await loadData();
    DATA = CatalogImport.fixBooks(JSON.parse(booksText));   // "r": "2024-03-15" -> ["2024-03-15"]
    SERIES_INFO = JSON.parse(infoText);
    EXCLUSIONS = CatalogImport.parseExclusions(excludedText);
    BASELINE = CatalogImport.fingerprint(booksText);
    INFO_BASELINE = CatalogImport.fingerprint(infoText);
    DISK_SAVE = await detectDiskSave(dir);
  }catch(e){
    document.getElementById('subtitle').textContent =
      "Couldn't load the catalogue data. Serve this folder over HTTP (make serve) instead of opening the file directly.";
    return;
  }
  const restored = restoreLocalEdits();
  populateFilters();
  setView('series');
  if(STARTUP_NOTICE) showIoStatus(STARTUP_NOTICE, true);
  else if(restored && DISK_SAVE) await saveToDisk();     // edits a failed save left in this browser
}

const READY = start();
