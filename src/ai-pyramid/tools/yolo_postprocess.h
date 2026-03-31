// yolo_postprocess.h — YOLO26 separated-head post-processing (NMS, bbox decode).
#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

static constexpr float SCORE_THRESHOLD = 0.25f;
static constexpr float NMS_THRESHOLD = 0.45f;

struct Detection {
    int class_id;
    float confidence;
    float x1, y1, x2, y2;
};

static float sigmoid(float x) {
    return 1.f / (1.f + std::exp(-x));
}

// YOLO26 separated-head: bbox [1,H,W,4] + cls [1,H,W,C].
static void generate_proposals_separated(int stride, const float* bbox_feat, const float* cls_feat,
                                         float prob_threshold, std::vector<Detection>& dets,
                                         int input_w, int input_h, int cls_num) {
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

// YOLO11 unified DFL head: [1,H,W, 4*REG_MAX + C] where REG_MAX=16, C=80.
// Channel layout per cell: [16 DFL bins × 4 coords, 80 class scores].
static constexpr int DFL_REG_MAX = 16;

static float dfl_decode(const float* bins, int reg_max) {
    // softmax over reg_max bins, then weighted sum = expected distance
    float max_val = bins[0];
    for (int i = 1; i < reg_max; ++i) {
        if (bins[i] > max_val) max_val = bins[i];
    }
    float sum_exp = 0.f;
    float weighted = 0.f;
    for (int i = 0; i < reg_max; ++i) {
        const float e = std::exp(bins[i] - max_val);
        sum_exp += e;
        weighted += e * i;
    }
    return weighted / sum_exp;
}

static void generate_proposals_dfl(int stride, const float* feat, float prob_threshold,
                                   std::vector<Detection>& dets, int input_w, int input_h,
                                   int cls_num, int reg_max = DFL_REG_MAX) {
    const int feat_w = input_w / stride;
    const int feat_h = input_h / stride;
    const int ch = 4 * reg_max + cls_num; // 64 + 80 = 144

    for (int h = 0; h < feat_h; ++h) {
        for (int w = 0; w < feat_w; ++w) {
            const float* cell = feat + (h * feat_w + w) * ch;
            const float* cls_ptr = cell + 4 * reg_max; // class scores start after DFL bins

            int best_cls = 0;
            float best_score = -1e9f;
            for (int c = 0; c < cls_num; ++c) {
                if (cls_ptr[c] > best_score) {
                    best_score = cls_ptr[c];
                    best_cls = c;
                }
            }
            const float prob = sigmoid(best_score);
            if (prob <= prob_threshold) continue;

            // Decode DFL: 4 distances (left, top, right, bottom) from grid center
            const float dl = dfl_decode(cell + 0 * reg_max, reg_max);
            const float dt = dfl_decode(cell + 1 * reg_max, reg_max);
            const float dr = dfl_decode(cell + 2 * reg_max, reg_max);
            const float db = dfl_decode(cell + 3 * reg_max, reg_max);

            // dist2bbox: grid center ± distance × stride
            const float gx = (w + 0.5f) * stride;
            const float gy = (h + 0.5f) * stride;

            Detection d;
            d.class_id = best_cls;
            d.confidence = prob;
            d.x1 = std::max(gx - dl * stride, 0.f);
            d.y1 = std::max(gy - dt * stride, 0.f);
            d.x2 = std::min(gx + dr * stride, (float)(input_w - 1));
            d.y2 = std::min(gy + db * stride, (float)(input_h - 1));
            if (d.x2 > d.x1 && d.y2 > d.y1) {
                dets.push_back(d);
            }
        }
    }
}

static float det_iou(const Detection& a, const Detection& b) {
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
            if (det_iou(d, k) > nms_threshold) {
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
