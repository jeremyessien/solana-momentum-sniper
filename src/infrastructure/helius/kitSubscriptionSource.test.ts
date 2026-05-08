import { describe, expect, test } from 'vitest';
import { transformLogsNotification } from './kitSubscriptionSource.js';

describe('transformLogsNotification', () => {
  test('maps a successful notification to ProgramLogEvent', () => {
    const result = transformLogsNotification({
      context: { slot: 5208469n },
      value: {
        signature: 'sig123',
        logs: ['Program log: hello'],
        err: null,
      },
    });
    expect(result).toEqual({
      signature: 'sig123',
      slot: 5208469n,
      logs: ['Program log: hello'],
      err: null,
    });
  });

  test('maps a failed notification preserving err and empty logs', () => {
    const result = transformLogsNotification({
      context: { slot: 100n },
      value: {
        signature: 'failedSig',
        logs: [],
        err: { InstructionError: [0, 'Custom'] },
      },
    });
    expect(result.signature).toBe('failedSig');
    expect(result.slot).toBe(100n);
    expect(result.logs).toEqual([]);
    expect(result.err).toEqual({ InstructionError: [0, 'Custom'] });
  });
});
