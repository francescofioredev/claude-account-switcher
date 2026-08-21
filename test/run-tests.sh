#!/bin/sh
# claude-account tests. Runs in a fake HOME and touches nothing real:
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
# beside ~/.claude, while with CLAUDE_CONFIG_DIR set it sits INSIDE the config dir.
printf '{"oauthAccount":{"emailAddress":"default@example.com"}}' > "$HOME/.claude.json"

pass=0; fail=0
chk() { # chk <descrizione> <atteso> <ottenuto>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok   %s\n' "$1"
  else fail=$((fail+1)); printf '  FAIL %s\n       atteso:  [%s]\n       ottenuto:[%s]\n' "$1" "$2" "$3"; fi
}
field() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

echo "--- 1. no config: everything default"
chk "resolve empty"        ""        "$($CLI resolve "$HOME/proj/alpha")"
s=$($CLI status "$HOME/proj/alpha")
chk "status account"       "default" "$(field "$s" account)"
chk "status source"        "default" "$(field "$s" source)"
chk "status config_dir"    "$HOME/.claude" "$(field "$s" config_dir)"
chk "status email"         "default@example.com" "$(field "$s" email)"

echo "--- 2. nonexistent path non rompe"
chk "resolve missing"  ""        "$($CLI resolve /tmp/nope-non-esiste)"
chk "exit code"            "0"       "$($CLI resolve /tmp/nope-non-esiste >/dev/null 2>&1; echo $?)"

echo "--- 3. new creates the slot con i symlink"
$CLI new work >/dev/null 2>&1
chk "slot created"          "yes"     "$([ -d "$HOME/.claude-accounts/work" ] && echo yes)"
chk "skills symlinkate"    "yes"     "$([ -L "$HOME/.claude-accounts/work/skills" ] && echo yes)"
chk "CLAUDE.md symlinked" "yes"     "$([ -L "$HOME/.claude-accounts/work/CLAUDE.md" ] && echo yes)"
chk ".claude.json NOT shared" ""  "$([ -e "$HOME/.claude-accounts/work/.claude.json" ] && echo yes)"
chk "slot with no login" "1" "$($CLI list | grep -c 'never logged in')"
printf '{"oauthAccount":{"emailAddress":"work@example.com"}}' > "$HOME/.claude-accounts/work/.claude.json"
chk "slot after login"  "0" "$($CLI list | grep -c 'never logged in')"
$CLI new work >/dev/null 2>&1
chk "new is idempotent"      "0"       "$?"
chk "new default rejected" "1"      "$($CLI new default >/dev/null 2>&1; echo $?)"

echo "--- 4. accounts table"
mkdir -p "$HOME/.config/claude-account"
printf 'work\t~/proj/alpha\n' > "$HOME/.config/claude-account/accounts"
chk "prefix match"       "$HOME/.claude-accounts/work" "$($CLI resolve "$HOME/proj/alpha")"
chk "subdirectory match"  "$HOME/.claude-accounts/work" "$($CLI resolve "$HOME/proj/alpha/sub")"
chk "no match"            ""        "$($CLI resolve "$HOME/proj/beta")"
chk "source=table"         "table"   "$(field "$($CLI status "$HOME/proj/alpha")" source)"
chk "not a partial prefix" ""       "$($CLI resolve "$HOME/proj/alphaXXX" 2>/dev/null)"
# a slot's email is read from <slot>/.claude.json, the default's from ~/.claude.json
chk "slot email"     "work@example.com"  "$(field "$($CLI status "$HOME/proj/alpha")" email)"
chk "default email"    "default@example.com" "$(field "$($CLI status "$HOME/proj/beta")" email)"

echo "--- 5. comments and nonexistent slots in the table"
printf '# comment\n\nghost\t~/proj/beta\nwork\t~/proj/beta\n' >> "$HOME/.config/claude-account/accounts"
chk "ghost slot skipped, continues" "$HOME/.claude-accounts/work" "$($CLI resolve "$HOME/proj/beta")"

