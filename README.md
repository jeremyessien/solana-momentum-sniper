# Loom Script — Mood Tracker Walkthrough

**Target runtime:** under 5 minutes
**Live demo:** https://mood-tracker-sigma-pied.vercel.app
**Repo:** the GitHub link you submitted

## How to use this doc

Each section has three parts:

- **SHOW** — what to have on screen
- **SAY** — what to say, in plain language. Talk it, don't read it word-for-word.
- **Heads-up** — a note for me, the speaker — small reminders or terms in case I freeze

Keep it conversational. Move on if you stumble. The reviewer cares about the three checkboxes the brief asks for: **state management**, **CustomPainter**, **one improvement**.

---

## 0:00 – 0:25 · Open with the live app

**SHOW:** the live Vercel URL in the browser, full screen.

**SAY:**
> "Hey, this is a quick walkthrough of the mood tracker I built. Quick recap of the brief: one Flutter web screen, you tap a face to log how you feel, the past seven entries show up on a horizontal scrolling timeline, and you can tap any past entry to see it animate. The faces themselves had to be drawn with `CustomPainter` — no images, no emoji. I deployed it on Vercel; you can play with it at this URL right now."

Tap a face → snackbar appears → new card slides into the timeline.
Tap a past card → it wobbles.

> "That's the whole loop."

**Heads-up:** keep this section short. Move on as soon as you've shown the loop working.

---

## 0:25 – 0:55 · Project structure (30 seconds, don't linger)

**SHOW:** the `lib/` folder expanded in the IDE.

**SAY:**
> "I laid the code out in three layers. `domain/` is just the data types — the `Mood` enum and the `MoodEntry` value type — pure Dart, no Flutter imports. `data/` is the repository that saves and loads entries from `SharedPreferences`. `presentation/` is everything Flutter — the widgets, the controller, and the painter. The rule is dependencies only point inward, which is what lets me test the controller without ever touching storage."

**Heads-up:**
- If asked why this much structure for one screen: "It's overkill on size, but it gives me three things — the painter, the controller, and the storage — that I can test and swap independently. That mattered for the controller test."
- Don't read every filename. Just the three folder names.

---

## 0:55 – 1:50 · State management (this is checkbox 1)

**SHOW:** `lib/presentation/controllers/mood_controller.dart`

**SAY:**
> "For state management I used Riverpod 3. The state is a list of `MoodEntry` objects, and I'm using an `AsyncNotifier` because the very first time the screen loads, we have to read entries from disk. `AsyncNotifier` gives me three states out of the box — loading, data, and error — without any extra boilerplate."

Scroll to `build()`:
> "The `build` method runs once when the provider first wakes up. It reads from the repository and sorts the entries newest-first."

Scroll to `log()`:
> "When the user taps a face, the picker calls this `log` method. I create a new entry, prepend it, update the state, and *then* save to disk. So the UI updates immediately and persistence happens right after — that's an optimistic update. The list is also immutable — I return `List.unmodifiable` — so the only way to change the state is through this controller."

Switch to `lib/presentation/widgets/mood_timeline.dart`, top of `build`:
> "And on the consuming side, the timeline just does `ref.watch` and pattern-matches on the AsyncValue. So loading, empty, loaded, and error are all four arms of one switch statement. No flags, no `isLoading` booleans."

Switch to `test/presentation/mood_controller_test.dart`:
> "Because the repository is injected through a provider, the controller test overrides it with an in-memory fake. Four tests — sorted load, prepend on log, sort stays correct, and clear — without ever hitting actual storage. That's the payoff of the layered structure."

**Heads-up:**
- If asked "why not BLoC or just `setState`?" — "`setState` only reaches inside one widget; the picker and the timeline are siblings, so I needed shared state. BLoC would've been overkill for a single piece of state. Riverpod with `AsyncNotifier` fit the size."
- If asked about codegen — "Riverpod has a codegen package but the docs themselves say it's optional. For one controller, the manual provider line at the bottom is cheaper than adding `build_runner`."

---

## 1:50 – 3:30 · The CustomPainter (this is checkbox 2 — the meatiest part)

**SHOW:** `lib/domain/mood.dart` first

**SAY:**
> "Before we look at the painter, look at the `Mood` enum. Each mood has five numbers attached — `mouthCurvature`, `eyebrowTilt`, `eyeScale`, `eyeOffsetY`, and an accent color. So a 'mood' isn't just a label — it's a bundle of geometry the painter knows how to read. That's the design move that makes the painter clean."

Switch to `lib/presentation/painting/mood_face_painter.dart`

> "Here's the painter. The `paint` method is the entry point — Flutter calls it whenever the canvas needs to redraw. I do four steps: draw the face, the eyes, the eyebrows, the mouth."

Scroll to top of `paint`:
> "Everything's expressed in units of `radius`, where radius is half the smaller side of whatever box I'm drawn in. So the same painter renders cleanly at 60 pixels on the empty state and 200 pixels on the picker. No magic numbers tied to a fixed size."

Scroll to `_paintFace`:
> "The face is two circles — a translucent fill in the mood's accent color, and a solid stroke around it. Both use `canvas.drawCircle`, which the brief specifically mentioned as one of the allowed primitives."

