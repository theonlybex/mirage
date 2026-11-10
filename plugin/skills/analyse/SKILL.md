---
name: analyse
description: "Analyse a YouTube channel from its public data and save what makes its videos do well as a formula, or find out why the person's own channel isn't working and what to change. Use when the person wants to know why a channel's videos do well, to learn from their own or another channel, to add a formula of their own, or asks why their videos aren't getting views."
---

# Analysing a channel

This is the process Mirage's own formulas were made with, saved so you can run it without the person explaining it. It has two uses:

- **Learn from a channel** (theirs or anyone's): what its best videos share, written down as a formula the person can edit by (steps 0–7).
- **"Why isn't my channel working?"** (their own channel): the same gathering, then a diagnosis of what is working, what is missing and what to change, and a formula of their own (steps 0–4, then "When it is the person's own channel").

Speak to the person in plain words. Say what you are doing in a line before each step; an analysis takes a while.

## The engine tools

| Tool | Input | What it does |
|---|---|---|
| `mcp__plugin_mirage_engine__channel` | `{ url, videos? }` | lists the channel's newest videos (default 200, at most 1000): titles, lengths and views. Writes `analysis/<name>/videos.json` and reports the name to use next, the medians, lengths, title habits, and three lists of 12: most viewed, newest, least viewed of the latest 60 |
| | `{ name, patterns: [{ label, regex }] }` | for each title pattern: how many titles match, the median views with and without, and the ratio (`×1.35`), over all videos and over the latest 60 |
| | `{ name, thumbnails: "top" \| "newest" \| "lowest" }` | writes `analysis/<name>/thumbs-<which>.jpg`, 12 thumbnails tiled 4 across in reading order, and lists the 12 videos in tile order |
| | `{ name, captions: [ids] }` | for 1–5 videos: writes each transcript to `analysis/<name>/<id>.txt` and reports its length, words a minute per 5-minute block, most replayed points, chapters, and the words of its first 150 s and last 100 s |
| `mcp__plugin_mirage_engine__formulas` | `{ id? }` | lists the formulas: Mirage's own (`algorithm`, `youtube`, `instagram`, `tiktok`, `episode`, `vlog`, `short`; they can't be changed) and then the person's own, marked `(yours)`; with `id`, that formula's whole file |
| `mcp__plugin_mirage_engine__formats` | `{ id? }` | the kinds of video Mirage makes; a formula says which of them it is for |
| `mcp__plugin_mirage_engine__new_project` | `{ title }` | starts a Mirage project in this folder, when there is none yet |

Below, a tool is written by its short name (`channel`, `formulas` …). `channel` does one thing per call, needs a project (`✖ no Mirage project at …`: ask what to call it and run `new_project`), and needs yt-dlp. It reads public data only: the video list, the thumbnails, the automatic captions and the "most replayed" graph. It never downloads a video, and neither do you.

## The rules of honesty

These hold through every step, and go into whatever you write:

- **"×" shows what goes with more views, never proof of cause.** Old videos have had longer to collect views, and a big idea gets both the bold title and the views. Say "goes with", not "causes".
- **The share-per-part table is an estimate.** Nobody outside YouTube can measure it. Label it "(my estimate)" every time.
- **Say what was not measured.** Cut rate, camera work, and click and retention rates are not in public data. The one exception: the person's own channel, when they give you the numbers from YouTube Studio.
- **Only public data.** Never sign in anywhere, never ask for the person's password, never use another tool to get past a private or members-only video.
- **Never download a video.** Captions, thumbnails and numbers are enough.
- **Other creators' thumbnails stay in `analysis/`.** Don't copy them elsewhere, don't use them in the person's videos or thumbnails, and don't republish them.
- **Never invent a number.** Every number in a formula or a diagnosis comes from a tool's report, a file in `analysis/`, or the person. When you don't have one, say so.
- **Never copy the creator's subject.** A formula is the question underneath, stated so it works without that creator's budget or fame.
- **Mirage's own formulas, formats and skills are read-only.** Never write into the plugin's folders. A person's formula goes only in the project's `formulas/` folder. To change a Mirage rule for themselves, the person saves their own formula under a new id; they never edit or replace Mirage's.

## 0. Ask

