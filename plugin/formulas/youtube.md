---
{"id":"youtube","name":"How YouTube recommends","describe":"How YouTube's recommendation system judges a video, long or Short, in YouTube's own words: chose to watch, stuck around, enjoyed it.","formats":["build-story","short","vlog"],"source":"YouTube's Help pages and public statements by its two product leads, read 2026-11-09"}
---
# How YouTube's algorithm works, in YouTube's words

Researched online on 2026-11-09. Everything here is what YouTube itself says: its Help pages and its two product leads (the links are at the end).

**How far to trust this.** It is from YouTube, so it is the firmest thing Mirage knows about the algorithm. But YouTube publishes no thresholds, so your own retention graph in YouTube Studio beats every number anyone else gives you.

## It pulls, it doesn't push
**It pulls videos for a viewer; it doesn't push your video out.** When someone opens the app, YouTube ranks videos for that person at that moment, using their watch history, the time of day and their device. Every viewer gets a different ranking. "The audience is the algorithm."

## The three steps
**It judges a video in three steps**, each time it is shown to someone:
1. Did they choose to watch, ignore it, or tap "not interested"? (Long-form: the click on title and thumbnail. Shorts: stayed vs swiped away.)
2. Did they stick around? Both average view duration and average percentage viewed are used.
3. Did they enjoy it? Likes, dislikes and post-watch surveys. YouTube says it doesn't assume all watch time is valuable, and that no single metric decides.

## Other things YouTube has said
- A new video is tried on varied viewers early, including people who have never seen the channel, and it learns separately for subscribers and non-subscribers.
- The first hours don't decide everything. Some videos peak on day one, others a month later, and old videos can come back.
- Subscribers skip about 90% of uploads. Subscribing is a weaker signal than people think.
- Click rate falls as a video reaches beyond core fans. That is normal.
- One weak video doesn't penalise the channel. Shorts performance doesn't hurt long-form.
- It now uses language models to understand what a video contains, not only who watched it.
- Search ranks by how well title, description and content match the query, plus engagement for that query.
- Titles and thumbnails should be compelling and accurate. Misleading ones get clicks, then lose on steps 2 and 3.
- No posting frequency is required. Quality over volume.

## YouTube Shorts
This part is the one a short points at; the same short on Instagram Reels and TikTok is held to `formulas { id: "instagram" }` and `formulas { id: "tiktok" }`. Shorts differ from long-form:
- There is no click. Viewers swipe without knowing what's next, so the opening is the whole pitch.
- A Short goes to a small "seed audience" first. How they respond decides whether it spreads or tapers off.
- No length is favoured: "as long as the story needs".
- Posting more, posting at a certain time, and custom thumbnails don't help. Deleting and reposting can look like spam.
- Trending audio from YouTube's library can put a Short on that sound's page.
- Since March 2025 the public view count includes every start and replay; "engaged views" is the stricter number, and the one that pays.
- A Short is a vertical or square video of up to 3 minutes; a longer one is an ordinary video.

Mirage's `predict` holds a short to these in its `YouTube Shorts:` lines: the length against 3:00, the opening, the ending, and the captions and overlays against the areas the buttons cover. It gives no score per platform: no platform publishes weights.

## What a channel's owner can check against each step
The numbers are in YouTube Studio, and only the owner sees them:
1. Chose to watch: the click rate on impressions (long-form); "viewed vs swiped away" (Shorts).
2. Stuck around: average view duration and average percentage viewed, and where the retention graph drops.
3. Enjoyed it: likes and dislikes. The post-watch surveys aren't shown.

## Not measured
YouTube gives no thresholds, no weights for the three steps, and no numbers for a "good" click rate or retention; anyone who quotes one is guessing or quoting their own channel. Nothing here was measured by Mirage: it is what YouTube has said, as of the date above, and YouTube changes it.

## Sources
YouTube itself:
- Search & discovery tips, Shorts: https://support.google.com/youtube/answer/11914225?hl=en&co=YOUTUBE._YTVideoType%3Dshorts
- Search & discovery tips, video: https://support.google.com/youtube/answer/11914225?hl=en&co=YOUTUBE._YTVideoType%3Dvideo
- How YouTube recommendations work: https://support.google.com/youtube/answer/16089387?hl=en
- On YouTube's recommendation system: https://blog.youtube/inside-youtube/on-youtubes-recommendation-system/
- Todd Sherman (Shorts lead), 2023: https://techcrunch.com/2023/08/25/youtube-demystifies-the-shorts-algorithm-views-and-answers-other-creator-questions/
- Todd Beaupré (growth and discovery), 2025: https://www.searchenginejournal.com/how-youtubes-recommendation-system-works-in-2025/538379/
- Todd Beaupré, September 2026, as reported: https://ppc.land/subscribers-skip-90-of-uploads-in-their-feed-youtube-director-says/
- Shorts view counting, March 2025: https://www.tubefilter.com/2025/03/26/youtube-shorts-views-counting-stats/
