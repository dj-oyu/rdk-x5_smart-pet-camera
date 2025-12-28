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
