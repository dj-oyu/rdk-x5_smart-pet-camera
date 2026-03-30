// ax_yolo_daemon — Persistent YOLO NPU detection daemon for AX650.
//
// Loads an axmodel once, listens on a Unix socket, and serves detection
// requests via fixed-length binary protocol.  Eliminates ~900ms model-load
// overhead per invocation by keeping the model resident in CMM.
//
// Protocol: see struct RequestHeader / ResponseHeader / WireDetection.
//
// BSD 3-Clause License (follows ax-pipeline conventions).

#include <ax_engine_api.h>
#include <ax_sys_api.h>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include <errno.h>
#include <getopt.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

// ---------------------------------------------------------------------------
// Wire protocol (shared with Rust client via #[repr(C)])
// ---------------------------------------------------------------------------

// Commands
static constexpr uint16_t CMD_DETECT = 0;
static constexpr uint16_t CMD_LOAD = 1;
static constexpr uint16_t CMD_UNLOAD = 2;
static constexpr uint16_t CMD_STATUS = 3;

// Input types for CMD_DETECT
static constexpr uint16_t INPUT_JPEG_PATH = 0;
static constexpr uint16_t INPUT_NV12_RAW = 1;

#pragma pack(push, 1)

struct RequestHeader {
    uint16_t cmd;          // CMD_*
    uint16_t input_type;   // INPUT_* (detect only)
    uint16_t width;        // NV12_RAW: frame width; JPEG_PATH: 0
    uint16_t height;       // NV12_RAW: frame height; JPEG_PATH: 0
    uint32_t payload_size; // bytes following this header
    uint32_t reserved;     // must be 0
};

struct ResponseHeader {
    uint16_t status;     // 0=ok, 1=error
    uint16_t det_count;  // number of WireDetection structs following
    float elapsed_ms;    // inference time
    uint32_t error_len;  // if status=1, bytes of error string following
};

struct WireDetection {
    int16_t x1, y1, x2, y2;
    uint16_t class_id;
    uint16_t confidence; // prob × 10000
};

#pragma pack(pop)

static_assert(sizeof(RequestHeader) == 16, "RequestHeader must be 16 bytes");
static_assert(sizeof(ResponseHeader) == 12, "ResponseHeader must be 12 bytes");
static_assert(sizeof(WireDetection) == 12, "WireDetection must be 12 bytes");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

static constexpr int DEFAULT_INPUT_W = 640;
static constexpr int DEFAULT_INPUT_H = 640;
static constexpr float SCORE_THRESHOLD = 0.25f;
static constexpr float NMS_THRESHOLD = 0.45f;
static constexpr int CLS_NUM = 80;
static constexpr int CMM_ALIGN = 128;
static const char* CMM_TOKEN = "ax_yolo_daemon";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

static volatile sig_atomic_t g_running = 1;
static int g_listen_fd = -1;

static void signal_handler(int /*sig*/) {
    g_running = 0;
    if (g_listen_fd >= 0) {
        close(g_listen_fd);
        g_listen_fd = -1;
    }
}

// ---------------------------------------------------------------------------
// YOLO post-processing (yolo26 separated-head format)
// ---------------------------------------------------------------------------

struct Detection {
    int class_id;
    float confidence;
    float x1, y1, x2, y2;
};

static float sigmoid(float x) {
    return 1.f / (1.f + std::exp(-x));
}

static void generate_proposals_separated(int stride, const float* bbox_feat,
                                         const float* cls_feat, float prob_threshold,
                                         std::vector<Detection>& dets, int input_w,
                                         int input_h, int cls_num) {
    const int feat_w = input_w / stride;
    const int feat_h = input_h / stride;

    for (int h = 0; h < feat_h; ++h) {
        for (int w = 0; w < feat_w; ++w) {
            const int idx = h * feat_w + w;
            const float* cls_ptr = cls_feat + idx * cls_num;

            int best_cls = 0;
            float best_score = -1e9f;
            for (int c = 0; c < cls_num; ++c) {
                if (cls_ptr[c] > best_score) {
                    best_score = cls_ptr[c];
                    best_cls = c;
                }
            }
            const float prob = sigmoid(best_score);
            if (prob > prob_threshold) {
                const float* box = bbox_feat + idx * 4;
                const float gx = w + 0.5f;
                const float gy = h + 0.5f;
                Detection d;
                d.class_id = best_cls;
                d.confidence = prob;
                d.x1 = std::max((gx - box[0]) * stride, 0.f);
                d.y1 = std::max((gy - box[1]) * stride, 0.f);
                d.x2 = std::min((gx + box[2]) * stride, (float)(input_w - 1));
                d.y2 = std::min((gy + box[3]) * stride, (float)(input_h - 1));
                if (d.x2 > d.x1 && d.y2 > d.y1) {
                    dets.push_back(d);
                }
            }
        }
    }
}

