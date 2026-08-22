// Binary protocol shared with ax_yolo_daemon.cpp.

pub(super) const CMD_DETECT: u16 = 0;
pub(super) const CMD_LOAD: u16 = 1;
pub(super) const CMD_STREAM: u16 = 4;
#[allow(dead_code)]
pub(super) const CMD_HELP: u16 = 5;
pub(super) const INPUT_JPEG_PATH: u16 = 0;
pub(super) const INPUT_NV12_RAW: u16 = 1;

#[repr(C, packed)]
pub(super) struct RequestHeader {
    pub(super) cmd: u16,
    pub(super) input_type: u16,
    pub(super) width: u16,
    pub(super) height: u16,
    pub(super) payload_size: u32,
    pub(super) reserved: u32,
}

#[repr(C, packed)]
#[derive(Clone, Copy)]
pub(super) struct ResponseHeader {
    pub(super) status: u16,
    pub(super) det_count: u16,
    pub(super) _elapsed_ms: f32,
    pub(super) error_len: u32,
}

#[repr(C, packed)]
#[derive(Clone, Copy)]
pub(super) struct WireDetection {
    pub(super) x1: i16,
    pub(super) y1: i16,
    pub(super) x2: i16,
    pub(super) y2: i16,
    pub(super) class_id: u16,
    pub(super) confidence: u16,
}

#[derive(Debug, Clone)]
pub struct RawLocalDetection {
    pub class_id: i32,
    pub class_name: String,
    pub confidence: f64,
    pub bbox_x: i32,
    pub bbox_y: i32,
    pub bbox_w: i32,
    pub bbox_h: i32,
}

const COCO_NAMES: &[&str] = &[
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
];

pub fn coco_name(class_id: u16) -> String {
    COCO_NAMES
        .get(class_id as usize)
        .unwrap_or(&"unknown")
        .to_string()
}

pub(super) fn request_bytes(header: &RequestHeader) -> &[u8] {
    unsafe { std::slice::from_raw_parts(header as *const _ as *const u8, 16) }
}

pub(super) fn response_header(bytes: &[u8; 12]) -> ResponseHeader {
    unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast()) }
}

pub(super) fn wire_detection(bytes: &[u8; 12]) -> WireDetection {
    unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast()) }
}

pub(super) fn raw_detection(detection: WireDetection) -> RawLocalDetection {
    let class_id = detection.class_id as i32;
    RawLocalDetection {
        class_id,
        class_name: coco_name(detection.class_id),
        confidence: detection.confidence as f64 / 10000.0,
        bbox_x: detection.x1 as i32,
        bbox_y: detection.y1 as i32,
        bbox_w: (detection.x2 - detection.x1) as i32,
        bbox_h: (detection.y2 - detection.y1) as i32,
    }
}

/// Build a CMD_STREAM request header + host payload as bytes.
pub fn stream_request_header(host: &[u8]) -> Vec<u8> {
    let header = RequestHeader {
        cmd: CMD_STREAM,
        input_type: 0,
        width: 0,
        height: 0,
        payload_size: host.len() as u32,
        reserved: 0,
    };
    let mut request = Vec::with_capacity(16 + host.len());
    request.extend_from_slice(request_bytes(&header));
    request.extend_from_slice(host);
    request
}
