# Catalog proxy

A Cloudflare Worker that lets the app's pages ask catalogs whose APIs don't answer web pages (AudiobookDB,
Audible, BookBrainz, ISFDB). It only reaches those APIs, only answers the app's origins, and only with the key.
Your AudiobookDB API key, when the app sends one, goes only to the AudiobookDB paths that need it (`keyed`),
and is never stored.

- `worker.js`: the Worker. Its routes are in `CATALOGS`, and `handle` is what the tests run (`tests/proxy.test.mjs`).
- `wrangler.toml`: its name and `ALLOWED_ORIGINS`, and the optional D1 database (`SYNC_DB`) that keeps the
  encrypted copy of the catalog for syncing devices (`/sync`). The key is the `PROXY_KEY` secret, never written here.

Setting it up, and saving it in the app: [docs/catalog-proxy.md](../docs/catalog-proxy.md). In short:

```sh
npx wrangler login
npx wrangler deploy
npx wrangler secret put PROXY_KEY
```

With sync, deploy with `make deploy-proxy` (`deploy.mjs`) instead: it finds or makes the D1 database by name and
deploys the git-ignored `wrangler.deploy.toml`, `wrangler.toml` with the binding and the database's id, so the id is
never in git.

It is not part of the app: nothing in `public/` imports it, and GitHub Pages never serves it.
