CC := gcc
CFLAGS := -Wall -Wextra -O2 -std=c11
CPPFLAGS := -D_GNU_SOURCE -I/usr/include

BUILD_DIR := ../../build

LDFLAGS := -L/usr/hobot/lib

DAEMON_SOURCES := camera_daemon_drobotics.c shared_memory.c
SHM_TEST_SOURCES := test_shm.c shared_memory.c
SWITCHER_DEMO_SOURCES := camera_switcher_demo.c camera_switcher.c shared_memory.c
SWITCHER_RUNTIME_SOURCES := camera_switcher_runtime.c camera_switcher.c shared_memory.c
SWITCHER_DAEMON_SOURCES := camera_switcher_daemon.c camera_switcher_runtime.c camera_switcher.c shared_memory.c

DAEMON_OBJECTS := $(DAEMON_SOURCES:.c=.o)
SHM_TEST_OBJECTS := $(SHM_TEST_SOURCES:.c=.o)
SWITCHER_DEMO_OBJECTS := $(SWITCHER_DEMO_SOURCES:.c=.o)
SWITCHER_RUNTIME_OBJECTS := $(SWITCHER_RUNTIME_SOURCES:.c=.o)
SWITCHER_DAEMON_OBJECTS := $(SWITCHER_DAEMON_SOURCES:.c=.o)

DAEMON_BINARY := $(BUILD_DIR)/camera_daemon_drobotics
SHM_TEST_BINARY := $(BUILD_DIR)/test_shm
SWITCHER_DEMO_BINARY := $(BUILD_DIR)/camera_switcher_demo
SWITCHER_RUNTIME_LIBRARY := $(BUILD_DIR)/libcamera_switcher_runtime.a
SWITCHER_DAEMON_BINARY := $(BUILD_DIR)/camera_switcher_daemon

LDLIBS_COMMON := -lrt -ljpeg
LDLIBS_DROBOTICS := $(LDLIBS_COMMON) -lpthread -lcam -lvpf -lhbmem
LDLIBS_SWITCHER_DEMO := $(LDLIBS_COMMON)
LDLIBS_SWITCHER_DAEMON := $(LDLIBS_COMMON) -lpthread

DAEMON_ARGS ?= -C 0 -P 1

.PHONY: all clean test switcher-demo switcher-runtime-lib switcher-daemon switcher-daemon-build run run-daemon cleanup kill-processes help

all: $(DAEMON_BINARY) $(SHM_TEST_BINARY)

$(BUILD_DIR):
	@mkdir -p $@

$(DAEMON_BINARY): $(DAEMON_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_DROBOTICS)

$(SHM_TEST_BINARY): $(SHM_TEST_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_DROBOTICS)

$(SWITCHER_DEMO_BINARY): $(SWITCHER_DEMO_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_SWITCHER_DEMO)

$(SWITCHER_RUNTIME_LIBRARY): $(SWITCHER_RUNTIME_OBJECTS) | $(BUILD_DIR)
	ar rcs $@ $^

$(SWITCHER_DAEMON_BINARY): $(SWITCHER_DAEMON_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_SWITCHER_DAEMON)

%.o: %.c
	$(CC) $(CFLAGS) $(CPPFLAGS) -c -o $@ $<

test: $(SHM_TEST_BINARY)
	@echo "[Test] Running shared memory test..."
	@$(SHM_TEST_BINARY)

switcher-demo: $(SWITCHER_DEMO_BINARY)
	@echo "[Run] Starting interactive switcher demo..."
	@$(SWITCHER_DEMO_BINARY)

switcher-runtime-lib: $(SWITCHER_RUNTIME_LIBRARY)
	@echo "[Info] Static library ready. Link with -lpthread -ljpeg when embedding in a daemon."

switcher-daemon-build: $(SWITCHER_DAEMON_BINARY)
	@echo "[Build] camera_switcher_daemon ready at $(SWITCHER_DAEMON_BINARY)"

