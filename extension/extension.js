// UI only: the truth about "which account for which project" lives in the
// `claude-account` CLI, the same one the wrapper consults when Claude spawns.
// That is why an override is a file on disk and not internal state: it has to be
// readable by a /bin/sh, at the moment Claude starts.

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_NEW_CONVERSATION = 'claude-vscode.newConversation';

let item;                 // StatusBarItem
let state = null;         // last result of `claude-account status`
let pendingSwitch = false; // switched, but no new conversation opened yet
let watchers = [];
let panel = null;         // AccountsViewProvider, if the view has been created
let usageCache = [];      // last `claude-account usage --porcelain`

// ---------------------------------------------------------------- CLI

function cliPath() {
  const configured = vscode.workspace.getConfiguration('claudeAccount').get('cliPath');
  if (configured) return configured;
  // VS Code launched from the Dock has a reduced PATH and often cannot see
  // ~/.local/bin: try the standard install path before relying on PATH.
  const local = path.join(os.homedir(), '.local', 'bin', 'claude-account');
  if (fs.existsSync(local)) return local;
  return 'claude-account';
}

function runCli(args, timeout, env) {
  return new Promise((resolve) => {
    cp.execFile(
      cliPath(),
      args,
      { timeout: timeout || 5000, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout) => {
        resolve(err ? null : stdout);
      }
    );
  });
}

// The live lookup sends the account's OAuth token to api.anthropic.com, so it stays
// off until the user asks for it. The CLI enforces the same gate on its own: this
// only avoids asking for something it would refuse anyway.
function usageLiveEnabled() {
  return vscode.workspace.getConfiguration('claudeAccount').get('usageLive', false);
}

function parseKeyValue(out) {
  const o = {};
  for (const line of (out || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return o;
}

// ---------------------------------------------------------------- window

// The CLI canonicalizes paths the same way (abspath), and both sides derive the
// same slug from the result: diverge here and an override written by the extension
// is not the one the wrapper looks up.
function canonical(p) {
  try {
    return fs.realpathSync(p).normalize('NFC');
  } catch {
    return p.normalize('NFC');
  }
}

// Must match the cwd the Claude Code extension uses to launch the process:
// realpathSync(workspaceFolders[0] ?? homedir()).normalize('NFC').
// In a multi-root workspace that is the FIRST folder of the .code-workspace; if we
// computed anything else here, the status bar would show an account other than the
// one actually in use.
function windowPath() {
  return canonical(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir());
}

// ---------------------------------------------------------------- account

async function listAccounts() {
  const out = await runCli(['list', '--porcelain']);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, email, configDir, json] = line.split('\t');
      return { name, email: email || '', configDir, json };
    });
}

const SOURCE_LABEL = {
  override: 'picked by hand for this project',
  marker: '.claude-account file in the project',
  table: 'rule in ~/.config/claude-account/accounts',
  default: 'no rule: default account',
};

// ---------------------------------------------------------------- usage

async function getUsage(live) {
  const wantLive = live && usageLiveEnabled();
  const out = wantLive
    ? await runCli(['usage', '--live', '--porcelain'], 30000, {
        CLAUDE_ACCOUNT_USAGE_LIVE: '1',
      })
    : await runCli(['usage', '--porcelain']);
  if (!out) return [];
  return out
    .split('---')
    .map((chunk) => parseKeyValue(chunk))
    .filter((r) => r.name);
}

function usageStale() {
  const withData = usageCache.filter((r) => r.fetched_at_ms);
  if (!withData.length) return true;
  const oldest = Math.min(...withData.map((r) => Number(r.fetched_at_ms)));
  return Date.now() - oldest > staleAfterMs();
}

function staleAfterMs() {
  const m = vscode.workspace
    .getConfiguration('claudeAccount')
    .get('usageStaleAfterMinutes', 360);
  return Math.max(1, m) * 60000;
}

