# zsh hook for claude-account: keeps CLAUDE_CONFIG_DIR aligned with the current directory.
#
# This is for `claude` launched from a terminal. VS Code's integrated terminal
# inherits the editor's environment, where CLAUDE_CONFIG_DIR is unset: without
# this hook, `claude` from a terminal would use the default account even inside a
# project mapped to another one.
#
# Install with:  echo 'source /path/to/repo/shell/claude-account.zsh' >> ~/.zshrc

_claude_account_sync() {
  local dir
  dir="$(claude-account resolve "$PWD" 2>/dev/null)"
  if [[ -n $dir ]]; then
    export CLAUDE_CONFIG_DIR="$dir"
  else
    # unset, not "=default": setting it would change the Keychain namespace
    unset CLAUDE_CONFIG_DIR
  fi
}

autoload -Uz add-zsh-hook
add-zsh-hook chpwd _claude_account_sync
_claude_account_sync
