/**
 * Node built-in test-runner tests for the one-time migration module
 * (desktop/migration.mjs).
 *
 * Covers VAL-MIG-007, VAL-MIG-008, VAL-MIG-009, VAL-KEY-001, VAL-KEY-002,
 * VAL-UX-002, VAL-UX-006:
 *   - First migration copies legacy data without deletion
 *   - Migrated settings do not retain plaintext API keys
 *   - Migration is idempotent and non-destructive
 *   - Migration encrypts legacy API keys to credentials.json
 *   - App Support settings contain no plaintext API keys after migration
 *   - Migration completion marker persists
 *   - Plaintext key detection warns correctly
 *
 * Tests use mock safeStorage and real temp directories — never the user's
 * real ~/.nebula/ or <repo>/settings.json.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MigrationError,
  LEGACY_DATA_SUBDIRS,
  LEGACY_STATE_FILES,
  detectPlaintextKeys,
  detectPlaintextKeysInFile,
  copyDirectoryTree,
  copyFiles,
  isMigrationNeeded,
  runMigration,
  decryptAllCredentials,
} from '../migration.mjs';
import {
  MIGRATION_STATE_FILE_NAME,
  CREDENTIALS_FILE_NAME,
  V1_PREFIX,
  readCredentialsStore,
  readMigrationState,
} from '../credentials.mjs';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

const tempDirs = [];

function mkTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'nebula-migration-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup */
    }
  }
});

/**
 * Mock safeStorage with a simple reversible transform.
 */
function createMockSafeStorage({ available = true } = {}) {
  return {
    isAsyncEncryptionAvailable: () => available,
    encryptStringAsync: async (plaintext) => {
      if (!available) throw new Error('safeStorage unavailable');
      return Buffer.from(`enc::${plaintext}`, 'utf8');
    },
    decryptStringAsync: async (buffer) => {
      if (!available) throw new Error('safeStorage unavailable');
      const str = buffer.toString('utf8');
      const plaintext = str.replace(/^enc::/, '');
      return { result: plaintext, shouldReEncrypt: false };
    },
  };
}

/**
 * Create a full set of legacy fixtures in a temp directory.
 * Returns { root, settingsPath, nebulaDir, outputDir }.
 */
function createLegacyFixtures() {
  const root = mkTemp();
  const settingsPath = join(root, 'settings.json');
  const nebulaDir = join(root, 'nebula-home');
  const outputDir = join(root, 'output');

  // Legacy settings with API keys and non-secret settings
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        apiKeys: {
          OPENAI_API_KEY: 'test-openai-fake-key',
          ANTHROPIC_API_KEY: 'test-anthropic-fake-key',
          FAL_KEY: 'test-fal-fake-key',
          GOOGLE_API_KEY: '', // empty — should be skipped
          MESHY_API_KEY: 'test-meshy-fake-key',
        },
        routing: { flux: 'fal' },
        outputPath: '/custom/output',
        executionMode: 'auto',
        batchSizeCap: 50,
        exportFolder: '/custom/exports',
        zoomTelemetryEnabled: true,
      },
      null,
      2,
    ),
  );

  // Legacy ~/.nebula/ state files
  mkdirSync(nebulaDir, { recursive: true });
  writeFileSync(join(nebulaDir, 'state.json'), JSON.stringify({ hello: 'world' }));
  writeFileSync(
    join(nebulaDir, 'provider-recoveries.json'),
    JSON.stringify({ recovery: 'data' }),
  );

  // Legacy ~/.nebula/ data subdirs
  for (const subdir of LEGACYDataSubdirs()) {
    const dir = join(nebulaDir, subdir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'item1.json'), JSON.stringify({ name: 'item1' }));
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'nested.json'), JSON.stringify({ nested: true }));
  }

  // Legacy output directory
  mkdirSync(join(outputDir, 'run-001'), { recursive: true });
  writeFileSync(join(outputDir, 'run-001', 'image.png'), 'fake-png-data');
  mkdirSync(join(outputDir, 'chat-uploads'), { recursive: true });
  writeFileSync(join(outputDir, 'chat-uploads', 'upload.txt'), 'upload-data');

  return { root, settingsPath, nebulaDir, outputDir };
}

function LEGACYDataSubdirs() {
  return LEGACY_DATA_SUBDIRS;
}

/**
 * Create an App Support directory (empty, just the root).
 */
