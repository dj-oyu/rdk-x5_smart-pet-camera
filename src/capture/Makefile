CC := gcc
CFLAGS := -Wall -Wextra -O2 -std=c11
CPPFLAGS := -D_GNU_SOURCE -I/usr/include -I/usr/include/GC820

BUILD_DIR := ../../build
BUILD_DIR_ABS := $(abspath $(BUILD_DIR))

LDFLAGS := -L/usr/hobot/lib

DAEMON_SOURCES := camera_daemon_main.c camera_pipeline.c camera_switcher.c vio_lowlevel.c encoder_lowlevel.c encoder_thread.c shared_memory.c isp_brightness.c logger.c
SWITCHER_DEMO_SOURCES := camera_switcher_demo.c camera_switcher.c shared_memory.c logger.c
SWITCHER_DAEMON_SOURCES := camera_switcher_daemon.c camera_switcher.c shared_memory.c logger.c
HB_MEM_IMPORT_SOURCES := test_hb_mem_import.c shared_memory.c logger.c
JPEG_ENCODER_SOURCES := jpeg_encoder.c logger.c
N2D_COMIC_SOURCES := n2d_comic.c logger.c
RGN_OVERLAY_SOURCES := rgn_overlay.c
N2D_LETTERBOX_SOURCES := n2d_letterbox.c logger.c

DAEMON_OBJECTS := $(DAEMON_SOURCES:.c=.o)
JPEG_ENCODER_OBJECTS := $(JPEG_ENCODER_SOURCES:.c=.o)
N2D_COMIC_OBJECTS := $(N2D_COMIC_SOURCES:.c=.o)
RGN_OVERLAY_OBJECTS := $(RGN_OVERLAY_SOURCES:.c=.o)
N2D_LETTERBOX_OBJECTS := $(N2D_LETTERBOX_SOURCES:.c=.o)
SWITCHER_DEMO_OBJECTS := $(SWITCHER_DEMO_SOURCES:.c=.o)
SWITCHER_DAEMON_OBJECTS := $(SWITCHER_DAEMON_SOURCES:.c=.o)
HB_MEM_IMPORT_OBJECTS := $(HB_MEM_IMPORT_SOURCES:.c=.o)

DAEMON_BINARY := $(BUILD_DIR)/camera_daemon_drobotics
SWITCHER_DEMO_BINARY := $(BUILD_DIR)/camera_switcher_demo
SWITCHER_DAEMON_BINARY := $(BUILD_DIR)/camera_switcher_daemon
HB_MEM_IMPORT_BINARY := $(BUILD_DIR)/test_hb_mem_import
JPEG_ENCODER_LIB := $(BUILD_DIR)/libjpeg_encoder.a
N2D_COMIC_LIB := $(BUILD_DIR)/libn2d_comic.a
RGN_OVERLAY_LIB := $(BUILD_DIR)/librgn_overlay.a
N2D_LETTERBOX_SO := $(BUILD_DIR)/libn2d_letterbox.so

LDLIBS_COMMON := -lrt
LDLIBS_DAEMON := $(LDLIBS_COMMON) -lpthread -lcam -lvpf -lhbmem -lmultimedia -lm
LDLIBS_SWITCHER_DEMO := $(LDLIBS_COMMON)
LDLIBS_SWITCHER_DAEMON := $(LDLIBS_COMMON) -lpthread
LDLIBS_HB_MEM_IMPORT := $(LDLIBS_COMMON) -lpthread -lhbmem

DAEMON_ARGS ?= -C 0 -P 1

.PHONY: all clean switcher-demo switcher-daemon switcher-daemon-build run run-daemon cleanup kill-processes help test-hb-mem-import jpeg-encoder-lib

all: $(DAEMON_BINARY) $(JPEG_ENCODER_LIB) $(N2D_COMIC_LIB) $(RGN_OVERLAY_LIB) $(N2D_LETTERBOX_SO)

test-hb-mem-import: $(HB_MEM_IMPORT_BINARY)
	@echo "[Test] hb_mem import API test ready at $(HB_MEM_IMPORT_BINARY)"
	@echo "[Test] Run with camera daemon active: $(HB_MEM_IMPORT_BINARY)"

