# DisputeDefender

_A Claude agent built on PayPal's Disputes API. It answers a chargeback minutes after it lands, says when not to fight, and helps stop the next one._

## Slide 1: A chargeback just landed. Watch it get answered before this video ends.

- A live PayPal sandbox dispute, with a stopwatch running on screen
- Webhook → Claude agent → cited evidence → seller approves → PayPal returns 200
- We report the real elapsed time we measured, not a number we picked in advance

**Speaker notes:** Open on the clock, not a logo. One sentence: a chargeback just landed, and you'll watch it get answered before this video ends. Start the stopwatch on screen now and leave it running through the demo. Promise one thing: whatever time it shows at the end is the real measured time, from webhook receipt to provide-evidence returning 200.

**Visual:** Full-bleed dark frame: a large running stopwatch next to a PayPal sandbox notification reading CUSTOMER.DISPUTE.CREATED. A small 'Sandbox demo data' badge in the corner.

---

## Slide 2: Small sellers lose disputes they could have won

- Illustrative seller: runs a store doing about $40k a year, handles disputes alone at night, lost 3 of 5 last quarter
- Loss #1: missed the response deadline
- Loss #2: uploaded a screenshot where a carrier record was needed
- Loss #3: wrote an angry paragraph that didn't match the reason code
- For them a $60 chargeback means a day's margin plus a fee, and enterprise chargeback tools are priced for larger merchants

**Speaker notes:** Tell it as one person's story, and say plainly that this is an illustrative seller profile, not a customer we have. Go through the three ways they lose: missed deadline, wrong evidence type, an emotional reply that doesn't fit the reason code. Don't quote industry statistics; we only claim what we can show. PayPal people on the panel know disputes are among the most painful parts of being a merchant, so let the specific story carry it.

**Visual:** Three cards in a row, each with a small icon: an expired calendar ('Missed deadline'), a blurry screenshot ('Wrong evidence'), an angry speech bubble ('Wrong argument'). A muted portrait silhouette labeled 'Illustrative seller'.

---

## Slide 3: DisputeDefender: a dispute agent that runs inside PayPal

- Triggered by PayPal webhooks the moment a dispute opens, not by a nightly batch
- A Claude tool-use agent gathers the evidence, classifies the reason code and drafts the response
- Every sentence cites its source; the seller clicks Approve once before anything is sent
- It recommends a refund when the evidence is weak, and shows the dollar math
- It finds root causes across disputes to help prevent the next one

**Speaker notes:** Give the product in one breath: it responds, it's honest, and it prevents. Stress that this isn't a document template. It runs on PayPal's own Disputes API, from webhook to provide-evidence. Each of the last three bullets gets its own slide, so just name them here.

**Visual:** Simple left-to-right flow with three labeled stages: 'Respond' (cited evidence PDF), 'Decide' (fight vs refund scale), 'Prevent' (pattern insight card). PayPal sandbox and Claude marks shown as tools in use, no logos changed.

---

## Slide 4: Live demo: from claim to submitted evidence

- Dispute created in the PayPal sandbox → CUSTOMER.DISPUTE.CREATED webhook, signature verified
- Agent trace streams live: pull the dispute and its Orders v2 transaction → tracking → buyer messages
- Classify the reason code → decide fight or refund → draft a response for that reason code with citations
- Evidence PDF built → seller clicks Approve → provide-evidence returns 200
- Stopwatch stops; the PayPal sandbox shows the evidence was received

**Speaker notes:** This is the centerpiece. Run it as one continuous take with the stopwatch visible. Narrate each step of the trace as it streams over Server-Sent Events. Point out the verified webhook signature and the PayPal debug_id in the UI, which prove the calls are real. When provide-evidence returns 200, cut to the sandbox dashboard showing the evidence was received. Read out the actual stopwatch value. Our target is under a minute, but we say whatever we measured. If the webhook is slow, the fallback poll or the dashboard webhook simulator triggers the run, and we say so on screen.

