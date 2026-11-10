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

// ---------------------------------------------------------------------------
// Text: the single source for every word that appears or is spoken.

/** On-screen product copy. Change the repo line here when the repo goes public. */
export const BRAND = {
  product: 'Dispute Defender',
  subtitle: 'An AI agent that answers PayPal disputes, with every claim cited.',
  repo: 'github.com/ROROK20/dispute-defender',
  endLine: 'Built with Claude · PayPal Disputes, Orders v2 and Webhooks APIs (fixtures in this recording)',
  disclosureLabel: 'In this recording',
  disclosure: ['PayPal responses are sandbox-shaped fixtures', 'The agent is real Claude'],
};

/** Narration, word for word from STORYBOARD.md. E and H have honest fallbacks used only if the capture can't show the claim. */
export const NARRATION = {
  A1: "It's eleven at night. A buyer just opened a dispute, and the clock is already running.",
  A2: 'Small sellers lose disputes they could have won: a missed deadline, the wrong evidence, or a reply that ignores the reason code.',
  C: "This is Dispute Defender. Every open dispute, its deadline, and how strong the evidence is. In this recording, PayPal's responses are sandbox-shaped fixtures. The agent is real Claude, running live.",
  D: "A dispute comes in, and the agent goes to work. Claude pulls the dispute, the buyer's messages, the order and its capture, the tracking, and the store's own policies. Every result becomes a numbered source.",
  E: 'It scores the evidence against a rubric for this exact reason code, then does the math: is this worth fighting? Here, it is.',
  E_NOT_FIGHT: 'It scores the evidence against a rubric for this exact reason code, then does the math on fighting versus refunding.',
  F: "Every sentence cites its source. Click one, and you see the record it came from. A deterministic checker rejects any sentence whose numbers, dates or quotes aren't in those sources, so the agent can't invent facts.",
  G: 'Nothing is sent until the seller approves. One click submits the evidence and its PDF packet. Here it goes to the mock PayPal adapter.',
  W: 'When the evidence is weak, it says so, and shows the dollar math for refunding instead.',
  H: "And it helps prevent the next one. Patterns groups past disputes by product and reason, in the buyers' own words, so you can fix the cause, like an outdated size chart.",
  H_NO_SIZE_CHART: "And it helps prevent the next one. Patterns groups past disputes by product and reason, in the buyers' own words, so you can fix the cause.",
  I: 'Review and approve from your phone.',
  K: "Under the hood: Claude runs the agent with tools, a deterministic checker guards every citation, and an Opus pass may only reword. On the PayPal side it's wired to the Disputes, Orders and Webhooks APIs.",
  J1: "Dispute Defender won't invent facts, it shows you the math, and it helps stop the next dispute.",
  Z: 'The code is at the link below.',
} as const;

/** What each AI slot should show (from the storyboard), printed on its placeholder card. */
const AI_SHOTS: Record<string, string> = {
  A1: 'Late night. A seller at a cluttered home-studio desk, lit by a laptop, with parcels around. A phone buzzes.',
  A2: 'Close-up: hands sorting receipts and shipping labels, and a wall calendar with days crossed out.',
  J1: 'Morning. The same studio, now tidy. The seller calmly packs an order with a coffee.',
};

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
const WIN = { x: 160, y: 36, w: 1600, h: 900, r: 18 };
const PHONE_VIEW = { width: 390, height: 844 };
const PHONE = { x: 765, y: 50, w: 390, h: 844, r: 46, bezel: 13 };
const DPR = Number(process.env.DEMO_DPR ?? 1);
const JPEG_Q = 95;