// Usage is updated by Claude Code when it runs on that account: a number without
// its age is indistinguishable from one days old, so it must always be dated.
function formatAge(ms) {
  if (!ms) return null;
  const min = Math.floor((Date.now() - Number(ms)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.floor(min / 60)}h ago`;
  const d = Math.floor(min / 1440);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function formatCountdown(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const min = Math.round((t - Date.now()) / 60000);
  if (min <= 0) return 'a momenti';
  if (min < 60) return `tra ${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  if (h < 24) return r ? `tra ${h}h ${r}m` : `tra ${h}h`;
  return `tra ${Math.floor(h / 24)}g ${h % 24}h`;
}

function formatMoney(minor, exponent, currency) {
  if (minor === '' || minor == null || !currency) return null;
  const exp = Number(exponent || 0);
  const value = Number(minor) / 10 ** exp;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: exp,
    }).format(value);
  } catch {
    return `${value.toFixed(exp)} ${currency}`;
  }
}

function pct(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

async function refresh() {
  const p = windowPath();
  const out = await runCli(['status', p]);

  if (!out) {
    state = null;
    item.text = '$(account) Claude: ?';
    item.tooltip = new vscode.MarkdownString(
      `**claude-account not reachable**\n\n` +
        `Tried: \`${cliPath()}\`\n\n` +
        `Install the repo (\`./install.sh\`) or set \`claudeAccount.cliPath\`.\n\n` +
        `_Claude Code keeps working on the default account._`
    );
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.show();
    return;
  }

  state = parseKeyValue(out);

  const label = state.email || (state.account === 'default' ? 'default' : state.account);
  // The start folder is an invisible change of behaviour — every new session runs
  // somewhere else — so when it is set it is named right there in the bar.
  const folder = state.cwd ? ` $(folder) ${path.basename(state.cwd)}` : '';
  item.text = `${pendingSwitch ? '$(warning)' : '$(account)'} ${label}${folder}`;

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Claude Code account for this window**\n\n`);
  md.appendMarkdown(`- Account: \`${state.account}\`\n`);
  md.appendMarkdown(`- Login: ${state.email || '_never — Claude will ask_'}\n`);
  md.appendMarkdown(`- Why: ${SOURCE_LABEL[state.source] || state.source}\n`);
  md.appendMarkdown(`- Config dir: \`${state.config_dir}\`\n`);
  if (state.cwd) {
    md.appendMarkdown(`- Starts in: \`${state.cwd}\`\n`);
    md.appendMarkdown(`- Workspace root: \`${state.path}\`\n`);
  } else {
    md.appendMarkdown(`- Project: \`${state.path}\`\n`);
  }

  if (vscode.workspace.getConfiguration('claudeAccount').get('usageInTooltip', true)) {
    const u = usageCache.find((r) => r.name === state.account);
    const five = u && pct(u.five_hour_pct);
    const seven = u && pct(u.seven_day_pct);
    if (five != null || seven != null) {
      const age = formatAge(Number(u.fetched_at_ms));
      md.appendMarkdown(
        `- Usage: ${five != null ? `5h ${five}%` : '—'} · ` +
          `${seven != null ? `7d ${seven}%` : '—'}${age ? ` · ${age}` : ''}\n`
      );
    }
  }

  if (pendingSwitch) {
    md.appendMarkdown(
      `\n---\n\n⚠️ Conversations **already open** still run on the previous account: ` +
        `the switch applies from the next one.\n`
    );
  }
  md.appendMarkdown(
    `\n_Click to switch account._ · [Folder](command:claudeAccount.setFolder)` +
      ` · [Panel](command:claudeAccount.showPanel)`
  );
  md.isTrusted = true;
  md.supportThemeIcons = true;
  item.tooltip = md;
  item.backgroundColor = pendingSwitch
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  item.show();
}

// ---------------------------------------------------------------- panel

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const TIER_LABEL = {
  default_claude_max_20x: 'Max 20x',
  default_claude_max_5x: 'Max 5x',
  default_claude_pro: 'Pro',
};

