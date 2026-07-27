#!/bin/sh
# Test di claude-account. Gira in una HOME finta e non tocca nulla di reale:
# né ~/.claude, né ~/.claude-accounts, né ~/.config/claude-account.
#
#   sh test/run-tests.sh

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd)
CLI="$REPO/bin/claude-account"
WRAP="$REPO/bin/claude-account-wrapper"

T=$(mktemp -d)
export HOME="$T/home"
unset XDG_CONFIG_HOME
mkdir -p "$HOME/.claude/skills" "$HOME/.claude/agents" "$HOME/proj/alpha/sub" "$HOME/proj/beta" "$HOME/altro"
printf 'istruzioni\n' > "$HOME/.claude/CLAUDE.md"
# Asimmetria di Claude Code: il .claude.json dell'account di default sta ACCANTO
# a ~/.claude, mentre con CLAUDE_CONFIG_DIR impostata sta DENTRO la config dir.
printf '{"oauthAccount":{"emailAddress":"default@example.com"}}' > "$HOME/.claude.json"

pass=0; fail=0
chk() { # chk <descrizione> <atteso> <ottenuto>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok   %s\n' "$1"
  else fail=$((fail+1)); printf '  FAIL %s\n       atteso:  [%s]\n       ottenuto:[%s]\n' "$1" "$2" "$3"; fi
}
field() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

echo "--- 1. senza config: tutto default"
chk "resolve vuoto"        ""        "$($CLI resolve "$HOME/proj/alpha")"
s=$($CLI status "$HOME/proj/alpha")
chk "status account"       "default" "$(field "$s" account)"
chk "status source"        "default" "$(field "$s" source)"
chk "status config_dir"    "$HOME/.claude" "$(field "$s" config_dir)"
chk "status email"         "default@example.com" "$(field "$s" email)"

echo "--- 2. path inesistente non rompe"
chk "resolve inesistente"  ""        "$($CLI resolve /tmp/nope-non-esiste)"
chk "exit code"            "0"       "$($CLI resolve /tmp/nope-non-esiste >/dev/null 2>&1; echo $?)"

echo "--- 3. new crea lo slot con i symlink"
$CLI new lavoro >/dev/null 2>&1
chk "slot creato"          "yes"     "$([ -d "$HOME/.claude-accounts/lavoro" ] && echo yes)"
chk "skills symlinkate"    "yes"     "$([ -L "$HOME/.claude-accounts/lavoro/skills" ] && echo yes)"
chk "CLAUDE.md symlinkato" "yes"     "$([ -L "$HOME/.claude-accounts/lavoro/CLAUDE.md" ] && echo yes)"
chk ".claude.json NON condiviso" ""  "$([ -e "$HOME/.claude-accounts/lavoro/.claude.json" ] && echo yes)"
chk "slot senza login" "1" "$($CLI list | grep -c 'mai loggato')"
printf '{"oauthAccount":{"emailAddress":"lavoro@example.com"}}' > "$HOME/.claude-accounts/lavoro/.claude.json"
chk "slot dopo il login"  "0" "$($CLI list | grep -c 'mai loggato')"
$CLI new lavoro >/dev/null 2>&1
chk "new idempotente"      "0"       "$?"
chk "new default rifiutato" "1"      "$($CLI new default >/dev/null 2>&1; echo $?)"

echo "--- 4. tabella accounts"
mkdir -p "$HOME/.config/claude-account"
printf 'lavoro\t~/proj/alpha\n' > "$HOME/.config/claude-account/accounts"
chk "match prefisso"       "$HOME/.claude-accounts/lavoro" "$($CLI resolve "$HOME/proj/alpha")"
chk "match sottocartella"  "$HOME/.claude-accounts/lavoro" "$($CLI resolve "$HOME/proj/alpha/sub")"
chk "non-match"            ""        "$($CLI resolve "$HOME/proj/beta")"
chk "source=table"         "table"   "$(field "$($CLI status "$HOME/proj/alpha")" source)"
chk "prefisso non parziale" ""       "$($CLI resolve "$HOME/proj/alphaXXX" 2>/dev/null)"
# l'email dello slot si legge da <slot>/.claude.json, quella del default da ~/.claude.json
chk "email dello slot"     "lavoro@example.com"  "$(field "$($CLI status "$HOME/proj/alpha")" email)"
chk "email del default"    "default@example.com" "$(field "$($CLI status "$HOME/proj/beta")" email)"

