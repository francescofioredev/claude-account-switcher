# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `label <name|default> [<label>|--clear]`: a display label for an account, stored in
  `~/.config/claude-account/labels`. The key stays the identity (`default` stays `default`
  for pins, session names and `resolve`); `list`, `status`, `usage` and the extension show the
  label next to it. `use`, `usage`, `login-cmd`, `logout`, `share` and `label` accept the label
  in place of the key. `rename` carries it over and `rm` drops it.

### Changed

- `list --porcelain` has an eighth column, `label` (empty when unset); `status` and
  `usage --porcelain` print `label=`. Existing columns and keys are unchanged.

## [0.4.0] — 2026-10-16

### Added

- `share <name> on|off`: an account can share sessions, plans and resume state with the
  default account. Its `sessions/`, `plans/`, `file-history/`, `session-env/` and
  `shell-snapshots/` become symlinks to `~/.claude`, so sessions on both accounts see each
  other and a plan follows a resumed session. Refuses while the account has running sessions,
  unless given `--force`.
- `new <name> --share` creates an account with sharing already on.
- A shared account takes local MCP servers, folder trust, tool permissions and the Chrome
  flags from `~/.claude.json` at every launch. Identity and tokens are never copied.
- A toggle for sharing on each account card in the extension.

### Changed

- `list --porcelain` has a seventh column, `shared`; `usage --porcelain` and `status` print
  `shared=`.

## [0.3.0] — 2026-09-17

### Added

- The folder a session starts in is now a choice of its own: `set-cwd`, `cwd` and `clear-cwd`
  in the CLI, **Claude Account: Choose the folder the session starts in** in the extension,
  which offers the workspace roots. The session picks up that folder's `CLAUDE.md`, hooks,
  skills and commands. The account keeps being resolved from the folder the editor launched
  Claude in, so the two choices are independent.
- The status bar names the start folder when it is not the workspace root, and the panel shows
  it above the account cards.

## [0.2.0] — 2026-08-22

### Added

- Account panel in the Activity Bar: one card per account with 5-hour and 7-day usage, reset
  times, extra credit, and buttons to log in, log out, rename, and delete.
- `usage` command, reading cached values by default and live values with `--live`.
- `login-cmd`, `logout`, `rename`, and `rm` commands for managing account slots.
- `rm` refuses to delete a slot holding real copies of shared config unless given `--force`,
  and never follows symlinks out of the slot.

### Changed

- The live usage lookup is opt-in and off by default. Enable it with
  `CLAUDE_ACCOUNT_USAGE_LIVE=1` or the `claudeAccount.usageLive` setting.
- Everything — docs, CLI output, and extension UI — is now in English.

### Fixed

- `usageStaleAfterMinutes` had three different defaults across the README, the manifest, and
  the extension. All three now agree on 360.

## [0.1.0] — 2026-07-27

### Added

- `claude-account` CLI: per-project Claude Code accounts via `CLAUDE_CONFIG_DIR`, resolved
  from a manual override, a `.claude-account` marker file, or a project-prefix table.
- Launcher wrapper and zsh hook.
- VS Code extension showing the active account in the status bar.
