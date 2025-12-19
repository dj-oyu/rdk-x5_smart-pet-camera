# Makefile for D-Robotics camera daemon
#
# Usage:
#   make              - Build D-Robotics daemon
#   make clean        - Remove build artifacts
#   make test         - Build and run shared memory tests
#   make test-daemon  - Test reading from running daemon
#   make run          - Run daemon with auto-cleanup
#   make run-daemon   - Run daemon in background
#
# Requirements:
#   - D-Robotics SDK installed
#   - libcam.so, libvpf.so, libhbmem.so available
#   - IMX219 sensor configured

CC = gcc
CFLAGS = -Wall -Wextra -O2 -std=c11 -D_GNU_SOURCE
INCLUDES = -I/usr/include
LDFLAGS = -L/usr/hobot/lib -lrt -ljpeg -lpthread -lcam -lvpf -lhbmem

# Targets
TARGET = camera_daemon_drobotics
TEST_TARGET = test_shm
READER_TARGET = test_daemon_reader
SWITCH_TARGET = camera_switcher_demo
SWITCH_RUNTIME_LIB = libcamera_switcher_runtime.a
SWITCH_DAEMON_TARGET = camera_switcher_daemon

# Source files
SRC = camera_daemon_drobotics.c shared_memory.c
TEST_SRC = test_shm.c shared_memory.c
READER_SRC = test_daemon_reader.c shared_memory.c
SWITCH_SRC = camera_switcher_demo.c camera_switcher.c shared_memory.c
SWITCH_RUNTIME_SRC = camera_switcher_runtime.c camera_switcher.c shared_memory.c
SWITCH_DAEMON_SRC = camera_switcher_daemon.c camera_switcher_runtime.c camera_switcher.c shared_memory.c

# Object files
OBJ = $(SRC:.c=.o)
TEST_OBJ = $(TEST_SRC:.c=.o)
READER_OBJ = $(READER_SRC:.c=.o)
SWITCH_OBJ = $(SWITCH_SRC:.c=.o)
SWITCH_RUNTIME_OBJ = $(SWITCH_RUNTIME_SRC:.c=.o)
SWITCH_DAEMON_OBJ = $(SWITCH_DAEMON_SRC:.c=.o)

# Build directory
BUILD_DIR = ../../build
LDFLAGS_BASIC = -lrt -ljpeg

.PHONY: all clean test install help check-sdk kill-processes cleanup test-daemon test-daemon-py

all: $(BUILD_DIR)/$(TARGET)

# Kill existing camera processes
kill-processes:
	@echo "[Cleanup] Checking for existing camera processes..."
	@-pkill -9 -f camera_daemon_drobotics 2>/dev/null && echo "[Cleanup] Killed camera_daemon_drobotics" || true
	@-pkill -9 -f cam-service 2>/dev/null && echo "[Cleanup] Killed cam-service" || true
	@sleep 1
	@echo "[Cleanup] Process cleanup complete"

# Clean up shared memory segments
cleanup: kill-processes
	@echo "[Cleanup] Removing shared memory segments..."
	@-rm -f /dev/shm/pet_camera_frames 2>/dev/null && echo "[Cleanup] Removed /dev/shm/pet_camera_frames" || true
	@-rm -f /dev/shm/pet_camera_detections 2>/dev/null && echo "[Cleanup] Removed /dev/shm/pet_camera_detections" || true
	@echo "[Cleanup] Shared memory cleanup complete"

$(BUILD_DIR)/$(TARGET): $(OBJ)
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $^ $(LDFLAGS)
	@echo "[Build] D-Robotics camera daemon built: $@"
	@echo ""
	@echo "Next steps:"
	@echo "  1. Run daemon: make run-daemon"
	@echo "  2. In another terminal: make test-daemon"
	@echo "  3. Or test with Python: python3 test_daemon_python.py"

$(BUILD_DIR)/$(TEST_TARGET): $(TEST_OBJ)
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $^ $(LDFLAGS)
	@echo "[Build] Test program built: $@"

$(BUILD_DIR)/$(READER_TARGET): $(READER_OBJ)
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $^ $(LDFLAGS)
	@echo "[Build] Daemon reader built: $@"

$(BUILD_DIR)/$(SWITCH_TARGET): $(SWITCH_OBJ)
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $^ $(LDFLAGS_BASIC)
	@echo "[Build] Camera switcher demo built: $@"

$(BUILD_DIR)/$(SWITCH_DAEMON_TARGET): $(SWITCH_DAEMON_OBJ)
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $^ $(LDFLAGS_BASIC) -lpthread
	@echo "[Build] Camera switcher orchestration daemon built: $@"

$(BUILD_DIR)/$(SWITCH_RUNTIME_LIB): $(SWITCH_RUNTIME_OBJ)
	@mkdir -p $(BUILD_DIR)
	ar rcs $@ $^
	@echo "[Build] Camera switcher runtime static library built: $@"

%.o: %.c shared_memory.h
	$(CC) $(CFLAGS) $(INCLUDES) -c -o $@ $<

test: $(BUILD_DIR)/$(TEST_TARGET)
	@echo "[Test] Running shared memory test..."
	@$(BUILD_DIR)/$(TEST_TARGET)

