#!/usr/bin/env bash
set -euo pipefail

# Renew the Tailscale (Let's Encrypt) TLS cert used by pet-album, and restart
# the service only when the cert actually changed.
#
# Why this exists:
#   pet-album loads its TLS cert ONCE at startup (RustlsConfig::from_pem_file in
#   src/ai-pyramid/src/main.rs) and never reloads it. A renewed cert on disk is
#   only served after a restart. Tailscale certs are valid 90 days, so without
#   automation the cert silently expires and browsers show NET::ERR_CERT_DATE_INVALID
#   (and the album iframe embedded in the rdk-x5 SPA stops loading).
#
# Intended to run as root from pet-album-cert-renew.timer (weekly). `tailscale
# cert` only re-issues when the existing cert is inside its renewal window, so
# running weekly is cheap and idempotent.

# Cert/key paths come from the (gitignored) .env via systemd EnvironmentFile.
# The Tailscale domain is derived from the cert filename so no device-specific
# hostname is hardcoded here; override with ALBUM_CERT_DOMAIN if needed.
CERT="${PET_ALBUM_TLS_CERT:?PET_ALBUM_TLS_CERT not set (see /opt/smart-pet-camera/.env)}"
KEY="${PET_ALBUM_TLS_KEY:?PET_ALBUM_TLS_KEY not set (see /opt/smart-pet-camera/.env)}"
DOMAIN="${ALBUM_CERT_DOMAIN:-$(basename "${CERT}" .crt)}"

before=""
if [[ -f "${CERT}" ]]; then
  before="$(sha256sum "${CERT}" | cut -d' ' -f1)"
fi

echo "[renew-album-cert] requesting cert for ${DOMAIN}"
tailscale cert --cert-file "${CERT}" --key-file "${KEY}" "${DOMAIN}"

after="$(sha256sum "${CERT}" | cut -d' ' -f1)"

if [[ "${before}" != "${after}" ]]; then
  echo "[renew-album-cert] cert changed -> restarting pet-album.service"
  systemctl restart pet-album.service
else
  echo "[renew-album-cert] cert unchanged -> no restart needed"
fi

# Surface the resulting validity window for the journal.
openssl x509 -in "${CERT}" -noout -subject -dates 2>/dev/null || true
