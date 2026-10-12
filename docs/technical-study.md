# Technical study — Restoring the todo list in OpenCode v2 and OpenChamber

> Study document.
> Reference versions observed on the machine: **OpenCode 2.0.16**
> (`~/.opencode/bin/opencode` binary), npm packages `@opencode/plugin@2.0.26`,
> `@opencode/schema@2.0.26`, `@opencode/client@2.0.26`, **OpenChamber 2.2.0**.
>
> Source repositories up to date on Oct 11, 2026:
> - `~/Documents/Projects/opencode` — branch `dev`, commit `707de58326`.
> - `~/Documents/Projects/openchamber` — branch `main`, commit `2dca721e6`.

---

## 1. Goal

Make available again, on the **OpenCode v2** side:

- `todowrite` / `todoread` tools the model can call to keep a per-session todo
  list;
- a **user-visible** view of that list (progress, statuses);
- if possible, an **injection into the agent context** so the list survives
  compaction (the regression most often reported against v2).

Design constraint: do not depend on the OpenCode core, but go through the
**v2 plugin API** (supported and stable).

---

## 2. Why the feature disappeared (recap)

- Official decision (issue `anomalyco/opencode#42421`): "we removed it because it
  slows agent down and we haven't noticed significant performance improvements
  from it's existence". The issue was first closed "not planned", then
  **reopened on Oct 6, 2026**: "We may add a way to re-enable them".
- History: the todo was disabled for non-Anthropic models (2025), `todoread` was
  removed in v1 (PR #19128), then the whole thing disappeared in v2.
- Technical consequence verified on 2.0.16: neither `todowrite` nor `todoread` in
  the tool registry, **no** `/api/todo` endpoint, **no** `todo.updated` event.

---

## 3. Current state of the art (verified locally)

### 3.1 What v2 still provides

| Item | State |
|---|---|
| SQLite table `todo` | **Present**, identical v1 schema (see §3.3) |
| REST endpoint `/api/todo` | Absent |
| `todo.updated` event | Absent from the v2 schema |
| Native todo tools | Absent |
| v2 plugin API (`@opencode/plugin`) | Complete, including `tool.transform`, hooks, RPC, storage |
| `/api/rpc/{rpcID}/{method}` endpoint | **Present** in the v2 OpenAPI |
| RPC events `rpc.<id>.<event>` | Carried by the server's event stream |

### 3.2 The event stream and RPC

- The server exposes an event stream (`/api/event`,
  `/api/experimental/session/{id}/log`).
- A plugin can publish **typed RPC events**; their type is `rpc.<id>.<event>`
  (`@opencode/schema/rpc`). They are delivered to external clients subscribed to
  the stream, with `location`.
- A plugin can expose **RPC methods** callable over HTTP via
  `/api/rpc/{rpcID}/{method}`.

This is the key integration point: **no custom endpoint needed** to surface todos
to a client.

### 3.3 The `todo` table (real schema, read from `opencode.db`)

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

This table still exists but **is no longer fed by any v2 code**. A plugin has
**no** official access to the database (no DB API in `ctx`).

**Confirmed in the v2 source**
(`packages/core/src/database/migration/20260127222353_familiar_lady_ursula.ts`):
this baseline migration creates the `todo` table and its index. It is **embedded
in the binary** and recorded as applied — so a **fresh v2 install gets the
table**, with nothing to create. No later migration drops it. It nevertheless
remains **orphaned** (see §7.1). On the v1→v2 migration side,
`packages/core/src/database/v1-migration.bun.ts` contains
`const REMOVED_TOOLS = ["todowrite"]`.

---

## 4. The v2 plugin API — usable building blocks

Package: `@opencode/plugin` (latest: `2.0.26`). Main entrypoint:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "todolist",
  async setup(ctx) {
    // registrations here
    return () => { /* cleanup */ }
  },
})
```

A local plugin is loaded automatically from `.opencode/plugins/`, or declared in
`opencode.jsonc` via `plugins: [...]`.

### 4.1 Tools (`ctx.tool`)

```ts
await ctx.tool.transform((editor) => {
  editor.add({
    name: "todowrite",
    description: "Create/update the session todo list",
    input: { /* JSON Schema or Standard Schema (zod) */ },
    output: { /* optional */ },
    options: { /* namespace?, permission?, codemode? */ },
    execute: async (input, context) => {
      // context.signal, context.progress, context.sessionID, context.agent
      return { content: "…", metadata: { todos } }
    },
  })
})
```

**Exact type shape** (`@opencode/schema/tool`):

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

Important points:

- **`codemode`**: optional. Omitted → the tool is in the **native chat catalog**
  (visible to the model). `codemode: true` places it in Code Mode. For
  `todowrite`/`todoread`, **omit `codemode`** (or set `false`). The community
  rumour "codemode defaults to true" does not match the 2.0.26 type.
- `namespace`: avoids collisions but renames to `ns_tool`. To keep the exact names
  `todowrite`/`todoread`, **do not** set a namespace.
- `permission`: permission action name (allows a dedicated `allow`/`deny`).
- `execute` is **captured per model request** (stable snapshot). Capture the
  needed values inside the transform callback.

### 4.2 Hooks

- **Context injection** — the key lever to survive compaction:

  ```ts
  await ctx.session.hook("context", (event) => {
    event.system.push({ type: "text", text: renderTodos(openTodos) })
    // or event.messages
  })
  ```

  The hook receives `sessionID`, `agent`, `model`, `messages`, `system`, `tools`,
  `options`. It only changes the outgoing request, not the history.

- **Tool execution observation** (useful for sync/events):

  ```ts
  await ctx.tool.hook("execute.after", (event) => {
    // event.tool, event.sessionID, event.status, event.result | event.error
  })
  ```

### 4.3 RPC (transport to a client)

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

// in setup:
const reg = await ctx.rpc.register(TodoRpc, {
  list: async ({ sessionID }) => ({ todos: await readTodos(sessionID) }),
  set:  async ({ sessionID, todos }) => { await writeTodos(sessionID, todos); return { todos } },
})
await reg.events.emit("updated", { sessionID, todos })
```

