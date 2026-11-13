#!/bin/sh
# WhatsOnMyNet - removes the host script again: cron entry and script file. Run as the user that set it up (root for
# /usr/local/sbin). Nothing else was installed, so the machine is as before afterwards.
for f in @FILES@; do
  rm -f "/usr/local/sbin/$f" "$HOME/.local/bin/$f"
  if crontab -l 2>/dev/null | grep -q "$f"; then crontab -l 2>/dev/null | grep -v "$f" | crontab -; fi
done
for c in @CRONS@; do [ -f "/etc/cron.d/$c" ] && rm -f "/etc/cron.d/$c"; done
echo "WhatsOnMyNet: removed"
