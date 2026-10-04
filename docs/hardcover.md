# Hardcover

The catalogue can import from and export to your shelves on [Hardcover](https://hardcover.app),
through Hardcover's API. Make a token on Hardcover (**Settings → Hardcover API**, `hardcover.app/account/api`)
with the scopes `read:me`, `read:catalog`, `read:library` and, for exports, `write:library`.

**In the app**, the *Import & export* page has a **Hardcover** panel. It works in two ways.

**With `make serve`** and your own catalogue: Paste the token and press **Save token**: it is kept with your catalogue in `data/hardcover-token`
(git-ignored like your other data, readable only by you, never sent to the page, and not in backups).
Then press **Import**, **Export** or **Sync**: the server runs the same command as below as a dry run and
shows what it would do, and nothing changes, here or on Hardcover, until you confirm. Afterwards the page
reloads the catalogue. It only runs when every edit in the page is saved, and like a save it refuses if
`data/books.json` changed on disk since the page loaded it. **Remove token** deletes the file.

A run goes on in the background on the server, one at a time. While it does, every page of the app shows
a banner on top with what it is doing (reading your shelves, finding your books on Hardcover, putting
them on your shelf...), how far it has got (`12 of 40`) and how long it has been going; the other pages
link to *Import & export* for the details. It keeps going if you reload, close the tab or open another
page, and the banner picks it up again. When it ends, *Import & export* shows what it did, and every page
open on the catalogue reloads it. Don't edit the catalogue while a real run goes: an edit saved meanwhile
stops the run before it writes anything or sends anything to Hardcover (run it again afterwards).

**Anywhere else** (the installed phone app, the demo, or any other web server), the page asks Hardcover
itself. **Save token** keeps the token in this browser only: it is never put in a backup or sent anywhere
but to Hardcover, and **Remove token** forgets it. Only save it on a device that is yours. Any other page on the same site can read it too: on GitHub Pages every
project site of an account (`<name>.github.io/...`) shares one site, so host the app on its own (sub)domain
if you publish other pages there. **Import**,
**Export** and **Sync** first show what would happen, as above, and confirming runs it. The catalogue is
saved before anything is sent to Hardcover, where your edits are usually kept (this browser, or the
device's own catalogue). The banner on top shows the progress. Stay on the page until it is done: leaving
the page, or opening another page of the app, stops the run, so the browser asks first. Stopping early
loses nothing. The books already sent stay on Hardcover, and a run again carries on from there, since
nothing already there is added twice. An edit made meanwhile, here or in another tab, stops the run before
it saves or sends anything. If the browser can't reach Hardcover at all (offline, or Hardcover refusing a
request from a web page), it says so; run it under `make serve` then.

**Or on the command line**, with the token saved as above (or written to `data/hardcover-token` by hand,
or, taking precedence, in the `HARDCOVER_TOKEN` environment variable):

```sh
node catalog.js hardcover-sync --dry-run        # what it would do, on both sides
node catalog.js hardcover-sync                  # import, then export
node catalog.js hardcover-import                # only Hardcover -> catalogue
node catalog.js hardcover-export                # only catalogue -> Hardcover
```

- **Import** reads the books on your Hardcover *Read* shelf, like any import (it only adds, see [How imports avoid clobbering your edits](imports.md)).
  A book read as an audiobook edition on Hardcover is added if it is new; a book you read in another
  format, or without an edition picked, only fills in a book you already have. Each gets Hardcover's book
  id (`hcb`) and an edition with Hardcover's edition id (`hc`), the ASIN, ISBN, narrator, publisher, release
  date and length Hardcover has, and every finished date of its reads (Hardcover keeps them all, so a book you have
  gains the dates it lacks; `2024-03-15` counts as there when you have `2024-03`). A book on Hardcover with
  no finished date gets none, which here means the date is unknown. A box set you read on Hardcover, found
  by its edition on your titles, gives its dates to each of those titles.
- **Export** finds each of your books without a Hardcover book id by its editions' Hardcover id, ASIN, ISBN
  or Goodreads id, saves the book's id (`hcb`) on the book and the edition's (`hc`) on the edition (an ISBN or
  Goodreads id only gives the book's id, since it is often the print edition), and puts the books that aren't on your Hardcover shelves yet on *Read*, with
  each dated read as a Hardcover read. A book already on *Read* gains the reads it lacks. A box set is one
  Hardcover book, so titles that share its id go on Hardcover once; a title with its own Hardcover book
  id goes on as that book. An edition is only sent with a book when Hardcover says it is an edition of
  that book, so a box set's edition on a title with its own book id is left out. A book with no date read goes on *Read* without a
  read. Dates without a day (`2024-03`) can't be sent and are counted; books Hardcover can't be found by
  are listed: give them a `Hardcover <edition id>` in the edit form (the number in the edition's address).
- **Sync** imports, then exports.

Nothing is ever changed or removed on either side: a book on another Hardcover shelf (*Want to Read*,
*Did Not Finish*, ...) is listed and left alone, and ratings and reviews are not touched. Running it again
only does what is still missing. Hardcover allows 60 requests a minute, so the commands ask once a second;
a first export of a large catalogue takes a few minutes. With `--data-dir`, the commands use the token in that folder: if it is a git repository, keep
`hardcover-token` out of it.