const ICON = {
  refresh:
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.7 2.4v2.9h-2.9"/></svg>',
  more:
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>',
  folder:
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.9 12.6V3.4h4.2l1.5 1.8h6.5v7.4z"/></svg>',
};

// Quota percentages are not a linear "how much is left": below 50% the difference
// does not matter, above 80% every point counts. The colour only changes there.
function level(p) {
  if (p >= 90) return 'crit';
  if (p >= 75) return 'warn';
  return '';
}

function meter(label, p, resets, dim, active) {
  if (p == null) return '';
  const when = formatCountdown(resets);
  return `<div class="m${active ? ' on' : ''}">
    <div class="mtop">
      <span class="mk">${label}</span>
      <span class="mv ${level(p)}">${p}<small>%</small></span>
      ${when ? `<span class="mr">${esc(when)}</span>` : ''}
    </div>
    <div class="bar${dim ? ' dim' : ''}"><i class="${level(p)}" style="width:${Math.max(p, p > 0 ? 1.5 : 0)}%"></i></div>
  </div>`;
}

function card(u, current) {
  const isCurrent = u.name === current;
  const logged = u.logged_in === '1';
  const age = Number(u.fetched_at_ms);
  const veryStale = age ? Date.now() - age > 86400000 : false;
  const n = esc(u.name);

  let body;
  if (!logged) {
    body = `<div class="none">Never logged in</div>
      <div class="acts always"><button class="pri" data-a="login" data-n="${n}">Log in</button></div>`;
  } else {
    const five = pct(u.five_hour_pct);
    const seven = pct(u.seven_day_pct);
    const spend = formatMoney(u.spend_used_minor, u.spend_exponent, u.spend_currency);
    const cap = formatMoney(u.spend_limit_minor, u.spend_exponent, u.spend_currency);
    const meters =
      meter('Session', five, u.five_hour_resets_at, veryStale, u.active_limit === 'session') +
      meter('Week', seven, u.seven_day_resets_at, veryStale, u.active_limit === 'weekly_all');

    body =
      (meters || '<div class="none">No usage data</div>') +
      (u.extra_enabled === '1' && spend
        ? `<div class="xtra"><span>Extra credit</span><b>${esc(spend)}${cap ? ` <span class="of">of ${esc(cap)}</span>` : ''}</b></div>`
        : '') +
      `<div class="acts">
         <button data-a="relogin" data-n="${n}">Log in again</button>
         <button data-a="logout" data-n="${n}">Log out</button>
         ${u.name === 'default' ? '' : `<button class="ico" data-a="more" data-n="${n}" title="Rename or delete" aria-label="More actions for ${n}">${ICON.more}</button>`}
       </div>`;
  }

  const tier = TIER_LABEL[u.tier] || u.tier || '';
  return `<div class="card${isCurrent ? ' cur' : ''}">
    <div class="hd">
      <span class="nm">${n}</span>
      ${isCurrent
        ? '<span class="tag">active</span>'
        : `<button class="use" data-a="use" data-n="${n}">Use here</button>`}
    </div>
    ${u.email ? `<div class="em" title="${esc(u.email)}">${esc(u.email)}${tier ? ` <span class="tier">${esc(tier)}</span>` : ''}</div>` : ''}
    ${body}
  </div>`;
}

