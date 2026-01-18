# Makefile for Smart Pet Camera - C components

# Compiler and flags
CC = gcc
CFLAGS = -Wall -Wextra -O2 -std=c11 -D_POSIX_C_SOURCE=200809L
LDFLAGS = -lv4l2 -ljpeg -lzmq -lpthread
DEBUG_FLAGS = -g -DDEBUG -O0

# Directories
SRC_DIR = src/capture
BUILD_DIR = build
BIN_DIR = bin
WEB_SRC_DIR = src/monitor/web_assets
WEB_BUILD_DIR = $(BUILD_DIR)/web
ESBUILD_LOCAL = ./node_modules/.bin/esbuild

# Source files
SOURCES = $(wildcard $(SRC_DIR)/*.c)
OBJECTS = $(SOURCES:$(SRC_DIR)/%.c=$(BUILD_DIR)/%.o)
TARGET = $(BIN_DIR)/capture_main

# Phony targets
.PHONY: all clean debug install test help web

# Default target
all: $(TARGET) web

# Create directories
$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

# Build object files
$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

# Build executable
$(TARGET): $(OBJECTS) | $(BIN_DIR)
	$(CC) $(OBJECTS) $(LDFLAGS) -o $@
	@echo "Build complete: $(TARGET)"

# Build web assets (optional)
web:
	@mkdir -p $(WEB_BUILD_DIR)
	@ESBUILD=""; \
	if command -v esbuild >/dev/null 2>&1; then ESBUILD="esbuild"; \
	elif [ -x "$(ESBUILD_LOCAL)" ]; then ESBUILD="$(ESBUILD_LOCAL)"; \
	else echo "esbuild not found. Skipping web assets build."; exit 0; fi; \
	$$ESBUILD $(WEB_SRC_DIR)/monitor.js --bundle --outfile=$(WEB_BUILD_DIR)/monitor.js --minify --log-level=warning; \
	$$ESBUILD $(WEB_SRC_DIR)/monitor.css --outfile=$(WEB_BUILD_DIR)/monitor.css --minify --log-level=warning

# Debug build
debug: CFLAGS += $(DEBUG_FLAGS)
debug: clean all
	@echo "Debug build complete"

# Clean build artifacts
clean:
	rm -rf $(BUILD_DIR) $(BIN_DIR)
	@echo "Clean complete"

# Install (copy to system location)
install: all
	sudo cp $(TARGET) /usr/local/bin/
	sudo chmod +x /usr/local/bin/capture_main
	@echo "Installation complete"

# Run tests
test:
	@echo "Running C tests..."
	# TODO: Implement C unit tests
	@echo "Tests not yet implemented"

# Help
help:
	@echo "Smart Pet Camera - Makefile"
	@echo ""
	@echo "Available targets:"
	@echo "  all      - Build the project (default)"
	@echo "  debug    - Build with debug symbols"
	@echo "  clean    - Remove build artifacts"
	@echo "  install  - Install to /usr/local/bin"
	@echo "  test     - Run tests"
	@echo "  help     - Show this help message"
	@echo ""
	@echo "Usage examples:"
	@echo "  make           # Build in release mode"
	@echo "  make debug     # Build in debug mode"
	@echo "  make clean all # Clean and rebuild"
