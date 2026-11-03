# Style interview and automation list

Source: the WeAreNoCode "YouTube Editor" kit (its `SKILL.md`, 1,093 lines; `STYLE-GUIDE.md`; `SETUP.md`; `PROMPTS.md`). Read on 2026-11-02.

## 1. What the 1,093 lines are actually made of

| Part of the file | Rough share | Whose is it | Where it belongs in Mirage |
|---|---|---|---|
| **Craft:** cut checks, dead air, clipped words, colour tags, black-frame checks, render traps, loudness, sync | about half | everyone's | Built into Mirage's engine as code. The user never sees or answers it. |
| **Animation library:** 40+ formats such as lower line, logo card, flow diagram, stat tiles, 3D browser, chat window | about a third | everyone's, but drawn in his look | Mirage's own library, coloured and sized from the user's style file |
| **Taste:** colours, font, energy, how many sounds, how much face, zoom size, pauses | one page (his `STYLE-GUIDE.md` is 74 lines) | **personal** | The interview below fills it in. Notes on each video then grow it. |

So the "custom YouTube md for each user" isn't 1,400 lines per person. It's a one-page style file plus the rules learned from that person's notes. Mirage carries everything else for everybody.

His kit sets no licence for its own text or scripts. The MIT licence only covers parts adapted from another person's starter kit. So Mirage takes ideas from it but doesn't ship its wording or code.

## 2. The style interview

### How to ask

- Most answers come from **watching**, not asking. The user pastes their channel and 1 to 3 videos they love. Mirage measures them: cuts per minute, how often text appears, face time, captions, music, words per minute. It then proposes the answers, and the user only corrects them.
- Ask by **showing**: two or three short previews per question ("this zoom or this zoom?"), never jargon like "punch-in 118%".
- Ask in **three layers**. Layer 1 is first launch, about 5 minutes. Layer 2 is each video, 3 to 4 questions. Layer 3 is learned from notes, and is never asked up front.
- Every question has a sensible default, so "skip" always works.

### Layer 1: first launch (about 5 minutes)

Channel and audience
1. **What's your channel?** Paste the link, or "I'm new".
   - Sets: Mirage measures your last videos and pre-fills everything below.
2. **Which 1 to 3 videos do you wish yours looked like?**
   - Sets: the reference pacing, density and look.
3. **Where do your viewers watch?** Phone, desktop, or playing in the background while they work.
   - Sets: text size, caption style, and how much has to work without watching.
4. **What kinds of videos do you make?** Talking head, screen tutorial, build story, news or reaction, vlog.
   - Sets: which editing route each video takes.
5. **How long are they usually, and do you want Shorts from each one?**
   - Sets: pacing rules and the Shorts cut-downs.

The look
6. **Brand colours and logo:** upload them, or pick a palette from previews.
   - Sets: the highlight colour, the money/warning colour, the punchline colour, and the text colour.
7. **Font:** pick from 4 previews, or upload your own.
   - Sets: the font family and weights.
8. **On-screen cards:** frosted glass, solid, or no cards (text only). Shown as previews.
   - Sets: the card style.
9. **Captions:** none, key words only, or every word.
   - Sets: caption mode. In his kit, every word is for Shorts only.

Energy
10. **Energy:** a slider from "calm, documentary" to "fast, something every 2 seconds", with a preview clip at each end.
    - Sets: animations and camera moves per 90 s, and how long cards hold.
11. **Zooms:** none, slow and subtle, or punchy. Previews.
    - Sets: the camera rules.
12. **How much of the video should be graphics instead of your face?**
    - Sets: the face-time target (his is 40% or more full-frame graphics).
13. **Playful (bounces, pops) or clean and smooth?**
    - Sets: the easing and the motion rules.

Sound
14. **Sound effects:** silence unless something on screen makes a noise, a few, or lots. Previews.
    - Sets: the sound rules and volume levels.
15. **Music:** none, under the opening only, or all the way through. Then pick a mood. Do you have Epidemic Sound?
    - Sets: the music rules and where the music comes from.

Cuts
16. **Pauses:** tight, natural, or breathing room.
    - Sets: the dead-air limit (his is 0.4 s).
17. **Keep the ums, laughs and stumbles that show personality, or clean everything?**
    - Sets: the filler rules.
18. **In a live demo, show the waiting or skip to the result?**
    - Sets: the demo rule.

Proof and B-roll
19. **When you name a website, tool or person, what should appear?** The real page, the logo, stock footage, or nothing.
    - Sets: the B-roll rules.
20. **Is stock footage OK? AI shots of you?** AI shots need a face-photo pack and consent, and get labelled on upload.
    - Sets: the B-roll and AI routes.
21. **What must never be shown?** Client names, revenue dashboards, family, personal data.
    - Sets: the privacy rules: auto-blur and cut.

Trust and delivery
22. **How much do you want to check?**
    - "Just give me the video."
    - "Show me the cut first."
    - "Show me the cut and the plan."
    - Sets: which checkpoints run.
