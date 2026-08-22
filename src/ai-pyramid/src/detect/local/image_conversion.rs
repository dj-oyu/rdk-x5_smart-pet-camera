const IVPS_STRIDE_ALIGNMENT: u32 = 16;

pub(super) struct Nv12Image {
    pub(super) data: Vec<u8>,
    pub(super) stride: u32,
}

/// Convert RGB to NV12 with the row stride required by AX650 IVPS/TDP.
pub(super) fn rgb_to_nv12(rgb: &image::RgbImage, width: u32, height: u32) -> Nv12Image {
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
            let u = (-38 * pixel[0] as i32 - 74 * pixel[1] as i32 + 112 * pixel[2] as i32 + 128)
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
}