echo "--- 5. commenti e slot inesistenti nella tabella"
printf '# commento\n\nfantasma\t~/proj/beta\nlavoro\t~/proj/beta\n' >> "$HOME/.config/claude-account/accounts"
chk "slot fantasma ignorato, prosegue" "$HOME/.claude-accounts/lavoro" "$($CLI resolve "$HOME/proj/beta")"

echo "--- 6. override ha la precedenza sulla tabella"
$CLI use default "$HOME/proj/alpha" >/dev/null
s=$($CLI status "$HOME/proj/alpha")
chk "use default forza il default" "default" "$(field "$s" account)"
chk "source=override"      "override" "$(field "$s" source)"
chk "resolve vuoto"        ""        "$($CLI resolve "$HOME/proj/alpha")"
$CLI clear "$HOME/proj/alpha" >/dev/null
chk "clear ripristina"     "table"   "$(field "$($CLI status "$HOME/proj/alpha")" source)"

echo "--- 7. canonicalizzazione del path"
$CLI use lavoro "$HOME/proj/beta" >/dev/null
chk "path con /./ stesso slug" "override" "$(field "$($CLI status "$HOME/proj/./beta")" source)"
chk "path con .. stesso slug"  "override" "$(field "$($CLI status "$HOME/proj/alpha/../beta")" source)"
$CLI clear "$HOME/proj/beta" >/dev/null

echo "--- 8. marker file nel repo, e precedenza"
printf 'lavoro\n' > "$HOME/altro/.claude-account"
chk "marker attivo"        "$HOME/.claude-accounts/lavoro" "$($CLI resolve "$HOME/altro")"
chk "source=marker"        "marker"  "$(field "$($CLI status "$HOME/altro")" source)"
$CLI use default "$HOME/altro" >/dev/null
chk "override batte marker" "override" "$(field "$($CLI status "$HOME/altro")" source)"
$CLI clear "$HOME/altro" >/dev/null
printf 'fantasma\n' > "$HOME/altro/.claude-account"
chk "marker fantasma → default" "default" "$(field "$($CLI status "$HOME/altro")" source)"

echo "--- 9. use con slot inesistente fallisce"
chk "use fantasma"         "1"       "$($CLI use fantasma "$HOME/proj/beta" >/dev/null 2>&1; echo $?)"

echo "--- 10. il wrapper propaga l'env e degrada"
mkdir -p "$HOME/nonmappato"
chk "wrapper default→unset" "DEFAULT" "$(cd "$HOME/nonmappato" && $WRAP /bin/sh -c 'echo ${CLAUDE_CONFIG_DIR:-DEFAULT}')"
chk "wrapper mappato→set"   "$HOME/.claude-accounts/lavoro" "$(cd "$HOME/proj/alpha" && $WRAP /bin/sh -c 'echo $CLAUDE_CONFIG_DIR')"
chk "wrapper exec passa gli args" "a b" "$(cd "$HOME" && $WRAP /bin/echo a b)"
# l'estensione passa al wrapper l'env del processo VS Code: se contenesse già una
# CLAUDE_CONFIG_DIR, il ramo default deve comunque ripulirla
chk "wrapper ripulisce una CLAUDE_CONFIG_DIR ereditata" "DEFAULT" \
  "$(cd "$HOME/nonmappato" && CLAUDE_CONFIG_DIR=/sporco $WRAP /bin/sh -c 'echo ${CLAUDE_CONFIG_DIR:-DEFAULT}')"
# se la CLI sparisce, Claude deve partire lo stesso
mkdir -p "$T/orfano"
cp "$WRAP" "$T/orfano/claude-account-wrapper"
chk "wrapper degrada se la CLI manca" "avviato" \
  "$(cd "$HOME/proj/alpha" && "$T/orfano/claude-account-wrapper" /bin/echo avviato 2>/dev/null)"

echo "--- 11. list"
chk "list mostra i due slot" "2" "$($CLI list | wc -l | tr -d ' ')"

printf '\n%s passati, %s falliti\n' "$pass" "$fail"
rm -rf "$T"
[ "$fail" -eq 0 ]
