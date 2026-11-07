---
{"id":"vlog","name":"Vlog","describe":"A day or a week of someone's life told as a few funny bits, ending on the headline bit.","words":["vlog","day in the life","trip","week","hanging out","weekend"],"beats":["cold-open","title-card","premise","bit","headline","sponsor","plugs","tag"],"targetSec":260,"warnPastSec":400,"output":{"width":1920,"height":1080},"captions":{"style":"chosen"}}
---
A vlog is a day or a week of someone's life told as a few funny bits, ending on the headline bit: the one the title promises, held back until it pays off. It always moves; only the big reactions are slow, and they are what people came for.

## Length
About 4:20 (260 s), the classic length; `check` warns past 6:40. When the person asks for long vlogs (the "now" style, 10–16 min), pass `targetSec` (600–960) to `new_video`, or set it in `episodes/<n>/video.json`. Cut whole bits before thinning laughs: when the vlog runs long, drop the weakest bit rather than trimming the laughs inside the bits that stay.

## Starting a vlog
Pass `vlog: { name, date }` to `new_video`: `name` is what the person calls their vlogs (ask once, then reuse it: an earlier vlog's `episodes/<n>/video.json` has it), and the number counts up from the project's last vlog of that name by itself (give `number` only when the person says which it is). `date` is the day most of the footage was filmed, as `M-D-YY` (`11-6-26`): ask the person to confirm it, never guess it.

## Beats, in order
1. `cold-open`: an 8–15 s standalone gag, unrelated to the title (a prank, an odd moment from the day). Never a flash-forward to the headline. Often one slow shot: the speed comes after the title card.
2. `title-card`: a 2 s `mono` card, three lines from `vlog` in `episodes/<n>/video.json`: `<name>\nVlog #<n>\n<M-D-YY>`, e.g. `{ "id": "t1", "beat": "title-card", "card": { "text": "Sam\nVlog #3\n11-6-26", "style": "mono", "sec": 2 }, "quiet": true }`.
3. `premise`: 30–50 s to camera, fast, explaining the day or the surprise. Jump-cut between words, not only at pauses, to keep it moving. A sponsor read (its own item, beat `sponsor`) goes right here, after the title card (about 35 s). In a long vlog it goes mid-video instead: 25–45 s, 21–70% of the way in, never at the open, voiced over B-roll from the day and ending on a gag.
4. `bit` × any, then the `headline`. Build-ups are fast and handheld: shots of about 2 s (1–3 s), 15–25 cuts a minute. The reveal or the big reaction is held long on one angle (50–90 s on one fixed camera, about 2 changes a minute), trimmed with jump cuts on that same angle: the reaction is the content, so don't cut away from it. Long sit-down talks and payoffs may hold one setup for 20–60 s. After the headline's reveal, the back half rides on music (travel, a montage, a celebration): 20 or more cuts a minute and almost no talking.
5. `plugs`: full-screen `bold` cards (merch, socials, "vlog continues on…"), only when the person has something to plug, in the words they gave. Otherwise leave the beat out.
6. `tag`: one more gag or moment after the cards, 4–20 s. Never end on a card, on black or on a sign-off: the tag rewards the people who stay to the end.

## Cutting
- Cut out on the laugh. The person's own laugh works as a laugh track: end the shot as it lands. Cut in on the line just before the joke, and drop setup chatter the joke doesn't need.
- Let the laugh ring with a short `tailOut` when the next shot is quiet.
- Speech is front-loaded: most of the talking comes in the first minute (55–74% of all words in the classic vlogs), then a music-led back half.
- Show it instead of explaining it: B-roll over explanations and sponsor reads; phone screens, texts and video calls full frame.
- Spectacle is what viewers replay (a physical gag, a kiss, fireworks, an animal or a stunt moment): give it room.
- Slow motion and replays sparingly, if at all.

## Music and sound
- Use one song per bit, changed at each bit, from the person's own `music/` tracks. Hit songs bring copyright claims that take the ad money or block the video, so use licensed library music.
- Drop the music before punchlines and reveals with `dips` on the cue, so the room sound carries them.
- Sound effects for jokes and emotional beats, as the edit skill says: seasoning, not on every cut.

## Text on screen
- `captions` `chosen`: no automatic captions. Put a few yellow `subtitle` overlays on chosen lines only, words copied from the transcript.
- A `name` label the first time someone appears: their name in bold, and under it a joke line that is true to them and never mean. The line comes from what the footage or the person says about them: ask the person when unsure, and never invent one.
- Time cards for jumps in time: a `bold` card ("Not even 2 days later...") or a yellow `timecard` overlay ("EARLIER") when the picture should keep playing.
- Plug cards near the end (above), and the `mono` title card. No other full-screen cards (phone screens, texts and video calls full frame are fine).

## Packaging
Suggest titles in either style and let the person pick (3 options in `summary.md`, each 3–8 words):
- The classic: ALL CAPS, ending "!!", hiding who and what, with an optional tag in brackets ("SURPRISING BEST FRIEND WITH LAMBORGHINI!!", "SHE SAID SHE'D NEVER DO THIS AGAIN!! (CAUGHT)").
- The current one: sentence case, first person, no "!!" ("This was a bad idea").

A title never claims what the vlog doesn't show.

Thumbnail: no text, no arrows. Pick a frame with a wide-open laughing or shocked face and the cause in frame, as the edit skill says (`thumbnail`, candidates first); call it without `text`.

The description follows the edit skill's order: schedule line, sponsor code, plugs, socials, "People in the video" with the handles the person gave, credits. Take nothing from anywhere but the person and the catalog.

## Guardrails
- Only people who agreed to be on camera. Leave out bystanders and anyone who didn't agree to be shown; if they matter to a bit, ask the person.
- What the person said must not show (`hide`) stays out.
- The edit shapes how people come across: never make anyone look worse than they were.
- No sexual storylines built around anyone drunk, and never glorify injuries from stunts.
- A gambling sponsor read follows the ad rules (18+, local limits): pass that on to the person.
