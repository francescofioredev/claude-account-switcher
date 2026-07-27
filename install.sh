#!/bin/sh
# Installa claude-account: symlink in ~/.local/bin e config iniziale.
# Symlink e non copia, così un `git pull` aggiorna tutto senza reinstallare —
# per questo il repo deve restare dov'è.

set -eu

repo=$(cd "$(dirname "$0")" && pwd)
bin="$HOME/.local/bin"
conf="${XDG_CONFIG_HOME:-$HOME/.config}/claude-account"

mkdir -p "$bin" "$conf/overrides"

chmod +x "$repo/bin/claude-account" "$repo/bin/claude-account-wrapper"
ln -sf "$repo/bin/claude-account"         "$bin/claude-account"
ln -sf "$repo/bin/claude-account-wrapper" "$bin/claude-account-wrapper"

if [ -f "$conf/accounts" ]; then
  printf 'config già presente, lasciata intatta: %s\n' "$conf/accounts"
else
  cp "$repo/accounts.example" "$conf/accounts"
  printf 'creata config: %s\n' "$conf/accounts"
fi

printf 'installati: %s/claude-account, %s/claude-account-wrapper\n\n' "$bin" "$bin"

case ":$PATH:" in
  *":$bin:"*) ;;
  *) printf 'ATTENZIONE: %s non è nel PATH, aggiungilo al tuo profilo.\n\n' "$bin" ;;
esac

cat <<EOF
Restano due passi manuali:

1) VS Code — user settings (Cmd+Shift+P → "Preferences: Open User Settings (JSON)"):
     "claudeCode.claudeProcessWrapper": "$bin/claude-account-wrapper"
   Va nelle user settings: è un setting machine-scoped, VS Code lo ignora se
   messo nelle impostazioni di workspace.

2) Shell — per il \`claude\` da terminale:
     echo 'source $repo/shell/claude-account.zsh' >> ~/.zshrc

Poi:  claude-account new <nome>  e  CLAUDE_CONFIG_DIR=\$HOME/.claude-accounts/<nome> claude auth login
EOF
