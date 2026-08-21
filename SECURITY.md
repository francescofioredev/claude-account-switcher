# Security

## Reporting a vulnerability

Email francesco.fiore.dev@gmail.com. Please don't open a public issue for something
exploitable.

## What this tool touches

It is a wrapper around Claude Code's own configuration. It is worth knowing exactly what it
does with your credentials.

**macOS Keychain.** Claude Code stores each account's OAuth credentials in the Keychain under
the service `Claude Code-credentials` for the default account, and
`Claude Code-credentials-<sha256(config_dir)[0:8]>` for any account launched with
`CLAUDE_CONFIG_DIR` set. This tool:

- reads the access token via `security find-generic-password`, only when the live usage
  lookup is enabled (see below);
- deletes the entry via `security delete-generic-password` on `logout`, `rm`, and `rename`.
  On `rename` this is not optional: the service name is a hash of the directory path, so a
  moved directory leaves credentials that can never be addressed again.

**Network.** With one exception, this tool makes no network calls at all. The exception is
opt-in and off by default:

`claude-account usage --live` sends a `GET` to `https://api.anthropic.com/api/oauth/usage`,
authenticated with that account's OAuth token from the Keychain, to read current usage. It is
the only way to get accurate numbers: the `cachedUsageUtilization` field in `.claude.json` is
refreshed rarely and can be many hours stale.

- It is **off unless you turn it on** — `CLAUDE_ACCOUNT_USAGE_LIVE=1` for the CLI, or the
  `claudeAccount.usageLive` setting for the extension. Without it, `--live` returns cached
  data and no request is made.
- The token goes to `api.anthropic.com` and nowhere else. There is no telemetry, no analytics,
  and no other host contacted by any part of this project.
- `/api/oauth/usage` is **not a documented API**. A Claude Code update may change or remove it.
  If it fails for any reason the tool falls back to cached values, labelled as cached.

**Files.** It reads and writes `~/.claude-accounts/`, `~/.config/claude-account/`, and
`.claude-account` marker files in your projects. It creates symlinks from a new account slot
into `~/.claude` for shared config. `rm` refuses to delete a slot containing real copies of
shared config rather than symlinks, unless given `--force`, and never follows a symlink out of
the slot.
