import Engine from 'php-parser';

interface Ast { kind: string; [key: string]: unknown; }
interface Item { node: Ast; parents: Ast[]; }
export interface RunnerProcess {
  api: 'passthru' | 'proc_open'; executable: 'PHP_BINARY'; arguments: string[];
  forwarding: 'none' | 'escaped-selectors' | 'argv-array';
}
export interface RunnerReview { processes: RunnerProcess[]; needsLaravelBootstrap: boolean; }

function ast(value: unknown): Ast | undefined {
  return value !== null && typeof value === 'object' && 'kind' in value && typeof value.kind === 'string' ? value as Ast : undefined;
}
function list(value: unknown): Ast[] { return Array.isArray(value) ? value.flatMap(v => ast(v) ?? []) : []; }
function variable(value: unknown): string | undefined { const n = ast(value); return n?.kind === 'variable' && typeof n.name === 'string' ? n.name : undefined; }
function rootVariable(value: unknown): string | undefined { let n = ast(value); while (n?.kind === 'offsetlookup') n = ast(n.what); return variable(n); }
function phpBinary(value: unknown): boolean { const n = ast(value); return n?.kind === 'name' && typeof n.name === 'string' && n.name.replace(/^\\/u, '') === 'PHP_BINARY'; }
function name(value: unknown): string | undefined { const n = ast(value); return n?.kind === 'name' && typeof n.name === 'string' ? n.name.replace(/^\\/u, '').toLowerCase() : undefined; }
function text(value: unknown): string | undefined { const n = ast(value); return n?.kind === 'string' && typeof n.value === 'string' ? n.value : undefined; }
function call(value: unknown, fn: string): Ast[] | undefined { const n = ast(value); return n?.kind === 'call' && name(n.what) === fn ? list(n.arguments) : undefined; }
function offset(n: Ast): number { return (n.loc as {start?: {offset?: number}} | undefined)?.start?.offset ?? -1; }
function fail(): never { throw new Error('Runner process invocation is unsupported. Use fixed PHP_BINARY + PHPUnit or artisan config:clear; forward only validated selectors using escapeshellarg() or an argv array.'); }

