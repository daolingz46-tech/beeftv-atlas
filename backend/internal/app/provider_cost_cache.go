package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

type atlasQuoteSession struct {
	gate     chan struct{}
	last     time.Time
	cooldown time.Time
	cache    map[[32]byte]atlasQuoteCacheEntry
}
type atlasQuoteCacheEntry struct {
	body    []byte
	expires time.Time
}

var atlasQuoteSessions = struct {
	sync.Mutex
	items map[[32]byte]*atlasQuoteSession
}{items: make(map[[32]byte]*atlasQuoteSession)}

// Account-scoped cache and pacing apply only to free pricing reads. Sequential
// clicks and duplicate panels must not exhaust Atlas's per-key pricing limit.
func cachedAtlasQuote(ctx context.Context, config providerConfig, spec protocol.RequestSpec, request func() ([]byte, error)) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	account := sha256.Sum256([]byte(config.BaseURL + "\x00" + config.APIKey))
	wire, _ := json.Marshal(struct {
		Method, Path string
		Body         any
		Headers      []OutboundHeader
	}{spec.Method, spec.Path, spec.Body, config.Headers})
	key := sha256.Sum256(wire)
	atlasQuoteSessions.Lock()
	session := atlasQuoteSessions.items[account]
	if session == nil {
		if len(atlasQuoteSessions.items) >= 16 {
			for id := range atlasQuoteSessions.items {
				delete(atlasQuoteSessions.items, id)
				break
			}
		}
		session = &atlasQuoteSession{gate: make(chan struct{}, 1), cache: make(map[[32]byte]atlasQuoteCacheEntry)}
		atlasQuoteSessions.items[account] = session
	}
	atlasQuoteSessions.Unlock()
	select {
	case session.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-session.gate }()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if cached, ok := session.cache[key]; ok && time.Now().Before(cached.expires) {
		return append([]byte(nil), cached.body...), nil
	}
	if time.Now().Before(session.cooldown) {
		return nil, RateLimited(fmt.Sprintf("Atlas 暂时限制访问，请约 %d 分钟后重试估价", int(math.Ceil(time.Until(session.cooldown).Minutes()))))
	}
	if wait := time.Until(session.last.Add(1100 * time.Millisecond)); wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	session.last = time.Now()
	body, err := request()
	if err != nil {
		var upstream providerHTTPError
		if errors.As(err, &upstream) && upstream.StatusCode == 429 {
			wait := upstream.RetryAfter
			if wait <= 0 {
				wait = time.Minute
			}
			session.cooldown = time.Now().Add(wait)
		}
		return nil, err
	}
	if spec.Method == "POST" {
		if _, err := parseAtlasCost(body); err != nil {
			return body, nil
		}
	} else {
		var response struct {
			Code json.Number     `json:"code"`
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal(body, &response) != nil || (response.Code != "200" && response.Code != "0") || len(response.Data) == 0 {
			return body, nil
		}
	}
	if len(session.cache) >= 256 {
		for id := range session.cache {
			delete(session.cache, id)
			break
		}
	}
	session.cache[key] = atlasQuoteCacheEntry{body: append([]byte(nil), body...), expires: time.Now().Add(time.Minute)}
	return body, nil
}
