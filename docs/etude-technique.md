# Étude technique — Réintroduire la todo-list dans OpenCode v2 et OpenChamber

> Document d'étude. Aucune implémentation n'est encore réalisée.
> Versions de référence observées sur la machine : **OpenCode 2.0.16**
> (binaire `~/.opencode/bin/opencode`), paquets npm `@opencode/plugin@2.0.26`,
> `@opencode/schema@2.0.26`, `@opencode/client@2.0.26`, **OpenChamber 2.2.0**
> (dépôt local `~/Documents/Projects/openchamber`, v1.24.2).

---

## 1. Objectif

Remettre à disposition, côté **OpenCode v2** et côté **OpenChamber** :

- des outils `todowrite` / `todoread` que le modèle peut appeler pour tenir une
  liste de tâches par session ;
- une **visibilité utilisateur** de cette liste (progression, statuts) ;
- si possible, une **injection dans le contexte** de l'agent afin que la liste
  survive à la compaction (régression la plus citée en v2).

Contrainte de conception : ne pas dépendre du core OpenCode, mais passer par
l'**API plugin v2** (supportée et stable) et par la **surface d'extension
OpenChamber**.

---

## 2. Pourquoi la fonctionnalité a disparu (rappel)

- Décision officielle (issue `anomalyco/opencode#42421`) : « we removed it
  because it slows agent down and we haven't noticed significant performance
  improvements from it's existence ». Issue d'abord fermée « not planned », puis
  **réouverte le 6 oct. 2026** : « We may add a way to re-enable them ».
- Historique : désactivation du todo pour les modèles non-Anthropic (2025),
  suppression de `todoread` en v1 (PR #19128), puis disparition totale en v2.
- Conséquence technique vérifiée sur 2.0.16 : ni `todowrite` ni `todoread` dans
  le registre d'outils, **aucun** endpoint `/api/todo`, **aucun** événement
  `todo.updated`.

---

## 3. État des lieux technique (vérifié localement)

### 3.1 Ce que v2 fournit encore

| Élément | État |
|---|---|
| Table SQLite `todo` | **Présente**, schéma v1 identique (voir §3.3) |
| Endpoint REST `/api/todo` | Absent |
| Événement `todo.updated` | Absent du schéma v2 |
| Outils natifs todo | Absents |
| API plugin v2 (`@opencode/plugin`) | Complète, dont `tool.transform`, hooks, RPC, storage |
| Endpoint `/api/rpc/{rpcID}/{method}` | **Présent** dans l'OpenAPI v2 |
| Événements RPC `rpc.<id>.<event>` | Transportés par le flux d'événements du serveur |

### 3.2 Le flux d'événements et les RPC

- Le serveur expose un flux d'événements (`/api/event`, `/api/experimental/session/{id}/log`).
- Un plugin peut publier des **événements RPC typés** ; leur type est
  `rpc.<id>.<event>` (`@opencode/schema/rpc`). Ils sont livrés aux clients
  externes abonnés au flux, avec `location`.
- Un plugin peut exposer des **méthodes RPC** appelables en HTTP via
  `/api/rpc/{rpcID}/{method}`.

C'est le point d'intégration clé : **pas besoin d'endpoint custom** pour faire
remonter les todos vers OpenChamber.

### 3.3 La table `todo` (schéma réel, lue dans `opencode.db`)

```sql
CREATE TABLE `todo` (
  `session_id`   text NOT NULL,
  `content`      text NOT NULL,
  `status`       text NOT NULL,   -- pending | in_progress | completed
  `priority`     text NOT NULL,   -- high | medium | low
  `position`     integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  CONSTRAINT `todo_pk` PRIMARY KEY(`session_id`, `position`),
  CONSTRAINT `fk_todo_session_id_session_id_fk`
    FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
CREATE INDEX `todo_session_idx` ON `todo` (`session_id`);
```

Cette table existe encore mais **n'est plus alimentée par aucun code v2**. Un
plugin n'a **pas** d'accès officiel à la base (pas d'API DB dans `ctx`).

---

## 4. L'API plugin v2 — briques utilisables

Paquet : `@opencode/plugin` (dernière : `2.0.26`). Point d'entrée principal :

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "todolist",
  async setup(ctx) {
    // enregistrements ici
    return () => { /* cleanup */ }
  },
})
```

Un plugin local est chargé automatiquement depuis `.opencode/plugins/`, ou
déclaré dans `opencode.jsonc` via `plugins: [...]`.

### 4.1 Outils (`ctx.tool`)

```ts
await ctx.tool.transform((editor) => {
  editor.add({
    name: "todowrite",
    description: "Create/update the session todo list",
    input: { /* JSON Schema ou Standard Schema (zod) */ },
    output: { /* optionnel */ },
    options: { /* namespace?, permission?, codemode? */ },
    execute: async (input, context) => {
      // context.signal, context.progress, context.sessionID, context.agent
      return { content: "…", metadata: { todos } }
    },
  })
})
```

**Forme exacte du type** (`@opencode/schema/tool`) :

```ts
interface Info {
  name: string
  input: ValueSchema
  description: string
  execute: (input, context) => Effect<Result, Error>
  output?: ValueSchema
  options?: Options
}
type Options = {
  namespace?: string
  permission?: string
} & ({ codemode?: true; pinned?: boolean } | { codemode: boolean; pinned?: never })
interface Result {
  output?: unknown
  content?: string | ReadonlyArray<Content>  // Content = {type:"text",text} | {type:"file",...}
  metadata?: Record<string, any>
}
```

Points importants :

- **`codemode`** : optionnel. Omis → l'outil est dans le **catalogue natif de
  chat** (visible par le modèle). `codemode: true` le place dans Code Mode.
  Pour `todowrite`/`todoread`, **omettre `codemode`** (ou `false`). La rumeur
  communautaire « codemode défaut = true » ne correspond pas au type 2.0.26.
- `namespace` : évite les collisions mais renomme en `ns_tool`. Pour garder les
  noms exacts `todowrite`/`todoread`, **ne pas** mettre de namespace.
- `permission` : nom d'action de permission (permet un `allow`/`deny` dédié).
- L'`execute` est **capturé par requête modèle** (snapshot stable). Il faut
  capturer les valeurs nécessaires dans le callback de transform.

### 4.2 Hooks

- **Injection de contexte** — le levier clé pour survivre à la compaction :

  ```ts
  await ctx.session.hook("context", (event) => {
    event.system.push({ type: "text", text: renderTodos(openTodos) })
    // ou event.messages
  })
  ```

  Le hook reçoit `sessionID`, `agent`, `model`, `messages`, `system`, `tools`,
  `options`. Il ne modifie que la requête sortante, pas l'historique.

- **Observation d'exécution d'outil** (utile pour la synchro/événements) :

  ```ts
  await ctx.tool.hook("execute.after", (event) => {
    // event.tool, event.sessionID, event.status, event.result | event.error
  })
  ```

### 4.3 RPC (transport vers OpenChamber)

```ts
import { Rpc } from "@opencode/plugin/rpc"

