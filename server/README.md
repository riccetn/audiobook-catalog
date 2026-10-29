# The app's server

Optional, and not part of the app: nothing in `src/` imports it, and GitHub Pages never serves it. It is TypeScript
that Wrangler and Node run as it is (`tsconfig.server.json` checks it). It does two unrelated things, each in a module of its own:

- `proxy.ts`: the catalog proxy (`/proxy/<catalog>/...`), which lets the app's pages ask catalogs whose APIs don't
  answer web pages (AudiobookDB, Audible, BookBrainz, ISFDB). It only reaches those APIs, and your AudiobookDB API
  key, when the app sends one, goes only to the AudiobookDB paths that need it (`keyed`) and is never stored.
- `sync.ts`: sync (`/sync`), one encrypted copy of the catalog that devices sync with, in a D1 database (`SYNC_DB`)
  or, with `make serve`, a SQLite file (`sqlite-d1.ts`). It runs the same SQL in both.

The rest:

- `worker.ts`: the Cloudflare Worker. `handle` answers only the app's origins (`ALLOWED_ORIGINS`), only with the key
  (the `SERVER_KEY` secret, `X-Server-Key`), and routes the request to the proxy or sync; it is what the tests run
  (`tests/server.test.mjs`) and what `serve.mjs` runs.
- `serve.mjs`: `make serve`, the app's pages from `public/` and the server beside them on this computer, with the
  key in `.dev.vars` and the synced copy in `.local/sync.sqlite` (both git-ignored). Node 22.18 or later.
- `wrangler.toml`: the Worker's name and `ALLOWED_ORIGINS`. The key is a secret, never written here.
- `deploy.mjs`: `make deploy-server`, which finds or makes the D1 database by name and deploys the git-ignored
  `wrangler.deploy.toml` (`wrangler.toml` with the binding and the database's id), so the id is never in git.

Setting it up, and saving it in the app: [docs/server.md](../docs/server.md). In short:

```sh
npx wrangler login
make deploy-server
cd server && npx wrangler secret put SERVER_KEY
```
