# Bahnabfahrten — Rebble App Store listing

Wird bei jeder Veröffentlichung mit aktualisiert. Englisch, weil der Store
international ist. Zum Veröffentlichen aus diesem Verzeichnis heraus:

```bash
pebble publish --release-notes "..."
```

---

## Title

Bahnabfahrten

## Tagline

Your next train to Hamburg, on your wrist.

## Description

A departure board for one commute: the regional line between Elmshorn and
Hamburg in northern Germany.

The app knows where you are. Stand in Elmshorn and it shows the trains that
actually go your way — towards Hamburg-Altona, Hamburg Hbf, or at least as
far as Pinneberg, which is where the line often terminates when something
has gone wrong. Trains carrying the same line number in the other direction,
onwards to Kiel, Flensburg or Westerland, are left out. Stand in Hamburg and
it shows the departures from Hbf and Altona; everything leaving there calls
at Elmshorn, so nothing needs filtering.

Each entry gives you the line and the scheduled departure in large type,
with any delay beside it in red. Underneath, in full, the station the train
started from and the one it is heading for. The origin is there on purpose:
when a train begins somewhere other than usual, that is often the first sign
of disruption, and you see it before the delay catches up.

Watched lines are RE6, RE7, RE70, RB60, RB61 and RB71. The window runs from
half an hour ahead — enough time to actually reach the platform — to two and
a half hours out.

Scroll by dragging, or tap the lower half of the screen for the next page and
the upper half for the previous one. The up and down buttons step one entry at
a time, select refreshes, back leaves.

Departures come from Deutsche Bahn's timetable service, with live delays and
cancellations laid over them. The phone does the fetching and filtering and
pushes a compact list to the watch, so the watch only ever draws.

Built for Pebble Time 2 and Pebble Round 2, each with its own layout — the
round face centres every line and steps the type down near the curved edge so
nothing is clipped, the rectangular one aligns the times in a fixed column.

## Settings

None. The route, the watched lines and the time window are fixed in the code;
this is a single-purpose app rather than a general departure board. Anyone
wanting a different route can change the station numbers and the line list at
the top of `src/pkjs/index.js`.

The app needs the phone connection for location and network access.

## Category

Utilities (Travel)

## Release notes

### 1.0.0

First release.
