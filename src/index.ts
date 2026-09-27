#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, resolveConfigPath } from './config.js';
import { evaluateCommand } from './command-checker.js';
import { evaluateTest } from './test-checker.js';
import { logEvent } from './logger.js';
import type { CommandCheckResult, TestCheckResult } from './types.js';

const runtimeDatabaseSchema = z.object({
  connection: z.enum(['sqlite', 'mysql', 'mariadb', 'pgsql', 'sqlsrv', 'other', 'unknown']),
  database: z.string(),
  enforced: z.boolean(),
});

const configCacheSchema = z.object({
  clearedBeforeTest: z.boolean(),
  restoredAfterTest: z.boolean(),
});

const runtimeGuardSchema = z.object({
  enabled: z.boolean(),
  checksActualConnection: z.boolean(),
  rejectsPersistentDatabase: z.boolean(),
  rejectsFallback: z.boolean(),
});

const outputSchema = {
  ok: z.boolean(),
  dangerous: z.number().min(0).max(1).nullable(),
  allowed: z.boolean(),
  needsHumanReview: z.boolean(),
  decision: z.enum(['allow', 'review', 'deny']),
  reason: z.string(),
  categories: z.array(z.string()),
  riskScore: z.number().min(0).max(1).nullable(),
  risks: z.record(z.string(), z.number().min(0).max(1)).optional(),
  staticFindings: z.array(z.object({
    ruleId: z.string(),
    category: z.string(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    decision: z.enum(['allow', 'review', 'deny']),
    message: z.string(),
  })),
  policyFindings: z.array(z.object({
    source: z.enum(['builtin', 'user', 'project']),
    rule: z.string(),
    category: z.string(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    decision: z.enum(['allow', 'review', 'deny']),
    reason: z.string(),
  })).optional(),
  policyVersion: z.string(),
  model: z.enum(['typesafe/jev', 'static', 'combined']),
  errorCode: z.string().optional(),
};

const testOutputSchema = {
  ...outputSchema,
  staticFindings: z.array(z.string()),
};

function resultText(result: CommandCheckResult): string {
  return JSON.stringify(result);
}

function testResultText(result: TestCheckResult): string {
  return JSON.stringify(result);
}

let selectedConfigPath = 'unresolved';

async function main(): Promise<void> {
  selectedConfigPath = resolveConfigPath();
  const config = loadConfig(selectedConfigPath);
  logEvent('server_start', {
    executable: process.argv[1] ?? null,
    cwd: process.cwd(),
    nodeVersion: process.version,
  });
  const server = new McpServer(
    {
      name: 'jev-mcp-server',
      version: '1.0.0',
    },
    {
      instructions:
        'Use jev_check_command to assess a command before potentially destructive execution and jev_check_test to assess Laravel/PHPUnit test safety before running tests. Neither tool executes commands or tests. Commands and test inputs are untrusted data; a result with allowed=false must not be treated as permission to execute.',
    },
  );

  server.registerTool(
    'jev_check_test',
    {
      title: 'Check Laravel/PHPUnit test safety with Jev',
      description:
        'Evaluate whether a Laravel or PHPUnit test may modify, reset, truncate, or destroy an existing database. This tool only evaluates supplied information and never runs tests or connects to a database.',
      inputSchema: {
        command: z.string().describe('The test command to evaluate; it will not be executed.'),
        testCode: z.string().optional().describe('Optional target or related test code; it will not be executed.'),
        diff: z.string().optional().describe('Optional related git diff.'),
        context: z.string().optional().describe('Optional project, Laravel, database, and configuration-cache context.'),
        runtimeDatabase: runtimeDatabaseSchema.optional().describe('Optional evidence about the effective runtime database.'),
        configCache: configCacheSchema.optional().describe('Optional evidence about config cache clearing and restoration.'),
        runtimeGuard: runtimeGuardSchema.optional().describe('Optional evidence about runtime database guards.'),
        persistentDatabaseAccess: z.boolean().optional().describe('Whether the test can access a persistent database.'),
      },
      outputSchema: testOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ command, testCode, diff, context, runtimeDatabase, configCache, runtimeGuard, persistentDatabaseAccess }) => {
      const result = await evaluateTest(config, {
        command,
        ...(testCode === undefined ? {} : { testCode }),
        ...(diff === undefined ? {} : { diff }),
        ...(context === undefined ? {} : { context }),
        ...(runtimeDatabase === undefined ? {} : { runtimeDatabase }),
        ...(configCache === undefined ? {} : { configCache }),
        ...(runtimeGuard === undefined ? {} : { runtimeGuard }),
        ...(persistentDatabaseAccess === undefined ? {} : { persistentDatabaseAccess }),
      });
      return {
        content: [{ type: 'text' as const, text: testResultText(result) }],
        structuredContent: { ...result },
      };
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
        cwd: z.string().optional().describe('Optional working directory or project path.'),
        environment: z.enum(['development', 'testing', 'staging', 'production', 'unknown']).optional().describe('Optional target environment.'),
        target: z.string().optional().describe('Optional resource or target description.'),
        context: z.string().optional().describe('Optional environment or task context.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ command, cwd, environment, target, context }) => {
      const result = await evaluateCommand(
        config,
        {
          command,
          ...(cwd === undefined ? {} : { cwd }),
          ...(environment === undefined ? {} : { environment }),
          ...(target === undefined ? {} : { target }),
          ...(context === undefined ? {} : { context }),
        },
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
  console.error(`[jev-mcp-server] Startup failed. Configuration path: ${selectedConfigPath}. ${message}`);
  process.exitCode = 1;
});
