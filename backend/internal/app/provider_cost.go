package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/protocol"
)

func (s *Service) EstimateGenerationCost(ctx context.Context, userID string, raw json.RawMessage) (quote *generation.CostEstimate, err error) {
	var input canvasGenerationInput
	defer func() {
		var public *AppError
		if err != nil && !errors.As(err, &public) && !errors.Is(err, context.Canceled) {
			err = WrapAppError(http.StatusBadRequest, "费用预估参数无法匹配当前模型，请检查模型要求的输入和设置", err)
		}
		if quote != nil && quote.Note == "" {
			quote.Estimated = true
			if len(input.ReferenceImages)+len(input.ReferenceVideos)+len(input.ReferenceAudios) > 0 {
				quote.Note = "按当前配置和参考素材的尺寸、时长预估，实际扣费以账单为准"
			}
		}
	}()
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, BadAuthRequest("费用预估输入格式错误")
	}
	if input.Mode != "video" && input.Mode != "image" && input.Mode != "audio" && input.Mode != "text" {
		return nil, BadAuthRequest("当前生成类型不支持费用预估")
	}
	config, err := s.resolveProviderConfig(input.Config)
	if err != nil {
		return nil, err
	}
	endpoint, err := url.Parse(config.BaseURL)
	if err != nil || endpoint.Scheme != "https" || !strings.EqualFold(endpoint.Host, "api.atlascloud.ai") || endpoint.User != nil {
		return nil, BadAuthRequest("当前渠道未接入费用预估")
	}
	if strings.TrimSpace(config.APIKey) == "" || strings.TrimSpace(config.Model) == "" {
		return nil, BadAuthRequest("缺少 Atlas Cloud 密钥或模型")
	}
	input.Config = config
	ctx, cancel := context.WithTimeout(withProtocolRegistry(ctx, s.protocolRegistry()), 35*time.Second)
	defer cancel()
	if input.Mode == "text" && config.InterfaceType == "atlascloud-chat" {
		return s.estimateAtlasTextCost(ctx, config, input)
	}
	adapter, exists := declarativeProtocolAdapterForContext(ctx, config.InterfaceType)
	if !exists {
		if input.Mode == "image" && (config.InterfaceType == "openai-image" || config.InterfaceType == "gemini-image") {
			return s.estimateAtlasNativeImageCost(ctx, userID, input)
		}
		return nil, BadAuthRequest("该模型的费用预估适配器未安装")
	}
	if err := s.hydrateVideoReferenceMetadata(userID, &input); err != nil {
		return nil, err
	}
	if input.Mode == "video" {
		if err := s.validateResolvedVideoCapability(&input); err != nil {
			return nil, err
		}
		if len(input.ReferenceVideos) > 0 {
			quoteInput := atlasVideoMetadataInput(input)
			seedance := strings.HasPrefix(config.Model, "bytedance/seedance-2.")
			if !seedance {
				quoteInput, err = s.prepareAtlasBillingMedia(ctx, userID, input)
				if err != nil {
					return nil, err
				}
			}
			spec, err := adapter.BuildCreate(ctx, protocol.RequestContext{BaseURL: config.BaseURL, Request: protocolRequestFromInput(quoteInput)})
			if err != nil {
				return nil, err
			}
			var seconds atlasSeedanceQuoteSeconds
			if seedance {
				spec, seconds, err = atlasSeedanceMetadataQuote(spec, input)
				if err != nil {
					return nil, err
				}
			} else {
				spec = atlasCostRequest(spec)
				spec.Path = "/api/v1/pricing/calculate"
			}
			body, err := executeAtlasQuote(ctx, config, spec)
			if err != nil {
				return nil, err
			}
			if seedance {
				return completeAtlasSeedanceQuote(body, seconds)
			}
			var response struct {
				Data struct {
					Partial bool `json:"estimate_partial"`
				} `json:"data"`
			}
			if err := json.Unmarshal(body, &response); err != nil {
				return nil, err
			}
			if response.Data.Partial {
				return nil, BadAuthRequest("该模型的报价尚未包含参考视频费用，暂不能显示完整总价")
			}
			return parseAtlasCost(body)
		}
	}
	input, err = s.prepareAtlasBillingMedia(ctx, userID, input)
	if err != nil {
		return nil, err
	}
	if input.VideoCapability != nil {
		if err := validateVideoTask(input.VideoCapability, input); err != nil {
			return nil, err
		}
	}
	// Use the installed adapter's exact generation body, changing only the free endpoint.
	spec, err := adapter.BuildCreate(ctx, protocol.RequestContext{BaseURL: config.BaseURL, Request: protocolRequestFromInput(input)})
	if err != nil {
		return nil, err
	}
	spec = atlasCostRequest(spec)
	spec.Path = "/api/v1/pricing/calculate"
	body, err := executeAtlasQuote(ctx, config, spec)
	if err != nil {
		return nil, err
	}
	return parseAtlasCost(body)
}

