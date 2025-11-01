import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  const client = new Client(
    {
      name: 'codex-registry-smoke-client',
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

  const toolsResponse = await client.listTools();
  console.log(`Discovered ${toolsResponse.tools.length} tools`);

  if (toolsResponse.tools.length > 0) {
    const firstTool = toolsResponse.tools[0];
    console.log(`Calling tool ${firstTool.name}...`);
    const callResult = await client.callTool({
      name: firstTool.name,
      arguments: {}
    });
    console.log('Tool response content:', callResult.content);
  }

  await client.close();
}

main().catch((error) => {
  console.error('Smoke test failed:', error);
  process.exit(1);
});
