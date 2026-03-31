// ax_yolo_daemon — Persistent YOLO NPU detection daemon for AX650.
//
// Modes:
//   1. On-demand: CMD_DETECT with JPEG_PATH or NV12_RAW input
//   2. Stream: CMD_STREAM connects TCP to rdk-x5, HW decodes H.265 via VDEC,
//      applies CLAHE, preprocesses via IVPS HW, runs NPU, pushes detections
//
// Binary protocol over Unix socket. See protocol.h.
//
// BSD 3-Clause License (follows ax-pipeline conventions).

#include "clahe.h"
#include "protocol.h"
#include "yolo_postprocess.h"

#include <ax_engine_api.h>
#include <ax_ivps_api.h>
#include <ax_sys_api.h>
#include <ax_vdec_api.h>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <mutex>
#include <string>
#include <vector>

#include <arpa/inet.h>
#include <netinet/tcp.h>
#include <errno.h>
#include <getopt.h>
#include <netdb.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

static constexpr int DEFAULT_INPUT_W = 640;
static constexpr int DEFAULT_INPUT_H = 640;
static constexpr int CLS_NUM = 80;
static constexpr int CMM_ALIGN = 128;
static const char* const CMM_TOKEN = "ax_yolo_daemon";

static constexpr int STREAM_RELAY_PORT = 9265;
static constexpr int STREAM_HEARTBEAT_SEC = 10;

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

static volatile sig_atomic_t g_running = 1;
static int g_listen_fd = -1;

static void signal_handler(int /*sig*/) {
    g_running = 0;
    // Shutdown listen socket to unblock accept(). Stream loop uses poll()
    // with 1s timeout so it detects g_running=0 without fd close.
    if (g_listen_fd >= 0) {
        shutdown(g_listen_fd, SHUT_RDWR);
        close(g_listen_fd);
        g_listen_fd = -1;
    }
}

// Post-processing, CLAHE, and protocol structs are in headers.

// AX Engine wrapper
// ---------------------------------------------------------------------------

enum class ModelColorSpace { RGB, BGR, NV12, UNKNOWN };

struct AxModel {
    AX_ENGINE_HANDLE handle = nullptr;
    AX_ENGINE_IO_INFO_T* io_info = nullptr;
    AX_ENGINE_IO_T io_data = {};
    int input_w = 0;
    int input_h = 0;
    ModelColorSpace color_space = ModelColorSpace::UNKNOWN;
    std::string model_path;
    uint32_t cmm_bytes = 0;

    // CMM buffer for NV12 input (reusable).
    AX_U64 nv12_phy = 0;
    void* nv12_vir = nullptr;
    uint32_t nv12_size = 0;
    bool ivps_ready = false;
    bool vdec_ready = false;
    AX_POOL vdec_pool_id = AX_INVALID_POOLID;

    // Mutex for NPU access (stream vs on-demand).
    std::mutex npu_mutex;
};

static void free_io(AX_ENGINE_IO_T* const io) {
    for (uint32_t i = 0; i < io->nOutputSize; ++i) {
        AX_SYS_MemFree(io->pOutputs[i].phyAddr, io->pOutputs[i].pVirAddr);
    }
    delete[] io->pInputs;
    delete[] io->pOutputs;
    io->pInputs = nullptr;
    io->pOutputs = nullptr;
    io->nInputSize = 0;
    io->nOutputSize = 0;
}

