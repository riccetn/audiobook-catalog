# Narrators and publishers

The *Narrators* and *Publishers* pages work like the [Authors](authors.md) page, for the narrators and
publishers named on the books' editions. Each lists everyone in the catalog with how many of their books
and series you have, and the first line of their bio, or when there is none the authors whose books they
narrate or publish (the three with the most books, "Mostly ..." when there are more); the search box
narrows the list by name.

Click a name (or a narrator's or publisher's name on a book in the catalog) to open their page
(`narrator.html`, `publisher.html`), named by their id in the catalog (an address with the name,
`narrator.html#n=Ingrid+Voss` or `publisher.html#p=Kestrel+Row+Audio`, works too, and so do the addresses
from before, `narrators.html#n=…` and `publishers.html#p=…`):

- a short bio, if you wrote one;
- links to their own website and their pages on Audible, Goodreads, Hardcover, AudiobookDB, ISFDB, BookBrainz and Wikidata (whichever
  have pages for them), if you added them;
- the series they narrate or publish, each with its books in order;
- their books outside a series.

Each book shows its authors, linked to their author pages; on a narrator's page it also names who else
narrates the editions they narrate. A book is on the page when any of its editions names them, so a book
with a US and a UK edition read by different narrators is on both narrators' pages.

**Add or edit the bio and links**: press **Edit** at the end of their page, as on an author's page. Audible has
no narrator or publisher pages, so its field keeps the name Audible searches for: type it, or paste the address
of an Audible search (search for the name and pick *Narrator* or *Publisher* in the filters), for example
`https://www.audible.com/search?searchNarrator=...`, and the link goes to that search. Hardcover lists
narrators as authors (`https://hardcover.app/authors/...`) and has publisher pages
(`https://hardcover.app/publishers/...`), and is asked for the number of either (see [Hardcover](hardcover.md)); Goodreads lists narrators as authors too, and has no publisher
pages, so a publisher has no Goodreads field. Each field takes the id or the address of the page, as on an
author's page. Clearing every field keeps nothing about them; they stay.

Each narrator and publisher is an entry of their own, under the name exactly as the editions write it: they stay,
with no books, when no edition names them any more, until you remove them. Renaming one on the editions
leaves the old name as a narrator (or publisher) with no books. **Remove narrator** (or **Remove
publisher**) in the form takes them off every edition and removes them; the first press says how many
books it changes, the second does it. The books stay. See [Data format](data-format.md#narrators-and-publishers) for how it is kept.
