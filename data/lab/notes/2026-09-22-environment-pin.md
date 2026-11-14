---
title: "Why the environment is pinned"
date: 2026-09-22
author: Farhan Qureshi
author_email: farhan.qureshi@sils.example
---

# Why the environment is pinned

We pinned the conda environment in env/environment.lock.yml because an unpinned samtools update on 14 September 2026 changed the duplicate counts in the nightly QC.

## What we do from now on

Any tool update goes through a new lock file and a new tag. Nobody runs `conda update` in the soilmeta environment by hand.

## Old object store access (retired)

The lab no longer uses the external object store. The old access key AKIAFAKEMENONLAB0000 was deleted on 22 September 2026.
