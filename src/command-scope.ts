import type { StaticFinding } from './types.js';

// A deliberately small grammar, not a shell parser. Match the entire raw command;
// never unwrap env/sudo/shells or accept an unknown command by name heuristics.
const SIMPLE_COMMAND = /^[A-Za-z0-9_./:=+-]+(?:[ \t]+[A-Za-z0-9_./:=+-]+)*(?![\s\S])/u;
const FILE_OPERATIONS = new Set(['ls', 'cat', 'mkdir', 'rmdir', 'touch', 'cp', 'mv', 'rm']);
const STATUS_OPTIONS = new Set(['--short', '-s', '--branch', '-b', '--show-stash', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--long', '--untracked-files', '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all', '--ignored', '--ignored=traditional', '--ignored=matching', '--ignored=no']);
const DIFF_OPTIONS = new Set(['--no-ext-diff', '--no-textconv', '--stat', '--name-only', '--name-status', '--cached', '--staged']);

export const COMMAND_SCOPE_REVIEW_MESSAGE = 'The command delegates to unreviewed code or is outside the supported direct-command syntax. Script bodies, dependencies, configuration, and dynamic execution are not evaluated; explicit human approval is required to execute with this unverified scope.';

export function commandScopeFindings(command: string): StaticFinding[] {
  const text = command.replace(/^[ \t]+|[ \t]+$/gu, '');
  if (SIMPLE_COMMAND.test(text)) {
    const [executable, ...args] = text.split(/[ \t]+/u);
    if ((executable !== undefined && FILE_OPERATIONS.has(executable)) || (executable === 'pwd' && args.every((arg) => arg === '-L' || arg === '-P'))) return [];
    if (executable === 'git') {
      const [subcommand, ...options] = args;
      if (subcommand === 'status' && options.every((arg) => STATUS_OPTIONS.has(arg))) return [];
      // Git diff can execute configured diff/textconv helpers unless disabled.
      if (subcommand === 'diff') {
        const separator = options.indexOf('--');
        const flags = separator < 0 ? options : options.slice(0, separator);
        if (flags.includes('--no-ext-diff') && flags.includes('--no-textconv') && flags.every((arg) => DIFF_OPTIONS.has(arg))) return [];
      }
    }
  }
  return [{ ruleId: 'command.execution-content-unreviewed', category: 'configuration', severity: 'medium', decision: 'review', message: COMMAND_SCOPE_REVIEW_MESSAGE }];
}
