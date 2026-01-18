# GPU Capability Investigation Plan

**Target**: Vivante GC8000L GPU on RDK X5 (D-Robotics)

**Objective**: Determine practical GPU acceleration opportunities for smart pet camera system

---

## Investigation Areas

### 1. GPU Basic Information
**Goal**: Understand GPU architecture and compute capabilities

**Methods**:
- OpenCL device query (compute units, work group size, memory)
- GPU clock speed and architecture details
- Driver version and OpenCL support level

**Expected Outputs**:
- GPU compute units count
- Maximum work group size
- Global/local memory sizes
- OpenCL version supported

**Tools**:
- `clinfo` (if available)
- Custom OpenCL query program
- `/sys` filesystem inspection

---

### 2. Video Encode/Decode Hardware Support
**Goal**: Identify hardware video codec capabilities

**Methods**:
- V4L2 encoder/decoder device enumeration
- GStreamer hardware plugin detection
- Vivante VPU (Video Processing Unit) documentation review
- `v4l2-ctl` device capabilities query

**Expected Outputs**:
- List of supported codecs (H.264, H.265, VP8, VP9)
- Maximum resolution and framerate
- Available V4L2 devices (`/dev/video*`)
- GStreamer hardware elements

**Priority**: **HIGH** - Direct impact on streaming performance

---

### 3. OpenCL Performance Benchmarking
**Goal**: Measure actual GPU compute performance

**Benchmarks**:
1. **Memory Bandwidth Test**
   - Host-to-Device transfer
   - Device-to-Host transfer
   - Device-to-Device transfer

2. **Compute Performance Test**
   - GFLOPS (single precision)
   - Integer operations
   - Matrix multiplication

3. **Small Packet Processing Test**
   - Simulate RTP packet encryption workload
   - Measure overhead for small data transfers

**Expected Outputs**:
- Memory bandwidth (GB/s)
- Compute performance (GFLOPS)
- Transfer latency for small buffers

**Tools**:
- Custom OpenCL benchmarks
- clpeak (if portable)

---

### 4. NPU/VPU Investigation
**Goal**: Discover specialized accelerators beyond GPU

**Methods**:
- Check for NPU (Neural Processing Unit) devices
- Identify VPU (Video Processing Unit) separate from GPU
- Review D-Robotics documentation
- Check `/dev` for specialized devices

**Devices to Check**:
- `/dev/vpu*`
- `/dev/npu*`
- `/dev/bpu*` (BPU = Brain Processing Unit, D-Robotics terminology)
- `/sys/class/bpu/`

**Expected Outputs**:
- Available accelerator types
- Driver interfaces
- Performance characteristics

**Priority**: **MEDIUM** - May offer alternative acceleration paths

---

### 5. GStreamer Hardware Acceleration
**Goal**: Validate GStreamer pipeline hardware support

**Methods**:
- List available GStreamer plugins with hardware acceleration
- Test H.264 hardware encoding pipeline
- Measure CPU usage comparison

**Tests**:
```bash
# List hardware plugins
gst-inspect-1.0 | grep -i "vivante\|imx\|v4l2\|mpp"

# Test hardware H.264 encode
gst-launch-1.0 videotestsrc ! <hw_encoder> ! filesink location=test.h264

# Compare CPU usage: software vs hardware
```

**Expected Outputs**:
- Available hardware encoder elements
- Performance comparison (CPU usage, latency)
- Pipeline compatibility with existing system

**Priority**: **HIGH** - Potential alternative to current implementation

---

### 6. Image Processing Capabilities
**Goal**: Assess GPU suitability for image processing

**Potential Use Cases**:
- NV12 to RGB conversion (currently done in C)
- Image scaling/rotation
- Noise reduction
- Motion detection preprocessing

**Methods**:
- OpenCL kernel development for NV12→RGB
- Performance comparison with existing C implementation
- Latency measurement

**Expected Outputs**:
- Processing time comparison
- CPU offload potential
- Integration complexity

**Priority**: **LOW** - Current C implementation already optimized

---

## Investigation Order

### Phase 1: Quick Assessment (30 minutes)
1. GPU basic information collection
2. V4L2 device enumeration
3. GStreamer plugin listing
4. NPU/VPU device check

**Deliverable**: Initial feasibility report

### Phase 2: Hardware Video Codec Testing (1 hour)
1. V4L2 encoder capability testing
2. GStreamer hardware pipeline validation
3. Performance measurement

**Deliverable**: Video codec acceleration report

### Phase 3: OpenCL Benchmarking (1 hour)
1. Memory bandwidth testing
2. Compute performance testing
3. Small packet processing simulation

**Deliverable**: OpenCL performance profile

### Phase 4: Integration Planning (30 minutes)
1. Document findings
2. Identify actionable optimization opportunities
3. Estimate implementation effort

**Deliverable**: GPU capability report with recommendations

---

## Success Criteria

### High Value Findings:
- ✅ Hardware H.264 encoder available and usable
- ✅ GStreamer pipeline can replace current implementation
- ✅ Significant CPU offload (>30% reduction)

### Medium Value Findings:
- ✅ OpenCL performance justifies specific workload offload
- ✅ NPU/VPU available for specialized tasks

### Low Value Findings:
- ⚠️ GPU available but transfer overhead too high
- ⚠️ Hardware encoder exists but integration too complex

---

## Documentation Output

**Final Report**: `docs/gpu_capability_report.md`

**Sections**:
1. Executive Summary
2. Hardware Inventory
3. Performance Benchmarks
4. Integration Opportunities
5. Recommendations
6. Implementation Effort Estimates

---

## Tools and Scripts

### Required Tools:
- `clinfo` - OpenCL device information
- `v4l2-ctl` - V4L2 device capabilities
- `gst-inspect-1.0` - GStreamer plugin inspection
- `gcc` - Compile test programs
- Custom OpenCL benchmarks (to be developed)

### Scripts to Develop:
1. `scripts/gpu_info.sh` - Collect all GPU-related information
2. `scripts/opencl_benchmark.c` - OpenCL performance testing
3. `scripts/test_hw_encoder.sh` - V4L2/GStreamer encoder testing

---

## Risk Assessment

### Technical Risks:
- **Incomplete documentation**: D-Robotics/Vivante may have limited public docs
- **Driver limitations**: Proprietary drivers may restrict access
- **Integration complexity**: Hardware encoder API may differ significantly

### Mitigation:
- Focus on standard interfaces (V4L2, GStreamer)
- Test incrementally before committing to major refactor
- Document all findings for future reference

---

## Timeline

**Total Estimated Time**: 3-4 hours

- Phase 1: 30 minutes
- Phase 2: 1 hour
- Phase 3: 1 hour
- Phase 4: 30 minutes
- Buffer: 1 hour for unexpected issues

---

## Next Steps

1. Execute Phase 1 investigation
2. Review findings and adjust plan
3. Proceed with high-priority areas
4. Document results and recommendations