echo "--- 6. override takes precedence over the table"
$CLI use default "$HOME/proj/alpha" >/dev/null
s=$($CLI status "$HOME/proj/alpha")
chk "use default pins the default" "default" "$(field "$s" account)"
chk "source=override"      "override" "$(field "$s" source)"
chk "resolve empty"        ""        "$($CLI resolve "$HOME/proj/alpha")"
$CLI clear "$HOME/proj/alpha" >/dev/null
chk "clear restores"     "table"   "$(field "$($CLI status "$HOME/proj/alpha")" source)"

echo "--- 7. canonicalizzazione del path"
$CLI use work "$HOME/proj/beta" >/dev/null
chk "path with /./ same slug" "override" "$(field "$($CLI status "$HOME/proj/./beta")" source)"
chk "path with .. same slug"  "override" "$(field "$($CLI status "$HOME/proj/alpha/../beta")" source)"
$CLI clear "$HOME/proj/beta" >/dev/null

echo "--- 8. marker file in the repo, and precedence"
printf 'work\n' > "$HOME/altro/.claude-account"
chk "marker attivo"        "$HOME/.claude-accounts/work" "$($CLI resolve "$HOME/altro")"
chk "source=marker"        "marker"  "$(field "$($CLI status "$HOME/altro")" source)"
$CLI use default "$HOME/altro" >/dev/null
chk "override batte marker" "override" "$(field "$($CLI status "$HOME/altro")" source)"
$CLI clear "$HOME/altro" >/dev/null
printf 'ghost\n' > "$HOME/altro/.claude-account"
chk "ghost marker → default" "default" "$(field "$($CLI status "$HOME/altro")" source)"

echo "--- 9. use on a missing slot fails"
chk "use ghost slot"         "1"       "$($CLI use ghost "$HOME/proj/beta" >/dev/null 2>&1; echo $?)"

echo "--- 10. il wrapper propaga l'env e degrada"
mkdir -p "$HOME/nonmappato"
chk "wrapper default→unset" "DEFAULT" "$(cd "$HOME/nonmappato" && $WRAP /bin/sh -c 'echo ${CLAUDE_CONFIG_DIR:-DEFAULT}')"
chk "wrapper mapped→set"   "$HOME/.claude-accounts/work" "$(cd "$HOME/proj/alpha" && $WRAP /bin/sh -c 'echo $CLAUDE_CONFIG_DIR')"
chk "wrapper exec passes args through" "a b" "$(cd "$HOME" && $WRAP /bin/echo a b)"
# the extension hands the wrapper the VS Code process env: if it already held a
# CLAUDE_CONFIG_DIR, the default branch must still clear it
chk "wrapper clears an inherited CLAUDE_CONFIG_DIR" "DEFAULT" \
  "$(cd "$HOME/nonmappato" && CLAUDE_CONFIG_DIR=/sporco $WRAP /bin/sh -c 'echo ${CLAUDE_CONFIG_DIR:-DEFAULT}')"
# if the CLI disappears, Claude must still start
mkdir -p "$T/orfano"
cp "$WRAP" "$T/orfano/claude-account-wrapper"
chk "wrapper degrades when the CLI is missing" "avviato" \
  "$(cd "$HOME/proj/alpha" && "$T/orfano/claude-account-wrapper" /bin/echo avviato 2>/dev/null)"

echo "--- 11. list"
chk "list mostra i due slot" "2" "$($CLI list | wc -l | tr -d ' ')"

