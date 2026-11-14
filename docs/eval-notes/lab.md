**This is the hold-out setting.** The research-group pack (`packs/lab.json`) and its corpus were
written after the extraction prompts were fixed on the club data. Nothing was tuned to this answer
key: no alias, example, prompt or planted sentence was changed after the first live run. The numbers
below are the first cold run (14 Nov 2026, 21 extraction batches, none failed, 592 s cold, 10 s
replayed), read back from the committed cache.

What the run shows, as measured:

- Recall is 60.5% (46 of 76 planted facts); the club reads 57.7% with the same prompts. This is on a
  different source mix (three Slack channels, a repository, a lab notebook, a task sheet, a calendar;
  no WhatsApp).
- Most misses are facts stated in repository files and notebook entries as part of a longer passage
  (the environment lock, the cron line, checksum manifests, per-figure status) and cadence facts
  ("once a year", "every quarter") that the model files under another attribute or drops.
- Nine false conflicts (the club has five). Six are two true facts about different things filed under one entity and
  attribute (a form on a portal and the protocol document as two "locations"; the pipeline owner
  before and after the handover). The verifier treats single-valued attributes strictly, so these
  surface for review rather than being hidden.
- Supersessions 3 of 4 and planted conflicts 2 of 3: the missed ones depend on a claim the
  extraction did not produce (`hpc-allocation / deadline = 2026-12-08`).
- Safety metrics hold on the new setting with no change: 0 planted secrets in any claim or stored
  segment, 0 restricted-token violations, citations 97.6% exact.
- Downstream, the stand-in successor (incoming postdoc) reads B 7 · C 59% · K 97%. The answer key
  plants exactly 7 blocking gaps for that role.
