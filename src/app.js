const LS_KEY = 'audiobook-catalog-data';

// Cheap non-cryptographic hash, used to tell which build a locally saved copy belongs to.
function hashString(s){
  let h = 5381;
  for(let i = 0; i < s.length; i++){ h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36) + ':' + s.length;
}

const EMBEDDED_JSON = document.getElementById('book-data').textContent;
const BASELINE = hashString(EMBEDDED_JSON);
let DATA = JSON.parse(EMBEDDED_JSON);
let STARTUP_NOTICE = '';
try{
  // Offline/standalone copies keep edits in localStorage. Only reuse them if they were made
  // against *this* build's data; otherwise a rebuilt file would keep showing stale books.
  const raw = localStorage.getItem(LS_KEY);
  if(raw){
    const saved = JSON.parse(raw);
    if(saved && saved.base === BASELINE && Array.isArray(saved.data)){
      DATA = saved.data;
      document.getElementById('book-data').textContent = JSON.stringify(DATA);
    } else {
      localStorage.setItem(LS_KEY + '.backup', raw);
      localStorage.removeItem(LS_KEY);
      STARTUP_NOTICE = 'A newer catalogue build was loaded; earlier local edits were set aside, not deleted.';
    }
  }
}catch(e){}
let SERIES_INFO = JSON.parse(document.getElementById('series-info').textContent);
let VIEW = 'series';           // 'series' | 'library'
let SERIES_FILTER = null;      // series name, '__standalone__', or null
let EDIT_INDEX = null;         // index into DATA being edited, or null when adding new

function uniqueSorted(arr){ return [...new Set(arr)].sort((a,b)=>a.localeCompare(b)); }

function populateFilters(){
  const authors = uniqueSorted(DATA.map(b=>b.a));
  const genres = uniqueSorted(DATA.flatMap(b=>b.g||[]));
  const aSel = document.getElementById('authorFilter');
  const gSel = document.getElementById('genreFilter');
  const aCur = aSel.value, gCur = gSel.value;
  aSel.innerHTML = '<option value="">All authors</option>' + authors.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('');
  gSel.innerHTML = '<option value="">All genres</option>' + genres.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join('');
  aSel.value = aCur; gSel.value = gCur;
}

function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function matches(b, q, author, genre){
  if(SERIES_FILTER){
    if(SERIES_FILTER === '__standalone__'){ if(b.s) return false; }
    else if(b.s !== SERIES_FILTER) return false;
  }
  if(author && b.a !== author) return false;
  if(genre && !(b.g||[]).includes(genre)) return false;
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
  document.getElementById('toggleAdd').style.display = showLibControls ? '' : 'none';
  const crumb = document.getElementById('crumb');
  if(v === 'library' && SERIES_FILTER){
    crumb.classList.add('show');
    document.getElementById('crumbLabel').textContent =
      SERIES_FILTER === '__standalone__' ? 'Standalone books' : SERIES_FILTER;
  } else {
    crumb.classList.remove('show');
  }
  syncUIStateTag();
  render();
}

function syncUIStateTag(){
  document.getElementById('ui-state').textContent = JSON.stringify({
    view: VIEW,
    filter: SERIES_FILTER,
    q: document.getElementById('q').value,
    authorFilter: document.getElementById('authorFilter').value,
    genreFilter: document.getElementById('genreFilter').value
  });
}

function openSeries(name){
  SERIES_FILTER = name;
  setView('library');
}

