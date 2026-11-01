# Demo runbook

Target length: under 2:45. Captions on throughout. Voiceover recorded separately. Music original or royalty-free. Fictional brands and people only.

## Rule zero

**The stopwatch shows measured times only.** Every time on screen comes from `agent_runs.clock_started_at`, `draft_ready_at` and `finished_at`. If the run took 70 s, we say 70 s. We never edit the clock, speed up the footage silently, or quote a time from another take.

## Before recording

- [ ] At least 4 disputes in the pool (`GET /api/demo/pool`), including one strong INR (JT-107) and one weak UNAUTHORISED (JT-111).
- [ ] `GET /api/health` shows `mock: {paypal:false, anthropic:false}` and `webhook_id_set: true`. No red MOCK MODE banner on screen.
- [ ] Patterns recomputed (`POST /api/patterns/recompute`) so the JT-114 sizing card is present.
- [ ] Browser zoom 110%, notifications off, a clean profile with no other tabs.
- [ ] Sandbox buyer logged in at sandbox.paypal.com in a second window.
- [ ] Render instance awake (load `/api/health` once; free services sleep after 15 min).

## Script

| Time | Screen | Voiceover (gist) |
|---|---|---|
| 0:00–0:15 | Seller inbox, empty-ish, evening light | One seller, a $40k/yr store, lost 3 of 5 disputes last quarter: a missed deadline, the wrong evidence, an angry paragraph. |
| 0:15–0:25 | Buyer window: open an INR dispute on the JT-107 order | "A chargeback just landed. Watch it get answered before this video ends." |
| 0:25–0:35 | Inbox: webhook row appears, stopwatch starts | Signed webhook, verified with PayPal. The clock starts at receipt. |
| 0:35–1:05 | Detail view: live agent trace | It pulls the dispute, the order, PayPal tracking and the buyer thread, then scores the evidence against a published rubric. |
| 1:05–1:20 | Draft with citation chips; open one source | Every sentence links to the tool result behind it. Sentences that cannot be traced are removed and listed. |
| 1:20–1:30 | PDF preview | The packet PayPal will receive, one footnote per citation. |
| 1:30–1:45 | Approve → `provide-evidence` 200 with debug_id; stopwatch stops | One approval. The stopwatch shows the measured time, including my approval. |
| 1:45–2:00 | Weak UNAUTHORISED dispute: decision panel recommends accept-claim, EV math visible | It also tells you when not to fight, in dollars. |
| 2:00–2:15 | Patterns tab: "4 of 6 SNAD claims on JT-114 mention sizing" | Counted by code, quotes checked against the messages. Fix the size chart, prevent the next one. |
| 2:15–2:40 | Architecture diagram, list of PayPal APIs, AI tools disclosure, hosted URL | Disputes API, Orders v2, Add Tracking, Webhooks; Claude Sonnet agent, Opus review; seller approval always. |

## Three-take protocol

1. Record three complete takes back to back, each on a **fresh** dispute from the pool.
2. After each take write down the run id and the two stopwatch readouts (draft ready, submitted) from the detail view.
3. Choose the best take on clarity, not on time. Use its real times in the video, the README and the Devpost text.
4. If a take fails (PayPal 5xx, agent error), keep the footage and the debug id; do not splice another take's clock into it.

## After recording

- Export the run ids and times into `DEVPOST.md`.
- Cut the README GIF from the chosen take (0:25–1:45).
- Restock the pool if the hosted demo will stay up for judges.