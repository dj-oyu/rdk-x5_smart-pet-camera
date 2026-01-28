CC := gcc
CFLAGS := -Wall -Wextra -O2 -std=c11
CPPFLAGS := -D_GNU_SOURCE -I/usr/include

BUILD_DIR := ../../build
BUILD_DIR_ABS := $(abspath $(BUILD_DIR))

LDFLAGS := -L/usr/hobot/lib

DAEMON_SOURCES := camera_daemon_main.c camera_pipeline.c vio_lowlevel.c encoder_lowlevel.c encoder_thread.c shared_memory.c isp_brightness.c logger.c
SHM_TEST_SOURCES := test_shm.c shared_memory.c logger.c
FPS_READER_SOURCES := test_fps_reader.c shared_memory.c logger.c
SWITCHER_DEMO_SOURCES := camera_switcher_demo.c camera_switcher.c shared_memory.c logger.c
SWITCHER_DAEMON_SOURCES := camera_switcher_daemon.c camera_switcher.c shared_memory.c logger.c
POC_LOWLEVEL_SOURCES := camera_poc_lowlevel.c shared_memory.c logger.c
POC_VSE_DUAL_SOURCES := camera_poc_vse_dual.c shared_memory.c logger.c
ISP_LOWLIGHT_SOURCES := test_isp_lowlight.c logger.c
HB_MEM_IMPORT_SOURCES := test_hb_mem_import.c shared_memory.c logger.c
HAL_SOURCES := vio_lowlevel.c encoder_lowlevel.c logger.c

DAEMON_OBJECTS := $(DAEMON_SOURCES:.c=.o)
SHM_TEST_OBJECTS := $(SHM_TEST_SOURCES:.c=.o)
FPS_READER_OBJECTS := $(FPS_READER_SOURCES:.c=.o)
SWITCHER_DEMO_OBJECTS := $(SWITCHER_DEMO_SOURCES:.c=.o)
SWITCHER_DAEMON_OBJECTS := $(SWITCHER_DAEMON_SOURCES:.c=.o)
POC_LOWLEVEL_OBJECTS := $(POC_LOWLEVEL_SOURCES:.c=.o)
POC_VSE_DUAL_OBJECTS := $(POC_VSE_DUAL_SOURCES:.c=.o)
ISP_LOWLIGHT_OBJECTS := $(ISP_LOWLIGHT_SOURCES:.c=.o)
HB_MEM_IMPORT_OBJECTS := $(HB_MEM_IMPORT_SOURCES:.c=.o)

DAEMON_BINARY := $(BUILD_DIR)/camera_daemon_drobotics
SHM_TEST_BINARY := $(BUILD_DIR)/test_shm
FPS_READER_BINARY := $(BUILD_DIR)/test_fps_reader
SWITCHER_DEMO_BINARY := $(BUILD_DIR)/camera_switcher_demo
SWITCHER_DAEMON_BINARY := $(BUILD_DIR)/camera_switcher_daemon
POC_LOWLEVEL_BINARY := $(BUILD_DIR)/camera_poc_lowlevel
POC_VSE_DUAL_BINARY := $(BUILD_DIR)/camera_poc_vse_dual
ISP_LOWLIGHT_BINARY := $(BUILD_DIR)/test_isp_lowlight
HB_MEM_IMPORT_BINARY := $(BUILD_DIR)/test_hb_mem_import

LDLIBS_COMMON := -lrt
LDLIBS_DAEMON := $(LDLIBS_COMMON) -lpthread -lcam -lvpf -lhbmem -lmultimedia -lm
LDLIBS_DAEMON_OLD := $(LDLIBS_COMMON) -lpthread -lspcdev -lcam -lvpf -lhbmem
LDLIBS_POC_LOWLEVEL := $(LDLIBS_COMMON) -lpthread -lcam -lvpf -lhbmem -lmultimedia
LDLIBS_ISP_LOWLIGHT := $(LDLIBS_COMMON) -lpthread -lcam -lvpf -lhbmem -lm
LDLIBS_SWITCHER_DEMO := $(LDLIBS_COMMON) -ljpeg
LDLIBS_SWITCHER_DAEMON := $(LDLIBS_COMMON) -lpthread -ljpeg
LDLIBS_HB_MEM_IMPORT := $(LDLIBS_COMMON) -lpthread -lhbmem

DAEMON_ARGS ?= -C 0 -P 1

.PHONY: all clean test switcher-demo switcher-daemon switcher-daemon-build run run-daemon cleanup kill-processes help poc-lowlevel poc-vse-dual isp-lowlight test-hb-mem-import

all: $(DAEMON_BINARY) $(SHM_TEST_BINARY) $(SWITCHER_DAEMON_BINARY)

poc-lowlevel: $(POC_LOWLEVEL_BINARY)
	@echo "[PoC] Low-level API PoC ready at $(POC_LOWLEVEL_BINARY)"

poc-vse-dual: $(POC_VSE_DUAL_BINARY)
	@echo "[PoC] VSE Dual Channel PoC ready at $(POC_VSE_DUAL_BINARY)"

