const SENSITIVE_HEADER_NAME = /(auth|token|cookie|session|bearer)/i;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_NAME.test(name);
}

export function redactHeaderValue(name: string, value: string | string[] | undefined): string {
  if (isSensitiveHeader(name)) return "[REDACTED]";
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "-";
}

export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, redactHeaderValue(name, value)]),
  );
}
