---
name: learn
description: "Learn from the person's own posted videos: record that a video is live, read how each one did, improve the person's formula for that format, and report what was improved and why. Use when the person says a video is posted or asks how their videos did, what Mirage has learned, or to improve their formula; also when status says learn is due."
---

# Learning from the person's posted videos

This is a saved process: run it without the person explaining it. Each time a video goes live, Mirage reads how the posted videos did, holds that against what each cut was made of, and improves the person's own formula for that format, one careful step at a time. Then it tells the person what was improved and why.

Mirage does not upload. "Posted" means the person says the video is live and gives its address.

Speak to the person in plain words. Say what you are doing in a line before each step.

## The engine tools

| Tool | Input | What it does |
|---|---|---|
| `mcp__plugin_mirage_engine__posted` | `{ video, url, also?: [{ platform, url }] }` | records in `episodes/<n>/video.json` that video `n` is live at that YouTube address (and, with `also`, where else the same short went: `platform` is `instagram` or `tiktok`), and writes `episodes/<n>/features.json`: what the cut was made of (length, seconds before the first word, where the answer starts, cuts a minute, typical shot, words a minute, longest stretch without words, share under music, overlays, captions, a short's kind, the idea answers, the video's experiment, whether it has a thumbnail, whether that was written with text and how it was made (one frame, or two sources and their layout), and each item's place in the video). Needs the final render. Called again, it replaces the address and takes the snapshot again |
| `mcp__plugin_mirage_engine__learn` | `{ studio?: { video, platform?, clickRate?, percentViewed?, avgViewSec?, viewedVsSwiped?, drops?: [{ at, note? }], spikes?: [{ at }], views?, likes?, comments?, shares?, saves? } }` | reads every posted video's public numbers (title, upload date, length, views, likes, comments, the "most replayed" graph), adds today's snapshot to `results/<n>.json` (one per day, the history is kept), keeps the Studio numbers given for one video, reports per format, and writes the same evidence to `results/evidence.json` |
| `mcp__plugin_mirage_engine__formulas` | `{ id? }` | lists the formulas: Mirage's own (they can't be changed) and the person's, marked `(yours)`; with `id`, that formula's whole file |
| `mcp__plugin_mirage_engine__status` | `{}` | its `Results:` line says how many videos are posted, when they were last read, and which videos have a read due |
| `mcp__plugin_mirage_engine__channel` | see the mirage:analyse skill | gathers a niche channel's public data, when the person's own videos are too few to learn from (step 4) |
| `mcp__plugin_mirage_engine__new_video` | `{ …, experiment?: { rule, change, expect } }` | the next video carries its experiment from the start (step 5) |
| `mcp__plugin_mirage_engine__predict` | `{ video }` | the forecast the mirage:edit skill makes of a cut before it is posted, kept in `episodes/<n>/prediction.json`; `learn` holds it against what happened (step 2) |

Below, a tool is written by its short name (`posted`, `learn` …). `learn` reads public data only, with yt-dlp, and never downloads a video; neither do you. Both tools need a project.

Mirage does not sign in to YouTube or Google: the Studio numbers are the ones the person types. Never ask for their password or a sign-in.

**Instagram and TikTok.** A short usually goes to all three platforms. Mirage reads public numbers only from YouTube; it reads nothing on Instagram or TikTok. So for those two every number is one the person types from the app's own insights, and every comparison `learn` makes (the ranking, the halves, the experiments, the forecasts) is of the YouTube numbers. Say this plainly whenever you report on a short.

## The three reads

YouTube needs a few days to judge a video, and some keep growing for a month. So each posted video is read three times: an **early read** 3 days after it went up, the **main read** at 7 days, and a **late read** at 28 days. These day counts are starting points, not measurements.

- A short may be judged at the early read; a long video at the main read.
- The late read only confirms or corrects what the main read said: change a rule on it only when it contradicts the main read.
- Before a video's main read (before its early read, for a short), what it shows is early: write it as an observation, never a rule.