isp-lowlight: $(ISP_LOWLIGHT_BINARY)
	@echo "[PoC] ISP Low-Light Enhancement Tool ready at $(ISP_LOWLIGHT_BINARY)"

test-hb-mem-import: $(HB_MEM_IMPORT_BINARY)
	@echo "[Test] hb_mem import API test ready at $(HB_MEM_IMPORT_BINARY)"
	@echo "[Test] Run with camera daemon active: $(HB_MEM_IMPORT_BINARY)"

$(BUILD_DIR):
	@mkdir -p $@

$(DAEMON_BINARY): $(DAEMON_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_DAEMON)

$(SHM_TEST_BINARY): $(SHM_TEST_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_DAEMON_OLD)

$(FPS_READER_BINARY): $(FPS_READER_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_COMMON)

$(SWITCHER_DEMO_BINARY): $(SWITCHER_DEMO_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_SWITCHER_DEMO)

$(SWITCHER_DAEMON_BINARY): $(SWITCHER_DAEMON_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_SWITCHER_DAEMON)

$(POC_LOWLEVEL_BINARY): $(POC_LOWLEVEL_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_POC_LOWLEVEL)

$(POC_VSE_DUAL_BINARY): $(POC_VSE_DUAL_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_POC_LOWLEVEL)

$(ISP_LOWLIGHT_BINARY): $(ISP_LOWLIGHT_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_ISP_LOWLIGHT)

$(HB_MEM_IMPORT_BINARY): $(HB_MEM_IMPORT_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_HB_MEM_IMPORT)

# Compile camera_switcher_daemon.c with absolute path to camera_daemon
camera_switcher_daemon.o: camera_switcher_daemon.c
	$(CC) $(CFLAGS) $(CPPFLAGS) -DCAPTURE_BIN_PATH=\"$(BUILD_DIR_ABS)/camera_daemon_drobotics\" -c -o $@ $<

%.o: %.c
	$(CC) $(CFLAGS) $(CPPFLAGS) -c -o $@ $<

test: $(SHM_TEST_BINARY)
	@echo "[Test] Running shared memory test..."
	@$(SHM_TEST_BINARY)

switcher-demo: $(SWITCHER_DEMO_BINARY)
	@echo "[Run] Starting interactive switcher demo..."
	@$(SWITCHER_DEMO_BINARY)

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
	@-rm -f /dev/shm/pet_camera_* 2>/dev/null && echo "[Cleanup] Removed /dev/shm/pet_camera_*" || true
	@echo "[Cleanup] Shared memory cleanup complete"

kill-processes:
	@echo "[Cleanup] Checking for existing camera processes..."
	@-pkill -9 -f camera_switcher_daemon 2>/dev/null && echo "[Cleanup] Killed camera_switcher_daemon" || true
	@-pkill -9 -f camera_daemon_drobotics 2>/dev/null && echo "[Cleanup] Killed camera_daemon_drobotics" || true
	@-pkill -9 -f camera_poc_lowlevel 2>/dev/null && echo "[Cleanup] Killed camera_poc_lowlevel" || true
	@-pkill -9 -f cam-service 2>/dev/null && echo "[Cleanup] Killed cam-service" || true
	@-pkill -9 -f streaming-server 2>/dev/null && echo "[Cleanup] Killed streaming-server" || true
	@-pkill -9 -f web_monitor 2>/dev/null && echo "[Cleanup] Killed web_monitor" || true
	@-pkill -9 -f yolo_detector_daemon.py 2>/dev/null && echo "[Cleanup] Killed yolo_detector_daemon" || true
	@sleep 1
	@echo "[Cleanup] Process cleanup complete"

clean:
	@echo "[Clean] Removing built binaries and objects"
	@rm -f *.o
	@rm -f $(DAEMON_BINARY) $(SHM_TEST_BINARY) $(SWITCHER_DEMO_BINARY) $(SWITCHER_DAEMON_BINARY) $(POC_LOWLEVEL_BINARY) $(ISP_LOWLIGHT_BINARY) $(HB_MEM_IMPORT_BINARY)

help:
	@echo "Camera daemon build targets"
	@echo "  make (default)       Build camera_daemon_drobotics and shared memory test binary"
	@echo "  make test            Run shared memory tests"
	@echo "  make switcher-demo   Build and run the brightness-based camera switcher demo"
	@echo "  make switcher-daemon-build  Build the camera switcher orchestration daemon only"
	@echo "  make switcher-daemon Build and run the camera switcher orchestration daemon"
	@echo "  make run             Run camera_daemon_drobotics in the foreground (cleans stale processes and shm first)"
	@echo "  make run-daemon      Run camera_daemon_drobotics in the background (cleans stale processes and shm first)"
	@echo "  make cleanup         Remove camera processes and shared memory segments"
	@echo "  make kill-processes  Kill running camera_daemon_drobotics and cam-service processes"
	@echo "  make clean           Remove built binaries and object files"
	@echo "  make isp-lowlight    Build ISP low-light enhancement test tool"
	@echo "  make test-hb-mem-import  Build hb_mem import API test (run with camera daemon active)"