function panelHtml(webview, records, current, projectPath, sessionCwd) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const cards = records.length
    ? records.map((u) => card(u, current)).join('')
    : `<div class="empty"><b>claude-account not reachable</b>
         Run <code>./install.sh</code> or set <code>claudeAccount.cliPath</code>.</div>`;

  // Freshness is a property of the fetch, not of the individual account: one line
  // at the bottom instead of the same sentence repeated on every card.
  const withData = records.filter((r) => r.fetched_at_ms);
  // The footer talks about the OLDEST datum: with mixed freshness, saying "updated
  // just now" because one card is would hide the one stuck days ago.
  const allLive = withData.length > 0 && withData.every((r) => r.live === '1');
  const oldest = withData.length ? Math.min(...withData.map((r) => Number(r.fetched_at_ms))) : 0;
  const stale = oldest ? Date.now() - oldest > staleAfterMs() : false;
  const foot = !withData.length
    ? ''
    : allLive
    ? 'Updated just now'
    : `${stale ? '⚠ ' : ''}Data from ${formatAge(oldest)}`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font: var(--vscode-font-weight) 12px/1.45 var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: transparent;
    margin: 0; padding: 10px 10px 4px;
  }

  .card {
    position: relative;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 10px 11px 11px;
    margin-bottom: 8px;
    transition: border-color 160ms ease, background-color 160ms ease;
  }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  /* The active account is marked by a side bar, not a full border: it stays
     readable even while the card is hovered. */
  .card.cur { border-color: var(--vscode-focusBorder); }
  .card.cur::before {
    content: ''; position: absolute; left: -1px; top: 8px; bottom: 8px; width: 2px;
    border-radius: 2px; background: var(--vscode-focusBorder);
  }

  .hd { display: flex; align-items: baseline; gap: 8px; }
  .nm {
    font-size: 13px; font-weight: 600; letter-spacing: -.01em;
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tag {
    font-size: 9.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
    color: var(--vscode-charts-green); flex: none;
  }
  .em {
    color: var(--vscode-descriptionForeground);
    margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tier {
    display: inline-block; margin-left: 4px; padding: 0 5px;
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    font-size: 10px; vertical-align: 1px;
  }

  .m { margin-top: 9px; }
  .mtop { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; }
  .mk { flex: none; color: var(--vscode-descriptionForeground); }
  /* The number is the data: it takes the weight, the bar supports it. */
  .mv {
    flex: 1; text-align: right; font-size: 13px; font-weight: 600;
    font-variant-numeric: tabular-nums; letter-spacing: -.02em;
  }
  .mv small { font-size: 9.5px; font-weight: 500; opacity: .65; margin-left: 1px; }
  .mv.warn { color: var(--vscode-charts-yellow); }
  .mv.crit { color: var(--vscode-charts-red); }
  .mr {
    flex: none; font-size: 10.5px; color: var(--vscode-descriptionForeground);
    padding-left: 7px; border-left: 1px solid var(--vscode-panel-border);
  }
  .bar {
    height: 4px; border-radius: 2px; overflow: hidden;
    background: var(--vscode-panel-border);
  }
  .bar i {
    display: block; height: 100%; border-radius: 2px;
    background: var(--vscode-charts-blue);
    transition: width 220ms ease;
  }
  .bar i.warn { background: var(--vscode-charts-yellow); }
  .bar i.crit { background: var(--vscode-charts-red); }
  .bar.dim i { opacity: .45; }
  .m.on .mk { color: var(--vscode-foreground); }

  .xtra {
    display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
    margin-top: 10px; padding-top: 8px;
    border-top: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .xtra b { font-weight: 600; color: var(--vscode-foreground); font-variant-numeric: tabular-nums; }
  .xtra .of { font-weight: 400; color: var(--vscode-descriptionForeground); }
  .none { margin-top: 8px; color: var(--vscode-descriptionForeground); }

  /* Actions appear on hover: at rest the card shows data only. They stay reachable
     from the keyboard (:focus-within) and on touch screens. */
  .acts {
    display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
    margin-top: 10px; opacity: .0;
    transition: opacity 160ms ease;
  }
  .card:hover .acts, .card:focus-within .acts, .acts.always { opacity: 1; }
  @media (hover: none) { .acts { opacity: 1; } }

  button {
    font: inherit; font-size: 11.5px; line-height: 1;
    padding: 5px 9px; border: 1px solid transparent; border-radius: 4px;
    cursor: pointer; color: var(--vscode-foreground); background: transparent;
    transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease;
  }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
  }
  button.pri, button.use {
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button.pri:hover, button.use:hover { background: var(--vscode-button-hoverBackground); }
  button.use { flex: none; padding: 3px 8px; font-size: 11px; }
  button.ico {
    display: inline-flex; align-items: center; justify-content: center;
    margin-left: auto; padding: 5px 6px;
    color: var(--vscode-descriptionForeground);
  }
  button.ico:hover { color: var(--vscode-foreground); }

  .foot {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 4px 1px 8px; color: var(--vscode-descriptionForeground); font-size: 11px;
  }
  /* Where the session runs is context for every card below it, not a per-account
     property: one row at the top, above them all. */
  .dir {
    display: flex; align-items: baseline; gap: 6px;
    margin: 0 1px 9px; padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .dk { flex: none; }
  .dv {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vscode-foreground);
  }
  .dir button.ico { margin: -4px 0; }

  .add { width: 100%; margin: 2px 0 6px; padding: 6px; border: 1px dashed var(--vscode-panel-border); }
  .add:hover { border-color: var(--vscode-focusBorder); border-style: solid; }
  .empty { color: var(--vscode-descriptionForeground); line-height: 1.6; }
  .empty b { display: block; color: var(--vscode-foreground); margin-bottom: 4px; }
  code {
    font-family: var(--vscode-editor-font-family);
    font-size: 11px; padding: 1px 4px; border-radius: 3px;
    background: var(--vscode-textCodeBlock-background);
  }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
</style></head><body>
<div class="dir">
  <span class="dk">Starts in</span>
  <span class="dv" title="${esc(sessionCwd || projectPath)}">${esc(path.basename(sessionCwd || projectPath))}</span>
  <button class="ico" data-a="folder" title="Change the folder the session starts in"
    aria-label="Change the folder the session starts in">${ICON.folder}</button>
</div>
${cards}
<button class="add" data-a="new">+ New account</button>
${foot ? `<div class="foot"><span>${esc(foot)}</span>
  <button class="ico" data-a="live" title="Refresh from the API" aria-label="Refresh usage">${ICON.refresh}</button>
</div>` : ''}
<script nonce="${nonce}">
  const vs = acquireVsCodeApi();
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) vs.postMessage({ action: b.dataset.a, name: b.dataset.n });
  });
