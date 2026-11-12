#!/bin/sh
# Smoke test of an image – started like in docker-compose.yml (host network, same hardening).
# Usage: sh .github/scripts/smoke-test.sh <image>
set -u
IMG="$1"
NAME="womn-smoke-$$"
DATA="$(mktemp -d)"
HTTPS_PORT=18743
HTTP_PORT=18780

fail() {
  echo "::error::$1 | $(docker logs "$NAME" 2>&1 | tail -n 10 | tr '\n' '|')"
  docker rm -f "$NAME" >/dev/null 2>&1
  exit 1
}

out="$(docker run -d --name "$NAME" --network host -v "$DATA:/data" -e WOMN_COMPOSE_VERSION=1 \
  -e WOMN_HTTPS_PORT=$HTTPS_PORT -e WOMN_HTTP_PORT=$HTTP_PORT \
  --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID --cap-add KILL \
  "$IMG" 2>&1)" || fail "docker run: $out"

i=0
while [ "$i" -lt 45 ]; do
  s="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)"
  [ "$s" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Status}}' "$NAME")" = running ] || fail "container is no longer running"
  sleep 2
  i=$((i + 1))
done
docker logs "$NAME"
[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] || fail "not healthy"
curl -fsSk "https://localhost:$HTTPS_PORT/api/bootstrap" | grep -q '"setupRequired":true' || fail "bootstrap over HTTPS"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$HTTP_PORT/inventory")"
[ "$code" = 301 ] || fail "HTTP port does not redirect (status $code)"
loc="$(curl -s -o /dev/null -w '%{redirect_url}' "http://localhost:$HTTP_PORT/inventory")"
[ "$loc" = "https://localhost:$HTTPS_PORT/inventory" ] || fail "wrong redirect target: $loc"
docker logs "$NAME" 2>&1 | grep -Eq 'Einrichtungscode|[Ss]etup code' || fail "no setup code in the log"
owner="$(sudo stat -c %u "$DATA/whatsonmynet.sqlite")"
[ "$owner" = 1000 ] || fail "database is owned by $owner instead of 1000"
mode="$(sudo stat -c %a "$DATA/whatsonmynet.sqlite")"
[ "$mode" = 600 ] || fail "database has mode $mode instead of 600"
kmode="$(sudo stat -c %a "$DATA/tls/key.pem")"
[ "$kmode" = 600 ] || fail "certificate key has mode $kmode instead of 600"
# Tools the scanner and the certificate need
docker exec "$NAME" sh -c 'command -v openssl && command -v ping' >/dev/null || fail "openssl or ping missing in the image"
docker exec "$NAME" womn-admin list >/dev/null || fail "womn-admin does not run"
# Network drive check runs as the program user on the read-only file system (no SMB server here: refused)
smb="$(docker exec -u 1000 "$NAME" node -e "import('/app/src/monitor/smb.js').then((m) => m.smbCheck('127.0.0.1', 1, { share: 'x' }, '', 3)).then((r) => console.log(r.message))" 2>&1)"
[ "$smb" = "connection refused" ] || fail "network drive check in the container: $smb"
# Stop must reach the program (clean shutdown), not end in a hard kill after the grace period
docker stop -t 20 "$NAME" >/dev/null
docker logs "$NAME" 2>&1 | grep -q 'SIGTERM received' || fail "stop signal did not reach WhatsOnMyNet"
if docker logs "$NAME" 2>&1 | grep -q 'FATAL tini'; then fail "tini could not forward the stop signal"; fi
[ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" = 0 ] || fail "exit code after stop is not 0"
docker rm -f "$NAME" >/dev/null

# Slim image: no package tools of the Node base image, only one SQLite binary, no sources
extra="$(docker run --rm --entrypoint /bin/sh "$IMG" -c '
  for f in /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg; do
    [ -e "$f" ] && echo "$f"
  done
  ls -d /opt/yarn-* /app/node_modules/better-sqlite3/deps /app/node_modules/better-sqlite3/src 2>/dev/null
  n="$(ls /app/node_modules/better-sqlite3/prebuilds 2>/dev/null | wc -l)"
  [ "$n" -le 1 ] || echo "better-sqlite3: $n prebuilt binaries"
  true' 2>&1)"
[ -z "$extra" ] || fail "left in the image: $(echo "$extra" | tr '\n' ' ')"
echo "Smoke test passed: $IMG"
