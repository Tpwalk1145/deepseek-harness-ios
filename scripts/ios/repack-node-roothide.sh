#!/bin/sh
# repack-node-roothide.sh — 把 rootless 版 nodejs deb 重排为 roothide 包模型。
# roothide 的 deb 按包结构用 Architecture: iphoneos-arm64e + rootful 风格路径
# （./usr/...），roothide 的 dpkg 安装时把文件迁入随机的 jbroot。node 二进制与
# entitlements 从 rootless deb 原样搬运，零重编译。
#
# Usage: ./scripts/ios/repack-node-roothide.sh [dist/nodejs_<ver>_iphoneos-arm64.deb]
# Output: dist/nodejs_<ver>_iphoneos-arm64e.deb
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p dist

SRC_DEB="${1:-dist/nodejs_22.23.2-4_iphoneos-arm64.deb}"
[ -f "$SRC_DEB" ] || { echo "source deb not found: $SRC_DEB" >&2; exit 1; }
SRC_BASE="$(basename "$SRC_DEB" .deb)"                 # nodejs_22.23.2-4_iphoneos-arm64
NODE_DEB_VER="${SRC_BASE#nodejs_}"                     # 22.23.2-4_iphoneos-arm64
NODE_DEB_VER="${NODE_DEB_VER%_iphoneos-arm64}"         # 22.23.2-4
NODE_VER="${NODE_DEB_VER%-*}"                          # 22.23.2
OUT="dist/nodejs_${NODE_DEB_VER}_iphoneos-arm64e.deb"

STAGE=/tmp/nodejs-roothide-deb
rm -rf "$STAGE" && mkdir -p "$STAGE/DEBIAN"

# data.tar.gz 里只有 ./var/jb/usr/local/{bin/node,lib/nodejs/entitlements.plist}
ar p "$SRC_DEB" data.tar.gz | tar -xzf - -C "$STAGE"
mkdir -p "$STAGE/usr/local"
cp -a "$STAGE/var/jb/usr/local/." "$STAGE/usr/local/"
rm -rf "$STAGE/var"

cat > "$STAGE/DEBIAN/control" <<CTRL
Package: nodejs
Name: Node.js (iOS arm64, RootHide)
Version: $NODE_DEB_VER
Architecture: iphoneos-arm64e
Maintainer: dsh-ios port
Section: Development
Description: Node.js $NODE_VER cross-compiled for jailbroken iOS, repacked for RootHide Bootstrap (roothide, dpkg installs into the randomized jbroot). Darwin-style V8 JIT path (no MAP_JIT) for full JIT+WASM. Rootful-style layout: /usr/local under the jbroot.
CTRL

cat > "$STAGE/DEBIAN/postinst" <<'CTRL'
#!/bin/sh
P=/usr/local
LOG=/var/mobile/.dsh/postinst.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null
log(){ echo "[nodejs postinst $(date +%H:%M:%S)] $*" >> "$LOG" 2>/dev/null; }
if command -v ldid >/dev/null 2>&1; then
  if ldid -S"$P/lib/nodejs/entitlements.plist" "$P/bin/node" >>"$LOG" 2>&1; then
    echo "node signed (JIT entitlements)"
    log "node signed OK"
  else
    echo "ERROR: node signing FAILED - binary left UNSIGNED, will SIGKILL on V8 JIT" >&2
    log "ERROR: ldid -S node FAILED (see above)"
  fi
else
  echo "ERROR: ldid not found - node left UNSIGNED, will SIGKILL on V8 JIT" >&2
  log "ERROR: ldid not found in PATH"
fi
# jbctl=Dopamine；trustcache=Procursus 系（roothide）。都没有则告警不失败。
if command -v jbctl >/dev/null 2>&1; then
  jbctl trustcache add "$P/bin/node" >>"$LOG" 2>&1 && log "trustcache add node OK" || log "WARN: jbctl trustcache add node failed"
elif command -v trustcache >/dev/null 2>&1; then
  trustcache add "$P/bin/node" >>"$LOG" 2>&1 && log "trustcache add node OK" || log "WARN: trustcache add node failed"
else
  log "WARN: no jbctl/trustcache found - trustcache registration skipped"
fi
exit 0
CTRL
chmod 755 "$STAGE/DEBIAN/postinst"

dpkg-deb -b --root-owner-group -Zgzip "$STAGE" "$OUT" >/dev/null
echo "✅ $OUT"
