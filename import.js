// The import and export page: adding books from Audible and Goodreads exports, and backups.
// Loading and saving live in store.js.

function refreshPage(){
  document.getElementById('subtitle').textContent = `${DATA.length} audiobooks in the catalogue`;
  document.getElementById('audiblePanel').style.display = AUDIBLE_LOOKUP ? '' : 'none';
  document.getElementById('importSeriesOption').style.display = AUDIBLE_LOOKUP ? '' : 'none';
}

function exportBackup(){
  const backup = {books: DATA, seriesInfo: SERIES_INFO, excluded: EXCLUSIONS.entries};
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
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
      const {books, seriesInfo, excluded} = CatalogImport.readBackup(JSON.parse(e.target.result));
      const bad = books.some(b=> !b || typeof b !== 'object' || !b.t || !b.a);
      if(bad) throw new Error('missing title/author');
      DATA = books;
      if(seriesInfo) SERIES_INFO = seriesInfo;     // older backups have no series info: keep the current one
      const newlyExcluded = addExclusions(excluded || []);   // added to, never replaced: removing one is a hand edit
      // with no data/books.json to save to (the demo is showing), the restored catalogue becomes this device's own
      const onDevice = keepOnDevice();
      refreshPage(); persist();
      showIoStatus(`Imported ${books.length} books` + (seriesInfo ? ` and info for ${Object.keys(seriesInfo).length} series` : '') +
        (newlyExcluded ? `; ${newlyExcluded} more excluded from imports.` : '.') +
        (onDevice ? ' This device now keeps its own catalogue.' : ''));
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

// A book in a preview list: title, author and series, escaped.
function bookLine(rec){
  const series = rec.s ? `  [${rec.s}${rec.sn ? ' #' + rec.sn : ''}]` : '';
  return `${esc(rec.t)} &mdash; ${esc(rec.a)}${esc(series)}`;
}

function previewImport(kind, text, fileName){
  const importer = IMPORTERS[kind];
  const result = importer.read(text);
  const {report, errors} = mergeIntoCopy(result.records);
  const changes = report.added.length + report.backfilled.length + report.goodreadsFilled.length + report.datesFilled.length +
    report.isbnsFilled.length + report.detailsFilled.length + report.editionsAdded.length;
  PENDING_IMPORT = errors.length || !changes ? null : result.records;
  PENDING_SERIES = null;
  PENDING_MERGE = null;
  document.getElementById('mergePrefer').classList.remove('show');

  const li = rec => `<li>${bookLine(rec)}</li>`;
  let html = `<p>${result.records.length} finished book${result.records.length === 1 ? '' : 's'} read from ${esc(fileName)}</p>`;
  html += `<p>Already in the catalogue: ${report.matched}</p>`;
  if(result.skippedUnfinished) html += `<p>Not finished yet, skipped: ${result.skippedUnfinished}</p>`;
  if(report.backfilled.length) html += `<p>Audible ids filled in on existing books: ${report.backfilled.length}</p>`;
  if(report.goodreadsFilled.length) html += `<p>Goodreads ids filled in on existing books: ${report.goodreadsFilled.length}</p>`;
  if(report.datesFilled.length) html += `<p>Dates read filled in on existing books: ${report.datesFilled.length}</p>`;
  if(report.isbnsFilled.length) html += `<p>ISBNs added to existing books: ${report.isbnsFilled.length}</p>`;
  if(report.detailsFilled.length) html += `<p>Publisher, release date or length filled in on existing books: ${report.detailsFilled.length}</p>`;
  if(report.editionsAdded.length) html += `<p>Other editions added to existing books: ${report.editionsAdded.length}</p>`;
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
    : report.backfilled.length ? 'Save Audible ids' : report.goodreadsFilled.length ? 'Save Goodreads ids' : report.datesFilled.length ? 'Save dates read'
    : report.editionsAdded.length ? 'Save editions' : report.isbnsFilled.length ? 'Save ISBNs' : 'Save edition details';
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
  const withIsbns = report.isbnsFilled.length, withGr = report.goodreadsFilled.length;
  const withEditions = report.editionsAdded.length, withDetails = report.detailsFilled.length;
  DATA = data;
  refreshPage(); persist();
  const done = `Added ${added} book${added === 1 ? '' : 's'}` +
    (backfilled ? `, filled in ${backfilled} Audible id${backfilled === 1 ? '' : 's'}` : '') +
    (withGr ? `, filled in ${withGr} Goodreads id${withGr === 1 ? '' : 's'}` : '') +
    (dated ? `, filled in dates read on ${dated} book${dated === 1 ? '' : 's'}` : '') +
    (withIsbns ? `, added ISBNs to ${withIsbns} book${withIsbns === 1 ? '' : 's'}` : '') +
    (withEditions ? `, added editions to ${withEditions} book${withEditions === 1 ? '' : 's'}` : '') +
    (withDetails ? `, filled in edition details on ${withDetails} book${withDetails === 1 ? '' : 's'}` : '') + '.';
  showIoStatus(done + keepHint('data/books.json'));
  // the option under the import buttons: the new books' series, and release info for series new to the catalogue
  if(IMPORT_KIND === 'audible' && AUDIBLE_LOOKUP && added && document.getElementById('importSeries').checked){
    return lookUpSeries(CatalogImport.seriesLookups(DATA, SERIES_INFO, report.added), done);
  }
}

// ------------------------------------------------------------ series from Audible
// The same lookup as `node catalog.js series`, with `make serve` asking Audible for the page
// (api/audible), since a browser may not. What Audible answered is kept, so confirming applies it
// again to the catalogue as it is then, without asking Audible twice.
let PENDING_SERIES = null;      // {store, found, totals} while the preview is open
let LOOKING_UP = false;

// Ask the server about `asins`, a batch at a time; returns a Map of ASIN -> what Audible said.
async function askAudible(store, groups, asins, progress){
  const found = new Map();
  for(let i = 0; i < asins.length; i += 25){
    progress(i);
    const res = await fetch('api/audible', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({store, groups, asins: asins.slice(i, i + 25)}),
    });
    const body = await res.json();
    if(!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    for(const [asin, value] of Object.entries(body.results)) found.set(asin, value);
  }
  return found;
}

// Apply Audible's answers to copies of the books and series info.
function seriesIntoCopy({store, found, totals}){
  const data = JSON.parse(JSON.stringify(DATA)), info = JSON.parse(JSON.stringify(SERIES_INFO));
  const report = CatalogImport.seriesFromAudible(data, found);
  const added = CatalogImport.addSeriesTotals(info, report.series, totals, store, new Date().toISOString().slice(0, 10));
  return {data, info, report, added, errors: CatalogImport.validate(data, info).errors};
}

// Look up `asins` (default: every book that needs it); `lead` is said first in the preview.
async function lookUpSeries(asins, lead){
  if(LOOKING_UP) return;
  LOOKING_UP = true;
  const store = document.getElementById('audibleStore').value;
  const host = CatalogImport.AUDIBLE_STORES[store];
  asins = (asins || CatalogImport.seriesLookups(DATA, SERIES_INFO)).filter(a=> /^[A-Z0-9]{10}$/.test(a));
  try{
    const found = await askAudible(store, 'series', asins, i=> showIoStatus(`Looking up books on ${host}: ${i} of ${asins.length}…`));
    const series = CatalogImport.seriesFromAudible(JSON.parse(JSON.stringify(DATA)), found).series;
    const wanted = [...series].filter(([name])=> !Object.prototype.hasOwnProperty.call(SERIES_INFO, name)).map(([, asin])=> asin);
    const totals = await askAudible(store, 'relationships', wanted, i=> showIoStatus(`Looking up series on ${host}: ${i} of ${wanted.length}…`));
    previewSeries({store, found, totals}, lead);
    showIoStatus('');
  }catch(e){
    showIoStatus(`Couldn't look up series: ${e.message}`, true);
  }finally{
    LOOKING_UP = false;
  }
}

function previewSeries(pending, lead){
  const {info, report, added, errors} = seriesIntoCopy(pending);
  const host = CatalogImport.AUDIBLE_STORES[pending.store];
  const unknown = [...pending.found.values()].filter(x=> x === null).length;
  const changes = report.filled.length + added.length;
  PENDING_SERIES = errors.length || !changes ? null : pending;
  PENDING_IMPORT = null;
  PENDING_MERGE = null;
  document.getElementById('mergePrefer').classList.remove('show');

  let html = lead ? `<p>${esc(lead)} Their series:</p>` : '';
  html += `<p>${pending.found.size} book${pending.found.size === 1 ? '' : 's'} looked up on ${esc(host)}</p>`;
  html += `<p>Series or number filled in: ${report.filled.length}</p>`;
  if(report.filled.length) html += `<ul>${report.filled.map(b=> `<li>${esc(b.t)} &mdash; ${esc(b.a)}  [${esc(b.s)}${b.sn ? ' #' + esc(b.sn) : ''}]</li>`).join('')}</ul>`;
  html += `<p>Series given a released total: ${added.length}</p>`;
  if(added.length) html += `<ul>${added.map(name=> `<li>${esc(name)}: ${info[name].total} (marked ongoing; check whether it is complete)</li>`).join('')}</ul>`;
  if(unknown) html += `<p>Not found on ${esc(host)}: ${unknown} (try another store)</p>`;
  if(report.warnings.length){
    html += `<p class="warn">Needs a look (${report.warnings.length}):</p><ul>${report.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`;
  }
  if(errors.length){
    html += `<p class="warn">Validation failed, nothing will be changed:</p><ul>${errors.slice(0, 10).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`;
  } else if(!changes){
    html += '<p>Nothing to fill in.</p>';
  }
  document.getElementById('importPreviewTitle').textContent = 'Series from Audible';
  document.getElementById('importPreviewBody').innerHTML = html;
  const confirmBtn = document.getElementById('importConfirm');
  confirmBtn.style.display = PENDING_SERIES ? '' : 'none';
  confirmBtn.textContent = 'Save series';
  document.getElementById('importCancel').textContent = PENDING_SERIES ? 'Cancel' : 'Close';
  document.getElementById('importPreview').classList.add('open');
}

function applySeries(){
  if(!PENDING_SERIES) return;
  // applied again, in case books were edited while the preview was open
  const {data, info, report, added, errors} = seriesIntoCopy(PENDING_SERIES);
  closeImportPreview();
  if(errors.length){ showIoStatus('The catalogue changed and the series no longer validate; nothing was changed.', true); return; }
  DATA = data;
  SERIES_INFO = info;
  refreshPage(); persist();
  const filled = report.filled.length;
  showIoStatus(`Filled in the series of ${filled} book${filled === 1 ? '' : 's'}` +
    (added.length ? ` and released totals for ${added.length} series` : '') + '.' + keepHint('data/books.json'));
}

// ------------------------------------------------------------ Merge a backup from another device
// Restore replaces the catalogue; Merge is for two catalogues that have both changed since they were
// last the same (the phone and the PC, say), so neither side's edits are lost (CatalogImport.mergeBackup).
// Like a CSV import it is previewed first, and only applied when confirmed.
let PENDING_MERGE = null;      // {backup, fileName} while its preview is open

function mergeIntoCatalogue(backup){
  const prefer = document.getElementById('mergePreferSelect').value;
  const m = CatalogImport.mergeBackup(DATA, SERIES_INFO, EXCLUSIONS, backup, prefer);
  // series info left without books is expected after a series was renamed; anything else blocks
  const errors = CatalogImport.validate(m.books, m.seriesInfo).errors.filter(e=> !/^series-info: .* matches no series/.test(e));
  const changes = m.added.length + m.updated.length + m.removed.length + m.infoAdded.length + m.infoChanged.length + m.excluded.length;
  return {m, errors, changes};
}

function previewMerge(){
  const {backup, fileName} = PENDING_MERGE;
  const {m, errors, changes} = mergeIntoCatalogue(backup);
  const list = recs => recs.length ? `<ul>${recs.map(r=> `<li>${bookLine(r)}</li>`).join('')}</ul>` : '';
  let html = `<p>${backup.books.length} books in ${esc(fileName)}; ${m.books.length} after merging.</p>`;
  html += `<p>New from the backup: ${m.added.length}</p>` + list(m.added);
  html += `<p>Gaining genres, dates read or editions${m.conflicts.length ? ', or the version kept below' : ''}: ${m.updated.length}</p>`;
  html += `<p>Removed (removed on the other device): ${m.removed.length}</p>` + list(m.removed);
  if(m.skipped.length) html += `<p>Not added back (removed here): ${m.skipped.length}</p>`;
  if(m.conflicts.length){
    const kept = document.getElementById('mergePreferSelect').value === 'backup' ? "the backup's" : "this catalogue's";
    html += `<p>Title, author or series differ, keeping ${kept}: ${m.conflicts.length}</p><ul>` +
      m.conflicts.map(c=> `<li>${bookLine(c.mine)} / backup: ${bookLine(c.theirs)}</li>`).join('') + '</ul>';
  }
  const infoDiffer = m.infoChanged.length + m.infoKept.length;
  if(m.infoAdded.length || infoDiffer){
    html += `<p>Series info: ${m.infoAdded.length} added` + (infoDiffer ? `, ${infoDiffer} differing (keeping ${m.infoChanged.length ? "the backup's" : "this catalogue's"})` : '') + '</p>';
  }
  if(m.excluded.length) html += `<p>More books excluded from imports: ${m.excluded.length}</p>`;
  if(errors.length){
    html += `<p class="warn">Validation failed, nothing will be changed:</p><ul>${errors.slice(0, 10).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`;
  } else if(!changes){
    html += '<p>Nothing to merge: this catalogue already has everything in the backup.</p>';
  }
  const ok = !errors.length && changes;
  document.getElementById('importPreviewTitle').textContent = 'Merge a backup';
  document.getElementById('importPreviewBody').innerHTML = html;
  document.getElementById('mergePrefer').classList.add('show');
  const confirmBtn = document.getElementById('importConfirm');
  confirmBtn.style.display = ok ? '' : 'none';
  confirmBtn.textContent = 'Merge';
  document.getElementById('importCancel').textContent = ok ? 'Cancel' : 'Close';
  document.getElementById('importPreview').classList.add('open');
}

function applyMerge(){
  // merged again, in case books were edited while the preview was open
  const {m, errors, changes} = mergeIntoCatalogue(PENDING_MERGE.backup);
  closeImportPreview();
  if(errors.length || !changes){ showIoStatus('The catalogue changed and the merge no longer applies; nothing was changed.', true); return; }
  DATA = m.books;
  SERIES_INFO = m.seriesInfo;
  addExclusions(m.excluded);
  refreshPage(); persist();
  showIoStatus(`Merged: ${m.added.length} added, ${m.updated.length} updated, ${m.removed.length} removed.` +
    keepHint('data/books.json and data/series-info.json'));
}

function mergeBackupFile(file){
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const backup = CatalogImport.readBackup(JSON.parse(e.target.result));
      if(backup.books.some(b=> !b || typeof b !== 'object' || !b.t || !b.a)) throw new Error('missing title/author');
      PENDING_IMPORT = null;
      PENDING_SERIES = null;
      PENDING_MERGE = {backup, fileName: file.name};
      previewMerge();
    }catch(err){
      closeImportPreview();
      showIoStatus("Couldn't read that file \u2014 make sure it's a catalogue backup JSON.", true);
    }
  };
  reader.readAsText(file);
}

