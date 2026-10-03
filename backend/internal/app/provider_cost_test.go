package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"math"
	"math/rand"
	"net"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestSeedanceQuoteTransfersOnlyParametersAndIncludesReferenceDuration(t *testing.T) {
	refs := canvasGenerationInput{ReferenceVideos: []providerMedia{{URL: "private-original", DataURL: "private-bytes", DurationMs: 3000}}}
	metadata := atlasVideoMetadataInput(refs)
	if refs.ReferenceVideos[0].URL != "private-original" || metadata.ReferenceVideos[0].DataURL != "" || metadata.ReferenceVideos[0].DurationMs != 3000 {
		t.Fatal("generic video quote changed original media or lost metadata")
	}
	input := canvasGenerationInput{Mode: "video", Config: providerConfig{VideoSeconds: "15"}, ReferenceVideos: []providerMedia{{DurationMs: 3000}, {DurationMs: 4500}}, ReferenceImages: []providerMedia{{}}}
	original := map[string]any{"model": "bytedance/seedance-2.0-mini/reference-to-video", "duration": 15, "resolution": "720p-SR", "reference_videos": []string{strings.Repeat("private-video-bytes", 50000)}, "reference_images": []string{"private-image"}}
	spec, seconds, err := atlasSeedanceMetadataQuote(protocol.RequestSpec{Body: original}, input)
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := json.Marshal(spec.Body)
	if spec.Path != "/api/v1/pricing/calculate" || len(wire) > 1000 || strings.Contains(string(wire), "private") || seconds.Reference != 7.5 {
		t.Fatal("large media entered lightweight quote")
	}
	if original["reference_images"].([]string)[0] != "private-image" {
		t.Fatal("actual generation body was modified")
	}
	quote, err := completeAtlasSeedanceQuote([]byte(`{"code":200,"data":{"price":"0.182744","estimate_partial":true}}`), seconds)
	if err != nil || math.Abs(quote.Price-0.274116) > 1e-9 || !strings.Contains(quote.Note, "7.50") {
		t.Fatalf("reference duration was not included: %+v %v", quote, err)
	}
	quote, err = completeAtlasSeedanceQuote([]byte(`{"code":200,"data":{"price":"0.4"}}`), seconds)
	if err != nil || quote.Price != 0.4 {
		t.Fatal("complete provider price was multiplied twice")
	}
	input.ReferenceVideos[0].DurationMs = 0
	if _, _, err := atlasSeedanceMetadataQuote(protocol.RequestSpec{Body: original}, input); err == nil {
		t.Fatal("unknown duration produced an incomplete estimate")
	}
}

