#!/bin/sh
# WhatsOnMyNet @VERSIONTEXT@ - Linux report (read only). Sends CPU, RAM, file systems, uptime and the state of the services
# (systemd) every 5 minutes to WhatsOnMyNet - plus hardware (model, CPU, network cards; as root also serial number
# and memory modules), the disks (with smartctl as root: health, temperature, wear), pending updates and restart,
# firewall and critical journal entries of the last 24 hours. No agent, no open port, nothing installed, root not needed: run it once
# (sh womn-host.sh) - it sets itself up in cron. Needs: sh, awk, curl. Removing: womn-host-uninstall.sh.
# Talks only to the address below; loads nothing from anywhere - except, when WhatsOnMyNet offers it, a newer version of
# this script from that same address (checked by its fingerprint, see "Self-update" at the end).
URL=@URL@
TOKEN=@TOKEN@
PIN=@PIN@
# The version of this script (sent with every report - WhatsOnMyNet shows machines with an older one)
SCRIPT_VERSION=@VERSIONTEXT@
export LC_ALL=C
@SETUP@

# One run at a time: plugins or a slow disk may make a run longer than 5 minutes, and cron would start the next one
if [ "$(id -u)" = 0 ]; then CACHE=/var/cache/whatsonmynet; else CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/whatsonmynet; fi
mkdir -p "$CACHE" && chmod 700 "$CACHE"
LOCK=$CACHE/run.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  # left over from a run that was killed (power cut): older than 30 minutes
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0; else exit 0; fi
fi
trap 'rm -rf "$LOCK"' EXIT
trap 'exit 1' INT TERM HUP

esc() { printf '%s' "$1" | tr -d '\001-\010\013-\037\177' | awk 'BEGIN{ORS=""} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/," "); if (NR>1) print " "; print}'; }
# the same, keeping lines and tabs (for text the server reads itself: zpool status, /proc/mdstat)
escn() { printf '%s' "$1" | tr -d '\001-\010\013-\037\177' | awk 'BEGIN{ORS=""} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t"); if (NR>1) print "\\n"; print}'; }

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

# Storage pools: ZFS (zpool, readable by any user) and Linux software RAID (/proc/mdstat) - the text as it is, the
# server reads state, members, errors and the last scrub out of it
zj=null
if command -v zpool >/dev/null 2>&1; then
  zl=$(zpool list -Hp -o name,health,size,alloc 2>/dev/null | head -n 32)
  if [ -n "$zl" ]; then
    zs=""
    for zp in $(printf '%s\n' "$zl" | cut -f1); do
      zs="$zs${zs:+,}\"$(esc "$zp")\":\"$(escn "$(zpool status -p "$zp" 2>/dev/null | head -c 20000)")\""
    done
    zj="{\"list\":\"$(escn "$zl")\",\"status\":{$zs}}"
  fi
fi
md=""
[ -r /proc/mdstat ] && grep -q '^md' /proc/mdstat 2>/dev/null && md=$(head -c 20000 /proc/mdstat)

# Updates: the package search runs after the report at most every 6 hours (apt: simulated upgrade, dnf: cache only);
# the report sends the last result. A pending restart (Debian/Ubuntu) is read every time.
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

