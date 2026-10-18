# Privacy policy

**deepseek-bridge** is a local tool. It consists of a browser extension and a
gateway process that runs on your machine.

## What the extension does with data

* It reads the web chat page on `chat.deepseek.com` to find answers that contain
  code or tool calls.
* It sends tool requests to `http://127.0.0.1` (your own gateway). Nothing is sent
  to any other server by the extension.
* It stores a port and a token in the browser's extension storage
  (`chrome.storage.local`).

## What the gateway does with data

* It reads and writes files inside the project root you configure.
* It keeps staged edits, backups, a manifest and a JSONL log inside that root
  (`_fixes/`, `gateway/logs/`).
* It never sends data anywhere. All network access is inbound on `127.0.0.1`.

## What is sent to DeepSeek

When you press Enter in the chat, the text in the composer — including tool
results such as file contents or command output — is sent to DeepSeek as a normal
chat message, under their terms and privacy policy. This is the same as typing or
pasting that text yourself.

## Data collected by the developer

None. No analytics, no telemetry, no accounts.

## Data retention

All data stays on your machine until you delete it. Removing the extension clears
its storage; deleting `_fixes/` removes staged edits and backups.

## Third parties

The extension only communicates with `chat.deepseek.com` (the page you are on) and
`127.0.0.1` (your gateway). It does not use third-party analytics or CDNs.

## Contact

Open an issue at https://github.com/maksyutoff90-bot/deepseek-bridge/issues
