#!/usr/bin/env bash
set -euo pipefail

# Renew the Tailscale (Let's Encrypt) TLS cert used by pet-camera-monitor, and
# restart the service only when the cert actually changed.
#
# Why this exists:
#   web_monitor reads its TLS cert ONCE at startup (-tls-cert / -tls-key flags in
#   deploy/rdk-x5/pet-camera-monitor.service) and never reloads it. A renewed cert
#   on disk is only served after a restart. Tailscale certs are valid 90 days, so
#   without automation the cert silently expires and browsers refuse to connect.
#
#   This happened: the cert issued 2026-04-15 expired 2026-07-14 and went
#   unnoticed for 40 days, until an iPhone could no longer open the monitor.
#   pet-album already had this automation (#217); the camera side did not.
#
# Intended to run as root from pet-camera-cert-renew.timer (weekly). `tailscale
# cert` only re-issues when the existing cert is inside its renewal window, so
# running weekly is cheap and idempotent.

# Cert/key paths come from the (gitignored) .env via systemd EnvironmentFile.
# The Tailscale domain is derived from the cert filename so no device-specific
# hostname is hardcoded here; override with CAMERA_CERT_DOMAIN if needed.
CERT="${PET_CAMERA_TLS_CERT:?PET_CAMERA_TLS_CERT not set (see /opt/smart-pet-camera/.env)}"
KEY="${PET_CAMERA_TLS_KEY:?PET_CAMERA_TLS_KEY not set (see /opt/smart-pet-camera/.env)}"
DOMAIN="${CAMERA_CERT_DOMAIN:-$(basename "${CERT}" .crt)}"

before=""
if [[ -f "${CERT}" ]]; then
  before="$(sha256sum "${CERT}" | cut -d' ' -f1)"
fi

echo "[renew-camera-cert] requesting cert for ${DOMAIN}"
tailscale cert --cert-file "${CERT}" --key-file "${KEY}" "${DOMAIN}"

after="$(sha256sum "${CERT}" | cut -d' ' -f1)"

if [[ "${before}" != "${after}" ]]; then
  # Restart the monitor only. pet-camera-capture is PartOf-linked to the other
  # three services, so restarting it here would take the whole camera down for a
  # cert change it does not even read.
  echo "[renew-camera-cert] cert changed -> restarting pet-camera-monitor.service"
  systemctl restart pet-camera-monitor.service
else
  echo "[renew-camera-cert] cert unchanged -> no restart needed"
fi

# Surface the resulting validity window for the journal.
openssl x509 -in "${CERT}" -noout -subject -dates 2>/dev/null || true