switcher-daemon: cleanup
	@echo "[Build] Rebuilding camera_daemon_drobotics and camera_switcher_daemon..."
	@rm -f $(DAEMON_OBJECTS) $(SWITCHER_DAEMON_OBJECTS)
	@$(MAKE) $(SWITCHER_DAEMON_BINARY) $(DAEMON_BINARY)
	@echo "[Run] Starting camera switcher orchestration daemon..."
	@$(SWITCHER_DAEMON_BINARY)

run: cleanup $(DAEMON_BINARY)
	@echo "[Run] Starting camera daemon (foreground): $(DAEMON_BINARY) $(DAEMON_ARGS)"
	@echo "[Run] Press Ctrl+C to stop"
	@$(DAEMON_BINARY) $(DAEMON_ARGS)

run-daemon: cleanup $(DAEMON_BINARY)
	@echo "[Run] Starting camera daemon in background: $(DAEMON_BINARY) $(DAEMON_ARGS) --daemon"
	@$(DAEMON_BINARY) $(DAEMON_ARGS) --daemon &
	@echo "[Run] Daemon started (PID: $$!)"
	@echo "[Run] Use 'make kill-processes' to stop"

cleanup: kill-processes clean
	@echo "[Cleanup] Removing shared memory segments..."
	@-rm -f /dev/shm/pet_camera_frames 2>/dev/null && echo "[Cleanup] Removed /dev/shm/pet_camera_frames" || true
	@-rm -f /dev/shm/pet_camera_frames_day 2>/dev/null && echo "[Cleanup] Removed /dev/shm/pet_camera_frames_day" || true
	@-rm -f /dev/shm/pet_camera_frames_night 2>/dev/null && echo "[Cleanup] Removed /dev/shm/pet_camera_frames_night" || true
	@-rm -f /dev/shm/pet_camera_frames_probe 2>/dev/null && echo "[Cleanup] Removed /dev/shm/pet_camera_frames_probe" || true
	@-rm -f /dev/shm/pet_camera_detections 2>/dev/null && echo "[Cleanup] Removed /dev/shm/pet_camera_detections" || true
	@echo "[Cleanup] Shared memory cleanup complete"

kill-processes:
	@echo "[Cleanup] Checking for existing camera processes..."
	@-pkill -9 -f camera_switcher_daemon 2>/dev/null && echo "[Cleanup] Killed camera_switcher_daemon" || true
	@-pkill -9 -f camera_daemon_drobotics 2>/dev/null && echo "[Cleanup] Killed camera_daemon_drobotics" || true
	@-pkill -9 -f cam-service 2>/dev/null && echo "[Cleanup] Killed cam-service" || true
	@sleep 1
	@echo "[Cleanup] Process cleanup complete"

clean:
	@echo "[Clean] Removing built binaries and objects"
	@rm -f $(DAEMON_OBJECTS) $(SHM_TEST_OBJECTS) $(SWITCHER_DEMO_OBJECTS) $(SWITCHER_RUNTIME_OBJECTS) $(SWITCHER_DAEMON_OBJECTS)
	@rm -f $(DAEMON_BINARY) $(SHM_TEST_BINARY) $(SWITCHER_DEMO_BINARY) $(SWITCHER_RUNTIME_LIBRARY) $(SWITCHER_DAEMON_BINARY)

help:
	@echo "Camera daemon build targets"
	@echo "  make (default)       Build camera_daemon_drobotics and shared memory test binary"
	@echo "  make test            Run shared memory tests"
	@echo "  make switcher-demo   Build and run the brightness-based camera switcher demo"
	@echo "  make switcher-daemon-build  Build the camera switcher orchestration daemon only"
	@echo "  make switcher-daemon Build and run the camera switcher orchestration daemon"
	@echo "  make switcher-runtime-lib Build libcamera_switcher_runtime.a"
	@echo "  make run             Run camera_daemon_drobotics in the foreground (cleans stale processes and shm first)"
	@echo "  make run-daemon      Run camera_daemon_drobotics in the background (cleans stale processes and shm first)"
	@echo "  make cleanup         Remove camera processes and shared memory segments"
	@echo "  make kill-processes  Kill running camera_daemon_drobotics and cam-service processes"
	@echo "  make clean           Remove built binaries and object files"
