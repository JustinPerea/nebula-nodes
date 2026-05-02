// Pre-generate the demo image / 3D / video assets used by the deterministic
// scripted-build animation. Each stage is independently runnable so we can
// iterate on prompts without redoing earlier stages:
//
//   node scripts/puppeteer-driver/pre-generate-assets.mjs v1
//   node scripts/puppeteer-driver/pre-generate-assets.mjs v2
//   node scripts/puppeteer-driver/pre-generate-assets.mjs style
//   node scripts/puppeteer-driver/pre-generate-assets.mjs mesh
//   node scripts/puppeteer-driver/pre-generate-assets.mjs video
//   node scripts/puppeteer-driver/pre-generate-assets.mjs all
//
// Outputs land in frontend/public/demo/outputs/ so the deterministic build
// script can inject them as fake "execution outputs" via updateNodeData.
//
// Keys come from settings.json at repo root (the same file Nebula's backend
// uses), not from .env.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const OUTPUTS_DIR = join(REPO_ROOT, 'frontend', 'public', 'demo', 'outputs');
const REFERENCE_PATH = join(REPO_ROOT, 'frontend', 'public', 'demo', 'clay_daedalus.png');
const SETTINGS_PATH = join(REPO_ROOT, 'settings.json');

// Prompts under review — we agreed on these in the planning chat.
// v1 deliberately omits "chibi" + reference-style anchoring so the model
// drifts toward stock realism. v2 + style + video re-anchor with the
// reference image and the figurine-aesthetic vocabulary.
const PROMPTS = {
  v1: 'a render of Daedalus the mythological inventor in flight with mechanical feathered wings, soaring across the sky',
  v2: 'Daedalus mid-flight, mechanical feathered wings spread wide, dynamic flying pose, matching reference figurine style — soft cream background, chibi proportions, blush cheeks, gold accents on wing struts, smooth sculpted aesthetic, three-quarter view',
  style: 'watercolor painting of the same figure, soft pastel washes, paper grain texture, muted palette, hand-painted feel',
};

async function loadKey(name) {
  const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
  const v = settings.apiKeys?.[name];
  if (!v) throw new Error(`${name} missing in settings.json`);
  return v;
}

// gpt-image-2 generations endpoint. Non-streaming response shape:
//   { created, data: [{ b64_json, revised_prompt? }] }
async function openaiGenerate({ key, prompt, size = '1024x1024', quality = 'high' }) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt,
      size,
      quality,
      output_format: 'png',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI generate ${res.status}: ${text.slice(0, 800)}`);
  }
  const body = await res.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenAI generate: no b64_json in response (${JSON.stringify(body).slice(0, 200)})`);
  return Buffer.from(b64, 'base64');
}

// gpt-image-2 edits endpoint. Multipart form: image[] (1+ files), prompt, model, ...
async function openaiEdit({ key, prompt, imagePaths, size = '1024x1024', quality = 'high' }) {
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', quality);
  form.append('output_format', 'png');
  for (const p of imagePaths) {
    const bytes = await readFile(p);
    const fname = p.split('/').pop();
    form.append('image[]', new Blob([bytes], { type: 'image/png' }), fname);
  }
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI edit ${res.status}: ${text.slice(0, 800)}`);
  }
  const body = await res.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenAI edit: no b64_json in response (${JSON.stringify(body).slice(0, 200)})`);
  return Buffer.from(b64, 'base64');
}