Client side: `client.rpc(TodoRpc).list(...)` and
`client.rpc(TodoRpc).events.on("updated", …)` / `.subscribe("updated")`.

### 4.4 Storage

`ctx.storage` is a **durable JSON KV store owned by the plugin** (no access to
the `todo` table):

```ts
await ctx.storage.set(`session/${sessionID}`, todos)
await ctx.storage.get(`session/${sessionID}`)
await ctx.storage.scan({ prefix: "session/" })
```

This is the clean way to persist todos **without touching the core database**.

### 4.5 Server events

`ctx.event.subscribe({ signal })` lets you listen to the server stream (e.g.
`session.idle`, session lifecycle) to clean up or update.

### 4.6 TUI plugin (terminal)

`@opencode/plugin/tui` adds a terminal UI through **slots** (`sidebar.content`,
`session.panel`, `home.footer`, …), palette / slash commands, and dialogs. Useful
for terminal parity, **but** it does not concern OpenChamber (a separate desktop
client).

---

## 5. OpenChamber integration surface

OpenChamber (a Bun monorepo) is a **client + proxy**:

- The UI (`packages/ui`) talks to its **own server** `/api`, which **proxies**
  HTTP + SSE to an OpenCode server (through `@opencode-ai/sdk/v2`).
- The browser receives events over a **WebSocket** `/api/global/event/ws` (SSE
  fallback). Pipeline: `packages/ui/src/sync/event-pipeline.ts` →
  `event-reducer.ts` → React stores.
- OpenChamber can **inject its own OpenCode plugin** into the process it manages
  (`packages/web/server/lib/agent-tool/runtime.js`): it writes an
  `openchamber-plugin.js`, adds it to `OPENCODE_CONFIG_CONTENT`, and the plugin
  calls OpenChamber back via `POST /api/openchamber/agent-tool` with a token.
  **This is the pattern to reuse.**

### 5.1 What already exists for todo in OpenChamber

> **Update after pull (main `2dca721e6`)**: the session todo plumbing has been
> **removed** from OpenChamber, consistent with the removal on the OpenCode v2
> side.

- **Removed**: no more `WorkStatusTasksSection`, no more `state.todo` in
  `sync/types.ts`, no more `todo.updated` handling in `event-reducer.ts`, no more
  `session.todo` call. The only remaining traces of `todowrite`/`todoread` are
  **comments** (`lib/opencode/tools.ts`, `hooks/useAssistantStatus.ts`) and a
  legacy permission list (`sections/agents/agentPermissionModel.ts`).
- **Still present — but distinct**: the **project todos**
  (`ProjectNotesTodoPanel.tsx`, `TodosSection.tsx`, `useProjectContextStore`,
  `TodoSendDialog.tsx`), **owned by the OpenChamber server** (routes
  `/api/project-context/:projectId/todos`), unrelated to OpenCode.
- **To verify**: any generic rendering of a `todowrite` tool (the old
  `renderTodoOutput`/`toolHelpers` no longer seems to exist on `main`).

### 5.2 What is missing

- No consumer of a **plugin RPC** (`ctx.rpc`, `/api/rpc/...`, `codemode`) exists
  in OpenChamber today (search: zero occurrences in UI/server, apart from the MCP
  `codemode` settings).
- No **session** todo UI: it was removed, so it would have to be rebuilt.

### 5.3 Two integration paths

