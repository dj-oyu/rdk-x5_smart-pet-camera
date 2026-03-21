# Makefile for Smart Pet Camera

WEB_SRC_DIR = src/web
WEB_BUILD_DIR = build/web

.PHONY: all capture web clean help

all: capture web

capture:
	$(MAKE) -C src/capture

web:
	@if command -v bun >/dev/null 2>&1; then \
		$(WEB_SRC_DIR)/build.sh; \
	else echo "bun not found. Skipping web assets build."; fi

clean:
	$(MAKE) -C src/capture clean
	rm -rf $(WEB_BUILD_DIR)

help:
	@echo "Targets: all, capture, web, clean, help"