Ask only two things, in one message:
- Which channel? Its address or `@handle`. One channel, or several of one niche (then run steps 1–4 for each and compare them in step 5).
- Which format is it for? A build story, a vlog, a short (`formats` lists them), or something else.

If they ask why their own channel isn't working, or say the channel is theirs, it is the second use: remember that for step 4 and after.

For a channel of Shorts, give `channel` the address of its Shorts tab (`https://www.youtube.com/@handle/shorts`): it is kept under its own name, `<handle>-shorts`.

## 1. Gather the videos

`channel { url }`. Read the three lists and the numbers above them. Note the name the report says to use; every later call takes it as `name`.

Tell the person in two or three lines what stands out: how many videos, the typical views, how long the videos are, how the titles are written.

- `⚠ <k> of <n> videos have no view count (members-only, upcoming or live) — they are left out of the medians and the most and least viewed lists`: nothing to do; mention it if it is a large part of the channel.

## 2. Titles

From the three lists, propose 8–12 patterns and run them in one call, `channel { name, patterns }`. A pattern is a label and a regular expression tried on each title, ignoring case. Look for:
- the opening words ("I BOUGHT", "ATTEMPTING TO");
- a doubter or an obstacle ("REFUSED", "IMPOSSIBLE", "SAID");
- a deadline ("IN \d+ (DAYS|HOURS)");
- a price (`[£$€]\s?\d`);
- hiding who or what ("SHE", "HE", "THIS" as a word);
- drama words ("CAUGHT", "CONFESSED", "EXPOSED");
- bracket tags (`\(.+\)\s*$`), "!!", emoji;
- the kind of subject (the rare thing against the ordinary one);
- anything the most viewed list has and the least viewed list lacks.

Title length is in step 1's report already (the views by length bucket are video length, also from step 1).

**Judge on the latest 60 first.** Older videos have had longer to collect views, and the channel was smaller then; the "all" line is the second opinion. `too few to compare` means one side has under 3 videos: that pattern says nothing either way, so don't quote a ratio for it. A ratio near ×1.00 means the pattern adds nothing by itself; say that too, it is a finding.

If the first round suggests a sharper pattern, run a second round. Two rounds are usually enough.

## 3. Thumbnails

`channel { name, thumbnails: "top" }` and `channel { name, thumbnails: "lowest" }`; also `"newest"` when the newest videos look different from the most viewed (the style changed). Read each sheet with the Read tool: the tiles are in reading order, matching the numbered list in the report.

Count, out of 12 on each sheet, and write the counts down:
- where the face is (left, right, centre, none) and how large;
- the expression (smiling, shocked, worried, mouth open);
- what fills the rest of the frame (the subject, and its state);
- text (none, words from the title, a price, a stamp);
- props, arrows, circles, badges;
- second people;
- the background (does it say where?), and the look (a real frame, or cut out and staged).

Then say what differs between the top sheet and the lowest sheet. That difference is worth more than either count alone.

- `⚠ no thumbnail could be fetched for <id> (<title>) — it is left out of the sheet`: the sheet has fewer tiles; count out of the number it has, and say so.

## 4. Inside the video

`channel { name, captions: [ids] }` for 3 videos, picked from the lists: a first episode or a typical hit, a middle one, and a recent one. For the person's own channel, pick 2 of their best and 2 of their weakest instead.

From the report, and from the transcript file when you need more (`analysis/<name>/<id>.txt`, each line with its time), read:
- how it opens: the first sentence, and what a stranger knows after 30 seconds;
- how it ends: the last lines, a sign-off, what comes after it;
- the pace: words a minute per block, and where it drops;
- where the answer to the title lands, as a share of the video;
- the most replayed points, and what is said there;
- how often a doubt ("hopefully", "the problem is", "we don't know if"), a setback and a win are voiced: count them in the transcript and give the count and the rough spacing, as approximate.

- `⚠ <id> “<title>”: no English captions — no transcript for this video`: its most replayed points and chapters are still reported; pick another video for the words.
- `⚠ <id>: yt-dlp couldn't read this video (<why>) — it is left out` or `⚠ <id>: yt-dlp wrote no info for this video — it is left out`: the video is private, age-restricted, removed or a live stream. Pick another.
- `Most replayed: YouTube shows none for this video`: small or new videos have no graph. Say it was not available; don't guess where people rewatch.

Captions are automatic: names and numbers in them can be wrong. Quote them as "the captions say".

