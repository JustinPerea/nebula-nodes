#!/usr/bin/env node
/**
 * Fixture: echoes a secret-shaped environment variable to stderr, then exits.
 *
 * Used as NEBULA_DESKTOP_PYTHON (non-executable variant handled separately)
 * to test that diagnostics are sanitized and never contain credentials.
 *
 * Env:
 *   SECRET_1 — the secret to echo (e.g. sk-...)
 */
import process from 'node:process';

const secret = process.env.SECRET_1 ?? 'sk-no-secret-provided-1234567890';
process.stderr.write(`Loading config with key: ${secret}\n`);
process.stderr.write(`Authorization: Bearer ${secret}\n`);
process.exit(1);
