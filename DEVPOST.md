## Inspiration

A chargeback just landed. Watch it get answered before this video ends.

That sentence is the whole pitch, and it comes from a specific person. Picture a solo seller running a small handmade-apparel store on PayPal (a hypothetical, not a real customer). They handle disputes themselves, at night, after the packing is done. For a store like that, a $60 chargeback can cost a day's margin plus a fee. When they lose a case they could have won, it's usually for one of three reasons:

1. **They miss the response deadline.**
2. **They send the wrong kind of evidence**, like a screenshot where PayPal wanted a carrier record.
3. **They write an angry paragraph** that doesn't address the reason code the buyer filed under.

None of these is about who was right. They happen because the seller has no time to learn what each reason code needs, and enterprise chargeback tools are priced for much bigger merchants. PayPal already has a full Disputes API for this job. We wanted to see what happens when an agent works through that API for the seller, honestly, within minutes of the claim.

## What it does

**DisputeDefender** is a dispute agent for small PayPal sellers. It's built directly on PayPal's Disputes API, not on a document template.

**1. It wakes up when the dispute does.** A `CUSTOMER.DISPUTE.CREATED` webhook arrives, and we check its signature against PayPal's `verify-webhook-signature` endpoint. A stopwatch starts on screen at that moment. If webhook delivery is slow, a poller that runs every 30 seconds catches any new dispute in `WAITING_FOR_SELLER_RESPONSE`.

**2. It investigates using real PayPal data.** A Claude tool-use agent pulls:
- the dispute
- the Orders v2 capture and order
- the PayPal tracker for the shipment
- the buyer's message thread
- the store's policies
- the SKU record

Every step streams live into a trace panel. Every tool result is stored as a numbered source (`S1…Sn`).

**3. It scores the evidence with a rubric you can read.** The evidence strength score (0–100) comes from a fixed rubric per reason code, written in code rather than by a model. For "item not received", for example:
- tracking attached in PayPal: 25
- carrier shows delivered: 30
- delivery ZIP matches the ship-to address: 20
- signature captured: 15
- shipped before the buyer's claim date: 10

Hover over the score to see which items are present and which sources prove them. We don't call this a trained win probability, because it isn't one.

**4. It tells you when *not* to fight.** Plain arithmetic compares three options: fight, accept the claim, or make a partial offer. For example, the cost of fighting is `(1 − s)·(A + F) + T`, where `s` is the strength score, `A` the disputed amount, `F` the dispute fee and `T` the value of the seller's time. The formula is shown with the real values filled in. If the evidence is weak, the agent recommends `accept-claim` or `make-offer` and shows the dollar math. Claude can explain the recommendation but cannot override it.

**5. It cannot submit a claim it can't back up.** The response letter is a list of sentences, and each sentence must cite at least one stored source. A deterministic checker also requires every number, date, tracking number and quoted string in a sentence to appear in the text of a source it cites. A sentence that fails goes back to the model with the reason, for up to 2 repair rounds. If it still fails, it's removed and listed in the UI as "removed, unsupported".

**6. It builds a professional evidence packet.** The PDF contains a cover letter, timeline, tracking proof, a message excerpt, the policy clause, and one footnote per citation. Our target size is under 500 KB.

**7. Nothing goes to PayPal without one click from the seller.** The seller reviews the draft, can click any citation chip to see its source, and taps **Approve & Submit**. Before calling PayPal, the app fetches the dispute again and checks four things:
- the status is still `WAITING_FOR_SELLER_RESPONSE`
- the deadline hasn't passed
- every evidence type is allowed for that reason code
- the file is under 10 MB

Then it sends a multipart `provide-evidence` request and records PayPal's `debug_id`. Nothing is ever submitted automatically.

**8. It helps prevent the next dispute.** The Patterns page groups disputes by SKU and reason code. Claude tags each buyer message with a theme from a closed list (such as `sizing` or `color_mismatch`). Our code, not the model, counts the tags. In our labeled fixture history, the result reads: *"4 of 6 SNAD claims on JT-114 mention sizing. Update the size chart for JT-114."* ("SNAD" means significantly not as described.) Each pattern stores the buyer's exact words, and we check every quote against the original message. A bot that only answers disputes becomes a system that helps prevent them.

The inbox is an AG Grid table of every dispute, with deadline countdowns, status pills, strength bars and recommendations. Each row expands into that dispute's full agent trace.

## How we built it

**PayPal is the backbone, not an add-on.** We use the sandbox across several parts of the platform:

- **Disputes API v1:** list and show, `provide-evidence` (multipart form with JSON and a PDF), `accept-claim`, `make-offer`, `send-message`, plus the sandbox-only `require-evidence` and `adjudicate` endpoints. These let us run the whole lifecycle on camera: open, evidence, resolution.
- **Webhooks** for dispute created, updated and resolved, with real signature verification.
- **Orders v2 + Checkout JS SDK** (`@paypal/react-paypal-js`). A small fictional storefront, "Juniper Thread Co.", creates real captured sandbox orders, so every dispute traces back to a real PayPal transaction ID.
- **Add Tracking API** (`/v1/shipping/trackers-batch`). Tracking gets attached when an order is captured, so "item not received" evidence comes from PayPal's own records.

Every PayPal call is logged with its method, path, status, duration and `paypal-debug-id`. The Activity page lists them all.

**The agent** is a tool-use loop written directly against the Anthropic SDK, with no agent framework.
- **Claude Sonnet** runs the loop and tags pattern themes.
- **Claude Opus** does one final review of the wording. It may only reword sentences, keeping the same sentence IDs and citations, and its output goes back through the citation checker. If any sentence then fails, we discard Opus's version and keep the Sonnet draft.
- The loop ends with a required `submit_analysis` tool call, validated with zod. Limits: at most 12 model turns and a 90-second wall-clock budget. Every step is written to the database before it is streamed to the browser.

