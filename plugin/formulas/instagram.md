---
{"id":"instagram","name":"How Instagram ranks Reels","describe":"How Instagram says it ranks Reels: will they share it, watch it through, like it; plus the rules that keep a reel out of recommendations.","formats":["short"],"source":"Instagram's blog, Creators pages and Meta's Transparency Center and Ads Guide, with Adam Mosseri's 2025 statements as reported by the press, read 2026-11-09"}
---
# How Instagram ranks Reels, in Instagram's words

Researched online on 2026-11-09. Most of this is what Instagram itself says: its blog, its Creators pages, Meta's Transparency Center and Ads Guide (the links are at the end). Instagram's Help Center pages could not be opened, so where they are used it says so.

**How far to trust this.** A line marked *(Instagram)* or *(Meta)* was read on the company's own page. *(Instagram, as reported)* is a statement by Instagram or its head, Adam Mosseri, read in a press report and not at the original. *(rule of thumb)* comes from a vendor blog with no measured source. Instagram publishes no thresholds for watch time, likes or sends, so your own Insights beat every number anyone else gives you. The pages were read through a tool that summarises them, so wording in quotation marks is as that tool gave it and may differ slightly from the page: follow the link before quoting it anywhere.

## In Instagram's own words
**What it predicts for a reel, most important first** *(Instagram, 2023)*:
1. Will you reshare it?
2. Will you watch it all the way through?
3. Will you like it?
4. Will you go to its audio page? (A sign you may make your own reel.)

**The signals it uses, roughly in order of importance** *(Instagram, 2023)*: your activity (reels you liked, saved, reshared, commented on); your history with the creator; information about the reel (audio, visuals, popularity); information about the creator (followers, engagement). It also surveys people on whether a reel was worth their time.

**Later statements:**
- "The top three signals that matter most for ranking are watch time, likes and sends." Watch average watch time, likes per reach and sends per reach. Likes count slightly more with followers, sends slightly more with non-followers. *(Mosseri, January 2025, as reported by Social Media Today)*
- Each eligible reel is first shown to a small audience, followers or not. The best performing go to a slightly wider audience, and so on. *(Instagram, April 2024)*
- Copies are replaced by the original in recommendations, and accounts that repeatedly repost others' content are taken out of recommendations. A new voiceover, a meme edit or a reaction remix counts as changed. *(Instagram, April 2024)*
- Meta's Transparency Center lists predictions for the Reels feed that include watching less than three seconds, watching more of a reel than 95% of people watching reels of that length, resharing, commenting and following. How often a reel was viewed with sound on is one input. Meta says these change often. *(Meta, updated November 2025)*
- It is not true that reactions in the first 30 minutes rank a post higher. *(Instagram, Creators FAQ)*

**What it says it does not recommend:**
- Reels over 3 minutes. "We recommend videos to unconnected audiences that are 3 minutes or less." You can record and edit up to 20 minutes, but "reels over 3 minutes won't be recommended to new audiences". Before January 2025 the line was 90 seconds. *(Instagram)*
- Low-resolution or watermarked reels, muted reels, reels with borders, reels that are mostly text, and reels already posted on Instagram. These are made "less visible". *(Instagram, 2023)*
- Anything that breaks the Recommendation Guidelines. It stays up for followers but is kept out of Reels, Explore and Search. Account Status in the app shows whether an account can be recommended. *(Instagram)*

## What differs from YouTube Shorts
- **Shares come first.** Instagram puts "reshare" at the top of its list and Mosseri names sends in his top three. YouTube's three steps (chose, stuck around, enjoyed) do not name shares.
- **There is a length line.** YouTube says no length is favoured. Instagram does not recommend a reel over 3 minutes to people who don't follow the account.
- **Watermarks are named.** Instagram says watermarked reels are less visible. "Ditch the watermark!"
- **Reposts are handled by rule.** YouTube says deleting and reposting can look like spam. Instagram swaps a copy for the original and removes repeat reposters from recommendations.
- **The cover matters on the profile.** A reel shared to the grid shows its cover there, and the grid has been tall rectangles, not squares, since January 2025 *(as reported by Engadget)*. On Shorts, YouTube says custom thumbnails don't help.
- **Search reads the caption.** Instagram says to use relevant keywords in content, captions, bio and hashtags. YouTube search matches title, description and content.
- **Audio.** Both use it. Instagram predicts whether a viewer will visit the audio page, and says trending audio "can also impact distribution".
- **Testing.** Instagram has "trial reels": shown to non-followers first, with views, likes, comments and shares after about 24 hours. For Shorts, YouTube's advice is two versions that differ in the first 2–3 seconds.
- **The same:** a small first audience whose response decides whether it spreads.

