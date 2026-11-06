# Editing a series

**Edit** at the end of a series' page opens the _Edit series_ page (`edit.html#series=<id>`): the series and
every book in it on one page, a card for each book, with what the other catalogs have for them. Everything is
edited in place, and nothing is saved until you press **Review & save** and then **Save**.

**Edit their books** on an author's page opens the same page for every book by them (`edit.html#author=<id>`),
each with its series and number among its fields; the author's own name, bio and links stay in their form.

## The series

Its name (a new name renames it on every book in it), how many books are released, whether it is ongoing or
complete, a note, and its ids in other catalogs. **Remove series** takes it off its books and removes it; it
asks you to save or discard your changes first. See [Everyday workflows](workflows.md).

## A book

Each book's card has its title, authors, number in the series, genres, dates read and its ids in other
catalogs (Goodreads, Hardcover, Open Library, ...). A field that changed is marked, and one that can't be read
(a date such as "last spring") is named on the book and changes nothing until it is fixed.

## Its editions

Each edition is told apart by its description (a short name for it, such as `UK edition` or `Full cast`); without one, by its narrators; without those,
by its ids. Its publishers, release date, length and ids follow. An edition a box set shares with other
books of the series says so: a change to it changes it there too.

Open an edition to edit its title (only when it was released under another title than the book's),
narrators, publishers, release date, length, ISBN, description and each of its ids. **Another id** takes
the address of the edition's page on any catalog, and becomes a field of its own.

- **Merge with…** lists the book's other editions that can be one with it (none of their ids disagree:
  two ASINs on one site, or two ISBNs, are two editions) and makes them one, keeping what the first has.
- **Split** moves the fields you pick to a new edition, and copies those you pick onto both.
- **Remove edition** takes it off the book. Tick **Don't let imports add it again** to put its ids on the
  exclusion list as `Edition` entries: imports then leave that edition out, but its book still matches by
  its other editions or its title and gains everything else. **Show** beside _Excluded_ on _Import &
  export_ lists every entry, and **Remove** takes one off.
- **+ Add an edition** adds an empty one to fill in.

## Other catalogs

When the page opens it asks every catalog you have set up for the series' (or author's) books: Hardcover with
your token, AudiobookDB through your server's catalog proxy, and Audible through it too (a series only). Each is
read as its **Compare** on _Import & export_ would read it, but only for these books, and nothing is sent to any
catalog. Untick one under _Other catalogs_ to leave it out: it stays left out in this browser until you tick it
again. A catalog that can't be asked says why (no token, or no server saved), and **Ask again** asks those ticked
once more (after you add an id to a book, say).

What they say is shown on the books, and nothing of it is taken until you pick it and save:

- **Beside a field**, each value a catalog has that differs from yours, with the catalogs that have it
  (`9h`, marked with the icons of the catalogs that have it: **Hc** Hardcover, **AD** AudiobookDB, **Au** Audible). Press one to put it in the field; it is a change like any other you type.
  Beside the series' name, the names the catalogs give it.
- **Links** to the book's page on each catalog that has it, and which don't (`not found on Audible`).
- **Found on …**: the ids (and covers, shown) a catalog found for the book and its editions. **Take** puts them
  in the book's fields.
- **… has more**: what the catalog's book would add, as an import would (ids, dates read, and what its edition
  fills in on yours). Tick _and its edition_ to take the edition too (filled into the one it is, or added),
  as an edition listed there may not be yours.
- **Maybe not an audiobook**: an edition of yours a catalog calls a print book or ebook, or an ASIN Audible
  doesn't sell.

Under the books, **Not in your catalog** lists the catalogs' books that none of yours are, each once with the
catalogs that have it: tick one to add it when you save (and pick whose, when several have it). _Other
catalogs_ also names the books a catalog lists in the series that it didn't read (so they can't be added from
here), and offers to keep the ids the
catalogs found for the series and its people where they have none.

An edition you keep out of imports (an `Edition` entry, as **Remove edition** below puts) offers nothing: its
values aren't shown beside the fields and taking its book leaves it out. A book lists those editions behind
**excluded editions**, to see what they are; **Show** beside _Excluded_ on _Import & export_ lets them in again.

## Saving

**Review & save** lists every change, book by book: the fields, and each edition added, changed or removed.
While the list is open the fields can't be changed, so **Save** saves just what it lists; **Back** goes on
editing. When a field can't be read, Review & save says so and scrolls to it instead. **Save** saves the
books, adds the new books ticked, and keeps the ids picked for the series and people, then returns to the
series' (or author's) page, which says what was saved; **Discard** returns to it without saving anything.
