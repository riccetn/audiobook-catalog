// The import and export page: adding books from Audible and Goodreads exports, and backups.
// Loading and saving live in store.js.

function refreshPage(){
  document.getElementById('subtitle').textContent = `${DATA.length} audiobooks in the catalogue`;
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
      refreshPage(); persist();
      showIoStatus(`Imported ${books.length} books` + (seriesInfo ? ` and info for ${Object.keys(seriesInfo).length} series` : '') +
        (newlyExcluded ? `; ${newlyExcluded} more excluded from imports.` : '.'));
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
  const changes = report.added.length + report.backfilled.length + report.goodreadsFilled.length + report.datesFilled.length +
    report.isbnsFilled.length + report.detailsFilled.length + report.editionsAdded.length;
  PENDING_IMPORT = errors.length || !changes ? null : result.records;

  const li = rec => {
    const series = rec.s ? `  [${rec.s}${rec.sn ? ' #' + rec.sn : ''}]` : '';
    return `<li>${esc(rec.t)} &mdash; ${esc(rec.a)}${esc(series)}</li>`;
  };
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
  showIoStatus(`Added ${added} book${added === 1 ? '' : 's'}` +
    (backfilled ? `, filled in ${backfilled} Audible id${backfilled === 1 ? '' : 's'}` : '') +
    (withGr ? `, filled in ${withGr} Goodreads id${withGr === 1 ? '' : 's'}` : '') +
    (dated ? `, filled in dates read on ${dated} book${dated === 1 ? '' : 's'}` : '') +
    (withIsbns ? `, added ISBNs to ${withIsbns} book${withIsbns === 1 ? '' : 's'}` : '') +
    (withEditions ? `, added editions to ${withEditions} book${withEditions === 1 ? '' : 's'}` : '') +
    (withDetails ? `, filled in edition details on ${withDetails} book${withDetails === 1 ? '' : 's'}` : '') +
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

document.getElementById('exportBtn').addEventListener('click', exportBackup);
document.getElementById('importBtn').addEventListener('click', ()=> document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(file) importBackup(file);
  e.target.value = '';
});

const READY = startPage(refreshPage);
