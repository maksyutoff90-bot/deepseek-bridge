# Chrome Web Store checklist

## 1. Before uploading

* [ ] Bump `version` in `extension/manifest.json` (store does not accept a version that
      already exists; next would be `0.2.1`).
* [ ] Build the package (only the `extension` folder, no `.git`, no `dist`):

  ```powershell
  Compress-Archive -Path extension\* -DestinationPath dist\deepseek-bridge-0.2.1.zip -Force
  ```

* [ ] Check the zip opens and contains `manifest.json` at the root.
* [ ] Make sure no personal paths or tokens are inside (`gateway/.token` is not in the
      extension folder, so it is fine).

## 2. Account

* [ ] Chrome Web Store developer account ($5 one-time), email verified.
* [ ] Two-step verification on the Google account (required for publishing).

## 3. Store listing

| Field | Value |
|---|---|
| Name | `DeepSeek Bridge` (currently the manifest says “WebCode Bridge (prototype)” — rename before submitting) |
| Short description (132 chars) | `Local coding agent for the DeepSeek web chat: sandboxed edits, review before apply, backups. No API key.` |
| Category | Developer Tools |
| Language | English (add Russian as a second locale if you want) |
| Homepage | `https://github.com/maksyutoff90-bot/deepseek-bridge` |
| Support | `https://github.com/maksyutoff90-bot/deepseek-bridge/issues` |
| Privacy policy | `https://github.com/maksyutoff90-bot/deepseek-bridge/blob/main/PRIVACY.md` |

## 4. Graphic assets

* [ ] Icon 128×128 (the manifest currently has no icon — add `icons` before submitting).
* [ ] Screenshots 1280×800 or 640×400, 1–5 pieces. Use the mock page only, no personal
      chats. `screenshot.png` can be cropped to 1280×800.
* [ ] Small promo tile 440×280 (optional but improves placement).
* [ ] Marquee 1400×560 (optional).

## 5. Permissions justification (review form)

* `storage` — saves the gateway port and token locally.
* `host_permissions: https://chat.deepseek.com/*` — the content script reads the chat page
  to find tool calls and code blocks, and writes results into the composer.
* `host_permissions: http://127.0.0.1/*` — the extension talks to the user's own local
  gateway; nothing leaves the machine except the messages the user sends to DeepSeek.
* Content scripts — one entry for the chat page, one for the local mock page used by the
  test suite (`include_globs: *webcode-mock*`).

Reviewer notes to include:

> The extension is a client for a local Node gateway that the user runs themselves
> (`start-gateway.cmd`). Without the gateway it only shows a panel with a connection error.
> The gateway is part of the same open-source repository. No remote code is loaded; the
> extension contains no `eval` and no external scripts.

## 6. Data usage disclosures

* Website content — yes (reads the chat page).
* Personally identifiable information — no.
* Health, financial, authentication — no.
* The extension does not sell or transfer data; it communicates only with the page the user
  is on and with `127.0.0.1`.

## 7. Common rejection reasons

* **Broad host permissions.** We narrowed `127.0.0.1` to the mock page with `include_globs`;
  keep it that way.
* **Remote code.** None — do not add CDN scripts or `eval`.
* **Unclear single purpose.** Write: “Bridge between the DeepSeek web chat and a local
  project, with sandboxed edits and review before applying.”
* **Missing privacy policy.** Link `PRIVACY.md`.
* **Functionality behind a local server.** Reviewers may not run Node. Attach a short
  screen recording (30–60 s) of the full flow to the review notes.

## 8. After publishing

* [ ] Add the store link to `README.md`.
* [ ] Keep the unpacked install as the “development” path.
* [ ] Tag a release that matches the store version.
