// Build a beat-aligned voiceover and mux it into a target video.
//
// Usage:
//   node scripts/voiceover/build-vo.mjs <config.json> <video.mp4>
//
// Config schema:
//   {
//     "voice":  "onyx",          // OpenAI TTS preset (alloy|echo|fable|onyx|nova|shimmer)
//     "speed":  0.92,            // 0.25–4.0; <1 = slower
//     "model":  "tts-1-hd",      // tts-1 or tts-1-hd
//     "segments": [
//       { "startSec": 1.7, "text": "..." [, "voice": "...", "speed": ..., "gain": 1.0] },
//       ...
//     ]
//   }
//
// Each segment is generated as a separate mp3 via OpenAI TTS, then ffmpeg's
// adelay places it at startSec inside the final audio track. amix mixes them
// with the (silent) video track. So the timing of each spoken line is
// deterministic — change startSec and re-run to relock the cut.
//
// Output: <video_dir>/zoomed-with-voice.mp4 alongside the source mp4.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// On-disk caches so re-runs don't re-bill the API for unchanged content.
// Hash key includes every input that affects the audio bytes (text, voice,
// model, voiceSettings, prompt, duration, etc.), so any edit to those values
// busts the cache automatically. SFX cached since the SFX feature shipped;
// TTS + music cache added later — same pattern. Pass --no-cache to bypass.
const SFX_CACHE_DIR = join(__dirname, 'sfx-cache');
const TTS_CACHE_DIR = join(__dirname, 'tts-cache');
const MUSIC_CACHE_DIR = join(__dirname, 'music-cache');
const CACHE_DISABLED = process.argv.includes('--no-cache');

