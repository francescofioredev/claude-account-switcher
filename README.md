# claude-account-switcher

Un account Claude Code diverso per ogni progetto, scelto automaticamente in base alla cartella che apri —
e visibile nella status bar di VS Code, come il branch git.

Claude Code tiene **un solo login per macchina**: `/logout` + `/login` cambia l'account ovunque, e non esiste
un'impostazione di account per workspace. Se lavori su due progetti con due account diversi (personale e
lavoro, due clienti, due organizzazioni) l'unica alternativa è rifare il login ogni volta.

## Come funziona

Claude Code isola credenziali e stato per `CLAUDE_CONFIG_DIR`. Su macOS le credenziali stanno nel Keychain, ma
il **nome del servizio dipende dalla config dir**:

| `CLAUDE_CONFIG_DIR` | servizio Keychain |
|---|---|
| non impostata | `Claude Code-credentials` |
| impostata | `Claude Code-credentials-<sha256(dir)[0:8]>` |

Quindi più account possono restare **loggati insieme**, senza logout/login quando cambi progetto.

Resta il problema di impostare quella variabile in modo diverso per ogni progetto. In VS Code non si può fare
con le impostazioni di workspace: `claudeCode.environmentVariables` e `claudeCode.claudeProcessWrapper` sono
dichiarate `"scope": "machine"`, e VS Code ignora i valori machine-scoped messi in `.vscode/settings.json`.

La soluzione è `claudeCode.claudeProcessWrapper`: un wrapper che l'estensione ufficiale invoca come
`<wrapper> <binario-claude> <args...>`, e che quindi può **decidere a runtime dalla cartella corrente**. È
anche l'unico punto che risolve per-finestra: due finestre su due progetti diversi restano ognuna sul proprio
account.

## Installazione

```sh
git clone <questo-repo> ~/Coding/claude-account-switcher
cd ~/Coding/claude-account-switcher
./install.sh
```

`install.sh` fa symlink dei due eseguibili in `~/.local/bin` e crea `~/.config/claude-account/`. Poi seguine
le due istruzioni finali: il setting di VS Code e la riga per la shell.

Il repo deve restare dov'è (l'installazione è a symlink, così `git pull` aggiorna tutto).

## Uso

Creare un account e fare il login:

```sh
claude-account new lavoro
CLAUDE_CONFIG_DIR=$HOME/.claude-accounts/lavoro claude auth login
```

Mappare i progetti, in `~/.config/claude-account/accounts` — una riga per regola, vince il primo match:

```
lavoro   ~/Coding/acme
```

Da qui in poi ogni sessione Claude aperta sotto `~/Coding/acme` usa l'account `lavoro`, tutto il resto usa
quello di default. Per controllare:

```sh
claude-account list                      # chi è loggato in quale slot
claude-account status ~/Coding/acme/api  # account, config dir, e perché
claude-account usage                     # consumi dalla cache locale
claude-account usage --live              # consumi veri, chiesti all'API
```

### Gestire gli account

```sh
claude-account login-cmd lavoro      # stampa la riga di login di quello slot
claude-account logout lavoro         # disconnette e rimuove le credenziali
claude-account rename lavoro ufficio # sposta lo slot (richiede un nuovo login)
claude-account rm lavoro             # elimina slot, credenziali e override
```

`rm` rimuove anche la voce del Keychain e gli override che puntavano a quell'account; se la
tabella `accounts` lo cita ancora te lo dice, senza toccarla (è scritta a mano). Se dentro lo
slot trova config **copiata** invece che symlinkata si ferma: quei file sono unici, e li
cancella solo con `--force`.

### I tre livelli di precedenza

1. **override** — `claude-account use <nome> [path]`, quello che scrive la status bar. `claude-account clear`
   lo rimuove.
2. **`.claude-account`** — un file nel repo con dentro il nome dell'account, versionabile: dichiara l'intento
   una volta per tutto il team.
3. **`accounts`** — la tabella dei prefissi di path.

`default` è un nome di account valido a tutti i livelli, e vale "l'account in `~/.claude`": serve per
riportare al default una sottocartella di un albero mappato altrove.

## Cosa condividono gli account

`claude-account new` non crea uno slot vuoto: fa symlink da `~/.claude` di skill, agent, comandi, plugin,
hook, `settings.json` e `CLAUDE.md`, così il tuo tooling è lo stesso ovunque. Symlinka anche `projects/`, che
è dove vivono memory e cronologia delle conversazioni: puoi spostare un progetto da un account all'altro senza
perdere `--continue` né le memory.

Restano separati per account: `.claude.json` (identità, stato dei progetti, MCP user-scoped), `sessions/`,
`history.jsonl`, `cache/` e le altre directory volatili.

