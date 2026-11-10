# Judge's-eye review: Dispute Defender demo v2

Reviewed: the 1:58 cut described by `demo/out/demo-v2.json`, its 16 stills, `demo-v2.srt`, the cards, `STORYBOARD.md`, `VOICE_SCRIPT.md`, `devpost_submission.md`, README and ARCHITECTURE. I did not watch the MP4 itself, so motion, pacing and audio are INFERENCE from the manifest and stills. Contrast ratios were not measured. Everything marked FACT is something I read in a file or saw in a still.

THESIS: the product is stronger than the video. The two features no competitor will have, the agent that tells you when to concede and the checker that refuses unsupported sentences, are the two least demonstrated beats in the cut. Fourteen seconds go to setup before any product appears, and 62 of the 180 allowed seconds are unused.

---

## 1. Scorecard (as the video stands, with a normal human voice assumed)

| Criterion | Score | Reason |
|---|---|---|
| Technological Implementation | 6 | A real Claude tool loop, a deterministic rubric and checker, and a visible 26-source trace are non-trivial and credible. The PayPal half is fixtures only, and the video never shows a single real PayPal artifact (call log, debug_id, signature code). Live sandbox would put this at 8. |
| Design | 7 | Clean, consistent teal system with a legible trace and chip-to-source drawer. It loses points for "Unknown buyer" on every live row, zooms that slice cards mid-edge (D shows "Dec / Wait / San / Pay" fragments, E shows a half-card on the left), a static 6.5 s mobile scene, and an empty end card. |
| Potential Impact | 6 | The problem is stated generically ("small sellers lose disputes") with no number, face or stake. The best impact proof is already on screen ($268 at risk across 3 disputes, $32.60 to fight vs $71.50 to concede) but is never narrated as the point. |
| Innovation/Idea | 7 | "Cited sentences plus a checker" and "recommends losing" are distinctive. Neither is shown: the checker is never seen rejecting anything and the concede branch is never shown being taken. Both would earn an 8 or 9 if they were. |
| Presentation | 6 | The flow is end to end and there is a measured badge and a disclosure. The weaknesses are a 14 s generic open, a 12 s disclosure-heavy scene C, a dense 13.6 s architecture card, a mobile scene with 1.6 s of narration in 6.5 s, and claims that are not on screen. |

Estimated total: about 32/50. A decisive win needs 40+, and the changes below are aimed at that.

---

## 2. Top 10 changes, ranked by score gain per effort

Cut target after changes: 2:35 to 2:45. Do not go above 2:50. Leave margin under 3:00 for player intro and encoding.

### 1. Product-first cold open (Presentation, Impact). Re-render only.
Reorder so the product and the payoff appear by 0:04.
- Shorten A1 to 3 s. Cut A2 as a separate AI shot; keep its sentence and move it to 0:15 over the real inbox ($268 at risk visible).
- Lead with a real D-capture fast-forward with a big stopwatch ending on "Draft ready 38 s".
- Fold T into a 1.5 s lockup overlay instead of a 4.75 s card.
- Exact rewrite is in section 3.

### 2. Reconcile every written claim with the video (Honesty, Technological Implementation). Text only.
Several lines in the Devpost, README and narration are wrong or contradict each other. Details are in section 4. In short:
- Devpost "uses real PayPal data" and README "Everything runs against the PayPal sandbox" contradict a fixtures recording.
- Devpost says "4 of 6" where the video shows "5 of 7".
- The voice script and the manifest narration differ in G and K.
- "can't invent facts" overclaims.

### 3. Record the weak case, scene W (Innovation, Impact, TI). Re-capture.
This is the single biggest gap between what Devpost claims ("An agent that recommends losing") and what the video shows.
- Add a fixture dispute, for example an INR with no delivery scan and no signature, so the real agent scores it about 25 to 35. It must be an honest run, not a forced result.
- Capture: strength bar low, "Fight or concede" with `accept claim` or `make offer` highlighted, and the dollar math.
- Place it after G as the twist, 14 s.
- Narration: "Now a weak one. Strength 31. Fighting would cost about $71. Refunding costs $48. It says concede, and it shows its arithmetic." Use the real numbers from the capture.
- On-screen text: "The agent recommends conceding", held 2 s.

### 4. Show the checker actually rejecting a bad sentence (Innovation, TI, Presentation). Re-capture, about 10 s.
`POST /approve` re-checks edited sentences and returns `422 CITATION_FAILED` (ARCHITECTURE line 539), and the draft has an "edit" link per sentence, so this is a real interaction.
- In scene F, click "edit" on the delivery sentence and change "2026-10-31" to "2026-10-29".
- Click Approve and show the rejection state, then restore the text.
- Narration: "Change a date, and the checker refuses. It isn't in the cited source."
- On-screen callout: `422 CITATION_FAILED`.
- Replace the current "can't invent facts" line (see change 2).
- If the UI does not render the 422 legibly, capture it as is first, and have the CTO make the error message readable.

