/**
 * Lightweight Protobuf Decoder for DetectionEvent
 * Schema: detection.proto (petcamera package)
 *
 * Supports decoding without external dependencies.
 */

class ProtobufDecoder {
    constructor(buffer) {
        this.buffer = new Uint8Array(buffer);
        this.pos = 0;
    }

    // Read varint (32-bit variable-length integer)
    // Uses bitwise OR - fast but limited to 32 bits due to JS bitwise operator constraint
    readVarint() {
        let result = 0;
        let shift = 0;
        while (this.pos < this.buffer.length) {
            const byte = this.buffer[this.pos++];
            result |= (byte & 0x7F) << shift;
            if ((byte & 0x80) === 0) break;
            shift += 7;
        }
        return result >>> 0;
    }

    // Read 64-bit varint as Number
    // Uses arithmetic (not bitwise) to support up to 53 bits (JS safe integer range)
    // Example: 1 << 35 = 8 (wrong), 1 * Math.pow(2, 35) = 34359738368 (correct)
    readVarint64() {
        let result = 0;
        let shift = 0;
        while (this.pos < this.buffer.length && shift < 64) {
            const byte = this.buffer[this.pos++];
            result += (byte & 0x7F) * Math.pow(2, shift);
            if ((byte & 0x80) === 0) break;
            shift += 7;
        }
        return result;
    }

    // Read fixed 32-bit float
    readFloat() {
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.pos, 4);
        this.pos += 4;
        return view.getFloat32(0, true); // little-endian
    }

    // Read fixed 64-bit double
    readDouble() {
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.pos, 8);
        this.pos += 8;
        return view.getFloat64(0, true); // little-endian
    }

    // Read length-delimited bytes
    readBytes() {
        const length = this.readVarint();
        const bytes = this.buffer.slice(this.pos, this.pos + length);
        this.pos += length;
        return bytes;
    }

    // Read string (UTF-8)
    readString() {
        const bytes = this.readBytes();
        return new TextDecoder().decode(bytes);
    }

    // Read field tag (field number + wire type)
    readTag() {
        if (this.pos >= this.buffer.length) return null;
        const tag = this.readVarint();
        return {
            fieldNumber: tag >>> 3,
            wireType: tag & 0x7
        };
    }

    // Skip field based on wire type
    skipField(wireType) {
        switch (wireType) {
            case 0: this.readVarint(); break;      // Varint
            case 1: this.pos += 8; break;          // Fixed64
            case 2: this.readBytes(); break;       // Length-delimited
            case 5: this.pos += 4; break;          // Fixed32
            default: throw new Error(`Unknown wire type: ${wireType}`);
        }
    }
}

// Decode BBox message
function decodeBBox(bytes) {
    const decoder = new ProtobufDecoder(bytes);
    const bbox = { x: 0, y: 0, w: 0, h: 0 };

    while (decoder.pos < bytes.length) {
        const tag = decoder.readTag();
        if (!tag) break;

        switch (tag.fieldNumber) {
            case 1: bbox.x = decoder.readVarint(); break;
            case 2: bbox.y = decoder.readVarint(); break;
            case 3: bbox.w = decoder.readVarint(); break;
            case 4: bbox.h = decoder.readVarint(); break;
            default: decoder.skipField(tag.wireType);
        }
    }
    return bbox;
}

// Decode Detection message
// Proto fields: bbox(1), confidence(2), class_id(3), label(4)
function decodeDetection(bytes) {
    const decoder = new ProtobufDecoder(bytes);
    const detection = { bbox: { x: 0, y: 0, w: 0, h: 0 }, confidence: 0, class_id: 0, class_name: '' };

    while (decoder.pos < bytes.length) {
        const tag = decoder.readTag();
        if (!tag) break;

        switch (tag.fieldNumber) {
            case 1: detection.bbox = decodeBBox(decoder.readBytes()); break;
            case 2: detection.confidence = decoder.readFloat(); break;
            case 3: detection.class_id = decoder.readVarint(); break;
            case 4: detection.class_name = decoder.readString(); break; // 'label' in proto -> 'class_name' for JS
            default: decoder.skipField(tag.wireType);
        }
    }
    return detection;
}

/**
 * Decode DetectionEvent protobuf message
 * @param {Uint8Array} bytes - Protobuf binary data
 * @returns {Object} Decoded detection event
 */
