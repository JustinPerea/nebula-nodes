#!/usr/bin/env node
/**
 * Fixture: floods stderr with numbered lines (megabytes of output), then
 * exits with code 1.
 *
 * Used to verify that retained diagnostics are a bounded tail and do not
 * retain the full child stream.
 */
import process from 'node:process';

const TOTAL = 100_000;
for (let i = 1; i <= TOTAL; i++) {
  process.stderr.write(`FLOOD_LINE_${i}\n`);
}
process.exit(1);
