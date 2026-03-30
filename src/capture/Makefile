CC := gcc
CFLAGS := -Wall -Wextra -O2 -std=c11
CPPFLAGS := -D_GNU_SOURCE -I/usr/include -I/usr/include/GC820

BUILD_DIR := ../../build

LDFLAGS := -L/usr/hobot/lib

DAEMON_SOURCES := camera_daemon_main.c camera_pipeline.c camera_switcher.c vio_lowlevel.c encoder_lowlevel.c encoder_thread.c tcp_relay.c shared_memory.c isp_brightness.c logger.c
JPEG_ENCODER_SOURCES := jpeg_encoder.c logger.c
N2D_COMIC_SOURCES := n2d_comic.c logger.c
RGN_OVERLAY_SOURCES := rgn_overlay.c
N2D_LETTERBOX_SOURCES := n2d_letterbox.c logger.c

DAEMON_OBJECTS := $(DAEMON_SOURCES:.c=.o)
JPEG_ENCODER_OBJECTS := $(JPEG_ENCODER_SOURCES:.c=.o)
N2D_COMIC_OBJECTS := $(N2D_COMIC_SOURCES:.c=.o)
RGN_OVERLAY_OBJECTS := $(RGN_OVERLAY_SOURCES:.c=.o)
N2D_LETTERBOX_OBJECTS := $(N2D_LETTERBOX_SOURCES:.c=.o)

DAEMON_BINARY := $(BUILD_DIR)/camera_daemon_drobotics
JPEG_ENCODER_LIB := $(BUILD_DIR)/libjpeg_encoder.a
N2D_COMIC_LIB := $(BUILD_DIR)/libn2d_comic.a
RGN_OVERLAY_LIB := $(BUILD_DIR)/librgn_overlay.a
N2D_LETTERBOX_SO := $(BUILD_DIR)/libn2d_letterbox.so

LDLIBS_COMMON := -lrt
LDLIBS_DAEMON := $(LDLIBS_COMMON) -lpthread -lcam -lvpf -lhbmem -lmultimedia -lm

DAEMON_ARGS ?= -C 0 -P 1

.PHONY: all clean run run-daemon cleanup kill-processes help jpeg-encoder-lib format check-format lint

all: $(DAEMON_BINARY) $(JPEG_ENCODER_LIB) $(N2D_COMIC_LIB) $(RGN_OVERLAY_LIB) $(N2D_LETTERBOX_SO)

$(BUILD_DIR):
	@mkdir -p $@

$(DAEMON_BINARY): $(DAEMON_OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS_DAEMON)

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

%.o: %.c
	$(CC) $(CFLAGS) $(CPPFLAGS) -c -o $@ $<

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
	@rm -f $(DAEMON_BINARY) $(JPEG_ENCODER_LIB) $(N2D_COMIC_LIB) $(RGN_OVERLAY_LIB) $(N2D_LETTERBOX_SO)

help:
	@echo "Camera daemon build targets"
	@echo "  make (default)       Build camera_daemon_drobotics and libraries"
	@echo "  make run             Run camera_daemon_drobotics in the foreground (cleans stale processes and shm first)"
	@echo "  make run-daemon      Run camera_daemon_drobotics in the background (cleans stale processes and shm first)"
	@echo "  make cleanup         Remove camera processes and shared memory segments"
	@echo "  make kill-processes  Kill running camera_daemon_drobotics and cam-service processes"
	@echo "  make clean           Remove built binaries and object files"
	@echo "  make format          Format all C sources with clang-format"
	@echo "  make check-format    Check formatting without modifying files (for CI)"
	@echo "  make lint            Run clang-tidy static analysis (device only, needs vendor headers)"

FORMAT_SOURCES := $(wildcard *.c *.h)

format:
	@echo "[Format] clang-format -i ..."
	@clang-format -i $(FORMAT_SOURCES)
	@echo "[Format] Done"

check-format:
	@echo "[Format] Checking formatting..."
	@clang-format --dry-run --Werror $(FORMAT_SOURCES) && echo "[Format] OK" || (echo "[Format] FAIL: run 'make format'" && exit 1)

lint:
	@echo "[Lint] clang-tidy ..."
	@which clang-tidy > /dev/null 2>&1 || (echo "[Lint] clang-tidy not found, skipping" && exit 0)
	@for src in $(filter %.c,$(FORMAT_SOURCES)); do \
		echo "  $$src"; \
		clang-tidy $$src -- $(CFLAGS) $(CPPFLAGS) 2>&1 | grep -v "warnings generated" || true; \
	done
	@echo "[Lint] Done"
