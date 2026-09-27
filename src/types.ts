export type Decision = 'allow' | 'review' | 'deny';

export type CommandEnvironment = 'development' | 'testing' | 'staging' | 'production' | 'unknown';

export type RiskCategory =
  | 'data-loss'
  | 'filesystem'
  | 'database'
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
  context?: string;
  runtimeDatabase?: RuntimeDatabaseEvidence;
  configCache?: ConfigCacheEvidence;
  runtimeGuard?: RuntimeGuardEvidence;
  persistentDatabaseAccess?: boolean;
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
  reason: string;
  model: 'typesafe/jev';
  errorCode?: string;
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