test-daemon: $(BUILD_DIR)/$(READER_TARGET)
	@echo "[Test] Reading frames from camera daemon..."
	@echo "[Test] Make sure daemon is running: make run-daemon"
	@$(BUILD_DIR)/$(READER_TARGET) -n 100 -v

test-daemon-py:
	@echo "[Test] Reading frames from camera daemon (Python)..."
	@echo "[Test] Make sure daemon is running: make run-daemon"
	@cd ../.. && PYTHONPATH=src:src/capture uv run src/capture/test_daemon_python.py -n 100 -v

switcher-demo: $(BUILD_DIR)/$(SWITCH_TARGET)
	@echo "[Run] Starting interactive switcher demo..."
	@$(BUILD_DIR)/$(SWITCH_TARGET)

switcher-runtime-lib: $(BUILD_DIR)/$(SWITCH_RUNTIME_LIB)
	@echo "[Info] Static library ready. Link with -lpthread -ljpeg when embedding in a daemon."

switcher-daemon: $(BUILD_DIR)/$(SWITCH_DAEMON_TARGET)
	@echo "[Run] Starting camera switcher orchestration daemon..."
	@$(BUILD_DIR)/$(SWITCH_DAEMON_TARGET)

# Run daemon with automatic cleanup
run: cleanup $(BUILD_DIR)/$(TARGET)
	@echo "[Run] Starting camera daemon (Camera 0, 640x480@30fps)..."
	@echo "[Run] Press Ctrl+C to stop"
	@$(BUILD_DIR)/$(TARGET) -C 0 -P 1

# Run daemon in daemon mode
run-daemon: cleanup $(BUILD_DIR)/$(TARGET)
	@echo "[Run] Starting camera daemon in background mode..."
	@$(BUILD_DIR)/$(TARGET) -C 0 -P 1 --daemon &
	@echo "[Run] Daemon started (PID: $$!)"
	@echo "[Run] Use 'make kill-processes' to stop"

clean: kill-processes
	rm -f $(OBJ) $(TEST_OBJ) $(READER_OBJ)
	rm -f $(BUILD_DIR)/$(TARGET) $(BUILD_DIR)/$(TEST_TARGET) $(BUILD_DIR)/$(READER_TARGET)
	@echo "[Clean] Build artifacts removed"

install: $(BUILD_DIR)/$(TARGET)
	install -m 755 $(BUILD_DIR)/$(TARGET) /usr/local/bin/
	@echo "[Install] Camera daemon installed to /usr/local/bin/"
	@echo ""
	@echo "To run as systemd service:"
	@echo "  sudo cp ../../systemd/smart-pet-camera-capture.service /etc/systemd/system/"
	@echo "  sudo systemctl daemon-reload"
	@echo "  sudo systemctl start smart-pet-camera-capture"

# Check D-Robotics SDK
check-sdk:
	@echo "[Check] Verifying D-Robotics SDK..."
	@if [ ! -f /usr/lib/libcam.so ]; then \
		echo "[Error] libcam.so not found"; \
		echo "Please install D-Robotics SDK"; \
		exit 1; \
	fi
	@if [ ! -f /usr/lib/libvpf.so ]; then \
		echo "[Error] libvpf.so not found"; \
		exit 1; \
	fi
	@if [ ! -f /usr/lib/libhbmem.so ]; then \
		echo "[Error] libhbmem.so not found"; \
		exit 1; \
	fi
	@echo "[OK] D-Robotics SDK libraries found"

# Help target
help:
	@echo "Smart Pet Camera - D-Robotics Camera Daemon Build"
	@echo ""
	@echo "Targets:"
	@echo "  make                Build D-Robotics daemon"
	@echo "  make test           Build and run shared memory tests"
	@echo "  make test-daemon    Test reading from running daemon (C)"
	@echo "  make test-daemon-py Test reading from running daemon (Python with uv)"
	@echo "  make switcher-demo  Build and run the brightness-based camera switcher demo (C only)"
	@echo "  make run            Run daemon with auto-cleanup"
	@echo "  make run-daemon     Run daemon in background"
	@echo "  make cleanup        Kill processes and clean shared memory"
	@echo "  make kill-processes Kill camera processes"
	@echo "  make clean          Remove build artifacts"
	@echo "  make install        Install to /usr/local/bin"
	@echo "  make check-sdk      Verify D-Robotics SDK"
	@echo "  make help           Show this help message"
	@echo ""
	@echo "Dependencies:"
	@echo "  - D-Robotics SDK (libcam.so, libvpf.so, libhbmem.so)"
	@echo "  - libjpeg-dev"
	@echo "  - librt (POSIX shared memory)"
	@echo ""
	@echo "Usage examples:"
	@echo "  # Build and run with automatic cleanup"
	@echo "  make run"
	@echo ""
	@echo "  # Run in background (daemon mode)"
	@echo "  make run-daemon"
	@echo ""
	@echo "  # Test daemon in another terminal"
	@echo "  make test-daemon"
	@echo ""
	@echo "  # Clean up stuck processes and shared memory"
	@echo "  make cleanup"
	@echo ""
	@echo "  # Manual execution"
	@echo "  ./build/camera_daemon_drobotics -C 0 -P 1"
	@echo ""
	@echo "  # Stop running daemon"
	@echo "  make kill-processes"