function createAppSupport() {
  const root = mkTemp();
  mkdirSync(root, { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// detectPlaintextKeys
// ---------------------------------------------------------------------------

describe('detectPlaintextKeys', () => {
  test('returns hasPlaintext=false for empty apiKeys', () => {
    const result = detectPlaintextKeys({ apiKeys: {} });
    assert.equal(result.hasPlaintext, false);
    assert.deepEqual(result.providers, []);
  });

  test('returns hasPlaintext=false when apiKeys is absent', () => {
    const result = detectPlaintextKeys({ routing: {} });
    assert.equal(result.hasPlaintext, false);
  });

  test('detects non-empty API key values', () => {
    const result = detectPlaintextKeys({
      apiKeys: {
        OPENAI_API_KEY: 'test-fake-key-123',
        ANTHROPIC_API_KEY: '',
        FAL_KEY: '  ',
      },
    });
    assert.equal(result.hasPlaintext, true);
    assert.deepEqual(result.providers, ['OPENAI_API_KEY']);
  });

  test('detects multiple non-empty keys', () => {
    const result = detectPlaintextKeys({
      apiKeys: {
        OPENAI_API_KEY: 'test-fake-key',
        FAL_KEY: 'test-fal-key',
      },
    });
    assert.equal(result.hasPlaintext, true);
    assert.deepEqual(result.providers.sort(), ['FAL_KEY', 'OPENAI_API_KEY']);
  });

  test('handles null/undefined settings', () => {
    assert.equal(detectPlaintextKeys(null).hasPlaintext, false);
    assert.equal(detectPlaintextKeys(undefined).hasPlaintext, false);
  });
});

// ---------------------------------------------------------------------------
// detectPlaintextKeysInFile
// ---------------------------------------------------------------------------

describe('detectPlaintextKeysInFile', () => {
  test('reads file and detects plaintext keys', async () => {
    const dir = mkTemp();
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ apiKeys: { OPENAI_API_KEY: 'test-fake-key' } }));

    const result = await detectPlaintextKeysInFile(settingsPath);
    assert.equal(result.hasPlaintext, true);
    assert.deepEqual(result.providers, ['OPENAI_API_KEY']);
  });

  test('returns false for missing file', async () => {
    const result = await detectPlaintextKeysInFile(join(mkTemp(), 'nope.json'));
    assert.equal(result.hasPlaintext, false);
  });

  test('returns false for unparseable file', async () => {
    const dir = mkTemp();
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, 'NOT JSON{{{');
    const result = await detectPlaintextKeysInFile(settingsPath);
    assert.equal(result.hasPlaintext, false);
  });

  test('returns false for file with empty apiKeys', async () => {
    const dir = mkTemp();
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ apiKeys: {} }));
    const result = await detectPlaintextKeysInFile(settingsPath);
    assert.equal(result.hasPlaintext, false);
  });
});

// ---------------------------------------------------------------------------
// copyDirectoryTree
// ---------------------------------------------------------------------------

describe('copyDirectoryTree', () => {
  test('copies files recursively', async () => {
    const root = mkTemp();
    const src = join(root, 'src');
    const dest = join(root, 'dest');

    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'aaa');
    writeFileSync(join(src, 'sub', 'b.txt'), 'bbb');

    const result = await copyDirectoryTree(src, dest);
    assert.ok(result.copied.length >= 2);
    assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'aaa');
    assert.equal(readFileSync(join(dest, 'sub', 'b.txt'), 'utf8'), 'bbb');
  });

  test('skips existing destination files (idempotent)', async () => {
    const root = mkTemp();
    const src = join(root, 'src');
    const dest = join(root, 'dest');

    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'source-content');
    writeFileSync(join(dest, 'a.txt'), 'dest-content-DO-NOT-OVERWRITE');

    const result = await copyDirectoryTree(src, dest);
    assert.equal(result.copied.length, 0);
    assert.ok(result.skipped.length >= 1);
    // Destination must NOT be overwritten
    assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'dest-content-DO-NOT-OVERWRITE');
  });

  test('does nothing when source does not exist', async () => {
    const root = mkTemp();
    const result = await copyDirectoryTree(join(root, 'nope'), join(root, 'dest'));
    assert.equal(result.copied.length, 0);
  });

  test('source files are never modified', async () => {
    const root = mkTemp();
    const src = join(root, 'src');
    const dest = join(root, 'dest');

    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'original.txt'), 'original-data');

    await copyDirectoryTree(src, dest);

    // Source must be untouched
    assert.equal(readFileSync(join(src, 'original.txt'), 'utf8'), 'original-data');
  });
});

