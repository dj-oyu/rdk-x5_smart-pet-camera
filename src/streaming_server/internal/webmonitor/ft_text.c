/**
 * ft_text.c — FreeType-based Unicode text + color emoji renderer
 *
 * Renders UTF-8 text to BGRA buffer using:
 * - Noto Sans JP for CJK/Latin glyphs
 * - Noto Color Emoji for color emoji (CBDT/CBLC bitmaps via FT_LOAD_COLOR)
 *
 * Fallback chain: text_font → emoji_font → skip glyph
 */

#include "ft_text.h"
#include <ft2build.h>
#include FT_FREETYPE_H
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

static FT_Library g_ft_lib = NULL;
static FT_Face g_text_face = NULL;
static FT_Face g_emoji_face = NULL;
static int g_initialized = 0;

/* ---- UTF-8 decoder ---- */

/* Decode one UTF-8 codepoint, advance *pos. Returns codepoint or 0xFFFD on error. */
static uint32_t utf8_decode(const char *text, int len, int *pos) {
    unsigned char c = (unsigned char)text[*pos];
    uint32_t cp;
    int extra;

    if (c < 0x80) {
        cp = c; extra = 0;
    } else if ((c & 0xE0) == 0xC0) {
        cp = c & 0x1F; extra = 1;
    } else if ((c & 0xF0) == 0xE0) {
        cp = c & 0x0F; extra = 2;
    } else if ((c & 0xF8) == 0xF0) {
        cp = c & 0x07; extra = 3;
    } else {
        (*pos)++;
        return 0xFFFD;
    }

    (*pos)++;
    for (int i = 0; i < extra && *pos < len; i++) {
        unsigned char next = (unsigned char)text[*pos];
        if ((next & 0xC0) != 0x80) return 0xFFFD;
        cp = (cp << 6) | (next & 0x3F);
        (*pos)++;
    }
    return cp;
}

/* ---- Emoji detection ---- */

/* Returns 1 if codepoint is likely an emoji that needs the color font. */
static int is_emoji_codepoint(uint32_t cp) {
    /* Common emoji ranges */
    if (cp >= 0x1F600 && cp <= 0x1F64F) return 1; /* Emoticons */
    if (cp >= 0x1F300 && cp <= 0x1F5FF) return 1; /* Misc Symbols & Pictographs */
    if (cp >= 0x1F680 && cp <= 0x1F6FF) return 1; /* Transport & Map */
    if (cp >= 0x1F900 && cp <= 0x1F9FF) return 1; /* Supplemental Symbols */
    if (cp >= 0x1FA00 && cp <= 0x1FA6F) return 1; /* Chess Symbols */
    if (cp >= 0x1FA70 && cp <= 0x1FAFF) return 1; /* Symbols Extended-A */
    if (cp >= 0x2600 && cp <= 0x26FF) return 1;   /* Misc Symbols */
    if (cp >= 0x2700 && cp <= 0x27BF) return 1;   /* Dingbats */
    if (cp >= 0xFE00 && cp <= 0xFE0F) return 1;   /* Variation Selectors */
    if (cp >= 0x200D && cp <= 0x200D) return 1;   /* ZWJ */
    if (cp == 0x2764 || cp == 0x2763) return 1;    /* Heart */
    if (cp >= 0x23E9 && cp <= 0x23F3) return 1;   /* Media controls */
    if (cp >= 0x1F1E0 && cp <= 0x1F1FF) return 1; /* Regional indicators (flags) */
    return 0;
}

/* ---- Glyph rendering ---- */

typedef struct {
    int x;           /* Horizontal position (pen advance) */
    int y_offset;    /* Vertical offset from baseline */
    int width;       /* Glyph bitmap width */
    int height;      /* Glyph bitmap height */
    int pitch;       /* Glyph bitmap row stride */
    int is_color;    /* 1 if BGRA color bitmap, 0 if grayscale */
    uint8_t *pixels; /* Glyph bitmap data (NOT owned, points into FT cache) */
    /* We need to copy because FT_Load_Char invalidates previous glyph */
    uint8_t *pixels_copy; /* Owned copy of pixels (must free) */
} rendered_glyph_t;

int ft_text_init(const char *text_font_path, const char *emoji_font_path) {
    if (g_initialized) return 0;

    FT_Error err = FT_Init_FreeType(&g_ft_lib);
    if (err) {
        fprintf(stderr, "[ft_text] FT_Init_FreeType failed: %d\n", err);
        return -1;
    }

    if (text_font_path) {
        err = FT_New_Face(g_ft_lib, text_font_path, 0, &g_text_face);
        if (err) {
            fprintf(stderr, "[ft_text] Failed to load text font %s: %d\n", text_font_path, err);
            return -2;
        }
        fprintf(stderr, "[ft_text] Text font loaded: %s (%s %s)\n",
                text_font_path, g_text_face->family_name, g_text_face->style_name);
    }

    if (emoji_font_path) {
        err = FT_New_Face(g_ft_lib, emoji_font_path, 0, &g_emoji_face);
        if (err) {
            fprintf(stderr, "[ft_text] Failed to load emoji font %s: %d (emoji disabled)\n",
                    emoji_font_path, err);
            /* Non-fatal: emoji just won't render */
        } else {
            fprintf(stderr, "[ft_text] Emoji font loaded: %s (has_color=%d)\n",
                    emoji_font_path, FT_HAS_COLOR(g_emoji_face) ? 1 : 0);
        }
    }

    g_initialized = 1;
    return 0;
}

