/**
 * Literal value prefix used in navigation key parts.
 * When a key part starts with this prefix, it's a raw SQL literal (e.g. "5", "TRUE")
 * rather than a column name.
 */
export const LITERAL_PREFIX = '__LIT:';

/**
 * Format a join value as either a quoted column reference or a raw literal.
 * @param alias Table alias for column references
 * @param value Column name or "__LIT:value" for literals
 */
export function formatJoinValue(alias: string, value: string): string {
  if (value.startsWith(LITERAL_PREFIX)) {
    return value.substring(LITERAL_PREFIX.length);
  }
  return `"${alias}"."${value}"`;
}

/**
 * Check if a key part is a literal value (not a column reference).
 */
export function isLiteralKeyPart(value: string): boolean {
  return value.startsWith(LITERAL_PREFIX);
}