// ---------------------------------------------------------------------------
// copyFiles
// ---------------------------------------------------------------------------

describe('copyFiles', () => {
  test('copies listed files that exist', async () => {
    const root = mkTemp();
    const src = join(root, 'src');
    const dest = join(root, 'dest');

    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'state.json'), '{}');
    writeFileSync(join(src, 'provider-recoveries.json'), '{}');

    const result = await copyFiles(src, dest, ['state.json', 'provider-recoveries.json', 'missing.json']);
    assert.equal(result.copied.length, 2);
    assert.equal(result.skipped.length, 0);
    assert.ok(existsSync(join(dest, 'state.json')));
  });

  test('skips files already at destination', async () => {
    const root = mkTemp();
    const src = join(root, 'src');
    const dest = join(root, 'dest');

    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'state.json'), 'new-content');
    writeFileSync(join(dest, 'state.json'), 'existing-content');

    const result = await copyFiles(src, dest, ['state.json']);
    assert.equal(result.copied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(readFileSync(join(dest, 'state.json'), 'utf8'), 'existing-content');
  });
});

// ---------------------------------------------------------------------------
// isMigrationNeeded
// ---------------------------------------------------------------------------

describe('isMigrationNeeded', () => {
  test('returns true when no migration-state.json exists', () => {
    const dir = mkTemp();
    assert.equal(isMigrationNeeded(join(dir, 'migration-state.json')), true);
  });

  test('returns false when migration-state.json has status complete', () => {
    const dir = mkTemp();
    const statePath = join(dir, 'migration-state.json');
    writeFileSync(statePath, JSON.stringify({ status: 'complete' }));
    assert.equal(isMigrationNeeded(statePath), false);
  });

  test('returns true when migration-state.json has status failed', () => {
    const dir = mkTemp();
    const statePath = join(dir, 'migration-state.json');
    writeFileSync(statePath, JSON.stringify({ status: 'failed' }));
    assert.equal(isMigrationNeeded(statePath), true);
  });

  test('returns true when migration-state.json has status in-progress', () => {
    const dir = mkTemp();
    const statePath = join(dir, 'migration-state.json');
    writeFileSync(statePath, JSON.stringify({ status: 'in-progress' }));
    assert.equal(isMigrationNeeded(statePath), true);
  });
});

// ---------------------------------------------------------------------------
// runMigration — VAL-MIG-007, VAL-MIG-008, VAL-KEY-001, VAL-KEY-002
// ---------------------------------------------------------------------------

