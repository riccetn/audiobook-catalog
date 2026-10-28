# Catalog proxy

Some catalogs don't answer requests from web pages: their APIs send no CORS headers, so the browser
refuses to hand their answers to the app. AudiobookDB, Audible's catalog API, BookBrainz and ISFDB are like
that. Open Library, Wikidata and Hardcover aren't, and the app asks them itself.

The app can ask the others through a proxy of your own: with one saved, the book form's _Fill in from another
catalog_ looks Audible pages, ASINs and AudiobookDB books and releases up through it
([Everyday workflows](workflows.md)), the AudiobookDB panel on _Import & export_ compares the catalog with
your AudiobookDB shelves ([AudiobookDB](audiobookdb.md)), and a series is compared with its books on Audible
([Audible](audible.md#fill-in-a-series-books-from-audible)). It's a small Cloudflare Worker (`proxy/worker.js`)
that runs on Cloudflare's free plan, which allows 100,000 requests a day. It can also keep an encrypted copy of
your catalog for [syncing your devices](#syncing-devices). It is optional: everything else works without it, and
catalogs that need it are just not asked.

## What the proxy will and won't do

- **Only these catalogs.** A request names a catalog and a path in its API (`/audiobookdb/audiobooks/...`,
  `/audible/audible.co.uk/catalog/products/<ASIN>`), never an address, so it can't be used to reach any other
  site. Only `GET` is allowed, and for Audible only its public catalog API (`/1.0/catalog/...`), never anything
  to do with an account. The one exception is your AudiobookDB account, below.
- **Only your pages.** It answers only the origins in `ALLOWED_ORIGINS` (in `proxy/wrangler.toml`): the
  app on GitHub Pages and `make serve`.
- **Only with the key.** Every request needs the proxy's key (the `PROXY_KEY` secret on Cloudflare), so a
  copy of the address alone is no use to anyone. The key is never in the repository.
- **Nothing else passes through.** No cookies go either way, and the catalog's answer comes back with only its
  body and type. Answers found are kept for a day, so asking twice doesn't bother the catalog twice.
- **Your AudiobookDB key only where it's needed.** Reading your AudiobookDB shelves and putting a book on one
  need your AudiobookDB API key. The app sends it with just those requests, and the proxy passes it on to
  just three of AudiobookDB's paths: who you are (`auth/session`), your shelves (`users/username/<you>/shelves...`)
  and putting a book on a shelf, the only `POST` it allows. A key sent with any other request is refused, not
  passed on. The proxy never stores the key, and never caches what those paths answer. It can't make shelves,
  take a book off one, or change AudiobookDB's catalog.
- **Never Hardcover.** Hardcover answers pages itself, so your Hardcover token goes only to Hardcover.

## Setting it up

You need a free Cloudflare account and Node (which you already have for the tests). From the repository:

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up). Under _Workers & Pages_, pick your
   `workers.dev` subdomain when it asks.
2. In the `proxy` folder, sign in and deploy:

   ```sh
   cd proxy
   npx wrangler login      # opens the browser to let wrangler use your account
   npx wrangler deploy     # prints the address: https://audiobook-catalog-proxy.<subdomain>.workers.dev
   ```

3. Make a key and give it to the Worker. Any long random text works, for example
   `node -e "console.log(crypto.randomUUID())"`. Then:

   ```sh
   npx wrangler secret put PROXY_KEY     # paste the key when it asks
   ```

4. In the app, open _Import & export_. Under **Catalog proxy**, paste the address and the key and press
   **Save proxy**. The status line should say the proxy answers. **Check** asks it again later, and
   **Remove proxy** forgets it in this browser.

Do step 4 in each browser you use, for example your phone. Like the Hardcover token, the address and key are
kept in that browser only and never put in a backup. Any other page on the same site can read them too, so
the same advice applies as for the [Hardcover token](hardcover.md).

Without installing anything, you can also make the Worker in Cloudflare's dashboard: _Workers & Pages →
Create → Worker_, paste `proxy/worker.js` into its editor and deploy, then under _Settings → Variables and
Secrets_ add `PROXY_KEY` as a secret and `ALLOWED_ORIGINS` as text (the line from `wrangler.toml`).

To see it work from a terminal:

```sh
curl -H "X-Proxy-Key: <your key>" https://audiobook-catalog-proxy.<subdomain>.workers.dev/ping
# {"ok":true,"catalogs":["audiobookdb","audible","bookbrainz","isfdb"]}
```

## Changing it

- **A new key:** run `npx wrangler secret put PROXY_KEY` again, then save the new key in the app.
- **The app served from somewhere else:** add its origin (`https://name.example`, no path) to
  `ALLOWED_ORIGINS` in `wrangler.toml` and run `npx wrangler deploy` again.
- **After `git pull`:** if `proxy/worker.js` changed, run `npx wrangler deploy` again. A proxy deployed before
  AudiobookDB's shelves were added refuses the key (_the proxy answered 405_ or _400_) until you do.
- **To take it down:** run `npx wrangler delete` and press **Remove proxy** in the app.

## Syncing devices

With a D1 database bound to it (Cloudflare's SQLite, free on the same plan: 5 GB, and far more reads and writes a
day than syncing needs), the proxy also keeps one copy of your catalog, so your devices can sync through it.
**Sync now** under **Sync between devices** on _Import & export_ takes in what your other devices changed since this
one last synced, saves it here, and sends the result as the new copy.

- **Encrypted before it leaves the browser.** The copy is a backup, compressed and encrypted (AES-GCM, with a key
  made from your passphrase by PBKDF2) in the page. The proxy and Cloudflare keep only text they can't read, and
  the passphrase is never sent. Like the proxy's key, it is kept in each browser only, never in a backup. A lost
  passphrase can't be recovered, but each device still has its catalog: delete the copy (below) and sync again.
- **Nothing is written over.** Each device keeps the copy it last synced, so a sync knows what changed on each
  side. A book, series or person changed on only one side comes from that side, and one removed on one side is
  removed. When both changed the same one, nothing changes until you pick **Keep this device's** or **Keep the
  synced ones** for those. Two devices syncing at the same moment can't write over each other either: the proxy
  keeps a copy only when it was sent by a device that read the one it replaces, and the other device just reads
  it again.
- **Only by hand.** Nothing syncs on its own: press **Sync now** when you start on a device and when you're done.
  Backups are still worth making: the copy is one more place your catalog is, not a history of it.

### Setting it up

1. Make the database, from the `proxy` folder:

   ```sh
   npx wrangler d1 create audiobook-catalog-sync
   ```

2. Take the `#` off the four `[[d1_databases]]` lines at the end of `proxy/wrangler.toml`, put in the
   `database_id` it printed, and deploy again with `npx wrangler deploy`. The Worker makes its one table on the
   first sync. (In the dashboard instead: _Storage & Databases → D1 → Create_, then on the Worker _Settings →
   Bindings → Add → D1 database_, named `SYNC_DB`.)
3. On each device, open _Import & export_, save the proxy (above) if it isn't yet, and under **Sync between
   devices** type the same passphrase and press **Save passphrase**. A long one is best: anyone with the copy
   could try passphrases against it.
4. Press **Sync now** first on the device whose catalog is complete. On the others, sync when their catalog
   is empty, or holds a backup of that one restored (each book, series and person keeps its id in a backup, so
   the two are known as one).

A device whose catalog was made apart from the synced one (two catalogs that were never one) can't sync: both
have the same authors under other ids. **Use the synced catalog here** replaces this device's catalog with the
synced one (Export a backup first). To keep what only this device has, Export its backup before, and on a device
that syncs, **Merge** that backup ([Merge a backup from another device](backups.md)) and sync there.

To start over (another passphrase, say), delete the copy and sync from the device whose catalog you want:

```sh
npx wrangler d1 execute audiobook-catalog-sync --remote --command "DELETE FROM sync"
```

The copy can be up to about 1.9 MB as sent (a row of D1 holds 2 MB), which, compressed, is a catalog of many
thousands of books; past that, the sync says the catalog is too big.

## When something is wrong

The status line after **Save proxy** or **Check** says what happened:

- _the proxy refused the key_: the key saved in the app isn't the Worker's `PROXY_KEY`.
- _could not reach the catalog proxy_: the address is wrong, the Worker isn't deployed, or it doesn't allow
  this page. A browser can't tell those apart, so check `ALLOWED_ORIGINS` too.
- _the proxy answered 500_: the Worker has no `PROXY_KEY` yet.

And after **Sync now**:

- _sync is not set up on your proxy_: the Worker has no D1 database bound as `SYNC_DB` (setting it up, above).
- _your proxy is from before sync_: run `npx wrangler deploy` again.
- _the passphrase does not open the synced copy_: this browser's passphrase isn't the one the copy was sent with.
- _another device changed these too_: pick whose version to keep, with the buttons below it.
