import { createTheme } from '@mui/material/styles';
import { colors, fonts, radius, scales, shadows } from './tokens';

/**
 * MUI's theme, from the console's tokens: the tabs, buttons, fields, cards and alerts MUI draws look as the pages
 * Tailwind draws do, instead of MUI's own blue, Roboto and uppercase.
 */
export const muiTheme = createTheme({
  palette: {
    primary: { main: colors.ink, dark: scales.blue[900], light: scales.blue[600], contrastText: '#ffffff' },
    secondary: { main: scales.blue[600], contrastText: '#ffffff' },
    success: { main: scales.green[600], contrastText: '#ffffff' },
    error: { main: colors.danger },
    warning: { main: colors.warning },
    info: { main: scales.blue[500] },
    text: { primary: scales.gray[800], secondary: scales.gray[600], disabled: scales.gray[400] },
    divider: colors.line,
    background: { default: colors.canvas, paper: '#ffffff' },
    action: { hover: scales.gray[100], selected: scales.blue[50] },
  },
  typography: {
    fontFamily: fonts.sans,
    fontSize: 14,
    h6: { fontSize: '1rem', lineHeight: 1.5, fontWeight: 600, letterSpacing: '-0.01em', color: colors.ink },
    body2: { fontSize: '0.875rem', lineHeight: 1.43 },
    button: { textTransform: 'none', fontWeight: 500 },
  },
  shape: { borderRadius: radius.panel },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: radius.panel } } },
    MuiTabs: {
      styleOverrides: {
        root: { minHeight: 40, borderBottom: `1px solid ${colors.line}` },
        indicator: { height: 2, backgroundColor: colors.ink },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 40,
          minWidth: 0,
          padding: '8px 12px',
          fontSize: 14,
          fontWeight: 500,
          color: scales.gray[600],
          '&.Mui-selected': { color: colors.ink },
        },
      },
    },
    MuiCard: {
      defaultProps: { variant: 'outlined' },
      styleOverrides: { root: { borderColor: colors.line, borderRadius: radius.panel, boxShadow: shadows.sm } },
    },
    MuiAlert: { styleOverrides: { root: { borderRadius: radius.panel, fontSize: 14 } } },
    MuiOutlinedInput: {
      styleOverrides: { root: { borderRadius: radius.panel, backgroundColor: '#ffffff' }, notchedOutline: { borderColor: colors.line } },
    },
    MuiChip: { styleOverrides: { root: { fontWeight: 500 } } },
    MuiTooltip: { styleOverrides: { tooltip: { backgroundColor: colors.ink, fontSize: 12 } } },
  },
});
