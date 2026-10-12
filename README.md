# OpenCodeTodoList

Restore the **todo list** removed from OpenCode v2, as plugins.

## Contents

| Directory | Role | Status |
|---|---|---|
| [`opencode-plugin/`](opencode-plugin/) | OpenCode plugin: `todowrite`/`todoread` tools, per-session list, compaction-safe | **implemented** |
| [`openchamber-plugin/`](openchamber-plugin/) | OpenChamber panel / plugin | not planned |

## Context

OpenCode v2 removed the native `todowrite` / `todoread` tools and the associated
todo panel (an official decision, made for performance reasons). The feature is
reimplemented here outside the core, through the v2 plugin API.

## Quick start (OpenCode plugin)

Declare the plugin directory in `opencode.jsonc`:

```jsonc
{
  "plugins": ["/home/guillaume/Documents/Projects/OpenCodeTodoList/opencode-plugin"]
}
```

Details: [`opencode-plugin/README.md`](opencode-plugin/README.md).

## Documentation

- [`docs/technical-study.md`](docs/technical-study.md) — technical study: why the
  feature was removed, the v2 plugin API, a comparison of approaches (plugin /
  MCP / OpenChamber integration), constraints, and decisions.
