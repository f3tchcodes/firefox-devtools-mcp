/**
 * Integration tests for BiDi sendCommand
 * Tests with real Firefox browser in headless mode
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestFirefox, closeFirefox } from '../../helpers/firefox.js';
import type { FirefoxClient } from '@/firefox/index.js';

describe('BiDi sendCommand Integration Tests', () => {
  let firefox: FirefoxClient;

  beforeAll(async () => {
    firefox = await createTestFirefox();
  });

  afterAll(async () => {
    await closeFirefox(firefox);
  });

  function evaluateSlowScript(timeout: number) {
    return firefox.sendBiDiCommand(
      'script.evaluate',
      {
        expression: 'new Promise((r) => setTimeout(() => r(42), 500))',
        awaitPromise: true,
        target: { context: firefox.getCurrentContextId()! },
      },
      { timeout }
    );
  }

  it('should reject when the command takes longer than the timeout', async () => {
    await expect(evaluateSlowScript(100)).rejects.toThrow('BiDi command timeout: script.evaluate');
  });

  it('should resolve when the command completes within the timeout', async () => {
    const result = await evaluateSlowScript(5000);
    expect(result).toMatchObject({ type: 'success', result: { type: 'number', value: 42 } });
  });
});
