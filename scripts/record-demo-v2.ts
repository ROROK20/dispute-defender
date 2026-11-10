/**
 * Demo video v2: a real capture of the running app, composed into a product
 * video with title and end cards, AI-shot slots, narration, captions, music and
 * loudness normalisation. The shot list, narration and honesty rules live in
 * demo/v2/STORYBOARD.md and are binding.
 *
 * Start the app (production build, mock PayPal, real agent through the local
 * Claude Code CLI):
 *
 *   rm -f data/demo-video.db*
 *   DATABASE_PATH=./data/demo-video.db PAYPAL_MOCK=1 npm run setup
 *   npx next build
 *   DATABASE_PATH=./data/demo-video.db PAYPAL_MOCK=1 ANTHROPIC_PROVIDER=claude-cli \
 *     DEMO_TRIGGER_PER_IP_PER_MIN=60 POLL_INTERVAL_MS=600000 npx next start -p 3200 -H 127.0.0.1
 *
 * Then:
 *
 *   npx tsx scripts/record-demo-v2.ts                  capture the app, then render
 *   npx tsx scripts/record-demo-v2.ts --reuse-capture  render only, from demo/work-v2/capture
 *   npx tsx scripts/record-demo-v2.ts --gate           v1 vs v2 sharpness check on the inbox
 *
 * --reuse-capture (or DEMO_REUSE_CAPTURE=1) is the loop for swapping assets:
 *
 *   demo/v2/ai/<A1|A2|J1>.mp4        AI shots     fallback: a card reading "AI shot pending: <id>"
 *   demo/v2/ai/B1.mp4                bridge shot  optional, silent, before C; skipped if absent
 *   demo/v2/voice/<scene>.wav|mp3    narration    fallback per scene: macOS `say` (the manifest marks it DRAFT)
 *                                    scenes: A1 A2 C D E F G W H I K J1 Z
 *   demo/v2/music/bed.mp3|wav        music bed    fallback: none
 *
 * demo/v2/narration.json is written on every run with the line for each voiced
 * scene, so each line can go to a TTS model and come back as demo/v2/voice/<scene>.wav.
 *
 * Output: demo/out/demo-v2.mp4 (1920x1080, 30 fps, H.264 yuv420p, AAC 48 kHz),
 * demo/out/demo-v2.srt and demo/out/demo-v2.json (the manifest: scenes,
 * durations, which slots fell back, the agent's real run time).
 *
 * How the capture works. The machine this runs on is often heavily loaded, and a
 * real-time recorder drops frames under load, so motion stutters. This script
 * steps every animated frame instead: it sets the cursor, camera and scroll for
 * frame N, then takes a screenshot with CDP Page.captureScreenshot. Motion plays
 * at a steady 30 fps however slow each screenshot is. Only waiting (page loads,
 * the agent run, the submission) is captured in real time, with wall-clock
 * durations, and the agent run is shown sped up with its measured factor on
 * screen. The camera is a screenshot clip with a scale, which Chrome
 * re-rasterises, so zoomed text stays sharp. The cursor is a DOM overlay drawn by
 * this script; Playwright input does not move a visible pointer.
 */
import { chromium, type Browser, type CDPSession, type Locator, type Page } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkSentences } from '../src/lib/agent/citations';

// ---------------------------------------------------------------------------
// Text: the single source for every word that appears or is spoken.

/** On-screen product copy. Change the repo line here when the repo goes public. */
export const BRAND = {
  product: 'Dispute Defender',
  subtitle: 'An AI agent for PayPal disputes, with every claim cited.',
  tagline: 'Every claim cited. Nothing sent unapproved.',
  repo: 'github.com/ROROK20/dispute-defender',
  endLine: 'Built with Claude · PayPal Disputes, Orders v2 and Webhooks APIs (fixtures in this recording)',
  disclosure: 'In this recording: PayPal responses are sandbox-shaped fixtures · the agent is real Claude',
  mockSubmit: 'MOCK adapter · nothing was sent to PayPal',
  recap: ['Cited.', 'Costed.', 'Approved by you.'],
};

/**
 * Narration, byte for byte from demo/v2/VOICE_SCRIPT.md (v3). Its codes are the
 * scene ids, and the founder's recordings arrive as demo/v2/voice/<CODE>.wav.
 * tests/unit/record-demo-v2.test.ts fails if the two ever drift apart.
 */
export const NARRATION = {
  A1: 'Eleven at night. A buyer just opened a PayPal dispute.',
  O1: 'Dispute Defender is an AI agent that drafts the answer.',
  O2: 'Moments later, a draft is ready, and every sentence cites its source.',
  O3: "Here's how it works, and how it knows when to give up.",
  A2: 'Small sellers lose disputes they could have won: a missed deadline, the wrong evidence, or a reply that ignores the reason code.',
  C: "Every open dispute, its deadline, and how strong the evidence is. PayPal's responses here are sandbox-shaped fixtures. The agent is real Claude.",
  D: "When a dispute comes in, Claude pulls the dispute, the buyer's messages, the order and its capture, the tracking, and the store's policies. Every result becomes a numbered source.",
  E: 'It scores the evidence for this exact reason code, then does the math. Here, fighting is the cheaper bet, so it fights.',
  F: 'Every sentence cites its source. Click one, and you see the record behind it. Every number, date and quote is checked against those records before anything can be sent.',
  REJ: 'Change a date by hand, and the checker blocks the submission.',
  G: 'Nothing is sent until the seller approves. One click submits the evidence. Here, to a mock PayPal adapter.',
  W: 'When the evidence is weak, it says so, and shows the dollar math for refunding instead.',
  H: "And it helps prevent the next one. Patterns groups past disputes by product and reason, in the buyers' own words, so you can fix the cause, like an outdated size chart.",
  I: 'Review and approve from your phone.',
  K: "Under the hood: a Claude tool-use agent, a deterministic citation checker, and PayPal's Disputes, Orders and Webhooks APIs.",
  R: 'Every sentence cited. Every option costed. Nothing sent until the seller says so.',
  J1: 'So the seller gets their night back.',
  Z: 'Dispute Defender. The code is linked below.',
} as const;

/** Used instead of E or H only if the capture cannot show their last claim (storyboard rule 4). */
export const FALLBACK_NARRATION = {
  E: 'It scores the evidence for this exact reason code, then does the math.',
  H: "And it helps prevent the next one. Patterns groups past disputes by product and reason, in the buyers' own words, so you can fix the cause.",
};

/** What each AI slot should show (from the storyboard), printed on its placeholder card. */
const AI_SHOTS: Record<string, string> = {
  A1: 'Late night. A seller at a cluttered home-studio desk, lit by a laptop, with parcels around. A phone buzzes.',
  B1: 'Optional bridge shot into the product. No UI, no brand.',
  J1: 'Morning. The same studio, now tidy. The seller calmly packs an order with a coffee.',
};

/** Preferred in-point (s) for an AI clip: the part that reads best at the slot's length. */
const AI_IN: Record<string, number> = { A1: 4.5 };

/** The staged mock dispute tried for scene W. Its real run decides whether W is shown. */
const WEAK_CANDIDATE = 'PP-D-27831';

// ---------------------------------------------------------------------------
// Geometry and settings.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3200';
const V2 = path.join(ROOT, 'demo/v2');
const CARDS = path.join(V2, 'cards');
const OUT = path.join(ROOT, 'demo/out');
const WORK = path.join(ROOT, 'demo/work-v2');
const CAP = path.join(WORK, 'capture');
const REN = path.join(WORK, 'render');

const FPS = 30;
const FRAME = { w: 1920, h: 1080 };
/** Browser viewport for desktop scenes: the app's max content width, so the UI fills the window. */
const VIEW = { width: 1280, height: 720 };
/** Where the desktop capture sits in the frame. The strip below it holds captions and lower thirds. */
const WIN = { x: 192, y: 20, w: 1536, h: 864, r: 18 };
const PHONE_VIEW = { width: 390, height: 844 };
const PHONE = { x: 765, y: 24, w: 390, h: 844, r: 46, bezel: 13 };
const DPR = Number(process.env.DEMO_DPR ?? 1);
const JPEG_Q = 95;

/** Crossfade between scenes; voice starts after it and ends before the next one. */
export const XFADE = 0.4;
const LEAD = 0.5;
const TAIL = 0.45;
const MIN_SECONDS: Record<string, number> = {
  A1: 2.6, O1: 3, O2: 4, O3: 2.8, T: 1.9, B1: 3.5, A2: 5, C: 6, D: 8, E: 7, F: 9, REJ: 5, G: 7, W: 7, H: 8, I: 3, K: 6, R: 5.5, J1: 4, Z: 5.5,
};
/** Faster lead-in and tail for the cold open; everything else uses LEAD and TAIL. */
const PACE: Record<string, { lead: number; tail: number }> = {
  A1: { lead: 0.15, tail: 0.15 },
  O1: { lead: 0.42, tail: 0.15 },
  O2: { lead: 0.42, tail: 0.15 },
  O3: { lead: 0.42, tail: 0.15 },
};
/** The cut must stay under 2:50; over that the manifest says which scenes to trim. */
const MAX_TOTAL = 170;
/** Silent AI bridge shot before C: its own length, kept between these bounds. */
const B1_SECONDS = { min: 3, max: 5 };
const X264_PRESET = process.env.DEMO_X264_PRESET ?? 'medium';
const X264_CRF = process.env.DEMO_X264_CRF ?? '16';
const SAY_RATE = process.env.DEMO_SAY_RATE ?? '172';

// ---------------------------------------------------------------------------
// Small utilities.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const sha = (s: string | Buffer) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const rel = (p: string) => path.relative(ROOT, p);
const log = (...a: unknown[]) => console.log('[demo-v2]', ...a);

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} … failed (${r.status}):\n${String(r.stderr).slice(-3000)}`);
  return `${r.stdout}${r.stderr}`;
}

/** Long ffmpeg runs: async, with a progress line every ~15 s. */
function ffmpeg(args: string[], label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let last = 0;
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 400_000) err = err.slice(-200_000);
      const m = [...d.toString().matchAll(/time=(\d+:\d+:\d+\.\d+)/g)].at(-1);
      if (m && Date.now() - last > 15_000) {
        last = Date.now();
        log(`${label}: ${m[1]}`);
      }
    });
    child.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg ${label} failed (${code}):\n${err.slice(-4000)}`))));
  });
}

/** Seconds of PCM in a WAV written by ffmpeg (pcm_s16le). */
function wavSeconds(file: string): number {
  const b = fs.readFileSync(file);
  let i = 12;
  let byteRate = 0;
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === 'fmt ') byteRate = b.readUInt32LE(i + 16);
    if (id === 'data') return (Math.min(size, b.length - i - 8)) / byteRate;
    i += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

function jpegSize(b: Buffer): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function firstExisting(base: string, exts: string[]): string | null {
  for (const e of exts) if (fs.existsSync(`${base}.${e}`)) return `${base}.${e}`;
  return null;
}

