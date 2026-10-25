# On your phone

The app installs as a phone app (a PWA: Add to home screen, full screen, works offline). Android only
installs it from an HTTPS address, so host the `public/` folder as a plain static site, for example with
GitHub Pages: set repository **Settings → Pages → Source** to **GitHub Actions**, and the _Pages_ workflow
(`.github/workflows/pages.yml`) writes the pages from `templates/` and publishes `public/` on every push to `main`. That site only serves the app:
your catalog is never in git, and nothing outside `public/` is published.

Then, on the phone:

1. Open the site in Chrome and choose **Add to home screen** (or **Install app**).
2. On the PC, **Export** a backup on the _Import & export_ page; get the file onto the phone.
3. In the installed app, **Restore** that backup. The phone keeps it in its browser storage, like any
   browser does ([Running the app and keeping your catalog](saving.md)), and every edit and import on the phone is saved there.

The phone's catalog and the PC's are separate. To bring phone edits to the PC, Export on the phone and
**Merge** that file on the PC ([Merge a backup from another device](backups.md)), or Restore it if nothing
changed on the PC meanwhile. The other way, Export on the PC and **Merge** it in the phone app.

The service worker (`public/sw.js`) answers the app's files from its cache, without downloading them again.
At each start the browser checks only whether a new version was published; if one was, it is downloaded whole
in the background and shows from the next start on. Served from your own computer (`make serve`), the network
goes first instead, so an edit shows at once.

On a phone's narrow screen the page keeps the list near the top: the page links stay on one line that
scrolls sideways, and the catalog's filters fold away behind a **Filters** button next to the search box,
which shows how many are on (_Filters · 2_). A book opened on its own shows no search or filters.
