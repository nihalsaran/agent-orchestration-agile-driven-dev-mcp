# Codex CLI Agent MCP Registry

This project exposes the Codex CLI agents from the BMAD knowledge base as
Model Context Protocol (MCP) tools, making them discoverable and
callable by any MCP-compatible client. Each MCP tool represents a single
agent manifest and returns structured metadata as well as the full
instructions that power that agent.

## Features

- ✅ Discovers BMAD agent manifests (`*.md`, `*.agent.xml`) dynamically.
- ✅ Uses Zod for strict runtime validation of tool options and results.
- ✅ Streams over `stdio` so it can run as a local process without any
  network services.
- ✅ Returns both raw manifests and body-only instructions, with optional
  front-matter metadata.
- ✅ Launches Codex MCP sessions (`codex-run`, `codex-reply`, `codex-close`)
  so you can spin up specialised agents directly from the registry.

## Prerequisites

The server expects access to the BMAD repo that contains the agent
manifests. Set the environment variable `BMAD_ROOT` (or pass `--root`
when launching) to the directory that corresponds to
`bmad-mcp/bmad` provided in your workspace.

## Installation

```bash
npm install
```

If you are in a sandboxed environment without network access, you may
need to install dependencies outside the sandbox and copy them in.

## Scripts

- `npm run build` – Type-checks and compiles to `dist/`.
- `npm run start` – Runs the compiled server (`node dist/index.js`).
- `npm run dev` – Executes the TypeScript entry point directly via
  `ts-node` (helpful during development).

## Running the MCP server

```bash
npm run build
BMAD_ROOT=/path/to/bmad node dist/index.js
```

or during development:

```bash
BMAD_ROOT=/path/to/bmad npm run dev
```

When the server starts it:

1. Resolves the BMAD directory (from `--root` argument, `BMAD_ROOT`, or
   the default `../bmad-mcp/bmad` relative to the current working
   directory).
2. Recursively scans for agent manifests.
3. Registers one MCP tool per agent using `McpServer.registerTool`.
4. Attaches to `stdio` transport so an MCP client can spawn the process.

Each tool accepts two optional parameters:

| Field              | Type                    | Default | Description                                                                 |
| ------------------ | ----------------------- | ------- | --------------------------------------------------------------------------- |
| `detail`           | `"body"` \| `"raw"`     | `body`  | `body` returns instructions without front matter; `raw` returns full files. |
| `includeFrontMatter` | `boolean`             | `false` | When true, include parsed front matter metadata and the raw YAML block.     |

Tool invocations return a text summary plus structured content with:

- `agentId`, `name`, `description`
- Relative `sourcePath`
- `manifestFormat` (`markdown` or `xml`)
- `manifest` (body or raw file based on `detail`)
- `metadata`, `frontMatter` (when requested)
- Always echoes `body` and `raw` for convenience

## Codex integration

The registry now exposes three orchestration tools that shell out to the
Codex MCP server. Make sure the Codex CLI is installed and available on
your `$PATH`.

### Install Codex CLI

```bash
# Choose one
npm install -g @openai/codex
brew install codex
```

Then follow the Codex docs to authenticate (e.g. `codex login`) so the
CLI can reach your workspace. You can always verify the installation
with:

```bash
npm run verify:codex
```

### Runtime tools

| Tool           | Required fields                     | Purpose                                                   |
| -------------- | ----------------------------------- | --------------------------------------------------------- |
| `codex-run`    | `agentId`, `prompt`                 | Starts a new Codex session using the agent as instructions |
| `codex-reply`  | `conversationId`, `prompt`          | Sends a follow-up prompt to an existing session           |
| `codex-close`  | `conversationId`                    | Closes the Codex session and releases resources           |

`codex-run` forwards useful configuration parameters (model, sandbox,
approval policy, custom config, etc.) to the underlying Codex tool.
Each call returns the `conversationId` in `structuredContent`, letting
you orchestrate multi-step tasks by pairing `codex-reply` and
`codex-close`.

The registry automatically:

- Replaces `{project-root}` placeholders inside agent personas with the
  actual absolute path to the bundled BMAD directory.
- Runs Codex with `cwd` (and `PROJECT_ROOT` env var) pointing at that
  directory so activation steps that reference config/workflow files
  execute without manual setup.

Because Codex calls can take several minutes, ensure your client allows
for longer timeouts (e.g. 600 seconds when testing with the MCP
Inspector).

### Resources

The registry exposes a single read-only resource:

| URI                        | Description                         | Mime type            |
| -------------------------- | ----------------------------------- | -------------------- |
| `codex-registry://agents`  | JSON catalog of all available agents | `application/json` |

Clients calling `resources/list` will receive this catalog, eliminating
“method not found” warnings during the MCP handshake.

### Environment overrides

You can tweak how the registry launches Codex purely via environment
variables (see `.env.example` for ready-to-copy samples):

| Variable           | Description                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `CODEX_COMMAND`    | Absolute or relative path to the Codex CLI (defaults to `codex`).                             |
| `CODEX_MCP_ARGS`   | Extra arguments placed before `mcp-server` (supports quotes, e.g. `--profile "my profile"`).  |
| `CODEX_MCP_ENV`    | JSON object of additional environment vars passed to the Codex process.                       |
| `CODEX_MCP_CWD`    | Working directory for the Codex child process.                                                |

Example:

```bash
CODEX_COMMAND=/usr/local/bin/codex \
CODEX_MCP_ARGS='--profile internal --startup-timeout 180' \
CODEX_MCP_ENV='{"OPENAI_API_KEY":"sk-..."}' \
node dist/index.js
```

## Notes & Next Steps

- If new agents are added to the BMAD repository, simply restart the MCP
  registry to pick them up—no code changes are required.
- The project currently focuses on tools; adding resources or prompts to
  expose the same manifests through other MCP primitives is straight
  forward if needed.
- Consider extending the tool handler to return derived artifacts (e.g.
  quick-start prompts or workflow summaries) alongside the raw manifest.