func atlasVideoMetadataInput(input canvasGenerationInput) canvasGenerationInput {
	// A quote needs reference counts and billing options, not playable media.
	// Clone slices so preparing a quote never rewrites generation references.
	for _, group := range []*[]providerMedia{&input.ReferenceImages, &input.ReferenceVideos, &input.ReferenceAudios} {
		*group = append([]providerMedia(nil), (*group)...)
		for i := range *group {
			(*group)[i].URL = "https://quote.invalid/reference"
			(*group)[i].DataURL = ""
		}
	}
	return input
}

type atlasSeedanceQuoteSeconds struct {
	Output, Reference float64
	Auto              bool
}

func atlasSeedanceMetadataQuote(spec protocol.RequestSpec, input canvasGenerationInput) (protocol.RequestSpec, atlasSeedanceQuoteSeconds, error) {
	seconds := atlasSeedanceQuoteSeconds{Output: float64(protocolRequestFromInput(input).Duration)}
	if seconds.Output == -1 {
		seconds.Output = 15
		seconds.Auto = true
	}
	if seconds.Output <= 0 {
		return spec, seconds, BadAuthRequest("请先选择生成时长再估价")
	}
	for _, video := range input.ReferenceVideos {
		if video.DurationMs <= 0 {
			return spec, seconds, BadAuthRequest("参考视频时长未识别，请重新导入视频后估价")
		}
		seconds.Reference += float64(video.DurationMs) / 1000
	}
	body, ok := spec.Body.(map[string]any)
	if !ok {
		return spec, seconds, BadAuthRequest("当前模型无法构造轻量估价请求")
	}
	lightweight := make(map[string]any, len(body))
	for key, value := range body {
		lightweight[key] = value
	}
	// This endpoint checks reference presence for the billing tier. It does not
	// need video bytes. Its partial response omits reference duration; add that
	// duration locally using Seedance's output+reference token billing rule.
	lightweight["reference_videos"] = make([]string, len(input.ReferenceVideos))
	lightweight["reference_images"] = make([]string, len(input.ReferenceImages))
	lightweight["reference_audios"] = make([]string, len(input.ReferenceAudios))
	lightweight["duration"] = seconds.Output
	spec = atlasCostRequest(spec)
	spec.Path = "/api/v1/pricing/calculate"
	spec.Body = lightweight
	return spec, seconds, nil
}

