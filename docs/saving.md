# Running the app and saving edits

The page loads its data with `fetch`, which browsers block for pages opened straight from disk
(`file://`), so serve the project folder: `make serve` (it listens on 127.0.0.1 only, since the folder
holds your personal data). Any static web server pointed at the project root works too. The app uses
`data/books.json` and `data/series-info.json`, or `data/sample/` if you have no `data/books.json`;
`--data-dir` and `CATALOG_DATA_DIR` only affect the command line tools, not the page.

`make serve` also saves: every edit in the pages (books, series info, CSV imports, **Restore** of a
backup, merges) is sent to the server, which checks it like `sync-export` does (the same validation and
tidying) and writes `data/books.json` and `data/series-info.json`, and adds books removed in the page
to `data/excluded.txt` (that file is only ever added to). It only accepts saves from the page
it serves, only to your own `data/books.json` (never the demo), and refuses a save if either file changed
on disk since the page loaded it (an import, a `sync-export`, a hand edit), so it never overwrites
those; reload the page to pick them up. A refused or failed save (for example with the server stopped)
says so under the buttons.

While it runs, `make serve` logs to the terminal, each line stamped with the time: every call the pages
make to its API (method, path, the answer's status, why it refused if it did, and how long it took),
every request it sends to Audible or Hardcover (the address, the Hardcover query's name, the answer's
status), and when a long task (an Audible lookup, a Hardcover import, export or sync) starts and
finishes, with how it went:

```
[21:04:12] started: Hardcover sync (dry run)
[21:04:12] external: POST https://api.hardcover.app/v1/graphql (me) -> 200 (310 ms)
[21:04:19] finished: Hardcover sync (dry run), exit code 0 (7.2 s)
[21:04:19] POST /api/hardcover 200 (7.2 s)
```

It never logs what is sent (your books, your Hardcover token), and not the pages and files it serves.

Until the disk has them, edits also live in that browser's `localStorage`, and with any other static
server they only live there: use **Export** and `sync-export`. **Export / Restore** JSON also make real
backups (books, series info and the import exclusion list). Local edits are tagged with a fingerprint of the `books.json` and
`series-info.json` they were made against. When either changes, older local edits are **set aside**
(kept under the `audiobook-catalog-data.backup` key) instead of silently hiding your new data; if they
still match on the next load, `make serve` saves them then.

All pages share those edits, so moving between them keeps your work. If two tabs edit the catalogue
at once, the one that saves second refuses and asks you to reload it, rather than overwriting the other.
