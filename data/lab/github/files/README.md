# soil-metagenomics-pipeline

Nightly read QC and long-read assembly for the Menon Lab, written in Snakemake. Maintainer: Farhan Qureshi.

## Run it by hand

To run it by hand: `conda activate soilmeta`, then `snakemake --profile profiles/kaveri --cores 32` from the repository root.

The nightly run does the same thing on a schedule. See docs/RUNBOOK.md for where it runs and how to check it.