$(BUILD_DIR):
	@mkdir -p $@

$(DAEMON_BINARY): $(DAEMON_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_DAEMON)

$(SWITCHER_DEMO_BINARY): $(SWITCHER_DEMO_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_SWITCHER_DEMO)

$(SWITCHER_DAEMON_BINARY): $(SWITCHER_DAEMON_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_SWITCHER_DAEMON)

$(HB_MEM_IMPORT_BINARY): $(HB_MEM_IMPORT_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_HB_MEM_IMPORT)

# Static libraries (used by Go streaming server via CGO)
$(JPEG_ENCODER_LIB): $(JPEG_ENCODER_OBJECTS) | $(BUILD_DIR)
	ar rcs $@ $^
	@echo "[Build] JPEG encoder library ready at $@"

$(N2D_COMIC_LIB): $(N2D_COMIC_OBJECTS) | $(BUILD_DIR)
	ar rcs $@ $^
	@echo "[Build] nano2D comic library ready at $@"

$(RGN_OVERLAY_LIB): $(RGN_OVERLAY_OBJECTS) | $(BUILD_DIR)
	ar rcs $@ $^
	@echo "[Build] RGN overlay library ready at $@"

$(N2D_LETTERBOX_SO): $(N2D_LETTERBOX_SOURCES) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) -shared -fPIC $(LDFLAGS) -o $@ $^ -lNano2D -lNano2Dutil -lhbmem
	@echo "[Build] nano2D letterbox shared library ready at $@"

jpeg-encoder-lib: $(JPEG_ENCODER_LIB)
	@echo "[Build] JPEG encoder library: $(JPEG_ENCODER_LIB)"

# Compile camera_switcher_daemon.c with absolute path to camera_daemon
camera_switcher_daemon.o: camera_switcher_daemon.c
	$(CC) $(CFLAGS) $(CPPFLAGS) -DCAPTURE_BIN_PATH=\"$(BUILD_DIR_ABS)/camera_daemon_drobotics\" -c -o $@ $<

%.o: %.c
	$(CC) $(CFLAGS) $(CPPFLAGS) -c -o $@ $<

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
	@-pkill -9 -f cam-service 2>/dev/null && echo "[Cleanup] Killed cam-service" || true
	@-pkill -9 -f streaming-server 2>/dev/null && echo "[Cleanup] Killed streaming-server" || true
	@-pkill -9 -f web_monitor 2>/dev/null && echo "[Cleanup] Killed web_monitor" || true
	@-pkill -9 -f yolo_detector_daemon.py 2>/dev/null && echo "[Cleanup] Killed yolo_detector_daemon" || true
	@sleep 1
	@echo "[Cleanup] Process cleanup complete"

clean:
	@echo "[Clean] Removing built binaries and objects"
	@rm -f *.o
	@rm -f $(DAEMON_BINARY) $(SWITCHER_DEMO_BINARY) $(SWITCHER_DAEMON_BINARY) $(HB_MEM_IMPORT_BINARY) $(JPEG_ENCODER_LIB) $(N2D_COMIC_LIB) $(RGN_OVERLAY_LIB) $(N2D_LETTERBOX_SO)

help:
	@echo "Camera daemon build targets"
	@echo "  make (default)       Build camera_daemon_drobotics and libraries"
	@echo "  make switcher-demo   Build and run the brightness-based camera switcher demo"
	@echo "  make switcher-daemon-build  Build the camera switcher orchestration daemon only"
	@echo "  make switcher-daemon Build and run the camera switcher orchestration daemon"
	@echo "  make run             Run camera_daemon_drobotics in the foreground (cleans stale processes and shm first)"
	@echo "  make run-daemon      Run camera_daemon_drobotics in the background (cleans stale processes and shm first)"
	@echo "  make cleanup         Remove camera processes and shared memory segments"
	@echo "  make kill-processes  Kill running camera_daemon_drobotics and cam-service processes"
	@echo "  make clean           Remove built binaries and object files"
	@echo "  make test-hb-mem-import  Build hb_mem import API test (run with camera daemon active)"