async function genV1() {
  const key = await loadKey('OPENAI_API_KEY');
  log('v1', `prompt="${PROMPTS.v1}"`);
  const t0 = Date.now();
  const buf = await openaiGenerate({ key, prompt: PROMPTS.v1 });
  const out = join(OUTPUTS_DIR, 'v1.png');
  await writeFile(out, buf);
  log('v1', `saved ${(buf.length / 1024).toFixed(0)}KB in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
  return out;
}

async function genV2() {
  const key = await loadKey('OPENAI_API_KEY');
  log('v2', `prompt="${PROMPTS.v2.slice(0, 80)}..."`);
  log('v2', `reference: ${REFERENCE_PATH}`);
  const t0 = Date.now();
  const buf = await openaiEdit({
    key,
    prompt: PROMPTS.v2,
    imagePaths: [REFERENCE_PATH],
  });
  const out = join(OUTPUTS_DIR, 'v2.png');
  await writeFile(out, buf);
  log('v2', `saved ${(buf.length / 1024).toFixed(0)}KB in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
  return out;
}

async function genStyle() {
  const key = await loadKey('OPENAI_API_KEY');
  const v2Path = join(OUTPUTS_DIR, 'v2.png');
  log('style', `prompt="${PROMPTS.style.slice(0, 80)}..."`);
  log('style', `source: ${v2Path}`);
  const t0 = Date.now();
  const buf = await openaiEdit({
    key,
    prompt: PROMPTS.style,
    imagePaths: [v2Path],
  });
  const out = join(OUTPUTS_DIR, 'style.png');
  await writeFile(out, buf);
  log('style', `saved ${(buf.length / 1024).toFixed(0)}KB in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
  return out;
}

// Meshy image-to-3d: submit job (data URI in body), poll task until SUCCEEDED,
// download the returned GLB. Pattern mirrors backend/handlers/meshy.py:22-132.
// Meshy's submit endpoint times out (504) on full-size 1.2MB+ data URIs, so
// we downscale to 768px JPEG before encoding — small body, same subject.
async function genMesh() {
  const key = await loadKey('MESHY_API_KEY');
  const v2Path = join(OUTPUTS_DIR, 'v2.png');
  log('mesh', `source: ${v2Path}`);
  const t0 = Date.now();

  // Downscale v2 to 768px JPEG using ffmpeg (always available — we use it
  // for the audio pipeline already). Meshy accepts JPEG fine.
  const smallPath = join(OUTPUTS_DIR, 'v2.small.jpg');
  await runFfmpeg([
    '-y', '-i', v2Path,
    '-vf', 'scale=768:768:flags=lanczos',
    '-q:v', '6',
    smallPath,
  ]);
  const v2Bytes = await readFile(smallPath);
  log('mesh', `downscaled to ${(v2Bytes.length / 1024).toFixed(0)}KB JPEG`);
  const dataUri = `data:image/jpeg;base64,${v2Bytes.toString('base64')}`;

  const submitRes = await fetch('https://api.meshy.ai/openapi/v1/image-to-3d', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image_url: dataUri,
      // Reasonable defaults for a chibi figurine subject. Meshy node defs
      // expose ai_model + topology; defaults give a ~3-5min job.
      ai_model: 'meshy-5',
      topology: 'triangle',
      target_polycount: 30000,
      should_remesh: true,
    }),
  });
  if (![200, 201, 202].includes(submitRes.status)) {
    throw new Error(`Meshy submit ${submitRes.status}: ${(await submitRes.text()).slice(0, 500)}`);
  }
  const submitBody = await submitRes.json();
  const taskId = submitBody.result || submitBody.id || submitBody.task_id;
  if (!taskId) throw new Error(`Meshy submit: no task id (${JSON.stringify(submitBody)})`);
  log('mesh', `task ${taskId} submitted, polling...`);

  // Poll every 3s up to ~15 min.
  const pollUrl = `https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`;
  let glbUrl = null;
  for (let i = 0; i < 300; i++) {
    await sleep(3000);
    const pr = await fetch(pollUrl, { headers: { 'Authorization': `Bearer ${key}` } });
    if (!pr.ok) throw new Error(`Meshy poll ${pr.status}: ${await pr.text()}`);
    const pd = await pr.json();
    if (i % 10 === 0) log('mesh', `poll ${i}: status=${pd.status} progress=${pd.progress ?? '-'}`);
    if (pd.status === 'SUCCEEDED') {
      glbUrl = pd.model_urls?.glb;
      if (!glbUrl) throw new Error(`Meshy SUCCEEDED but no GLB url: ${JSON.stringify(pd).slice(0, 400)}`);
      break;
    }
    if (pd.status === 'FAILED') {
      throw new Error(`Meshy task FAILED: ${JSON.stringify(pd.task_error || pd).slice(0, 500)}`);
    }
  }
  if (!glbUrl) throw new Error('Meshy timed out');

  // Download the GLB locally so the demo doesn't depend on Meshy's signed URL.
  log('mesh', `downloading GLB from ${glbUrl.slice(0, 80)}...`);
  const glbRes = await fetch(glbUrl);
  if (!glbRes.ok) throw new Error(`GLB download ${glbRes.status}`);
  const glbBuf = Buffer.from(await glbRes.arrayBuffer());
  const out = join(OUTPUTS_DIR, 'mesh.glb');
  await writeFile(out, glbBuf);
  log('mesh', `saved ${(glbBuf.length / 1024).toFixed(0)}KB in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
  return out;
}

// Veo image-to-video: predictLongRunning → poll → download mp4. Pattern mirrors
// backend/handlers/veo.py. Subtle-motion prompt keeps the chibi figure
// recognizable in the brief loop the demo uses.
const VIDEO_PROMPT =
  'the Daedalus chibi figurine flapping wings gently mid-flight, soft cloth flutter on tunic, gold wing-struts catching light, subtle bobbing motion, soft natural lighting on cream background';
const VEO_MODEL = 'veo-3.1-generate-preview';

async function genVideo() {
  const key = await loadKey('GOOGLE_API_KEY');
  const v2Path = join(OUTPUTS_DIR, 'v2.png');
  log('video', `source: ${v2Path} model: ${VEO_MODEL}`);
  log('video', `prompt: "${VIDEO_PROMPT}"`);
  const t0 = Date.now();

  const v2Bytes = await readFile(v2Path);
  const v2B64 = v2Bytes.toString('base64');

  const submitRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${VEO_MODEL}:predictLongRunning`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instances: [
          {
            prompt: VIDEO_PROMPT,
            image: { bytesBase64Encoded: v2B64, mimeType: 'image/png' },
          },
        ],
        parameters: {
          // Veo only supports 16:9 and 9:16. v2 is a square chibi figure on
          // cream background — 16:9 will letterbox naturally, no awkward
          // crop, and it composes well as a node-preview thumbnail.
          aspectRatio: '16:9',
          durationSeconds: 4,
          personGeneration: 'allow_adult',
        },
      }),
    },
  );
  if (!submitRes.ok) {
    throw new Error(`Veo submit ${submitRes.status}: ${(await submitRes.text()).slice(0, 600)}`);
  }
  const op = await submitRes.json();
  const opName = op.name;
  if (!opName) throw new Error(`Veo: no op name (${JSON.stringify(op).slice(0, 300)})`);
  log('video', `op ${opName.split('/').pop()} submitted, polling...`);

  let videoUri = null;
  let videoBytes = null;
  const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${opName}`;
  for (let i = 0; i < 300; i++) {
    await sleep(3000);
    const pr = await fetch(pollUrl, { headers: { 'x-goog-api-key': key } });
    if (!pr.ok) throw new Error(`Veo poll ${pr.status}: ${await pr.text()}`);
    const pd = await pr.json();
    if (i % 10 === 0) log('video', `poll ${i}: done=${pd.done ?? false}`);
    if (pd.done) {
      const samples =
        pd.response?.generateVideoResponse?.generatedSamples ||
        pd.response?.generatedVideos ||
        [];
      if (samples.length === 0) {
        throw new Error(`Veo done but no samples: ${JSON.stringify(pd.response || pd).slice(0, 600)}`);
      }
      videoUri = samples[0].video?.uri || samples[0].uri;
      // Some samples come inline as base64 (rare for Veo).
      const inlineB64 = samples[0].video?.bytesBase64Encoded || samples[0].bytesBase64Encoded;
      if (inlineB64) videoBytes = Buffer.from(inlineB64, 'base64');
      break;
    }
    if (pd.error) {
      throw new Error(`Veo op error: ${JSON.stringify(pd.error)}`);
    }
  }
  if (!videoBytes && videoUri) {
    log('video', `downloading from ${videoUri.slice(0, 80)}...`);
    // Veo file URIs require the same x-goog-api-key auth.
    const vr = await fetch(videoUri, { headers: { 'x-goog-api-key': key } });
    if (!vr.ok) throw new Error(`Video download ${vr.status}: ${await vr.text()}`);
    videoBytes = Buffer.from(await vr.arrayBuffer());
  }
  if (!videoBytes) throw new Error('Veo: no video bytes resolved');
  const out = join(OUTPUTS_DIR, 'video.mp4');
  await writeFile(out, videoBytes);
  log('video', `saved ${(videoBytes.length / 1024).toFixed(0)}KB in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      ff.stderr.on('data', (d) => { err += d.toString(); });
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-500)}`));
      });
    });
  });
}

async function main() {
  const stage = process.argv[2] || 'v1';
  await mkdir(OUTPUTS_DIR, { recursive: true });
  log('start', `stage=${stage} outputs=${OUTPUTS_DIR}`);

  const stages = stage === 'all' ? ['v1', 'v2', 'style', 'mesh', 'video'] : [stage];
  for (const s of stages) {
    if (s === 'v1') await genV1();
    else if (s === 'v2') await genV2();
    else if (s === 'style') await genStyle();
    else if (s === 'mesh') await genMesh();
    else if (s === 'video') await genVideo();
    else throw new Error(`unknown stage: ${s}`);
  }
  log('done', '');
}

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${tag.padEnd(8)} ${msg}`);
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
