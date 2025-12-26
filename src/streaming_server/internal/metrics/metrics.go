package metrics

import (
	"net/http"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics holds all application metrics
type Metrics struct {
	// Frame processing counters
	FramesRead          atomic.Uint64
	FramesProcessed     atomic.Uint64
	FramesDropped       atomic.Uint64
	WebRTCFramesSent    atomic.Uint64
	WebRTCFramesDropped atomic.Uint64
	RecorderFramesSent  atomic.Uint64
	RecorderFramesDropped atomic.Uint64

	// Error counters
	ReadErrors      atomic.Uint64
	ProcessErrors   atomic.Uint64
	WebRTCErrors    atomic.Uint64
	RecorderErrors  atomic.Uint64

	// Latency tracking
	FrameLatencyMs  atomic.Uint64 // Average frame latency in ms
	ProcessLatencyMs atomic.Uint64 // Average processing latency in ms

	// Buffer usage
	WebRTCBufferUsage   atomic.Uint64 // Percentage (0-100)
	RecorderBufferUsage atomic.Uint64 // Percentage (0-100)

	// WebRTC client tracking
	ActiveClients atomic.Uint64
	TotalClients  atomic.Uint64

	// Recording state
	RecordingActive atomic.Uint64 // 0 = inactive, 1 = active
	RecordingBytes  atomic.Uint64
	RecordingFrames atomic.Uint64

	// Prometheus collectors
	registry *prometheus.Registry
}

// New creates a new Metrics instance with Prometheus collectors
func New() *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
	}

	// Register Prometheus gauges
	m.registerPrometheusMetrics()

	return m
}

// registerPrometheusMetrics registers all metrics with Prometheus
func (m *Metrics) registerPrometheusMetrics() {
	// Frame processing metrics
	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_frames_read_total",
			Help: "Total frames read from shared memory",
		},
		func() float64 { return float64(m.FramesRead.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_frames_processed_total",
			Help: "Total frames processed",
		},
		func() float64 { return float64(m.FramesProcessed.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_frames_dropped_total",
			Help: "Total frames dropped",
		},
		func() float64 { return float64(m.FramesDropped.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_webrtc_frames_sent_total",
			Help: "Total frames sent to WebRTC clients",
		},
		func() float64 { return float64(m.WebRTCFramesSent.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_webrtc_frames_dropped_total",
			Help: "Total WebRTC frames dropped",
		},
		func() float64 { return float64(m.WebRTCFramesDropped.Load()) },
	))

	// Error metrics
	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_read_errors_total",
			Help: "Total shared memory read errors",
		},
		func() float64 { return float64(m.ReadErrors.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_process_errors_total",
			Help: "Total frame processing errors",
		},
		func() float64 { return float64(m.ProcessErrors.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_webrtc_errors_total",
			Help: "Total WebRTC errors",
		},
		func() float64 { return float64(m.WebRTCErrors.Load()) },
	))

	// Latency metrics
	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_frame_latency_ms",
			Help: "Average frame latency in milliseconds",
		},
		func() float64 { return float64(m.FrameLatencyMs.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_process_latency_ms",
			Help: "Average processing latency in milliseconds",
		},
		func() float64 { return float64(m.ProcessLatencyMs.Load()) },
	))

	// Buffer usage metrics
	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_webrtc_buffer_usage_percent",
			Help: "WebRTC buffer usage percentage",
		},
		func() float64 { return float64(m.WebRTCBufferUsage.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_recorder_buffer_usage_percent",
			Help: "Recorder buffer usage percentage",
		},
		func() float64 { return float64(m.RecorderBufferUsage.Load()) },
	))

	// Client metrics
	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_active_clients",
			Help: "Number of active WebRTC clients",
		},
		func() float64 { return float64(m.ActiveClients.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_total_clients",
			Help: "Total WebRTC clients connected",
		},
		func() float64 { return float64(m.TotalClients.Load()) },
	))

	// Recording metrics
	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_recording_active",
			Help: "Recording active (0=inactive, 1=active)",
		},
		func() float64 { return float64(m.RecordingActive.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_recording_bytes",
			Help: "Total bytes written to recording",
		},
		func() float64 { return float64(m.RecordingBytes.Load()) },
	))

	m.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "streaming_recording_frames",
			Help: "Total frames written to recording",
		},
		func() float64 { return float64(m.RecordingFrames.Load()) },
	))
}

// UpdateFrameLatency updates the average frame latency
func (m *Metrics) UpdateFrameLatency(captureTime time.Time) {
	latency := time.Since(captureTime).Milliseconds()
	m.FrameLatencyMs.Store(uint64(latency))
}

// UpdateProcessLatency updates the average processing latency
func (m *Metrics) UpdateProcessLatency(duration time.Duration) {
	m.ProcessLatencyMs.Store(uint64(duration.Milliseconds()))
}

// UpdateBufferUsage updates buffer usage percentages
func (m *Metrics) UpdateBufferUsage(webrtcUsed, webrtcCap, recorderUsed, recorderCap int) {
	if webrtcCap > 0 {
		usage := uint64(webrtcUsed * 100 / webrtcCap)
		m.WebRTCBufferUsage.Store(usage)
	}
	if recorderCap > 0 {
		usage := uint64(recorderUsed * 100 / recorderCap)
		m.RecorderBufferUsage.Store(usage)
	}
}

// Handler returns the Prometheus HTTP handler
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// StartServer starts the metrics HTTP server
func (m *Metrics) StartServer(addr string) error {
	http.Handle("/metrics", m.Handler())
	return http.ListenAndServe(addr, nil)
}
