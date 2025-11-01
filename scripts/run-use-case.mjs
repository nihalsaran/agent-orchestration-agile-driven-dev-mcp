import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const agentId = process.argv[2] ?? 'bmm/agents/pm.md';
const prompt =
  process.argv.slice(3).join(' ') ||
  'Gather functional and non-functional requirements for a mobile habit-tracking app with social features.';

async function main() {
  console.log(`Connecting to MCP server for agent ${agentId}...`);
  console.log('Prompt:', prompt);
  const client = new Client(
    {
      name: 'codex-registry-use-case-runner',
      version: '0.1.0'
    },
    {
      capabilities: {}
    }
  );

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js']
  });

  await client.connect(transport);

  console.log('Invoking codex-run...');
  const result = await client.callTool({
    name: 'codex-run',
    arguments: {
      agentId,
      prompt
    }
  });

  console.log('codex-run content:');
  console.dir(result.content ?? [], { depth: null });
  console.log('Structured content:');
  console.dir(result.structuredContent ?? {}, { depth: null });

  await client.close();
}

main().catch((error) => {
  console.error('Use-case run failed:', error);
  process.exit(1);
});
