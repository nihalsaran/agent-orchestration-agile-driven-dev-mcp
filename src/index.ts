import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as ClientStdioTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type AgentSourceType = 'markdown' | 'xml';

interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  relativePath: string;
  manifestFormat: AgentSourceType;
  metadata: Record<string, string>;
  body: string;
  frontMatter?: string | null;
  raw: string;
  toolName?: string;
}

interface CodexSession {
  conversationId: string;
  client: McpClient;
  transport: ClientStdioTransport;
  agent: AgentDefinition;
}

const codexSessions = new Map<string, CodexSession>();

const toolArgsSchema = z.object({
  detail: z.enum(['body', 'raw']).optional(),
  includeFrontMatter: z.boolean().optional()
});

type ToolArgs = z.infer<typeof toolArgsSchema>;

const toolResultSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  description: z.string(),
  sourcePath: z.string(),
  manifestFormat: z.enum(['markdown', 'xml']),
  manifest: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
  body: z.string(),
  raw: z.string(),
  toolName: z.string().optional(),
  frontMatter: z.string().optional()
});

type ToolResult = z.infer<typeof toolResultSchema>;

async function pathExists(target: string | undefined): Promise<boolean> {
  if (!target) {
    return false;
  }
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function pickRootFromArgs(argv: string[]): string | undefined {
  if (argv.length === 0) {
    return undefined;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      return argv[index + 1];
    }
    if (arg.startsWith('--root=')) {
      return arg.slice('--root='.length);
    }
  }

  const firstValue = argv[0];
  if (!firstValue.startsWith('-')) {
    return firstValue;
  }

  return undefined;
}

async function resolveBmadRoot(): Promise<string> {
  const args = process.argv.slice(2);
  const explicitFromArgs = pickRootFromArgs(args);

  const candidates = [
    explicitFromArgs,
    process.env.BMAD_ROOT,
    path.resolve(process.cwd(), '../bmad-mcp/bmad'),
    path.resolve(process.cwd(), 'bmad')
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return path.resolve(candidate!);
    }
  }

  throw new Error(
    'Unable to locate BMAD agent directory. Provide a valid path via "--root <path>" argument or the BMAD_ROOT environment variable.'
  );
}

async function collectAgentFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
          return;
        }
        const subFiles = await collectAgentFiles(fullPath);
        files.push(...subFiles);
        return;
      }

      if (!entry.isFile()) {
        return;
      }

      if (fullPath.endsWith('.agent.xml') || fullPath.endsWith('.md')) {
        files.push(fullPath);
      }
    })
  );

  return files;
}

function extractFrontMatter(content: string): {
  metadata: Record<string, string>;
  body: string;
  frontMatter: string | null;
} {
  const frontMatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!frontMatterMatch) {
    return { metadata: {}, body: content.trim(), frontMatter: null };
  }

  const rawMetadata = frontMatterMatch[1];
  const frontMatter = frontMatterMatch[0].trim();
  const metadata: Record<string, string> = {};
  const lines = rawMetadata.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    metadata[key] = value;
  }

  const body = content.slice(frontMatterMatch[0].length).trim();
  return { metadata, body, frontMatter };
}

function createSlug(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'agent';
}

function splitArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const matches = value.match(/"([^"]*)"|'([^']*)'|[^\s]+/g);
  if (!matches) {
    return [];
  }

  return matches
    .map((segment) => {
      if (segment.startsWith('"') && segment.endsWith('"')) {
        return segment.slice(1, -1);
      }
      if (segment.startsWith("'") && segment.endsWith("'")) {
        return segment.slice(1, -1);
      }
      return segment;
    })
    .filter((segment) => segment.length > 0);
}

function substituteProjectRoot(input: string, projectRoot: string): string {
  return input
    .replaceAll('{project-root}', projectRoot)
    .replaceAll('{project_root}', projectRoot);
}

function parseCodexEnv(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        env[key] = value;
      } else if (value !== undefined && value !== null) {
        env[key] = String(value);
      }
    }
    return Object.keys(env).length > 0 ? env : undefined;
  } catch (error) {
    console.warn('Unable to parse CODEX_MCP_ENV JSON:', error);
    return undefined;
  }
}

function resolveCodexLaunch(): {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
} {
  const command = process.env.CODEX_COMMAND?.trim() || 'codex';
  const envArgs = splitArgs(process.env.CODEX_MCP_ARGS);
  let args = envArgs.length > 0 ? envArgs : ['mcp-server'];

  if (!args.includes('mcp-server')) {
    args = ['mcp-server', ...args];
  } else if (args[0] !== 'mcp-server') {
    const filtered = args.filter((part) => part !== 'mcp-server');
    args = ['mcp-server', ...filtered];
  }

  const env = parseCodexEnv(process.env.CODEX_MCP_ENV);
  const cwd = process.env.CODEX_MCP_CWD?.trim() || undefined;

  return { command, args, env, cwd };
}

