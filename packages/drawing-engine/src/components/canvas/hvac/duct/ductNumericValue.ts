/** Parse a complete numeric entry without silently changing the designer's value. */
export function parseDuctNumber(text: string, min: number, max: number, allowEmpty = false):
  | { valid: true; value: number | null }
  | { valid: false; message: string } {
  if (text.trim() === '') {
    return allowEmpty ? { valid: true, value: null } : { valid: false, message: 'Enter a value.' };
  }
  // Accept decimal and scientific notation, never partial numbers or hex literals.
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) {
    return { valid: false, message: 'Enter a number.' };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { valid: false, message: 'Enter a finite number.' };
  if (value < min || value > max) return { valid: false, message: `Enter ${min} to ${max}.` };
  return { valid: true, value };
}
