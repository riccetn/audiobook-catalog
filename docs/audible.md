# Audible

## Add new Audible purchases

1. Export your library with the Audible Library Extractor and save the CSV in `data/raw/`.
2. `node catalog.js import-audible data/raw/<file>.csv --dry-run` to preview, then run it without `--dry-run`.
   Add `--series` (and `--store uk` etc. if needed) to also fill in the new books' series and the release
   info of series new to the catalogue from Audible, as **Fill in series from Audible** below does for the
   whole catalogue.
3. `make test`, then commit `data/books.json`.

Only finished books are imported. The command lists what it added, and anything ambiguous
(for example a book Audible files under several series). Each book gets its Audible edition: the ASIN
(audible.com's; add `--store uk` etc. when the export is from another Audible site),
the ISBNs, the narrators, the publisher, the release date and the length, as far as the export has them.

**Or import in the app**: on the *Import & export* page, press **Audible CSV** (or **Goodreads CSV**) and pick the export (an Audible export
from another site than audible.com: pick the site under the buttons first, so its ASINs are kept as that site's). The page
runs the same importer and merge as the command line (both use `importers.js`), honours
`data/excluded.txt`, and shows the same preview: what is already there, which Audible and Goodreads ids get filled
in, what is new and what needs a look. Nothing changes until you press **Add books**; then, like any
edit in the page, it is saved to `data/books.json` (see [Running the app and saving edits](saving.md)).

## Fill in series from Audible

`node catalog.js series --dry-run` looks up your books on Audible by
their ASIN and shows what it would fill in; run it without `--dry-run` to save it. A book with no series
gets Audible's series and number (spelled the way your other books spell that series), a book with a
series but no number gets the number, and a series with no release info gets the number of books Audible
has out as its total, marked `ongoing` with a note, because Audible can't tell whether a series is finished:
check it and change it to `complete` in the series form. Nothing you have is ever changed. A box set's ASIN
gives its titles the series but not a number (the number would be the set's). A box set's title an
import added as `Ember, Book 2` ([Box sets](imports.md#box-sets)) gets the title of book 2 in Audible's
listing of the series; no other title is changed. Books without an ASIN (only
from Goodreads) are not looked up. It asks about an edition's ASIN on that Audible site, else on the matching
Amazon site (amazon.com for audible.com), else on another site. It asks audible.com; `--store uk` (or `de`, `fr`, `ca`, `au`, ...)
asks another store, for books the first one doesn't know. It needs the internet and uses Audible's own
catalogue API, which needs no account but isn't an official public API, so it could stop working.

**Or in the app**: with `make serve` running, the *Import & export* page has **Fill in series from
Audible**. Pick the store and press **Look up series**; the server asks Audible (a browser may not), and the
page shows what would be filled in, the same way the command does. Nothing changes until you press
**Save series**; then it is saved like any other edit. The panel only shows when the page is served by
`make serve`.
The page can also do it after every Audible CSV import: tick **After an Audible import, look up the new
books' series on Audible** under the import buttons (this browser remembers it). After **Add books**, it
looks up just the new books and shows their series to confirm.
