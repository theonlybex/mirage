---
name: overnight
description: "Edit one or more Mirage videos overnight, unattended, up to the guide cut the person records their voice-over against in the morning. Use when the viewer says the person wants videos edited overnight, or the person asks for an overnight edit."
---

# Editing overnight

The person leaves; you edit their videos up to the guide cut without asking them anything; in the morning they read the report in Mirage's viewer and record the voice-over. Mirage's viewer asks with a line like:

```
Mirage viewer: the person wants videos 2, 3 edited overnight. Use the mirage:overnight skill.
```

With no such line, ask which videos (`mcp__plugin_mirage_engine__status` lists them). Each needs to have been started with `mcp__plugin_mirage_engine__new_video` (the edit skill's step 0): with its footage folders, or made `from` a big video. Its format is the `format` in `episodes/<n>/video.json` (none is a build story): read that format's rules with `mcp__plugin_mirage_engine__formats` and its `id` before editing the video, and follow them, as the edit skill's step 0 says.

First load the `mirage:edit` skill with the Skill tool, then follow its rules throughout: the `episode.json` fields, how to read `⚠` and `✖` lines, and what to do when the person pauses, corrects or stops you.

## 1. Check the Mac
Call `mcp__plugin_mirage_engine__overnight` with `{ videos: [2, 3] }`. It checks that the Mac is plugged in, that the disk has room for tonight's renders and that the tools are installed, then keeps the Mac awake until this session ends.

If it reports problems, pass each one on in plain words and stop there. The person fixes them and asks again.

## 2. Ask the person to get the Mac ready
Tell them, in one message:
- Switch Claude Code to auto mode: press Shift+Tab until it says "auto". That way nothing waits for them to say yes overnight.
- Leave the lid open and the Mac plugged in. The screen can be off.

If you haven't yet told them for this project, add: "Your footage stays on this Mac, but frames, transcripts and audio from it go to Anthropic so I can see and hear it."

Start once they say it's done.

## 3. Edit each video, never asking
For each video in turn, follow the mirage:edit skill from its step 1 (catalog the footage folders in `episodes/<n>/video.json`) through step 4 (the narration lines and `mcp__plugin_mirage_engine__guide`). Don't stop at the rough cut, and don't wait for the person to read the lines. When `episodes/<n>/video.json` asks for AI narration, or the person asked for it, call `mcp__plugin_mirage_engine__speak` after the lines and then `mcp__plugin_mirage_engine__render`, instead of stopping at the guide (the edit skill's step 4 says how).

After the final render, call `mcp__plugin_mirage_engine__thumbnail` for candidates and once with `at` for the best one, and log it with kind `guess` for the person to confirm.

Never ask the person anything; nobody is there to answer. Instead, write it down for the morning with `mcp__plugin_mirage_engine__log` (`{ video: n, kind, text }`):
- Where you would have asked, make your best guess and carry on, then log it with kind `guess`: "Used the second take of the intro, because the first one cuts off mid-sentence."
- What only the person can answer (a number for a counter, what went wrong off screen, how long something took) goes in with kind `question`. Leave that thing out of the video meanwhile: never invent footage, numbers or events.
- A vlog whose `episodes/<n>/video.json` has no `vlog` (its name and date): leave out the title card and log a `question` asking for the vlog's name and the day it was filmed. The vlog rules say never guess the date.
- Doubts about your own choices go in with kind `concern`: "The montage may be too long for how little happens in it."

Write each in plain words, one point per entry. The `⚠` lines of the tools that take a video (`check`, `cut`, `slots`, `guide` …) are already kept for that video's morning report; act on them where you can and don't log them again. The `⚠` lines of `ingest` and `music` may not land on the right video when several are edited in one night: log each one that matters for a video with kind `concern` for that video.

## 4. When a step fails
A step that fails with a `✖` is tried once more, after fixing what its message says if you can. If it fails again, log a `concern` saying what failed, and move on to the next video.

The person can still pause, correct or stop you from the viewer. Follow the edit skill: act on a correction, and after a stop make no more tool calls, not even for the next video. Say in one line what was finished.

## 5. Finish
When the last video has its guide cut (or its final video, for AI narration), say: "Done for tonight. Mirage's viewer has the morning report."
