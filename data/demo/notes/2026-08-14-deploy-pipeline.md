---
title: Deploy pipeline review
date: 2026-08-14
author: Priya Nair
author_email: priya.nair@westbrook.example
---

# Deploy pipeline review

## Decision

Firmware builds run on GitHub Actions (`.github/workflows/deploy.yml`) on every push to `main`.

## Why

- Everyone gets the same binary, so there are no more builds that only work on one laptop.
- Each build is attached to a GitHub release, so an older version can be flashed again if a new one misbehaves.
- GitHub Actions is free for our public repository.

## Options considered

- Keep building on Priya's laptop. Rejected: only one person can build.
- A self-hosted runner on the lab PC. Rejected: the lab PC is switched off at night.
