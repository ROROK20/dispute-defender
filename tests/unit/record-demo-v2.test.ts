import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cueTexts, timeCues, retime, sliceTimeline, NARRATION, XFADE, type Timeline } from '../../scripts/record-demo-v2';

const words = (s: string) => s.split(/\s+/).filter(Boolean);

describe('narration', () => {
  it('matches demo/v2/VOICE_SCRIPT.md byte for byte, code for code', () => {
    const md = fs.readFileSync(path.join(process.cwd(), 'demo/v2/VOICE_SCRIPT.md'), 'utf8');
    const rows = [...md.matchAll(/^\| ([A-Z][A-Z0-9]*) \| (.+) \|$/gm)].map((m) => [m[1], m[2].replace(/^\*\(maybe\)\*\s*/, '')]);
    expect(rows.length).toBeGreaterThan(10);
    expect(Object.fromEntries(rows)).toEqual({ ...NARRATION });
  });
});

describe('cueTexts', () => {
  it('keeps every word, in order, for every narration line', () => {
    for (const text of Object.values(NARRATION)) {
      const cues = cueTexts(text);
      expect(cues.flat().join(' ')).toBe(words(text).join(' '));
    }
  });

  it('never makes more than two lines, and keeps lines short enough for 44 px', () => {
    for (const text of Object.values(NARRATION)) {
      for (const cue of cueTexts(text)) {
        expect(cue.length).toBeLessThanOrEqual(2);
        for (const line of cue) expect(line.length).toBeLessThanOrEqual(40);
      }
    }
  });

  it('starts a new cue at each sentence, not every N words', () => {
    const cues = cueTexts('Eleven at night. A buyer just opened a PayPal dispute.');
    expect(cues.map((c) => c.join(' '))).toEqual(['Eleven at night.', 'A buyer just opened a PayPal dispute.']);
  });

  it('splits a long sentence at a clause boundary', () => {
    const cues = cueTexts(NARRATION.D).map((c) => c.join(' '));
    expect(cues.every((c) => c.length <= 60)).toBe(true);
    expect(cues.some((c) => c.endsWith(','))).toBe(true);
  });

  it('never leaves a short orphan clause on its own', () => {
    for (const text of Object.values(NARRATION)) {
      const cues = cueTexts(text).map((c) => c.join(' '));
      for (const c of cues) if (/,$/.test(c)) expect(c.length).toBeGreaterThanOrEqual(22);
    }
    // "Every number," must not stand alone.
    expect(cueTexts(NARRATION.F).map((c) => c.join(' '))).not.toContain('Every number,');
  });
});

describe('timeCues', () => {
  it('snaps cue boundaries to the real pauses between sentences', () => {
    const cues = [['First sentence here.'], ['Second sentence is a bit longer than that.'], ['Third.']];
    const timed = timeCues(cues, { start: 0, end: 6 }, [
      { s: 1.4, e: 1.8 },
      { s: 5.0, e: 5.3 },
    ]);
    expect(timed[0].to).toBeCloseTo(1.52, 2);
    expect(timed[1].from).toBeCloseTo(1.72, 2);
    expect(timed[1].to).toBeCloseTo(5.12, 2);
    expect(timed[2].from).toBeCloseTo(5.22, 2);
  });

  it('falls back to proportional timing without pauses, and stays ordered', () => {
    const timed = timeCues([['a a a a'], ['b b b b'], ['c c c c']], { start: 0, end: 9 }, []);
    for (let i = 1; i < timed.length; i++) {
      expect(timed[i].from).toBeGreaterThanOrEqual(timed[i - 1].from);
      expect(timed[i].from).toBeCloseTo(timed[i - 1].to, 5);
    }
    expect(timed[2].to).toBeGreaterThan(9);
  });
});

