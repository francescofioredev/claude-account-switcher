# Claude Account Switcher

Shows the Claude Code account used in this VS Code window in the status bar, and switches it
with a click — like the git branch indicator.

> Not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are
> trademarks of Anthropic.

## What it does

Claude Code keeps one login per machine, but isolates credentials per `CLAUDE_CONFIG_DIR`, so
several accounts can stay logged in at once. This extension shows which one applies to the
current project and lets you change it.

- **Status bar** — the active account, with a tooltip saying *why* it is active: pinned by
  hand, a `.claude-account` file in the repo, a rule in your config, or the default.
- **Accounts panel** — one card per account in the Activity Bar: usage over the last 5 hours
  and 7 days, when they reset, extra credit if enabled, and buttons to log in, log out, rename
  and delete.
- **Switching** — pick an account for the current project; it applies from the next
  conversation, since the account is bound when the Claude process spawns.

## Requirements

This extension is the UI. The actual work is done by the `claude-account` CLI, which has to be
installed first:

```sh
git clone https://github.com/francescofioredev/claude-account-switcher.git
cd claude-account-switcher
./install.sh
```

macOS only — credential handling goes through `security(1)`.

Without the CLI the extension is inert: it says so in the status bar tooltip, and Claude Code
keeps working normally on the default account.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeAccount.cliPath` | empty | Path to `claude-account`. Empty = try `~/.local/bin/claude-account`, then the PATH. Needed because VS Code launched from the Dock has a reduced PATH. |
| `claudeAccount.statusBarPriority` | `99` | Position in the status bar: higher is further left. |
| `claudeAccount.usageLive` | `false` | Ask the API for real usage figures instead of cached ones. Off by default: it sends the account's OAuth token to `api.anthropic.com`. |
| `claudeAccount.usageStaleAfterMinutes` | `360` | After how many minutes usage is flagged as out of date. |
| `claudeAccount.usageInTooltip` | `true` | Usage line in the status bar tooltip. |
| `claudeAccount.usageRefreshMinutes` | `10` | How often the panel refreshes usage while open. `0` disables it. Only applies when `usageLive` is on. |

## Privacy

The extension makes no network requests of its own. With `claudeAccount.usageLive` enabled, the
CLI asks `api.anthropic.com` for your usage figures using that account's own OAuth token. That
is the only host contacted, there is no telemetry, and the feature is off unless you turn it
on. See [SECURITY.md](https://github.com/francescofioredev/claude-account-switcher/blob/main/SECURITY.md).

## License

[MIT](https://github.com/francescofioredev/claude-account-switcher/blob/main/LICENSE).