### 5. Make the dollars the point of E (Impact, Presentation). Re-render only, with an overlay.
- Overlay a 64 px label above the panel: "Expected cost to fight: $32.60 / to concede: $71.50".
- Narration: "Fighting this one is expected to cost $32.60. Conceding costs $71.50. It recommends fighting, and shows the formula."
- The accept-claim line reads `$88.00 + $0.00 - $33.00 x 0.5 = $71.50`. The `$33.00` is unlabelled. FACT: I could not find its definition in `src/lib` with a quick grep. Judges who check the arithmetic will stall there. Add a one-word label in the UI or overlay, or take a tighter crop that avoids it.

### 6. Spend 12 to 15 s on PayPal-platform proof (Technological Implementation). Needs a capture. Optional live version below.
Right now the only PayPal evidence is a one-line card. Replace the 13.6 s architecture reading (K) with two shorter beats.
- **a) Activity page, 5 s.** It lists every PayPal call with method, path, status, duration and debug_id. Narration: "Every PayPal call is logged: method, path, status, debug id."
- **b) Code, 4 s.** A 4 s zoom on the raw-body `verify-webhook-signature` code with the comment about raw bytes, or on the Postman collection. This is real engineering that fixtures do not undercut.
- **c) Architecture, trimmed to 6 s.** Keep it in the video with fewer words.
- Without live credentials, the narration must say: "For this recording PayPal's responses are fixtures in PayPal's documented shapes." Do not add "and it also runs on the sandbox" unless change 6-live below is done. README line 308 admits `provide-evidence` still needs confirming with a live call (`npm run smoke:evidence`).

**6-live (founder decision, highest TI payoff).** Roughly 1 to 2 hours: create a developer app and sandbox accounts, then run `npm run smoke:evidence` and create one real sandbox order.
- Capture 8 to 10 s of one real sandbox call with a real `paypal-debug-id` in the Activity page. That lifts TI from about 6 to about 8, and "fixtures" becomes "fixtures for the dispute, live for X".
- Even a partial go-live helps. OAuth, `GET /v1/customer/disputes` and an Orders v2 create work without a buyer. Opening a dispute needs the sandbox buyer's Resolution Center.
- If the founder says no, stay with 6a/6b and the plain disclosure.

How to soften the fixtures cost honestly, in order:
1. Say it once, calmly, with precision, and keep the persistent lower third. Do not apologise repeatedly, because every repetition reads as weakness.
2. Show real artifacts of the integration: code, logs, Postman.
3. Never imply the green submit card hit PayPal (see section 4).

### 7. Trim dead time and rebalance (Presentation). Re-render only.
- C: 13.8 s to 8 s. Move the disclosure sentence to the start of C, delivered once, and keep the lower third.
- I (mobile): either 3 s as a phone inset beside G with a tapped "Approve & submit evidence", or cut. As is, it shows an approve screen but never approves.
- K: 13.6 s to 6 s.
- Reclaimed seconds go to W (14 s), the checker rejection (10 s) and PayPal proof (9 s).

### 8. Fix the visible sloppiness (Design). Mostly re-capture or re-framing.
- Zoom windows must land on card boundaries. D should show the full trace card with the right "Decision / Sandbox / PayPal calls" column intact, or crop to the trace card only. E's left sliver should be removed.
- "Unknown buyer" in the inbox: give the staged disputes buyer names, since the fixture history rows already have names. A sloppy inbox is the first product frame a judge sees.
- Inbox shows "Due in < 48 h: 0", yet the opening claims "the clock is already running". Make the staged disputes' earliest deadline within 48 h so the amber urgency is visible. Narration then lands for free.
- The inbox right-edge sliver is a known issue and not re-reported.

### 9. Memorable close and a stronger end card (Presentation, Innovation). Re-render only.
The end card's bottom half is empty and the subtitle is small gray text. Full rewrite is in section 3.

### 10. Caption and mute-proofing (Presentation). Re-render only.
Many judges watch muted. Captions already exist.
- Raise caption size to at least 44 px and keep the dark pill.
- Keep the lower third at least 24 px.
- Hold the three key numbers on screen for at least 2 s each: 38 s, $32.60 vs $71.50, 9 of 9 grounded.
- Regenerate captions from the final recorded script, because they currently come from the manifest text and not the voice script.

