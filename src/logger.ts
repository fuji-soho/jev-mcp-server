import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LOG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'log', 'jev.log');

function logPath(): string {
  return process.env.JEV_LOG_PATH?.trim() || DEFAULT_LOG_PATH;
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  };

  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown logging error';
    console.error('[jev-mcp-server] Unable to write log file:', message);
  }
}