static int load_model(AxModel& m, const std::string& path, const int input_w, const int input_h) {
    std::ifstream ifs(path, std::ios::binary | std::ios::ate);
    if (!ifs) {
        fprintf(stderr, "[ERROR] Cannot open model: %s\n", path.c_str());
        return -1;
    }
    const auto file_size = ifs.tellg();
    ifs.seekg(0);
    std::vector<char> model_data(file_size);
    ifs.read(model_data.data(), file_size);

    int ret = AX_ENGINE_CreateHandle(&m.handle, model_data.data(), (AX_U32)file_size);
    if (ret != 0) {
        fprintf(stderr, "[ERROR] AX_ENGINE_CreateHandle: 0x%x\n", ret);
        return ret;
    }
    ret = AX_ENGINE_CreateContext(m.handle);
    if (ret != 0) {
        AX_ENGINE_DestroyHandle(m.handle);
        m.handle = nullptr;
        return ret;
    }
    ret = AX_ENGINE_GetIOInfo(m.handle, &m.io_info);
    if (ret != 0) {
        AX_ENGINE_DestroyHandle(m.handle);
        m.handle = nullptr;
        return ret;
    }

    memset(&m.io_data, 0, sizeof(m.io_data));
    m.io_data.nInputSize = m.io_info->nInputSize;
    m.io_data.pInputs = new AX_ENGINE_IO_BUFFER_T[m.io_info->nInputSize]();
    for (uint32_t i = 0; i < m.io_info->nInputSize; ++i) {
        auto& buf = m.io_data.pInputs[i];
        buf.nSize = m.io_info->pInputs[i].nSize;
        ret = AX_SYS_MemAllocCached(&buf.phyAddr, &buf.pVirAddr, buf.nSize, CMM_ALIGN,
                                    (const AX_S8*)CMM_TOKEN);
        if (ret != 0) {
            return ret;
        }
    }
    m.io_data.nOutputSize = m.io_info->nOutputSize;
    m.io_data.pOutputs = new AX_ENGINE_IO_BUFFER_T[m.io_info->nOutputSize]();
    for (uint32_t i = 0; i < m.io_info->nOutputSize; ++i) {
        auto& buf = m.io_data.pOutputs[i];
        buf.nSize = m.io_info->pOutputs[i].nSize;
        ret = AX_SYS_MemAllocCached(&buf.phyAddr, &buf.pVirAddr, buf.nSize, CMM_ALIGN,
                                    (const AX_S8*)CMM_TOKEN);
        if (ret != 0) {
            return ret;
        }
    }

    AX_ENGINE_CMM_INFO cmm_info = {};
    if (AX_ENGINE_GetCMMUsage(m.handle, &cmm_info) == 0) {
        m.cmm_bytes = cmm_info.nCMMSize;
    }

    const char* cs_name = "unknown";
    if (m.io_info->nInputSize > 0 && m.io_info->pInputs[0].pExtraMeta) {
        switch (m.io_info->pInputs[0].pExtraMeta->eColorSpace) {
        case AX_ENGINE_CS_NV12:
            m.color_space = ModelColorSpace::NV12;
            cs_name = "NV12";
            break;
        case AX_ENGINE_CS_RGB:
            m.color_space = ModelColorSpace::RGB;
            cs_name = "RGB";
            break;
        case AX_ENGINE_CS_BGR:
            m.color_space = ModelColorSpace::BGR;
            cs_name = "BGR";
            break;
        default:
            m.color_space = ModelColorSpace::RGB;
            cs_name = "unknown(fallback RGB)";
            break;
        }
    }

    m.input_w = input_w;
    m.input_h = input_h;
    m.model_path = path;
    fprintf(stderr, "[INFO] Model loaded: %s (CMM %u KB, %dx%d, %s)\n", path.c_str(),
            m.cmm_bytes / 1024, input_w, input_h, cs_name);
    return 0;
}

static void unload_model(AxModel& m) {
    if (!m.handle) {
        return;
    }
    for (uint32_t i = 0; i < m.io_data.nInputSize; ++i) {
        AX_SYS_MemFree(m.io_data.pInputs[i].phyAddr, m.io_data.pInputs[i].pVirAddr);
    }
    free_io(&m.io_data);
    AX_ENGINE_DestroyHandle(m.handle);
    m.handle = nullptr;
    m.io_info = nullptr;
    m.cmm_bytes = 0;
    m.model_path.clear();
}

// ---------------------------------------------------------------------------
// Preprocessing + inference
// ---------------------------------------------------------------------------

static void letterbox_into(const cv::Mat& src, cv::Mat& dst) {
    const int tw = dst.cols, th = dst.rows;
    const float scale = std::min((float)tw / src.cols, (float)th / src.rows);
    const int nw = (int)(scale * src.cols), nh = (int)(scale * src.rows);
    dst.setTo(cv::Scalar(114, 114, 114));
    cv::Mat roi = dst(cv::Rect((tw - nw) / 2, (th - nh) / 2, nw, nh));
    cv::resize(src, roi, cv::Size(nw, nh));
}

static int run_npu_and_postprocess(AxModel& m, const int orig_w, const int orig_h,
                                   std::vector<Detection>& results, double& elapsed_ms,
                                   const std::chrono::steady_clock::time_point t0) {
    const int ret = AX_ENGINE_RunSync(m.handle, &m.io_data);
    if (ret != 0) {
        return ret;
    }
    for (uint32_t i = 0; i < m.io_data.nOutputSize; ++i) {
        AX_SYS_MinvalidateCache(m.io_data.pOutputs[i].phyAddr, m.io_data.pOutputs[i].pVirAddr,
                                m.io_data.pOutputs[i].nSize);
    }
    for (uint32_t i = 0; i + 1 < m.io_data.nOutputSize; i += 2) {
        const auto& bm = m.io_info->pOutputs[i];
        const int fw = bm.nShapeSize >= 4 ? bm.pShape[2] : 0;
        if (fw <= 0) {
            continue;
        }
        const auto& cm = m.io_info->pOutputs[i + 1];
        const int cc = cm.nShapeSize >= 4 ? cm.pShape[3] : CLS_NUM;
        generate_proposals_separated(m.input_w / fw, (const float*)m.io_data.pOutputs[i].pVirAddr,
                                     (const float*)m.io_data.pOutputs[i + 1].pVirAddr,
                                     SCORE_THRESHOLD, results, m.input_w, m.input_h, cc);
    }
    nms(results, NMS_THRESHOLD);
    scale_detections(results, m.input_w, m.input_h, orig_w, orig_h);
    elapsed_ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return 0;
}

static int ensure_nv12_cmm(AxModel& m, const int w, const int h) {
    const uint32_t needed = w * h * 3 / 2;
    if (m.nv12_vir && m.nv12_size >= needed) {
        return 0;
    }
    if (m.nv12_vir) {
        AX_SYS_MemFree(m.nv12_phy, m.nv12_vir);
        m.nv12_vir = nullptr;
    }
    const int ret =
        AX_SYS_MemAllocCached(&m.nv12_phy, &m.nv12_vir, needed, CMM_ALIGN, (const AX_S8*)CMM_TOKEN);
    if (ret != 0) {
        return ret;
    }
    m.nv12_size = needed;
    return 0;
}

