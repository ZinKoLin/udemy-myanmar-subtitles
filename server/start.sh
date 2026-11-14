#!/bin/sh
set -eu
test "${#VNC_PASSWORD}" -ge 8 || { echo 'Set VNC_PASSWORD (8 characters or more).'; exit 1; }
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
xdisplay=$!
trap 'kill "$xdisplay" 2>/dev/null || true' EXIT INT TERM
sleep 1
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/udemy-vnc.pass >/dev/null
x11vnc -display :99 -localhost -rfbport 5900 -rfbauth /tmp/udemy-vnc.pass -forever -shared >/tmp/vnc.log 2>&1 &
websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 >/tmp/novnc.log 2>&1 &
exec node /app/server/main.mjs
