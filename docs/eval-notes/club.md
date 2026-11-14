Supersession of `title-sponsor / contact` (Meera Shah -> Rahul Desai) is expected to stay missing:
`contact` is multi-valued in the contract, so both values stay active and the newest is current.

Dates: the verifier drops a model deadline that is only the day its cited text was written while the
text states no such date (docs/ARCHITECTURE.md section 4). It removes `competition / deadline =
2026-11-08`, which the model took from the commit "website: competition date on the homepage" (8 Nov);
that claim made two false conflicts and left both 2026-12-19 claims conflicting. `2026-12-05` still
repeats the deadline example in the extraction prompt; it is superseded, so it adds no conflict.

A prompt rewrite (header times labelled "written", examples from a made-up garden with no dates, explicit
procedure / owner / cadence / access guidance) was measured with two cold runs (27 batches each, none
failed) and reverted: recall rose to 73.1% and 67.9%, but false conflicts rose to 11 and 12 (separate
"X rejected" decision claims, venue options extracted as locations). It stays in the git history.
