# Console design plan: navy and paper

| | |
|---|---|
| **Status** | Direction A chosen by you on 2026-10-22 (the [decision log](decisions.md), decision 22), from two previews of the functions page. **Built the same day,** W-00 to W-06, on the branch `feat/console-redesign`; not merged into `master` yet |
| **Goal** | The console (`FE/`) looks like a calm, exact tool that people trust with their code and their money, and stands apart from the black-and-green look of most developer tools |
| **Scope** | The console only, with no change to the API. The admin app keeps its look until its own turn; the login pages are Keycloak's |

Task numbers start with W, for *web console*.

## 1. Where the console stands

- **Two systems that don't agree.** Most pages use Tailwind's default grays and blues (678 class lists); some use MUI's components (tabs, buttons, text fields, alerts) with MUI's default theme, whose blue and font differ from Tailwind's. Nothing defines FF's own colors or type.
- **A row of nine links across the top,** wrapping on narrow screens, with the balance and the account switcher squeezed beside them.
- **Functions shown as cards** with a "View Details" button each, which doesn't scale past a few functions and hides what matters: status, runtime, memory.
- **Heavy shadows** (`shadow-md`) on every card, 16 px text everywhere, and Inter, the default.

## 2. The direction

This is the contract for the build: each task follows it, and a change to it is a decision of yours.