func completeAtlasSeedanceQuote(body []byte, seconds atlasSeedanceQuoteSeconds) (*generation.CostEstimate, error) {
	quote, err := parseAtlasCost(body)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			Partial bool `json:"estimate_partial"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	if response.Data.Partial {
		if seconds.Output <= 0 || seconds.Reference <= 0 {
			return nil, BadAuthRequest("参考视频时长缺失，无法补全费用预估")
		}
		quote.Price *= (seconds.Output + seconds.Reference) / seconds.Output
	}
	quote.Estimated = true
	quote.Note = fmt.Sprintf("按输出 %.2f 秒 + 参考视频 %.2f 秒预估；参考时长已计入，最终按实际视频 Token 结算", seconds.Output, seconds.Reference)
	if seconds.Auto {
		quote.Note = "自动时长按 15 秒上限估算；" + quote.Note
	}
	return quote, nil
}

func executeAtlasQuote(ctx context.Context, config providerConfig, spec protocol.RequestSpec) ([]byte, error) {
	// Retrying is allowed only on these read-only pricing endpoints, never on generation.
	if !spec.OriginPath || !(((spec.Path == "/api/v1/model/calculate" || spec.Path == "/api/v1/pricing/calculate") && spec.Method == http.MethodPost) || (spec.Path == "/api/v1/models" && spec.Method == http.MethodGet)) {
		return nil, BadAuthRequest("费用预估请求端点无效")
	}
	return cachedAtlasQuote(ctx, config, spec, func() ([]byte, error) {
		return atlasQuoteWithRetry(ctx, func() ([]byte, error) { return executeProtocolRequest(ctx, config, spec) })
	})
}

func atlasQuoteWithRetry(ctx context.Context, request func() ([]byte, error)) ([]byte, error) {
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		if ctx.Err() != nil {
			err = ctx.Err()
			break
		}
		var body []byte
		body, err = request()
		if err == nil {
			return body, nil
		}
		var networkError net.Error
		if !errors.As(err, &networkError) || ctx.Err() != nil {
			break
		}
	}
	if errors.Is(err, context.Canceled) {
		return nil, err
	}
	var networkError net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout()) {
		return nil, WrapAppError(http.StatusGatewayTimeout, "Atlas 费用预估响应超时，请点击重试估价", err)
	}
	if errors.As(err, &networkError) {
		return nil, WrapAppError(http.StatusBadGateway, "连接 Atlas 报价服务失败，已自动重试；请检查网络或稍后重试", err)
	}
	var public *AppError
	var upstream providerHTTPError
	if errors.As(err, &upstream) && upstream.StatusCode == http.StatusTooManyRequests {
		minutes := int(math.Ceil(upstream.RetryAfter.Minutes()))
		if minutes < 1 {
			minutes = 1
		}
		return nil, WrapAppError(http.StatusTooManyRequests, fmt.Sprintf("Atlas 暂时限制访问，请约 %d 分钟后重试估价；相同配置会使用缓存", minutes), err)
	}
	if errors.As(err, &public) {
		return nil, err
	}
	return nil, WrapAppError(http.StatusBadGateway, "Atlas 未能计算当前模型的费用，请检查该模型的必填参数和参考素材", err)
}

// GPT Image input tokens depend on image dimensions, not encoded file size.
// Only the free quote uses a smaller encoding; generation keeps original media.
func compactAtlasQuoteImage(media *providerMedia) {
	if len(media.DataURL) < 128*1024 {
		return
	}
	parts := strings.SplitN(media.DataURL, ",", 2)
	if len(parts) != 2 || (parts[0] != "data:image/png;base64" && parts[0] != "data:image/jpeg;base64") {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return
	}
	reader := bytes.NewReader(raw)
	size, _, err := image.DecodeConfig(reader)
	if err != nil || size.Width <= 0 || size.Height <= 0 || int64(size.Width)*int64(size.Height) > 32*1024*1024 {
		return
	}
	reader.Seek(0, 0)
	decoded, _, err := image.Decode(reader)
	if err != nil {
		return
	}
	var encoded bytes.Buffer
	if jpeg.Encode(&encoded, decoded, &jpeg.Options{Quality: 35}) != nil || encoded.Len() >= len(raw) {
		return
	}
	media.DataURL = dataURL("image/jpeg", encoded.Bytes())
	media.MimeType = "image/jpeg"
	media.Type = "image/jpeg"
	media.Bytes = int64(encoded.Len())
	media.Width, media.Height = size.Width, size.Height
}

func (s *Service) estimateAtlasTextCost(ctx context.Context, config providerConfig, input canvasGenerationInput) (*generation.CostEstimate, error) {
	// Chat output length is unknown before generation. Fetch current rates and
	// state the budgeting assumptions rather than presenting an exact charge.
	body, err := executeAtlasQuote(ctx, config, protocol.RequestSpec{Method: http.MethodGet, Path: "/api/v1/models", OriginPath: true, Auth: protocol.ManifestAuth{Type: "bearer", Field: "apiKey"}})
	if err != nil {
		return nil, err
	}
	return atlasTextCost(body, input)
}

func atlasTextCost(body []byte, input canvasGenerationInput) (*generation.CostEstimate, error) {
	var catalog struct {
		Data []struct {
			Model string `json:"model"`
			Price struct {
				Actual struct {
					Type   string      `json:"type"`
					Input  json.Number `json:"input_price"`
					Output json.Number `json:"output_price"`
				} `json:"actual"`
			} `json:"price"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &catalog); err != nil {
		return nil, BadAuthRequest("无法读取文字模型当前单价")
	}
	for _, model := range catalog.Data {
		if model.Model != input.Config.Model {
			continue
		}
		inRate, inErr := model.Price.Actual.Input.Float64()
		outRate, outErr := model.Price.Actual.Output.Float64()
		if model.Price.Actual.Type != "flat" || inErr != nil || outErr != nil || inRate < 0 || outRate < 0 || math.IsNaN(inRate+outRate) || math.IsInf(inRate+outRate, 0) {
			break
		}
		inputTokens := len(input.Prompt) + len(input.Config.SystemPrompt)
		for _, message := range input.TextHistory {
			inputTokens += len(message.Content)
		}
		inputTokens += 32 + len(input.ReferenceImages)*4096
		return &generation.CostEstimate{Price: (float64(inputTokens)*inRate + 1024*outRate) / 1e6, Currency: "USD", Estimated: true, Note: fmt.Sprintf("粗估：输入按 UTF-8 字节数、参考图每张按 4096 Token、输出按 1024 Token；当前输入/输出单价 $%g/$%g 每百万 Token，实际按用量结算", inRate, outRate)}, nil
	}
	return nil, BadAuthRequest("当前文字模型未提供可用 Token 单价")
}

func atlasCostRequest(spec protocol.RequestSpec) protocol.RequestSpec {
	spec.Method, spec.Path, spec.OriginPath = http.MethodPost, "/api/v1/model/calculate", true
	spec.ContentType = "application/json"
	spec.Query, spec.Files = nil, nil
	return spec
}

func parseAtlasCost(body []byte) (*generation.CostEstimate, error) {
	var response struct {
		Code json.Number `json:"code"`
		Data struct {
			Price     *json.Number `json:"price"`
			Estimated bool         `json:"estimated"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &response); err != nil || (response.Code != "200" && response.Code != "0") || response.Data.Price == nil {
		return nil, BadAuthRequest("Atlas Cloud 未返回有效报价，请检查参数与参考素材")
	}
	price, err := response.Data.Price.Float64()
	if err != nil || price < 0 || math.IsNaN(price) || math.IsInf(price, 0) {
		return nil, BadAuthRequest("Atlas Cloud 报价无效")
	}
	return &generation.CostEstimate{Price: price, Currency: "USD", Estimated: response.Data.Estimated}, nil
}
