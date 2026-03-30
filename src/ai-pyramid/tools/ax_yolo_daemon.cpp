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
#include <errno.h>
#include <getopt.h>
#include <netdb.h>
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
static const char* CMM_TOKEN = "ax_yolo_daemon";

static constexpr int STREAM_RELAY_PORT = 9265;
static constexpr int STREAM_HEARTBEAT_SEC = 10;

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

    // Mutex for NPU access (stream vs on-demand).
    std::mutex npu_mutex;
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

static int run_npu_and_postprocess(AxModel& m, int orig_w, int orig_h,
                                   std::vector<Detection>& results, double& elapsed_ms,
                                   std::chrono::steady_clock::time_point t0) {
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

static int ensure_nv12_cmm(AxModel& m, int w, int h) {
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
static int run_inference_nv12_cmm(AxModel& m, int src_w, int src_h, std::vector<Detection>& results,
                                  double& elapsed_ms) {
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

static int create_listen_socket(const char* path) {
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

static bool send_detections(int fd, const std::vector<Detection>& dets, float ms) {
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

static void send_error(int fd, const char* msg) {
    ResponseHeader hdr = {};
    hdr.status = 1;
    hdr.error_len = (uint32_t)strlen(msg);
    write_exact(fd, &hdr, sizeof(hdr));
    if (hdr.error_len > 0) {
        write_exact(fd, msg, hdr.error_len);
    }
}

// ---------------------------------------------------------------------------
// H.265 NAL parser
// ---------------------------------------------------------------------------

// H.265 NAL unit types relevant for keyframe detection.
static constexpr uint8_t HEVC_NAL_IDR_W_RADL = 19;
static constexpr uint8_t HEVC_NAL_IDR_N_LP = 20;
static constexpr uint8_t HEVC_NAL_CRA = 21;
static constexpr uint8_t HEVC_NAL_VPS = 32;
static constexpr uint8_t HEVC_NAL_SPS = 33;
static constexpr uint8_t HEVC_NAL_PPS = 34;

static uint8_t hevc_nal_type(const uint8_t* nal) {
    // H.265: nal_unit_type is bits 1-6 of the first byte after start code.
    return (nal[0] >> 1) & 0x3F;
}

static bool hevc_is_idr(uint8_t nal_type) {
    return nal_type == HEVC_NAL_IDR_W_RADL || nal_type == HEVC_NAL_IDR_N_LP ||
           nal_type == HEVC_NAL_CRA;
}

static bool hevc_is_vcl(uint8_t nal_type) {
    return nal_type <= 31; // VCL NAL units are 0-31
}

// Find next start code (00 00 01 or 00 00 00 01) in buffer.
// Returns pointer to first byte after start code, or nullptr if not found.
static const uint8_t* find_start_code(const uint8_t* p, const uint8_t* end) {
    while (p + 2 < end) {
        if (p[0] == 0 && p[1] == 0) {
            if (p[2] == 1) {
                return p + 3;
            }
            if (p + 3 < end && p[2] == 0 && p[3] == 1) {
                return p + 4;
            }
        }
        ++p;
    }
    return nullptr;
}

// ---------------------------------------------------------------------------
// TCP client
// ---------------------------------------------------------------------------

static int tcp_connect(const char* host, int port) {
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
    // Set recv timeout (10s).
    struct timeval tv = {10, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

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
// Stream mode: TCP → VDEC HW → CLAHE → IVPS → NPU → push to client
// ---------------------------------------------------------------------------

static constexpr AX_VDEC_GRP VDEC_GRP = 0;
static constexpr AX_VDEC_CHN VDEC_CHN = 0;
static constexpr int STREAM_BUF_SIZE = 2 * 1024 * 1024; // 2MB stream buffer
static constexpr int FRAME_W = 1280;
static constexpr int FRAME_H = 720;

static void handle_stream(int client_fd, AxModel& model, const RequestHeader& req) {
    // Read rdk-x5 host from payload.
    std::string host(req.payload_size, '\0');
    if (req.payload_size > 0 && !read_exact(client_fd, host.data(), req.payload_size)) {
        send_error(client_fd, "read host failed");
        return;
    }
    if (host.empty()) {
        send_error(client_fd, "missing host");
        return;
    }

    fprintf(stderr, "[STREAM] Connecting to %s:%d\n", host.c_str(), STREAM_RELAY_PORT);

    // --- TCP connect ---
    const int tcp_fd = tcp_connect(host.c_str(), STREAM_RELAY_PORT);
    if (tcp_fd < 0) {
        send_error(client_fd, "tcp connect failed");
        return;
    }

    if (!model.vdec_ready) {
        send_error(client_fd, "vdec not initialized");
        close(tcp_fd);
        return;
    }

    // --- Create VDEC group (Init already done in main) ---
    // Heap-allocate all VDEC structs — stack alignment issues with AX650 BSP.
    auto* grp_attr = new AX_VDEC_GRP_ATTR_T();
    memset(grp_attr, 0, sizeof(*grp_attr));
    grp_attr->enCodecType = PT_H265;
    grp_attr->enInputMode = AX_VDEC_INPUT_MODE_STREAM;
    grp_attr->u32MaxPicWidth = FRAME_W;
    grp_attr->u32MaxPicHeight = FRAME_H;
    grp_attr->u32StreamBufSize = STREAM_BUF_SIZE;
    grp_attr->bSdkAutoFramePool = AX_TRUE;

    int ret = AX_VDEC_CreateGrp(VDEC_GRP, grp_attr);
    delete grp_attr;
    if (ret != 0) {
        fprintf(stderr, "[STREAM] AX_VDEC_CreateGrp failed: 0x%x\n", ret);
        send_error(client_fd, "vdec create failed");
        close(tcp_fd);
        return;
    }

    // Set decode mode to IPB (decode all frame types).
    auto* grp_param = new AX_VDEC_GRP_PARAM_T();
    memset(grp_param, 0, sizeof(*grp_param));
    grp_param->stVdecVideoParam.enOutputOrder = AX_VDEC_OUTPUT_ORDER_DEC;
    grp_param->stVdecVideoParam.enVdecMode = VIDEO_DEC_MODE_IPB;
    AX_VDEC_SetGrpParam(VDEC_GRP, grp_param);
    delete grp_param;

    // Configure output channel: NV12 at original resolution.
    auto* recv_param = new AX_VDEC_RECV_PIC_PARAM_T();
    memset(recv_param, 0, sizeof(*recv_param));
    recv_param->s32RecvPicNum = -1; // unlimited
    ret = AX_VDEC_StartRecvStream(VDEC_GRP, recv_param);
    delete recv_param;
    if (ret != 0) {
        fprintf(stderr, "[STREAM] AX_VDEC_StartRecvStream failed: 0x%x\n", ret);
        AX_VDEC_DestroyGrp(VDEC_GRP);
        AX_VDEC_Deinit();
        send_error(client_fd, "vdec start failed");
        close(tcp_fd);
        return;
    }

    // Send initial OK.
    {
        std::vector<Detection> empty;
        if (!send_detections(client_fd, empty, 0)) {
            goto cleanup;
        }
    }

    fprintf(stderr, "[STREAM] HW decode started (%dx%d H.265)\n", FRAME_W, FRAME_H);

    {
        // TCP recv + VDEC send + frame get loop.
        std::vector<uint8_t> tcp_buf(256 * 1024);
        auto last_heartbeat = std::chrono::steady_clock::now();
        uint64_t frames = 0;
        const uint64_t clahe_mask = 127; // CLAHE every 128 frames (~4.3s at 30fps).

        while (g_running) {
            // --- Read H.265 data from TCP ---
            const ssize_t nr = recv(tcp_fd, tcp_buf.data(), tcp_buf.size(), 0);
            if (nr <= 0) {
                if (nr == 0) {
                    fprintf(stderr, "[STREAM] TCP EOF\n");
                } else if (errno != EAGAIN && errno != EINTR) {
                    fprintf(stderr, "[STREAM] TCP recv error: %s\n", strerror(errno));
                }
                break;
            }

            // --- Send to VDEC ---
            AX_VDEC_STREAM_T stream = {};
            stream.pu8Addr = tcp_buf.data();
            stream.u32StreamPackLen = (AX_U32)nr;
            stream.bEndOfFrame = AX_FALSE;
            stream.bEndOfStream = AX_FALSE;
            ret = AX_VDEC_SendStream(VDEC_GRP, &stream, 100);
            if (ret != 0 && ret != (int)AX_ERR_VDEC_BUF_FULL) {
                fprintf(stderr, "[STREAM] VDEC SendStream error: 0x%x\n", ret);
                break;
            }

            // --- Try to get decoded frames ---
            AX_VIDEO_FRAME_INFO_T frame_info = {};
            while (AX_VDEC_GetChnFrame(VDEC_GRP, VDEC_CHN, &frame_info, 0) == 0) {
                const auto& vf = frame_info.stVFrame;
                const int fw = vf.u32Width;
                const int fh = vf.u32Height;

                if (fw > 0 && fh > 0 && vf.u64VirAddr[0]) {
                    // CLAHE on Y plane (in-place on VDEC output — may need copy).
                    uint8_t* y_ptr = (uint8_t*)(uintptr_t)vf.u64VirAddr[0];
                    uint8_t* uv_ptr = (uint8_t*)(uintptr_t)vf.u64VirAddr[1];

                    if ((frames & clahe_mask) == 0) {
                        // CLAHE needs writable buffer — copy Y to temp.
                        const int y_size = fw * fh;
                        std::vector<uint8_t> y_tmp(y_ptr, y_ptr + y_size);
                        apply_clahe_nv12(y_tmp.data(), fw, fh);
                        // Copy back CLAHE'd Y (UV already set to 128 by apply_clahe_nv12).
                        memcpy(y_ptr, y_tmp.data(), y_size);
                        memset(uv_ptr, 128, y_size / 2);
                    } else {
                        // Just desaturate UV.
                        memset(uv_ptr, 128, fw * fh / 2);
                    }

                    // Flush VDEC frame (Y + UV) for IVPS/NPU.
                    AX_SYS_MflushCache(vf.u64PhyAddr[0], y_ptr, fw * fh);
                    AX_SYS_MflushCache(vf.u64PhyAddr[1], uv_ptr, fw * fh / 2);

                    // --- IVPS + NPU (use VDEC frame directly as IVPS source) ---
                    std::vector<Detection> dets;
                    double ms = 0;
                    {
                        std::lock_guard<std::mutex> lock(model.npu_mutex);
                        const auto t0 = std::chrono::steady_clock::now();

                        if (model.ivps_ready) {
                            AX_VIDEO_FRAME_T sf = {};
                            sf.u32Width = fw;
                            sf.u32Height = fh;
                            sf.enImgFormat = AX_FORMAT_YUV420_SEMIPLANAR;
                            sf.u32PicStride[0] = vf.u32PicStride[0];
                            sf.u64PhyAddr[0] = vf.u64PhyAddr[0];
                            sf.u64VirAddr[0] = vf.u64VirAddr[0];
                            sf.u64PhyAddr[1] = vf.u64PhyAddr[1];
                            sf.u64VirAddr[1] = vf.u64VirAddr[1];

                            AX_VIDEO_FRAME_T df = {};
                            df.u32Width = model.input_w;
                            df.u32Height = model.input_h;
                            df.enImgFormat = AX_FORMAT_BGR888;
                            df.u32PicStride[0] = model.input_w * 3;
                            df.u64PhyAddr[0] = model.io_data.pInputs[0].phyAddr;
                            df.u64VirAddr[0] = (AX_U64)(uintptr_t)model.io_data.pInputs[0].pVirAddr;
                            df.u32FrameSize = model.io_data.pInputs[0].nSize;

                            AX_IVPS_ASPECT_RATIO_T ar = {};
                            ar.eMode = AX_IVPS_ASPECT_RATIO_AUTO;
                            ar.nBgColor = 0x727272;
                            ar.eAligns[0] = AX_IVPS_ASPECT_RATIO_HORIZONTAL_CENTER;
                            ar.eAligns[1] = AX_IVPS_ASPECT_RATIO_VERTICAL_CENTER;

                            if (AX_IVPS_CropResizeTdp(&sf, &df, &ar) == 0) {
                                AX_SYS_MinvalidateCache(model.io_data.pInputs[0].phyAddr,
                                                        model.io_data.pInputs[0].pVirAddr,
                                                        model.io_data.pInputs[0].nSize);
                                run_npu_and_postprocess(model, fw, fh, dets, ms, t0);
                            } else {
                                // CPU fallback.
                                cv::Mat nv12_mat(fh * 3 / 2, fw, CV_8UC1, y_ptr);
                                cv::Mat bgr;
                                cv::cvtColor(nv12_mat, bgr, cv::COLOR_YUV2BGR_NV12);
                                cv::Mat cmm(model.input_h, model.input_w, CV_8UC3,
                                            model.io_data.pInputs[0].pVirAddr);
                                letterbox_into(bgr, cmm);
                                AX_SYS_MflushCache(model.io_data.pInputs[0].phyAddr,
                                                   model.io_data.pInputs[0].pVirAddr,
                                                   model.io_data.pInputs[0].nSize);
                                run_npu_and_postprocess(model, fw, fh, dets, ms, t0);
                            }
                        }
                    }

                    if (!dets.empty()) {
                        if (!send_detections(client_fd, dets, (float)ms)) {
                            AX_VDEC_ReleaseChnFrame(VDEC_GRP, VDEC_CHN, &frame_info);
                            goto cleanup;
                        }
                    }
                    frames++;
                }

                AX_VDEC_ReleaseChnFrame(VDEC_GRP, VDEC_CHN, &frame_info);
            }

            // Heartbeat.
            const auto now = std::chrono::steady_clock::now();
            if (std::chrono::duration_cast<std::chrono::seconds>(now - last_heartbeat).count() >=
                STREAM_HEARTBEAT_SEC) {
                std::vector<Detection> empty;
                if (!send_detections(client_fd, empty, 0)) {
                    break;
                }
                if (frames > 0) {
                    fprintf(stderr, "[STREAM] %lu frames processed\n", (unsigned long)frames);
                }
                frames = 0;
                last_heartbeat = now;
            }
        }
    }

cleanup:
    AX_VDEC_StopRecvStream(VDEC_GRP);
    AX_VDEC_DestroyGrp(VDEC_GRP);
    close(tcp_fd);
    fprintf(stderr, "[STREAM] Ended\n");
}

// ---------------------------------------------------------------------------
// On-demand handlers
// ---------------------------------------------------------------------------

static void handle_detect(int fd, AxModel& m, const RequestHeader& req) {
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
        cv::Mat img = cv::imread(path, cv::IMREAD_COLOR);
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

static void handle_load(int fd, AxModel& m, const RequestHeader& req) {
    std::string path(req.payload_size, '\0');
    if (req.payload_size > 0 && !read_exact(fd, path.data(), req.payload_size)) {
        send_error(fd, "read path failed");
        return;
    }
    std::lock_guard<std::mutex> lock(m.npu_mutex);
    unload_model(m);
    if (load_model(m, path, m.input_w ? m.input_w : DEFAULT_INPUT_W,
                   m.input_h ? m.input_h : DEFAULT_INPUT_H) != 0) {
        send_error(fd, "load failed");
        return;
    }
    std::vector<Detection> empty;
    send_detections(fd, empty, 0);
}

static void handle_unload(int fd, AxModel& m) {
    std::lock_guard<std::mutex> lock(m.npu_mutex);
    unload_model(m);
    std::vector<Detection> empty;
    send_detections(fd, empty, 0);
}

static void handle_status(int fd, const AxModel& m) {
    std::vector<Detection> empty;
    send_detections(fd, empty, m.handle ? (float)(m.cmm_bytes / 1024) : 0.f);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

static void print_usage(const char* prog) {
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

    AX_ENGINE_NPU_ATTR_T npu_attr = {};
    npu_attr.eHardMode = AX_ENGINE_VIRTUAL_NPU_DISABLE;
    ret = AX_ENGINE_Init(&npu_attr);
    if (ret != 0) {
        fprintf(stderr, "[WARN] AX_ENGINE_Init: 0x%x\n", ret);
    }
    fprintf(stderr, "[INFO] AX Engine %s\n", AX_ENGINE_GetVersion());

    // VDEC must be initialized BEFORE model load (CreateHandle).
    // CreateHandle consumes kernel resources that prevent VDEC init.
    // VDEC struct must be heap-allocated — stack alignment issues with AX650 BSP.
    bool vdec_ok = false;
    {
        auto* vdec_mod = new AX_VDEC_MOD_ATTR_T();
        memset(vdec_mod, 0, sizeof(*vdec_mod));
        vdec_mod->u32MaxGroupCount = 16;
        vdec_mod->enDecModule = AX_ENABLE_BOTH_VDEC_JDEC;
        ret = AX_VDEC_Init(vdec_mod);
        if (ret == 0) {
            vdec_ok = true;
            fprintf(stderr, "[INFO] VDEC HW enabled\n");
        } else {
            fprintf(stderr, "[WARN] AX_VDEC_Init: 0x%x (stream unavailable)\n", ret);
        }
        delete vdec_mod;
    }

    bool ivps_ok = AX_IVPS_Init() == 0;
    if (ivps_ok) {
        fprintf(stderr, "[INFO] IVPS HW enabled\n");
    }

    AxModel model;
    model.input_w = input_w;
    model.input_h = input_h;
    model.ivps_ready = ivps_ok;
    model.vdec_ready = vdec_ok;
    if (load_model(model, model_path, input_w, input_h) != 0) {
        return 1;
    }

    g_listen_fd = create_listen_socket(socket_path.c_str());
    if (g_listen_fd < 0) {
        return 1;
    }
    fprintf(stderr, "[INFO] Listening on %s\n", socket_path.c_str());

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
            case CMD_STREAM:
                handle_stream(cfd, model, req);
                break;
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
        AX_VDEC_Deinit();
    }
    AX_ENGINE_Deinit();
    AX_SYS_Deinit();
    return 0;
}
