#!/bin/sh
# WhatsOnMyNet - Linux report (read only). Sends CPU, RAM, file systems, uptime and the state of the services
# (systemd) every 5 minutes to WhatsOnMyNet - plus hardware (model, CPU, network cards; as root also serial number
# and memory modules), the disks (with smartctl as root: health, temperature, wear), pending updates and restart,
# firewall and critical journal entries of the last 24 hours. No agent, no open port, nothing installed, root not needed: run it once
# (sh womn-host.sh) - it sets itself up in cron. Needs: sh, awk, curl. Removing: womn-host-uninstall.sh.
# Talks only to the address below; loads nothing from anywhere.
URL=@URL@
TOKEN=@TOKEN@
PIN=@PIN@
export LC_ALL=C
@SETUP@

esc() { printf '%s' "$1" | tr -d '\001-\010\013-\037\177' | awk 'BEGIN{ORS=""} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/," "); if (NR>1) print " "; print}'; }

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
# Columns: device, type, size, used, free, use%, mount point. A device or mount point with spaces (a CIFS share
# "//nas/Team Daten") shifts them - so the use% column is looked for, and only lines with numbers are taken.
disks=$(df -P -k -T 2>/dev/null | awk 'NR>1 {
  p = 0; for (i = 5; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { p = i; break }
  if (!p) next
  type = $(p-4); total = $(p-3); used = $(p-2)
  if (total !~ /^[0-9]+$/ || used !~ /^[0-9]+$/ || total == 0) next
  if (type ~ /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup2?|efivarfs|autofs|ramfs|nsfs|fuse\..*|nfs.*|cifs|smb3)$/) next
  m = $(p+1); for (i = p+2; i <= NF; i++) m = m " " $i
  print m "\t" used "\t" total }' | sort -u -t "$(printf '\t')" -k1,1 | head -n 50)
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

# Hardware from DMI (serial number and memory modules only as root)
rd() { [ -r "$1" ] && tr -d '\n' < "$1" 2>/dev/null | sed 's/[[:space:]]*$//'; }
d=/sys/class/dmi/id
hmodel=$(rd $d/product_name); [ -n "$hmodel" ] || hmodel=$(tr -d '\000' 2>/dev/null < /proc/device-tree/model)
hcpu=$(awk -F': *' '/^model name/ {print $2; exit}' /proc/cpuinfo)
[ -n "$hcpu" ] || hcpu=$(awk -F': *' '/^(Hardware|Model)[[:space:]]*:/ {print $2; exit}' /proc/cpuinfo)
threads=$(grep -c '^processor' /proc/cpuinfo)
sockets=$(awk -F': *' '/^physical id/ {print $2}' /proc/cpuinfo | sort -u | wc -l)
cores=$(awk -F': *' '/^physical id/ {p=$2} /^core id/ {print p"-"$2}' /proc/cpuinfo | sort -u | wc -l)
[ "$sockets" -gt 0 ] || sockets=1; [ "$cores" -gt 0 ] || cores=$threads
virt=false; command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt -q 2>/dev/null && virt=true
ram=""
if [ "$(id -u)" = 0 ] && command -v dmidecode >/dev/null 2>&1; then
  ram=$(dmidecode -t 17 2>/dev/null | awk -F': *' '
    function clean(v) { gsub(/["\\]/, "", v); sub(/[[:space:]]+$/, "", v); return v }
    function out() { if (size > 0) printf "%s{\"slot\":\"%s\",\"sizeMb\":%d,\"speed\":%d,\"vendor\":\"%s\",\"part\":\"%s\"}", (n++ ? "," : ""), clean(loc), size, speed, clean(ven), clean(part); size = 0; speed = 0; loc = ven = part = "" }
    /^Memory Device/ { out() }
    /^[[:space:]]+Size:/ { v = $2; size = (v ~ /GB/) ? v * 1024 : (v ~ /MB/) ? v + 0 : 0 }
    /^[[:space:]]+Locator:/ { loc = $2 } /^[[:space:]]+Speed:/ { speed = $2 + 0 }
    /^[[:space:]]+Manufacturer:/ { ven = $2 } /^[[:space:]]+Part Number:/ { part = $2 }
    END { out() }')
fi
nj=""
for n in /sys/class/net/*; do
  [ -e "$n/device" ] || continue
  sp=$(cat "$n/speed" 2>/dev/null); case "$sp" in ''|-*|*[!0-9]*) sp=0 ;; esac
  up=false; [ "$(cat "$n/operstate" 2>/dev/null)" = up ] && up=true
  nj="$nj${nj:+,}{\"name\":\"$(esc "${n##*/}")\",\"mac\":\"$(esc "$(cat "$n/address" 2>/dev/null)")\",\"speedMb\":$sp,\"up\":$up}"
done
hw="{\"vendor\":\"$(esc "$(rd $d/sys_vendor)")\",\"model\":\"$(esc "$hmodel")\",\"serial\":\"$(esc "$(rd $d/product_serial)")\",\"bios\":\"$(esc "$(rd $d/bios_version)")\",\"biosDate\":\"$(esc "$(rd $d/bios_date)")\",\"cpu\":\"$(esc "$hcpu")\",\"sockets\":$sockets,\"cores\":$cores,\"threads\":${threads:-0},\"virtual\":$virt,\"ram\":[$ram],\"nics\":[$nj]}"

# Disks: model, serial number and size (lsblk); with smartctl (root) also health, temperature, hours and wear -
# the server reads them out of the smartctl answer
pj=""
if command -v lsblk >/dev/null 2>&1; then
  for dev in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2 == "disk" && $1 !~ /^(zram|ram|loop|fd|sr)/ {print $1}' | head -n 32); do
    kv=$(lsblk -dn -b -P -o MODEL,SERIAL,SIZE,ROTA,TRAN "/dev/$dev" 2>/dev/null)
    get() { printf '%s' "$kv" | awk -v k="$1" '{ if (match($0, k "=\"[^\"]*\"")) { v = substr($0, RSTART + length(k) + 2, RLENGTH - length(k) - 3); gsub(/\\x20/, " ", v); sub(/[[:space:]]+$/, "", v); print v } }'; }
    sm=null
    if [ "$(id -u)" = 0 ] && command -v smartctl >/dev/null 2>&1; then
      out=$(smartctl -j -i -H -A "/dev/$dev" 2>/dev/null)
      case "$out" in "{"*"}") sm=$out ;; esac
    fi
    sz=$(get SIZE); case "$sz" in ''|*[!0-9]*) sz=0 ;; esac
    rota=$(get ROTA); case "$rota" in 0|1) ;; *) rota=null ;; esac
    pj="$pj${pj:+,}{\"name\":\"$(esc "$dev")\",\"model\":\"$(esc "$(get MODEL)")\",\"serial\":\"$(esc "$(get SERIAL)")\",\"size\":$sz,\"rota\":$rota,\"tran\":\"$(esc "$(get TRAN)")\",\"smart\":$sm}"
  done
