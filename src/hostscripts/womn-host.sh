#!/bin/sh
# WhatsOnMyNet - Linux report (read only). Sends CPU, RAM, file systems, uptime and the state of the services
# (systemd) every 5 minutes to WhatsOnMyNet. No agent, no open port, nothing installed, root not needed: run it once
# (sh womn-host.sh) - it sets itself up in cron. Needs: sh, awk, curl. Removing: womn-host-uninstall.sh.
# Talks only to the address below; loads nothing from anywhere.
URL=@URL@
TOKEN=@TOKEN@
PIN=@PIN@
export LC_ALL=C
@SETUP@

esc() { printf '%s' "$1" | awk 'BEGIN{ORS=""} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/," "); if (NR>1) print " "; print}'; }

name=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname)
os=$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-$NAME}")
[ -n "$os" ] || os=$(uname -sr)
s1=$(grep '^cpu ' /proc/stat)
sleep 2
s2=$(grep '^cpu ' /proc/stat)
# Busy share of all CPUs between the two readings (only small numbers leave awk - no exponent format)
cpu=$(printf '%s\n%s\n' "$s1" "$s2" | awk '{t=0; for (i=2; i<=9 && i<=NF; i++) t+=$i; idle=$5+$6; if (NR==1) {t1=t; i1=idle} else {dt=t-t1; di=idle-i1; printf "%d", (dt>0 ? 100*(dt-di)/dt : 0)}}')
memkb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
availkb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
uptime=$(awk '{printf "%d", $1}' /proc/uptime)

# File systems on disks (no tmpfs, overlay, snap images …); sizes in KiB, turned into bytes by the server
disks=$(df -P -k -T 2>/dev/null | awk 'NR>1 && $2 !~ /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup2?|efivarfs|autofs|ramfs|nsfs|fuse\..*|nfs.*|cifs|smb3)$/ && $3>0 {print $7"\t"$4"\t"$3}' | sort -u -k1,1 | head -n 50)
dj=""
while IFS="$(printf '\t')" read -r mnt used total; do
  [ -n "$mnt" ] || continue
  dj="$dj${dj:+,}{\"name\":\"$(esc "$mnt")\",\"usedKb\":$used,\"totalKb\":$total}"
done <<EOT
$disks
EOT

# Services (systemd): loaded units with their state; "failed" = crashed or could not start
sj=""
if command -v systemctl >/dev/null 2>&1; then
  units=$(systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '$2=="loaded" {d=""; for (i=5; i<=NF; i++) d=d (i>5?" ":"") $i; print $1"\t"$3"\t"$4"\t"d}' | head -n 400)
  while IFS="$(printf '\t')" read -r unit active sub descr; do
    [ -n "$unit" ] || continue
    st=stopped; [ "$sub" = running ] && st=running; [ "$active" = failed ] && st=failed
    f=false; [ "$active" = failed ] && f=true
    sj="$sj${sj:+,}{\"name\":\"$(esc "${unit%.service}")\",\"display\":\"$(esc "$descr")\",\"state\":\"$st\",\"failed\":$f}"
  done <<EOT
$units
EOT
fi

# UPS: values of a NUT (upsc) or apcupsd (apcaccess) running here - read only, only when one is installed
num() { case "$1" in ''|*[!0-9.]*) printf null ;; *) printf '%s' "$1" ;; esac; }
uj=null
if command -v upsc >/dev/null 2>&1 && u=$(upsc -l 2>/dev/null | head -n 1) && [ -n "$u" ]; then
  uv=$(upsc "$u@localhost" 2>/dev/null)
  get() { printf '%s\n' "$uv" | awk -F': ' -v k="$1" '$1==k {print $2; exit}'; }
  m=$(get ups.model); [ -n "$m" ] || m=$(get device.model)
  v=$(get ups.mfr); [ -n "$v" ] || v=$(get device.mfr)
  uj="{\"status\":\"$(esc "$(get ups.status)")\",\"charge\":$(num "$(get battery.charge)"),\"runtime\":$(num "$(get battery.runtime)"),\"load\":$(num "$(get ups.load)"),\"model\":\"$(esc "$m")\",\"vendor\":\"$(esc "$v")\"}"
elif command -v apcaccess >/dev/null 2>&1 && av=$(apcaccess status 2>/dev/null) && [ -n "$av" ]; then
  get() { printf '%s\n' "$av" | awk -F' *: *' -v k="$1" '$1==k {split($2, a, " "); print (k=="STATUS" || k=="MODEL") ? $2 : a[1]; exit}'; }
  left=$(get TIMELEFT); [ -n "$left" ] && left=$(awk -v m="$left" 'BEGIN {printf "%d", m*60}')
  uj="{\"status\":\"$(esc "$(get STATUS)")\",\"charge\":$(num "$(get BCHARGE)"),\"runtime\":$(num "$left"),\"load\":$(num "$(get LOADPCT)"),\"model\":\"$(esc "$(get MODEL)")\",\"vendor\":\"APC\"}"
fi

macs=""
for a in /sys/class/net/*/address; do
  [ -r "$a" ] || continue
  case "$a" in */lo/address) continue ;; esac
  m=$(cat "$a"); [ "$m" = 00:00:00:00:00:00 ] && continue
  macs="$macs${macs:+,}\"$m\""
done
ips=$( (ip -o -4 addr show scope global 2>/dev/null || true) | awk '{split($4,a,"/"); printf "%s\"%s\"", (n++?",":""), a[1]}')

body="{\"hostname\":\"$(esc "$name")\",\"os\":\"$(esc "$os")\",\"cpu\":${cpu:-0},\"memTotalKb\":${memkb:-0},\"memAvailKb\":${availkb:-0},\"uptime\":${uptime:-0},\"disks\":[$dj],\"services\":[$sj],\"macs\":[$macs],\"ips\":[$ips],\"ups\":$uj}"
if [ -n "$PIN" ]; then TLS="-k --pinnedpubkey $PIN"; else TLS=""; fi
# shellcheck disable=SC2086
printf '%s' "$body" | curl -fsS --max-time 30 $TLS -H "Authorization: Bearer $TOKEN" -H 'X-WOMN-Request: 1' -H 'Content-Type: application/json' --data-binary @- "$URL" >/dev/null