// Inference from NV12 in CMM (already copied + flushed). Uses IVPS or CPU fallback.
static int run_inference_nv12_cmm(AxModel& m, const int src_w, const int src_h,
                                  std::vector<Detection>& results, double& elapsed_ms) {
    results.clear();
    const auto t0 = std::chrono::steady_clock::now();

    if (m.ivps_ready) {
        AX_VIDEO_FRAME_T sf = {};
        sf.u32Width = src_w;
        sf.u32Height = src_h;
        sf.enImgFormat = AX_FORMAT_YUV420_SEMIPLANAR;
        sf.u32PicStride[0] = src_w;
        sf.u64PhyAddr[0] = m.nv12_phy;
        sf.u64VirAddr[0] = (AX_U64)(uintptr_t)m.nv12_vir;
        sf.u64PhyAddr[1] = m.nv12_phy + src_w * src_h;
        sf.u64VirAddr[1] = (AX_U64)(uintptr_t)((uint8_t*)m.nv12_vir + src_w * src_h);

        AX_VIDEO_FRAME_T df = {};
        df.u32Width = m.input_w;
        df.u32Height = m.input_h;
        df.enImgFormat = AX_FORMAT_BGR888;
        df.u32PicStride[0] = m.input_w * 3;
        df.u64PhyAddr[0] = m.io_data.pInputs[0].phyAddr;
        df.u64VirAddr[0] = (AX_U64)(uintptr_t)m.io_data.pInputs[0].pVirAddr;
        df.u32FrameSize = m.io_data.pInputs[0].nSize;

        AX_IVPS_ASPECT_RATIO_T ar = {};
        ar.eMode = AX_IVPS_ASPECT_RATIO_AUTO;
        ar.nBgColor = 0x727272;
        ar.eAligns[0] = AX_IVPS_ASPECT_RATIO_HORIZONTAL_CENTER;
        ar.eAligns[1] = AX_IVPS_ASPECT_RATIO_VERTICAL_CENTER;

        if (AX_IVPS_CropResizeTdp(&sf, &df, &ar) == 0) {
            AX_SYS_MinvalidateCache(m.io_data.pInputs[0].phyAddr, m.io_data.pInputs[0].pVirAddr,
                                    m.io_data.pInputs[0].nSize);
            return run_npu_and_postprocess(m, src_w, src_h, results, elapsed_ms, t0);
        }
        fprintf(stderr, "[WARN] IVPS failed, CPU fallback\n");
    }

    // CPU fallback.
    cv::Mat nv12_mat(src_h * 3 / 2, src_w, CV_8UC1, m.nv12_vir);
    cv::Mat bgr;
    cv::cvtColor(nv12_mat, bgr, cv::COLOR_YUV2BGR_NV12);
    cv::Mat cmm_mat(m.input_h, m.input_w, CV_8UC3, m.io_data.pInputs[0].pVirAddr);
    letterbox_into(bgr, cmm_mat);
    AX_SYS_MflushCache(m.io_data.pInputs[0].phyAddr, m.io_data.pInputs[0].pVirAddr,
                       m.io_data.pInputs[0].nSize);
    return run_npu_and_postprocess(m, src_w, src_h, results, elapsed_ms, t0);
}

// ---------------------------------------------------------------------------
// Socket I/O
// ---------------------------------------------------------------------------

static bool read_exact(const int fd, void* const buf, size_t n) {
    uint8_t* p = (uint8_t*)buf;
    while (n > 0) {
        const ssize_t r = read(fd, p, n);
        if (r <= 0) {
            return false;
        }
        p += r;
        n -= r;
    }
    return true;
}

static bool write_exact(const int fd, const void* const buf, size_t n) {
    const uint8_t* p = (const uint8_t*)buf;
    while (n > 0) {
        const ssize_t w = write(fd, p, n);
        if (w <= 0) {
            return false;
        }
        p += w;
        n -= w;
    }
    return true;
}

static int create_listen_socket(const char* const path) {
    unlink(path);
    const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    struct sockaddr_un addr = {};
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0 || listen(fd, 4) < 0) {
        close(fd);
        return -1;
    }
    chmod(path, 0666);
    return fd;
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

static bool send_detections(const int fd, const std::vector<Detection>& dets, const float ms) {
    const uint16_t count = (uint16_t)std::min(dets.size(), (size_t)UINT16_MAX);
    ResponseHeader hdr = {};
    hdr.status = 0;
    hdr.det_count = count;
    hdr.elapsed_ms = ms;
    if (!write_exact(fd, &hdr, sizeof(hdr))) {
        return false;
    }
    for (uint16_t i = 0; i < count; ++i) {
        const auto& d = dets[i];
        WireDetection wd = {};
        wd.x1 = (int16_t)std::clamp(d.x1, -32768.f, 32767.f);
        wd.y1 = (int16_t)std::clamp(d.y1, -32768.f, 32767.f);
        wd.x2 = (int16_t)std::clamp(d.x2, -32768.f, 32767.f);
        wd.y2 = (int16_t)std::clamp(d.y2, -32768.f, 32767.f);
        wd.class_id = (uint16_t)d.class_id;
        wd.confidence = (uint16_t)(d.confidence * 10000.f);
        if (!write_exact(fd, &wd, sizeof(wd))) {
            return false;
        }
    }
    return true;
}