</script></body></html>`;
}

class AccountsViewProvider {
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((m) => handleAction(m));
    // Rebuilding the panel while it is hidden is wasted work: Claude rewrites
    // .claude.json often and every write wakes the watchers.
    view.onDidChangeVisibility(() => {
      autoLive(view.visible);
      if (view.visible) {
        this.render();
        // coming back to the panel, the data may have aged while it was closed
        if (usageStale()) refreshAll(true);
      }
    });
    view.onDidDispose(() => autoLive(false));
    this.render();
    // first real data on open: the cache is almost always days old
    refreshAll(true);
    autoLive(true);
  }

  render() {
    if (!this.view || !this.view.visible) return;
    this.view.webview.html = panelHtml(
      this.view.webview,
      usageCache,
      state?.account,
      state?.path || windowPath(),
      state?.cwd
    );
  }
}

async function handleAction(m) {
  const p = windowPath();
  switch (m.action) {
    case 'live':
      return refreshAll(true);
    case 'new':
      return createAccount();
    case 'use':
      await runCli(['use', m.name, p]);
      pendingSwitch = true;
      await refresh();
      return offerNewConversation();
    case 'login':
    case 'relogin':
      return openLogin(m.name);
    case 'logout':
      return doLogout(m.name);
    case 'folder':
      return chooseFolder();
    case 'more':
      return moreActions(m.name);
  }
}

async function moreActions(name) {
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(edit) Rename…', detail: 'Moves the slot; requires logging in again', action: 'rename' },
      { label: '$(trash) Delete', detail: 'Removes the slot, credentials and overrides. Irreversible', action: 'delete' },
    ],
    { title: `Account "${name}"` }
  );
  if (picked?.action === 'rename') return doRename(name);
  if (picked?.action === 'delete') return doDelete(name);
}

// The CLI writes the login line: no paths are built here.
async function openLogin(name) {
  const cmd = await runCli(['login-cmd', name]);
  if (!cmd) {
    vscode.window.showErrorMessage(`No login line available for "${name}".`);
    return;
  }
  const term = vscode.window.createTerminal({ name: `claude login: ${name}` });
  term.show();
  term.sendText(cmd.trim());
}

async function doLogout(name) {
  // Worse than deleting: the dir stays, so resolution keeps picking it and the next
  // conversation walks into an auth prompt mid-work.
  const warn =
    name === state?.account
      ? `\n\nThis is the account in use in this window: the next conversation will ask for a login.`
      : '';
  const ok = await vscode.window.showWarningMessage(
    `Log "${name}" out?${warn}`,
    { modal: true },
    'Log out'
  );
  if (!ok) return;

  const out = await runCli(['logout', name]);
  if (out === null) {
    vscode.window.showErrorMessage(`Could not log "${name}" out.`);
    return;
  }
  await refreshAll();
}

async function doRename(name) {
  const to = await vscode.window.showInputBox({
    title: `Rename "${name}"`,
    prompt: 'Credentials are tied to the path: after renaming you have to log in again.',
    value: name,
    validateInput: (v) =>
      !/^[A-Za-z0-9._-]+$/.test(v || '')
        ? 'Letters, numbers, dot, dash and underscore only.'
        : v === name
        ? 'That is the same name.'
        : v === 'default'
        ? "'default' is reserved."
        : null,
  });
  if (!to) return;

  const out = await runCli(['rename', name, to]);
  if (out === null) {
    vscode.window.showErrorMessage(`Could not rename "${name}".`);
    return;
  }
  await refreshAll();
  const choice = await vscode.window.showWarningMessage(
    `"${name}" is now "${to}". The credentials were tied to the old path: you have to log in again.`,
    'Log in'
  );
  if (choice) return openLogin(to);
}

async function doDelete(name) {
  const warn =
    name === state?.account ? `\n\nThis is the account in use in this window.` : '';
  const ok = await vscode.window.showWarningMessage(
    `Delete "${name}"?${warn}\n\nThis removes the slot, its Keychain credentials and the overrides using it. There is no going back.`,
    { modal: true },
    'Delete'
  );
  if (!ok) return;

  let out = await runCli(['rm', name]);
  if (out === null) {
    // The most likely refusal: config copied instead of symlinked. Those files are
    // unique and the CLI will not throw them away without an explicit yes.
    const forced = await vscode.window.showWarningMessage(
      `"${name}" holds copied config (not symlinks) that would be lost. Delete anyway?`,
      { modal: true },
      'Delete anyway'
    );
    if (!forced) return;
    out = await runCli(['rm', name, '--force']);
    if (out === null) {
      vscode.window.showErrorMessage(`Could not delete "${name}".`);
      return;
    }
  }

  // Open conversations still hold the old CLAUDE_CONFIG_DIR, which now points at a
  // directory that no longer exists.
  if (name === state?.account) pendingSwitch = true;
  await refreshAll();
  vscode.window.showInformationMessage(out.trim().split('\n')[0]);
}

let bumpTimer = null;
let liveTimer = null;

function autoLive(on) {
  clearInterval(liveTimer);
  liveTimer = null;
  if (!on || !usageLiveEnabled()) return;
  const min = vscode.workspace
    .getConfiguration('claudeAccount')
    .get('usageRefreshMinutes', 10);
  if (min <= 0) return;
  liveTimer = setInterval(() => {
    if (panel?.view?.visible) refreshAll(true);
  }, Math.max(1, min) * 60000);
}

function bump() {
  clearTimeout(bumpTimer);
  bumpTimer = setTimeout(() => refreshAll(false), 500);
}

let refreshing = false;

// Claude Code rewrites .claude.json constantly (measured: as often as every few
// seconds), and every write wakes the watchers. Without this merge a cached refresh
// would overwrite data just fetched from the API with the file's older values,
// "expiring" the live reading seconds after taking it.
function mergeUsage(fresh, prev) {
  return fresh.map((r) => {
    if (r.live === '1') return r;
    const old = prev.find((o) => o.name === r.name);
    if (!old || old.live !== '1') return r;
    // cached data is newer than live only if Claude really did refresh the field:
    // in that case it wins
    if (Number(r.fetched_at_ms) > Number(old.fetched_at_ms)) return r;
    return { ...old, logged_in: r.logged_in, email: r.email || old.email };
  });
}

async function refreshAll(live) {
  if (live && refreshing) return;
  if (live) {
    refreshing = true;
    if (panel?.view) panel.view.description = 'refreshing…';
  }
  try {
    const fresh = await getUsage(live);
    usageCache = live ? fresh : mergeUsage(fresh, usageCache);
  } finally {
    if (live) {
      refreshing = false;
      if (panel?.view) panel.view.description = undefined;
    }
  }
  await refresh();
  panel?.render();
}

// ---------------------------------------------------------------- switch

async function switchAccount() {
  const p = windowPath();
  const accounts = await listAccounts();

  if (!accounts.length) {
    vscode.window.showErrorMessage(
      `claude-account not reachable (tried: ${cliPath()}). Run ./install.sh or set claudeAccount.cliPath.`
    );
    return;
  }

  const current = state?.account;
  const items = accounts.map((a) => ({
    label: `${a.name === current ? '$(check) ' : '      '}${a.name}`,
    description: a.email || '⚠ never logged in',
    detail: a.configDir,
    account: a.name,
  }));

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  if (state?.source === 'override') {
    items.push({
      label: '$(discard) Use the project default',
      detail: 'Removes the manual choice and goes back to the configured rule',
      action: 'clear',
    });
  }
  items.push({
    label: '$(add) New account…',
    detail: 'Creates a slot and opens the login in the terminal',
    action: 'new',
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Code account for this project',
    placeHolder: path.basename(p),
  });
  if (!picked) return;

  if (picked.action === 'new') return createAccount();

  if (picked.action === 'clear') {
    await runCli(['clear', p]);
  } else {
    await runCli(['use', picked.account, p]);
  }

  pendingSwitch = true;
  await refresh();
  await offerNewConversation();
}

// Which folder Claude runs in decides whose CLAUDE.md, hooks, skills and commands
// apply. Only the workspace roots are offered: the session has to stay somewhere the
// window already has open.
async function chooseFolder() {
  const p = windowPath();

  if (!state) {
    vscode.window.showErrorMessage(
      `claude-account not reachable (tried: ${cliPath()}). Run ./install.sh or set claudeAccount.cliPath.`
    );
    return;
  }

  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    name: f.name,
    path: canonical(f.uri.fsPath),
  }));
  const pinned = state.cwd;

  // With a single root there is nothing to choose: saying so beats a quick pick
  // whose only entry is where the session already runs.
  if (folders.length < 2 && !pinned) {
    vscode.window.showInformationMessage(
      'The session already starts in the only folder of this window. ' +
        'Add a second folder to the workspace to choose between them.'
    );
    return;
  }

  const current = pinned || p;
  const items = folders.map((f) => ({
    label: `${f.path === current ? '$(check) ' : '      '}${f.name}`,
    description: f.path === p ? 'workspace root' : '',
    detail: f.path,
    folder: f.path,
  }));

  if (pinned) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: '$(discard) Back to the workspace root',
      detail: p,
      folder: p,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Folder the Claude session starts in',
    placeHolder: 'Its CLAUDE.md, hooks, skills and commands are the ones that apply',
  });
  if (!picked) return;

  // The root is the absence of a choice, not a choice pointing at itself: no file
  // left behind for the wrapper to read on every launch.
  if (picked.folder === p) await runCli(['clear-cwd', p]);
  else await runCli(['set-cwd', picked.folder, p]);

  pendingSwitch = true;
  await refresh();
  await offerNewConversation(
    `Sessions start in "${path.basename(state?.cwd || p)}". It applies from the next conversation.`
  );
}

async function createAccount() {
  const name = await vscode.window.showInputBox({
    title: 'New Claude Code account',
    prompt: 'Short slot name (e.g. work). It will create ~/.claude-accounts/<name>.',
    validateInput: (v) =>
      /^[A-Za-z0-9._-]+$/.test(v || '') ? null : 'Letters, numbers, dot, dash and underscore only.',
  });
  if (!name) return;

  const out = await runCli(['new', name]);
  if (out === null) {
    vscode.window.showErrorMessage(`Could not create the slot "${name}".`);
    return;
  }

  // Login is a browser OAuth flow: the user has to do it in a terminal.
  await openLogin(name);
  await refreshAll();

  vscode.window.showInformationMessage(
    `Slot "${name}" created. Finish the login in the terminal to use it.`
  );
}

async function offerNewConversation(message) {
  const choice = await vscode.window.showInformationMessage(
    message ?? `Account set to "${state?.account ?? '?'}". It applies from the next conversation.`,
    'Open a new conversation'
  );
  if (choice) {
    try {
      await vscode.commands.executeCommand(CLAUDE_NEW_CONVERSATION);
      pendingSwitch = false;
      await refresh();
    } catch {
      vscode.window.showWarningMessage(
        'Could not open a new conversation: do it by hand from the Claude Code panel.'
      );
    }
  }
}

// ---------------------------------------------------------------- activation

async function setupWatchers(context) {
  watchers.forEach((w) => w.dispose());
  watchers = [];

  const conf =
    process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, 'claude-account')
      : path.join(os.homedir(), '.config', 'claude-account');

  // The choice can change from another window or from a terminal: the label has to
  // stay true regardless, not only when this window is the one changing it.
  const targets = [
    new vscode.RelativePattern(vscode.Uri.file(conf), '{accounts,overrides/**,cwd/**}'),
    new vscode.RelativePattern(vscode.Uri.file(os.homedir()), '.claude.json'),
    new vscode.RelativePattern(vscode.Uri.file(path.join(os.homedir(), '.claude-accounts')), '*/.claude.json'),
    new vscode.RelativePattern(vscode.Uri.file(path.join(os.homedir(), '.claude-accounts')), '*'),
  ];

  for (const pattern of targets) {
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    w.onDidCreate(() => bump());
    w.onDidChange(() => bump());
    w.onDidDelete(() => bump());
    watchers.push(w);
    context.subscriptions.push(w);
  }
}

function activate(context) {
  const priority = vscode.workspace
    .getConfiguration('claudeAccount')
    .get('statusBarPriority', 99);

  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
  item.command = 'claudeAccount.switch';
  context.subscriptions.push(item);

  panel = new AccountsViewProvider();

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAccount.switch', switchAccount),
    vscode.commands.registerCommand('claudeAccount.setFolder', chooseFolder),
    vscode.commands.registerCommand('claudeAccount.refresh', () => refreshAll(true)),
    vscode.commands.registerCommand('claudeAccount.showPanel', () =>
      vscode.commands.executeCommand('claudeAccounts.panel.focus')
    ),
    vscode.window.registerWebviewViewProvider('claudeAccounts.panel', panel),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refreshAll(false)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeAccount')) refreshAll(false);
    })
  );

  setupWatchers(context);
  refreshAll(false);
}

function deactivate() {
  clearTimeout(bumpTimer);
  clearInterval(liveTimer);
  watchers.forEach((w) => w.dispose());
}

module.exports = { activate, deactivate };
