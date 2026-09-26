#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { configPath, loadConfig } from './config.js';
import { evaluateCommand } from './command-checker.js';
import type { CommandCheckResult } from './types.js';

const outputSchema = {
  ok: z.boolean(),
  dangerous: z.number().min(0).max(1).nullable(),
  allowed: z.boolean(),
  needsHumanReview: z.boolean(),
  decision: z.enum(['allow', 'review', 'deny']),
  reason: z.string(),
  model: z.literal('typesafe/jev'),
  errorCode: z.string().optional(),
};

function resultText(result: CommandCheckResult): string {
  return JSON.stringify(result);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer(
    {
      name: 'jev-mcp-server',
      version: '1.0.0',
    },
    {
      instructions:
        'Use jev_check_command to assess a command before potentially destructive execution. A result with allowed=false must not be treated as permission to execute.',
    },
  );

  server.registerTool(
    'jev_check_command',
    {
      title: 'Check command safety with Jev',
      description:
        'Evaluate whether a command may destroy or irreversibly modify existing data, databases, files, credentials, or systems.',
      inputSchema: {
        command: z.string().describe('The command to evaluate; it will not be executed.'),
        context: z.string().optional().describe('Optional environment or task context.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ command, context }) => {
      const result = await evaluateCommand(
        config,
        context === undefined ? { command } : { command, context },
      );
      return {
        content: [{ type: 'text' as const, text: resultText(result) }],
        structuredContent: { ...result },
      };
    },
  );

  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    console.error('[jev-mcp-server] STDIO transport error:', error.message);
  };
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error.';
  console.error(`[jev-mcp-server] Startup failed. Configuration path: ${configPath}. ${message}`);
  process.exitCode = 1;
});
