/*
 * logger.c - Lightweight Logging Implementation
 */

#include "logger.h"
#include <stdarg.h>
#include <time.h>
#include <pthread.h>
#include <string.h>
#include <unistd.h>

// Global logger state
static struct {
    log_level_t level;
    FILE *output;
    int enable_timestamp;
    pthread_mutex_t mutex;
} g_logger = {
    .level = LOG_LEVEL_INFO,
    .output = NULL,  // Will be set to stdout in log_init
    .enable_timestamp = 0,
    .mutex = PTHREAD_MUTEX_INITIALIZER
};

// Log level names
static const char *level_names[] = {
    "DEBUG",
    "INFO ",
    "WARN ",
    "ERROR"
};

// Log level colors (ANSI codes for terminal)
static const char *level_colors[] = {
    "\033[36m",  // Cyan for DEBUG
    "\033[32m",  // Green for INFO
    "\033[33m",  // Yellow for WARN
    "\033[31m"   // Red for ERROR
};

static const char *color_reset = "\033[0m";

void log_init(log_level_t level, FILE *output, int enable_timestamp) {
    pthread_mutex_lock(&g_logger.mutex);

    g_logger.level = level;
    g_logger.output = output ? output : stdout;
    g_logger.enable_timestamp = enable_timestamp;

    pthread_mutex_unlock(&g_logger.mutex);
}

void log_set_level(log_level_t level) {
    pthread_mutex_lock(&g_logger.mutex);
    g_logger.level = level;
    pthread_mutex_unlock(&g_logger.mutex);
}

void log_message(log_level_t level, const char *module, const char *fmt, ...) {
    // Check if this log level should be output
    if (level < g_logger.level || level >= LOG_LEVEL_NONE) {
        return;
    }

    pthread_mutex_lock(&g_logger.mutex);

    FILE *out = g_logger.output ? g_logger.output : stdout;

    // Print timestamp if enabled
    if (g_logger.enable_timestamp) {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        fprintf(out, "[%6ld.%03ld] ", ts.tv_sec % 1000000, ts.tv_nsec / 1000000);
    }

    // Check if output is a terminal (for color support)
    int use_color = isatty(fileno(out));

    // Print log level with optional color
    if (use_color) {
        fprintf(out, "%s[%s]%s ", level_colors[level], level_names[level], color_reset);
    } else {
        fprintf(out, "[%s] ", level_names[level]);
    }

    // Print module name
    if (module && module[0]) {
        fprintf(out, "[%s] ", module);
    }

    // Print user message
    va_list args;
    va_start(args, fmt);
    vfprintf(out, fmt, args);
    va_end(args);

    fprintf(out, "\n");
    fflush(out);

    pthread_mutex_unlock(&g_logger.mutex);
}
