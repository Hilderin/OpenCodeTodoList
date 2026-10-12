/**
 * opencode-todolist
 * -----------------------------------------------------------------------------
 * A small OpenCode v2 plugin that restores the `todowrite` / `todoread` tools and
 * the session todo list removed from OpenCode v2.
 *
 * Why a plugin (and not MCP / a core change):
 *   - It runs inside the OpenCode server: no extra process to install or keep
 *     alive, no MCP configuration.
 *   - It stores the list in `ctx.storage`, OpenCode's durable plugin key/value
 *     store: no file to manage, no database access needed.
 *   - It re-injects the open todos into every model request through the
 *     `session.hook("context")` hook, so the list survives compaction -- the
 *     regression most often reported against v2.
 *
 * It is written as a dependency-free ES module on purpose: the same file can be
 * dropped in `.opencode/plugins/` or loaded as a package, with nothing to
 * resolve and nothing to build.
 *
 * The plugin API used here is verified against @opencode/plugin 2.0.x:
 *   - `ctx.tool.transform(editor => editor.add({ name, description, input, options, execute }))`
 *   - tool `options: { codemode: false, permission: "..." }` (direct tool, not
 *     behind Code Mode)
 *   - `execute(input, context)` with `context.sessionID`
 *   - `ctx.storage.get/set`
 *   - `ctx.session.hook("context", async event => event.system.push({ type: "text", text }))`
 */

/** Storage keys are namespaced per session inside the plugin's own store. */
const STORAGE_PREFIX = "session/"

/** Upper bound on the todos rendered into the model context, to bound tokens. */
const MAX_INJECTED = 50

const STATUSES = ["pending", "in_progress", "completed"]
const PRIORITIES = ["high", "medium", "low"]

const STATUS_SET = new Set(STATUSES)
const PRIORITY_SET = new Set(PRIORITIES)

/** Checkbox used when rendering a todo list as text. */
const box = (status) => (status === "completed" ? "x" : status === "in_progress" ? "~" : " ")

/** Render a todo list as compact markdown-ish text. */
const render = (todos) => {
  if (todos.length === 0) return "(no todos)"
  return todos.map((todo) => `- [${box(todo.status)}] (${todo.priority}) ${todo.content}`).join("\n")
}

/**
 * Coerce whatever the model sent into a clean, complete todo list. Unknown
 * statuses/priorities fall back to safe defaults instead of rejecting the call,
 * because a partially valid list is more useful than a tool error.
 */
const normalize = (raw) => {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item) => item && typeof item === "object" && typeof item.content === "string" && item.content.trim() !== "")
    .map((item) => ({
      content: item.content.trim(),
      status: STATUS_SET.has(item.status) ? item.status : "pending",
      priority: PRIORITY_SET.has(item.priority) ? item.priority : "medium",
    }))
}

const TODO_ITEM_SCHEMA = {
  type: "object",
  properties: {
    content: {
      type: "string",
      description: "Imperative description of the task, e.g. 'Add the migration test'.",
    },
    status: {
      type: "string",
      enum: STATUSES,
      description: "pending (not started), in_progress (current), completed (done).",
    },
    priority: {
      type: "string",
      enum: PRIORITIES,
      description: "high, medium, or low.",
    },
  },
  required: ["content", "status", "priority"],
  additionalProperties: false,
}

const TODOWRITE_DESCRIPTION = [
  "Create or replace the session todo list.",
  "Use it to plan multi-step work and to keep the list current: call it again with the full list whenever the plan changes, when you start an item (status 'in_progress'), and immediately after you finish one (status 'completed').",
  "Prefer several small, concrete items over one vague item. Pass the complete list every time; this call replaces the previous one.",
].join(" ")

const TODOREAD_DESCRIPTION =
  "Read the current session todo list. Call it when you are unsure what remains, especially after a long gap or a compaction."

/** The plugin entrypoint. `Plugin.define` is optional; a plain { id, setup } is enough. */
export default {
  id: "todolist",

  async setup(ctx) {
    const key = (sessionID) => STORAGE_PREFIX + sessionID

    /** Read the list for one session from the plugin's durable storage. */
    const read = async (sessionID) => normalize(await ctx.storage.get(key(sessionID)))

    /** Persist the list for one session. */
    const write = async (sessionID, todos) => {
      await ctx.storage.set(key(sessionID), todos)
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "todowrite",
        description: TODOWRITE_DESCRIPTION,
        // codemode:false keeps this a direct tool rather than one hidden behind
        // the Code Mode `execute` tool. `permission` gives a stable action name
        // so it can be allowed/denied from configuration.
        options: { codemode: false, permission: "todowrite" },
        input: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              description: "The complete todo list for this session.",
              items: TODO_ITEM_SCHEMA,
            },
          },
          required: ["todos"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const todos = normalize(input && input.todos)
          await write(context.sessionID, todos)
          // `metadata` travels with the tool result, so a client can render the
          // list structurally instead of parsing the text content.
          return { content: render(todos), metadata: { todos } }
        },
      })

      editor.add({
        name: "todoread",
        description: TODOREAD_DESCRIPTION,
        options: { codemode: false, permission: "todoread" },
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute(_input, context) {
          const todos = await read(context.sessionID)
          return { content: render(todos), metadata: { todos } }
        },
      })
    })

    // Re-inject the list before every model request. This is what makes the list
    // survive compaction: the injected text is part of the outgoing request but
    // not of the persisted transcript, so it is re-added on every call.
    await ctx.session.hook("context", async (event) => {
      const todos = await read(event.sessionID)
      if (todos.length === 0) return

      const shown = todos.slice(0, MAX_INJECTED)
      const remaining = todos.length - shown.length
      const done = todos.filter((todo) => todo.status === "completed").length

      event.system.push({
        type: "text",
        text: [
          "<todo_list>",
          `${done}/${todos.length} completed. Keep this list current with the todowrite tool.`,
          render(shown),
          remaining > 0 ? `... and ${remaining} more` : "",
          "</todo_list>",
        ]
          .filter(Boolean)
          .join("\n"),
      })
    })
  },
}
