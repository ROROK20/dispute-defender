import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const shortId = customAlphabet(alphabet, 14);

export function newId(prefix: string): string {
  return `${prefix}_${shortId()}`;
}

export const newRunId = (): string => newId("run");
export const newDecisionId = (): string => newId("dec");
export const newPatternId = (): string => newId("pat");
export const newDemoEventId = (): string => newId("demo");
export const newPollEventId = (): string => newId("poll");
export const newSentenceId = (index: number): string => `s${index + 1}`;

export function sourceKey(index: number): string {
  return `S${index}`;
}

export function isSyntheticEventId(id: string): boolean {
  return id.startsWith("demo_") || id.startsWith("poll_");
}