describe('runMigration — first launch', () => {
  test('encrypts legacy API keys to credentials.json (VAL-KEY-001)', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    const result = await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    assert.equal(result.ok, true);
    assert.ok(result.migrated.keys.length >= 4);

    // Verify credentials.json was written
    const credsPath = join(appData, CREDENTIALS_FILE_NAME);
    assert.ok(existsSync(credsPath));

    const store = readCredentialsStore(credsPath);
    assert.equal(store.version, 1);

    // Each encrypted value must start with v1: prefix (not plaintext)
    for (const provider of result.migrated.keys) {
      const blob = store.providers[provider];
      assert.ok(blob.startsWith(V1_PREFIX), `${provider} blob must start with v1:`);
      assert.ok(!blob.includes('test-fake-key'), `${provider} blob must not contain plaintext`);
    }

    // Empty key (GOOGLE_API_KEY) should NOT be in the store
    assert.equal(store.providers['GOOGLE_API_KEY'], undefined);
  });

  test('writes new settings.json with apiKeys: {} (VAL-KEY-002, VAL-MIG-008)', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    const newSettingsPath = join(appData, 'settings.json');
    assert.ok(existsSync(newSettingsPath));

    const settings = JSON.parse(readFileSync(newSettingsPath, 'utf8'));

    // apiKeys must be empty object
    assert.deepEqual(settings.apiKeys, {});

    // Non-secret settings must be preserved
    assert.equal(settings.outputPath, '/custom/output');
    assert.equal(settings.executionMode, 'auto');
    assert.equal(settings.batchSizeCap, 50);
    assert.equal(settings.exportFolder, '/custom/exports');
    assert.equal(settings.zoomTelemetryEnabled, true);
    assert.deepEqual(settings.routing, { flux: 'fal' });
  });

  test('copies legacy state files to App Support (VAL-MIG-007)', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    const stateDir = join(appData, 'state');
    assert.ok(existsSync(join(stateDir, 'state.json')));
    assert.ok(existsSync(join(stateDir, 'provider-recoveries.json')));

    const stateJson = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    assert.equal(stateJson.hello, 'world');
  });

  test('copies legacy data directories to App Support (VAL-MIG-007)', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    for (const subdir of LEGACY_DATA_SUBDIRS) {
      const destDir = join(appData, subdir);
      assert.ok(existsSync(join(destDir, 'item1.json')), `${subdir}/item1.json should exist`);
      assert.ok(existsSync(join(destDir, 'sub', 'nested.json')), `${subdir}/sub/nested.json should exist`);
    }
  });

  test('copies legacy output directory to App Support (VAL-MIG-007)', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    const outputDir = join(appData, 'output');
    assert.ok(existsSync(join(outputDir, 'run-001', 'image.png')));
    assert.ok(existsSync(join(outputDir, 'chat-uploads', 'upload.txt')));
  });

  test('NEVER deletes or modifies source files (VAL-MIG-007)', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    // Snapshot source content before migration
    const sourceSettingsBefore = readFileSync(fixtures.settingsPath, 'utf8');
    const sourceStateBefore = readFileSync(join(fixtures.nebulaDir, 'state.json'), 'utf8');
    const sourceOutputBefore = readFileSync(join(fixtures.outputDir, 'run-001', 'image.png'), 'utf8');

    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    // Source files must be byte-identical after migration
    assert.equal(readFileSync(fixtures.settingsPath, 'utf8'), sourceSettingsBefore);
    assert.equal(readFileSync(join(fixtures.nebulaDir, 'state.json'), 'utf8'), sourceStateBefore);
    assert.equal(readFileSync(join(fixtures.outputDir, 'run-001', 'image.png'), 'utf8'), sourceOutputBefore);
  });

  test('writes migration completion marker (VAL-UX-006)', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    const statePath = join(appData, MIGRATION_STATE_FILE_NAME);
    assert.ok(existsSync(statePath));

    const state = readMigrationState(statePath);
    assert.equal(state.status, 'complete');
    assert.ok(typeof state.timestamp === 'string');
  });
});

// ---------------------------------------------------------------------------
// runMigration — idempotency (VAL-MIG-009)
// ---------------------------------------------------------------------------

describe('runMigration — idempotency (VAL-MIG-009)', () => {
  test('second run does not duplicate or overwrite', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    // First migration
    const result1 = await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });
    assert.ok(result1.migrated.keys.length >= 4);
    assert.equal(result1.migrated.settings, true);

    // Modify a destination file to detect overwrite
    const destSettingsPath = join(appData, 'settings.json');
    const settingsBefore = readFileSync(destSettingsPath, 'utf8');
    const modifiedContent = JSON.stringify(
      { ...JSON.parse(settingsBefore), customUserSetting: 'DO-NOT-OVERWRITE' },
      null,
      2,
    ) + '\n';
    writeFileSync(destSettingsPath, modifiedContent);

    // Second migration
    const result2 = await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    // No new keys encrypted (already present)
    assert.equal(result2.migrated.keys.length, 0);
    // Settings file was NOT overwritten
    assert.equal(readFileSync(destSettingsPath, 'utf8'), modifiedContent);
    // Migration state still complete
    const state = readMigrationState(join(appData, MIGRATION_STATE_FILE_NAME));
    assert.equal(state.status, 'complete');
  });

  test('second run preserves destination changes in data dirs', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    // Add a new file to the destination
    const newFile = join(appData, 'characters', 'user-created.json');
    writeFileSync(newFile, JSON.stringify({ user: 'created' }));

    // Add a new file to the source
    writeFileSync(join(fixtures.nebulaDir, 'characters', 'new-source.json'), '{}');

    // Re-run migration
    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    // User-created file must still exist (not deleted)
    assert.ok(existsSync(newFile));
    // New source file should be copied (didn't exist at dest before)
    assert.ok(existsSync(join(appData, 'characters', 'new-source.json')));
    // Existing dest files should not be overwritten
    assert.ok(existsSync(join(appData, 'characters', 'item1.json')));
  });

  test('isMigrationNeeded returns false after successful migration', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    const statePath = join(appData, MIGRATION_STATE_FILE_NAME);
    assert.equal(isMigrationNeeded(statePath), false);
  });
});

// ---------------------------------------------------------------------------
// runMigration — error handling
// ---------------------------------------------------------------------------

