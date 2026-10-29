#!/bin/sh
# claude-account tests. Runs in a fake HOME and touches nothing real:
# not ~/.claude, not ~/.claude-accounts, not ~/.config/claude-account.
#
#   sh test/run-tests.sh

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd)
CLI="$REPO/bin/claude-account"
WRAP="$REPO/bin/claude-account-wrapper"

T=$(mktemp -d)
export HOME="$T/home"
unset XDG_CONFIG_HOME
# rm, rename, logout and usage --live call these: stubs keep the suite off the real login Keychain
mkdir -p "$T/stub"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/claude"
printf '#!/bin/sh\nexit 1\n' > "$T/stub/security"
chmod +x "$T/stub/claude" "$T/stub/security"
export PATH="$T/stub:$PATH"
mkdir -p "$HOME/.claude/skills" "$HOME/.claude/agents" "$HOME/proj/alpha/sub" "$HOME/proj/beta" "$HOME/altro"
printf 'instructions\n' > "$HOME/.claude/CLAUDE.md"
# Claude Code's asymmetry: the default account's .claude.json sits BESIDE ~/.claude,
# while with CLAUDE_CONFIG_DIR set it sits INSIDE the config dir.
printf '{"oauthAccount":{"emailAddress":"default@example.com"}}' > "$HOME/.claude.json"

pass=0; fail=0
chk() { # chk <description> <expected> <actual>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok   %s\n' "$1"
  else fail=$((fail+1)); printf '  FAIL %s\n       expected: [%s]\n       actual:   [%s]\n' "$1" "$2" "$3"; fi
}
field() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

echo "--- 1. no config: everything default"
chk "resolve empty"        ""        "$($CLI resolve "$HOME/proj/alpha")"
s=$($CLI status "$HOME/proj/alpha")
chk "status account"       "default" "$(field "$s" account)"
chk "status source"        "default" "$(field "$s" source)"
chk "status config_dir"    "$HOME/.claude" "$(field "$s" config_dir)"
chk "status email"         "default@example.com" "$(field "$s" email)"

echo "--- 2. nonexistent path does not break"
chk "resolve missing"  ""        "$($CLI resolve /tmp/nope-non-esiste)"
chk "exit code"            "0"       "$($CLI resolve /tmp/nope-non-esiste >/dev/null 2>&1; echo $?)"

echo "--- 3. new creates the slot with symlinks"
$CLI new work >/dev/null 2>&1
chk "slot created"          "yes"     "$([ -d "$HOME/.claude-accounts/work" ] && echo yes)"
chk "skills symlinked"     "yes"     "$([ -L "$HOME/.claude-accounts/work/skills" ] && echo yes)"
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

echo "--- 7. path canonicalization"
$CLI use work "$HOME/proj/beta" >/dev/null
chk "path with /./ same slug" "override" "$(field "$($CLI status "$HOME/proj/./beta")" source)"
chk "path with .. same slug"  "override" "$(field "$($CLI status "$HOME/proj/alpha/../beta")" source)"
$CLI clear "$HOME/proj/beta" >/dev/null

echo "--- 8. marker file in the repo, and precedence"
printf 'work\n' > "$HOME/altro/.claude-account"
chk "marker active"        "$HOME/.claude-accounts/work" "$($CLI resolve "$HOME/altro")"
chk "source=marker"        "marker"  "$(field "$($CLI status "$HOME/altro")" source)"
$CLI use default "$HOME/altro" >/dev/null
chk "override beats marker" "override" "$(field "$($CLI status "$HOME/altro")" source)"
$CLI clear "$HOME/altro" >/dev/null
printf 'ghost\n' > "$HOME/altro/.claude-account"
chk "ghost marker → default" "default" "$(field "$($CLI status "$HOME/altro")" source)"

echo "--- 9. use on a missing slot fails"
chk "use ghost slot"         "1"       "$($CLI use ghost "$HOME/proj/beta" >/dev/null 2>&1; echo $?)"

