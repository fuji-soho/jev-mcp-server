export type Decision = 'allow' | 'review' | 'deny';

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
  /** Optional test files. Each file is evaluated and cached independently. */
  testFiles?: string[];
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
  categories?: RiskCategory[];
  riskScore?: number | null;
  risks?: Partial<Record<RiskCategory, number>>;
  policyFindings?: PolicyFinding[];
  policyVersion?: string;
  policiesApplied?: string[];
  reason: string;
  model: 'typesafe/jev';
  errorCode?: string;
  safetyProfile?: SafetyProfileAssessment;
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
