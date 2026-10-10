# Hardcover

The catalogue can import from and export to your shelves on [Hardcover](https://hardcover.app),
through Hardcover's API. Make a token on Hardcover (**Settings → Hardcover API**, `hardcover.app/account/api`)
with the scopes `read:me`, `read:catalog`, `read:library` and, for exports, `write:library`.

The *Import & export* page has a **Hardcover** panel, and the page asks Hardcover itself. Paste the token
and press **Save token**: it is kept in this browser only, never put in a backup or sent anywhere but to
Hardcover, and **Remove token** forgets it. Only save it on a device that is yours. Any other page on the
same site can read it too: on GitHub Pages every project site of an account (`<name>.github.io/...`)
shares one site, so host the app on its own (sub)domain if you publish other pages there.

**Import**, **Export** and **Sync** first show what would happen, and nothing changes, here or on
Hardcover, until you confirm; confirming runs it. The catalogue is saved before anything is sent to
Hardcover. While it runs, a banner on top shows what it is doing (reading your shelves, finding your books
on Hardcover, putting them on your shelf...), how far it has got (`12 of 40`) and how long it has been
going. Stay on the page until it is done: leaving the page, or opening another page of the app, stops the
run, so the browser asks first. Stopping early loses nothing. The books already sent stay on Hardcover,
and a run again carries on from there, since nothing already there is added twice. An edit made
meanwhile, here or in another tab, stops the run before it saves or sends anything. If the browser can't
reach Hardcover at all (offline, or Hardcover refusing a request from a web page), it says so.

**A book's Hardcover id from its address.** The Hardcover app doesn't show ids. In a book's edit form,
paste the address of the book's page (`https://hardcover.app/books/the-salt-road`) or of one of its editions' pages into the *Hardcover book* field, and the page asks Hardcover for the
book's id with the same token. An edition's
address in an edition's *Hardcover edition* field needs no lookup: it holds the edition's id.

- **Import** reads the books on your Hardcover *Read* shelf, like any import (it only adds, see [How imports avoid clobbering your edits](imports.md)).
  A book read as an audiobook edition on Hardcover is added if it is new; a book you read in another
  format, or without an edition picked, only fills in a book you already have. Each gets Hardcover's book
  id (`hcb`) and an edition with Hardcover's edition id (`hc`), the ASIN (as amazon.com's, the site Hardcover uses), ISBN, narrator, publisher, release
  date and length Hardcover has, and every finished date of its reads (Hardcover keeps them all, so a book you have
  gains the dates it lacks; `2024-03-15` counts as there when you have `2024-03`). A book on Hardcover with
  no finished date gets none, which here means the date is unknown. A box set you read on Hardcover, found
  by its edition on your titles, gives its dates to each of those titles, and is added as their collection
  when they are numbers in a row of one series ([Box sets](imports.md#box-sets)).
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
only does what is still missing. Hardcover allows 60 requests a minute, so the page asks once a second;
a first export of a large catalogue takes a few minutes.
