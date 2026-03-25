export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detection {
  bbox: BBox;
  confidence: number;
  class_id: number;
  class_name: string;
}

export interface DetectionEvent {
  frame_number: number;
  timestamp: number;
  detections: Detection[];
}

export interface MonitorStats {
  frames_processed: number;
  current_fps: number;
  detection_count: number;
  target_fps: number;
}

export interface SharedMemoryStats {
  frame_count: number;
  total_frames_written: number;
  detection_version: number;
  has_detection: number;
}

export interface DetectionResult {
  frame_number: number;
  timestamp: number;
  num_detections: number;
  version: number;
  detections: Detection[];
}

export interface StatusEvent {
  monitor: MonitorStats | null;
  shared_memory: SharedMemoryStats | null;
  latest_detection: DetectionResult | null;
  detection_history: DetectionResult[];
  timestamp: number;
}

class ProtobufDecoder {
  private buffer: Uint8Array;
  private pos: number;

  constructor(buffer: ArrayBuffer | Uint8Array) {
    this.buffer = new Uint8Array(buffer);
    this.pos = 0;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.buffer.length) {
      const byte = this.buffer[this.pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }

  readVarint64(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.buffer.length && shift < 64) {
      const byte = this.buffer[this.pos++];
      result += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }

  readFloat(): number {
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.pos, 4);
    this.pos += 4;
    return view.getFloat32(0, true);
  }

  readDouble(): number {
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  readBytes(): Uint8Array {
    const length = this.readVarint();
    const bytes = this.buffer.slice(this.pos, this.pos + length);
    this.pos += length;
    return bytes;
  }

  readString(): string {
    const bytes = this.readBytes();
    return new TextDecoder().decode(bytes);
  }

  readTag(): { fieldNumber: number; wireType: number } | null {
    if (this.pos >= this.buffer.length) return null;
    const tag = this.readVarint();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }

  skipField(wireType: number): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.readBytes();
        break;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`Unknown wire type: ${wireType}`);
    }
  }

  get remaining(): number {
    return this.buffer.length - this.pos;
  }
}

function decodeBBox(bytes: Uint8Array): BBox {
  const d = new ProtobufDecoder(bytes);
  const bbox: BBox = { x: 0, y: 0, w: 0, h: 0 };
  while (d.remaining > 0) {
    const tag = d.readTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1: bbox.x = d.readVarint(); break;
      case 2: bbox.y = d.readVarint(); break;
      case 3: bbox.w = d.readVarint(); break;
      case 4: bbox.h = d.readVarint(); break;
      default: d.skipField(tag.wireType);
    }
  }
  return bbox;
}

function decodeDetection(bytes: Uint8Array): Detection {
  const d = new ProtobufDecoder(bytes);
  const det: Detection = { bbox: { x: 0, y: 0, w: 0, h: 0 }, confidence: 0, class_id: 0, class_name: '' };
  while (d.remaining > 0) {
    const tag = d.readTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1: det.bbox = decodeBBox(d.readBytes()); break;
      case 2: det.confidence = d.readFloat(); break;
      case 3: det.class_id = d.readVarint(); break;
      case 4: det.class_name = d.readString(); break;
      default: d.skipField(tag.wireType);
    }
  }
  return det;
}

export function decodeDetectionEvent(bytes: Uint8Array): DetectionEvent {
  const d = new ProtobufDecoder(bytes);
  const event: DetectionEvent = { frame_number: 0, timestamp: 0, detections: [] };
  while (d.remaining > 0) {
    const tag = d.readTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1: event.frame_number = d.readVarint64(); break;
      case 2: event.timestamp = d.readDouble(); break;
      case 3: event.detections.push(decodeDetection(d.readBytes())); break;
      default: d.skipField(tag.wireType);
    }
  }
  return event;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function decodeMonitorStats(bytes: Uint8Array): MonitorStats {
  const d = new ProtobufDecoder(bytes);
  const stats: MonitorStats = { frames_processed: 0, current_fps: 0, detection_count: 0, target_fps: 0 };
  while (d.remaining > 0) {
    const tag = d.readTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1: stats.frames_processed = d.readVarint(); break;
      case 2: stats.current_fps = d.readDouble(); break;
      case 3: stats.detection_count = d.readVarint(); break;
      case 4: stats.target_fps = d.readVarint(); break;
      default: d.skipField(tag.wireType);
    }
  }
  return stats;
}

function decodeSharedMemoryStats(bytes: Uint8Array): SharedMemoryStats {
  const d = new ProtobufDecoder(bytes);
  const stats: SharedMemoryStats = { frame_count: 0, total_frames_written: 0, detection_version: 0, has_detection: 0 };
  while (d.remaining > 0) {
    const tag = d.readTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1: stats.frame_count = d.readVarint(); break;
      case 2: stats.total_frames_written = d.readVarint(); break;
      case 3: stats.detection_version = d.readVarint(); break;
      case 4: stats.has_detection = d.readVarint(); break;
      default: d.skipField(tag.wireType);
    }
  }
  return stats;
}

function decodeDetectionResult(bytes: Uint8Array): DetectionResult {
  const d = new ProtobufDecoder(bytes);
  const result: DetectionResult = { frame_number: 0, timestamp: 0, num_detections: 0, version: 0, detections: [] };
  while (d.remaining > 0) {
    const tag = d.readTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1: result.frame_number = d.readVarint64(); break;
      case 2: result.timestamp = d.readDouble(); break;
      case 3: result.num_detections = d.readVarint(); break;
      case 4: result.version = d.readVarint(); break;
      case 5: result.detections.push(decodeDetection(d.readBytes())); break;
      default: d.skipField(tag.wireType);
    }
  }
  return result;
}

export function decodeStatusEvent(bytes: Uint8Array): StatusEvent {
  const d = new ProtobufDecoder(bytes);
  const event: StatusEvent = {
    monitor: null,
    shared_memory: null,
    latest_detection: null,
    detection_history: [],
    timestamp: 0,
  };
  while (d.remaining > 0) {
    const tag = d.readTag();
    if (!tag) break;
    switch (tag.fieldNumber) {
      case 1: event.monitor = decodeMonitorStats(d.readBytes()); break;
      case 2: event.shared_memory = decodeSharedMemoryStats(d.readBytes()); break;
      case 3: event.latest_detection = decodeDetectionResult(d.readBytes()); break;
      case 4: event.detection_history.push(decodeDetectionResult(d.readBytes())); break;
      case 5: event.timestamp = d.readDouble(); break;
      default: d.skipField(tag.wireType);
    }
  }
  return event;
}