fi

# Updates: the package search runs after the report at most every 6 hours (apt: simulated upgrade, dnf: cache only);
# the report sends the last result. A pending restart (Debian/Ubuntu) is read every time.
if [ "$(id -u)" = 0 ]; then CACHE=/var/cache/whatsonmynet; else CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/whatsonmynet; fi
UPD=$CACHE/updates.json
uc=null; [ -s "$UPD" ] && uc=$(cat "$UPD")
case "$uc" in "{"*"}") ;; *) uc=null ;; esac
rb=false; [ -f /var/run/reboot-required ] && rb=true
updj="{\"cache\":$uc,\"reboot\":$rb}"

# Firewall: ufw (root) or firewalld
fwj=null
if command -v ufw >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
  case "$(ufw status 2>/dev/null | head -n 1)" in *inactive*) fwj='{"name":"ufw","on":false}' ;; *active*) fwj='{"name":"ufw","on":true}' ;; esac
elif command -v firewall-cmd >/dev/null 2>&1; then
  if [ "$(firewall-cmd --state 2>/dev/null)" = running ]; then fwj='{"name":"firewalld","on":true}'; else fwj='{"name":"firewalld","on":false}'; fi
fi

# Journal: critical entries and errors of the last 24 hours (the newest 10 with text)
ej=null
if command -v journalctl >/dev/null 2>&1; then
  crit=$(journalctl -q --no-pager -p 0..2 --since "24 hours ago" -o cat 2>/dev/null | wc -l)
  errs=$(journalctl -q --no-pager -p 3..3 --since "24 hours ago" -o cat 2>/dev/null | wc -l)
  items=$(journalctl -q --no-pager -p 0..3 --since "24 hours ago" -r -n 10 -o json 2>/dev/null | awk '/^\{.*\}$/ {printf "%s%s", (n++ ? "," : ""), $0}')
  ej="{\"hours\":24,\"critical\":${crit:-0},\"errors\":${errs:-0},\"journal\":[$items]}"
fi

