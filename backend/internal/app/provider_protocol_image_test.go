package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

// Optional offline check of generated public Atlas manifests; no credentials or API calls.
func TestProtocolAtlasCatalogImageSizesOffline(t *testing.T) {
	root := os.Getenv("BEEFTV_ATLAS_MAPPING_TEST_ROOT")
	if root == "" {
		t.Skip("public Atlas manifests not configured")
	}
	files, err := filepath.Glob(filepath.Join(root, "packages", "*.beeftv-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	adapters := make(map[string]protocol.Adapter)
	for _, file := range files {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		pkg, err := protocol.ParsePluginPackage(body)
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
	data, err := os.ReadFile(filepath.Join(root, "integration-plan.json"))
	if err != nil {
		t.Fatal(err)
	}
	var plan struct {
		Groups map[string][]struct {
			Model, Protocol  string
			CapabilityConfig ModelCapabilityConfig
		}
	}
	if err := json.Unmarshal(data, &plan); err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, model := range plan.Groups["image"] {
		profile := model.CapabilityConfig.Image
		adapter := adapters[model.Protocol]
		if profile == nil || profile.Size.Parameter != "size" || adapter == nil {
			continue
		}
		for _, size := range profile.Size.Values {
			if size != "auto" && !strings.Contains(size, "x") {
				continue
			}
			input := canvasGenerationInput{Mode: "image", Prompt: "A quiet forest", Config: providerConfig{Model: model.Model, InterfaceType: model.Protocol, Size: size}, ImageCapability: profile}
			input.ReferenceImages = []providerMedia{{URL: "https://example.com/fixture.png"}}
			spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: protocolRequestFromInput(input)})
			if err != nil {
				t.Fatal(err)
			}
			body := marshalProtocolBody(t, spec.Body)
			if body["size"] != size && !(size == "auto" && body["size"] == nil && profile.Size.AllowCustom) {
				t.Fatalf("%s size = %#v, want %s", model.Model, body["size"], size)
			}
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no Atlas pixel sizes checked")
	}
	t.Logf("checked %d Atlas model/size combinations offline", checked)
}

func TestProtocolDeclarativeImageSizePayload(t *testing.T) {
	// Match Atlas's generated size expression, including its square fallback.
	manifest := []byte(`{
		"apiVersion":"beeftv.plugin/v2",
		"id":"test-atlas-image", "name":"Atlas image size", "version":"1.0.0",
		"contributes":{"providers":[{
		"id":"test-atlas-image", "label":"Atlas image size",
		"capabilities":["image"], "scopes":["canvas"],
		"create":{"method":"POST","path":"/api/v1/model/generateImage","body":{
			"size":{"$if":{"condition":{"$in":[{"$ref":"request.extra.size"},["auto","1024x1024","768x1024","1024x768","2160x2880","1024x1360"]]},"then":{"$ref":"request.extra.size"},"else":"1024x1024"}},
			"image_size":{"$ref":"request.extra.size"}
		}},
		"response":{"images":{"$ref":"response.data.outputs"}}
		}]}
	}`)
	adapter, err := protocol.LoadInstalledPlugin(manifest, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, size, want string
	}{
		{"portrait", "768x1024", "768x1024"},
		{"landscape", "1024x768", "1024x768"},
		{"large portrait", "2160x2880", "2160x2880"},
		{"canvas ratio", "3:4", "1024x1360"},
		{"automatic", "auto", "auto"},
		{"default", "", "768x1024"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			profile := &ImageCapabilityConfig{Size: ImageSizeConfig{Parameter: "size", Default: "768x1024"}}
			input := canvasGenerationInput{Mode: "image", Config: providerConfig{Model: "test-model", InterfaceType: "test-atlas-image", Size: tc.size}, ImageCapability: profile}
			spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: protocolRequestFromInput(input)})
			if err != nil {
				t.Fatal(err)
			}
			body := marshalProtocolBody(t, spec.Body)
			for _, field := range []string{"size", "image_size"} {
				if body[field] != tc.want {
					t.Fatalf("%s = %#v, want %s", field, body[field], tc.want)
				}
			}
			quoteBody := marshalProtocolBody(t, atlasCostRequest(spec).Body)
			if quoteBody["size"] != tc.want {
				t.Fatalf("quote size = %#v, want %s", quoteBody["size"], tc.want)
			}
		})
	}
}

