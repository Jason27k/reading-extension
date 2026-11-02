# Read Along

A Firefox extension that reads web books (mainly O'Reilly Learning) aloud with
Google Cloud Text-to-Speech, highlighting each word and sentence as it reads.

You need your own Google Cloud API key with the Text-to-Speech API enabled.
Standard and WaveNet voices are covered by Google's free monthly tier for
moderate use. Restrict the key to the Text-to-Speech API in the Cloud Console.

## Install

Install the signed `.xpi` from the
[latest release](https://github.com/Jason27k/reading-extension/releases/latest)
(open it in Firefox, or drag it onto about:addons). Then open the extension's
settings (about:addons → Read Along → Preferences), paste your API key, and pick
a voice.

The API key stays on each device. Voice, speed, the skip/caption toggles and
the monthly character count sync through Firefox Sync (with **Add-ons** checked
in Sync settings); the count shown is the total across devices. Firefox checks
[updates.json](updates.json) about once a day and installs new versions
automatically; about:addons → gear → **Check for Updates** checks right away.

### For development

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `extension/manifest.json`.

Temporary add-ons are removed when Firefox restarts. After changing code, click
**Reload** on the about:debugging page and refresh the tab you're reading in.

## Use it

- Select some text and press **Alt+Shift+P** (or ▶ on the bar). Reading
  continues until you stop it.
- Right-click anywhere in the text → **Read aloud from here**.
- Click the toolbar icon or press **Alt+Shift+B** to show the control bar.
- All shortcuts are listed on the settings page.

## Development

```sh
npm install
npm run lint    # web-ext lint
npm run build   # zip into web-ext-artifacts/
```

## Release

Signing needs AMO API credentials from
https://addons.mozilla.org/developers/addon/api/key/.

1. Bump `version` in `extension/manifest.json` (AMO rejects a version it has
   already signed).
2. Sign it as an unlisted add-on:
   ```sh
   WEB_EXT_API_KEY=user:... WEB_EXT_API_SECRET=... npm run sign
   ```
   The signed `.xpi` lands in `web-ext-artifacts/`.
3. Create a GitHub release tagged `v<version>` and attach the `.xpi` as
   `read_along-<version>.xpi`.
4. Add the version to `updates.json` and push to `main`.

## License

[MIT](LICENSE)
