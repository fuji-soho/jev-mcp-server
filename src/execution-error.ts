import type { RelatedCodeFile } from './safety-fingerprint.js';
export class ExecutionEvidenceError extends Error {
  constructor(public readonly code: string, message: string, public readonly file?: string, public readonly evidence: RelatedCodeFile[] = []) { super(message); }
}
