/**
 * ft_text.h — FreeType-based Unicode text + color emoji renderer
 *
 * Renders UTF-8 text (Japanese, English, emoji) to BGRA pixel buffer.
 * Uses Noto Sans JP for text, Noto Color Emoji for emoji (CBDT/CBLC).
 * Output is pre-multiplied BGRA suitable for alpha blending onto NV12.
 *
 * Thread-safe after ft_text_init().
 */

#ifndef FT_TEXT_H
#define FT_TEXT_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize the text renderer with font files.
 * Call once at startup. Returns 0 on success.
 *
 * @param text_font_path  Path to Noto Sans JP (or similar CJK TTF/OTF)
 * @param emoji_font_path Path to Noto Color Emoji TTF (NULL to disable emoji)
 */
int ft_text_init(const char *text_font_path, const char *emoji_font_path);

/**
 * Render UTF-8 text to a BGRA pixel buffer.
 *
 * Allocates *out_pixels via malloc (caller must free).
 * Text glyphs come from the text font; emoji codepoints fall back
 * to the emoji font automatically.
 *
 * @param text        UTF-8 encoded string
 * @param size_pt     Font size in points (e.g., 24)
 * @param fg_r,fg_g,fg_b  Foreground color (0-255)
 * @param bg_r,bg_g,bg_b,bg_a  Background color with alpha (0-255)
 * @param out_pixels  Output: malloc'd BGRA buffer (caller frees)
 * @param out_width   Output: image width in pixels
 * @param out_height  Output: image height in pixels
 * @return 0 on success, negative on error
 */
int ft_text_render(
    const char *text,
    int size_pt,
    uint8_t fg_r, uint8_t fg_g, uint8_t fg_b,
    uint8_t bg_r, uint8_t bg_g, uint8_t bg_b, uint8_t bg_a,
    uint8_t **out_pixels,
    int *out_width,
    int *out_height
);

/**
 * Cleanup and release FreeType resources.
 */
void ft_text_cleanup(void);

#ifdef __cplusplus
}
#endif

#endif /* FT_TEXT_H */
