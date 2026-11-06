#!/usr/bin/env bash
# Regenerate the PWA icon PNGs in frontend/public/ from the BrandMark
# composition: accent tile (#245c43) holding the white lucide `sprout` glyph,
# drawn at stroke-width 1.5 to match the light() wrapper BrandMark renders
# through (frontend/src/components/icons.jsx).
#
# The mark must stay in sync with:
#   - frontend/src/components/icons.jsx (BrandMark component, source of truth)
#   - frontend/index.html (inline SVG favicon, same composition)
#   - frontend/node_modules/lucide-react/dist/esm/icons/sprout.mjs
#     (glyph path data, verbatim from the installed lucide-react)
#
# Requires rsvg-convert (librsvg) on PATH.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$repo_root/frontend/public"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

accent='#245c43'
on_accent='#ffffff'

# lucide `sprout` paths (24x24 grid), verbatim from the installed lucide-react.
sprout='<path d="M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3"/><path d="M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4"/><path d="M5 21h14"/>'

# Standard icons mirror BrandMark at size 32: rounded tile (30% radius) with
# the glyph in a round(32 * 0.61) = 20px centered box, i.e. the 24x24 lucide
# grid scaled by 20/24 and translated to (6, 6).
cat >"$tmp_dir/icon.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9.6" fill="$accent"/><g transform="translate(6 6) scale(0.83333)" fill="none" stroke="$on_accent" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">$sprout</g></svg>
EOF

# Maskable: full-bleed tile (no transparent corners) with the glyph in the
# same 62.5% box (320px on 512). The glyph's widest extent stays ~180px from
# the center, inside the 204.8px (80%) safe-zone radius.
cat >"$tmp_dir/icon-maskable.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="$accent"/><g transform="translate(96 96) scale(13.33333)" fill="none" stroke="$on_accent" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">$sprout</g></svg>
EOF

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "error: rsvg-convert (librsvg) is required to rasterize the icons" >&2
  exit 1
fi

rsvg-convert -w 192 -h 192 "$tmp_dir/icon.svg" -o "$out_dir/icon-192x192.png"
rsvg-convert -w 512 -h 512 "$tmp_dir/icon.svg" -o "$out_dir/icon-512x512.png"
rsvg-convert -w 512 -h 512 "$tmp_dir/icon-maskable.svg" -o "$out_dir/icon-maskable-512x512.png"

echo "Regenerated icon-192x192.png, icon-512x512.png, icon-maskable-512x512.png in $out_dir"
