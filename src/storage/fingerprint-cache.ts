import type { DatabaseSync } from 'node:sqlite';
import type { Decision } from '../types.js';

export interface CacheKey { projectId: string; targetType: string; targetKey: string; fingerprint: string; policyHash: string; contextHash: string; safetyProfileHash?: string | undefined; runtimeHash: string; modelVersion: string; evaluatorVersion: string; }
export interface CacheEntry extends CacheKey { decision: Decision; reusable: boolean; actualModel?: string; verifiedAt: string; createdAt: string; updatedAt: string; }

export function lookupAllow(db: DatabaseSync, key: CacheKey): CacheEntry | undefined {
  const row = db.prepare(`SELECT * FROM fingerprint_cache WHERE project_id=? AND target_type=? AND target_key=? AND fingerprint=? AND policy_hash=? AND context_hash=? AND IFNULL(safety_profile_hash,'')=IFNULL(?,'') AND runtime_hash=? AND model_version=? AND evaluator_version=? AND decision='allow' AND reusable=1 LIMIT 1`).get(key.projectId, key.targetType, key.targetKey, key.fingerprint, key.policyHash, key.contextHash, key.safetyProfileHash ?? null, key.runtimeHash, key.modelVersion, key.evaluatorVersion) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return { ...key, decision: 'allow', reusable: true, ...(row.actual_model == null ? {} : { actualModel: String(row.actual_model) }), verifiedAt: String(row.verified_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

export function upsertCache(db: DatabaseSync, key: CacheKey, decision: Decision, reusable: boolean, now: string, actualModel?: string): void {
  db.prepare(`INSERT INTO fingerprint_cache(project_id,target_type,target_key,fingerprint,policy_hash,context_hash,safety_profile_hash,runtime_hash,decision,reusable,model_version,evaluator_version,actual_model,verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,target_type,target_key,fingerprint,policy_hash,context_hash,runtime_hash,model_version,evaluator_version) DO UPDATE SET decision=excluded.decision,reusable=excluded.reusable,actual_model=excluded.actual_model,verified_at=excluded.verified_at,updated_at=excluded.updated_at`).run(key.projectId,key.targetType,key.targetKey,key.fingerprint,key.policyHash,key.contextHash,key.safetyProfileHash ?? null,key.runtimeHash,decision,reusable ? 1 : 0,key.modelVersion,key.evaluatorVersion,actualModel ?? null,now,now,now);
}
