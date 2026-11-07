---
{"id":"short","name":"Short","describe":"20–45 s vertical video that opens on its hook; made from a big video it's a teaser pointing to it.","words":["short","shorts","reel","reels","tiktok","teaser","clip"],"beats":["hook","tease","pointer","payoff","loop"],"targetSec":45,"warnPastSec":60,"output":{"width":1080,"height":1920},"captions":{"style":"pop","position":"middle"},"short":{"kind":"teaser"}}
---
A short is a 20–45 s vertical video for YouTube Shorts and Instagram Reels (and TikTok). One file works on both apps: make it once, and the person uploads the same file to each.

## The hook, in frame 0
Every short opens on its `hook`, in its very first frame: the claim said out loud, or the thing about to happen (a machine about to fall, a door about to open). No title, no logo, no "hey guys", no `title` or `cold-open` beat, and never an `outro`. Start the first item on the first word or the first movement, with no silence before it (`check` warns past 0.5 s).

## Two kinds
- **Teaser**, the default for a short made `from` a big video (`new_video { from, format: "short" }`). The person's shorts are there mostly to bring people to the big video, so a teaser ends before the payoff. Its beats are `hook` → `tease` → `pointer`, with no loop:
  - `tease`: the build-up, cut right before the payoff.
  - `pointer`: 1–2 s at the very end pointing to the full video. Use a line the person says on camera when the footage has one; otherwise a `bold` card or an overlay with "Full video on my channel".
  - A teaser short never shows the headline's reveal. The payoff stays in the big video.
  - A short that tells one complete small moment (a side gag, not the headline) is fine too, when the person picks it. It still ends on the `pointer`.
- **Standalone**, a short with no big video behind it (made without `from`). Its beats are `hook` → `payoff` → `loop`:
  - `payoff`: the moment the hook promised.
  - `loop`: the last line or sound leads back into the first shot, so the restart flows straight into the hook: a question the hook answers, a sentence cut off so the hook finishes it, or the same motion at both ends. End mid-beat, with no outro. The last music cue runs to the very end without fading out (`fadeOut` 0).

`check` treats a short made `from` a big video as a teaser and any other short as a standalone one.

## Starting from a big video
A short made `from` a big video has its footage folders, its answers (`about`, `mention`, `hide`) and the project's catalog already: don't catalog again. Start from the big video's best moments: its headline, its reveals, its laughs, and what viewers replay most (a physical gag, a kiss, fireworks, an animal or a stunt, the first seconds). When the person asked for a few shorts, each one is its own video with its own number, notes and versions.

## Picture, pace and captions
- `output` 1080×1920, and write `"captions": { "style": "pop", "position": "middle" }` into episode.json: one to three bold capital words at a time, mid-frame, with at most one key word in colour per caption.
- Landscape footage needs a `frame` on each item (`fill` or `blur`), as the edit skill says.
- Fast: about 29 cuts a minute or more, shots of about 2 s. A replay of the peak from a second angle works well.
- 20–45 s. `check` warns past 60 s: cut whole moments rather than squeezing every shot.

## Keep text and faces out of the covered areas
Instagram's buttons and caption cover more of the picture than YouTube's, so keep text and faces out of both: about the bottom 20%, the top 10% and the right 15% of the frame. Pick each item's `focus` so faces stay in the clear part of the frame. `check` names any overlay or caption that falls in a covered area; a `callout` sits in the middle of the frame and is always clear.

## Packaging
The short's title asks the big video's question, never the answer ("Did he actually say yes?"). A standalone short's title asks the hook's question.

The cover (1080×1920) is the hook's strongest frame: call `thumbnail` for candidates and pick the one nearest the hook, with a face in the clear part of the frame, no text unless the person asks. The title and description are written as the edit skill says, with facts from the person, the catalog or the music library only.

## When it's finished
The short's `summary.md` says what to set when posting it:
- On YouTube: set the short's "Related video" to the big video, so viewers get a link they can tap through.
- On Instagram, which has no links on Reels: a caption line pointing to the full video, and the link in the bio.
- Post the shorts after the big video is live, so the link exists. Mirage posts nothing itself.

The finished short is copied like the person's other finished videos (wherever they keep them), named after its title. The same file is what they upload to Instagram: there is no second export.
