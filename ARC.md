# Arc components in Agent Santé

The UI uses free Arc items (MIT, https://uiarc.dev) for every part where Arc has an item.
Arc items live in `src/components/arc/`. Do not edit them, except
for the local changes listed below. Each local change has a `Local change (Agent Santé)` comment.

## Install

```sh
yes n | pnpm dlx shadcn@latest add @uiarc/segmented-control @uiarc/drawer \
  @uiarc/checkbox @uiarc/button @uiarc/alert @uiarc/text-shimmer @uiarc/badge @uiarc/empty-state \
  @uiarc/chat-thread @uiarc/skeleton \
  @uiarc/metric-card @uiarc/switch @uiarc/popover @uiarc/accordion @uiarc/input @uiarc/slider
```

`yes n` answers "no" to each overwrite prompt. A reinstall with `--overwrite` removes the local changes.
After an add, run `git diff src/components/arc` and put the local changes back.

## Map

| UI part                                                           | Arc item                                                    | Where                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| Language toggle                                                   | `segmented-control`                                         | `src/shell/Header.tsx`                        |
| Navigation menus (wide screens), display options                  | `popover`, `switch`                                         | `src/shell/Header.tsx`, `src/shell/DisplayMenu.tsx` |
| Navigation menu (phones)                                          | `drawer` (`side="right"`)                                   | `src/shell/Header.tsx`                        |
| Consent gate (the consents as agent messages, one button to accept each) | `chat-thread` (`ChatThread`), `button`               | `src/gate/Gate.tsx`                           |
| Buttons                                                           | `button`                                                    | everywhere                                    |
| Gate errors, PII block, network errors, conversation ended        | `alert` (one alert that changes tone)                       | `src/gate/Gate.tsx`, `src/chat/Chat.tsx`      |
| Chat log and bubbles                                              | `chat-thread` (`ChatThread` with `composer={false}`)        | `src/chat/Chat.tsx`                           |
| Message box                                                       | `chat-thread` (`ChatComposer`, `allowAttachments={false}`)  | `src/chat/Chat.tsx`                           |
| Typing indicator                                                  | `chat-thread` `typing` prop                                 | `src/chat/Chat.tsx`                           |
| Label of the running step in the live activity list               | `text-shimmer`                                              | `src/chat/ActivityTimeline.tsx`               |
| Session expired, page not found                                   | `empty-state`                                               | `src/chat/Chat.tsx`, `src/pages/NotFound.tsx` |
| Source domain on each source chip                                 | `badge`                                                     | `src/chat/AssistantReply.tsx`                 |
| Source domain on each official quote card                         | `badge`                                                     | `src/chat/AssistantReply.tsx`                 |
| Loading the config                                                | `skeleton`                                                  | `src/app/App.tsx`                             |
| Live emergency-room and 811 figures, transparency counters        | `metric-card` (with `animated-counter`)                     | `src/home/LiveContext.tsx`, `src/pages/TransparencyPage.tsx` |
| Transparency costs (totals, averages, yearly projection)          | `metric-card` (with `prefix`, `decimals`)                   | `src/pages/CostsSection.tsx`                  |
| Share of 811 calls in the cost projection                        | `slider`                                                    | `src/pages/CostsSection.tsx`                  |
| Display options (simple language, large text)                     | `popover` + `switch`                                        | `src/shell/DisplayMenu.tsx`                   |
| 811 options                                                       | `accordion`                                                 | `src/pages/Call811Page.tsx`                   |
| 811 "have ready" list                                             | `checkbox`                                                  | `src/pages/Call811Page.tsx`                   |
| Urgent first ("is it urgent?"), capacity and maintenance notices  | `alert`                                                     | `src/pages/Call811Page.tsx`, `src/gate/Gate.tsx`, `src/chat/Chat.tsx` |
| Maintenance page, conversation ended by the person               | `empty-state`                                               | `src/home/Maintenance.tsx`, `src/chat/Chat.tsx` |
| End button, mic button, recording bar buttons, voice bubble Retry and "Type instead" | `button` | `src/chat/Chat.tsx`, `src/chat/VoiceMessage.tsx` |
| "Transcription…" on the audio bubble                              | `text-shimmer`                                              | `src/chat/VoiceMessage.tsx`                   |
| Suggested answers of an agent question                            | `button` (secondary; primary with a check when chosen)      | `src/chat/QuestionCard.tsx`                   |
| "Autre réponse…" field of an agent question                      | `input`                                                     | `src/chat/QuestionCard.tsx`                   |

Not used, and why:

- `toast-stack`: the offline and network states show in the one `alert` above the message box. A toast would be
  a second place for the same message.
- `dialog`: the gate must not close on Escape or on an outside tap.
- `chip-group`: a suggested question is an action, not a filter. It is a secondary `button`.
- `radio-group`, `segmented-control`, `button-group` for the suggested answers of a question: a click sends the answer at
  once, so each answer is an action (`button`), not a selection. `button-group` joins the buttons in one row, and a long
  answer does not fit on a phone.
- Pro items (`ai-chat` and others): English-only strings and features we do not need. The repo stays free of a Pro token.
- `voice-orb` (Pro): a voice mode with audio levels and speech output. We need only a voice message.
- `voice-recorder` (Pro): record, review and scrub before send. It is the closest item, but it is Pro, and
  a voice message here goes on Send with no review step (the transcript is the review).
- `onboarding-checklist`: for setup tasks with progress in an app. The 811 list is a short set of `checkbox` items.
- `stats-band`: marketing numbers that count up. The figures here need a source line and a date, so `metric-card`.

## Custom parts (Arc has no item)

| Part                                 | File                                   | Why                                                                                |
| ------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------- |
| Skip links                           | `src/shell/shell.module.css` (`.skip`) | No Arc item. About 15 lines on Arc tokens.                                         |
| Header layout                        | `src/shell/Header.tsx`                 | `site-header` is a marketing navbar with a mega menu.                              |
| Turnstile widget                     | `src/gate/Turnstile.tsx`               | Cloudflare widget, explicit render, follows theme and language.                    |
| Help numbers list                    | `src/gate/EmergencyList.tsx`           | A list of `tel:` links. No Arc item fits.                                          |
| Source chips and Markdown reply      | `src/chat/AssistantReply.tsx`          | No free "source card". Links plus `badge`. Only official domains are links.        |
| Official quote card                  | `src/chat/AssistantReply.tsx` (`CitationCard`), `.citation` in `chat.module.css` | Arc has no quote item (free or Pro). `card` is a grid item with a quick look dialog. A `<figure>` with `<blockquote cite>` and a `<figcaption>` label, on Arc tokens, with the Arc `badge` for the source host. Plain text only. |
| Ended state call buttons             | `src/chat/Chat.tsx` (`.endCall`)       | Two `tel:` links. `button` renders a `<button>`, and a phone call is a link.       |
| Static pages (about, privacy, terms) | `src/pages/StaticPage.tsx`             | Arc has no article or prose item.                                                  |
| Router                               | `src/app/router.tsx`                   | Nine static paths. Same-origin links navigate in place, so a conversation survives. |
| Architecture diagram                 | `src/pages/PressPage.tsx`              | Inline SVG on theme tokens (light and dark). Arc has no diagram item.             |
| Counters by day table                | `src/pages/TransparencyPage.tsx`       | A plain semantic `<table>`. The Arc data table is Pro and has features we do not need. |
| "Prepare your 811 call" link card    | `src/home/LiveContext.tsx`             | One link. `card` is for browsable grids with a quick look.                       |
| Places list and Clic Santé card      | `src/chat/Attachments.tsx`, `src/chat/places.module.css` | Arc has no free location list or result card. A bordered surface on Arc tokens: the map on top, then a compact list (rows of about 56 px, name in title case, distance, address, a small open or closed status) that scrolls inside the card. A row opens to show the services and the official page, and selects its marker; a marker selects its row (`aria-current`). The Clic Santé action is a link styled like the primary `button`, because it opens another site. |
| Places map                           | `src/chat/PlacesMap.tsx`               | Apple MapKit JS. Always shown above the list when the host has a token, in a box of fixed height (220 px phone, 280 px desktop) so nothing moves when it loads. "Agrandir la carte" makes it taller. Hidden from screen readers: the list is the accessible content. |
| Voice message (recording bar, audio bubble) | `src/chat/VoiceMessage.tsx`, `src/chat/voice.module.css` | The only Arc recorder (`voice-recorder`) is Pro. The bar has the height and the radius of the Arc composer box and reuses the Arc `button`; the send control copies the ready send button of the composer. The bubble uses the own-message accent. The red dot pulse and the bar transitions run only with `prefers-reduced-motion: no-preference`; the live level bars still update (they are information). |
| Question card                        | `src/chat/QuestionCard.tsx`, `src/chat/question.module.css` | Arc has no free "question with suggested answers" item. A `fieldset` (group role, the question is the `legend`) on a bordered surface like the quote card, with Arc `button` and `input` inside. Focus moves to the card when it appears (`tabindex="-1"`, no ring from code focus). A locked card keeps its layout: the buttons and the field stay, only their state and the field label change, so the thread does not bounce. On touch, the field text is 16 px, so iOS does not zoom. |
| Activity step list (live and in the summary) | `src/chat/ActivityTimeline.tsx`, `src/chat/activity.module.css` | The Arc items for agent steps (`tool-call`, `agent-status`, `agent-run`, `agent-timeline`) are Pro. The free `timeline` is a newest-first feed grouped by day with no running state, and `stepper` is for fixed steps. A group header (marks of the steps, count, time) that opens to one row per step (mark, label, duration, a spinner or a tick that draws itself). Written from scratch on Arc tokens and motion presets (`spring.smooth`), with a reduced-motion branch. No Pro code. |

## Local changes

1. `chat-thread`: `renderText` prop (an agent reply renders as Markdown with sources, full width).
2. `chat-thread`: composer `fill(text)` on the ref (suggested questions, and a blocked message goes back in the box).
3. `chat-thread`: no reaction button without `onReact`.
4. `chat-thread`: the `log` role moved from `<ol>` to a wrapper `<div>`. axe reported `aria-allowed-role` and `listitem`.
5. `chat-thread` CSS: optional `--chat-column` width and the `.rich` row style.
6. `segmented-control`: optional `lang` per option (WCAG 3.1.2, language of parts: "English" on a French page).
7. `drawer`: radii on `--radius-panel` (one radius for every surface, see `theme.css`).
8. `metric-card`: optional `locale` prop, passed to `animated-counter` (fr-CA groups digits as "4 401").
9. `chat-thread`: `typingDetail` prop, a block under the typing bubble (the live activity steps). It is hidden from
   screen readers like the typing row; `typingStatusLabel` gives one polite line per phase instead.
10. `chat-thread` pinning (no bounce): the content springs up by the distance the scroll really moved,
    not by the growth of the content. So a thread shorter than the screen does not jump at each new line.
    The transform is also written at once, so the frame after the scroll does not flicker. A new reply
    that is taller than the thread stops the pinning and shows from its start.
11. `chat-thread` motion: a row arrives with opacity and a short rise (no scale, no side slide). The typing row is
    outside `AnimatePresence`: it leaves in the same frame as the reply arrives, so the swap is one layout change.
    Its entrance is a tween with no overshoot.
12. `chat-thread`: `failedStatusOnly` prop. Agent Santé shows the "Sent" line only for a failed message. A line that
    moves to the next message at each send makes the thread jump by its height.
13. `chat-thread`: `accessory` prop on `ChatComposer`, a control before the text box (the mic button).
14. `chat-thread`: `renderOwn` prop, draws one of the person's own messages in place of its text bubble (the
    audio bubble). It returns null for the default bubble. The voice message and its transcript share the
    row key (the message id), so the text replaces the bubble in place.

To measure the layout shift, run `node scripts/layout-shift.mjs` (dev server with fake upstreams; `REDUCED=1` for
reduced motion). With these changes, a turn does not move the person's own message, and the layout shift is 0.

## Checklist exceptions

The Arc checklist sweeps pass, with three exceptions on purpose:

- `.main:focus { outline: none; }` in `src/app/app.module.css`. `main` takes focus only as the skip link target.
  A ring around the whole page does not help.
- `.skip:focus-visible` shows the skip link. It is not a focus ring.
- `--page-wash` in `src/styles/theme.css` is one faint radial wash behind the first screen. It is a page
  backdrop, not a gradient inside a component.

Both themes pass WCAG AA for every token pair.
