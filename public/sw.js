// The service worker that makes the catalogue installable as an app (on a phone, say) and usable offline.
// Every request goes to the network first, so a new version of the app shows up at once; the cached copy
// is only used when the network fails. The catalogue itself lives in localStorage (store.js), not in files.
const CACHE = 'audiobook-catalog-v3';
const APP = ['./', 'index.html', 'import.html', 'duplicates.html', 'authors.html', 'styles.css', 'importers.js', 'store.js', 'app.js',
  'import.js', 'duplicates.js', 'authors.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=> c.addAll(APP)).then(()=> self.skipWaiting()));
});

self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys()
    .then(keys=> Promise.all(keys.filter(k=> k !== CACHE).map(k=> caches.delete(k))))
    .then(()=> self.clients.claim()));
});

// Whether a request may be answered from the cache: the app's own files. Only public/ is served, so the
// old data/ files beside it are out of reach anyway; requests to Hardcover go straight to the network.
function cacheable(req){
  return req.method === 'GET' && new URL(req.url).origin === location.origin;
}

self.addEventListener('fetch', e=>{
  const req = e.request;
  if(!cacheable(req)) return;
  e.respondWith(fetch(req).then(res=>{
    if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c=> c.put(req, copy)); }
    return res;
  }).catch(()=> caches.match(req, {ignoreSearch: true}).then(hit=> hit || Response.error())));
});
