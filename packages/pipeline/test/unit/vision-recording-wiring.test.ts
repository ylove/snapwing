import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Attachment, ContextBundle, ImageReading } from '../../src/contracts/incident.ts';
import { readImages, type LoadRecording } from '../../src/context/vision/index.ts';
import type { ModelPort, VisionRequest } from '../../src/ports/model.ts';

function reading(description: string): ImageReading {
  return { surfaceSignals: { chrome: 'web' }, uiElements: [], plainDescription: description, sensitive: false, userSideIndicators: [] };
}

function model(calls: VisionRequest[] = []): ModelPort {
  const texts = ['opens cart', 'applies promo', 'total blank'];
  return {
    async vision(request) {
      calls.push(request);
      return { model: 'mock/scripted', readings: [reading(texts[Math.min(calls.length - 1, 2)] ?? 'unknown')] };
    },
    async complete() {
      throw new Error('unused');
    },
    async classify() {
      throw new Error('unused');
    },
  };
}

const FAKE_FFMPEG = `#!/bin/sh
case "$*" in
  *showinfo*)
    for a; do last=$a; done
    dir=\${last%/*}
    printf 'one' > "$dir/frame-00001.png"
    printf 'two' > "$dir/frame-00002.png"
    printf 'three' > "$dir/frame-00003.png"
    echo 'x pts_time:0 y' >&2
    echo 'x pts_time:4 y' >&2
    echo 'x pts_time:11 y' >&2
    exit 0 ;;
  *)
    echo "  Duration: \${FAKE_DURATION:-00:00:12.00}, start: 0" >&2
    exit 1 ;;
esac
`;

let dir: string;
let binDir: string;
let scratch: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapwing-wiring-'));
  binDir = join(dir, 'bin');
  scratch = join(dir, 'scratch');
  await Promise.all([mkdir(binDir), mkdir(scratch)]);
  await writeFile(join(binDir, 'ffmpeg'), FAKE_FFMPEG);
  await chmod(join(binDir, 'ffmpeg'), 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const video: Attachment = { kind: 'file', url: 'https://files.slack.com/f/repro.mp4', mimeType: 'video/mp4' };

function bundle(...attachments: Attachment[]): ContextBundle {
  return {
    anchorId: '1',
    included: [{ id: '1', authorId: 'U1', text: 'repro', timestamp: '2026-10-03T00:00:00.000Z', mentions: [], reactions: [], attachments }],
    excluded: [],
    windowUsed: { oldest: '2026-10-03T00:00:00.000Z', latest: '2026-10-03T00:00:00.000Z', cap: 40 },
  };
}

const bytesLoader: LoadRecording = async () => Uint8Array.from([1, 2, 3]);
const settings = (maxDuration = 180) => ({
  maxDuration,
  sampleFps: 1,
  env: { PATH: binDir },
  tmpDir: scratch,
});

function first(b: ContextBundle): Attachment | undefined {
  return b.included[0]?.attachments[0];
}

describe('recordings in the bundle', () => {
  it('downloads a video, reads it, attaches the sequence, and removes the temp file', async () => {
    const calls: VisionRequest[] = [];
    const out = await readImages(bundle(video), model(calls), { loadRecording: bytesLoader, recordings: settings() });
    const rec = first(out)?.recording;
    expect(rec?.status).toBe('read');
    if (rec?.status !== 'read') return;
    expect(rec.summary).toBe('0:00 opens cart, 0:04 applies promo, 0:11 total blank');
    expect(calls).toHaveLength(3);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('removes the temp file when the video is too long', async () => {
    const out = await readImages(bundle(video), model(), { loadRecording: bytesLoader, recordings: settings(5) });
    const rec = first(out)?.recording;
    expect(rec?.status).toBe('skipped');
    expect(rec?.note).toMatch(/longer than/);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('passes the attachment to the authenticated loader', async () => {
    const seen: Attachment[] = [];
    await readImages(bundle(video), model(), {
      loadRecording: async (a) => {
        seen.push(a);
        return Uint8Array.from([1]);
      },
      recordings: settings(),
    });
    expect(seen).toEqual([video]);
  });

  it('skips with a note when ffmpeg is missing, and never throws', async () => {
    const out = await readImages(bundle(video), model(), {
      loadRecording: bytesLoader,
      recordings: { env: { PATH: join(dir, 'nowhere') }, tmpDir: scratch },
    });
    expect(first(out)?.recording).toEqual({ status: 'skipped', note: 'recording skipped: ffmpeg is not installed on PATH' });
    expect(await readdir(scratch)).toEqual([]);
  });

  it('skips with a note when the download fails or throws, or there is no loader', async () => {
    const none = await readImages(bundle(video), model(), { loadRecording: async () => undefined, recordings: settings() });
    expect(first(none)?.recording?.status).toBe('skipped');
    const boom = await readImages(bundle(video), model(), {
      loadRecording: async () => {
        throw new Error('net');
      },
      recordings: settings(),
    });
    expect(first(boom)?.recording?.status).toBe('skipped');
    const noLoader = await readImages(bundle(video), model(), { recordings: settings() });
    expect(first(noLoader)?.recording?.note).toMatch(/no authenticated loader/);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('notes a hosted recording link and does not fetch it', async () => {
    let loads = 0;
    const loom: Attachment = { kind: 'link', url: 'https://www.loom.com/share/abc123' };
    const other: Attachment = { kind: 'link', url: 'https://example.com/post' };
    const out = await readImages(bundle(loom, other), model(), {
      loadRecording: async () => {
        loads++;
        return undefined;
      },
      recordings: settings(),
    });
    const [a, b] = out.included[0]?.attachments ?? [];
    expect(a?.kind).toBe('link');
    expect(a?.url).toBe(loom.url);
    expect(a?.recording?.note).toMatch(/hosted recording link, not fetched/);
    expect(b?.recording).toBeUndefined();
    expect(loads).toBe(0);
  });

  it('leaves non-video files alone', async () => {
    const pdf: Attachment = { kind: 'file', url: 'https://files.slack.com/f/a.pdf', mimeType: 'application/pdf' };
    const out = await readImages(bundle(pdf), model(), { loadRecording: bytesLoader, recordings: settings() });
    expect(first(out)).toEqual(pdf);
  });
});