export const TodoRpc = Rpc.define({
  id: "todolist",
  methods: {
    list: { input: {...}, output: {...} },
    set:  { input: {...}, output: {...} },
  },
  events: {
    updated: { schema: { type: "object", properties: { sessionID:{type:"string"}, todos:{type:"array"} }, required:["sessionID","todos"] } },
  },
})

// dans setup :
const reg = await ctx.rpc.register(TodoRpc, {
  list: async ({ sessionID }) => ({ todos: await readTodos(sessionID) }),
  set:  async ({ sessionID, todos }) => { await writeTodos(sessionID, todos); return { todos } },
})
await reg.events.emit("updated", { sessionID, todos })
```

Côté client : `client.rpc(TodoRpc).list(...)` et
`client.rpc(TodoRpc).events.on("updated", …)` / `.subscribe("updated")`.

### 4.4 Stockage

`ctx.storage` est un **KV JSON durable, propre au plugin** (pas d'accès à la
table `todo`) :

```ts
await ctx.storage.set(`session/${sessionID}`, todos)
await ctx.storage.get(`session/${sessionID}`)
await ctx.storage.scan({ prefix: "session/" })
```

C'est la voie propre pour persister les todos **sans toucher à la DB du core**.

### 4.5 Événements serveur

`ctx.event.subscribe({ signal })` permet d'écouter le flux du serveur (ex.
`session.idle`, cycle de vie session) pour nettoyer/mettre à jour.

### 4.6 Plugin TUI (terminal)

`@opencode/plugin/tui` permet d'ajouter une UI terminal via des **slots**
(`sidebar.content`, `session.panel`, `home.footer`, …), des commandes palette /
slash, des dialogues. Utile pour la parité TUI, **mais** ne concerne pas
OpenChamber (client desktop distinct).

---

## 5. Surface d'intégration OpenChamber

OpenChamber (monorepo Bun) est un **client + proxy** :

- L'UI (`packages/ui`) parle à son **propre serveur** `/api`, qui **proxy**
  HTTP + SSE vers un serveur OpenCode (via `@opencode-ai/sdk/v2`).
- Le navigateur reçoit les événements par **WebSocket** `/api/global/event/ws`
  (repli SSE). Pipeline : `packages/ui/src/sync/event-pipeline.ts` →
  `event-reducer.ts` → stores React.
- OpenChamber peut **injecter son propre plugin OpenCode** dans le process
  qu'il gère (`packages/web/server/lib/agent-tool/runtime.js`) : il écrit un
  `openchamber-plugin.js`, l'ajoute à `OPENCODE_CONFIG_CONTENT`, et le plugin
  rappelle OpenChamber via `POST /api/openchamber/agent-tool` avec un token.
  **C'est le patron à réutiliser.**

### 5.1 Ce qui existe déjà côté todo dans OpenChamber

- **UI session todos** : `WorkStatusTasksSection.tsx`, alimentée par
  `state.todo[sessionID]` (événement `todo.updated`, legacy v1) et
  `useTodosPersistStore`.
- **Rendu d'outil** : `toolRenderers.tsx` → `renderTodoOutput` (parse un JSON
  `[{content,status,priority}]` et l'affiche), `toolHelpers.ts` (métadonnées
  `todowrite`), `toolPresentation.tsx` (icône `list-check-3`).
- **Panneau projet** : `ProjectNotesTodoPanel.tsx` (todos/notes/plans
  **propres à OpenChamber**, stockés par son serveur — sans lien avec OpenCode).

### 5.2 Ce qui manque

- Aucun consommateur de **RPC de plugin** (`ctx.rpc`, `/api/rpc/...`,
  `codemode`) n'existe aujourd'hui dans OpenChamber (recherche : zéro
  occurrence).
- `todo.updated` n'est plus émis par OpenCode v2 → `WorkStatusTasksSection`
  reste vide pour les sessions v2.

### 5.3 Deux voies d'intégration

**Voie A — RPC + flux d'événements (recommandée).**
Le plugin expose `todowrite`/`todoread` + un RPC `todolist` (méthodes `list`/
`set` + événement `updated`). OpenChamber :
1. proxy déjà en place : `/api/*` forward → `/api/rpc/todolist/list` fonctionne ;
2. l'événement `rpc.todolist.updated` arrive dans le flux global → à traiter dans
   `event-reducer.ts` pour alimenter un store (voire réutiliser la forme
   `state.todo` attendue par `WorkStatusTasksSection`) ;
3. UI : panneau dédié (guest extension) ou réutilisation de
   `WorkStatusTasksSection`.

**Voie B — callback plugin → OpenChamber (patron `agent-tool`).**
Le plugin OpenCode est injecté par OpenChamber avec une URL + token et `POST`
l'état vers une route OpenChamber dédiée. Plus de code serveur, mais moins
générique (ne marche que si OpenChamber gère le process OpenCode).

**Recommandation** : Voie A. Elle est générique (marche aussi TUI/VS Code/autre
client), s'appuie sur l'API plugin publique, et réutilise le proxy existant.

---

## 6. Architecture proposée

### 6.1 Plugin OpenCode (`@…/opencode-todolist`)

```
opencode-todolist/
  package.json         # exports "." + éventuel "./tui"
  src/index.ts         # Plugin.define : outils + hooks + RPC
  src/rpc.ts           # Rpc.define (methods: list/set/clear, events: updated)
  src/store.ts         # ctx.storage keyed by session
  src/tui.tsx          # (optionnel) slot sidebar.content / session.panel
```

Responsabilités :

1. **Outils** `todowrite` (upsert de la liste complète) et `todoread`
   (lecture), sans `codemode`, avec `permission: "todowrite"` (et `todoread`).
2. **Persistance** dans `ctx.storage`, clé `session/<sessionID>`.
3. **Émission** de l'événement RPC `updated` après chaque écriture.
4. **Injection contexte** via `ctx.session.hook("context")` : pousse les tâches
   non terminées dans `event.system` à chaque appel modèle → survit à la
   compaction (gain vs v1).
5. **RPC** : `list({sessionID})`, `set({sessionID, todos})`,
   `clear({sessionID})` + événement `updated({sessionID, todos})`.

### 6.2 Modèle de données

```ts
type TodoStatus   = "pending" | "in_progress" | "completed"
type TodoPriority = "high" | "medium" | "low"
interface Todo {
  content: string
  status: TodoStatus
  priority: TodoPriority
  position?: number
}
```

Aligné sur la table v1 → compatibilité de rendu avec
`renderTodoOutput` d'OpenChamber.

### 6.3 Flux

```
 modèle ──appelle──► todowrite (plugin) ──écrit──► ctx.storage[session]
                              │
                              ├─ emit rpc.todolist.updated ─► flux /api/event
                              │                                   │
                              │                         OpenChamber (WS /api/global/event/ws)
                              │                                   │
                              │                          event-reducer ─► store ─► UI
                              │
 contexte modèle ◄── session.hook("context") (injection des tâches ouvertes)
```

### 6.4 Côté OpenChamber

- Traiter `rpc.todolist.updated` dans `event-reducer.ts` → alimenter
  `state.todo[sessionID]` (forme déjà consommée par `WorkStatusTasksSection`),
  **ou** créer un store dédié + un panneau.
- Option UI : panneau dédié (guest extension `contributes.panel`) ou ajout d'une
  règle `contributes.tools` pour un rendu riche de `todowrite` (le rendu JSON
  existant peut suffire).
- Hydratation au chargement via `GET /api/rpc/todolist/list`.

---

## 7. Contraintes et pièges identifiés

1. **Pas d'accès DB** depuis un plugin → ne pas réutiliser la table `todo` ;
   utiliser `ctx.storage`. (Les plugins communautaires qui écrivent la table
   passent par un accès direct fragile.)
2. **`codemode`** : ne pas l'activer pour que les outils soient visibles en chat.
3. **Snapshot par requête** : capturer les données dans le callback de transform,
   pas de mutation après coup (utiliser `reload()`).
4. **`ctx.storage` est scoped plugin, pas session** → préfixer les clés.
5. **Le plugin tourne dans le service partagé** → utiliser `ctx.location`, ne pas
   supposer `process.cwd()`.
6. **OpenChamber 2.2.0 ≠ dépôt local 1.24.2** : l'architecture observée doit être
   re-vérifiée sur la version cible avant implémentation.
7. **Compatibilité des noms** : garder exactement `todowrite`/`todoread` pour
   réutiliser les rendus et habitudes existants.
8. **Permission** : déclarer `permission: "todowrite"` pour permettre un
   `allow`/`deny` propre dans la config v2.

---

## 8. Décisions (tranchées)

1. **Transport OpenChamber** : **Voie A (RPC)**. Le plugin expose un RPC
   (méthodes + événements) ; OpenChamber le consomme via son proxy `/api` et le
   flux d'événements. Générique (TUI, VS Code, autres clients).
2. **UI OpenChamber** : **réutiliser l'existant** — alimenter `state.todo` via
   le reducer pour réutiliser `WorkStatusTasksSection` et `renderTodoOutput`.
3. **Parité TUI** : **plus tard** (phase 6 optionnelle), hors périmètre initial.
4. **Portée de la persistance** : par session (`session/<id>`) — à confirmer en
   phase 1.
5. **Nom/édition** : `todowrite` upsert complet (comme v1) — à confirmer.
6. **Cible de version** : OpenCode `2.0.26` (latest npm), OpenChamber cible à
   préciser.

---

## 9. Plan de mise en œuvre (proposé)

| Phase | Contenu | Livrable |
|---|---|---|
| 0 | Valider cette étude, trancher les décisions ouvertes | doc à jour |
| 1 | Plugin minimal : `todowrite`/`todoread` + `ctx.storage` | plugin chargeable, outils visibles |
| 2 | RPC `list`/`set`/`clear` + événement `updated` | test `opencode api` / client |
| 3 | Injection contexte (`session.hook("context")`) | survit à la compaction |
| 4 | Intégration OpenChamber : reducer + store + hydratation | liste visible |
| 5 | UI (réutilisée ou panneau dédié) | progression, statuts |
| 6 | Optionnel : plugin TUI (slot sidebar) | parité terminal |
| 7 | Tests, doc, packaging npm | release |

---

## 10. Risques

- **Évolution de l'API plugin v2** (encore jeune) : `codemode`, hooks, RPC
  peuvent changer → verrouiller une version et surveiller.
- **Retour officiel du todo** : si le core réintroduit un opt-in, migrer vers le
  natif plutôt que maintenir le plugin.
- **Double source de vérité** si OpenChamber garde son store v1 → clarifier.
- **Perf** : l'injection de contexte à chaque appel a un coût tokens ; borner la
  liste (tâches ouvertes uniquement, troncature).

---

## 11. Références

- Issue officielle : `anomalyco/opencode#42421` (« [Feature]: add todo support for v2 »).
- Docs v2 : plugins `https://opencode.ai/v2/docs/build/plugins`, RPC
  `.../plugins/rpc`, CLI plugins `.../plugins/cli`, client, API.
- Paquets npm : `@opencode/plugin@2.0.26`, `@opencode/schema@2.0.26`,
  `@opencode/client@2.0.26`.
- Code source inspecté : `~/.opencode/bin/opencode` (2.0.16),
  `~/.local/share/opencode/opencode.db` (schéma `todo`), OpenAPI
  `/openapi.json` (endpoint `/api/rpc/{rpcID}/{method}`).
- OpenChamber : `~/Documents/Projects/openchamber`
  (`packages/ui/src/sync/*`, `packages/web/server/lib/agent-tool/runtime.js`,
  `packages/extensions`, `packages/sdk`).
