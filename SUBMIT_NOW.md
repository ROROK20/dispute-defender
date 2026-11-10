# Submit DisputeDefender — the shortest path

**Deadline: Thursday Nov 12, 2026, 12:00pm PT (3:00pm ET).** Aim for Wednesday night.
Everything below is yours to do; nothing here has been registered, published, uploaded or submitted for you.

## What is already true (2026-11-10)
- The app builds, typechecks, lints and passes 97 tests; 8 browser tests pass in mock mode.
- **The real agent works with a real model.** With PayPal answers from fixtures and Claude run through the local Claude Code CLI (no API key, no spend), a dispute goes to a cited draft in about a minute. The demo-video run: 9 of 9 sentences grounded. (An earlier run: 48 seconds, 7 tool calls, 17 sources, 8 of 8 grounded, recommendation FIGHT.)
- **A draft demo video is in `demo/out/draft-demo.mp4`** (the older 1:28 cut; the v2/v3 cut is described in `demo/v2/`), recorded from the running production build. It shows a real agent run (sped up and labelled on screen), the cited draft, the evidence score and fight-or-concede math, a one-click submission to the mock PayPal adapter, Claude-mined patterns with verbatim buyer quotes, and the phone view. The red banner and the narration both say PayPal answers come from fixtures. It is not uploaded anywhere. The macOS "Samantha" voice is a placeholder; the plan is the founder's own voice.
- **Never done:** a live PayPal sandbox call. The video therefore cannot show one, and the README, `DEVPOST.md`, `devpost_submission.md` and `devpost_submission.json` claim none. A search of `docs/`, `postman/` and the README found no logged `debug_id` or other record of a live call; the Postman files are request definitions only.
- **Rules risk:** the contest requires the project to function as depicted in the video. The written entry is now kept at or below what the video shows. Do not add a sentence that the video does not back.

## Path A — submit with the draft video (about 25 minutes)
1. **Eligibility (2 min).** Open https://paypalaihackathon.devpost.com/rules. You must be above the age of majority where you live, and not in an excluded country. If you are not eligible, stop here.
2. **Watch the draft video (4 min).** If it is good enough, upload it to YouTube as **Public**. If not, record your own voice over it, or record your screen with `DEMO_SCRIPT.md`.
3. **Repo (2 min).** Say "yes, publish the repo" and the session creates `ROROK20/dispute-defender` as a public repo and pushes it. Or run it yourself:
   ```bash
   cd ~/dispute-defender && gh repo create ROROK20/dispute-defender --public --source . --push
   ```
4. **Devpost (15 min).** Join the hackathon, start a project, and paste each field from `devpost_submission.md`. Add the YouTube and repo links. Read the "AI tools disclosure" section, since it goes out under your name. Submit.
5. **Afterwards.** When results are announced, record the outcome in Apex (History → Confirm a result).

## Path B — show live PayPal sandbox calls (adds about 90 minutes)
Stronger for the "uses PayPal's platform" criterion. You need a PayPal developer account, a sandbox Business and Personal account, and an app. Steps: `docs/sandbox-staging.md`. Put the credentials in `.env` yourself (never in chat), keep `ANTHROPIC_PROVIDER=claude-cli` to avoid an API key, say "creds in", and the session wires the webhook tunnel, runs the live calls, fixes what breaks, and re-records the draft video.

## If you DO complete a live sandbox run: sentences to change

Only after a real call has happened, with a real `paypal-debug-id` you can point to, and only for the parts actually run. Change the same sentence in `README.md`, `DEVPOST.md`, `devpost_submission.md` and the matching key in `devpost_submission.json`.

| Where | Current sentence (mock truth) | Replace with, only if true |
|---|---|---|
| README banner / DEVPOST "What it does" | "...every PayPal call is answered by a mock adapter... We have not run a live PayPal sandbox flow end to end, so nothing below claims one." | "The video's dispute run uses the mock adapter. We also ran [list exactly what: OAuth, GET disputes, Orders v2 create/capture, provide-evidence] against the PayPal sandbox; the Activity page shows the real `paypal-debug-id`s." |
| DEVPOST "It investigates" | "In the demo these tools read PayPal-shaped fixtures; against real credentials they call PayPal." | "[Say which tools were run live.]" |
| DEVPOST step 7 | "In the demo that request goes to the mock adapter, and the id is a mock one." | "[Only if you ran smoke:evidence:] we confirmed `provide-evidence` returns 200 on a sandbox dispute (debug_id ...)." |
| DEVPOST "How we built it" (debug_id line) | "In the demo these are mock-adapter calls with mock ids." | "[Live calls show PayPal's own ids.]" |
| DEVPOST challenges, first bullet | "...we have not executed it, which is why the demo runs on fixtures." | "[Describe the staged disputes you actually opened.]" |
| DEVPOST challenges, `provide-evidence` bullet | "...still need confirming with a live sandbox call." | "[Delete, or say which evidence types you confirmed.]" |
| DEVPOST "What's next" first bullet and Testing instructions last paragraph | "A live PayPal sandbox run... That path has not been run end to end by us." | "[Remove or narrow.]" |
| README Limitations, "No live PayPal run" | "a live sandbox run has not been done." | "[State what was run.]" |
| README section 5 heading and webhook-simulator note | "(not yet run by us)", "(Not yet exercised live by us.)" | "[Remove.]" |

The video must show it too (see `demo/v2/JUDGE_REVIEW.md`, change 6-live). Do not upgrade the text if the video still says "fixtures".

## Honest odds
About 22,900 people registered. A placing is far from certain. Submitting still gives Apex its first real outcome to learn from.