/** Crossfade between scenes; voice starts after it and ends before the next one. */
export const XFADE = 0.4;
const LEAD = 0.5;
const TAIL = 0.45;
const MIN_SECONDS: Record<string, number> = { A1: 5.5, A2: 6, T: 4, B1: 3.5, C: 8, D: 10, E: 7, F: 11, G: 8, W: 8, H: 9, I: 6.5, K: 9, J1: 5.5, Z: 5.5 };
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
export interface Frame { file: string; dur: number; kind: FrameKind }
interface Rect { x: number; y: number; w: number; h: number }
interface Cam { cx: number; cy: number; z: number }
interface Pt { x: number; y: number }
export interface Timeline {
  id: string;
  kind: 'desktop' | 'mobile' | 'card';
  size: { w: number; h: number };
  frames: Frame[];
  /** Frame indices and wall-clock seconds of the sped-up window, if any. */
  lapse?: { from: number; to: number; real_s: number };
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
    log(`capture ${id} …`);
  }

  end() {
    const outW = Math.round(this.view.width * this.outScale);
    const outH = Math.round(this.view.height * this.outScale);
    const t: Timeline = { id: this.id, kind: this.kind, size: { w: outW, h: outH }, frames: this.frames, ...(this.lapse ? { lapse: this.lapse } : {}) };
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

  private push(file: string, dur: number, kind: FrameKind) {
    this.frames.push({ file, dur: +dur.toFixed(4), kind });
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
      if (prev) this.push(prev.file, (at - prev.at) / 1000, kind);
      prev = { file, at };
      if (at - lastCheck >= (o.checkEveryMs ?? 500)) {
        lastCheck = at;
        if (await done().catch(() => false)) break;
      }
      if (at - start > o.timeoutMs) throw new Error(`timed out after ${o.timeoutMs / 1000}s waiting for ${o.what}`);
      const spent = Date.now() - at;
      if (spent < 1000 / FPS) await sleep(1000 / FPS - spent);
    }
    this.push(prev.file, Math.max(1 / FPS, (Date.now() - prev.at) / 1000), kind);
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
  async focus(target: Rect, o: { seconds: number; pad?: number; zmax?: number; cursor?: Pt; top?: number; scroll?: boolean }) {
    const vh = this.view.height;
    const top = o.top ?? 72;
    const [sy, max] = (await this.page.evaluate('[window.scrollY, document.documentElement.scrollHeight - window.innerHeight]')) as [number, number];
    let delta = 0;
    if (o.scroll !== false && (target.y < top || target.y + target.h > vh - 12)) {
      const want = target.h > vh - top - 24 ? target.y - top : target.y - (top + (vh - top - target.h) / 2);
      delta = clamp(want, -sy, Math.max(0, max - sy));
    }
    const r = { ...target, y: target.y - delta };
    await this.tween(o.seconds, {
      cam: this.camFor(r, o.pad, o.zmax),
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
  } | null;
  steps: { kind: string; label: string }[];
  sources: unknown[];
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

async function preflight(): Promise<{ background: string | null; weak: CaptureFacts['weak_case']; weakReason: string }> {
  const pool = await api<{ available?: number }>('/api/demo/pool').catch(() => {
    throw new Error(`the app is not reachable at ${BASE}; start it as the header of this file says`);
  });
  log(`pool: ${pool.body.available ?? 0} staged dispute(s)`);

  // Scene H needs mined patterns; mining is the seller's Recompute button.
  const pats = await api<{ patterns?: unknown[] }>('/api/patterns');
  if (!pats.body.patterns?.length) {
    log('mining patterns (Recompute) …');
    const r = await api<{ patterns?: unknown[] }>('/api/patterns/recompute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    log(`patterns: HTTP ${r.status}, ${r.body.patterns?.length ?? 0}`);
  }

  // The inbox (scene C) should show a strength score, so one staged dispute is
  // analysed before recording. It is a real run, triggered the same way.
  const list = await api<{ disputes: { id: string; source: string }[] }>('/api/disputes');
  const staged = list.body.disputes.filter((d) => d.source !== 'fixture');
  const details = await Promise.all(staged.map((d) => runDetail(d.id)));
  let analysed = details.filter((d) => d.run?.status === 'draft_ready');
  if (!analysed.length && (pool.body.available ?? 0) >= 2) {
    log('analysing one staged dispute before recording, so the inbox has a score …');
    const t = await api<{ dispute_id?: string }>('/api/demo/trigger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (t.status !== 202 || !t.body.dispute_id) throw new Error(`demo trigger: HTTP ${t.status}`);
    let d = await waitRun(t.body.dispute_id, 15 * 60_000);
    if (d.run?.status === 'failed') {
      log('that run failed; retrying it once');
      await api(`/api/disputes/${encodeURIComponent(t.body.dispute_id)}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"force":true}' });
      d = await waitRun(t.body.dispute_id, 15 * 60_000);
    }
    analysed = d.run?.status === 'draft_ready' ? [d] : [];
  }
  const after = await api<{ available?: number }>('/api/demo/pool');
  if (!after.body.available) throw new Error('no staged dispute is left for the on-camera trigger; reset the demo DB (see the header of this file)');

  const weak = analysed.find((d) => d.run?.ev && d.run.ev.recommended !== 'FIGHT');
  const strong = analysed.map((d) => `${d.dispute.id} ${d.run?.strength?.score ?? '?'}/100 ${d.run?.ev?.recommended ?? '?'}`).join(', ');
  return {
    background: analysed[0]?.dispute.id ?? null,
    weak: weak ? { id: weak.dispute.id, recommendation: weak.run!.ev!.recommended, strength: weak.run!.strength?.score ?? null } : null,
    weakReason: weak
      ? `recorded from ${weak.dispute.id}`
      : `no analysed dispute recommends anything but FIGHT (${strong || 'none analysed'}); scene W and its sentence are cut (storyboard honesty rule 4)`,
  };
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

    // ---- C: the inbox. Reveal the deadline and strength columns, zoom on them.
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
    const toLeft = clamp(maxLeft + (recAtMax.x + recAtMax.w) - (gridBody.x + gridBody.w) + 16, 0, maxLeft);
    rec.begin('C');
    await rec.hold(1.6);
    await rec.tween(1.4, { el: { sel: hsel, prop: 'scrollLeft', to: toLeft }, cursor: { x: gridBody.x + gridBody.w * 0.55, y: gridBody.y + 150 } });
    await sleep(250);
    const dl = await rectOf(page.locator('.ag-header-cell[col-id="seller_response_due_at"]').first());
    const rc = await rectOf(page.locator('.ag-header-cell[col-id="recommendation"]').first());
    const row2 = await rectOf(page.locator('.ag-center-cols-container .ag-row[row-index="2"]').first());
    const colsRect = { x: dl.x - 10, y: dl.y - 4, w: rc.x + rc.w - dl.x + 20, h: row2.y + row2.h - dl.y + 8 };
    await rec.tween(1.1, { cam: rec.camFor(colsRect, 20, 1.9), cursor: { x: rc.x + rc.w * 0.5, y: row2.y + row2.h + 40 } });
    await rec.hold(3.2);
    await rec.tween(1.0, { cam: rec.full });
    await rec.hold(1.4);
    rec.end();

    // ---- D: trigger a staged dispute and follow the live trace, sped up.
    rec.begin('D');
    await rec.hold(0.5);
    const trig = page.getByRole('button', { name: /trigger demo dispute/i }).first();
    const tb = await rectOf(trig);
    await rec.tween(1.2, { cursor: center(tb), cam: { cx: tb.x + tb.w / 2 - 120, cy: tb.y + 120, z: 1.55 } });
    rec.lapseStart();
    await rec.click(center(tb));
    await rec.realUntil(
      async () => /\/disputes\//.test(page.url()) && (await page.getByRole('heading', { name: 'Agent trace' }).isVisible()),
      { kind: 'lapse', timeoutMs: 180_000, what: 'the dispute page' },
    );
    const url = new URL(page.url());
    const disputeId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    log(`on-camera dispute: ${disputeId}`);
    const trace = await rectOf(section(page, 'Agent trace'));
    const traceTarget = { x: trace.x, y: trace.y, w: trace.w, h: 470 };
    await rec.focus(traceTarget, { seconds: 1.1, pad: 22, zmax: 1.6, cursor: { x: trace.x + trace.w + 120, y: trace.y + 300 }, top: 76 });
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
    await rec.hold(1.4);
    await rec.tween(1.0, { cam: rec.full });
    await rec.hold(0.6);
    rec.end();

    // ---- E: score, then the expected-value decision.
    rec.begin('E');
    await rec.hold(0.4);
    const strength = await rectOf(section(page, 'Evidence strength'));
    await rec.focus(strength, { seconds: 1.2, pad: 22, zmax: 2.0, cursor: { x: strength.x + strength.w - 70, y: strength.y + 40 } });
    await rec.hold(2.4);
    const ev = await rectOf(section(page, 'Fight or concede'));
    const recOpt = await rectOf(section(page, 'Fight or concede').locator('li', { hasText: 'recommended' }).first());
    await rec.focus(ev, { seconds: 1.1, pad: 22, zmax: 2.0, cursor: { x: recOpt.x + recOpt.w - 40, y: recOpt.y + recOpt.h - 6 } });
    await rec.hold(2.8);
    await rec.tween(1.0, { cam: rec.full });
    await rec.hold(0.6);
    rec.end();

    // ---- F: the cited draft, one source opened, then the citation check in the trace.
    rec.begin('F');
    await rec.hold(0.4);
    const draftSec = section(page, 'Draft response');
    const draft = await rectOf(draftSec);
    await rec.focus({ ...draft, h: Math.min(draft.h, 430) }, { seconds: 1.3, pad: 18, zmax: 1.6, cursor: { x: draft.x + draft.w * 0.7, y: draft.y + 360 } });
    await rec.hold(0.8);
    const chips = draftSec.locator('button[title]').filter({ hasText: /^S\d+$/ });
    let chip = chips.first();
    const n = await chips.count();
    for (let i = 0; i < n; i++) {
      const title = (await chips.nth(i).getAttribute('title')) ?? '';
      if (/message|buyer/i.test(title)) { chip = chips.nth(i); break; }
    }
    const chipBox = await rectOf(chip);
    await rec.tween(0.9, { cursor: center(chipBox) });
    await rec.hold(0.3);
    await rec.click(center(chipBox));
    const dialog = page.getByRole('dialog');
    await rec.realUntil(async () => dialog.isVisible(), { timeoutMs: 20_000, what: 'the source drawer' });
    const panel = await rectOf(dialog.locator('xpath=./div').first());
    const panelContent = (await page.evaluate(`(() => { const p = document.querySelector('[role=dialog] > div'); return p ? Math.max(...[...p.children].map(c => c.getBoundingClientRect().bottom)) : 400; })()`)) as number;
    const closeBtn = await rectOf(dialog.getByRole('button', { name: /^close$/i }));
    await rec.focus({ x: panel.x, y: 0, w: panel.w, h: clamp(panelContent + 20, 240, 520) }, { seconds: 1.0, pad: 18, zmax: 1.8, scroll: false, cursor: { x: panel.x + panel.w - 120, y: clamp(panelContent + 50, 300, 640) } });
    await rec.hold(1.8);
    await rec.click(center(closeBtn));
    await rec.realUntil(async () => !(await dialog.isVisible()), { timeoutMs: 10_000, what: 'the drawer to close' });
    await page.evaluate(`{const o=document.querySelector('ol'); if (o) o.scrollTop = o.scrollHeight;}`);
    const check = page.locator('ol li', { hasText: 'Citation check' }).first();
    const checkBox = await rectOf(check);
    const prevBox = await rectOf(page.locator('ol li', { hasText: 'submit_analysis' }).first()).catch(() => checkBox);
    const nextBox = await rectOf(page.locator('ol li', { hasText: /Review applied|Draft ready:/ }).first()).catch(() => checkBox);
    await rec.focus(union(prevBox, checkBox, nextBox), { seconds: 1.3, pad: 22, zmax: 1.9, cursor: { x: checkBox.x + checkBox.w * 0.78, y: checkBox.y + checkBox.h + 26 } });
    await rec.hold(3.0);
    await rec.tween(1.0, { cam: rec.full });
    await rec.hold(0.5);
    rec.end();

    // ---- I: the same dispute at phone width, before it is approved.
    const mctx = await browser.newContext({ viewport: PHONE_VIEW, deviceScaleFactor: DPR, isMobile: true, hasTouch: true });
    await mctx.addInitScript(INIT_SCRIPT);
    const mpage = await mctx.newPage();
    const mcdp = await mctx.newCDPSession(mpage);
    const mrec = new Shooter(mpage, mcdp, PHONE_VIEW, 1, 'mobile');
    await nav(mpage, page.url());
    await mpage.getByRole('heading', { name: 'Draft response' }).waitFor({ timeout: WAIT_MS });
    await settle(mpage, 1500);
    mrec.begin('I');
    await mrec.hold(0.9);
    const mDraft = await rectOf(section(mpage, 'Draft response'));
    const mSy = (await mpage.evaluate('window.scrollY')) as number;
    await mrec.tween(1.7, { scrollY: mSy + mDraft.y - 70 });
    await mrec.hold(1.0);
    const mApprove = await rectOf(mpage.getByRole('button', { name: /approve & submit evidence/i }).first());
    const mSy2 = (await mpage.evaluate('window.scrollY')) as number;
    await mrec.tween(1.7, { scrollY: mSy2 + mApprove.y - PHONE_VIEW.height * 0.45 });
    await mrec.hold(1.6);
    mrec.end();
    await mctx.close();

    // ---- G: approve, submit to the mock adapter, show the result.
    rec.begin('G');
    await rec.hold(0.4);
    const approveBtn = page.getByRole('button', { name: /approve & submit evidence/i }).first();
    const decision = await rectOf(section(page, 'Decision'));
    const ab = await rectOf(approveBtn);
    await rec.focus(decision, { seconds: 1.3, pad: 22, zmax: 1.9, cursor: { x: ab.x + ab.w * 0.62, y: ab.y + ab.h / 2 }, top: 100 });
    const ab2 = await rectOf(approveBtn);
    await rec.hold(0.9);
    await rec.click(center(ab2));
    const result = page.getByText('Evidence submitted to PayPal');
    await rec.realUntil(async () => result.isVisible(), { timeoutMs: 120_000, what: 'the submission result' });
    await settle(page, 300);
    const resBox = await rectOf(page.locator('section[role="status"]').first());
    const decision2 = await rectOf(section(page, 'Decision'));
    await rec.focus(union(decision2, resBox), { seconds: 1.1, pad: 20, zmax: 1.9, cursor: { x: resBox.x + resBox.w - 60, y: resBox.y + resBox.h + 30 } });
    await rec.hold(3.0);
    await rec.tween(1.1, { cam: rec.full });
    await rec.hold(0.8);
    const submittedText = ((await page.locator('section[role="status"]').first().innerText()) || '').replace(/\s+/g, ' ').trim();
    rec.end();

    // ---- W: only if a weak case was really analysed (honesty rule 4).
    if (pre.weak) {
      rec.begin('W');
      await nav(page, `${BASE}/disputes/${encodeURIComponent(pre.weak.id)}`);
      await page.getByRole('heading', { name: 'Fight or concede' }).waitFor({ timeout: WAIT_MS });
      await settle(page);
      rec.cam = rec.full;
      await rec.hold(0.8);
      await rec.focus(await rectOf(section(page, 'Evidence strength')), { seconds: 1.2, pad: 22, zmax: 2.0 });
      await rec.hold(2.2);
      await rec.focus(await rectOf(section(page, 'Fight or concede')), { seconds: 1.1, pad: 22, zmax: 2.0 });
      await rec.hold(3.0);
      await rec.tween(1.0, { cam: rec.full });
      await rec.hold(0.5);
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
      scenes: ['C', 'D', 'E', 'F', 'I', 'G', ...(pre.weak ? ['W'] : []), 'H'],
    };
    fs.writeFileSync(path.join(CAP, 'capture.json'), JSON.stringify(facts, null, 2));
    return facts;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Render: cards, overlays, voice, captions, audio, one ffmpeg pass.

type SceneKind = 'ai' | 'title' | 'architecture' | 'end' | 'desktop' | 'mobile';
interface CutScene {
  id: string;
  kind: SceneKind;
  text: string | null;
  product: boolean;
}

interface Cue { from: number; to: number; lines: string[] }

/** Split narration into caption cues: whole sentences, split at clauses past ~84 characters, at most two balanced lines. */
export function cueTexts(text: string, maxChars = 84, lineChars = 42): string[][] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text.trim()];
  const chunks: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChars) {
      chunks.push(s);
      continue;
    }
    const clauses = s.split(/(?<=[,;:])\s+/);
    let cur = '';
    for (const c of clauses) {
      if (!cur) cur = c;
      else if (`${cur} ${c}`.length <= maxChars) cur = `${cur} ${c}`;
      else {
        chunks.push(cur);
        cur = c;
      }
    }
    if (cur) chunks.push(cur);
  }
  const out: string[] = [];
  for (const c of chunks) {
    if (c.length <= maxChars) {
      out.push(c);
      continue;
    }
    const words = c.split(' ');
    const half = Math.ceil(words.length / 2);
    out.push(words.slice(0, half).join(' '), words.slice(half).join(' '));
  }
  return out.map((c) => {
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

/** Fit a captured timeline to `target` seconds by stretching its holds (and the sped-up window). */
export function retime(t: Timeline, target: number): { frames: Frame[]; seconds: number; speed: number | null; lapseOut: [number, number] | null; lapseRealS: number | null } {
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
  const fixed = sum((f) => f.kind !== 'hold');
  const k = holdsNominal > 0 ? (target - fixed) / holdsNominal : 1;
  frames.forEach((f, i) => {
    if (f.kind !== 'hold') return;
    const last = i === frames.length - 1;
    f.dur = Math.max(last ? XFADE + 0.35 : 0.15, f.dur * k);
  });
  let lapseOut: [number, number] | null = null;
  if (lap) {
    const a = frames.slice(0, lap.from).reduce((s, f) => s + f.dur, 0);
    const b = frames.slice(0, lap.to).reduce((s, f) => s + f.dur, 0);
    lapseOut = [a, b];
  }
  return { frames, seconds: frames.reduce((s, f) => s + f.dur, 0), speed, lapseOut, lapseRealS: lap?.real_s ?? null };
}

/**
 * Turn a retimed timeline into an exact FPS image sequence of symlinks: output
 * frame n points at the captured frame showing at time (n + 0.5) / FPS. (The
 * ffmpeg concat demuxer is no good for this: each image opens with a 1/25 time
 * base, so 1/30 s durations collide and xfade waits forever.)
 */
/**
 * Frames whose size is off by a pixel or two (captures made before the clip was
 * snapped to the pixel grid) would make ffmpeg rebuild its filter graph mid-run,
 * which resets trim/tpad and stalls xfade. Bring just those frames to the exact
 * size without resampling: crop any overflow, pad the shortfall by smearing the
 * edge. Cached, so --reuse-capture pays this once.
 */
function normalizeFrames(srcDir: string, frames: Frame[], w: number, h: number, name: string): Map<string, string> {
  const fixedDir = path.join(WORK, 'fixed', name);
  const map = new Map<string, string>();
  const todo: string[] = [];
  for (const f of new Set(frames.map((x) => x.file))) {
    const size = jpegSize(fs.readFileSync(path.join(srcDir, f)));
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
    todo.forEach((f, i) => fs.symlinkSync(path.join(srcDir, f), path.join(tmp, `${String(i).padStart(6, '0')}.jpg`)));
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
    fs.symlinkSync(fixed.get(frames[j].file) ?? path.join(srcDir, frames[j].file), path.join(out, `${String(i).padStart(6, '0')}${path.extname(frames[j].file)}`));
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

interface Built {
  scene: CutScene;
  start: number;
  seconds: number;
  voice: Voice | null;
  asset: string;
  fallback: boolean;
  input: string[][];
  filter: (label: string, idx: number[]) => string;
  speed?: number | null;
  lapseOut?: [number, number] | null;
  lapseRealS?: number | null;
}

async function render(facts: CaptureFacts, reused: boolean) {
  const t0 = Date.now();
  fs.rmSync(REN, { recursive: true, force: true });
  fs.mkdirSync(REN, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ---- Narration that the capture can honestly support.
  const labels = facts.run.step_labels.join('\n');
  const needTools = ['get_dispute', 'get_messages', 'get_transaction', 'get_tracking', 'get_policy'];
  const missing = needTools.filter((t) => !labels.includes(t));
  if (missing.length) throw new Error(`scene D narrates tool calls the run did not make: ${missing.join(', ')}`);
  if (!/check: Citation check/.test(labels)) throw new Error('scene F narrates the citation checker, but the trace has no citation check step');
  if (!facts.submitted_text?.includes('Evidence submitted')) throw new Error('scene G narrates a submission that was not recorded');
  const sizeChart = /size chart/i.test(`${facts.pattern?.headline ?? ''} ${facts.pattern?.action ?? ''}`);
  const cut: CutScene[] = [
    { id: 'A1', kind: 'ai', text: NARRATION.A1, product: false },
    { id: 'A2', kind: 'ai', text: NARRATION.A2, product: false },
    { id: 'T', kind: 'title', text: null, product: false },
    ...(firstExisting(path.join(V2, 'ai', 'B1'), ['mp4', 'mov']) ? [{ id: 'B1', kind: 'ai' as const, text: null, product: false }] : []),
    { id: 'C', kind: 'desktop', text: NARRATION.C, product: true },
    { id: 'D', kind: 'desktop', text: NARRATION.D, product: true },
    { id: 'E', kind: 'desktop', text: facts.run.recommendation === 'FIGHT' ? NARRATION.E : NARRATION.E_NOT_FIGHT, product: true },
    { id: 'F', kind: 'desktop', text: NARRATION.F, product: true },
    { id: 'G', kind: 'desktop', text: NARRATION.G, product: true },
    ...(facts.scenes.includes('W') ? [{ id: 'W', kind: 'desktop' as const, text: NARRATION.W, product: true }] : []),
    { id: 'H', kind: 'desktop', text: sizeChart ? NARRATION.H : NARRATION.H_NO_SIZE_CHART, product: true },
    { id: 'I', kind: 'mobile', text: NARRATION.I, product: true },
    { id: 'K', kind: 'architecture', text: NARRATION.K, product: false },
    { id: 'J1', kind: 'ai', text: NARRATION.J1, product: false },
    { id: 'Z', kind: 'end', text: NARRATION.Z, product: false },
  ];
  const narration = Object.fromEntries(cut.filter((s) => s.text).map((s) => [s.id, s.text as string]));
  fs.writeFileSync(path.join(V2, 'narration.json'), `${JSON.stringify(narration, null, 2)}\n`);

  // ---- Voices.
  const sayVoice = bestSayVoice();
  const voices = new Map<string, Voice>();
  for (const s of cut) if (s.text) voices.set(s.id, prepareVoice(s.id, s.text, sayVoice));
  log(`voices ready (${[...voices.values()].filter((v) => v.draft).length} of ${voices.size} are say "${sayVoice}" drafts)`);

  const browser = await chromium.launch();
  const built: Built[] = [];
  let stageDesktop = '';
  let stagePhone = '';
  try {
    // ---- Stage plates.
    const sp = await openCard(browser, 'stage', { mode: 'desktop', x: WIN.x, y: WIN.y, w: WIN.w, h: WIN.h, r: WIN.r });
    stageDesktop = path.join(REN, 'stage-desktop.png');
    await shoot(sp, stageDesktop, true);
    await sp.close();
    const pp = await openCard(browser, 'stage', { mode: 'phone', x: PHONE.x, y: PHONE.y, w: PHONE.w, h: PHONE.h, r: PHONE.r, bezel: PHONE.bezel });
    stagePhone = path.join(REN, 'stage-phone.png');
    await shoot(pp, stagePhone, true);
    await pp.close();

    // ---- Scene lengths and sources.
    let start = 0;
    for (const s of cut) {
      const v = voices.get(s.id) ?? null;
      const want = Math.max(MIN_SECONDS[s.id] ?? 4, v ? LEAD + v.seconds + TAIL + XFADE : 0);
      const b: Built = { scene: s, start, seconds: want, voice: v, asset: '', fallback: false, input: [], filter: () => '' };
      if (s.kind === 'ai') {
        const file = firstExisting(path.join(V2, 'ai', s.id), ['mp4', 'mov']);
        if (file) {
          b.asset = rel(file);
          const len = mediaSeconds(file);
          if (s.id === 'B1') b.seconds = clamp(len, B1_SECONDS.min, B1_SECONDS.max);
          const want = b.seconds;
          b.input = [['-i', file]];
          b.filter = (label, [i]) =>
            `[${i}:v]scale=${FRAME.w}:${FRAME.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${FRAME.w}:${FRAME.h},setsar=1,fps=${FPS},` +
            `tpad=stop_mode=clone:stop_duration=${Math.max(0, want - len + 1).toFixed(2)},trim=duration=${want.toFixed(4)},setpts=PTS-STARTPTS,` +
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
      } else if (s.kind === 'title' || s.kind === 'architecture' || s.kind === 'end') {
        const params: Record<string, string> =
          s.kind === 'title' ? { product: BRAND.product, subtitle: BRAND.subtitle } : s.kind === 'end' ? { product: BRAND.product, repo: BRAND.repo, line: BRAND.endLine } : {};
        const { dir, t } = await cardTimeline(browser, s.kind, params);
        const r = retime(t, want);
        b.seconds = r.seconds;
        b.asset = `${rel(path.join(CARDS, `${s.kind}.html`))}`;
        b.input = [writeSequence(dir, r.frames, r.seconds, s.id)];
        b.filter = (label, [i]) => `[${i}:v]setsar=1,tpad=stop_mode=clone:stop_duration=1,trim=duration=${b.seconds.toFixed(4)},setpts=PTS-STARTPTS,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[${label}]`;
      } else {
        const dir = path.join(CAP, s.id);
        const t = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')) as Timeline;
        const r = retime(t, want);
        Object.assign(b, { seconds: r.seconds, speed: r.speed, lapseOut: r.lapseOut, lapseRealS: r.lapseRealS, asset: `capture ${rel(dir)} (${t.frames.length} frames)` });
        const geo = s.kind === 'mobile' ? PHONE : WIN;
        const stage = s.kind === 'mobile' ? stagePhone : stageDesktop;
        const fixed = normalizeFrames(dir, r.frames, geo.w, geo.h, s.id);
        b.input = [writeSequence(dir, r.frames, r.seconds, s.id, fixed), ['-loop', '1', '-framerate', String(FPS), '-t', (b.seconds + 1).toFixed(3), '-i', stage]];
        b.filter = (label, [i, st]) =>
          `[${i}:v]crop=w='min(iw,${geo.w})':h='min(ih,${geo.h})':x=0:y=0,pad=${geo.w}:${geo.h}:0:0:white,setsar=1,pad=${FRAME.w}:${FRAME.h}:${geo.x}:${geo.y}:black,` +
          `tpad=stop_mode=clone:stop_duration=1,trim=duration=${b.seconds.toFixed(4)},setpts=PTS-STARTPTS[${label}c];` +
          `[${label}c][${st}:v]overlay=0:0:shortest=1:format=rgb,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[${label}]`;
      }
      built.push(b);
      start += b.seconds - XFADE;
    }
    // Recompute starts with the final lengths.
    let at = 0;
    for (const b of built) {
      b.start = at;
      at += b.seconds - XFADE;
    }
    const total = at + XFADE;
    log(`cut: ${built.map((b) => `${b.scene.id} ${b.seconds.toFixed(1)}s`).join(' · ')} = ${total.toFixed(1)} s`);
    if (total >= 180) throw new Error(`the cut is ${total.toFixed(1)} s, over the 3:00 limit`);

    // ---- Captions: SRT plus one transparent PNG per cue.
    const cues: Cue[] = [];
    for (const b of built) {
      if (!b.voice || !b.scene.text) continue;
      const at0 = b.start + LEAD;
      for (const c of timeCues(cueTexts(b.scene.text), b.voice.speech, b.voice.pauses)) cues.push({ from: at0 + c.from, to: at0 + c.to, lines: c.lines });
    }
    fs.writeFileSync(path.join(OUT, 'demo-v2.srt'), cues.map((q, i) => `${i + 1}\n${srtTime(q.from)} --> ${srtTime(q.to)}\n${q.lines.join('\n')}\n`).join('\n'));
    const ov = await openCard(browser, 'overlay', {});
    const ovDir = path.join(REN, 'overlays');
    fs.mkdirSync(ovDir, { recursive: true });
    const blank = path.join(ovDir, 'blank.png');
    await ov.evaluate('window.show("none", {})');
    await shoot(ov, blank, true);
    const capList = ['ffconcat version 1.0'];
    let clock = 0;
    // Gaps under 0.2 s are folded into the cue before, so every entry here is
    // long: this list goes through the concat demuxer, whose image time base is 1/25.
    for (const [i, q] of cues.entries()) {
      const png = path.join(ovDir, `cue-${String(i).padStart(3, '0')}.png`);
      await ov.evaluate(`window.show("caption", ${JSON.stringify({ lines: q.lines })})`);
      await shoot(ov, png, true);
      const next = cues[i + 1];
      const end = next && next.from - q.to < 0.2 ? next.from : q.to;
      if (q.from - clock >= 0.2) capList.push(`file '${blank}'`, `duration ${(q.from - clock).toFixed(4)}`);
      const from = q.from - clock >= 0.2 ? q.from : clock;
      capList.push(`file '${png}'`, `duration ${Math.max(0.2, end - from).toFixed(4)}`);
      clock = from + Math.max(0.2, end - from);
    }
    capList.push(`file '${blank}'`, `duration ${Math.max(0.1, total - clock).toFixed(4)}`, `file '${blank}'`);
    const capFile = path.join(REN, 'captions.ffconcat');
    fs.writeFileSync(capFile, `${capList.join('\n')}\n`);

    const disclosurePng = path.join(ovDir, 'disclosure.png');
    await ov.evaluate(`window.show("disclosure", ${JSON.stringify({ label: BRAND.disclosureLabel, lines: BRAND.disclosure })})`);
    await shoot(ov, disclosurePng, true);
    const lapseScene = built.find((b) => b.lapseOut);
    let badgePng = '';
    let badgeText = '';
    if (lapseScene?.speed && lapseScene.lapseOut) {
      const speedLabel = lapseScene.speed >= 10 ? `${Math.round(lapseScene.speed)}x` : `${(Math.round(lapseScene.speed * 2) / 2).toFixed(1).replace(/\.0$/, '')}x`;
      badgeText = `Sped up ${speedLabel} · real run ${facts.run.real_run_seconds} s`;
      badgePng = path.join(ovDir, 'badge.png');
      await ov.evaluate(`window.show("badge", ${JSON.stringify({ main: `Sped up ${speedLabel}`, sub: `· real run ${facts.run.real_run_seconds} s` })})`);
      await shoot(ov, badgePng, true);
    }
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
        const ms = Math.round((b.start + LEAD) * 1000);
        aGraph.push(`[${ai}:a]adelay=${ms}|${ms}[v${ai}]`);
        voiceLabels.push(`[v${ai}]`);
        ai++;
      }
      if (b.scene.kind === 'ai' && !b.fallback && hasAudio(path.join(ROOT, b.asset))) {
        aIn.push('-i', path.join(ROOT, b.asset));
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
    const capIdx = idx++;
    vIn.push('-f', 'concat', '-safe', '0', '-i', capFile);
    const product = built.filter((b) => b.scene.product);
    const discFrom = product[0].start;
    const discTo = product[product.length - 1].start + product[product.length - 1].seconds;
    const discIdx = idx++;
    vIn.push('-loop', '1', '-framerate', String(FPS), '-t', (discTo - discFrom).toFixed(3), '-i', disclosurePng);
    const yuva = 'scale=out_color_matrix=bt709:out_range=tv,format=yuva420p';
    graph.push(`[${discIdx}:v]format=rgba,fade=t=in:st=0:d=${XFADE}:alpha=1,fade=t=out:st=${(discTo - discFrom - XFADE).toFixed(3)}:d=${XFADE}:alpha=1,${yuva},setpts=PTS+${discFrom.toFixed(3)}/TB[disc]`);
    graph.push(`[${capIdx}:v]fps=${FPS},format=rgba,${yuva}[cap]`);
    let chain = `[xf][disc]overlay=0:0:eof_action=pass[o1];[o1][cap]overlay=0:0:eof_action=pass`;
    let badgeRange: [number, number] | null = null;
    if (badgePng && lapseScene?.lapseOut) {
      const a = lapseScene.start + lapseScene.lapseOut[0];
      const z = lapseScene.start + lapseScene.lapseOut[1];
      badgeRange = [a, z];
      const badgeIdx = idx++;
      vIn.push('-loop', '1', '-framerate', String(FPS), '-t', (z - a).toFixed(3), '-i', badgePng);
      graph.push(`[${badgeIdx}:v]format=rgba,fade=t=in:st=0:d=0.25:alpha=1,fade=t=out:st=${Math.max(0, z - a - 0.25).toFixed(3)}:d=0.25:alpha=1,${yuva},setpts=PTS+${a.toFixed(3)}/TB[badge]`);
      chain += `[o2];[o2][badge]overlay=0:0:eof_action=pass`;
    }
    graph.push(`${chain},fade=t=in:st=0:d=0.6,fade=t=out:st=${(total - 0.9).toFixed(3)}:d=0.9,trim=duration=${total.toFixed(4)},format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout]`);
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
      ...built.filter((b) => b.scene.kind === 'ai' && b.fallback).map((b) => `AI shot ${b.scene.id}: placeholder card`),
      ...(built.some((b) => b.voice?.draft) ? [`voice: macOS say "${sayVoice}" for ${built.filter((b) => b.voice?.draft).map((b) => b.scene.id).join(', ')}`] : []),
      ...(music ? [] : ['music: none (no demo/v2/music/bed.mp3|wav)']),
    ];
    const manifest = {
      file: rel(final),
      seconds: +seconds.toFixed(2),
      under_3_minutes: seconds < 180,
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
        captured_window_seconds: lapseScene?.lapseRealS ?? null,
        shown_speed: lapseScene?.speed ? +lapseScene.speed.toFixed(2) : null,
        badge: badgeText || null,
        badge_on_screen: badgeRange ? badgeRange.map((v) => +v.toFixed(2)) : null,
        strength: facts.run.strength,
        recommendation: facts.run.recommendation,
        sources: facts.run.sources,
      },
      weak_case: { included: facts.scenes.includes('W'), reason: facts.weak_case_reason },
      narration_adjustments: [
        ...(facts.run.recommendation === 'FIGHT' ? [] : ['E: "Here, it is." cut: the run did not recommend FIGHT']),
        ...(sizeChart ? [] : ['H: "like an outdated size chart" cut: no size-chart pattern on screen']),
      ],
      disclosure: { text: BRAND.disclosure.join(' · '), on_screen: [+discFrom.toFixed(2), +discTo.toFixed(2)], scenes: product.map((b) => b.scene.id) },
      scenes: built.map((b) => ({
        id: b.scene.id,
        kind: b.scene.kind,
        start: +b.start.toFixed(2),
        seconds: +b.seconds.toFixed(2),
        narration: b.scene.text,
        narration_seconds: b.voice ? +b.voice.seconds.toFixed(2) : null,
        voice_source: b.voice?.source ?? null,
        asset: b.asset,
        fallback: b.fallback,
      })),
      optional_slots: { B1: built.some((b) => b.scene.id === 'B1') ? 'demo/v2/ai/B1.mp4' : 'absent (skipped)' },
      captions: { file: 'demo/out/demo-v2.srt', cues: cues.length },
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
