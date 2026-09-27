const MAX_AUDIT_TEXT = 2_000;

export function sanitizeAuditText(value: string | undefined, limit = MAX_AUDIT_TEXT): string | null {
  if (value === undefined) return null;
  let safe = value
    .replace(/-----BEGIN(?: [^-]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [^-]+)? PRIVATE KEY-----/giu, '[REDACTED_PRIVATE_KEY]')
    .replace(/(authorization\s*:\s*bearer\s+|bearer\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|private[_-]?key|access[_-]?key|credential|cookie)\s*[=:]\s*)[^\s,;&\n]+/giu, '$1[REDACTED]')
    .replace(/(--?(?:token|password|secret|api[-_]?key|access[-_]?key|private[-_]?key|cookie)(?:=|\s+))[^\s,;&]+/giu, '$1[REDACTED]')
    .replace(/((?:mysql|postgres(?:ql)?|mariadb|sqlserver):\/\/)([^\s/@]+):([^\s/@]+)@/giu, '$1[REDACTED]:[REDACTED]@');
  if (safe.length > limit) safe = `${safe.slice(0, Math.max(0, limit - 14))}...[truncated]`;
  return safe;
}

export function sanitizeAuditSummary(value: string | undefined): string | null {
  return sanitizeAuditText(value, 1_000);
}