echo "--- 10. the wrapper passes the env through and degrades"
mkdir -p "$HOME/unmapped"
chk "wrapper default→unset" "DEFAULT" "$(cd "$HOME/unmapped" && $WRAP /bin/sh -c 'echo ${CLAUDE_CONFIG_DIR:-DEFAULT}')"
chk "wrapper mapped→set"   "$HOME/.claude-accounts/work" "$(cd "$HOME/proj/alpha" && $WRAP /bin/sh -c 'echo $CLAUDE_CONFIG_DIR')"
chk "wrapper exec passes args through" "a b" "$(cd "$HOME" && $WRAP /bin/echo a b)"
# the extension hands the wrapper the VS Code process env: if it already held a
# CLAUDE_CONFIG_DIR, the default branch must still clear it
chk "wrapper clears an inherited CLAUDE_CONFIG_DIR" "DEFAULT" \
  "$(cd "$HOME/unmapped" && CLAUDE_CONFIG_DIR=/dirty $WRAP /bin/sh -c 'echo ${CLAUDE_CONFIG_DIR:-DEFAULT}')"
# if the CLI disappears, Claude must still start
mkdir -p "$T/orphan"
cp "$WRAP" "$T/orphan/claude-account-wrapper"
chk "wrapper degrades when the CLI is missing" "started" \
  "$(cd "$HOME/proj/alpha" && "$T/orphan/claude-account-wrapper" /bin/echo started 2>/dev/null)"

echo "--- 11. list"
chk "list shows both slots"  "2" "$($CLI list | wc -l | tr -d ' ')"

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
$CLI new nologin >/dev/null 2>&1

u=$($CLI usage --porcelain default)
chk "5h"                   "3"  "$(field "$u" five_hour_pct)"
chk "7d"                   "14" "$(field "$u" seven_day_pct)"
chk "resets_at intact (not truncated at +00:00)" \
    "2026-08-19T21:09:59.700950+00:00" "$(field "$u" five_hour_resets_at)"
chk "seven_day does not match seven_day_opus" "1" "$(printf '%s\n' "$u" | grep -c '^seven_day_pct=')"
chk "active_limit"         "weekly_all" "$(field "$u" active_limit)"
chk "tier"                 "default_claude_max_20x" "$(field "$u" tier)"
chk "extra on"             "1"   "$(field "$u" extra_enabled)"
chk "spend used"           "250" "$(field "$u" spend_used_minor)"
chk "spend currency"       "EUR" "$(field "$u" spend_currency)"

u=$($CLI usage --porcelain noextra)
chk "spend zeroed when extra is off" "" "$(field "$u" spend_currency)"
chk "extra off"            "0"   "$(field "$u" extra_enabled)"
chk "percentages still present"     "12" "$(field "$u" seven_day_pct)"

u=$($CLI usage --porcelain nologin)
chk "never logged in: logged_in=0"    "0" "$(field "$u" logged_in)"
chk "never logged in: no percentages"  ""  "$(field "$u" five_hour_pct)"

chk "corrupt json does not break"  "0" "$($CLI usage --porcelain broken >/dev/null 2>&1; echo $?)"
chk "corrupt json: no data" ""  "$(field "$($CLI usage --porcelain broken)" five_hour_pct)"
chk "usage with no name lists all" "5" "$($CLI usage --porcelain | grep -c '^name=')"
chk "usage slot missing"   "1" "$($CLI usage --porcelain ghost >/dev/null 2>&1; echo $?)"

echo "--- 13. list --porcelain: columns appended at the end"
l=$($CLI list --porcelain | head -1)
chk "8 columns"        "8" "$(printf '%s' "$l" | awk -F'\t' '{print NF}')"
chk "column 1 unchanged"  "default" "$(printf '%s' "$l" | cut -f1)"
chk "column 3 unchanged"  "$HOME/.claude" "$(printf '%s' "$l" | cut -f3)"
chk "logged_in"        "1" "$(printf '%s' "$l" | cut -f5)"
chk "keychain default with no suffix" "Claude Code-credentials" "$(printf '%s' "$l" | cut -f6)"
chk "keychain slot with hash" "Claude Code-credentials-$(printf '%s' "$HOME/.claude-accounts/work" | shasum -a 256 | cut -c1-8)" \
    "$($CLI list --porcelain | grep '^work	' | cut -f6)"