describe('runMigration — error handling', () => {
  test('throws MigrationError when safeStorage is unavailable', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage({ available: false });

    await assert.rejects(
      () =>
        runMigration({
          appDataRoot: appData,
          legacySettingsPath: fixtures.settingsPath,
          legacyNebulaDir: fixtures.nebulaDir,
          legacyOutputDir: fixtures.outputDir,
          safeStorage,
        }),
      (err) => {
        assert.ok(err instanceof MigrationError);
        assert.equal(err.code, 'SAFE_STORAGE_UNAVAILABLE');
        return true;
      },
    );

    // No credentials.json should have been written
    assert.equal(existsSync(join(appData, CREDENTIALS_FILE_NAME)), false);
  });

  test('handles missing legacy settings gracefully', async () => {
    const root = mkTemp();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    const result = await runMigration({
      appDataRoot: appData,
      legacySettingsPath: join(root, 'nonexistent.json'),
      legacyNebulaDir: join(root, 'no-nebula'),
      legacyOutputDir: join(root, 'no-output'),
      safeStorage,
    });

    assert.equal(result.ok, true);
    assert.equal(result.migrated.keys.length, 0);
    // Still writes the completion marker
    const state = readMigrationState(join(appData, MIGRATION_STATE_FILE_NAME));
    assert.equal(state.status, 'complete');
  });
});

// ---------------------------------------------------------------------------
// runMigration — progress callbacks
// ---------------------------------------------------------------------------

describe('runMigration — progress callbacks', () => {
  test('invokes onProgress for each step', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    const steps = [];
    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
      onProgress: (step) => steps.push(step),
    });

    assert.ok(steps.includes('encrypt-keys'));
    assert.ok(steps.includes('write-settings'));
    assert.ok(steps.includes('copy-state'));
    assert.ok(steps.includes('copy-data'));
    assert.ok(steps.includes('copy-output'));
    assert.ok(steps.includes('write-marker'));
    assert.ok(steps.includes('complete'));
  });
});

// ---------------------------------------------------------------------------
// decryptAllCredentials
// ---------------------------------------------------------------------------

describe('decryptAllCredentials', () => {
  test('decrypts all stored credentials', async () => {
    const fixtures = createLegacyFixtures();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    await runMigration({
      appDataRoot: appData,
      legacySettingsPath: fixtures.settingsPath,
      legacyNebulaDir: fixtures.nebulaDir,
      legacyOutputDir: fixtures.outputDir,
      safeStorage,
    });

    const credsPath = join(appData, CREDENTIALS_FILE_NAME);
    const decrypted = await decryptAllCredentials(credsPath, safeStorage);

    assert.equal(decrypted['OPENAI_API_KEY'], 'test-openai-fake-key');
    assert.equal(decrypted['ANTHROPIC_API_KEY'], 'test-anthropic-fake-key');
    assert.equal(decrypted['FAL_KEY'], 'test-fal-fake-key');
    assert.equal(decrypted['MESHY_API_KEY'], 'test-meshy-fake-key');
    // Empty key was not migrated
    assert.equal(decrypted['GOOGLE_API_KEY'], undefined);
  });

  test('returns empty dict when no credentials file exists', async () => {
    const dir = mkTemp();
    const safeStorage = createMockSafeStorage();
    const result = await decryptAllCredentials(join(dir, 'nope.json'), safeStorage);
    assert.deepEqual(result, {});
  });
});

// ---------------------------------------------------------------------------
// runMigration — fresh launch with no legacy data
// ---------------------------------------------------------------------------

describe('runMigration — fresh launch (no legacy data)', () => {
  test('creates settings.json with empty defaults and completes', async () => {
    const root = mkTemp();
    const appData = createAppSupport();
    const safeStorage = createMockSafeStorage();

    const result = await runMigration({
      appDataRoot: appData,
      legacySettingsPath: join(root, 'no-settings.json'),
      legacyNebulaDir: join(root, 'no-nebula'),
      legacyOutputDir: join(root, 'no-output'),
      safeStorage,
    });

    assert.equal(result.ok, true);
    assert.equal(result.migrated.keys.length, 0);
    assert.equal(result.migrated.settings, true);

    // settings.json should exist with apiKeys: {}
    const settings = JSON.parse(readFileSync(join(appData, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.apiKeys, {});

    // Migration marker should be complete
    const state = readMigrationState(join(appData, MIGRATION_STATE_FILE_NAME));
    assert.equal(state.status, 'complete');
  });
});
