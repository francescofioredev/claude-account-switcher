// Solo UI: la verità su "quale account per quale progetto" sta nella CLI
// `claude-account`, la stessa che consulta il wrapper allo spawn di Claude.
// Per questo l'override è un file su disco e non stato interno: a leggerlo
// dev'essere una /bin/sh, nel momento in cui Claude parte.

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_NEW_CONVERSATION = 'claude-vscode.newConversation';

let item;                 // StatusBarItem
let state = null;         // ultimo risultato di `claude-account status`
let pendingSwitch = false; // switch fatto ma nessuna nuova conversazione ancora aperta
let watchers = [];
let panel = null;         // AccountsViewProvider, se la view è stata creata
let usageCache = [];      // ultimo `claude-account usage --porcelain`

// ---------------------------------------------------------------- CLI

function cliPath() {
  const configured = vscode.workspace.getConfiguration('claudeAccount').get('cliPath');
  if (configured) return configured;
  // VS Code lanciato dal Dock ha un PATH ridotto e spesso non vede ~/.local/bin:
  // si prova il percorso di installazione standard prima di affidarsi al PATH.
  const local = path.join(os.homedir(), '.local', 'bin', 'claude-account');
  if (fs.existsSync(local)) return local;
  return 'claude-account';
}

function runCli(args, timeout) {
  return new Promise((resolve) => {
    cp.execFile(cliPath(), args, { timeout: timeout || 5000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function parseKeyValue(out) {
  const o = {};
  for (const line of (out || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return o;
}

// ---------------------------------------------------------------- finestra

// Deve coincidere con il cwd che l'estensione Claude Code usa per lanciare il
// processo: realpathSync(workspaceFolders[0] ?? homedir()).normalize('NFC').
// In un workspace multi-root è la PRIMA cartella del .code-workspace; se qui si
// calcolasse altro, la status bar mostrerebbe un account diverso da quello in uso.
function windowPath() {
  const first = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    return fs.realpathSync(first ?? os.homedir()).normalize('NFC');
  } catch {
    return (first ?? os.homedir()).normalize('NFC');
  }
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
  override: 'scelto a mano per questo progetto',
  marker: 'file .claude-account nel progetto',
  table: 'regola in ~/.config/claude-account/accounts',
  default: 'nessuna regola: account di default',
};

// ---------------------------------------------------------------- usage

async function getUsage(live) {
  const out = live
    ? await runCli(['usage', '--live', '--porcelain'], 30000)
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

// I consumi li aggiorna Claude Code quando gira su quell'account: un numero senza
// la sua età è indistinguibile da uno vecchio di giorni, quindi va sempre datato.
function formatAge(ms) {
  if (!ms) return null;
  const min = Math.floor((Date.now() - Number(ms)) / 60000);
  if (min < 1) return 'adesso';
  if (min < 60) return `${min} min fa`;
  if (min < 1440) return `${Math.floor(min / 60)}h fa`;
  const d = Math.floor(min / 1440);
  return d === 1 ? 'ieri' : `${d} giorni fa`;
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
    return new Intl.NumberFormat('it-IT', {
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
      `**claude-account non raggiungibile**\n\n` +
        `Provato: \`${cliPath()}\`\n\n` +
        `Installa il repo (\`./install.sh\`) oppure imposta \`claudeAccount.cliPath\`.\n\n` +
        `_Claude Code continua a funzionare sull'account di default._`
    );
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.show();
    return;
  }

  state = parseKeyValue(out);

  const label = state.email || (state.account === 'default' ? 'default' : state.account);
  item.text = `${pendingSwitch ? '$(warning)' : '$(account)'} ${label}`;

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Account Claude Code di questa finestra**\n\n`);
  md.appendMarkdown(`- Account: \`${state.account}\`\n`);
  md.appendMarkdown(`- Login: ${state.email || '_mai fatto — Claude lo chiederà_'}\n`);
  md.appendMarkdown(`- Perché: ${SOURCE_LABEL[state.source] || state.source}\n`);
  md.appendMarkdown(`- Config dir: \`${state.config_dir}\`\n`);
  md.appendMarkdown(`- Progetto: \`${state.path}\`\n`);

  if (vscode.workspace.getConfiguration('claudeAccount').get('usageInTooltip', true)) {
    const u = usageCache.find((r) => r.name === state.account);
    const five = u && pct(u.five_hour_pct);
    const seven = u && pct(u.seven_day_pct);
    if (five != null || seven != null) {
      const age = formatAge(Number(u.fetched_at_ms));
      md.appendMarkdown(
        `- Consumi: ${five != null ? `5h ${five}%` : '—'} · ` +
          `${seven != null ? `7g ${seven}%` : '—'}${age ? ` · ${age}` : ''}\n`
      );
    }
  }

  if (pendingSwitch) {
    md.appendMarkdown(
      `\n---\n\n⚠️ Le conversazioni **già aperte** girano ancora sull'account precedente: ` +
        `il cambio vale da quella successiva.\n`
    );
  }
  md.appendMarkdown(
    `\n_Clicca per cambiare account._ · [Pannello](command:claudeAccount.showPanel)`
  );
  md.isTrusted = true;
  md.supportThemeIcons = true;
  item.tooltip = md;
  item.backgroundColor = pendingSwitch
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  item.show();
}

// ---------------------------------------------------------------- pannello

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
};

// Le percentuali di quota non sono un "quanto manca" lineare: sotto il 50% la
// differenza non interessa, sopra l'80% conta ogni punto. Il colore cambia solo lì.
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
    body = `<div class="none">Mai loggato</div>
      <div class="acts always"><button class="pri" data-a="login" data-n="${n}">Fai il login</button></div>`;
  } else {
    const five = pct(u.five_hour_pct);
    const seven = pct(u.seven_day_pct);
    const spend = formatMoney(u.spend_used_minor, u.spend_exponent, u.spend_currency);
    const cap = formatMoney(u.spend_limit_minor, u.spend_exponent, u.spend_currency);
    const meters =
      meter('Sessione', five, u.five_hour_resets_at, veryStale, u.active_limit === 'session') +
      meter('Settimana', seven, u.seven_day_resets_at, veryStale, u.active_limit === 'weekly_all');

    body =
      (meters || '<div class="none">Nessun dato di consumo</div>') +
      (u.extra_enabled === '1' && spend
        ? `<div class="xtra"><span>Credito extra</span><b>${esc(spend)}${cap ? ` <span class="of">di ${esc(cap)}</span>` : ''}</b></div>`
        : '') +
      `<div class="acts">
         <button data-a="relogin" data-n="${n}">Rifai login</button>
         <button data-a="logout" data-n="${n}">Disconnetti</button>
         ${u.name === 'default' ? '' : `<button class="ico" data-a="more" data-n="${n}" title="Rinomina o elimina" aria-label="Altre azioni per ${n}">${ICON.more}</button>`}
       </div>`;
  }

  const tier = TIER_LABEL[u.tier] || u.tier || '';
  return `<div class="card${isCurrent ? ' cur' : ''}">
    <div class="hd">
      <span class="nm">${n}</span>
      ${isCurrent
        ? '<span class="tag">attivo</span>'
        : `<button class="use" data-a="use" data-n="${n}">Usa qui</button>`}
    </div>
    ${u.email ? `<div class="em" title="${esc(u.email)}">${esc(u.email)}${tier ? ` <span class="tier">${esc(tier)}</span>` : ''}</div>` : ''}
    ${body}
  </div>`;
}

function panelHtml(webview, records, current, projectPath) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const cards = records.length
    ? records.map((u) => card(u, current)).join('')
    : `<div class="empty"><b>claude-account non raggiungibile</b>
         Esegui <code>./install.sh</code> oppure imposta <code>claudeAccount.cliPath</code>.</div>`;

  // La freschezza è una proprietà della fetch, non del singolo account: una riga
  // sola in fondo invece della stessa frase ripetuta su ogni card.
  const withData = records.filter((r) => r.fetched_at_ms);
  // Il footer parla del dato PIÙ VECCHIO: con freschezze miste, dire "aggiornato
  // adesso" perché una card lo è nasconderebbe quella ferma a giorni fa.
  const allLive = withData.length > 0 && withData.every((r) => r.live === '1');
  const oldest = withData.length ? Math.min(...withData.map((r) => Number(r.fetched_at_ms))) : 0;
  const stale = oldest ? Date.now() - oldest > staleAfterMs() : false;
  const foot = !withData.length
    ? ''
    : allLive
    ? 'Aggiornato adesso'
    : `${stale ? '⚠ ' : ''}Dati di ${formatAge(oldest)}`;

  return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8">
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
  /* L'account attivo si distingue per una barra laterale, non per un bordo pieno:
     resta leggibile anche quando la card è in hover. */
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
  /* Il numero è il dato: prende il peso, la barra lo accompagna. */
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

  /* Le azioni compaiono in hover: a riposo la card mostra solo dati.
     Restano sempre visibili da tastiera (:focus-within) e su schermi touch. */
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
${cards}
<button class="add" data-a="new">+ Nuovo account</button>
${foot ? `<div class="foot"><span>${esc(foot)}</span>
  <button class="ico" data-a="live" title="Aggiorna dall'API" aria-label="Aggiorna i consumi">${ICON.refresh}</button>
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
    // Ricostruire il pannello mentre è nascosto è lavoro buttato: Claude riscrive
    // .claude.json di frequente e ogni write sveglia i watcher.
    view.onDidChangeVisibility(() => {
      autoLive(view.visible);
      if (view.visible) {
        this.render();
        // rientrando sul pannello il dato può essere invecchiato mentre era chiuso
        if (usageStale()) refreshAll(true);
      }
    });
    view.onDidDispose(() => autoLive(false));
    this.render();
    // primo dato vero all'apertura: la cache è quasi sempre di giorni fa
    refreshAll(true);
    autoLive(true);
  }

  render() {
    if (!this.view || !this.view.visible) return;
    this.view.webview.html = panelHtml(
      this.view.webview,
      usageCache,
      state?.account,
      state?.path || windowPath()
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
    case 'more':
      return moreActions(m.name);
  }
}

async function moreActions(name) {
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(edit) Rinomina…', detail: 'Sposta lo slot; richiede un nuovo login', action: 'rename' },
      { label: '$(trash) Elimina', detail: 'Rimuove slot, credenziali e override. Irreversibile', action: 'delete' },
    ],
    { title: `Account "${name}"` }
  );
  if (picked?.action === 'rename') return doRename(name);
  if (picked?.action === 'delete') return doDelete(name);
}

// La riga di login la scrive la CLI: qui non si costruiscono percorsi.
async function openLogin(name) {
  const cmd = await runCli(['login-cmd', name]);
  if (!cmd) {
    vscode.window.showErrorMessage(`Non ho la riga di login per "${name}".`);
    return;
  }
  const term = vscode.window.createTerminal({ name: `claude login: ${name}` });
  term.show();
  term.sendText(cmd.trim());
}

async function doLogout(name) {
  // Peggio dell'eliminazione: la dir resta, quindi la risoluzione continua a
  // sceglierlo e la conversazione dopo sbatte su un prompt di auth a metà lavoro.
  const warn =
    name === state?.account
      ? `\n\nÈ l'account in uso in questa finestra: la prossima conversazione chiederà il login.`
      : '';
  const ok = await vscode.window.showWarningMessage(
    `Disconnettere "${name}"?${warn}`,
    { modal: true },
    'Disconnetti'
  );
  if (!ok) return;

  const out = await runCli(['logout', name]);
  if (out === null) {
    vscode.window.showErrorMessage(`Logout di "${name}" non riuscito.`);
    return;
  }
  await refreshAll();
}

async function doRename(name) {
  const to = await vscode.window.showInputBox({
    title: `Rinomina "${name}"`,
    prompt: 'Le credenziali sono legate al percorso: dopo la rinomina serve un nuovo login.',
    value: name,
    validateInput: (v) =>
      !/^[A-Za-z0-9._-]+$/.test(v || '')
        ? 'Solo lettere, numeri, punto, trattino e underscore.'
        : v === name
        ? 'È lo stesso nome.'
        : v === 'default'
        ? "'default' è riservato."
        : null,
  });
  if (!to) return;

  const out = await runCli(['rename', name, to]);
  if (out === null) {
    vscode.window.showErrorMessage(`Non sono riuscito a rinominare "${name}".`);
    return;
  }
  await refreshAll();
  const choice = await vscode.window.showWarningMessage(
    `"${name}" è ora "${to}". Le credenziali erano legate al vecchio percorso: serve un nuovo login.`,
    'Fai il login'
  );
  if (choice) return openLogin(to);
}

async function doDelete(name) {
  const warn =
    name === state?.account ? `\n\nÈ l'account in uso in questa finestra.` : '';
  const ok = await vscode.window.showWarningMessage(
    `Eliminare "${name}"?${warn}\n\nVengono rimossi lo slot, le credenziali nel Keychain e gli override che lo usano. Non si torna indietro.`,
    { modal: true },
    'Elimina'
  );
  if (!ok) return;

  let out = await runCli(['rm', name]);
  if (out === null) {
    // Il rifiuto più probabile: config copiata invece che symlinkata, quei file
    // sono unici e la CLI non li butta senza un sì esplicito.
    const forced = await vscode.window.showWarningMessage(
      `"${name}" contiene config copiata (non symlink) che andrebbe persa. Eliminare comunque?`,
      { modal: true },
      'Elimina comunque'
    );
    if (!forced) return;
    out = await runCli(['rm', name, '--force']);
    if (out === null) {
      vscode.window.showErrorMessage(`Eliminazione di "${name}" non riuscita.`);
      return;
    }
  }

  // Le conversazioni aperte tengono ancora la vecchia CLAUDE_CONFIG_DIR, che ora
  // punta a una dir che non c'è più.
  if (name === state?.account) pendingSwitch = true;
  await refreshAll();
  vscode.window.showInformationMessage(out.trim().split('\n')[0]);
}

let bumpTimer = null;
let liveTimer = null;

function autoLive(on) {
  clearInterval(liveTimer);
  liveTimer = null;
  if (!on) return;
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

// Claude Code riscrive .claude.json in continuazione (misurato: anche ogni pochi
// secondi), e ogni scrittura sveglia i watcher. Senza questo merge un refresh da
// cache sovrascriverebbe i dati appena presi dall'API con quelli vecchi del file,
// facendo "scadere" la lettura live pochi secondi dopo averla fatta.
function mergeUsage(fresh, prev) {
  return fresh.map((r) => {
    if (r.live === '1') return r;
    const old = prev.find((o) => o.name === r.name);
    if (!old || old.live !== '1') return r;
    // il dato in cache è più recente di quello live solo se Claude ha davvero
    // rinfrescato il campo: in quel caso vince lui
    if (Number(r.fetched_at_ms) > Number(old.fetched_at_ms)) return r;
    return { ...old, logged_in: r.logged_in, email: r.email || old.email };
  });
}

async function refreshAll(live) {
  if (live && refreshing) return;
  if (live) {
    refreshing = true;
    if (panel?.view) panel.view.description = 'aggiorno…';
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
      `claude-account non raggiungibile (provato: ${cliPath()}). Esegui ./install.sh o imposta claudeAccount.cliPath.`
    );
    return;
  }

  const current = state?.account;
  const items = accounts.map((a) => ({
    label: `${a.name === current ? '$(check) ' : '      '}${a.name}`,
    description: a.email || '⚠ mai loggato',
    detail: a.configDir,
    account: a.name,
  }));

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  if (state?.source === 'override') {
    items.push({
      label: '$(discard) Usa il default del progetto',
      detail: 'Rimuove la scelta manuale e torna alla regola configurata',
      action: 'clear',
    });
  }
  items.push({
    label: '$(add) Nuovo account…',
    detail: 'Crea uno slot e apri il login nel terminale',
    action: 'new',
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Account Claude Code per questo progetto',
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

async function createAccount() {
  const name = await vscode.window.showInputBox({
    title: 'Nuovo account Claude Code',
    prompt: 'Nome breve dello slot (es. lavoro). Verrà creato ~/.claude-accounts/<nome>.',
    validateInput: (v) =>
      /^[A-Za-z0-9._-]+$/.test(v || '') ? null : 'Solo lettere, numeri, punto, trattino e underscore.',
  });
  if (!name) return;

  const out = await runCli(['new', name]);
  if (out === null) {
    vscode.window.showErrorMessage(`Non sono riuscito a creare lo slot "${name}".`);
    return;
  }

  // Il login è un flusso OAuth nel browser: va fatto dall'utente in un terminale.
  await openLogin(name);
  await refreshAll();

  vscode.window.showInformationMessage(
    `Slot "${name}" creato. Completa il login nel terminale per usarlo.`
  );
}

async function offerNewConversation() {
  const choice = await vscode.window.showInformationMessage(
    `Account impostato su "${state?.account ?? '?'}". Vale dalla prossima conversazione.`,
    'Apri una nuova conversazione'
  );
  if (choice) {
    try {
      await vscode.commands.executeCommand(CLAUDE_NEW_CONVERSATION);
      pendingSwitch = false;
      await refresh();
    } catch {
      vscode.window.showWarningMessage(
        "Non sono riuscito ad aprire una nuova conversazione: fallo a mano dal pannello di Claude Code."
      );
    }
  }
}

// ---------------------------------------------------------------- attivazione

async function setupWatchers(context) {
  watchers.forEach((w) => w.dispose());
  watchers = [];

  const conf =
    process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, 'claude-account')
      : path.join(os.homedir(), '.config', 'claude-account');

  // La scelta può cambiare da un'altra finestra o da terminale: la label deve
  // restare vera comunque, non solo quando è questa finestra a cambiarla.
  const targets = [
    new vscode.RelativePattern(vscode.Uri.file(conf), '{accounts,overrides/**}'),
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
