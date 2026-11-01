import { themeQuartz } from 'ag-grid-community';

/**
 * AG Grid v34 Theming API. No AG Grid CSS files are imported anywhere.
 * Accent matches --color-accent (#0f766e, teal).
 */
export const ACCENT = '#0f766e';

export const gridTheme = themeQuartz.withParams({
  accentColor: ACCENT,
  fontFamily: 'inherit',
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  foregroundColor: '#1c1917',
  backgroundColor: '#ffffff',
  headerBackgroundColor: '#fafaf9',
  headerTextColor: '#57534e',
  borderColor: '#e7e5e4',
  rowHoverColor: '#f0fdfa',
  selectedRowBackgroundColor: '#ccfbf1',
  oddRowBackgroundColor: '#ffffff',
  wrapperBorderRadius: 12,
  borderRadius: 6,
  spacing: 7,
  rowHeight: 56,
  headerHeight: 40,
});

export const compactGridTheme = gridTheme.withParams({
  rowHeight: 44,
  spacing: 6,
});

export default gridTheme;