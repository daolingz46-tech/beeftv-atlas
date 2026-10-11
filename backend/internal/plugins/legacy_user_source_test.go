package plugins

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestLegacyUserSourceMigratesToUploadedAndSurvivesRestart(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	pkg := testPluginPackage(t, testManifest("legacy-atlas-user", "1.0.0"))
	fileRuntime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fileRuntime.Install(pkg, "atlas-user.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	records, err := fileRuntime.readRegistry()
	if err != nil {
		t.Fatal(err)
	}
	for i := range records {
		if records[i].ID == "legacy-atlas-user" {
			records[i].Source = "user"
		}
	}
	if err := fileRuntime.writeRegistry(records); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dataDir, "plugin_registry.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		runtime, err := NewRuntimeWithStore(dataDir, store)
		if err != nil {
			t.Fatal(err)
		}
		assertImmediatePlugin(t, runtime, "legacy-atlas-user", "1.0.0", StatusEnabled, pkg)
		view, ok := ByID(runtime.List(), "legacy-atlas-user")
		if !ok || view.Source != OriginUploaded {
			t.Fatalf("legacy user package must remain uploaded, got %#v", view)
		}
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("legacy disk registry must be preserved after importing to SQLite")
	}
	if err := validateRecordSource("user"); err == nil {
		t.Fatal("legacy alias must not weaken validation of new authoritative records")
	}
}
