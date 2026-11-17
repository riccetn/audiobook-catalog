# Places

A book's **places** are where its story takes place: its setting, as Goodreads calls it. A place is a world, or somewhere in one. Earth
is a world, and so are the worlds invented for stories, fantasy or science fiction alike (a place says nothing
about a book's genre). Somewhere in a world is a country, a region, a city, a school, a ship. When a story takes
place is not kept.

A book may have several places. Places also stand in for a series where one would be wrong: books set in the same
world that are otherwise unrelated stories share a place, not a series.

## Places within places

Each place may be **part of** other places, so they make a hierarchy: a city is part of a region or a country, the
country is part of Earth, and an invented world may be part of Earth too (a hidden world inside ours). A book set
in a place is set in everything that place is within: a story set in Port Wren, part of the Gull Coast, part of
Emberlands, is set in all three.

- A book's page lists its places, each with what it is within after it: _Port Wren (Gull Coast, Emberlands)_.
- A place's page lists the books set there, then the books set in each place within it, so a world's page shows
  every story set anywhere in it.
- A place can be part of several (a place on a border, or a made-up place within a real one). It can't be part of
  itself, or of a place within it; the form refuses that, and Check reports it when a backup has it.

## Worlds and who owns them

For an invented world the form keeps **Created by**, the authors who made it (they link to the authors' pages, and
an author with no books in the catalog is added as one), and **Rights held by**, when that is someone else: an open
world many authors write in is often owned by the company that publishes its stories. Many worlds have one author;
an open world may have books by many, each of them set there.

## The pages

- **Places** (in the nav bar) lists every place as a tree: those part of none at the top, each with the places
  within it below, and how many books are set in each and in the places within it (a book set in several of them
  counted once, and not at all when it is set in the place itself). A place part of two shows
  under each, but the places within it only under the first; the other says where they are. The search lists the
  places whose names match, each with what it is part of. _+ Add a place_ opens the form of a new place, where you
  name it.
- A **place's page** (`place.html#place=<id>`) shows what it is part of (and what those are within), who created
  it and holds its rights, its note, its links, the places within it as a tree with it at the top, and the books.
  _+ Add a place within it_ opens a new place's form with _Part of_ filled in. **Edit** opens the form: its
  name (a rename changes it on every book and every place part of it; renaming it to another place's name joins the
  two on a second Save), what it is part of, its creators, its rights holder, a note, its ids on Goodreads (a
  Goodreads _place_) and Wikidata, and other links. **Remove place** (pressed twice) takes it off its books and
  removes it; the places within it stay, part of what it was part of instead.
- On the **Edit** page each book has a **Places** field, which offers the catalog's places as you type and says
  which names are new: they are added when you save. Separate names with commas; a place with a comma in its name
  ("Fernhold, Upper Reach") stays whole once the catalog has it.
- The search on the Books page finds a book by its places' names too, and **Stats** counts the books without a
  place and the places without an external id.

Imports don't bring places: Goodreads' export has none, and the other catalogs aren't asked for them. A book an
import matches keeps its places, and merging two books keeps the places of both.

Places are kept with the catalog, in backups (version 6: `places`, and books' `placeIds`; [Data format](data-format.md))
and when syncing.
