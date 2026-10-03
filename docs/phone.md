# On your phone

The app installs as a phone app (a PWA: Add to home screen, full screen, works offline). Android only
installs it from an HTTPS address, so host the repository as a plain static site, for example with
GitHub Pages (repository **Settings → Pages → Deploy from a branch**, `main`, `/ (root)`). That site
only serves the app and the demo data: your `data/` files are never in git, so they are never on it.

Then, on the phone:

1. Open the site in Chrome and choose **Add to home screen** (or **Install app**).
2. On the PC, **Export** a backup on the *Import & export* page; get the file onto the phone.
3. In the installed app, **Restore** that backup. Because that copy of the app has no `data/books.json`
   of its own, the restored catalogue becomes **this device's own catalogue**: it is kept in the phone's
   browser storage (`audiobook-catalog-device`), loads instead of the demo from then on, and every edit
   and CSV import on the phone is saved there. Restoring another backup replaces it.

The phone's catalogue does not sync with `data/` yet: to bring phone edits back to the PC, Export on the
phone and run `node catalog.js sync-export` on the PC. A page served with its own `data/books.json`
(`make serve`) always uses that and ignores any device catalogue.

The service worker (`sw.js`) fetches everything from the network first and only falls back to its
cached copy offline, so a new version shows up on the next start while online. It caches the app and
the demo data, never your own `data/` files or the save endpoint.
