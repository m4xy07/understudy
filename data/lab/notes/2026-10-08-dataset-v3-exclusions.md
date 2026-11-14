---
title: "Dataset v3: excluded samples and state"
date: 2026-10-08
author: Farhan Qureshi
author_email: farhan.qureshi@sils.example
---

# Dataset v3: excluded samples

Six samples were excluded from dataset v3 because their read depth was below 2 million reads.

Which sequencing run the six excluded samples came from is not written down anywhere yet.

## Files and state

The file list of dataset v3 is MANIFEST.sha256 in /project/bio-142/raw_v3; it lists 212 files.

Dataset v3 has 206 of 212 samples through QC.

## Next step

Next step for dataset v3: regenerate MANIFEST.sha256 with `scripts/make_manifest.sh raw_v3`, then write the release notes.

## Old transfer key (retired)

Left in my notes by mistake. This key pair was removed from the transfer node.

```
-----BEGIN OPENSSH PRIVATE KEY-----
FAKE-EXAMPLE-NOT-A-REAL-KEY-0000
FAKE-EXAMPLE-NOT-A-REAL-KEY-0001
-----END OPENSSH PRIVATE KEY-----
```
