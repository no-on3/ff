import { describe, expect, it } from 'vitest';
import css from '../index.css?raw';
import { muiTheme } from './mui';
import { colors, fonts, radius, themeVariables } from './tokens';

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
