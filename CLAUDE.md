# Read Along

Firefox extension (Manifest V3) that reads web books aloud with Google Cloud
Text-to-Speech and highlights as it reads. The code is in `extension/`: no
build step and no dependencies at runtime. `web-ext` is only used for linting,
running and signing.

- `npm run lint` checks the extension. Run it after changes.
- `npm run start` opens a development Firefox with the extension loaded.
- Releases: follow [RELEASING.md](RELEASING.md) step by step. It covers
  signing, GitHub releases and `updates.json`, and where each setting is
  stored. Signing needs the owner's AMO credentials, so the owner runs
  `npm run sign`; the other steps can be done with `gh`.
- Never commit API keys or AMO credentials. Users enter their Google API key
  on the settings page, and it stays in `storage.local`.
