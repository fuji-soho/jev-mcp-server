import { readFileSync } from 'node:fs';

const ENV_PATH = '/root/.config/jev-mcp/.env';

export interface Config {
  accountId: string;
  apiToken: string;
}

function parseEnvFile(contents: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    values.set(key, value);
  }

  return values;
}

function requiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) {
    throw new Error(`Missing required configuration: ${key}`);
  }
  return value;
}

export function loadConfig(path = ENV_PATH): Config {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Unable to read configuration file: ${path}`);
  }

  const values = parseEnvFile(contents);
  return {
    accountId: requiredValue(values, 'CLOUDFLARE_ACCOUNT_ID'),
    apiToken: requiredValue(values, 'CLOUDFLARE_API_TOKEN'),
  };
}

export const configPath = ENV_PATH;