**Visual:** Screen recording: split view with the streaming agent trace (step list with checkmarks and tool-call names) on the left, the drafted response with citation chips on the right, and the stopwatch overlaid top-right. End on a green 'provide-evidence: 200' toast.

---

## Slide 5: It tells you when NOT to fight

- Second demo dispute has weak evidence: no signature, no matching tracking
- Agent recommends accept-claim or make-offer, with the expected-value math beside it
- Plain arithmetic a judge can check: evidence strength score × disputed amount vs. the cost of fighting
- The score comes from a published rubric per reason code, with a breakdown on hover. It is not a trained model and we claim no accuracy figure
- Uses the Disputes API accept-claim and make-offer endpoints, not just provide-evidence

**Speaker notes:** This is the surprise. Most tools push you to fight everything; this one says when you'll probably lose. Hover the strength score to show the rubric: tracking with signature, delivery to the matching address, timestamps on the buyer thread, a policy published before purchase. Call it an evidence strength score, never a win probability, and never imply it was trained on outcome data. Then show the branch hitting accept-claim or make-offer live in the sandbox.

**Visual:** Decision panel: a strength score bar with a rubric tooltip expanded, two buttons side by side ('Approve & Submit' secondary here, 'Accept & refund' primary), and a small worked EV equation underneath, marked 'illustrative'.

---

## Slide 6: It won't make up evidence

- Every sentence links to a tool result: tracking event ID, message ID, policy clause or order field
- An automatic check rejects any sentence without a citation and has the model rewrite it
- Clickable citation chips open the exact source record
- The seller approves before anything is sent. It never submits on its own

**Speaker notes:** Say why this matters: invented evidence in a real dispute is fraud, and it would destroy trust in the product. Show the citation check catching a sentence with no source and sending it back to the model. Click one citation chip to open the PayPal tracking record it points to. The trust feature is also what makes this production-ready.

**Visual:** Close-up of the drafted response: each sentence ends in a small chip (e.g. 'trk_evt', 'msg', 'policy §'). One sentence highlighted red with 'No citation — rewriting'. A popover shows the source record.

---

## Slide 7: From answering disputes to preventing them

- Patterns tab mines root causes across all disputes
- Sample insight (sandbox demo data): '4 of 6 SNAD claims on SKU 114 mention sizing. Update the size chart'
- Prevention actions, for example: add signature confirmation on orders above a threshold the seller sets
- A response bot becomes a dispute-prevention system

**Speaker notes:** Move from one dispute to the whole store. The demo store is Juniper Thread Co., a fictional handmade apparel shop seeded with about 20 SKUs, about 40 real captured sandbox orders and about 12 disputes across all three reason codes. Say clearly that the SKU 114 insight comes from that seeded data. The point is the loop: each dispute it handles makes the next one less likely.

**Visual:** AG Grid pattern table grouped by SKU and reason code. One row expanded showing the SKU 114 insight with a 'Prevention action' card and an 'Update size chart' button. 'Sandbox demo data' badge visible.

---

## Slide 8: Built deep into PayPal's platform

- Disputes API v1: show, provide-evidence (multipart PDF), accept-claim, make-offer, send-message, plus the sandbox-only require-evidence and adjudicate endpoints
- Webhooks (CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED), checked with verify-webhook-signature
- Orders v2 + Checkout JS SDK seed store: every dispute traces to a real sandbox transaction ID
- Add Tracking API: 'not received' evidence comes from PayPal itself
- Claude Sonnet tool-use agent with structured JSON outputs; Claude Opus only for the final review of the response wording

**Speaker notes:** This is for the PayPal engineers on the panel. Count the surfaces: Disputes across six-plus endpoints, Webhooks with signature verification, Orders v2 with the Checkout SDK, and Add Tracking. The sandbox-only require-evidence and adjudicate endpoints let us show the full lifecycle, open to evidence to resolution, in one video. On the AI side there's no framework, just native tool use with structured outputs, so the classification and citation map can be checked by code. Mention the Postman collection in the repo so anyone can replay each call the agent makes.