static void send_error(const int fd, const char* const msg) {
    ResponseHeader hdr = {};
    hdr.status = 1;
    hdr.error_len = (uint32_t)strlen(msg);
    write_exact(fd, &hdr, sizeof(hdr));
    if (hdr.error_len > 0) {
        write_exact(fd, msg, hdr.error_len);
    }
}

// ---------------------------------------------------------------------------
// TCP client
// ---------------------------------------------------------------------------

static int tcp_connect(const char* const host, const int port) {
    struct addrinfo hints = {}, *res = nullptr;
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%d", port);
    if (getaddrinfo(host, port_str, &hints, &res) != 0 || !res) {
        fprintf(stderr, "[STREAM] DNS resolve failed: %s\n", host);
        return -1;
    }
    const int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd < 0) {
        freeaddrinfo(res);
        return -1;
    }
    // Recv timeout (10s).
    const struct timeval tv = {10, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    // TCP keepalive — detect dead connections quickly.
    const int keepalive = 1, idle = 5, interval = 2, count = 3;
    setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &interval, sizeof(interval));
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &count, sizeof(count));

    if (connect(fd, res->ai_addr, res->ai_addrlen) < 0) {
        fprintf(stderr, "[STREAM] Connect failed: %s:%d (%s)\n", host, port, strerror(errno));
        close(fd);
        freeaddrinfo(res);
        return -1;
    }
    freeaddrinfo(res);
    return fd;
}

// ---------------------------------------------------------------------------
// VDEC constants
// ---------------------------------------------------------------------------

static constexpr AX_VDEC_GRP VDEC_GRP = 0;
static constexpr AX_VDEC_CHN VDEC_CHN = 0;
static constexpr int STREAM_BUF_SIZE = 2 * 1024 * 1024; // 2MB stream buffer
static constexpr int FRAME_W = 1280;
static constexpr int FRAME_H = 720;

// ---------------------------------------------------------------------------
// On-demand handlers
// ---------------------------------------------------------------------------

static void handle_detect(const int fd, AxModel& m, const RequestHeader& req) {
    if (!m.handle) {
        send_error(fd, "no model loaded");
        return;
    }
    std::vector<Detection> dets;
    double ms = 0;

    if (req.input_type == INPUT_JPEG_PATH) {
        std::string path(req.payload_size, '\0');
        if (!read_exact(fd, path.data(), req.payload_size)) {
            send_error(fd, "read path failed");
            return;
        }
        const cv::Mat img = cv::imread(path, cv::IMREAD_COLOR);
        if (img.empty()) {
            send_error(fd, "imread failed");
            return;
        }
        std::lock_guard<std::mutex> lock(m.npu_mutex);
        const auto t0 = std::chrono::steady_clock::now();
        cv::Mat cmm_mat(m.input_h, m.input_w, CV_8UC3, m.io_data.pInputs[0].pVirAddr);
        letterbox_into(img, cmm_mat);
        AX_SYS_MflushCache(m.io_data.pInputs[0].phyAddr, m.io_data.pInputs[0].pVirAddr,
                           m.io_data.pInputs[0].nSize);
        if (run_npu_and_postprocess(m, img.cols, img.rows, dets, ms, t0) != 0) {
            send_error(fd, "inference failed");
            return;
        }
    } else if (req.input_type == INPUT_NV12_RAW) {
        const size_t expected = (size_t)req.width * req.height * 3 / 2;
        if (req.payload_size != expected) {
            std::vector<uint8_t> drain(req.payload_size);
            read_exact(fd, drain.data(), req.payload_size);
            send_error(fd, "nv12 size mismatch");
            return;
        }
        if (ensure_nv12_cmm(m, req.width, req.height) != 0) {
            std::vector<uint8_t> drain(expected);
            read_exact(fd, drain.data(), expected);
            send_error(fd, "cmm alloc failed");
            return;
        }
        if (!read_exact(fd, m.nv12_vir, expected)) {
            send_error(fd, "read nv12 failed");
            return;
        }
        AX_SYS_MflushCache(m.nv12_phy, m.nv12_vir, expected);
        std::lock_guard<std::mutex> lock(m.npu_mutex);
        if (run_inference_nv12_cmm(m, req.width, req.height, dets, ms) != 0) {
            send_error(fd, "inference failed");
            return;
        }
    } else {
        if (req.payload_size > 0) {
            std::vector<uint8_t> drain(req.payload_size);
            read_exact(fd, drain.data(), req.payload_size);
        }
        send_error(fd, "unknown input_type");
        return;
    }

    send_detections(fd, dets, (float)ms);
}

static void handle_load(const int fd, AxModel& m, const RequestHeader& req) {
    std::string path(req.payload_size, '\0');
    if (req.payload_size > 0 && !read_exact(fd, path.data(), req.payload_size)) {
        send_error(fd, "read path failed");
        return;
    }
    std::lock_guard<std::mutex> lock(m.npu_mutex);
    const int prev_w = m.input_w ? m.input_w : DEFAULT_INPUT_W;
    const int prev_h = m.input_h ? m.input_h : DEFAULT_INPUT_H;
    unload_model(m);
    if (load_model(m, path, prev_w, prev_h) != 0) {
        unload_model(m); // Clean up partial state from failed load.
        send_error(fd, "load failed");
        return;
    }
    std::vector<Detection> empty;
    send_detections(fd, empty, 0);
}

