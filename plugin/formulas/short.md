---
{"id":"short","name":"Shorts rules","describe":"What makes a short vertical video stay on screen and spread, each rule marked with how far to trust it.","formats":["short"],"source":"YouTube's own statements, Paddy Galloway's study of about 5,400 Shorts, and vendor rules of thumb, read 2026-11-09"}
---
# Shorts rules (short vertical videos)

Researched online on 2026-11-09. These turn what YouTube says about its recommendation system (`formulas { id: "youtube" }`, its "YouTube Shorts" part: a video is judged on whether people chose to watch, stuck around, and enjoyed it) into rules for a short.

**One file per platform.** The same short goes to three places, and each has its own algorithm file, researched the same way: YouTube Shorts in `formulas { id: "youtube" }`, Instagram Reels in `formulas { id: "instagram" }`, TikTok in `formulas { id: "tiktok" }`. The rules below are the ones all three share; where a platform differs (Instagram's 3-minute line for recommendations and its weight on sends, TikTok's weight on finishing a video), its own file says so, and `predict` holds a short to each platform's rules in its per-platform lines.

**How far to trust this.** A rule marked *(YouTube)* follows directly from what YouTube itself says; *(study)* is Paddy Galloway's analysis of about 5,400 Shorts; *(rule of thumb)* comes from vendor blogs with no measured source. YouTube publishes no thresholds, so your own retention graph in YouTube Studio beats every number here.

## The rules
1. **Open on the hook in the first 1–2 seconds.** No intro card, logo, "hey guys" or wide establishing shot. This is step 1: stayed vs swiped. *(YouTube)*
2. **Aim for 70%+ viewed vs swiped.** Under 60% rarely did well. *(study)*
3. **Make it clear at once what this is**, in picture and caption, for someone who has never seen the channel. The seed audience is mostly strangers. *(YouTube)*
4. **Cut to the story, not to a length.** Every second that isn't earning its place lowers percentage viewed. *(YouTube)*
5. **End on the payoff with no outro, ideally looping into the first frame.** Replays raise watch time and count as views. *(YouTube, rule of thumb)*
6. **Leave them satisfied, not tricked.** A hook the Short doesn't pay off wins step 1 and loses step 3. *(YouTube)*
7. **Captions on.** Much viewing is muted. *(rule of thumb)*
8. **A teaser is a trailer, not a summary, and it still pays something off.** It answers one small question of its own and leaves open the big one, which the long video answers. Don't end on a "full video on my channel" card: attach the long video as the Short's related video, and let that link do the pointing. Few viewers click (as low as 0.05%), so it works through volume. *(rule of thumb; the small payoff follows from rule 6)*
9. **To test, change only the first 2–3 seconds** between two versions. Don't delete and repost. *(YouTube)*

## Why: how Shorts differ from long-form (YouTube)
- There is no click. Viewers swipe without knowing what's next, so the opening is the whole pitch.
- A Short goes to a small "seed audience" first. How they respond decides whether it spreads or tapers off.
- No length is favoured: "as long as the story needs".
- Posting more, posting at a certain time, and custom thumbnails don't help. Deleting and reposting can look like spam.
- Trending audio from YouTube's library can put a Short on that sound's page.
- Since March 2025 the public view count includes every start and replay; "engaged views" is the stricter number, and the one that pays.

## Checklist before publishing
- [ ] The hook is in the first 1–2 seconds, said or shown.
- [ ] A stranger knows at once what this is.
- [ ] No second that isn't earning its place.
- [ ] It ends on the payoff (for a teaser, a small one, with the big question still open), with no outro and no end card.
- [ ] The hook's promise is paid off in the short; a teaser pays off its own small question and leaves the big one to the long video.
- [ ] Captions are on.
- [ ] A teaser has the long video set as its related video.

## Not measured
Nothing here was measured by Mirage on any channel: the rules come from YouTube's statements, one outside study and rules of thumb. The 70% and 60% marks are that study's, the 0.05% click figure is a vendor's; neither is YouTube's. No cut rate, hook wording, caption style or sound choice was measured. Only the owner of a channel sees "viewed vs swiped away" and percentage viewed, in YouTube Studio.

## Sources
- YouTube, Search & discovery tips for Shorts: https://support.google.com/youtube/answer/11914225?hl=en&co=YOUTUBE._YTVideoType%3Dshorts
- Todd Sherman (Shorts lead), 2023: https://techcrunch.com/2023/08/25/youtube-demystifies-the-shorts-algorithm-views-and-answers-other-creator-questions/
- Shorts view counting, March 2025: https://www.tubefilter.com/2025/03/26/youtube-shorts-views-counting-stats/
- Paddy Galloway's Shorts study: https://threadreaderapp.com/thread/1646898356419981315.html
- Linking Shorts to long videos: https://searchengineland.com/?p=430655 , https://spottercommunity.beehiiv.com/p/increase-views-from-related-shorts
- Shorts hooks and length (vendor blogs): https://vidiq.com/blog/post/youtube-shorts-algorithm/ , https://www.bytecap.io/research/youtube-shorts-retention-benchmarks