---

## 3. First 15 s and last 15 s, rewritten

### Opening 0:00 to 0:15 (honesty rules intact: AI is mood only, everything else is real capture)

| Time | Picture | VO | On-screen text |
|---|---|---|---|
| 0:00-0:03 | A1 Seedance, night, phone buzzes (mood only, no UI) | "Eleven at night. A buyer opens a PayPal dispute." | none |
| 0:03-0:07 | Hard cut to the real inbox, "Trigger demo dispute" click, stopwatch starts at 0:00 | "Dispute Defender is an AI agent that drafts the answer." | "Dispute Defender" lockup at 56 px, bottom-left, 1.5 s |
| 0:07-0:12 | Real D capture fast-forward; trace lines scroll; stopwatch lands on "Draft ready 38 s"; badge "Sped up 4.5x . real run 38 s" | "Thirty-eight seconds later, a response is ready, and every sentence cites its source." | "38 s" at 96 px, held 2 s |
| 0:12-0:15 | Zoom on the draft, chips S1 to S7 visible | "Here's how it works, and how it knows when to give up." | none |

- The disclosure lower third starts at 0:03.
- "38 s" is the measured `draft_ready_at - clock_started_at` of the real run, which matches the manifest FACT.
- Avoid "answered in 38 seconds". Say "ready", because the seller still approves.

### Closing, last 15 s (replaces J1 narration and Z)

| Time (from end -15) | Picture | VO | On-screen text |
|---|---|---|---|
| -15 to -9 | Real clips, 2 s each: draft chips ("9 of 9 grounded"), E dollar panel, Approve button | "Every sentence cited. Every option costed. Nothing sent until the seller says so." | Three beats at 56 px: "Cited." / "Costed." / "Approved by you." |
| -9 to -5 | J1 Seedance morning, tidy desk (mood only) | "So the seller gets their night back." | none |
| -5 to 0 | End card | "Dispute Defender. The code is linked below." | Logo and name, then tagline 48 px: "Every claim cited. Nothing sent unapproved." Repo URL in mono. Footer: "Built with Claude . PayPal Disputes, Orders v2, Webhooks APIs (fixtures in this recording)" |

- Hold the end card 5 s so the URL is readable.
- Fill the dead lower half: tagline at about y=640, a 3-icon row of "Cited / Costed / Approved" if wanted.
- The tagline claim "every claim cited" is true of the draft sentences, which is what the product enforces. Do not use "invent nothing", which overclaims (section 4).

### Proposed revised order and approximate running time

A1 (3) > inbox/trigger (4) > D ff (5) > draft (3) > problem line on inbox (7) > C disclosure (8) > D (12) > E (12) > F + drawer (12) > F rejection (10) > G approve + PDF (12) > W weak case (14) > H patterns (10) > PayPal proof, Activity + code (9) > K arch (6) > close (15). About 2:20 to 2:40 with transitions. FACT-check the real durations after the re-render.

---

## 4. Honesty and rule risks

Disqualifying-grade first. The rules say the project "must function as depicted in the video".

1. **Devpost and README overstate PayPal integration relative to the recording. HIGH.**
   - README line 15: "Everything runs against the PayPal sandbox."
   - Devpost "It investigates using real PayPal data."
   - Devpost "creates real captured sandbox orders".
   - Devpost "real signature verification".
   - Devpost "the app draws from a pool of staged real disputes".
   - Devpost "records PayPal's debug_id".
   - The video's disclosure says PayPal responses are fixtures.
   - If the founder has never run a live sandbox flow, all of these must be reworded to say that PayPal calls are made by a typed client that is tested against fixtures in PayPal's documented shapes, with a live sandbox path in the README but not demonstrated.
   - If the founder did run live, then the video must show it (change 6-live).
   - README line 308 explicitly says `provide-evidence` evidence types are unconfirmed against live sandbox.
   - Make the Devpost and README consistent with the video before submitting. The video must be the most conservative source, and it currently is the only one that is.
