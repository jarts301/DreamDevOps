/**
 * Cleans up a name people typed: trims it and turns every run of spaces, tabs and line
 * breaks into one space. Returns null when it isn't text, is too short or too long, or
 * holds a control character that was asked to be refused.
 */
export function normalizeName(
  value: unknown,
  rules: { readonly minLength: number; readonly maxLength: number; readonly refuseControlCharacters: boolean },
): string | null {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (name.length < rules.minLength || name.length > rules.maxLength) {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (rules.refuseControlCharacters && /[\u0000-\u001f\u007f]/.test(name)) {
    return null;
  }
  return name;
}
