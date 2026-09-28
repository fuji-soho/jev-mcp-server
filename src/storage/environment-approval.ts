import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EnvironmentApprovalRecord, EnvironmentApprovalStatus } from '../types.js';

export interface EnvironmentApprovalKey {
  projectId: string;
  profileDigest: string;
  environmentFingerprint: string;
  scopeJson: string;
  verifierVersion: string;
}

function id(): string { return `env_${randomBytes(24).toString('base64url')}`; }
function mapRow(row: Record<string, unknown>): EnvironmentApprovalRecord {
  return {
    approvalId: String(row.approval_id), projectId: String(row.project_id), profileDigest: String(row.profile_digest),
    environmentFingerprint: String(row.environment_fingerprint), scopeJson: String(row.scope_json), verifierVersion: String(row.verifier_version),
    status: String(row.status) as EnvironmentApprovalStatus, createdAt: String(row.created_at),
    ...(row.approved_at == null ? {} : { approvedAt: String(row.approved_at) }),
    ...(row.rejected_at == null ? {} : { rejectedAt: String(row.rejected_at) }),
    ...(row.revoked_at == null ? {} : { revokedAt: String(row.revoked_at) }),
    ...(row.expires_at == null ? {} : { expiresAt: String(row.expires_at) }),
  };
}
function expire(db: DatabaseSync, now: string): void {
  db.prepare("UPDATE environment_approvals SET status='expired' WHERE status IN ('pending','approved') AND expires_at IS NOT NULL AND expires_at<=?").run(now);
}

export function createOrGetEnvironmentReview(db: DatabaseSync, key: EnvironmentApprovalKey, now: string, pendingExpiresAt: string): EnvironmentApprovalRecord {
  expire(db, now);
  const existing = db.prepare("SELECT * FROM environment_approvals WHERE project_id=? AND environment_fingerprint=? AND status IN ('pending','approved') LIMIT 1").get(key.projectId, key.environmentFingerprint) as Record<string, unknown> | undefined;
  if (existing) return mapRow(existing);
  const approvalId = id();
  db.prepare('INSERT INTO environment_approvals(approval_id,project_id,profile_digest,environment_fingerprint,scope_json,verifier_version,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(approvalId,key.projectId,key.profileDigest,key.environmentFingerprint,key.scopeJson,key.verifierVersion,'pending',now,pendingExpiresAt);
  return mapRow(db.prepare('SELECT * FROM environment_approvals WHERE approval_id=?').get(approvalId) as Record<string, unknown>);
}

export function lookupEnvironmentApproval(db: DatabaseSync, key: EnvironmentApprovalKey, now: string, requiredId?: string): EnvironmentApprovalRecord | undefined {
  expire(db, now);
  const row = requiredId === undefined
    ? db.prepare("SELECT * FROM environment_approvals WHERE project_id=? AND profile_digest=? AND environment_fingerprint=? AND scope_json=? AND verifier_version=? AND status='approved' AND (expires_at IS NULL OR expires_at>?) LIMIT 1").get(key.projectId,key.profileDigest,key.environmentFingerprint,key.scopeJson,key.verifierVersion,now)
    : db.prepare("SELECT * FROM environment_approvals WHERE approval_id=? AND project_id=? AND profile_digest=? AND environment_fingerprint=? AND scope_json=? AND verifier_version=? AND status='approved' AND (expires_at IS NULL OR expires_at>?) LIMIT 1").get(requiredId,key.projectId,key.profileDigest,key.environmentFingerprint,key.scopeJson,key.verifierVersion,now);
  return row ? mapRow(row as Record<string, unknown>) : undefined;
}

export function transitionEnvironmentApproval(db: DatabaseSync, approvalId: string, action: 'approve'|'reject', now: string, approvedExpiresAt?: string): EnvironmentApprovalRecord {
  expire(db, now);
  const row = db.prepare('SELECT * FROM environment_approvals WHERE approval_id=?').get(approvalId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Unknown environment approval ID.');
  if (String(row.status) !== 'pending') throw new Error(`Environment approval is not pending (status: ${String(row.status)}).`);
  if (action === 'approve') db.prepare("UPDATE environment_approvals SET status='approved', approved_at=?, expires_at=? WHERE approval_id=? AND status='pending'").run(now,approvedExpiresAt ?? null,approvalId);
  else db.prepare("UPDATE environment_approvals SET status='rejected', rejected_at=? WHERE approval_id=? AND status='pending'").run(now,approvalId);
  return mapRow(db.prepare('SELECT * FROM environment_approvals WHERE approval_id=?').get(approvalId) as Record<string, unknown>);
}

export function revokeEnvironmentApproval(db: DatabaseSync, approvalId: string, now: string): EnvironmentApprovalRecord {
  db.exec('BEGIN');
  let result;
  try {
    result = db.prepare("UPDATE environment_approvals SET status='revoked', revoked_at=? WHERE approval_id=? AND status='approved'").run(now,approvalId);
    if (result.changes !== 1) throw new Error('Environment approval is not active.');
    db.prepare('UPDATE execution_tickets SET revoked_at=? WHERE approval_id=? AND used_at IS NULL AND revoked_at IS NULL').run(now,approvalId);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw error; }
  return mapRow(db.prepare('SELECT * FROM environment_approvals WHERE approval_id=?').get(approvalId) as Record<string, unknown>);
}
