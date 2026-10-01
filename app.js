// The catalogue page: the series overview, all books, and editing books and series info.
// Loading and saving live in store.js.
let VIEW = 'series';           // 'series' | 'library'
let SERIES_FILTER = null;      // series name, '__standalone__', or null
let EDIT_INDEX = null;         // index into DATA being edited, or null when adding new
let EDIT_SERIES = null;        // name of the series whose info is being edited, or null
let MERGE_FROM = null;         // index of the first book picked with its merge button, or null

// Filter value for books with no date read, in the "Read any time" select.
const UNDATED = '__undated__';

// Year a book was (last) read in, for the read filter: '2024' from ['2021-05', '2024-03-15'].
const readYears = b => readDates(b).map(d => d.slice(0, 4));

function uniqueSorted(arr){ return [...new Set(arr)].sort((a,b)=>a.localeCompare(b)); }

// Series numbers you don't own yet, from series-info.json's released total; null when that is unknown.
function seriesMissing(name){
  const info = SERIES_INFO[name];
  return info ? CatalogImport.missingNumbers(DATA.filter(b=> b.s === name), info.total) : null;
}

// [3, 5, 6, 7] -> "#3, #5-7"
function numberList(nums){
  const runs = [];
  nums.forEach(n=>{
    const last = runs[runs.length - 1];
    if(last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
  });
  return runs.map(([a,b])=> a === b ? `#${a}` : `#${a}\u2013${b}`).join(', ');
}

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
  MERGE_FROM = null;             // DATA changed, so an index picked for merging may be stale
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
    const editions = CatalogImport.bookEditions(b);
    const hay = [b.t,b.a,b.s,...(b.g||[]),...editions.flatMap(ed=>[ed.id, ed.gr, ed.n, ed.p, ed.desc, ...(Array.isArray(ed.isbn) ? ed.isbn : [])])]
      .filter(x=> typeof x === 'string').join(' ').toLowerCase();
    // an ISBN matches however it is typed: with hyphens, or as the ISBN-10 of the same edition
    const isbn = CatalogImport.parseIsbn(q);
    if(!hay.includes(q.toLowerCase()) && !(isbn && CatalogImport.bookIsbns(b).includes(isbn))) return false;
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
  document.getElementById('missingFilter').style.display = showLibControls ? 'none' : '';
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
  SHARED = sharedEditions();

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
      const missing = seriesMissing(name);
      const note = [`${esc(info.total)} released total`];
      if(missing && missing.length) note.push(`missing ${numberList(missing)}`);
      if(info.note) note.push(esc(info.note));
      head += `<p class="series-note">${note.join(' \u2014 ')}</p>`;
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
        const [removed] = DATA.splice(i,1);
        addExclusions(CatalogImport.exclusionEntries(removed));   // so the next import does not bring it back
        if(EDIT_INDEX === i){ closeForm(); }
        populateFilters(); render(); persist();
        showIoStatus(`Removed ${removed.t}; imports will skip it.` + keepHint('data/books.json and data/excluded.txt'));
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
  document.querySelectorAll('.iconbtn.merge').forEach(btn=>{
    btn.addEventListener('click', e=> pickMergeBook(parseInt(e.currentTarget.dataset.i,10)));
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
  const onlyMissing = document.getElementById('missingFilter').value === 'missing';
  if(onlyMissing) seriesNames = seriesNames.filter(name=> (seriesMissing(name) || []).length);

  document.getElementById('subtitle').textContent =
    `${Object.keys(groups).length} series across ${DATA.length} audiobooks \u2014 tap a series to see its titles`;
  document.getElementById('resultCount').textContent = `${seriesNames.length} series shown`;

  let html = '';
  const showStandalone = !onlyMissing && (!q || 'standalone'.includes(q));
  if(seriesNames.length === 0 && !showStandalone){
    html = onlyMissing ? '<p class="empty">No series with missing books.</p>' : '<p class="empty">No series match your search.</p>';
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
    const missing = seriesMissing(name);
    if(missing && missing.length) foot += ` <span class="missing">missing ${numberList(missing)}</span>`;
    foot += '</div>';
    html += foot;
    if(info && info.note !== '') html += `<p class="srow-note">${esc(info.note)}</p>`;
    html += '</div>';
  });

  if(showStandalone){
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

// Edition object -> indexes of the other books it is also on (a box set), for the books being shown.
let SHARED = new Map();

function sharedEditions(){
  const byKey = new Map();
  const keys = ed=> [...['id','gr'].filter(k=> ed[k]).map(k=> k + ' ' + ed[k]), ...CatalogImport.editionIsbns(ed).map(x=> 'isbn ' + x)];
  DATA.forEach((b,i)=> CatalogImport.bookEditions(b).forEach(ed=> keys(ed).forEach(k=>{
    if(!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push([i, ed]);
  })));
  const shared = new Map();
  DATA.forEach((b,i)=> CatalogImport.bookEditions(b).forEach(ed=>{
    const others = new Set();
    for(const k of keys(ed)) for(const [j, x] of byKey.get(k)) if(j !== i && CatalogImport.sameEdition(x, ed)) others.add(j);
    if(others.size) shared.set(ed, [...others]);
  }));
  return shared;
}

// Audible's US store: the catalogue has no notion of a store region, and audible.com redirects
// a visitor to their own store when the title is sold there.
const AUDIBLE_URL = 'https://www.audible.com/pd/', GOODREADS_URL = 'https://www.goodreads.com/book/show/';

/** An edition as formatEdition() writes it, with its ASIN and Goodreads id linking to the book there. */
function editionHtml(ed){
  const link = (url, id)=> `<a href="${esc(url + encodeURIComponent(id))}" target="_blank" rel="noopener">${esc(id)}</a>`;
  const urls = {id: AUDIBLE_URL, gr: GOODREADS_URL};
  return CatalogImport.editionParts(ed).map(([k, label, value])=>
    (label ? esc(label) + ' ' : '') + (urls[k] ? link(urls[k], value) : esc(value))).join('; ');
}

function bookCard(b){
  const num = b.sn ? `<div class="num">${esc(b.sn)}</div>` : '<div class="num">&bull;</div>';
  // the narrators of all its editions; each edition line names its own only when they differ
  const narrators = CatalogImport.bookNarrators(b);
  const meta = [b.a, narrators.length ? 'narr. '+narrators.join(' / ') : null].filter(Boolean).join(' \u2014 ');
  const genres = (b.g||[]).map(g=>`<span class="tag">${esc(g)}</span>`).join('');
  const read = readDates(b).length ? `<div class="read">Read ${esc(readDates(b).join(', '))}</div>` : '';
  const editions = CatalogImport.bookEditions(b).map(ed=>{
    const also = (SHARED.get(ed) || []).map(k=> DATA[k].t + (DATA[k].sn ? ` #${DATA[k].sn}` : ''));
    return `<div class="edition">${editionHtml(narrators.length > 1 ? ed : {...ed, n: undefined})}` +
      (also.length ? `<br><span class="also">Also in this edition: ${esc(also.join(', '))}</span>` : '') + '</div>';
  }).join('');
  const picked = MERGE_FROM === b._i;
  const mergeLabel = picked ? 'Cancel merge' : MERGE_FROM === null ? 'Merge with another book' : `Merge with ${DATA[MERGE_FROM].t}`;
  return `<div class="book${picked ? ' picked' : ''}">${num}<div class="info">
    <div class="title">${esc(b.t)}</div>
    <div class="meta">${esc(meta)}</div>
    ${read}
    ${editions}
    ${genres ? `<div class="genres">${genres}</div>` : ''}
  </div><div class="book-actions">
    <button class="iconbtn edit" data-i="${b._i}" title="Edit" aria-label="Edit">&#9998;</button>
    <button class="iconbtn merge" data-i="${b._i}" title="${esc(mergeLabel)}" aria-label="${esc(mergeLabel)}">&#8644;</button>
    <button class="iconbtn del" data-i="${b._i}" title="Remove" aria-label="Remove">&times;</button>
  </div></div>`;
}

document.getElementById('q').addEventListener('input', render);
document.getElementById('authorFilter').addEventListener('change', render);
document.getElementById('genreFilter').addEventListener('change', render);
document.getElementById('readFilter').addEventListener('change', render);
document.getElementById('missingFilter').addEventListener('change', render);
document.getElementById('btnSeriesView').addEventListener('click', ()=>{ SERIES_FILTER=null; closeForm(); closeSeriesForm(); setView('series'); });
document.getElementById('btnLibraryView').addEventListener('click', ()=>{ SERIES_FILTER=null; closeForm(); closeSeriesForm(); setView('library'); });
document.getElementById('backToSeries').addEventListener('click', ()=>{ SERIES_FILTER=null; closeForm(); closeSeriesForm(); setView('series'); });
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
  document.getElementById('f_g').value = (b.g||[]).join(', ');
  document.getElementById('f_s').value = b.s || '';
  document.getElementById('f_sn').value = b.sn || '';
  document.getElementById('f_r').value = readDates(b).join(', ');
  document.getElementById('f_e').value = CatalogImport.bookEditions(b).map(CatalogImport.formatEdition).join('\n');
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
  const {editions, bad: badParts} = CatalogImport.parseEditions(document.getElementById('f_e').value);
  // "book #0 ('Title') edition #2: needs an ..." -> "edition #2: needs an ..."
  const problems = (editions.length ? CatalogImport.validate([{t: b.t, a: b.a, e: editions}], {}).errors : [])
    .map(e=> e.includes(' edition #') ? e.slice(e.indexOf(' edition #') + 1) : e);
  if(badParts.length || problems.length){
    document.getElementById('formError').textContent = badParts.length
      ? `Not understood in editions: ${badParts.join('; ')}. Write e.g. "ASIN B0…; Goodreads 4242; ISBN 978…; Publisher …; Released 2021-05; Length 10h 42m", one edition per line.`
      : problems.join('; ');
    return;
  }
  if(editions.length) b.e = editions;

  // editing an edition a box set shares with other books edits it there too
  const others = CatalogImport.saveBook(DATA, EDIT_INDEX, b);
  populateFilters(); render(); persist();
  closeForm();
  if(others) showIoStatus(`Also updated the shared edition on ${others} other book${others === 1 ? '' : 's'}.`);
});

// The merge button on a book: the first press picks it, a press on another book opens the two on the
// duplicates page (which checks they are still the same books).
function pickMergeBook(i){
  if(MERGE_FROM === null){
    MERGE_FROM = i;
    showIoStatus(`Now press \u21c4 on the book to merge ${DATA[i].t} with.`);
  } else if(MERGE_FROM === i){
    MERGE_FROM = null;
  } else {
    const pair = [MERGE_FROM, i].sort((x, y)=> x - y);
    MERGE_FROM = null;
    location.href = 'duplicates.html#merge=' + pair.join(',');
    return;
  }
  render();
}

// After a save to disk tidied the books (store.js).
function refreshPage(){
  populateFilters(); render();
}

const READY = startPage(()=>{ populateFilters(); setView('series'); });