**Path A — RPC + event stream (recommended).**
The plugin exposes `todowrite`/`todoread` + a `todolist` RPC (`list`/`set`
methods + `updated` event). OpenChamber:
1. the proxy is already in place: `/api/*` forwards → `/api/rpc/todolist/list`
   works;
2. the `rpc.todolist.updated` event reaches the global stream → to be handled in
   `event-reducer.ts` to feed a **new session todo store** (to be rebuilt);
3. UI: a **new** session todo panel/section (the v1 component no longer exists),
   possibly modelled on `ProjectNotesTodoPanel`/`TodosSection`.

**Path B — plugin callback → OpenChamber (`agent-tool` pattern).**
The OpenCode plugin is injected by OpenChamber with a URL + token and `POST`s its
state to a dedicated OpenChamber route. Less server code, but less generic (only
works when OpenChamber manages the OpenCode process).

**Recommendation**: Path A. It is generic (also works with TUI/VS Code/other
clients), relies on the public plugin API, and reuses the existing proxy.

---

## 6. Proposed architecture (historical)

> **Historical section**: this architecture (RPC + OpenChamber UI) was abandoned
> in favour of the plugin alone. See the revision in §12.

### 6.1 OpenCode plugin (`@…/opencode-todolist`)

```
opencode-todolist/
  package.json         # exports "." + optional "./tui"
  src/index.ts         # Plugin.define: tools + hooks + RPC
  src/rpc.ts           # Rpc.define (methods: list/set/clear, events: updated)
  src/store.ts         # ctx.storage keyed by session
  src/tui.tsx          # (optional) sidebar.content / session.panel slot
```

Responsibilities:

1. **Tools** `todowrite` (full-list upsert) and `todoread` (read), without
   `codemode`, with `permission: "todowrite"` (and `todoread`).
2. **Persistence** in `ctx.storage`, key `session/<sessionID>`.
3. **Emit** the RPC event `updated` after every write.
4. **Context injection** via `ctx.session.hook("context")`: push the unfinished
   tasks into `event.system` on every model call → survives compaction (a gain
   over v1).
5. **RPC**: `list({sessionID})`, `set({sessionID, todos})`, `clear({sessionID})`
   + event `updated({sessionID, todos})`.

### 6.2 Data model

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

Aligned with the v1 table → rendering compatibility with OpenChamber's
`renderTodoOutput`.

### 6.3 Flow

```
 model ──calls──► todowrite (plugin) ──writes──► ctx.storage[session]
                          │
                          ├─ emit rpc.todolist.updated ─► /api/event stream
                          │                                   │
                          │                         OpenChamber (WS /api/global/event/ws)
                          │                                   │
                          │                          event-reducer ─► store ─► UI
                          │
 model context ◄── session.hook("context") (injection of open tasks)
```

### 6.4 OpenChamber side

- Handle `rpc.todolist.updated` in `event-reducer.ts` → feed a **new session todo
  store** (the old `state.todo` was removed on `main`).
- UI: create a session todo section/panel, modelled on
  `ProjectNotesTodoPanel`/`TodosSection`; or a `contributes.tools` rule for a rich
  rendering of `todowrite`.
- Hydrate on load via `GET /api/rpc/todolist/list`.

---

## 7. Constraints and pitfalls identified

1. **No DB access** from a plugin → do not reuse the `todo` table; use
   `ctx.storage`. (Community plugins that write the table use a fragile direct
   access.)
2. **`codemode`**: do not enable it, so the tools stay visible in chat.
3. **Per-request snapshot**: capture the data inside the transform callback; no
   mutation afterwards (use `reload()`).
4. **`ctx.storage` is plugin-scoped, not session-scoped** → prefix the keys.
5. **The plugin runs in the shared service** → use `ctx.location`, do not assume
   `process.cwd()`.
6. **Up-to-date source repositories**: opencode `dev` `707de58326`, openchamber
   `main` `2dca721e6`. Re-verify the architecture before implementing; file paths
   have changed (session todo removed on the OpenChamber side).
7. **Name compatibility**: keep exactly `todowrite`/`todoread` to reuse existing
   rendering and habits.
8. **Permission**: declare `permission: "todowrite"` to allow a clean
   `allow`/`deny` in the v2 config.

---

## 8. Decisions (revised)

> Major revision after analysis: the scope is narrowed to an **OpenCode plugin
> alone**, without RPC, without MCP, and without an OpenChamber UI. See §12.

1. **Approach**: **OpenCode plugin alone** (not MCP, no OpenChamber integration).
   MCP was ruled out (separate process, no context injection, display unresolved);
   the OpenChamber-native integration was ruled out (requires core changes, not
   needed for the requirement).
2. **UI**: **none** for now — todos appear as tool calls in the chat.
3. **Persistence**: `ctx.storage`, key `session/<sessionID>`.
4. **Name/editing**: `todowrite` replaces the full list (v1 semantics);
   `todoread` reads it back.