chk "shared column, off by default" "0" "$($CLI list --porcelain | grep '^work	' | cut -f7)"

echo "--- 14. login-cmd"
chk "default: no CLAUDE_CONFIG_DIR"      "claude auth login" "$($CLI login-cmd default)"
chk "slot: with CLAUDE_CONFIG_DIR" "CLAUDE_CONFIG_DIR=$HOME/.claude-accounts/work claude auth login" \
    "$($CLI login-cmd work)"
chk "slot missing" "1" "$($CLI login-cmd ghost >/dev/null 2>&1; echo $?)"

echo "--- 15. rename"
chk "rename default rejected"     "1" "$($CLI rename default x >/dev/null 2>&1; echo $?)"
chk "rename to default rejected"     "1" "$($CLI rename work default >/dev/null 2>&1; echo $?)"
chk "rename onto an existing name" "1" "$($CLI rename work noextra >/dev/null 2>&1; echo $?)"
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
chk "symlink target intact" "instructions" "$(cat "$HOME/.claude/CLAUDE.md")"
chk "~/.claude survives"       "yes" "$([ -d "$HOME/.claude" ] && echo yes)"
chk "default skills intact" "yes" "$([ -d "$HOME/.claude/skills" ] && echo yes)"

echo "--- 17. --live degrades to the cache"
# the stubbed security finds no token: --live must fall back to the cache without
# errors and without passing the data off as fresh
u=$($CLI usage --live --porcelain default)
chk "--live with no credentials: exit 0" "0" "$($CLI usage --live --porcelain default >/dev/null 2>&1; echo $?)"
chk "--live marked as cached"  "0"  "$(field "$u" live)"
chk "--live keeps the cached data" "3" "$(field "$u" five_hour_pct)"
chk "cache: live=0"              "0"  "$(field "$($CLI usage --porcelain default)" live)"
chk "--live on never-logged-in"      "0"  "$($CLI usage --live --porcelain nologin >/dev/null 2>&1; echo $?)"

echo "--- 18. start folder: pin, read back, clear"
mkdir -p "$HOME/root A" "$HOME/rootB"
chk "no pin: cwd empty"      ""  "$($CLI cwd "$HOME/rootB")"
chk "no pin: status cwd empty" "" "$(field "$($CLI status "$HOME/rootB")" cwd)"
# a space in the folder name is why the pin is not read with read1()
# the pin is canonicalized on the way in, like the account overrides
rootA=$(cd "$HOME/root A" && pwd -P)
$CLI set-cwd "$HOME/root A" "$HOME/rootB" >/dev/null
chk "cwd reads the pin back" "$rootA" "$($CLI cwd "$HOME/rootB")"
chk "status reports the pin" "$rootA" "$(field "$($CLI status "$HOME/rootB")" cwd)"
chk "path with /./ same slug" "$rootA" "$($CLI cwd "$HOME/./rootB")"
chk "path with .. same slug"  "$rootA" "$($CLI cwd "$HOME/proj/../rootB")"
chk "set-cwd on a missing folder fails" "1" "$($CLI set-cwd "$HOME/nope" "$HOME/rootB" >/dev/null 2>&1; echo $?)"
chk "pin survives a failed set-cwd" "$rootA" "$($CLI cwd "$HOME/rootB")"
# pinning a folder to itself is the absence of a pin, not a pin that loops
$CLI set-cwd "$HOME/rootB" "$HOME/rootB" >/dev/null
chk "pin at itself is ignored" "" "$($CLI cwd "$HOME/rootB")"
$CLI set-cwd "$HOME/root A" "$HOME/rootB" >/dev/null
$CLI clear-cwd "$HOME/rootB" >/dev/null
chk "clear-cwd removes the pin" "" "$($CLI cwd "$HOME/rootB")"

