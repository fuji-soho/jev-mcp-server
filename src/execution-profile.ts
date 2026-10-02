import { lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { SaxesParser } from 'saxes';
import { canonicalJson, digestPaths, projectId, readRelatedCode, relativeTarget, resolveTestRoot, sha256, type RelatedCodeFile } from './safety-fingerprint.js';
import { loadEffectivePolicies, loadEffectiveTestPolicies } from './policy.js';
import type { TestCheckInput } from './types.js';

export const EXECUTION_VERIFIER_VERSION = 'jev-test-execution-v1';
const pathSchema = z.string().min(1).max(4000).refine(p => /^[a-zA-Z0-9_./-]+$/u.test(p) && !isAbsolute(p) && p !== '.' && !p.split('/').includes('..'));
const patternSchema = z.string().min(1).max(4000).refine(p => /^[a-zA-Z0-9_./*-]+$/u.test(p) && !isAbsolute(p) && p !== '.' && !p.split('/').includes('..'));
const executableSchema = z.string().refine(p => isAbsolute(p) && /^[a-zA-Z0-9_./+-]+$/u.test(p));
const paths = z.array(pathSchema).max(128);
export const executionProfileSchema = z.object({
  version: z.literal(3), name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/u),
  framework: z.literal('laravel'), environment: z.literal('testing'),
  entry: z.discriminatedUnion('adapter', [
    z.object({ adapter: z.literal('composer-script'), script: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u) }).strict(),
    z.object({ adapter: z.literal('php-runner') }).strict(),
  ]),
  runner: z.object({ file: pathSchema, safetyFiles: paths, testEntry: pathSchema.default('vendor/bin/phpunit') }).strict(),
  selectors: z.object({ filePatterns: z.array(patternSchema).min(1).max(128), allowFilter: z.boolean(), allowFullSuite: z.boolean() }).strict(),
  environmentFiles: paths, codeReviewRoots: paths,
  runtime: z.object({ php: executableSchema, composer: executableSchema.optional(),
    composerHome: z.string().refine(isAbsolute).optional(), configFiles: z.array(z.string().refine(isAbsolute)).max(128) }).strict(),
  resources: z.object({
    database: z.object({ policy: z.literal('sqlite-memory'), rejectFallback: z.literal(true), rejectAdditionalConnections: z.literal(true) }).strict(),
    filesystem: z.object({ writableRoots: paths }).strict(),
    network: z.object({ policy: z.literal('deny') }).strict(), credentials: z.object({ policy: z.literal('deny') }).strict(),
  }).strict(),
}).strict();
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

export class ExecutionEvidenceError extends Error {
  constructor(public readonly code: string, message: string, public readonly file?: string, public readonly evidence: RelatedCodeFile[] = []) { super(message); }
}
function stop(code: string, message: string, file?: string): never { throw new ExecutionEvidenceError(code, message, file); }

/** This detector never follows a profile symlink or interprets a broken v3 profile as absent. */
export function usesExecutionProfile(input: TestCheckInput): boolean {
  const path = input.safetyProfilePath ? resolve(input.safetyProfilePath) : resolve(input.cwd ?? process.cwd(), '.jev/test-safety.json');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return true;
    const bytes = readFileSync(path);
    if (bytes.length > 64 * 1024) return true;
    return (JSON.parse(bytes.toString('utf8')) as { version?: unknown }).version === 3;
  } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

function readProjectFiles(root: string, files: string[]): RelatedCodeFile[] {
  const snapshot = readRelatedCode(root, files);
  if (snapshot.status !== 'complete') throw new ExecutionEvidenceError('EXECUTION_EVIDENCE_INCOMPLETE', snapshot.reason, undefined, snapshot.files);
  return snapshot.files;
}
function jsonFile(root: string, file: string): Record<string, unknown> {
  const value = readProjectFiles(root, [file])[0];
  try {
    const parsed: unknown = JSON.parse(value!.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { return stop('EXECUTION_EVIDENCE_INCOMPLETE', 'Required execution metadata is not a JSON object.', file); }
}
function optionalDigest(path: string): string {
  try {
    let component = resolve('/');
    for (const part of resolve(path).split('/').filter(Boolean)) {
      component = join(component, part);
      if (lstatSync(component).isSymbolicLink()) throw new Error();
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error();
    return sha256(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    return stop('EXECUTION_EVIDENCE_INCOMPLETE', 'Runtime metadata cannot be read as a regular file.');
  }
}
function assertNamedExecutable(name: string, configured: string): void {
  const found = (process.env.PATH ?? '').split(':').map(p => resolve(p, name)).find(p => {
    try { return lstatSync(p).isFile() || lstatSync(p).isSymbolicLink(); } catch { return false; }
  });
  if (!found || realpathSync(found) !== realpathSync(configured)) stop('EXECUTION_CONTEXT_MISMATCH', 'Named executable resolution differs from runtime configuration. Use the configured absolute executable path.');
}
function assertComposerPhp(composer: string, php: string): void {
  const firstLine = readFileSync(realpathSync(composer)).subarray(0, 1024).toString('utf8').split('\n')[0]!;
  const interpreter = firstLine.match(/^#!\s*(\/[^\s]+)(?:\s+([^\s]+))?\s*$/u);
  if (!interpreter) stop('EXECUTION_CHAIN_UNRESOLVED', 'Initial Composer support requires an inspectable PHP shebang interpreter.');
  if (interpreter[1] === '/usr/bin/env' && interpreter[2] === 'php') assertNamedExecutable('php', php);
  else {
    try { if (interpreter[2] || realpathSync(interpreter[1]!) !== realpathSync(php)) throw new Error(); }
    catch { stop('EXECUTION_CONTEXT_MISMATCH', 'Composer shebang does not select the configured PHP executable.'); }
  }
}
function executableDigest(path: string): { path: string; digest: string } {
  try {
    const actual = realpathSync(path);
    const stat = lstatSync(actual);
    if (!stat.isFile() || !(stat.mode & 0o111) || stat.size > 128 * 1024 * 1024) throw new Error();
    return { path: actual, digest: sha256(readFileSync(actual)) };
  } catch { return stop('EXECUTION_RUNTIME_UNAVAILABLE', 'Configured PHP/Composer executable cannot be inspected.'); }
}
function glob(pattern: string, file: string): boolean {
  const escaped = pattern.split('**').map(p => p.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^/]*')).join('.*');
  return new RegExp(`^${escaped}$`, 'u').test(file);
}

/** No shell interpretation. Quotes are supported only as literal, non-expanding token delimiters. */
export function executionTokens(command: string): string[] {
  if (command.length > 16_000 || /[\0\r\n$`;&|<>\\]/u.test(command)) stop('UNSUPPORTED_EXECUTION_FORM', 'Shell operators, expansion, escapes and wrappers are unsupported. Use the exact local Composer/PHP invocation.');
  const tokens: string[] = [];
  const regex = /(?:^|[ \t]+)(?:"([^"\n]*)"|'([^'\n]*)'|([^ \t'"\n]+))(?=$|[ \t])/gu;
  let consumed = 0;
  for (const match of command.matchAll(regex)) {
    if (match.index !== consumed) stop('UNSUPPORTED_EXECUTION_FORM', 'The command cannot be tokenized completely.');
    if (match[3] !== undefined && !/^[a-zA-Z0-9_./:=+@-]+$/u.test(match[3])) stop('UNSUPPORTED_EXECUTION_FORM', 'Unquoted shell metacharacters are unsupported. Quote literal filter values.');
    tokens.push(match[1] ?? match[2] ?? match[3]!); consumed = match.index + match[0].length;
  }
  if (command.slice(consumed).trim() || !tokens.length) stop('UNSUPPORTED_EXECUTION_FORM', 'The command cannot be tokenized completely.');
  return tokens;
}

function composerChain(root: string, profile: ExecutionProfile): { calls: string[]; files: string[]; invocation: string[] } {
  const composer = jsonFile(root, 'composer.json');
  const config = composer.config as Record<string, unknown> | undefined;
  if (config && ((config['vendor-dir'] !== undefined && config['vendor-dir'] !== 'vendor') || (config['bin-dir'] !== undefined && config['bin-dir'] !== 'vendor/bin'))) stop('EXECUTION_CHAIN_UNRESOLVED', 'Custom Composer vendor/bin directories are unsupported.', 'composer.json');
  const scripts = composer.scripts as Record<string, unknown> | undefined;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) stop('EXECUTION_CHAIN_UNRESOLVED', 'composer.json must define the selected script.', 'composer.json');
  // These may alter a custom command before the known script graph is reached.
  for (const event of ['init', 'command', 'pre-command-run']) if (scripts[event] !== undefined) stop('EXECUTION_CHAIN_UNRESOLVED', 'Composer event handlers are unsupported in the initial adapter.', 'composer.json');
  const calls: string[] = [], leaves: string[][] = [];
  const active = new Set<string>();
  const visit = (name: string, depth: number): void => {
    if (depth > 16 || active.has(name) || calls.length >= 64) stop('EXECUTION_CHAIN_UNRESOLVED', 'Composer script references contain a cycle or exceed the traversal limit.', 'composer.json');
    active.add(name);
    const value = scripts[name];
    const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    if (!items.length || items.some(v => typeof v !== 'string')) stop('EXECUTION_CHAIN_UNRESOLVED', 'Every Composer script handler must be a supported command string.', 'composer.json');
    for (const item of items as string[]) {
      const tokens = executionTokens(item);
      calls.push(item);
      if (tokens.length === 1 && tokens[0]!.startsWith('@') && tokens[0] !== '@php') visit(tokens[0]!.slice(1), depth + 1);
      else if ((tokens[0] === '@php' || tokens[0] === 'php' || tokens[0] === profile.runtime.php) && tokens[1] === profile.runner.file && tokens.length === 2) leaves.push(tokens);
      else stop('EXECUTION_CHAIN_UNRESOLVED', 'Only script references and the configured PHP safe runner are supported; every array element must be resolved.', 'composer.json');
    }
    active.delete(name);
  };
  if (profile.entry.adapter !== 'composer-script') throw new Error('Wrong adapter');
  visit(profile.entry.script, 0);
  if (leaves.length !== 1) stop('EXECUTION_CHAIN_UNRESOLVED', 'The initial adapter requires exactly one safe-runner invocation.', 'composer.json');
  return { calls, files: ['composer.json'], invocation: leaves[0]! };
}

export function resolveComposerHome(): string {
  if (process.env.COMPOSER_HOME) return resolve(process.env.COMPOSER_HOME);
  const home = process.env.HOME || homedir();
  const usesXdg = Object.keys(process.env).some(k => k.startsWith('XDG_')) || (() => { try { return lstatSync('/etc/xdg').isDirectory(); } catch { return false; } })();
  const candidates = [...(usesXdg ? [join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'composer')] : []), join(home, '.composer')];
  return candidates.find(p => { try { return lstatSync(p).isDirectory(); } catch { return false; } }) ?? candidates[0]!;
}

function assertNoPlugins(root: string, home: string, noPlugins: boolean): Array<{ path: string; digest: string }> {
  const globalFiles = ['config.json', 'composer.json', 'composer.lock', 'vendor/composer/installed.json'];
  const manifests = [join(root, 'composer.lock'), join(root, 'vendor/composer/installed.json'), ...globalFiles.map(p => join(home, p))];
  const result = manifests.map(path => ({ path, digest: optionalDigest(path) }));
  for (const entry of result) {
    if (entry.digest === 'absent') continue;
    let text: string;
    try {
      text = readFileSync(entry.path, 'utf8');
      const metadata = JSON.parse(text) as { config?: Record<string, unknown> };
      if (metadata.config && ['vendor-dir','bin-dir'].some(k => metadata.config![k] !== undefined)) stop('EXECUTION_CHAIN_UNRESOLVED', 'Global Composer vendor/bin overrides are unsupported.');
    }
    catch { return stop('EXECUTION_EVIDENCE_INCOMPLETE', 'Composer plugin metadata is unreadable or invalid.'); }
    if (!noPlugins && /"type"\s*:\s*"composer-plugin"/u.test(text)) stop('EXECUTION_PLUGINS_UNSUPPORTED', 'An installed/global Composer plugin may change execution. Disable plugins explicitly and recheck.');
  }
  return result;
}

function phpunitConfiguration(xml: string): { selectors: Array<{ path: string; suffix: string }>; bootstrap?: string } {
  const stack: string[] = [], selectors: Array<{ path: string; suffix: string }> = [];
  let bootstrap: string | undefined, capture: { path: string; suffix: string } | undefined;
  const parser = new SaxesParser();
  parser.on('doctype', () => stop('EXECUTION_TARGET_UNRESOLVED', 'PHPUnit DTDs and external entities are unsupported.'));
  parser.on('opentag', tag => {
    if (tag.name === 'phpunit') {
      if (Object.keys(tag.attributes).some(k => /Loader|Extension/u.test(k))) stop('EXECUTION_TARGET_UNRESOLVED', 'Custom PHPUnit loaders are unsupported.');
      bootstrap = tag.attributes.bootstrap;
    }
    if (['exclude', 'extension', 'extensions'].includes(tag.name)) stop('EXECUTION_TARGET_UNRESOLVED', 'PHPUnit exclusions and extensions are unsupported.');
    if (stack.includes('testsuites') && !['testsuite','directory','file'].includes(tag.name)) stop('EXECUTION_TARGET_UNRESOLVED', 'Unsupported element inside testsuites.');
    if (tag.name === 'directory' || tag.name === 'file') {
      if (stack.at(-1) === 'testsuite') capture = { path: '', suffix: tag.attributes.suffix ?? (tag.name === 'file' ? '' : 'Test.php') };
    }
    stack.push(tag.name);
  });
  parser.on('text', text => { if (capture) capture.path += text; });
  parser.on('cdata', text => { if (capture) capture.path += text; });
  parser.on('closetag', () => {
    const tag = stack.pop();
    if (capture && (tag === 'directory' || tag === 'file')) { capture.path = capture.path.trim(); selectors.push(capture); capture = undefined; }
  });
  try { parser.write(xml).close(); }
  catch (error) {
    if (error instanceof ExecutionEvidenceError) throw error;
    stop('EXECUTION_TARGET_UNRESOLVED', 'PHPUnit configuration is not well-formed XML.');
  }
  return { selectors, ...(bootstrap === undefined ? {} : { bootstrap }) };
}

function suiteFiles(root: string, selectors: Array<{ path: string; suffix: string }>, patterns: string[]): string[] {
  const files = new Set<string>(); let entries = 0;
  const visit = (path: string, suffix: string): void => {
    const key = relativeTarget(root, path);
    if (!key || path.split('/').includes('..') || isAbsolute(path)) stop('EXECUTION_TARGET_UNRESOLVED', 'A suite path escapes the project.');
    let absolute = root;
    try {
      for (const part of key.split('/')) { absolute = resolve(absolute, part); if (lstatSync(absolute).isSymbolicLink()) throw new Error(); }
      if (++entries > 4096) stop('EXECUTION_TARGET_UNRESOLVED', 'Suite traversal exceeds 4096 entries.');
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) { for (const child of readdirSync(absolute).sort()) visit(`${key}/${child}`, suffix); }
      else if (!stat.isFile()) throw new Error();
      else if (key.endsWith(suffix)) {
        if (!patterns.some(p => glob(p, key))) stop('EXECUTION_SELECTOR_OUTSIDE_SCOPE', 'A suite contains a test outside the approved selector scope.', key);
        files.add(key); if (files.size > 128) stop('EXECUTION_TARGET_UNRESOLVED', 'Suite exceeds 128 test files.');
      }
    } catch (error) {
      if (error instanceof ExecutionEvidenceError) throw error;
      stop('EXECUTION_EVIDENCE_INCOMPLETE', 'Suite paths must be readable and symlink-free.', key);
    }
  };
  for (const selector of selectors) visit(selector.path, selector.suffix);
  if (!selectors.length || !files.size) stop('EXECUTION_TARGET_UNRESOLVED', 'The full suite has no resolvable test files.');
  return [...files].sort();
}

export interface ExecutionSnapshot {
  root: string; profilePath: string; profile: ExecutionProfile; fingerprint: string; policyHash: string;
  scope: Record<string, unknown>; evidence: RelatedCodeFile[]; related: RelatedCodeFile[];
  dependencyFingerprint: string; files: string[]; executionFingerprint: string; baseCommand: string;
}

export function snapshotExecution(input: TestCheckInput, approvalOnly = false): ExecutionSnapshot {
  const resolved = resolveTestRoot(input.cwd ?? process.cwd());
  if (!resolved.ok) stop(resolved.code, resolved.message);
  const root = resolved.root;
  const profilePath = input.safetyProfilePath ? relativeTarget(root, resolve(input.safetyProfilePath)) : '.jev/test-safety.json';
  if (!profilePath) stop('INVALID_EXECUTION_PROFILE', 'The execution profile must be inside cwd.');
  const rawProfile = readProjectFiles(root, [profilePath])[0]!;
  let profile: ExecutionProfile;
  try { profile = executionProfileSchema.parse(JSON.parse(rawProfile.content)); }
  catch { return stop('INVALID_EXECUTION_PROFILE', 'Profile v3 has an invalid schema. Supply runtime paths, safety files, selectors and resource scope.', profilePath); }
  if (input.framework !== profile.framework || input.environment !== profile.environment) stop('EXECUTION_CONTEXT_MISMATCH', 'framework=laravel and environment=testing must match Profile v3.');
  if (input.execution || input.environmentApprovalId) stop('EXECUTION_CONTEXT_MISMATCH', 'Profile v2 execution/Environment Approval fields cannot be mixed with Profile v3.');
  const tokens = executionTokens(input.command);
  let args: string[], baseCommand: string, chain: string[], definitionFiles: string[] = [];
  let composerRuntime: Record<string, unknown> | undefined;
  if (profile.entry.adapter === 'composer-script') {
    if (!profile.runtime.composer) stop('INVALID_EXECUTION_PROFILE', 'Composer runtime executable is required.');
    const command = tokens.shift();
    if (command !== 'composer' && command !== profile.runtime.composer) stop('UNSUPPORTED_EXECUTION_FORM', 'The configured local Composer executable must be invoked directly.');
    if (command === 'composer') assertNamedExecutable('composer', profile.runtime.composer);
    const noPlugins = tokens[0] === '--no-plugins'; if (noPlugins) tokens.shift();
    const runScript = tokens[0] === 'run-script'; if (runScript) tokens.shift();
    if (tokens.shift() !== profile.entry.script) stop('EXECUTION_SELECTOR_OUTSIDE_SCOPE', 'The requested Composer script is outside the configured entry scope.');
    if (tokens.length && tokens.shift() !== '--') stop('UNSUPPORTED_EXECUTION_FORM', 'Pass selector arguments after Composer --.');
    args = tokens;
    baseCommand = `${command}${noPlugins ? ' --no-plugins' : ''}${runScript ? ' run-script' : ''} ${profile.entry.script}`;
    const resolvedChain = composerChain(root, profile); chain = resolvedChain.calls; definitionFiles = resolvedChain.files;
    if (resolvedChain.invocation[0] === 'php') assertNamedExecutable('php', profile.runtime.php);
    assertComposerPhp(profile.runtime.composer, profile.runtime.php);
    const home = resolveComposerHome();
    if (profile.runtime.composerHome && resolve(profile.runtime.composerHome) !== home) stop('EXECUTION_CONTEXT_MISMATCH', 'Declared Composer home differs from the current runtime. Set COMPOSER_HOME consistently in MCP and execution or correct runtime.composerHome.');
    if (process.env.COMPOSER && resolve(process.env.COMPOSER) !== join(root, 'composer.json')) stop('EXECUTION_CONTEXT_MISMATCH', 'COMPOSER redirects the project definition. Remove the override and recheck.');
    composerRuntime = { executable: executableDigest(profile.runtime.composer), home: resolve(home), noPlugins, metadata: assertNoPlugins(root, home, noPlugins) };
  } else {
    if ((tokens[0] !== 'php' && tokens[0] !== profile.runtime.php) || tokens[1] !== profile.runner.file) stop('UNSUPPORTED_EXECUTION_FORM', 'Invoke the configured PHP safe runner directly.');
    if (tokens[0] === 'php') assertNamedExecutable('php', profile.runtime.php);
    args = tokens.slice(2); if (args[0] === '--') args.shift();
    baseCommand = `${tokens[0]} ${profile.runner.file}`; chain = [baseCommand];
  }
  const selected: string[] = []; let filter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--filter' && profile.selectors.allowFilter && filter === undefined && args[i + 1]) {
      filter = args[++i]!;
      if (filter.length > 1000 || filter.startsWith('-')) stop('EXECUTION_SELECTOR_OUTSIDE_SCOPE', 'Filter exceeds 1000 characters or resembles an option.');
    } else {
      if (!/^[a-zA-Z0-9_./-]+\.php$/u.test(arg) || arg.startsWith('-') || arg.split('/').includes('..') || !profile.selectors.filePatterns.some(p => glob(p, arg))) stop('EXECUTION_SELECTOR_OUTSIDE_SCOPE', 'Only approved relative PHP test files and --filter are permitted.');
      selected.push(arg);
    }
  }
  if (new Set(selected).size !== selected.length) stop('EXECUTION_SELECTOR_OUTSIDE_SCOPE', 'Duplicate selectors are not permitted.');
  const configuration = profile.environmentFiles.find(p => /(?:^|\/)phpunit\.xml(?:\.dist)?$/u.test(p));
  if (!configuration) stop('INVALID_EXECUTION_PROFILE', 'environmentFiles must include the PHPUnit configuration.');
  const xml = readProjectFiles(root, [configuration])[0]!.content;
  const xmlConfig = phpunitConfiguration(xml), bootstrap = xmlConfig.bootstrap;
  const autoFiles = ['composer.lock', 'vendor/composer/installed.json', 'vendor/composer/autoload_files.php', 'vendor/composer/autoload_real.php', 'vendor/composer/autoload_static.php', '.env', '.env.testing', 'bootstrap/cache/config.php', 'tests/TestCase.php'];
  const autoManifest = autoFiles.map(file => ({ file, digest: optionalDigest(join(root, file)) }));
  for (const file of ['composer.lock', 'vendor/composer/installed.json']) {
    if (autoManifest.find(f => f.file === file)?.digest === 'absent') stop('EXECUTION_EVIDENCE_INCOMPLETE', 'Installed dependency metadata is required.', file);
  }
  let vendorFingerprint: string;
  try { vendorFingerprint = digestPaths(root, ['vendor']).fingerprint; }
  catch { return stop('EXECUTION_DEPENDENCY_INCOMPLETE', 'Installed vendor dependencies must be readable, symlink-free and within 20000 files, 40000 entries and 8 MiB per file. Reinstall or correct the dependency scope.'); }
  const evidencePaths = [...definitionFiles, profile.runner.file, ...profile.runner.safetyFiles, ...profile.environmentFiles, ...(bootstrap ? [bootstrap] : []), profile.runner.testEntry];
  const evidence = readProjectFiles(root, [...new Set(evidencePaths)]);
  const runner = evidence.find(f => f.key === profile.runner.file)!;
  if (!runner.content.includes(profile.runner.testEntry)) stop('EXECUTION_CHAIN_UNRESOLVED', 'The runner source must reference the declared PHPUnit entry; confirm its complete invocation and argument forwarding.', profile.runner.file);
  for (const file of profile.runner.safetyFiles) if (!runner.content.includes(file) && !runner.content.includes(file.split('/').at(-1)!)) stop('EXECUTION_CHAIN_UNRESOLVED', 'The runner must reference every declared safety file; confirm the guard loading path.', profile.runner.file);
  // The PHP runner is a human-reviewed boundary, not an arbitrary shell resolver.
  if (/\b(?:eval|shell_exec|passthru|system)\s*\(|\b(?:sh|bash)\s+-[lc]/u.test(runner.content)) stop('EXECUTION_CHAIN_UNRESOLVED', 'Dynamic shell/eval execution inside the runner is unsupported.', profile.runner.file);
  let files: string[] = [];
  if (!approvalOnly) {
    if (selected.length) files = [...selected].sort();
    else {
      if (!profile.selectors.allowFullSuite) stop('EXECUTION_SELECTOR_OUTSIDE_SCOPE', 'This profile does not approve full-suite execution.');
      files = suiteFiles(root, xmlConfig.selectors, profile.selectors.filePatterns);
    }
    if (input.testFiles !== undefined) {
      const supplied = input.testFiles.map(f => relativeTarget(root, f));
      if (supplied.some(f => !f) || canonicalJson([...supplied].sort()) !== canonicalJson(files)) stop('EXECUTION_TARGET_MISMATCH', 'testFiles must equal the files selected by the actual command. Do not supply a subset for a full-suite invocation.');
    }
    if (input.testCode !== undefined) stop('EXECUTION_TARGET_MISMATCH', 'Profile v3 reads actual test files; omit inline testCode.');
  }
  const relatedSnapshot = readRelatedCode(root, [...profile.codeReviewRoots, ...evidencePaths]);
  if (relatedSnapshot.status !== 'complete') throw new ExecutionEvidenceError('RELATED_CODE_REVIEW_INCOMPLETE', relatedSnapshot.reason, undefined, [...evidence, ...relatedSnapshot.files]);
  const commandPolicies = loadEffectivePolicies(root), testPolicies = loadEffectiveTestPolicies(root, profile.framework);
  const policyHash = sha256(canonicalJson({ command: commandPolicies.hash, test: testPolicies.hash }));
  const runtimeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PHP|COMPOSER|APP_|DB_|XDG_CONFIG_HOME)/u.test(key)).map(([key, value]) => [key, sha256(value ?? '')]));
  const manifest = evidence.map(({ key, digest, bytes }) => ({ key, digest, bytes }));
  const fingerprint = sha256(canonicalJson({ version: EXECUTION_VERIFIER_VERSION, project: projectId(root), profileDigest: rawProfile.digest,
    baseCommand, chain: chain.map(v => sha256(v)), manifest, autoManifest, vendorFingerprint, policyHash,
    runtime: { php: executableDigest(profile.runtime.php), composer: composerRuntime ?? null,
      config: profile.runtime.configFiles.map(path => {
        const digest = optionalDigest(path);
        if (digest === 'absent') stop('EXECUTION_EVIDENCE_INCOMPLETE', 'A declared runtime configuration file is missing.');
        return { path, digest };
      }), environment: runtimeEnvironment } }));
  const scope = { projectRoot: root, name: profile.name, command: baseCommand, chain, entry: profile.entry, runner: profile.runner, selectors: profile.selectors,
    resources: profile.resources, files: manifest.map(f => f.key), runtime: profile.runtime, composerPluginMode: composerRuntime?.noPlugins ? 'disabled' : 'absence-inspected',
    reviewBoundary: 'Review the complete PHP runner, guard loading, PHPUnit invocation and argument forwarding. This is not automatic PHP dependency resolution.' };
  return { root, profilePath, profile, fingerprint, policyHash, scope, evidence, related: relatedSnapshot.files,
    dependencyFingerprint: relatedSnapshot.fingerprint, files, executionFingerprint: sha256(canonicalJson({ command: sha256(input.command), files, filter: filter === undefined ? null : sha256(filter), fingerprint })), baseCommand };
}
