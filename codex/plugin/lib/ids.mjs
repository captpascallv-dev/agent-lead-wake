import { createHash } from 'node:crypto';
// Lowercase byte encoding preserves case-sensitive logical IDs on Windows.
// Long adapter IDs need a compact filename identity; compute/cache that identity
// once, never hash report bodies, prompts or log entries during polling.
const longKeys = new Map();
export function key(value) {
  const text = String(value); const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= 80) return `id-${bytes.toString('hex')}`;
  if (!longKeys.has(text)) longKeys.set(text, `id-h${createHash('sha256').update(bytes).digest('hex')}`);
  return longKeys.get(text);
}
