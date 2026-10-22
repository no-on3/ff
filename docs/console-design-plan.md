# Console design plan: navy and paper

| | |
|---|---|
| **Status** | Direction A chosen by you on 2026-10-22 (the [decision log](decisions.md), decision 22), from two previews of the functions page. Being built on the branch `feat/console-redesign` |
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
| Labels | `#7C7F88` | Column's most used text color |
| Borders | `#E3E4E8` | Column's borders |
| Page | `#F6F6F8` | Column's muted background |
| Panels | `#FFFFFF` | |
| Links, selected items, focus | Column's blue scale, `#EEF4FB` to `#080B32`; links `#1E4199` | Column's `--color-blue-*` |
| Healthy, active | `#167E6C`, `#44B48B` | Column's teal and green |
| Needs you (alarm counts) | `#EC652B` | Column's orange, used for nothing else |
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
| W-02 The shell | ✅ Done | (this commit) | • **As built.** `FE/src/components/Shell.tsx` in place of the header (`NavBar.tsx`, `BalanceBadge.tsx` gone): from 1024 px a 248 px sidebar beside the pages, sticky, with FF's mark, the account switcher (a select, as before, with the role and the account's number under it), the pages with their icons, the open one a white pill in ink, the account's pages under "Account", and at its foot the balance (with the billing trial's tag, and "Add credit" for owners) and who is logged in, or "Development mode". Below 1024 px, a top bar whose menu opens the same sidebar over the page: the keyboard starts on its close button; its button, a click beside it, Escape or a page chosen closes it, and the keyboard goes back to the menu's button. Alarms carries the count of alarms in alarm, in the direction's orange, read again at each page. The banners (an account waiting, the credit) span the pages' column. Neither the sidebar nor the top bar prints.<br>• **Logic, tested:** `lib/navigation.ts`, the pages by role (members and API keys for owners, as the API decides) and which one is open (Functions on the home too; the settings only on their own path, which the other account pages start with); `firingCount` in `lib/alarms.ts`. Console **21 files / 254 tests** (was 247); types, linter clean.<br>• **Checked in the preview copy:** at 1440 px the functions page, a function, billing and the account; at 390 px the top bar and the open menu; the focus on opening, Escape and a page chosen; the pro-forma printed without the sidebar |
