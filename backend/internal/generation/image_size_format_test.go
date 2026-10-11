package generation

import (
	"infinite-canvas/backend/internal/modelcatalog"
	"testing"
)

func TestImageSizeKeepsCapabilityFormatForGenerationAndQuotes(t *testing.T) {
	for _, tc := range []struct{ name, parameter, fallback, input, wantKey, wantValue string }{
		{"Atlas selected dimensions", "size", "1024*1024", "768*1024", "size", "768*1024"},
		{"Atlas inherited dimensions", "size", "1024*1024", "768x1024", "size", "768*1024"},
		{"Atlas default", "size", "1024*1024", "", "size", "1024*1024"},
		{"Atlas portrait preset", "size", "1024*1024", "3:4", "size", "1024*1360"},
		{"OpenAI dimensions", "size", "1024x1024", "768*1024", "size", "768x1024"},
		{"OpenAI default", "size", "1024x1024", "", "size", "1024x1024"},
		{"portrait ratio", "aspect_ratio", "1:1", "3:4", "aspect_ratio", "3:4"},
		{"automatic", "size", "1024*1024", "auto", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			profile := &ImageCapabilityConfig{Size: modelcatalog.ImageSizeConfig{Parameter: tc.parameter, Default: tc.fallback, AllowCustom: true}}
			key, value := ImageSizeParameter(profile, tc.input)
			if key != tc.wantKey || value != tc.wantValue {
				t.Fatalf("got %s=%s, want %s=%s", key, value, tc.wantKey, tc.wantValue)
			}
			if tc.wantKey == "size" {
				request := ProtocolRequestFromInput(Input{Mode: "image", Config: Config{Size: tc.input}, ImageCapability: profile})
				if request.Extra["size"] != tc.wantValue {
					t.Fatalf("request lost wire size: %v", request.Extra["size"])
				}
			}
		})
	}
}
