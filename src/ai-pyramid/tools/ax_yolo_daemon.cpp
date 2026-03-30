// ax_yolo_daemon — Persistent YOLO NPU detection daemon for AX650.
//
// Loads an axmodel once, listens on a Unix socket, and serves detection
// requests via JSON Lines protocol.  Eliminates ~900ms model-load overhead
// per invocation by keeping the model resident in CMM.
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
// Configuration
// ---------------------------------------------------------------------------

static constexpr int DEFAULT_INPUT_W = 640;
static constexpr int DEFAULT_INPUT_H = 640;
static constexpr float SCORE_THRESHOLD = 0.25f;
static constexpr float NMS_THRESHOLD = 0.45f;
static constexpr int CLS_NUM = 80;
static constexpr int CMM_ALIGN = 128;
static const char* CMM_TOKEN = "ax_yolo_daemon";

// COCO class names (80 classes).
static const char* COCO_NAMES[] = {
    "person",        "bicycle",      "car",
    "motorcycle",    "airplane",     "bus",
    "train",         "truck",        "boat",
    "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench",        "bird",
    "cat",           "dog",          "horse",
    "sheep",         "cow",          "elephant",
    "bear",          "zebra",        "giraffe",
    "backpack",      "umbrella",     "handbag",
    "tie",           "suitcase",     "frisbee",
    "skis",          "snowboard",    "sports ball",
    "kite",          "baseball bat", "baseball glove",
    "skateboard",    "surfboard",    "tennis racket",
    "bottle",        "wine glass",   "cup",
    "fork",          "knife",        "spoon",
    "bowl",          "banana",       "apple",
    "sandwich",      "orange",       "broccoli",
    "carrot",        "hot dog",      "pizza",
    "donut",         "cake",         "chair",
    "couch",         "potted plant", "bed",
    "dining table",  "toilet",       "tv",
    "laptop",        "mouse",        "remote",
    "keyboard",      "cell phone",   "microwave",
    "oven",          "toaster",      "sink",
    "refrigerator",  "book",         "clock",
    "vase",          "scissors",     "teddy bear",
    "hair drier",    "toothbrush",
};

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

static volatile sig_atomic_t g_running = 1;
static int g_listen_fd = -1;

static void signal_handler(int /*sig*/) {
    g_running = 0;
    // Unblock accept() by closing the listen socket.
    if (g_listen_fd >= 0) {
        close(g_listen_fd);
        g_listen_fd = -1;
    }
}

// ---------------------------------------------------------------------------
// YOLO post-processing (yolov8_native / yolo26 compatible)
// ---------------------------------------------------------------------------

struct Detection {
    int class_id;
    float confidence;
    float x1, y1, x2, y2;
};

static float sigmoid(float x) {
    return 1.f / (1.f + std::exp(-x));
}

// Separated-head format: bbox [1,H,W,4] + cls [1,H,W,80], no DFL.
// bbox values are LTRB offsets in grid units — multiply by stride to get pixels.
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

            // Find best class.
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
                // YOLO26 decode: (grid ± box) * stride → xyxy
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

// Scale detections from letterboxed coordinates back to original image.
static void scale_detections(std::vector<Detection>& dets, int input_w, int input_h, int orig_w,
                             int orig_h) {
    const float scale =
        std::min((float)input_w / orig_w, (float)input_h / orig_h);
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
    // Read model file.
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

    // Allocate IO buffers.
    memset(&m.io_data, 0, sizeof(m.io_data));

    // Input: single buffer, cached CMM (must flush after memcpy).
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

    // Outputs.
    m.io_data.nOutputSize = m.io_info->nOutputSize;
    m.io_data.pOutputs = new AX_ENGINE_IO_BUFFER_T[m.io_info->nOutputSize]();
    for (uint32_t i = 0; i < m.io_info->nOutputSize; ++i) {
        auto& buf = m.io_data.pOutputs[i];
        buf.nSize = m.io_info->pOutputs[i].nSize;
        ret = AX_SYS_MemAllocCached(&buf.phyAddr, &buf.pVirAddr, buf.nSize, CMM_ALIGN,
                                     (const AX_S8*)CMM_TOKEN);
        if (ret != 0) {
            fprintf(stderr, "[ERROR] AX_SYS_MemAlloc output[%u] failed: 0x%x\n", i, ret);
            return ret;
        }
    }

    // Query CMM usage.
    AX_ENGINE_CMM_INFO cmm_info = {};
    if (AX_ENGINE_GetCMMUsage(m.handle, &cmm_info) == 0) {
        m.cmm_bytes = cmm_info.nCMMSize;
    }

    // Detect input color space from model metadata.
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
            m.color_space = ModelColorSpace::RGB; // fallback
            cs_name = "unknown(fallback RGB)";
            break;
        }
    }

    m.input_w = input_w;
    m.input_h = input_h;
    m.model_path = path;

    fprintf(stderr, "[INFO] Model loaded: %s (CMM %u KB, input %dx%d, %s, nSize=%u)\n",
            path.c_str(), m.cmm_bytes / 1024, input_w, input_h, cs_name,
            m.io_info->pInputs[0].nSize);
    return 0;
}

