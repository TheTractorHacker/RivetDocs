#!/usr/bin/env node
/**
 * RivetDocs MCP server (stdio).
 *
 *   RIVETDOCS_URL=https://rivetdocs.example.com \
 *   RIVETDOCS_API_KEY=ws_… \
 *   rivetdocs-mcp
 *
 * There is no password-reveal tool. Decrypted credentials never go to a
 * model: tool results land in the provider's context and in transcripts.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseConfig, RivetDocsClient } from './client.js';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const server = new McpServer({ name: 'rivetdocs', version: '0.1.0' });
  registerTools(server, new RivetDocsClient(config));
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout is the MCP channel; diagnostics go to stderr. Config errors never
  // contain the key (parseConfig only names the variable).
  process.stderr.write(`rivetdocs-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
