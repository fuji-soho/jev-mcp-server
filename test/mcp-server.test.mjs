import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('jev_check_test returns structured file errors and related-code findings through MCP', async () => {
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
    for (const dir of ['.jev', 'bin', 'app']) mkdirSync(join(project, dir));
    writeFileSync(join(project, 'bin/runner'), '#!/bin/sh\nexit 1\n');
    writeFileSync(join(project, 'tests/Safe.test.js'), 'act();\n');
    writeFileSync(join(project, 'app/service.js'), 'DROP DATABASE customer_records;\n');
    writeFileSync(join(project, '.jev/test-safety.json'), JSON.stringify({
      version: 2, name: 'mcp-related-review', framework: 'vitest', environment: 'testing',
      runner: { id: 'runner-v1', executable: 'bin/runner', files: ['bin/runner'], fixedArgs: [], shell: false, selectors: { filePatterns: ['tests/**'], allowFilter: true } },
      environmentFiles: [], codeReviewRoots: ['app'],
      resources: { database: { policy: 'deny', rejectFallback: true, rejectAdditionalConnections: true }, filesystem: { writableRoots: [] }, network: { policy: 'deny' }, credentials: { policy: 'deny' } },
    }));
    const argumentsV2 = { command: 'bin/runner', cwd: project, environment: 'testing', framework: 'vitest', testFiles: ['tests/Safe.test.js'], execution: { runnerId: 'runner-v1', files: ['tests/Safe.test.js'] } };
    const denied = await client.callTool({ name: 'jev_check_test', arguments: argumentsV2 });
    assert.equal(denied.structuredContent.decision, 'deny');
    assert.ok(denied.structuredContent.findings.some((finding) => finding.file === 'app/service.js'));
    assert.ok(denied.structuredContent.policyFindings.some((finding) => finding.file === 'app/service.js'));
    assert.equal(JSON.stringify(denied).includes('customer_records'), false);
    writeFileSync(join(project, 'app/service.js'), Buffer.from([0xff]));
    const incomplete = await client.callTool({ name: 'jev_check_test', arguments: argumentsV2 });
    assert.equal(incomplete.structuredContent.errorCode, 'RELATED_CODE_REVIEW_INCOMPLETE');
    assert.equal(incomplete.structuredContent.allowed, false);
    assert.equal(incomplete.structuredContent.reviewId, undefined);
    assert.equal(incomplete.structuredContent.environmentReviewId, undefined);
    assert.equal(incomplete.structuredContent.executionAssessment.ticket, undefined);
  } finally {
    await client.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
