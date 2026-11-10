---
{"id":"build-story","name":"Build story","describe":"A build told as a story: the stakes, the failures, a montage, the reveal.","words":["build","episode","part","series","project","devlog"],"beats":["cold-open","title","recap","new-toy","problem","montage","twist","truth","outro","blooper"],"output":{"width":1920,"height":1080},"playbook":{"answer":{"beat":"truth","fromShare":0.85,"toShare":0.93},"emptySec":8,"wordsPerMin":{"min":145,"max":200},"ideaNeeded":true,"endsOn":["outro","blooper"],"title":{"allCaps":true,"hasNumber":true,"words":{"min":6,"max":8}}}}
---
A build told as a story: the stakes, the failures, a montage, the reveal. Its beats, in the order they usually come: `cold-open`, `title`, `recap`, `new-toy`, `problem`, `montage`, `twist`, `truth`, `outro`, and `blooper`.

The measurements behind these rules: `formulas { id: "episode" }`; the reasoning under every format: `formulas { id: "algorithm" }`; how YouTube judges a video: `formulas { id: "youtube" }`.

The rules for these beats are in the mirage:edit skill, and they stay there: step 3 ("Beats in order" and the rules under it) and step 6 (the summary and the title). Follow them as written there. This file adds what sits on top of them: the question an episode is built on, the series it belongs to, how it keeps people watching, and how it ends. Its Packaging part below builds on the edit skill's. Where the two differ, this file wins.

## The question
A build story sells one question: will this broken or unfinished thing ever work? Before writing the timeline, find these four in the footage, the catalog and the person's answers, and ask the person for any that are missing. Never invent one.
- The gap: what the thing should be and what it is now. The wider the distance, the stronger the episode.
- The question: one, with an answer the camera can see happen (it starts or it doesn't, the test passes or fails).
- The doubt: who or what says it will fail (someone who refused to help, a deadline, a missing part, the odds).
- The stake: a loss the viewer can count (money spent, days left, attempts used).

When the gap or the question is missing, say so before cutting: a better edit doesn't fix an episode with no question.

## The series
- A project runs over 3–6 episodes: getting it, the first attempt, the work, the first use, the verdict. Each answers a smaller version of the big question.
- The first episode of a project draws the most viewers: give it the widest gap and the strongest thumbnail.
- Every episode's `outro` ends on one open question that the next episode answers. Write that question into `summary.md`, and record it in the series (below), so the next episode's `recap` can pick it up.
- A series is a folder, `series/<slug>/`, that groups its episodes and carries from one to the next: the open question, the running counts (cost so far, attempts used), the sign-off, the title shape and the thumbnail layout (`series.json`; `README.md` beside it lists the episodes). Start an episode with `new_video { series: { name } }`. Its `recap` reads the series' open question and counts (`series { name }`); after the final render the edit skill records the question this episode leaves open and the counts as they now stand (`series { name, openQuestion, video, counts }`), with numbers from the person or the catalog only. `check` says, for a video in a series, whether an open question is on record for the next episode.

## The episode
- `cold-open`: the first sentence is the situation and the stake. No greeting and no logo.
- `recap`: within 30 s a newcomer knows the stake and the doubt, in the doubter's own words when the footage has them. In a series it opens on the question the last episode left open and the counts so far, as the series holds them. Then "today the plan is…".
- `problem`, `montage` and `twist`: trouble comes early and wins come late. Most setbacks belong in the first 60% of the episode, most wins in the last 30%.
- `truth`: the answer lands late, 85–93% of the way through. Show it on a real reaction and don't cut away from it.
- After the `truth`, close the account with a number the person or the catalog gave: cost against value, before against after, the final count.
- `outro`: the next question in one sentence, then the same sign-off every episode (the series' `signOff`). A `blooper` after it rewards the people who stay.

## Keeping people watching
- One question is always open. In narration, voice a doubt about every 40–55 s ("hopefully", "the problem is", "we don't know if"), and never go more than 4 minutes without a doubt, a setback or a win. Every doubt is a real one from the footage or the person.
- Leave no empty stretch: narration written after the cut runs at 145–200 words a minute and explains each part in plain words. A `quiet` reveal is the exception.
- Length follows the material: an episode is as long as it stays this dense. Mirage sets no length for a build story. The person's own formula does: `targetSec` and `warnPastSec` in the `playbook` of their `build-story-mine` formula, first taken from the leading channels of their niche (series episodes of 30 minutes do well on some channels, because a long episode leaves fewer chances to click away), then moved by their own results. Never pad.

## Packaging
The title: all caps with a number, as step 6 of the edit skill says ("I BUILT X IN 7 DAYS"), in the first person, 6–8 words. It states the setup and never the result. `check` holds the title the person picked (`titles.chosen` in `video.json`) to the measurable part of this: in capitals, with a number, 6–8 words (`title` in this file's `playbook`; a series keeps its own `titleShape` in words). The shapes that do best: "I BOUGHT / STARTED A [broken state] [thing]", "ATTEMPTING TO [start / finish] …", "… IN [N] DAYS", "[the doubter] SAID IT WAS IMPOSSIBLE". A plain "REBUILDING …" with no obstacle is the weakest.

The thumbnail: the before/after or the reveal, with a face in it if there is one; it is picked and written as the edit skill's "Thumbnail, title and description" says. Among the candidates, prefer a frame with the person on one side and the thing on the other, its broken side towards the camera, and keep that layout for every episode of the series: the series stores it (`thumbnail: { face, share }`). When the face and the thing are never in one good frame, build the thumbnail from two sources (`thumbnail { face, subject }`): the person's face from one second of the video, or from a photo they give, on one side, about a third of the width, and the thing from another second filling the rest. They are two crops side by side; nothing is cut out. No words from the title on it; a price or a count at most, and only when the person asks for words.
