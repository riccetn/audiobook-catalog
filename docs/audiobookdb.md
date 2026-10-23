# AudiobookDB

The catalog can find its books on [AudiobookDB](https://audiobookdb.org), compare itself with your shelves
there, take books and values from them, and put your books on your *Listened* shelf there (AudiobookDB's Read
shelf), through AudiobookDB's API.
AudiobookDB's API doesn't answer web pages (it sends no CORS headers), so the page asks it through your own
[catalog proxy](catalog-proxy.md): save one on the *Import & export* page first.

## Your API key

Finding your books and reading AudiobookDB's catalog needs no account. Reading your shelves and putting books
on them needs your API key: sign in on audiobookdb.org and make one under your account. On the *Import & export*
page, the **AudiobookDB** panel has a field for it: paste the key and press **Save key**. It is kept in this
browser only, never put in a backup, and **Remove key** forgets it. Like the [Hardcover token](hardcover.md),
only save it on a device that is yours.

The key goes to AudiobookDB through your proxy, as nothing else can reach AudiobookDB from a page. The page sends
it only with the requests that act for your account (who the key belongs to, your shelves, and putting a book
on a shelf), and the proxy passes it on only to those, refuses it with anything else, never caches what they
answer, and never stores the key.

## Compare

**Compare** reads AudiobookDB (it changes nothing, here or there) and shows what it found beside the catalog,
the way an import does ([the comparison](imports.md#the-comparison)):

1. Each of your books is found on AudiobookDB: by its AudiobookDB id when it has one, else by its editions'
   ASINs (one request per book, so a first comparison of a large catalog takes a few minutes; asking again
   within a day is quicker, as the proxy keeps the answers).
2. With your key, the books on your *Listened* shelf there are compared with the catalog's. A book you don't have
   is offered as **New from AudiobookDB**, with its title, authors, series and number, genres, and its release
   as an edition (its AudiobookDB id, ISBN, narrators, publisher, release date, length and cover). AudiobookDB shelves
   books, not releases: a book with several releases is only added when one of them is yours (by its ASIN),
   otherwise it is listed as not added: add it from the book form with your release's address.
3. The comparison has more groups for AudiobookDB:
   - **Not on your AudiobookDB Listened shelf**: your books AudiobookDB has that aren't on *Listened* there.
     Everything in the catalog counts as read, with a date or without. Unticked: tick a book to put it on
     your *Listened* shelf.
   - **Save the AudiobookDB ids and covers found**: ticked, it keeps the AudiobookDB ids found for your books and their
     editions (the release each one is), and for their series, authors, narrators and publishers (where
     AudiobookDB names them the same), so later comparisons find them at once and their pages link there;
     and each of those editions' cover ([Covers](#covers)). This needs no key.
   - **On another AudiobookDB shelf, left alone** (*To Listen* or *Currently Listening*: a book is on one
     of these and *Listened* at a time, so putting it on *Listened* would take it off) and **Not found on
     AudiobookDB** list the books that won't be put on *Listened*. *Favorites* and your own shelves don't count.

AudiobookDB doesn't keep dates read, ratings or reviews, so none are compared or sent.

**A series or an author.** Pick *a series* or *an author* beside the button and type its name (the field offers
the names in the catalog): only the books of that series, or by that author, are looked up, compared and offered
to put on AudiobookDB. The series or author is found on AudiobookDB by the AudiobookDB id in its info form, else
from your books of it there. For a series, the books AudiobookDB lists in it that aren't in the catalog are
listed too, to look through. **Compare with AudiobookDB** on a series' page (on *Series*) or on an author's
page opens the *Import & export* page and compares that series or author at once.

## Apply

**Apply** first takes what you ticked into the catalog and saves it, then puts the books you ticked on your
*Listened* shelf on AudiobookDB; nothing is sent unless you ticked it. If another tab saved an edit since you
compared, nothing is changed or sent: compare again. While it runs, a banner on top shows how far it has got.
Stay on the page until it is done: leaving stops it, so the browser asks first. Stopping early loses nothing,
and comparing again shows what is still missing, as nothing already there is added twice.

Nothing is ever changed or removed on AudiobookDB: no book is taken off a shelf, no shelf is made, and
AudiobookDB's own catalog (its books, people and series) is never edited.

## Covers

AudiobookDB has a cover for most books and releases. The address of its image can't be worked out from the
release's id (as Amazon's is from an ASIN), so an edition keeps its key once AudiobookDB has given it: when
*Fill in from another catalog* fills in an AudiobookDB release, and when **Compare** finds your book there (the
release's cover, else the book's; ticked under **Save the AudiobookDB ids and covers found**). A cover already kept
is never replaced. The book's card and details then show AudiobookDB's cover before any other, loaded from
AudiobookDB's image server without the proxy; *Covers* off turns it off with the others. The form shows no field
for it: removing the release from the edition doesn't remove the cover, but removing the edition does.

## When something is wrong

- *AudiobookDB is asked through your catalog proxy*: save a [catalog proxy](catalog-proxy.md) first.
- *AudiobookDB refused your API key*: make a new key on audiobookdb.org and save it again.
- *the catalog proxy refused it (400)* or *(405)*: your proxy was deployed before AudiobookDB's shelves were
  added. Run `npx wrangler deploy` in `proxy/` again.
- *AudiobookDB asks to slow down*: it allows a daily budget of requests (about 10,500 a day without a key, and about 20,000 with yours).
  The page waits a little and asks again when AudiobookDB says it will take more soon, and stops when the day's budget
  is spent; try again the next day.
- *AudiobookDB has no Read shelf of yours*: the page looks for AudiobookDB's own shelf named *Read*, else
  *Listened* (or *Finished*); the message lists the shelves it found.
