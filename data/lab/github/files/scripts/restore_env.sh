#!/usr/bin/env bash
# Restores the soilmeta conda environment from a tagged copy of env/environment.lock.yml.
# Usage: ./scripts/restore_env.sh <tag>
# Which tag is known good, and which node to run this on, is pinned in the pipeline channel.
set -euo pipefail

TAG="${1:?give a tag}"
git show "${TAG}:env/environment.lock.yml" > /tmp/environment.lock.yml
conda env remove -n soilmeta -y
conda env create -n soilmeta -f /tmp/environment.lock.yml
echo "restored soilmeta from ${TAG}"
