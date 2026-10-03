package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

func TestAtlasQuoteCacheMergesDuplicatesAndSeparatesParametersAndKeys(t *testing.T) {
	config := providerConfig{APIKey: t.Name()}
	spec := protocol.RequestSpec{Method: "POST", Body: map[string]any{"model": "one", "duration": 5}}
	var calls atomic.Int32
	request := func() ([]byte, error) {
		calls.Add(1)
		time.Sleep(10 * time.Millisecond)
		return []byte(`{"code":200,"data":{"price":"0.1"}}`), nil
	}
	var workers sync.WaitGroup
	for range 4 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			if _, err := cachedAtlasQuote(context.Background(), config, spec, request); err != nil {
				t.Error(err)
			}
		}()
	}
	workers.Wait()
	if calls.Load() != 1 {
		t.Fatal("duplicate quotes were not merged")
	}
	spec.Body = map[string]any{"model": "one", "duration": 10}
	if _, err := cachedAtlasQuote(context.Background(), config, spec, request); err != nil {
		t.Fatal(err)
	}
	config.APIKey += "-different-account"
	if _, err := cachedAtlasQuote(context.Background(), config, spec, request); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 {
		t.Fatal("different duration or account reused old price")
	}
}

func TestAtlasQuoteCacheCancellationAndFailureDoNotProduceCachedPrice(t *testing.T) {
	config := providerConfig{APIKey: t.Name()}
	spec := protocol.RequestSpec{Method: "POST"}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := cachedAtlasQuote(ctx, config, spec, func() ([]byte, error) { return nil, errors.New("unused") })
	if !errors.Is(err, context.Canceled) {
		t.Fatal("canceled quote was dispatched")
	}
	calls := 0
	request := func() ([]byte, error) { calls++; return []byte(`{"code":400,"msg":"invalid parameters"}`), nil }
	for range 2 {
		if _, err := cachedAtlasQuote(context.Background(), config, spec, request); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 2 {
		t.Fatal("failed business response was cached")
	}
}

func TestAtlasQuoteCacheHonorsProviderCooldownAndKeepsSuccessfulPrices(t *testing.T) {
	config := providerConfig{APIKey: t.Name()}
	spec := protocol.RequestSpec{Method: "POST", Body: map[string]any{"model": "cached"}}
	success := func() ([]byte, error) { return []byte(`{"code":200,"data":{"price":"0.1"}}`), nil }
	if _, err := cachedAtlasQuote(context.Background(), config, spec, success); err != nil {
		t.Fatal(err)
	}
	uncached := spec
	uncached.Body = map[string]any{"model": "limited"}
	calls := 0
	limited := func() ([]byte, error) {
		calls++
		return nil, WrapAppError(429, "limited", providerHTTPError{StatusCode: 429, RetryAfter: 15 * time.Minute})
	}
	if _, err := cachedAtlasQuote(context.Background(), config, uncached, limited); err == nil {
		t.Fatal("rate limit was ignored")
	}
	if _, err := cachedAtlasQuote(context.Background(), config, uncached, limited); err == nil || !strings.Contains(err.Error(), "15") {
		t.Fatal("cooldown duration was lost")
	}
	if _, err := cachedAtlasQuote(context.Background(), config, spec, limited); err != nil || calls != 1 {
		t.Fatal("cached price was lost or a blocked request was repeated")
	}
}