static void unload_model(AxModel& m) {
    if (!m.handle) {
        return;
    }
    // Free input buffers.
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
// Image preprocessing: letterbox to input_w x input_h, BGR → RGB.
// ---------------------------------------------------------------------------

// Letterbox + color convert to match model input format.
// Returns a contiguous Mat whose .data can be memcpy'd to the NPU buffer.
static cv::Mat preprocess(const cv::Mat& src, int target_w, int target_h,
                          ModelColorSpace cs) {
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
        // BGR → YUV (NV12): height * 1.5, single channel.
        cv::Mat yuv;
        cv::cvtColor(padded, yuv, cv::COLOR_BGR2YUV_I420);
        // I420 (YUV420P) → NV12: Y plane is identical, interleave U and V.
        const int y_size = target_w * target_h;
        const int uv_h = target_h / 2;
        const int uv_w = target_w / 2;
        cv::Mat nv12(target_h * 3 / 2, target_w, CV_8UC1);
        // Copy Y plane.
        memcpy(nv12.data, yuv.data, y_size);
        // Interleave U and V planes.
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
    // BGR: no conversion needed (OpenCV native).
    return padded;
}

// ---------------------------------------------------------------------------
// Run inference on a JPEG file.
// ---------------------------------------------------------------------------

static int detect(AxModel& m, const std::string& image_path, std::vector<Detection>& results,
                  double& elapsed_ms) {
    results.clear();

    const auto t0 = std::chrono::steady_clock::now();

    // Read JPEG.
    cv::Mat img = cv::imread(image_path, cv::IMREAD_COLOR);
    if (img.empty()) {
        fprintf(stderr, "[WARN] imread failed: %s\n", image_path.c_str());
        return -1;
    }
    const int orig_w = img.cols;
    const int orig_h = img.rows;

    // Preprocess: letterbox + color convert to match model input format.
    cv::Mat input = preprocess(img, m.input_w, m.input_h, m.color_space);

    // Copy to NPU input buffer (size-checked).
    const size_t data_size = input.total() * input.elemSize();
    const size_t buf_size = m.io_data.pInputs[0].nSize;
    if (data_size != buf_size) {
        fprintf(stderr, "[WARN] input size mismatch: data=%zu, buffer=%zu\n", data_size, buf_size);
    }
    memcpy(m.io_data.pInputs[0].pVirAddr, input.data, std::min(data_size, buf_size));
    AX_SYS_MflushCache(m.io_data.pInputs[0].phyAddr, m.io_data.pInputs[0].pVirAddr,
                        m.io_data.pInputs[0].nSize);

    // Run.
    const int ret = AX_ENGINE_RunSync(m.handle, &m.io_data);
    if (ret != 0) {
        fprintf(stderr, "[ERROR] AX_ENGINE_RunSync failed: 0x%x\n", ret);
        return ret;
    }

    // Invalidate all output caches.
    for (uint32_t i = 0; i < m.io_data.nOutputSize; ++i) {
        AX_SYS_MinvalidateCache(m.io_data.pOutputs[i].phyAddr, m.io_data.pOutputs[i].pVirAddr,
                                m.io_data.pOutputs[i].nSize);
    }

    const uint32_t num_outputs = m.io_data.nOutputSize;
    for (uint32_t i = 0; i + 1 < num_outputs; i += 2) {
        const auto& bbox_meta = m.io_info->pOutputs[i];
        const auto& cls_meta = m.io_info->pOutputs[i + 1];
        const int feat_w = bbox_meta.nShapeSize >= 4 ? bbox_meta.pShape[2] : 0;
        if (feat_w <= 0) {
            continue;
        }
        const int stride = m.input_w / feat_w;
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
// CMM headroom check via /proc/ax_proc/mem_cmm_info.
// ---------------------------------------------------------------------------

static int get_free_cmm_mb() {
    FILE* f = fopen("/proc/ax_proc/mem_cmm_info", "r");
    if (!f) {
        return -1;
    }
    char line[512];
    int free_mb = -1;
    // Line 4 contains: nbytes(... Cur=XXXB ...)
    // We compute: free = total - current.
    int total_kb = 0;
    int cur_kb = 0;
    while (fgets(line, sizeof(line), f)) {
        // Look for Size=NNNNKB
        const char* size_pos = strstr(line, "Size=");
        if (size_pos && strstr(line, "PARTITION")) {
            sscanf(size_pos, "Size=%dKB", &total_kb);
        }
        // Look for Cur=NNNNKB in nbytes()
        const char* cur_pos = strstr(line, "Cur=");
        if (cur_pos && strstr(line, "nbytes")) {
            // Parse Cur=NNNNB(NNNNKB
            long long cur_bytes = 0;
            sscanf(cur_pos, "Cur=%lldB", &cur_bytes);
            cur_kb = (int)(cur_bytes / 1024);
        }
    }
    fclose(f);
    if (total_kb > 0 && cur_kb > 0) {
        free_mb = (total_kb - cur_kb) / 1024;
    }
    return free_mb;
}

// ---------------------------------------------------------------------------
// Simple JSON helpers (no external dependency).
// ---------------------------------------------------------------------------

// Escape a string for JSON output.
static std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (const char c : s) {
        switch (c) {
        case '"':
            out += "\\\"";
            break;
        case '\\':
            out += "\\\\";
            break;
        case '\n':
            out += "\\n";
            break;
        default:
            out += c;
        }
    }
    return out;
}

// Extract a JSON string value for a given key (minimal parser).
static std::string json_get_string(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) {
        return "";
    }
    pos = json.find('"', pos + needle.size() + 1); // skip ':'
    if (pos == std::string::npos) {
        return "";
    }
    const auto end = json.find('"', pos + 1);
    if (end == std::string::npos) {
        return "";
    }
    return json.substr(pos + 1, end - pos - 1);
}

static std::string json_get_cmd(const std::string& json) {
    return json_get_string(json, "cmd");
}

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

static int create_listen_socket(const char* socket_path) {
    // Remove stale socket.
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

    // Allow non-root clients to connect.
    chmod(socket_path, 0666);

    if (listen(fd, 4) < 0) {
        perror("listen");
        close(fd);
        return -1;
    }

    return fd;
}

// Read one line (terminated by '\n') from fd.
static bool read_line(int fd, std::string& line) {
    line.clear();
    char c;
    while (true) {
        const ssize_t n = read(fd, &c, 1);
        if (n <= 0) {
            return false;
        }
        if (c == '\n') {
            return true;
        }
        line += c;
    }
}

// Write a string + newline to fd.
static bool write_line(int fd, const std::string& msg) {
    const std::string data = msg + "\n";
    const char* ptr = data.c_str();
    size_t remaining = data.size();
    while (remaining > 0) {
        const ssize_t n = write(fd, ptr, remaining);
        if (n <= 0) {
            return false;
        }
        ptr += n;
        remaining -= n;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

static std::string handle_detect(AxModel& m, const std::string& json) {
    if (!m.handle) {
        return R"({"ok":false,"error":"no model loaded"})";
    }

    const std::string image = json_get_string(json, "image");
    if (image.empty()) {
        return R"({"ok":false,"error":"missing 'image' field"})";
    }

    std::vector<Detection> dets;
    double ms = 0;
    const int ret = detect(m, image, dets, ms);
    if (ret != 0) {
        return R"({"ok":false,"error":"detection failed"})";
    }

    // Build response JSON.
    std::string resp = R"({"ok":true,"dets":[)";
    for (size_t i = 0; i < dets.size(); ++i) {
        const auto& d = dets[i];
        char buf[256];
        snprintf(buf, sizeof(buf),
                 R"({"id":%d,"name":"%s","conf":%.2f,"x1":%d,"y1":%d,"x2":%d,"y2":%d})",
                 d.class_id, (d.class_id < CLS_NUM ? COCO_NAMES[d.class_id] : "unknown"),
                 d.confidence, (int)d.x1, (int)d.y1, (int)d.x2, (int)d.y2);
        if (i > 0) {
            resp += ",";
        }
        resp += buf;
    }
    char ms_buf[64];
    snprintf(ms_buf, sizeof(ms_buf), R"(],"ms":%.1f})", ms);
    resp += ms_buf;
    return resp;
}

static std::string handle_load(AxModel& m, const std::string& json) {
    const std::string model = json_get_string(json, "model");
    if (model.empty()) {
        return R"({"ok":false,"error":"missing 'model' field"})";
    }

    unload_model(m);
    const int ret = load_model(m, model, m.input_w > 0 ? m.input_w : DEFAULT_INPUT_W,
                               m.input_h > 0 ? m.input_h : DEFAULT_INPUT_H);
    if (ret != 0) {
        return R"({"ok":false,"error":"load failed"})";
    }

    const int free_mb = get_free_cmm_mb();
    char buf[256];
    snprintf(buf, sizeof(buf), R"({"ok":true,"model":"%s","cmm_kb":%u,"free_cmm_mb":%d})",
             json_escape(m.model_path).c_str(), m.cmm_bytes / 1024, free_mb);
    return std::string(buf);
}

static std::string handle_unload(AxModel& m) {
    unload_model(m);
    return R"({"ok":true})";
}

static std::string handle_status(const AxModel& m) {
    const int free_mb = get_free_cmm_mb();
    char buf[512];
    if (m.handle) {
        snprintf(buf, sizeof(buf),
                 R"({"ok":true,"loaded":true,"model":"%s","cmm_kb":%u,"input":"%dx%d","free_cmm_mb":%d})",
                 json_escape(m.model_path).c_str(), m.cmm_bytes / 1024, m.input_w, m.input_h,
                 free_mb);
    } else {
        snprintf(buf, sizeof(buf), R"({"ok":true,"loaded":false,"free_cmm_mb":%d})", free_mb);
    }
    return std::string(buf);
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
    // Parse arguments.
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

    // Signal handling.
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGPIPE, SIG_IGN);

    // Initialize AX system.
    int ret = AX_SYS_Init();
    if (ret != 0) {
        fprintf(stderr, "[ERROR] AX_SYS_Init failed: 0x%x\n", ret);
        return 1;
    }

    // Try AX_ENGINE_Init, but tolerate failure if another process (axllm)
    // already owns the NPU.  On AX650, the kernel driver is per-process,
    // so Init should succeed even with axllm running — but RunSync may
    // still fail if both try to use the NPU simultaneously.
    AX_ENGINE_NPU_ATTR_T npu_attr = {};
    npu_attr.eHardMode = AX_ENGINE_VIRTUAL_NPU_DISABLE;
    ret = AX_ENGINE_Init(&npu_attr);
    if (ret != 0) {
        fprintf(stderr, "[WARN] AX_ENGINE_Init failed: 0x%x (trying without Init)\n", ret);
    }

    fprintf(stderr, "[INFO] AX Engine initialized (version: %s)\n", AX_ENGINE_GetVersion());

    // Load model.
    AxModel model;
    model.input_w = input_w;
    model.input_h = input_h;
    ret = load_model(model, model_path, input_w, input_h);
    if (ret != 0) {
        AX_ENGINE_Deinit();
        AX_SYS_Deinit();
        return 1;
    }

    // Check CMM headroom.
    const int free_mb = get_free_cmm_mb();
    if (free_mb >= 0) {
        fprintf(stderr, "[INFO] CMM free: %d MB (headroom threshold: %d MB)\n", free_mb,
                min_headroom_mb);
        if (free_mb < min_headroom_mb) {
            fprintf(stderr, "[WARN] CMM headroom below threshold — consider smaller model\n");
        }
    }

    // Create listen socket.
    g_listen_fd = create_listen_socket(socket_path.c_str());
    if (g_listen_fd < 0) {
        unload_model(model);
        AX_ENGINE_Deinit();
        AX_SYS_Deinit();
        return 1;
    }

    fprintf(stderr, "[INFO] Listening on %s\n", socket_path.c_str());

    // Main loop.
    while (g_running) {
        const int client_fd = accept(g_listen_fd, nullptr, nullptr);
        if (client_fd < 0) {
            if (!g_running) {
                break; // Shutdown.
            }
            if (errno == EINTR) {
                continue;
            }
            perror("accept");
            continue;
        }

        // Handle one request per connection.
        std::string line;
        if (read_line(client_fd, line) && !line.empty()) {
            const std::string cmd = json_get_cmd(line);
            std::string response;

            if (cmd.empty() || cmd == "detect") {
                response = handle_detect(model, line);
            } else if (cmd == "load") {
                response = handle_load(model, line);
            } else if (cmd == "unload") {
                response = handle_unload(model);
            } else if (cmd == "status") {
                response = handle_status(model);
            } else {
                response = R"({"ok":false,"error":"unknown command"})";
            }

            write_line(client_fd, response);
        }

        close(client_fd);
    }

    // Cleanup.
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