# Own checks: every executable file in the checks folder prints lines in the Checkmk "local check" format
#   <0|1|2|3> <name> <value or -> <text>      (0 OK, 1 WARN, 2 CRIT, 3 UNKNOWN; value e.g. "count=12" or "-")
# They run with the rights of this script - so only a folder and files of this user (or root) that nobody else
# may change, never a link; at most 50, each at most 30 seconds. WOMN_CHECKS, WOMN_CHECK_TIMEOUT only for the tests.
if [ "$(id -u)" = 0 ]; then CHK=/etc/whatsonmynet/checks; else CHK=${XDG_CONFIG_HOME:-$HOME/.config}/whatsonmynet/checks; fi
CHK=${WOMN_CHECKS:-$CHK}
cj=""
cline() { cj="$cj${cj:+,}{\"name\":\"$(esc "$1")\",\"status\":$2,\"text\":\"$(esc "$3")\",\"value\":null,\"file\":\"$(esc "$4")\"}"; }
if [ -d "$CHK" ]; then
  me=$(id -u)
  if [ -L "$CHK" ] || [ -z "$(find "$CHK" -maxdepth 0 \( -user "$me" -o -user 0 \) ! -perm -g+w ! -perm -o+w 2>/dev/null)" ]; then
    cline _checks 3 "folder $CHK may be changed by others - checks not run" ""
  elif ! command -v timeout >/dev/null 2>&1; then
    cline _checks 3 "the command timeout is missing - checks not run" ""
  else
    # a private temporary folder (never a fixed name in /tmp - this may run as root)
    tmpd=$(mktemp -d 2>/dev/null) || tmpd=""
    if [ -n "$tmpd" ]; then
      find "$CHK" -maxdepth 1 -type f -perm -u+x \( -user "$me" -o -user 0 \) ! -perm -g+w ! -perm -o+w 2>/dev/null | sort | head -n 50 > "$tmpd/list"
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        base=${f##*/}
        # stdin from /dev/null: a check must not read the list of the loop; the exit code is that of the check
        timeout "${WOMN_CHECK_TIMEOUT:-30}" "$f" < /dev/null > "$tmpd/out" 2>/dev/null; rc=$?
        parsed=$(head -c 20000 "$tmpd/out" | awk -v file="$base" '
          function esc(v) { gsub(/[\001-\037\177]/, " ", v); gsub(/\\/, "\\\\", v); gsub(/"/, "\\\"", v); return substr(v, 1, 300) }
          $1 ~ /^[0-3]$/ && NF >= 3 {
            val = "null"
            if ($3 != "-") { split($3, m, "|"); split(m[1], kv, "="); split(kv[2], v, ";"); if (v[1] ~ /^-?[0-9]+(\.[0-9]+)?$/) val = v[1] }
            text = ""; for (i = 4; i <= NF; i++) text = text (i > 4 ? " " : "") $i
            printf "%s{\"name\":\"%s\",\"status\":%d,\"text\":\"%s\",\"value\":%s,\"file\":\"%s\"}", (n++ ? "," : ""), esc($2), $1, esc(text), val, esc(file)
          }')
        if [ "$rc" = 124 ]; then cline "$base" 3 "timeout (${WOMN_CHECK_TIMEOUT:-30} s)" "$base"
        elif [ -n "$parsed" ]; then cj="$cj${cj:+,}$parsed"
        else cline "$base" 3 "no line in the check format (exit code $rc)" "$base"; fi
      done < "$tmpd/list"
      rm -rf "$tmpd"
    fi
  fi
fi

# Plugins written in WhatsOnMyNet (Settings → Plugins), put into the plugins folder by the administrators. A plugin
# runs only when WhatsOnMyNet named exactly this file for this machine in its answer to the last report: id, version
# and fingerprint (SHA-256) - a changed file, an old version or a plugin meant for other machines does not run. The
# same rights rules as for the checks; at most 50. Lines in the check format or "Name: value unit" (e.g.
# "Backup-Alter: 26 h") are sent with the report. WOMN_PLUGINS only for the tests.
if [ "$(id -u)" = 0 ]; then PLG=/etc/whatsonmynet/plugins; else PLG=${XDG_CONFIG_HOME:-$HOME/.config}/whatsonmynet/plugins; fi
PLG=${WOMN_PLUGINS:-$PLG}
ALLOW=$CACHE/plugins.txt
plj=""
pline() { plj="$plj${plj:+,}{\"file\":\"$(esc "$1")\",\"id\":${2:-null},\"version\":${3:-null},\"state\":\"$4\",\"text\":\"$(esc "$5")\"}"; }
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | awk '{print $1}'
  fi
}
if [ -d "$PLG" ]; then
  me=$(id -u)
  if [ -L "$PLG" ] || [ -z "$(find "$PLG" -maxdepth 0 \( -user "$me" -o -user 0 \) ! -perm -g+w ! -perm -o+w 2>/dev/null)" ]; then
    pline "" "" "" unsafe "folder $PLG may be changed by others - plugins not run"
  elif ! command -v timeout >/dev/null 2>&1; then
    pline "" "" "" error "the command timeout is missing - plugins not run"
  else
    tmpd=$(mktemp -d 2>/dev/null) || tmpd=""
    if [ -n "$tmpd" ]; then
      plstart=$(date +%s)
      find "$PLG" -maxdepth 1 -name '*.sh' -type f 2>/dev/null | sort | head -n 50 > "$tmpd/list"
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        base=${f##*/}
        hv=$(head -c 600 "$f" | sed -n 's/^# womn-plugin id=\([0-9][0-9]*\) version=\([0-9][0-9]*\).*/\1 \2/p' | head -n 1)
        if [ -z "$hv" ]; then pline "$base" "" "" noHeader "not a plugin of WhatsOnMyNet - not run"; continue; fi
        pid=${hv% *}; pver=${hv#* }
        if [ -L "$f" ] || [ -z "$(find "$f" -maxdepth 0 -type f \( -user "$me" -o -user 0 \) ! -perm -g+w ! -perm -o+w 2>/dev/null)" ]; then
          pline "$base" "$pid" "$pver" unsafe "owner or rights not safe - not run (owner must be root)"; continue
        fi
        a=""; [ -s "$ALLOW" ] && a=$(awk -v id="$pid" '{ for (i = 1; i <= NF; i++) { n = split($i, x, ":"); if (n == 5 && x[1] == id && length(x[3]) == 64 && x[3] ~ /^[0-9a-f]+$/ && x[4] ~ /^[0-9]+$/ && x[5] ~ /^[0-9]+$/) { print x[2], x[3], x[4], x[5]; exit } } }' "$ALLOW")
        if [ -z "$a" ]; then pline "$base" "$pid" "$pver" notAssigned "not meant for this machine (or switched off) - not run"; continue; fi
        read -r av asha at every <<EOA
$a
EOA
        fsha=$(sha256 "$f")
        if [ -z "$fsha" ]; then pline "$base" "$pid" "$pver" error "no sha256sum, shasum or openssl to check the file - not run"; continue; fi
        if [ "$fsha" != "$asha" ]; then
          if [ "$pver" -lt "$av" ]; then pline "$base" "$pid" "$pver" outdated "version $pver - WhatsOnMyNet has version $av: download it again"
          else pline "$base" "$pid" "$pver" changed "the file is not the one from WhatsOnMyNet - download it again"; fi
          continue
        fi
        # Not every run: a plugin that runs every 60 minutes gives its last output again in between (same file only)
        pc=$CACHE/plugin-$pid.out; nowt=$(date +%s); ago=""
        if [ -s "$pc" ] && [ "$every" -gt 5 ]; then
          hd=$(head -n 1 "$pc"); hts=${hd#* }
          case $hts in ''|*[!0-9]*) hts=0 ;; esac
          if [ "${hd% *}" = "$fsha" ] && [ $((nowt - hts)) -ge 0 ] && [ $((nowt - hts)) -lt $(( (every - 1) * 60 )) ]; then
            tail -n +2 "$pc" > "$tmpd/out"; rc=0; ago=$(( (nowt - hts) / 60 ))
          fi
        fi
        if [ -z "$ago" ]; then
          # at most 3 minutes for all plugins of a run, so the report still goes out every 5 minutes - the rest runs next time
          if [ $((nowt - plstart)) -gt 180 ]; then pline "$base" "$pid" "$pver" deferred "time budget of this run used up - runs next time"; continue; fi
          # an executable file starts with its own interpreter line, any other with sh; stdin from /dev/null
          if [ -x "$f" ]; then timeout "$at" "$f" < /dev/null > "$tmpd/out" 2>/dev/null; rc=$?
          else timeout "$at" sh "$f" < /dev/null > "$tmpd/out" 2>/dev/null; rc=$?; fi
          if [ "$rc" = 124 ]; then pline "$base" "$pid" "$pver" timeout "timeout ($at s)"; continue; fi
          if [ "$every" -gt 5 ]; then { printf '%s %s\n' "$fsha" "$nowt"; head -c 20000 "$tmpd/out"; } > "$pc"; fi
        fi
        parsed=$(head -c 20000 "$tmpd/out" | awk -v file="$base" -v plugin="$pid" '
          function esc(v) { gsub(/[\001-\037\177]/, " ", v); gsub(/\\/, "\\\\", v); gsub(/"/, "\\\"", v); return substr(v, 1, 300) }
          function out(name, st, text, val, unit) { printf "%s{\"name\":\"%s\",\"status\":%d,\"text\":\"%s\",\"value\":%s,\"file\":\"%s\",\"plugin\":%d,\"unit\":\"%s\"}", (n++ ? "," : ""), esc(name), st, esc(text), val, esc(file), plugin, esc(unit) }
          $1 ~ /^[0-3]$/ && NF >= 3 {
            val = "null"
            if ($3 != "-") { split($3, m, "|"); split(m[1], kv, "="); split(kv[2], v, ";"); if (v[1] ~ /^-?[0-9]+(\.[0-9]+)?$/) val = v[1] }
            text = ""; for (i = 4; i <= NF; i++) text = text (i > 4 ? " " : "") $i
            out($2, $1, text, val, ""); next
          }
          {
            i = index($0, ":"); if (i < 2 || i > 61) next
            nm = substr($0, 1, i - 1); rest = substr($0, i + 1)
            gsub(/^[ \t]+|[ \t]+$/, "", nm); gsub(/^[ \t]+|[ \t]+$/, "", rest)
            if (nm == "" || !match(rest, /^-?[0-9]+([.,][0-9]+)?/)) next
            num = substr(rest, 1, RLENGTH); unit = substr(rest, RLENGTH + 1); gsub(/^[ \t]+/, "", unit)
            if (unit ~ /[ \t]/ || unit ~ /^[0-9]/ || length(unit) > 12) next
            gsub(/,/, ".", num); gsub(/[ \t]+/, "_", nm)
            out(nm, 0, rest, num, unit)
          }')
        if [ -n "$parsed" ]; then
          cj="$cj${cj:+,}$parsed"
          nv=$(printf '%s' "$parsed" | grep -o '"name":' | wc -l | tr -d ' ')
          if [ -n "$ago" ]; then pline "$base" "$pid" "$pver" ok "$nv value(s), runs every $every min - last run $ago min ago"
          else pline "$base" "$pid" "$pver" ok "$nv value(s)"; fi
        else pline "$base" "$pid" "$pver" error "no line in a known format (exit code $rc)"; fi
      done < "$tmpd/list"
      rm -rf "$tmpd"
    fi
  fi
fi

macs=""
for a in /sys/class/net/*/address; do
  [ -r "$a" ] || continue
  case "$a" in */lo/address) continue ;; esac
  m=$(cat "$a"); [ "$m" = 00:00:00:00:00:00 ] && continue
  macs="$macs${macs:+,}\"$m\""
done
ips=$( (ip -o -4 addr show scope global 2>/dev/null || true) | awk '{split($4,a,"/"); printf "%s\"%s\"", (n++?",":""), a[1]}')
# Network cards (physical, wired: a device behind them, no Wi-Fi): state, speed, bytes and errors - read only when
# WhatsOnMyNet asked for them (its answer to the last report: the ports of this machine are watched there)
nj=""; nn=0
[ -f "$CACHE/nics" ] && for d in /sys/class/net/*; do
  [ -e "$d/device" ] || continue
  [ -e "$d/wireless" ] && continue
  [ "$nn" -lt 32 ] || break
  n=${d##*/}
  up=0; [ "$(cat "$d/operstate" 2>/dev/null)" = up ] && up=1
  sp=$(cat "$d/speed" 2>/dev/null); case "$sp" in ''|*[!0-9]*) sp=0 ;; esac
  rb=$(cat "$d/statistics/rx_bytes" 2>/dev/null); tb=$(cat "$d/statistics/tx_bytes" 2>/dev/null)
  re=$(cat "$d/statistics/rx_errors" 2>/dev/null); te=$(cat "$d/statistics/tx_errors" 2>/dev/null)
  nj="$nj${nj:+,}{\"name\":\"$(esc "$n")\",\"up\":$up,\"speed\":$sp,\"rxBytes\":$(num "$rb"),\"txBytes\":$(num "$tb"),\"rxErrors\":$(num "$re"),\"txErrors\":$(num "$te")}"
  nn=$((nn + 1))
done

# the last self-update (written by this script below: when, whether it worked, why not)
# (only a complete status file: a cut-off one would make every report invalid - and the next try never come)
suj=null; [ -s "$CACHE/update.json" ] && suj=$(head -c 600 "$CACHE/update.json") && case "$suj" in '{'*'}') ;; *) suj=null ;; esac
body="{\"hostname\":\"$(esc "$name")\",\"os\":\"$(esc "$os")\",\"cpu\":${cpu:-0},\"memTotalKb\":${memkb:-0},\"memAvailKb\":${availkb:-0},\"uptime\":${uptime:-0},\"disks\":[$dj],\"services\":[$sj],\"macs\":[$macs],\"ips\":[$ips],\"ups\":$uj,\"hw\":$hw,\"pdisks\":[$pj],\"updates\":$updj,\"firewall\":$fwj,\"events\":$ej,\"temps\":[$tj],\"checks\":[$cj],\"plugins\":[$plj],\"nics\":[$nj],\"selfUpdate\":$suj,\"zfs\":$zj,\"mdstat\":\"$(escn "$md")\",\"script\":\"$SCRIPT_VERSION\"}"
if [ -n "$PIN" ]; then TLS="-k --pinnedpubkey $PIN"; else TLS=""; fi
# The answer names the plugins this machine may run ("id:version:sha256:timeout …") - kept for the next run
# shellcheck disable=SC2086
if printf '%s' "$body" | curl -fsS --max-time 30 $TLS -H "Authorization: Bearer $TOKEN" -H 'X-WOMN-Request: 1' -H 'Content-Type: application/json' --data-binary @- "$URL" > "$CACHE/answer.json"; then
  if grep -q '"plugins":"' "$CACHE/answer.json" 2>/dev/null; then
    sed -n 's/.*"plugins":"\([0-9a-f: ]*\)".*/\1/p' "$CACHE/answer.json" | head -c 20000 > "$ALLOW"
  fi
  # … and whether it wants the network cards (only when their ports are watched there): read from the next run on
  if grep -q '"nics":true' "$CACHE/answer.json" 2>/dev/null; then : > "$CACHE/nics"; else rm -f "$CACHE/nics"; fi
  # … and a newer version of this script, when WhatsOnMyNet offers one ("update": "<version>:<sha256>")
  upd=$(sed -n 's/.*"update":"\([0-9]\{1,4\}\.[0-9]\{1,4\}\.[0-9]\{1,6\}\):\([0-9a-f]\{64\}\)".*/\1 \2/p' "$CACHE/answer.json" | head -n 1)