export function decodeDetectionEvent(bytes) {
    const decoder = new ProtobufDecoder(bytes);
    const event = { frame_number: 0, timestamp: 0, detections: [] };

    while (decoder.pos < bytes.length) {
        const tag = decoder.readTag();
        if (!tag) break;

        switch (tag.fieldNumber) {
            case 1: event.frame_number = decoder.readVarint64(); break;
            case 2: event.timestamp = decoder.readDouble(); break;
            case 3: event.detections.push(decodeDetection(decoder.readBytes())); break;
            default: decoder.skipField(tag.wireType);
        }
    }
    return event;
}

/**
 * Decode base64 string to Uint8Array
 * @param {string} base64 - Base64 encoded string
 * @returns {Uint8Array} Decoded bytes
 */
export function base64ToBytes(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

// ====== Status Stream Decoders ======

// Decode MonitorStats message
// Proto fields: frames_processed(1), current_fps(2), detection_count(3), target_fps(4)
function decodeMonitorStats(bytes) {
    const decoder = new ProtobufDecoder(bytes);
    const stats = { frames_processed: 0, current_fps: 0, detection_count: 0, target_fps: 0 };

    while (decoder.pos < bytes.length) {
        const tag = decoder.readTag();
        if (!tag) break;

        switch (tag.fieldNumber) {
            case 1: stats.frames_processed = decoder.readVarint(); break;
            case 2: stats.current_fps = decoder.readDouble(); break;
            case 3: stats.detection_count = decoder.readVarint(); break;
            case 4: stats.target_fps = decoder.readVarint(); break;
            default: decoder.skipField(tag.wireType);
        }
    }
    return stats;
}

// Decode SharedMemoryStats message
// Proto fields: frame_count(1), total_frames_written(2), detection_version(3), has_detection(4)
function decodeSharedMemoryStats(bytes) {
    const decoder = new ProtobufDecoder(bytes);
    const stats = { frame_count: 0, total_frames_written: 0, detection_version: 0, has_detection: 0 };

    while (decoder.pos < bytes.length) {
        const tag = decoder.readTag();
        if (!tag) break;

        switch (tag.fieldNumber) {
            case 1: stats.frame_count = decoder.readVarint(); break;
            case 2: stats.total_frames_written = decoder.readVarint(); break;
            case 3: stats.detection_version = decoder.readVarint(); break;
            case 4: stats.has_detection = decoder.readVarint(); break;
            default: decoder.skipField(tag.wireType);
        }
    }
    return stats;
}

// Decode DetectionResult message (extended Detection with version info)
// Proto fields: frame_number(1), timestamp(2), num_detections(3), version(4), detections(5)
function decodeDetectionResult(bytes) {
    const decoder = new ProtobufDecoder(bytes);
    const result = { frame_number: 0, timestamp: 0, num_detections: 0, version: 0, detections: [] };

    while (decoder.pos < bytes.length) {
        const tag = decoder.readTag();
        if (!tag) break;

        switch (tag.fieldNumber) {
            case 1: result.frame_number = decoder.readVarint64(); break;
            case 2: result.timestamp = decoder.readDouble(); break;
            case 3: result.num_detections = decoder.readVarint(); break;
            case 4: result.version = decoder.readVarint(); break;
            case 5: result.detections.push(decodeDetection(decoder.readBytes())); break;
            default: decoder.skipField(tag.wireType);
        }
    }
    return result;
}

/**
 * Decode StatusEvent protobuf message
 * Proto fields: monitor(1), shared_memory(2), latest_detection(3), detection_history(4), timestamp(5)
 * @param {Uint8Array} bytes - Protobuf binary data
 * @returns {Object} Decoded status event
 */
export function decodeStatusEvent(bytes) {
    const decoder = new ProtobufDecoder(bytes);
    const event = {
        monitor: null,
        shared_memory: null,
        latest_detection: null,
        detection_history: [],
        timestamp: 0
    };

    while (decoder.pos < bytes.length) {
        const tag = decoder.readTag();
        if (!tag) break;

        switch (tag.fieldNumber) {
            case 1: event.monitor = decodeMonitorStats(decoder.readBytes()); break;
            case 2: event.shared_memory = decodeSharedMemoryStats(decoder.readBytes()); break;
            case 3: event.latest_detection = decodeDetectionResult(decoder.readBytes()); break;
            case 4: event.detection_history.push(decodeDetectionResult(decoder.readBytes())); break;
            case 5: event.timestamp = decoder.readDouble(); break;
            default: decoder.skipField(tag.wireType);
        }
    }
    return event;
}