async function api<T>(p: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${p}`, { ...init, signal: AbortSignal.timeout(120_000) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

// ---------------------------------------------------------------------------
// Capture engine.

export type FrameKind = 'step' | 'hold' | 'real' | 'lapse';
/** `w` is the wall-clock time (ms) the frame was captured, so real elapsed time is measured, never inferred. */
export interface Frame { file: string; dur: number; kind: FrameKind; w?: number }
export interface Rect { x: number; y: number; w: number; h: number }
/** A named point in a capture: the frame index it precedes, and optionally a rect in frame pixels. */
export interface Mark { at: number; rect?: Rect }
interface Cam { cx: number; cy: number; z: number }
interface Pt { x: number; y: number }
export interface Timeline {
  id: string;
  kind: 'desktop' | 'mobile' | 'card';
  size: { w: number; h: number };
  frames: Frame[];
  /** Frame indices and wall-clock seconds of the sped-up window, if any. */
  lapse?: { from: number; to: number; real_s: number };
  marks?: Record<string, Mark>;
}

/** Injected into every page: the cursor and click ripple, drawn above everything. */
const INIT_SCRIPT = `
globalThis.__name = globalThis.__name || ((f) => f);
(() => {
  if (window.top !== window) return;
  const install = () => {
    let root = document.getElementById('__dd_root');
    if (root) return root;
    root = document.createElement('div');
    root.id = '__dd_root';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root.innerHTML =
      '<div id="__dd_ripple" style="position:absolute;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:2.5px solid rgba(13,148,136,.95);background:rgba(45,212,191,.22);opacity:0"></div>' +
      '<svg id="__dd_cursor" width="28" height="32" viewBox="0 0 28 32" style="position:absolute;left:0;top:0;transform-origin:4px 3px;filter:drop-shadow(0 2px 2.5px rgba(0,0,0,.38))">' +
      '<path d="M4 3 L4 25 L9.6 19.6 L13.3 28.3 L17.1 26.7 L13.4 18.2 L21 18.2 Z" fill="#0b0f17" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(root);
    return root;
  };
  window.__dd = (x, y, press, shown, rx, ry, rp, pre) => {
    if (pre) { try { (0, eval)(pre); } catch (e) {} }
    install();
    const c = document.getElementById('__dd_cursor');
    c.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 3) + 'px) scale(' + (1 - 0.16 * press) + ')';
    c.style.opacity = shown ? '1' : '0';
    const r = document.getElementById('__dd_ripple');
    if (rp >= 0 && rp <= 1) {
      r.style.opacity = String(0.95 * (1 - rp) * (1 - rp));
      r.style.transform = 'translate(' + rx + 'px,' + ry + 'px) scale(' + (0.3 + 1.15 * Math.sqrt(rp)) + ')';
    } else r.style.opacity = '0';
    return [window.scrollX, window.scrollY];
  };
})();
`;

class Shooter {
  frames: Frame[] = [];
  dir = '';
  id = '';
  private n = 0;
  cam: Cam;
  cursor: Pt & { press: number; shown: boolean };
  private ripple: (Pt & { p: number }) | null = null;
  private lapseFrom: { index: number; at: number } | null = null;
  private lapse?: Timeline['lapse'];
  private offSize = 0;
  private marks: Record<string, Mark> = {};

  constructor(
    readonly page: Page,
    readonly cdp: CDPSession,
    readonly view: { width: number; height: number },
    readonly outScale: number,
    readonly kind: 'desktop' | 'mobile',
  ) {
    this.cam = { cx: view.width / 2, cy: view.height / 2, z: 1 };
    this.cursor = { x: view.width * 0.64, y: view.height * 0.62, press: 0, shown: kind === 'desktop' };
  }

  get full(): Cam {
    return { cx: this.view.width / 2, cy: this.view.height / 2, z: 1 };
  }

  begin(id: string) {
    this.id = id;
    this.dir = path.join(CAP, id);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.n = 0;
    this.lapse = undefined;
    this.lapseFrom = null;
    this.offSize = 0;
    this.marks = {};
    log(`capture ${id} …`);
  }

  end() {
    const outW = Math.round(this.view.width * this.outScale);
    const outH = Math.round(this.view.height * this.outScale);
    const t: Timeline = { id: this.id, kind: this.kind, size: { w: outW, h: outH }, frames: this.frames, ...(this.lapse ? { lapse: this.lapse } : {}), marks: this.marks };
    fs.writeFileSync(path.join(this.dir, 'timeline.json'), JSON.stringify(t, null, 1));
    const secs = this.frames.reduce((s, f) => s + f.dur, 0);
    log(`capture ${this.id}: ${this.frames.length} frames, ${secs.toFixed(1)} s nominal${this.offSize ? `, ${this.offSize} off-size (normalised at render)` : ', all exact size'}`);
  }

  private clip(sx: number, sy: number) {
    const { width: vw, height: vh } = this.view;
    const z = Math.max(1, this.cam.z);
    // The clip must stay inside the viewport: if it pokes out even a fraction of
    // a pixel, Chrome drops the scale and returns an unscaled capture.
    const w = vw / z;
    const h = vh / z;
    // Chrome rounds the bitmap size; aim a quarter pixel above the integer on
    // the longer side so float error cannot land a row short. Render crops/pads
    // to the exact size anyway, without resampling.
    const scale = this.outScale * z * (1 + 0.25 / Math.max(vw * this.outScale, vh * this.outScale));
    const x = clamp(this.cam.cx - w / 2, 0, vw - w);
    const y = clamp(this.cam.cy - h / 2, 0, vh - h);
    // Chrome sizes the bitmap from the scaled clip edges, so a fractional origin
    // costs a pixel. Snapping the document-space origin to the output pixel grid
    // makes still and scrolling frames exact. Zoomed frames can still come out
    // 1-2 px short (Chrome rounds the clip in CSS px); render() pads those back
    // without resampling.
    const snap = (v: number, lo: number, hi: number) => {
      const q = Math.round(v * scale) / scale;
      return q < lo ? Math.ceil(lo * scale) / scale : q > hi ? Math.floor(hi * scale) / scale : q;
    };
    return { x: snap(sx + x, sx, sx + vw - w), y: snap(sy + y, sy, sy + vh - h), width: w, height: h, scale };
  }

  /** Draw the cursor state (after an optional page-side script), then screenshot the camera. */
  async shot(pre = ''): Promise<string> {
    const r = this.ripple;
    const args = [this.cursor.x, this.cursor.y, this.cursor.press, this.cursor.shown ? 1 : 0, r?.x ?? 0, r?.y ?? 0, r ? r.p : -1].map((v) => +v.toFixed(3));
    let lastErr: unknown;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
          const [sx, sy] = (await this.page.evaluate(
            `window.__dd ? window.__dd(${args.join(',')}, ${JSON.stringify(pre)}) : [window.scrollX, window.scrollY]`,
          )) as [number, number];
          const res = (await this.cdp.send('Page.captureScreenshot', {
            format: 'jpeg',
            quality: JPEG_Q,
            optimizeForSpeed: true,
            captureBeyondViewport: false,
            clip: this.clip(sx, sy),
          })) as { data: string };
          const buf = Buffer.from(res.data, 'base64');
          const size = jpegSize(buf);
          if (!size || size[0] !== Math.round(this.view.width * this.outScale) || size[1] !== Math.round(this.view.height * this.outScale)) this.offSize++;
          const file = `${String(this.n++).padStart(5, '0')}.jpg`;
          fs.writeFileSync(path.join(this.dir, file), buf);
          return file;
      } catch (err) {
        lastErr = err;
        await sleep(150);
      }
    }
    throw new Error(`screenshot failed in ${this.id}: ${String(lastErr)}`);
  }

  private push(file: string, dur: number, kind: FrameKind, at = Date.now()) {
    this.frames.push({ file, dur: +dur.toFixed(4), kind, w: at });
  }

  /** Name the next frame, optionally with a page rect projected into frame pixels under the current camera. */
  mark(name: string, rect?: Rect) {
    this.marks[name] = { at: this.frames.length, ...(rect ? { rect: this.project(rect) } : {}) };
  }

  /** A viewport rect in output frame pixels, for the camera as it is now. */
  project(r: Rect): Rect {
    const { width: vw, height: vh } = this.view;
    const z = Math.max(1, this.cam.z);
    const w = vw / z;
    const h = vh / z;
    const x = clamp(this.cam.cx - w / 2, 0, vw - w);
    const y = clamp(this.cam.cy - h / 2, 0, vh - h);
    const k = this.outScale * z;
    return { x: (r.x - x) * k, y: (r.y - y) * k, w: r.w * k, h: r.h * k };
  }

  async hold(seconds: number) {
    this.push(await this.shot(), seconds, 'hold');
  }

  /**
   * One eased move of any of: cursor, camera, window scroll, an element's scroll.
   * Every output frame is stepped, so it plays at exactly FPS.
   */
  async tween(seconds: number, to: { cursor?: Pt; cam?: Cam; scrollY?: number; el?: { sel: string; prop: 'scrollTop' | 'scrollLeft'; to: number } }) {
    const n = Math.max(1, Math.round(seconds * FPS));
    const c0 = { x: this.cursor.x, y: this.cursor.y };
    const cam0 = { ...this.cam };
    const s0 = to.scrollY !== undefined ? ((await this.page.evaluate('window.scrollY')) as number) : 0;
    const e0 = to.el ? ((await this.page.evaluate(`(document.querySelector(${JSON.stringify(to.el.sel)}) || {})[${JSON.stringify(to.el.prop)}] || 0`)) as number) : 0;
    // A gentle arc reads as a hand-moved mouse rather than a robot line.
    const dx = to.cursor ? to.cursor.x - c0.x : 0;
    const dy = to.cursor ? to.cursor.y - c0.y : 0;
    const dist = Math.hypot(dx, dy);
    const bend = Math.min(60, dist * 0.08);
    for (let i = 1; i <= n; i++) {
      const p = easeInOut(i / n);
      if (to.cursor) {
        const arc = Math.sin(Math.PI * p) * bend;
        this.cursor.x = lerp(c0.x, to.cursor.x, p) + (dist ? (-dy / dist) * arc : 0);
        this.cursor.y = lerp(c0.y, to.cursor.y, p) + (dist ? (dx / dist) * arc : 0);
      }
      if (to.cam) {
        this.cam = {
          cx: lerp(cam0.cx, to.cam.cx, p),
          cy: lerp(cam0.cy, to.cam.cy, p),
          z: Math.exp(lerp(Math.log(cam0.z), Math.log(to.cam.z), p)),
        };
      }
      let pre = '';
      if (to.scrollY !== undefined) pre += `window.scrollTo({top:${lerp(s0, to.scrollY, p).toFixed(2)},left:0,behavior:'instant'});`;
      if (to.el) pre += `{const e=document.querySelector(${JSON.stringify(to.el.sel)}); if (e) e[${JSON.stringify(to.el.prop)}]=${lerp(e0, to.el.to, p).toFixed(2)};}`;
      if (to.cursor && this.kind === 'desktop') await this.page.mouse.move(this.cursor.x, this.cursor.y);
      this.push(await this.shot(pre), 1 / FPS, 'step');
    }
  }

  /** Press, click for real, and let a ripple expand. */
  async click(at: Pt) {
    if (Math.hypot(at.x - this.cursor.x, at.y - this.cursor.y) > 2) await this.tween(0.5, { cursor: at });
    for (let i = 1; i <= 4; i++) {
      this.cursor.press = i / 4;
      this.push(await this.shot(), 1 / FPS, 'step');
    }
    await this.page.mouse.click(at.x, at.y);
    this.ripple = { x: at.x, y: at.y, p: 0 };
    for (let i = 1; i <= 14; i++) {
      this.ripple.p = i / 14;
      this.cursor.press = Math.max(0, 1 - i / 4);
      this.push(await this.shot(), 1 / FPS, 'step');
    }
    this.ripple = null;
    this.cursor.press = 0;
  }

  /** Real-time capture until `done()` is true; each frame lasts until the next one was taken. */
  async realUntil(done: () => Promise<boolean>, o: { kind?: 'real' | 'lapse'; timeoutMs: number; pre?: string; checkEveryMs?: number; what: string }) {
    const kind = o.kind ?? 'real';
    const start = Date.now();
    let lastCheck = 0;
    let prev: { file: string; at: number } | null = null;
    for (;;) {
      const at = Date.now();
      const file = await this.shot(o.pre ?? '');
      if (prev) this.push(prev.file, (at - prev.at) / 1000, kind, prev.at);
      prev = { file, at };
      if (at - lastCheck >= (o.checkEveryMs ?? 500)) {
        lastCheck = at;
        if (await done().catch(() => false)) break;
      }
      if (at - start > o.timeoutMs) throw new Error(`timed out after ${o.timeoutMs / 1000}s waiting for ${o.what}`);
      const spent = Date.now() - at;
      if (spent < 1000 / FPS) await sleep(1000 / FPS - spent);
    }
    this.push(prev.file, Math.max(1 / FPS, (Date.now() - prev.at) / 1000), kind, prev.at);
  }

  lapseStart() {
    this.lapseFrom = { index: this.frames.length, at: Date.now() };
  }

  lapseEnd() {
    if (!this.lapseFrom) throw new Error('lapseEnd without lapseStart');
    this.lapse = { from: this.lapseFrom.index, to: this.frames.length, real_s: +((Date.now() - this.lapseFrom.at) / 1000).toFixed(2) };
    this.lapseFrom = null;
  }

  camFor(r: Rect, pad = 26, zmax = 2): Cam {
    const z = clamp(Math.min(this.view.width / (r.w + 2 * pad), this.view.height / (r.h + 2 * pad)), 1, zmax);
    return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, z };
  }

  /**
   * Bring a page rect into a comfortable spot (scrolling if needed) and frame it,
   * all in one eased move. `cursor` is in the same pre-scroll viewport coordinates.
   */
  async focus(target: Rect, o: { seconds: number; pad?: number; zmax?: number; cursor?: Pt; top?: number; scroll?: boolean; maxRight?: number }) {
    const vh = this.view.height;
    const top = o.top ?? 72;
    const [sy, max] = (await this.page.evaluate('[window.scrollY, document.documentElement.scrollHeight - window.innerHeight]')) as [number, number];
    let delta = 0;
    if (o.scroll !== false && (target.y < top || target.y + target.h > vh - 12)) {
      const want = target.h > vh - top - 24 ? target.y - top : target.y - (top + (vh - top - target.h) / 2);
      delta = clamp(want, -sy, Math.max(0, max - sy));
    }
    const r = { ...target, y: target.y - delta };
    const cam = this.camFor(r, o.pad, o.zmax);
    // Keep the frame's right edge at or left of maxRight (a card boundary), so no neighbouring card is sliced.
    if (o.maxRight !== undefined) cam.cx = Math.min(cam.cx, o.maxRight - this.view.width / cam.z / 2);
    await this.tween(o.seconds, {
      cam,
      ...(delta ? { scrollY: sy + delta } : {}),
      ...(o.cursor ? { cursor: { x: o.cursor.x, y: o.cursor.y - delta } } : {}),
    });
  }
}

async function rectOf(l: Locator): Promise<Rect> {
  await l.waitFor({ state: 'visible', timeout: WAIT_MS });
  const b = await l.boundingBox();
  if (!b) throw new Error(`no box for ${l}`);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}
const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const union = (...rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};
const section = (page: Page, title: string) =>
  page.locator('section', { has: page.locator('h2', { hasText: new RegExp(`^${title}$`) }) }).first();

/** Under heavy load Chromium can take minutes to paint; wait for the DOM, then for real content. */
const WAIT_MS = 300_000;

async function nav(page: Page, url: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
      return;
    } catch (err) {
      if (attempt >= 2) throw err;
      log(`navigation to ${url} failed (${String(err).split('\n')[0]}); retrying`);
    }
  }
}

async function settle(page: Page, ms = 1200) {
  await page.evaluate('document.fonts.ready');
  await sleep(ms);
}

// ---------------------------------------------------------------------------
// Capture: preflight, then every app scene in one continuous browser session.

interface RunDetail {
  dispute: { id: string; reason: string; amount_cents: number; source: string; status: string };
  run: {
    id: string;
    status: string;
    clock_started_at: string;
    draft_ready_at: string | null;
    strength: { score: number } | null;
    ev: { recommended: string } | null;
    citation_check: { passed?: boolean; checked?: number } | null;
    draft: { sentences: { id: string; text: string; source_ids: string[] }[] } | null;
  } | null;
  steps: { kind: string; label: string }[];
  sources: { source_key: string; kind: string; title: string; content: string }[];
  decisions?: unknown[];
}

/** Values read off the page, never typed in: they go into the overlays exactly as shown. */
interface EvPage {
  score: string;
  options: { action: string; amount: string; formula: string; recommended: boolean }[];
}

interface CaptureFacts {
  captured_at: string;
  base_url: string;
  dpr: number;
  dispute: { id: string; reason: string; amount_cents: number };
  run: { id: string; status: string; strength: number | null; recommendation: string | null; real_run_seconds: number; step_labels: string[]; sources: number };
  background_dispute: string | null;
  submitted_text: string | null;
  pattern: { headline: string; action: string } | null;
  weak_case: { id: string; recommendation: string; strength: number | null } | null;
  weak_case_reason: string;
  /** E and W panels as read from the page. */
  ev_page: EvPage | null;
  weak_page: EvPage | null;
  /** The checker rejecting a hand-edited date, as the UI showed it; null if REJ was not captured. */
  rejection: { sentence_id: string; original: string; edited: string; token: string; shown: string } | null;
  rejection_reason: string;
  scenes: string[];
}

async function runDetail(id: string): Promise<RunDetail> {
  const r = await api<RunDetail>(`/api/disputes/${encodeURIComponent(id)}`);
  if (r.status !== 200) throw new Error(`GET dispute ${id}: HTTP ${r.status}`);
  return r.body;
}

async function waitRun(id: string, timeoutMs: number): Promise<RunDetail> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const d = await runDetail(id).catch(() => null);
    const st = d?.run?.status;
    if (d && st && st !== 'queued' && st !== 'running') return d;
    await sleep(2000);
  }
  throw new Error(`agent run on ${id} did not finish in time`);
}

const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } } as const;

/** Run the agent on one dispute through the app's own endpoint and wait; one retry if the CLI times out. */
async function analyse(id: string): Promise<RunDetail> {
  let r = await api<{ run_id?: string }>(`/api/disputes/${encodeURIComponent(id)}/run`, { ...JSON_POST, body: '{"force":false}' });
  if (r.status >= 400) throw new Error(`run ${id}: HTTP ${r.status}`);
  let d = await waitRun(id, 15 * 60_000);
  if (d.run?.status === 'failed') {
    log(`the run on ${id} failed (${d.run ? 'see trace' : ''}); retrying once`);
    r = await api(`/api/disputes/${encodeURIComponent(id)}/run`, { ...JSON_POST, body: '{"force":true}' });
    d = await waitRun(id, 15 * 60_000);
  }
  return d;
}

async function preflight(): Promise<{ background: string | null; weak: CaptureFacts['weak_case']; weakReason: string }> {
  const pool = await api<{ available?: number }>('/api/demo/pool').catch(() => {
    throw new Error(`the app is not reachable at ${BASE}; start it as the header of this file says`);
  });
  log(`pool: ${pool.body.available ?? 0} staged dispute(s)`);

  // Scene H needs mined patterns; mining is the seller's Recompute button.
  const pats = await api<{ patterns?: unknown[] }>('/api/patterns');
  if (!pats.body.patterns?.length) {
    log('mining patterns (Recompute) …');
    const r = await api<{ patterns?: unknown[] }>('/api/patterns/recompute', { ...JSON_POST, body: '{}' });
    log(`patterns: HTTP ${r.status}, ${r.body.patterns?.length ?? 0}`);
  }

  const staged = async () => {
    const list = await api<{ disputes: { id: string; source: string }[] }>('/api/disputes');
    return Promise.all(list.body.disputes.filter((d) => d.source !== 'fixture').map((d) => runDetail(d.id)));
  };
  let details = await staged();

  // The inbox (scenes A2 and C) should show scores, so the oldest staged dispute
  // is analysed before recording, triggered the same way the camera does it.
  if (!details.some((d) => d.dispute.id !== WEAK_CANDIDATE && d.run?.status === 'draft_ready') && (pool.body.available ?? 0) >= 2) {
    log('analysing the oldest staged dispute before recording, so the inbox has a score …');
    const t = await api<{ dispute_id?: string }>('/api/demo/trigger', { ...JSON_POST, body: '{}' });
    if (t.status !== 202 || !t.body.dispute_id) throw new Error(`demo trigger: HTTP ${t.status}`);
    const d = await waitRun(t.body.dispute_id, 15 * 60_000);
    if (d.run?.status === 'failed') await analyse(t.body.dispute_id);
  }

  // Scene W: one real run on the weak candidate. Nothing about its outcome is set
  // here; if the agent does not land on a non-FIGHT decision, W is cut.
  const cand = details.find((d) => d.dispute.id === WEAK_CANDIDATE);
  if (cand && !cand.run) {
    log(`analysing ${WEAK_CANDIDATE} for scene W …`);
    await analyse(WEAK_CANDIDATE);
  }
  details = await staged();
  const after = await api<{ available?: number }>('/api/demo/pool');
  if (!after.body.available) throw new Error('no staged dispute is left for the on-camera trigger; reset the demo DB (see the header of this file)');

  const analysed = details.filter((d) => d.run?.status === 'draft_ready');
  const weak = analysed.find((d) => d.run?.ev && d.run.ev.recommended !== 'FIGHT');
  const strong = analysed.find((d) => d.dispute.id !== weak?.dispute.id);
  const all = analysed.map((d) => `${d.dispute.id} ${d.run?.strength?.score ?? '?'}/100 ${d.run?.ev?.recommended ?? '?'}`).join(', ');
  return {
    background: strong?.dispute.id ?? null,
    weak: weak ? { id: weak.dispute.id, recommendation: weak.run!.ev!.recommended, strength: weak.run!.strength?.score ?? null } : null,
    weakReason: weak
      ? `recorded from ${weak.dispute.id}: a real run scored ${weak.run!.strength?.score}/100 and recommended ${weak.run!.ev!.recommended}`
      : `no analysed dispute recommends anything but FIGHT (${all || 'none analysed'}); scene W and its sentence are cut (storyboard honesty rule 4)`,
  };
}

/** Read a "Fight or concede" panel (and its strength score) exactly as rendered. */
async function readEvPanel(page: Page): Promise<EvPage> {
  return page.evaluate(() => {
    const sec = (title: string) =>
      Array.from(document.querySelectorAll('section')).find((s) => s.querySelector('h2')?.textContent?.trim() === title) ?? null;
    const strength = sec('Evidence strength');
    const score = strength?.querySelector('.tabular')?.textContent?.trim() ?? '';
    const options = Array.from(sec('Fight or concede')?.querySelectorAll('li') ?? []).map((li) => {
      const spans = Array.from(li.querySelectorAll('div span'));
      const label = (spans[0]?.textContent ?? '').trim();
      return {
        action: label.replace(/\s*recommended\s*$/, '').trim(),
        amount: (li.querySelector('div > span.tabular')?.textContent ?? '').trim(),
        formula: (li.querySelector('p')?.textContent ?? '').trim(),
        recommended: /recommended/.test(label),
      };
    });
    return { score, options };
  });
}

async function captureAll(): Promise<CaptureFacts> {
  const pre = await preflight();
  fs.mkdirSync(CAP, { recursive: true });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR });
    await ctx.addInitScript(INIT_SCRIPT);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const rec = new Shooter(page, cdp, VIEW, WIN.w / VIEW.width, 'desktop');

    // ---- C (and A2, which holds its first frame): the inbox; reveal deadline and strength, zoom on them.
    await nav(page, `${BASE}/`);
    await page.getByText('Dispute inbox').first().waitFor({ timeout: WAIT_MS });
    await page.locator('.ag-center-cols-container .ag-row').first().waitFor({ timeout: WAIT_MS });
    await settle(page, 2500);
    // ag-grid only renders columns in view, so measure the Recommendation column
    // with the grid scrolled to its end, off camera, then put it back.
    const hsel = '.ag-body-horizontal-scroll-viewport';
    const gridBody = await rectOf(page.locator('.ag-center-cols-viewport').first());
    const maxLeft = (await page.evaluate(`(() => { const h = document.querySelector('${hsel}'); h.scrollLeft = h.scrollWidth; return h.scrollWidth - h.clientWidth; })()`)) as number;
    await sleep(600);
    const recAtMax = await rectOf(page.locator('.ag-header-cell[col-id="recommendation"]').first());
    await page.evaluate(`document.querySelector('${hsel}').scrollLeft = 0`);
    await sleep(800);
    // Recommendation's right edge lands exactly on the grid's edge: no sliver of the next column.
    const toLeft = clamp(maxLeft + (recAtMax.x + recAtMax.w) - (gridBody.x + gridBody.w), 0, maxLeft);
    rec.begin('C');
    await rec.hold(1.6);
    rec.mark('zoom');
    await rec.tween(1.3, { el: { sel: hsel, prop: 'scrollLeft', to: toLeft }, cursor: { x: gridBody.x + gridBody.w * 0.55, y: gridBody.y + 150 } });
    await sleep(250);
    // Frame Amount through Recommendation, so no column is cut at either edge.
    const am = await rectOf(page.locator('.ag-header-cell[col-id="amount_cents"]').first());
    const rc = await rectOf(page.locator('.ag-header-cell[col-id="recommendation"]').first());
    const row2 = await rectOf(page.locator('.ag-center-cols-container .ag-row[row-index="2"]').first());
    const left = Math.max(am.x, gridBody.x) - 12;
    const right = Math.min(rc.x + rc.w, gridBody.x + gridBody.w) + 8;
    const colsRect = { x: left, y: am.y - 4, w: right - left, h: row2.y + row2.h - am.y + 8 };
    await rec.tween(1.1, { cam: rec.camFor(colsRect, 0, 1.9), cursor: { x: rc.x + rc.w * 0.5, y: row2.y + row2.h + 40 } });
    rec.mark('zoomHold');
    await rec.hold(3.2);
    await rec.tween(1.0, { cam: rec.full });
    await rec.hold(1.4);
    rec.end();

    // ---- D (and O1, O2): trigger a staged dispute and follow the live trace, sped up.
    rec.begin('D');
    await rec.hold(0.5);
    const trig = page.getByRole('button', { name: /trigger demo dispute/i }).first();
    const tb = await rectOf(trig);
    await rec.tween(1.2, { cursor: center(tb), cam: { cx: tb.x + tb.w / 2 - 120, cy: tb.y + 120, z: 1.55 } });
    rec.lapseStart();
    rec.mark('click');
    await rec.click(center(tb));
    rec.mark('clicked');
    await rec.realUntil(
      async () => /\/disputes\//.test(page.url()) && (await page.getByRole('heading', { name: 'Agent trace' }).isVisible()),
      { kind: 'lapse', timeoutMs: 180_000, what: 'the dispute page' },
    );
    const url = new URL(page.url());
    const disputeId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    log(`on-camera dispute: ${disputeId}`);
    // Frame the trace card edge to edge: nothing of the right-hand column.
    const trace = await rectOf(section(page, 'Agent trace'));
    const traceTarget = { x: trace.x, y: trace.y, w: trace.w, h: 470 };
    await rec.focus(traceTarget, { seconds: 1.1, pad: 8, zmax: 1.6, cursor: { x: trace.x + trace.w - 40, y: trace.y + 300 }, top: 76, maxRight: trace.x + trace.w + 10 });
    rec.mark('traceIn');
    const followTrace = `{const o=document.querySelector('ol'); if (o) o.scrollTop += Math.max(0, o.scrollHeight - o.clientHeight - o.scrollTop) * 0.45;}`;
    let finished: RunDetail | null = null;
    await rec.realUntil(
      async () => {
        const d = await runDetail(disputeId);
        if (d.run && d.run.status !== 'queued' && d.run.status !== 'running') finished = d;
        if (!finished) return false;
        // A failed run never shows the strength panel; stop and report it.
        return finished.run?.status !== 'draft_ready' || (await page.getByRole('heading', { name: 'Evidence strength' }).isVisible());
      },
      { kind: 'lapse', timeoutMs: 20 * 60_000, pre: followTrace, checkEveryMs: 1000, what: 'the agent run' },
    );
    for (let i = 0; i < 10; i++) {
      await page.evaluate(`{const o=document.querySelector('ol'); if (o) o.scrollTop = o.scrollHeight;}`);
      await sleep(60);
    }
    rec.lapseEnd();
    const done = finished as RunDetail | null;
    if (!done?.run || done.run.status !== 'draft_ready') throw new Error(`the on-camera agent run ended ${done?.run?.status}: ${JSON.stringify(done?.run).slice(0, 400)}`);
    rec.mark('runDone');
    await rec.hold(2.2);
    rec.mark('runDoneEnd');
    await rec.tween(1.0, { cam: rec.full });
    await rec.hold(0.6);
    rec.end();

    // ---- E: score, then the expected-value decision. The right column sits at
    // the frame's right edge; the overlays cover the left, so no card is sliced.
    rec.begin('E');
    await rec.hold(0.4);
    rec.mark('strengthMove');
    const strength = await rectOf(section(page, 'Evidence strength'));
    await rec.focus(strength, { seconds: 1.2, pad: 18, zmax: 1.75, cursor: { x: strength.x + strength.w - 70, y: strength.y + 40 } });
    rec.mark('strengthHold', await rectOf(section(page, 'Evidence strength')));
    await rec.hold(2.4);
    rec.mark('evMove');
    const ev = await rectOf(section(page, 'Fight or concede'));
    const recOpt = await rectOf(section(page, 'Fight or concede').locator('li', { hasText: 'recommended' }).first());
    await rec.focus(ev, { seconds: 1.1, pad: 18, zmax: 1.75, cursor: { x: recOpt.x + recOpt.w - 40, y: recOpt.y + recOpt.h - 6 } });
    rec.mark('evHold', await rectOf(section(page, 'Fight or concede')));
    await rec.hold(3.2);
    const evPage = await readEvPanel(page);
    await rec.tween(1.0, { cam: rec.full });
    await rec.hold(0.6);
    rec.end();

    // ---- F (and O3): the cited draft, one source opened, then the citation check.
    rec.begin('F');
    await rec.hold(0.4);
    const draftSec = section(page, 'Draft response');
    const draft = await rectOf(draftSec);
    await rec.focus({ ...draft, h: Math.min(draft.h, 430) }, { seconds: 1.3, pad: 18, zmax: 1.6, cursor: { x: draft.x + draft.w * 0.7, y: draft.y + 360 } });
    rec.mark('draftHold');
    await rec.hold(0.8);
    const chips = draftSec.locator('button[title]').filter({ hasText: /^S\d+$/ });
    let chip = chips.first();
    const n = await chips.count();
    for (let i = 0; i < n; i++) {
      const title = (await chips.nth(i).getAttribute('title')) ?? '';
      if (/message|buyer/i.test(title)) { chip = chips.nth(i); break; }
    }
    rec.mark('chipClick');
    const chipBox = await rectOf(chip);
    await rec.tween(0.8, { cursor: center(chipBox) });
    await rec.click(center(chipBox));
    const dialog = page.getByRole('dialog');
    await rec.realUntil(async () => dialog.isVisible(), { timeoutMs: 20_000, what: 'the source drawer' });
    const panel = await rectOf(dialog.locator('xpath=./div').first());
    const panelContent = (await page.evaluate(`(() => { const p = document.querySelector('[role=dialog] > div'); return p ? Math.max(...[...p.children].map(c => c.getBoundingClientRect().bottom)) : 400; })()`)) as number;
    const closeBtn = await rectOf(dialog.getByRole('button', { name: /^close$/i }));
    await rec.focus({ x: panel.x, y: 0, w: panel.w, h: clamp(panelContent + 20, 240, 520) }, { seconds: 0.9, pad: 18, zmax: 1.8, scroll: false, cursor: { x: panel.x + panel.w - 120, y: clamp(panelContent + 50, 300, 640) } });
    await rec.hold(1.8);
    await rec.click(center(closeBtn));
    await rec.realUntil(async () => !(await dialog.isVisible()), { timeoutMs: 10_000, what: 'the drawer to close' });
    rec.mark('drawerGone');
    await page.evaluate(`{const o=document.querySelector('ol'); if (o) o.scrollTop = o.scrollHeight;}`);
    const check = page.locator('ol li', { hasText: 'Citation check' }).first();
    const checkBox = await rectOf(check);
    const prevBox = await rectOf(page.locator('ol li', { hasText: 'submit_analysis' }).first()).catch(() => checkBox);
    const nextBox = await rectOf(page.locator('ol li', { hasText: /Review applied|Draft ready:/ }).first()).catch(() => checkBox);
    await rec.focus(union(prevBox, checkBox, nextBox), { seconds: 1.2, pad: 22, zmax: 1.9, cursor: { x: checkBox.x + checkBox.w * 0.78, y: checkBox.y + checkBox.h + 26 } });
    rec.mark('checkHold');
    await rec.hold(3.0);
    await rec.tween(1.0, { cam: rec.full });
    await rec.hold(0.5);
    rec.end();

    // ---- REJ: edit a date by hand; the app's checker must refuse it on Approve.
    // The edit is checked first with the app's own checker against this run's
    // stored sources, so an edit that would pass (and be submitted) is never tried.
    let rejection: CaptureFacts['rejection'] = null;
    let rejectionReason = '';
    try {
      const detail = await runDetail(disputeId);
      const sources = Object.fromEntries(detail.sources.map((s) => [s.source_key, { content: s.content }]));
      const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
      const sentences = detail.run?.draft?.sentences ?? [];
      const ordered = [...sentences.filter((s) => /deliver/i.test(s.text)), ...sentences.filter((s) => !/deliver/i.test(s.text))];
      let plan: { id: string; original: string; edited: string; date: string; newDate: string } | null = null;
      for (const s of ordered) {
        const dm = s.text.match(/\b\d{4}-\d{2}-\d{2}\b/);
        if (!dm) continue;
        for (const days of [-2, -3, 3, -5]) {
          const newDate = shift(dm[0], days);
          const edited = s.text.replace(dm[0], newDate);
          const result = checkSentences([{ ...s, text: edited }], sources as never);
          if (result.failed.length === 1 && result.failed[0].token === newDate) {
            plan = { id: s.id, original: s.text, edited, date: dm[0], newDate };
            break;
          }
        }
        if (plan) break;
      }
      if (!plan) throw new Error('no dated sentence where a changed date is guaranteed to fail the checker');
      const sentenceP = draftSec.locator('p', { hasText: plan.original.slice(0, 40) }).first();
      const editBtn = sentenceP.getByRole('button', { name: /^edit$/ });
      rec.begin('REJ');
      await rec.hold(0.3);
      const sp = await rectOf(sentenceP);
      await rec.focus({ ...sp, y: sp.y - 10, h: sp.h + 120 }, { seconds: 1.0, pad: 24, zmax: 1.7, cursor: center(await rectOf(editBtn)) });
      await rec.click(center(await rectOf(editBtn)));
      const ta = draftSec.locator('textarea').first();
      await rec.realUntil(async () => ta.isVisible(), { timeoutMs: 10_000, what: 'the sentence editor' });
      const at = plan.original.indexOf(plan.date);
      await ta.evaluate((el, [a, b]) => { const t = el as HTMLTextAreaElement; t.focus(); t.setSelectionRange(a, b); }, [at, at + plan.date.length]);
      await rec.hold(0.5);
      for (const ch of plan.newDate) {
        await page.keyboard.type(ch);
        await rec.tween(0.07, {});
      }
      await rec.hold(0.4);
      await page.evaluate('document.activeElement && document.activeElement.blur()');
      await rec.hold(0.4);
      const approve = page.getByRole('button', { name: /approve & submit evidence/i }).first();
      const decisionR = await rectOf(section(page, 'Decision'));
      const apb = await rectOf(approve);
      await rec.focus(decisionR, { seconds: 1.0, pad: 22, zmax: 1.75, cursor: { x: apb.x + apb.w * 0.6, y: apb.y + apb.h / 2 }, top: 100 });
      rec.mark('approveClick');
      await rec.click(center(await rectOf(approve)));
      const failText = draftSec.locator('p.text-lost, p[class*="text-lost"]').first();
      await rec.realUntil(async () => (await page.locator('section[role="status"]').first().isVisible()) && (await failText.isVisible()), { timeoutMs: 60_000, what: 'the checker to answer' });
      const shown = ((await failText.innerText()) || '').trim();
      const failedP = draftSec.locator('div.bg-lost-soft').first();
      const fb = await rectOf(failedP);
      await rec.focus({ ...fb, y: fb.y - 8, h: fb.h + 16 }, { seconds: 1.0, pad: 26, zmax: 1.8, cursor: { x: fb.x + fb.w - 60, y: fb.y + fb.h + 30 } });
      rec.mark('blocked', await rectOf(failedP));
      await rec.hold(2.6);
      rec.end();
      const after = await runDetail(disputeId);
      if (after.run?.status !== 'draft_ready') throw new Error(`after the rejected approve the run is ${after.run?.status}; something was submitted`);
      if (!shown.includes(plan.newDate)) throw new Error(`the UI did not show the rejected date (it showed: ${shown.slice(0, 120)})`);
      rejection = { sentence_id: plan.id, original: plan.original, edited: plan.edited, token: plan.newDate, shown };
      rejectionReason = `checker refused "${plan.newDate}" (was ${plan.date}); the run is still draft_ready, nothing submitted`;
    } catch (err) {
      rejectionReason = `REJ cut: ${String(err).split('\n')[0]}`;
      log(rejectionReason);
    }
    // Drop the edited text from the page before anything is approved for real.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: WAIT_MS });
    await page.getByRole('button', { name: /approve & submit evidence/i }).first().waitFor({ timeout: WAIT_MS });
    await settle(page, 1200);
    rec.cam = rec.full;

    // ---- I: the same dispute at phone width, ending on the approve control.
    const mctx = await browser.newContext({ viewport: PHONE_VIEW, deviceScaleFactor: DPR, isMobile: true, hasTouch: true });
    await mctx.addInitScript(INIT_SCRIPT);
    const mpage = await mctx.newPage();
    const mcdp = await mctx.newCDPSession(mpage);
    const mrec = new Shooter(mpage, mcdp, PHONE_VIEW, 1, 'mobile');
    await nav(mpage, page.url());
    await mpage.getByRole('button', { name: /approve & submit evidence/i }).first().waitFor({ timeout: WAIT_MS });
    await settle(mpage, 1500);
    const mApprove0 = await rectOf(mpage.getByRole('button', { name: /approve & submit evidence/i }).first());
    const mY0 = (await mpage.evaluate('window.scrollY')) as number;
    const target = mY0 + mApprove0.y - PHONE_VIEW.height * 0.45;
    await mpage.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior }), Math.max(0, target - 700));
    await sleep(500);
    mrec.begin('I');
    await mrec.hold(0.5);
    await mrec.tween(1.1, { scrollY: target });
    mrec.mark('approveVisible');
    await mrec.hold(1.5);
    mrec.end();
    await mctx.close();

    // ---- G: approve, submit to the mock adapter, show the result.
    rec.begin('G');
    await rec.hold(0.4);
    const approveBtn = page.getByRole('button', { name: /approve & submit evidence/i }).first();
    const decision = await rectOf(section(page, 'Decision'));
    const ab = await rectOf(approveBtn);
    await rec.focus(decision, { seconds: 1.3, pad: 22, zmax: 1.9, cursor: { x: ab.x + ab.w * 0.62, y: ab.y + ab.h / 2 }, top: 100 });
    rec.mark('approveHover');
    await rec.hold(0.9);
    rec.mark('approveClick');
    await rec.click(center(await rectOf(approveBtn)));
    const result = page.getByText('Evidence submitted to PayPal');
    await rec.realUntil(async () => result.isVisible(), { timeoutMs: 120_000, what: 'the submission result' });
    await settle(page, 300);
    const resBox = await rectOf(page.locator('section[role="status"]').first());
    const decision2 = await rectOf(section(page, 'Decision'));
    await rec.focus(union(decision2, resBox), { seconds: 1.1, pad: 20, zmax: 1.9, cursor: { x: resBox.x + resBox.w - 60, y: resBox.y + resBox.h + 30 } });
    rec.mark('resultHold', await rectOf(page.locator('section[role="status"]').first()));
    await rec.hold(3.0);
    await rec.tween(1.1, { cam: rec.full });
    await rec.hold(0.6);
    const submittedText = ((await page.locator('section[role="status"]').first().innerText()) || '').replace(/\s+/g, ' ').trim();
    rec.end();

    // ---- W: only if a real run produced a non-FIGHT decision (honesty rule 4). Never clicks.
    let weakPage: EvPage | null = null;
    if (pre.weak) {
      await nav(page, `${BASE}/disputes/${encodeURIComponent(pre.weak.id)}`);
      await page.getByRole('heading', { name: 'Fight or concede' }).waitFor({ timeout: WAIT_MS });
      await page.getByRole('button', { name: /accept & refund/i }).first().waitFor({ timeout: WAIT_MS });
      await settle(page);
      rec.cam = rec.full;
      rec.begin('W');
      await rec.hold(0.6);
      rec.mark('strengthMove');
      await rec.focus(await rectOf(section(page, 'Evidence strength')), { seconds: 1.2, pad: 18, zmax: 1.75 });
      rec.mark('strengthHold', await rectOf(section(page, 'Evidence strength')));
      await rec.hold(2.4);
      rec.mark('mathMove');
      const options = await rectOf(section(page, 'Fight or concede').locator('ul').first());
      const decisionW = await rectOf(section(page, 'Decision'));
      const acceptBtn = await rectOf(page.getByRole('button', { name: /accept & refund/i }).first());
      await rec.focus(union(options, decisionW), { seconds: 1.2, pad: 16, zmax: 1.75, cursor: { x: acceptBtn.x - 18, y: acceptBtn.y + acceptBtn.h / 2 } });
      rec.mark('mathHold', union(await rectOf(section(page, 'Fight or concede').locator('ul').first()), await rectOf(section(page, 'Decision'))));
      await rec.hold(3.4);
      weakPage = await readEvPanel(page);
      rec.end();
    }

    // ---- H: Patterns, from the nav tab; frame the size-chart pattern.
    rec.begin('H');
    await rec.hold(0.4);
    const tab = await rectOf(page.getByRole('link', { name: /^patterns$/i }).first());
    await rec.tween(1.0, { cursor: center(tab) });
    await rec.click(center(tab));
    await rec.realUntil(async () => /\/patterns/.test(page.url()) && (await page.locator('article').first().isVisible()), { timeoutMs: 60_000, what: 'the Patterns page' });
    await settle(page, 400);
    await rec.hold(1.2);
    let card = page.locator('article', { hasText: /size chart/i }).first();
    if (!(await card.count())) card = page.locator('article').first();
    const cardBox = await rectOf(card);
    const headline = ((await card.locator('h2').first().innerText()) || '').trim();
    const action = await card.evaluate((el) => {
      const ps = Array.from(el.querySelectorAll('p'));
      const i = ps.findIndex((p) => /prevention action/i.test(p.textContent || ''));
      return i >= 0 && ps[i + 1] ? (ps[i + 1].textContent || '').trim() : '';
    });
    const h2Box = await rectOf(card.locator('h2').first());
    rec.mark('cardMove');
    await rec.focus({ ...cardBox, h: Math.min(cardBox.h, 520) }, { seconds: 1.3, pad: 22, zmax: 1.8, cursor: { x: h2Box.x + Math.min(h2Box.w, 420), y: h2Box.y + h2Box.h + 8 } });
    await rec.hold(3.4);
    await rec.tween(1.1, { cam: rec.full });
    await rec.hold(0.6);
    rec.end();

    const real = done.run;
    const realSeconds = real.draft_ready_at ? (Date.parse(real.draft_ready_at) - Date.parse(real.clock_started_at)) / 1000 : 0;
    const facts: CaptureFacts = {
      captured_at: new Date().toISOString(),
      base_url: BASE,
      dpr: DPR,
      dispute: { id: done.dispute.id, reason: done.dispute.reason, amount_cents: done.dispute.amount_cents },
      run: {
        id: real.id,
        status: real.status,
        strength: real.strength?.score ?? null,
        recommendation: real.ev?.recommended ?? null,
        real_run_seconds: Math.round(realSeconds),
        step_labels: done.steps.map((s) => `${s.kind}: ${s.label}`),
        sources: done.sources.length,
      },
      background_dispute: pre.background,
      submitted_text: submittedText || null,
      pattern: headline ? { headline, action } : null,
      weak_case: pre.weak,
      weak_case_reason: pre.weakReason,
      ev_page: evPage,
      weak_page: weakPage,
      rejection,
      rejection_reason: rejectionReason,
      scenes: ['C', 'D', 'E', 'F', ...(rejection ? ['REJ'] : []), 'I', 'G', ...(pre.weak ? ['W'] : []), 'H'],
    };
    fs.writeFileSync(path.join(CAP, 'capture.json'), JSON.stringify(facts, null, 2));
    return facts;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Render: cards, overlays, voice, captions, audio, one ffmpeg pass.

interface Cue { from: number; to: number; lines: string[] }

/**
 * Split narration into caption cues: whole sentences, split at clause commas
 * when longer than `maxChars`, never leaving a short orphan clause, then at
 * most two balanced lines. Defaults suit 44 px captions.
 */
export function cueTexts(text: string, maxChars = 60, lineChars = 34, minChars = 22): string[][] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text.trim()];
  const splitWords = (c: string): string[] => {
    const parts = Math.ceil(c.length / maxChars);
    const target = c.length / parts;
    const out: string[] = [];
    let cur = '';
    for (const w of c.split(' ')) {
      if (cur && (cur.length + 1 + w.length > maxChars || (cur.length >= target && out.length < parts - 1))) {
        out.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) out.push(cur);
    return out;
  };
  const chunks: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChars) {
      chunks.push(s);
      continue;
    }
    const packed: string[] = [];
    let cur = '';
    for (const c of s.split(/(?<=[,;:])\s+/)) {
      if (!cur) cur = c;
      else if (`${cur} ${c}`.length <= maxChars || cur.length < minChars) cur = `${cur} ${c}`;
      else {
        packed.push(cur);
        cur = c;
      }
    }
    if (cur) {
      if (cur.length < minChars && packed.length) packed[packed.length - 1] += ` ${cur}`;
      else packed.push(cur);
    }
    for (const c of packed) chunks.push(...(c.length <= maxChars ? [c] : splitWords(c)));
  }
  return chunks.map((c) => {
    if (c.length <= lineChars) return [c];
    const words = c.split(' ');
    let best = 1;
    let bestScore = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ').length;
      const b = words.slice(i).join(' ').length;
      const score = Math.max(a, b) + (/[,;:]$/.test(words[i - 1]) ? -4 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
  });
}

/**
 * Time cues against the narration audio: speech span and pauses come from
 * silencedetect; cue boundaries start at character-proportional estimates and
 * snap to the nearest real pause.
 */
export function timeCues(cues: string[][], speech: { start: number; end: number }, pauses: { s: number; e: number }[]): Cue[] {
  const lens = cues.map((c) => c.join(' ').length + 6);
  const total = lens.reduce((a, b) => a + b, 0);
  const span = speech.end - speech.start;
  const inner = pauses.filter((p) => p.s > speech.start + 0.2 && p.e < speech.end - 0.2);
  const used = new Set<number>();
  const bounds: { endPrev: number; startNext: number }[] = [];
  let acc = 0;
  let prevT = speech.start;
  for (let k = 0; k < cues.length - 1; k++) {
    acc += lens[k];
    const est = speech.start + (span * acc) / total;
    let pick = -1;
    let bestD = Infinity;
    inner.forEach((p, i) => {
      const mid = (p.s + p.e) / 2;
      const d = Math.abs(mid - est);
      if (!used.has(i) && mid > prevT + 0.5 && d < Math.max(1.2, span * 0.12) && d < bestD) {
        bestD = d;
        pick = i;
      }
    });
    if (pick >= 0) {
      used.add(pick);
      const p = inner[pick];
      bounds.push({ endPrev: p.s + 0.12, startNext: Math.max(p.s + 0.12, p.e - 0.08) });
      prevT = (p.s + p.e) / 2;
    } else {
      bounds.push({ endPrev: est, startNext: est });
      prevT = est;
    }
  }
  return cues.map((lines, k) => ({
    from: k === 0 ? Math.max(0, speech.start - 0.05) : bounds[k - 1].startNext,
    to: k === cues.length - 1 ? speech.end + 0.25 : bounds[k].endPrev,
    lines,
  }));
}

function srtTime(s: number): string {
  const ms = Math.round(Math.max(0, s) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor((ms % 3_600_000) / 60_000))}:${p(Math.floor((ms % 60_000) / 1000))},${p(ms % 1000, 3)}`;
}