static float iou(const Detection& a, const Detection& b) {
    const float ix1 = std::max(a.x1, b.x1);
    const float iy1 = std::max(a.y1, b.y1);
    const float ix2 = std::min(a.x2, b.x2);
    const float iy2 = std::min(a.y2, b.y2);
    const float inter = std::max(ix2 - ix1, 0.f) * std::max(iy2 - iy1, 0.f);
    const float area_a = (a.x2 - a.x1) * (a.y2 - a.y1);
    const float area_b = (b.x2 - b.x1) * (b.y2 - b.y1);
    const float uni = area_a + area_b - inter;
    return uni > 0.f ? inter / uni : 0.f;
}

static void nms(std::vector<Detection>& dets, float nms_threshold) {
    std::sort(dets.begin(), dets.end(),
              [](const Detection& a, const Detection& b) { return a.confidence > b.confidence; });
    std::vector<Detection> kept;
    for (const auto& d : dets) {
        bool suppressed = false;
        for (const auto& k : kept) {
            if (iou(d, k) > nms_threshold) {
                suppressed = true;
                break;
            }
        }
        if (!suppressed) {
            kept.push_back(d);
        }
    }
    dets = std::move(kept);
}

static void scale_detections(std::vector<Detection>& dets, int input_w, int input_h, int orig_w,
                             int orig_h) {
    const float scale = std::min((float)input_w / orig_w, (float)input_h / orig_h);
    const int new_w = (int)(scale * orig_w);
    const int new_h = (int)(scale * orig_h);
    const float pad_w = (input_w - new_w) / 2.f;
    const float pad_h = (input_h - new_h) / 2.f;
    const float ratio_x = (float)orig_w / new_w;
    const float ratio_y = (float)orig_h / new_h;

    for (auto& d : dets) {
        d.x1 = std::max((d.x1 - pad_w) * ratio_x, 0.f);
        d.y1 = std::max((d.y1 - pad_h) * ratio_y, 0.f);
        d.x2 = std::min((d.x2 - pad_w) * ratio_x, (float)(orig_w - 1));
        d.y2 = std::min((d.y2 - pad_h) * ratio_y, (float)(orig_h - 1));
    }
}

// ---------------------------------------------------------------------------
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
};

