// Claude Account Switcher — mostra e cambia l'account Claude Code della finestra.
//
// L'estensione è solo la UI: la verità su "quale account per quale progetto" sta
// nella CLI `claude-account`, la stessa che consulta il wrapper allo spawn del
// processo Claude. Qui non si duplica quella logica, la si interroga.
//
// Per lo stesso motivo l'override è un file su disco e non stato interno:
// a leggerlo dev'essere una /bin/sh, nel momento in cui Claude parte.

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

function runCli(args) {
  return new Promise((resolve) => {
    cp.execFile(cliPath(), args, { timeout: 5000 }, (err, stdout) => {
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
  if (pendingSwitch) {
    md.appendMarkdown(
      `\n---\n\n⚠️ Le conversazioni **già aperte** girano ancora sull'account precedente: ` +
        `il cambio vale da quella successiva.\n`
    );
  }
  md.appendMarkdown(`\n_Clicca per cambiare account._`);
  item.tooltip = md;
  item.backgroundColor = pendingSwitch
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  item.show();
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
  const dir = path.join(os.homedir(), '.claude-accounts', name);
  const term = vscode.window.createTerminal({ name: `claude login: ${name}` });
  term.show();
  term.sendText(`CLAUDE_CONFIG_DIR=${dir} claude auth login`);

  vscode.window.showInformationMessage(
    `Slot "${name}" creato. Completa il login nel terminale, poi riapri il selettore per usarlo.`
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
  ];

  for (const pattern of targets) {
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    w.onDidCreate(() => refresh());
    w.onDidChange(() => refresh());
    w.onDidDelete(() => refresh());
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

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAccount.switch', switchAccount),
    vscode.commands.registerCommand('claudeAccount.refresh', refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeAccount')) refresh();
    })
  );

  setupWatchers(context);
  refresh();
}

function deactivate() {
  watchers.forEach((w) => w.dispose());
}

module.exports = { activate, deactivate };
