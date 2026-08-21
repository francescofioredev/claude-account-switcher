#!/bin/sh
# Install claude-account: symlinks in ~/.local/bin plus initial config.
# Symlinks rather than copies, so a `git pull` updates everything without
# reinstalling — which is why the repo has to stay where it is.

set -eu

repo=$(cd "$(dirname "$0")" && pwd)
bin="$HOME/.local/bin"
conf="${XDG_CONFIG_HOME:-$HOME/.config}/claude-account"

mkdir -p "$bin" "$conf/overrides"

chmod +x "$repo/bin/claude-account" "$repo/bin/claude-account-wrapper"
ln -sf "$repo/bin/claude-account"         "$bin/claude-account"
ln -sf "$repo/bin/claude-account-wrapper" "$bin/claude-account-wrapper"

if [ -f "$conf/accounts" ]; then
  printf 'config already present, left untouched: %s\n' "$conf/accounts"
else
  cp "$repo/accounts.example" "$conf/accounts"
  printf 'created config: %s\n' "$conf/accounts"
fi

printf 'installed: %s/claude-account, %s/claude-account-wrapper\n\n' "$bin" "$bin"

case ":$PATH:" in
  *":$bin:"*) ;;
  *) printf 'WARNING: %s is not on your PATH, add it to your profile.\n\n' "$bin" ;;
esac

cat <<EOF
Two manual steps remain:

1) VS Code — user settings (Cmd+Shift+P → "Preferences: Open User Settings (JSON)"):
     "claudeCode.claudeProcessWrapper": "$bin/claude-account-wrapper"
   It has to go in the user settings: it is a machine-scoped setting, and VS Code
   ignores it in workspace settings.

2) Shell — for \`claude\` from a terminal:
     echo 'source $repo/shell/claude-account.zsh' >> ~/.zshrc

Then:  claude-account new <name>  and  CLAUDE_CONFIG_DIR=\$HOME/.claude-accounts/<name> claude auth login
EOF