## What it means for a cut
- **Make the first 3 seconds count.** "Make sure the first 3 seconds of your reel are engaging, so that people don't move on." *(Instagram)*
- **Keep it at 3 minutes or less** if it should reach new people. *(Instagram)* Under 90 seconds is said to do best with new audiences. *(rule of thumb, Buffer; no data shown)*
- **No watermark or logo of another app.** Export clean. *(Instagram)*
- **Use footage that is yours, or change it materially.** A straight repost can be replaced by the original. *(Instagram)*
- **Fill the vertical 9:16 frame.** No borders or letterbox bars, and the highest resolution you can upload. *(Instagram)*
- **Picture first, text second.** A reel that is mostly text is made less visible. *(Instagram)*
- **Audio on.** Muted reels are made less visible, and sound-on viewing is a signal. *(Instagram, Meta)*
- **Captions on, inside the safe area.** Meta's guide for Reels ads calls captions "recommended" and says to keep the top 14%, the bottom 35% and 6% on each side free of text and logos. *(Meta, written for ads; no figure is published for ordinary reels)*
- **End on the payoff, with no outro.** "Watch it all the way through" is the second prediction, and an outro is where people leave. *(the signal is Instagram's; the advice is a rule of thumb)*
- **Give them something worth sending to a friend.** Sends are a top signal. *(Mosseri, as reported)* What makes people send is not published.
- **Say the subject in words** in the caption and on screen, so search can find it. *(Instagram)*

## What a cut can be checked for
Can be measured from the cut:
- Length: 180 seconds or less to be recommended; 20 minutes is the most Instagram lets you record and edit.
- A vertical 9:16 frame, filled, with no borders.
- The picture or the first word arrives inside the first 3 seconds.
- Text and captions sit clear of where the app's buttons and caption cover the picture.
- It ends without an outro card.

Mirage's `predict` holds a short to these in its `Instagram Reels:` lines: the length against 3:00, the first word against 3 seconds, the ending, and the captions and overlays against the areas `check` uses for Shorts and Reels (the bottom 20%, top 10% and right 15% of the frame; Meta's ads guide asks for more: the top 14%, bottom 35% and 6% at each side). It gives no score for Instagram: Instagram publishes no weights.

Cannot be measured from the cut:
- Sends, likes and watch time, and whether the audio is trending.
- Whether the footage carries another app's watermark, and whether its sound is on: Mirage does not look for either.
- Whether the account is eligible for recommendations (Account Status).
- Originality as Instagram judges it, by matching audio and picture against other posts.

## Not measured / not published
Instagram gives no thresholds and no weights: no "good" watch time, skip rate, likes per reach or sends per reach. Mosseri said sends matter "slightly more" than likes for non-followers; the claim that a send is worth three to five likes has no Instagram source. Instagram publishes no safe area for ordinary reels; the percentages above are from Meta's ads guide. Nothing here was measured by Mirage: it is what Instagram has said, as of the date above, and Instagram changes it.

Only the account's owner sees the numbers, in Insights: views, accounts reached, average watch time, likes, sends (shares), and since August 2025 the retention chart and skip rate, the share who left before 3 seconds *(as reported by Social Samosa)*.

## Sources
All read 2026-11-09. Instagram and Meta themselves:
- Instagram Ranking Explained (Adam Mosseri, May 2023): https://about.instagram.com/blog/announcements/instagram-ranking-explained
- Helping Creators Find New Audiences (April 2024): https://creators.instagram.com/recommendations-and-originality
- Creators FAQ: https://creators.instagram.com/faq?locale=en_US
- Tips for Improving Your Reach: https://creators.instagram.com/blog/tips-for-improving-your-reach
- Finding success on reels in 2025 (January 2025): https://creators.instagram.com/blog/the-latest-with-instagram
- Trial reels (December 2024): https://creators.instagram.com/blog/instagram-trial-reels
- Reels feature page, which quotes the Help Center on 20 minutes and 3 minutes: https://about.instagram.com/features/reels
- Meta Transparency Center, Instagram Reels Chaining: https://transparency.meta.com/features/explaining-ranking/ig-reels-chaining/
- Meta Ads Guide, Instagram Reels (safe zones): https://www.facebook.com/business/ads-guide/update/video/instagram-reels
- Could not be opened, so not used directly: Help Center pages https://help.instagram.com/313829416281232 (Recommendation Guidelines), https://help.instagram.com/225190788256708 (record a reel), https://help.instagram.com/1038071743007909 (reel sizes).

Others:
- Mosseri's top three signals, as reported by Social Media Today, January 2025: https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/
- 3-minute reels and the taller grid, as reported by Engadget, January 2025: https://www.engadget.com/social-media/instagram-swoops-in-with-3-minute-reels-and-rectangular-profile-grids-as-the-tiktok-ban-gets-real-201316339.html
- Retention chart and skip rate, as reported by Social Samosa, August 2025: https://www.socialsamosa.com/news-2/instagram-retention-chart-skip-rate-new-performance-metrics-reels-9730992
- Reels length (vendor blog): https://buffer.com/resources/instagram-reels-length