fi
rm -f "$CACHE/answer.json"

# Self-update: fetched from the same address with the same key and certificate pin, its fingerprint and version must
# match, the address, key and pin of this copy are put in, the result is checked (complete, parses) and the running
# copy is replaced by a rename (the running shell keeps reading the old file) - the next run is the new version; cron,
# key and settings stay. Only from cron (not during the setup) and only over HTTPS: over plain HTTP anyone on the way
# could name a fingerprint of their own. A failed try leaves the old copy and is repeated next time; the result goes
# with the next report.
if [ -n "${upd:-}" ] && [ "${1:-}" = --run ]; then
  nver=${upd% *}; nsha=${upd#* }; uok=false; umsg=""
  dl="$CACHE/update.download"; new="$DEST.new"
  rm -f "$dl" "$new"
  case "$URL" in https://*) ;; *) umsg="self-update only over https" ;; esac
  # only the copy cron runs is replaced (another one elsewhere would leave this one old for ever)
  [ -z "$umsg" ] && [ "$0" != "$DEST" ] && umsg="runs as $0, not as $DEST"
  [ -z "$umsg" ] && [ -z "$(sha256 "$0")" ] && umsg="no tool for SHA-256 (sha256sum, shasum or openssl)"
  # shellcheck disable=SC2086
  if [ -n "$umsg" ]; then :
  elif ! curl -fsS --max-time 60 --max-filesize 1048576 $TLS -H "Authorization: Bearer $TOKEN" -H 'X-WOMN-Request: 1' -o "$dl" "${URL%/push}/script" 2>/dev/null; then umsg="download failed"
  elif [ "$(sha256 "$dl")" != "$nsha" ]; then umsg="fingerprint does not match"
  elif ! grep -q "^SCRIPT_VERSION=$nver\$" "$dl"; then umsg="version does not match"
  else
    shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
    # the marks are put together here, so this block itself is not changed when the marks are filled in
    mk="@@WOMN"
    if ! (umask 077; U_MARKS="${mk}_URL@@ ${mk}_TOKEN@@ ${mk}_PIN@@" U_URL=$(shq "$URL") U_TOKEN=$(shq "$TOKEN") U_PIN=$(shq "$PIN") awk '
      BEGIN { n = split(ENVIRON["U_MARKS"], k, " "); v[1] = ENVIRON["U_URL"]; v[2] = ENVIRON["U_TOKEN"]; v[3] = ENVIRON["U_PIN"] }
      { line = $0; for (i = 1; i <= n; i++) { out = ""; while ((p = index(line, k[i])) > 0) { out = out substr(line, 1, p - 1) v[i]; line = substr(line, p + length(k[i])) } line = out line } print line }' "$dl" > "$new"); then umsg="could not write $new"
    # complete: as many lines as the download and its last line (a full disk cuts the file off - sh -n would pass it)
    elif [ "$(wc -l < "$new")" != "$(wc -l < "$dl")" ] || [ "$(tail -n 1 "$new")" != "$(tail -n 1 "$dl")" ]; then umsg="the new version was not written completely"
    elif grep -q "${mk}_" "$new"; then umsg="unknown mark in the new version"
    elif ! sh -n "$new" 2>/dev/null; then umsg="the new version does not parse"
    else chmod 700 "$new" && mv -f "$new" "$DEST" && uok=true || umsg="could not replace $DEST"; fi
  fi
  rm -f "$dl" "$new"
  printf '{"at":"%s","ok":%s,"version":"%s","message":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$uok" "$nver" "$(esc "$umsg")" > "$CACHE/update.json"
fi

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
