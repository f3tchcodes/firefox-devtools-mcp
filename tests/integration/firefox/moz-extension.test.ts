/**
 * Integration tests for BiDi navigation
 * Tests with real Firefox browser in headless mode.
 *
 * Navigation uses BiDi browsingContext.navigate for all URLs.
 * Standard schemes (http/https/data/blob/file) use wait:"interactive".
 * Non-standard schemes (moz-extension:, about:) use wait:"none" because
 * the Remote Agent doesn't emit navigation completion events for
 * extension/privileged contexts.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { createTestFirefox, closeFirefox, waitFor } from '../../helpers/firefox.js';
import type { FirefoxClient } from '@/firefox/index.js';
import { compareVersions } from '@/utils/version.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { zipSync } from 'fflate';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturesPath = resolve(__dirname, '../../fixtures');
const extensionDir = resolve(fixturesPath, 'test-extension');
const xpiPath = resolve(fixturesPath, 'test-extension.xpi');

function packExtension(): void {
  // Remove stale .xpi so the archive is always rebuilt from the fixture
  if (existsSync(xpiPath)) {
    unlinkSync(xpiPath);
  }
  // Packed in-process: the `zip` binary this used to call does not exist on Windows.
  const entries = Object.fromEntries(
    ['manifest.json', 'popup.html'].map((name) => [name, readFileSync(resolve(extensionDir, name))])
  );
  writeFileSync(xpiPath, zipSync(entries));
}

/**
 * Get the moz-extension:// hostname for an installed extension by switching
 * to a chrome-privileged context and querying WebExtensionPolicy.
 * Requires MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1.
 */
async function getExtensionHostname(firefox: FirefoxClient, extensionId: string): Promise<string> {
  const treeResult = await firefox.sendBiDiCommand('browsingContext.getTree', {
    'moz:scope': 'chrome',
  });
  const contexts = treeResult.contexts || [];
  if (contexts.length === 0) {
    throw new Error('No chrome contexts available');
  }

  const driver = firefox.getDriver();
  const originalContextId = firefox.getCurrentContextId();
  const chromeContextId = contexts[0].context;

  try {
    await driver.switchTo().window(chromeContextId);
    await driver.setContext('chrome');

    const hostname = await driver.executeAsyncScript(`
      const callback = arguments[arguments.length - 1];
      const extensionId = ${JSON.stringify(extensionId)};
      (async () => {
        try {
          const policy = WebExtensionPolicy.getByID(extensionId);
          callback(policy ? policy.mozExtensionHostname : '');
        } catch { callback(''); }
      })();
    `);

    if (!hostname) {
      throw new Error(
        `Could not resolve hostname for extension ${extensionId}, got: ${JSON.stringify(hostname)}`
      );
    }
    return hostname as string;
  } finally {
    try {
      await driver.setContext('content');
      if (originalContextId) {
        await driver.switchTo().window(originalContextId);
      }
    } catch (e) {
      console.warn('Failed to restore context after getExtensionHostname:', e);
    }
  }
}

