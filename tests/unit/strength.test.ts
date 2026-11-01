import { describe, it, expect } from 'vitest';
import { RUBRICS, scoreStrength } from '../../src/lib/scoring/strength';

const INR = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
const SNAD = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
const UNAUTH = 'UNAUTHORISED';

function allSignals(reason: string, present: boolean) {
  const out: Record<string, { present: boolean; source_ids: string[] }> = {};
  for (const item of RUBRICS[reason as keyof typeof RUBRICS]) {
    out[item.key] = { present, source_ids: present ? ['S1'] : [] };
  }
  return out;
}

describe('strength rubric', () => {
  it('has weights summing to 100 for every reason code', () => {
    for (const reason of [INR, SNAD, UNAUTH]) {
      const items = RUBRICS[reason as keyof typeof RUBRICS];
      expect(items.reduce((s, i) => s + i.weight, 0)).toBe(100);
    }
  });

  it('matches the published INR weights', () => {
    expect(RUBRICS[INR].map((i) => i.weight).sort((a, b) => a - b)).toEqual([10, 15, 20, 25, 30]);
  });

  it('matches the published SNAD weights', () => {
    expect(RUBRICS[SNAD].map((i) => i.weight).sort((a, b) => a - b)).toEqual([15, 20, 20, 20, 25]);
  });

  it('matches the published UNAUTHORISED weights', () => {
    expect(RUBRICS[UNAUTH].map((i) => i.weight).sort((a, b) => a - b)).toEqual([20, 20, 25, 35]);
  });

  it('scores 100 when every item is present and 0 when none are', () => {
    for (const reason of [INR, SNAD, UNAUTH]) {
      expect(scoreStrength(reason, allSignals(reason, true)).score).toBe(100);
      expect(scoreStrength(reason, allSignals(reason, false)).score).toBe(0);
    }
  });

  it('adds only the weights of present items', () => {
    const signals = allSignals(INR, false);
    const heaviest = [...RUBRICS[INR]].sort((a, b) => b.weight - a.weight).slice(0, 2);
    for (const h of heaviest) signals[h.key] = { present: true, source_ids: ['S2'] };
    expect(scoreStrength(INR, signals).score).toBe(55);
  });

  it('reports a breakdown item per rubric line with its source ids', () => {
    const signals = allSignals(UNAUTH, false);
    const first = RUBRICS[UNAUTH][0];
    signals[first.key] = { present: true, source_ids: ['S3', 'S4'] };
    const res = scoreStrength(UNAUTH, signals);
    expect(res.items).toHaveLength(RUBRICS[UNAUTH].length);
    const item = res.items.find((i) => i.key === first.key)!;
    expect(item.present).toBe(true);
    expect(item.source_ids).toEqual(['S3', 'S4']);
    expect(typeof item.label).toBe('string');
    for (const other of res.items.filter((i) => i.key !== first.key)) {
      expect(other.present).toBe(false);
      expect(other.source_ids).toEqual([]);
    }
  });

  it('treats a missing signal as absent', () => {
    expect(scoreStrength(INR, {}).score).toBe(0);
  });

  it('is deterministic', () => {
    const s = allSignals(SNAD, true);
    expect(scoreStrength(SNAD, s)).toEqual(scoreStrength(SNAD, s));
  });
});