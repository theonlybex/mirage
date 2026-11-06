---
name: voiceover
description: "Fit the person's voice-over recording to a Mirage video and render the finished video with captions. Use when the viewer says the person dropped a voice-over recording, or the person gives you the path to one."
---

# Fitting the voice-over

The person recorded their narration along with the guide cut. Mirage's viewer tells you with a line like:

```
Mirage viewer: the person dropped a voice-over recording for video 2: “/Users/sam/Movies/vo.m4a”. Use the mirage:voiceover skill.
```

Use the path between “ and ” exactly as it is. With no such line, ask the person which video and where the recording is (`mcp__plugin_mirage_engine__status` lists the videos).

First load the `mirage:edit` skill with the Skill tool, then follow its rules throughout: how to read `⚠` and `✖` lines, what to do when the person pauses, corrects or stops you, and never inventing anything. Engine messages here often carry a command-line hint, such as `… vo … --add` or `Run: … slots <project> 2`: call the matching engine tool instead (`--add` is `add: true`, `--slots n2,n5` is `slots: ["n2", "n5"]`). Never run `pnpm` or any other command for Mirage's steps.

If the person would rather not record, or wants an AI voice, use `mcp__plugin_mirage_engine__speak` instead of a recording: it reads the written lines with Kokoro and fits them like `vo` does (the edit skill's step 4 says how).

## 1. Fit it
Call `mcp__plugin_mirage_engine__vo` with `{ video: n, recording: "<path>" }`.
- The first recording, or a new recording of every line: no `add`.
- A recording of just the lines the last fit reported missing: `add: true`. It fits only those and keeps every line already placed.
- A recording of particular lines again (a partial or re-worded line): `add: true, slots: ["n3"]`. A listed line the new recording lacks says `kept the earlier take`.

## 2. Render
Unless `vo` stopped with a `✖`, call `mcp__plugin_mirage_engine__render` with `{ video: n }`. It makes `final.mp4` and its captions, and the finished video shows in Mirage's viewer as the next version. Lines still missing are left out of this render; they can be added later.

## 3. Tell the person, in plain words
Read the `vo` report and say:
- **Lines that held the picture:** the picture waited for them, nothing to do.
- **Missing lines** (`not found: n2, n5`): "Lines 2 and 5 weren't in the recording. Record just those, in any order, and save it under a new name, not over the first recording. Then drop it in Mirage's viewer again."
- **Partial lines** (`only part of the line was found`): "Only part of line 3 was found. Read the whole line again, on its own, and drop that recording in."
- **Too-long lines** (`too long`): "Line 4 runs longer than its spot in the video." Offer to shorten the line or give it more picture; after that, they re-record it.

When they come back with a new recording, fit it with `add: true` (and `slots` for particular lines), then render again.

## When `vo` or `render` refuses
- `<file> is not the recording … were cut from`: the earlier recording was saved over. Ask them to put it back and save the new take under another name, or to record every line again (then `vo` without `add`).
- `No speech was heard in <file>` / `<file> has no audio track`: the wrong file, or the mic was off.
- `episode.json changed while vo was running`: call `vo` again; the transcript is kept, so it is quick.
- `The cut changed since slots were written — run slots first`: call `mcp__plugin_mirage_engine__slots`, check the lines it carried over, then `vo` again.
- `No narration lines are written yet`: the lines come first. Follow steps 4 and 5 of the edit skill.
- `⚠ nN's line changed since vo`: the recorded line no longer matches what is written. Have them record that line again (`add: true, slots: ["nN"]`), or put the wording back. When the voice-over came from `speak` (its recording is `episodes/<n>/narration-<k>.wav`), call `speak` with `slots: ["nN"]` instead.
- `render` refuses a recording changed since `vo` fitted it: ask them to put back the recording that was fitted, or call `vo` again with the new one.

## 4. Finish
When every line is placed and the final video is rendered, write `episodes/<n>/summary.md` (what was attempted, what broke, what's left, counter values) for the next video's recap, and suggest a title in the format: all caps with a number ("I BUILT X IN 7 DAYS", "X SAID IT WAS IMPOSSIBLE").
