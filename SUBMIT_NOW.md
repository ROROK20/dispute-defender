# Submit DisputeDefender — the shortest path

**Deadline: Thursday Nov 12, 2026, 12:00pm PT (3:00pm ET).** Aim for Wednesday night.
Everything below is yours to do; nothing here has been registered, published, uploaded or submitted for you.

## What is already true (2026-11-10)
- The app builds, typechecks, lints and passes 97 tests; 8 browser tests pass in mock mode.
- **The real agent works with a real model.** With PayPal answers from fixtures and Claude run through the local Claude Code CLI (no API key, no spend), a dispute went to a cited draft in 48 seconds: 7 tool calls, 17 sources, 8 of 8 sentences grounded, the Opus review applied, recommendation FIGHT.
- **A draft demo video is in `demo/out/draft-demo.mp4`** (1:28, captions in `draft-demo.srt`), recorded from the running production build by `scripts/record-demo.ts` with the macOS Samantha voice. It shows a real agent run (63 s, sped up and labelled on screen), the cited draft, the evidence score and fight-or-concede math, a one-click submission to the mock PayPal adapter, Claude-mined patterns with verbatim buyer quotes, and the phone view. The red banner and the narration both say PayPal answers come from fixtures. It is not uploaded anywhere. Re-record any time: the commands are at the top of the script.
- **Never done:** a live PayPal sandbox call. The video therefore cannot show one.

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

## Honest odds
About 22,900 people registered. A placing is far from certain. Submitting still gives Apex its first real outcome to learn from.
