import { describe, expect, it } from 'vitest';
import css from '../index.css?raw';
import { muiTheme } from './mui';
import { colors, fonts, radius, scales, themeVariables } from './tokens';

/** The variables index.css's @theme block defines, by name. */
function cssThemeVariables(text: string): Record<string, string> {
  const block = text.match(/@theme\s*\{([\s\S]*?)\n\}/);
  if (!block) throw new Error('index.css has no @theme block');
  return Object.fromEntries([...block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

describe("the console's tokens", () => {
  it("are index.css's @theme exactly, so that Tailwind's classes and MUI's components can't drift apart", () => {
    expect(cssThemeVariables(css)).toEqual(themeVariables());
  });

  it("make MUI's theme: the ink of its primary color, the borders, the font and the corners", () => {
    expect(muiTheme.palette.primary.main).toBe(colors.ink);
    expect(muiTheme.palette.divider).toBe(colors.line);
    expect(muiTheme.typography.fontFamily).toBe(fonts.sans);
    expect(muiTheme.shape.borderRadius).toBe(radius.panel);
  });
});

/** WCAG 2's contrast ratio between two opaque colors, #rrggbb. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe("the tokens' text colors", () => {
  it('measures contrast as WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
  });

  it.each([
    ['text', scales.gray[800], 'a panel', '#ffffff'],
    ['muted text', scales.gray[600], 'a panel', '#ffffff'],
    ['a label', scales.gray[500], 'a panel', '#ffffff'],
    ['a label', scales.gray[500], 'the page', colors.canvas],
    ["a table's heading", scales.gray[500], "its heading's row", scales.gray[50]],
    ['a link', scales.blue[600], 'a panel', '#ffffff'],
    ['a title', colors.ink, 'the page', colors.canvas],
    ["a primary button's text", '#ffffff', 'ink', colors.ink],
    ["an alarm's count", '#ffffff', 'the strong orange', colors['attention-strong']],
    ['a failure', colors.danger, 'a panel', '#ffffff'],
    ['an active pill', scales.green[700], 'its pill', scales.green[100]],
    ['a busy pill', scales.blue[600], 'its pill', scales.blue[50]],
    ['a placeholder', scales.gray[500], 'a field', '#ffffff'],
  ])('reads %s (%s) on %s (%s) at 4.5:1 or more, as WCAG AA asks of small text', (_what, color, _on, background) => {
    expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps Column's orange for the charts, where its 3.3:1 under white text would fail a label", () => {
    expect(contrast('#ffffff', colors.attention)).toBeLessThan(4.5);
  });
});
