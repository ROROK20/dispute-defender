import { describe, it, expect } from 'vitest';
import { cueTexts, timeCues, retime, NARRATION, XFADE, type Timeline } from '../../scripts/record-demo-v2';

const words = (s: string) => s.split(/\s+/).filter(Boolean);

describe('cueTexts', () => {
  it('keeps every word, in order, for every narration line', () => {
    for (const text of Object.values(NARRATION)) {
      const cues = cueTexts(text);
      expect(cues.flat().join(' ')).toBe(words(text).join(' '));
    }
  });

  it('never makes more than two lines, and keeps lines readable', () => {
    for (const text of Object.values(NARRATION)) {
      for (const cue of cueTexts(text)) {
        expect(cue.length).toBeLessThanOrEqual(2);
        for (const line of cue) expect(line.length).toBeLessThanOrEqual(50);
      }
    }
  });

  it('starts a new cue at each sentence, not every N words', () => {
    const cues = cueTexts("It's eleven at night. A buyer just opened a dispute, and the clock is already running.");
    expect(cues.map((c) => c.join(' '))).toEqual([
      "It's eleven at night.",
      'A buyer just opened a dispute, and the clock is already running.',
    ]);
  });

  it('splits a long sentence at a clause boundary', () => {
    const cues = cueTexts(NARRATION.F).map((c) => c.join(' '));
    expect(cues.every((c) => c.length <= 84)).toBe(true);
    expect(cues.some((c) => c.endsWith(','))).toBe(true);
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