static void free_io(AX_ENGINE_IO_T* io) {
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

static int load_model(AxModel& m, const std::string& path, int input_w, int input_h) {
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
        fprintf(stderr, "[ERROR] AX_ENGINE_CreateHandle failed: 0x%x\n", ret);
        return ret;
    }

    ret = AX_ENGINE_CreateContext(m.handle);
    if (ret != 0) {
        fprintf(stderr, "[ERROR] AX_ENGINE_CreateContext failed: 0x%x\n", ret);
        AX_ENGINE_DestroyHandle(m.handle);
        m.handle = nullptr;
        return ret;
    }

    ret = AX_ENGINE_GetIOInfo(m.handle, &m.io_info);
    if (ret != 0) {
        fprintf(stderr, "[ERROR] AX_ENGINE_GetIOInfo failed: 0x%x\n", ret);
        AX_ENGINE_DestroyHandle(m.handle);
        m.handle = nullptr;
        return ret;
    }

    memset(&m.io_data, 0, sizeof(m.io_data));

    // Input: cached CMM (must flush after memcpy).
    m.io_data.nInputSize = m.io_info->nInputSize;
    m.io_data.pInputs = new AX_ENGINE_IO_BUFFER_T[m.io_info->nInputSize]();
    for (uint32_t i = 0; i < m.io_info->nInputSize; ++i) {
        auto& buf = m.io_data.pInputs[i];
        buf.nSize = m.io_info->pInputs[i].nSize;
        ret = AX_SYS_MemAllocCached(&buf.phyAddr, &buf.pVirAddr, buf.nSize, CMM_ALIGN,
                                     (const AX_S8*)CMM_TOKEN);
        if (ret != 0) {
            fprintf(stderr, "[ERROR] AX_SYS_MemAllocCached input[%u] failed: 0x%x\n", i, ret);
            return ret;
        }
    }

    // Outputs: cached CMM.
    m.io_data.nOutputSize = m.io_info->nOutputSize;
    m.io_data.pOutputs = new AX_ENGINE_IO_BUFFER_T[m.io_info->nOutputSize]();
    for (uint32_t i = 0; i < m.io_info->nOutputSize; ++i) {
        auto& buf = m.io_data.pOutputs[i];
        buf.nSize = m.io_info->pOutputs[i].nSize;
        ret = AX_SYS_MemAllocCached(&buf.phyAddr, &buf.pVirAddr, buf.nSize, CMM_ALIGN,
                                     (const AX_S8*)CMM_TOKEN);
        if (ret != 0) {
            fprintf(stderr, "[ERROR] AX_SYS_MemAllocCached output[%u] failed: 0x%x\n", i, ret);
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

    fprintf(stderr, "[INFO] Model loaded: %s (CMM %u KB, input %dx%d, %s)\n", path.c_str(),
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
    fprintf(stderr, "[INFO] Model unloaded\n");
}

// ---------------------------------------------------------------------------
// Image preprocessing
// ---------------------------------------------------------------------------

static cv::Mat preprocess(const cv::Mat& src, int target_w, int target_h, ModelColorSpace cs) {
    const float scale = std::min((float)target_w / src.cols, (float)target_h / src.rows);
    const int new_w = (int)(scale * src.cols);
    const int new_h = (int)(scale * src.rows);

    cv::Mat resized;
    cv::resize(src, resized, cv::Size(new_w, new_h));

    cv::Mat padded(target_h, target_w, CV_8UC3, cv::Scalar(114, 114, 114));
    const int dx = (target_w - new_w) / 2;
    const int dy = (target_h - new_h) / 2;
    resized.copyTo(padded(cv::Rect(dx, dy, new_w, new_h)));

    if (cs == ModelColorSpace::NV12) {
        cv::Mat yuv;
        cv::cvtColor(padded, yuv, cv::COLOR_BGR2YUV_I420);
        const int y_size = target_w * target_h;
        const int uv_h = target_h / 2;
        const int uv_w = target_w / 2;
        cv::Mat nv12(target_h * 3 / 2, target_w, CV_8UC1);
        memcpy(nv12.data, yuv.data, y_size);
        const uint8_t* u_plane = yuv.data + y_size;
        const uint8_t* v_plane = u_plane + uv_h * uv_w;
        uint8_t* uv_dst = nv12.data + y_size;
        for (int i = 0; i < uv_h * uv_w; ++i) {
            uv_dst[2 * i] = u_plane[i];
            uv_dst[2 * i + 1] = v_plane[i];
        }
        return nv12;
    }

    if (cs == ModelColorSpace::RGB) {
        cv::cvtColor(padded, padded, cv::COLOR_BGR2RGB);
    }
    return padded;
}

// Preprocess NV12 raw frame: convert to BGR, then letterbox.
static cv::Mat preprocess_nv12(const uint8_t* nv12, int src_w, int src_h, int target_w,
                               int target_h, ModelColorSpace cs) {
    cv::Mat nv12_mat(src_h * 3 / 2, src_w, CV_8UC1, const_cast<uint8_t*>(nv12));
    cv::Mat bgr;
    cv::cvtColor(nv12_mat, bgr, cv::COLOR_YUV2BGR_NV12);
    return preprocess(bgr, target_w, target_h, cs);
}

// ---------------------------------------------------------------------------
// Run inference
// ---------------------------------------------------------------------------

static int run_inference(AxModel& m, const cv::Mat& input, int orig_w, int orig_h,
                         std::vector<Detection>& results, double& elapsed_ms) {
    results.clear();
    const auto t0 = std::chrono::steady_clock::now();

    const size_t data_size = input.total() * input.elemSize();
    const size_t buf_size = m.io_data.pInputs[0].nSize;
    memcpy(m.io_data.pInputs[0].pVirAddr, input.data, std::min(data_size, buf_size));
    AX_SYS_MflushCache(m.io_data.pInputs[0].phyAddr, m.io_data.pInputs[0].pVirAddr,
                        m.io_data.pInputs[0].nSize);

    const int ret = AX_ENGINE_RunSync(m.handle, &m.io_data);
    if (ret != 0) {
        fprintf(stderr, "[ERROR] AX_ENGINE_RunSync failed: 0x%x\n", ret);
        return ret;
    }

    for (uint32_t i = 0; i < m.io_data.nOutputSize; ++i) {
        AX_SYS_MinvalidateCache(m.io_data.pOutputs[i].phyAddr, m.io_data.pOutputs[i].pVirAddr,
                                m.io_data.pOutputs[i].nSize);
    }

    const uint32_t num_outputs = m.io_data.nOutputSize;
    for (uint32_t i = 0; i + 1 < num_outputs; i += 2) {
        const auto& bbox_meta = m.io_info->pOutputs[i];
        const int feat_w = bbox_meta.nShapeSize >= 4 ? bbox_meta.pShape[2] : 0;
        if (feat_w <= 0) {
            continue;
        }
        const int stride = m.input_w / feat_w;
        const auto& cls_meta = m.io_info->pOutputs[i + 1];
        const int cls_ch = cls_meta.nShapeSize >= 4 ? cls_meta.pShape[3] : CLS_NUM;
        const float* bbox_data = (const float*)m.io_data.pOutputs[i].pVirAddr;
        const float* cls_data = (const float*)m.io_data.pOutputs[i + 1].pVirAddr;
        generate_proposals_separated(stride, bbox_data, cls_data, SCORE_THRESHOLD, results,
                                     m.input_w, m.input_h, cls_ch);
    }

    nms(results, NMS_THRESHOLD);
    scale_detections(results, m.input_w, m.input_h, orig_w, orig_h);

    const auto t1 = std::chrono::steady_clock::now();
    elapsed_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
    return 0;
}

// ---------------------------------------------------------------------------
// Socket I/O helpers
// ---------------------------------------------------------------------------

static bool read_exact(int fd, void* buf, size_t n) {
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

static bool write_exact(int fd, const void* buf, size_t n) {
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

static int create_listen_socket(const char* socket_path) {
    unlink(socket_path);

    const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        return -1;
    }

    struct sockaddr_un addr = {};
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, socket_path, sizeof(addr.sun_path) - 1);

    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(fd);
        return -1;
    }

    chmod(socket_path, 0666);

    if (listen(fd, 4) < 0) {
        perror("listen");
        close(fd);
        return -1;
    }

    return fd;
}

// ---------------------------------------------------------------------------
// Send response helpers
// ---------------------------------------------------------------------------

static void send_ok(int fd, const std::vector<Detection>& dets, float elapsed_ms) {
    const uint16_t count = (uint16_t)std::min(dets.size(), (size_t)UINT16_MAX);
    ResponseHeader hdr = {};
    hdr.status = 0;
    hdr.det_count = count;
    hdr.elapsed_ms = elapsed_ms;
    hdr.error_len = 0;
    write_exact(fd, &hdr, sizeof(hdr));

    for (uint16_t i = 0; i < count; ++i) {
        const auto& d = dets[i];
        WireDetection wd = {};
        wd.x1 = (int16_t)std::clamp(d.x1, -32768.f, 32767.f);
        wd.y1 = (int16_t)std::clamp(d.y1, -32768.f, 32767.f);
        wd.x2 = (int16_t)std::clamp(d.x2, -32768.f, 32767.f);
        wd.y2 = (int16_t)std::clamp(d.y2, -32768.f, 32767.f);
        wd.class_id = (uint16_t)d.class_id;
        wd.confidence = (uint16_t)(d.confidence * 10000.f);
        write_exact(fd, &wd, sizeof(wd));
    }
}

static void send_error(int fd, const char* msg) {
    const uint32_t len = (uint32_t)strlen(msg);
    ResponseHeader hdr = {};
    hdr.status = 1;
    hdr.det_count = 0;
    hdr.elapsed_ms = 0;
    hdr.error_len = len;
    write_exact(fd, &hdr, sizeof(hdr));
    if (len > 0) {
        write_exact(fd, msg, len);
    }
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

static void handle_detect(int fd, AxModel& m, const RequestHeader& req) {
    if (!m.handle) {
        send_error(fd, "no model loaded");
        return;
    }

    std::vector<Detection> dets;
    double ms = 0;

    if (req.input_type == INPUT_JPEG_PATH) {
        // Read file path from payload.
        std::string path(req.payload_size, '\0');
        if (!read_exact(fd, path.data(), req.payload_size)) {
            send_error(fd, "read path failed");
            return;
        }

        cv::Mat img = cv::imread(path, cv::IMREAD_COLOR);
        if (img.empty()) {
            send_error(fd, "imread failed");
            return;
        }
        const int orig_w = img.cols;
        const int orig_h = img.rows;
        cv::Mat input = preprocess(img, m.input_w, m.input_h, m.color_space);
        if (run_inference(m, input, orig_w, orig_h, dets, ms) != 0) {
            send_error(fd, "inference failed");
            return;
        }
    } else if (req.input_type == INPUT_NV12_RAW) {
        // Read raw NV12 frame from payload.
        const int src_w = req.width;
        const int src_h = req.height;
        const size_t expected = (size_t)src_w * src_h * 3 / 2;
        if (req.payload_size != expected) {
            // Drain payload to avoid protocol desync.
            std::vector<uint8_t> drain(req.payload_size);
            read_exact(fd, drain.data(), req.payload_size);
            send_error(fd, "nv12 size mismatch");
            return;
        }

        std::vector<uint8_t> nv12(expected);
        if (!read_exact(fd, nv12.data(), expected)) {
            send_error(fd, "read nv12 failed");
            return;
        }

        cv::Mat input = preprocess_nv12(nv12.data(), src_w, src_h, m.input_w, m.input_h,
                                        m.color_space);
        if (run_inference(m, input, src_w, src_h, dets, ms) != 0) {
            send_error(fd, "inference failed");
            return;
        }
    } else {
        // Drain unknown payload.
        if (req.payload_size > 0) {
            std::vector<uint8_t> drain(req.payload_size);
            read_exact(fd, drain.data(), req.payload_size);
        }
        send_error(fd, "unknown input_type");
        return;
    }

    send_ok(fd, dets, (float)ms);
}

static void handle_load(int fd, AxModel& m, const RequestHeader& req) {
    std::string path(req.payload_size, '\0');
    if (req.payload_size > 0 && !read_exact(fd, path.data(), req.payload_size)) {
        send_error(fd, "read path failed");
        return;
    }
    if (path.empty()) {
        send_error(fd, "missing model path");
        return;
    }

    unload_model(m);
    const int ret = load_model(m, path, m.input_w > 0 ? m.input_w : DEFAULT_INPUT_W,
                               m.input_h > 0 ? m.input_h : DEFAULT_INPUT_H);
    if (ret != 0) {
        send_error(fd, "load failed");
        return;
    }

    // Send ok with 0 detections.
    std::vector<Detection> empty;
    send_ok(fd, empty, 0);
}

static void handle_unload(int fd, AxModel& m) {
    unload_model(m);
    std::vector<Detection> empty;
    send_ok(fd, empty, 0);
}

static void handle_status(int fd, const AxModel& m) {
    // Encode status as: ok + 0 dets + elapsed_ms = CMM KB (repurposed).
    std::vector<Detection> empty;
    send_ok(fd, empty, m.handle ? (float)(m.cmm_bytes / 1024) : 0.f);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

static void print_usage(const char* prog) {
    fprintf(stderr,
            "Usage: %s --model <path> [options]\n"
            "  --model <path>           axmodel file path (required)\n"
            "  --socket <path>          Unix socket path (default: /run/ax_yolo_daemon.sock)\n"
            "  --min-headroom-mb <N>    CMM headroom threshold (default: 40)\n"
            "  --input-size <WxH>       Model input size (default: 640x640)\n",
            prog);
}

int main(int argc, char** argv) {
    std::string model_path;
    std::string socket_path = "/run/ax_yolo_daemon.sock";
    int min_headroom_mb = 40;
    int input_w = DEFAULT_INPUT_W;
    int input_h = DEFAULT_INPUT_H;

    static struct option long_opts[] = {
        {"model", required_argument, nullptr, 'm'},
        {"socket", required_argument, nullptr, 's'},
        {"min-headroom-mb", required_argument, nullptr, 'H'},
        {"input-size", required_argument, nullptr, 'i'},
        {"help", no_argument, nullptr, 'h'},
        {nullptr, 0, nullptr, 0},
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "m:s:H:i:h", long_opts, nullptr)) != -1) {
        switch (opt) {
        case 'm':
            model_path = optarg;
            break;
        case 's':
            socket_path = optarg;
            break;
        case 'H':
            min_headroom_mb = atoi(optarg);
            break;
        case 'i':
            if (sscanf(optarg, "%dx%d", &input_w, &input_h) != 2) {
                fprintf(stderr, "[ERROR] Invalid --input-size: %s (expected WxH)\n", optarg);
                return 1;
            }
            break;
        case 'h':
        default:
            print_usage(argv[0]);
            return opt == 'h' ? 0 : 1;
        }
    }

    if (model_path.empty()) {
        fprintf(stderr, "[ERROR] --model is required\n");
        print_usage(argv[0]);
        return 1;
    }

    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGPIPE, SIG_IGN);

    int ret = AX_SYS_Init();
    if (ret != 0) {
        fprintf(stderr, "[ERROR] AX_SYS_Init failed: 0x%x\n", ret);
        return 1;
    }

    AX_ENGINE_NPU_ATTR_T npu_attr = {};
    npu_attr.eHardMode = AX_ENGINE_VIRTUAL_NPU_DISABLE;
    ret = AX_ENGINE_Init(&npu_attr);
    if (ret != 0) {
        fprintf(stderr, "[WARN] AX_ENGINE_Init failed: 0x%x (trying without Init)\n", ret);
    }

    fprintf(stderr, "[INFO] AX Engine initialized (version: %s)\n", AX_ENGINE_GetVersion());

    AxModel model;
    model.input_w = input_w;
    model.input_h = input_h;
    ret = load_model(model, model_path, input_w, input_h);
    if (ret != 0) {
        AX_ENGINE_Deinit();
        AX_SYS_Deinit();
        return 1;
    }

    g_listen_fd = create_listen_socket(socket_path.c_str());
    if (g_listen_fd < 0) {
        unload_model(model);
        AX_ENGINE_Deinit();
        AX_SYS_Deinit();
        return 1;
    }

    fprintf(stderr, "[INFO] Listening on %s (binary protocol v1)\n", socket_path.c_str());

    while (g_running) {
        const int client_fd = accept(g_listen_fd, nullptr, nullptr);
        if (client_fd < 0) {
            if (!g_running) {
                break;
            }
            if (errno == EINTR) {
                continue;
            }
            perror("accept");
            continue;
        }

        RequestHeader req = {};
        if (read_exact(client_fd, &req, sizeof(req))) {
            switch (req.cmd) {
            case CMD_DETECT:
                handle_detect(client_fd, model, req);
                break;
            case CMD_LOAD:
                handle_load(client_fd, model, req);
                break;
            case CMD_UNLOAD:
                handle_unload(client_fd, model);
                break;
            case CMD_STATUS:
                handle_status(client_fd, model);
                break;
            default:
                send_error(client_fd, "unknown command");
                break;
            }
        }

        close(client_fd);
    }

    fprintf(stderr, "[INFO] Shutting down...\n");
    if (g_listen_fd >= 0) {
        close(g_listen_fd);
    }
    unlink(socket_path.c_str());
    unload_model(model);
    AX_ENGINE_Deinit();
    AX_SYS_Deinit();
    return 0;
}
