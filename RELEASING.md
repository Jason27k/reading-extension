# Releasing

Read Along is distributed as an **unlisted** add-on: Mozilla signs it through
addons.mozilla.org (AMO), but it isn't listed there. Signed builds are attached
to GitHub releases, and installed copies update themselves from
[`updates.json`](updates.json) via the `update_url` in
`extension/manifest.json`.

## One-time setup

- AMO API credentials from https://addons.mozilla.org/developers/addon/api/key/.
  Keep them out of the repo; pass them as `WEB_EXT_API_KEY` and
  `WEB_EXT_API_SECRET`.
- `gh` logged in to GitHub with push access to this repo.
- `npm install`.

## Steps

1. **Bump `version`** in `extension/manifest.json`. AMO rejects any version it
   has already received, including ones that failed or timed out.
2. **Lint:** `npm run lint`. It runs in `--self-hosted` mode, because the
   normal mode reports `update_url` as an error (only AMO-listed add-ons have
   to omit it).
3. **Commit and push** the change to `main`. Installed copies don't update
   until `updates.json` changes (step 6).
4. **Sign:**
   ```sh
   WEB_EXT_API_KEY=user:... WEB_EXT_API_SECRET=... npm run sign
   ```
   It validates the upload, then waits for Mozilla's automatic signing, usually
   a few minutes. The signed file is downloaded to
   `web-ext-artifacts/<hash>-<version>.xpi`. If the command times out, the
   submission still goes through. Download the signed file from the
   [Developer Hub](https://addons.mozilla.org/developers/addons) (Read Along →
   Manage Status & Versions) instead of signing again.
5. **Create the GitHub release** with the file renamed to
   `read_along-<version>.xpi`, the name `updates.json` links to:
   ```sh
   cp web-ext-artifacts/*-<version>.xpi /tmp/read_along-<version>.xpi
   gh release create v<version> /tmp/read_along-<version>.xpi --target main \
     --title "v<version>" --notes "<what changed>"
   ```
6. **Publish the update.** Only after the release download works, append the
   version to `updates.json`, then commit and push:
   ```json
   {
     "version": "<version>",
     "update_link": "https://github.com/Jason27k/reading-extension/releases/download/v<version>/read_along-<version>.xpi"
   }
   ```
   Firefox checks about once a day. To update right away, use about:addons →
   gear → **Check for Updates**.

The order matters: if `updates.json` lists a version before its download link
works, Firefox's update fails.

## Checks

- `unzip -l <file>.xpi | grep META-INF` lists signature files. Unsigned builds
  have none, and release Firefox refuses to install them.
- `curl -sL -o /dev/null -w '%{http_code}\n' <update_link>` returns `200`.
- The extension's AMO page saying "not available on your platform" with a
  disabled **Add to Firefox** button is expected for unlisted add-ons.

## Storage and sync

Changes to what's stored need care, because existing installs carry data over
between versions:

- `storage.sync` (synced by Firefox Sync when **Add-ons** is checked):
  `voice`, `rate`, `skipCode`, `readCaptions`, and one `usage-<deviceId>`
  entry per device. Each device writes only its own usage entry, and the
  settings page adds them up, so devices never overwrite each other's counts.
- `storage.local` (this device only): `apiKey`, `deviceId`, `barPos`,
  `barCollapsed`.
- Data saved by older versions is moved in `background.js` (`migrateToSync`,
  `migrateUsage`) from `runtime.onInstalled`. Add a migration there when moving
  or renaming a key.
- Only values the user changes get stored; defaults live in code. A new device
  with nothing synced yet shows the defaults.
