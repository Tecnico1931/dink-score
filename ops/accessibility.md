# Accessibility and outdoor readability

Target: WCAG 2.2 AA for the app, with the court screen readable in direct sun.

## Display on this phone

Settings button in the top bar, Rules tab ("Display on this phone"), or the sun button on the court screen. Stored in `pb.display` on the device only; nothing is sent to the club.

- **Appearance** (`data-theme` on `<html>`): Match phone (default, follows `prefers-color-scheme`), Light (`data-theme="light"`), or Dark (`data-theme="dark"`). Applied before paint from `pb.display` to prevent a theme flash on reload.
- **Court theme** (`data-palette` on `<html>`): six free per-device court palettes — Court Green (default, attribute omitted), Court Blue (`blue`), Clay Red (`clay`), Indoor Violet (`violet`), Sunset Orange (`sunset`), and Club Slate (`slate`). Stored in `pb.display` on the device only and applied before paint alongside `data-theme` and `data-outdoor`. Team 1 (blue), Team 2 (green), and the optic-lime ball (`#DDF247`) stay locked across every palette so team identity and colour-vision-deficiency separation never degrade.
- **Sunlight contrast** (`data-outdoor` on `<html>`): white page, black text, solid team colours and AAA-grade solid court colours for the active palette (no gradients, glass or see-through text), 2 px outlines on court buttons. Overrides the phone's dark theme and manual appearance choice while preserving the chosen court hue.
- **Large scores** (`data-large`): scores fill the court, names and the score call grow with them.
- **Win celebration** (`pb.celebration`): off by default; optional confetti and chime when a live game ends, honoring `prefers-reduced-motion` (confetti stays off) and per-device mute.
- The sun button on the court turns sunlight contrast and large scores on or off at once.
- **Club TV display and public pages**: the club TV display (`/?display=CODE`) uses always-dark `--dsp-*` tokens driven by the active palette (with `--dsp-dim` tuned to clear 4.5:1) and keeps QR codes black on pure white. Public bracket (`/b/<token>`) and league (`/l/<token>`) pages accept optional `?theme=` and `?palette=` query parameters, falling back to Court Green for unknown palette values.

## What is checked, and how

| Check | Where | Runs |
| --- | --- | --- |
| Contrast of every token pair across light, dark and sunlight modes (and selectable palettes), plus the court's team colours (text 4.5:1, marks 3:1) | `test/contrast.test.js` | `npm test`, CI |
| No text under 12 px in the CSS (tour mini-illustrations excepted: decorative, `aria-hidden`) | `test/contrast.test.js` | `npm test`, CI |
| axe-core (WCAG 2.0-2.2 A/AA + best practice), controls under 44 px, text under 12 px, reflow at 320 and 195 px (200% zoom), focus landing in the winner sheet | `tools/a11y-check.mjs` | by hand: `npm i --no-save puppeteer-core axe-core && node tools/a11y-check.mjs` (needs local Chrome; dev only, never shipped) |

axe cannot measure text over a gradient, which is why the court colours are tested by calculation instead.

## Behaviour worth knowing

- Score changes, toasts, court theme changes and the sun toggle are announced through one live region (`#a11y-live`) that is never redrawn. The court is rebuilt on every rally, so a live region inside it would be dropped.
- The court redraws itself each rally; focus is put back on the control that had it. When the winner or leave-game sheet opens, focus goes to its heading and the court behind is `inert`. The page behind the court is `inert` too.
- Team halves are named from their contents (names, serving, score) plus a hidden "Press when ... wins the rally".
- Reduced motion: a global `prefers-reduced-motion` rule removes transitions and animations.
- Colour is never the only signal: serving, game point and team are text ("Serving", "Game point", team names), not just colour.

## Known gaps

- axe was not run on the Events screens or the public bracket with real data (needs a club or a share token). The shared bracket CSS and tokens are covered by the contrast test.
- The public bracket page's `#pub-name` heading is empty until the data loads.
- The first-run tour's mini-illustrations use 10-11 px text; they are decorative.
- No assistive-technology run (VoiceOver, TalkBack) was done; the checks are automated plus DOM and focus inspection.
