#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mode="${1:-open}"
case "$mode" in open|archive) ;; *) echo 'Usage: sh scripts/build-ios.sh [open|archive]' >&2; exit 2 ;; esac
if [ "$(uname -s)" != Darwin ]; then
  echo 'Native iPhone compilation requires macOS and Xcode 26 or later. Use node scripts/prepare-ios.mjs to prepare resources on Windows.' >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 24.15 or later first.' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<24||(a===24&&b<15))process.exit(1)' || { echo 'Node.js 24.15 or later is required.' >&2; exit 1; }
xcode_major=$(xcodebuild -version | awk '/^Xcode / { split($2,v,"."); print v[1] }')
case "$xcode_major" in ''|*[!0-9]*) echo 'Select a complete Xcode installation first.' >&2; exit 1 ;; esac
if [ "$xcode_major" -lt 26 ]; then echo 'Xcode 26 or later is required by Capacitor 8.' >&2; exit 1; fi
if [ "$mode" = archive ]; then
  case "${ICHAT_APPLE_TEAM_ID:-}" in ''|*[!A-Z0-9]*) echo 'Set ICHAT_APPLE_TEAM_ID to your Apple signing team identifier.' >&2; exit 1 ;; esac
  if [ "${#ICHAT_APPLE_TEAM_ID}" -ne 10 ]; then echo 'The Apple Team ID must contain 10 characters.' >&2; exit 1; fi
fi
npm ci --no-fund --no-audit
node scripts/prepare-ios.mjs
npx cap sync ios
node scripts/verify-ios-project.mjs
if [ "$mode" = open ]; then
  echo 'Select your signing team in Xcode, then run on an iPhone or archive with the App scheme.'
  open ios/App/App.xcodeproj
else
  version=$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')
  output_dir="$(pwd)/deliverables/ios-${version}-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$output_dir"
  archive_path="$output_dir/iChat.xcarchive"
  if [ -e "$archive_path" ]; then echo 'Archive already exists; preserve the previous build.' >&2; exit 1; fi
  xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$archive_path" \
    -allowProvisioningUpdates "DEVELOPMENT_TEAM=$ICHAT_APPLE_TEAM_ID" archive
  codesign --verify --deep --strict "$archive_path/Products/Applications/App.app"
  if [ -n "${ICHAT_IOS_EXPORT_OPTIONS:-}" ]; then
    if [ ! -f "$ICHAT_IOS_EXPORT_OPTIONS" ]; then echo 'ExportOptions.plist does not exist.' >&2; exit 1; fi
    plutil -lint "$ICHAT_IOS_EXPORT_OPTIONS"
    cp "$ICHAT_IOS_EXPORT_OPTIONS" "$output_dir/ExportOptions.plist"
    # Always export a local artifact. Do not upload a build as a side effect.
    /usr/libexec/PlistBuddy -c 'Set :destination export' "$output_dir/ExportOptions.plist" 2>/dev/null || \
      /usr/libexec/PlistBuddy -c 'Add :destination string export' "$output_dir/ExportOptions.plist"
    xcodebuild -exportArchive -archivePath "$archive_path" -exportPath "$output_dir/export" \
      -exportOptionsPlist "$output_dir/ExportOptions.plist" -allowProvisioningUpdates
    found=0
    for ipa in "$output_dir/export/"*.ipa; do
      if [ -f "$ipa" ]; then found=1; shasum -a 256 "$ipa"; fi
    done
    if [ "$found" -ne 1 ]; then echo 'Xcode did not export an IPA.' >&2; exit 1; fi
  else
    echo 'Signed archive created. In Xcode Organizer choose the intended distribution method and export an IPA.'
    open "$archive_path"
  fi
fi
