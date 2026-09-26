import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const ENV_PATH_ENV_VAR = 'JEV_ENV_PATH';

export interface Config {
  accountId: string;
  apiToken: string;
}

function commandLineEnvPath(args: readonly string[]): string | undefined {
  let path: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--env-file') {
      const next = args[index + 1]?.trim();
      if (!next) {
        throw new Error('Missing path after --env-file.');
      }
      path = next;
      index += 1;
      continue;
    }

    if (argument?.startsWith('--env-file=')) {
      const value = argument.slice('--env-file='.length).trim();
      if (!value) {
        throw new Error('Missing path after --env-file=.');
      }
      path = value;
      continue;
    }

    throw new Error(`Unknown command-line option: ${argument}`);
  }

  return path;
}

export function resolveConfigPath(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const cliPath = commandLineEnvPath(args);
  const environmentPath = environment[ENV_PATH_ENV_VAR]?.trim() || undefined;
  const selectedPath = cliPath ?? environmentPath ?? DEFAULT_ENV_PATH;
  return resolve(selectedPath);
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

export function loadConfig(path = resolveConfigPath()): Config {
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
