#!/bin/sh
set -eu

storage_root=/app/solix_web_dashboard/src/dashboard/exports/timeseries

mkdir -p "$storage_root"
chown -R appuser:appuser "$storage_root"

exec gosu appuser "$@"