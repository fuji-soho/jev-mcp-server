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

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export interface JevResponse {
  model?: string;
  answers?: {
    command_dangerous?: JevNoulAnswer;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}
