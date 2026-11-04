// @vitest-environment node
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverBackend, discoverFrontend, runPytest } from '../../scripts/check-ratchets.mjs';

/**
 * scripts/check-ratchets.mjs (npm run check:ratchets) finds every test that reads the source or docs
 * from disk. These pin its discovery and its isolated backend environment.
 */

describe('check-ratchets discovery', () => {
  it('finds a known disk-reading frontend test and skips a pure unit test', () => {
    const found = discoverFrontend();
    expect(found).toContain('tests/deleteLandedRatchet.test.ts');
    expect(found).toContain('tests/checkRatchets.test.ts');
    expect(found).not.toContain('tests/agentCursor.test.ts');
  });

  it('finds a known source-walking backend test, a docs-reading one, and the fixed list', () => {
    const found = discoverBackend();
    expect(found).toContain('tests/test_error_copy_round3c2.py');
    expect(found).toContain('tests/test_graph_file_client.py');
    expect(found).toContain('tests/test_ci_shard.py');
  });
});

describe('check-ratchets isolated backend run', () => {
  it('runs pytest with a temp HOME and no shard, then deletes the temp dir', () => {
    const probeDir = mkdtempSync(path.join(tmpdir(), 'ratchet-probe-'));
    try {
      writeFileSync(
        path.join(probeDir, 'test_probe.py'),
        [
          'import os',
          'def test_probe():',
          '    assert "NEBULA_TEST_SHARD" not in os.environ',
          '    home = os.environ["HOME"]',
          '    assert home != os.environ["REAL_HOME"]',
          '    for key in ("NEBULA_SETTINGS_PATH", "NEBULA_STATE_DIR", "NEBULA_OUTPUT_ROOT"):',
          '        assert os.environ[key].startswith(home + os.sep)',
          '    assert os.path.isdir(home)',
          '',
        ].join('\n'),
      );
      const previous = process.env.NEBULA_TEST_SHARD;
      process.env.NEBULA_TEST_SHARD = '1/3';
      let result;
      try {
        result = runPytest(['test_probe.py'], { cwd: probeDir, extraEnv: { REAL_HOME: homedir() } });
      } finally {
        if (previous === undefined) delete process.env.NEBULA_TEST_SHARD;
        else process.env.NEBULA_TEST_SHARD = previous;
      }
      expect(result.output).toContain('1 passed');
      expect(result.status).toBe(0);
      expect(existsSync(result.tmp)).toBe(false);
      expect(result.tmp.startsWith(tmpdir())).toBe(true);
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
