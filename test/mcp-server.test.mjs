import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('jev_check_test returns a structured missing-file tool error instead of -32602', async () => {
  const temporary = mkdtempSync('/tmp/jev-mcp-missing-file-');
  const project = join(temporary, 'project');
  mkdirSync(join(project, 'tests'), { recursive: true });
  const envPath = join(temporary, 'jev.env');
  writeFileSync(envPath, 'CLOUDFLARE_ACCOUNT_ID=test-account\nCLOUDFLARE_API_TOKEN=test-token\n');
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
  environment.JEV_ENV_PATH = envPath;
  environment.JEV_CACHE_DB_PATH = ':memory:';
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], cwd: process.cwd(), env: environment, stderr: 'pipe' });
  const client = new Client({ name: 'jev-test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'jev_check_test',
      arguments: { command: 'npm test', cwd: project, testFiles: ['tests/Missing.test.js'] },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.errorCode, 'TEST_FILE_VALIDATION_ERROR');
    assert.deepEqual(result.structuredContent?.categories, []);
    assert.equal(result.structuredContent?.riskScore, null);
    assert.equal(result.structuredContent?.policyVersion, 'unavailable');
    assert.deepEqual(result.structuredContent?.fileErrors, [{
      file: 'tests/Missing.test.js',
      code: 'TEST_FILE_NOT_FOUND',
      message: 'The requested test file does not exist under cwd in the MCP server filesystem.',
    }]);
  } finally {
    await client.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
