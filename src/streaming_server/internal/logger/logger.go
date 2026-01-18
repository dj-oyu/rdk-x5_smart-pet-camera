package logger

import (
	"fmt"
	"io"
	"log"
	"os"
	"sync"
)

// LogLevel represents the severity of a log message
type LogLevel int

const (
	DEBUG LogLevel = iota
	INFO
	WARN
	ERROR
	SILENT // No logging
)

var (
	levelNames = map[LogLevel]string{
		DEBUG:  "DEBUG",
		INFO:   "INFO",
		WARN:   "WARN",
		ERROR:  "ERROR",
		SILENT: "SILENT",
	}

	levelColors = map[LogLevel]string{
		DEBUG:  "\033[36m", // Cyan
		INFO:   "\033[32m", // Green
		WARN:   "\033[33m", // Yellow
		ERROR:  "\033[31m", // Red
		SILENT: "",
	}

	resetColor = "\033[0m"
)

// Logger provides leveled logging with module support
type Logger struct {
	mu          sync.Mutex
	level       LogLevel
	output      io.Writer
	useColor    bool
	debugLogger *log.Logger
	infoLogger  *log.Logger
	warnLogger  *log.Logger
	errorLogger *log.Logger
}

var defaultLogger *Logger
var once sync.Once

// Init initializes the global logger (call once at startup)
func Init(level LogLevel, output io.Writer, useColor bool) {
	once.Do(func() {
		defaultLogger = New(level, output, useColor)
	})
}

// New creates a new Logger instance
func New(level LogLevel, output io.Writer, useColor bool) *Logger {
	if output == nil {
		output = os.Stderr
	}

	flags := log.Ldate | log.Ltime | log.Lmicroseconds

	return &Logger{
		level:       level,
		output:      output,
		useColor:    useColor,
		debugLogger: log.New(output, "", flags),
		infoLogger:  log.New(output, "", flags),
		warnLogger:  log.New(output, "", flags),
		errorLogger: log.New(output, "", flags),
	}
}

// SetLevel changes the log level
func (l *Logger) SetLevel(level LogLevel) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.level = level
}

// GetLevel returns the current log level
func (l *Logger) GetLevel() LogLevel {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.level
}

func (l *Logger) log(level LogLevel, module string, format string, args ...interface{}) {
	l.mu.Lock()
	currentLevel := l.level
	l.mu.Unlock()

	if level < currentLevel {
		return
	}

	var logger *log.Logger
	switch level {
	case DEBUG:
		logger = l.debugLogger
	case INFO:
		logger = l.infoLogger
	case WARN:
		logger = l.warnLogger
	case ERROR:
		logger = l.errorLogger
	default:
		return
	}

	levelName := levelNames[level]
	prefix := fmt.Sprintf("[%s]", levelName)

	if l.useColor {
		color := levelColors[level]
		prefix = color + prefix + resetColor
	}

	if module != "" {
		prefix = fmt.Sprintf("%s [%s]", prefix, module)
	}

	message := fmt.Sprintf(format, args...)
	logger.Printf("%s %s", prefix, message)
}

// Debug logs a debug message
func (l *Logger) Debug(module string, format string, args ...interface{}) {
	l.log(DEBUG, module, format, args...)
}

// Info logs an info message
func (l *Logger) Info(module string, format string, args ...interface{}) {
	l.log(INFO, module, format, args...)
}

// Warn logs a warning message
func (l *Logger) Warn(module string, format string, args ...interface{}) {
	l.log(WARN, module, format, args...)
}

// Error logs an error message
func (l *Logger) Error(module string, format string, args ...interface{}) {
	l.log(ERROR, module, format, args...)
}

// Global logger functions (use default logger)

// SetLevel sets the global log level
func SetLevel(level LogLevel) {
	if defaultLogger != nil {
		defaultLogger.SetLevel(level)
	}
}

// GetLevel returns the global log level
func GetLevel() LogLevel {
	if defaultLogger != nil {
		return defaultLogger.GetLevel()
	}
	return INFO
}

// Debug logs a debug message using the global logger
func Debug(module string, format string, args ...interface{}) {
	if defaultLogger != nil {
		defaultLogger.Debug(module, format, args...)
	}
}

// Info logs an info message using the global logger
func Info(module string, format string, args ...interface{}) {
	if defaultLogger != nil {
		defaultLogger.Info(module, format, args...)
	}
}

// Warn logs a warning message using the global logger
func Warn(module string, format string, args ...interface{}) {
	if defaultLogger != nil {
		defaultLogger.Warn(module, format, args...)
	}
}

// Error logs an error message using the global logger
func Error(module string, format string, args ...interface{}) {
	if defaultLogger != nil {
		defaultLogger.Error(module, format, args...)
	}
}

// ParseLevel parses a log level string
func ParseLevel(s string) (LogLevel, error) {
	switch s {
	case "debug", "DEBUG":
		return DEBUG, nil
	case "info", "INFO":
		return INFO, nil
	case "warn", "WARN", "warning", "WARNING":
		return WARN, nil
	case "error", "ERROR":
		return ERROR, nil
	case "silent", "SILENT", "none", "NONE":
		return SILENT, nil
	default:
		return INFO, fmt.Errorf("invalid log level: %s", s)
	}
}

// String returns the string representation of a log level
func (l LogLevel) String() string {
	if name, ok := levelNames[l]; ok {
		return name
	}
	return "UNKNOWN"
}