async function main() {
  const configPath = process.argv[2];
  const videoPath = process.argv[3];
  if (!configPath || !videoPath) {
    console.error('Usage: node build-vo.mjs <config.json> <video.mp4>');
    process.exit(1);
  }

  const apiKeys = {
    openai: process.env.OPENAI_API_KEY,
    elevenlabs: process.env.ELEVENLABS_API_KEY,
  };

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const {
    // provider: "openai" (default, uses tts-1-hd voices like onyx) or
    // "elevenlabs" (uses voice IDs from ELEVENLABS_VOICES below).
    provider = 'openai',
    voice = provider === 'elevenlabs' ? 'Adam' : 'onyx',
    speed = 0.92,
    model = provider === 'elevenlabs' ? 'eleven_multilingual_v2' : 'tts-1-hd',
    // ElevenLabs voice_settings (provider=elevenlabs only). Higher stability
    // = steadier delivery, lower = more expressive. similarity_boost preserves
    // the preset's character. style adds emotional tilt.
    voiceSettings = { stability: 0.45, similarity_boost: 0.80, style: 0.20, use_speaker_boost: true },
    // postFilter: ffmpeg audio-filter chain applied to every voice segment
    // BEFORE it gets adelay'd onto the timeline. Used to shape the voice's
    // tone (pitch shift, EQ, level). When reverbFilter is also set, this
    // applies to BOTH the dry and wet paths — keeping the reverb tonally
    // matched to the dry voice. Skip (null/"") to pass-through.
    postFilter = null,
    // reverbFilter + reverbMix: parallel reverb send. When set, each segment
    // is split into dry and wet busses; both run through postFilter, the wet
    // bus additionally runs through reverbFilter and is attenuated to
    // reverbMix (0..1) before being mixed back under the dry. The result is
    // a clear, consonant-forward dry voice with reverb sitting underneath
    // instead of washing the whole signal.
    reverbFilter = null,
    reverbMix = 0.35,
    // music: optional block. If present, generates a background underscore
    // via ElevenLabs Music API and sidechain-ducks it under the voice.
    //   { prompt, durationMs, volume, fadeInSec, fadeOutSec, forceInstrumental }
    music = null,
    // sfx: optional array. Each entry generates a clip via ElevenLabs Sound
    // Effects API and lays it on the timeline at startSec. Used for diegetic
    // ambience (mouse clicks, keyboard typing) timed to the visuals. Cached
    // by md5(prompt + durationSec) in scripts/voiceover/sfx-cache/ so repeat
    // runs don't burn API credits.
    //   { startSec, prompt, durationSec, volume?, promptInfluence? }
    sfx = [],
    segments,
  } = config;

  if (provider === 'openai' && !apiKeys.openai) {
    throw new Error('provider=openai but OPENAI_API_KEY not set');
  }
  if (provider === 'elevenlabs' && !apiKeys.elevenlabs) {
    throw new Error('provider=elevenlabs but ELEVENLABS_API_KEY not set');
  }
  if (music && !apiKeys.elevenlabs) {
    throw new Error('config.music requires ELEVENLABS_API_KEY (run --env-file=.env)');
  }
  if (sfx.length > 0 && !apiKeys.elevenlabs) {
    throw new Error('config.sfx requires ELEVENLABS_API_KEY (run --env-file=.env)');
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('config.segments is required and must be non-empty');
  }

  const videoDir = dirname(videoPath);
  const voDir = join(videoDir, 'voiceover');
  await mkdir(voDir, { recursive: true });

  // Generate each segment as its own mp3, measure duration so we can warn
  // if a line will overrun the start of the next one. Cached by hash of all
  // params that affect the bytes (provider, voice, text, model, settings,
  // speed) so re-runs with unchanged lines are free.
  await mkdir(TTS_CACHE_DIR, { recursive: true });
  const generated = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segPath = join(voDir, `seg-${String(i).padStart(2, '0')}.mp3`);
    const segVoice = seg.voice ?? voice;
    const segSpeed = seg.speed ?? speed;

    const ttsCacheKey = createHash('md5')
      .update(JSON.stringify({
        provider, voice: segVoice, text: seg.text, model,
        voiceSettings, speed: segSpeed,
      }))
      .digest('hex');
    const ttsCachedPath = join(TTS_CACHE_DIR, `${ttsCacheKey}.mp3`);
    const ttsCached = !CACHE_DISABLED && (await fileExists(ttsCachedPath));

    console.log(
      `[vo] segment ${i}: start=${seg.startSec}s provider=${provider} voice=${segVoice} ` +
        `cache=${ttsCached ? 'HIT' : 'miss'} text="${seg.text.slice(0, 60)}${seg.text.length > 60 ? '…' : ''}"`,
    );

    let buf;
    if (ttsCached) {
      buf = await readFile(ttsCachedPath);
    } else {
      buf = await generateTtsSegment({
        provider,
        apiKeys,
        text: seg.text,
        voice: segVoice,
        speed: segSpeed,
        model,
        voiceSettings,
      });
      await writeFile(ttsCachedPath, buf);
    }
    await writeFile(segPath, buf);
    const duration = await probeDuration(segPath);
    console.log(`[vo]   → ${basename(segPath)}  duration=${duration.toFixed(2)}s`);
    generated.push({ path: segPath, startSec: seg.startSec, duration, gain: seg.gain ?? 1.0 });
  }

  // Sanity check: warn if any segment overruns the next one's start.
  for (let i = 0; i < generated.length - 1; i++) {
    const end = generated[i].startSec + generated[i].duration;
    const next = generated[i + 1].startSec;
    if (end > next + 0.01) {
      console.warn(
        `[vo] WARNING: segment ${i} ends at ${end.toFixed(2)}s but segment ${i + 1} ` +
          `starts at ${next}s (overlap ${(end - next).toFixed(2)}s). ` +
          `Audio will overlap — bump startSec or shorten the line.`,
      );
    }
  }

  // Generate sound effects (mouse clicks, keyboard typing, etc.) via the
  // ElevenLabs Sound Effects API. Each clip is cached by hash so iterating
  // on timing is free; only new prompts hit the API.
  const generatedSfx = [];
  if (sfx.length > 0) {
    await mkdir(SFX_CACHE_DIR, { recursive: true });
    for (let i = 0; i < sfx.length; i++) {
      const entry = sfx[i];
      const dur = entry.durationSec ?? 1.0;
      const promptInfluence = entry.promptInfluence ?? 0.3;
      const cacheKey = createHash('md5')
        .update(`${entry.prompt}::${dur}::${promptInfluence}`)
        .digest('hex');
      const cachedPath = join(SFX_CACHE_DIR, `${cacheKey}.mp3`);
      const cached = await fileExists(cachedPath);
      console.log(
        `[sfx] ${i}: start=${entry.startSec}s dur=${dur}s ` +
          `prompt="${entry.prompt.slice(0, 60)}${entry.prompt.length > 60 ? '…' : ''}" ` +
          `cache=${cached ? 'HIT' : 'miss'}`,
      );
      if (!cached) {
        const buf = await generateSfx({
          apiKey: apiKeys.elevenlabs,
          prompt: entry.prompt,
          durationSec: dur,
          promptInfluence,
        });
        await writeFile(cachedPath, buf);
      }
      generatedSfx.push({
        path: cachedPath,
        startSec: entry.startSec,
        gain: entry.volume ?? 0.4,
      });
    }
  }

  // Optional: generate background music via ElevenLabs Music API. Default
  // duration matches the video length so it covers the entire cut, with
  // user-tunable fade in/out and base volume. Cached by hash of prompt +
  // duration + instrumental flag + model so prompt iterations are free.
  let musicPath = null;
  let musicConfig = null;
  if (music) {
    await mkdir(MUSIC_CACHE_DIR, { recursive: true });
    const videoDuration = await probeDuration(videoPath);
    const requestedMs = Math.round((music.durationMs ?? videoDuration * 1000));
    musicPath = join(voDir, 'music.mp3');
    const forceInstrumental = music.forceInstrumental !== false;
    const musicCacheKey = createHash('md5')
      .update(JSON.stringify({
        prompt: music.prompt,
        durationMs: requestedMs,
        forceInstrumental,
        modelId: music.modelId || 'music_v1',
      }))
      .digest('hex');
    const musicCachedPath = join(MUSIC_CACHE_DIR, `${musicCacheKey}.mp3`);
    const musicCached = !CACHE_DISABLED && (await fileExists(musicCachedPath));
    console.log(
      `[vo] music: cache=${musicCached ? 'HIT' : 'miss'} ` +
        `prompt="${music.prompt.slice(0, 60)}${music.prompt.length > 60 ? '…' : ''}" ` +
        `duration=${requestedMs}ms`,
    );
    if (musicCached) {
      const buf = await readFile(musicCachedPath);
      await writeFile(musicPath, buf);
    } else {
      await generateMusic({
        apiKey: apiKeys.elevenlabs,
        prompt: music.prompt,
        durationMs: requestedMs,
        forceInstrumental,
        modelId: music.modelId,
        outPath: musicPath,
      });
      const buf = await readFile(musicPath);
      await writeFile(musicCachedPath, buf);
    }
    musicConfig = {
      path: musicPath,
      volume: music.volume ?? 0.30,
      fadeInSec: music.fadeInSec ?? 1.5,
      fadeOutSec: music.fadeOutSec ?? 2.0,
      duckThreshold: music.duckThreshold ?? 0.04,
      duckRatio: music.duckRatio ?? 8,
      duckAttack: music.duckAttack ?? 5,
      duckRelease: music.duckRelease ?? 350,
      videoDuration,
    };
    console.log(`[vo]   → ${basename(musicPath)}`);
  }

  // Build the ffmpeg filter graph: each segment routes through its own
  // adelay (positions it on the timeline), then amix combines them.
  // ffmpeg input order:
  //   [0]=video
  //   [1..N]=voice segments
  //   [N+1..N+M]=sfx clips
  //   [N+M+1]=music (optional, last so its index is computable from N+M)
  const sfxStartIdx = generated.length + 1;
  const inputs = [
    ...generated.flatMap((s) => ['-i', s.path]),
    ...generatedSfx.flatMap((s) => ['-i', s.path]),
  ];
  if (musicConfig) inputs.push('-i', musicConfig.path);

  const hasPost = postFilter && postFilter.trim();
  const hasReverb = reverbFilter && reverbFilter.trim();
  const segFilters = generated.map((s, i) => {
    const delayMs = Math.round(s.startSec * 1000);
    const inputIdx = i + 1;
    const tailGain = s.gain !== 1.0 ? `,volume=${s.gain.toFixed(3)}` : '';
    // Per-segment chain: postFilter (DSP shaping) → adelay → optional gain.
    // postFilter runs BEFORE adelay so reverb/EQ tails operate on the raw
    // voice and won't bleed into the prior beat. Reverb itself happens at
    // the bus level (after voiceMix) — see reverbStage — to avoid an
    // amix → adelay PTS overflow that truncated AAC encode to ~2s.
    let chain = `[${inputIdx}:a]`;
    if (hasPost) chain += `${postFilter},`;
    chain += `adelay=${delayMs}|${delayMs}${tailGain}[a${i}]`;
    return chain;
  });
  const voiceLabels = generated.map((_, i) => `[a${i}]`).join('');
  // amix defaults: normalize=1 divides volume by N inputs to prevent clipping
  // when they play simultaneously. Our voice segments never overlap (we
  // sanity-checked above), so dividing just throws away gain. normalize=0
  // keeps full unity. dropout_transition=0 also stops amix from ducking
  // when an input ends.
  const voiceMix = `${voiceLabels}amix=inputs=${generated.length}:duration=longest:normalize=0:dropout_transition=0[voice]`;

  // Optional bus-level parallel reverb. [voice] is split into a dry copy
  // (full level, full clarity) and a wet copy (reverbFilter applied,
  // attenuated to reverbMix). amix recombines them into [voice_post].
  // aresample=async=1 after the wet branch normalizes any PTS skew that
  // aecho leaves behind, otherwise downstream sidechaincompress + AAC
  // encode see non-monotonic DTS and truncate the output.
  const reverbStage = [];
  const finalVoiceLabel = hasReverb ? '[voice_post]' : '[voice]';
  if (hasReverb) {
    reverbStage.push(
      `[voice]asplit=2[voice_dry][voice_wet_pre]`,
      `[voice_wet_pre]${reverbFilter},volume=${reverbMix.toFixed(3)},aresample=async=1[voice_wet]`,
      `[voice_dry][voice_wet]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0[voice_post]`,
    );
  }

  // SFX chains: each clip just gets adelay + volume. No DSP — they're meant
  // to sound diegetic. Joined into the final mix alongside voice (and music
  // when present), so they sit underneath the dialogue but stay audible.
  const sfxFilters = generatedSfx.map((s, i) => {
    const delayMs = Math.round(s.startSec * 1000);
    const inputIdx = sfxStartIdx + i;
    return `[${inputIdx}:a]adelay=${delayMs}|${delayMs},volume=${s.gain.toFixed(3)}[sfx${i}]`;
  });
  const sfxLabels = generatedSfx.map((_, i) => `[sfx${i}]`).join('');

  let filterComplex;
  if (musicConfig) {
    // Music chain: trim to video length, base volume, fade in/out, then
    // sidechaincompress using a duplicate of the voice bus as the trigger.
    // When voice is loud, music ducks. amix the ducked music + voice + sfx
    // for the final track.
    const musicIdx = generated.length + generatedSfx.length + 1;
    const fadeOutStart = (musicConfig.videoDuration - musicConfig.fadeOutSec).toFixed(2);
    const musicChain =
      `[${musicIdx}:a]atrim=duration=${musicConfig.videoDuration.toFixed(2)},` +
      `afade=t=in:st=0:d=${musicConfig.fadeInSec},` +
      `afade=t=out:st=${fadeOutStart}:d=${musicConfig.fadeOutSec},` +
      `volume=${musicConfig.volume.toFixed(3)}[music_pre]`;
    // Split voice for compressor sidechain key + final mix. apad on the
    // sidechain key extends it with silence to the full video duration —
    // sidechaincompress otherwise stops emitting output the moment its
    // sidechain input ends, which truncates the music to voice-end length
    // and clips the final mux to ~voice-duration instead of video-duration.
    const voiceSplit =
      `${finalVoiceLabel}asplit=2[voice_out][voice_key_raw];` +
      `[voice_key_raw]apad=whole_dur=${musicConfig.videoDuration.toFixed(2)}[voice_key]`;
    const ducked =
      `[music_pre][voice_key]sidechaincompress=` +
      `threshold=${musicConfig.duckThreshold}:` +
      `ratio=${musicConfig.duckRatio}:` +
      `attack=${musicConfig.duckAttack}:` +
      `release=${musicConfig.duckRelease}[music_ducked]`;
    const finalInputs = `[voice_out][music_ducked]${sfxLabels}`;
    const finalCount = 2 + generatedSfx.length;
    // Explicit duration=longest + aresample=async=1 keep the AAC encoder
    // from truncating output when individual streams have mismatched lengths
    // (voice ends ~44s, music ends ~50s — without these the output clips
    // to ~44s and the music tail gets cut off).
    const finalMix = `${finalInputs}amix=inputs=${finalCount}:duration=longest:normalize=0:dropout_transition=0,aresample=async=1[a]`;
    filterComplex = [
      ...segFilters,
      ...sfxFilters,
      voiceMix,
      ...reverbStage,
      musicChain,
      voiceSplit,
      ducked,
      finalMix,
    ].join(';');
  } else if (generatedSfx.length > 0) {
    // No music — voice + sfx straight to output.
    const finalInputs = `${finalVoiceLabel}${sfxLabels}`;
    const finalCount = 1 + generatedSfx.length;
    const finalMix = `${finalInputs}amix=inputs=${finalCount}:normalize=0:dropout_transition=0[a]`;
    filterComplex = [...segFilters, ...sfxFilters, voiceMix, ...reverbStage, finalMix].join(';');
  } else if (hasReverb) {
    // aresample=async=1 normalizes PTS — without it the AAC encoder writes
    // wildly-large duration_ts to the audio stream and some players treat
    // it as silent. Same fix the music/sfx branches use via amix.
    filterComplex = [
      ...segFilters,
      voiceMix,
      ...reverbStage,
      `${finalVoiceLabel}aresample=async=1[a]`,
    ].join(';');
  } else {
    // No reverb / no music / no SFX path. Still aresample=async=1 the
    // voice bus to keep timestamps clean.
    filterComplex = [
      ...segFilters,
      `${voiceLabels}amix=inputs=${generated.length}:duration=longest:normalize=0:dropout_transition=0,aresample=async=1[a]`,
    ].join(';');
  }

  // Build a video drawtext chain for captions — sound-off viewers read along
  // at the bottom of the final video. Each segment shows from its startSec
  // until just before the next segment starts; positioned in screen-space so
  // it stays put regardless of any zoom/pan that's already baked into the
  // input video. Each line is written to a temp .txt file (drawtext textfile=)
  // so embedded newlines from wrapping don't break the filter chain.
  const finalDuration = await probeDuration(videoPath);
  const captionsDir = join(voDir, 'captions');
  await mkdir(captionsDir, { recursive: true });
  const captionChain = await buildCaptionChain(segments, finalDuration, captionsDir);
  const videoFilter = `[0:v]${captionChain}[v_out]`;
  const filterComplexWithCaptions = `${videoFilter};${filterComplex}`;

  const outputPath = join(videoDir, 'zoomed-with-voice.mp4');
  console.log(`[vo] muxing into ${outputPath}${musicConfig ? ' (with sidechain-ducked music)' : ''}`);
  if (process.env.VO_DEBUG_GRAPH) {
    console.error('[vo] filter_complex =\n' + filterComplexWithCaptions.replace(/;/g, ';\n'));
  }
  await runFfmpeg([
    '-y',
    '-i', videoPath,
    ...inputs,
    '-filter_complex', filterComplexWithCaptions,
    '-map', '[v_out]',
    '-map', '[a]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'slow',
    '-crf', '16',
    '-c:a', 'aac',
    '-b:a', '256k',
    '-ar', '44100',
    '-shortest',
    outputPath,
  ]);
  const finalDur = await probeDuration(outputPath);
  console.log(`[vo] wrote ${outputPath}  duration=${finalDur.toFixed(2)}s`);
}