# Temperatures from hwmon - the same source lm-sensors' "sensors" reads, without lm-sensors and without root:
# CPU (coretemp/k10temp), NVMe, chipset, mainboard chip, … in thousandths of a degree, with the limits the chip
# itself names. Without hwmon (some ARM boards, VMs): the thermal zones. The device behind a chip makes the name
# stable (hwmon numbers can change at the next start). WOMN_HWMON / WOMN_THERMAL only for the tests.
HWMON=${WOMN_HWMON:-/sys/class/hwmon}
THERMAL=${WOMN_THERMAL:-/sys/class/thermal}
tj=""; tn=0
mc() { v=$(cat "$1" 2>/dev/null); case "$v" in ''|*[!0-9-]*|-) printf null ;; *) printf '%s' "$v" ;; esac; }
for c in "$HWMON"/hwmon*; do
  [ -r "$c/name" ] || continue
  chip=$(cat "$c/name" 2>/dev/null)
  dev=$( (cd "$c/device" 2>/dev/null && pwd -P) || true); dev=${dev##*/}
  for t in "$c"/temp*_input; do
    [ -r "$t" ] && [ "$tn" -lt 64 ] || continue
    b=${t%_input}; v=$(mc "$t"); [ "$v" = null ] && continue
    lab=$(cat "${b}_label" 2>/dev/null); [ -n "$lab" ] || lab=${b##*/}
    tj="$tj${tj:+,}{\"chip\":\"$(esc "$chip")\",\"dev\":\"$(esc "$dev")\",\"name\":\"$(esc "$lab")\",\"mC\":$v,\"maxMC\":$(mc "${b}_max"),\"critMC\":$(mc "${b}_crit")}"
    tn=$((tn + 1))
  done
done
if [ -z "$tj" ]; then
  for z in "$THERMAL"/thermal_zone*; do
    [ -r "$z/temp" ] && [ "$tn" -lt 16 ] || continue
    v=$(mc "$z/temp"); [ "$v" = null ] && continue
    tj="$tj${tj:+,}{\"chip\":\"thermal\",\"dev\":\"$(esc "${z##*/}")\",\"name\":\"$(esc "$(cat "$z/type" 2>/dev/null)")\",\"mC\":$v,\"maxMC\":null,\"critMC\":null}"
    tn=$((tn + 1))
  done
fi

macs=""
for a in /sys/class/net/*/address; do
  [ -r "$a" ] || continue
  case "$a" in */lo/address) continue ;; esac
  m=$(cat "$a"); [ "$m" = 00:00:00:00:00:00 ] && continue
  macs="$macs${macs:+,}\"$m\""
done
ips=$( (ip -o -4 addr show scope global 2>/dev/null || true) | awk '{split($4,a,"/"); printf "%s\"%s\"", (n++?",":""), a[1]}')

body="{\"hostname\":\"$(esc "$name")\",\"os\":\"$(esc "$os")\",\"cpu\":${cpu:-0},\"memTotalKb\":${memkb:-0},\"memAvailKb\":${availkb:-0},\"uptime\":${uptime:-0},\"disks\":[$dj],\"services\":[$sj],\"macs\":[$macs],\"ips\":[$ips],\"ups\":$uj,\"hw\":$hw,\"pdisks\":[$pj],\"updates\":$updj,\"firewall\":$fwj,\"events\":$ej,\"temps\":[$tj]}"
if [ -n "$PIN" ]; then TLS="-k --pinnedpubkey $PIN"; else TLS=""; fi
# shellcheck disable=SC2086
printf '%s' "$body" | curl -fsS --max-time 30 $TLS -H "Authorization: Bearer $TOKEN" -H 'X-WOMN-Request: 1' -H 'Content-Type: application/json' --data-binary @- "$URL" >/dev/null

# After the report: search for updates again when the last search is older than 6 hours (not on the first call -
# the setup should be quick). Only looks, never installs.
if [ "${1:-}" = --run ] && { [ ! -s "$UPD" ] || [ -n "$(find "$UPD" -mmin +360 2>/dev/null)" ]; }; then
  n=""; sec=0; rpm=false
  if command -v apt-get >/dev/null 2>&1; then
    r=$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | awk '/^Inst / {n++; if (/[Ss]ecurity/) s++} END {printf "%d %d", n, s}')
    n=${r%% *}; sec=${r##* }
  elif command -v dnf >/dev/null 2>&1; then
    n=$(dnf -q --cacheonly check-update 2>/dev/null | awk 'NF == 3 && $2 ~ /[0-9]/ {c++} END {print c + 0}')
    sec=$(dnf -q --cacheonly updateinfo list --security 2>/dev/null | wc -l)
    command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || rpm=true; }
  fi
  if [ -n "$n" ]; then
    mkdir -p "$CACHE" && chmod 700 "$CACHE"
    printf '{"pending":%d,"security":%d,"reboot":%s,"checkedAt":"%s"}' "$n" "${sec:-0}" "$rpm" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$UPD"
  fi
fi