**The stack:**
- **App:** Next.js (App Router) with Tailwind, on Node.js 22.
- **Live trace:** Server-Sent Events stream the agent's steps to the browser.
- **Data:** SQLite (better-sqlite3) holds disputes, agent runs, steps, sources, decisions and PayPal calls.
- **PDF:** `@react-pdf/renderer` builds the evidence packet.
- **Grid:** AG Grid Community.
- **Hosting:** Render, with a `render.yaml` blueprint, gives judges a stable HTTPS URL for webhooks and a clickable demo.
- **Replay:** a Postman collection lets anyone repeat each PayPal call the agent makes.

**Order of work.** First we got a hand-made PDF accepted by `provide-evidence` with a 200 response. Only then did we start on the AI. The rest followed in order: real orders and webhooks, the agent with citations, scoring and the inbox, then patterns and polish.

## Challenges we ran into

- **You can't create a dispute through the API.** Every real dispute has to be opened by a sandbox buyer in the sandbox Resolution Center, against an order paid with the PayPal wallet. We wrote a staging runbook (`docs/sandbox-staging.md`) and keep a pool of pre-staged real disputes. The "Trigger demo dispute" button takes the oldest real one from that pool. It is labeled "Demo trigger (not a PayPal webhook)". If the pool is empty, it returns 409 with restocking instructions and never fakes a dispute.
- **The webhook simulator can't drive the full flow.** Its events carry fake resource IDs, so they fail signature verification and return 404 when we look up the dispute. The 30-second poller and the demo trigger are our honest fallbacks.
- **Signature verification depends on the exact bytes.** PayPal expects `webhook_event` to be the original raw JSON. If you parse it and turn it back into JSON, verification fails. We insert the raw request body into the verification request as-is.
- **`provide-evidence` is easy to get wrong.** Problems include multipart encoding, evidence types that aren't allowed for a reason code, file size limits, and disputes in the wrong state. We put all the reason-code-to-evidence-type rules in one typed file, and the submission service rejects anything outside it.
- **AG Grid's best-known features are Enterprise-only.** Row grouping and master/detail need a paid license, and we stayed on Community. We built expandable full-width rows for the agent trace, our own group-by with group-header rows, quick filter, a pinned totals row ("$ at risk", "due in < 48 h"), CSV export, and the Theming API.
- **Render's free tier has no persistent disk.** SQLite is rebuilt on every boot, and the poller then pulls the live sandbox disputes back in. This is documented rather than hidden.
- **Grounding is harder than it sounds.** Asking a model to cite sources isn't enough. It will cite S3 and still slip in a date S3 doesn't contain. Our checker looks for those tokens one by one, and that's what makes the citations trustworthy.

## Accomplishments that we're proud of

- **The agent cannot make up a fact and get it submitted.** Every sentence in the letter traces to a stored PayPal or policy record. Anything unsupported is removed in plain view, and the seller approves before anything is sent. In a real dispute, a made-up tracking event would be fraud, so this was the line we refused to cross.
- **An agent that recommends losing.** Telling a seller "refund this one, here's why in dollars" is more useful than fighting every claim, and it's the branch that uses `accept-claim` and `make-offer`.
- **A full lifecycle on PayPal's own platform:** real order, real tracking, real dispute, verified webhook, evidence submitted, sandbox resolution.
- **Honest numbers everywhere.** The stopwatch shows only measured times, with two readouts. "Draft ready" runs from webhook receipt to finished draft. "Submitted" runs from webhook receipt to PayPal's 2xx response and is labeled "includes your approval time". The strength score is labeled a rubric, not a prediction. Historical fixture disputes carry a "Fixture history" badge, and any route that would change data at PayPal rejects them with 422.
- **Working mock modes for safe testing.** Tests and CI run with mocked PayPal and Claude, with a red "MOCK MODE" banner, so nobody mistakes them for live runs.

## What we learned

- **The deterministic parts are what make the AI trustworthy.** Claude is great at investigating, classifying and writing. Scoring, expected-value math, counting patterns and checking citations should be plain code, because judges and sellers can check plain code.
- **PayPal's sandbox-only endpoints are underused.** `require-evidence` and `adjudicate` turn a process that normally takes weeks into something you can show in a single video.
- **Clear evidence rules matter more than clever wording.** A plain letter with the right evidence type for the reason code beats an eloquent one that doesn't fit the claim.
- **Building in order of risk works.** Getting `provide-evidence` to return 200 before writing any AI code removed the biggest risk on day one.

## What's next

- **A real carrier API.** The carrier adapter interface is already in place. Plugging in EasyPost or Shippo test mode would replace the labeled fixture provider.
- **Live credentials and multiple sellers.** That means adding authentication and moving from sandbox to live PayPal credentials, with a path toward an app-marketplace listing.
- **Better patterns as data grows.** With more real dispute history, prevention actions can go beyond size charts. One example: suggest signature confirmation above a dollar amount the seller chooses.
- **Fee schedules that match the seller.** The dispute fee is currently a setting the seller enters. Reading it per seller would make the expected-value math exact for each store.

## Built With

paypal-disputes-api, paypal-webhooks, paypal-orders-v2, paypal-checkout-js-sdk, paypal-add-tracking-api, claude, anthropic-sdk, typescript, node.js, next.js, react, tailwindcss, server-sent-events, ag-grid-community, react-pdf, sqlite, better-sqlite3, zod, render, postman, vitest, playwright, gitleaks
