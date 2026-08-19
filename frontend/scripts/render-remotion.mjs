import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import {
  makeCancelSignal,
  renderMedia,
  selectComposition,
} from '@remotion/renderer';

const COMPOSITION_ID = 'NebulaComposition';

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const requestPath = process.argv[2];
const outputLocation = process.argv[3];
if (!requestPath || !outputLocation) {
  throw new Error('usage: render-remotion.mjs <request.json> <output.mp4>');
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const entryPoint = path.resolve(scriptDir, '../src/remotion/render-entry.tsx');
const lottieLightPath = path.resolve(
  scriptDir,
  '../node_modules/lottie-web/build/player/lottie_light.js',
);
const request = JSON.parse(await readFile(requestPath, 'utf8'));
const inputProps = { manifest: request.manifest };
const { cancelSignal, cancel } = makeCancelSignal();
let cancelled = false;

process.on('SIGTERM', () => {
  cancelled = true;
  cancel();
});
process.on('SIGINT', () => {
  cancelled = true;
  cancel();
});

let serveUrl;
try {
  emit({ type: 'progress', value: 0.01, stage: 'bundling' });
  serveUrl = await bundle({
    entryPoint,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        alias: {
          ...config.resolve?.alias,
          'lottie-web': lottieLightPath,
        },
      },
    }),
    onProgress: (value) => emit({
      type: 'progress',
      value: Math.min(0.1, 0.01 + (value / 100) * 0.09),
      stage: 'bundling',
    }),
  });

  // Remotion requires the same inputProps for metadata selection and rendering.
  // Keeping this object intact is the core preview-to-export fidelity contract.
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
    logLevel: 'error',
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation,
    inputProps,
    cancelSignal,
    crf: 18,
    x264Preset: 'medium',
    colorSpace: 'bt709',
    logLevel: 'error',
    onProgress: ({ progress }) => emit({
      type: 'progress',
      value: 0.1 + progress * 0.9,
      stage: 'rendering',
    }),
  });

  emit({ type: 'complete', outputLocation });
} catch (error) {
  if (cancelled) {
    emit({ type: 'cancelled' });
    process.exitCode = 130;
  } else {
    emit({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
} finally {
  if (serveUrl) await rm(serveUrl, { recursive: true, force: true });
}