2. **"The agent is real Claude, running live" (scene C).** The agent shown is a real run, but recorded and sped up 4.5x. The badge says so in D; the C sentence does not. Reword to "The agent is real Claude, and what you see next is one real run, sped up." Drop "live".
3. **"so the agent can't invent facts" (F, and J1 "won't invent facts").** The checker verifies that numbers, dates, tracking numbers and quoted strings appear in cited sources. It cannot verify that a sentence's meaning is faithful. A judge or lawyer would call "can't invent facts" overclaiming. Use: "so every number, date and quote in the letter traces to a stored record." J1 line: "Dispute Defender cites every claim, shows you the math, and helps stop the next dispute."
4. **"One click submits the evidence and its PDF packet" (G).** FACT: no still shows a PDF. Rule 4 of the storyboard says to cut any unshown claim. Either capture a 3 s PDF preview (the architecture card says the preview and the submitted file are the same bytes) or cut "and its PDF packet". The VOICE_SCRIPT version already says just "the evidence packet".
5. **The green card "Evidence submitted to PayPal . HTTP 200 . debug_id mock-..." (G).** The narration says "mock PayPal adapter", and "mock-" is in the id, but this is exactly the frame that gets screenshotted, and in a still it reads as a real submission. Add a scene-specific amber lower third on G: "MOCK adapter. Nothing was sent to PayPal." Never use this still in the gallery without that line.
6. **Script drift between the founder's recorded script and the captions.**
   - VOICE_SCRIPT G: "One click submits the evidence packet. Here, it goes to a mock PayPal adapter." Manifest/SRT G: "...evidence and its PDF packet. Here it goes to the mock PayPal adapter."
   - VOICE_SCRIPT K: "a Claude Opus pass is only allowed to reword" vs SRT "an Opus pass may only reword".
   - VOICE_SCRIPT W is not yet in the manifest.
   - Captions will not match the voice. Regenerate the SRT from the final recorded script, or burned-in captions will contradict the audio.
7. **Pattern numbers.** The video shows "5 of 7 SNAD claims on JT-114"; the Devpost and README say "4 of 6". The fifth quote is from the dispute just answered (PP-D-27811), so H's "past disputes" is slightly wrong. Fix the Devpost number, and say "including the one we just answered" in H's narration, which also makes a good beat.
8. **Third-party marks.** No logos appear in the 16 stills (FACT).
   - Text-only mentions: PayPal, Claude, Opus, USPS (in the draft text and tracking), Higgsfield/Seedance/ElevenLabs (disclosure only).
   - Check the Storefront and Checkout button before including any capture of them, because a PayPal button is a PayPal logo.
   - Check the Seedance clips for readable brand marks. The J1 still has gibberish label text, which is fine, but scan every frame for a tape brand or real carrier logo.
   - Confirm the rules' exact trademark wording once, because "Built with Claude" is text and likely fine, but a Claude/Anthropic logo would not be.
9. **Audio.** The macOS "Samantha" voice is a placeholder. Do not ship it. No music is fine and safer than an unlicensed bed.
10. **Repo URL on the end card.** `github.com/ROROK20/dispute-defender` must be public and the README must render before 12:00 PT Thursday. VERIFY at the end.

---

## 5. Devpost gallery and thumbnail

Gallery (in this order):
1. **`07-E-ev.png` dollar panel**, re-cropped wide with a 48 px headline "Fight $32.60 vs concede $71.50". The most distinctive image.
2. **`08-F-draft.png` and `09-F-drawer.png` composite**: draft with chips on the left, the source drawer open on the right, caption "Click a citation, see the record." Strongest proof of the grounding claim.
3. **The new W frame** (weak case recommending concede). If it cannot be captured, use `06-E-strength.png` with its rubric checklist.
4. **`14-K-architecture.png`**. Keep the "sandbox-shaped fixtures" tag visible.
5. **`12-H-pattern.png`**, the prevention story with buyer quotes.

Do not use `11-G-submitted.png` in the gallery without the "MOCK adapter. Nothing was sent to PayPal." line (section 4, item 5). Do not use `04-C-inbox-zoom.png`, which is cropped and has "Not scored" everywhere.

Thumbnail concept (3:2 for Devpost, about 1500x1000, and a 1280x720 version for any video host):
- Left 40%: A1 still, cool blue, desaturated slightly, the seller's face at upper left.
- Right 60%: a crop of the draft with the green S1 to S7 chips sharp and the sentence blurred beyond them.
- Headline, bold sans (Inter 800 or the same system face as the title card), 96 px, white on the dark teal band: "Every sentence cited."
- Subline, 40 px, #9FB4B0: "An AI agent for PayPal disputes."
- Brand mark: the teal "D" icon at 120 px, bottom-right. No PayPal logo, no Claude logo.
- Contrast: white on the dark teal band is well above AA, INFERENCE from the title-card palette; measure when built.

---

## Where this lives next

- The founder owns the live-sandbox decision (change 6-live) and the Devpost/README wording in change 2.
- The CTO owns W (a weak fixture dispute with an honest run), the edit-then-reject capture, the zoom fixes, the buyer names and urgent deadlines, and, if needed, a readable 422 state.
- The CMO owns the final VO wording once these edits are agreed.
