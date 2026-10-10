# On your phone

The app installs as a phone app (a PWA: Add to home screen, full screen, works offline). Android only
installs it from an HTTPS address, so host the repository as a plain static site, for example with
GitHub Pages (repository **Settings → Pages → Deploy from a branch**, `main`, `/ (root)`). That site
only serves the app: your catalogue is never in git, so it is never on it.

Then, on the phone:

1. Open the site in Chrome and choose **Add to home screen** (or **Install app**).
2. On the PC, **Export** a backup on the *Import & export* page; get the file onto the phone.
3. In the installed app, **Restore** that backup. The phone keeps it in its browser storage, like any
   browser does ([Running the app and keeping your catalogue](saving.md)), and every edit and import on the phone is saved there.

The phone's catalogue and the PC's are separate. To bring phone edits to the PC, Export on the phone and
**Merge** that file on the PC ([Merge a backup from another device](backups.md)), or Restore it if nothing
changed on the PC meanwhile. The other way, Export on the PC and **Merge** it in the phone app.

The service worker (`sw.js`) fetches everything from the network first and only falls back to its
cached copy offline, so a new version shows up on the next start while online. It caches the app only,
never anything under `data/`.
