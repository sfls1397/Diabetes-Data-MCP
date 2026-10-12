import { it, expect, vi } from 'vitest';
import { writeKeychainSecret } from '../src/keychainWrite.js';
it('uses one stdin command, rejects truncation/injection and sanitizes errors', () => {
  const value = 'TEST_CREDENTIAL_' + 'Z'.repeat(1800);
  const exec = vi.fn(() => Buffer.from(''));
  writeKeychainSecret('fixture-service', 'fixture-account', value, exec as any);
  const call: any[] = exec.mock.calls[0];
  expect(call[0]).toBe('/usr/bin/security');
  expect(call[1]).toEqual(['-i']);
  expect(call[2].input).toContain(value);
  expect(JSON.stringify(call[1])).not.toContain(value);
  const failure = vi.fn(() => { throw new Error(value); });
  expect(() => writeKeychainSecret('fixture-service', 'fixture-account', value, failure as any)).toThrow('credential values omitted');
  for (const invalid of ['Z'.repeat(16000), 'bad\ncommand', 'bad\rcommand', 'bad\0value', '']) {
    const blocked = vi.fn();
    expect(() => writeKeychainSecret('fixture-service', 'fixture-account', invalid, blocked as any)).toThrow('credential values omitted');
    expect(blocked).not.toHaveBeenCalled();
  }
});
