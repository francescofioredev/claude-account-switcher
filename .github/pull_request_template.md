<!-- What changed and why. A few lines is plenty — the diff is right there. -->

## Checks

- [ ] `sh test/run-tests.sh` passes
- [ ] `node --check extension/extension.js` passes
- [ ] No new `set -e` in `bin/claude-account`: an error there must degrade to the default
      account, never stop Claude from launching
- [ ] `--porcelain` columns appended at the end, never reordered or renamed
- [ ] Docs and comments in English
