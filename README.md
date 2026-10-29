# claude-account-switcher

[![tests](https://github.com/francescofioredev/claude-account-switcher/actions/workflows/test.yml/badge.svg)](https://github.com/francescofioredev/claude-account-switcher/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#requirements)

One Claude Code account per project, picked automatically from the directory you are in — and
shown in the VS Code status bar like a git branch.

Work account on the work repos, personal account everywhere else, without logging out and back
in. Both stay logged in; which one Claude uses is decided when it starts, from the path.

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
clone has to stay where it is. It then prints the two steps it cannot do for you.

**1. Point Claude Code at the wrapper.** `Cmd+Shift+P` → *Preferences: Open User Settings
(JSON)*:

```json
"claudeCode.claudeProcessWrapper": "/Users/you/.local/bin/claude-account-wrapper"
```

It has to be **user** settings: the setting is machine-scoped, and VS Code ignores
machine-scoped values in workspace settings. That is also why `claudeCode.environmentVariables`
cannot be used to do this per project.

**2. For `claude` in a terminal**, source the zsh hook — it exports the variable on every
directory change:

```sh
echo 'source ~/path/to/claude-account-switcher/shell/claude-account.zsh' >> ~/.zshrc
```

Then install the extension:

```sh
cd extension && npx @vscode/vsce package
code --install-extension claude-account-switcher-*.vsix
```

It is not on the Marketplace: build the `.vsix` from this repo.

## Usage

### Quick start

```sh
claude-account new work                  # create the slot ~/.claude-accounts/work
claude-account login-cmd work            # prints the login line — run it
claude-account use work ~/projects/acme  # pin that project to the account
claude-account status ~/projects/acme    # check: which account, and why
```

Pinning one project at a time is the blunt way. The interesting one is a rule covering a whole
tree at once — see [the three levels of precedence](#the-three-levels-of-precedence).

### Command reference

| Command | What it does |
|---|---|
| `new <name> [--share]` | Create the slot `~/.claude-accounts/<name>`, sharing config with `~/.claude` via symlinks. `--share` also turns on `share`. |
| `share <name> [on\|off] [--force]` | Share sessions, plans and local MCP config with the default account. Alone, prints `shared=0` or `1`. |
| `list` | Every account and who is logged in to each, with its label if it has one. |
| `label <name\|default> [<label>\|--clear]` | Set, show or clear a display label, e.g. `label default me@example.com`. Shown by `list`, `status` and `usage`; the key stays the identity. Commands taking an account name also accept the label. |
| `login-cmd <name>` | Print the login line for an account. Printed, not run: the OAuth flow wants a terminal of your own. |
| `logout <name>` | Log the account out and remove its Keychain credentials. |
| `rename <old> <new>` | Move the slot. Requires logging in again — see below. |
| `rm <name> [--force]` | Delete the slot, its credentials and the overrides pointing at it. |
| `use <name\|default> [path]` | Pin an account to a project. This is what the status bar writes. |
| `clear [path]` | Remove that pin and fall back to the configured rules. |
| `status [path]` | Account, config dir, why, start folder, email. |
| `resolve [path]` | Just the config dir to use — empty means the default account. What the wrapper calls. |
| `set-cwd <folder> [path]` | Start the session in `<folder>` instead of `[path]`. |
| `cwd [path]` | Read that back — empty means the path itself. |
| `clear-cwd [path]` | Drop the start folder. |
| `usage [--live] [name]` | Usage over 5 hours and 7 days, plus extra credit. `--live` asks the API. |

`[path]` defaults to the current directory everywhere, so `claude-account use work` from inside
the project does the same as naming it.

### Managing accounts

`rm` also removes the Keychain entry and any overrides pointing at that account; if the
`accounts` table still mentions it you get told, without the file being touched — it is
hand-written. If it finds config inside the slot that was **copied** rather than symlinked it
stops: those files are unique, and only `--force` deletes them.

### Sharing sessions and plans

```sh
claude-account share work on    # or: claude-account new work --share
claude-account share work       # shared=1
claude-account share work off
```

Two sessions on different accounts could not see each other: `ListAgents` and `SendMessage`
read the live session registry in `sessions/`, which was per account. Plans stayed behind
too, so resuming a session on the other account lost its plan, and MCP servers added on the
default account never showed up on the others.

`share <name> on` symlinks the slot's `sessions/`, `plans/`, `file-history/`, `session-env/`
and `shell-snapshots/` to the same folders in `~/.claude`. What the slot already had is moved
over without overwriting anything; entries that collide stay in `<dir>.pre-share` and you are
told so.

At every launch, from the wrapper and the zsh hook, a shared slot also takes these keys from
`~/.claude.json` into its own `.claude.json`:

- top level: `mcpServers` (on a name clash the default's wins; servers only the slot has are
  kept), `githubRepoPaths`, `claudeInChromeDefaultEnabled`, `cachedChromeExtensionInstalled`;
- per project: `hasTrustDialogAccepted`, `mcpServers`, `allowedTools`,
  `enabledMcpjsonServers`, `disabledMcpjsonServers`.

Identity, tokens, caches and `lastSessionId` are never copied.

Not shared, even when on:

- **claude.ai connectors and Claude Design artifacts.** They belong to the claude.ai account,
  not to anything on disk.
- **`history.jsonl`, `ide/`, `daemon/`, `jobs/`, `scheduled-tasks/`.** Prompt history, IDE
  connections and background work stay with the account that started them.

Memory and transcripts were already shared before this: they live under `projects/`, which
every slot links.

`share on` refuses while the slot has running sessions, and names their pids: close them
first. `--force` goes ahead anyway, and those sessions switch registry mid-flight. `share off`
gives the slot empty folders of its own again; what was written while shared stays in
`~/.claude`. `default` cannot share: it is the account the others share with.

One caveat: Claude Code may rewrite `.claude.json` from memory and drop the merged keys. The
next launch merges them again.

### Where the session starts

```sh
claude-account set-cwd ~/work/monorepo/apps/web ~/work/monorepo  # start there instead
claude-account cwd ~/work/monorepo                               # read it back
claude-account clear-cwd ~/work/monorepo                         # back to the folder itself
```

Claude Code launches the CLI in the first folder of the workspace, and that folder is the one
whose `CLAUDE.md`, hooks, skills and commands apply. In a multi-root workspace that leaves the
other roots out of reach without reordering the `.code-workspace`. A start folder moves the
session's working directory, so those apply instead. In the extension it is
**Claude Account: Choose the folder the session starts in**, which offers the workspace roots.

The account is *not* affected: the wrapper resolves it from the folder the editor launched
Claude in, and only then moves. The two choices stay independent.

A pinned folder that no longer exists is ignored and the session starts where it would have
anyway. Two things to expect: Claude Code tracks trust per folder, so the first session in a
newly pinned one may ask for it; and its session list is scoped to the workspace root, so
sessions started elsewhere may not appear in it.

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

`sessions/`, `plans/`, `file-history/`, `session-env/` and `shell-snapshots/` are separate
unless you turn on [`share`](#sharing-sessions-and-plans), which links them too and merges
part of `.claude.json`.

Everything else account-specific or volatile always stays separate: the rest of
`.claude.json`, `ide/`, `history.jsonl`, `daemon/`, `jobs/`, `scheduled-tasks/`, `backups/`,
`cache/`, `telemetry/`.

## VS Code extension

In `extension/`. Shows the active account in the status bar and switches it with a click; the
tooltip also says **why** that account is active — override, marker file, table or default.

The Activity Bar panel has one card per account: usage over the last 5 hours and 7 days, when
they reset, extra credit if enabled, and buttons to log in, log out, rename and delete.
Logged-in accounts other than the default also have a toggle for
[sharing sessions and plans](#sharing-sessions-and-plans); if the account has running
sessions it asks before forcing it. Above the cards sits the folder the session starts in,
with a button to change it; when it is not the workspace root, the status bar names it too.

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
- **MCP servers and connectors are per account.** claude.ai connectors always have to be
  authorized on each account. User-scoped MCP servers do too, unless the account
  [shares](#sharing-sessions-and-plans) with the default, which copies their config over.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| Status bar says `Claude: ?` | The extension cannot run the CLI. VS Code launched from the Dock has a reduced `PATH` and often cannot see `~/.local/bin`. | Set `claudeAccount.cliPath` to the absolute path of `claude-account`. |
| The account never changes | `claudeCode.claudeProcessWrapper` is unset, or was set in workspace settings, where VS Code ignores it. | Put it in **user** settings; check with `Cmd+Shift+P` → *Preferences: Open User Settings (JSON)*. |
| It changed, but this conversation did not | The account is bound when the Claude process spawns. | Open a new conversation. The status bar shows ⚠ until you do. |
| An account looks logged out | Its config dir was moved by hand: the Keychain key is a hash of the path, so the credentials are orphaned. | `claude-account login-cmd <name>` and log in again. Use `rename`, never `mv`. |
| `claude` in a terminal uses the wrong account | The zsh hook is not sourced, or the shell has not changed directory since. | Source `shell/claude-account.zsh` from `~/.zshrc`, then `cd .` |
| Usage figures are hours old | They come from Claude Code's own cache, which only updates when Claude runs on that account. | Turn on `claudeAccount.usageLive`, or click the refresh button in the panel. |

If none of that fits, `claude-account status` from inside the project says which account it
resolves, and **why** — that is usually the whole answer.

## Uninstalling

```sh
rm ~/.local/bin/claude-account ~/.local/bin/claude-account-wrapper
rm -rf ~/.config/claude-account          # rules, pins and start folders
code --uninstall-extension francescofioredev.claude-account-switcher
```

Then remove `claudeCode.claudeProcessWrapper` from your user settings and the `source` line
from `~/.zshrc`. Claude Code goes back to the default account on its own.

Your accounts survive all of that. To take them out too, `claude-account rm <name>` **before**
deleting the CLI — it is what removes the Keychain credentials as well. `~/.claude` and the
account you started from are never touched.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run the tests with `sh test/run-tests.sh` — they build
a throwaway `$HOME` and never touch your real accounts.

## License

[MIT](LICENSE).
