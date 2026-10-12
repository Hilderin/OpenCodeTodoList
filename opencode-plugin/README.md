# opencode-plugin

A small **OpenCode v2 plugin** that restores the `todowrite` / `todoread` tools
and the session todo list removed from OpenCode v2.

- **Native tools** `todowrite` (create/replace the list) and `todoread` (read it
  back), direct (not behind the Code Mode `execute` tool).
- **Per-session persistence** through `ctx.storage` (the plugin's durable KV
  store): no file to manage, no database access.
- **Survives compaction**: the list of open todos is re-injected into every model
  request through `ctx.session.hook("context")`.
- **No separate process**, no MCP configuration, no change to OpenCode or
  OpenChamber.

> Context and comparison of approaches: [`../docs/technical-study.md`](../docs/technical-study.md).

## Installation

The plugin must be loaded as a **directory** (OpenCode resolves its `index.js`).
Two methods.

### 1. Declare the directory in the config (recommended)

In `opencode.jsonc`, at the global level (`~/.config/opencode/opencode.jsonc`) or
project level:

```jsonc
{
  "plugins": ["/home/guillaume/Documents/Projects/OpenCodeTodoList/opencode-plugin"]
}
```

Restart the OpenCode server (or reload the config). The plugin is hot-reloaded on
every change to `index.js`.

### 2. Copy it into the project's plugins directory

Copy this directory to `.opencode/plugins/todolist/` (a **directory**, with
`index.js` at its root):

```
.opencode/plugins/todolist/
├── package.json
└── index.js
```

### Verify it loaded

```sh
opencode api get /api/plugin
```

The plugin must appear with `"id": "todolist"` and
`"state": { "status": "active" }`.

## Usage

The model calls `todowrite` with the complete list on every change:

```json
{ "todos": [
  { "content": "Read the spec", "status": "completed", "priority": "high" },
  { "content": "Write the migration", "status": "in_progress", "priority": "high" },
  { "content": "Add the tests", "status": "pending", "priority": "medium" }
] }
```

`todoread` returns the current list. Open todos are automatically recalled to the
model before every request (so after a compaction too).

## Permissions

Both tools expose permission actions `todowrite` and `todoread`. To disable or
restrict them, add rules under `permissions`:

```jsonc
{
  "permissions": [
    { "action": "todowrite", "resource": "*", "effect": "deny" }
  ]
}
```

By default they are available without a permission prompt.

## Structure

```
index.js       # the plugin (dependency-free ESM, the directory's entrypoint)
package.json   # package metadata
```

The `index.js` file intentionally imports nothing: OpenCode loads it as-is, with
no build and no dependency resolution.