echo "--- 19. the wrapper moves, and the account does not follow"
# ~/proj/alpha resolves to a slot via the table, ~/root A to nothing: after the cd the
# session is in ~/root A but the account must still be the one for ~/proj/alpha
$CLI new work >/dev/null 2>&1
$CLI set-cwd "$HOME/root A" "$HOME/proj/alpha" >/dev/null
chk "wrapper starts in the pinned folder" "$(cd "$HOME/root A" && pwd -P)" \
  "$(cd "$HOME/proj/alpha" && $WRAP /bin/sh -c 'pwd -P')"
chk "account stays the window's" "$HOME/.claude-accounts/work" \
  "$(cd "$HOME/proj/alpha" && $WRAP /bin/sh -c 'echo $CLAUDE_CONFIG_DIR')"
# the pinned folder disappears (deleted, or dropped from the workspace)
rm -rf "$HOME/root A"
chk "pin at a missing folder: stays put" "$(cd "$HOME/proj/alpha" && pwd -P)" \
  "$(cd "$HOME/proj/alpha" && $WRAP /bin/sh -c 'pwd -P')"
chk "pin at a missing folder: still starts" "started" \
  "$(cd "$HOME/proj/alpha" && $WRAP /bin/echo started 2>/dev/null)"
$CLI clear-cwd "$HOME/proj/alpha" >/dev/null
$CLI rm work --force >/dev/null 2>&1

echo "--- 20. share: sessions, plans and .claude.json keys"
mkdir -p "$HOME/.claude/plans"
printf 'default plan\n' > "$HOME/.claude/plans/same.md"
$CLI new pre >/dev/null 2>&1
mkdir -p "$HOME/.claude-accounts/pre/plans" "$HOME/.claude-accounts/pre/sessions" \
  "$HOME/.claude-accounts/pre/file-history/sid/a" "$HOME/.claude/file-history/sid"
printf 'slot plan\n' > "$HOME/.claude-accounts/pre/plans/only-slot.md"
printf 'slot copy\n' > "$HOME/.claude-accounts/pre/plans/same.md"
printf 'v1\n' > "$HOME/.claude-accounts/pre/file-history/sid/a/x@v1"
printf '{"pid":%s,"sessionId":"live"}' "$$" > "$HOME/.claude-accounts/pre/sessions/$$.json"
chk "share refuses with a live session" "1" "$($CLI share pre on >/dev/null 2>&1; echo $?)"
chk "refusal leaves sessions real" "" "$([ -L "$HOME/.claude-accounts/pre/sessions" ] && echo yes)"
chk "--force goes through" "0" "$($CLI share pre on --force >/dev/null 2>&1; echo $?)"
for f in sessions plans file-history session-env shell-snapshots; do
  chk "$f linked" "$HOME/.claude/$f" "$(readlink "$HOME/.claude-accounts/pre/$f")"
done
chk "plan migrated"            "slot plan"    "$(cat "$HOME/.claude/plans/only-slot.md")"
chk "colliding plan untouched" "default plan" "$(cat "$HOME/.claude/plans/same.md")"
chk "collision kept aside"     "slot copy"    "$(cat "$HOME/.claude-accounts/pre/plans.pre-share/same.md")"
chk "same session id merged"   "v1"           "$(cat "$HOME/.claude/file-history/sid/a/x@v1")"
chk "empty backups removed"    ""  "$([ -e "$HOME/.claude-accounts/pre/file-history.pre-share" ] && echo yes)"
chk "session registry moved"   "yes" "$([ -f "$HOME/.claude/sessions/$$.json" ] && echo yes)"
chk "share reports on"         "shared=1" "$($CLI share pre)"
$CLI use pre "$HOME/proj/beta" >/dev/null
chk "status reports shared"    "1" "$(field "$($CLI status "$HOME/proj/beta")" shared)"
chk "porcelain column 7"       "1" "$($CLI list --porcelain | grep '^pre	' | cut -f7)"
chk "usage reports shared"     "1" "$(field "$($CLI usage --porcelain pre)" shared)"
chk "share on is idempotent"   "0" "$($CLI share pre on >/dev/null 2>&1; echo $?)"
chk "default cannot share"     "1" "$($CLI share default on >/dev/null 2>&1; echo $?)"
chk "share on a missing slot"  "1" "$($CLI share ghost on >/dev/null 2>&1; echo $?)"

