# Contributing

Bug reports and pull requests are welcome.

## Running the tests

```sh
sh test/run-tests.sh
```

The suite builds a throwaway `$HOME` with `mktemp -d` and unsets `XDG_CONFIG_HOME`, so it
never touches your real accounts. It must be green before and after any change.

## Shell constraints

`bin/claude-account` is POSIX `sh`, not bash. No arrays, no `[[`, no `local`.

It uses `set -u` but deliberately **never `set -e`**. The script runs on Claude Code's startup
path via the wrapper: an unexpected error must degrade to the default account, not stop Claude
from launching. Keep that property — return non-zero and let the caller fall back.

## The `--porcelain` contract

`list --porcelain` and `usage --porcelain` are parsed positionally by the VS Code extension.
New columns go **at the end**, never in the middle, and existing columns never get reordered
or renamed. Changing the order silently breaks every installed copy of the extension.

## The wrapper's order of operations

`bin/claude-account-wrapper` resolves the account from `$PWD` **before** it `cd`s into the
pinned start folder. Swap the two and picking a folder would silently change which account is
in use, which is the one thing the feature promises it will not do. `test/run-tests.sh`
section 19 exists to catch exactly that.

## Style

Comments explain *why*, not *what*. The existing ones are the model: short, and about the
reason a line exists rather than what it does.

Everything written down — docs, comments, CLI output, UI strings, commit messages — is in
English, including in a repo whose authors speak something else.
