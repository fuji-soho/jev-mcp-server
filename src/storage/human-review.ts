import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { HumanApprovalKind, HumanReviewRecord, HumanReviewStatus } from '../types.js';
import { canonicalJson, sha256 } from '../safety-fingerprint.js';

export interface HumanReviewKey {
  projectId: string;
  targetType: 'test-file';
  targetKey: string;
  fingerprint: string;
  commandHash: string;
  testFilesHash: string;
  cwdHash: string;
  policyHash: string;
  contextHash: string;
  safetyProfileHash?: string;
  runtimeHash: string;
  actualModel: string;
}

export function bindHumanReviewModel(key: Omit<HumanReviewKey, 'actualModel'>, actualModel: string): HumanReviewKey {
  return {
    ...key,
    actualModel,
    fingerprint: sha256(canonicalJson({ schemaVersion: 1, ...key, actualModel })),
  };
}

function mapRow(row: Record<string, unknown>): HumanReviewRecord {
  return {
    reviewId: String(row.review_id), projectId: String(row.project_id), targetType: 'test-file', targetKey: String(row.target_key),
    fingerprint: String(row.fingerprint), commandHash: String(row.command_hash), testFilesHash: String(row.test_files_hash), cwdHash: String(row.cwd_hash),
    policyHash: String(row.policy_hash), contextHash: String(row.context_hash), runtimeHash: String(row.runtime_hash),
    ...(row.safety_profile_hash == null ? {} : { safetyProfileHash: String(row.safety_profile_hash) }),
    ...(row.actual_model == null ? {} : { actualModel: String(row.actual_model) }),
    decision: 'review', status: String(row.status) as HumanReviewStatus,
    ...(row.approval_kind == null ? {} : { approvalKind: String(row.approval_kind) as HumanApprovalKind }),
    createdAt: String(row.created_at), ...(row.approved_at == null ? {} : { approvedAt: String(row.approved_at) }),
    ...(row.rejected_at == null ? {} : { rejectedAt: String(row.rejected_at) }), ...(row.expires_at == null ? {} : { expiresAt: String(row.expires_at) }),
    ...(row.used_at == null ? {} : { usedAt: String(row.used_at) }),
  };
}

function reviewId(): string { return `rev_${randomBytes(24).toString('base64url')}`; }

export function createOrGetHumanReview(db: DatabaseSync, key: HumanReviewKey, now: string, expiresAt?: string): HumanReviewRecord {
  db.prepare("UPDATE human_reviews SET status='expired' WHERE project_id=? AND target_type=? AND target_key=? AND fingerprint=? AND policy_hash=? AND context_hash=? AND runtime_hash=? AND status IN ('pending','approved') AND expires_at IS NOT NULL AND expires_at<=?").run(key.projectId, key.targetType, key.targetKey, key.fingerprint, key.policyHash, key.contextHash, key.runtimeHash, now);
  const existing = db.prepare(`SELECT * FROM human_reviews WHERE project_id=? AND target_type=? AND target_key=? AND fingerprint=? AND policy_hash=? AND context_hash=? AND runtime_hash=? AND status IN ('pending','approved') LIMIT 1`).get(key.projectId, key.targetType, key.targetKey, key.fingerprint, key.policyHash, key.contextHash, key.runtimeHash) as Record<string, unknown> | undefined;
  if (existing) return mapRow(existing);
  const id = reviewId();
  db.prepare(`INSERT INTO human_reviews(review_id,project_id,target_type,target_key,fingerprint,command_hash,test_files_hash,cwd_hash,policy_hash,context_hash,safety_profile_hash,runtime_hash,actual_model,decision,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, key.projectId, key.targetType, key.targetKey, key.fingerprint, key.commandHash, key.testFilesHash, key.cwdHash, key.policyHash, key.contextHash, key.safetyProfileHash ?? null, key.runtimeHash, key.actualModel, 'review', 'pending', now, expiresAt ?? null);
  return mapRow(db.prepare('SELECT * FROM human_reviews WHERE review_id=?').get(id) as Record<string, unknown>);
}

export function lookupApprovedHumanReview(db: DatabaseSync, key: HumanReviewKey, now: string): HumanReviewRecord | undefined {
  const row = db.prepare(`SELECT * FROM human_reviews WHERE project_id=? AND target_type=? AND target_key=? AND fingerprint=? AND command_hash=? AND test_files_hash=? AND cwd_hash=? AND policy_hash=? AND context_hash=? AND IFNULL(safety_profile_hash,'')=IFNULL(?,'') AND runtime_hash=? AND actual_model=? AND status='approved' AND (expires_at IS NULL OR expires_at>?) LIMIT 1`).get(key.projectId, key.targetType, key.targetKey, key.fingerprint, key.commandHash, key.testFilesHash, key.cwdHash, key.policyHash, key.contextHash, key.safetyProfileHash ?? null, key.runtimeHash, key.actualModel, now) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : undefined;
}

export function transitionHumanReview(db: DatabaseSync, id: string, action: 'approve' | 'reject', now: string): HumanReviewRecord {
  const row = db.prepare('SELECT * FROM human_reviews WHERE review_id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Unknown review_id.');
  const current = String(row.status);
  if (current !== 'pending') throw new Error(`Review is not pending (status: ${current}).`);
  if (row.expires_at != null && String(row.expires_at) <= now) {
    db.prepare("UPDATE human_reviews SET status='expired' WHERE review_id=? AND status='pending'").run(id);
    throw new Error('Review has expired.');
  }
  if (action === 'approve') db.prepare("UPDATE human_reviews SET status='approved', approval_kind='approve_fingerprint', approved_at=? WHERE review_id=? AND status='pending'").run(now, id);
  else db.prepare("UPDATE human_reviews SET status='rejected', rejected_at=? WHERE review_id=? AND status='pending'").run(now, id);
  return mapRow(db.prepare('SELECT * FROM human_reviews WHERE review_id=?').get(id) as Record<string, unknown>);
}

export function markHumanReviewUsed(db: DatabaseSync, reviewId: string, now: string): void {
  db.prepare("UPDATE human_reviews SET used_at=? WHERE review_id=? AND status='approved'").run(now, reviewId);
}

export function getHumanReview(db: DatabaseSync, reviewId: string): HumanReviewRecord | undefined {
  const row = db.prepare('SELECT * FROM human_reviews WHERE review_id=?').get(reviewId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : undefined;
}