cat > "$HOME/.claude.json" <<'JSON'
{
  "oauthAccount": { "emailAddress": "default@example.com" },
  "userID": "default-user",
  "mcpServers": { "neon": { "command": "neon-mcp" }, "both": { "command": "from-default" } },
  "githubRepoPaths": { "acme/app": ["/a"] },
  "claudeInChromeDefaultEnabled": true,
  "projects": {
    "/trusted": { "hasTrustDialogAccepted": true, "lastSessionId": "default-session", "allowedTools": ["Bash(ls)"] },
    "/untouched": { "hasTrustDialogAccepted": false, "lastSessionId": "x" }
  }
}
JSON
cat > "$HOME/.claude-accounts/pre/.claude.json" <<'JSON'
{
  "oauthAccount": { "emailAddress": "pre@example.com" },
  "userID": "pre-user",
  "mcpServers": { "slot-only": { "command": "mine" }, "both": { "command": "from-slot" } },
  "githubRepoPaths": { "acme/app": ["/b"] },
  "projects": { "/trusted": { "lastSessionId": "slot-session", "allowedTools": ["Read"] } }
}
JSON
j="$HOME/.claude-accounts/pre/.claude.json"
jget() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=eval("j"+process.argv[2]);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2"; }
(cd "$HOME/proj/beta" && $WRAP /bin/echo started >/dev/null 2>&1)
chk "wrapper merges a default MCP server" "neon-mcp" "$(jget "$j" '.mcpServers.neon.command')"
chk "default wins a name clash"   "from-default" "$(jget "$j" '.mcpServers.both.command')"
chk "slot-only server kept"       "mine" "$(jget "$j" '.mcpServers["slot-only"].command')"
chk "identity untouched"          "pre@example.com" "$(jget "$j" '.oauthAccount.emailAddress')"
chk "userID untouched"            "pre-user" "$(jget "$j" '.userID')"
chk "repo paths unioned"          '["/b","/a"]' "$(jget "$j" '.githubRepoPaths["acme/app"]')"
chk "chrome flag copied"          "true" "$(jget "$j" '.claudeInChromeDefaultEnabled')"
chk "trust copied"                "true" "$(jget "$j" '.projects["/trusted"].hasTrustDialogAccepted')"
chk "allowed tools unioned"       '["Read","Bash(ls)"]' "$(jget "$j" '.projects["/trusted"].allowedTools')"
chk "session pointer untouched"   "slot-session" "$(jget "$j" '.projects["/trusted"].lastSessionId')"
chk "untrusted project not copied" "undefined" "$(jget "$j" '.projects["/untouched"]')"
chk "file stays private"          "600" "$(stat -f %Lp "$j")"
before=$(ls -i "$j")
$CLI sync-json pre
chk "no rewrite when nothing changed" "$before" "$(ls -i "$j")"
chk "sync-json takes a config dir" "0" "$($CLI sync-json "$HOME/.claude-accounts/pre" >/dev/null 2>&1; echo $?)"

printf '{ broken' > "$j"
chk "broken slot json: wrapper still starts" "started" \
  "$(cd "$HOME/proj/beta" && $WRAP /bin/echo started 2>/dev/null)"
chk "broken slot json left alone" "{ broken" "$(cat "$j")"
chk "no temp files left behind" "0" "$(ls "$HOME/.claude-accounts/pre" | grep -c '^\.claude\.json\.')"

