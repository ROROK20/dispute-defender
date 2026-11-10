/**
 * Records a DRAFT demo video of the running app: one browser capture per scene,
 * narration from macOS `say`, captions, and ffmpeg to retime and join them.
 *
 * It records what the app really does in the mode it is started in. The
 * intended mode is mock PayPal + the real agent through a local Claude Code
 * CLI (no credentials needed):
 *
 *   rm -f data/demo-video.db*
 *   DATABASE_PATH=./data/demo-video.db PAYPAL_MOCK=1 npm run setup
 *   DATABASE_PATH=./data/demo-video.db PAYPAL_MOCK=1 ANTHROPIC_PROVIDER=claude-cli \
 *     DEMO_TRIGGER_PER_IP_PER_MIN=60 POLL_INTERVAL_MS=600000 npx next dev -p 3200
 *   DEMO_BASE_URL=http://localhost:3200 npx tsx scripts/record-demo.ts
 *
 * Output: demo/out/draft-demo.mp4 (+ .srt). It is a draft for the person
 * submitting to watch, replace or re-record; nothing is uploaded anywhere.
 * The narration says plainly that PayPal answers come from fixtures.
 */
import { chromium, type Page } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3200';
const OUT = path.resolve('demo/out');
const WORK = path.resolve('demo/work');
const VOICE = process.env.DEMO_VOICE ?? 'Samantha';
const RATE = process.env.DEMO_RATE ?? '178';
const SIZE = { width: 1280, height: 720 };

interface Scene {
  id: string;
  narration: string;
  /** Speed the capture up to fit the narration (shown on screen), never slow it down. */
  timelapse?: boolean;
  mobile?: boolean;
  run: (page: Page, ctx: SceneCtx) => Promise<void>;
}

interface SceneCtx {
  disputeUrl?: string;
  agentSeconds?: number;
  /** Called once the scene's content is on screen; earlier frames are trimmed. */
  markReady: () => void;
}

/** Wait until a page shows real content (the machine can be slow to paint). */
async function shown(page: Page, text: RegExp | string, ctx: SceneCtx) {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout: 90_000 });
  await sleep(600);
  ctx.markReady();
}

