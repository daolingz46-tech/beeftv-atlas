package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

// Explicit opt-in: only free calculate/catalog calls, never generation endpoints.
func TestAtlasCostLive(t *testing.T) {
	key := os.Getenv("BEEFTV_ATLAS_COST_TEST_KEY")
	root := os.Getenv("BEEFTV_ATLAS_COST_TEST_ROOT")
	if key == "" || root == "" {
		t.Skip("live free quote test not configured")
	}
	runtime := pluginRuntimeFromRecords(nil)
	registry := runtime.registrySnapshot()
	packages, _ := filepath.Glob(filepath.Join(root, "packages", "*.beeftv-plugin"))
	for _, file := range packages {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		pkg, err := protocol.ParsePluginPackage(body)
		if err != nil {
			t.Fatal(err)
		}
		adapters, err := protocol.LoadInstalledProviders(pkg.ManifestRaw, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, adapter := range adapters {
			if err := registry.Register(adapter); err != nil {
				t.Fatal(err)
			}
		}
	}
	body, err := os.ReadFile(filepath.Join(root, "integration-plan.json"))
	if err != nil {
		t.Fatal(err)
	}
	var plan struct {
		Groups map[string]json.RawMessage `json:"groups"`
	}
	var profiles []struct {
		Model      string                 `json:"model"`
		Protocol   string                 `json:"protocol"`
		Capability *ModelCapabilityConfig `json:"capabilityConfig"`
	}
	if err := json.Unmarshal(body, &plan); err != nil {
		t.Fatal(err)
	}
	// Match JavaScript's JSON serialization of numeric schema enums (5.0 -> 5).
	var values any
	var allProfiles []json.RawMessage
	for _, mode := range []string{"video", "image", "audio", "text"} {
		var group []json.RawMessage
		if err := json.Unmarshal(plan.Groups[mode], &group); err != nil {
			t.Fatal(err)
		}
		allProfiles = append(allProfiles, group...)
	}
	combinedJSON, _ := json.Marshal(allProfiles)
	if err := json.Unmarshal(combinedJSON, &values); err != nil {
		t.Fatal(err)
	}
	videoJSON, _ := json.Marshal(values)
	if err := json.Unmarshal(videoJSON, &profiles); err != nil {
		t.Fatal(err)
	}
	service := &Service{mode: serviceModeLocal, pluginRuntime: runtime}
	if os.Getenv("BEEFTV_ATLAS_COST_CATALOG_AUDIT") == "1" {
		atlasAuditCostCatalog(t, service, key, plan.Groups)
		return
	}
	tested := 0
	wanted := map[string]string{
		"kwaivgi/kling-video-o3-pro/reference-to-video":  "video",
		"kwaivgi/kling-v3.0-pro/motion-control":          "video",
		"bytedance/seedance-2.0/text-to-video":           "video",
		"bytedance/seedance-2.0-mini/reference-to-video": "video",
		"alibaba/wan-2.7/text-to-video":                  "video",
		"openai/gpt-image-2.5-sunburst/text-to-image":    "image",
		"openai/gpt-image-2/edit":                        "image",
		"bytedance/seed-audio-1.0":                       "audio",
		"deepseek-ai/deepseek-v4.1-flash":                "text",
	}
	if filter := os.Getenv("BEEFTV_ATLAS_COST_TEST_MODELS"); filter != "" {
		wanted = make(map[string]string)
		for _, model := range strings.Split(filter, ",") {
			for mode, group := range plan.Groups {
				var items []struct {
					Model string `json:"model"`
				}
				_ = json.Unmarshal(group, &items)
				for _, item := range items {
					if item.Model == model {
						wanted[model] = mode
					}
				}
			}
		}
		if len(wanted) == 0 {
			t.Fatal("no configured models match filter")
		}
	}
	for _, profile := range profiles {
		mode := wanted[profile.Model]
		if mode == "" {
			continue
		}
		input := canvasGenerationInput{Mode: mode, Prompt: "A quiet forest at sunrise", Config: providerConfig{BaseURL: "https://api.atlascloud.ai", APIKey: key, Model: profile.Model, InterfaceType: profile.Protocol, Size: "1024x1024", Quality: "medium", Count: "1", VideoSeconds: "5", AudioVoice: "default", AudioFormat: "mp3", AudioSpeed: "1", CapabilityConfig: profile.Capability}}
		if mode == "video" {
			input.Config.Size = "16:9"
			input.Config.VQuality = profile.Capability.Video.DefaultResolution
			input.Config.VideoSeconds = fmt.Sprint(profile.Capability.Video.Duration.Default)
			input.Metadata = map[string]interface{}{"videoEditOperation": "text_to_video"}
		}
		if profile.Model == "openai/gpt-image-2/edit" {
			input.ReferenceImages = []providerMedia{atlasQuoteTestImage(t)}
		}
		raw, _ := json.Marshal(input)
		if profile.Model == "kwaivgi/kling-video-o3-pro/reference-to-video" || profile.Model == "kwaivgi/kling-v3.0-pro/motion-control" {
			input.Metadata = map[string]interface{}{"videoEditOperation": "reference_to_video"}
			input.ReferenceVideos = []providerMedia{{URL: "https://example.invalid/not-transferred.mp4", DurationMs: 3000, Width: 1280, Height: 720, Bytes: 50 << 20}}
			input.ReferenceImages = []providerMedia{atlasQuoteTestImage(t)}
			raw, _ = json.Marshal(input)
		}
		if profile.Model == "kwaivgi/kling-v3.0-pro/motion-control" {
			input.ReferenceVideos[0].DurationMs = 15046
			input.ReferenceVideos[0].Width, input.ReferenceVideos[0].Height = 1920, 1080
			raw, _ = json.Marshal(input)
		}
		if profile.Model == "alibaba/wan-2.7/video-edit" {
			input.Metadata = map[string]interface{}{"videoEditOperation": "reference_to_video"}
			input.ReferenceVideos = []providerMedia{{URL: "https://example.invalid/not-transferred.mp4", DurationMs: 3000, Width: 1280, Height: 720}}
			raw, _ = json.Marshal(input)
		}
		if strings.HasSuffix(profile.Model, "/audio-to-video") {
			input.Metadata = map[string]interface{}{"videoEditOperation": "audio_to_video"}
			input.ReferenceAudios = []providerMedia{{URL: "https://example.invalid/not-transferred.wav", DurationMs: 5000}}
			raw, _ = json.Marshal(input)
		}
		if profile.Model == "bytedance/seedance-2.0-mini/reference-to-video" {
			input.Config.VideoSeconds = "15"
			input.Config.VQuality = "720p-SR"
			input.Config.Size = "adaptive"
			input.Metadata = map[string]interface{}{"videoEditOperation": "reference_to_video"}
			input.ReferenceVideos = []providerMedia{{URL: "https://example.invalid/never-upload-50MB.mp4", DurationMs: 3000, Width: 1280, Height: 720, Bytes: 50 << 20}}
			input.ReferenceImages = []providerMedia{atlasQuoteTestImage(t)}
			raw, _ = json.Marshal(input)
		}
		started := time.Now()
		quote, err := service.EstimateGenerationCost(context.Background(), "local", raw)
		if err != nil {
			t.Fatalf("free quote for %s: %v", profile.Model, err)
		}
		if quote.Price <= 0 || quote.Currency != "USD" {
			t.Fatalf("invalid quote for %s", profile.Model)
		}
		t.Logf("free quote %s: %.6f USD", profile.Model, quote.Price)
		if profile.Model == "kwaivgi/kling-video-o3-pro/reference-to-video" {
			t.Logf("Kling metadata-only quote: %.2fs", time.Since(started).Seconds())
		}
		if profile.Model == "bytedance/seedance-2.0-mini/reference-to-video" {
			t.Logf("metadata-only video quote: %.2fs, %s", time.Since(started).Seconds(), quote.Note)
			if !strings.Contains(quote.Note, "3.00") {
				t.Fatal("reference duration was omitted")
			}
		}
		if profile.Model == "openai/gpt-image-2/edit" {
			compactTime := time.Since(started)
			ctx := withProtocolRegistry(context.Background(), registry)
			adapter, _ := declarativeProtocolAdapterForContext(ctx, profile.Protocol)
			spec, err := adapter.BuildCreate(ctx, protocol.RequestContext{BaseURL: input.Config.BaseURL, Request: protocolRequestFromInput(input)})
			if err != nil {
				t.Fatal(err)
			}
			started = time.Now()
			originalBody, err := executeProtocolRequest(ctx, input.Config, atlasCostRequest(spec))
			if err != nil {
				t.Fatal(err)
			}
			original, err := parseAtlasCost(originalBody)
			if err != nil || original.Price != quote.Price {
				t.Fatalf("compressed image changed quote: original=%+v compact=%+v error=%v", original, quote, err)
			}
			t.Logf("same dimensions and price: compact %.2fs, original %.2fs", compactTime.Seconds(), time.Since(started).Seconds())
		}
		tested++
	}
	if tested != len(wanted) {
		t.Fatalf("expected %d selected models, checked %d", len(wanted), tested)
	}
}

func atlasAuditCostCatalog(t *testing.T, service *Service, key string, groups map[string]json.RawMessage) {
	t.Helper()
	type result struct {
		Model, Mode, Error string
		Price              float64
	}
	var results []result
	auditCtx, stop := context.WithCancel(context.Background())
	defer stop()
	var mu sync.Mutex
	semaphore := make(chan struct{}, 1)
	var work sync.WaitGroup
	image := atlasQuoteTestImage(t)
	for _, mode := range []string{"video", "image", "audio", "text"} {
		var profiles []struct {
			Model      string                 `json:"model"`
			Protocol   string                 `json:"protocol"`
			Capability *ModelCapabilityConfig `json:"capabilityConfig"`
		}
		if err := json.Unmarshal(groups[mode], &profiles); err != nil {
			t.Fatal(err)
		}
		for _, profile := range profiles {
			work.Add(1)
			go func(mode string, model, protocolName string, capability *ModelCapabilityConfig) {
				defer work.Done()
				semaphore <- struct{}{}
				defer func() { <-semaphore }()
				input := canvasGenerationInput{Mode: mode, Prompt: "A quiet forest at sunrise", Config: providerConfig{BaseURL: "https://api.atlascloud.ai", APIKey: key, Model: model, InterfaceType: protocolName, Size: "1024x1024", Quality: "medium", Count: "1", VideoSeconds: "5", AudioVoice: "default", AudioFormat: "mp3", AudioSpeed: "1", CapabilityConfig: capability}}
				if mode == "video" && capability != nil && capability.Video != nil {
					v := capability.Video
					input.Config.Size, input.Config.VQuality = v.DefaultRatio, v.DefaultResolution
					input.Config.VideoSeconds = fmt.Sprint(v.Duration.Default)
					input.Metadata = map[string]interface{}{"videoEditOperation": v.DefaultOperation}
					for i := 0; i < v.References.MinImages; i++ {
						input.ReferenceImages = append(input.ReferenceImages, image)
					}
					if v.References.MaxVideos > 0 {
						input.ReferenceVideos = []providerMedia{{URL: "https://example.invalid/not-transferred.mp4", DurationMs: 15046, Width: 1280, Height: 720, Bytes: 50 << 20}}
					}
					if v.References.MaxAudios > 0 {
						input.ReferenceAudios = []providerMedia{{URL: "https://example.invalid/not-transferred.wav", DurationMs: 5000}}
					}
				}
				if mode == "image" && capability != nil && capability.Image != nil {
					input.Config.Size, input.Config.Quality = capability.Image.Size.Default, capability.Image.Quality.Default
					if capability.Image.References.MaxImages > 0 && (strings.Contains(model, "edit") || strings.Contains(model, "image-to") || strings.Contains(model, "upscale") || strings.Contains(model, "remove")) {
						input.ReferenceImages = []providerMedia{image}
					}
				}
				raw, _ := json.Marshal(input)
				quote, err := service.EstimateGenerationCost(auditCtx, "local", raw)
				r := result{Model: model, Mode: mode}
				if err != nil {
					var public *AppError
					if errors.As(err, &public) && public.Status == 429 {
						stop()
					}
					r.Error = err.Error()
					if public, ok := err.(*AppError); ok && public.Cause != nil {
						r.Error += ": " + public.Cause.Error()
					}
				} else {
					r.Price = quote.Price
				}
				mu.Lock()
				results = append(results, r)
				if len(results)%50 == 0 {
					t.Logf("checked %d model quotes", len(results))
				}
				mu.Unlock()
			}(mode, profile.Model, profile.Protocol, profile.Capability)
		}
	}
	work.Wait()
	body, _ := json.MarshalIndent(results, "", "  ")
	if path := os.Getenv("BEEFTV_ATLAS_COST_AUDIT_REPORT"); path != "" {
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	failed := 0
	for _, r := range results {
		if r.Error != "" {
			failed++
		}
	}
	t.Logf("free quote audit: %d models, %d successful, %d requiring investigation; no paid tasks", len(results), len(results)-failed, failed)
	if failed > 0 {
		t.Errorf("catalog audit did not validate all models; inspect the report")
	}
}
