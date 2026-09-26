import type { Config } from './config.js';
import { checkCommandWithJev, JevError } from './cloudflare-jev.js';
import type { CommandCheckInput, CommandCheckResult } from './types.js';

const MAX_COMMAND_LENGTH = 16_000;
const MAX_CONTEXT_LENGTH = 16_000;

function reviewResult(reason: string, errorCode?: string): CommandCheckResult {
  return {
    ok: false,
    dangerous: null,
    allowed: false,
    needsHumanReview: true,
    decision: 'review',
    reason,
    model: 'typesafe/jev',
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function validateInput(input: CommandCheckInput): string | undefined {
  if (input.command.trim() === '') {
    return 'command must not be empty.';
  }
  if (input.command.length > MAX_COMMAND_LENGTH) {
    return `command exceeds the ${MAX_COMMAND_LENGTH}-character limit.`;
  }
  if (input.context !== undefined && input.context.length > MAX_CONTEXT_LENGTH) {
    return `context exceeds the ${MAX_CONTEXT_LENGTH}-character limit.`;
  }
  return undefined;
}

export async function evaluateCommand(
  config: Config,
  input: CommandCheckInput,
): Promise<CommandCheckResult> {
  const validationError = validateInput(input);
  if (validationError !== undefined) {
    return reviewResult(validationError, 'INVALID_INPUT');
  }

  try {
    const response = await checkCommandWithJev(config, input.command, input.context);
    const dangerous = response.answers?.command_dangerous?.noul;
    if (dangerous === undefined) {
      return reviewResult('Jev did not return a dangerousness score.', 'JEV_INVALID_RESPONSE');
    }

    if (dangerous >= 0.8) {
      return {
        ok: true,
        dangerous,
        allowed: false,
        needsHumanReview: false,
        decision: 'deny',
        reason: 'The command has a high probability of causing destructive or irreversible changes.',
        model: 'typesafe/jev',
      };
    }

    if (dangerous >= 0.4) {
      return {
        ok: true,
        dangerous,
        allowed: false,
        needsHumanReview: true,
        decision: 'review',
        reason: 'The command has a moderate probability of being destructive and requires human review.',
        model: 'typesafe/jev',
      };
    }

    return {
      ok: true,
      dangerous,
      allowed: true,
      needsHumanReview: false,
      decision: 'allow',
      reason: 'Jev found no clear destructive risk above the configured threshold.',
      model: 'typesafe/jev',
    };
  } catch (error) {
    if (error instanceof JevError) {
      return reviewResult(
        'Jev could not complete the safety check. Human review is required before execution.',
        error.code,
      );
    }
    return reviewResult('An unexpected error occurred during the safety check.', 'INTERNAL_ERROR');
  }
}
