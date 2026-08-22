/// Convert RGB image to NV12 (Y plane + interleaved UV plane).
pub(super) fn rgb_to_nv12(rgb: &image::RgbImage, width: u32, height: u32) -> Vec<u8> {
    let mut nv12 = vec![0u8; (width * height * 3 / 2) as usize];
    let (y_plane, uv_plane) = nv12.split_at_mut((width * height) as usize);

    for row in 0..height {
        for col in 0..width {
            let pixel = rgb.get_pixel(col, row).0;
            let y = (66 * pixel[0] as i32 + 129 * pixel[1] as i32 + 25 * pixel[2] as i32 + 128)
                / 256
                + 16;
            y_plane[(row * width + col) as usize] = y.clamp(0, 255) as u8;
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
            let uv_index = (row / 2 * width + col) as usize;
            uv_plane[uv_index] = u.clamp(0, 255) as u8;
            uv_plane[uv_index + 1] = v.clamp(0, 255) as u8;
        }
    }

    nv12
}
