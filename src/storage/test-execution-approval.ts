import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, projectId, sha256 } from '../safety-fingerprint.js';
import { snapshotExecution, EXECUTION_VERIFIER_VERSION, type ExecutionSnapshot } from '../execution-profile.js';
import { findPolicyMatches, loadEffectivePolicies, loadEffectiveTestPolicies } from '../policy.js';
import { insertAudit } from './audit-log.js';
import type { TestCheckInput } from '../types.js';

export interface TestExecutionApproval {
  approvalId: string; conditionId?: string; sourceKind: 'profile'|'db'; projectId: string; profilePath: string; fingerprint: string; policyHash: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired' | 'superseded';
  scope: Record<string, unknown>; request: TestCheckInput; createdAt: string; expiresAt?: string;
}
function map(row: Record<string, unknown>): TestExecutionApproval {
  return { approvalId: String(row.approval_id), projectId: String(row.project_id), profilePath: row.profile_path == null ? `conditions:${String(row.condition_id)}` : String(row.profile_path),
    fingerprint: String(row.fingerprint), sourceKind: String(row.source_kind) as 'profile'|'db', ...(row.condition_id == null ? {} : {conditionId:String(row.condition_id)}), policyHash: String(row.policy_hash), status: String(row.status) as TestExecutionApproval['status'],
    scope: JSON.parse(String(row.scope_json)) as Record<string, unknown>, request: JSON.parse(String(row.request_json)) as TestCheckInput,
    createdAt: String(row.created_at), ...(row.expires_at == null ? {} : { expiresAt: String(row.expires_at) }) };
}
export function getTestExecutionApproval(db: DatabaseSync, id: string): TestExecutionApproval | undefined {
  const row = db.prepare('SELECT * FROM test_execution_approvals WHERE approval_id=?').get(id);
  return row ? map(row) : undefined;
}

export function executionApprovalFor(db: DatabaseSync, snapshot: ExecutionSnapshot, now: string, requiredId?: string): TestExecutionApproval {
  const pid = projectId(snapshot.projectRoot);
  let committed = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE test_execution_approvals SET status='expired' WHERE status='pending' AND expires_at<=?").run(now);
    let conditionId = snapshot.conditionId;
    if (snapshot.conditions) {
      const descriptor = canonicalJson(snapshot.conditions), hash = sha256(descriptor);
      const existing = db.prepare('SELECT * FROM test_execution_conditions WHERE project_id=? AND descriptor_hash=?').get(pid,hash);
      if (existing) conditionId = String(existing.condition_id);
      else {
        conditionId = `cond_${randomBytes(24).toString('base64url')}`;
        db.prepare('INSERT INTO test_execution_conditions(condition_id,project_id,host_root,descriptor_hash,conditions_json,created_at) VALUES(?,?,?,?,?,?)')
          .run(conditionId,pid,snapshot.projectRoot,hash,descriptor,now);
      }
    }
    const active = conditionId
      ? db.prepare("SELECT * FROM test_execution_approvals WHERE condition_id=? AND status IN ('pending','approved')").get(conditionId)
      : db.prepare("SELECT * FROM test_execution_approvals WHERE project_id=? AND profile_path=? AND source_kind='profile' AND status IN ('pending','approved')").get(pid, snapshot.profilePath);
    const current = active ? map(active) : undefined;
    if (requiredId && (current?.approvalId !== requiredId || current.status !== 'approved' || current.fingerprint !== snapshot.fingerprint)) {
      if (current && current.fingerprint !== snapshot.fingerprint) db.prepare("UPDATE test_execution_approvals SET status='superseded' WHERE approval_id=?").run(current.approvalId);
      db.exec('COMMIT'); committed = true;
      throw new Error('EXECUTION_APPROVAL_MISMATCH');
    }
    if (current?.fingerprint === snapshot.fingerprint) { db.exec('COMMIT'); return current; }
    if (current) db.prepare("UPDATE test_execution_approvals SET status='superseded' WHERE approval_id=?").run(current.approvalId);
    const priorRecord = conditionId
      ? db.prepare('SELECT 1 FROM test_execution_approvals WHERE condition_id=? LIMIT 1').get(conditionId)
      : db.prepare("SELECT 1 FROM test_execution_approvals WHERE project_id=? AND profile_path=? AND source_kind='profile' LIMIT 1").get(pid,snapshot.profilePath);
    const priorProject = snapshot.conditions && db.prepare("SELECT 1 FROM test_execution_approvals WHERE project_id=? AND source_kind='db' LIMIT 1").get(pid);
    const reviewTrigger = current || (!priorRecord && priorProject) ? 'conditions-changed' : priorRecord ? 'approval-inactive' : 'initial';
    const scope = {...snapshot.scope, reviewTrigger};
    const id = `exec_${randomBytes(24).toString('base64url')}`;
    const expiresAt = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString();
    // Only the safe entry invocation is persisted, never selectors, filters or caller context.
    const request: TestCheckInput = { command: snapshot.baseCommand, cwd: snapshot.projectRoot,
      ...(snapshot.conditions ? {executionConditions:snapshot.conditions} : {safetyProfilePath:`${snapshot.root}/${snapshot.profilePath}`}),
      framework: snapshot.profile.framework, environment: snapshot.profile.environment };
    db.prepare('INSERT INTO test_execution_approvals(approval_id,project_id,profile_path,condition_id,source_kind,fingerprint,policy_hash,verifier_version,scope_json,request_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, pid, snapshot.conditions ? null : snapshot.profilePath, conditionId ?? null, snapshot.conditions ? 'db' : 'profile', snapshot.fingerprint, snapshot.policyHash,
        snapshot.conditions ? 'jev-db-execution-v1' : EXECUTION_VERIFIER_VERSION, canonicalJson(scope), canonicalJson(request), 'pending', now, expiresAt);
    db.exec('COMMIT');
    return getTestExecutionApproval(db, id)!;
  } catch (error) { if (!committed) db.exec('ROLLBACK'); throw error; }
}

