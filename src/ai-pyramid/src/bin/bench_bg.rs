//! Runtime benchmark for bg::score_frame and bg::build_model.
//!
//! Usage:
//!   cargo build --release --bin bench_bg
//!   ./target/release/bench_bg <jpeg_dir> [--ref-count N] [--warmup N] [--iterations N]
//!
//! Example:
//!   ./target/release/bench_bg src/ai-pyramid/data/photos --ref-count 5 --iterations 200

use pet_album::training::bg;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 || args[1] == "--help" {
        eprintln!(
            "Usage: bench_bg <jpeg_dir> [--ref-count N] [--warmup N] [--iterations N]\n\
             \n\
             Benchmarks bg::build_model and bg::score_frame.\n\
             Loads JPEGs from <jpeg_dir>, uses first --ref-count as reference frames\n\
             for the background model, then scores the remaining frames.\n\
             \n\
             Options:\n\
             --ref-count  N   Number of reference frames to build model (default: 5)\n\
             --warmup     N   Warmup iterations before timing (default: 10)\n\
             --iterations N   Timed scoring iterations (default: 200)"
        );
        std::process::exit(1);
    }

    let jpeg_dir = PathBuf::from(&args[1]);
    let mut ref_count: usize = 5;
    let mut warmup: usize = 10;
    let mut iterations: usize = 200;

    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--ref-count" => {
                ref_count = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(5);
                i += 2;
            }
            "--warmup" => {
                warmup = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(10);
                i += 2;
            }
            "--iterations" => {
                iterations = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(200);
                i += 2;
            }
            _ => i += 1,
        }
    }

    // ── Collect JPEG paths ────────────────────────────────────────────────────
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&jpeg_dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {}", jpeg_dir.display(), e))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("jpg") || s.eq_ignore_ascii_case("jpeg"))
                .unwrap_or(false)
        })
        .collect();
    paths.sort();

    if paths.len() < ref_count + 1 {
        eprintln!(
            "Error: need at least {} JPEGs in {}, found {}",
            ref_count + 1,
            jpeg_dir.display(),
            paths.len()
        );
        std::process::exit(1);
    }

    let ref_paths = &paths[..ref_count];
    let score_paths = &paths[ref_count..];
    let score_pool_len = score_paths.len();

    println!("jpeg_dir   : {}", jpeg_dir.display());
    println!("total jpegs: {}", paths.len());
    println!("ref frames : {ref_count}");
    println!("score pool : {score_pool_len}");
    println!("warmup     : {warmup}");
    println!("iterations : {iterations}");
    println!();

    // ── Benchmark: build_model ────────────────────────────────────────────────
    print!("Building background model ({ref_count} frames)... ");
    let t0 = Instant::now();
    let model = bg::build_model(ref_paths).unwrap_or_else(|e| panic!("build_model failed: {e}"));
    let build_ms = t0.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{:.1} ms  ({}×{}, {} px)",
        build_ms,
        model.width,
        model.height,
        model.width * model.height
    );

    // ── Benchmark: score_frame ────────────────────────────────────────────────
    println!("\nBenchmarking score_frame ({warmup} warmup + {iterations} timed)...");

    // Warmup
    for j in 0..warmup {
        let path = &score_paths[j % score_pool_len];
        let _ = bg::score_frame(&model, path).ok();
    }

    // Timed
    let mut times: Vec<Duration> = Vec::with_capacity(iterations);
    let mut scores: Vec<f32> = Vec::with_capacity(iterations);
    for j in 0..iterations {
        let path = &score_paths[j % score_pool_len];
        let t = Instant::now();
        let s = bg::score_frame(&model, path).unwrap_or(0.0);
        times.push(t.elapsed());
        scores.push(s);
    }

    // ── Stats ─────────────────────────────────────────────────────────────────
    let total: Duration = times.iter().sum();
    let mean_us = total.as_micros() as f64 / iterations as f64;
    let min_us = times.iter().map(|d| d.as_micros()).min().unwrap_or(0) as f64;
    let max_us = times.iter().map(|d| d.as_micros()).max().unwrap_or(0) as f64;

    // Percentiles
    let mut sorted_us: Vec<f64> = times.iter().map(|d| d.as_micros() as f64).collect();
    sorted_us.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = sorted_us[sorted_us.len() / 2];
    let p95 = sorted_us[(sorted_us.len() as f64 * 0.95) as usize];
    let p99 = sorted_us[(sorted_us.len() as f64 * 0.99) as usize];

    let fps = 1_000_000.0 / mean_us;

    println!();
    println!("score_frame timing ({iterations} iterations):");
    println!(
        "  mean  : {:>8.1} µs  ({:.1} ms)",
        mean_us,
        mean_us / 1000.0
    );
    println!("  min   : {:>8.1} µs", min_us);
    println!("  p50   : {:>8.1} µs", p50);
    println!("  p95   : {:>8.1} µs", p95);
    println!("  p99   : {:>8.1} µs", p99);
    println!("  max   : {:>8.1} µs", max_us);
    println!("  → {:.0} frames/sec theoretical max", fps);

    // Score distribution
    let mean_score = scores.iter().sum::<f32>() / scores.len() as f32;
    let min_score = scores.iter().cloned().fold(f32::INFINITY, f32::min);
    let max_score = scores.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    println!();
    println!("score distribution (% pixels deviated from background):");
    println!(
        "  mean={:.1}%  min={:.1}%  max={:.1}%",
        mean_score, min_score, max_score
    );
}
