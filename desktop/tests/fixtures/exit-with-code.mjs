#!/usr/bin/env node
/**
 * Fixture: writes a distinctive stderr line, then exits with a given code.
 *
 * Used as NEBULA_DESKTOP_PYTHON to test pre-readiness early-exit failures.
 * Ignores any uvicorn-style arguments passed by the sidecar module.
 *
 * Env:
 *   FIXTURE_EXIT_CODE  — exit code (default 7)
 *   FIXTURE_STDERR     — stderr message (default distinctive line)
 */
import process from 'node:process';

const code = parseInt(process.env.FIXTURE_EXIT_CODE ?? '7', 10);
const msg = process.env.FIXTURE_STDERR ?? 'DISTINCTIVE_FIXTURE_STDERR_LINE';
process.stderr.write(`${msg}\n`);
process.exit(code);