**North star: [Column](https://column.com/).** A bank's developer platform whose screens look calm and exact, and that people trust with money: the feel FF needs, as a new provider billing in dinars.

**Borrowing:**
- The palette, the type's tight tracking and the soft navy-tinted shadows: from Column.
- The strip of key numbers in cells joined by hairlines, a label above each number: from Column's figures row.
- A light console with 14 px interface text and 6 to 8 px corners: as on [Laravel Cloud](https://laravel.com/cloud)'s product.

**Colors.** Every color comes from Column's site, except where noted; tints and shades between them are derived.

| Role | Value | Where it comes from |
|---|---|---|
| Ink: headings, primary buttons, FF's mark | `#111A4A` | Column's headlines and primary button |
| Text | `#232730` | Column's secondary button text |
| Muted text | `#575A64` | Column's paragraphs |
| Labels | `#6B6E77` | Column's most used text color, `#7C7F88`, darkened for WCAG's 4.5:1 on the page and the panels (W-06) |
| Borders | `#E3E4E8` | Column's borders |
| Page | `#F6F6F8` | Column's muted background |
| Panels | `#FFFFFF` | |
| Links, selected items, focus | Column's blue scale, `#EEF4FB` to `#080B32`; links `#1E4199` | Column's `--color-blue-*` |
| Healthy, active | `#167E6C`, `#44B48B` | Column's teal and green |
| Needs you | `#EC652B` in the charts; `#C4501D` under white text, as an alarm's count | Column's orange; darkened for white text at 4.7:1 (W-06) |
| Failure | Tailwind's red, unchanged | The console's own |
| Warning | Tailwind's amber, unchanged | The console's own; Laravel Cloud's too |

**Type.** Geist, standing in for Column's Suisse Int'l (licensed); Geist Mono, for its Suisse Int'l Mono. Both are open fonts (SIL OFL), served by the console itself. Page titles 28/34 px, weight 600, −3% tracking, in ink; interface text 14/20 px; labels 12/16 px, weight 500; handlers, IDs, ARNs, schedules, logs and code in Geist Mono; figures with tabular numbers.

**Shape.** Corners 8 px for panels, buttons and fields, 6 px for small controls, round for status pills. 1 px borders. Shadows `0 1px 3px rgba(17,26,74,.08), 0 1px 2px rgba(17,26,74,.04)`, and a larger one for menus and dialogs.

**Layout.** A 248 px sidebar on the page color: FF's mark, the account switcher, the pages (Functions, Alarms, Usage, Billing; then the account's: Settings, Notifications, Members, API keys), and at its foot the credit and who is logged in. Content up to 1200 px wide: a breadcrumb, the page's title with its description and actions, then panels. Below 1024 px, the sidebar becomes a top bar with a menu.

**Pages:**
- **Functions:** the key numbers (calls and errors in the last 24 hours, this month's estimate, functions used of the plan's), then a table with search and filters: name and handler, runtime, status, memory, timeout, last change.
- **A function:** its name, status, runtime and handler on top, the tabs underlined in ink, each tab's content in panels; invocations as a table, logs in a mono panel, the charts in the palette's colors.
- **Usage, billing, alarms and the account's pages:** the same header, panels and tables.
- **Create function, onboarding, waiting for approval:** one centered panel.

**Steering away from:** the row of links across the top; cards with a "View Details" button for a list; two blues that don't agree; heavy shadows; the cream-and-green look; purple gradients.

**Inspired by:**
- Column: [column.com](https://column.com/), on [land-book](https://land-book.com/websites/86901-column-the-developer-infrastructure-bank): the palette, the type, the shadows, the key numbers' strip.
- Laravel Cloud: [laravel.com/cloud](https://laravel.com/cloud), on [land-book](https://land-book.com/websites/86897-laravel-cloud): a light console's density and corners.

The other direction shown on 2026-10-22, B, "graphite night", came from [Neon](https://neon.com/): black and graphite surfaces, mono labels, Laravel Cloud's electric blue. It remains a starting point if a dark mode is wanted later.

## 3. How it is built

- **Tokens first, in one place.** `FE/src/theme/tokens.ts` holds the colors, fonts, corners and shadows. Tailwind reads them from `index.css`'s `@theme`, which CSS can't import from TypeScript, so a test keeps both equal.
- **Tailwind's scales become the direction's.** `@theme` redefines Tailwind's gray, blue and green scales with the colors above. Every existing class (`text-gray-500`, `bg-blue-600`, `bg-green-100`) then follows the direction at once, and no page is left in the old colors while the others are redone.
- **MUI from the same tokens.** One MUI theme (`FE/src/theme/mui.ts`): its palette, Geist, the corners, and its tabs, buttons, fields and alerts restyled to match.
- **Fonts from npm:** `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`, bundled by Vite: no request to Google.
- **No API change.** The functions page's numbers come from what the API already answers: `GET /metrics` for the last 24 hours, `GET /usage` for the month's estimate, `GET /me` for the plan's limits. Per-function numbers on the list would take one request per function, so the list doesn't show them.

## 4. Working rules

The other plans' rules: one commit per task, with what was checked in its message; this plan's progress log updated in the same commit; tests for every piece of logic a task adds (filters, the tokens' agreement); the console's tests, linter and build passing at each commit. A design task's evidence is also its screenshots: each page before and after, at 1440 px and at 390 px, against a local copy of the console fed with sample data.

## 5. Tasks

| Task | What | Effort (days) |
|---|---|---|
| W-00 | This plan, the direction, and decision 22 in the decision log | 0.25 |
| W-01 | The tokens and the theme: `tokens.ts`, `@theme` with Tailwind's scales redefined, the MUI theme, the fonts, the console's own classes (`.btn`, `.card`, `.input`); the test that keeps CSS and TypeScript equal | 0.5 |
| W-02 | The shell: the sidebar, the account switcher, the credit and the user at its foot, the top bar with a menu below 1024 px; banners at the top of the content | 0.5 |
| W-03 | The functions page: the key numbers, the table, its search and filters, the empty state | 0.5 |
| W-04 | A function's page: its header, the tabs, the overview, invocations, logs and metrics | 1 |
| W-05 | The other pages: usage, billing, alarms, the account's pages, create function, onboarding and approval | 1–1.5 |
| W-06 | Phone widths, focus and contrast checked on every page; the guide's description of the console | 0.5 |

## 6. Progress log

| Task | Status | Commit | Evidence |
|---|---|---|---|
| W-00 The plan and the direction | ✅ Done | `8fff4cc` | • Two directions researched on land-book (developer platforms, cloud, databases, serverless) and on the live sites of Column, Laravel Cloud, Koyeb and Neon, whose fonts and colors were read from their pages; both previewed on the functions page; A chosen.<br>• Docs: this plan, the [decision log](decisions.md) (decision 22), the docs' index and the README |
| W-01 The tokens and the theme | ✅ Done | `0be984e` | • **As built.** `FE/src/theme/tokens.ts`: Tailwind's gray, blue and green scales as the direction's, the colors with a role (`ink`, `canvas`, `line`, `attention`, `danger`, `warning`), Geist and Geist Mono, the shadows, the corners. `index.css`'s `@theme` with the same values: every class the pages use (`text-gray-500`, `bg-blue-600`, `bg-green-100`, `shadow-md`) follows the direction at once. `FE/src/theme/mui.ts`: MUI's theme from the tokens (its ink, Geist, 8 px corners, tabs in sentence case underlined in ink, outlined cards), around the whole app in `main.tsx`. The console's own classes: buttons in ink or white with a border, cards with a hairline and a soft shadow, fields with a blue focus ring; links and buttons show a focus ring from the keyboard.<br>• **Fonts:** `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` 5.3.0 (SIL OFL), bundled by Vite (29 KB for Latin). npm dropped `sass`'s stale entries from the lockfile at the install: it left `package.json` with the move to Tailwind, and no `.scss` file remains.<br>• **Tests:** `tokens.test.ts`: `index.css`'s `@theme` equals the tokens exactly (changing one color in either fails it, checked), and MUI's theme takes its ink, borders, font and corners from them. Vitest empties CSS unless told otherwise: `vite.config.ts` lets it read `index.css` raw. Console **20 files / 247 tests** (was 245); linter clean; build passes.<br>• **Screenshots** (1440 px, the preview copy with sample data): the functions page, a function, its invocations, usage, billing and alarms, before and after: navy buttons and titles, Geist at 14 px, softer shadows, MUI's tabs in sentence case. The layout is W-02's and W-03's |
| W-02 The shell | ✅ Done | `0cf9efc` | • **As built.** `FE/src/components/Shell.tsx` in place of the header (`NavBar.tsx`, `BalanceBadge.tsx` gone): from 1024 px a 248 px sidebar beside the pages, sticky, with FF's mark, the account switcher (a select, as before, with the role and the account's number under it), the pages with their icons, the open one a white pill in ink, the account's pages under "Account", and at its foot the balance (with the billing trial's tag, and "Add credit" for owners) and who is logged in, or "Development mode". Below 1024 px, a top bar whose menu opens the same sidebar over the page: the keyboard starts on its close button; its button, a click beside it, Escape or a page chosen closes it, and the keyboard goes back to the menu's button. Alarms carries the count of alarms in alarm, in the direction's orange, read again at each page. The banners (an account waiting, the credit) span the pages' column. Neither the sidebar nor the top bar prints.<br>• **Logic, tested:** `lib/navigation.ts`, the pages by role (members and API keys for owners, as the API decides) and which one is open (Functions on the home too; the settings only on their own path, which the other account pages start with); `firingCount` in `lib/alarms.ts`. Console **21 files / 254 tests** (was 247); types, linter clean.<br>• **Checked in the preview copy:** at 1440 px the functions page, a function, billing and the account; at 390 px the top bar and the open menu; the focus on opening, Escape and a page chosen; the pro-forma printed without the sidebar |
| W-03 The functions page | ✅ Done | `3f3fc4f` | • **As built.** `components/Page.tsx`: every page's column (up to 1200 px, the same margins) and its header (breadcrumb, title, description, actions), which W-04 and W-05 bring to the other pages. The functions page: the key numbers in cells joined by hairlines (calls and errors of the last 24 hours with the calls' sparkline and the throttled, from `GET /metrics`; this month's estimate after the free tier, from `GET /usage`, linking to Usage; functions used of the plan's), then the table: name and handler, runtime, status in a pill (`StatusPill`), memory, timeout, code (package and size, or inline), last change, and Delete for those who may change functions, its confirmation naming the function. A search by name and filters by runtime and status, with the count shown; the empty account says how to start, here or with `ff init` and `ff deploy`; a search that finds nothing offers to clear it. Below 768 px the table keeps name, runtime, status and memory and scrolls inside its panel. Runtimes are named without a version, which the API doesn't give. The `.select` class draws the selects as the fields.<br>• **Logic, tested:** `lib/function-list.ts`: the search and filters, the count's words, the statuses' words and tones, when something happened ("5 min ago", the date after a week), the sparkline's points (a day of five-minute points summed into 48). Console **22 files / 269 tests** (was 254); types, linter clean.<br>• **Checked in the preview copy:** at 1440 px against the preview you chose; the search, a status filter, nothing found and clearing it; at 390 px. Found on the way: at 390 px the page scrolled sideways: the hidden "Actions" heading, positioned absolutely, escaped the table's scrolling box; the box is positioned now, and the page is as wide as the screen |
| W-04 A function's page | ✅ Done | `4a5587b` | • **As built.** The function's header on every tab, which only its overview had: the breadcrumb back to the functions, its name, its status in a pill (its error in the pill's title), then its runtime, handler, memory, timeout and code. The tabs underlined in ink under it. The overview: the notices (FF's original event, a function that can't run) as callouts, then the configuration in a panel, its labels now joined to their fields, and beside it two panels, the code (what runs, its size, its SHA-256, its event, its last change) and the function's alarms. The invocations: an Invoke panel, and the history as rows that open, each with its status in words (`INVOCATION_STATUS_INFO`: the two not billed, throttled and lost, say why), when, through what, its duration and memory; opened, its request ID, a link to its logs, and its input, output and error. The logs in an ink panel, their controls as the fields. The metrics: their figures in the key numbers' strip, the charts in panels, in Column's blue, orange and green from the tokens, the grid and axes in the direction's greys. The other tabs (environment, URL, schedules, scaling) are MUI's, which W-01's theme already draws in the direction: they lost only their extra margins. New components for every page: `Panel`, `Callout`, `KeyNumbers` (out of the functions page).<br>• **The charts' colors, validated** with the dataviz skill's `validate_palette.js` on white: lightness, chroma, colour-blind separation 10.9 (target 8), normal vision 26.8 pass; the green's contrast, 2.6:1, asks for a legend and a table view, which the charts have, as with the palette before. Column's darker teal, `#167E6C`, failed the chroma floor (it reads grey), so the green is `#44B48B`.<br>• **Tests:** the invocation statuses' words and tones, and why the two unbilled aren't. Console **22 files / 271 tests** (was 269); types, linter clean.<br>• **Checked in the preview copy** at 1440 px: every tab of a function, a failed function, a history row opened; at 390 px the overview, the page as wide as the screen |
| W-05 The other pages | ✅ Done | `eff29e9` | • **As built.** Usage, billing, alarms, the account's settings, members, API keys, notifications, create function, a new account, waiting for approval, not approved, the login page and the pro-forma's screen: each in the `.page` column, as the functions page; titles in ink at 28 px, the sections' headings as the panels' (15 px, ink); the notices as callouts; the tables as `.data-table` (small grey headings, hairlines between the rows, tabular figures), each cell keeping its padding. Usage's figures and billing's balance in the key numbers' strip; an alarm's state in the console's pills (`StateBadge` draws a `StatusPill`). Create function: its breadcrumb, a description that names `ff deploy`, the form in a panel, runtime, memory and timeout side by side, labels joined to their fields. Every page now starts at the same left edge, the narrow ones too, so that the titles stay put from one page to the next. The printed pro-forma is unchanged.<br>• Console **22 files / 271 tests**; types, linter clean.<br>• **Checked in the preview copy** at 1440 px: usage, billing, alarms, the account, API keys, members, notifications, create function, a new account, the pro-forma, and an account waiting for approval (its `GET /me` answered for one shot) |
| W-06 Phones, focus and contrast; the docs | ✅ Done | `e525e05` | • **Phones:** every page at 390 px, 19 of them (each tab of a function, usage, billing, alarms, the account's pages, create function, a new account, the pro-forma): none scrolls sideways; wide tables scroll inside their panels.<br>• **The keyboard:** 25 stops by Tab on the functions page and on a function's page, each with a visible focus: the blue ring on links and buttons, the blue border on fields, MUI's own on tabs, the account's card around its select.<br>• **Contrast, measured as WCAG does:** Column's label grey, `#7C7F88`, gave 4.0:1 on white, under the 4.5:1 small text needs: gray 500 is now `#6B6E77`, the same grey darkened (5.0:1 on white, 4.7:1 on the page), for labels, tables' headings and placeholders; white on Column's orange gave 3.3:1: an alarm's count is on `#C4501D`, the orange darkened (4.7:1), while the charts keep Column's orange, validated with them. `tokens.test.ts` checks 13 pairs of text and background (text, muted text, labels, links, titles, buttons, the count, failures, pills, placeholders) at 4.5:1 or more; with the old grey it fails 4 of them, checked.<br>• **Docs:** the console's README (the look and where it lives, the balance and the alarms' count in the sidebar, the two UI kits now drawn from the same tokens), the getting-started guide (Settings under Account in the sidebar, the account switcher at its top), `how-it-works.html` (the console's sidebar).<br>• Console **22 files / 286 tests** (was 271); types, linter clean; build passes |
