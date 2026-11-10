---
{"id":"tiktok","name":"How TikTok recommends","describe":"How TikTok says its For You feed picks videos: what you do with a video counts most, finishing a longer one counts strongly, follower count is not a direct factor.","formats":["short"],"source":"TikTok's Newsroom, Transparency Center, Community Guidelines, developer and ads pages, with its Help Center and Creator Academy only as quoted in search results, read 2026-11-09"}
---
# How TikTok's For You feed works, in TikTok's words

Researched online on 2026-11-09. Most of this is what TikTok itself says: its Newsroom, its Transparency Center, its Community Guidelines and its developer and ads pages (the links are at the end). TikTok's Help Center and Creator Academy pages could not be opened, so where they are used it says so.

**How far to trust this.** A line marked *(TikTok)* was read on TikTok's own page. *(TikTok, for ads)* is TikTok's advice to advertisers, not a statement about the For You feed. *(TikTok, not opened)* is a TikTok page seen only as quoted in search results. *(study)* is Buffer's analysis of 1.1 million TikToks; *(rule of thumb)* comes from vendor blogs with no measured source. TikTok publishes no thresholds, so your own analytics beat every number anyone else gives you. The pages were read through a tool that summarises them, so wording in quotation marks is as that tool gave it and may differ slightly from the page: follow the link before quoting it anywhere.

## In TikTok's own words
**What it looks at, strongest first** *(TikTok, 2020)*:
1. User interactions: the videos you like, share and comment on, the accounts you follow, what you post yourself, and what you mark "not interested".
2. Video information: captions, sounds and hashtags.
3. Device and account settings: language, country, device type. These get lower weight, because people don't actively choose them.

**How they are weighted.** A strong indicator is "whether a user finishes watching a longer video from beginning to end". A weak one is whether viewer and creator are in the same country. *(TikTok, 2020)*

**The system scores each video by predicting what you will do with it** *(TikTok, Transparency Center)*: like, share, comment, follow the author or open their profile, finish or skip, favourite, tap the soundtrack, spend a certain time watching, or mark "not interested". Content information includes when and where it was posted, its sound, its hashtags and its length. No weights are given.

**What it says it does not use.** "Neither follower count nor whether the account has had previous high-performing videos are direct factors." *(TikTok, 2020)*

**What it says it does not recommend:**
- Unoriginal content. A video is ineligible for the For You feed "if it includes unoriginal or reused material without anything new". *(TikTok, Community Guidelines in effect from September 2026)*
- Duplicated content, videos you have already seen, spam, and videos just uploaded or still under review. *(TikTok, 2020)*
- Content not suited to a broad audience, anything posted by an account under 16, and content that tries to trick people into likes, follows or gifts. *(TikTok)*
- Too much of the same: a top-ranked video is swapped out if it is too similar to the ones before it, such as the same sound twice running. *(TikTok, Transparency Center)*

**On length and pay.** The Creator Rewards Program pays for "high-quality, original content that is over a minute long", judged on originality, play duration (watch time and finish rate), search value and audience engagement. TikTok says people spend half their time there on videos longer than a minute. *(TikTok, March 2024)* This is a payment rule, not a ranking rule.

## What differs from YouTube Shorts
- **Finishing is named as strong.** TikTok says finishing a longer video is a strong signal. YouTube uses both view duration and percentage viewed, and says no length is favoured.
- **Shares are named.** Likes, shares, comments and follows are on TikTok's list. YouTube's three steps (chose, stuck around, enjoyed) do not name shares.
- **Length.** Every TikTok account can post 3 minutes; some can post 5 or 10. *(TikTok, developer pages)* Over a minute is needed to be paid. YouTube pays Shorts on engaged views, with no minimum length in what Mirage has read.
- **Watermarks.** TikTok's current guidelines name unoriginal or reused material, not watermarks. Blogs say a video carrying another app's watermark is kept out of the For You feed, and name no TikTok source. *(rule of thumb)*
- **Cover.** As on Shorts, the feed plays the video without showing a cover first. The cover shows on the profile grid; TikTok says nothing about it in ranking.
- **Search.** "Search value" is one of the four things Creator Rewards pays on, and TikTok has a Creator Search Insights tool. Captions and hashtags are ranking inputs. *(TikTok)*
- **Audio.** Both use it. On TikTok the sound is a stated input and tapping the soundtrack is a predicted action, but the same sound twice in a row is filtered out.
- **Followers.** TikTok says follower count is not a direct factor. YouTube says subscribing is a weaker signal than people think.
- **The first audience.** YouTube describes a "seed audience". TikTok's own pages, as read here, do not describe how a new video is first shown.

