#!/bin/sh
# WhatsOnMyNet - KVM/libvirt host report (read only). Sends host load, storage pools and VMs every 5 minutes.
# Uses "virsh -r" (read-only connection) and /proc - changes nothing. Needs: virsh, awk, curl.
# Run it once (sh womn-libvirt.sh): it sets itself up in cron. Removing: womn-libvirt-uninstall.sh.
URL=@URL@
TOKEN=@TOKEN@
PIN=@PIN@
export LC_ALL=C
@SETUP@
VIRSH="virsh -r -c qemu:///system"

esc() { printf '%s' "$1" | awk 'BEGIN{ORS=""} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/," "); if (NR>1) print " "; print}'; }

name=$(hostname)
s1=$(grep '^cpu ' /proc/stat)
dom1=$($VIRSH domstats --cpu-total 2>/dev/null | awk -F= '/^Domain:/{d=$0; sub(/^Domain: /,"",d); gsub(/'"'"'/,"",d)} /cpu.time=/{print d"\t"$2}')
sleep 2
s2=$(grep '^cpu ' /proc/stat)
dom2=$($VIRSH domstats --cpu-total 2>/dev/null | awk -F= '/^Domain:/{d=$0; sub(/^Domain: /,"",d); gsub(/'"'"'/,"",d)} /cpu.time=/{print d"\t"$2}')
# Busy share of all CPUs between the two readings (only small numbers leave awk - no exponent format)
cpu=$(printf '%s\n%s\n' "$s1" "$s2" | awk '{t=0; for (i=2; i<=9 && i<=NF; i++) t+=$i; idle=$5+$6; if (NR==1) {t1=t; i1=idle} else {dt=t-t1; di=idle-i1; printf "%d", (dt>0 ? 100*(dt-di)/dt : 0)}}')
ncpu=$(grep -c '^processor' /proc/cpuinfo)
memkb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
availkb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
memtotal=$((memkb * 1024))
memused=$(((memkb - availkb) * 1024))
uptime=$(awk '{printf "%d", $1}' /proc/uptime)

guests=""
for d in $($VIRSH list --all --uuid); do
  dn=$($VIRSH domname "$d")
  case "$($VIRSH domstate "$d")" in running*) st=running ;; paused*) st=paused ;; shut*|crashed*) st=stopped ;; *) st=unknown ;; esac
  t1=$(printf '%s\n' "$dom1" | awk -F'\t' -v n="$dn" '$1==n{print $2}')
  t2=$(printf '%s\n' "$dom2" | awk -F'\t' -v n="$dn" '$1==n{print $2}')
  c=null; [ -n "$t1" ] && [ -n "$t2" ] && c=$(awk -v a="$t1" -v b="$t2" -v n="$ncpu" 'BEGIN{printf "%d", (b-a)/(2e9*n)*100}')
  m=$($VIRSH dommemstat "$d" 2>/dev/null | awk '/^actual /{a=$2} /^available /{v=$2} /^unused /{u=$2} END{if (v>0 && u!="") printf "%d", 100*(v-u)/v; else print "null"}')
  [ "$st" = running ] || { c=null; m=null; }
  guests="$guests${guests:+,}{\"vmid\":\"$d\",\"name\":\"$(esc "$dn")\",\"node\":\"$(esc "$name")\",\"status\":\"$st\",\"cpu\":$c,\"mem\":${m:-null}}"
done

storages=""
for p in $($VIRSH pool-list --name); do
  # shellcheck disable=SC2046
  set -- $($VIRSH pool-info "$p" --bytes 2>/dev/null | awk '/^Capacity:/{c=$2} /^Allocation:/{a=$2} END{print (c=="" ? 0 : c), (a=="" ? 0 : a)}')
  [ "${1:-0}" -gt 0 ] 2>/dev/null || continue
  storages="$storages${storages:+,}{\"name\":\"$(esc "$p")\",\"node\":\"$(esc "$name")\",\"used\":$2,\"total\":$1}"
done

body="{\"nodes\":[{\"name\":\"$(esc "$name")\",\"online\":true,\"cpu\":${cpu:-0},\"memUsed\":$memused,\"memTotal\":$memtotal,\"uptime\":$uptime}],\"guests\":[$guests],\"storages\":[$storages]}"
if [ -n "$PIN" ]; then TLS="-k --pinnedpubkey $PIN"; else TLS=""; fi
# shellcheck disable=SC2086
printf '%s' "$body" | curl -fsS --max-time 30 $TLS -H "Authorization: Bearer $TOKEN" -H 'X-WOMN-Request: 1' -H 'Content-Type: application/json' --data-binary @- "$URL" >/dev/null