export function transitionTestExecutionApproval(db: DatabaseSync, id: string, action: 'approve' | 'reject' | 'revoke', now: string): TestExecutionApproval {
  const record = getTestExecutionApproval(db, id);
  if (!record) throw new Error('Unknown execution approval ID.');
  if (action === 'approve') {
    if (record.status !== 'pending') throw new Error(`Execution review is not pending (status: ${record.status}).`);
    if (record.expiresAt && record.expiresAt <= now) {
      db.prepare("UPDATE test_execution_approvals SET status='expired' WHERE approval_id=? AND status='pending'").run(id);
      throw new Error('Execution review expired. Recheck to obtain a new review.');
    }
    const current = snapshotExecution(record.request, true);
    if (current.fingerprint !== record.fingerprint || projectId(current.projectRoot) !== record.projectId) {
      db.prepare("UPDATE test_execution_approvals SET status='superseded' WHERE approval_id=? AND status='pending'").run(id);
      throw new Error('Execution evidence changed after review creation. Recheck before approving.');
    }
    const texts = [record.request.command, ...current.evidence.map(f => f.content), ...current.related.map(f => f.content)];
    for (const policies of [loadEffectivePolicies(current.projectRoot), loadEffectiveTestPolicies(current.projectRoot, current.profile.framework)]) {
      if (texts.some(text => findPolicyMatches(policies, text).findings.some(f => f.decision === 'deny'))) throw new Error('Current policy denies the execution evidence.');
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    let result;
    if (action === 'approve') result = db.prepare("UPDATE test_execution_approvals SET status='approved',approved_at=?,expires_at=NULL WHERE approval_id=? AND status='pending' AND fingerprint=? AND expires_at>?").run(now, id, record.fingerprint, now);
    else if (action === 'reject') result = db.prepare("UPDATE test_execution_approvals SET status='rejected',rejected_at=? WHERE approval_id=? AND status='pending'").run(now, id);
    else result = db.prepare("UPDATE test_execution_approvals SET status='revoked',revoked_at=? WHERE approval_id=? AND status='approved'").run(now, id);
    if (result.changes !== 1) throw new Error('Execution approval is not in the required active state.');
    insertAudit(db, { toolName: `jev_execution_${action}`, projectId: record.projectId, targetType: 'test-execution', targetKey: record.profilePath,
      fingerprint: record.fingerprint, policyHash: record.policyHash, cacheStatus: 'disabled', finalDecision: 'review', allowed: false, needsHumanReview: false,
      reason: 'Execution approval state changed; recheck tests before execution.', summary: canonicalJson({ approvalId: id, action }) });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getTestExecutionApproval(db, id)!;
}