## 5. Find the question underneath

Read `formulas { id: "algorithm" }` and state, for this channel:
- **the gap**: the familiar thing and the wrong state it is shown in;
- **the one question** every video asks, with an answer a camera can see;
- **the doubt**: who or what says it will fail;
- **the stake**: what the viewer can count as lost.

State each so it applies to someone without this creator's budget, fame or friends, with two or three low-budget versions. If you can't state the question in one sentence, look again at what the top 12 share that the lowest 12 lack. Never just copy the creator's subject ("buy a wrecked supercar" is a subject; "will this broken thing ever work?" is the question).

With several channels of one niche, say what they share (that is the niche's formula) and what only one does (that is a style).

## 6. Write the formula

Write `formulas/<id>.md` in the project (make the `formulas` folder if it isn't there). The id is lower-case words with hyphens, equal to the file name, and not one of Mirage's own (`algorithm`, `youtube`, `instagram`, `tiktok`, `episode`, `vlog`, `short`). The file starts with a `---` line, one line of JSON, and a `---` line:

```
---
{"id":"cooking-shorts","name":"Cooking shorts formula","describe":"One line: what kind of video, and the question it sells.","formats":["short"],"source":"@handle (latest 200 videos, 24 thumbnails, the captions of 3 videos), measured 2026-11-09"}
---
```

`formats` holds the ids of the formats it is for (it may be empty: `[]`); `source` says in one line what was measured and when. No other keys.

Then the formula in Markdown, with the same sections as Mirage's `episode` and `vlog` formulas (read one with `formulas { id: "episode" }` and follow its shape):
1. What it is for and what it was derived from, and the sentence about what "×" means.
2. **The question this format sells.**
3. **The idea**: the gap, the doubt, the stake, and low-budget versions.
4. **Title**: the shapes, each with its ×.
5. **Thumbnail**: the layout.
6. **The video, in order**: a table of where and what.
7. **Keeping people through it.**
8. **What matters most (my estimate)**: the share table, labelled as an estimate.
9. **Checklist before publishing.**
10. **Every measured detail**: the thumbnail counts, lengths, titles, and what the captions showed.
11. **Not measured.**

Then show it with `formulas { id }`, and tell the person it is now listed under `formulas`, marked `(yours)`, and that the edit skill can follow it when they make a video of that format.

- `✖ formulas/<file>: <issue>` in the list: the file you wrote is broken and left out (the line names the key or the problem). Fix it and list again.
- `✖ formulas/<file>: "<id>" is one of Mirage's own formulas, which can't be changed — save yours under another name`: rename the file and its `id`.
- `✖ plugin/formulas/<file>: <issue>` or `✖ plugin/formulas: the folder is missing or unreadable`: one of Mirage's own is broken; suggest reinstalling the Mirage plugin. Don't repair it.
- `✖ unknown formula "<id>"`: the next line lists the ids there are.
- A write refused with `Mirage's own formats, formulas and skills are read-only. Save your own formula in the project's formulas folder, under a new name.`: you tried to write into the plugin. Write in the project's `formulas/` folder instead.

## 7. Save a starting point in the person's formula

Whenever a channel was analysed for a format, do this without being asked: the research worked for that channel, so it is a good starting point for the person's own videos of that format. Besides the channel's own formula file (step 6), save the findings that would shape an edit into the person's formula for the format, `formulas/<format>-mine.md` (`build-story-mine`, `vlog-mine`, `short-mine`): the file the mirage:edit skill follows and the mirage:learn skill keeps. When it isn't there yet, create it as the learn skill's step 3 says (the same front matter and sections, with no rules yet).

What to save, each only when you measured it in steps 1–4:
- **Length**: the channel's typical length and its range, from step 1's report (and the lengths of its most viewed videos).
- **Pace**: cuts are not in public data, so save only what the captions showed: where the pace drops and where it holds.
- **Narration density**: words a minute, from the `captions` reports.
- **Where the answer lands**: as a share of the video, from step 4.
- **Title shapes**: the patterns of step 2 that go with more views on the latest 60, each with its ×, and how the titles are written (capitals, a number, how they end, how many words).
- **Thumbnail layout**: the counts of step 3: the side the face is on, how large, what fills the rest, text or none.

Where it goes:
1. The measurable ones go into the formula's `"playbook"` front matter, the override `check` and `predict` already read (each key replaces the format's for this project): the length as `"targetSec"` (the typical length, in seconds) and `"warnPastSec"` (the top of the range the channel's good videos stay within; left out, `check` warns past 1.5 × the target); the narration density as `"wordsPerMin": { "min", "max" }`; where the answer lands as `"answer": { "beat", "fromShare", "toShare" }` (the format's own answer beat: `truth`, `headline` or `payoff`); the title's measurable shape as `"title": { "allCaps", "hasNumber", "firstPerson", "endsWith", "words": { "min", "max" } }`, only the parts the channel's titles share. For example, a build-story channel whose episodes run about 30 minutes: `"playbook":{"targetSec":1800,"warnPastSec":2400,"wordsPerMin":{"min":150,"max":190}}`. Never a number you didn't measure, and no cut rate: public data has none.
2. The rest (the title patterns with their ×, the thumbnail layout, the pace notes, how it opens and ends), and one line for every playbook number you set, go under the heading `## From the niche (untested here)`, the same heading the learn skill uses. Every line names the channel it came from and the date, and says it is untested on this audience: "Length: about 30 min, range 24–41 min (from @handle, 2026-11-09; untested here) → playbook `targetSec` 1800, `warnPastSec` 2400".
3. Append an entry to `formulas/changes.md` as the learn skill's step 5 says, with `- Evidence: from @handle's public data (<what was measured>), not from this project's own videos` and `- Confidence: untested here`.

They are starting points, not rules. The mirage:learn skill confirms or replaces each one from the person's own results; until then `check` measures the person's cuts against them, and its header says so (`Playbook (<format>, with your <format>-mine formula's targetSec, …):`).

**Never write over the person's own results.** When `formulas/<format>-mine.md` already has a value for a key from their own videos (a rule under `## Rules`, or a playbook key that `formulas/changes.md` shows came from their results), keep it. List the channel's number under `## From the niche (untested here)` as an alternative to try ("Alternative to try: answer at 85–90% (from @handle, 2026-11-09); yours is 70–80% from your own 6 videos"), and leave the playbook key as it is. A starting number an earlier analysis put there (its line is under `## From the niche (untested here)`) may be replaced by a newer analysis; say which channel it now comes from, and log it in `changes.md`.

With several channels of one niche, save what they share; where they differ, save the range and name each channel.

Check the file with `formulas { id: "<format>-mine" }`, then tell the person in two or three lines what the starting numbers are, that they came from that channel and are untested on their audience, and that each format keeps its own length this way (a series' episodes can be long, a vlog short), moved later by their own results.

- `✖ formulas/<format>-mine.md: <issue>` in the list, or after `check`'s listing: the front matter you wrote is broken (the line names the key), so the format's own numbers are used meanwhile. Fix it and list again.

## When it is the person's own channel

Run steps 1–4 on their channel: `channel { url }`, the title patterns, the `top` and `lowest` thumbnail sheets, and `captions` for 2 of their best and 2 of their weakest videos. Then:

1. **Score their recent videos.** Take the latest 10–20 (from the Newest list and `analysis/<name>/videos.json`). Score each against the idea test in `formulas { id: "algorithm" }`: gap, question, doubt, stake, one picture, face; 0–2 each, out of 12. Score from the title, the thumbnail (the `newest` sheet covers the latest 12) and the captions where you gathered them; where you have neither picture nor captions for a test, write "not seen" and don't guess. Then hold the same videos against the formula of their format (`formulas { id: "episode" }`, `"vlog"` or `"short"`): its title shapes, its thumbnail layout, its opening, where the answer lands, its ending.
2. **Compare their own top videos with their own lowest**, on the same points: the patterns, the thumbnail counts, the scores, the openings. This difference is the most trustworthy evidence there is, because it is their audience choosing. Where their own numbers disagree with a Mirage formula, their numbers win; say so.
3. **Ask for the numbers only they can see**, in YouTube Studio, for a few of the best and the weakest videos: the click rate on impressions, the average percentage viewed, and for Shorts "viewed vs swiped away". Use them when given, each tied to its step in `formulas { id: "youtube" }`:
   - chose to watch (click rate; viewed vs swiped away): a low number points at the title, the thumbnail or, for a short, the first second;
   - stuck around (average percentage viewed, and where the retention graph drops): points at the opening, the pace and where the answer lands;
   - enjoyed it (likes against dislikes): points at whether the video delivered what the title promised.

   Without them, say which of the three steps you can't judge, and carry on with what is public. Never guess a click or retention rate.
4. **Write `analysis/<name>/diagnosis.md`.** Start with one line saying it is a reading of public data (and of the Studio numbers, when they gave some), not proof. Then:
   - **What is working**: each point with its evidence (which videos, which numbers).
   - **What is missing**: each point with its evidence and one concrete change ("open on the result you are chasing, not the greeting: videos 3, 7 and 12 start with 20 s of hello and are in your lowest 12").
   - Rank both lists, the biggest first, and say why it is the biggest.
   - **Not measured**: what you could not see.

   Tell the person the three biggest points in plain words, with the path to the file.
5. **Write their own formula** to `formulas/<id>.md` as in step 6: what works for their audience, plus the fixes, each fix marked as not yet tested on their channel. Then step 7: what their own best videos share is their own result, so in `formulas/<format>-mine.md` it goes under `## Observations so far` (or `## Rules`, by the learn skill's evidence rule), not under the niche heading. Show it with `formulas { id }` and tell them it is listed under `formulas`.

Once videos made with Mirage are posted, the mirage:learn skill keeps this diagnosis current: each time a video goes live it reads how the posted videos did, holds that against what each cut was made of, and updates the person's own formula for that format (`<format>-mine`). Tell the person so.

One video or a handful of views is too little to diagnose from: with fewer than about 10 videos, say so, score the ideas, and lean on the formula of their format.

## When a tool stops

A `✖` line stops the call; its next line says what to do. Pass it on in plain words.

- `✖ yt-dlp was not found`, then `Install yt-dlp (macOS: brew install yt-dlp; Windows: winget install yt-dlp) or set WORDEDITS_YTDLP_DIR to a folder containing yt-dlp.`: yt-dlp is the free program that reads YouTube's public pages; Mirage needs it only for this skill. Ask whether to install it (the setup skill's yt-dlp step), then run the call again. Installing needs no restart on a Mac.
- `✖ yt-dlp not found in WORDEDITS_YTDLP_DIR (<folder>)`: that setting points at a folder without yt-dlp; put it there or unset the variable (then start a new Claude Code session).
- `✖ yt-dlp could not be started`: the file is there but can't run; reinstall it.
- `✖ yt-dlp exited with code <n>`: the next line is yt-dlp's own reason. A wrong address: check it. "Sign in to confirm" or HTTP 429: YouTube is limiting requests; wait some minutes and try once more, with fewer `videos`. An old yt-dlp often fails on a changed page: update it (`brew upgrade yt-dlp`, `winget upgrade yt-dlp`).
- `✖ yt-dlp exceeded <ms> ms`: the list is very long or the connection slow; run it again with fewer `videos`.
- `✖ "<input>" isn't a YouTube channel address`: ask for the channel's address (`https://www.youtube.com/@handle`) or its `@handle`; a link to one video isn't a channel.
- `✖ no videos were found at <url>`: the address is wrong, or that tab is empty (a Shorts-only channel: use its `/shorts` address).
- `✖ no channel "<name>" has been gathered in this project`: run `channel { url }` first; the next line lists the names there are.
- `✖ channel does one thing per call`, `✖ give url or name, not both: the name comes from the url`, `✖ name is needed: which gathered channel this is about`, `✖ videos goes with url (how many videos to list)`: the input was wrong; the next line shows the four shapes.
- `✖ pattern "<label>": its regex can't be read (<why>)`: fix that pattern and run the call again; nothing was compared.
- `✖ "<id>" isn't a video id`: use an id from the lists.
- `✖ no thumbnail could be fetched`: no internet, or YouTube's image server is unreachable; try again.
- `✖ ffmpeg was not found`: the contact sheet needs FFmpeg; the setup skill installs it.
- `✖ analysis/<name>/videos.json: …`: the file was edited and broke; run `channel { url }` again to write it afresh.
- `✖ Stopped by the person before it finished.`: don't run it again unless they ask. What was already written under `analysis/` stays.

Never run `yt-dlp`, `ffmpeg` or `pnpm` yourself for these steps: the engine tools do it, the same way on every computer.