echo "--- 12. usage --porcelain"
# pretty-printed fixture: flat vs pretty changes the parser's behaviour, and the real
# .claude.json is pretty (thousands of lines). Testing one flat line would prove nothing.
cat > "$HOME/.claude.json" <<'JSON'
{
  "oauthAccount": {
    "emailAddress": "default@example.com",
    "displayName": "Tizio",
    "organizationType": "claude_max",
    "organizationRateLimitTier": "default_claude_max_20x"
  },
  "cachedUsageUtilization": {
    "fetchedAtMs": 1787157358038,
    "utilization": {
      "five_hour": {
        "utilization": 3,
        "resets_at": "2026-08-19T21:09:59.700950+00:00"
      },
      "seven_day": {
        "utilization": 14,
        "resets_at": "2026-08-20T16:59:59.700971+00:00"
      },
      "seven_day_opus": null,
      "extra_usage": {
        "is_enabled": true,
        "monthly_limit": 2000
      },
      "limits": [
        { "kind": "session",     "percent": 3,  "is_active": false },
        { "kind": "weekly_all",  "percent": 14, "is_active": true }
      ],
      "spend": {
        "used":  { "amount_minor": 250, "currency": "EUR", "exponent": 2 },
        "limit": { "amount_minor": 2000, "currency": "EUR", "exponent": 2 },
        "percent": 12
      }
    }
  }
}
JSON
# slot with extra_usage off but spend.used.currency set: a real case — the UI must not
# show an empty credit row by inferring presence from the currency.
$CLI new noextra >/dev/null 2>&1
cat > "$HOME/.claude-accounts/noextra/.claude.json" <<'JSON'
{
  "oauthAccount": { "emailAddress": "noextra@example.com" },
  "cachedUsageUtilization": {
    "fetchedAtMs": 1787157351935,
    "utilization": {
      "five_hour": { "utilization": 1, "resets_at": "2026-08-19T21:19:59.861023+00:00" },
      "seven_day": { "utilization": 12, "resets_at": "2026-08-20T07:59:59.861045+00:00" },
      "extra_usage": { "is_enabled": false },
      "limits": [ { "kind": "weekly_all", "percent": 12, "is_active": true } ],
      "spend": { "used": { "amount_minor": null, "currency": "USD", "exponent": 2 } }
    }
  }
}
JSON
$CLI new broken >/dev/null 2>&1
printf '{"oauthAccount":{"emailAddress":"broken@example.com"},"cachedUsa' > "$HOME/.claude-accounts/broken/.claude.json"
$CLI new mailoggato >/dev/null 2>&1

u=$($CLI usage --porcelain default)
chk "5h"                   "3"  "$(field "$u" five_hour_pct)"
chk "7d"                   "14" "$(field "$u" seven_day_pct)"
chk "resets_at intact (not truncated at +00:00)" \
    "2026-08-19T21:09:59.700950+00:00" "$(field "$u" five_hour_resets_at)"
chk "seven_day does not match seven_day_opus" "1" "$(printf '%s\n' "$u" | grep -c '^seven_day_pct=')"
chk "active_limit"         "weekly_all" "$(field "$u" active_limit)"
chk "tier"                 "default_claude_max_20x" "$(field "$u" tier)"
chk "extra attivo"         "1"   "$(field "$u" extra_enabled)"
chk "spend usato"          "250" "$(field "$u" spend_used_minor)"
chk "spend valuta"         "EUR" "$(field "$u" spend_currency)"

u=$($CLI usage --porcelain noextra)
chk "spend azzerato se extra spento" "" "$(field "$u" spend_currency)"
chk "extra spento"         "0"   "$(field "$u" extra_enabled)"
chk "percentuali comunque presenti" "12" "$(field "$u" seven_day_pct)"

u=$($CLI usage --porcelain mailoggato)
chk "mai loggato: logged_in=0"        "0" "$(field "$u" logged_in)"
chk "mai loggato: nessuna percentuale" ""  "$(field "$u" five_hour_pct)"

chk "corrupt json does not break"  "0" "$($CLI usage --porcelain broken >/dev/null 2>&1; echo $?)"
chk "corrupt json: no data" ""  "$(field "$($CLI usage --porcelain broken)" five_hour_pct)"
chk "usage with no name lists all" "5" "$($CLI usage --porcelain | grep -c '^name=')"
chk "usage slot missing"   "1" "$($CLI usage --porcelain ghost >/dev/null 2>&1; echo $?)"

echo "--- 13. list --porcelain: columns appended at the end"
l=$($CLI list --porcelain | head -1)
chk "6 colonne"        "6" "$(printf '%s' "$l" | awk -F'\t' '{print NF}')"
chk "colonna 1 invariata" "default" "$(printf '%s' "$l" | cut -f1)"
chk "colonna 3 invariata" "$HOME/.claude" "$(printf '%s' "$l" | cut -f3)"
chk "logged_in"        "1" "$(printf '%s' "$l" | cut -f5)"
chk "keychain default with no suffix" "Claude Code-credentials" "$(printf '%s' "$l" | cut -f6)"
chk "keychain slot with hash" "Claude Code-credentials-$(printf '%s' "$HOME/.claude-accounts/work" | shasum -a 256 | cut -c1-8)" \
    "$($CLI list --porcelain | grep '^work	' | cut -f6)"