// ----- Caption (drawtext) helpers -----

// Wrap text to N chars per line, breaking at word boundaries.
function wrapForDrawtext(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

async function buildCaptionChain(segments, videoDurationSec, captionsDir) {
  // Resolve a font path (Mac defaults; /usr/share/fonts on Linux).
  const { existsSync } = await import('node:fs');
  const FONT_CANDIDATES = [
    '/System/Library/Fonts/Supplemental/Menlo.ttc',
    '/System/Library/Fonts/Menlo.ttc',
    '/System/Library/Fonts/SFNSMono.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  ];
  const fontfile = FONT_CANDIDATES.find((p) => existsSync(p)) || FONT_CANDIDATES[0];

  const filters = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const start = Number(seg.startSec).toFixed(3);
    const next = segments[i + 1];
    const endRaw = next ? Number(next.startSec) - 0.05 : videoDurationSec;
    const end = endRaw.toFixed(3);
    // Write wrapped text to a temp file. textfile= avoids all the inline
    // escaping pain (newlines, colons, single quotes, backslashes).
    const wrapped = wrapForDrawtext(seg.text, 48);
    const captionPath = join(captionsDir, `cap-${String(i).padStart(2, '0')}.txt`);
    await writeFile(captionPath, wrapped, 'utf8');
    // ffmpeg drawtext path option: backslashes need doubling on POSIX.
    const safePath = captionPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
    const f = [
      `drawtext=fontfile='${fontfile}'`,
      `textfile='${safePath}'`,
      'fontcolor=0xE8F8F0',
      'fontsize=34',
      'line_spacing=10',
      'text_align=C',
      'box=1',
      'boxcolor=0x080C12@0.88',
      'boxborderw=28',
      'x=(w-text_w)/2',
      'y=h-text_h-72',
      `enable='between(t,${start},${end})'`,
    ].join(':');
    filters.push(f);
  }
  return filters.join(',');
}

// ElevenLabs preset voice name → voice_id mapping. Add more as needed.
// Source: ElevenLabs default voice library. These IDs are stable.
const ELEVENLABS_VOICES = {
  Adam: 'pNInz6obpgDQGcFmaJgB',     // deep narrator (best Daedalus fit)
  Antoni: 'ErXwobaYiN019PkySvjV',   // warm, well-spoken
  Arnold: 'VR6AewLTigWG4xSOukaG',   // crisp, american
  Bill: 'pqHfZKP75CvOlQylNhV4',     // mature american narrator
  Brian: 'nPczCjzI2devNBz1zQrb',    // deep american narrator
  Daniel: 'onwK4e9ZLuTAKqWW03F9',   // deep british
  Drew: '29vD33N1CtxCmqQRPOHJ',     // mature deep
  George: 'JBFqnCBsd6RMkjVDRZzb',   // raspy, british
  Charlie: 'IKne3meq5aSn9XLyUdCD',  // casual australian
  Liam: 'TX3LPaxmHKxFdv7VOQHJ',     // articulate young
};

async function generateTtsSegment({ provider, apiKeys, text, voice, speed, model, voiceSettings }) {
  if (provider === 'elevenlabs') {
    const voiceId = ELEVENLABS_VOICES[voice] || voice; // accept raw voice_id too
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    // ElevenLabs supports `speed` inside voice_settings (range 0.7–1.2).
    // Clamp to that window so a 0.78 segment override produces an
    // actually-slower delivery instead of being silently ignored.
    const elevenSpeed = Math.max(0.7, Math.min(1.2, Number(speed) || 1.0));
    const body = JSON.stringify({
      text,
      model_id: model,
      voice_settings: { ...voiceSettings, speed: elevenSpeed },
    });
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKeys.elevenlabs,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body,
    });
    if (!resp.ok) throw new Error(`ElevenLabs TTS ${resp.status}: ${await resp.text()}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  // default: OpenAI TTS
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKeys.openai}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: text, voice, speed }),
  });
  if (!resp.ok) throw new Error(`OpenAI TTS ${resp.status}: ${await resp.text()}`);
  return Buffer.from(await resp.arrayBuffer());
}

// Generate a sound effect via the ElevenLabs Sound Effects API. Returns
// the raw MP3 buffer; caller is responsible for writing/caching.
//   POST /v1/sound-generation
//   { text, duration_seconds: 0.5–22 (or null = auto), prompt_influence: 0–1 }
async function generateSfx({ apiKey, prompt, durationSec, promptInfluence }) {
  const resp = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: durationSec,
      prompt_influence: promptInfluence,
    }),
  });
  if (!resp.ok) throw new Error(`ElevenLabs SFX ${resp.status}: ${await resp.text()}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Generate a background-score MP3 via ElevenLabs Music API. Returns the local
// path. The music API streams MP3 bytes directly — no polling required.
async function generateMusic({ apiKey, prompt, durationMs, forceInstrumental, modelId, outPath }) {
  console.log(
    `[vo] music: prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}" ` +
      `duration=${durationMs}ms instrumental=${forceInstrumental}`,
  );
  const resp = await fetch('https://api.elevenlabs.io/v1/music/stream', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      music_length_ms: durationMs,
      force_instrumental: forceInstrumental,
      model_id: modelId || 'music_v1',
    }),
  });
  if (!resp.ok) throw new Error(`ElevenLabs Music ${resp.status}: ${await resp.text()}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(outPath, buf);
  return outPath;
}

function probeDuration(path) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    ff.stdout.on('data', (d) => { out += d.toString(); });
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err}`));
      const n = parseFloat(out.trim());
      if (!Number.isFinite(n)) return reject(new Error(`parse: ${out}`));
      resolve(n);
    });
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) {
        if (process.env.VO_DEBUG_GRAPH) console.error(err);
        resolve();
      } else {
        reject(new Error(`ffmpeg exit ${code}: ${err.slice(-1500)}`));
      }
    });
  });
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
