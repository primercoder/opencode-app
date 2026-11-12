#!/usr/bin/env bash
# Print the local toolchain versions and Android/Docker readiness.
set -euo pipefail

line() { printf '%-16s %s\n' "$1" "$2"; }

line "OS" "$(. /etc/os-release && echo "$PRETTY_NAME")"
line "Node" "$(node -v 2>/dev/null || echo MISSING)"
line "npm" "$(npm -v 2>/dev/null || echo MISSING)"
line "Bun" "$(bun -v 2>/dev/null || echo MISSING)"
line "Go" "$(go version 2>/dev/null || echo MISSING)"
line "Java" "$(java -version 2>&1 | head -1 || echo MISSING)"
line "JAVA_HOME" "${JAVA_HOME:-MISSING}"
line "Android SDK" "${ANDROID_HOME:-MISSING}"
line "adb" "$(adb version 2>/dev/null | head -1 || echo MISSING)"
line "Android CLI" "$(android --version 2>/dev/null | head -1 || echo MISSING)"
line "Emulator" "$(emulator -version 2>/dev/null | head -1 || echo MISSING)"
line "AVDs" "$(emulator -list-avds 2>/dev/null | tr '\n' ' ' || echo MISSING)"
line "Docker" "$(docker --version 2>/dev/null || echo 'MISSING (or re-login for docker group)')"
line "Compose" "$(docker compose version 2>/dev/null | head -1 || echo MISSING)"
line "Maestro" "$(maestro --version 2>/dev/null | head -1 || echo MISSING)"
line "scrcpy" "$(scrcpy --version 2>/dev/null | head -1 || echo MISSING)"
line "GOPROXY" "${GOPROXY:-MISSING}"
line "KVM" "$([ -e /dev/kvm ] && echo present || echo 'missing (emulator uses -accel off)')"
line "Virt" "$(systemd-detect-virt 2>/dev/null || echo none)"
line "vmx/svm" "$(grep -m1 -oE '\b(vmx|svm)\b' /proc/cpuinfo 2>/dev/null || echo 'missing')"

echo
echo "Git:"
git -C "$(dirname "$0")/.." status --short || true
git -C "$(dirname "$0")/.." log --oneline -1 2>/dev/null || true
