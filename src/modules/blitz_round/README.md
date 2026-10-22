# Blitz round

The module owns a channel-scoped D1 question pool and uses the shared points round
core for durable game state. It requires the points module.

## Lifecycle

- Enabling an empty pool seeds 30 starter words in the activation batch, using
  the host authorization predicate. Re-enabling a populated pool leaves it alone.
- Starts select the enabled question with the oldest use time. The DO atomically
  rejects another announcing or open round for this
  module. Stored round data includes the question ID and opening timestamp.
  A durable preparation intent reconciles its use time and idempotent start audit,
  including cancellation before announcement;
  a failed D1 write after opening does not report a failed start.
- The announcement is formatted from the stored round data. Answer time begins
  after its delivery. Preparation completes before any send attempt is claimed.
  Recovery distinguishes an interrupted preparation from a persisted transport claim.
  Chat messages read the active round from the DO and submit
  only normalized correct answers, keyed by the Twitch message ID.
- The first answer shortens the deadline to the earlier of the existing timeout
  and five seconds later. Answers have zero stake. Ordinary `rounds.join` still
  requires a positive stake.
- The deadline alarm commits `round:<id>:resolve` once. Integer prize shares go
  from the house to winners in answer order, through the existing `resolve`
  monthly accounting path. No winners produce an empty settlement.
- A persisted result delivery intent survives retries and restarts. Confirmed
  chat sends are deduplicated. An uncertain result send can retry after the
  existing send uncertainty window; the ledger operation cannot repeat.
- Disabling cancels active rounds without refund operations for zero stakes.
- Optional automatic start uses one channel-scoped Durable Object record and alarm.
  Its baseline combines the Blitz activation and settings revisions. Settings and
  activation changes establish a fresh interval; another module's activation
  leaves the persisted deadline intact. Offline time pauses the remaining live
  interval, unknown stream state has no deadline, and late alarms skip missed
  starts. Opening any Blitz round clears the start deadline until that round is
  resolved. Resolution notifications carry the stored round baseline and are
  replay-safe; a watchdog recovers an interrupted notification without a
  catch-up start. Scheduler callbacks and round lifecycle notifications share
  the ChannelObject module lifecycle mutation queue.

## Pool and panel

Question mutations use the FAQ authorization and audit batch pattern. The pool
cap is enforced in the insert statement. Revision triggers refresh mounted panel
queries. The collection page uses the shared draft guard and SaveStatus header;
search, pagination, and save actions stay above scrollable content. Answer chips
and validation feedback have reserved space.
