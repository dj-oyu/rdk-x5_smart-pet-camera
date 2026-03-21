CC = aarch64-linux-gnu-gcc
CFLAGS = -O2 -Wall
INCLUDES = -I /usr/include/ -I /usr/include/GC820/ -I /usr/hobot/include/ -I /usr/hobot/include/HAL/
LDFLAGS = -L /usr/hobot/lib

# Libraries
LIBS_N2D = -lNano2Dutil -lNano2D -lm
LIBS_CODEC = -lmultimedia -lhbmem -lalog -lpthread -ldl -lm
LIBS_VPS = -lspcdev -lcam -lvpf -lhbmem -lalog -lpthread -ldl
LIBS_VFLOW = -lcam -lvpf -lhbmem -lalog -lpthread -ldl

TARGETS = format_convert_test h265_fixqp_test letterbox_hw_test vps_test \
          vse_6ch_test zerocopy_bench letterbox_verify

.PHONY: all clean help

all: $(TARGETS)

# nano2D NV12⇔RGBA / resize benchmark
format_convert_test: format_convert_test.c
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $< $(LDFLAGS) $(LIBS_N2D)

# H.264 vs H.265 FIXQP quality comparison
h265_fixqp_test: h265_fixqp_test.c
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $< $(LDFLAGS) $(LIBS_CODEC)

# nano2D letterbox methods comparison
letterbox_hw_test: letterbox_hw_test.c
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $< $(LDFLAGS) $(LIBS_N2D)

# VPS (sp_open_vps) scaling benchmark
vps_test: vps_test.c
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $< $(LDFLAGS) $(LIBS_VPS)

# VSE 5-channel simultaneous output test
vse_6ch_test: vse_6ch_test.c
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $< $(LDFLAGS) $(LIBS_VFLOW)

# Zero-copy VSE → nano2D letterbox pipeline
zerocopy_bench: zerocopy_bench.c
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $< $(LDFLAGS) $(LIBS_N2D) $(LIBS_VFLOW)

# VSE → nano2D letterbox visual verification (outputs YUV files)
letterbox_verify: letterbox_verify.c
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $< $(LDFLAGS) $(LIBS_N2D) $(LIBS_VFLOW)

clean:
	rm -f $(TARGETS)

help:
	@echo "HW Benchmark Tests (run on RDK X5 only)"
	@echo ""
	@echo "  make                 Build all benchmarks"
	@echo "  make clean           Remove binaries"
	@echo ""
	@echo "Tests:"
	@echo "  format_convert_test  nano2D NV12⇔RGBA, resize (GPU 2D)"
	@echo "  h265_fixqp_test      H.264 vs H.265 quality comparison (VPU)"
	@echo "  letterbox_hw_test    nano2D vs CPU letterbox comparison"
	@echo "  vps_test             VPS sp_open_vps scaling (libspcdev)"
	@echo "  vse_6ch_test         VSE 5ch simultaneous output (hbn_vflow)"
	@echo "  zerocopy_bench       Zero-copy VSE→nano2D pipeline"
	@echo "  letterbox_verify     VSE→nano2D visual verification (saves .yuv)"
	@echo ""
	@echo "Prerequisites:"
	@echo "  - RDK X5 board with D-Robotics SDK"
	@echo "  - /app/multimedia_samples/sample_codec/1280x720_NV12.yuv (h265_fixqp_test)"
	@echo "  - /app/multimedia_samples/sample_codec/1920x1080_NV12.yuv (zerocopy_bench)"
