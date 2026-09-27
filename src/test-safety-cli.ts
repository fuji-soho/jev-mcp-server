#!/usr/bin/env node
import { verifySafetyProfile } from './test-safety-profile.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const cwdIndex = args.indexOf('--cwd');
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : undefined;
const inputIndex = args.indexOf('--input');
const inputPath = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
if ((cwdIndex >= 0 && !cwd) || (inputIndex >= 0 && !inputPath)) {
  console.error('Missing path after --cwd.');
  process.exitCode = 2;
} else {
  try {
    const input = inputPath === undefined
      ? { command: 'explicit human verification', ...(cwd === undefined ? {} : { cwd }) }
      : JSON.parse(readFileSync(inputPath, 'utf8')) as { command: string; cwd?: string };
    const result = verifySafetyProfile({ ...input, ...(cwd === undefined ? {} : { cwd }) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to verify Safety Profile.');
    process.exitCode = 1;
  }
}
