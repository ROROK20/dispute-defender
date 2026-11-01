/**
 * Closed list of root-cause themes for buyer messages.
 *
 * Claude may only tag messages with these themes; anything else is dropped.
 * Code (not the model) counts tags per (sku, reason) group in mine.ts.
 */

export const THEMES = [
  'sizing',
  'color_mismatch',
  'fabric_quality',
  'late_delivery',
  'wrong_item',
  'damaged',
  'not_recognized',
] as const;

export type Theme = (typeof THEMES)[number];

export interface ThemeDefinition {
  theme: Theme;
  label: string;
  /** Shown to Claude when tagging, so tagging stays consistent. */
  description: string;
  /** Phrase used in the headline: "4 of 6 SNAD claims on JT-114 mention <phrase>". */
  headlinePhrase: string;
  /** Lower-cased keywords used by the deterministic fallback tagger (mock mode / no API key). */
  keywords: string[];
  /** Builds the prevention action for a pattern. */
  action: (sku: string | null, skuName: string | null) => string;
}

function skuLabel(sku: string | null, skuName: string | null): string {
  if (sku && skuName) return `${sku} (${skuName})`;
  if (sku) return sku;
  return 'these orders';
}

export const THEME_DEFINITIONS: Record<Theme, ThemeDefinition> = {
  sizing: {
    theme: 'sizing',
    label: 'Sizing',
    description: 'Buyer says the item is too small, too large, runs small/big, or does not match the size chart.',
    headlinePhrase: 'sizing',
    keywords: ['size', 'sizing', 'too small', 'too big', 'too large', 'too tight', 'too loose', 'runs small', 'runs large', 'runs big', 'fit', 'fits', 'size chart', 'measurements'],
    action: (sku, name) => `Update the size chart and add measured garment dimensions for ${skuLabel(sku, name)}`,
  },
  color_mismatch: {
    theme: 'color_mismatch',
    label: 'Color mismatch',
    description: 'Buyer says the color or shade differs from the listing photos or description.',
    headlinePhrase: 'color not matching the listing',
    keywords: ['color', 'colour', 'shade', 'darker', 'lighter', 'different color', 'not the color', 'faded', 'tone'],
    action: (sku, name) => `Reshoot listing photos in natural light and name the exact shade for ${skuLabel(sku, name)}`,
  },
  fabric_quality: {
    theme: 'fabric_quality',
    label: 'Fabric quality',
    description: 'Buyer complains about material, fabric feel, thickness, pilling, stitching or general quality.',
    headlinePhrase: 'fabric or build quality',
    keywords: ['fabric', 'material', 'quality', 'thin', 'see-through', 'see through', 'cheap', 'pilling', 'scratchy', 'stitching', 'seam', 'itchy', 'flimsy'],
    action: (sku, name) => `Add fabric weight, composition and close-up photos to the listing for ${skuLabel(sku, name)}`,
  },
  late_delivery: {
    theme: 'late_delivery',
    label: 'Late delivery',
    description: 'Buyer says the package is late, has not arrived, or tracking has not updated.',
    headlinePhrase: 'late or missing delivery',
    keywords: ['late', 'never arrived', 'not arrived', "hasn't arrived", 'has not arrived', 'not received', 'never received', 'still waiting', 'tracking', 'delayed', 'where is my', 'lost'],
    action: (sku, name) => `Ship ${skuLabel(sku, name)} with signature confirmation and state realistic delivery windows at checkout`,
  },
  wrong_item: {
    theme: 'wrong_item',
    label: 'Wrong item',
    description: 'Buyer says they received a different item, style or variant than they ordered.',
    headlinePhrase: 'receiving the wrong item',
    keywords: ['wrong item', 'wrong size sent', 'different item', 'not what i ordered', 'wrong one', 'sent the wrong', 'received the wrong', 'wrong product', 'wrong style'],
    action: (sku, name) => `Add a pick-and-pack SKU check before shipping ${skuLabel(sku, name)}`,
  },
  damaged: {
    theme: 'damaged',
    label: 'Damaged',
    description: 'Buyer says the item arrived damaged, torn, stained, broken or with defects.',
    headlinePhrase: 'damage on arrival',
    keywords: ['damaged', 'torn', 'ripped', 'hole', 'stain', 'stained', 'broken', 'defect', 'defective', 'crushed'],
    action: (sku, name) => `Improve packaging and add a pre-ship inspection photo for ${skuLabel(sku, name)}`,
  },
  not_recognized: {
    theme: 'not_recognized',
    label: 'Not recognized',
    description: 'Buyer does not recognize the charge, says they did not make the purchase, or suspects account misuse.',
    headlinePhrase: 'not recognizing the charge',
    keywords: ["didn't buy", 'did not buy', "didn't order", 'did not order', "don't recognize", 'do not recognize', 'unauthorized', 'unauthorised', 'not me', 'fraud', 'hacked', 'never ordered'],
    action: (sku, name) => `Use a recognizable billing descriptor and send an order-confirmation email for ${skuLabel(sku, name)}`,
  },
};

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** Keep only valid themes, deduplicated, in closed-list order. */
export function normalizeThemes(values: unknown): Theme[] {
  if (!Array.isArray(values)) return [];
  const set = new Set<Theme>();
  for (const v of values) {
    const t = typeof v === 'string' ? v.trim().toLowerCase() : v;
    if (isTheme(t)) set.add(t);
  }
  return THEMES.filter((t) => set.has(t));
}

/** Text listing for the tagging prompt. */
export function themeListForPrompt(): string {
  return THEMES.map((t) => `- ${t}: ${THEME_DEFINITIONS[t].description}`).join('\n');
}

/**
 * Deterministic keyword tagger. Used in ANTHROPIC_MOCK mode, without an API key,
 * or when the model call fails. Returns themes plus the first matching keyword
 * position so a verbatim quote can be cut from the message.
 */
export function keywordTag(text: string): { themes: Theme[]; hits: { theme: Theme; index: number; keyword: string }[] } {
  const lower = text.toLowerCase();
  const hits: { theme: Theme; index: number; keyword: string }[] = [];
  for (const t of THEMES) {
    let best: { index: number; keyword: string } | null = null;
    for (const kw of THEME_DEFINITIONS[t].keywords) {
      const re = new RegExp(`(^|[^a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
      const m = re.exec(lower);
      if (m) {
        const idx = m.index + m[1].length;
        if (!best || idx < best.index) best = { index: idx, keyword: kw };
      }
    }
    if (best) hits.push({ theme: t, ...best });
  }
  return { themes: hits.map((h) => h.theme), hits };
}