function bestSayVoice(): string {
  const out = spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout ?? '';
  const en = out.split('\n').filter((l) => /\ben_(US|GB|AU|IE|CA|NZ)\b/.test(l));
  const name = (l: string) => l.split(/\s{2,}/)[0].trim();
  const pick = en.find((l) => /\(Premium\)/.test(l)) ?? en.find((l) => /\(Enhanced\)/.test(l)) ?? en.find((l) => /^Samantha\s/.test(l));
  return pick ? name(pick) : 'Samantha';
}

interface Voice { file: string; seconds: number; source: string; draft: boolean; speech: { start: number; end: number }; pauses: { s: number; e: number }[] }

function prepareVoice(id: string, text: string, sayVoice: string): Voice {
  const supplied = firstExisting(path.join(V2, 'voice', id), ['wav', 'mp3']);
  let src = supplied;
  let source = supplied ? rel(supplied) : '';
  if (!src) {
    const cacheDir = path.join(WORK, 'voice-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    src = path.join(cacheDir, `${sha(`${sayVoice}|${SAY_RATE}|${text}`)}.aiff`);
    if (!fs.existsSync(src)) run('say', ['-v', sayVoice, '-r', SAY_RATE, '-o', src, text]);
    source = `macOS say "${sayVoice}" (DRAFT)`;
  }
  const out = path.join(REN, `voice-${id}.wav`);
  // Trim leading and trailing silence so timing is the speech itself.
  run('ffmpeg', ['-hide_banner', '-y', '-i', src, '-af',
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse,aresample=48000',
    '-ac', '2', '-c:a', 'pcm_s16le', out]);
  const seconds = wavSeconds(out);
  const det = run('ffmpeg', ['-hide_banner', '-i', out, '-af', 'silencedetect=noise=-36dB:d=0.14', '-f', 'null', '-']);
  const starts = [...det.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
  const ends = [...det.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const pauses = starts.map((s, i) => ({ s, e: ends[i] ?? seconds }));
  return { file: out, seconds, source, draft: !supplied, speech: { start: 0, end: seconds }, pauses };
}

function hasAudio(file: string): boolean {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return /Stream #.*Audio:/.test(String(r.stderr));
}

function mediaSeconds(file: string): number {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = String(r.stderr).match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

export interface Retimed {
  frames: Frame[];
  seconds: number;
  speed: number | null;
  lapseOut: [number, number] | null;
  lapseRealS: number | null;
  /** For each anchor: where it was asked to land and where it did. */
  anchors: { at: number; wanted: number; landed: number }[];
}

/**
 * Fit a captured timeline to `target` seconds. Only holds stretch or shrink
 * (and the sped-up window, which picks a round, stated factor). Anchors pin a
 * frame index to an output time, typically a narration cue, so a beat such as
 * "the drawer is closed" lands where the voice needs it, whatever the read.
 */
export function retime(t: Timeline, target: number, anchorsIn: { at: number; time: number }[] = [], keys: number[] = []): Retimed {
  const key = new Set(keys);
  const frames = t.frames.map((f) => ({ ...f }));
  const lap = t.lapse;
  const inLap = (i: number) => !!lap && i >= lap.from && i < lap.to;
  const sum = (pred: (f: Frame, i: number) => boolean) => frames.reduce((s, f, i) => (pred(f, i) ? s + f.dur : s), 0);
  const holdsNominal = sum((f) => f.kind === 'hold');
  let speed: number | null = null;
  if (lap) {
    const fixedOutside = sum((f, i) => !inLap(i) && f.kind !== 'hold');
    const stepsInside = sum((f, i) => inLap(i) && f.kind !== 'lapse');
    const lapseReal = sum((f) => f.kind === 'lapse');
    const windowWanted = Math.max(1.5, target - fixedOutside - holdsNominal);
    // The badge states the window's average speed, so pick a round factor first.
    const raw = lap.real_s / windowWanted;
    speed = raw >= 10 ? Math.round(raw) : Math.max(1, Math.round(raw * 2) / 2);
    const lapseOut = Math.max(0.5, lap.real_s / speed - stepsInside);
    const k = lapseOut / lapseReal;
    frames.forEach((f) => { if (f.kind === 'lapse') f.dur *= k; });
    speed = lap.real_s / (lapseOut + stepsInside);
  }
  // Holds, segment by segment between anchors.
  const anchors = anchorsIn.filter((a) => a.at > 0 && a.at < frames.length && a.time > 0 && a.time < target).sort((a, b) => a.at - b.at);
  const bounds = [0, ...anchors.map((a) => a.at), frames.length];
  const times = [0, ...anchors.map((a) => a.time), target];
  let clock = 0;
  const landed: Retimed['anchors'] = [];
  for (let sgi = 0; sgi < bounds.length - 1; sgi++) {
    const [a, b] = [bounds[sgi], bounds[sgi + 1]];
    const lastSeg = sgi === bounds.length - 2;
    const want = Math.max(0, times[sgi + 1] - clock);
    let fixed = 0;
    let holds = 0;
    for (let i = a; i < b; i++) {
      if (frames[i].kind === 'hold') holds += frames[i].dur;
      else fixed += frames[i].dur;
    }
    const k = holds > 0 ? (want - fixed) / holds : 1;
    for (let i = a; i < b; i++) {
      if (frames[i].kind !== 'hold') continue;
      const last = lastSeg && i === frames.length - 1;
      // Key holds (a result, a number) never drop below 2 s; transitional beats may shrink.
      const floor = Math.max(last ? XFADE + 0.35 : 0.12, key.has(i) ? Math.min(frames[i].dur, 2) : 0);
      frames[i].dur = Math.max(floor, frames[i].dur * k);
    }
    for (let i = a; i < b; i++) clock += frames[i].dur;
    if (sgi < anchors.length) landed.push({ at: anchors[sgi].at, wanted: +anchors[sgi].time.toFixed(2), landed: +clock.toFixed(2) });
  }
  let lapseOut: [number, number] | null = null;
  if (lap) {
    lapseOut = [frames.slice(0, lap.from).reduce((s, f) => s + f.dur, 0), frames.slice(0, lap.to).reduce((s, f) => s + f.dur, 0)];
  }
  return { frames, seconds: frames.reduce((s, f) => s + f.dur, 0), speed, lapseOut, lapseRealS: lap?.real_s ?? null, anchors: landed };
}

/**
 * Frames [from, to) of a capture as a timeline of their own: marks re-based, the
 * sped-up window recomputed from wall-clock times, and an elastic hold of the
 * last frame appended so the slice can stretch to its narration.
 */
export function sliceTimeline(t: Timeline, from: number, to: number, tail = 0.4): Timeline {
  const frames = t.frames.slice(from, to).map((f) => ({ ...f }));
  const marks = Object.fromEntries(
    Object.entries(t.marks ?? {})
      .filter(([, m]) => m.at >= from && m.at <= to)
      .map(([k, m]) => [k, { ...m, at: m.at - from }]),
  );
  const lapseIdx = frames.map((f, i) => (f.kind === 'lapse' ? i : -1)).filter((i) => i >= 0);
  let lapse: Timeline['lapse'];
  if (lapseIdx.length) {
    const a = lapseIdx[0];
    const b = lapseIdx[lapseIdx.length - 1] + 1;
    const last = frames[b - 1];
    const real = frames[a].w !== undefined && last.w !== undefined
      ? (last.w + last.dur * 1000 - frames[a].w!) / 1000
      : frames.slice(a, b).reduce((s, f) => s + (f.kind === 'lapse' ? f.dur : 0), 0);
    lapse = { from: a, to: b, real_s: +real.toFixed(2) };
  }
  if (tail > 0 && frames.length) frames.push({ ...frames[frames.length - 1], dur: tail, kind: 'hold' });
  return { ...t, frames, marks, ...(lapse ? { lapse } : { lapse: undefined }) };
}

/**
 * Frames whose size is off by a pixel or two (captures made before the clip was
 * snapped to the pixel grid) would make ffmpeg rebuild its filter graph mid-run,
 * which resets trim/tpad and stalls xfade. Bring just those frames to the exact
 * size without resampling: crop any overflow, pad the shortfall by smearing the
 * edge. Cached, so --reuse-capture pays this once.
 */
function normalizeFrames(srcDir: string, frames: Frame[], w: number, h: number, name: string): Map<string, string> {
  // Kept inside the scene's capture folder, so a new capture never reuses old fixes.
  const fixedDir = path.join(srcDir, '.fixed');
  const map = new Map<string, string>();
  const todo: string[] = [];
  for (const f of new Set(frames.map((x) => x.file))) {
    const size = jpegSize(fs.readFileSync(path.isAbsolute(f) ? f : path.join(srcDir, f)));
    if (size && size[0] === w && size[1] === h) continue;
    const fixed = path.join(fixedDir, f);
    map.set(f, fixed);
    if (!fs.existsSync(fixed)) todo.push(f);
  }
  if (todo.length) {
    const tmp = path.join(REN, 'normalize', name);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(fixedDir, { recursive: true });
    todo.forEach((f, i) => fs.symlinkSync(path.isAbsolute(f) ? f : path.join(srcDir, f), path.join(tmp, `${String(i).padStart(6, '0')}.jpg`)));
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    run('ffmpeg', ['-hide_banner', '-y', '-framerate', String(FPS), '-start_number', '0', '-i', path.join(tmp, '%06d.jpg'),
      '-vf', `crop=w='min(iw,${w})':h='min(ih,${h})':x=0:y=0,pad=${w}:${h}:0:0,fillborders=right=2:bottom=2:mode=smear`,
      '-q:v', '2', '-start_number', '0', path.join(out, '%06d.jpg')]);
    todo.forEach((f, i) => fs.renameSync(path.join(out, `${String(i).padStart(6, '0')}.jpg`), path.join(fixedDir, f)));
    log(`normalised ${todo.length} off-size frame(s) in ${name}`);
  }
  return map;
}

function writeSequence(srcDir: string, frames: Frame[], seconds: number, name: string, fixed = new Map<string, string>()): string[] {
  const out = path.join(REN, 'seq', name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const ends: number[] = [];
  let acc = 0;
  for (const f of frames) ends.push((acc += f.dur));
  const n = Math.max(1, Math.round(seconds * FPS));
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / FPS;
    while (j < frames.length - 1 && ends[j] <= t) j++;
    const src = fixed.get(frames[j].file) ?? (path.isAbsolute(frames[j].file) ? frames[j].file : path.join(srcDir, frames[j].file));
    fs.symlinkSync(src, path.join(out, `${String(i).padStart(6, '0')}${path.extname(frames[j].file)}`));
  }
  return ['-framerate', String(FPS), '-start_number', '0', '-i', path.join(out, `%06d${path.extname(frames[0].file)}`)];
}

async function shoot(page: Page, file: string, transparent: boolean) {
  await page.screenshot({ path: file, omitBackground: transparent, type: 'png' });
}

async function openCard(browser: Browser, name: string, params: Record<string, string | number>): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: FRAME.w, height: FRAME.h }, deviceScaleFactor: 1 });
  const u = pathToFileURL(path.join(CARDS, `${name}.html`));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  await page.goto(u.href, { waitUntil: 'load', timeout: WAIT_MS });
  await page.waitForFunction('document.body.dataset.ready === "1"', undefined, { timeout: WAIT_MS });
  await sleep(150);
  return page;
}

