# Higgsfield pack: clean J1 closing shot

**Why:** in the current J1 clip (`demo/v2/ai/J1.mp4`, from job `74bea722-a200-4956-b4b5-85364b374f83`), the stacked parcels carry shipping labels with garbled fake text and barcodes. The fix is to edit the start still so every box is plain, then re-animate it.

**How to run:** paste the block below into Claude chat with the Higgsfield connector on, where the unlimited trial works. Claude Code can't use the unlimited trial.

**After it runs:**
1. Pull the results from Higgsfield history.
2. Check every frame for labels or text.
3. Conform the best take to 1920x1080 at 30 fps and install it as `ai/J1.mp4`, keeping the old clip as `ai/J1_labels.mp4`.
4. Re-render.

```
Use the Higgsfield connector. Pay for every generation with my free-trial unlimited generations (use_unlim: true) and never spend credits. Before the first job, call models_explore with unlim: true and read which models and settings my unlimited plan covers today. If a job would cost credits or is refused, retry it once with the fallback this message gives; if that is refused too, skip it, note why, and move on. The trial allows one generation at a time, so submit one job, wait until it finishes, then submit the next. Free jobs can wait in a queue: if one is still waiting after a few checks, tell me its job id and stop, and when I say "keep going", check on it and carry on from where you stopped.

Put every generation in my Higgsfield project "Dispute Defender demo" (create it if it does not exist). Every item below has an ID like DD-1; use it in the report. Make only the jobs below. Don't download, publish or share anything: another session pulls the results from my history.

DISPUTE DEFENDER PACK: CLEAN CLOSING SHOT

Context: the closing shot of my hackathon demo video shows a seller's hands in a denim sleeve packing an order on a sunny morning. In the current version, the stacked boxes carry shipping labels with garbled fake text and barcodes. The hackathon forbids third-party marks, and judges notice garbled text, so every box must be plain. Keep everything else exactly as it is: the same hands, denim sleeve and ring, the same mug and desk, the same window light and the same framing.

DD-1 STILL (cleaned start frame). Model nano_banana_pro, resolution 2k, aspect 16:9, batch_size 2. Fallback: gpt_image_2_6, quality high, resolution 2k, batch_size 1. Input image: my image job 267af7d4-bba1-4f00-8f0b-6ad4982fa8b5. Prompt: "Edit this photo. Keep everything exactly the same: the hands in the denim sleeve, the ring, the kraft box being taped, the white coffee mug, the wooden desk, the stack of parcels, the warm golden window light, the framing, the depth of field and the film grain. Change only one thing: every box is plain, unprinted brown kraft cardboard sealed with clear tape. Remove every shipping label, sticker, barcode, letter, number and logo from every box and from the whole image." Check each result: zoom in on every box and the window. If any label, letter, number, barcode or logo remains, regenerate once. Pick the cleanest result for DD-2 and DD-3.

DD-2 VIDEO. Model seedance_2_0, mode std, 1080p, aspect 16:9, 8 seconds, generate_audio off, image-to-video with the chosen DD-1 result as start_image. Fallback: Kling 3.0 at 1080p, 8 seconds, same start image. If DD-1 was skipped, skip DD-2 and DD-3. Prompt: "Bright morning. The seller's hands in a denim sleeve smooth clear tape over the plain kraft box, lift it and set it on the neat stack of plain parcels, coffee steaming beside it. Warm golden window light, slow gentle dolly, shallow depth of field, calm relieved mood. Every box stays plain brown cardboard: no labels, no stickers, no barcodes, no letters, no logos, no readable text anywhere."

DD-3 VIDEO, second take. Same model, settings, start image and fallback as DD-2. Prompt: "Bright morning, locked-off camera with a very slow push-in. The seller's hands in a denim sleeve press the last strip of clear tape flat on the plain kraft box, then rest calmly on its lid for a moment; thin steam rises from the white coffee mug in the sunlight. Warm golden window light, shallow depth of field, quiet relieved mood. Every box stays plain brown cardboard: no labels, no stickers, no barcodes, no letters, no logos, no readable text anywhere."

REPORT. One table: ID, job id, model and settings actually used, which result is best and why in a few words, and anything that failed, was skipped, or still shows labels or text.
```