describe('retime', () => {
  const frame = (kind: 'step' | 'hold' | 'real' | 'lapse', dur: number, i: number) => ({ file: `${i}.jpg`, dur, kind });

  it('stretches only the holds to hit the target length', () => {
    const t: Timeline = {
      id: 'X', kind: 'desktop', size: { w: 1600, h: 900 },
      frames: [frame('hold', 1, 0), frame('step', 0.5, 1), frame('real', 0.5, 2), frame('hold', 1, 3)],
    };
    const r = retime(t, 6);
    expect(r.seconds).toBeCloseTo(6, 5);
    expect(r.frames[1].dur).toBe(0.5);
    expect(r.frames[2].dur).toBe(0.5);
    expect(r.frames[0].dur).toBeCloseTo(2.5, 5);
    expect(r.speed).toBeNull();
  });

  it('keeps the last frame long enough to cover the crossfade', () => {
    const t: Timeline = { id: 'X', kind: 'desktop', size: { w: 1600, h: 900 }, frames: [frame('step', 3, 0), frame('hold', 1, 1)] };
    const r = retime(t, 2);
    expect(r.frames[1].dur).toBeGreaterThanOrEqual(XFADE);
  });

  it('speeds up the agent run by a round factor that matches the real window exactly', () => {
    const frames = [frame('hold', 0.5, 0)];
    for (let i = 0; i < 6; i++) frames.push(frame('step', 1 / 30, frames.length));
    for (let i = 0; i < 100; i++) frames.push(frame('lapse', 1.2, frames.length));
    const to = frames.length;
    frames.push(frame('hold', 1, frames.length));
    const t: Timeline = { id: 'D', kind: 'desktop', size: { w: 1600, h: 900 }, frames, lapse: { from: 1, to, real_s: 121 } };
    const r = retime(t, 14);
    expect(r.speed).not.toBeNull();
    expect(Number.isInteger(r.speed!) || Number.isInteger(r.speed! * 2)).toBe(true);
    const [a, b] = r.lapseOut!;
    expect(121 / (b - a)).toBeCloseTo(r.speed!, 6);
    expect(r.seconds).toBeCloseTo(14, 1);
  });
});

describe('retime with anchors', () => {
  const f = (kind: 'step' | 'hold' | 'real', dur: number, i: number) => ({ file: `${i}.jpg`, dur, kind });

  it('lands each anchored frame on its cue time, stretching only the holds around it', () => {
    // hold | steps (click) | hold (drawer) | steps (close) | hold
    const t: Timeline = {
      id: 'F', kind: 'desktop', size: { w: 1536, h: 864 },
      frames: [f('hold', 1, 0), f('step', 0.5, 1), f('hold', 2, 2), f('step', 0.5, 3), f('hold', 1, 4)],
    };
    const r = retime(t, 12, [{ at: 1, time: 3 }, { at: 3, time: 7 }]);
    expect(r.seconds).toBeCloseTo(12, 5);
    expect(r.anchors.map((a) => a.landed)).toEqual([3, 7]);
    expect(r.frames[1].dur).toBe(0.5);
    expect(r.frames[3].dur).toBe(0.5);
  });

  it('reports an anchor it could not reach instead of hiding it', () => {
    const t: Timeline = { id: 'X', kind: 'desktop', size: { w: 1536, h: 864 }, frames: [f('step', 2, 0), f('hold', 1, 1)] };
    const r = retime(t, 6, [{ at: 1, time: 0.5 }]);
    expect(r.anchors[0].landed).toBeGreaterThan(r.anchors[0].wanted);
  });
});

describe('sliceTimeline', () => {
  it('re-bases marks, measures the sped-up window from wall clocks, and adds an elastic tail', () => {
    const frames = [
      { file: 'a.jpg', dur: 1, kind: 'hold' as const, w: 0 },
      { file: 'b.jpg', dur: 1 / 30, kind: 'step' as const, w: 1000 },
      { file: 'c.jpg', dur: 2, kind: 'lapse' as const, w: 2000 },
      { file: 'd.jpg', dur: 3, kind: 'lapse' as const, w: 4000 },
      { file: 'e.jpg', dur: 1, kind: 'hold' as const, w: 7000 },
    ];
    const t: Timeline = { id: 'D', kind: 'desktop', size: { w: 1536, h: 864 }, frames, marks: { clicked: { at: 1 }, runDone: { at: 4 } } };
    const s = sliceTimeline(t, 1, 5, 0.5);
    expect(s.frames.map((x) => x.file)).toEqual(['b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'e.jpg']);
    expect(s.frames[4]).toMatchObject({ kind: 'hold', dur: 0.5 });
    expect(s.marks).toEqual({ clicked: { at: 0 }, runDone: { at: 3 } });
    expect(s.lapse).toEqual({ from: 1, to: 3, real_s: 5 });
  });
});

