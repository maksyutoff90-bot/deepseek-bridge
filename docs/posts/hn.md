# Hacker News

**Title:** Show HN: Deepseek-bridge – local coding agent for the DeepSeek web chat

**Text:**

I built a bridge that lets the DeepSeek web chat work on a local project without an API key.

The model emits a tool call in a `webcode` code block; a Chrome extension forwards it to a
local Node gateway on 127.0.0.1, which runs the tool (read, grep, write, run) and returns
the result. The extension types the result back into the chat.

The design choice I care about: model writes never touch the project directly. They are
staged into `_fixes/` (a mirror of the tree). Apply is a separate step with a confirmation
list, a per-file backup, and a guard against overwriting a large file with a short snippet.

It also captures plain code blocks with a filename nearby (no special commands), has a
project tree with drag & drop, a context menu with VS Code open/diff/delete-to-trash, and a
dockable panel. Chat history is ignored on load, so nothing re-runs when you switch tabs or
chats.

Limits: it parses the web UI, so a redesign can break it; `run` is a real shell (can be
disabled in config); Node 22+ and Chrome 137+.

Repo: https://github.com/maksyutoff90-bot/deepseek-bridge (MIT)