int ft_text_render(
    const char *text,
    int size_pt,
    uint8_t fg_r, uint8_t fg_g, uint8_t fg_b,
    uint8_t bg_r, uint8_t bg_g, uint8_t bg_b, uint8_t bg_a,
    uint8_t **out_pixels,
    int *out_width,
    int *out_height
) {
    if (!g_initialized || !g_text_face || !text || !out_pixels) return -1;

    int len = (int)strlen(text);
    if (len == 0) return -1;

    /* Set font size */
    FT_Set_Pixel_Sizes(g_text_face, 0, size_pt);
    if (g_emoji_face) {
        /* For CBDT emoji, select the nearest strike size */
        FT_Select_Size(g_emoji_face, 0); /* Use first available strike */
    }

    /* === Pass 1: Measure all glyphs === */
    int max_glyphs = len; /* Upper bound (1 glyph per byte worst case) */
    rendered_glyph_t *glyphs = calloc(max_glyphs, sizeof(rendered_glyph_t));
    if (!glyphs) return -3;

    int num_glyphs = 0;
    int pen_x = 0;
    int max_ascent = 0;
    int max_descent = 0;

    int pos = 0;
    while (pos < len) {
        uint32_t cp = utf8_decode(text, len, &pos);
        if (cp == 0xFFFD) continue;

        /* Choose font: emoji font for emoji codepoints, text font otherwise */
        FT_Face face = g_text_face;
        int use_color = 0;

        if (g_emoji_face && is_emoji_codepoint(cp)) {
            FT_UInt glyph_idx = FT_Get_Char_Index(g_emoji_face, cp);
            if (glyph_idx != 0) {
                face = g_emoji_face;
                use_color = 1;
            }
        }

        FT_UInt glyph_idx = FT_Get_Char_Index(face, cp);
        if (glyph_idx == 0 && face == g_text_face && g_emoji_face) {
            /* Fallback: try emoji font for unknown glyphs */
            glyph_idx = FT_Get_Char_Index(g_emoji_face, cp);
            if (glyph_idx != 0) {
                face = g_emoji_face;
                use_color = 1;
            }
        }
        if (glyph_idx == 0) {
            /* Skip unknown glyph, advance by space width */
            pen_x += size_pt / 2;
            continue;
        }

        FT_Int32 load_flags = FT_LOAD_DEFAULT;
        if (use_color && FT_HAS_COLOR(face)) {
            load_flags |= FT_LOAD_COLOR;
        }

        FT_Error err = FT_Load_Glyph(face, glyph_idx, load_flags);
        if (err) continue;

        err = FT_Render_Glyph(face->glyph, FT_RENDER_MODE_NORMAL);
        if (err) continue;

        FT_Bitmap *bmp = &face->glyph->bitmap;
        int is_bgra = (bmp->pixel_mode == FT_PIXEL_MODE_BGRA);

        /* For color emoji, scale to match text size */
        int glyph_w = bmp->width;
        int glyph_h = bmp->rows;
        int scale_to = 0;

        if (is_bgra && glyph_h > 0 && glyph_h != size_pt) {
            /* Emoji bitmaps are fixed size (e.g., 136x128).
               We'll record the raw size and scale during compositing. */
            scale_to = size_pt;
        }

        /* Copy bitmap data (FT invalidates on next FT_Load_Glyph) */
        int data_size = bmp->pitch * bmp->rows;
        uint8_t *copy = NULL;
        if (data_size > 0) {
            copy = malloc(data_size);
            if (copy) memcpy(copy, bmp->buffer, data_size);
        }

        rendered_glyph_t *g = &glyphs[num_glyphs];
        g->x = pen_x + face->glyph->bitmap_left;
        g->y_offset = -face->glyph->bitmap_top; /* Negative = above baseline */
        g->width = glyph_w;
        g->height = glyph_h;
        g->pitch = bmp->pitch;
        g->is_color = is_bgra;
        g->pixels_copy = copy;

        /* Track vertical extents */
        int ascent = face->glyph->bitmap_top;
        int descent = glyph_h - ascent;
        if (scale_to > 0) {
            /* Scale extents proportionally */
            ascent = ascent * scale_to / glyph_h;
            descent = descent * scale_to / glyph_h;
        }
        if (ascent > max_ascent) max_ascent = ascent;
        if (descent > max_descent) max_descent = descent;

        int advance = (int)(face->glyph->advance.x >> 6);
        if (scale_to > 0) {
            advance = scale_to; /* Emoji: advance = size */
        }
        pen_x += advance;
        num_glyphs++;
    }

    if (num_glyphs == 0) {
        free(glyphs);
        return -4;
    }

    /* === Pass 2: Composite to BGRA buffer === */
    int pad = 4;
    int img_w = pen_x + pad * 2;
    int img_h = max_ascent + max_descent + pad * 2;
    int baseline_y = pad + max_ascent;

    uint8_t *pixels = calloc(img_w * img_h * 4, 1);
    if (!pixels) {
        for (int i = 0; i < num_glyphs; i++) free(glyphs[i].pixels_copy);
        free(glyphs);
        return -5;
    }

    /* Fill background */
    for (int y = 0; y < img_h; y++) {
        for (int x = 0; x < img_w; x++) {
            int idx = (y * img_w + x) * 4;
            pixels[idx + 0] = bg_b;
            pixels[idx + 1] = bg_g;
            pixels[idx + 2] = bg_r;
            pixels[idx + 3] = bg_a;
        }
    }

    /* Draw each glyph */
    for (int gi = 0; gi < num_glyphs; gi++) {
        rendered_glyph_t *g = &glyphs[gi];
        if (!g->pixels_copy || g->width == 0 || g->height == 0) continue;

        int dst_x = pad + g->x;
        int dst_y = baseline_y + g->y_offset;

        /* Determine if scaling is needed (emoji) */
        int src_w = g->width;
        int src_h = g->height;
        int dst_w = src_w;
        int dst_h = src_h;

        if (g->is_color && src_h != size_pt && src_h > 0) {
            dst_w = size_pt * src_w / src_h;
            dst_h = size_pt;
            /* Adjust y position for scaled emoji */
            dst_y = baseline_y - dst_h + (max_descent > 0 ? max_descent / 4 : 0);
        }

        for (int py = 0; py < dst_h; py++) {
            /* Source coordinate (nearest-neighbor scaling) */
            int sy = (dst_h != src_h) ? py * src_h / dst_h : py;
            if (sy >= src_h) sy = src_h - 1;

            for (int px = 0; px < dst_w; px++) {
                int sx = (dst_w != src_w) ? px * src_w / dst_w : px;
                if (sx >= src_w) sx = src_w - 1;

                int nx = dst_x + px;
                int ny = dst_y + py;
                if (nx < 0 || nx >= img_w || ny < 0 || ny >= img_h) continue;

                int dst_idx = (ny * img_w + nx) * 4;

                if (g->is_color) {
                    /* BGRA color bitmap (emoji) */
                    int src_idx = sy * g->pitch + sx * 4;
                    uint8_t sb = g->pixels_copy[src_idx + 0];
                    uint8_t sg_c = g->pixels_copy[src_idx + 1];
                    uint8_t sr = g->pixels_copy[src_idx + 2];
                    uint8_t sa = g->pixels_copy[src_idx + 3];

                    if (sa == 0) continue;
                    if (sa == 255) {
                        pixels[dst_idx + 0] = sb;
                        pixels[dst_idx + 1] = sg_c;
                        pixels[dst_idx + 2] = sr;
                        pixels[dst_idx + 3] = 255;
                    } else {
                        /* Alpha blend */
                        int inv = 255 - sa;
                        pixels[dst_idx + 0] = (sa * sb + inv * pixels[dst_idx + 0]) / 255;
                        pixels[dst_idx + 1] = (sa * sg_c + inv * pixels[dst_idx + 1]) / 255;
                        pixels[dst_idx + 2] = (sa * sr + inv * pixels[dst_idx + 2]) / 255;
                        pixels[dst_idx + 3] = sa + (inv * pixels[dst_idx + 3]) / 255;
                    }
                } else {
                    /* Grayscale glyph — apply foreground color */
                    int src_idx = sy * g->pitch + sx;
                    uint8_t alpha = g->pixels_copy[src_idx];
                    if (alpha == 0) continue;

                    if (alpha == 255) {
                        pixels[dst_idx + 0] = fg_b;
                        pixels[dst_idx + 1] = fg_g;
                        pixels[dst_idx + 2] = fg_r;
                        pixels[dst_idx + 3] = 255;
                    } else {
                        int inv = 255 - alpha;
                        pixels[dst_idx + 0] = (alpha * fg_b + inv * pixels[dst_idx + 0]) / 255;
                        pixels[dst_idx + 1] = (alpha * fg_g + inv * pixels[dst_idx + 1]) / 255;
                        pixels[dst_idx + 2] = (alpha * fg_r + inv * pixels[dst_idx + 2]) / 255;
                        pixels[dst_idx + 3] = alpha + (inv * pixels[dst_idx + 3]) / 255;
                    }
                }
            }
        }

        free(g->pixels_copy);
        g->pixels_copy = NULL;
    }

    free(glyphs);

    *out_pixels = pixels;
    *out_width = img_w;
    *out_height = img_h;
    return 0;
}

void ft_text_cleanup(void) {
    if (g_text_face) { FT_Done_Face(g_text_face); g_text_face = NULL; }
    if (g_emoji_face) { FT_Done_Face(g_emoji_face); g_emoji_face = NULL; }
    if (g_ft_lib) { FT_Done_FreeType(g_ft_lib); g_ft_lib = NULL; }
    g_initialized = 0;
}
