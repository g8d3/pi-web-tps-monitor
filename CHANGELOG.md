# Changelog

All notable changes to TPS Monitor. Versions follow the tags on `main`.

Measured numbers below come from our own runs and are cited with their source;
where a number is an assumption rather than a measurement, it says so.

## v0.10.2 — 2026-10-17

**The provider roundtrip is now a column, not a mystery.** Adds `preResponseMs`
to each turn row: the window from turn start to the provider's first token.
Shown as a `Pre` column in the Turns view and a `pre` segment in `/tps turns`;
older rows and turns with no assistant message read as `–`.

This is the number the monitor could not previously see. `llmDurationMs` times
only the stream, so a network call looked like milliseconds — measured
externally (5 reps, one-word reply), the pre-response window is **1451 ms
median (1193–1605)** while the stream itself is 2 ms. Pi emits `message_start`
after the provider responds, so the roundtrip lands before the clock the
companion reads. No new hooks were needed: the companion already receives both
events.

Also fixes the Turns expander's `colspan`, left at 10 when a column was added
in v14 (the table is 13 columns wide).

## v0.10.1 — 2026-10-17

**A partial spend no longer poses as a session total.** A session mixing priced
and unpriced models used to show its priced subtotal as if it were the whole
spend. Every cost surface now treats a spend with unpriced messages in it as a
floor and says so: a trailing `+` in the Fleet cost cell (hover for the unpriced
share), a `NN% unpriced` note in `/tps cost` and `/tps fleet`, and the same
qualifier on `/tps budget` and the spend guardrail. A fully unpriced session
reads as `–`, never `$0.00`, because that would read as "free".

## v0.10.0 — 2026-10-17

**Two rates instead of one.** `tps` stays the blended rate over the whole
window — what a caller actually waits for — and a new `decodeTps` measures
generation speed after the first token landed (`output / (duration − ttft)`),
shown as a `Dec` column. A provider that is slow to respond is no longer scored
as a slow decoder. Rows without a TTFT fall back to the full window; a
zero-length decode window is unknown, never a fabricated rate.

## v0.9.0 — 2026-10-17

**Wasted spend is now visible.** Turns that failed, were aborted, or produced
no output still bill for their tokens. `turnWaste()` prices those turns from
their own rows and reports them as a Waste cell in the Fleet view, `waste` in
`/tps fleet`, and `N wasted ≈ $X (Y% of turn spend)` in `/tps cost`. Turns on
models with no list price are counted as turns, never as invented dollars.
`/tps cost` also reports turns when the message history is empty.

## v0.8.7 — 2026-10-17

**Cheaper appends, bounded files.** Every append used to re-read the whole
`.jsonl` just to count rows — measured at **762 µs of synchronous work per
assistant message and per turn**, versus **7.9 µs** for an append that keeps an
in-memory counter (≈100×). Appends now rotate only when a row or byte ceiling
(default 2 MiB) is crossed, so one turn with a large tool list can no longer
grow the file without bound. Also fixes a fabricated rate: a window under
`tuning.minStreamMs` is recorded unrated instead of reporting e.g. "1000 t/s"
for a three-token reply.

## Earlier

Versions through v0.8.6 added TTFT, stall and cache marking, per-turn step
rows, the Tools and Fleet views, per-model averages, session budgets, and the
context-pressure gauge. See `git log` for the full history.
