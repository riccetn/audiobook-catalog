# Editing a series

**Edit** at the end of a series' page opens the _Edit series_ page (`edit.html#series=<id>`): the series and
every book in it on one page, a card for each book. Everything is edited in place, and nothing is saved until
you press **Review & save** and then **Save**.

## The series

Its name (a new name renames it on every book in it), how many books are released, whether it is ongoing or
complete, a note, and its ids in other catalogs. **Remove series** takes it off its books and removes it; it
asks you to save or discard your changes first. See [Everyday workflows](workflows.md).

## A book

Each book's card has its title, authors, number in the series, genres, dates read and its ids in other
catalogs (Goodreads, Hardcover, Open Library, ...). A field that changed is marked, and one that can't be read
(a date such as "last spring") is named on the book and changes nothing until it is fixed.

## Its editions

Each edition is told apart by the start of its description; without one, by its narrators; without those,
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

## Saving

**Review & save** lists every change, book by book: the fields, and each edition added, changed or removed.
While the list is open the fields can't be changed, so **Save** saves just what it lists; **Back** goes on
editing. When a field can't be read, Review & save says so and scrolls to it instead. **Save** returns to the
series' page, which says what was saved; **Discard** returns to it without saving anything.
