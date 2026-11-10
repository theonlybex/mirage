---
{"id":"short","name":"Short","describe":"A vertical video that opens on its hook and is as long as its story needs; made from a big video it's a teaser that answers one small question and leaves the big one open.","words":["short","shorts","reel","reels","tiktok","teaser","clip"],"beats":["hook","tease","pointer","payoff","loop"],"warnPastSec":180,"output":{"width":1080,"height":1920},"captions":{"style":"pop","position":"middle"},"short":{"kind":"teaser"},"playbook":{"firstWordSec":0.5,"answer":{"beat":"payoff","fromShare":0.5,"toShare":0.9},"emptySec":3,"cutsPerMin":{"min":29},"ideaNeeded":true,"title":{"endsWith":"?"}}}
---
A short is a vertical video for YouTube Shorts and Instagram Reels (and TikTok), as long as its story needs and no longer. One file works on both apps: make it once, and the person uploads the same file to each.

The measurements behind these rules: `formulas { id: "short" }`; the reasoning under every format: `formulas { id: "algorithm" }`; how YouTube judges a video: `formulas { id: "youtube" }`.

A short has three algorithms, one per place it is posted: YouTube Shorts (`formulas { id: "youtube" }`, its "YouTube Shorts" part), Instagram Reels (`formulas { id: "instagram" }`) and TikTok (`formulas { id: "tiktok" }`). The rules here are the ones all three share. `predict` scores the cut once, then holds it to each platform's own rules in its per-platform lines.

## The question
A short is built on a question too, and a swipe costs the viewer nothing, so it has to be clear in the first second. Before writing the timeline, find these four in the footage, the catalog and the person's answers, and ask the person for any that are missing. Never invent one.
- The gap: what the thing should be and what it is now.
- The question: one, with an answer the camera can see happen.
- The doubt: who or what says it will fail.
- The stake: a loss the viewer can count.

A standalone short has its own four. For a teaser the question is the big video's (its `idea` in the big video's `episodes/<n>/video.json`): the teaser raises it and leaves it open, and answers one smaller question of its own on the way. When the gap or the question is missing, say so before cutting.

## The hook, in frame 0
Every short opens on its `hook`, in its very first frame: the claim said out loud, or the thing about to happen (a machine about to fall, a door about to open). No title, no logo, no "hey guys", no `title` or `cold-open` beat, and never an `outro`. Start the first item on the first word or the first movement, with no silence before it: the first word comes within 0.5 s, which `check` measures in its `Playbook (short):` lines.

## Two kinds
- **Teaser**, the default for a short made `from` a big video (`new_video { from, format: "short" }`). The person's shorts are there mostly to bring people to the big video, so a teaser raises the big video's question and leaves it open. Its beats are `hook` → `tease` → `payoff`, with no loop:
  - `tease`: the build-up.
  - `payoff`: the answer to one small question the short itself raised (the part fits, the first test runs, the side gag lands). A teaser never ends with nothing paid off: a viewer who was only teased feels tricked, and the short loses on "enjoyed it". `check` warns when a teaser has no `payoff`.
  - A teaser short never shows the headline's reveal. The big video's answer stays in the big video.
  - No outro card. A teaser never ends on a full-screen card, and `check` warns when a short does. YouTube's "Related video" link and Instagram's caption line do the pointing (see "When it's finished").
  - `pointer` is optional: at most a line the person says on camera (a last `pointer` item of the footage itself), or an overlay over the last shot while the picture keeps playing. Leave it out when the footage has no such line.
- **Standalone**, a short with no big video behind it (made without `from`). Its beats are `hook` → `payoff` → `loop`:
  - `payoff`: the moment the hook promised.
  - `loop`: the last line or sound leads back into the first shot, so the restart flows straight into the hook: a question the hook answers, a sentence cut off so the hook finishes it, or the same motion at both ends. End mid-beat, with no outro. The last music cue runs to the very end without fading out (`fadeOut` 0). `check` measures what a timeline shows of the loop: that the last item's beat is `loop`, and that the last cue doesn't fade. Whether the last line really leads into the first shot it can't hear: watch the restart.

`check` treats a short made `from` a big video as a teaser and any other short as a standalone one.

## Starting from a big video
A short made `from` a big video has its footage folders, its answers (`about`, `mention`, `hide`) and the project's catalog already: don't catalog again. Start from the big video's best moments: its headline, its reveals, its laughs, and what viewers replay most (a physical gag, a kiss, fireworks, an animal or a stunt, the first seconds). When the person asked for a few shorts, each one is its own video with its own number, notes and versions.

## Picture, pace and captions
- `output` 1080×1920, and write `"captions": { "style": "pop", "position": "middle" }` into episode.json: one to three bold capital words at a time, mid-frame, with at most one key word in colour per caption.
- Landscape footage needs a `frame` on each item (`fill` or `blur`), as the edit skill says.
- Fast: about 29 cuts a minute or more, shots of about 2 s. A replay of the peak from a second angle works well.
- Length: no length is favoured. As a starting point, a first cut usually lands between 20 and 45 s; then cut every empty second (a stretch where nothing is said, nothing cuts and nothing appears on screen), and stop when none is left. The person's own results move this starting point, in their `short-mine` formula. `check` warns past 3:00, the longest video YouTube Shorts and Instagram Reels take: cut whole moments rather than squeezing every shot.

## Keep text and faces out of the covered areas
Instagram's buttons and caption cover more of the picture than YouTube's, so keep text and faces out of both: about the bottom 20%, the top 10% and the right 15% of the frame. Pick each item's `focus` so faces stay in the clear part of the frame. `check` names any overlay or caption that falls in a covered area; a `callout` sits in the middle of the frame and is always clear.

## Packaging
The short's title asks the big video's question, never the answer ("Did he actually say yes?"). A standalone short's title asks the hook's question. `check` holds the title the person picked to that: it ends with a question mark (`title` in this file's `playbook`).

The cover (1080×1920) is the hook's strongest frame: call `thumbnail` for candidates and pick the one nearest the hook, with a face in the clear part of the frame, no text unless the person asks. The title and description are written as the edit skill says, with facts from the person, the catalog or the music library only.

## When it's finished
The short's `summary.md` says what to set when posting it:
- On YouTube: set the short's "Related video" to the big video, so viewers get a link they can tap through.
- On Instagram, which has no links on Reels: a caption line pointing to the full video, and the link in the bio.
- Post the shorts after the big video is live, so the link exists. Mirage posts nothing itself.
- When the person says where it went, record it: `posted { video, url, also: [{ platform: "instagram" | "tiktok", url }] }` keeps the YouTube address and where else the same file went. Mirage reads numbers only from YouTube; Instagram's and TikTok's are the ones the person types (the mirage:learn skill).

The finished short is copied like the person's other finished videos (wherever they keep them), named after its title. The same file is what they upload to Instagram: there is no second export.
