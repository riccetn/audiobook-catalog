# Catalog proxy

Some catalogs don't answer requests from web pages: their APIs send no CORS headers, so the browser
refuses to hand their answers to the app. AudiobookDB, Audible's catalog API, BookBrainz and ISFDB are like
that. Open Library, Wikidata and Hardcover aren't, and the app asks them itself.

The app can ask the others through a proxy of your own: with one saved, the book form's *Fill in from another
catalog* looks Audible pages, ASINs and AudiobookDB books and releases up through it
([Everyday workflows](workflows.md)). It's a small Cloudflare Worker (`proxy/worker.js`)
that runs on Cloudflare's free plan, which allows 100,000 requests a day. It is optional: everything else works
without it, and catalogs that need it are just not asked.

## What the proxy will and won't do

- **Only these catalogs.** A request names a catalog and a path in its API (`/audiobookdb/audiobooks/...`,
  `/audible/audible.co.uk/catalog/products/<ASIN>`), never an address, so it can't be used to reach any other
  site. Only `GET` is allowed, and for Audible only its public catalog API (`/1.0/catalog/...`), never anything
  to do with an account.
- **Only your pages.** It answers only the origins in `ALLOWED_ORIGINS` (in `proxy/wrangler.toml`): the
  app on GitHub Pages and `make serve`.
- **Only with the key.** Every request needs the proxy's key (the `PROXY_KEY` secret on Cloudflare), so a
  copy of the address alone is no use to anyone. The key is never in the repository.
- **Nothing else passes through.** No cookies go either way, and the catalog's answer comes back with only its
  body and type. Answers found are kept for a day, so asking twice doesn't bother the catalog twice.
- **Never Hardcover.** Hardcover answers pages itself, so your Hardcover token goes only to Hardcover.

## Setting it up

You need a free Cloudflare account and Node (which you already have for the tests). From the repository:

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up). Under *Workers & Pages*, pick your
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

4. In the app, open *Import & export*. Under **Catalog proxy**, paste the address and the key and press
   **Save proxy**. The status line should say the proxy answers. **Check** asks it again later, and
   **Remove proxy** forgets it in this browser.

Do step 4 in each browser you use, for example your phone. Like the Hardcover token, the address and key are
kept in that browser only and never put in a backup. Any other page on the same site can read them too, so
the same advice applies as for the [Hardcover token](hardcover.md).

Without installing anything, you can also make the Worker in Cloudflare's dashboard: *Workers & Pages →
Create → Worker*, paste `proxy/worker.js` into its editor and deploy, then under *Settings → Variables and
Secrets* add `PROXY_KEY` as a secret and `ALLOWED_ORIGINS` as text (the line from `wrangler.toml`).

To see it work from a terminal:

```sh
curl -H "X-Proxy-Key: <your key>" https://audiobook-catalog-proxy.<subdomain>.workers.dev/ping
# {"ok":true,"catalogs":["audiobookdb","audible","bookbrainz","isfdb"]}
```

## Changing it

- **A new key:** run `npx wrangler secret put PROXY_KEY` again, then save the new key in the app.
- **The app served from somewhere else:** add its origin (`https://name.example`, no path) to
  `ALLOWED_ORIGINS` in `wrangler.toml` and run `npx wrangler deploy` again.
- **After `git pull`:** if `proxy/worker.js` changed, run `npx wrangler deploy` again.
- **To take it down:** run `npx wrangler delete` and press **Remove proxy** in the app.

## When something is wrong

The status line after **Save proxy** or **Check** says what happened:

- *the proxy refused the key*: the key saved in the app isn't the Worker's `PROXY_KEY`.
- *could not reach the catalog proxy*: the address is wrong, the Worker isn't deployed, or it doesn't allow
  this page. A browser can't tell those apart, so check `ALLOWED_ORIGINS` too.
- *the proxy answered 500*: the Worker has no `PROXY_KEY` yet.
