# OpenCode Tools Implementation Report

This report summarizes how OpenCode implements built-in tools, custom tools, MCP tools, permissions, and session tool execution.

Source reviewed: `anomalyco/opencode`, default branch `dev`.

## Key Source Paths

- Built-in tools: `packages/opencode/src/tool/*.ts`
- Tool definition wrapper: `packages/opencode/src/tool/tool.ts`
- Tool registry: `packages/opencode/src/tool/registry.ts`
- Prompt/model tool wiring: `packages/opencode/src/session/prompt.ts`
- Tool stream/session tracking: `packages/opencode/src/session/processor.ts`
- Permission system: `packages/opencode/src/permission/*`
- MCP implementation: `packages/opencode/src/mcp/index.ts`
- Plugin/custom tool helper: `packages/plugin/src/tool.ts`

## Architecture

OpenCode tools are model-callable AI SDK tools.

```text
Tool source
  -> ToolRegistry / MCP service
  -> SessionPrompt.resolveTools()
  -> AI SDK streamText({ tools })
  -> model emits tool call
  -> tool execute callback runs
  -> SessionProcessor records pending/running/completed/error tool parts
  -> result is returned to model
```

## Built-In Tools

Built-ins are regular TypeScript modules under `packages/opencode/src/tool/`.

Each built-in uses `Tool.define(id, initEffect)` from `tool.ts`.

The internal definition has this shape:

```ts
{
  id: string,
  description: string,
  parameters: EffectSchema,
  execute(args, ctx): Effect<ExecuteResult>
}
```

`ExecuteResult` has this shape:

```ts
{
  title: string
  metadata: Record<string, any>
  output: string
  attachments?: FilePart[]
}
```

The tool execution context includes:

```ts
{
  sessionID,
  messageID,
  agent,
  abort,
  callID,
  messages,
  metadata(...),
  ask(...)
}
```

Important behavior from `tool.ts`:

- Arguments are decoded and validated with `effect/Schema`.
- Invalid arguments are converted into model-facing errors.
- Outputs are automatically truncated unless the tool already marks `metadata.truncated`.
- Execution is wrapped in tracing spans.

## Tool Registry

`packages/opencode/src/tool/registry.ts` builds the built-in and custom tool list.

Built-ins registered there include:

- `bash`
- `read`
- `glob`
- `grep`
- `edit`
- `write`
- `apply_patch`
- `task`
- `todowrite`
- `webfetch`
- `websearch`
- `codesearch`
- `question`
- `skill`
- `lsp`
- `plan`

The registry conditionally enables tools:

- `websearch` and `codesearch`: only with the OpenCode provider or Exa flag.
- `apply_patch`: preferred for newer GPT models.
- `edit` and `write`: hidden when `apply_patch` is preferred.
- `question`: only for supported clients or flag.
- `lsp`: experimental flag.
- `plan`: experimental plan mode flag.

## Custom Tools

OpenCode supports non-MCP custom tools.

Docs: <https://opencode.ai/docs/custom-tools/>

Custom tools can live in:

```text
.opencode/tools/
~/.config/opencode/tools/
```

They are TypeScript or JavaScript files. The filename becomes the tool name.

Example:

```ts
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Query the project database",
  args: {
    query: tool.schema.string().describe("SQL query to execute"),
  },
  async execute(args, context) {
    return `Executed query: ${args.query}`
  },
})
```

Multiple exports in one file become separate tools named `<filename>_<exportname>`.

Custom tools are loaded in `ToolRegistry` by scanning:

```text
{tool,tools}/*.{js,ts}
```

from configured directories.

The registry wraps each custom tool's Zod args in an Effect schema adapter so custom tools fit the same internal framework as built-ins.

Custom tool context includes:

```ts
{
  sessionID,
  messageID,
  agent,
  directory,
  worktree,
  abort,
  metadata(...),
  ask(...)
}
```

Custom tools can return either a string or an object:

```ts
string
```

```ts
{
  output: string
  metadata?: Record<string, any>
}
```

Custom tools can override built-ins by using the same tool name.

## MCP Tools

MCP is separate from `ToolRegistry`.

Implementation: `packages/opencode/src/mcp/index.ts`.

MCP supports:

- Local stdio servers via `StdioClientTransport`
- Remote Streamable HTTP via `StreamableHTTPClientTransport`
- Remote SSE via `SSEClientTransport`
- OAuth auth flows for remote MCP

MCP tools are converted with AI SDK `dynamicTool()`:

```ts
dynamicTool({
  description,
  inputSchema: jsonSchema(schema),
  execute: async (args) => client.callTool(...)
})
```

MCP tool names are prefixed and sanitized:

```text
<serverName>_<toolName>
```

In `SessionPrompt.resolveTools()`, OpenCode adds MCP tools after built-in/custom tools.

Before executing an MCP tool, OpenCode asks permission using the full MCP tool name:

```ts
ctx.ask({
  permission: key,
  patterns: ["*"],
  always: ["*"],
  metadata: {}
})
```

MCP result content is converted into text output and optional file attachments. Output is truncated with the same truncation service used by built-ins.

