#!/usr/bin/env bash
# Pull-if-possible: fetch the digest-keyed toolchain test images from GHCR and
# retag them to the local names Compose expects (#657 phase 2).
#
# The runner (#356) keys its images on the toolchain digest
# (automation/scripts/lib/stack.sh stack_deps_digest) and never pulls
# (pull_policy: never). This script borrows the registry's copy of that exact
# digest when one exists: the PR smoke (and the nightly) skip the ~2-3 min
# toolchain build and start from the same bytes main published.
#
# STRICTLY fail-open: every failure (no GHCR image for this digest yet, a
# private package, no network, docker hiccup) leaves the local Compose cold
# build in place as today and the caller keeps working. This script never
# exits nonzero — a cache miss must look like 2026-11-14, not like a red job.
#
# Compose and the Dockerfiles are NOT touched: the images land under their
# exact local names via `docker tag`, so `pull_policy: never` still sees
# "local images exist" and no runner/Dockerfile line changes.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR" || exit 0

REGISTRY=ghcr.io
OWNER=${GITHUB_REPOSITORY_OWNER:-ahaqqu}
# service:local-image pairs — the local names are Compose's `image:` names
# (automation/docker-compose.yml). The test-runner service's local image is
# `rumaq-test-runner`, NOT `rumaq-test-<service>`; the GHCR name follows the
# plan's rumaq-test-{api,web,test-runner} shape, the retag bridges them.
ENTRIES="api:rumaq-test-api web:rumaq-test-web test-runner:rumaq-test-runner"

# The digest math is the runner's, never a fork: one source of truth for image
# identity, or CI and local runs could disagree about what "same toolchain"
# means.
# shellcheck source=automation/scripts/lib/stack.sh
source "$ROOT_DIR/automation/scripts/lib/stack.sh"

if ! digest="$(stack_deps_digest "$ROOT_DIR")"; then
  echo "pull-test-images: could not compute the toolchain digest — Compose will cold-build"
  exit 0
fi

for entry in $ENTRIES; do
  svc=${entry%%:*}
  local_image="${entry#*:}:$digest"
  remote_image="$REGISTRY/$OWNER/rumaq-test-$svc:$digest"
  if docker image inspect "$local_image" > /dev/null 2>&1; then
    echo "pull-test-images: $local_image already exists locally — skipping"
    continue
  fi
  # Unknown tags answer non-zero; a private package answers 403. Both are the
  # same "miss" here.
  if docker buildx imagetools inspect "$remote_image" > /dev/null 2>&1 &&
    docker pull "$remote_image" &&
    docker tag "$remote_image" "$local_image"; then
    echo "pull-test-images: pulled $remote_image → $local_image"
  else
    echo "pull-test-images: no usable GHCR image for $remote_image — Compose will cold-build $local_image"
  fi
done

exit 0
