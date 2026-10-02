import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sha256 } from '../safety-fingerprint.js';

export interface ExecutionTicketKey { approvalId: string; projectId: string; environmentFingerprint: string; codeFingerprint: string; executionFingerprint: string }
export type CurrentExecutionTicketIdentity = Omit<ExecutionTicketKey, 'approvalId'>;
export interface IssuedExecutionTicket { token: string; expiresAt: string }
export type ExecutionTicketConsumeStatus = 'consumed' | 'unknown' | 'expired' | 'used' | 'revoked' | 'identity-mismatch' | 'approval-invalid';
export interface ExecutionTicketConsumeResult { status: ExecutionTicketConsumeStatus; approvalId?: string }

export function issueExecutionTicket(db: DatabaseSync, key: ExecutionTicketKey, now: string, expiresAt: string): IssuedExecutionTicket {
  const token = `xtk_${randomBytes(32).toString('base64url')}`;
  db.prepare('INSERT INTO execution_tickets(ticket_hash,approval_id,project_id,environment_fingerprint,code_fingerprint,execution_fingerprint,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(sha256(token),key.approvalId,key.projectId,key.environmentFingerprint,key.codeFingerprint,key.executionFingerprint,now,expiresAt);
  return { token, expiresAt };
}

/** Runner-facing primitive: derives approval identity from the opaque ticket and atomically consumes it. */
export function consumeExecutionTicketForIdentity(db: DatabaseSync, token: string, identity: CurrentExecutionTicketIdentity, now: string, expectedApprovalId?: string): ExecutionTicketConsumeResult {
  const ticketHash = sha256(token);
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM execution_tickets WHERE ticket_hash=?').get(ticketHash) as Record<string, unknown> | undefined;
    if (!row) { db.exec('COMMIT'); return { status: 'unknown' }; }
    const approvalId = String(row.approval_id);
    if (row.used_at != null) { db.exec('COMMIT'); return { status: 'used', approvalId }; }
    if (row.revoked_at != null) { db.exec('COMMIT'); return { status: 'revoked', approvalId }; }
    if (String(row.expires_at) <= now) { db.prepare('UPDATE execution_tickets SET revoked_at=? WHERE ticket_hash=? AND revoked_at IS NULL').run(now, ticketHash); db.exec('COMMIT'); return { status: 'expired', approvalId }; }
    const matches = (expectedApprovalId === undefined || approvalId === expectedApprovalId)
      && String(row.project_id) === identity.projectId
      && String(row.environment_fingerprint) === identity.environmentFingerprint
      && String(row.code_fingerprint) === identity.codeFingerprint
      && String(row.execution_fingerprint) === identity.executionFingerprint;
    if (!matches) { db.prepare('UPDATE execution_tickets SET revoked_at=? WHERE ticket_hash=? AND used_at IS NULL AND revoked_at IS NULL').run(now, ticketHash); db.exec('COMMIT'); return { status: 'identity-mismatch', approvalId }; }
    const approval = db.prepare("SELECT approval_id FROM environment_approvals WHERE approval_id=? AND project_id=? AND environment_fingerprint=? AND status='approved' AND (expires_at IS NULL OR expires_at>?)").get(approvalId, identity.projectId, identity.environmentFingerprint, now);
    if (!approval) { db.prepare('UPDATE execution_tickets SET revoked_at=? WHERE ticket_hash=? AND used_at IS NULL AND revoked_at IS NULL').run(now, ticketHash); db.exec('COMMIT'); return { status: 'approval-invalid', approvalId }; }
    const consumed = db.prepare('UPDATE execution_tickets SET used_at=? WHERE ticket_hash=? AND used_at IS NULL AND revoked_at IS NULL').run(now, ticketHash).changes === 1;
    db.exec('COMMIT');
    return consumed ? { status: 'consumed', approvalId } : { status: 'used', approvalId };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* best effort */ }
    throw error;
  }
}

/** Compatibility helper for internal tests and existing integrations. Prefer consumeExecutionTicketForIdentity. */
export function consumeExecutionTicket(db: DatabaseSync, token: string, key: ExecutionTicketKey, now: string): boolean {
  return consumeExecutionTicketForIdentity(db, token, key, now, key.approvalId).status === 'consumed';
}

export function invalidateExecutionTicket(db: DatabaseSync, token: string, now: string): void {
  db.prepare('UPDATE execution_tickets SET revoked_at=? WHERE ticket_hash=? AND used_at IS NULL AND revoked_at IS NULL').run(now, sha256(token));
}
