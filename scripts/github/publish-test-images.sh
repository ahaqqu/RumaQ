#!/usr/bin/env bash
# Publish-if-missing: build the three toolchain test images for the current
# digest exactly as the runner does and push them to GHCR (#657 phase 2).
#
# The runner (#356) keys its images on the toolchain digest
# (automation/scripts/lib/stack.sh stack_deps_digest) and builds them with
# Compose. This script publishes that exact build as
#   ghcr.io/<owner>/rumaq-test-{api,web,test-runner}:<digest>
# so PR smoke jobs and the nightly can pull instead of rebuilding (see
# pull-test-images.sh). Digest-keyed tags are content-addressed and immutable
# in practice: concurrent publishers of the same digest push identical layers.
#
# Skip-if-exists: `docker buildx imagetools inspect` answers per image, so a
# re-run (or a second push racing the first) is a cheap metadata check and a
# no-op. Tags that already exist are NOT re-pushed — a digest change is the
# only thing that can mint a new tag.
#
# Requires a GHCR login with packages:write (the workflow's GITHUB_TOKEN via
# docker/login-action). Toolchain-input changes (lockfile, Dockerfiles) mint
# new digests automatically; the accepted apt-drift caveat of Dockerfile.web
# is unchanged from the local-build world.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

REGISTRY=ghcr.io
OWNER=${GITHUB_REPOSITORY_OWNER:-ahaqqu}
# service:local-image pairs — the local names are Compose's `image:` names
# (automation/docker-compose.yml). The test-runner service's local image is
# `rumaq-test-runner`, NOT `rumaq-test-<service>`; the GHCR name follows the
# plan's rumaq-test-{api,web,test-runner} shape, the tag bridges them.
ENTRIES="api:rumaq-test-api web:rumaq-test-web test-runner:rumaq-test-runner"

# The digest math is the runner's, never a fork: one source of truth for
# image identity.
# shellcheck source=automation/scripts/lib/stack.sh
source "$ROOT_DIR/automation/scripts/lib/stack.sh"

if ! digest="$(stack_deps_digest "$ROOT_DIR")"; then
  echo "publish-test-images: could not compute the toolchain digest — nothing to publish" >&2
  exit 1
fi

to_publish=()
for entry in $ENTRIES; do
  svc=${entry%%:*}
  remote_image="$REGISTRY/$OWNER/rumaq-test-$svc:$digest"
  if docker buildx imagetools inspect "$remote_image" > /dev/null 2>&1; then
    echo "publish-test-images: $remote_image already exists — skipping"
  else
    to_publish+=("$entry")
  fi
done

if [ "${#to_publish[@]}" -eq 0 ]; then
  echo "publish-test-images: all digest $digest images are already on GHCR — done"
  exit 0
fi

echo "publish-test-images: building ${to_publish[*]} for digest $digest (Compose, as the runner does)"
# Same compose file, same tags, same profile gate the runner builds with
# (--profile spa: web is profile-gated; explicit service names build all three).
RUMAQ_DEPS_DIGEST="$digest" docker compose -f "$ROOT_DIR/automation/docker-compose.yml" \
  --profile spa build api web test-runner

for entry in "${to_publish[@]}"; do
  svc=${entry%%:*}
  local_image="${entry#*:}:$digest"
  remote_image="$REGISTRY/$OWNER/rumaq-test-$svc:$digest"
  docker tag "$local_image" "$remote_image"
  docker push "$remote_image"
  echo "publish-test-images: pushed $remote_image (from $local_image)"
done

echo "publish-test-images: digest $digest published"
