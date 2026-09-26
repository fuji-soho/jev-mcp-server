export type Decision = 'allow' | 'review' | 'deny';

export interface CommandCheckInput {
  command: string;
  context?: string;
}

export interface CommandCheckResult {
  ok: boolean;
  dangerous: number | null;
  allowed: boolean;
  needsHumanReview: boolean;
  decision: Decision;
  reason: string;
  model: 'typesafe/jev';
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
