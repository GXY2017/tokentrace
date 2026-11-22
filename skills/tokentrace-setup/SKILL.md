---
name: tokentrace-setup
description: Install, update, configure or remove tokentrace, a dependency-free Claude Code status line that shows the model, prompt-cache hit share and expiry, git branch, subscription windows (5h / 7d) or pay-as-you-go cost, and context-window usage. Use when the user asks to set up or change a Claude Code status line, wants cost, rate limits or cache TTL shown in the status line, wants to price a non-Anthropic vendor, or asks to update or uninstall tokentrace.
license: MIT
---

# tokentrace setup

tokentrace is one Node script (`statusline.js`) plus a price table (`statusline-pricing.json`). Claude Code runs the script for every status line refresh. A plugin or skill cannot register a status line by itself, so this skill puts the script in a stable directory and points the user's `settings.json` at it.

Source: https://github.com/GXY2017/tokentrace (MIT). Its `README.md` is the reference for every option named here.

## Install

1. Check the runtime: `node --version` must print v18 or newer. If Node is missing, stop and tell the user; do not install it for them.
2. Fetch the code into the Claude Code config directory (`$CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`), in `hooks/tokentrace`:

   ```sh
   git clone https://github.com/GXY2017/tokentrace.git ~/.claude/hooks/tokentrace
   ```

   Without `git`, download `statusline.js`, `statusline-pricing.json` and `examples/statusline-input.json` from `https://raw.githubusercontent.com/GXY2017/tokentrace/main/` into the same layout.
3. Test before touching any setting. The command must print one line that starts with the model name:

   ```sh
   node ~/.claude/hooks/tokentrace/statusline.js < ~/.claude/hooks/tokentrace/examples/statusline-input.json
   ```

4. Read the user's `settings.json` in the config directory. If it already has a `statusLine` entry, show that entry to the user and replace it only after they agree. Then set, keeping every other key as it is:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"/absolute/path/to/.claude/hooks/tokentrace/statusline.js\""
     }
   }
   ```

   Write the real absolute path with forward slashes (they work on Windows too). Do not leave `~` or `$HOME` in the command on Windows.
5. Tell the user to restart Claude Code, and what the segments mean: `model hit%@expiry · dir branch · 5h / 7d windows or cost · ctx`.

## Configure

- **Vendors and prices**: `statusline-pricing.json` has one entry per vendor, matched against `ANTHROPIC_BASE_URL` or named in `STATUSLINE_VENDOR`. The shipped prices are examples. Before adding or changing a row, read the vendor's current pricing page and record the page and the date in the entry's `source` and `verified` fields. Never fill in a price from memory.
- **Environment variables** (`STATUSLINE_PRICING`, `STATUSLINE_CACHE_DIR`, `STATUSLINE_VENDOR`, `CLAUDE_CTX_LIMIT`, `STATUSLINE_API_COST`): see the table in `README.md`.
- **Per-model weekly windows** (`STATUSLINE_MODEL_LIMITS=1`): off by default. It reads the local Claude Code OAuth credentials and calls an undocumented Anthropic usage endpoint. Enable it only when the user asks for it, after telling them that.

## Update

```sh
git -C ~/.claude/hooks/tokentrace pull --ff-only
```

If the pull stops because `statusline-pricing.json` has local edits, those edits are the user's price table: keep them (`git stash`, pull, `git stash pop`) and resolve any conflict with the user. Never discard them.

## Remove

Delete the `statusLine` entry from `settings.json`, then ask before deleting `hooks/tokentrace` and the observed cache-TTL file `cache/statusline-cache-observed.json` in the config directory.
