package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"infinite-canvas/backend/internal/generation"
	"math"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

func (s *Service) estimateAtlasNativeImageCost(ctx context.Context, userID string, input canvasGenerationInput) (*generation.CostEstimate, error) {
	if err := s.hydrateVideoReferenceMetadata(ctx, userID, &input); err != nil {
		return nil, err
	}
	// Atlas's native image interfaces have token rates but no calculate expression.
	// Read this account's current rates; never reuse a different model's quote.
	spec := protocol.RequestSpec{Method: http.MethodGet, Path: "/api/v1/models", OriginPath: true, Auth: protocol.ManifestAuth{Type: "bearer", Field: "apiKey"}}
	response, err := executeAtlasQuote(ctx, input.Config, spec)
	if err != nil {
		return nil, err
	}
	return atlasNativeImageCost(response, input)
}

func atlasNativeImageCost(body []byte, input canvasGenerationInput) (*generation.CostEstimate, error) {
	var catalog struct {
		Data []struct {
			Model string `json:"model"`
			Price struct {
				Actual struct {
					Type        string      `json:"type"`
					Input       json.Number `json:"input_price"`
					InputImage  json.Number `json:"input_image_price"`
					Output      json.Number `json:"output_price"`
					OutputImage json.Number `json:"output_image_price"`
				} `json:"actual"`
			} `json:"price"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &catalog) != nil {
		return nil, BadAuthRequest("无法读取原生图片模型当前单价")
	}
	for _, model := range catalog.Data {
		if model.Model != input.Config.Model {
			continue
		}
		inRate, inErr := model.Price.Actual.Input.Float64()
		outRate, outErr := model.Price.Actual.OutputImage.Float64()
		if model.Price.Actual.Type != "flat" || inErr != nil || outErr != nil || inRate < 0 || outRate <= 0 || math.IsNaN(inRate+outRate) || math.IsInf(inRate+outRate, 0) {
			break
		}
		inputTokens := float64(len(input.Prompt) + len(input.Config.SystemPrompt) + 32)
		imageRate := inRate
		if model.Price.Actual.InputImage != "" {
			var err error
			imageRate, err = model.Price.Actual.InputImage.Float64()
			if err != nil || imageRate < 0 || math.IsNaN(imageRate) || math.IsInf(imageRate, 0) {
				break
			}
		}
		var outputTokens, imageTokens, reasoningBudget float64
		var basis string
		switch input.Config.Model {
		case "openai/gpt-image-2":
			w, h := 1024, 1024
			var width, height int
			if count, err := fmt.Sscanf(input.Config.Size, "%dx%d", &width, &height); err == nil && count == 2 {
				w, h = width, height
			}
			if w <= 0 || h <= 0 || int64(w)*int64(h) > 32*1024*1024 {
				return nil, BadAuthRequest("图片尺寸无效，无法预估")
			}
			base := 7024.0 // Auto quality is budgeted as high, not silently as low.
			switch strings.ToLower(input.Config.Quality) {
			case "low":
				base = 196
			case "medium":
				base = 1756
			}
			outputTokens = base * float64(w*h) / (1024 * 1024)
			for _, image := range input.ReferenceImages {
				if image.Width <= 0 || image.Height <= 0 {
					return nil, BadAuthRequest("参考图尺寸未识别，请重新导入后估价")
				}
				imageTokens += 1756 * float64(image.Width*image.Height) / (1024 * 1024)
			}
			inputTokens = 1000
			basis = "GPT 原生接口按尺寸与质量粗估；自动尺寸按 1024 方图、自动质量按高质量预算"
		case "google/gemini-2.5-flash-image", "google/gemini-3.1-flash-image", "google/gemini-3-pro-image":
			resolution := "1K"
			if cfg := geminiImageConfigFor(input.Config); cfg != nil && cfg.ImageSize != "" {
				resolution = cfg.ImageSize
			}
			outputTokens = 1120
			if input.Config.Model == "google/gemini-2.5-flash-image" {
				outputTokens = 1290
			}
			if input.Config.Model == "google/gemini-3.1-flash-image" {
				if resolution == "2K" {
					outputTokens = 1680
				}
				if resolution == "4K" {
					outputTokens = 2520
				}
			}
			if input.Config.Model == "google/gemini-3-pro-image" && resolution == "4K" {
				outputTokens = 2000
			}
			imageTokens = float64(len(input.ReferenceImages) * 4096)
			textRate, err := model.Price.Actual.Output.Float64()
			if err != nil || textRate < 0 || math.IsNaN(textRate) || math.IsInf(textRate, 0) {
				break
			}
			reasoningBudget = 1024 * textRate
			basis = fmt.Sprintf("Gemini 原生接口粗估：%s 图像按 %.0f Token、参考图每张按 4096 Token、额外文字与思考按 1024 Token 预算", resolution, outputTokens)
		default:
			return nil, BadAuthRequest("该原生图片模型尚无可靠的费用预估规则")
		}
		if basis == "" {
			break
		}
		return &generation.CostEstimate{Price: (inputTokens*inRate + imageTokens*imageRate + outputTokens*outRate + reasoningBudget) / 1e6, Currency: "USD", Estimated: true, Note: basis + "；使用当前账号单价，实际按 Token 用量结算"}, nil
	}
	return nil, BadAuthRequest("当前原生图片模型未提供有效 Token 单价")
}

var atlasBillingMediaCache = struct {
	sync.Mutex
	items map[[32]byte]atlasBillingMediaEntry
}{items: make(map[[32]byte]atlasBillingMediaEntry)}

type atlasBillingMediaEntry struct {
	url     string
	expires time.Time
}

// Billing probes inspect dimensions and duration. Blank media preserves those
// properties without uploading private content. It is used only by free quotes;
// never put these references in a generation task or its persistent input.
func (s *Service) prepareAtlasBillingMedia(ctx context.Context, userID string, original canvasGenerationInput) (canvasGenerationInput, error) {
	input := atlasVideoMetadataInput(original)
	for i := range input.ReferenceImages {
		media := original.ReferenceImages[i]
		if err := s.prepareAtlasBillingImage(ctx, userID, &media, original); err != nil {
			return input, err
		}
		input.ReferenceImages[i] = media
	}
	for _, group := range []struct {
		kind  string
		media *[]providerMedia
	}{{"video", &input.ReferenceVideos}, {"audio", &input.ReferenceAudios}} {
		for i := range *group.media {
			media := &(*group.media)[i]
			url, err := atlasBillingMediaURL(ctx, original.Config, *media, group.kind)
			if err != nil {
				return input, err
			}
			media.URL, media.DataURL = url, ""
		}
	}
	if original.Mask != nil {
		mask := *original.Mask
		metadata := canvasGenerationInput{Config: original.Config, ReferenceImages: []providerMedia{mask}}
		if err := s.hydrateVideoReferenceMetadata(ctx, userID, &metadata); err != nil {
			return input, err
		}
		mask = metadata.ReferenceImages[0]
		if err := s.prepareAtlasBillingImage(ctx, userID, &mask, original); err != nil {
			return input, err
		}
		input.Mask = &mask
	}
	return input, nil
}

func (s *Service) prepareAtlasBillingImage(ctx context.Context, userID string, media *providerMedia, input canvasGenerationInput) error {
	if media.Width <= 0 || media.Height <= 0 {
		if err := s.hydrateProviderMedia(userID, media, providerMediaHydrationPolicyFor(ctx, input)); err != nil {
			return err
		}
		raw := firstNonEmpty(media.DataURL, media.URL)
		if strings.HasPrefix(raw, "data:") {
			_, data, err := decodeProviderDataURL(raw)
			if err == nil {
				media.Width, media.Height, _ = imageHeaderDimensions(bytes.NewReader(data))
			}
		}
	}
	if media.Width <= 0 || media.Height <= 0 {
		// An existing public image URL can still be probed by the pricing API.
		if strings.HasPrefix(media.URL, "https://") {
			return nil
		}
		return BadAuthRequest("参考图尺寸未识别，请重新导入图片后估价")
	}
	if int64(media.Width)*int64(media.Height) > 32*1024*1024 {
		return BadAuthRequest("参考图尺寸过大，无法准备费用预估")
	}
	var body bytes.Buffer
	if err := png.Encode(&body, image.NewGray(image.Rect(0, 0, media.Width, media.Height))); err != nil {
		return err
	}
	media.URL, media.DataURL = "", dataURL("image/png", body.Bytes())
	media.Type, media.MimeType = "image/png", "image/png"
	// Atlas's pricing probe accepts public URLs, unlike generateImage which also
	// accepts data URLs. Upload only the blank dimension surrogate, never pixels.
	url, err := atlasBillingMediaURL(ctx, input.Config, *media, "image")
	if err != nil {
		return err
	}
	media.URL, media.DataURL = url, ""
	return nil
}

func atlasBillingMediaURL(ctx context.Context, config providerConfig, media providerMedia, kind string) (string, error) {
	if kind != "image" && (media.DurationMs <= 0 || media.DurationMs > 3600000) {
		return "", BadAuthRequest("参考素材时长未识别或超过一小时，请重新导入后估价")
	}
	if (kind == "video" || kind == "image") && (media.Width <= 0 || media.Height <= 0 || int64(media.Width)*int64(media.Height) > 32*1024*1024) {
		return "", BadAuthRequest("参考素材尺寸未识别，请重新导入后估价")
	}
	cacheKey := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%s\x00%d\x00%dx%d", config.BaseURL, config.APIKey, kind, media.DurationMs, media.Width, media.Height)))
	atlasBillingMediaCache.Lock()
	cached, exists := atlasBillingMediaCache.items[cacheKey]
	atlasBillingMediaCache.Unlock()
	if exists && time.Now().Before(cached.expires) {
		return cached.url, nil
	}
	var clip []byte
	var err error
	if kind == "image" {
		_, clip, err = decodeProviderDataURL(media.DataURL)
	} else {
		clip, err = atlasBillingClip(ctx, media, kind)
	}
	if err != nil {
		return "", err
	}
	mime, extension := "video/mp4", ".mp4"
	if kind == "audio" {
		mime, extension = "audio/wav", ".wav"
	} else if kind == "image" {
		mime, extension = "image/png", ".png"
	}
	spec := protocol.RequestSpec{Method: http.MethodPost, Path: "/api/v1/model/uploadMedia", OriginPath: true, ContentType: "multipart/form-data", Auth: protocol.ManifestAuth{Type: "bearer", Field: "apiKey"}, Files: []protocol.RequestFilePart{{Name: "file", Filename: "billing-metadata" + extension, MIMEType: mime, Reference: protocol.MediaReference{DataURL: dataURL(mime, clip), Kind: kind}}}}
	body, err := executeProtocolRequest(ctx, config, spec)
	if err != nil {
		return "", WrapAppError(http.StatusBadGateway, "Atlas 无法读取估价用的素材信息，请稍后重试", err)
	}
	var response struct {
		Code int `json:"code"`
		Data struct {
			URL string `json:"download_url"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &response) != nil || response.Code != 200 || response.Data.URL == "" {
		return "", BadAuthRequest("Atlas 未返回有效的估价素材地址")
	}
	if _, err := ValidateOutboundURL(response.Data.URL); err != nil {
		return "", err
	}
	atlasBillingMediaCache.Lock()
	if len(atlasBillingMediaCache.items) >= 64 {
		for key := range atlasBillingMediaCache.items {
			delete(atlasBillingMediaCache.items, key)
			break
		}
	}
	atlasBillingMediaCache.items[cacheKey] = atlasBillingMediaEntry{url: response.Data.URL, expires: time.Now().Add(10 * time.Minute)}
	atlasBillingMediaCache.Unlock()
	return response.Data.URL, nil
}

func atlasBillingClip(ctx context.Context, media providerMedia, kind string) ([]byte, error) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return nil, BadAuthRequest("估价需要 ffmpeg 读取媒体信息，请检查本机 ffmpeg 配置")
	}
	extension := ".mp4"
	if kind == "audio" {
		extension = ".wav"
	}
	file, err := os.CreateTemp("", "beeftv-billing-*"+extension)
	if err != nil {
		return nil, err
	}
	path := file.Name()
	_ = file.Close()
	defer os.Remove(path)
	args := []string{"-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"}
	if kind == "video" {
		// One frame lasts exactly the source duration; encoding cost and file size
		// are independent of duration. yuv444p also preserves odd pixel dimensions.
		args = append(args, "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=1000/%d,format=yuv444p", media.Width, media.Height, media.DurationMs), "-frames:v", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p", "-video_track_timescale", "1000", "-movflags", "+faststart")
	} else {
		args = append(args, "-i", "anullsrc=r=8000:cl=mono", "-t", strconv.FormatFloat(float64(media.DurationMs)/1000, 'f', 3, 64), "-c:a", "pcm_u8")
	}
	args = append(args, path)
	if err := exec.CommandContext(ctx, "ffmpeg", args...).Run(); err != nil {
		return nil, WrapAppError(http.StatusBadGateway, "无法准备媒体时长信息用于估价，请检查 ffmpeg 或重新导入素材", err)
	}
	return os.ReadFile(path)
}
