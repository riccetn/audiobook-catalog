# On your phone

The app installs as a phone app (a PWA: Add to home screen, full screen, works offline). Android only
installs it from an HTTPS address, so host the `public/` folder as a plain static site, for example with
GitHub Pages: set repository **Settings → Pages → Source** to **GitHub Actions**, and the _Pages_ workflow
(`.github/workflows/pages.yml`) writes the pages from `templates/` and publishes `public/` on every push to `main`. That site only serves the app:
your catalog is never in git, and nothing outside `public/` is published. [Your server](server.md#the-app-on-it) on
Cloudflare serves the app too, at its own address, and installs the same way.

Then, on the phone:

1. Open the site in Chrome and choose **Add to home screen** (or **Install app**).
2. Bring over your settings ([below](#settings-by-qr-code)): your server, the sync passphrase and your keys for the catalogs.
3. On the PC, **Export** a backup on the _Import & export_ page; get the file onto the phone. (With sync set up,
   **Sync now** on the phone instead.)
4. In the installed app, **Restore** that backup. The phone keeps it in its browser storage, like any
   browser does ([Running the app and keeping your catalog](saving.md)), and every edit and import on the phone is saved there.

The phone's catalog and the PC's are separate. With sync set up on your server, **Sync now** on each
keeps them alike ([Syncing devices](server.md#syncing-devices)). Without it, to bring phone edits to the PC, Export on the phone and
**Merge** that file on the PC ([Merge a backup from another device](backups.md)), or Restore it if nothing
changed on the PC meanwhile. The other way, Export on the PC and **Merge** it in the phone app.

## Settings by QR code

Your server's address and key, the sync passphrase, the Hardcover token and the AudiobookDB key are kept in each
browser only, never in a backup, so a new device needs them too. Rather than typing them, on the PC open
_Import & export_ and under **Set up another device** tick the ones to bring over and press **Show QR code**.
Scan it with the phone's camera: it opens _Import & export_ on the phone, which lists what the link brings (and
what it would replace) and saves it only when you press **Save these settings**; it then checks the server, as
saving it by hand does.

- The settings travel in the link after the `#`, which a browser never sends to any server, and the phone takes
  them out of its address (and its history) as soon as the page opens. But anyone who sees the code can read
  them, like a password shown on screen: show it only to your own phone. It hides itself after two minutes, or
  press **Hide**.
- The link opens the app at the address the PC has it (GitHub Pages, say), so the phone should use the app at
  that address too: each address keeps its own settings and catalog. On `make serve` (an address on the PC only),
  the link opens your server's address instead, as it serves the app too.
- With everything ticked the code is dense (the Hardcover token is long); a phone reads it fine off a monitor.

The service worker (`public/sw.js`) answers the app's files from its cache, without downloading them again.
At each start the browser checks only whether a new version was published; if one was, it is downloaded whole
in the background and shows from the next start on. Served from your own computer (`make serve`), the network
goes first instead, so an edit shows at once.

On a phone's narrow screen the page keeps the list near the top: the page links stay on one line that
scrolls sideways, and the catalog's filters fold away behind a **Filters** button next to the search box,
which shows how many are on (_Filters · 2_). A book opened on its own shows no search or filters.
