import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageReading } from '../../src/contracts/incident.ts';
import {
  formatTimestamp,
  parseDuration,
  parseFrameTimes,
  readRecording,
  summarizeFrames,
} from '../../src/context/vision/recording.ts';
import type { ModelPort, VisionRequest } from '../../src/ports/model.ts';

function reading(description: string, sensitive = false): ImageReading {
  return {
    surfaceSignals: { chrome: 'web' },
    uiElements: [],
    plainDescription: description,
    sensitive,
    userSideIndicators: [],
  };
}

/** Answers each vision call with the next description in the list (the last one repeats). */
function scriptedModel(descriptions: string[], calls: VisionRequest[] = []): ModelPort {
  return {
    async vision(request) {
      calls.push(request);
      const text = descriptions[Math.min(calls.length - 1, descriptions.length - 1)] ?? 'unknown';
      return { model: 'mock/scripted', readings: [reading(text)] };
    },
    async complete() {
      throw new Error('unused');
    },
    async classify() {
      throw new Error('unused');
    },
  };
}

// A fake ffmpeg: the probe call prints a Duration line, the extract call writes three "frames" and
// showinfo lines at 0, 4.2 and 11 seconds. FAKE_DURATION overrides the probed length.
const FAKE_FFMPEG = `#!/bin/sh
case "$*" in
  *showinfo*)
    for a; do last=$a; done
    dir=\${last%/*}
    printf 'frame-one' > "$dir/frame-00001.png"
    printf 'frame-two' > "$dir/frame-00002.png"
    printf 'frame-three' > "$dir/frame-00003.png"
    echo '[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0 pos: 1' >&2
    echo '[Parsed_showinfo_1 @ 0x1] n:   1 pts:   4200 pts_time:4.2 pos: 2' >&2
    echo '[Parsed_showinfo_1 @ 0x1] n:   2 pts:  11000 pts_time:11 pos: 3' >&2
    exit 0 ;;
  *)
    echo "  Duration: \${FAKE_DURATION:-00:00:12.00}, start: 0.000000, bitrate: 100 kb/s" >&2
    exit 1 ;;
esac
`;

let dir: string;
let binDir: string;
let emptyDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-rec-test-'));
  binDir = join(dir, 'bin');
  emptyDir = join(dir, 'empty');
  await Promise.all([mkdir(binDir), mkdir(emptyDir)]);
  await writeFile(join(binDir, 'ffmpeg'), FAKE_FFMPEG);
  await chmod(join(binDir, 'ffmpeg'), 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fakeEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: binDir, ...extra });

describe('recording helpers', () => {
  it('formats timestamps as m:ss', () => {
    expect(formatTimestamp(4.9)).toBe('0:04');
    expect(formatTimestamp(71)).toBe('1:11');
    expect(formatTimestamp(3725)).toBe('1:02:05');
  });

  it('parses ffmpeg duration and showinfo times', () => {
    expect(parseDuration('  Duration: 00:01:02.50, start')).toBe(62.5);
    expect(parseDuration('nothing here')).toBeUndefined();
    expect(parseFrameTimes('x pts_time:0 y\nz pts_time:4.2 w')).toEqual([0, 4.2]);
  });

  it('collapses repeats, drops unreadable frames, and never describes a sensitive one', () => {
    const out = summarizeFrames([
      { seconds: 0, reading: reading('cart page') },
      { seconds: 1, reading: reading('Cart page') },
      { seconds: 2, reading: reading('unknown') },
      { seconds: 4, reading: reading('promo field', false) },
      { seconds: 5, reading: reading('password is hunter2', true) },
    ]);
    expect(out.map((e) => `${e.time} ${e.text}`)).toEqual([
      '0:00 cart page',
      '0:04 promo field',
      '0:05 sensitive content on screen',
    ]);
  });
});