23. **When it's done:** save to a folder, or upload to YouTube as a private draft.
    - Sets: delivery.
24. **Packaging:** title style, thumbnail style, description template, the links you always include, and how you ask viewers to subscribe.
    - Sets: the packaging rules.

### Layer 2: each video (3 to 4 questions)

- What's this video about, and what will the viewer have at the end? This sets the hook's promise and its payoff.
- Which file is which (camera, screen, extra angles), and in what order?
- Anything to mention: a sponsor, links, a product?
- Anything to hide in this one?

### Layer 3: learned, never asked

- **Measured from the footage:**
  - where your face sits, and the safe zones for cards
  - mic position
  - the lip-sync offset of your setup
  - your room tone
  - your speaking pace
  - how you signal a retake
- **Learned from your notes.** After each round of notes, Mirage proposes the rules it noticed, for example "You removed 3 whooshes. Make 'no whoosh under text' a rule?" You tap yes. This replaces typing "save this to the skill".
- **From the teardown.** Every few videos, it compares your last edits against the channels you admire, then proposes changes.

## 3. What else Mirage can automate (what people are too lazy to do)

### In his kit, but done by hand or with typed commands

1. **Setup:** Node, ffmpeg, HyperFrames, Parakeet, Python, Chrome, connectors, settings. That's 30 minutes plus a $20 to $200 plan.
2. **Bringing footage in:**
   - copy from the SD card, and confirm the copy before ejecting
   - order and join the clips
   - sync camera, screen and mic by the clap or the audio
   - measure lip-sync drift per setup
3. **Recording coach:**
   - tips before recording: shoot 4K, pause and restart a fluffed line, say money in full, name tools out loud
   - on import, flag a 1080p file, baked-in zooms, or a missing mic track
4. **The cut:**
   - keep the last take, and obey "cut that" said out loud
   - trim dead air
   - catch slivers of dropped takes and clipped last words
   - cut forms showing personal data
   - skip the waiting in demos
5. **Finding graphics in what you said:** lists become diagrams, money becomes a counter, a named tool becomes its logo, a named site becomes the real page.
6. **Never covering your face:** measured per shot.
7. **Fetching assets:**
   - logos from press kits
   - website captures
   - X posts through the official embed
   - product photos
   - stock B-roll, with its licence checked and readable logos blurred
8. **Licence bookkeeping:**
   - every stock clip listed with its page and licence
   - credits added to the description
   - "AI content" ticked on upload
9. **Sound housekeeping:** level every effect, line its peak up with its cause, and prove each sound is in the render.
10. **Quality gates:**
    - **hook gate:** the first 3 seconds, works muted, the promise gets paid off
    - **pacing gate:** no dead stretch longer than 15, 20 or 30 s
11. **Render chores:**
    - colour tags
    - black-frame scan
    - free disk space and temp-cache cleanup
    - resume a long render that hung
    - re-render only the part a note touched
12. **Finishing:**
    - join the sections level-matched to −14 LUFS
    - `chapters.txt`
    - a delivery folder
    - a storyboard report
    - version numbers v2, v3…
13. **Teardown:** measure the channels you admire every two videos and turn the gaps into rules.

### Not in his kit at all (his workflow still does these by hand)

14. **Notes on the video itself:** click a moment in the player and type or say the note. The timestamp is filled in for you, instead of typing "at second 22…".
15. **Rules proposed automatically** after each round of notes, instead of remembering to say "save this to the skill".
16. **Packaging:**
    - title options
    - 3 thumbnails, made from your own frames and face
    - description with chapters and links
    - tags
    - pinned comment
17. **Upload:**
    - private draft, scheduled publish
    - captions file
    - end screen and cards
    - the AI-content label
    - YouTube's thumbnail A/B test
18. **Shorts:** 3 to 5 vertical cut-downs from every video. His kit says they aren't part of the routine.
19. **Retention loop:** after publishing, read YouTube Analytics. Where did viewers leave? Turn that into proposed rules. Learning from the audience, not just from you.
20. **Repurposing:** clips for X, LinkedIn and Instagram, and a newsletter or blog post from the transcript.
21. **Copyright check before upload:** music and footage that could trigger Content ID.
22. **Housekeeping:** archive raw footage after publishing, free disk space, keep projects tidy.
23. **Cost meter:** what each video cost in Claude usage, with a cheaper model used for routine passes.

## 4. Show the editing live?

It can be done without faking anything. Claude edits a file (the cut list and storyboard; in Mirage, `episode.json`), so a timeline that redraws itself whenever that file changes shows the real work as it happens.

- Clips drop out as retakes are cut.
- Cards appear on their words.
- Snapshots fill in, and a step list ticks along.

Three reasons it's worth building:

- **Trust:** you can see what it's doing and stop it.
- **Interruption:** "no, keep that" while it works. This was an original requirement.
- **Marketing:** screen recordings of Mirage working are the best demo.

It's a view only. The user never has to touch it.
