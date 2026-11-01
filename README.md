# Read Along

A Firefox extension that reads web books (mainly O'Reilly Learning) aloud with
Google Cloud Text-to-Speech, highlighting each word and sentence as it reads.
See [goals.md](goals.md) for the full feature list.

## Load it in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `extension/manifest.json`.
3. Open the extension's settings (about:addons → Read Along → Preferences),
   paste your API key, and pick a voice.

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