## What it means for a cut
- **Open on the point.** "Introduce your content proposition in the first 3 seconds" and "prioritize your hook in the first 6 seconds". *(TikTok, for ads; it gives no data for either number)*
- **Cut so it gets finished.** Finishing counts strongly, and skipping is predicted too. Every second that isn't earning its place makes finishing less likely. *(TikTok)*
- **Over a minute only if the story holds.** Videos over 60 seconds had 43.2% more median reach than 30–60 second ones. *(study, Buffer, March 2025; a correlation, and Buffer says length is "unlikely to be a make-or-break factor")* Over a minute is also what Creator Rewards pays for. *(TikTok)*
- **Keep to 3 minutes or less** unless you know the account can post longer. *(TikTok, developer pages)*
- **Use footage that is yours, or add something new to it.** *(TikTok)*
- **No watermark or logo of another app.** *(rule of thumb; not in TikTok's current guidelines)*
- **Vertical 9:16, at least 720p, sound on.** *(TikTok, for ads)*
- **Captions and text inside the safe zone.** Text outside it "might be covered or cropped". TikTok gives no fixed margins: it offers safe zone files to download, and the zone changes with the length of the caption. *(TikTok, for ads)*
- **Say the subject in words** in the caption, so search and the recommender can read it. *(TikTok; that on-screen text helps is a rule of thumb)*
- **End on the payoff, with no outro.** Finish rate is what TikTok names. *(the signal is TikTok's; the advice is a rule of thumb)*

## What a cut can be checked for
Can be measured from the cut:
- Length: 3 minutes or less posts from any account; 10 minutes is the most TikTok's own pages state; over 60 seconds for Creator Rewards.
- A vertical 9:16 frame, 720p or more.
- The subject is on screen or spoken inside the first 3 seconds.
- Text and captions kept away from the right edge and the bottom, where the buttons and the caption sit. TikTok publishes no percentages.
- It ends without an outro card.

Mirage's `predict` holds a short to these in its `TikTok:` lines: the length against 3:00, the first word against 3 seconds (TikTok's advice to advertisers) and the ending. The covered areas are not measured for TikTok, because it publishes no margins. It gives no score for TikTok: TikTok publishes no weights.

Cannot be measured from the cut:
- Likes, shares, comments, follows, watch time and finish rate.
- Whether the sound is trending, or was just shown to the same viewer.
- Whether the video or account is eligible for the For You feed.
- Originality as TikTok judges it.
- Whether the footage carries another app's watermark, and whether its sound is on: Mirage does not look for either.

## Not measured / not published
TikTok gives no thresholds and no weights: no "good" finish rate, watch time or share rate, and no best length. It has not published how a new video gets its first viewers. The 43.2% figure is Buffer's, not TikTok's. The 3-second and 6-second marks are TikTok's advice to advertisers, given without data. Hour-long uploads are reported as a test, not stated on a TikTok page read here. Nothing here was measured by Mirage: it is what TikTok has said, as of the date above, and TikTok changes it.

Only the account's owner sees the numbers, in TikTok's analytics: average watch time, watched full video (the finish rate), retention rate and traffic source, which shows how much came from For You. *(TikTok, Creator Academy, not opened)*

## Sources
All read 2026-11-09. TikTok itself:
- How TikTok recommends videos #ForYou (June 2020): https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you
- Transparency Center, recommendation system: https://www.tiktok.com/transparency/en/recommendation-system/
- Community Guidelines, Integrity and Authenticity (released August 2026): https://www.tiktok.com/community-guidelines/en/integrity-authenticity
- Community Guidelines, For You feed eligibility: https://www.tiktok.com/community-guidelines/en/fyf-standards
- Introducing the New Creator Rewards Program (March 2024): https://newsroom.tiktok.com/en-us/introducing-the-new-creator-rewards-program/
- Developer guide, video length by account: https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide
- Ads Help, in-feed ad specs and safe zone: https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads
- Ads Help, creative best practices: https://ads.tiktok.com/help/article/creative-best-practices
- Could not be opened, seen only as quoted in search results: Help Center, How TikTok recommends content: https://support.tiktok.com/en/using-tiktok/exploring-videos/how-tiktok-recommends-content ; Creator Academy on analytics: https://www.tiktok.com/creator-academy/en/article/tool-analytics-intro ; and on Creator Rewards: https://www.tiktok.com/creator-academy/article/creator-rewards-program

Others:
- Buffer's study of 1.1 million TikToks (March 2025): https://buffer.com/resources/longer-tiktoks-get-more-views-data/
- Hour-long uploads tested, as reported by Tubefilter citing TechCrunch (May 2024): https://www.tubefilter.com/2024/05/17/tiktok-tests-60-minute-videos/
- Watermarks of other apps (a blog that names no TikTok source): https://mainframee.blogspot.com/2026/02/how-to-fix-not-eligible-for-for-you.html
