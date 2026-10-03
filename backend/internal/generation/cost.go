package generation

import (
	"context"
	"encoding/json"
)

type CostEstimate struct {
	Price     float64 `json:"price"`
	Currency  string  `json:"currency"`
	Estimated bool    `json:"estimated"`
	Note      string  `json:"note,omitempty"`
}

// Estimation never creates a generation task or reserves a charge.
type CostEstimator interface {
	EstimateGenerationCost(context.Context, string, json.RawMessage) (*CostEstimate, error)
}
