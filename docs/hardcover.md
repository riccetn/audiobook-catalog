# Hardcover

The catalog can compare itself with your shelves on [Hardcover](https://hardcover.app), take books and
values from them, and put your books and dates read on them, through Hardcover's API. Make a token on Hardcover (**Settings → Hardcover API**, `hardcover.app/account/api`)
with the scopes `read:me`, `read:catalog`, `read:library` and, for exports, `write:library`.

The *Import & export* page has a **Hardcover** panel, and the page asks Hardcover itself. Paste the token
and press **Save token**: it is kept in this browser only, never put in a backup or sent anywhere but to
Hardcover, and **Remove token** forgets it. Only save it on a device that is yours. Any other page on the
same site can read it too: on GitHub Pages every project site of an account (`<name>.github.io/...`)
shares one site, so host the app on its own (sub)domain if you publish other pages there.

**Compare** reads your Hardcover shelves (it changes nothing, here or on Hardcover) and shows them beside the
catalog, the way an import does ([the comparison](imports.md#the-comparison)). To work through the catalog a part
at a time, pick *a series* or *an author* beside the button and type its name (the field offers the names in the
catalog): only the books of that series, or by that author, here and on your Hardcover *Read* shelf, are compared
and offered to put on Hardcover (a series spelled another way on Hardcover, `Gull Isle Series`, is the same series).
The comparison has more groups for Hardcover:

- **Not on your Hardcover Read shelf**: your books Hardcover knows (by an id, ASIN, ISBN or Goodreads id) that
  aren't on your shelves there, with their dates read. Unticked: tick a book to put it on your *Read* shelf.
- **Reads Hardcover lacks**: books on your *Read* shelf there without some of your dates read. Unticked:
  tick a book to add those reads on Hardcover.
- **Save the Hardcover ids found**: ticked, it keeps the Hardcover book and edition ids found for your books,
  so later comparisons and edits find them at once.
- **On another Hardcover shelf, left alone** and **Not found on Hardcover** list the books that can't be put on
  your *Read* shelf, and how many dates read have no day (a Hardcover read needs one).

**Apply** first takes what you ticked into the catalog and saves it, then sends what you ticked to Hardcover;
nothing is sent unless you ticked it. If another tab saved an edit since you compared, nothing is changed or
sent: compare again. While it runs (and while it compares), a banner on top shows what it is doing (reading your
shelves, finding your books on Hardcover, putting them on your shelf...), how far it has got (`12 of 40`) and how
long it has been going. Stay on the page until it is done sending: leaving the page, or opening another page of
the app, stops it, so the browser asks first. Stopping early loses nothing. The books already sent stay on
Hardcover, and comparing again shows what is still missing, since nothing already there is added twice. If the
browser can't reach Hardcover at all (offline, or Hardcover refusing a request from a web page), it says so.

**A book's Hardcover id from its address.** The Hardcover app doesn't show ids. In a book's edit form,
paste the address of the book's page (`https://hardcover.app/books/the-salt-road`) or of one of its editions' pages into the *Hardcover book* field, and the page asks Hardcover for the
book's id with the same token. An edition's
address in an edition's *Hardcover edition* field needs no lookup: it holds the edition's id.

**A series', author's, narrator's or publisher's Hardcover id.** These are kept by their number on Hardcover too
(linked as `https://hardcover.app/id/author/4101`, which keeps working when Hardcover renames the page). Their pages'
addresses have a name in them instead (`https://hardcover.app/authors/marisol-quenby`), so when you paste one, or
the name alone, into the Hardcover field of the series or info form, the page asks Hardcover for the number as
soon as you leave the field (or when you save), with the same token. If Hardcover can't be asked (no token saved,
offline, the token refused), the name is kept instead and the status line says so; it links to the page by its
address until Hardcover renames it. Saving the form again later, with Hardcover reachable, swaps it for the
number. A name Hardcover has no page for is refused. Entries saved before Hardcover ids were numbers keep their
names until their form is saved.

- **From Hardcover**: the books on your Hardcover *Read* shelf are compared like any import (see [How imports avoid clobbering your edits](imports.md)).
  A book read as an audiobook edition on Hardcover is added if it is new; a book you read in another
  format, or without an edition picked, only fills in a book you already have. Each gets Hardcover's book
  id (`ext.hardcover` on the book) and an edition with Hardcover's edition id (`ext.hardcover` on the edition), the ASIN (as amazon.com's, the site Hardcover uses), ISBN, narrator, publisher, release
  date and length Hardcover has, and every finished date of its reads (Hardcover keeps them all, so a book you have
  gains the dates it lacks; `2024-03-15` counts as there when you have `2024-03`). A book on Hardcover with
  no finished date gets none, which here means the date is unknown. A box set you read on Hardcover, found
  by its edition on your titles, gives its dates to each of those titles, and is added as their collection
  when they are numbers in a row of one series ([Box sets](imports.md#box-sets)).
- **To Hardcover**: the comparison finds each of your books without a Hardcover book id by its editions' Hardcover id, ASIN, ISBN
  or Goodreads id, saves the book's id on the book and the edition's on the edition (an ISBN or
  Goodreads id only gives the book's id, since it is often the print edition), and the books you tick that aren't on your Hardcover shelves yet go on *Read*, with
  each dated read as a Hardcover read. A book already on *Read* that you tick gains the reads it lacks. A box set is one
  Hardcover book, so titles that share its id go on Hardcover once; a title with its own Hardcover book
  id goes on as that book. An edition is only sent with a book when Hardcover says it is an edition of
  that book, so a box set's edition on a title with its own book id is left out. A book with no date read goes on *Read* without a
  read. Dates without a day (`2024-03`) can't be sent and are counted; books Hardcover can't be found by
  are listed: give them a `Hardcover <edition id>` in the edit form (the number in the edition's address).

Nothing is ever changed or removed on either side: a book on another Hardcover shelf (*Want to Read*,
*Did Not Finish*, ...) is listed and left alone, and ratings and reviews are not touched. Running it again
only does what is still missing. Hardcover allows 60 requests a minute, so the page asks once a second;
a first export of a large catalog takes a few minutes.