static void handle_unload(const int fd, AxModel& m) {
    std::lock_guard<std::mutex> lock(m.npu_mutex);
    unload_model(m);
    std::vector<Detection> empty;
    send_detections(fd, empty, 0);
}

static void handle_status(const int fd, const AxModel& m) {
    std::vector<Detection> empty;
    send_detections(fd, empty, m.handle ? (float)(m.cmm_bytes / 1024) : 0.f);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

static void print_usage(const char* const prog) {
    fprintf(stderr,
            "Usage: %s --model <path> [options]\n"
            "  --model <path>           axmodel file (required)\n"
            "  --socket <path>          Unix socket (default: /run/ax_yolo_daemon.sock)\n"
            "  --input-size <WxH>       Model input (default: 640x640)\n",
            prog);
}

int main(int argc, char** argv) {
    std::string model_path;
    std::string socket_path = "/run/ax_yolo_daemon.sock";
    int input_w = DEFAULT_INPUT_W;
    int input_h = DEFAULT_INPUT_H;

    static struct option long_opts[] = {
        {"model", required_argument, nullptr, 'm'},
        {"socket", required_argument, nullptr, 's'},
        {"input-size", required_argument, nullptr, 'i'},
        {"help", no_argument, nullptr, 'h'},
        {nullptr, 0, nullptr, 0},
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "m:s:i:h", long_opts, nullptr)) != -1) {
        switch (opt) {
        case 'm':
            model_path = optarg;
            break;
        case 's':
            socket_path = optarg;
            break;
        case 'i':
            if (sscanf(optarg, "%dx%d", &input_w, &input_h) != 2) {
                fprintf(stderr, "[ERROR] Invalid --input-size\n");
                return 1;
            }
            break;
        default:
            print_usage(argv[0]);
            return opt == 'h' ? 0 : 1;
        }
    }

    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGPIPE, SIG_IGN);

    int ret = AX_SYS_Init();
    if (ret != 0) {
        return 1;
    }

    // VDEC must be fully set up BEFORE AX_ENGINE_Init.
    // ENGINE_Init spawns NPU threads that interfere with VDEC channel output.
    // All VDEC structs heap-allocated — stack alignment issues with AX650 BSP.
    bool vdec_ok = false;
    AX_POOL vdec_pool_id = AX_INVALID_POOLID;
    {
        auto* vdec_mod = new AX_VDEC_MOD_ATTR_T();
        memset(vdec_mod, 0, sizeof(*vdec_mod));
        vdec_mod->u32MaxGroupCount = 16;
        vdec_mod->enDecModule = AX_ENABLE_BOTH_VDEC_JDEC;
        ret = AX_VDEC_Init(vdec_mod);
        delete vdec_mod;
        if (ret != 0) {
            fprintf(stderr, "[WARN] AX_VDEC_Init: 0x%x (stream unavailable)\n", ret);
        } else {
            // Pre-create group + start recv before model load.
            auto* ga = new AX_VDEC_GRP_ATTR_T();
            memset(ga, 0, sizeof(*ga));
            ga->enCodecType = PT_H265;
            ga->enInputMode = AX_VDEC_INPUT_MODE_STREAM;
            ga->u32MaxPicWidth = FRAME_W;
            ga->u32MaxPicHeight = FRAME_H;
            ga->u32StreamBufSize = STREAM_BUF_SIZE;
            ga->bSdkAutoFramePool = AX_FALSE;
            ret = AX_VDEC_CreateGrp(VDEC_GRP, ga);
            delete ga;
            if (ret != 0) {
                fprintf(stderr, "[WARN] AX_VDEC_CreateGrp: 0x%x\n", ret);
                AX_VDEC_Deinit();
            } else {
                // Set channel attributes with stride alignment.
                auto* ca = new AX_VDEC_CHN_ATTR_T();
                memset(ca, 0, sizeof(*ca));
                ca->u32PicWidth = FRAME_W;
                ca->u32PicHeight = FRAME_H;
                ca->u32OutputFifoDepth = 4;
                ca->u32FrameBufCnt = 5;
                ca->enOutputMode = AX_VDEC_OUTPUT_ORIGINAL;
                ca->enImgFormat = AX_FORMAT_YUV420_SEMIPLANAR;
                // Stride: align width to 128 bytes (ax-pipeline pattern).
                ca->u32FrameStride = ((FRAME_W + 127) & ~127);
                ca->u32FramePadding = 0;
                ca->u32ScaleRatioX = 1;
                ca->u32ScaleRatioY = 1;
                ret = AX_VDEC_SetChnAttr(VDEC_GRP, VDEC_CHN, ca);
                delete ca;
                if (ret != 0) {
                    fprintf(stderr, "[WARN] AX_VDEC_SetChnAttr: 0x%x\n", ret);
                    AX_VDEC_DestroyGrp(VDEC_GRP);
                    AX_VDEC_Deinit();
                    goto vdec_done;
                }
                ret = AX_VDEC_EnableChn(VDEC_GRP, VDEC_CHN);
                if (ret != 0) {
                    fprintf(stderr, "[WARN] AX_VDEC_EnableChn: 0x%x\n", ret);
                    AX_VDEC_DestroyGrp(VDEC_GRP);
                    AX_VDEC_Deinit();
                    goto vdec_done;
                }

                // Manual frame pool (bSdkAutoFramePool=FALSE requires this).
                // NV12: stride * height * 3/2, with generous sizing for decoder.
                const AX_U32 stride = ((FRAME_W + 127) & ~127);
                const AX_U32 frame_buf_size = stride * FRAME_H * 3 / 2;
                AX_POOL_CONFIG_T pool_cfg = {};
                pool_cfg.MetaSize = 512;
                pool_cfg.BlkCnt = 10;
                pool_cfg.BlkSize = frame_buf_size;
                pool_cfg.CacheMode = POOL_CACHE_MODE_NONCACHE;
                strcpy((char*)pool_cfg.PartitionName, "anonymous");
                const AX_POOL pool_id = AX_POOL_CreatePool(&pool_cfg);
                if (pool_id == AX_INVALID_POOLID) {
                    fprintf(stderr, "[WARN] AX_POOL_CreatePool failed\n");
                    AX_VDEC_DestroyGrp(VDEC_GRP);
                    AX_VDEC_Deinit();
                } else {
                    ret = AX_VDEC_AttachPool(VDEC_GRP, VDEC_CHN, pool_id);
                    if (ret != 0) {
                        fprintf(stderr, "[WARN] AX_VDEC_AttachPool: 0x%x\n", ret);
                        AX_POOL_DestroyPool(pool_id);
                        AX_VDEC_DestroyGrp(VDEC_GRP);
                        AX_VDEC_Deinit();
                    } else {
                        fprintf(stderr, "[INFO] VDEC pool created (blk=%u, cnt=10)\n",
                                frame_buf_size);
                        vdec_ok = true;
                        vdec_pool_id = pool_id;
                        fprintf(stderr, "[INFO] VDEC HW ready (StartRecvStream deferred)\n");
                    }
                }
            }
        }
    }
