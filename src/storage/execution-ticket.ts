import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sha256 } from '../safety-fingerprint.js';

export interface ExecutionTicketKey { approvalId: string; projectId: string; environmentFingerprint: string; codeFingerprint: string; executionFingerprint: string }
export interface IssuedExecutionTicket { token: string; expiresAt: string }

export function issueExecutionTicket(db: DatabaseSync, key: ExecutionTicketKey, now: string, expiresAt: string): IssuedExecutionTicket {
  const token = `xtk_${randomBytes(32).toString('base64url')}`;
  db.prepare('INSERT INTO execution_tickets(ticket_hash,approval_id,project_id,environment_fingerprint,code_fingerprint,execution_fingerprint,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(sha256(token),key.approvalId,key.projectId,key.environmentFingerprint,key.codeFingerprint,key.executionFingerprint,now,expiresAt);
  return { token, expiresAt };
}

/** Intended for the approved runner: validates exact current fingerprints and consumes the ticket once. */
export function consumeExecutionTicket(db: DatabaseSync, token: string, key: ExecutionTicketKey, now: string): boolean {
  const row = db.prepare('SELECT * FROM execution_tickets WHERE ticket_hash=?').get(sha256(token)) as Record<string, unknown> | undefined;
  if (!row || row.used_at != null || row.revoked_at != null || String(row.expires_at) <= now) return false;
  if (String(row.approval_id) !== key.approvalId || String(row.project_id) !== key.projectId || String(row.environment_fingerprint) !== key.environmentFingerprint || String(row.code_fingerprint) !== key.codeFingerprint || String(row.execution_fingerprint) !== key.executionFingerprint) return false;
  const approval = db.prepare("SELECT approval_id FROM environment_approvals WHERE approval_id=? AND project_id=? AND environment_fingerprint=? AND status='approved' AND (expires_at IS NULL OR expires_at>?)").get(key.approvalId,key.projectId,key.environmentFingerprint,now);
  if (!approval) return false;
  return db.prepare('UPDATE execution_tickets SET used_at=? WHERE ticket_hash=? AND used_at IS NULL AND revoked_at IS NULL').run(now,sha256(token)).changes === 1;
}
