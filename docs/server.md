# Your server

The app runs in the browser and needs no server. A server of your own adds two things, which have nothing to do
with each other beyond living in one place:

- **The catalog proxy** (`/proxy/...`). Some catalogs don't answer requests from web pages: their APIs send no
  CORS headers, so the browser refuses to hand their answers to the app. AudiobookDB, Audible's catalog API,
  BookBrainz and ISFDB are like that. Open Library, Wikidata and Hardcover aren't, and the app asks them itself.
  Through the proxy, the book form's _Fill in from another catalog_ looks Audible pages, ASINs and AudiobookDB books
  and releases up ([Everyday workflows](workflows.md)), the AudiobookDB panel on _Import & export_ compares the
  catalog with your AudiobookDB shelves ([AudiobookDB](audiobookdb.md)), and a series is compared with its books on
  Audible ([Audible](audible.md#fill-in-a-series-books-from-audible)).
- **Sync** (`/sync`). It keeps one encrypted copy of your catalog for [syncing your devices](#syncing-devices).

The server is `server/`: the proxy is `proxy.js`, sync is `sync.js`, and `worker.js` lets a request in (only your
pages, only with the key) and hands it to one of them. It runs in two places, with the same code:

- **On Cloudflare**, as a Worker on the free plan (100,000 requests a day), for your phone and every other browser.
  The synced copy is kept in a D1 database. It serves the app too, at its own address, beside GitHub Pages.
  [Setting it up](#on-cloudflare).
- **On your computer**, with `make serve`, which serves the app's pages too. The synced copy is kept in a SQLite
  file. [Running it](#on-your-computer).

It is optional: everything else works without it, and catalogs that need the proxy are just not asked.

## On your computer

```sh
make serve       # .\make.ps1 serve on Windows; node server/serve.mjs after make pages
```

This serves the app at `http://127.0.0.1:8000/` and the server at the same address (`server/serve.mjs`, Node
22.13 or later; Node built-ins only). A request for a file in `public/` gets the file, as Cloudflare answers its static
files first, and anything else goes to the server. The first time, it makes a key, keeps it in `server/.dev.vars`
and prints it. In the app, open _Import & export_, and under **Your server** paste `http://127.0.0.1:8000` and the
key, then press **Save server**.

- **The key and origins** are read from `server/.dev.vars` (`SERVER_KEY=...`, and `ALLOWED_ORIGINS` if you want
  other pages than `make serve`'s), or from environment variables of those names. It is the file `npx wrangler dev`
  reads too, and git ignores it.
- **Synced copies** are kept in `server/.local/sync.sqlite`, which git ignores. It runs the same SQL as D1, so
  everything under [Syncing devices](#syncing-devices) works here too. Delete the file to start over.
- **Another port or your network:** `make serve PORT=8080`, or `HOST=0.0.0.0` to listen on your network
  (`.\make.ps1 serve -Port 8080 -Bind 0.0.0.0`). The app saves a server only with https, but for this computer, so
  a phone needs it served over https, for example with `tailscale serve`.

## On Cloudflare

You need a free Cloudflare account and Node (which you already have for the tests). From the repository:

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up). Under _Workers & Pages_, pick your
   `workers.dev` subdomain when it asks.
2. Sign in and deploy:

   ```sh
   npx wrangler login      # opens the browser to let wrangler use your account
   make deploy-server      # .\make.ps1 deploy-server on Windows; or node server/deploy.mjs
   ```

   It prints the address: `https://audiobook-catalog-proxy.<subdomain>.workers.dev` (the Worker keeps the name
   it had when it was only the proxy, so the address stays the same). It also finds the D1 database
   `audiobook-catalog-sync` by its name, makes it the first time, and binds it as `SYNC_DB` for sync. The database's
   id is never written into `wrangler.toml`: it goes into `server/wrangler.deploy.toml`, which git ignores, and is
   looked up again on every deploy. The server makes its one table on the first sync.

3. Make a key and give it to the Worker. Any long random text works, for example
   `node -e "console.log(crypto.randomUUID())"`. Then:

   ```sh
   cd server
   npx wrangler secret put SERVER_KEY     # paste the key when it asks
   ```

   A server set up before has its key as `PROXY_KEY`, which is still read: there's no need to set it again.

4. In the app, open _Import & export_. Under **Your server**, paste the address and the key and press
   **Save server**. The status line should say the server answers, and whether sync is set up on it. **Check**
   asks it again later, and **Remove server** forgets it in this browser.

Do step 4 in each browser you use, for example your phone. Like the Hardcover token, the address and key are
kept in that browser only and never put in a backup. Any other page on the same site can read them too, so
the same advice applies as for the [Hardcover token](hardcover.md).

Always deploy with `make deploy-server`: a plain `npx wrangler deploy` deploys the server without its database,
and sync then says it isn't set up. Without installing anything, you can also make the Worker in Cloudflare's
dashboard, though only without sync: _Workers & Pages → Create → Worker_, paste the files of `server/` into its
editor and deploy, then under _Settings → Variables and Secrets_ add `SERVER_KEY` as a secret and
`ALLOWED_ORIGINS` as text (the line from `wrangler.toml`).

### The app on it

The Worker serves the app's pages too: its address opens the app, which works offline and installs on a phone just
as it does from GitHub Pages ([On your phone](phone.md)). Cloudflare answers a request for one of the app's files
itself, without running the Worker, and those requests are free and don't count against the 100,000 a day. Each file
is served at the address it is named by (`books.html`, not `books`; Cloudflare's own redirect to the short address
broke the app in Chrome and Edge), and the Worker answers the address itself with `index.html`. On the
app served there, save the server under **Your server** as anywhere else (its own address, and the key); the server
always lets in the app it serves, so its address needn't be in `ALLOWED_ORIGINS`.

Each address keeps its own catalog, as each browser does: the app at the Worker's address starts empty. Bring your
catalog over with **Sync now**, or with Export there and Restore here. GitHub Pages keeps publishing the app as
before, and its pages use the same server.

`make deploy-server` deploys the pages `make pages` last wrote into `public/`. To deploy on every push to `main`
instead, as GitHub Pages does, give the repository two secrets (_Settings → Secrets and variables → Actions_), and
`.github/workflows/server.yml` deploys with them; without them it does nothing:

- `CLOUDFLARE_ACCOUNT_ID`: your account's id, shown on the dashboard's _Workers & Pages_ page.
- `CLOUDFLARE_API_TOKEN`: a token made under _My Profile → API Tokens → Create Token_, from the _Edit Cloudflare
  Workers_ template, with _Account → D1 → Edit_ added (to find or make the sync database).

The workflow writes the API documentation into `public/api/` first, so it is served at `/api/` there too.

### From a terminal

To see it work:

```sh
curl -H "X-Server-Key: <your key>" https://audiobook-catalog-proxy.<subdomain>.workers.dev/ping
# {"ok":true,"proxy":["audiobookdb","audible","bookbrainz","isfdb"],"sync":true}
```

## What it will and won't do

- **Only your pages.** It answers only the app it serves itself and the origins in `ALLOWED_ORIGINS` (in
  `server/wrangler.toml`): the app on GitHub Pages and `make serve`.
- **Only with the key.** Every request needs the server's key (the `SERVER_KEY` secret on Cloudflare), so a
  copy of the address alone is no use to anyone. The key is never in the repository.
- **The proxy reaches only these catalogs.** A request names a catalog and a path in its API
  (`/proxy/audiobookdb/audiobooks/...`, `/proxy/audible/audible.co.uk/catalog/products/<ASIN>`), never an address,
  so it can't be used to reach any other site. Only `GET` is allowed, and for Audible only its public catalog API
  (`/1.0/catalog/...`), never anything to do with an account. The one exception is your AudiobookDB account, below.
- **Nothing else passes through.** No cookies go either way, and the catalog's answer comes back with only its
  body and type. Answers found are kept for a day, so asking twice doesn't bother the catalog twice.
- **Your AudiobookDB key only where it's needed.** Reading your AudiobookDB shelves and putting a book on one
  need your AudiobookDB API key. The app sends it with just those requests, and the proxy passes it on to
  just three of AudiobookDB's paths: who you are (`auth/session`), your shelves (`users/username/<you>/shelves...`)
  and putting a book on a shelf, the only `POST` it allows. A key sent with any other request is refused, not
  passed on. The proxy never stores the key, and never caches what those paths answer. It can't make shelves,
  take a book off one, or change AudiobookDB's catalog.
- **Never Hardcover.** Hardcover answers pages itself, so your Hardcover token goes only to Hardcover.
- **Sync keeps only what it can't read** (below).

## Syncing devices

The server keeps one copy of your catalog, so your devices can sync through it: in a D1 database on Cloudflare
(its SQLite, free on the same plan: 5 GB, and far more reads and writes a day than syncing needs), or in a SQLite file
with `make serve`. **Sync now** under **Sync between devices** on _Import & export_ takes in what your other devices
changed since this one last synced, saves it here, and sends the result as the new copy.

- **Encrypted before it leaves the browser.** The copy is a backup, compressed and encrypted (AES-GCM, with a key
  made from your passphrase by PBKDF2) in the page. The server (and Cloudflare) keep only text they can't read, and
  the passphrase is never sent. Like the server's key, it is kept in each browser only, never in a backup. A lost
  passphrase can't be recovered, but each device still has its catalog: delete the copy (below) and sync again.
- **Nothing is written over.** Each device keeps the copy it last synced, so a sync knows what changed on each
  side. A book, series or person changed on only one side comes from that side, and one removed on one side is
  removed. When both changed the same one, nothing changes until you pick **Keep this device's** or **Keep the
  synced ones** for those. Two devices syncing at the same moment can't write over each other either: the server
  keeps a copy only when it was sent by a device that read the one it replaces, and the other device just reads
  it again.
- **Only by hand.** Nothing syncs on its own: press **Sync now** when you start on a device and when you're done.
  Backups are still worth making: the copy is one more place your catalog is, not a history of it.

### Setting it up

1. Deploy the server with `make deploy-server` ([On Cloudflare](#on-cloudflare)), or run `make serve`.
2. On each device, open _Import & export_, save the server (above) if it isn't yet, and under **Sync between
   devices** type the same passphrase and press **Save passphrase**. A long one is best: anyone with the copy
   could try passphrases against it.
3. Press **Sync now** first on the device whose catalog is complete. On the others, sync when their catalog
   is empty, or holds a backup of that one restored (each book, series and person keeps its id in a backup, so
   the two are known as one).

A device whose catalog was made apart from the synced one (two catalogs that were never one) can't sync: both
have the same authors under other ids. **Use the synced catalog here** replaces this device's catalog with the
synced one (Export a backup first). To keep what only this device has, Export its backup before, and on a device
that syncs, **Merge** that backup ([Merge a backup from another device](backups.md)) and sync there.

To start over (another passphrase, say), delete the copy and sync from the device whose catalog you want. On
Cloudflare:

```sh
cd server
npx wrangler d1 execute audiobook-catalog-sync --config wrangler.deploy.toml --remote --command "DELETE FROM sync"
```

With `make serve`, stop it and delete `server/.local/sync.sqlite`.

The copy can be up to about 1.9 MB as sent (a row of D1 holds 2 MB), which, compressed, is a catalog of many
thousands of books; past that, the sync says the catalog is too big.

## Changing it

- **A new key:** run `npx wrangler secret put SERVER_KEY` again in `server/` (or edit `server/.dev.vars`), then
  save the new key in the app.
- **The app served from somewhere else:** add its origin (`https://name.example`, no path) to
  `ALLOWED_ORIGINS` in `wrangler.toml` and deploy again with `make deploy-server`.
- **After `git pull`:** if anything in `server/` or the app changed, deploy it again with `make deploy-server` (the
  workflow does this on every push to `main` once it has its secrets). A server
  deployed before the proxy moved under `/proxy/` makes **Check** say it's _from before this version_, and the
  catalogs that need the proxy fail, until you do. One deployed before AudiobookDB's shelves were added refuses
  the key (_your server refused it (400)_).
- **To take it down:** run `npx wrangler delete` in `server/` and press **Remove server** in the app.

## When something is wrong

The status line after **Save server** or **Check** says what happened:

- _your server refused the key_: the key saved in the app isn't the server's `SERVER_KEY`.
- _could not reach your server_: the address is wrong, the server isn't deployed or running, or it doesn't allow
  this page. A browser can't tell those apart, so check `ALLOWED_ORIGINS` too.
- _your server is from before this version_: deploy it again with `make deploy-server`.
- _your server answered 500_: the server has no `SERVER_KEY` yet.

And after **Sync now**:

- _sync is not set up on your server_: the Worker has no D1 database bound as `SYNC_DB`: deploy it with
  `make deploy-server`.
- _your server is from before sync_: deploy it again with `make deploy-server`.
- _the passphrase does not open the synced copy_: this browser's passphrase isn't the one the copy was sent with.
- _another device changed these too_: pick whose version to keep, with the buttons below it.