function closeImportPreview(){
  PENDING_IMPORT = null;
  PENDING_SERIES = null;
  PENDING_MERGE = null;
  document.getElementById('mergePrefer').classList.remove('show');
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
document.getElementById('importConfirm').addEventListener('click', ()=> PENDING_MERGE ? applyMerge() : PENDING_SERIES ? applySeries() : applyImport());
document.getElementById('audibleSeriesBtn').addEventListener('click', ()=> lookUpSeries());
// remembered in this browser, like a preference
const SERIES_AFTER_IMPORT_KEY = 'audiobook-catalog-import-series';
try{ document.getElementById('importSeries').checked = localStorage.getItem(SERIES_AFTER_IMPORT_KEY) === '1'; }catch(e){}
document.getElementById('importSeries').addEventListener('change', e=>{
  try{ localStorage.setItem(SERIES_AFTER_IMPORT_KEY, e.target.checked ? '1' : '0'); }catch(err){}
});
document.getElementById('importCancel').addEventListener('click', closeImportPreview);

document.getElementById('exportBtn').addEventListener('click', exportBackup);
document.getElementById('importBtn').addEventListener('click', ()=> document.getElementById('importFile').click());
document.getElementById('mergeBtn').addEventListener('click', ()=> document.getElementById('mergeFile').click());
document.getElementById('mergeFile').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(file) mergeBackupFile(file);
  e.target.value = '';
});
document.getElementById('mergePreferSelect').addEventListener('change', ()=>{ if(PENDING_MERGE) previewMerge(); });
document.getElementById('importFile').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(file) importBackup(file);
  e.target.value = '';
});

const READY = startPage(refreshPage);