## How Tools Reach The Model

Main file: `packages/opencode/src/session/prompt.ts`.

`resolveTools()` converts internal tool definitions into AI SDK tools:

```ts
tools[item.id] = tool({
  description: item.description,
  inputSchema: jsonSchema(schema),
  execute(args, options) {
    ...
  },
})
```

During execution OpenCode:

- Builds `Tool.Context`.
- Triggers plugin hook `tool.execute.before`.
- Calls `item.execute(args, ctx)`.
- Attaches generated file attachments.
- Triggers plugin hook `tool.execute.after`.
- Returns the result to the AI SDK.

Then `packages/opencode/src/session/llm.ts` calls:

```ts
streamText({
  tools,
  activeTools,
  toolChoice,
  messages,
  model,
})
```

Tools are first-class model tools, not prompt-parsed JSON.

## Tool Call Tracking

Main file: `packages/opencode/src/session/processor.ts`.

The AI SDK stream emits events:

- `tool-input-start`
- `tool-call`
- `tool-result`
- `tool-error`

OpenCode creates and updates session message parts through these states:

```text
pending -> running -> completed/error
```

OpenCode also has doom-loop detection. If the same tool with the same input repeats 3 times, it triggers the `doom_loop` permission.

## Permissions

Relevant files:

- `packages/opencode/src/permission/index.ts`
- `packages/opencode/src/permission/evaluate.ts`

Permission actions:

```text
allow
ask
deny
```

Rules match on permission name and pattern. The last matching rule wins.

Tools call `ctx.ask(...)` for granular checks. Examples:

- `read`: asks `read` permission for filepath.
- `grep`: asks `grep` permission for regex pattern.
- `glob`: asks `glob` permission for glob pattern.
- `bash`: asks `bash` permission for parsed commands and `external_directory` for path escapes.
- `webfetch`: asks `webfetch` permission for URL.
- `edit`, `write`, and `apply_patch`: use `edit` permission.
- MCP tools: use the full MCP tool name.

Permission requests are surfaced through events and block until replied.

## Specific Tool Details

### read

Source: `packages/opencode/src/tool/read.ts`.

- Resolves relative paths against the current instance directory.
- Checks external directory access.
- Asks `read` permission.
- Supports directories and files.
- Directory output is sorted.
- File output is line-numbered.
- Default line limit: `2000`.
- Max line length: `2000`.
- Max bytes: `50 KB`.
- Detects binary files and refuses to read them.
- Images and PDFs are returned as attachments.
- Warms LSP by touching files after reads.
- Adds instruction reminders if associated instructions exist.

### glob

Source: `packages/opencode/src/tool/glob.ts`.

- Uses internal `Ripgrep.Service`.
- Resolves search path against the current directory.
- Requires the search path to be a directory.
- Checks external directory access.
- Asks `glob` permission using the glob pattern.
- Limits results to `100`.
- Sorts by file modification time descending.
- Uses ripgrep file listing under the hood.

### grep

Source: `packages/opencode/src/tool/grep.ts`.

- Uses `Ripgrep.Service`.
- Accepts regex `pattern`, optional `path`, and optional `include`.
- Asks `grep` permission using the regex pattern.
- Handles file or directory search targets.
- Checks external directory access.
- Limits displayed results to `100`.
- Sorts matches by file modification time descending.
- Truncates long matching lines to `2000` chars.
- Reports partial inaccessible-path results.

### webfetch

Source: `packages/opencode/src/tool/webfetch.ts`.

- Requires URL to start with `http://` or `https://`.
- Asks `webfetch` permission for URL.
- Supports `format`: `markdown`, `text`, `html`.
- Default timeout: `30s`.
- Max timeout: `120s`.
- Max response size: `5 MB`.
- Sets browser-like headers.
- Retries with `User-Agent: opencode` for a Cloudflare challenge case.
- Converts HTML to Markdown using `turndown`.
- Extracts text from HTML using `HTMLRewriter`.
- Image responses become file attachments.

## Plugin Hooks

Tools have plugin hooks around definition and execution:

- `tool.definition`
- `tool.execute.before`
- `tool.execute.after`

Plugins can mutate tool descriptions/schemas and inspect or alter execution output.

## Implication For This Bot

The simplest non-MCP path is OpenCode custom tools.

For Telegram bot wrapper functionality, use:

```text
OpenCode custom tool
  -> calls Telegram bot local loopback endpoint
  -> bot executes wrapper service
  -> returns result
```

The custom tool should not edit `settings.json` directly. Schedule mutations must call bot-owned services so tasks are validated, persisted, and registered with runtime timers.

Recommended initial wrapper tools:

- `telegram_notify`
- `scheduler_create_task`
- `scheduler_list_tasks`
- `scheduler_delete_task`

## Bottom Line

OpenCode tools are not only MCP. Built-in and custom tools are native TypeScript/JavaScript AI SDK tools. For inner harness tools similar to `read`, `glob`, `grep`, and `webfetch`, OpenCode's custom tool system is the closest native match and is simpler than building a full MCP server.