describe('readRecording with a fake ffmpeg', () => {
  it('reads each sampled frame and summarizes a timed sequence', async () => {
    const calls: VisionRequest[] = [];
    const model = scriptedModel(['opens cart', 'opens cart', 'applies promo'], calls);
    const out = await readRecording('/videos/repro.mp4', model, { env: fakeEnv(), tmpDir: dir });
    expect(out.status).toBe('read');
    if (out.status !== 'read') return;
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.task === 'vision' && c.images.length === 1)).toBe(true);
    expect(Buffer.from(calls[1]?.images[0]?.data ?? '', 'base64').toString()).toBe('frame-two');
    expect(out.durationSeconds).toBe(12);
    expect(out.frames.map((f) => f.seconds)).toEqual([0, 4.2, 11]);
    expect(out.summary).toBe('0:00 opens cart, 0:11 applies promo');
  });

  it('removes its frame scratch directory', async () => {
    const scratch = join(dir, 'scratch');
    await mkdir(scratch);
    await readRecording('/videos/repro.mp4', scriptedModel(['x']), { env: fakeEnv(), tmpDir: scratch });
    expect(await readdir(scratch)).toEqual([]);
  });

  it('skips with a note, never a failure, when ffmpeg is absent', async () => {
    const calls: VisionRequest[] = [];
    const out = await readRecording('/videos/repro.mp4', scriptedModel(['x'], calls), { env: { PATH: emptyDir } });
    expect(out).toEqual({ status: 'skipped', note: 'recording skipped: ffmpeg is not installed on PATH' });
    expect(calls).toHaveLength(0);
  });

  it('skips a recording longer than maxDuration without extracting', async () => {
    const calls: VisionRequest[] = [];
    const env = fakeEnv({ FAKE_DURATION: '00:03:01.00' });
    const out = await readRecording('/videos/long.mp4', scriptedModel(['x'], calls), { env });
    expect(out.status).toBe('skipped');
    expect(out.status === 'skipped' && out.note).toContain('longer than the 3:00 limit');
    expect(calls).toHaveLength(0);
    // The same video fits when the limit is raised.
    const ok = await readRecording('/videos/long.mp4', scriptedModel(['x']), { env, maxDuration: 600 });
    expect(ok.status).toBe('read');
  });

  it('skips when ffmpeg cannot read the video', async () => {
    await writeFile(join(binDir, 'ffmpeg'), '#!/bin/sh\necho "Invalid data found" >&2\nexit 1\n');
    const out = await readRecording('/videos/bad.mp4', scriptedModel(['x']), { env: fakeEnv() });
    expect(out).toEqual({ status: 'skipped', note: 'recording skipped: ffmpeg could not read the video' });
  });

  it('counts a failing vision call as an unreadable frame, not an error', async () => {
    const model: ModelPort = {
      ...scriptedModel(['x']),
      async vision() {
        throw new Error('model down');
      },
    };
    const out = await readRecording('/videos/repro.mp4', model, { env: fakeEnv() });
    expect(out.status).toBe('read');
    if (out.status === 'read') expect(out.summary).toBe('');
  });
});

const realFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!realFfmpeg)('readRecording with a real ffmpeg', () => {
  it('samples a tiny generated video at sampleFps plus scene changes', async () => {
    const video = join(dir, 'tiny.mp4');
    // Two seconds of red, then two of blue: 4 s, one scene change at 2 s.
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=5:d=2',
        '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5:d=2',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
        '-pix_fmt', 'yuv420p', video,
      ],
    );
    const calls: VisionRequest[] = [];
    const out = await readRecording(video, scriptedModel(['red screen', 'red screen', 'blue screen'], calls), {
      tmpDir: dir,
      sampleFps: 1,
    });
    expect(out.status).toBe('read');
    if (out.status !== 'read') return;
    expect(out.durationSeconds).toBeGreaterThan(3);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(out.frames[0]?.seconds).toBe(0);
    expect(out.frames.map((f) => f.seconds)).toEqual([...out.frames.map((f) => f.seconds)].sort((a, b) => a - b));
    expect(out.summary).toMatch(/^0:00 red screen/);
  });
});