async function runFinished(disputeUrl: string, timeoutMs: number): Promise<string> {
  const id = decodeURIComponent(new URL(disputeUrl).pathname.split('/').pop() ?? '');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/disputes/${encodeURIComponent(id)}`);
      const body = (await res.json()) as { run?: { status?: string } | null };
      const st = body.run?.status;
      if (st === 'draft_ready' || st === 'failed') return st;
    } catch {
      /* the dev server can be slow under load; keep polling */
    }
    await sleep(1500);
  }
  throw new Error('agent run did not finish in time');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function slowScroll(page: Page, px: number, steps = 12, pauseMs = 220) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, px / steps);
    await sleep(pauseMs);
  }
}

const SCENES: Scene[] = [
  {
    id: 's1-inbox',
    narration:
      'This is Dispute Defender, an AI agent that answers PayPal disputes for small sellers. ' +
      'Sellers lose disputes they could win in three ways: a missed deadline, the wrong evidence, or a reply that ignores the reason code. ' +
      'In this recording, PayPal responses come from sandbox-shaped fixtures, as the red banner says. The agent itself is real Claude.',
    run: async (page, ctx) => {
      await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 });
      await shown(page, 'Dispute inbox', ctx);
      await sleep(2500);
      await page.mouse.move(640, 420);
      await slowScroll(page, 500);
      await sleep(1500);
      await slowScroll(page, -500);
      await sleep(1500);
    },
  },
  {
    id: 's2-agent',
    timelapse: true,
    narration:
      'A dispute arrives, and the agent starts. Claude reads the dispute, the buyer\'s messages, the order and its capture, the tracking record and the store\'s own policies. ' +
      'Every result is stored as a numbered source. This part is shown faster than real time.',
    run: async (page, ctx) => {
      await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 });
      await shown(page, 'Dispute inbox', ctx);
      await sleep(1500);
      const started = Date.now();
      await page.getByRole('button', { name: /trigger demo dispute/i }).first().click();
      await page.waitForURL(/\/disputes\//, { timeout: 30_000 });
      ctx.disputeUrl = page.url();
      // Follow the live trace while the run works; the API says when it is done.
      const finished = runFinished(ctx.disputeUrl, 12 * 60_000);
      await page.mouse.move(400, 500);
      let done = false;
      void finished.then(() => { done = true; }, () => { done = true; });
      while (!done) {
        await page.mouse.wheel(0, 120);
        await sleep(2500);
      }
      const status = await finished;
      if (status !== 'draft_ready') throw new Error(`agent run ended ${status}`);
      ctx.agentSeconds = Math.round((Date.now() - started) / 1000);
      await sleep(2500);
    },
  },
  {
    id: 's3-draft',
    narration:
      'It scores the evidence against a rubric for this reason code, and decides on expected value whether to fight. ' +
      'Every sentence in the draft cites its sources. A deterministic checker rejects any sentence whose numbers, dates or quotes are not in those sources, ' +
      'and a Claude Opus pass may only reword, never add facts. Nothing is sent until the seller approves. ' +
      'One click submits the evidence and its PDF packet, here to the mock PayPal adapter.',
    run: async (page, ctx) => {
      if (!ctx.disputeUrl) throw new Error('no dispute from scene 2');
      await page.goto(ctx.disputeUrl, { waitUntil: 'load', timeout: 90_000 });
      await page.getByRole('button', { name: /approve & submit evidence/i }).first().waitFor({ timeout: 90_000 });
      await shown(page, 'Agent trace', ctx);
      await sleep(1500);
      await page.mouse.move(640, 400);
      await slowScroll(page, 450);
      await sleep(1000);
      const chip = page.locator('button[aria-label^="Source S"]').first();
      if (await chip.count()) {
        await chip.scrollIntoViewIfNeeded();
        await sleep(800);
        await chip.click();
        await sleep(3500);
        await page.getByRole('button', { name: /^close$/i }).first().click().catch(() => page.keyboard.press('Escape'));
        await sleep(1000);
      }
      const approve = page.getByRole('button', { name: /approve & submit evidence/i }).first();
      if (await approve.count()) {
        await approve.scrollIntoViewIfNeeded();
        await sleep(2500);
        if (await approve.isEnabled()) {
          await approve.click();
          await sleep(6000);
        }
      }
      await slowScroll(page, 300);
      await sleep(2000);
    },
  },
  {
    id: 's4-patterns',
    narration:
      'The Patterns page groups past disputes by product and reason code, with the buyers\' exact words, ' +
      'so the seller can fix the cause, like an outdated size chart, before the next dispute.',
    run: async (page, ctx) => {
      await page.goto(`${BASE}/patterns`, { waitUntil: 'load', timeout: 90_000 });
      await page.getByRole('heading').first().waitFor({ timeout: 90_000 });
      await sleep(1500);
      ctx.markReady();
      await sleep(2500);
      await page.mouse.move(640, 400);
      await slowScroll(page, 600, 14, 300);
      await sleep(2000);
    },
  },
  {
    id: 's5-mobile',
    mobile: true,
    narration:
      'The seller can review and approve from a phone. Dispute Defender won\'t invent facts, it tells you when to concede, ' +
      'and it helps prevent the next dispute. The code and setup steps are linked below.',
    run: async (page, ctx) => {
      await page.goto(ctx.disputeUrl ?? `${BASE}/`, { waitUntil: 'load', timeout: 90_000 });
      await shown(page, 'Agent trace', ctx);
      await sleep(1500);
      await slowScroll(page, 1400, 16, 300);
      await sleep(2000);
    },
  },
];

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Decoded length in seconds. ffprobe is not always installed, and Playwright's
 *  webm files carry no duration header, so decode once and read the last time=. */
function duration(file: string): number {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const times = [...String(r.stderr).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = times.at(-1);
  if (!last) throw new Error(`could not read the duration of ${file}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

function srtTime(s: number): string {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(sec)},${p(rest, 3)}`;
}

/** Split narration into caption lines of about a dozen words, timed by word count. */
function captions(text: string, start: number, length: number): { from: number; to: number; text: string }[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 12) chunks.push(words.slice(i, i + 12).join(' '));
  let t = start;
  return chunks.map((c) => {
    const d = (c.split(' ').length / words.length) * length;
    const cue = { from: t, to: t + d, text: c };
    t += d;
    return cue;
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  // The Patterns scene needs mined patterns; mining is the seller's Recompute button.
  const mined = await fetch(`${BASE}/api/patterns/recompute`, { method: 'POST' });
  const minedBody = (await mined.json().catch(() => ({}))) as { patterns?: unknown[] };
  console.log(`[record] patterns recomputed: HTTP ${mined.status}, ${minedBody.patterns?.length ?? 0} pattern(s)`);
  let readyAt = 0;
  let t0 = 0;
  const ctx: SceneCtx = { markReady: () => { if (!readyAt) readyAt = (Date.now() - t0) / 1000; } };
  const clips: { scene: Scene; video: string; audio: string; seconds: number; narration: number; trim: number }[] = [];

  for (const scene of SCENES) {
    const dir = path.join(WORK, scene.id);
    const viewport = scene.mobile ? { width: 390, height: 844 } : SIZE;
    // A fresh browser per scene: one crash under memory pressure costs one scene, not the run.
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      recordVideo: { dir, size: viewport },
      ...(scene.mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    const page = await context.newPage();
    t0 = Date.now();
    readyAt = 0;
    console.log(`[record] ${scene.id} …`);
    await scene.run(page, ctx);
    const video = await page.video()!.path();
    await context.close();
    await browser.close();

    const audio = path.join(WORK, `${scene.id}.aiff`);
    execFileSync('say', ['-v', VOICE, '-r', RATE, '-o', audio, scene.narration]);
    // Frames before the content painted are blank; start the clip just before it.
    const trim = Math.max(0, readyAt - 0.4);
    clips.push({ scene, video, audio, seconds: duration(video) - trim, narration: duration(audio), trim });
    console.log(`[record] ${scene.id}: capture ${clips.at(-1)!.seconds.toFixed(1)}s, narration ${clips.at(-1)!.narration.toFixed(1)}s`);
  }

  // Normalise every clip to 1280x720 30fps and to the narration's length (+1s).
  const parts: string[] = [];
  const cues: { from: number; to: number; text: string }[] = [];
  let clock = 0;
  for (const [i, c] of clips.entries()) {
    const target = c.narration + 1;
    const filters: string[] = [];
    let note = '';
    if (c.scene.timelapse && c.seconds > target) {
      const factor = c.seconds / target;
      filters.push(`setpts=PTS/${factor.toFixed(3)}`);
      note = `Sped up ${factor.toFixed(1)}x - agent run took ${ctx.agentSeconds ?? Math.round(c.seconds)}s in real time`;
    }
    filters.push(
      'scale=1280:720:force_original_aspect_ratio=decrease',
      'pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xf1f5f9',
      'fps=30',
      `tpad=stop_mode=clone:stop_duration=${Math.max(0, target).toFixed(2)}`,
    );
    if (note) {
      filters.push(
        `drawtext=text='${note}':x=w-tw-24:y=24:fontsize=22:fontcolor=white:box=1:boxcolor=0x0f172acc:boxborderw=10`,
      );
    }
    const out = path.join(WORK, `part${i}.mp4`);
    sh('ffmpeg', [
      '-y', '-ss', c.trim.toFixed(2), '-i', c.video, '-i', c.audio,
      '-filter_complex', `[0:v]${filters.join(',')}[v];[1:a]apad[a]`,
      '-map', '[v]', '-map', '[a]', '-t', target.toFixed(2),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', out,
    ]);
    parts.push(out);
    cues.push(...captions(c.scene.narration, clock + 0.2, c.narration));
    clock += target;
  }

  const list = path.join(WORK, 'parts.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  const joined = path.join(WORK, 'joined.mp4');
  sh('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);

  const srt = path.join(OUT, 'draft-demo.srt');
  fs.writeFileSync(srt, cues.map((q, i) => `${i + 1}\n${srtTime(q.from)} --> ${srtTime(q.to)}\n${q.text}\n`).join('\n'));
  const final = path.join(OUT, 'draft-demo.mp4');
  sh('ffmpeg', [
    '-y', '-i', joined,
    '-vf', `subtitles=${srt}:force_style='FontSize=18,MarginV=28,BorderStyle=3,Outline=1,BackColour=&H80000000'`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'copy', final,
  ]);
  const total = duration(final);
  const manifest = {
    file: final,
    seconds: Math.round(total),
    under_3_minutes: total < 180,
    agent_seconds_real_time: ctx.agentSeconds ?? null,
    voice: VOICE,
    scenes: clips.map((c) => ({ id: c.scene.id, capture_s: +c.seconds.toFixed(1), trimmed_s: +c.trim.toFixed(1), narration_s: +c.narration.toFixed(1) })),
  };
  fs.writeFileSync(path.join(OUT, 'draft-demo.json'), JSON.stringify(manifest, null, 2));
  console.log('[record] done', JSON.stringify(manifest));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
