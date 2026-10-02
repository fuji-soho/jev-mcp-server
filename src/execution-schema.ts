import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const pathSchema = z.string().min(1).max(4000).refine(p => /^[a-zA-Z0-9_./-]+$/u.test(p) && !isAbsolute(p) && p !== '.' && !p.split('/').includes('..'));
const patternSchema = z.string().min(1).max(4000).refine(p => /^[a-zA-Z0-9_./*-]+$/u.test(p) && !isAbsolute(p) && p !== '.' && !p.split('/').includes('..'));
export const executableSchema = z.string().refine(p => isAbsolute(p) && /^[a-zA-Z0-9_./+-]+$/u.test(p));
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


const targetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local') }).strict(),
  z.object({ mode: z.enum(['podman','docker']), containerName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u),
    projectRoot: executableSchema, cwd: executableSchema }).strict(),
]);
const runtimeSchema = z.object({ php: z.string().regex(/^[a-zA-Z0-9_./+-]+$/u).optional(), composer: z.string().regex(/^[a-zA-Z0-9_./+-]+$/u).optional(),
  composerHome: executableSchema.optional(), configFiles: z.array(executableSchema).max(128).optional() }).strict();
export const executionConditionsSchema = executionProfileSchema.omit({ version:true, name:true, framework:true, environment:true, runtime:true }).extend({
  target: targetSchema, runtime: runtimeSchema.optional(),
});
// Partial collection input: absence is returned as actionable missingFields, never approved.
export const executionConditionsInputSchema = executionConditionsSchema.partial().extend({
  target: z.object({ mode: z.enum(['local','podman','docker']).optional(), containerName: z.string().max(128).optional(), projectRoot: z.string().max(4000).optional(), cwd: z.string().max(4000).optional() }).strict().optional(),
  entry: z.object({ adapter: z.enum(['composer-script','php-runner']).optional(), script: z.string().max(100).optional() }).strict().optional(),
  runner: executionProfileSchema.shape.runner.partial().optional(),
  selectors: executionProfileSchema.shape.selectors.partial().optional(),
  resources: executionProfileSchema.shape.resources.partial().extend({
    database: executionProfileSchema.shape.resources.shape.database.partial().optional(),
    filesystem: executionProfileSchema.shape.resources.shape.filesystem.partial().optional(),
    network: executionProfileSchema.shape.resources.shape.network.partial().optional(),
    credentials: executionProfileSchema.shape.resources.shape.credentials.partial().optional(),
  }).optional(),
});
export type ExecutionConditionsInput = z.infer<typeof executionConditionsInputSchema>;
export type ExecutionConditions = z.infer<typeof executionConditionsSchema>;
