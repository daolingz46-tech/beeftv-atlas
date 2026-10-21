package app

import (
	"context"
	"fmt"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestDeclarativeVideoResumeRequiresReceiptAndReadOnlyPoll(t *testing.T) {
	for _, method := range []string{"GET", "POST"} {
		t.Run(method, func(t *testing.T) {
			manifest := fmt.Sprintf(`{
				"apiVersion":"beeftv.plugin/v2",
				"id":"atlas-model-test","version":"1.0.0","name":"Atlas test","author":"Test","documentation":"# Test",
				"contributes":{"providers":[{"id":"atlas-model-test","label":"Atlas test","capabilities":["video"],"scopes":["canvas"],
				"create":{"method":"POST","path":"/api/v1/model/generateVideo","body":{"model":{"$ref":"request.model"}}},
				"poll":{"method":%q,"path":"/api/v1/model/prediction/{{taskId}}"},
				"response":{"taskId":{"$ref":"response.data.id"},"status":{"$ref":"response.data.status"}}}]}
			}`, method)
			adapter, err := protocol.LoadManifest([]byte(manifest))
			if err != nil {
				t.Fatal(err)
			}
			registry, err := protocol.NewRegistry(adapter)
			if err != nil {
				t.Fatal(err)
			}
			ctx := withProtocolRegistry(context.Background(), registry)
			input := canvasGenerationInput{Mode: "video", Config: providerConfig{InterfaceType: "atlas-model-test", BaseURL: "https://example.com", Model: "test-video"}}
			if resumableDeclarativeVideo(ctx, input, "") {
				t.Fatal("missing receipt must never cause a new submission")
			}
			if got := resumableDeclarativeVideo(ctx, input, "original-prediction"); got != (method == "GET") {
				t.Fatalf("resume eligibility for %s = %v", method, got)
			}
			input.Config.InterfaceType = "missing-adapter"
			if resumableDeclarativeVideo(ctx, input, "original-prediction") {
				t.Fatal("missing adapter cannot resume safely")
			}
		})
	}
}
