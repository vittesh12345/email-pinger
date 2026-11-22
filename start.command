#!/bin/sh
# Double-click this file on a Mac to start Pinger.
cd "$(dirname "$0")" || exit 1
./start.sh "$@" || {
  echo
  echo "Pinger stopped. Press Return to close this window."
  read -r _
}