func TestProtocolRequestMapsOpenAICanvasRatioToPixelSize(t *testing.T) {
	profile := DefaultImageCapabilityConfig("openai-image", "gpt-image-2")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "gpt-image-2", InterfaceType: "openai-image", Size: "16:9", Quality: "2k"},
		ImageCapability: profile,
	})
	if request.AspectRatio != "1824x1024" {
		t.Fatalf("AspectRatio = %q, want 1824x1024", request.AspectRatio)
	}
	if request.Output.AspectRatio != "1824x1024" {
		t.Fatalf("Output.AspectRatio = %q, want 1824x1024", request.Output.AspectRatio)
	}
	if request.Quality != "2k" {
		t.Fatalf("Quality = %q, want 2k for plugin-side mapping", request.Quality)
	}
}

func TestProtocolRequestImageResolutionAndCount(t *testing.T) {
	profile := &ImageCapabilityConfig{Resolution: &ImageQualityConfig{Supported: true, Values: []string{"1k", "2k"}, Default: "1k"}}
	request := protocolRequestFromInput(canvasGenerationInput{Mode: "image", Config: providerConfig{ImageResolution: "2k", Quality: "low", VQuality: "1080p", TransparentBackground: "true"}, ImageCapability: profile})
	if request.Resolution != "2k" || request.Quality != "low" || request.ImageCount != 1 || request.Output.Count != 1 || request.Extra["transparentBackground"] != "true" {
		t.Fatalf("image options lost: %+v", request)
	}
}

func TestProtocolRequestKeepsSeedreamCanvasRatioWhenCapabilityUsesSize(t *testing.T) {
	profile := DefaultImageCapabilityConfig("volcengine-ark-image", "doubao-seedream-5-0-260128")
	if profile.Size.Parameter != "size" {
		t.Fatalf("ark image parameter = %q, want size", profile.Size.Parameter)
	}
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "doubao-seedream-5-0-260128", InterfaceType: "volcengine-ark-image", Size: "16:9"},
		ImageCapability: profile,
	})
	if request.AspectRatio != "16:9" {
		t.Fatalf("AspectRatio = %q, want canvas 16:9 so Seedream can map 2560x1440", request.AspectRatio)
	}
}

func TestProtocolSeedreamPluginMapsCanvasRatioNotHostPixels(t *testing.T) {
	adapter := officialSourceProviderAdapter(t, "volcengine-ark-seedream", "volcengine-ark-image")
	profile := DefaultImageCapabilityConfig("volcengine-ark-image", "doubao-seedream-5-0-260128")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "doubao-seedream-5-0-260128", InterfaceType: "volcengine-ark-image", Size: "16:9"},
		ImageCapability: profile,
	})
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := marshalProtocolBody(t, spec.Body)
	if body["size"] != "2560x1440" {
		t.Fatalf("seedream size = %#v, want 2560x1440", body["size"])
	}
}

func TestProtocolQwenImagePluginMapsCanvasRatio(t *testing.T) {
	adapter := officialSourceProviderAdapter(t, "dashscope-qwen-image", "dashscope-qwen-image")
	profile := DefaultImageCapabilityConfig("dashscope-qwen-image", "qwen-image-3.0-pro")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "qwen-image-3.0-pro", InterfaceType: "dashscope-qwen-image", Size: "16:9"},
		ImageCapability: profile,
	})
	if request.AspectRatio != "16:9" {
		t.Fatalf("AspectRatio = %q, want 16:9", request.AspectRatio)
	}
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := marshalProtocolBody(t, spec.Body)
	parameters, _ := body["parameters"].(map[string]any)
	if parameters["size"] != "1536*864" {
		t.Fatalf("qwen size = %#v, want 1536*864", parameters["size"])
	}
}

