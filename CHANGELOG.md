# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

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

## [0.1.0]

### Added

- `claude-account` CLI: per-project Claude Code accounts via `CLAUDE_CONFIG_DIR`, resolved
  from a manual override, a `.claude-account` marker file, or a project-prefix table.
- Launcher wrapper and zsh hook.
- VS Code extension showing the active account in the status bar.
