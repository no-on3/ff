/**
 * The console's design tokens: its colors, fonts, corners and shadows, as the console design plan's direction sets
 * them (docs/console-design-plan.md, "navy and paper"). index.css's @theme gives Tailwind the same values, since CSS
 * can't import them from here, and tokens.test.ts keeps both equal; MUI's theme (mui.ts) reads them from here.
 */

/**
 * Tailwind's gray, blue and green scales, redefined so that every class the pages already use follows the direction.
 * The named steps are Column's (column.com): its grays, its blue scale whole, its teal and green; the steps between
 * are derived from them. Gray 500, the labels', is Column's #7c7f88 darkened to #6b6e77, for WCAG's 4.5:1 on the page
 * and the panels, which tokens.test.ts checks.
 */
export const scales = {
  gray: {
    50: '#f6f6f8',
    100: '#eeeff2',
    200: '#e3e4e8',
    300: '#cfd1d7',
    400: '#a4a7af',
    500: '#6b6e77',
    600: '#575a64',
    700: '#3f424b',
    800: '#232730',
    900: '#12161e',
    950: '#0a0d14',
  },
  blue: {
    50: '#eef4fb',
    100: '#d4e3f7',
    200: '#c4d6f2',
    300: '#a2c1ed',
    400: '#7ea7e9',
    500: '#4575cd',
    600: '#1e4199',
    700: '#1b2d70',
    800: '#111a4a',
    900: '#080b32',
    950: '#05071f',
  },
  green: {
    50: '#effaf6',
    100: '#e3f4ee',
    200: '#c3e7da',
    300: '#94d4bd',
    400: '#44b48b',
    500: '#279a74',
    600: '#167e6c',
    700: '#12665a',
    800: '#0f5249',
    900: '#0c433c',
    950: '#062823',
  },
} as const;

/** The colors with a role of their own, as classes: text-ink, bg-canvas, border-line, bg-attention. */
export const colors = {
  /** Headings, primary buttons, FF's mark: Column's ink. */
  ink: scales.blue[800],
  /** The page behind the panels. */
  canvas: scales.gray[50],
  /** Borders and dividers. */
  line: scales.gray[200],
  /** What needs the user: Column's orange, in the charts; and darkened, under white text, as an alarm's count. */
  attention: '#ec652b',
  'attention-strong': '#c4501d',
  /** Failures: Tailwind's red-700, which the console's red classes keep. */
  danger: '#c10007',
  /** Warnings: Tailwind's amber-600, which the console's amber classes keep. */
  warning: '#e17100',
} as const;

/** Geist and Geist Mono, served by the console itself (@fontsource-variable), in place of Column's licensed Suisse Int'l. */
export const fonts = {
  sans: '"Geist Variable", ui-sans-serif, system-ui, sans-serif',
  mono: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** Column's soft, navy-tinted shadows: on panels and buttons (sm, and md in its place), and on menus and dialogs. */
export const shadows = {
  sm: '0 1px 3px rgba(17, 26, 74, 0.08), 0 1px 2px rgba(17, 26, 74, 0.04)',
  md: '0 1px 3px rgba(17, 26, 74, 0.08), 0 1px 2px rgba(17, 26, 74, 0.04)',
  raised: '0 1px 3px rgba(17, 26, 74, 0.1), 0 8px 24px rgba(17, 26, 74, 0.12)',
} as const;

/** Corners, in px: panels, buttons and fields; small controls such as tags and the sidebar's links. */
export const radius = { panel: 8, control: 6 } as const;

/** What index.css's @theme must define, by variable name: tokens.test.ts compares the two. */
export function themeVariables(): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [scale, steps] of Object.entries(scales)) {
    for (const [step, value] of Object.entries(steps)) variables[`--color-${scale}-${step}`] = value;
  }
  for (const [name, value] of Object.entries(colors)) variables[`--color-${name}`] = value;
  for (const [name, value] of Object.entries(fonts)) variables[`--font-${name}`] = value;
  for (const [name, value] of Object.entries(shadows)) variables[`--shadow-${name}`] = value;
  return variables;
}