Se un account deve avere un confine di riservatezza, togli `projects` da `SHARED` in `bin/claude-account`: i
transcript smettono di essere condivisi, al prezzo di perdere memory e `--continue` quando sposti un progetto.

## Estensione VS Code

In `extension/`. Mostra l'account attivo nella status bar e permette di cambiarlo con un click; il tooltip
dice anche **perché** quell'account è attivo (override, marker file, tabella o default).

Nella Activity Bar c'è un pannello con una card per account: consumi delle ultime 5 ore e dei 7
giorni, quando si azzerano, credito extra se attivo, e i pulsanti per rifare il login,
disconnettere, rinominare ed eliminare. I consumi si aggiornano all'apertura e con ⟳.

```sh
cd extension
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension claude-account-switcher-*.vsix
```

L'estensione non duplica la logica di risoluzione: interroga `claude-account`, la stessa CLI che consulta il
wrapper. Se non la trova, lo dice nel tooltip e Claude Code continua a funzionare sull'account di default.

| Setting | Default | A cosa serve |
|---|---|---|
| `claudeAccount.cliPath` | vuoto | Percorso di `claude-account`. Vuoto = prova `~/.local/bin/claude-account`, poi il PATH. Serve perché VS Code lanciato dal Dock ha un PATH ridotto. |
| `claudeAccount.statusBarPriority` | `99` | Posizione nella status bar: più alto, più a sinistra. |
| `claudeAccount.usageStaleAfterMinutes` | `360` | Dopo quanti minuti i consumi vengono segnalati come vecchi. |
| `claudeAccount.usageInTooltip` | `true` | Riga di consumi nel tooltip della status bar. |

### Da dove vengono i consumi

Da `GET /api/oauth/usage`, lo stesso endpoint che chiama Claude Code, autenticato con il token
OAuth di quell'account letto dal Keychain. È l'unico modo per avere numeri veri: in
`.claude.json` c'è un `cachedUsageUtilization`, ma Claude Code lo rinfresca di rado — misurato
su questa macchina, il file veniva riscritto ogni 3 minuti con il campo fermo da 15 ore, e i
valori in cache (14%) erano il quadruplo di quelli reali (3%).

La chiamata parte **solo su richiesta**: all'apertura del pannello e quando premi ⟳. I refresh
automatici dai watcher usano la cache, così non c'è traffico di rete né rischio di prompt del
Keychain a ogni scrittura di `.claude.json`. Ogni card dice se il dato è live o in cache.

Se la chiamata fallisce — token illeggibile, rete giù, endpoint cambiato — si ricade sulla
cache, etichettata come tale. Nessun errore bloccante.

⚠️ `/api/oauth/usage` **non è documentato**: un aggiornamento di Claude Code può cambiarlo o
rimuoverlo, e in quel caso restano i valori in cache finché non si aggiorna questo repo.

Serve `curl` (di sistema) più `jq` (di sistema su macOS 15+) oppure `node` come ripiego. Se
mancano i parser il pannello resta senza barre e tutto il resto continua a funzionare.

## Da sapere

- **Il cambio account vale dalla conversazione successiva.** Il wrapper viene eseguito allo spawn del processo
  Claude: una conversazione già aperta continua sull'account con cui è partita.
- **Non spostare a mano una config dir dopo il login.** La chiave del Keychain è l'hash del path:
  cambiandolo l'account risulta sloggato e le vecchie credenziali restano orfane. Per rinominare usa
  `claude-account rename`, che pulisce le credenziali vecchie e ti dice di rifare il login.
- **`CLAUDE_CONFIG_DIR` impostata al valore di default non equivale a non impostarla**, sempre per lo stesso
  motivo. Per questo il wrapper fa `unset` invece di impostarla.
- **MCP e connettori sono per account.** Gli MCP user-scoped e i connettori claude.ai vanno riautorizzati sul
  nuovo account; gli MCP project-scoped (`.mcp.json` nel repo) funzionano ovunque.
- **Se `claude-account` manca o è rotto, Claude parte comunque** sull'account di default: il wrapper non
  fallisce mai di proposito.

## Portabilità

POSIX sh: macOS e Linux. Su Linux `CLAUDE_CONFIG_DIR` isola le credenziali via
`$CLAUDE_CONFIG_DIR/.credentials.json` invece del Keychain — meccanismo diverso, stesso risultato, ma non è
stato verificato direttamente. Windows non è supportato.

Verificato su macOS con Claude Code 2.1.199 (CLI) e 2.1.220 (estensione VS Code). Il meccanismo si appoggia a
`claudeCode.claudeProcessWrapper`, un setting pubblico dell'estensione, e a `CLAUDE_CONFIG_DIR`, documentata:
nessuna patch, nessun file dell'installazione di Claude viene toccato.