/** Frame-step an animated HTML card. Cached by the card's source and parameters. */
async function cardTimeline(browser: Browser, name: 'title' | 'architecture' | 'end', params: Record<string, string>): Promise<{ dir: string; t: Timeline }> {
  const key = sha(fs.readFileSync(path.join(CARDS, `${name}.html`)).toString() + fs.readFileSync(path.join(CARDS, 'theme.css')).toString() + JSON.stringify(params) + FPS);
  const dir = path.join(WORK, 'cards', `${name}-${key}`);
  const tl = path.join(dir, 'timeline.json');
  if (fs.existsSync(tl)) return { dir, t: JSON.parse(fs.readFileSync(tl, 'utf8')) as Timeline };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const page = await openCard(browser, name, params);
  const ms = (await page.evaluate('window.DURATION_MS')) as number;
  const n = Math.ceil((ms / 1000) * FPS);
  const frames: Frame[] = [];
  for (let i = 0; i <= n; i++) {
    await page.evaluate(`window.seek(${((i * 1000) / FPS).toFixed(3)})`);
    const file = `${String(i).padStart(5, '0')}.jpg`;
    await page.screenshot({ path: path.join(dir, file), type: 'jpeg', quality: JPEG_Q });
    frames.push({ file, dur: 1 / FPS, kind: i === n ? 'hold' : 'step' });
  }
  await page.close();
  const t: Timeline = { id: name, kind: 'card', size: { w: FRAME.w, h: FRAME.h }, frames };
  fs.writeFileSync(tl, JSON.stringify(t));
  return { dir, t };
}