/** Bounded syntax recognition, not PHP dependency resolution or a proof of runtime isolation. */
export function inspectRunner(source: string, testEntry: string): RunnerReview {
  let program: unknown;
  try { program = new Engine.Engine({parser:{suppressErrors:false},ast:{withPositions:true}}).parseCode(source, 'runner.php'); }
  catch { throw new Error('Runner source is not parseable PHP; correct the execution evidence.'); }
  const items: Item[] = [];
  const walk = (value: unknown, parents: Ast[]): void => {
    const n = ast(value);
    if (!n) return;
    items.push({node:n,parents});
    for (const [key, child] of Object.entries(n)) {
      if (key === 'loc' || key.endsWith('Comments')) continue;
      if (Array.isArray(child)) for (const v of child) walk(v, [...parents,n]);
      else walk(child, [...parents,n]);
    }
  };
  walk(program, []);
  const processes: RunnerProcess[] = [];
  const invocations = items.filter(({node}) => node.kind === 'call' && ['passthru','proc_open'].includes(name(node.what) ?? ''));
  for (const {node} of items) {
    if ((node.kind === 'usegroup' || node.kind === 'useitem') && (node.type === 'function' || node.type === 'const')) fail();
    if (node.kind === 'eval' || (node.kind === 'encapsed' && node.type === 'shell')) fail();
    if (node.kind === 'call' && ['shell_exec','system','exec','popen','pcntl_exec','call_user_func','call_user_func_array'].includes(name(node.what) ?? '')) fail();
    if (node.kind === 'call' && !name(node.what) && ast(node.what)?.kind !== 'propertylookup' && ast(node.what)?.kind !== 'staticlookup') fail();
  }
  // Unsupported aliasing/scopes cannot establish the origin of a subprocess command.
  if (invocations.length && items.some(({node}) => ['namespace','function','closure','arrowfunc','assignref','global','eval'].includes(node.kind)
    || (node.kind === 'variable' && (typeof node.name !== 'string' || node.name === 'GLOBALS'))
    || (node.kind === 'call' && ['extract','parse_str','import_request_variables'].includes(name(node.what) ?? '')))) fail();
  const writes = (v: string): Item[] => items.filter(({node}) => {
    if (['assign','assignref','pre','post'].includes(node.kind)) {
      let left = ast(node.left ?? node.what);
      while (left?.kind === 'offsetlookup') left = ast(left.what);
      return variable(left) === v;
    }
    return (node.kind === 'foreach' && (variable(node.value) === v || variable(node.key) === v))
      || (node.kind === 'unset' && list(node.variables).some(n => rootVariable(n) === v));
  });
  const singleAssignment = (v: string, before: Ast): Ast => {
    const changes = writes(v);
    const n = changes[0]?.node;
    if (changes.length !== 1 || n?.kind !== 'assign' || n.operator !== '=' || variable(n.left) !== v || offset(n) >= offset(before)) fail();
    return n;
  };
  const onlyCallUses = (v: string, allowed: (n: Ast) => boolean): boolean => !items.some(({node}) => node.kind === 'call' && list(node.arguments).some(a => rootVariable(a) === v) && !allowed(node));
  const argvSlice = (value: unknown): boolean => {
    const args = call(value, 'array_slice');
    return args?.length === 2 && variable(args[0]) === 'argv' && ast(args[1])?.kind === 'number' && args[1]?.value === '1' && writes('argv').length === 0
      && onlyCallUses('argv', n => name(n.what) === 'array_slice' && list(n.arguments).length === 2 && variable(list(n.arguments)[0]) === 'argv');
  };
  const selectors = (value: unknown, before: Ast): boolean => {
    if (argvSlice(value)) return true;
    const v = variable(value);
    return v !== undefined && onlyCallUses(v, () => false) && argvSlice(singleAssignment(v,before).right);
  };
  const fixedShell = (value: unknown): string[] | undefined => {
    const n = ast(value), executable = call(n?.left,'escapeshellarg');
    if (n?.kind !== 'bin' || n.type !== '.' || executable?.length !== 1 || !phpBinary(executable[0])) return undefined;
    const suffix = text(n.right);
    if (suffix === ` ${testEntry}`) return [testEntry];
    if (suffix === ' artisan config:clear') return ['artisan','config:clear'];
    return undefined;
  };
  for (const invocation of invocations) {
    const n = invocation.node, args = list(n.arguments), api = name(n.what)!;
    if (invocation.parents.some(p => ['function','closure','arrowfunc','class','method'].includes(p.kind))) fail();
    if (api === 'passthru') {
      if (args.length < 1 || args.length > 2 || (args[1] && !variable(args[1]))) fail();
      let base = fixedShell(args[0]), forwarding: RunnerProcess['forwarding'] = 'none';
      const command = variable(args[0]);
      if (command) {
        const changes = writes(command), initial = changes.filter(({node}) => node.kind === 'assign' && node.operator === '=');
        const first = initial[0]?.node;
        if (initial.length !== 1 || !first || variable(first.left) !== command || offset(first) >= offset(n)) fail();
        base = fixedShell(first.right);
        for (const change of changes.filter(c => c.node !== first)) {
          const addition = change.node, expression = ast(addition.right);
          const escaped = call(expression?.right, 'escapeshellarg');
          const loop = [...change.parents].reverse().find(p => p.kind === 'foreach');
          const argument = escaped?.length === 1 ? variable(escaped[0]) : undefined;
          const body = ast(loop?.body);
          const statements = body?.kind === 'block' ? list(body.children) : body ? [body] : [];
          if (addition.kind !== 'assign' || addition.operator !== '.=' || variable(addition.left) !== command || offset(addition) <= offset(first) || offset(addition) >= offset(n)
            || base?.[0] !== testEntry || expression?.kind !== 'bin' || expression.type !== '.' || text(expression.left) !== ' '
            || !loop || statements.length !== 1 || ast(statements[0]?.expression) !== addition || !argument || variable(loop.value) !== argument || ast(loop.value)?.byref === true || !selectors(loop.source,loop) || writes(argument).length !== 1 || !onlyCallUses(argument, c => name(c.what) === 'escapeshellarg' && list(c.arguments).length === 1)) fail();
          forwarding = 'escaped-selectors';
        }
        // Do not pass the command by reference to an unknown function or reuse it as an output parameter.
        if (items.some(({node}) => node.kind === 'call' && list(node.arguments).some(a => rootVariable(a) === command)
          && !(name(node.what) === 'passthru' && variable(list(node.arguments)[0]) === command && !list(node.arguments).slice(1).some(a => variable(a) === command)))) fail();
      }
      if (!base) fail();
      processes.push({api:'passthru',executable:'PHP_BINARY',arguments:base,forwarding});
    } else {
      let command = args[0];
      const v = variable(command);
      if (v) {
        if (!onlyCallUses(v, c => name(c.what) === 'proc_open' && variable(list(c.arguments)[0]) === v && !list(c.arguments).slice(1).some(a => variable(a) === v))) fail();
        command = ast(singleAssignment(v,n).right);
      }
      if (command?.kind !== 'array') fail();
      const entries = list(command.items);
      if (entries.some(e => e.kind !== 'entry' || e.key !== null || e.byRef === true)) fail();
      if (!phpBinary(entries[0]?.value) || entries[0]?.unpack === true || entries[1]?.unpack === true) fail();
      let fixed: string[], start: number;
      if (text(entries[1]?.value) === testEntry) { fixed = [testEntry]; start = 2; }
      else if (text(entries[1]?.value) === 'artisan' && text(entries[2]?.value) === 'config:clear' && entries[2]?.unpack !== true) { fixed = ['artisan','config:clear']; start = 3; }
      else fail();
      const tail = entries.slice(start);
      if (tail.length && (fixed[0] !== testEntry || tail.length !== 1 || tail[0]?.unpack !== true || !selectors(tail[0]?.value,n))) fail();
      processes.push({api:'proc_open',executable:'PHP_BINARY',arguments:fixed,forwarding:tail.length ? 'argv-array' : 'none'});
    }
  }
  return {processes,needsLaravelBootstrap:processes.some(p => p.arguments[0] === 'artisan')};
}