vdec_done:

    // ENGINE_Init after VDEC setup — order matters for V3.6.4 BSP.
    AX_ENGINE_NPU_ATTR_T npu_attr = {};
    npu_attr.eHardMode = AX_ENGINE_VIRTUAL_NPU_DISABLE;
    ret = AX_ENGINE_Init(&npu_attr);
    if (ret != 0) {
        fprintf(stderr, "[WARN] AX_ENGINE_Init: 0x%x\n", ret);
    }
    fprintf(stderr, "[INFO] AX Engine %s\n", AX_ENGINE_GetVersion());

    const bool ivps_ok = AX_IVPS_Init() == 0;
    if (ivps_ok) {
        fprintf(stderr, "[INFO] IVPS HW enabled\n");
    }

    AxModel model;
    model.input_w = input_w;
    model.input_h = input_h;
    model.ivps_ready = ivps_ok;
    model.vdec_ready = vdec_ok;
    model.vdec_pool_id = vdec_pool_id;
    if (load_model(model, model_path, input_w, input_h) != 0) {
        return 1;
    }

    g_listen_fd = create_listen_socket(socket_path.c_str());
    if (g_listen_fd < 0) {
        return 1;
    }
    fprintf(stderr, "[INFO] Listening on %s\n", socket_path.c_str());

    // StartRecvStream AFTER all init (ENGINE/IVPS/model/socket).
    // Calling it before ENGINE_Init breaks GetChnFrame channel output.
    if (vdec_ok) {
        auto* rp = new AX_VDEC_RECV_PIC_PARAM_T();
        memset(rp, 0, sizeof(*rp));
        rp->s32RecvPicNum = -1;
        ret = AX_VDEC_StartRecvStream(VDEC_GRP, rp);
        delete rp;
        if (ret != 0) {
            fprintf(stderr, "[WARN] AX_VDEC_StartRecvStream: 0x%x\n", ret);
            vdec_ok = false;
            model.vdec_ready = false;
        } else {
            fprintf(stderr, "[INFO] VDEC StartRecvStream OK\n");
        }
    }

    while (g_running) {
        const int cfd = accept(g_listen_fd, nullptr, nullptr);
        if (cfd < 0) {
            if (!g_running || errno == EINTR) {
                continue;
            }
            perror("accept");
            continue;
        }

        RequestHeader req = {};
        if (read_exact(cfd, &req, sizeof(req))) {
            switch (req.cmd) {
            case CMD_DETECT:
                handle_detect(cfd, model, req);
                break;
            case CMD_LOAD:
                handle_load(cfd, model, req);
                break;
            case CMD_UNLOAD:
                handle_unload(cfd, model);
                break;
            case CMD_STATUS:
                handle_status(cfd, model);
                break;
            case CMD_STREAM: {
                // NOTE: VDEC GetChnFrame only works from main() scope on AX650 BSP V3.6.4.
                // Calling it from a separate function causes BUF_EMPTY despite successful decode.
                std::string shost(req.payload_size, '\0');
                if (req.payload_size > 0 && !read_exact(cfd, shost.data(), req.payload_size)) {
                    send_error(cfd, "read host failed");
                    break;
                }
                if (shost.empty() || !model.vdec_ready) {
                    send_error(cfd, shost.empty() ? "missing host" : "vdec not ready");
                    break;
                }
                fprintf(stderr, "[STREAM] Connecting to %s:%d\n", shost.c_str(), STREAM_RELAY_PORT);
                const int stcp = tcp_connect(shost.c_str(), STREAM_RELAY_PORT);
                if (stcp < 0) {
                    send_error(cfd, "tcp connect failed");
                    break;
                }
                // Send initial OK.
                {
                    std::vector<Detection> empty;
                    if (!send_detections(cfd, empty, 0)) {
                        shutdown(stcp, SHUT_RDWR);
                        close(stcp);
                        break;
                    }
                }
                fprintf(stderr, "[STREAM] Started (%dx%d H.265)\n", FRAME_W, FRAME_H);
                {
                    uint8_t sbuf[256 * 1024];
                    int sends = 0, decoded = 0;
                    const int clahe_interval = 128;
                    std::vector<uint8_t> clahe_y; // Cached CLAHE Y plane.
                    auto last_hb = std::chrono::steady_clock::now();
                    bool stream_alive = true;

                    // poll() multiplexing: accept other commands during stream.
                    // pfds[0] = stream TCP (H.265 source from rdk-x5)
                    // pfds[1] = listen socket (new daemon connections)
                    // pfds[2] = stream client (detect disconnect)
                    while (g_running && stream_alive) {
                        struct pollfd pfds[3];
                        pfds[0].fd = stcp;
                        pfds[0].events = POLLIN;
                        pfds[1].fd = g_listen_fd;
                        pfds[1].events = POLLIN;
                        pfds[2].fd = cfd;
                        pfds[2].events = 0; // only POLLHUP/POLLERR

                        const int pr = poll(pfds, 3, 1000); // 1s timeout for heartbeat check
                        if (pr < 0) {
                            if (errno == EINTR)
                                continue;
                            break;
                        }

                        // Stream client disconnected?
                        if (pfds[2].revents & (POLLHUP | POLLERR)) {
                            fprintf(stderr, "[STREAM] Client disconnected\n");
                            break;
                        }

                        // Handle new connections on listen socket during stream.
                        if (pfds[1].revents & POLLIN) {
                            const int new_cfd = accept(g_listen_fd, nullptr, nullptr);
                            if (new_cfd >= 0) {
                                // Short recv timeout for inline handling.
                                const struct timeval tv = {2, 0};
                                setsockopt(new_cfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
                                RequestHeader new_req = {};
                                if (read_exact(new_cfd, &new_req, sizeof(new_req))) {
                                    switch (new_req.cmd) {
                                    case CMD_DETECT:
                                        handle_detect(new_cfd, model, new_req);
                                        break;
                                    case CMD_LOAD:
                                        handle_load(new_cfd, model, new_req);
                                        break;
                                    case CMD_UNLOAD:
                                        handle_unload(new_cfd, model);
                                        break;
                                    case CMD_STATUS:
                                        handle_status(new_cfd, model);
                                        break;
                                    case CMD_STREAM: {
                                        // Drain payload before rejecting.
                                        if (new_req.payload_size > 0) {
                                            std::vector<uint8_t> drain(new_req.payload_size);
                                            read_exact(new_cfd, drain.data(), new_req.payload_size);
                                        }
                                        send_error(new_cfd, "stream already active");
                                    } break;
                                    default:
                                        send_error(new_cfd, "unknown command");
                                        break;
                                    }
                                }
                                close(new_cfd);
                            }
                        }

                        // Process stream data from TCP source.
                        if (pfds[0].revents & POLLIN) {
                            const ssize_t nr = recv(stcp, sbuf, sizeof(sbuf), 0);
                            if (nr <= 0) {
                                if (nr == 0 || (errno != EAGAIN && errno != EINTR))
                                    fprintf(stderr, "[STREAM] %s\n",
                                            nr == 0 ? "EOF" : strerror(errno));
                                break;
                            }
                            AX_VDEC_STREAM_T st = {};
                            st.pu8Addr = sbuf;
                            st.u32StreamPackLen = nr;
                            AX_VDEC_SendStream(VDEC_GRP, &st, -1);
                            sends++;

                            AX_VIDEO_FRAME_INFO_T fi = {};
                            if (AX_VDEC_GetChnFrame(VDEC_GRP, VDEC_CHN, &fi, 100) == 0) {
                                const auto& vf = fi.stVFrame;
                                const int fw = vf.u32Width, fh = vf.u32Height;
                                const int ysz = fw * fh;
                                const int nv12sz = ysz * 3 / 2;

                                // Mmap VDEC output (phy-only pool).
                                void* const nv12_map =
                                    (fw > 0 && fh > 0 && vf.u64PhyAddr[0] && !vf.u64VirAddr[0])
                                        ? AX_SYS_Mmap(vf.u64PhyAddr[0], nv12sz)
                                        : nullptr;
                                uint8_t* const y = vf.u64VirAddr[0]
                                                       ? (uint8_t*)(uintptr_t)vf.u64VirAddr[0]
                                                       : (uint8_t*)nv12_map;
                                uint8_t* const uv = y ? y + ysz : nullptr;

                                if (y && uv) {
                                    // CLAHE: recompute Y every N frames, cache result.
                                    if ((decoded % clahe_interval) == 0) {
                                        clahe_y.resize(ysz);
                                        median_blur_3x3(y, clahe_y.data(), fw, fh);
                                        std::vector<uint8_t> tmp(clahe_y);
                                        clahe_y_plane(tmp.data(), clahe_y.data(), fw, fh);
                                    }
                                    if (!clahe_y.empty())
                                        memcpy(y, clahe_y.data(), ysz);
                                    memset(uv, 128, ysz / 2);

                                    // IVPS HW NV12→BGR letterbox + NPU inference.
                                    if (model.ivps_ready && model.handle) {
                                        AX_VIDEO_FRAME_T sf = {};
                                        sf.u32Width = fw;
                                        sf.u32Height = fh;
                                        sf.enImgFormat = AX_FORMAT_YUV420_SEMIPLANAR;
                                        sf.u32PicStride[0] = vf.u32PicStride[0];
                                        sf.u64PhyAddr[0] = vf.u64PhyAddr[0];
                                        sf.u64VirAddr[0] = (AX_U64)(uintptr_t)y;
                                        sf.u64PhyAddr[1] = vf.u64PhyAddr[0] + ysz;
                                        sf.u64VirAddr[1] = (AX_U64)(uintptr_t)uv;
                                        AX_VIDEO_FRAME_T df = {};
                                        df.u32Width = model.input_w;
                                        df.u32Height = model.input_h;
                                        df.enImgFormat = AX_FORMAT_BGR888;
                                        df.u32PicStride[0] = model.input_w * 3;
                                        df.u64PhyAddr[0] = model.io_data.pInputs[0].phyAddr;
                                        df.u64VirAddr[0] =
                                            (AX_U64)(uintptr_t)model.io_data.pInputs[0].pVirAddr;
                                        df.u32FrameSize = model.io_data.pInputs[0].nSize;
                                        AX_IVPS_ASPECT_RATIO_T ar = {};
                                        ar.eMode = AX_IVPS_ASPECT_RATIO_AUTO;
                                        ar.nBgColor = 0x727272;
                                        ar.eAligns[0] = AX_IVPS_ASPECT_RATIO_HORIZONTAL_CENTER;
                                        ar.eAligns[1] = AX_IVPS_ASPECT_RATIO_VERTICAL_CENTER;
                                        if (AX_IVPS_CropResizeTdp(&sf, &df, &ar) == 0) {
                                            AX_SYS_MinvalidateCache(
                                                model.io_data.pInputs[0].phyAddr,
                                                model.io_data.pInputs[0].pVirAddr,
                                                model.io_data.pInputs[0].nSize);
                                            std::vector<Detection> dets;
                                            double ms = 0;
                                            const auto t0 = std::chrono::steady_clock::now();
                                            run_npu_and_postprocess(model, fw, fh, dets, ms, t0);
                                            if (!dets.empty()) {
                                                if (!send_detections(cfd, dets, (float)ms))
                                                    stream_alive = false;
                                            }
                                        }
                                    }
                                    decoded++;
                                }

                                if (nv12_map)
                                    AX_SYS_Munmap(nv12_map, nv12sz);
                                AX_VDEC_ReleaseChnFrame(VDEC_GRP, VDEC_CHN, &fi);
                            }
                        } else if (pfds[0].revents & (POLLHUP | POLLERR)) {
                            fprintf(stderr, "[STREAM] TCP source disconnected\n");
                            break;
                        }

                        // Heartbeat.
                        auto now = std::chrono::steady_clock::now();
                        if (std::chrono::duration_cast<std::chrono::seconds>(now - last_hb)
                                .count() >= STREAM_HEARTBEAT_SEC) {
                            std::vector<Detection> empty;
                            if (!send_detections(cfd, empty, 0))
                                break;
                            fprintf(stderr, "[STREAM] sends=%d decoded=%d\n", sends, decoded);
                            last_hb = now;
                        }
                    }
                    fprintf(stderr, "[STREAM] Ended (sends=%d decoded=%d)\n", sends, decoded);
                }
                shutdown(stcp, SHUT_RDWR);
                close(stcp);
            } break;
            default:
                send_error(cfd, "unknown command");
                break;
            }
        }
        close(cfd);
    }

    if (g_listen_fd >= 0) {
        close(g_listen_fd);
    }
    unlink(socket_path.c_str());
    if (model.nv12_vir) {
        AX_SYS_MemFree(model.nv12_phy, model.nv12_vir);
    }
    unload_model(model);
    if (ivps_ok) {
        AX_IVPS_Deinit();
    }
    if (vdec_ok) {
        AX_VDEC_StopRecvStream(VDEC_GRP);
        AX_VDEC_DisableChn(VDEC_GRP, VDEC_CHN);
        AX_VDEC_DetachPool(VDEC_GRP, VDEC_CHN);
        AX_VDEC_DestroyGrp(VDEC_GRP);
        if (model.vdec_pool_id != AX_INVALID_POOLID) {
            AX_POOL_DestroyPool(model.vdec_pool_id);
        }
        AX_VDEC_Deinit();
    }
    AX_ENGINE_Deinit();
    AX_SYS_Deinit();
    return 0;
}
