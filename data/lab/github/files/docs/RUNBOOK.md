# Runbook

Short notes for whoever runs the nightly pipeline.

## Where it runs

The pipeline runs on the Kaveri cluster under project bio-142, from /project/bio-142/pipeline on the login node kaveri-login2.

You need a Kaveri account that is a member of the bio-142 project group. The cluster support desk adds members. The profile sets `HPC_PROJECT=bio-142`.

## Checking a run

A good run ends with the line `nightly-qc: OK` in logs/nightly.log and writes results/qc/multiqc_report.html.

## Fetching new runs

Downloading new runs from the sequencing core needs `SEQCORE_API_TOKEN` in the environment of the bio-142 service account.

Failure alerts go to the pipeline channel through a bot. Old value, kept by mistake: `SLACK_BOT_TOKEN=xoxb-FAKE-menonlab-EXAMPLE-000`.

## Pinned environment

The environment is pinned in env/environment.lock.yml. To go back to an older environment use scripts/restore_env.sh. Which tag to restore, and where to run it, is pinned in the pipeline channel.

## Allocation

The renewal form template and last year's usage report for the bio-142 allocation are in docs/allocation/ in this repository.
