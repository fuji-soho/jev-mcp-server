export type Decision = 'allow' | 'review' | 'deny';

export type HumanReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type HumanApprovalKind = 'approve_fingerprint' | 'approve_once';
export type EnvironmentApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired';

export type CommandEnvironment = 'development' | 'testing' | 'staging' | 'production' | 'unknown';

export type RiskCategory =
  | 'persistent-data'
  | 'data-loss'
  | 'filesystem'
  | 'database'
  | 'external-service'
  | 'network'
  | 'environment-isolation'
  | 'configuration'
  | 'destructive-operation'
  | 'git'
  | 'availability'
  | 'production-impact'
  | 'security'
  | 'credential'
  | 'irreversibility'
  | 'scope'
  | 'deployment'
  | 'dependencies';

export interface StaticFinding {
  ruleId: string;
  category: RiskCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  decision: Decision;
  message: string;
}

export type PolicySource = 'builtin' | 'user' | 'project';

export interface PolicyFinding {
  source: PolicySource;
  rule: string;
  category: RiskCategory;
  severity: StaticFinding['severity'];
  decision: Decision;
  reason: string;
}

export interface CommandCheckInput {
  command: string;
  cwd?: string;
  environment?: CommandEnvironment;
  target?: string;
  context?: string;
}

export interface CommandCheckResult {
  ok: boolean;
  dangerous: number | null;
  allowed: boolean;
  needsHumanReview: boolean;
  decision: Decision;
  reason: string;
  categories: RiskCategory[];
  riskScore: number | null;
  risks?: Partial<Record<RiskCategory, number>>;
  staticFindings: StaticFinding[];
  policyFindings?: PolicyFinding[];
  policyVersion: string;
  model: 'typesafe/jev' | 'static' | 'combined';
  errorCode?: string;
}

export interface TestCheckInput {
  command: string;
  testCode?: string;
  diff?: string;
  cwd?: string;
  environment?: CommandEnvironment;
  framework?: string;
  context?: string;
  isolation?: TestIsolationEvidence;
  runtime?: TestRuntimeEvidence;
  /** @deprecated Use runtime/isolation. Kept for Laravel compatibility. */
  runtimeDatabase?: RuntimeDatabaseEvidence;
  /** @deprecated Use context/runtime. Kept for Laravel compatibility. */
  configCache?: ConfigCacheEvidence;
  /** @deprecated Use runtime/isolation. Kept for Laravel compatibility. */
  runtimeGuard?: RuntimeGuardEvidence;
  /** @deprecated Use runtime.persistentStorageAccess. */
  persistentDatabaseAccess?: boolean;
  /** Automatically loads .jev/test-safety.json below cwd when present. */
  safetyProfilePath?: string;
  /** Optional test files inside the MCP-visible cwd. Files are preflighted, then evaluated and cached independently. */
  testFiles?: string[];
  /** Structured execution selection for Safety Profile v2. */
  execution?: TestExecutionSelection;
  /** Optional exact environment approval to require. */
  environmentApprovalId?: string;
}

export interface TestExecutionSelection {
  runnerId: string;
  files: string[];
  filter?: string;
}

export interface TestIsolationEvidence {
  ephemeralDatabase?: boolean | undefined;
  temporaryFilesystem?: boolean | undefined;
  mockedExternalServices?: boolean | undefined;
  isolatedWorkspace?: boolean | undefined;
}

export interface TestRuntimeEvidence {
  productionAccess?: boolean | undefined;
  persistentStorageAccess?: boolean | undefined;
  networkAccess?: boolean | undefined;
  credentialAccess?: boolean | undefined;
}

export interface TestFinding {
  ruleId: string;
  source: PolicySource | 'static';
  category: RiskCategory;
  severity: StaticFinding['severity'];
  decision: Decision;
  message: string;
}

export type TestFileErrorCode =
  | 'TEST_FILE_NOT_FOUND'
  | 'TEST_FILE_OUTSIDE_CWD'
  | 'TEST_FILE_SYMLINK'
  | 'TEST_FILE_NOT_REGULAR'
  | 'TEST_FILE_UNREADABLE';

export interface TestFileError {
  file: string;
  code: TestFileErrorCode;
  message: string;
}

export interface RuntimeDatabaseEvidence {
  connection: 'sqlite' | 'mysql' | 'mariadb' | 'pgsql' | 'sqlsrv' | 'other' | 'unknown';
  database: string;
  enforced: boolean;
}

export interface ConfigCacheEvidence {
  clearedBeforeTest: boolean;
  restoredAfterTest: boolean;
}

export interface RuntimeGuardEvidence {
  enabled: boolean;
  checksActualConnection: boolean;
  rejectsPersistentDatabase: boolean;
  rejectsFallback: boolean;
}

export interface TestCheckResult {
  ok: boolean;
  dangerous: number | null;
  allowed: boolean;
  needsHumanReview: boolean;
  decision: Decision;
  staticFindings: string[];
  findings?: TestFinding[];
  categories: RiskCategory[];
  riskScore: number | null;
  risks?: Partial<Record<RiskCategory, number>>;
  policyFindings?: PolicyFinding[];
  policyVersion: string;
  policiesApplied?: string[];
  fileErrors?: TestFileError[];
  reason: string;
  model: 'typesafe/jev';
  errorCode?: string;
  safetyProfile?: SafetyProfileAssessment;
  reviewId?: string;
  reviewIds?: string[];
  environmentReviewId?: string;
  environmentAssessment?: EnvironmentAssessment;
  codeAssessment?: CodeAssessment;
  executionAssessment?: ExecutionAssessment;
}

export interface EnvironmentAssessment {
  status: 'not-applicable' | 'missing' | 'pending' | 'approved' | 'changed' | 'expired' | 'revoked' | 'invalid';
  approvalId?: string;
  environmentFingerprint?: string;
  fingerprintMatched: boolean;
  reapprovalRequired: boolean;
  reason?: string;
  scope?: Record<string, unknown>;
}

export interface CodeAssessment {
  status: 'cache-hit' | 'evaluated' | 'stale' | 'not-evaluated';
  fingerprint?: string;
  dependencyFingerprint?: string;
}

export interface ExecutionAssessment {
  runnerMatched: boolean;
  selectorsAllowed: boolean;
  executionFingerprint?: string;
  ticket?: string;
  ticketExpiresAt?: string;
  reason?: string;
}

export interface HumanReviewRecord {
  reviewId: string;
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
  decision: 'review';
  status: HumanReviewStatus;
  approvalKind?: HumanApprovalKind;
  createdAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  expiresAt?: string;
  usedAt?: string;
}

export interface SafetyProfileAssessment {
  status: 'absent' | 'invalid' | 'unverified' | 'verified' | 'changed';
  profilePath?: string;
  profileName?: string;
  fingerprintMatched: boolean;
  runtimeMatched: boolean;
  profileDigest?: string;
  safetyFingerprint?: string;
  reason?: string;
  version?: 1 | 2;
  environmentFingerprint?: string;
  dependencyFingerprint?: string;
  runnerId?: string;
}

export interface EnvironmentApprovalRecord {
  approvalId: string;
  projectId: string;
  profileDigest: string;
  environmentFingerprint: string;
  scopeJson: string;
  verifierVersion: string;
  status: EnvironmentApprovalStatus;
  createdAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export interface JevResponse {
  model?: string;
  answers?: {
    command_dangerous?: JevNoulAnswer;
    test_dangerous?: JevNoulAnswer;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}
