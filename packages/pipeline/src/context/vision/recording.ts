// Screen recordings (spec A 5.1): a video up to `recordings.maxDuration` is sampled at `sampleFps` plus every
// scene change with ffmpeg (a child process found on PATH), each frame goes through the vision pass, and the
// readings are summarized as a timed sequence ("0:04 opens cart, 0:11 applies promo"). A missing ffmpeg, a
// recording that is too long, or a video ffmpeg cannot decode is skipped with a note, never an error.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageReading } from '../../contracts/incident.ts';
import type { ModelPort } from '../../ports/model.ts';
import { loadVisionPrompt, type VisionPrompt } from './index.ts';
import { isImageReading, unreadableReading } from './reading.ts';

/** Defaults from recordings maxDuration="PT3M" sampleFps="1" (spec A 11). */
export const DEFAULT_MAX_DURATION_SECONDS = 180;
export const DEFAULT_SAMPLE_FPS = 1;
/** ffmpeg scene score above which a frame counts as a scene change. */
export const SCENE_THRESHOLD = 0.3;
/** Hard bound on model calls for one recording, whatever the scene changes add. */
export const MAX_FRAMES = 240;

export interface RecordingOptions {
  /** Longest recording read, in seconds. Default 180. */
  maxDuration?: number;
  /** Frames sampled per second, scene changes come on top. Default 1. */
  sampleFps?: number;
  /** ffmpeg binary name or path. Default `ffmpeg`, looked up on PATH. */
  ffmpeg?: string;
  /** Environment for the ffmpeg child (tests point PATH at a fake). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Scratch directory parent for extracted frames. Default the OS temp dir. */
  tmpDir?: string;
}

export interface RecordingFrame {
  /** Seconds from the start of the recording. */
  seconds: number;
  reading: ImageReading;
}

export interface SequenceEntry {
  seconds: number;
  /** "0:04". */
  time: string;
  text: string;
}

export type RecordingReading =
  | {
      status: 'read';
      durationSeconds: number;
      frames: RecordingFrame[];
      sequence: SequenceEntry[];
      summary: string;
      note?: string;
    }
  | { status: 'skipped'; note: string };

interface RunResult {
  code: number | undefined;
  stdout: string;
  stderr: string;
  /** The binary could not be started at all (not on PATH). */
  missing: boolean;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv | undefined): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const child = spawn(command, args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', (e: NodeJS.ErrnoException) =>
        done({ code: undefined, stdout, stderr, missing: e.code === 'ENOENT' || e.code === 'EACCES' }),
      );
      child.on('close', (code) => done({ code: code ?? undefined, stdout, stderr, missing: false }));
    } catch {
      done({ code: undefined, stdout, stderr, missing: true });
    }
  });
}

/** Seconds as m:ss (or h:mm:ss past an hour). */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Parse the `Duration: hh:mm:ss.xx` line ffmpeg prints for an input. */
export function parseDuration(output: string): number | undefined {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Parse showinfo's `pts_time:` values, one per frame written, in order. */
export function parseFrameTimes(output: string): number[] {
  return [...output.matchAll(/pts_time:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
}

async function readFrame(png: Buffer, seconds: number, model: ModelPort, prompt: VisionPrompt): Promise<ImageReading> {
  try {
    const ref = `frame-${formatTimestamp(seconds)}`;
    const result = await model.vision({
      task: 'vision',
      system: prompt.system,
      prompt: prompt.request.replaceAll('{{ref}}', ref),
      images: [{ mimeType: 'image/png', data: png.toString('base64'), ref }],
    });
    const reading: unknown = result.readings.length === 1 ? result.readings[0] : undefined;
    return isImageReading(reading) ? reading : unreadableReading();
  } catch {
    return unreadableReading();
  }
}

/**
 * Collapse frame readings into a timed sequence. A frame whose description matches the one before it adds
 * nothing; an unreadable frame adds nothing; a sensitive frame is named but never described.
 */
export function summarizeFrames(frames: readonly RecordingFrame[]): SequenceEntry[] {
  const out: SequenceEntry[] = [];
  let last = '';
  for (const { seconds, reading } of frames) {
    const raw = reading.plainDescription.trim();
    if (raw === '' || raw === 'unknown') continue;
    const text = reading.sensitive ? 'sensitive content on screen' : raw;
    const key = text.toLowerCase();
    if (key === last) continue;
    last = key;
    out.push({ seconds, time: formatTimestamp(seconds), text });
  }
  return out;
}

/**
 * Read a screen recording on disk. Never throws: every problem becomes a `skipped` result with a note.
 * Frames are sampled at `sampleFps` plus scene changes, each is read by the vision model, and the result
 * carries both the per-frame readings and the timed `summary` ("0:04 opens cart, 0:11 applies promo").
 */
export async function readRecording(
  videoPath: string,
  model: ModelPort,
  options: RecordingOptions = {},
): Promise<RecordingReading> {
  const ffmpeg = options.ffmpeg ?? 'ffmpeg';
  const maxDuration = options.maxDuration ?? DEFAULT_MAX_DURATION_SECONDS;
  const sampleFps = options.sampleFps ?? DEFAULT_SAMPLE_FPS;
  if (!(sampleFps > 0) || !(maxDuration > 0)) {
    return { status: 'skipped', note: 'recording skipped: invalid sampling options' };
  }

  const probe = await run(ffmpeg, ['-hide_banner', '-i', videoPath], options.env);
  if (probe.missing) return { status: 'skipped', note: 'recording skipped: ffmpeg is not installed on PATH' };
  const duration = parseDuration(probe.stderr + probe.stdout);
  if (duration === undefined) return { status: 'skipped', note: 'recording skipped: ffmpeg could not read the video' };
  if (duration > maxDuration) {
    return {
      status: 'skipped',
      note: `recording skipped: ${formatTimestamp(duration)} is longer than the ${formatTimestamp(maxDuration)} limit`,
    };
  }

  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(options.tmpDir ?? tmpdir(), 'snapwing-rec-'));
    const select = `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${1 / sampleFps})+gt(scene,${SCENE_THRESHOLD})'`;
    const extract = await run(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-y', '-i', videoPath, '-vf', `${select},showinfo`, '-vsync', 'vfr', join(dir, 'frame-%05d.png')],
      options.env,
    );
    if (extract.missing) return { status: 'skipped', note: 'recording skipped: ffmpeg is not installed on PATH' };
    const files = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    if (extract.code !== 0 || files.length === 0) {
      return { status: 'skipped', note: 'recording skipped: ffmpeg produced no frames' };
    }
    const times = parseFrameTimes(extract.stderr);
    const prompt = await loadVisionPrompt();
    let note: string | undefined;
    let used = files;
    if (files.length > MAX_FRAMES) {
      used = files.slice(0, MAX_FRAMES);
      note = `only the first ${MAX_FRAMES} of ${files.length} frames were read`;
    }
    const frames: RecordingFrame[] = [];
    for (const [i, file] of used.entries()) {
      // Without showinfo timestamps, fall back to the nominal sample spacing.
      const seconds = Math.max(0, times[i] ?? i / sampleFps);
      frames.push({ seconds, reading: await readFrame(await readFile(join(dir, file)), seconds, model, prompt) });
    }
    const sequence = summarizeFrames(frames);
    const summary = sequence.map((e) => `${e.time} ${e.text}`).join(', ');
    return { status: 'read', durationSeconds: duration, frames, sequence, summary, ...(note === undefined ? {} : { note }) };
  } catch {
    return { status: 'skipped', note: 'recording skipped: the video could not be sampled' };
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