$CLI share pre off >/dev/null 2>&1
chk "off: real dir again" "dir" "$([ -d "$HOME/.claude-accounts/pre/plans" ] && [ ! -L "$HOME/.claude-accounts/pre/plans" ] && echo dir)"
chk "off: history stays in ~/.claude" "slot plan" "$(cat "$HOME/.claude/plans/only-slot.md")"
chk "share reports off" "shared=0" "$($CLI share pre)"
printf '{"mcpServers":{}}' > "$j"
$CLI sync-json pre
chk "not shared: sync-json is a no-op" '{"mcpServers":{}}' "$(cat "$j")"

$CLI new fresh --share >/dev/null 2>&1
chk "new --share links sessions" "$HOME/.claude/sessions" "$(readlink "$HOME/.claude-accounts/fresh/sessions")"
$CLI rm fresh >/dev/null 2>&1
chk "rm of a shared slot keeps ~/.claude/plans" "slot plan" "$(cat "$HOME/.claude/plans/only-slot.md")"
chk "rm of a shared slot keeps the registry" "yes" "$([ -f "$HOME/.claude/sessions/$$.json" ] && echo yes)"
$CLI clear "$HOME/proj/beta" >/dev/null
$CLI rm pre --force >/dev/null 2>&1

echo "--- 21. labels: display only, the key stays the identity"
LBL="$HOME/.config/claude-account/labels"
$CLI new work >/dev/null 2>&1
printf '{"oauthAccount":{"emailAddress":"work@example.com"}}' > "$HOME/.claude-accounts/work/.claude.json"
chk "no label by default"  "" "$($CLI label default)"
chk "status label empty"   "" "$(field "$($CLI status "$HOME/altro")" label)"
chk "set exits 0"          "0" "$($CLI label default me@example.com >/dev/null 2>&1; echo $?)"
chk "label read back"      "me@example.com" "$($CLI label default)"
chk "stored as key label"  "default me@example.com" "$(cat "$LBL")"
$CLI label work "Work account" >/dev/null 2>&1
chk "label with spaces"    "Work account" "$($CLI label work)"
chk "list shows label and key" "1" "$($CLI list | grep -c '^me@example.com (default) ')"
chk "list shows spaced label"  "1" "$($CLI list | grep -c '^Work account (work) ')"
chk "list columns stay aligned" "1" "$($CLI list | awk '{print index($0,$NF)}' | sort -u | wc -l | tr -d ' ')"
s=$($CLI status "$HOME/altro")
chk "status account is still the key" "default" "$(field "$s" account)"
chk "status label"         "me@example.com" "$(field "$s" label)"
chk "status keeps its other keys" "default" "$(field "$s" source)"
$CLI use work "$HOME/proj/alpha" >/dev/null
chk "resolve is still a path" "$HOME/.claude-accounts/work" "$($CLI resolve "$HOME/proj/alpha")"
$CLI clear "$HOME/proj/alpha" >/dev/null
l=$($CLI list --porcelain | head -1)
chk "porcelain 8 columns"  "8" "$(printf '%s' "$l" | awk -F'\t' '{print NF}')"
chk "porcelain column 1 is the key" "default" "$(printf '%s' "$l" | cut -f1)"
chk "porcelain column 7 unchanged"  "0" "$(printf '%s' "$l" | cut -f7)"
chk "porcelain label last" "me@example.com" "$(printf '%s' "$l" | cut -f8)"
$CLI label work --clear >/dev/null
chk "porcelain no label: empty column kept" "8" "$($CLI list --porcelain | grep '^work	' | awk -F'\t' '{print NF}')"
$CLI label work "Work account" >/dev/null
u=$($CLI usage --porcelain default)
chk "usage name stays the key" "default" "$(field "$u" name)"
chk "usage label"          "me@example.com" "$(field "$u" label)"
chk "usage email unchanged" "default@example.com" "$(field "$u" email)"
chk "usage by label"       "default" "$(field "$($CLI usage --porcelain me@example.com)" name)"
chk "login-cmd by label"   "CLAUDE_CONFIG_DIR=$HOME/.claude-accounts/work claude auth login" "$($CLI login-cmd 'Work account')"
chk "use by label pins the key" "work" "$($CLI use 'Work account' "$HOME/proj/beta" >/dev/null; field "$($CLI status "$HOME/proj/beta")" account)"
$CLI clear "$HOME/proj/beta" >/dev/null
chk "unknown name still fails" "1" "$($CLI usage nobody >/dev/null 2>&1; echo $?)"
chk "label of a missing account fails" "1" "$($CLI label ghost x >/dev/null 2>&1; echo $?)"
chk "label equal to another key refused" "1" "$($CLI label work default >/dev/null 2>&1; echo $?)"
chk "label equal to another label refused" "1" "$($CLI label work me@example.com >/dev/null 2>&1; echo $?)"
chk "tab in a label refused" "1" "$($CLI label work "a	b" >/dev/null 2>&1; echo $?)"
chk "failed set leaves the label" "Work account" "$($CLI label work)"
$CLI rename work job >/dev/null 2>&1
chk "rename carries the label" "Work account" "$($CLI label job)"
chk "rename leaves no old line" "0" "$(grep -c '^work ' "$LBL")"
$CLI rename job work >/dev/null 2>&1
$CLI new gone >/dev/null 2>&1
chk "set on a slot to be removed" "1" "$($CLI label gone Trash >/dev/null 2>&1; grep -c '^gone Trash$' "$LBL")"
$CLI rm gone >/dev/null 2>&1
chk "rm drops the label"   "0" "$(grep -c '^gone ' "$LBL")"
chk "case variant of its own key allowed" "Work" "$($CLI label work Work >/dev/null 2>&1; $CLI label work)"
$CLI label work "Work account" >/dev/null 2>&1
chk "non-ASCII label" "Señor Työ" "$(export LC_ALL=C; $CLI label work 'Señor Työ' >/dev/null 2>&1; $CLI label work)"
$CLI label work "Work account" >/dev/null 2>&1
chk "'---' in a label refused" "1" "$($CLI label work 'a---b' >/dev/null 2>&1; echo $?)"
chk "empty key refused"   "1" "$($CLI label '' x >/dev/null 2>&1; echo $?)"
chk "dot key refused"     "1" "$($CLI label .. x >/dev/null 2>&1; echo $?)"
chk "alias in share"      "shared=0" "$($CLI share 'Work account')"
chk "alias in logout"     "logged out work" "$($CLI logout 'Work account' | head -1)"
chk "alias in label"      "Work account" "$($CLI label 'Work account')"
chk "usage porcelain label, slot" "Work account" "$(field "$($CLI usage --porcelain work)" label)"
chk "last line without newline is read" "Late" "$(printf 'default x\nwork Late' > "$LBL"; $CLI label work)"
printf 'default me@example.com\nwork Work account\n' > "$LBL"
chk "unreadable labels file is not wiped" "1" "$(chmod 000 "$LBL"; $CLI label work Zed >/dev/null 2>&1; echo $?)"
chmod 600 "$LBL"
chk "labels survived"     "2" "$(wc -l < "$LBL" | tr -d ' ')"
chk "new refuses a name that is a label" "1" "$($CLI new 'Work account' >/dev/null 2>&1; echo $?)"
chk "refused new creates nothing" "no" "$([ -e "$HOME/.claude-accounts/Work account" ] && echo yes || echo no)"
chk "rename refuses a name that is a label" "1" "$($CLI rename work 'Work account' >/dev/null 2>&1; echo $?)"
chk "refused rename leaves the slot" "yes" "$([ -d "$HOME/.claude-accounts/work" ] && echo yes)"
chk "refusal names the owner" "1" "$($CLI new 'Work account' 2>&1 | grep -c "label (of 'work')")"
chk "--clear says so"      "work → no label" "$($CLI label work --clear)"
chk "cleared label gone"   "" "$($CLI label work)"
$CLI label default "" >/dev/null 2>&1
chk "empty label clears"   "" "$($CLI label default)"
chk "labels file removed when empty" "no" "$([ -e "$LBL" ] && echo yes || echo no)"
chk "list plain again"     "1" "$($CLI list | grep -c '^default ')"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
rm -rf "$T"
[ "$fail" -eq 0 ]