function parseMarkdownAgent(
  absolutePath: string,
  relativePath: string,
  content: string
): AgentDefinition | null {
  const { metadata, body, frontMatter } = extractFrontMatter(content);
  const name = metadata.name;

  if (!name) {
    return null;
  }

  const description =
    metadata.description ||
    `Codex CLI agent registered from ${relativePath.replace(/\\/g, '/')}`;

  if (!body) {
    return null;
  }

  return {
    id: relativePath.replace(/\\/g, '/'),
    name,
    description,
    relativePath: relativePath.replace(/\\/g, '/'),
    manifestFormat: 'markdown',
    metadata,
    body,
    frontMatter,
    raw: content.trim()
  };
}

function parseXmlAgent(
  absolutePath: string,
  relativePath: string,
  content: string
): AgentDefinition | null {
  const nameMatch = content.match(/<agent\b[^>]*\bname="([^"]+)"/);
  const titleMatch = content.match(/<agent\b[^>]*\btitle="([^"]+)"/);
  const name = nameMatch?.[1] || path.basename(absolutePath);
  const description =
    titleMatch?.[1] ||
    `Codex CLI agent XML definition from ${relativePath.replace(/\\/g, '/')}`;

  return {
    id: relativePath.replace(/\\/g, '/'),
    name,
    description,
    relativePath: relativePath.replace(/\\/g, '/'),
    manifestFormat: 'xml',
    metadata: {},
    body: content.trim(),
    frontMatter: null,
    raw: content.trim()
  };
}

async function loadAgents(root: string): Promise<AgentDefinition[]> {
  const agentFiles = await collectAgentFiles(root);
  const agents: AgentDefinition[] = [];

  await Promise.all(
    agentFiles.map(async (absolutePath) => {
      const relativePath = path.relative(root, absolutePath);
      try {
        const content = await fs.readFile(absolutePath, 'utf8');
        if (absolutePath.endsWith('.md')) {
          const agent = parseMarkdownAgent(absolutePath, relativePath, content);
          if (agent) {
            agents.push(agent);
          }
          return;
        }
        if (absolutePath.endsWith('.xml')) {
          const agent = parseXmlAgent(absolutePath, relativePath, content);
          if (agent) {
            agents.push(agent);
          }
        }
      } catch (error) {
        console.error(`Failed to load agent file "${relativePath}":`, error);
      }
    })
  );

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return agents;
}

async function registerAgents(
  server: McpServer,
  agents: AgentDefinition[]
): Promise<Map<string, AgentDefinition>> {
  const seenNames = new Set<string>();
  const agentLookup = new Map<string, AgentDefinition>();

  for (const agent of agents) {
    const baseSlug = createSlug(agent.name);
    let toolName = baseSlug;
    let counter = 1;
    while (seenNames.has(toolName)) {
      counter += 1;
      toolName = `${baseSlug}-${counter}`;
    }
    seenNames.add(toolName);

    server.registerTool(
      toolName,
      {
        title: agent.name,
        description: agent.description
      },
      async (args: Partial<ToolArgs> = {}) => {
        const parsed = toolArgsSchema.parse(args ?? {});
        const detail = parsed.detail ?? 'body';
        const includeFrontMatter = parsed.includeFrontMatter ?? false;

        const summaryLines = [
          `Name: ${agent.name}`,
          `Source: ${agent.relativePath}`,
          `Format: ${agent.manifestFormat}`,
          `Detail: ${detail}`
        ];
        if (agent.description) {
          summaryLines.splice(1, 0, `Description: ${agent.description}`);
        }

    const manifest = detail === 'raw' ? agent.raw : agent.body;

    const structured: ToolResult = toolResultSchema.parse({
      agentId: agent.id,
      name: agent.name,
      description: agent.description,
      sourcePath: agent.relativePath,
      manifestFormat: agent.manifestFormat,
      manifest,
      metadata: includeFrontMatter ? agent.metadata : undefined,
      body: agent.body,
      raw: agent.raw,
      toolName,
      frontMatter: includeFrontMatter ? agent.frontMatter ?? undefined : undefined
    });

    return {
      content: [
            {
              type: 'text' as const,
              text: summaryLines.join('\n')
            }
          ],
        structuredContent: structured
      };
    }
  );

    agent.toolName = toolName;
    agentLookup.set(agent.id, agent);
    agentLookup.set(toolName, agent);
  }

  return agentLookup;
}

