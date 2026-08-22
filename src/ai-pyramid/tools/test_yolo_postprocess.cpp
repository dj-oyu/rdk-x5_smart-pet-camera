#include "yolo_postprocess.h"

#include <cassert>
#include <cmath>
#include <vector>

static float logit(float probability) {
    return std::log(probability / (1.0f - probability));
}

static void target_class_wins_before_argmax() {
    std::vector<float> bbox = {1.0f, 1.0f, 1.0f, 1.0f};
    std::vector<float> scores(80, logit(0.01f));
    scores[10] = logit(0.95f); // fire hydrant is intentionally excluded
    scores[15] = logit(0.60f); // cat must survive target filtering

    std::vector<Detection> detections;
    generate_proposals_separated(8, bbox.data(), scores.data(), 0.25f, detections, 8, 8, 80);

    assert(detections.size() == 1);
    assert(detections[0].class_id == 15);
    assert(std::abs(detections[0].confidence - 0.60f) < 0.001f);
}

static void nms_is_class_aware() {
    std::vector<Detection> detections = {
        {15, 0.90f, 10.0f, 10.0f, 100.0f, 100.0f},
        {56, 0.80f, 10.0f, 10.0f, 100.0f, 100.0f},
        {15, 0.70f, 12.0f, 12.0f, 98.0f, 98.0f},
    };

    nms(detections, 0.45f);

    assert(detections.size() == 2);
    assert(detections[0].class_id == 15);
    assert(detections[1].class_id == 56);
}

int main() {
    target_class_wins_before_argmax();
    nms_is_class_aware();
}
