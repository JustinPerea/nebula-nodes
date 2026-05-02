// Generate a music bed for the full stitched demo and mix it under the
// existing audio with sidechain ducking (so music dips when Daedalus
// speaks). Reuses build-vo's generateMusic + music-cache convention.
//
// Usage:
//   node --env-file=.env scripts/voiceover/add-music-to-stitch.mjs \
//     <input.mp4> [output.mp4]
//
// If output is omitted, writes alongside input as `<basename>-with-music.mp4`.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MUSIC_CACHE_DIR = join(__dirname, 'music-cache');

const MUSIC_PROMPT =
  'Hybrid orchestral-electronic film score — mythic Greek meets modern. Deep analog synth-bass drone, sparse plucked lyre arpeggios, ' +
  'melancholic duduk solo line, wordless soprano choir entering at swells, modal Phrygian harmony, warm analog synth pads, ' +
  'subtle filtered electronic pulse, distant glitched synth flourishes, ancient yet wired with circuits, ' +
  '65 bpm, instrumental, no vocals, sense of an inventor\'s workshop at dawn.';

const MUSIC_VOLUME = 0.20;
const FADE_IN_SEC = 1.5;
const FADE_OUT_SEC = 2.5;
const DUCK_THRESHOLD = 0.04;
const DUCK_RATIO = 10;
const DUCK_ATTACK = 5;
const DUCK_RELEASE = 350;
const MODEL_ID = 'music_v1';

function probeDuration(path) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ff.stdout.on('data', (d) => { out += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}`));
      resolve(parseFloat(out.trim()));
    });
  });
}

async function generateMusic({ apiKey, prompt, durationMs, outPath }) {
  console.log(`[music] generating ${durationMs}ms via ElevenLabs music_v1`);
  const resp = await fetch('https://api.elevenlabs.io/v1/music/stream', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      music_length_ms: durationMs,
      force_instrumental: true,
      model_id: MODEL_ID,
    }),
  });
  if (!resp.ok) throw new Error(`ElevenLabs Music ${resp.status}: ${await resp.text()}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(outPath, buf);
  return outPath;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}\n${stderr.slice(-2000)}`));
      resolve();
    });
  });
}

async function main() {
  const inputPath = resolve(process.argv[2] || '');
  if (!inputPath || !existsSync(inputPath)) {
    console.error('Usage: node --env-file=.env scripts/voiceover/add-music-to-stitch.mjs <input.mp4> [output.mp4]');
    process.exit(1);
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  const outPath = process.argv[3]
    ? resolve(process.argv[3])
    : join(dirname(inputPath), basename(inputPath, '.mp4') + '-with-music.mp4');

  const videoDuration = await probeDuration(inputPath);
  const requestedMs = Math.round(videoDuration * 1000);
  console.log(`[music] input video duration: ${videoDuration.toFixed(2)}s`);

  await mkdir(MUSIC_CACHE_DIR, { recursive: true });
  const cacheKey = createHash('md5')
    .update(JSON.stringify({
      prompt: MUSIC_PROMPT,
      durationMs: requestedMs,
      forceInstrumental: true,
      modelId: MODEL_ID,
    }))
    .digest('hex');
  const musicCachedPath = join(MUSIC_CACHE_DIR, `${cacheKey}.mp3`);
  const musicWorkPath = join(dirname(outPath), 'music.mp3');

  if (existsSync(musicCachedPath)) {
    console.log(`[music] cache HIT — ${cacheKey}`);
    const buf = await readFile(musicCachedPath);
    await writeFile(musicWorkPath, buf);
  } else {
    console.log(`[music] cache miss — generating new bed`);
    await generateMusic({ apiKey, prompt: MUSIC_PROMPT, durationMs: requestedMs, outPath: musicWorkPath });
    const buf = await readFile(musicWorkPath);
    await writeFile(musicCachedPath, buf);
  }
  console.log(`[music] bed at ${musicWorkPath}`);

  // Mix music with input audio using sidechain compression. Input audio
  // (voice + sfx) is the duck key; music gets compressed when voice is
  // loud. apad on the sidechain key ensures the compressor keeps emitting
  // through the music's full duration even if voice ends earlier.
  const fadeOutStart = Math.max(0, videoDuration - FADE_OUT_SEC);
  const filterComplex = [
    `[0:a]asplit=2[voice_out][voice_key_raw]`,
    `[voice_key_raw]apad=whole_dur=${videoDuration.toFixed(2)}[voice_key]`,
    `[1:a]atrim=duration=${videoDuration.toFixed(2)},` +
      `afade=t=in:st=0:d=${FADE_IN_SEC},` +
      `afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${FADE_OUT_SEC},` +
      `volume=${MUSIC_VOLUME.toFixed(3)}[music_pre]`,
    `[music_pre][voice_key]sidechaincompress=` +
      `threshold=${DUCK_THRESHOLD}:ratio=${DUCK_RATIO}:` +
      `attack=${DUCK_ATTACK}:release=${DUCK_RELEASE}[music_ducked]`,
    `[voice_out][music_ducked]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0,aresample=async=1[a]`,
  ].join(';');

  console.log(`[music] muxing → ${outPath}`);
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-i', musicWorkPath,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '256k',
    '-ar', '44100',
    outPath,
  ]);

  const finalDur = await probeDuration(outPath);
  console.log(`[music] wrote ${outPath} (${finalDur.toFixed(2)}s)`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
