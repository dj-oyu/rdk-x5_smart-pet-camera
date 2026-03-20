package webmonitor

import (
	"net/http"
	"os"
	"path/filepath"
)

type assetHandler struct {
	buildDir  string
	assetsDir string
}

func newAssetHandler(buildDir, assetsDir string) *assetHandler {
	return &assetHandler{
		buildDir:  buildDir,
		assetsDir: assetsDir,
	}
}

func (h *assetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	filename := filepath.Base(r.URL.Path)

	// Cache static assets to reduce SD card IO on reload
	ext := filepath.Ext(filename)
	switch ext {
	case ".js", ".css", ".woff2", ".woff", ".ttf":
		w.Header().Set("Cache-Control", "public, max-age=86400")
	case ".png", ".jpg", ".svg", ".ico":
		w.Header().Set("Cache-Control", "public, max-age=604800")
	}

	buildPath := filepath.Join(h.buildDir, filename)
	if fileExists(buildPath) {
		http.ServeFile(w, r, buildPath)
		return
	}

	assetPath := filepath.Join(h.assetsDir, filename)
	http.ServeFile(w, r, assetPath)
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}
