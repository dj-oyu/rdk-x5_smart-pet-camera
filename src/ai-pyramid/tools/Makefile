CXX := g++
CXXFLAGS := -Wall -Wextra -O2 -std=c++17
CPPFLAGS := -I/home/admin-user/ax650_bsp_headers $(shell pkg-config --cflags opencv4)

BUILD_DIR := ../../../build
LDFLAGS := -L/soc/lib
LDLIBS := -lax_engine -lax_sys -lax_ivps $(shell pkg-config --libs opencv4) -lpthread

DAEMON_BINARY := $(BUILD_DIR)/ax_yolo_daemon
DAEMON_SOURCES := ax_yolo_daemon.cpp

.PHONY: all clean format check-format lint

all: $(DAEMON_BINARY)

$(BUILD_DIR):
	@mkdir -p $@

$(DAEMON_BINARY): $(DAEMON_SOURCES) | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS)

FORMAT_SOURCES := $(wildcard *.cpp *.hpp *.h)

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
	@for src in $(filter %.cpp,$(FORMAT_SOURCES)); do \
		echo "  $$src"; \
		clang-tidy $$src -- $(CXXFLAGS) $(CPPFLAGS) 2>&1 | grep -v "warnings generated" || true; \
	done
	@echo "[Lint] Done"

clean:
	@rm -f $(DAEMON_BINARY)