function registerAgentCatalogResource(server: McpServer, agents: AgentDefinition[]): void {
  const uri = 'codex-registry://agents';
  const catalog = () => ({
    generatedAt: new Date().toISOString(),
    agentCount: agents.length,
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      sourcePath: agent.relativePath,
      manifestFormat: agent.manifestFormat,
      toolName: agent.toolName
    }))
  });

  server.registerResource(
    'codex-agent-catalog',
    uri,
    {
      title: 'Codex Agent Catalog',
      description: 'Metadata for all Codex CLI agents exposed by this registry.',
      mimeType: 'application/json'
    },
    async () => ({
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(catalog(), null, 2)
        }
      ]
    })
  );
}

const codexRunArgsSchema = z.object({
  agentId: z.string(),
  prompt: z.string(),
  model: z.string().optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  approvalPolicy: z.enum(['untrusted', 'on-request', 'on-failure', 'never']).optional(),
  cwd: z.string().optional(),
  includePlanTool: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional()
});

const codexReplyArgsSchema = z.object({
  conversationId: z.string(),
  prompt: z.string()
});

const codexCloseArgsSchema = z.object({
  conversationId: z.string()
});

function registerCodexTools(
  server: McpServer,
  agentLookup: Map<string, AgentDefinition>,
  projectRoot: string
): void {
  server.registerTool(
    'codex-run',
    {
      title: 'Run Codex Agent',
      description:
        'Launches a Codex MCP session using the selected agent manifest as base instructions.'
    },
    async (rawArgs) => {
      const args = codexRunArgsSchema.parse(rawArgs ?? {});
      const agent = resolveAgent(args.agentId, agentLookup);

      const { session, result } = await launchCodexSession(agent, args, projectRoot);

      codexSessions.set(session.conversationId, session);

      const formattedContent = formatCodexContent(result);
      const structuredContent: Record<string, unknown> = {
        conversationId: session.conversationId,
        agentId: agent.id,
        toolName: agent.toolName,
        projectRoot,
        codexStructuredContent: result.structuredContent ?? null,
        codexMeta: (result as unknown as { meta?: unknown }).meta ?? null
      };

      return {
        content: formattedContent,
        structuredContent,
        ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {})
      } as any;
    }
  );

  server.registerTool(
    'codex-reply',
    {
      title: 'Continue Codex Agent Conversation',
      description: 'Sends a follow-up prompt to an existing Codex MCP conversation.'
    },
    async (rawArgs) => {
      const args = codexReplyArgsSchema.parse(rawArgs ?? {});
      const session = codexSessions.get(args.conversationId);

      if (!session) {
        throw new Error(`No active Codex session for conversation ${args.conversationId}`);
      }

      const rawResult = await session.client.callTool({
        name: 'codex-reply',
        arguments: {
          conversationId: args.conversationId,
          prompt: args.prompt
        }
      });
      const result = rawResult as unknown as CallToolResult;

      const formattedContent = formatCodexContent(result);
      const structuredContent: Record<string, unknown> = {
        conversationId: args.conversationId,
        agentId: session.agent.id,
        toolName: session.agent.toolName,
        projectRoot,
        codexStructuredContent: result.structuredContent ?? null,
        codexMeta: (result as unknown as { meta?: unknown }).meta ?? null
      };

      return {
        content: formattedContent,
        structuredContent,
        ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {})
      } as any;
    }
  );

  server.registerTool(
    'codex-close',
    {
      title: 'Close Codex Session',
      description: 'Terminates an active Codex MCP conversation and releases resources.'
    },
    async (rawArgs) => {
      const args = codexCloseArgsSchema.parse(rawArgs ?? {});
      const session = codexSessions.get(args.conversationId);

      if (!session) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Session ${args.conversationId} is not active.`
            }
          ]
        };
      }

      await shutdownCodexSession(session);
      codexSessions.delete(args.conversationId);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Session ${args.conversationId} closed.`
          }
        ]
      };
    }
  );
}

function resolveAgent(
  agentKey: string,
  agentLookup: Map<string, AgentDefinition>
): AgentDefinition {
  const agent = agentLookup.get(agentKey);
  if (agent) {
    return agent;
  }

  const fallback = [...agentLookup.values()].find(
    (candidate) => candidate.id === agentKey || candidate.name === agentKey
  );

  if (!fallback) {
    throw new Error(`Unknown agent identifier: ${agentKey}`);
  }

  return fallback;
}

