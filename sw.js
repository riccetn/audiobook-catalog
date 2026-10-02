// The service worker that makes the catalogue installable as an app (on a phone, say) and usable offline.
// Every request goes to the network first, so a new version of the app shows up at once; the cached copy
// is only used when the network fails. Your own data/ files and saves are never cached: a phone keeps
// its catalogue in localStorage (see keepOnDevice in store.js), and `make serve` must always be asked.
const CACHE = 'audiobook-catalog-v1';
const APP = ['./', 'index.html', 'import.html', 'duplicates.html', 'styles.css', 'importers.js', 'store.js', 'app.js',
  'import.js', 'duplicates.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'data/sample/books.json', 'data/sample/series-info.json'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=> c.addAll(APP)).then(()=> self.skipWaiting()));
});

self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys()
    .then(keys=> Promise.all(keys.filter(k=> k !== CACHE).map(k=> caches.delete(k))))
    .then(()=> self.clients.claim()));
});

// Whether a request may be answered from the cache: the app itself and the demo data, nothing personal.
function cacheable(req){
  const url = new URL(req.url);
  if(req.method !== 'GET' || url.origin !== location.origin) return false;
  const rel = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  return !rel.startsWith('api/') && (!rel.startsWith('data/') || rel.startsWith('data/sample/'));
}

self.addEventListener('fetch', e=>{
  const req = e.request;
  if(!cacheable(req)) return;
  e.respondWith(fetch(req).then(res=>{
    if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c=> c.put(req, copy)); }
    return res;
  }).catch(()=> caches.match(req, {ignoreSearch: true}).then(hit=> hit || Response.error())));
});
