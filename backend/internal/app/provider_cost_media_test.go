package app

import (
	"bytes"
	"context"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

func TestAtlasNativeImageQuotesUseAccountRatesAndGenerationResolution(t *testing.T) {
	body := []byte(`{"data":[{"model":"google/gemini-3.1-flash-image","price":{"actual":{"type":"flat","input_price":"0.4","output_price":"2","output_image_price":"48"}}},{"model":"openai/gpt-image-2","price":{"actual":{"type":"flat","input_price":"4","input_image_price":"6.4","output_image_price":"24"}}}]}`)
	input := canvasGenerationInput{Prompt: "forest", Config: providerConfig{Model: "google/gemini-3.1-flash-image", Quality: "medium"}}
	quote, err := atlasNativeImageCost(body, input)
	want := (float64(len(input.Prompt)+32)*0.4 + 1680*48 + 1024*2) / 1e6
	if err != nil || math.Abs(quote.Price-want) > 1e-12 || !strings.Contains(quote.Note, "2K") || !quote.Estimated {
		t.Fatalf("account discount or actual Gemini resolution lost: %+v %v", quote, err)
	}
	input.Config.Model, input.Config.Size, input.Config.Quality = "openai/gpt-image-2", "auto", "medium"
	input.ReferenceImages = []providerMedia{{Width: 1024, Height: 1024}}
	quote, err = atlasNativeImageCost(body, input)
	want = (1000*4 + 1756*6.4 + 1756*24) / 1e6
	if err != nil || math.Abs(quote.Price-want) > 1e-12 {
		t.Fatalf("GPT token categories lost: %+v %v", quote, err)
	}
	input.ReferenceImages[0].Width = 0
	if _, err := atlasNativeImageCost(body, input); err == nil {
		t.Fatal("unknown input image dimensions were silently omitted")
	}
}

func TestAtlasBillingImagesKeepPriceDimensionsAndOriginalPixels(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var uploaded []byte
	uploads := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/model/uploadMedia" || (r.Header.Get("Authorization") != "Bearer synthetic-only" && r.Header.Get("Authorization") != "Bearer another-account") {
			t.Errorf("unexpected upload request: %s", r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		defer file.Close()
		uploaded, err = io.ReadAll(file)
		if err != nil {
			t.Error(err)
		}
		uploads++
		_, _ = w.Write([]byte(`{"code":200,"data":{"download_url":"https://example.com/billing.png"}}`))
	}))
	defer server.Close()
	original := atlasQuoteTestImage(t)
	original.Width, original.Height = 512, 512
	input := canvasGenerationInput{Config: providerConfig{BaseURL: server.URL, APIKey: "synthetic-only"}, ReferenceImages: []providerMedia{original}}
	prepared, err := (&Service{}).prepareAtlasBillingMedia(context.Background(), "local", input)
	if err != nil {
		t.Fatal(err)
	}
	if input.ReferenceImages[0].DataURL != original.DataURL || prepared.ReferenceImages[0].DataURL != "" || prepared.ReferenceImages[0].URL != "https://example.com/billing.png" {
		t.Fatal("quote retained large source image or mutated original")
	}
	w, h, err := imageHeaderDimensions(bytes.NewReader(uploaded))
	if err != nil || w != 512 || h != 512 {
		t.Fatal("billing dimensions changed")
	}
	if len(uploaded) >= len(original.DataURL)/10 {
		t.Fatal("source pixels uploaded instead of blank surrogate")
	}
	if _, err := (&Service{}).prepareAtlasBillingMedia(context.Background(), "local", input); err != nil || uploads != 1 {
		t.Fatalf("repeat quote did not reuse uploaded metadata: uploads=%d err=%v", uploads, err)
	}
	input.Config.APIKey = "another-account"
	// A different account must never receive the cached URL belonging to the first.
	if _, err := (&Service{}).prepareAtlasBillingMedia(context.Background(), "local", input); err != nil || uploads != 2 {
		t.Fatalf("cross-account upload was skipped: uploads=%d err=%v", uploads, err)
	}
}

func TestAtlasBillingVideoKeepsExactFractionalDurationAndDimensions(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	for _, size := range [][2]int{{1920, 1080}, {1281, 721}} {
		clip, err := atlasBillingClip(context.Background(), providerMedia{Width: size[0], Height: size[1], DurationMs: 15046}, "video")
		if err != nil {
			t.Fatal(err)
		}
		w, h, d := probeGeneratedVideoMedia(clip)
		if w != size[0] || h != size[1] || d != 15046 || len(clip) > 100000 {
			t.Fatalf("wrong probe metadata: %dx%d, %dms, %d bytes", w, h, d, len(clip))
		}
	}
	_, err := atlasBillingMediaURL(context.Background(), providerConfig{}, providerMedia{Width: 1920, Height: 1080}, "video")
	if err == nil || !strings.Contains(err.Error(), "时长") {
		t.Fatal("missing duration was silently estimated")
	}
}

func TestAtlasVideoCapabilityCorrectsImportedDurationAndAudioOperation(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("agnes-video", "agnes-video-2.5")
	profile.Video.Duration.Min = 0
	profile.Video.Duration.Default = 5
	profile.Video.References.MinImages = 0
	profile.Video.References.MaxAudios = 1
	profile.Video.Operations = []string{"reference_to_video"}
	profile.Video.DefaultOperation = "reference_to_video"
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "atlas-model-fixture", "ltx/audio-to-video", profile)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Video.Duration.Min != 1 || !videoCapabilityAllowsAudioOnly(normalized.Video) || profile.Video.Duration.Min != 0 || len(profile.Video.Operations) != 1 {
		t.Fatal("imported Atlas capabilities stayed invalid or original was changed")
	}
}