Scroll to `_paintMouth`:
> "The mouth is the interesting one. It's a quadratic Bézier curve — two anchor points at the corners of the mouth, both on the same horizontal line, and one control point in the middle. The position of that control point is what determines the shape. If it's below the line, the curve bows downward and you get a smile. If it's above, you get a frown. And the distance is `0.4 * radius * mouthCurvature` — so a happy face with curvature 0.45 gets a gentle smile, and amazing at 0.85 gets a big one."

Scroll to `_animatedCurvature`:
> "This is where the animation comes in. When a face is animating — either right after you tap a mood, or when you tap a card on the timeline — I add a damped sine wobble to the curvature. The wobble starts strong and fades to zero over the animation. Which is what gives you that little 'boing' effect on the smile when you log a mood."

Scroll back to the constructor:
> "And here's a small but important detail — I pass the animation to `super(repaint: animation)`. That wires the animation directly to the canvas. So when the animation ticks, only the canvas repaints — the widget tree doesn't rebuild. That's the cheap way to do smooth animations in Flutter."

Scroll to `_paintEyebrows`:
> "One more thing — eyebrows. The method early-returns when `eyebrowTilt` is zero, so the happy, amazing, and neutral faces don't have eyebrows at all. The angry ones do. That difference is data, not an `if mood == sad` branch. Adding a sixth mood is one enum entry; the painter doesn't change."

**Heads-up:**
- If you want a backup line: "The whole painter is a pure function of the mood and the animation — no branching per mood."
- If asked "why no eyebrows on happy?" — "Visual choice — wide open face reads as more positive. The eyebrows show up only when the geometry actually says something."

---

## 3:30 – 4:10 · The rest of the app (quick tour, don't dwell)

**SHOW:** `lib/presentation/widgets/mood_picker.dart`

**SAY:**
> "The picker is a row of five tiles. Each tile has its own animation controller for the tap wobble, and it shows hover and press states for the web — slight scale up on hover, slight scale down on press. When you tap, it fires the wobble animation and calls the controller's `log` method."

Switch to `lib/presentation/widgets/mood_timeline.dart`, `_TimelineCard`:
> "The timeline cards each carry the date, the drawn face, and an accent color that matches the mood — that's the brief's exact requirement. If the entry is from today, the border and shadow are stronger so today's mood pops. Tap any card and it replays the wobble animation."

Switch to `lib/presentation/widgets/ambient_background.dart` briefly:
> "And the background is just a warm gradient with three blurred color blobs behind everything, to give the screen some atmosphere without distracting from the face."

**Heads-up:** if you're tight on time, skip the ambient background and go straight to commit history.

---

## 4:10 – 4:30 · Commit history (small flex, big signal)

**SHOW:** GitHub → Commits tab, or `git log` in terminal.

**SAY:**
> "The brief asked for a natural commit history. I built this in layers — scaffold, then models, then the repository, then the state controller, then the painter, then the UI, then polish, then tests, then docs. Twenty-one commits, conventional commit prefixes, including one refactor commit where I cleaned up some `AsyncValue` handling. Reads like a real engineering process because that's how I built it."

---

## 4:30 – 5:00 · One thing I'd improve (this is checkbox 3 — don't skip)

**SHOW:** back to the live app, ideally with a few entries logged.

**SAY:**
> "If I had more time, the main thing I'd change is how the timeline handles multiple entries on the same day. Right now every tap creates a new entry, so you can fill the timeline with five entries from this morning. For a real mood tracker, you'd want each card on the timeline to represent one day — show the day's most recent mood, and let you expand the card to see every log from that day. The data model already supports it; the change is purely in the timeline widget. That'd turn this from a logging demo into something you'd actually use day to day."

> "That's it — thanks for watching."

**Heads-up:** This is the part reviewers use to judge taste. Don't say "more tests" or "more features." Pick one real product improvement and explain it crisply.

---

## Pre-record checklist

- [ ] Live app is open and warmed up in a tab
- [ ] IDE is open with `lib/` expanded
- [ ] DEBUG banner is off (it is — `debugShowCheckedModeBanner: false` in `app.dart`)
- [ ] Browser zoom set so code is readable on Loom playback (cmd-+ a couple of times)
- [ ] Notifications silenced
- [ ] One or two test entries already logged so the timeline isn't empty when you start
- [ ] Mic test — one quick "hello, test" recording

## If you go over 5 minutes

Cut in this order:
1. Skip the ambient background section
2. Trim the project structure section to one sentence
3. Trim the picker/timeline tour
4. Never cut: state management, CustomPainter, one improvement

## One-liner backups for if your brain blanks

- **What's Riverpod?** "It's a state management library for Flutter — like Provider's successor."
- **What's an `AsyncNotifier`?** "A state holder that natively models loading, data, and error states."
- **What's a Bézier curve?** "A curve defined by anchor points and a control point that pulls the curve toward it."
- **What's `repaint:` on `CustomPainter`?** "It wires an animation directly to the canvas so it repaints without rebuilding the widget."
- **Why JSON in SharedPreferences and not a real database?** "Tiny dataset, no native dependency, fast on web. Right tool for the size."