async function launchCodexSession(
  agent: AgentDefinition,
  args: z.infer<typeof codexRunArgsSchema>,
  projectRoot: string
): Promise<{ session: CodexSession; result: CallToolResult }> {
  const client = new McpClient(
    {
      name: `codex-registry-${process.pid}`,
      version: '0.1.0'
    },
    {
      capabilities: {}
    }
  );

  const codexLaunch = resolveCodexLaunch();
  const launchEnv = { ...(codexLaunch.env ?? {}) };
  if (launchEnv.PROJECT_ROOT === undefined) {
    launchEnv.PROJECT_ROOT = projectRoot;
  }

  const transport = new ClientStdioTransport({
    command: codexLaunch.command,
    args: codexLaunch.args,
    env: launchEnv,
    cwd: codexLaunch.cwd ?? projectRoot
  });

  try {
    await client.connect(transport);
  } catch (error) {
    await shutdownCodexTransport(transport);
    throw new Error(
      `Failed to launch Codex MCP server via "${codexLaunch.command} ${codexLaunch.args.join(
        ' '
      )}". Ensure the Codex CLI is installed and accessible. (${String(error)})`
    );
  }

  try {
    const baseInstructions = substituteProjectRoot(agent.body, projectRoot);
    const codexArguments: Record<string, unknown> = {
      prompt: args.prompt,
      'base-instructions': baseInstructions,
      cwd: args.cwd ?? projectRoot
    };

    if (args.model) {
      codexArguments.model = args.model;
    }
    if (args.sandbox) {
      codexArguments.sandbox = args.sandbox;
    }
    if (args.approvalPolicy) {
      codexArguments['approval-policy'] = args.approvalPolicy;
    }
    if (typeof args.includePlanTool === 'boolean') {
      codexArguments['include-plan-tool'] = args.includePlanTool;
    }
    const configOverrides: Record<string, unknown> = { ...(args.config ?? {}) };
    if (!Object.prototype.hasOwnProperty.call(configOverrides, 'projectRoot')) {
      configOverrides.projectRoot = projectRoot;
    }
    if (Object.keys(configOverrides).length > 0) {
      codexArguments.config = configOverrides;
    }

    const rawResult = await client.callTool({
      name: 'codex',
      arguments: codexArguments
    });
    const result = rawResult as unknown as CallToolResult;

    const conversationId = extractConversationId(result);

    if (!conversationId) {
      await shutdownCodexSession({ client, transport, agent, conversationId: 'unknown' });
      throw new Error('Codex did not return a conversationId.');
    }

    const session: CodexSession = {
      conversationId,
      client,
      transport,
      agent
    };

    transport.onclose = () => {
      codexSessions.delete(conversationId);
    };
    transport.onerror = () => {
      codexSessions.delete(conversationId);
    };

    return { session, result };
  } catch (error) {
    await shutdownCodexSession({ client, transport, agent, conversationId: 'failed' });
    throw error;
  }
}

async function shutdownCodexTransport(transport: ClientStdioTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // noop
  }
}

async function shutdownCodexSession(session: CodexSession): Promise<void> {
  try {
    await session.client.close();
  } catch {
    // noop
  }
  await shutdownCodexTransport(session.transport);
}

function extractConversationId(result: CallToolResult): string | undefined {
  const direct = (result as unknown as { conversationId?: string }).conversationId;
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct;
  }

  const meta = (result as unknown as { meta?: { conversationId?: string } }).meta;
  if (meta && typeof meta.conversationId === 'string' && meta.conversationId.trim().length > 0) {
    return meta.conversationId;
  }

  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  const structuredId = structured?.conversationId ?? structured?.conversationID;
  if (typeof structuredId === 'string' && structuredId.trim().length > 0) {
    return structuredId;
  }

  return undefined;
}

function formatCodexContent(
  result: CallToolResult
): Array<{ type: 'text'; text: string; _meta?: Record<string, unknown> }> {
  if (!result.content || result.content.length === 0) {
    return [
      {
        type: 'text' as const,
        text: 'Codex completed without returning textual output.'
      }
    ];
  }

  const textItems = result.content.filter(
    (item): item is { type: 'text'; text: string; _meta?: Record<string, unknown> } =>
      item.type === 'text'
  );

  if (textItems.length > 0) {
    return textItems.map((item) => ({
      type: 'text' as const,
      text: item.text,
      _meta: item._meta as Record<string, unknown> | undefined
    }));
  }

  const summary = result.content.map((item) => item.type).join(', ');

  return [
    {
      type: 'text' as const,
      text: `Codex returned ${result.content.length} content item(s): ${summary}`
    }
  ];
}

async function main(): Promise<void> {
  try {
    const root = await resolveBmadRoot();
    const agents = await loadAgents(root);

    if (agents.length === 0) {
      console.error('No Codex CLI agent manifests were discovered.');
    }

    const server = new McpServer({
      name: 'codex-cli-agent-registry',
      version: '0.1.0'
    });

    const agentLookup = await registerAgents(server, agents);
    registerAgentCatalogResource(server, agents);
    registerCodexTools(server, agentLookup, root);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error('Fatal error while starting Codex MCP registry:', error);
    process.exit(1);
  }
}

void main();