`status` names the videos with a read due (`learn is due: video 3 (early read), video 1 (late read)`); `learn` reads every posted video each time, so one call covers them all.

## The rules

These hold through every step, and go into whatever you write:

- **A rule changes only when three or more videos point the same way**, or when the gap between the better half and the weaker half is clear with 4 or more videos. One or two videos give an **observation**: write it under the formula's `## Observations so far` heading, never as a rule.
- **Tie every change to one of the three steps** in `formulas { id: "youtube" }`, and say which number it rests on:
  - chose to watch: the click rate, or for a short "viewed vs swiped away"; without Studio numbers, views at the same age is the nearest public number, and it mixes all three steps;
  - stuck around: the average percentage viewed and the average view;
  - enjoyed it: likes and comments per 1,000 views.
- **What viewers replay is evidence about moments, not about the whole video.** A most-replayed item says that moment was worth seeing twice (or was hard to follow); it says nothing about the video's views. A peak in the first seconds is mostly people starting the video.
- **"×" and the better and weaker halves show what goes with better results, never proof of cause.** A big idea gets both the fast opening and the views. Say "goes with", not "causes", in the formula, in `changes.md` and in your report.
- **Never copy a number into a rule that `results/evidence.json` doesn't hold. Never invent a result.** A Studio number is only what the person gave you.
- **Never touch Mirage's own formulas.** They are read-only; nothing here changes them. The person's formula lives in the project's `formulas/` folder, and it wins over Mirage's packaging and pacing advice as far as the mirage:edit skill says: never over a format's beats, size or captions, or over what the footage holds.
- **One change at a time when the sample is small.** With a weak signal, change at most one rule per run, so the next video can test it.

## 1. A video was just posted

Ask only for the address, when the person hasn't given it. Then `posted { video, url }`: `video` is its number (`status` lists them). For a short, ask in the same message whether the same file also went to Instagram or TikTok, and pass those addresses as `also: [{ platform: "instagram", url }, { platform: "tiktok", url }]`, so the record is complete; the reply then says `also posted on Instagram (<url>) and TikTok (<url>) — Mirage reads no numbers there: give learn the ones you see in the app, as studio with platform`.

Then ask once, in one message, for the numbers only they can see, and say they are optional. They are in YouTube Studio → Content → the video → Analytics:
- the click rate ("Impressions click-through rate", under Reach) → `clickRate`;
- "Average percentage viewed" and "Average view duration" (under Engagement, or Overview) → `percentViewed`, and `avgViewSec` in seconds (3:10 is 190);
- for a Short, "Viewed vs swiped away" (the "viewed" share) → `viewedVsSwiped`.

Also ask where viewers leave, when they can see it: on the retention graph (Analytics → Engagement → "Audience retention"), the moments where the line falls sharply or dips (viewers leave or skip) → `drops: [{ at, note? }]`, and where it rises (viewers rewatch) → `spikes: [{ at }]`. `at` is seconds into the video (1:25 is 85); `note` is what the person says about it. Public data has only the "most replayed" graph: where viewers leave is known only from what the person reads off this graph, so say so when they give none.

For a short that also went to Instagram or TikTok, ask for what the app shows its owner there (Instagram: the reel → View insights; TikTok: the video → Analytics), and keep it with `studio: { video, platform: "instagram" | "tiktok", … }`, one call per platform: `views`, `likes`, `comments`, `shares` (Instagram calls them sends), `saves`, the average watch time as `avgViewSec`, and the share that watched it through or didn't skip as `percentViewed` or `viewedVsSwiped` where the app shows one (Instagram's skip rate of 12% is `viewedVsSwiped: 88`). `platform` left out means YouTube.

Percentages go in as 0–100 (4.2% is `4.2`). YouTube needs a day or two to show them: if the person has none yet, carry on, and take them at the next read. Numbers for several videos take one `learn` call each. Never guess one.