type Src =
  | { kind: 'ai' }
  | { kind: 'card'; card: 'title' | 'architecture' | 'end'; params: Record<string, string> }
  | { kind: 'cap'; cap: string; from?: string; to?: string; tail?: number }
  | { kind: 'still'; cap: string; frame: number }
  | { kind: 'montage'; picks: { cap: string; mark: string }[] };

interface CutScene {
  id: string;
  text: string | null;
  /** Shows the running app, so the fixtures disclosure is on screen. */
  product: boolean;
  src: Src;
  /** Capture mark -> the narration phrase it must land on. */
  anchors?: Record<string, string>;
}

interface Built {
  scene: CutScene;
  start: number;
  seconds: number;
  voice: Voice | null;
  asset: string;
  fallback: boolean;
  input: string[][];
  filter: (label: string, idx: number[]) => string;
  timeline?: Timeline;
  retimed?: Retimed;
  geo?: { x: number; y: number; w: number; h: number };
}

interface Track { png: string; x: number; y: number; from: number; to: number; fade: number; what: string }
interface Layer { png: string; x: number; y: number }

const pace = (id: string) => PACE[id] ?? { lead: LEAD, tail: TAIL };

async function render(facts: CaptureFacts, reused: boolean) {
  const t0 = Date.now();
  fs.rmSync(REN, { recursive: true, force: true });
  fs.mkdirSync(REN, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ---- Narration that the capture can honestly support (storyboard rule 4).
  const labels = facts.run.step_labels.join('\n');
  const needTools = ['get_dispute', 'get_messages', 'get_transaction', 'get_tracking', 'get_policy'];
  const missing = needTools.filter((t) => !labels.includes(t));
  if (missing.length) throw new Error(`scene D narrates tool calls the run did not make: ${missing.join(', ')}`);
  if (!/check: Citation check/.test(labels)) throw new Error('scene F narrates the citation checker, but the trace has no citation check step');
  if (!facts.submitted_text?.includes('Evidence submitted')) throw new Error('scene G narrates a submission that was not recorded');
  const sizeChart = /size chart/i.test(`${facts.pattern?.headline ?? ''} ${facts.pattern?.action ?? ''}`);
  const fights = facts.run.recommendation === 'FIGHT';
  const weakShown = !!facts.weak_case && !!facts.weak_page && facts.weak_page.options.some((o) => o.recommended && !/^fight/i.test(o.action));
  const rejShown = !!facts.rejection && (facts.scenes ?? []).includes('REJ');
  const b1 = firstExisting(path.join(V2, 'ai', 'B1'), ['mp4', 'mov']);
  const cut: CutScene[] = [
    { id: 'A1', text: NARRATION.A1, product: false, src: { kind: 'ai' } },
    { id: 'O1', text: NARRATION.O1, product: true, src: { kind: 'cap', cap: 'D', to: 'click', tail: 0.5 } },
    { id: 'O2', text: NARRATION.O2, product: true, src: { kind: 'cap', cap: 'D', from: 'click', to: 'runDoneEnd', tail: 0 } },
    { id: 'O3', text: NARRATION.O3, product: true, src: { kind: 'cap', cap: 'F', to: 'chipClick', tail: 0.4 } },
    { id: 'T', text: null, product: false, src: { kind: 'card', card: 'title', params: { product: BRAND.product, subtitle: BRAND.subtitle } } },
    ...(b1 ? [{ id: 'B1', text: null, product: false, src: { kind: 'ai' as const } }] : []),
    { id: 'A2', text: NARRATION.A2, product: true, src: { kind: 'still', cap: 'C', frame: 0 } },
    { id: 'C', text: NARRATION.C, product: true, src: { kind: 'cap', cap: 'C' }, anchors: { zoom: 'Every open dispute' } },
    { id: 'D', text: NARRATION.D, product: true, src: { kind: 'cap', cap: 'D', from: 'traceIn', to: 'runDoneEnd', tail: 0.5 } },
    { id: 'E', text: fights ? NARRATION.E : FALLBACK_NARRATION.E, product: true, src: { kind: 'cap', cap: 'E' }, anchors: { evMove: 'then does the math' } },
    { id: 'F', text: NARRATION.F, product: true, src: { kind: 'cap', cap: 'F' }, anchors: { chipClick: 'Click one', drawerGone: 'Every number' } },
    ...(rejShown ? [{ id: 'REJ', text: NARRATION.REJ, product: true, src: { kind: 'cap' as const, cap: 'REJ' } }] : []),
    { id: 'G', text: NARRATION.G, product: true, src: { kind: 'cap', cap: 'G' }, anchors: { approveClick: 'One click submits' } },
    ...(weakShown ? [{ id: 'W', text: NARRATION.W, product: true, src: { kind: 'cap' as const, cap: 'W' }, anchors: { mathMove: 'and shows the dollar math' } }] : []),
    { id: 'H', text: sizeChart ? NARRATION.H : FALLBACK_NARRATION.H, product: true, src: { kind: 'cap', cap: 'H' }, anchors: { cardMove: 'Patterns groups' } },
    { id: 'I', text: NARRATION.I, product: true, src: { kind: 'cap', cap: 'I' } },
    { id: 'K', text: NARRATION.K, product: false, src: { kind: 'card', card: 'architecture', params: {} } },
    {
      id: 'R',
      text: NARRATION.R,
      product: true,
      src: { kind: 'montage', picks: [{ cap: 'F', mark: 'draftHold' }, { cap: 'E', mark: 'evHold' }, { cap: 'G', mark: 'approveHover' }] },
      anchors: { b1: 'Every option costed', b2: 'Nothing sent' },
    },
    { id: 'J1', text: NARRATION.J1, product: false, src: { kind: 'ai' } },
    { id: 'Z', text: NARRATION.Z, product: false, src: { kind: 'card', card: 'end', params: { product: BRAND.product, tagline: BRAND.tagline, repo: BRAND.repo, line: BRAND.endLine } } },
  ];
  const narration = Object.fromEntries(cut.filter((s) => s.text).map((s) => [s.id, s.text as string]));
  fs.writeFileSync(path.join(V2, 'narration.json'), `${JSON.stringify(narration, null, 2)}\n`);

  // ---- Voices, and each scene's caption cues relative to its voice.
  const sayVoice = bestSayVoice();
  const voices = new Map<string, Voice>();
  for (const s of cut) if (s.text) voices.set(s.id, prepareVoice(s.id, s.text, sayVoice));
  log(`voices ready (${[...voices.values()].filter((v) => v.draft).length} of ${voices.size} are say "${sayVoice}" drafts)`);
  /** Silence opened in a scene's narration at a sentence boundary, so a visual beat can land on its words. */
  const gaps = new Map<string, { at: number; dur: number }[]>();
  const shifted = (id: string, tv: number) => tv + (gaps.get(id) ?? []).filter((g) => g.at <= tv).reduce((a, g) => a + g.dur, 0);
  const cuesOf = (s: CutScene) => {
    const v = voices.get(s.id);
    if (!v || !s.text) return [];
    return timeCues(cueTexts(s.text), v.speech, v.pauses).map((c) => ({ ...c, from: shifted(s.id, c.from), to: shifted(s.id, c.to) }));
  };
  const capCache = new Map<string, Timeline>();
  const cap = (id: string): Timeline => {
    if (!capCache.has(id)) {
      const f = path.join(CAP, id, 'timeline.json');
      if (!fs.existsSync(f)) throw new Error(`capture ${id} is missing; run without --reuse-capture`);
      capCache.set(id, JSON.parse(fs.readFileSync(f, 'utf8')) as Timeline);
    }
    return capCache.get(id)!;
  };
  const markAt = (t: Timeline, name: string) => {
    const m = t.marks?.[name];
    if (!m) throw new Error(`capture ${t.id} has no mark "${name}"; recapture`);
    return m.at;
  };

  const browser = await chromium.launch();
  const built: Built[] = [];
  const tracks: Track[] = [];
  let stageDesktop = '';
  let stagePhone = '';
  try {
    const sp = await openCard(browser, 'stage', { mode: 'desktop', x: WIN.x, y: WIN.y, w: WIN.w, h: WIN.h, r: WIN.r });
    stageDesktop = path.join(REN, 'stage-desktop.png');
    await shoot(sp, stageDesktop, true);
    await sp.close();
    const pp = await openCard(browser, 'stage', { mode: 'phone', x: PHONE.x, y: PHONE.y, w: PHONE.w, h: PHONE.h, r: PHONE.r, bezel: PHONE.bezel });
    stagePhone = path.join(REN, 'stage-phone.png');
    await shoot(pp, stagePhone, true);
    await pp.close();

    const composite = (b: Built, seq: string[], mobile: boolean) => {
      const geo = mobile ? PHONE : WIN;
      const stage = mobile ? stagePhone : stageDesktop;
      b.geo = geo;
      b.input = [seq, ['-framerate', String(FPS), '-i', stage]];
      b.filter = (label, [i, st]) =>
        `[${i}:v]crop=w='min(iw,${geo.w})':h='min(ih,${geo.h})':x=0:y=0,pad=${geo.w}:${geo.h}:0:0:white,setsar=1,pad=${FRAME.w}:${FRAME.h}:${geo.x}:${geo.y}:black,` +
        `tpad=stop_mode=clone:stop_duration=1,trim=duration=${b.seconds.toFixed(4)},setpts=PTS-STARTPTS[${label}c];` +
        `[${st}:v]loop=loop=${Math.ceil((b.seconds + 1) * FPS)}:size=1:start=0[${label}st];` +
        `[${label}c][${label}st]overlay=0:0:shortest=1:format=rgb,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[${label}]`;
    };

    // ---- Scene by scene: length from the voice, source, retime.
    for (const s of cut) {
      const v = voices.get(s.id) ?? null;
      const p = pace(s.id);
      const want = Math.max(MIN_SECONDS[s.id] ?? 4, v ? p.lead + v.seconds + p.tail + XFADE : 0);
      const b: Built = { scene: s, start: 0, seconds: want, voice: v, asset: '', fallback: false, input: [], filter: () => '' };
      const src = s.src;
      if (src.kind === 'ai') {
        const file = firstExisting(path.join(V2, 'ai', s.id), ['mp4', 'mov']);
        if (file) {
          const full = mediaSeconds(file);
          if (s.id === 'B1') b.seconds = clamp(full, B1_SECONDS.min, B1_SECONDS.max);
          const L = b.seconds;
          // Start at the preferred in-point, earlier only if the slot needs more of the clip. Never sped up.
          const inPt = clamp(Math.min(AI_IN[s.id] ?? 0, full - L), 0, Math.max(0, full - 0.5));
          const len = full - inPt;
          b.asset = `${rel(file)}${inPt ? ` from ${inPt.toFixed(2)} s` : ''}`;
          // A clip shorter than its slot is slowed at most 1.3x, then holds its last frame. Voices are never sped up.
          const slow = len > 0 && L > len ? Math.min(1.3, L / len) : 1;
          b.input = [[...(inPt ? ['-ss', inPt.toFixed(3)] : []), '-i', file]];
          b.filter = (label, [i]) =>
            `[${i}:v]scale=${FRAME.w}:${FRAME.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${FRAME.w}:${FRAME.h},setsar=1,setpts=${slow.toFixed(4)}*PTS,fps=${FPS},` +
            `tpad=stop_mode=clone:stop_duration=${Math.max(0, L - len * slow + 1).toFixed(2)},trim=duration=${L.toFixed(4)},setpts=PTS-STARTPTS,` +
            `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[${label}]`;
        } else {
          b.fallback = true;
          b.asset = 'placeholder card';
          const png = path.join(REN, `placeholder-${s.id}.png`);
          const pg = await openCard(browser, 'placeholder', { id: s.id, desc: AI_SHOTS[s.id] ?? '', file: `demo/v2/ai/${s.id}.mp4` });
          await shoot(pg, png, false);
          await pg.close();
          b.input = [['-loop', '1', '-framerate', String(FPS), '-t', want.toFixed(4), '-i', png]];
          b.filter = (label, [i]) => `[${i}:v]setsar=1,trim=duration=${want.toFixed(4)},setpts=PTS-STARTPTS,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[${label}]`;
        }
      } else if (src.kind === 'card') {
        const { dir, t } = await cardTimeline(browser, src.card, src.params);
        const r = retime(t, want);
        b.seconds = r.seconds;
        b.asset = rel(path.join(CARDS, `${src.card}.html`));
        b.input = [writeSequence(dir, r.frames, r.seconds, s.id)];
        b.filter = (label, [i]) => `[${i}:v]setsar=1,tpad=stop_mode=clone:stop_duration=1,trim=duration=${b.seconds.toFixed(4)},setpts=PTS-STARTPTS,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[${label}]`;
      } else {
        let t: Timeline;
        let capDir: string;
        if (src.kind === 'cap') {
          const full = cap(src.cap);
          capDir = path.join(CAP, src.cap);
          const from = src.from ? markAt(full, src.from) : 0;
          const to = src.to ? markAt(full, src.to) : full.frames.length;
          t = src.from || src.to ? sliceTimeline(full, from, to, src.tail ?? 0.4) : full;
          b.asset = `capture ${rel(capDir)} frames ${from}-${to}`;
        } else if (src.kind === 'still') {
          const full = cap(src.cap);
          capDir = path.join(CAP, src.cap);
          t = { ...full, frames: [{ ...full.frames[src.frame], dur: 1, kind: 'hold' }], marks: {}, lapse: undefined };
          b.asset = `capture ${rel(capDir)} frame ${src.frame} (held)`;
        } else {
          // Montage: one held frame per pick, each already at the exact size.
          capDir = REN;
          const frames: Frame[] = src.picks.map((pk) => {
            const full = cap(pk.cap);
            const f = full.frames[markAt(full, pk.mark)];
            const dir = path.join(CAP, pk.cap);
            const fixed = normalizeFrames(dir, [f], WIN.w, WIN.h, `${pk.cap}-${s.id}`);
            return { file: fixed.get(f.file) ?? path.join(dir, f.file), dur: 1, kind: 'hold' as const };
          });
          t = { id: s.id, kind: 'desktop', size: { w: WIN.w, h: WIN.h }, frames, marks: Object.fromEntries(frames.slice(1).map((_, i) => [`b${i + 1}`, { at: i + 1 }])) };
          b.asset = `montage of ${src.picks.map((pk) => `${pk.cap}.${pk.mark}`).join(', ')}`;
        }
        const keys = Object.entries(t.marks ?? {})
          .filter(([n]) => /^(zoomHold|strengthHold|evHold|checkHold|resultHold|mathHold|blocked|runDone|approveVisible)$/.test(n))
          .map(([, m]) => m.at);
        // Anchors: each capture beat pinned to the moment its phrase is spoken.
        // When a beat cannot land in time (a fast read), silence is opened in the
        // narration at the pause before that sentence, never mid-sentence and
        // never by speeding anything up, and the scene is fitted again.
        const plan = () => {
          const cues = cuesOf(s);
          const out: { at: number; time: number; mk: string; cueStart: number | null }[] = [];
          for (const [mk, phrase] of Object.entries(s.anchors ?? {})) {
            const m = t.marks?.[mk];
            let when: number | null = null;
            let cueStart: number | null = null;
            for (const c of cues) {
              const text = c.lines.join(' ');
              const i = text.indexOf(phrase);
              if (i >= 0) {
                when = c.from + ((c.to - c.from) * i) / text.length;
                cueStart = i === 0 ? c.from : null;
                break;
              }
            }
            if (m && when !== null) out.push({ at: m.at, time: p.lead + when - (mk === 'drawerGone' ? 0.35 : 0.2), mk, cueStart });
            else log(`warning: scene ${s.id} anchor ${mk} -> "${phrase}" not applied (${m ? 'phrase' : 'mark'} missing)`);
          }
          return out.sort((a2, b2) => a2.at - b2.at);
        };
        let wantS = want;
        let anchors = plan();
        let r = retime(t, wantS, anchors, keys);
        for (let pass = 0; pass < 6 && v; pass++) {
          const k = r.anchors.findIndex((a2, i) => a2.landed > a2.wanted + 0.08 && anchors[i]?.cueStart !== null);
          if (k < 0) break;
          const late = +(r.anchors[k].landed - r.anchors[k].wanted).toFixed(3);
          // Gap in original voice time, inside the pause before the sentence.
          const cueStartShifted = anchors[k].cueStart!;
          const before = (gaps.get(s.id) ?? []).filter((g) => g.at <= cueStartShifted).reduce((a2, g) => a2 + g.dur, 0);
          const gapAt = Math.max(0, cueStartShifted - before - 0.04);
          gaps.set(s.id, [...(gaps.get(s.id) ?? []), { at: gapAt, dur: late }]);
          wantS += late;
          anchors = plan();
          r = retime(t, wantS, anchors, keys);
        }
        if (gaps.get(s.id)?.length) {
          // Rebuild this scene's voice with the gaps opened.
          const g = [...gaps.get(s.id)!].sort((a2, b2) => a2.at - b2.at);
          const out = path.join(REN, `voice-${s.id}-gapped.wav`);
          const parts: string[] = [];
          let prev = 0;
          g.forEach((x, i) => {
            parts.push(`[0:a]atrim=${prev.toFixed(3)}:${x.at.toFixed(3)},asetpts=PTS-STARTPTS[p${i}]`, `aevalsrc=0|0:s=48000:d=${x.dur.toFixed(3)}[z${i}]`);
            prev = x.at;
          });
          parts.push(`[0:a]atrim=${prev.toFixed(3)},asetpts=PTS-STARTPTS[pl]`);
          const order = g.map((_, i) => `[p${i}][z${i}]`).join('') + '[pl]';
          run('ffmpeg', ['-hide_banner', '-y', '-i', v!.file, '-filter_complex', `${parts.join(';')};${order}concat=n=${g.length * 2 + 1}:v=0:a=1[o]`, '-map', '[o]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out]);
          b.voice = { ...v!, file: out, seconds: wavSeconds(out) };
          log(`scene ${s.id}: opened ${g.map((x) => `${x.dur.toFixed(2)} s at ${x.at.toFixed(2)} s`).join(', ')} in the narration so its beats land on their words`);
        }
        b.timeline = t;
        b.retimed = r;
        b.seconds = r.seconds;
        const mobile = t.kind === 'mobile';
        const geo = mobile ? PHONE : WIN;
        const fixed = src.kind === 'montage' ? new Map<string, string>() : normalizeFrames(capDir, r.frames, geo.w, geo.h, s.id);
        composite(b, writeSequence(capDir, r.frames, r.seconds, s.id, fixed), mobile);
      }
      built.push(b);
    }
    let at = 0;
    for (const b of built) {
      b.start = at;
      at += b.seconds - XFADE;
    }
    const total = at + XFADE;
    log(`cut: ${built.map((b) => `${b.scene.id} ${b.seconds.toFixed(1)}s`).join(' · ')} = ${total.toFixed(1)} s`);

    // ---- Budget: never speed a voice up; say what to trim instead.
    const voiced = built.filter((b) => b.voice).sort((a, b) => b.voice!.seconds - a.voice!.seconds);
    const budget = {
      limit_s: MAX_TOTAL,
      total_s: +total.toFixed(2),
      over_by_s: +Math.max(0, total - MAX_TOTAL).toFixed(2),
      trim_first: total > MAX_TOTAL
        ? [
            ...['REJ', 'I', 'R', 'W'].filter((id) => built.some((b) => b.scene.id === id)).map((id) => `optional scene ${id} (${built.find((b) => b.scene.id === id)!.seconds.toFixed(1)} s)`),
            ...voiced.slice(0, 4).map((b) => `shorten the ${b.scene.id} line (${b.voice!.seconds.toFixed(1)} s spoken)`),
          ]
        : [],
    };
    if (total > MAX_TOTAL) log(`over budget: ${total.toFixed(1)} s > ${MAX_TOTAL} s; trim: ${budget.trim_first.join('; ')}`);
    if (total >= 180) {
      fs.writeFileSync(path.join(OUT, 'demo-v2.json'), `${JSON.stringify({ error: 'over 3:00, not rendered', budget }, null, 2)}\n`);
      throw new Error(`the cut is ${total.toFixed(1)} s, over the 3:00 limit; see demo/out/demo-v2.json for what to trim`);
    }

    // Time of frame `idx` of a capture-based scene, in the final cut.
    const timeOf = (b: Built, idx: number) => b.start + (b.retimed?.frames.slice(0, idx).reduce((s2, f) => s2 + f.dur, 0) ?? 0);
    const sceneOf = (id: string) => built.find((b) => b.scene.id === id);
    const markOf = (b: Built, name: string) => b.timeline?.marks?.[name];

    // ---- Overlays: rendered by Chromium, transparent, timed from capture marks.
    const ov = await openCard(browser, 'overlay', {});
    const ovDir = path.join(REN, 'overlays');
    fs.mkdirSync(ovDir, { recursive: true });
    const pngs = new Map<string, Layer>();
    const even = (v: number) => Math.max(0, Math.floor(v / 2) * 2);
    // Each overlay is cropped to its own box (plus room for its shadow), or to a
    // fixed band for sequences whose frames must all be the same size.
    const overlay = async (kind: string, data: Record<string, unknown>, band?: Rect): Promise<Layer> => {
      const key = sha(JSON.stringify([kind, data, band ?? null]));
      if (pngs.has(key)) return pngs.get(key)!;
      const png = path.join(ovDir, `${kind}-${key}.png`);
      const box = (await ov.evaluate(
        `(() => { window.show(${JSON.stringify(kind)}, ${JSON.stringify(data)}); const n = [...document.querySelectorAll('.slot')].find((x) => x.style.display !== 'none'); if (!n) return null; const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`,
      )) as [number, number, number, number] | null;
      let clip = band ?? { x: 0, y: 0, w: 2, h: 2 };
      if (!band && box) {
        const m = 48;
        const x = even(box[0] - m);
        const y = even(box[1] - m);
        clip = { x, y, w: even(Math.min(FRAME.w, box[0] + box[2] + m) - x + 1), h: even(Math.min(FRAME.h, box[1] + box[3] + m) - y + 1) };
      }
      await ov.screenshot({ path: png, omitBackground: true, type: 'png', clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h } });
      const layer = { png, x: clip.x, y: clip.y };
      pngs.set(key, layer);
      return layer;
    };
    const infoY = WIN.y + WIN.h + 8;

    // Disclosure: every stretch of real-app footage (short card gaps bridged).
    const ranges: [number, number][] = [];
    for (const b of built.filter((x) => x.scene.product)) {
      const last = ranges[ranges.length - 1];
      if (last && b.start - last[1] < 2.6) last[1] = b.start + b.seconds;
      else ranges.push([b.start, b.start + b.seconds]);
    }
    const discPng = await overlay('info', { side: 'left', x: WIN.x, y: infoY, tone: 'amber', label: 'In this recording', text: BRAND.disclosure.replace(/^In this recording:\s*/, '') });
    for (const [a, z] of ranges) tracks.push({ ...discPng, from: a, to: z, fade: XFADE, what: 'disclosure' });

    // D: the sped-up trace, with its measured factor.
    const badges: string[] = [];
    for (const id of ['D']) {
      const b = sceneOf(id);
      if (b?.retimed?.speed && b.retimed.lapseOut) {
        const sp2 = b.retimed.speed;
        const label = sp2 >= 10 ? `${Math.round(sp2)}x` : `${(Math.round(sp2 * 2) / 2).toFixed(1).replace(/\.0$/, '')}x`;
        const text = `Sped up ${label} · real run ${facts.run.real_run_seconds} s`;
        badges.push(`${id}: ${text}`);
        tracks.push({ ...(await overlay('info', { side: 'right', x: WIN.x + WIN.w, y: infoY, tone: 'teal', icon: 'ff', text })), from: b.start + b.retimed.lapseOut[0], to: b.start + b.retimed.lapseOut[1], fade: 0.25, what: `${id} speed badge` });
      }
    }

    // O1-O2: a stopwatch of real elapsed time, read from each frame's capture clock.
    const o1 = sceneOf('O1');
    const o2 = sceneOf('O2');
    const dCap = cap('D');
    const clickW = dCap.frames[Math.min(dCap.frames.length - 1, markAt(dCap, 'click') + 4)]?.w;
    let stopwatch: { seq: string[]; from: number; y: number } | null = null;
    const infoBand = { x: 0, y: infoY - 8, w: FRAME.w, h: 56 };
    if (o1 && o2 && o1.retimed && o2.retimed && clickW) {
      const o2speed = o2.retimed.speed ? Math.round(o2.retimed.speed) : null;
      const frameAt = (b: Built, local: number) => {
        let acc = 0;
        for (const f of b.retimed!.frames) {
          acc += f.dur;
          if (local < acc) return f;
        }
        return b.retimed!.frames[b.retimed!.frames.length - 1];
      };
      const n = Math.round((o2.start + o2.seconds - o1.start) * FPS);
      const dir = path.join(REN, 'seq', 'stopwatch');
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < n; i++) {
        const tt = o1.start + (i + 0.5) / FPS;
        const b = tt >= o2.start ? o2 : o1;
        const f = frameAt(b, tt - b.start);
        const secs = Math.floor(clamp(((f.w ?? clickW) - clickW) / 1000, 0, facts.run.real_run_seconds));
        const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        const layer = await overlay('info', { side: 'right', x: WIN.x + WIN.w, y: infoY, tone: 'teal', icon: 'clock', text, sub: b === o2 && o2speed ? `real time · sped up ${o2speed}x` : 'real time' }, infoBand);
        fs.symlinkSync(layer.png, path.join(dir, `${String(i).padStart(6, '0')}.png`));
      }
      stopwatch = { seq: ['-framerate', String(FPS), '-start_number', '0', '-i', path.join(dir, '%06d.png')], from: o1.start, y: infoBand.y };
      const done = markOf(o2, 'runDone');
      if (done) {
        tracks.push({
          ...(await overlay('big', { x: WIN.x + WIN.w / 2, y: WIN.y + WIN.h / 2, text: `Draft ready in ${facts.run.real_run_seconds} s`, sub: "measured by the app, from the dispute's arrival" })),
          from: timeOf(o2, done.at),
          to: o2.start + o2.seconds - 0.1,
          fade: 0.25,
          what: 'O2 elapsed time',
        });
      }
    }

    // The concede line's cost-of-goods term, read from its formula ("$88.00 + $0.00 − $33.00 × 0.5").
    const cogsOf = (p: EvPage) => p.options.find((x) => /^accept/i.test(x.action))?.formula.match(/[−-]\s*(\$[\d,]+\.\d{2})\s*×\s*0\.5/)?.[1] ?? null;

    // E: the score, then the dollars, as the page shows them; covers the left column.
    const e = sceneOf('E');
    const evp = facts.ev_page;
    if (e && evp) {
      const sm = markOf(e, 'strengthHold');
      const em = markOf(e, 'evMove');
      const eh = markOf(e, 'evHold');
      const area = (r?: Rect) => (r ? { x: WIN.x + 28, y: WIN.y + r.y, w: r.x - 56, h: r.h } : null);
      if (sm && em && sm.rect && area(sm.rect)!.w > 380) {
        tracks.push({ ...(await overlay('callout', { ...area(sm.rect), big: `${evp.score} / 100`, lines: ['evidence strength', 'scored against a published rubric for this reason code'] })), from: timeOf(e, sm.at), to: timeOf(e, em.at), fade: 0.25, what: 'E score callout' });
      }
      const fight = evp.options.find((o) => /^fight/i.test(o.action));
      const concede = evp.options.find((o) => /^accept/i.test(o.action));
      if (eh && eh.rect && fight && concede && area(eh.rect)!.w > 380) {
        tracks.push({
          ...(await overlay('callout', {
            ...area(eh.rect),
            kicker: 'Expected cost',
            rows: [{ label: 'to fight', value: fight.amount, hot: fight.recommended }, { label: 'to concede', value: concede.amount, hot: concede.recommended }],
            foot: cogsOf(evp) ? `${cogsOf(evp)} in the concede line is the item's cost of goods; half is recovered when it is returned.` : '',
          })),
          from: timeOf(e, eh.at),
          to: timeOf(e, eh.at + 1),
          fade: 0.25,
          what: 'E dollar callout',
        });
      }
    }

    // G: the green card is a mock response; say so on it.
    const g = sceneOf('G');
    const gr = g ? markOf(g, 'resultHold') : undefined;
    if (g && gr?.rect) {
      tracks.push({ ...(await overlay('amber', { x: WIN.x + gr.rect.x + gr.rect.w / 2, y: WIN.y + gr.rect.y + gr.rect.h - 4, text: BRAND.mockSubmit })), from: timeOf(g, gr.at), to: timeOf(g, gr.at + 1), fade: 0.2, what: 'G mock lower third' });
    }

    // W: the weak case's numbers and recommendation, as the page shows them.
    const w = sceneOf('W');
    const wp = facts.weak_page;
    const wm = w ? markOf(w, 'mathHold') : undefined;
    const ws = w ? markOf(w, 'strengthHold') : undefined;
    const wsm = w ? markOf(w, 'mathMove') : undefined;
    if (w && wp && ws?.rect && wsm && ws.rect.x - 56 > 380) {
      tracks.push({ ...(await overlay('callout', { x: WIN.x + 28, y: WIN.y + ws.rect.y, w: ws.rect.x - 56, h: ws.rect.h, big: `${wp.score} / 100`, lines: ['evidence strength', 'scored against the same published rubric'] })), from: timeOf(w, ws.at), to: timeOf(w, wsm.at), fade: 0.25, what: 'W score callout' });
    }
    if (w && wp && wm?.rect) {
      const recd = wp.options.find((o) => o.recommended);
      const verdict = recd && /offer/i.test(recd.action) ? 'offer a partial refund' : 'accept and refund';
      tracks.push({
        ...(await overlay('callout', {
          x: WIN.x + 28,
          y: WIN.y + Math.max(20, wm.rect.y - 40),
          w: wm.rect.x - 56,
          h: Math.min(WIN.h - 40, wm.rect.h + 80),
          kicker: `Weak evidence · ${wp.score} / 100`,
          rows: wp.options.map((o) => ({ label: o.action, value: o.amount, hot: o.recommended })),
          foot: `The agent recommends: ${verdict}.`,
        })),
        from: timeOf(w, wm.at),
        to: w.start + w.seconds - 0.05,
        fade: 0.25,
        what: 'W weak-case callout',
      });
    }

    // R: three beats, words added one at a time.
    const r = sceneOf('R');
    if (r?.retimed) {
      for (let i = 0; i < 3; i++) {
        tracks.push({
          ...(await overlay('words', { x: WIN.x + WIN.w / 2, y: WIN.y + WIN.h - 96, words: BRAND.recap.slice(0, i + 1) })),
          from: timeOf(r, i) + (i === 0 ? 0.2 : 0),
          to: i === 2 ? r.start + r.seconds - 0.1 : timeOf(r, i + 1),
          fade: 0.15,
          what: `R recap ${i + 1}`,
        });
      }
    }

    // ---- Captions: SRT plus one transparent PNG per cue (44 px).
    const cues: Cue[] = [];
    for (const b of built) {
      if (!b.voice || !b.scene.text) continue;
      const at0 = b.start + pace(b.scene.id).lead;
      for (const c of cuesOf(b.scene)) cues.push({ from: at0 + c.from, to: at0 + c.to, lines: c.lines });
    }
    fs.writeFileSync(path.join(OUT, 'demo-v2.srt'), cues.map((q, i) => `${i + 1}\n${srtTime(q.from)} --> ${srtTime(q.to)}\n${q.lines.join('\n')}\n`).join('\n'));
    const capBand = { x: 0, y: FRAME.h - 150, w: FRAME.w, h: 150 };
    const blank = (await overlay('none', {}, capBand)).png;
    const capList = ['ffconcat version 1.0'];
    let clock = 0;
    // Gaps under 0.2 s fold into the cue before: this list goes through the concat demuxer, whose image time base is 1/25.
    for (const [i, q] of cues.entries()) {
      const png = (await overlay('caption', { lines: q.lines }, capBand)).png;
      const next = cues[i + 1];
      const end = next && next.from - q.to < 0.2 ? next.from : q.to;
      if (q.from - clock >= 0.2) capList.push(`file '${blank}'`, `duration ${(q.from - clock).toFixed(4)}`);
      const from = q.from - clock >= 0.2 ? q.from : clock;
      capList.push(`file '${png}'`, `duration ${Math.max(0.2, end - from).toFixed(4)}`);
      clock = from + Math.max(0.2, end - from);
    }
    capList.push(`file '${blank}'`, `duration ${Math.max(0.2, total - clock).toFixed(4)}`, `file '${blank}'`);
    const capFile = path.join(REN, 'captions.ffconcat');
    fs.writeFileSync(capFile, `${capList.join('\n')}\n`);
    await ov.close();

    // ---- Audio: voice track, AI-shot room tone, ducked music, two-pass loudnorm.
    const music = firstExisting(path.join(V2, 'music', 'bed'), ['mp3', 'wav']);
    const aIn: string[] = [];
    const aGraph: string[] = [];
    const voiceLabels: string[] = [];
    const ambLabels: string[] = [];
    let ai = 0;
    for (const b of built) {
      if (b.voice) {
        aIn.push('-i', b.voice.file);
        const ms = Math.round((b.start + pace(b.scene.id).lead) * 1000);
        aGraph.push(`[${ai}:a]adelay=${ms}|${ms}[v${ai}]`);
        voiceLabels.push(`[v${ai}]`);
        ai++;
      }
      const aiFile = b.scene.src.kind === 'ai' && !b.fallback ? firstExisting(path.join(V2, 'ai', b.scene.id), ['mp4', 'mov']) : null;
      if (aiFile && hasAudio(aiFile)) {
        aIn.push(...(AI_IN[b.scene.id] ? ['-ss', String(AI_IN[b.scene.id])] : []), '-i', aiFile);
        const ms = Math.round(b.start * 1000);
        aGraph.push(`[${ai}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${b.seconds.toFixed(3)},afade=t=in:d=0.3,afade=t=out:st=${(b.seconds - 0.5).toFixed(3)}:d=0.5,volume=0.28,adelay=${ms}|${ms}[m${ai}]`);
        ambLabels.push(`[m${ai}]`);
        ai++;
      }
    }
    aGraph.push(`${voiceLabels.join('')}amix=inputs=${voiceLabels.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[voice]`);
    let mixInputs = '[voice]';
    let mixCount = 1;
    if (music) {
      // ffmpeg 7.1 asserts on a graph with a dangling sink, so only split when the bed needs the sidechain.
      aGraph.push('[voice]asplit=2[voiceA][voiceSC]');
      mixInputs = '[voiceA]';
      aIn.push('-stream_loop', '-1', '-i', music);
      aGraph.push(`[${ai}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(3)},afade=t=in:d=1.5,afade=t=out:st=${(total - 2.5).toFixed(3)}:d=2.5,volume=0.5[bed]`);
      aGraph.push('[bed][voiceSC]sidechaincompress=threshold=0.025:ratio=9:attack=25:release=420:makeup=1[duck]');
      mixInputs += '[duck]';
      mixCount++;
      ai++;
    }
    if (ambLabels.length) {
      aGraph.push(`${ambLabels.join('')}amix=inputs=${ambLabels.length}:normalize=0,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[amb]`);
      mixInputs += '[amb]';
      mixCount++;
    }
    aGraph.push(`${mixInputs}amix=inputs=${mixCount}:normalize=0:dropout_transition=0,afade=t=out:st=${(total - 1.0).toFixed(3)}:d=1.0[mix]`);
    const preMix = path.join(REN, 'audio-premix.wav');
    fs.writeFileSync(path.join(REN, 'audio.graph'), aGraph.join(';\n'));
    await ffmpeg([...aIn, '-filter_complex_script', path.join(REN, 'audio.graph'), '-map', '[mix]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', preMix], 'audio mix');
    const p1 = run('ffmpeg', ['-hide_banner', '-i', preMix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
    const m = JSON.parse(p1.slice(p1.lastIndexOf('{'), p1.lastIndexOf('}') + 1)) as Record<string, string>;
    const finalAudio = path.join(REN, 'audio-final.wav');
    run('ffmpeg', ['-hide_banner', '-y', '-i', preMix, '-af',
      `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary,aresample=48000`,
      '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', finalAudio]);


    // ---- Video: every scene, crossfades, overlays, fades; one encode.
    const vIn: string[] = [];
    const graph: string[] = [];
    let idx = 0;
    built.forEach((b, k) => {
      const ids: number[] = [];
      for (const args of b.input) {
        vIn.push(...args);
        ids.push(idx++);
      }
      graph.push(b.filter(`r${k}`, ids));
      // xfade needs a declared constant rate and one time base on every input.
      graph.push(`[r${k}]fps=${FPS},settb=1/${FPS}[s${k}]`);
    });
    let prev = 's0';
    for (let k = 1; k < built.length; k++) {
      const out = k === built.length - 1 ? 'xf' : `x${k}`;
      graph.push(`[${prev}][s${k}]xfade=transition=fade:duration=${XFADE}:offset=${built[k].start.toFixed(4)}[${out}]`);
      prev = out;
    }
    const yuva = 'scale=out_color_matrix=bt709:out_range=tv,format=yuva420p';
    let cur = 'xf';
    let o = 0;
    const lay = (label: string, x = 0, y = 0) => {
      const next = `o${o++}`;
      graph.push(`[${cur}][${label}]overlay=${x}:${y}:eof_action=pass[${next}]`);
      cur = next;
    };
    // Each overlay image is decoded once and repeated in memory, then faded.
    for (const [k, tr] of tracks.entries()) {
      const dur = Math.max(0.1, tr.to - tr.from);
      const i = idx++;
      vIn.push('-framerate', String(FPS), '-i', tr.png);
      graph.push(`[${i}:v]format=rgba,${yuva},loop=loop=${Math.ceil(dur * FPS)}:size=1:start=0,fade=t=in:st=0:d=${tr.fade}:alpha=1,fade=t=out:st=${Math.max(0, dur - tr.fade).toFixed(3)}:d=${tr.fade}:alpha=1,setpts=PTS+${tr.from.toFixed(3)}/TB[t${k}]`);
      lay(`t${k}`, tr.x, tr.y);
    }
    if (stopwatch) {
      const i = idx++;
      vIn.push(...stopwatch.seq);
      graph.push(`[${i}:v]format=rgba,${yuva},setpts=PTS+${stopwatch.from.toFixed(3)}/TB[sw]`);
      lay('sw', 0, stopwatch.y);
    }
    const capIdx = idx++;
    vIn.push('-f', 'concat', '-safe', '0', '-i', capFile);
    graph.push(`[${capIdx}:v]format=rgba,${yuva},fps=${FPS}[cap]`);
    lay('cap', 0, FRAME.h - 150);
    graph.push(`[${cur}]fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.9).toFixed(3)}:d=0.9,trim=duration=${total.toFixed(4)},format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout]`);
    const audioIdx = idx++;
    vIn.push('-i', finalAudio);
    const graphFile = path.join(REN, 'video.graph');
    fs.writeFileSync(graphFile, graph.join(';\n'));
    const final = path.join(OUT, 'demo-v2.mp4');
    log(`encoding ${total.toFixed(1)} s (x264 ${X264_PRESET}, CRF ${X264_CRF}) …`);
    const encodeArgs = [
      ...vIn,
      '-filter_complex_script', graphFile,
      '-map', '[vout]', '-map', `${audioIdx}:a`,
      '-c:v', 'libx264', '-preset', X264_PRESET, '-crf', X264_CRF, '-x264-params', 'deblock=-1,-1',
      '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 2),
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-t', total.toFixed(4), final,
    ];
    // Kept for debugging and for re-running the encode by hand.
    fs.writeFileSync(path.join(REN, 'video.args.json'), JSON.stringify(encodeArgs, null, 1));
    await ffmpeg(encodeArgs, 'video');

    // ---- Verify what was written, and say exactly what is in it.
    const head = spawnSync('ffmpeg', ['-hide_banner', '-i', final], { encoding: 'utf8' }).stderr;
    const dims = head.match(/Video: h264.*?, (\d+)x(\d+)/);
    const seconds = mediaSeconds(final);
    const lufs = run('ffmpeg', ['-hide_banner', '-i', final, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    const integ = [...lufs.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1];
    const peak = [...lufs.matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].at(-1)?.[1];
    const fallbacks = [
      ...built.filter((b) => b.scene.src.kind === 'ai' && b.fallback).map((b) => `AI shot ${b.scene.id}: placeholder card`),
      ...(built.some((b) => b.voice?.draft) ? [`voice: macOS say "${sayVoice}" for ${built.filter((b) => b.voice?.draft).map((b) => b.scene.id).join(', ')}`] : []),
      ...(music ? [] : ['music: none (no demo/v2/music/bed.mp3|wav)']),
    ];
    const manifest = {
      file: rel(final),
      seconds: +seconds.toFixed(2),
      under_3_minutes: seconds < 180,
      under_2_50: seconds < MAX_TOTAL,
      budget,
      width: dims ? +dims[1] : null,
      height: dims ? +dims[2] : null,
      fps: FPS,
      video: `H.264 (libx264 ${X264_PRESET}, CRF ${X264_CRF}), yuv420p, bt709`,
      audio: 'AAC 192 kb/s, 48 kHz stereo',
      loudness: { target_lufs: -14, integrated_lufs: integ ? +integ : null, true_peak_dbfs: peak ? +peak : null },
      voice_draft: built.some((b) => b.voice?.draft),
      fallbacks,
      music: music ? rel(music) : null,
      agent: {
        dispute_id: facts.dispute.id,
        run_id: facts.run.id,
        real_run_seconds: facts.run.real_run_seconds,
        real_run_source: 'run.draft_ready_at - run.clock_started_at from the app API (the same clock as the on-screen "Draft ready" stopwatch)',
        stopwatch: 'O1-O2: each frame shows its own capture wall-clock time since the click, capped at real_run_seconds',
        badges,
        strength: facts.run.strength,
        recommendation: facts.run.recommendation,
        sources: facts.run.sources,
        ev_as_shown: facts.ev_page && { score: facts.ev_page.score, options: facts.ev_page.options },
      },
      weak_case: { included: built.some((b) => b.scene.id === 'W'), reason: facts.weak_case_reason, as_shown: facts.weak_page && { score: facts.weak_page.score, options: facts.weak_page.options } },
      checker_rejection: { included: built.some((b) => b.scene.id === 'REJ'), reason: facts.rejection_reason, as_shown: facts.rejection },
      narration_adjustments: [
        ...(fights ? [] : ['E: "Here, fighting is the cheaper bet, so it fights." cut: the run did not recommend FIGHT']),
        ...(sizeChart ? [] : ['H: "like an outdated size chart" cut: no size-chart pattern on screen']),
      ],
      overlays: tracks.map((tr) => ({ what: tr.what, from: +tr.from.toFixed(2), to: +tr.to.toFixed(2) })),
      disclosure: { text: BRAND.disclosure, on_screen: ranges.map(([a, z]) => [+a.toFixed(2), +z.toFixed(2)]) },
      scenes: built.map((b) => ({
        id: b.scene.id,
        start: +b.start.toFixed(2),
        seconds: +b.seconds.toFixed(2),
        narration: b.scene.text,
        narration_seconds: b.voice ? +b.voice.seconds.toFixed(2) : null,
        voice_source: b.voice?.source ?? null,
        asset: b.asset,
        fallback: b.fallback,
        anchors: b.retimed?.anchors.length ? b.retimed.anchors : undefined,
        narration_gaps: gaps.get(b.scene.id)?.map((g) => ({ at_s: +g.at.toFixed(2), seconds: +g.dur.toFixed(2) })),
        sped_up: b.retimed?.speed ? +b.retimed.speed.toFixed(2) : undefined,
      })),
      captions: { file: 'demo/out/demo-v2.srt', cues: cues.length, size_px: 44 },
      optional_slots: { B1: b1 ? rel(b1) : 'absent (skipped)' },
      capture: { captured_at: facts.captured_at, reused, dpr: facts.dpr, background_dispute: facts.background_dispute, submitted: facts.submitted_text, pattern: facts.pattern },
      rendered_at: new Date().toISOString(),
      render_seconds: Math.round((Date.now() - t0) / 1000),
    };
    fs.writeFileSync(path.join(OUT, 'demo-v2.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`done: ${rel(final)} ${manifest.width}x${manifest.height} ${seconds.toFixed(1)} s, ${integ} LUFS, render ${manifest.render_seconds} s`);
    if (fallbacks.length) log(`fallbacks: ${fallbacks.join('; ')}`);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Gate: the inbox recorded the v1 way and the v2 way, as stills.

async function gate() {
  fs.mkdirSync(OUT, { recursive: true });
  const dir = path.join(WORK, 'gate');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Both recordings: the inbox held still, then the v1 scroll (500 px over ~2.6 s).
  const HOLD = 2.5;
  const SCROLL_S = 2.64;
  const browser = await chromium.launch();
  try {
    // v1: Playwright recordVideo (VP8), 1280x720, then the v1 encode. Two short
    // recordings, each sampled near its end (recordVideo's start lag is unknown):
    // one held still, one that is still scrolling the way v1 scrolls when it stops.
    const still = (mp4: string, at: number, out: string) => run('ffmpeg', ['-hide_banner', '-y', '-ss', Math.max(0, at).toFixed(2), '-i', mp4, '-frames:v', '1', out]);
    for (const motion of [false, true]) {
      const vdir = path.join(dir, motion ? 'v1-motion' : 'v1-static');
      const c1 = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, recordVideo: { dir: vdir, size: VIEW } });
      const p1 = await c1.newPage();
      await nav(p1, `${BASE}/`);
      await p1.locator('.ag-center-cols-container .ag-row').first().waitFor({ timeout: WAIT_MS });
      await settle(p1, 2500);
      await sleep(HOLD * 1000);
      if (motion) {
        for (let i = 0; i < 12; i++) {
          await p1.mouse.wheel(0, 500 / 12);
          await sleep(220);
        }
      }
      const webm = await p1.video()!.path();
      await c1.close();
      const v1mp4 = path.join(vdir, 'v1.mp4');
      run('ffmpeg', ['-hide_banner', '-y', '-i', webm, '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xf1f5f9,fps=30',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', v1mp4]);
      still(v1mp4, mediaSeconds(v1mp4) - (motion ? 1.0 : 0.6), path.join(OUT, motion ? 'compare-v1-motion.png' : 'compare-v1.png'));
    }

    // v2: the real capture path, composited and encoded exactly as the final cut.
    // (deviceScaleFactor 1 and 2 give byte-identical frames: Chrome rasterises a
    // scaled clip at the clip's own scale, so DPR does not matter here.)
    const c2 = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR });
    await c2.addInitScript(INIT_SCRIPT);
    const p2 = await c2.newPage();
    const cdp = await c2.newCDPSession(p2);
    await nav(p2, `${BASE}/`);
    await p2.locator('.ag-center-cols-container .ag-row').first().waitFor({ timeout: WAIT_MS });
    await settle(p2, 2500);
    const rec = new Shooter(p2, cdp, VIEW, WIN.w / VIEW.width, 'desktop');
    // Shooter writes into CAP/<id>; point it at the gate folder instead.
    rec.begin('../gate/v2');
    await rec.hold(HOLD);
    await rec.tween(SCROLL_S, { scrollY: 500 });
    await rec.hold(0.8);
    // A zoom in and out, so the gate also proves zoom frames come out at the exact size.
    await rec.tween(1.2, { cam: { cx: 471.3, cy: 333.7, z: 1.83 } });
    await rec.tween(1.0, { cam: rec.full });
    rec.end();
    await c2.close();
    const sdir = path.join(dir, 'v2');
    const seq = writeSequence(sdir, rec.frames, rec.frames.reduce((a, f) => a + f.dur, 0), 'gate-v2');
    const stage = path.join(dir, 'stage.png');
    const sp = await openCard(browser, 'stage', { mode: 'desktop', x: WIN.x, y: WIN.y, w: WIN.w, h: WIN.h, r: WIN.r });
    await shoot(sp, stage, true);
    await sp.close();
    const mp4 = path.join(sdir, 'v2.mp4');
    run('ffmpeg', ['-hide_banner', '-y', ...seq, '-loop', '1', '-framerate', String(FPS), '-i', stage, '-filter_complex',
      `[0:v]setsar=1,pad=${FRAME.w}:${FRAME.h}:${WIN.x}:${WIN.y}:black[c];[c][1:v]overlay=0:0:shortest=1:format=rgb,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-preset', X264_PRESET, '-crf', X264_CRF, '-x264-params', 'deblock=-1,-1', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', mp4]);
    still(mp4, HOLD - 0.5, path.join(OUT, 'compare-v2.png'));
    still(mp4, HOLD + SCROLL_S / 2, path.join(OUT, 'compare-v2-motion.png'));

    // The same UI region from each, at the same on-screen size (v1 scaled 1.25x, as a player would).
    const s = WIN.w / VIEW.width;
    const label = (t: string) => `drawtext=text='${t}':x=12:y=10:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=8`;
    const pair = (v1png: string, v2png: string, region: Rect, out: string) => {
      const cw = Math.round(region.w * s);
      const ch = Math.round(region.h * s);
      run('ffmpeg', ['-hide_banner', '-y', '-i', v1png, '-i', v2png, '-filter_complex',
        `[0:v]crop=${region.w}:${region.h}:${region.x}:${region.y},scale=${cw}:${ch}:flags=bicubic,${label('v1  recordVideo VP8 720p, shown at 1.25x')}[a];` +
        `[1:v]crop=${cw}:${ch}:${Math.round(WIN.x + region.x * s)}:${Math.round(WIN.y + region.y * s)},${label('v2  CDP frame-stepped, 1080p')}[b];[a][b]vstack=inputs=2`,
        '-frames:v', '1', out]);
    };
    pair(path.join(OUT, 'compare-v1.png'), path.join(OUT, 'compare-v2.png'), { x: 32, y: 370, w: 760, h: 180 }, path.join(OUT, 'compare-crop.png'));
    // A small text patch at 3x, nearest neighbour: what the eye sees on a large screen.
    const z = { x: 96, y: 390, w: 240, h: 60 };
    run('ffmpeg', ['-hide_banner', '-y', '-i', path.join(OUT, 'compare-v1.png'), '-i', path.join(OUT, 'compare-v2.png'), '-filter_complex',
      `[0:v]crop=${z.w}:${z.h}:${z.x}:${z.y},scale=${Math.round(z.w * s)}:${Math.round(z.h * s)}:flags=bicubic,scale=iw*3:ih*3:flags=neighbor[a];` +
      `[1:v]crop=${Math.round(z.w * s)}:${Math.round(z.h * s)}:${Math.round(WIN.x + z.x * s)}:${Math.round(WIN.y + z.y * s)},scale=iw*3:ih*3:flags=neighbor[b];[a][b]vstack=inputs=2`,
      '-frames:v', '1', path.join(OUT, 'compare-zoom.png')]);
    pair(path.join(OUT, 'compare-v1-motion.png'), path.join(OUT, 'compare-v2-motion.png'), { x: 32, y: 200, w: 760, h: 240 }, path.join(OUT, 'compare-motion.png'));
    log(`gate stills: ${['compare-v1.png', 'compare-v2.png', 'compare-crop.png', 'compare-v1-motion.png', 'compare-v2-motion.png', 'compare-motion.png', 'compare-zoom.png'].map((f) => rel(path.join(OUT, f))).join(', ')}`);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--gate')) return gate();
  const reuse = args.has('--reuse-capture') || process.env.DEMO_REUSE_CAPTURE === '1';
  let facts: CaptureFacts;
  const factsFile = path.join(CAP, 'capture.json');
  if (reuse) {
    if (!fs.existsSync(factsFile)) throw new Error(`--reuse-capture: no capture at ${rel(factsFile)}; run once without it`);
    facts = JSON.parse(fs.readFileSync(factsFile, 'utf8')) as CaptureFacts;
    log(`reusing the capture from ${facts.captured_at}`);
  } else {
    facts = await captureAll();
  }
  await render(facts, reuse);
}

// Run only when executed directly, so tests can import the pure helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
