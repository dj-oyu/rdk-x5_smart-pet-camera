/*
 * logger.h - Lightweight Logging Library
 *
 * Simple, thread-safe logging for embedded systems.
 * Supports log levels, module names, and optional timestamps.
 */

#ifndef LOGGER_H
#define LOGGER_H

#include <stdio.h>

/**
 * Log levels
 */
typedef enum {
    LOG_LEVEL_DEBUG = 0,
    LOG_LEVEL_INFO  = 1,
    LOG_LEVEL_WARN  = 2,
    LOG_LEVEL_ERROR = 3,
    LOG_LEVEL_NONE  = 4   // Disable all logging
} log_level_t;

/**
 * Initialize logger
 *
 * Sets the global log level and output stream.
 *
 * Args:
 *   level: Minimum log level to output
 *   output: Output stream (stdout, stderr, or file)
 *   enable_timestamp: Enable timestamp in log messages
 */
void log_init(log_level_t level, FILE *output, int enable_timestamp);

/**
 * Set log level
 *
 * Changes the minimum log level at runtime.
 *
 * Args:
 *   level: New log level
 */
void log_set_level(log_level_t level);

/**
 * Log message with module name
 *
 * Internal function - use LOG_* macros instead.
 *
 * Args:
 *   level: Log level
 *   module: Module name (e.g., "VIO", "Encoder")
 *   fmt: Printf-style format string
 *   ...: Format arguments
 */
void log_message(log_level_t level, const char *module, const char *fmt, ...);

/**
 * Logging macros
 *
 * Usage:
 *   LOG_DEBUG("VIO", "Frame received: %d", frame_num);
 *   LOG_INFO("Encoder", "Started H.264 encoder");
 *   LOG_WARN("Pipeline", "Frame dropped");
 *   LOG_ERROR("VIO", "Failed to get frame: %d", ret);
 */
#define LOG_DEBUG(module, ...) log_message(LOG_LEVEL_DEBUG, module, __VA_ARGS__)
#define LOG_INFO(module, ...)  log_message(LOG_LEVEL_INFO, module, __VA_ARGS__)
#define LOG_WARN(module, ...)  log_message(LOG_LEVEL_WARN, module, __VA_ARGS__)
#define LOG_ERROR(module, ...) log_message(LOG_LEVEL_ERROR, module, __VA_ARGS__)

#endif // LOGGER_H