5. **Direct tools**: `options: { codemode: false }` to stay out of Code Mode.
6. **Anti-compaction**: re-injection via `ctx.session.hook("context")`.
7. **Target**: OpenCode `dev` (`707de58326`), plugin API `2.0.x`.

---

## 9. Implementation plan

| Phase | Content | Status |
|---|---|---|
| 1 | Plugin: `todowrite`/`todoread` + `ctx.storage` + context injection | **done** (`opencode-plugin/index.js`) |
| 2 | Permissions (`permission: "todowrite"`/`"todoread"`) | **done** |
| 3 | Load verification (OpenCode 2.0.16, `/api/plugin`) | **done** (active, tools registered) |
| 4 | npm packaging / publishing | to do |
| 5 | (optional) OpenChamber panel fed by the todos | not planned |
| 6 | (optional) TUI plugin | not planned |

---

## 10. Risks

- **v2 plugin API evolution** (still young): `codemode`, hooks, RPC may change →
  pin a version and watch.
- **Official todo return**: if the core reintroduces an opt-in, migrate to the
  native feature rather than maintaining the plugin.
- **Dual source of truth** if OpenChamber keeps a v1 store → clarify.
- **Performance**: context injection on every call has a token cost; bound the
  list (open tasks only, truncation).

---

## 11. References

- Official issue: `anomalyco/opencode#42421` ("[Feature]: add todo support for v2").
- v2 docs: plugins `https://opencode.ai/v2/docs/build/plugins`, RPC
  `.../plugins/rpc`, CLI plugins `.../plugins/cli`, client, API.
- npm packages: `@opencode/plugin@2.0.26`, `@opencode/schema@2.0.26`,
  `@opencode/client@2.0.26`.
- Source inspected: `~/.opencode/bin/opencode` (2.0.16),
  `~/.local/share/opencode/opencode.db` (`todo` schema), OpenAPI
  `/openapi.json` (`/api/rpc/{rpcID}/{method}` endpoint).
- OpenChamber: `~/Documents/Projects/openchamber`
  (`packages/ui/src/sync/*`, `packages/web/server/lib/agent-tool/runtime.js`,
  `packages/extensions`, `packages/sdk`).

---

## 12. Final revision: OpenCode plugin alone

### Why the scope was reduced

The real requirement is: *the agent keeps a todo list, visible in the chat, in
OpenChamber*. Three approaches were compared:

| Criterion | OpenCode plugin alone | MCP | OpenChamber-native integration |
|---|---|---|---|
| Separate process | No | Yes | No |
| Persistence | built-in `ctx.storage` | file to manage | OpenChamber store |
| Anti-compaction re-injection | **Yes** (`session.hook`) | No | Yes |
| Modifies OpenCode/OpenChamber | No | No (MCP config) | **Yes** (core) |
| Portability outside OpenCode | No | Yes | No |
| Display | tool calls in the chat | same | dedicated panel |

The **plugin alone** wins for this case: no extra resource, the list survives
compaction, no core change, free persistence. MCP only wins on portability, at
the cost of a process and the loss of injection. The OpenChamber-native
integration only brings a panel, at the cost of a fork.

### Constraints discovered (verified in the v2 code)

- A local plugin must be a **directory** whose resolver finds `<dir>/index.js`
  (or `server.*`): the `package.json` `exports` are **not used** for a local
  directory (`packages/plugin/src/host.ts` + `Bun.resolveSync`). Hence the
  `index.js` at the root.
- Plugin tools do **not** trigger a permission prompt automatically (only
  built-in tools call `permission.assert`); `options.permission` only names the
  action for a possible `allow`/`deny`.
- `codemode: false` is required for a **direct** tool (otherwise Code Mode).
- `session.hook("context")` accepts an **async** callback and exposes
  `{ sessionID, system, messages, … }`.

### Delivered implementation

- `opencode-plugin/index.js` — the plugin: `todowrite`/`todoread`, per-session
  `ctx.storage`, injection via `ctx.session.hook("context")`.
- `opencode-plugin/package.json` — the `opencode-todolist` package
  (`exports: { ".": "./index.js" }`).
- `openchamber-plugin/` — reserved, not planned (see its README).
- Verified on OpenCode **2.0.16**: loads (`/api/plugin` → `id: "todolist"`,
  `state: active`) and registers the tools (`todowrite`, `todoread`).

### OpenChamber plugin: dropped

An OpenChamber extension rendering the tool output as a table (and optionally a
session panel) was considered. After testing the default rendering in OpenChamber,
it was judged good enough, so no OpenChamber-side plugin will be built. The
default rendering already shows the `todowrite` / `todoread` tool calls with the
todo list in the chat.
