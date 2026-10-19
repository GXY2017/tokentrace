# tokentrace

A fast, dependency-free status line for [Claude Code](https://code.claude.com/). It puts the model, working directory, git branch, usage or billing, context window, and prompt-cache health into one terminal line.

```
Claude Opus 5.5 · my-project · main* · 5h 12% @14:30 · 7d 45% @10/22 · ctx 23% 46k · cache 87% miss 1k @15:30
```

## Features

- Anthropic subscription windows (5h / 7d), reset times, and optional usage credits.
- Pay-as-you-go cost from the local transcript for Anthropic API keys and compatible vendors.
- Per-vendor price table with `$` / `¥` currencies and optional peak/off-peak multipliers.
- Context-window usage, with a configurable fallback limit.
- Cache-hit share and cache expiry. Anthropic expiry comes from Claude Code; other vendors use a configured TTL or a bidirectional estimate learned from transcript gaps.
- No npm dependencies. Node built-ins only.

## Requirements

- Node.js 18 or newer.
- Claude Code with status-line support.
- Optional: `git` on `PATH` for branch and dirty-state display.

## Install

1. Clone this repository somewhere, for example:

   ```sh
   git clone https://github.com/GXY2017/tokentrace.git ~/.claude/hooks/tokentrace
   ```

2. Edit `statusline-pricing.json` for the vendors you use. The shipped table is an example; prices change and must be verified against each vendor.

3. Add the status line to `~/.claude/settings.json`:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"$HOME/.claude/hooks/tokentrace/statusline.js\""
     }
   }
   ```

   On Windows, replace `<home>` with your home directory:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"<home>/.claude/hooks/tokentrace/statusline.js\""
     }
   }
   ```

4. Restart Claude Code.

You can test the script without Claude Code:

```sh
node statusline.js < examples/statusline-input.json
```

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STATUSLINE_PRICING` | `statusline-pricing.json` next to the script | Price-table path. |
| `STATUSLINE_CACHE_DIR` | `~/.claude/cache` | Directory for the observed cache-TTL file. |
| `CLAUDE_CTX_LIMIT` | model heuristic | Context-window size in tokens. |
| `STATUSLINE_API_COST=1` | off | Show the API-equivalent cost on a subscription plan. |
| `STATUSLINE_MODEL_LIMITS=1` | off | Enable optional per-model weekly windows. This reads the local Claude Code OAuth credentials and calls an undocumented Anthropic usage endpoint. |

### Price table

`statusline-pricing.json` has a `vendors` object. Each vendor entry can define:

- `match`: substrings tested against `ANTHROPIC_BASE_URL` (case-insensitive). No match means Anthropic.
- `label`: name shown in the status line.
- `currency`: `USD` renders `$`, `CNY` renders `¥`.
- `models`: token prices per 1M tokens, keyed by model slug. `input`, `output`, `cacheRead`, and `cacheWrite` are required for cost display.
- `cache_ttl_minutes`: fixed cache lifetime. If `null`, the script learns an estimate from gaps between consecutive requests to the same model.
- `peak`: optional multiplier windows (`tz_offset_hours`, `weekdays`, `windows`, `multiplier`, `label_peak`, `label_offpeak`).
- `subscription`: optional label. When set, the vendor shows that label instead of a computed cost.

On a non-Anthropic vendor the estimated expiry is shown as `@~HH:MM`. Cache TTL estimates are bidirectional: a cache hit at a longer gap raises the estimate, and a miss after a shorter gap lowers it. The estimate is marked with `~`. A single miss can lower it; a later longer hit can raise it again.

## Privacy

The script reads the status-line JSON from stdin and the transcript file named in that JSON. It writes the observed cache-TTL file under `~/.claude/cache` or `STATUSLINE_CACHE_DIR`, keeps short-lived git, cost and usage caches as `claude-statusline-*.json` in the system temp directory, and runs `git` in the current directory. It does not upload transcripts or usage data.

The optional `STATUSLINE_MODEL_LIMITS=1` feature reads `~/.claude/.credentials.json` and calls Anthropic's OAuth usage endpoint. It is off by default. No API keys or credentials are stored in this repository.

## Limitations

- Prices are user-maintained. Verify them against the vendor's current pricing page.
- Unknown vendors show `host ?` until added to the price table.
- Non-Anthropic cache TTL is an estimate, not a guarantee.
- Token counts depend on the data Claude Code provides in its status-line input and transcript.

## Disclaimer

This is an independent project, not affiliated with Anthropic or any model vendor. Product names are trademarks of their respective owners.

## License

MIT. See [LICENSE](LICENSE).
