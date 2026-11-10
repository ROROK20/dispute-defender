# Demo video v2: storyboard

Target length is about 2:30, and the hard limit is 3:00 (judges stop watching at 3:00). 1920x1080, 30 fps, H.264. Loudness -14 LUFS, voice ducks the music.

The video is judged on Presentation: "Does the video clearly demonstrate the project working end-to-end? Does the pitch communicate what problem is solved, who it's for, and why it matters?" PayPal rules, §4 and §6.

## Honesty rules

These rules override every creative choice below.

1. **AI shots are mood and context only.** They show the seller and their world. They never show the product, any UI, any screen content that could be read, or any PayPal brand mark. The rules say the project "must function as depicted in the video". Every frame that shows Dispute Defender is a real screen capture of the running app.
2. **The disclosure line stays on screen.** It says PayPal responses in this recording are sandbox-shaped fixtures and that the agent is real Claude. It is shown as a lower third during the product scenes, and the narration says it once.
3. **No third-party logos and no copyrighted music.** The rules forbid both. Music is generated (ElevenLabs Music via Higgsfield, on the founder's plan) or there is none.
4. **Every claim in the narration is shown on screen.** If a scene can't be recorded, its sentence is cut too. Example: "tells you when to concede" stays only if the weak-case decision is recorded.
5. **AI tools are disclosed.** The Devpost "AI tools disclosure" names Higgsfield (Seedance 2.0 for the b-roll, ElevenLabs for the voice and music).

## Shot list

| # | Time | Source | Picture | Narration (voice-over) |
|---|---|---|---|---|
| A1 | 0:00–0:07 | AI (Seedance 2.0) | Late night. A seller at a cluttered home-studio desk, lit by a laptop, with parcels around. A phone buzzes. | "It's eleven at night. A buyer just opened a dispute, and the clock is already running." |
| A2 | 0:07–0:14 | AI (Seedance 2.0) | Close-up: hands sorting receipts and shipping labels, and a wall calendar with days crossed out. | "Small sellers lose disputes they could have won: a missed deadline, the wrong evidence, or a reply that ignores the reason code." |
| T | 0:14–0:18 | Motion graphics (HTML) | Title: **Dispute Defender**. Subtitle: an AI agent that answers PayPal disputes, with every claim cited. | (music swell, no voice) |
| B1 | optional, ~4 s | AI (optional) | Bridge shot into the product. Rendered only if `demo/v2/ai/B1.mp4` exists. Same rules as the other AI shots: no product, UI or brand. | (no voice) |
| C | 0:18–0:30 | Real: inbox | Inbox. Zoom to the deadline and evidence-strength columns. | "This is Dispute Defender. Every open dispute, its deadline, and how strong the evidence is. In this recording, PayPal's responses are sandbox-shaped fixtures. The agent is real Claude, running live." |
| D | 0:30–0:55 | Real: agent run, sped up | Trigger a demo dispute. Zoom to the live trace as sources S1, S2 and so on appear. Badge: "Sped up Nx · real run: NN s". | "A dispute comes in, and the agent goes to work. Claude pulls the dispute, the buyer's messages, the order and its capture, the tracking, and the store's own policies. Every result becomes a numbered source." |
| E | 0:55–1:10 | Real | Zoom to the evidence-strength score, then the expected-value panel and its decision. | "It scores the evidence against a rubric for this exact reason code, then does the math: is this worth fighting? Here, it is." |
| F | 1:10–1:35 | Real | Zoom to the draft. A citation chip is clicked and the source drawer opens. | "Every sentence cites its source. Click one, and you see the record it came from. A deterministic checker rejects any sentence whose numbers, dates or quotes aren't in those sources, so the agent can't invent facts." |
| G | 1:35–1:50 | Real | Scroll to Approve & submit, click it, show the submitted state. | "Nothing is sent until the seller approves. One click submits the evidence and its PDF packet. Here it goes to the mock PayPal adapter." |
| W | 1:50–2:02 | Real, **only if a weak case can be recorded** | A weak dispute: low score, the decision panel recommends accepting or making an offer, with the dollar math. | "When the evidence is weak, it says so, and shows the dollar math for refunding instead." |
| H | 2:02–2:14 | Real: Patterns | Patterns page. Zoom to one pattern and its quotes from buyers. | "And it helps prevent the next one. Patterns groups past disputes by product and reason, in the buyers' own words, so you can fix the cause, like an outdated size chart." |
| I | 2:14–2:20 | Real: mobile | Phone-width approval view. | "Review and approve from your phone." |
| K | ~10 s | Motion graphics (HTML) | "How it's built": an architecture diagram that names only modules in `src/lib` and PayPal endpoints the code calls. The PayPal box is labelled "sandbox-shaped fixtures in this recording". | "Under the hood: Claude runs the agent with tools, a deterministic checker guards every citation, and an Opus pass may only reword. On the PayPal side it's wired to the Disputes, Orders and Webhooks APIs." |
| J1 | 2:20–2:27 | AI (Seedance 2.0) | Morning. The same studio, now tidy. The seller calmly packs an order with a coffee. | "Dispute Defender won't invent facts, it shows you the math, and it helps stop the next dispute." |
| Z | 2:27–2:33 | Motion graphics (HTML) | End card: Dispute Defender, the repo URL, and "Built with Claude · PayPal Disputes, Orders v2 and Webhooks APIs (fixtures in this recording)". | "The code is at the link below." |

## Rendering

`scripts/record-demo-v2.ts` builds the cut from this storyboard. The narration lives in that script and is exported to `demo/v2/narration.json`. Scene W is rendered only when a real analysed dispute recommends something other than FIGHT. In the mock fixtures every staged dispute is a strong case, so W and its sentence are cut, as rule 4 requires. The manifest (`demo/out/demo-v2.json`) records this and every other fallback.

## Higgsfield prompts

Common settings: model `seedance_2_0`, mode `std`, 1080p, 16:9, `generate_audio` on (room tone, mixed low), duration 8s. Make several variants of each shot and pick the best.

- **A1:** Cinematic night interior of a small independent clothing seller's home studio. A woman in her early thirties sits at a cluttered wooden desk surrounded by kraft-paper shipping boxes, fabric rolls and a garment rack, her face lit cool blue by an open laptop. She rubs her eyes. A smartphone lying face-up on the desk lights up and buzzes. Warm tungsten practical lamp in the background, shallow depth of field, slow push-in, 35mm film look, quiet tense mood. No logos, no brand marks, no readable text on any screen.
- **A2:** Cinematic close-up, night. Hands shuffle printed receipts and a shipping label beside a laptop's edge. Parcels sit in soft focus behind. Rack focus to a paper wall calendar with several days crossed out in red marker. Moody blue night light with a warm desk-lamp accent, shallow depth of field, slow handheld drift. No logos, no legible text.
- **J1:** Cinematic morning interior of the same small home clothing studio, now tidy and sunlit. The same woman calmly folds a shirt into a kraft mailer box and seals it, coffee mug beside her, a slight relieved smile. Parcels neatly stacked. Warm golden morning light through a window, gentle slow dolly, shallow depth of field, hopeful mood. No logos, no readable text on any screen.

**Voice:** `text2speech_v2` with variant `elevenlabs` and a preset voice that is warm, clear and mid-tempo. Make one file per scene so the timing fits each shot.

**Music:** `elevenlabs_music_v2_5`, instrumental, length = final cut + 2s. Prompt: "Minimal modern product-demo underscore, warm felt piano over a soft pulsing synth bed, 96 BPM, gentle build from a tense opening to a hopeful resolve, unobtrusive under voice-over, clean ending, no vocals."
