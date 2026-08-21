# claude-account-switcher

One Claude Code account per project, picked automatically from the directory you are in — and
shown in the VS Code status bar like a git branch.

> Not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are
> trademarks of Anthropic.

## How it works

Claude Code keeps one login per machine, but it isolates credentials and state per
`CLAUDE_CONFIG_DIR`. On macOS the Keychain service it uses depends on that variable:

| `CLAUDE_CONFIG_DIR` | Keychain service |
|---|---|
| unset | `Claude Code-credentials` |
| set | `Claude Code-credentials-<sha256(dir)[0:8]>` |

So several accounts can stay logged in at the same time, each in its own config dir. This
project is the piece that decides which one to use, per project:

- **`bin/claude-account`** — the CLI, and the single source of truth. Everything else asks it.
- **`bin/claude-account-wrapper`** — set as `claudeCode.claudeProcessWrapper`, it sets the
  variable when the VS Code extension spawns Claude.
- **`shell/claude-account.zsh`** — the same thing for `claude` launched from a terminal.
- **`extension/`** — the VS Code extension: status bar, account panel, switching.

Nothing in your Claude Code installation is patched. The two settings used
(`claudeCode.claudeProcessWrapper` and the config dir variable) are Claude Code's own.

## Requirements

- **macOS.** Credential handling goes through `security(1)`. Linux and Windows are not
  supported today.
- `curl`, plus `jq` **or** `node` for JSON parsing. macOS 13 and 14 ship no system `jq`, hence
  the fallback.
- VS Code 1.85+ for the extension.

## Installation

```sh
git clone https://github.com/francescofioredev/claude-account-switcher.git
cd claude-account-switcher
./install.sh
```

`install.sh` symlinks rather than copies, so `git pull` updates everything — which means the
clone has to stay where it is. It then prints two manual steps: pointing
`claudeCode.claudeProcessWrapper` at the wrapper in your **user** settings, and sourcing the
zsh hook.

The wrapper setting has to go in user settings. It is machine-scoped, and VS Code ignores
machine-scoped values in workspace settings — which is also why `claudeCode.environmentVariables`
cannot be used to do this per project.

## Usage

```sh
claude-account new work                  # create the slot ~/.claude-accounts/work
claude-account login-cmd work            # print the login line for it
claude-account list                      # who is logged in to which slot
claude-account status ~/projects/acme    # account, config dir, and why
claude-account usage                     # usage from the local cache
claude-account usage --live              # real usage, asked from the API
```

### Managing accounts

```sh
claude-account logout work         # log out and remove the credentials
claude-account rename work office  # move the slot (requires logging in again)
claude-account rm work             # delete slot, credentials and overrides
```

`rm` also removes the Keychain entry and any overrides pointing at that account; if the
`accounts` table still mentions it you get told, without the file being touched — it is
hand-written. If it finds config inside the slot that was **copied** rather than symlinked it
stops: those files are unique, and only `--force` deletes them.

### The three levels of precedence

1. **override** — `claude-account use <name> [path]`, what the status bar writes.
   `claude-account clear` removes it.
2. **marker file** — a `.claude-account` file in the repo holding the account name. Committable,
   so it travels with the project.
3. **table** — `~/.config/claude-account/accounts`, mapping path prefixes to accounts. First
   match wins, so write from the most specific to the most generic.

Anything that matches nothing falls through to the default account, `~/.claude`. An account
named in a rule but not yet created is skipped and resolution continues, so a rule written
ahead of time breaks nothing.

## What accounts share

A new slot gets symlinks back into `~/.claude` for `CLAUDE.md`, `settings.json`,
`settings.local.json`, `skills`, `agents`, `commands`, `plugins`, `hooks` and `projects`. Edit
the `SHARED` list at the top of `bin/claude-account` to change what is shared.

Everything account-specific or volatile stays separate: `.claude.json`, `ide/`, `sessions/`,
`session-env/`, `shell-snapshots/`, `file-history/`, `history.jsonl`, `backups/`, `cache/`,
`telemetry/`.

## VS Code extension

In `extension/`. Shows the active account in the status bar and switches it with a click; the
tooltip also says **why** that account is active — override, marker file, table or default.

The Activity Bar panel has one card per account: usage over the last 5 hours and 7 days, when
they reset, extra credit if enabled, and buttons to log in, log out, rename and delete.

```sh
cd extension
npx @vscode/vsce package
code --install-extension claude-account-switcher-*.vsix
```

| Setting | Default | Meaning |
|---|---|---|
| `claudeAccount.cliPath` | empty | Path to `claude-account`. Empty = try `~/.local/bin/claude-account`, then the PATH. Needed because VS Code launched from the Dock has a reduced PATH. |
| `claudeAccount.statusBarPriority` | `99` | Position in the status bar: higher is further left. |
| `claudeAccount.usageLive` | `false` | Ask the API for real usage figures. See below. |
| `claudeAccount.usageStaleAfterMinutes` | `360` | After how many minutes usage is flagged as out of date. |
| `claudeAccount.usageInTooltip` | `true` | Usage line in the status bar tooltip. |
| `claudeAccount.usageRefreshMinutes` | `10` | How often the panel refreshes usage while open. `0` disables it. Only applies when `usageLive` is on. |

### Where usage figures come from

By default, from `cachedUsageUtilization` in `.claude.json` — written by Claude Code itself.
That field only updates when Claude actually runs on that account, so it can be hours or days
old. Every card says how old its data is.

Turning on `claudeAccount.usageLive` (or setting `CLAUDE_ACCOUNT_USAGE_LIVE=1` for the CLI)
makes it ask `GET /api/oauth/usage` instead, authenticated with that account's OAuth token read
from the Keychain. This is **off by default** because it sends your token over the network —
to `api.anthropic.com` and nowhere else. See [SECURITY.md](SECURITY.md).

`/api/oauth/usage` is **not documented**. A Claude Code update may change or remove it; if the
call fails for any reason the cached values are used instead, labelled as cached.

## Good to know

- **An account switch applies from the next conversation.** The wrapper runs when the Claude
  process spawns, so a conversation already open stays on the account it started with.
- **Don't move a config dir by hand after logging in.** The Keychain key is a hash of the path:
  change it and the account looks logged out, with the old credentials orphaned. Use
  `claude-account rename`, which cleans up the old credentials and tells you to log in again.
- **Setting `CLAUDE_CONFIG_DIR` to the default value is not the same as leaving it unset**, for
  the same reason. That is why the wrapper unsets it instead of setting it.
- **MCP servers and connectors are per account.** User-scoped MCP servers and claude.ai
  connectors have to be re-authorized on each account.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run the tests with `sh test/run-tests.sh` — they build
a throwaway `$HOME` and never touch your real accounts.

## License

[MIT](LICENSE).