func TestAtlasQuoteRetriesConnectionFailuresAndShowsSafeReason(t *testing.T) {
	networkFailure := &url.Error{Op: "Post", URL: "https://secret.example.invalid", Err: &net.DNSError{Err: "temporary", Name: "secret.example.invalid", IsTemporary: true}}
	attempts := 0
	body, err := atlasQuoteWithRetry(context.Background(), func() ([]byte, error) {
		attempts++
		if attempts == 1 {
			return nil, networkFailure
		}
		return []byte("quote"), nil
	})
	if err != nil || string(body) != "quote" || attempts != 2 {
		t.Fatal("failed to recover transient quote connection")
	}
	attempts = 0
	_, err = atlasQuoteWithRetry(context.Background(), func() ([]byte, error) { attempts++; return nil, networkFailure })
	var public *AppError
	if attempts != 2 || !errors.As(err, &public) || public.Status != 502 || strings.Contains(public.Message, "secret") {
		t.Fatal("failed to safely report quote network error")
	}
	_, err = atlasQuoteWithRetry(context.Background(), func() ([]byte, error) { return nil, context.DeadlineExceeded })
	if !errors.As(err, &public) || public.Status != 504 {
		t.Fatal("timeout lost its public reason")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	attempts = 0
	_, err = atlasQuoteWithRetry(ctx, func() ([]byte, error) { attempts++; return nil, networkFailure })
	if attempts != 0 || !errors.Is(err, context.Canceled) {
		t.Fatal("canceled quote was retried")
	}
	_, err = executeAtlasQuote(context.Background(), providerConfig{}, protocol.RequestSpec{Method: "POST", Path: "/api/v1/model/generateVideo", OriginPath: true})
	if err == nil {
		t.Fatal("generation endpoint entered quote retry path")
	}
}

func atlasQuoteTestImage(t *testing.T) providerMedia {
	t.Helper()
	pixels := image.NewNRGBA(image.Rect(0, 0, 512, 512))
	rand.New(rand.NewSource(17)).Read(pixels.Pix)
	for i := 3; i < len(pixels.Pix); i += 4 {
		pixels.Pix[i] = 255
	}
	var body bytes.Buffer
	if err := png.Encode(&body, pixels); err != nil {
		t.Fatal(err)
	}
	return providerMedia{DataURL: dataURL("image/png", body.Bytes()), MimeType: "image/png", Width: 512, Height: 512}
}

func TestAtlasQuoteImageCompactionKeepsDimensionsAndReducesTransfer(t *testing.T) {
	media := atlasQuoteTestImage(t)
	original := media.DataURL
	compactAtlasQuoteImage(&media)
	if len(media.DataURL) >= len(original)/2 {
		t.Fatal("quote image transfer was not substantially reduced")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.SplitN(media.DataURL, ",", 2)[1])
	if err != nil {
		t.Fatal(err)
	}
	size, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || format != "jpeg" || size.Width != 512 || size.Height != 512 {
		t.Fatal("quote image dimensions changed")
	}
	invalid := providerMedia{DataURL: "data:image/png;base64," + strings.Repeat("!", 150000)}
	before := invalid.DataURL
	compactAtlasQuoteImage(&invalid)
	if invalid.DataURL != before {
		t.Fatal("invalid media should be kept for normal validation")
	}
}

func TestAtlasCostKeepsGenerationBodyButNeverUsesGenerationEndpoint(t *testing.T) {
	body := map[string]any{"model": "example/video", "duration": 5, "resolution": "720p", "video": "https://example.com/reference.mp4"}
	create := protocol.RequestSpec{Method: "POST", Path: "/api/v1/model/generateVideo", Body: body, Auth: protocol.ManifestAuth{Type: "bearer", Field: "apiKey"}}
	quote := atlasCostRequest(create)
	if quote.Path != "/api/v1/model/calculate" || !quote.OriginPath || quote.Method != "POST" {
		t.Fatal("quote would call the wrong endpoint")
	}
	if !reflect.DeepEqual(quote.Body, create.Body) || !reflect.DeepEqual(quote.Auth, create.Auth) {
		t.Fatal("quote changed generation parameters or authentication")
	}
}

func TestAtlasTextCostStatesAssumptionsAndUsesCurrentEffectiveRates(t *testing.T) {
	body := []byte(`{"data":[{"model":"example/chat","price":{"actual":{"type":"flat","input_price":"2","output_price":"4"}}}]}`)
	input := canvasGenerationInput{Mode: "text", Prompt: "你好", Config: providerConfig{Model: "example/chat", SystemPrompt: "help"}, TextHistory: []providerTextMessage{{Role: "user", Content: "old"}}, ReferenceImages: []providerMedia{{}}}
	quote, err := atlasTextCost(body, input)
	expected := (float64(6+4+3+32+4096)*2 + 1024*4) / 1e6
	if err != nil || quote.Price != expected || !quote.Estimated || !strings.Contains(quote.Note, "1024 Token") {
		t.Fatalf("invalid token budget: %+v, %v", quote, err)
	}
	for _, invalid := range []string{`{"data":[]}`, `{"data":[{"model":"example/chat","price":{"actual":{"type":"flat","input_price":"-1","output_price":"2"}}}]}`, `{"data":[{"model":"example/chat","price":{"actual":{"type":"tiered","input_price":"1","output_price":"2"}}}]}`} {
		if _, err := atlasTextCost([]byte(invalid), input); err == nil {
			t.Fatal("accepted unavailable rates")
		}
	}
}

func TestAtlasCostUsesDiscountedPriceAndRejectsMissingOrInvalidPrices(t *testing.T) {
	for _, body := range []string{`{"code":200,"data":{"price":"0.453716","origin_price":"0.567146","estimated":true}}`, `{"code":"200","data":{"price":0.453716,"estimated":true}}`} {
		quote, err := parseAtlasCost([]byte(body))
		if err != nil || quote.Price != 0.453716 || quote.Currency != "USD" || !quote.Estimated {
			t.Fatalf("invalid discounted quote: %+v, %v", quote, err)
		}
	}
	for _, body := range []string{`{"code":200,"data":{}}`, `{"code":200,"data":{"price":-1}}`, `{"code":403,"data":{"price":1}}`, `{"code":200,"data":{"price":"NaN"}}`, `{"code":200,"data":{"price":"Infinity"}}`} {
		if _, err := parseAtlasCost(json.RawMessage(body)); err == nil {
			t.Fatal("accepted missing or invalid quote")
		}
	}
	quote, err := parseAtlasCost([]byte(`{"code":200,"data":{"price":"0"}}`))
	if err != nil || quote.Price != 0 {
		t.Fatal("zero price is a valid free quote")
	}
}
