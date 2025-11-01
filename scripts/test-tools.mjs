import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SKIP_TOOLS = new Set(['codex-run', 'codex-reply', 'codex-close']);

async function main() {
  const client = new Client(
    {
      name: 'codex-registry-tool-tester',
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

  const tools = await client.listTools();
  console.log(`Discovered ${tools.tools.length} tools`);

  for (const tool of tools.tools) {
    if (SKIP_TOOLS.has(tool.name)) {
      console.log(`Skipping ${tool.name} (requires Codex CLI)`);
      continue;
    }
    process.stdout.write(`Invoking ${tool.name}... `);
    const result = await client.callTool({
      name: tool.name,
      arguments: {}
    });
    const textContent = result.content?.find((entry) => entry.type === 'text');
    console.log(
      textContent?.text?.split('\n')[0] ?? '[no text response]'
    );
  }

  await client.close();
}

main().catch((error) => {
  console.error('Tool test failed:', error);
  process.exit(1);
});
