# Catalog proxy

A Cloudflare Worker that lets the app's pages ask catalogs whose APIs don't answer web pages (AudiobookDB,
Audible, BookBrainz, ISFDB). It only reaches those APIs, only answers the app's origins, and only with the key.
Your AudiobookDB API key, when the app sends one, goes only to the AudiobookDB paths that need it (`keyed`),
and is never stored.

- `worker.js`: the Worker. Its routes are in `CATALOGS`, and `handle` is what the tests run (`tests/proxy.test.mjs`).
- `wrangler.toml`: its name and `ALLOWED_ORIGINS`. The key is the `PROXY_KEY` secret, never written here.

Setting it up, and saving it in the app: [docs/catalog-proxy.md](../docs/catalog-proxy.md). In short:

```sh
npx wrangler login
npx wrangler deploy
npx wrangler secret put PROXY_KEY
```

It is not part of the app: nothing in `public/` imports it, and GitHub Pages never serves it.
