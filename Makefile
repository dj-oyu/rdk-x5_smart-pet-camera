# Makefile for Smart Pet Camera - C components

# Compiler and flags
CC = gcc
CFLAGS = -Wall -Wextra -O2 -std=c11
LDFLAGS = -lv4l2 -ljpeg -lzmq -lpthread
DEBUG_FLAGS = -g -DDEBUG -O0

# Directories
SRC_DIR = src/capture
BUILD_DIR = build
BIN_DIR = bin

# Source files
SOURCES = $(wildcard $(SRC_DIR)/*.c)
OBJECTS = $(SOURCES:$(SRC_DIR)/%.c=$(BUILD_DIR)/%.o)
TARGET = $(BIN_DIR)/capture_main

# Phony targets
.PHONY: all clean debug install test help

# Default target
all: $(TARGET)

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