describe('BiDi Navigation Integration Tests', () => {
  let firefox: FirefoxClient;
  let extensionUrl: string;
  let extensionId: string;
  let listExtensionsSupported = false;

  beforeAll(async () => {
    packExtension();

    // MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 is required to resolve the extension hostname
    firefox = await createTestFirefox({
      env: { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    });

    // Install the test extension
    const installResult = await firefox.sendBiDiCommand('webExtension.install', {
      extensionData: { type: 'archivePath', path: xpiPath },
    });
    extensionId = installResult?.extension;
    if (!extensionId) {
      throw new Error(`Extension install returned no ID, got: ${JSON.stringify(installResult)}`);
    }

    // Resolve the moz-extension:// URL from the extension hostname
    const hostname = await getExtensionHostname(firefox, extensionId);
    extensionUrl = `moz-extension://${hostname}/popup.html`;

    // webExtension.moz:listExtensions needs Firefox 158
    const version = firefox.getFirefoxVersion();
    listExtensionsSupported = version !== null && compareVersions(version, '158.0') >= 0;
  });

  afterAll(async () => {
    // Uninstall the test extension to avoid accumulation across test runs
    if (extensionId) {
      try {
        await firefox.sendBiDiCommand('webExtension.uninstall', { extension: extensionId });
      } catch {
        // Ignore errors - the extension might already be gone
      }
    }
    await closeFirefox(firefox);
    // Remove the packed .xpi so no build artifact remains on disk
    if (existsSync(xpiPath)) {
      unlinkSync(xpiPath);
    }
  });

  // Reset to a clean state between tests
  afterEach(async () => {
    try {
      await firefox.navigate('about:blank');
    } catch {
      // Best-effort reset
    }
  });

  it('should navigate to moz-extension:// URL without hanging', async () => {
    // Non-standard schemes use wait:"none" because the Remote Agent
    // doesn't emit navigation completion events for extension contexts.
    await firefox.navigate(extensionUrl);

    // Poll for the page URL since wait:none returns before the page loads
    const driver = firefox.getDriver();
    await waitFor(async () => {
      const url = await driver.getCurrentUrl();
      return url.includes('moz-extension://');
    }, 5000);

    // Wait for the page title to be updated.
    await waitFor(async () => !!(await driver.getTitle()), 5000);

    const title = await driver.getTitle();
    expect(title).toBe('MCP Test Extension');
  }, 15000);

  it('should create new page with moz-extension:// URL without hanging', async () => {
    await firefox.createNewPage(extensionUrl);

    // Poll for the page URL since wait:none returns before the page loads
    const driver = firefox.getDriver();
    await waitFor(async () => {
      const url = await driver.getCurrentUrl();
      return url.includes('moz-extension://');
    }, 5000);

    // Wait for the page title to be updated.
    await waitFor(async () => !!(await driver.getTitle()), 5000);

    const title = await driver.getTitle();
    expect(title).toBe('MCP Test Extension');

    // Clean up the created tab
    try {
      const handles = await driver.getAllWindowHandles();
      if (handles.length > 1) {
        await driver.close();
        const remaining = await driver.getAllWindowHandles();
        if (remaining.length > 0) {
          await driver.switchTo().window(remaining[0]);
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }, 15000);

  describe('listExtensions', () => {
    beforeEach((ctx) => {
      if (!listExtensionsSupported) {
        console.warn('Skipping listExtensions tests: requires Firefox 158 or later');
        ctx.skip();
      }
    });

    it('returns the installed extension with its policy data', async () => {
      const extensions = await firefox.listExtensions({ ids: [extensionId] });

      expect(extensions).toHaveLength(1);
      const extension = extensions[0];
      expect(extension.id).toBe(extensionId);
      expect(extension.name).toBe('MCP Test Extension');
      expect(extension.version).toBe('1.0');
      expect(extension.manifestVersion).toBe(2);
      expect(extension.isActive).toBe(true);
      expect(extension.isSystem).toBe(false);
      expect(extension.policy?.uuid).toBeTruthy();
      expect(extension.policy?.baseURL).toBeTruthy();
      expect(extension.policy?.backgroundScripts).toEqual([]);
    }, 15000);

    it('filters by exact id', async () => {
      const known = await firefox.listExtensions({
        ids: [extensionId, 'nonexistent-mcp-test@example.invalid'],
      });
      expect(known).toHaveLength(1);
      expect(known[0].id).toBe(extensionId);

      const unknown = await firefox.listExtensions({
        ids: ['nonexistent-mcp-test@example.invalid'],
      });
      expect(unknown).toHaveLength(0);
    }, 15000);

    it('filters by partial name, case-insensitively', async () => {
      const byName = await firefox.listExtensions({ name: 'mcp test exte' });
      expect(byName.map((extension) => extension.id)).toContain(extensionId);

      const mismatch = await firefox.listExtensions({ ids: [extensionId], name: 'no-such-name' });
      expect(mismatch).toHaveLength(0);
    }, 15000);

    it('filters by active status', async () => {
      const active = await firefox.listExtensions({ ids: [extensionId], isActive: true });
      expect(active).toHaveLength(1);

      const inactive = await firefox.listExtensions({ ids: [extensionId], isActive: false });
      expect(inactive).toHaveLength(0);
    }, 15000);

    it('applies all filters together', async () => {
      const match = await firefox.listExtensions({
        ids: [extensionId],
        name: 'MCP',
        isActive: true,
      });
      expect(match).toHaveLength(1);

      const mismatch = await firefox.listExtensions({
        ids: [extensionId],
        name: 'MCP',
        isActive: false,
      });
      expect(mismatch).toHaveLength(0);
    }, 15000);
  });
});
