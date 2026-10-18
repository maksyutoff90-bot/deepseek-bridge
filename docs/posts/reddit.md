# Reddit

## r/LocalLLaMA, r/DeepSeek, r/ChatGPTCoding

**Title:** deepseek-bridge — use DeepSeek's web chat as a local coding agent (sandboxed, no API key)

**Body:**

I wanted the web chat to see my project, but I did not want to hand an LLM direct write
access to my disk. So I built a small bridge: a Chrome extension plus a local Node gateway.

How it works: the model answers with a tool call (`read`, `grep`, `write`, `run`…). The
extension sends it to `127.0.0.1:8787`, gets the result and types it back into the chat.
The model continues; you press Enter.

The important part: **writes are staged**. `write`/`replace` go to `_fixes/` (a mirror of
the project). Applying is a separate confirmed action with a per-file backup, and a guard
that refuses to overwrite a big file with a short snippet.

Other bits:
- plain code blocks with a filename nearby are captured automatically (no special commands)
- manual **Write** button: take code from the last answer, fix the path, confirm
- project tree with drag & drop (code → folder, files from Explorer → folder)
- context menu: open in VS Code, diff, preview, copy path, delete to trash
- dockable/resizable panel
- chat history and SPA chat switches are ignored (no accidental re-runs)

Install: `start-gateway.cmd`, load `extension/` unpacked, paste the token, send
`SYSTEM_PROMPT.md` as the first message.

Repo: https://github.com/maksyutoff90-bot/deepseek-bridge (MIT)
Release zip: https://github.com/maksyutoff90-bot/deepseek-bridge/releases/tag/v0.2.0

Caveats, honestly: it drives the web UI, so a DeepSeek redesign can break the parsing;
`run` is a real shell (can be disabled); file contents you send go to DeepSeek like any
pasted text. Requires Node 22+ and Chrome 137+; Windows-first.

Happy to hear what breaks and what you would change.
