import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, posix, resolve } from 'node:path';
import { executionConditionsInputSchema, executionConditionsSchema, executableSchema, type ExecutionConditions, type ExecutionProfile } from './execution-schema.js';
import { ExecutionEvidenceError } from './execution-error.js';
import { executionTokens } from './execution-profile.js';
import { canonicalJson, projectId, readRelatedCode, relativeTarget, resolveTestRoot, sha256 } from './safety-fingerprint.js';
import { openDatabase } from './storage/sqlite.js';
import type { TestCheckInput } from './types.js';

type MissingField = { field: string; reason: string; example?: unknown };
export class ExecutionRegistrationError extends ExecutionEvidenceError {
  constructor(code: string, message: string, public readonly missingFields: MissingField[] = [],
    public readonly candidates: Array<{ executionConditionsId: string; target: unknown; entry: unknown }> = []) { super(code, message); }
}
export interface ExecutionInvocation {
  mode: 'local' | 'podman' | 'docker'; containerName?: string; cwd?: string; tokens: string[];
  wrapper: 'direct' | 'workdir' | 'shell'; engine?: string;
}

/** Recognizes one literal exec or the exact cd && entry shell form; never executes it. */
export function parseExecutionInvocation(command: string): ExecutionInvocation {
  if (command.length > 16_000 || /[\0\r\n$`\\]/u.test(command)) throw new ExecutionEvidenceError('UNSUPPORTED_EXECUTION_FORM', 'Expansion, escapes, multiline commands and oversized commands are unsupported.');
  const engine = command.match(/^(podman|docker)\s+exec\s+/u);
  if (!engine) return { mode: 'local', tokens: executionTokens(command), wrapper: 'direct' };
  const shell = command.match(/^(podman|docker)\s+exec\s+([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})\s+sh\s+-lc\s+(['"])([\s\S]*)\3\s*$/u);
  if (shell) {
    const body = shell[4]!;
    if (body.includes(shell[3]!)) throw new ExecutionEvidenceError('UNSUPPORTED_EXECUTION_FORM', 'Nested use of the outer shell quote is unsupported. Use exec --workdir with a literal command.');
    const inner = body.match(/^cd\s+(\/[a-zA-Z0-9_./+-]+)\s+&&\s+(.+)$/u);
    if (!inner) throw new ExecutionEvidenceError('UNSUPPORTED_EXECUTION_FORM', 'The shell body must be exactly cd /project && one Composer/PHP entry. Use exec --workdir /project container composer test.');
    return { mode: shell[1] as 'podman'|'docker', engine: shell[1]!, containerName: shell[2]!, cwd: inner[1]!, tokens: executionTokens(inner[2]!), wrapper: 'shell' };
  }
  const tokens = executionTokens(command);
  tokens.splice(0,2);
  if (!['--workdir','-w'].includes(tokens[0] ?? '')) throw new ExecutionEvidenceError('UNSUPPORTED_EXECUTION_FORM', 'Specify exec --workdir /project container composer test, or the supported sh -lc cd form. Other exec options are unsupported.');
  tokens.shift(); const cwd = tokens.shift(), containerName = tokens.shift();
  if (!cwd || !executableSchema.safeParse(cwd).success || !containerName || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(containerName)) throw new ExecutionEvidenceError('UNSUPPORTED_EXECUTION_FORM', 'exec requires a literal absolute workdir and container name.');
  if (!tokens.length || ['sh','bash'].includes(tokens[0]!)) throw new ExecutionEvidenceError('UNSUPPORTED_EXECUTION_FORM', 'Only a direct Composer/PHP entry is supported after exec --workdir.');
  return { mode: engine[1] as 'podman'|'docker', engine: engine[1]!, containerName, cwd, tokens, wrapper: 'workdir' };
}
export function wrapExecutionCommand(invocation: ExecutionInvocation, inner: string): string {
  if (invocation.mode === 'local') return inner;
  if (invocation.wrapper === 'shell') return `${invocation.engine} exec ${invocation.containerName} sh -lc 'cd ${invocation.cwd} && ${inner}'`;
  return `${invocation.engine} exec --workdir ${invocation.cwd} ${invocation.containerName} ${inner}`;
}
function entryFrom(invocation: ExecutionInvocation): { adapter: 'composer-script'; script: string } | { adapter: 'php-runner' } {
  const tokens = [...invocation.tokens]; const executable = tokens.shift()?.split('/').at(-1);
  if (executable === 'composer') {
    if (tokens[0] === '--no-plugins') tokens.shift();
    if (tokens[0] === 'run-script') tokens.shift();
    const script = tokens.shift();
    if (!script || !/^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(script)) throw new ExecutionEvidenceError('UNSUPPORTED_EXECUTION_FORM', 'Specify a literal Composer script name.');
    return { adapter: 'composer-script', script };
  }
  if (executable === 'php') return { adapter:'php-runner' };
  throw new ExecutionEvidenceError('UNSUPPORTED_EXECUTION_FORM', 'Supported entries are Composer scripts and existing PHP safe runners.');
}
function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    try { const path = realpathSync(resolve(directory,name)); const stat=lstatSync(path); if(stat.isFile() && (stat.mode & 0o111))return path; } catch { /* continue */ }
  }
  return undefined;
}
function inferRunner(root: string, script: string): string | undefined {
  const read = readRelatedCode(root,['composer.json']);
  if(read.status!=='complete')throw new ExecutionEvidenceError('EXECUTION_EVIDENCE_INCOMPLETE',read.reason,'composer.json',read.files);
  let scripts: Record<string,unknown>;
  try { scripts=JSON.parse(read.files[0]!.content).scripts; } catch { throw new ExecutionEvidenceError('EXECUTION_EVIDENCE_INCOMPLETE','composer.json is invalid JSON.','composer.json'); }
  const active=new Set<string>(); const leaves:string[]=[]; let handlers=0;
  const visit=(name:string,depth:number):void=>{
    if(depth>16 || active.has(name) || ++handlers>64)throw new ExecutionEvidenceError('EXECUTION_CHAIN_UNRESOLVED','Composer graph is cyclic or exceeds its traversal limit.','composer.json');
    active.add(name); const value=scripts?.[name]; const items=Array.isArray(value)?value:[value];
    if(!items.length || items.some(item=>typeof item!=='string'))throw new ExecutionEvidenceError('EXECUTION_CHAIN_UNRESOLVED','Selected Composer script has unsupported handlers.','composer.json');
    for(const item of items as string[]) {
      if(++handlers>64)throw new ExecutionEvidenceError('EXECUTION_CHAIN_UNRESOLVED','Composer graph exceeds its handler limit.','composer.json');
      const tokens=executionTokens(item);
      if(tokens.length===1 && tokens[0]!.startsWith('@') && tokens[0]!=='@php')visit(tokens[0]!.slice(1),depth+1);
      else if(tokens.length===2 && (tokens[0]==='@php' || tokens[0]!.split('/').at(-1)==='php'))leaves.push(tokens[1]!);
      else throw new ExecutionEvidenceError('EXECUTION_CHAIN_UNRESOLVED','Only script references and one existing PHP runner are supported.','composer.json');
    }
    active.delete(name);
  };
  visit(script,0);
  if(leaves.length!==1)throw new ExecutionEvidenceError('EXECUTION_CHAIN_UNRESOLVED','The script must resolve to exactly one existing PHP safe runner.','composer.json');
  return leaves[0];
}
export function mappedHostWorkdir(root: string, projectRoot: string, cwd: string): string {
  const relative = posix.relative(projectRoot,cwd);
  if(relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative))throw new ExecutionRegistrationError('EXECUTION_CONDITIONS_MISMATCH','Container workdir must remain within target.projectRoot.');
  let component=root;
  for(const part of relative.split('/').filter(Boolean)) {
    component=resolve(component,part);
    try {if(lstatSync(component).isSymbolicLink())throw new ExecutionEvidenceError('EXECUTION_EVIDENCE_INCOMPLETE','Mapped host workdir must not contain a symbolic link.',relative);}
    catch(error){if(error instanceof ExecutionEvidenceError)throw error;throw new ExecutionEvidenceError('TEST_CWD_NOT_FOUND','Mapped host workdir is missing or unreadable. Correct target.cwd or the host project mapping.',relative);}
  }
  const working=resolveTestRoot(component);
  if(!working.ok)throw new ExecutionEvidenceError(working.code,working.message,relative);
  if(relativeTarget(root,working.root)===undefined)throw new ExecutionEvidenceError('EXECUTION_CONTEXT_MISMATCH','Mapped host workdir escapes the host project.');
  return working.root;
}
export function conditionsProfile(conditions: ExecutionConditions): ExecutionProfile {
  return { version:3, name:'db-execution-conditions', framework:'laravel', environment:'testing',
    entry: conditions.entry, runner: conditions.runner, selectors: conditions.selectors,
    environmentFiles: conditions.environmentFiles, codeReviewRoots: conditions.codeReviewRoots, resources: conditions.resources,
    // Container runtime values are declarations, not inspected host executable paths.
    runtime: { php:conditions.runtime?.php ?? 'php', configFiles:conditions.runtime?.configFiles ?? [],
      ...(conditions.runtime?.composer ? {composer:conditions.runtime.composer}:{}),
      ...(conditions.runtime?.composerHome ? {composerHome:conditions.runtime.composerHome}:{}) } };
}
function matches(conditions: ExecutionConditions, invocation: ExecutionInvocation): boolean {
  if(conditions.target.mode!==invocation.mode)return false;
  if(conditions.target.mode!=='local' && (conditions.target.containerName!==invocation.containerName || conditions.target.cwd!==invocation.cwd))return false;
  return canonicalJson(conditions.entry)===canonicalJson(entryFrom(invocation)) && (conditions.entry.adapter !== 'php-runner' || invocation.tokens[1] === conditions.runner.file);
}
export function resolveExecutionConditions(input: TestCheckInput, root: string): { conditions: ExecutionConditions; conditionId?: string } {
  const invocation=parseExecutionInvocation(input.command);
  const db=openDatabase(); const pid=projectId(root);
  let selected: Record<string,unknown> | undefined;
  if(input.executionApprovalId) {
    const approval=db.prepare('SELECT * FROM test_execution_approvals WHERE approval_id=? AND project_id=?').get(input.executionApprovalId,pid);
    if(!approval)throw new ExecutionRegistrationError('EXECUTION_APPROVAL_MISMATCH','The approval ID does not belong to this project.');
    if(approval.source_kind!=='db')throw new ExecutionRegistrationError('EXECUTION_MIGRATION_REQUIRED','This approval depends on a legacy Profile. Supply executionConditions and obtain a new explicit approval, or specify the legacy safetyProfilePath.');
    if(input.executionConditionsId && input.executionConditionsId!==approval.condition_id)throw new ExecutionRegistrationError('EXECUTION_APPROVAL_MISMATCH','Condition ID and approval ID identify different registrations.');
    selected=db.prepare('SELECT * FROM test_execution_conditions WHERE condition_id=? AND project_id=?').get(String(approval.condition_id),pid);
  } else if(input.executionConditionsId) selected=db.prepare('SELECT * FROM test_execution_conditions WHERE condition_id=? AND project_id=?').get(input.executionConditionsId,pid);
  if((input.executionApprovalId || input.executionConditionsId) && !selected)throw new ExecutionRegistrationError('EXECUTION_CONDITIONS_MISMATCH','The requested registration does not belong to this project.');
  if(selected) {
    const conditions=executionConditionsSchema.parse(JSON.parse(String(selected.conditions_json)));
    if(!matches(conditions,invocation))throw new ExecutionRegistrationError('EXECUTION_CONDITIONS_MISMATCH','Execution mode, container, workdir or entry differs from the selected registration. Supply the intended executionConditions for a new registration.');
    if(input.executionConditions) {
      const normalized=collectConditions(input,root,invocation);
      if(canonicalJson(normalized)!==canonicalJson(conditions))throw new ExecutionRegistrationError('EXECUTION_CONDITIONS_MISMATCH','Structured conditions differ from the selected registration. Omit its IDs to register the changed scope.');
    }
    return {conditions,conditionId:String(selected.condition_id)};
  }
  if(input.executionConditions) return {conditions:collectConditions(input,root,invocation)};
  const candidates=db.prepare('SELECT * FROM test_execution_conditions WHERE project_id=?').all(pid).map(row=>({row,conditions:executionConditionsSchema.parse(JSON.parse(String(row.conditions_json)))})).filter(({conditions})=>matches(conditions,invocation));
  if(candidates.length>1)throw new ExecutionRegistrationError('EXECUTION_CONDITIONS_AMBIGUOUS','Multiple registrations match. Specify executionConditionsId or the exact executionApprovalId.',[],candidates.map(({row,conditions})=>({executionConditionsId:String(row.condition_id),target:conditions.target,entry:conditions.entry})));
  if(candidates.length===1)return {conditions:candidates[0]!.conditions,conditionId:String(candidates[0]!.row.condition_id)};
  return {conditions:collectConditions(input,root,invocation)};
}
function collectConditions(input: TestCheckInput, root: string, invocation: ExecutionInvocation): ExecutionConditions {
  const parsed=executionConditionsInputSchema.safeParse(input.executionConditions ?? {});
  if(!parsed.success)throw new ExecutionRegistrationError('EXECUTION_REGISTRATION_INVALID','Invalid structured executionConditions. Correct the listed fields.',parsed.error.issues.map(issue=>({field:`executionConditions.${issue.path.join('.')}`,reason:'Invalid field shape or unsupported value.'})));
  const supplied=parsed.data, missing:MissingField[]=[];
  const require=(field:string,value:unknown,example:unknown):void=>{if(value===undefined)missing.push({field:`executionConditions.${field}`,reason:'Supply this field for explicit review of the execution scope.',example});};
  const entry=entryFrom(invocation);
  if(supplied.entry && (supplied.entry.adapter && supplied.entry.adapter!==entry.adapter || supplied.entry.script && (entry.adapter!=='composer-script' || supplied.entry.script!==entry.script)))throw new ExecutionRegistrationError('EXECUTION_CONDITIONS_MISMATCH','Declared entry does not match the actual command.');
  if(supplied.target?.mode && supplied.target.mode!==invocation.mode)throw new ExecutionRegistrationError('EXECUTION_CONDITIONS_MISMATCH','Declared execution mode differs from the command.');
  let target:unknown={mode:'local'};
  if(invocation.mode!=='local') {
    if(supplied.target?.containerName && supplied.target.containerName!==invocation.containerName || supplied.target?.cwd && supplied.target.cwd!==invocation.cwd)throw new ExecutionRegistrationError('EXECUTION_CONDITIONS_MISMATCH','Declared container or workdir differs from the full command.');
    require('target.projectRoot',supplied.target?.projectRoot,invocation.cwd);
    target={mode:invocation.mode,containerName:invocation.containerName,cwd:invocation.cwd,projectRoot:supplied.target?.projectRoot};
  } else if(supplied.target?.containerName || supplied.target?.projectRoot || supplied.target?.cwd)throw new ExecutionRegistrationError('EXECUTION_CONDITIONS_MISMATCH','Local target must not contain container fields.');
  const discoveryRoot=invocation.mode !== 'local' && supplied.target?.projectRoot && executableSchema.safeParse(supplied.target.projectRoot).success ? mappedHostWorkdir(root,supplied.target.projectRoot,invocation.cwd!) : root;
  const runnerFile=supplied.runner?.file ?? (entry.adapter==='composer-script'?inferRunner(discoveryRoot,entry.script):invocation.tokens[1]);
  require('runner.file',runnerFile,'scripts/test-safe.php');
  require('runner.safetyFiles',supplied.runner?.safetyFiles,['tests/Support/DatabaseGuard.php']);
  if(supplied.runner?.safetyFiles?.length===0)missing.push({field:'executionConditions.runner.safetyFiles',reason:'At least one existing connection guard must be identified.',example:['tests/Support/DatabaseGuard.php']});
  for(const key of ['filePatterns','allowFilter','allowFullSuite'] as const)require(`selectors.${key}`,supplied.selectors?.[key],key==='filePatterns'?['tests/Feature/**']:true);
  let environmentFiles=supplied.environmentFiles;
  if(!environmentFiles) {
    const xml=['phpunit.xml','phpunit.xml.dist'].find(file=>{try{return lstatSync(resolve(discoveryRoot,file)).isFile();}catch{return false;}});
    if(xml)environmentFiles=[xml]; else require('environmentFiles',undefined,['phpunit.xml']);
  }
  require('codeReviewRoots',supplied.codeReviewRoots,['tests/Support','app']);
  const resourceExamples={database:{policy:'sqlite-memory',rejectFallback:true,rejectAdditionalConnections:true},filesystem:{writableRoots:['bootstrap/cache']},network:{policy:'deny'},credentials:{policy:'deny'}};
  require('resources',supplied.resources,resourceExamples);
  if(supplied.resources) {
    for(const [group,example] of Object.entries(resourceExamples)) {
      const values=supplied.resources[group as keyof typeof supplied.resources];
      require(`resources.${group}`,values,example);
      if(values)for(const [key,value] of Object.entries(example))require(`resources.${group}.${key}`, (values as Record<string,unknown>)[key],value);
    }
  }
  let runtime=supplied.runtime;
  if(invocation.mode==='local') {
    const php=runtime?.php ?? findExecutable('php');
    const composer=entry.adapter==='composer-script'?(runtime?.composer ?? (isAbsolute(invocation.tokens[0]!)?invocation.tokens[0]:findExecutable('composer'))):undefined;
    require('runtime.php',php,'/usr/local/bin/php');
    if(entry.adapter==='composer-script')require('runtime.composer',composer,'/usr/local/bin/composer');
    require('runtime.configFiles',runtime?.configFiles,[]);
    runtime={...runtime,...(php?{php}:{}),...(composer?{composer}:{})};
    for(const [key,value] of Object.entries(runtime))if(['php','composer'].includes(key) && !executableSchema.safeParse(value).success)throw new ExecutionRegistrationError('EXECUTION_REGISTRATION_INVALID',`Local runtime.${key} must be an absolute inspectable executable path.`);
  }
  if(missing.length)throw new ExecutionRegistrationError('EXECUTION_REGISTRATION_INCOMPLETE','Complete the listed executionConditions fields, then call jev_check_test again. No configuration file is required.',missing);
  const result=executionConditionsSchema.safeParse({target,entry,runner:{file:runnerFile,safetyFiles:supplied.runner?.safetyFiles,testEntry:supplied.runner?.testEntry ?? 'vendor/bin/phpunit'},selectors:supplied.selectors,environmentFiles,codeReviewRoots:supplied.codeReviewRoots,resources:supplied.resources,...(runtime?{runtime}:{})});
  if(!result.success)throw new ExecutionRegistrationError('EXECUTION_REGISTRATION_INVALID','Correct the listed executionConditions fields.',result.error.issues.map(issue=>({field:`executionConditions.${issue.path.join('.')}`,reason:'Invalid field value or unsupported resource scope; supply a supported value and recheck.'})));
  if(result.data.target.mode!=='local') {
    const rel=posix.relative(result.data.target.projectRoot,result.data.target.cwd);
    if(rel==='..' || rel.startsWith('../') || posix.isAbsolute(rel))throw new ExecutionRegistrationError('EXECUTION_CONDITIONS_MISMATCH','Container workdir must be within the declared container projectRoot. Correct target.projectRoot/target.cwd and the actual exec command.');
  }
  if(Buffer.byteLength(canonicalJson(result.data))>64*1024)throw new ExecutionRegistrationError('EXECUTION_REGISTRATION_INVALID','Execution conditions exceed the 64 KiB limit.');
  return result.data;
}
