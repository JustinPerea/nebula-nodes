// Per-section render pipeline. Takes a section run directory + the
// section's directives + voice config, produces a final mp4 the user
// can review in isolation.
//
// Usage:
//   node scripts/puppeteer-driver/sections/build-section.mjs \
//     <run-dir> <directives.json> <voice.json>

import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';

async function runFfmpegOrNode(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

async function main() {
  const [runDir, directivesPath, voiceConfigPath] = process.argv.slice(2);
  if (!runDir || !directivesPath || !voiceConfigPath) {
    console.error('Usage: build-section.mjs <run-dir> <directives.json> <voice.json>');
    process.exit(1);
  }

  // Load directives, write into the run dir as zoom-directives.json so
  // apply-zoom finds it. Inject the recording path + duration from the
  // events.json so apply-zoom has the metadata it expects.
  const events = JSON.parse(await readFile(join(runDir, 'events.json'), 'utf8'));
  const directives = JSON.parse(await readFile(directivesPath, 'utf8'));
  const recordingPath = events.recording?.path;
  if (!recordingPath) throw new Error('events.json has no recording.path');
  // Probe recording duration via ffprobe.
  const duration = await new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      recordingPath,
    ]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('exit', (code) => code === 0 ? resolve(parseFloat(out.trim())) : reject(new Error(`ffprobe ${code}`)));
    proc.on('error', reject);
  });

  const zd = {
    runId: events.runId,
    recordingPath,
    duration,
    viewport: events.viewport,
    momentCount: directives.length,
    directives,
  };
  await writeFile(join(runDir, 'zoom-directives.json'), JSON.stringify(zd, null, 2));
  console.log(`[build-section] wrote zoom-directives.json (${directives.length} directives, duration=${duration.toFixed(2)}s)`);

  // Apply zoom — uses the existing pipeline.
  console.log('[build-section] apply-zoom →');
  await runFfmpegOrNode('node', ['scripts/puppeteer-driver/apply-zoom.mjs', runDir]);

  // Build VO + drawtext captions on top of zoomed.mp4.
  const zoomedPath = join(runDir, 'zoomed.mp4');
  console.log('[build-section] build-vo →');
  await runFfmpegOrNode('node', ['--env-file=.env', 'scripts/voiceover/build-vo.mjs', voiceConfigPath, zoomedPath]);

  console.log(`[build-section] done → ${join(runDir, 'zoomed-with-voice.mp4')}`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
