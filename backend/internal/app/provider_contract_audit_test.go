package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

// Public synthetic fixtures exercise the production request builder, never HTTP.
func TestAtlasGenerationContractsOffline(t *testing.T) {
	root := os.Getenv("BEEFTV_ATLAS_MAPPING_TEST_ROOT")
	if root == "" {
		t.Skip("public Atlas fixtures not configured")
	}
	files, err := filepath.Glob(filepath.Join(root, "packages", "*.beeftv-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	adapters := map[string]protocol.Adapter{}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		pkg, err := protocol.ParsePluginPackage(data)
		if err != nil {
			t.Fatal(err)
		}
		providers, err := protocol.LoadInstalledProviders(pkg.ManifestRaw, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, adapter := range providers {
			adapters[adapter.Metadata().ID] = adapter
		}
	}
	var cases []struct {
		Name     string
		Input    canvasGenerationInput
		Expected map[string]any
	}
	data, err := os.ReadFile(filepath.Join(root, "contract-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	var results []map[string]any
	checkedProfiles := map[string]bool{}
	for _, tc := range cases {
		adapter := adapters[tc.Input.Config.InterfaceType]
		if adapter == nil {
			t.Fatalf("missing adapter %s", tc.Input.Config.InterfaceType)
		}
		if cap := tc.Input.Config.CapabilityConfig; cap != nil {
			if !checkedProfiles[tc.Input.Config.Model] {
				if _, err := NormalizeModelCapabilityConfigForModel(tc.Input.Mode, tc.Input.Config.InterfaceType, tc.Input.Config.Model, cap); err != nil {
					t.Errorf("%s: capability profile: %v", tc.Input.Config.Model, err)
				}
				checkedProfiles[tc.Input.Config.Model] = true
			}
			tc.Input.ImageCapability = cap.Image
			tc.Input.VideoCapability = cap.Video
		}
		spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: protocolRequestFromInput(tc.Input)})
		if err != nil {
			t.Errorf("%s: %v", tc.Name, err)
			continue
		}
		body := marshalProtocolBody(t, spec.Body)
		for key, want := range tc.Expected {
			if !reflect.DeepEqual(body[key], want) {
				t.Errorf("%s: %s = %#v, want %#v", tc.Name, key, body[key], want)
			}
		}
		quote := marshalProtocolBody(t, atlasCostRequest(spec).Body)
		if !reflect.DeepEqual(body, quote) {
			t.Errorf("%s: quote body differs from generation", tc.Name)
		}
		if _, baseline := tc.Expected["model"]; baseline && (tc.Input.Config.Model == "openai/gpt-image-2.5-flare/edit" || tc.Input.Config.Model == "minimax/h3-fast/reference-to-video" || tc.Input.Config.Model == "vidu/q2-pro/reference-to-video") {
			invalid := tc.Input
			invalid.ReferenceImages, invalid.ReferenceVideos, invalid.ReferenceAudios = nil, nil, nil
			if _, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: protocolRequestFromInput(invalid)}); err == nil {
				t.Errorf("%s: missing required media accepted", tc.Input.Config.Model)
			}
		}
		results = append(results, map[string]any{"name": tc.Name, "model": tc.Input.Config.Model, "body": body})
	}
	data, err = json.Marshal(results)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "contract-results.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("checked %d requests through production adapters", len(results))
}
