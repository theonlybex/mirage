# Playbook, prediction and learning

Written 2026-11-09 from the owner's notes. Status of each part is at the end.

## The mission
Mirage edits videos so they reach the largest number of the right viewers, by adapting each cut to the platform's algorithm and to the formula for that video format. The loop:

**formula → edit → predict → improve → post → learn → experiment → better formula**, repeated until the format's formula stops improving for that niche.

## Layers of rules
1. **Platform algorithm** (`formulas { id: "youtube" }` today; Instagram Reels and TikTok to come): how that platform decides what to show. Shorts-style feeds differ from long video: no click, a swipe costs nothing, so the opening is the whole pitch.
2. **Core rules of a format** (`plugin/formats/*.md`, `plugin/formulas/*.md`): what every video of that format shares. Read-only for users.
3. **The person's formula** (`formulas/<format>-mine.md` in the project): what their own audience has shown, built first from the leading channels of their niche, then from their own results. It sits on top of layer 2.
4. **The experiment**: one deliberate change per video, tested against layer 3.

Lengths, pacing and narration density are starting points in layer 2 and are adjusted in layer 3 by experiment. Each format has its own: series episodes can run 30+ minutes (fewer chances to click another video), a vlog can be short, a short has no favoured length.

## A. The playbook is measured, not advised
`check` measures a cut against its format's playbook and reports each rule as met or missed, with the number:
- seconds before the first word (all formats, not only shorts);
- where the answer beat lands (`truth`, `headline`, `payoff`) against the format's target share;
- the longest stretch with nothing new: no speech, narration, cut or overlay;
- pace: cuts per minute per beat against the format's range;
- narration density against the format's setting. Density is per format: near-continuous for episodes, sparse for vlogs. Narration is not needed where the picture alone tells the situation, so a stretch counts as "empty" only when nothing changes on screen either;
- for shorts: the loop (does the end lead into the start), no outro, the covered areas;
- the idea answers present (gap, question, doubt, stake) for formats that ask for them, shorts included;
- title shape against the format's shapes (setup not result; obstacle, deadline or hidden "who").
Each format file states its numbers in its front matter so `check` reads them, and a person's formula can override them.

