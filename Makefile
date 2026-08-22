# Makefile for Smart Pet Camera

WEB_SRC_DIR = src/web
WEB_BUILD_DIR = build/web

.PHONY: all capture web check-shm clean help

all: capture web

capture:
	$(MAKE) -C src/capture

web:
	@if command -v bun >/dev/null 2>&1; then \
		$(WEB_SRC_DIR)/build.sh; \
	else echo "bun not found. Skipping web assets build."; fi

# Guard the SHM single source of truth. src/capture/shm_constants.h is
# authoritative; Python ctypes bindings and Go defaults carry copies that
# nothing else verifies. Run this before touching SHM layout.
#
# Two checks: check_shm_constants.py guards scalar constants and SHM names
# across C/Python/Go; check_shm_layout.py guards struct *layout*
# (offsetof/sizeof) between src/capture/shared_memory.h and the ctypes
# mirrors in src/capture/real_shared_memory.py (Go needs no such check --
# it includes shared_memory.h directly via cgo).
check-shm:
	@python3 scripts/check_shm_constants.py
	@python3 scripts/check_shm_layout.py

clean:
	$(MAKE) -C src/capture clean
	rm -rf $(WEB_BUILD_DIR)

help:
	@echo "Targets: all, capture, web, check-shm, clean, help"