echo "--- 14. login-cmd"
chk "default: nessuna CLAUDE_CONFIG_DIR" "claude auth login" "$($CLI login-cmd default)"
chk "slot: with CLAUDE_CONFIG_DIR" "CLAUDE_CONFIG_DIR=$HOME/.claude-accounts/work claude auth login" \
    "$($CLI login-cmd work)"
chk "slot missing" "1" "$($CLI login-cmd ghost >/dev/null 2>&1; echo $?)"

echo "--- 15. rename"
chk "rename default rifiutato"    "1" "$($CLI rename default x >/dev/null 2>&1; echo $?)"
chk "rename verso default rifiutato" "1" "$($CLI rename work default >/dev/null 2>&1; echo $?)"
chk "rename su nome esistente"    "1" "$($CLI rename work noextra >/dev/null 2>&1; echo $?)"
chk "rename nonexistent"          "1" "$($CLI rename ghost x >/dev/null 2>&1; echo $?)"
$CLI use work "$HOME/proj/beta" >/dev/null
out=$($CLI rename work office 2>&1)
chk "dir moved"      "yes" "$([ -d "$HOME/.claude-accounts/office" ] && echo yes)"
chk "old dir gone" ""  "$([ -d "$HOME/.claude-accounts/work" ] && echo yes)"
ovbeta="$HOME/.config/claude-account/overrides/$(cd "$HOME/proj/beta" && pwd -P | tr '/' '-')"
chk "override rewritten" "office" "$(cat "$ovbeta")"
chk "warns about logging in again" "1" "$(printf '%s\n' "$out" | grep -c 'Log in again')"
chk "table untouched by rename" "2" "$(grep -c '^work	' "$HOME/.config/claude-account/accounts")"
chk "rename warns about the table" "1" "$(printf '%s\n' "$out" | grep -c 'still point at')"
$CLI rename office work >/dev/null 2>&1

echo "--- 16. rm"
chk "rm default rejected" "1" "$($CLI rm default >/dev/null 2>&1; echo $?)"
chk "rm nonexistent"       "1" "$($CLI rm ghost >/dev/null 2>&1; echo $?)"
# a real copy in place of the symlink must be protected: those files are unique
cp -R "$HOME/.claude/skills" "$HOME/.claude-accounts/noextra/skills-tmp"
rm "$HOME/.claude-accounts/noextra/skills" && mv "$HOME/.claude-accounts/noextra/skills-tmp" "$HOME/.claude-accounts/noextra/skills"
chk "refuses when config is copied, not symlinked" "1" "$($CLI rm noextra >/dev/null 2>&1; echo $?)"
chk "--force goes through"        "0" "$($CLI rm noextra --force >/dev/null 2>&1; echo $?)"

$CLI use work "$HOME/proj/beta" >/dev/null
$CLI rm work >/dev/null 2>&1
chk "slot removed"      ""  "$([ -d "$HOME/.claude-accounts/work" ] && echo yes)"
chk "override cleaned up" ""  "$([ -f "$ovbeta" ] && echo yes)"
# the two load-bearing assertions: rm -rf must not follow symlinks into ~/.claude
chk "symlink target intact" "istruzioni" "$(cat "$HOME/.claude/CLAUDE.md")"
chk "~/.claude survives"       "yes" "$([ -d "$HOME/.claude" ] && echo yes)"
chk "default skills intact" "yes" "$([ -d "$HOME/.claude/skills" ] && echo yes)"

echo "--- 17. --live degrades to the cache"
# the fake HOME has no Keychain entry: --live must fall back to the cache without
# errors and without passing the data off as fresh
u=$($CLI usage --live --porcelain default)
chk "--live with no credentials: exit 0" "0" "$($CLI usage --live --porcelain default >/dev/null 2>&1; echo $?)"
chk "--live marked as cached"  "0"  "$(field "$u" live)"
chk "--live keeps the cached data" "3" "$(field "$u" five_hour_pct)"
chk "cache: live=0"              "0"  "$(field "$($CLI usage --porcelain default)" live)"
chk "--live on never-logged-in"      "0"  "$($CLI usage --live --porcelain mailoggato >/dev/null 2>&1; echo $?)"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
rm -rf "$T"
[ "$fail" -eq 0 ]
