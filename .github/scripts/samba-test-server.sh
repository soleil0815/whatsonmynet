#!/bin/sh
# Samba server for the network drive test (test/smb.test.js) on 127.0.0.1:1445 with share "Abteilung"
# and user "monitor". Usage: sh .github/scripts/samba-test-server.sh <password>
set -eu
PW="$1"
D="$(mktemp -d)"
mkdir -p "$D/share/Projekte" "$D/priv" "$D/run" "$D/lock" "$D/state" "$D/cache" "$D/log" "$D/ncalrpc"
echo hallo > "$D/share/Projekte/Bericht.txt"
chmod 755 "$D"
chmod -R a+rX "$D/share"
cat > "$D/smb.conf" <<CONF
[global]
  smb ports = 1445
  bind interfaces only = yes
  interfaces = lo
  private dir = $D/priv
  pid directory = $D/run
  lock directory = $D/lock
  state directory = $D/state
  cache directory = $D/cache
  ncalrpc dir = $D/ncalrpc
  log file = $D/log/%m.log
  server min protocol = SMB2
  load printers = no
  disable spoolss = yes
[Abteilung]
  path = $D/share
  read only = yes
  valid users = monitor
CONF
sudo mkdir -p /run/samba
id monitor >/dev/null 2>&1 || sudo useradd -M monitor
printf '%s\n%s\n' "$PW" "$PW" | sudo smbpasswd -c "$D/smb.conf" -s -a monitor >/dev/null
# shellcheck disable=SC2024 # the log file belongs to this user, sudo is only needed for smbd
sudo setsid smbd -s "$D/smb.conf" -F --no-process-group >"$D/log/fg.log" 2>&1 &
i=0
while [ "$i" -lt 20 ]; do
  if PASSWD="$PW" smbclient -s /dev/null -p 1445 //127.0.0.1/Abteilung -U monitor -c du >/dev/null 2>&1; then
    echo "Samba test server ready"
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done
cat "$D/log/fg.log"
echo "::error::Samba test server did not start"
exit 1