- `⚠ video.json names the format "<id>", which isn't one of Mirage's (<ids>) — features.json describes the cut as a build story: fix format in episodes/<n>/video.json, then call posted again`: the video's `format` is misspelled or not a format Mirage has, so its snapshot was taken by the build story's rules and `learn` would group it with the build stories. Fix `format` in `episodes/<n>/video.json` (ask the person which they meant), then call `posted` again.
- `⚠ the timeline is <a> s long and final.mp4 is <b> s — the timeline changed after the final render, so features.json may not describe the video that was posted`: the timeline was edited after the video that went live was rendered. Ask the person which is the posted one: put that version back (the edit skill's `versions` and `restore`) or render again, then call `posted` again.

## 2. Read how the videos did

`learn` (with `studio` when the person gave numbers). Read its report, then `results/evidence.json`, which holds the same evidence with every number.

The report, per format that has posted videos:
- `Video <n> “<title>”: <d> days old, <read> · <views> views · <v> a day · <l> likes per 1,000 views · <c> comments per 1,000 views · Studio (<day>): …`: one line per video. `<read>` is the read the video is at by its age: `before the early read`, `early read`, `main read` or `late read`. `no like count` or `no comment count` means YouTube didn't give one.
- A video in a series is named with it: `Video <n> “<title>” (series “<name>”): …`. The comparison is still per format.
- `Title, video <n>: live on YouTube it is “<live>”, and Mirage recorded “<chosen>” as the one chosen — they differ, and the title numbers here are the live title's`: the person changed the title when posting, or after. The title lines of the halves describe the live title; note the change as an observation (a title changed after posting is itself an experiment the person ran), and ask which one they want on record.
- `Elsewhere, video <n>: Instagram <url> — <views> views · <k> shares · … (typed by the person, <day>) · TikTok <url> — no numbers given yet`: where else the short went, with the newest numbers the person typed for each platform. They are shown, never ranked or compared by `learn`: hold them against that platform's own file yourself (`formulas { id: "instagram" }`, `"tiktok"`), and say they are typed. The report then ends `Instagram and TikTok numbers are the ones the person typed: Mirage reads numbers only from YouTube, and every comparison above is of the YouTube numbers.`
- `Early: videos … are before the main read (7 days) — what they show so far is early and may still change`: those videos' numbers are not settled. Report them as early, and don't change a rule on them (a short may be judged at its early read).
- `Viewers left (Studio), video <n>: <m:ss> during item <id> (beat <beat>) — “<note>” · …` and `Viewers rewatched (Studio), video <n>: …`: the drops and spikes the person read off their retention graph, each with the item of the cut playing there. This is how you can say "viewers left during item m3 (beat problem)". Without them, nothing says where viewers left.
- `Most replayed, video <n>: <m:ss> (<p>%) item <id>, <beat> · …`: the three strongest points of YouTube's "most replayed" graph, strongest first, each with the item of the cut that plays there and its beat. Look the item up in `episodes/<n>/episode.json` to see what the edit did at that moment. `Most replayed: YouTube shows none for …`: small or new videos have no graph; say it was not available, don't guess.
- `Ranked by views at <d> days old, the newest video's age …`: every video is compared at the same age, so no age is favoured; only each video's first days count. `Ranked by views a day, because the reads so far don't let the videos be compared at the same age …`: this favours newer videos, so say so, and trust it less. It turns into the fair comparison once each older video has been read both before and after the newest video's age: running `learn` every week does that.
- `Best first: video <n> (<number>) · …`: the ranking, with the number each was ranked on.
- `Better half (videos …) against weaker half (videos …), the middle value of each:`, then a line per feature, e.g. `Seconds before the first word: better half 1.2 s · weaker half 3.4 s`. `not known` means no video of that half has the number. With an odd count the middle video is in neither half.
- The same for the live titles: `Title words: better half 6 · weaker half 9`, then how many titles of each half are in capitals, have a number, are in the first person, end with ? or !!, or end with a bracket tag, e.g. `Title in ALL CAPS: better half 2 of 2 · weaker half 0 of 2`. Titles are one of the most important parts: read these lines every time, and hold them against the format's title shape (`title` in its `playbook`).
- `Thumbnail from two sources: better half 1 of 2 · weaker half 0 of 2`: how many thumbnails of each half the thumbnail tool built from two sources (a face and a subject side by side) rather than from one frame; it is printed once any posted video's thumbnail has that on record. Each video's `features.json` also holds the layout (`thumbnail.layout`: the side the face is on, its share of the width).
- `Experiments:`, then for each video that carried one: `Video <n> changed “<rule>”: <change>. Expected: <expect>. So far on <number> it has <x> against a middle of <y> for the other <k> videos: higher` (or `lower`, `the same`). The number is the one its `expect` names when that video and others have it (the click rate, viewed vs swiped, the percentage viewed, the average view, likes or comments per 1,000 views), otherwise the ranking's. `(early: before its main read)` marks one that is not settled; `there is no other video of this format to hold it against yet` means just that.
- `Forecast against result, video <n>: predicted above your usual for <format> (chosen 8/10 · stayed 6/10 · satisfied 10/10; weakest: stayed) · it landed 1 of 5 in the ranking, in the better half — the band was right`: for each posted video that has a forecast (`predict`, made before it was posted), what was predicted and where the video landed among the format's videos. The better half of the ranking is `above`, the weaker half `below`, the middle video of an odd count `around` (`in the middle`); `— the band was wrong (it landed below)` says the forecast missed. `predicted against the playbook only (…)` is a forecast made before the format had 4 posted videos: it gave scores and no band, so it can't be right or wrong. `— too few videos to say whether the band was right` means the format still has under 4 posted videos; `it is the format's only posted video, so there is no ranking to hold it against yet` means just that; `(early: before its main read)` marks a result that is not settled.
- `Forecasts so far: the band was right for <r> of <t> posted videos`: the running count, over every format, after the last format. `Forecasts so far: none can be judged yet — a forecast is judged once it gave a band and its format has 4 posted videos` means no forecast had both. The forecast's weights are fixed and do not correct themselves, so this count is how far to trust it: tell the person the count in the report, say plainly when the forecast has been wrong, and when it has been right for half or fewer of the videos judged (or fewer than 4 have been judged), treat the next forecast's band as a weak hint and rely on the playbook lines and the person's own numbers instead. A forecast that was wrong is also evidence: look at which step it scored high that the Studio numbers show failed (step 4), and write that under `## Observations so far`.
- `too few to compare: <k> videos — <m> more needed`: under 4 videos of that format, so no halves. The per-video lines and the most replayed items still count as observations.
- `Confidence, <format>: <k> posted videos — a weak signal` (under 5 videos), `a fair signal` (5–9) or `a strong signal` (10 or more).

Its `⚠` lines, each to pass on in plain words:
- `⚠ video <n> (<id>): yt-dlp couldn't read it (<why>) — it is left out`: the video is private, deleted, scheduled or still processing, or YouTube is limiting requests. It is left out of this report; the others are still read. If the address is wrong, call `posted` again with the right one.
- `⚠ video <n>: on YouTube it is <m:ss> long and its cut was <m:ss> — the moments viewers replayed or left can't be tied to the cut's items`: the posted video isn't the cut Mirage has (it was trimmed, or rendered again since). Its replayed points, drops and spikes are given as times only. If the person posted a newer cut, call `posted` again for it.
- `⚠ video <n>: its address changed since its numbers were last read — the earlier numbers were of <url> and are dropped`: the video was posted again under a new address, so its history starts afresh.
- `No posted video could be read, so there is nothing to compare yet.`: every video got a `⚠`; fix what they name and run `learn` again.

## 3. Read the person's formula for that format

The person's learned formula is `formulas/<format>-mine.md` in the project: ids `build-story-mine`, `vlog-mine`, `short-mine`. Read it with `formulas { id }`.

When there is none, create it (make the `formulas` folder if it isn't there). The file starts with a `---` line, one line of JSON, and a `---` line, with no other keys:

```
---
{"id":"build-story-mine","name":"My build story formula","describe":"What has gone with better results on my own build-story videos.","formats":["build-story"],"source":"learned from this project's own posted videos, last updated 2026-11-09"}
---
```

`formats` is `["<format>"]`. `source` says it is learned from this project's own posted videos, and when it was last updated: update that date with every change. Then the formula in Markdown:
1. A first section saying it sits on top of Mirage's formula for that format (`formulas { id: "episode" }` for a build story, `"vlog"`, `"short"`): where this file says nothing, Mirage's formula holds. And the sentence that the numbers show what goes with better results, not proof of cause.
2. `## Rules`: only rules it has evidence for. A new file has none yet: say so in one line. List nothing it hasn't evidence for.
3. `## Observations so far`: what one or two videos showed.
4. `## Not measured`: what the numbers can't show (without Studio numbers: the click rate and retention).

`formulas/changes.md` is the log of changes, not a formula: it has no front matter and is not listed.

**Thumbnails.** `features.json` holds only what Mirage knows of a thumbnail (`thumbnail`: whether `episodes/<n>/thumbnail.jpg` exists, and whether it was written with text; and, when the thumbnail tool recorded it, `made`: `one-frame` or `two-sources`, with the `layout` of the two). For each video you compare, Read `episodes/<n>/thumbnail.jpg` and note yourself: a face or not and its expression, the subject and its state, text or none. Hold those notes against the ranking as you do the title features; they are your reading of a picture, so say so.

## 4. Decide what changes

Go through the evidence under the rules above, per format:

1. **The halves** (4 or more videos): a feature whose better half and weaker half differ clearly, by more than the videos inside each half differ from each other (look at each video's own number in `results/evidence.json`). A gap of a few percent, or one made by a single video, is not clear.
2. **The same direction three times**: a thing three or more videos share that the others lack (they all open on the result; their replayed item is always the reveal).
3. **The Studio numbers**, when given: a low click rate points at the title and thumbnail, or a short's first second; a low percentage viewed points at the opening, the pace and where the answer starts.
4. **The most replayed items**: what the cut did there (the beat, a reveal, a punch-in), as evidence about moments.
5. **The idea answers** in `features.json` (`idea`: gap, question, doubt, stake): whether the better videos had a question on record and the weaker ones didn't.

6. **The titles and thumbnails**: the title lines of the halves, and your notes on the thumbnails. These are about the first step, chose to watch.
7. **Where viewers left** (`Viewers left (Studio)`): the item and beat playing there, and what the cut did at that moment. Like the replayed items, this is evidence about moments.

**Find the step that failed.** For the video just read, say which of the three steps in `formulas { id: "youtube" }` it was weak at against the person's other videos of the format: chose to watch (click rate; viewed vs swiped; else views at the same age), stuck around (percentage viewed, average view, where viewers left), enjoyed it (likes and comments per 1,000 views). Fix only that part. A video that did well needs no experiment: keep what it did, and write down what that was.

**For shorts the hook comes first.** Viewers swipe with no decision to make, so the first seconds are the whole pitch. When viewed vs swiped is the weak number, the experiment is on the opening, before anything else.

**Too few videos to compare.** `too few to compare` does not stop the process: learn from the niche instead.
- Read the `niche` entry of `mirage.json`: the channels that lead the person's niche, per format, e.g. `"niche": { "short": ["https://www.youtube.com/@leader/shorts"], "build-story": ["https://www.youtube.com/@other"] }`. When it has none for this format, ask the person which channels are the leaders in their niche, and write their addresses there (edit `mirage.json`; no other key changes).
- Use the mirage:analyse skill (`channel`) on the most-watched of them, for that format, and make its findings the base of the `<format>-mine` formula.
- When a specific moment failed (say the opening), look at how that channel executes that moment: its titles, its thumbnails, and the captions of 2–3 of its videos (`channel { name, captions }`). Adapt the principle; never copy the subject, the wording or the look.
- Every formula entry that came this way says it came from a niche channel, which one, and that it is untested on this audience until one of the person's own videos confirms it. Put it under `## From the niche (untested here)`, not under `## Rules`; it moves to `## Rules` only by the evidence rule above, on the person's own videos.

Then sort each finding: a **rule change** (it meets the first rule above), an **observation** (one or two videos, or an unclear gap), or **nothing** (no difference). A rule the new evidence contradicts three times goes back to an observation, or is removed, with the same care.

## 5. Write the change

Edit `formulas/<format>-mine.md`: the rule in `## Rules` in one or two plain sentences with its number and its step ("Open on the first word within 1.5 s (stuck around): the better half's middle is 1.2 s against 3.4 s, 6 videos"), observations under `## Observations so far`. Check it with `formulas { id }`.

Then append an entry to `formulas/changes.md` (create it with the heading `# Changes to my formulas` when it isn't there), newest last:

```
## 2026-11-09 · build-story · Open on the first word

- Before: "<the old wording, word for word; or: no rule>"
- After: "<the new wording>"
- Step: stuck around
- Evidence: videos 1, 3, 4 and 6; seconds before the first word, better half 1.2 s · weaker half 3.4 s; ranked by views at 12 days old
- Confidence: weak (4 posted videos)
- Try next: open the next video on the result within the first second, and compare its percentage viewed
```

Keep the old wording verbatim, so it can be put back. The confidence is the word from `learn`'s `Confidence` line for that format. "Try next" is one thing to do in the next video that would test the change.

**The playbook numbers.** `check` and `predict` measure every cut against its format's playbook: the numbers in the format file's front matter (`"playbook"`, in `formats { id }`): `firstWordSec`, `answer` (`beat`, `fromShare`, `toShare`), `emptySec`, `cutsPerMin` (`min`, `max`, `except`, `beats`, `after`), `wordsPerMin` (`min`, `max`), `ideaNeeded`, `endsOn`, `title` (`allCaps`, `hasNumber`, `firstPerson`, `endsWith`, `words`), `targetSec`, `warnPastSec`. Mirage's files stay as they are; the person's results adjust the playbook through their own formula. When a rule you write into `## Rules` changes one of those numbers (the better half's first word comes within 1.5 s; their answers start at 70–80%), also set that key in a `"playbook"` object in the front matter of `formulas/<format>-mine.md`, e.g. `"playbook":{"firstWordSec":1.5}`: each key there replaces the format's for this project, and `check` then says `Playbook (<format>, with your <format>-mine formula's firstWordSec):`. Only keys the evidence rule supports, only numbers `results/evidence.json` holds, and the same `changes.md` entry covers it (name the key and its old and new number in `Before` and `After`). An observation never changes a playbook number. The one exception is a starting number the mirage:analyse skill saved there from a niche channel (listed under `## From the niche (untested here)`): it is a starting point, not a rule, and the person's own results confirm it (it moves to `## Rules`) or replace it (the key takes the number their results gave) by the same evidence rule. Each format has its own length this way: `targetSec` and `warnPastSec` start from the niche and are then moved by experiment. Putting a rule back (step 7) puts its number back too: remove the key, or restore the old number.

**The next video's experiment.** Each video carries at most one deliberate change against its format's formula, so its effect can be read. Choose it by reading `formulas { id: "algorithm" }`, the format's Mirage formula (`"episode"`, `"vlog"` or `"short"`) and the person's `<format>-mine` formula, aimed at the step that failed. Write it as three sentences: `rule` (which rule it departs from), `change` (what the video does differently), `expect` (the number that should move, in the words `learn` finds: click rate, viewed vs swiped, percentage viewed, average view, likes, comments, or views). It goes into the next video as `new_video`'s `experiment`; for a video that already exists and isn't posted yet, write `"experiment": { "rule", "change", "expect" }` into its `episodes/<n>/video.json` (`posted` copies it into `features.json`). Until the next video exists, keep it in the `Try next` line.

**When an experiment has been read** (the `Experiments:` lines, at the video's main read; a short's early read):
- it helped, and with it the rule's evidence reaches the threshold (three or more videos pointing the same way, or a clear gap between the halves with 4 or more): it becomes a rule in the person's formula, with a `changes.md` entry;
- it helped once: an observation, and worth repeating in the next video;
- it didn't help: record it in `changes.md` as tried and dropped (`- After: "tried and dropped"`, with the numbers), so it isn't tried again by accident.

## 6. Report to the person

In plain words, short, in four parts, in this order:
1. **How the video did**: its numbers, against their other videos of the format, and at which read (early, main or late); when it is before its main read, say it is early.
2. **Why, as far as the evidence shows**: which of the three steps it was strong or weak at, and which moments viewers replayed or left (the item and what the cut did there). Say what could not be seen (without Studio numbers: the click rate, retention, where viewers left). When the video had a forecast, say what it predicted, where the video landed, and how often the forecast has been right so far.
3. **What was changed in the formula**: what was improved and why (each rule, the numbers it rests on, its step), what stayed the same and why, and what is only an observation so far.
4. **The experiment for the next video**, and what would count as it working (which number, against what).

End with how far to trust it (the confidence word), and that these numbers show what goes with better results, not what causes them.

When nothing changed, say that, and how many more videos are needed (`too few to compare` gives the number for the halves; three videos pointing the same way is the other route).

## 7. Putting a rule back

"Put that rule back": find its entry in `formulas/changes.md`, restore the `Before` wording in the formula word for word (or remove the rule when it was `no rule`), and append a new entry saying it was put back, when, and at whose request. Never delete an entry.

## When a tool stops

A `✖` line stops the call; its next line says what to do. Pass it on in plain words.

- `✖ also: "<url>" isn't an address on Instagram` (or `on TikTok`): the address given in `also` is not that platform's; ask for the reel's or the video's own https address there, or leave it out.
- `✖ "<input>" isn't a YouTube video address`: ask for the video's own address (`https://www.youtube.com/watch?v=…`, `https://youtu.be/…` or `https://www.youtube.com/shorts/…`); a channel or a playlist isn't one.
- `✖ there is no video <n>` or `✖ video <n> has no video.json to record it in`: check the number with `status`.
- `✖ video <n> has no final render yet`: only a finished video can be posted. Finish it with the edit skill (`render`) first.
- `✖ no video is posted yet`: `learn` has nothing to read. Use `posted` first, when a video is live.
- `✖ video <n> isn't posted yet, so it has no Studio numbers to keep`: call `posted` for that video first.
- `✖ studio needs at least one number`: give at least one of the numbers, `drops` or `spikes` (for Instagram or TikTok also `views`, `likes`, `comments`, `shares` or `saves`), or leave `studio` out.
- `✖ yt-dlp was not found`, then `Install yt-dlp (macOS: brew install yt-dlp; Windows: winget install yt-dlp) or set WORDEDITS_YTDLP_DIR to a folder containing yt-dlp.`: yt-dlp is the free program that reads YouTube's public pages. Ask whether to install it (the setup skill's yt-dlp step), then run `learn` again.
- `✖ yt-dlp could not be started`: the file is there but can't run; reinstall it.
- `✖ ffprobe was not found`: `posted` measures the final render with it; the setup skill installs it.
- `✖ results/<n>.json: …`, `✖ episodes/<n>/features.json: …`, `✖ episodes/<n>/prediction.json: …` or `✖ episodes/<n>/video.json: …`: that file was edited and broke; the line names the key. Fix it (for `features.json`, calling `posted` again writes it afresh; a broken `prediction.json` can be deleted: that video then has no forecast to hold against its result).
- `✖ no Mirage project at …`: there is no project in this folder; the edit skill starts one.
- `✖ Stopped by the person before it finished. The numbers read so far are kept.`: don't run it again unless they ask. The snapshots already written stay; the report and `results/evidence.json` were not written.

Never run `yt-dlp` or `pnpm` yourself for these steps: the engine tools do it, the same way on every computer.