func TestProtocolGeminiImageKeepsAspectRatio(t *testing.T) {
	adapter := officialSourceProviderAdapter(t, "google-gemini-image", "gemini-image")
	profile := DefaultImageCapabilityConfig("gemini-image", "gemini-3-pro-image-preview")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "gemini-3-pro-image-preview", InterfaceType: "gemini-image", Size: "16:9", Quality: "2k"},
		ImageCapability: profile,
	})
	if request.AspectRatio != "16:9" {
		t.Fatalf("AspectRatio = %q, want 16:9", request.AspectRatio)
	}
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := marshalProtocolBody(t, spec.Body)
	generationConfig, _ := body["generationConfig"].(map[string]any)
	imageConfig, _ := generationConfig["imageConfig"].(map[string]any)
	if imageConfig["aspectRatio"] != "16:9" {
		t.Fatalf("gemini aspectRatio = %#v, want 16:9", imageConfig["aspectRatio"])
	}
}

func TestProtocolRequestKeepsGrokImageAspectRatio(t *testing.T) {
	profile := DefaultImageCapabilityConfig("grok-image", "grok-imagine-image")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "grok-imagine-image", InterfaceType: "grok-image", Size: "16:9", Quality: "2k"},
		ImageCapability: profile,
	})
	if request.AspectRatio != "16:9" {
		t.Fatalf("AspectRatio = %q, want 16:9", request.AspectRatio)
	}
}

func TestProtocolRequestLeavesVideoAspectRatioUnconverted(t *testing.T) {
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:   "video",
		Prompt: "a clip",
		Config: providerConfig{Model: "grok-imagine-video-1.5", InterfaceType: "xai-video", Size: "16:9", VideoSeconds: "6"},
	})
	if request.AspectRatio != "16:9" {
		t.Fatalf("video AspectRatio = %q, want 16:9", request.AspectRatio)
	}
}

func TestProtocolOpenAIImagesPluginPayloadUsesPixelSize(t *testing.T) {
	adapter := officialSourceProviderAdapter(t, "openai-images", "openai-image")
	profile := DefaultImageCapabilityConfig("openai-image", "gpt-image-2")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "gpt-image-2", InterfaceType: "openai-image", Size: "16:9", Quality: "2k"},
		ImageCapability: profile,
	})
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := marshalProtocolBody(t, spec.Body)
	if body["size"] != "1824x1024" {
		t.Fatalf("openai-images size = %#v, want 1824x1024", body["size"])
	}
	if body["quality"] != "medium" {
		t.Fatalf("openai-images quality = %#v, want medium", body["quality"])
	}
	if spec.Path != "/v1/images/generations" {
		t.Fatalf("path = %q", spec.Path)
	}
}

func TestProtocolGrokImagesPluginPayloadKeepsAspectRatio(t *testing.T) {
	adapter := officialSourceProviderAdapter(t, "xai-grok-images", "grok-image")
	profile := DefaultImageCapabilityConfig("grok-image", "grok-imagine-image")
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:            "image",
		Prompt:          "a landscape",
		Config:          providerConfig{Model: "grok-imagine-image", InterfaceType: "grok-image", Size: "16:9", Quality: "2k"},
		ImageCapability: profile,
	})
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	body := marshalProtocolBody(t, spec.Body)
	if body["aspect_ratio"] != "16:9" {
		t.Fatalf("grok-image aspect_ratio = %#v, want 16:9", body["aspect_ratio"])
	}
	if _, exists := body["size"]; exists {
		t.Fatalf("grok-image must omit size: %#v", body)
	}
	if body["resolution"] != "2k" {
		t.Fatalf("grok-image resolution = %#v, want 2k", body["resolution"])
	}
}

func officialSourceProviderAdapter(t *testing.T, pluginID, providerID string) protocol.Adapter {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", pluginID, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := protocol.LoadInstalledProviders(data, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, adapter := range adapters {
		if adapter.Metadata().ID == providerID {
			return adapter
		}
	}
	t.Fatalf("provider %s is missing from %s", providerID, pluginID)
	return nil
}

func marshalProtocolBody(t *testing.T, value any) map[string]any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatal(err)
	}
	return body
}
