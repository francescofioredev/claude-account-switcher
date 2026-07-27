# Hook zsh per claude-account: tiene CLAUDE_CONFIG_DIR allineata alla cartella corrente.
#
# Serve al `claude` lanciato da terminale. Il terminale integrato di VS Code
# eredita l'ambiente dell'editor, dove CLAUDE_CONFIG_DIR non è impostata: senza
# questo hook, `claude` da terminale userebbe l'account di default anche dentro
# un progetto mappato su un altro account.
#
# Installazione:  echo 'source /percorso/del/repo/shell/claude-account.zsh' >> ~/.zshrc

_claude_account_sync() {
  local dir
  dir="$(claude-account resolve "$PWD" 2>/dev/null)"
  if [[ -n $dir ]]; then
    export CLAUDE_CONFIG_DIR="$dir"
  else
    # unset e non "=default": settarla cambierebbe il namespace del Keychain
    unset CLAUDE_CONFIG_DIR
  fi
}

autoload -Uz add-zsh-hook
add-zsh-hook chpwd _claude_account_sync
_claude_account_sync