**Visual:** One architecture diagram: PayPal sandbox (Orders v2, Tracking, Disputes, Webhooks) → Next.js API routes on Render (webhook receiver, agent runner) → Claude tool-use loop → SQLite/Postgres → dashboard via SSE. PayPal calls labeled with endpoint names.

---

## Slide 9: A complete product, not a console log

- Seller inbox: AG Grid dispute queue with deadline countdowns, status pills, strength bars, and grouping by reason code and SKU
- Master-detail rows expand into the full agent trace
- Detail view: timeline, cited draft, PDF preview, one primary action
- Branded evidence PDF: cover letter, timeline, tracking proof, message excerpt, policy clause, a footnote per claim
- Designed empty, loading, error and resolved states; approval works on a phone

**Speaker notes:** This slide covers the Design criterion. Walk the queue: custom cell renderers for countdowns and strength bars, row grouping by SKU and reason code, master-detail into the trace. That's serious AG Grid use, not just a table. Show the PDF judges can download. End on the phone view, because sellers approve from their phones at night.

**Visual:** Laptop mockup of the AG Grid queue beside a phone showing the single 'Approve & Submit' screen. Inset: first page of the evidence PDF with footnoted citations.

---

## Slide 10: What's different

- Templates: generic text, no PayPal connection, the seller still gathers the evidence
- Enterprise chargeback services: priced and built for larger merchants
- DisputeDefender: built on PayPal's Disputes API, starts within minutes of the claim, made for a solo seller
- Four ideas together: built on PayPal's own API, cites every claim, honest about when to concede, prevents the next dispute

**Speaker notes:** Make the contrast, not the claim. We don't say 'AI writes a letter'. The new part is the four ideas together. Keep it to a qualitative comparison with no competitor numbers, since we have none sourced. We also expect few entrants to touch the Disputes API at all, which helps us stand out.

**Visual:** Three-column comparison: Templates / Enterprise services / DisputeDefender. Rows: 'Uses PayPal Disputes API', 'Starts within minutes', 'Cites every claim', 'Recommends conceding', 'Prevents repeats'. Checkmarks only in the last column.

---

## Slide 11: Impact we can show, not claim

- Fixes all three ways the seller loses, each shown on screen: deadline tracked, right evidence type for the reason code, response matched to the reason code
- Measured on screen: time from claim to submitted evidence
- Every required evidence item for the reason code checked off before submit
- Fewer future disputes through the prevention loop
- Path to production: PayPal live credentials and an app marketplace listing (planned, not done)

**Speaker notes:** Tie each piece of impact back to the three losses from slide two. Only quantify what the demo shows: elapsed time, deadline met, evidence checklist complete. The path to production is a plan, so say 'next', never 'launched'. This also lines up with PayPal's interest in fewer escalations and happier merchants.

**Visual:** The three loss cards from slide 2 again, each now marked with a green check and the product feature that fixes it. Below, a small road strip: Sandbox (now) → Live credentials → Marketplace listing (next).

---

## Slide 12: Try it yourself, in one click

- Hosted Render demo: press 'Trigger a demo dispute' and watch the full loop run
- Public repo, MIT license, render.yaml one-click deploy, `npm run setup` seeds the store
- Postman collection and architecture diagram included; AI tools listed in the README
- DisputeDefender: answers the claim, tells you when to fold, prevents the next one

**Speaker notes:** This closing slide is aimed at the Innovation/Idea criterion. Leave judges with the one line: answers the claim, tells you when to fold, prevents the next one. Then invite them to run it themselves with the demo-trigger button. It uses our sandbox accounts and is rate-limited. The repo has a .env.example, an ngrok guide for local webhooks, and gitleaks in pre-commit, so no secrets ship. Name the AI tools: Claude Sonnet for the agent loop and Claude Opus for the final review of the response wording. End on the final stopwatch frame.

**Visual:** Clean end card: the frozen stopwatch showing the real measured time, the hosted demo URL as a button, the GitHub repo URL, and a small 'Sandbox demo data · fictional brand' footer.

---
