# Demo Video Script — 3:00 limit, as the brief states it

**DisputeDefender: A PayPal Dispute Answered Live, With Every Claim Cited**

> The brief's own words: "Demo video under 3 minutes, publicly visible on YouTube, showing the project running on its target device, with no unlicensed third-party trademarks/music"

> Written for YOU to read aloud while you record your own screen. The engine generates no audio or video, ran nothing to make this file, and uploaded nothing. The platform's own rules override this file.

**Runtime estimate: 2:46 — within the 3:00 limit (0:14 to spare).**

Method: 389 narration words ÷ 150 words per minute = 2:36 of speaking, plus 0:10 of pauses the script lists for clicks and page loads (a pause is on-screen time with nobody speaking). It is an estimate: read the script aloud once with a timer.

## Scene 1 — The problem  ·  0:00–0:20

**On screen:** DisputeDefender inbox with the 'Sandbox demo data' badge visible. The AG Grid dispute queue shows deadline countdown cells, status pills and evidence strength bars for Juniper Thread Co. disputes.

**Say:**

> A chargeback just landed. Watch it get answered before this video ends. Picture a small seller who handles disputes alone at night. They lose cases they could win in three ways: a missed deadline, the wrong type of evidence, or an angry reply that ignores the reason code.

_48 words ≈ 0:19 speaking_

## Scene 2 — Dispute opens, agent gathers sources  ·  0:20–0:49

**On screen:** PayPal sandbox: a dispute is opened against a real captured order from the Juniper Thread Co. seed store. Switch to the dispute detail view: the CUSTOMER.DISPUTE.CREATED event appears marked as signature verified, the stopwatch starts, and the live trace panel streams tool calls (show dispute, Orders v2 capture, tracking, buyer messages), each stored as source S1, S2, S3 and so on.

**Say:**

> This is DisputeDefender, built on the PayPal Disputes API. A buyer opens a dispute in the sandbox against a real order from our demo store, Juniper Thread Co. The dispute-created webhook arrives, its signature is verified, and the stopwatch starts. A Claude tool-use agent pulls the dispute, the Orders v2 capture, the tracking and the buyer messages. Each result is stored as a numbered source.

_65 words ≈ 0:26 speaking + 3s pause_

## Scene 3 — Cited draft, approval, submission  ·  0:49–1:25

**On screen:** Evidence strength score with its breakdown shown on hover. The expected-value panel shows the formula with its values filled in and the decision: fight. The draft response has citation chips on every sentence, and clicking one opens the source drawer. The citation check step appears in the trace. PDF preview of the evidence packet. The seller clicks 'Approve & Submit'. The trace shows provide-evidence returning 200 with its PayPal debug_id. The stopwatch stops at the measured time.

**Say:**

> It scores the evidence against a published rubric for this reason code, then decides on expected value whether to fight. Here it fights. Every sentence in the draft cites a source. A deterministic checker rejects any sentence whose numbers, dates or quotes don't appear in its sources. If a repair fails, the sentence is removed. Then the evidence PDF is built. Nothing goes to PayPal until I approve. One click, and provide-evidence returns 200. The stopwatch shows the real elapsed time.

_81 words ≈ 0:32 speaking + 4s pause_

## Scene 4 — When not to fight, and preventing the next dispute  ·  1:25–1:52

**On screen:** A second dispute with weak evidence: low strength score, and the decision panel recommends accept-claim or make-offer, with the dollar math shown beside the 'Accept & refund' button. Then the Patterns page: disputes grouped by SKU and reason code, an example pattern for SKU 114 about sizing with its verbatim buyer quotes, and a prevention action to update the size chart.

**Say:**

> Now a weak case. The agent recommends accepting the claim or making an offer, and shows the dollar math. The AI cannot override that math. The Patterns page groups disputes by product and reason. In this example, four of six not-as-described claims on SKU 114 mention sizing, so the fix is the size chart. Each pattern keeps the buyers' exact quotes.

_61 words ≈ 0:24 speaking + 3s pause_

## Scene 5 — How it is built  ·  1:52–2:21

**On screen:** Architecture diagram from the README: webhook receiver with poller fallback, Claude agent runner, citation checker, Opus review pass, scoring, PDF builder, submission service and pattern miner, connected to the PayPal Disputes, Orders v2, Add Tracking and Webhooks APIs. A list of logged PayPal calls with their debug_ids.

**Say:**

> It is one Next.js app with an AG Grid inbox. Claude Sonnet runs the agent, and a Claude Opus pass is only allowed to reword sentences. React PDF renderer builds the packet, and the data lives in SQLite. On the PayPal side it uses Orders v2, Add Tracking, Webhooks and the Disputes API, from provide-evidence to accept-claim and make-offer. Every PayPal call is logged with its debug ID.

_72 words ≈ 0:29 speaking_

## Scene 6 — Why it matters, and close  ·  2:21–2:46

**On screen:** The approval view on a phone-width screen, then the 'Trigger demo dispute' button and the public repo link.

**Say:**

> It uses PayPal's platform and AI in depth. It is a complete product a seller can approve from their phone, it solves a real problem for a specific audience, and it does something new: it won't invent facts, it tells you when you'll lose, and it helps prevent the next dispute. This is DisputeDefender. The code and setup steps are at the link below.

_62 words ≈ 0:25 speaking_