function render(){
  syncUIStateTag();
  if(VIEW === 'series'){ renderSeriesOverview(); return; }

  const q = document.getElementById('q').value.trim();
  const author = document.getElementById('authorFilter').value;
  const genre = document.getElementById('genreFilter').value;
  const filtered = DATA.map((b,i)=>({...b, _i:i})).filter(b=>matches(b,q,author,genre));

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
        syncDataTag(); populateFilters(); render(); persist();
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
    </div>`;
    let foot = `<div class="srow-foot"><span class="tag">${esc(authors.join(', '))}</span>`;
    if(info){
      foot += ` <span class="status ${info.status}">${info.status === 'complete' ? 'complete' : 'ongoing'}</span>`;
      if(info.url) foot += ` <a class="authorlink" href="${esc(info.url)}" target="_blank" rel="noopener">author site \u2197</a>`;
    }
    foot += '</div>';
    html += foot;
    if(info) html += `<p class="srow-note">${esc(info.note)}</p>`;
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
}

function bookCard(b){
  const num = b.sn ? `<div class="num">${esc(b.sn)}</div>` : '<div class="num">&bull;</div>';
  const meta = [b.a, b.n ? 'narr. '+b.n : null].filter(Boolean).join(' \u2014 ');
  const genres = (b.g||[]).map(g=>`<span class="tag">${esc(g)}</span>`).join('');
  return `<div class="book">${num}<div class="info">
    <div class="title">${esc(b.t)}</div>
    <div class="meta">${esc(meta)}</div>
    ${genres ? `<div class="genres">${genres}</div>` : ''}
  </div><div class="book-actions">
    <button class="iconbtn edit" data-i="${b._i}" title="Edit" aria-label="Edit">&#9998;</button>
    <button class="iconbtn del" data-i="${b._i}" title="Remove" aria-label="Remove">&times;</button>
  </div></div>`;
}

function syncDataTag(){
  document.getElementById('book-data').textContent = JSON.stringify(DATA);
}

function persist(){
  (async ()=>{
    let savedOnline = false;
    try{
      const artifact = await claude.use('artifact');
      if(artifact){ await artifact.publish('<!DOCTYPE html>\n' + document.documentElement.outerHTML); savedOnline = true; }
    }catch(e){ /* not available in this view (e.g. an offline downloaded copy) */ }
    if(!savedOnline){
      try{ localStorage.setItem(LS_KEY, JSON.stringify({base: BASELINE, data: DATA})); }catch(e){}
    }
  })();
}

function showIoStatus(msg, isErr){
  const el = document.getElementById('ioStatus');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.textContent = ''; }, 5000);
}

function exportBackup(){
  const blob = new Blob([JSON.stringify(DATA, null, 2)], {type:'application/json'});
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
      const imported = JSON.parse(e.target.result);
      if(!Array.isArray(imported)) throw new Error('not an array');
      const bad = imported.some(b=> typeof b !== 'object' || !b.t || !b.a);
      if(bad) throw new Error('missing title/author');
      DATA = imported;
      syncDataTag(); populateFilters(); render(); persist();
      showIoStatus(`Imported ${imported.length} books.`);
    }catch(err){
      showIoStatus("Couldn't read that file \u2014 make sure it's a catalogue backup JSON.", true);
    }
  };
  reader.readAsText(file);
}

document.getElementById('q').addEventListener('input', render);
document.getElementById('authorFilter').addEventListener('change', render);
document.getElementById('genreFilter').addEventListener('change', render);
document.getElementById('btnSeriesView').addEventListener('click', ()=>{ SERIES_FILTER=null; closeForm(); setView('series'); });
document.getElementById('btnLibraryView').addEventListener('click', ()=>{ SERIES_FILTER=null; closeForm(); setView('library'); });
document.getElementById('backToSeries').addEventListener('click', ()=>{ SERIES_FILTER=null; closeForm(); setView('series'); });
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
    EDIT_INDEX = null;
    document.getElementById('formTitle').textContent = 'Add a book';
    document.getElementById('formSaveBtn').textContent = 'Add book';
    form.reset();
    form.classList.add('open');
  }
});
document.getElementById('cancelAdd').addEventListener('click', closeForm);

function closeForm(){
  EDIT_INDEX = null;
  document.getElementById('addForm').classList.remove('open');
  document.getElementById('addForm').reset();
}

function openEditForm(i){
  const b = DATA[i];
  EDIT_INDEX = i;
  document.getElementById('f_t').value = b.t || '';
  document.getElementById('f_a').value = b.a || '';
  document.getElementById('f_n').value = b.n || '';
  document.getElementById('f_g').value = (b.g||[]).join(', ');
  document.getElementById('f_s').value = b.s || '';
  document.getElementById('f_sn').value = b.sn || '';
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

  if(EDIT_INDEX !== null){
    const prev = DATA[EDIT_INDEX];
    if(prev && prev.id) b.id = prev.id;   // keep the Audible ASIN so re-imports still match this book
    DATA[EDIT_INDEX] = b;
  } else {
    DATA.push(b);
  }
  syncDataTag(); populateFilters(); render(); persist();
  closeForm();
});

populateFilters();
(function initUIState(){
  let saved = {};
  try { saved = JSON.parse(document.getElementById('ui-state').textContent || '{}'); } catch(e){}
  document.getElementById('q').value = saved.q || '';
  document.getElementById('authorFilter').value = saved.authorFilter || '';
  document.getElementById('genreFilter').value = saved.genreFilter || '';
  SERIES_FILTER = saved.filter || null;
  setView(saved.view || 'series');
})();
if(STARTUP_NOTICE) showIoStatus(STARTUP_NOTICE, true);
