# openchamber-plugin

Reserved for a future **OpenChamber** plugin / panel for the todo list.

## Status

Not planned. After testing the default rendering in OpenChamber, the display was
judged good enough, so no OpenChamber-side plugin will be built. The todo list is
provided by the OpenCode plugin alone (`../opencode-plugin/`), with no OpenChamber
UI: the tasks appear as tool calls in the chat.

## Background

An OpenChamber session panel showing the tasks, fed by the OpenCode plugin, was
considered. See `../docs/technical-study.md` (§5, §12) for the OpenChamber
integration constraints (extension sandbox, no direct network access, the
`agent-tool` pattern) that informed the decision.