## B. Prediction after the cut
A `predict` step after the final render: an approximate forecast, not a promise.
- Scores the cut on the three steps of the platform's algorithm: will they choose to watch (title, thumbnail, first seconds), will they stay (pace, empty stretches, where the answer lands, open questions), will they be satisfied (the promise paid off, the ending).
- Names the weakest step and the specific moments behind it, with one change for each.
- Gives a band (below / around / above the channel's usual for that format), not a view count. With no posted videos it compares against the playbook only and says so.
- After each `learn`, the forecast is compared with what happened, and the weights are corrected for that project. The report shows how right past forecasts were.
- Then: improve the weak moments, predict again, post.

## C. Learning after posting
Built in the `posted` / `learn` tools and the `mirage:learn` skill: reads at 3, 7 and 28 days; public numbers plus the Studio numbers the person types; where viewers replayed or left, tied to the item of the cut; titles and thumbnails included; one experiment per video; the leading channels of the niche as the base when own videos are few; a report of how it did, why, what changed in the formula and what the next experiment is.

## D. Shorts and other platforms
- Fix the teaser's ending: no "Full video on my channel" card as an outro. The platform's own link points to the big video. A pointer is at most a spoken line or an overlay over the last shot.
- A teaser answers one small question and leaves the big one open. It never ends with nothing paid off.
- No fixed 20–45 s. A starting length, then cut by empty seconds; adjusted per project by experiment.
- The idea check (gap, question, doubt, stake) applies to shorts.
- One formula per platform for the same format: YouTube Shorts, Instagram Reels, TikTok each get their algorithm file, researched the way `youtube` was. A short is predicted per platform.
- Hook experiments only when the results say the opening failed (viewed vs swiped is the weak number).

## E. Series
- A series is a folder that groups its episodes, with its own file holding: the open question, the running counts (cost so far, attempts used), the sign-off, the title shape and the thumbnail layout.
- Each episode's recap and outro read from and write to it.

## F. Thumbnails
- Build a thumbnail from two frames (a face and the subject) or from a photo the person gives, and keep one layout per series.
- Why faces work, to record in the `algorithm` formula with its limits:
  - people look at faces first, automatically, from infancy, so a face wins the glance in a crowded feed;
  - an expression is read instantly and tells the viewer what they will feel;
  - a face that returns becomes familiar, so regular viewers recognise the channel before reading the title;
  - a face next to an object gives the object a scale and a stake: someone this happened to.
  The first two are well established in psychology. That they raise click rates is measured mostly by creators and tool vendors, not in controlled studies.

## G. Analyse saves a starting point into the format
When a channel is analysed for a format, the findings that would shape an edit (length, pace, narration density, title shapes, thumbnail layout, where the answer lands) are saved in the person's formula for that format as its starting numbers, marked as taken from that channel and untested on their audience. The analyse skill does this without being asked.

## Later
Not built, on purpose:
- Reading YouTube Studio numbers automatically, through a Google sign-in. Today the person types them (`learn`'s `studio`), and Instagram's and TikTok's too.
- Rendering two versions of a short that differ only in the opening. Only when the results show the opening failed: "viewed vs swiped" is the weak number. Until then one cut is made, and the opening is the experiment of the next short.
- Forecast weights that correct themselves per project after `learn`. Today the weights are fixed and `learn` reports how often the band was right.

## Status
- Done, uncommitted: formula files, `formulas`, `channel`, `mirage:analyse`, the read-only guard, the question / series / pacing parts of the build-story and vlog formats.
- Done, uncommitted (2026-11-09):
  - **A.** Each format file states its numbers in its front matter (`playbook`); `check` measures the cut against them and prints `Playbook (<format>):`, one `✓` / `✗` line per rule with the number, the target and where a miss happens, and `– … not measured` with the reason. A person's `formulas/<format>-mine.md` may carry the same `playbook` object, and its keys replace the format's for that project. Measured: the first word, where the answer starts, the longest stretch with nothing new (no word, no cut, no overlay starting), cuts a minute (over the whole cut, and per beat and after a beat where the playbook states one: the vlog's `bit` beats and what follows its `headline`), words a minute, the idea answers, the chosen title against the format's title shape (`title`: capitals, a number, the first person, how it ends, how many words), the opening, the ending, a standalone short's loop as far as a timeline shows it (its last beat is `loop`; its last music cue doesn't fade), the length against the target (`targetSec` / `warnPastSec` in the playbook, so a person's formula sets each format's length; a short's limit stays the platforms' 3:00), and, for a video in a series, whether an open question is on record for the next episode.
  - **B.** `predict { video }`: scores chosen / stayed / satisfied out of 10 from the measured playbook with a fixed, documented weighting (the chosen title counts 3 in Chosen), names the weakest step and up to five moments with one change each, gives a band against the project's posted videos of the format (4 or more), and writes `episodes/<n>/prediction.json`. `learn` prints `Forecast against result:` for each posted video that had a forecast, and a running count of how often the band was right.
  - **C.** `posted` / `learn` and the `mirage:learn` skill: reads at 3, 7 and 28 days, public numbers plus the Studio numbers the person types, where viewers replayed or left tied to the item of the cut, titles and thumbnails, one experiment per video, the niche as the base when own videos are few. `learn` says when the live title differs from the one recorded as chosen (`titles.chosen` in `video.json`, written by the edit skill's packaging step), names a video's series, and prints how many thumbnails of each half were built from two sources. `posted` warns when `video.json` names a format Mirage doesn't have (the snapshot is then a build story's).
  - **D.** A teaser answers one small question and has no outro card; no fixed 20–45 s; the idea check applies to shorts. One algorithm file per platform: `plugin/formulas/youtube.md` (its "YouTube Shorts" part), `instagram.md` and `tiktok.md`, each the platform's own words first with its sources and what it does not publish. `predict` scores a short once and then holds the same cut to each platform's own rules in a per-platform section (length against that platform's stated limit, the opening, the ending, the covered areas; what a cut can't show is said). There is no score per platform: no platform publishes weights. `posted` records where else the short went (`also`), and `learn`'s `studio` takes a `platform`, so Instagram's and TikTok's numbers are kept and shown per platform; they are typed by the person, and every comparison is of the YouTube numbers.
  - **E.** A series is a folder `series/<slug>/` with `series.json` (name, format, the big question, the open question and the video that left it, running counts with units, the sign-off, the title shape, the thumbnail layout, its episodes' video numbers in order) and a generated `README.md` that lists each episode's title, stage and files. The videos stay in `episodes/<n>/`. `new_video { series }` starts a series or adds a video to one; the `series` tool lists, shows and updates; `status` lists each series with its episodes and open question; the build-story format and the edit skill read the open question and counts for the `recap` and write them back after the final render.
  - **F.** `thumbnail { face, subject }` builds a thumbnail from two sources, each a second of the video or a picture inside the project: two crops side by side with a thin white line, the face about a third of the width, on the side the series keeps. No cut-outs: Mirage has no background removal. `thumbnail.json` records how the thumbnail was made, `features.json` picks it up. Why faces work, with its limits, is in the `algorithm` formula.
  - **G.** The analyse skill saves a starting point into `formulas/<format>-mine.md` whenever a channel is analysed for a format: length, narration density, where the answer lands and the title's shape into its `playbook` front matter, the rest under `## From the niche (untested here)`, each naming the channel and the date; the person's own values are never written over. The edit skill's "about 13 minutes" is gone: the format and the person's formula own the length, and narration follows the format's density (`wordsPerMin`) where one is set.
- Not built, on purpose:
  - A: a vlog's held `headline` has no pace of its own (its "2 changes a minute" is about camera angles, which a timeline doesn't show); whether a short's last line really leads into its first shot is not measured (Mirage can't hear it); the covered areas stay `⚠` lines in `check`. No `firstWordSec` for the build story or the vlog, no `cutsPerMin` for the build story and no `wordsPerMin` for the vlog or the short: the format and formula files give no number for them (a person's formula can).
  - A: the title's shape is measured, not its meaning: "setup not result" and "an obstacle, a deadline or a hidden who" are still the skill's judgement.
  - B: the weights are fixed (see Later).
  - D: no per-platform score or band, and no reading of Instagram or TikTok numbers. Another app's watermark and whether the sound is on are not looked for. TikTok's covered areas are not measured (it publishes no margins). Hook experiments are the learn skill's rule (the opening first when viewed vs swiped is the weak number); two renders of one short are in Later.
  - E: episodes are not moved into the series folder; it groups them by number, and its README is rewritten when the series is saved or shown, not on every render.
  - F: a two-source thumbnail is for a landscape video only, and neither source may be a card.
