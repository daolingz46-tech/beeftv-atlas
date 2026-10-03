import { http } from "./request";

export type ModelCostEstimate = { price: number; currency: "USD"; estimated: boolean; note?: string };

export function estimateModelCost(input: unknown, signal?: AbortSignal) {
    return http.post<ModelCostEstimate>("/workspace/model-cost", input, { signal, timeout: 40000 });
}
