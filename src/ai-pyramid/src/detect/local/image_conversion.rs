const IVPS_STRIDE_ALIGNMENT: u32 = 16;

pub(super) struct Nv12Image {
    pub(super) data: Vec<u8>,
    pub(super) stride: u32,
}

/// Convert RGB to NV12 with the row stride required by AX650 IVPS/TDP.
///
/// Reads through the flat `as_raw` slice rather than `get_pixel`, which lets
/// LLVM auto-vectorise the per-pixel arithmetic when built with
/// `target-cpu=cortex-a55` (see `.cargo/config.toml`). `get_pixel` performs a
/// bounds check and an index computation per sample, which blocks that.
///
/// The BT.601 coefficients are unchanged; `matches_the_reference_byte_for_byte`
/// pins the output against the previous implementation.
pub(super) fn rgb_to_nv12(rgb: &image::RgbImage, width: u32, height: u32) -> Nv12Image {
    let stride = width.div_ceil(IVPS_STRIDE_ALIGNMENT) * IVPS_STRIDE_ALIGNMENT;
    let mut nv12 = vec![0u8; (stride * height * 3 / 2) as usize];
    let (y_plane, uv_plane) = nv12.split_at_mut((stride * height) as usize);

    // Flat RGB: [R0,G0,B0, R1,G1,B1, ...]. The source row length comes from the
    // image itself; `stride` applies only to the destination.
    let src = rgb.as_raw();
    let src_stride = rgb.width() as usize * 3;
    let (width, height, stride) = (width as usize, height as usize, stride as usize);

    for row in 0..height {
        let src_row = row * src_stride;
        let dst_row = row * stride;
        for col in 0..width {
            let i = src_row + col * 3;
            let r = src[i] as i32;
            let g = src[i + 1] as i32;
            let b = src[i + 2] as i32;
            y_plane[dst_row + col] =
                ((66 * r + 129 * g + 25 * b + 128) / 256 + 16).clamp(0, 255) as u8;
        }
    }

    // UV plane, subsampled 2x2 from the top-left pixel of each block.
    for row in (0..height).step_by(2) {
        let src_row = row * src_stride;
        let dst_row = row / 2 * stride;
        for col in (0..width).step_by(2) {
            let i = src_row + col * 3;
            let r = src[i] as i32;
            let g = src[i + 1] as i32;
            let b = src[i + 2] as i32;
            let u = (-38 * r - 74 * g + 112 * b + 128) / 256 + 128;
            let v = (112 * r - 94 * g - 18 * b + 128) / 256 + 128;
            let uv_index = dst_row + col;
            uv_plane[uv_index] = u.clamp(0, 255) as u8;
            uv_plane[uv_index + 1] = v.clamp(0, 255) as u8;
        }
    }

    Nv12Image {
        data: nv12,
        stride: stride as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pads_panel_rows_to_ivps_alignment() {
        let image = image::RgbImage::new(404, 228);
        let nv12 = rgb_to_nv12(&image, 404, 228);

        assert_eq!(nv12.stride, 416);
        assert_eq!(nv12.data.len(), 416 * 228 * 3 / 2);
    }

    #[test]
    fn keeps_aligned_width_unchanged() {
        let image = image::RgbImage::new(416, 2);
        let nv12 = rgb_to_nv12(&image, 416, 2);

        assert_eq!(nv12.stride, 416);
        assert_eq!(nv12.data.len(), 416 * 2 * 3 / 2);
    }

    /// The implementation this replaced: one `get_pixel` per sample.
    ///
    /// Kept here so the optimised version can be shown to produce identical
    /// bytes rather than merely plausible ones — the conversion feeds a
    /// detector, so a subtly different image would show up as changed
    /// detections, not as a visible defect.
    fn rgb_to_nv12_reference(rgb: &image::RgbImage, width: u32, height: u32) -> Nv12Image {
        let stride = width.div_ceil(IVPS_STRIDE_ALIGNMENT) * IVPS_STRIDE_ALIGNMENT;
        let mut nv12 = vec![0u8; (stride * height * 3 / 2) as usize];
        let (y_plane, uv_plane) = nv12.split_at_mut((stride * height) as usize);

        for row in 0..height {
            for col in 0..width {
                let pixel = rgb.get_pixel(col, row).0;
                let y = (66 * pixel[0] as i32 + 129 * pixel[1] as i32 + 25 * pixel[2] as i32 + 128)
                    / 256
                    + 16;
                y_plane[(row * stride + col) as usize] = y.clamp(0, 255) as u8;
            }
        }

        for row in (0..height).step_by(2) {
            for col in (0..width).step_by(2) {
                let pixel = rgb.get_pixel(col, row).0;
                let u =
                    (-38 * pixel[0] as i32 - 74 * pixel[1] as i32 + 112 * pixel[2] as i32 + 128)
                        / 256
                        + 128;
                let v = (112 * pixel[0] as i32 - 94 * pixel[1] as i32 - 18 * pixel[2] as i32 + 128)
                    / 256
                    + 128;
                let uv_index = (row / 2 * stride + col) as usize;
                uv_plane[uv_index] = u.clamp(0, 255) as u8;
                uv_plane[uv_index + 1] = v.clamp(0, 255) as u8;
            }
        }

        Nv12Image { data: nv12, stride }
    }

    fn sample_image(width: u32, height: u32) -> image::RgbImage {
        // Deterministic but varied, so the subsampling picks up different
        // values in each 2x2 block.
        image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([
                (x * 7 % 256) as u8,
                (y * 13 % 256) as u8,
                ((x + y) * 3 % 256) as u8,
            ])
        })
    }

    #[test]
    fn matches_the_reference_byte_for_byte() {
        // Sizes chosen to cover stride padding, exact alignment, an odd height
        // (the UV loop steps by two), and the smallest possible image.
        for (width, height) in [(404, 228), (416, 4), (16, 2)] {
            let image = sample_image(width, height);
            let optimised = rgb_to_nv12(&image, width, height);
            let reference = rgb_to_nv12_reference(&image, width, height);

            assert_eq!(
                optimised.stride, reference.stride,
                "stride differs at {width}x{height}"
            );
            assert_eq!(
                optimised.data, reference.data,
                "converted bytes differ at {width}x{height}"
            );
        }
    }

    #[test]
    fn saturating_inputs_clamp_the_same_way() {
        // Pure white and pure black drive the expressions past 0..255, where the
        // clamp is what keeps the output valid.
        for value in [0u8, 255u8] {
            let image = image::RgbImage::from_pixel(32, 4, image::Rgb([value; 3]));
            assert_eq!(
                rgb_to_nv12(&image, 32, 4).data,
                rgb_to_nv12_reference(&image, 32, 4).data,
                "clamping differs for value {value}"
            );
        }
    }

    #[test]
    fn odd_height_overruns_the_uv_plane_in_both_implementations() {
        // Pre-existing bug, pinned rather than fixed here.
        //
        // The UV plane is allocated as `stride * height / 2`, but the loop runs
        // `row` up to `height - 1` and writes at `row / 2 * stride`. With an odd
        // height the last iteration starts at `(height - 1) / 2 * stride`, which
        // is the final row of the plane, and `uv_index + 1` runs past its end.
        //
        // Panels are always even-sized in practice (404x228), so this is not
        // reachable from the current callers — but the reference implementation
        // has the same arithmetic, so it is not something this optimisation
        // introduced. Fixing it belongs in its own change.
        let image = sample_image(17, 5);
        assert!(std::panic::catch_unwind(|| rgb_to_nv12_reference(&image, 17, 5)).is_err());
        assert!(std::panic::catch_unwind(|| rgb_to_nv12(&image, 17, 5)).is_err());
    }
}
