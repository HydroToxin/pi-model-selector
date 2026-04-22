/**
 * Model Selector Extension - Enhanced model selection with pricing info
 *
 * Features:
 * - Adds /models command (leaves built-in /model untouched)
 * - Shows: Model name | Input price | Output price | Provider
 * - Shortcuts: Shift+Ctrl+I (sort IN), Shift+Ctrl+O (sort OUT), Shift+Ctrl+P (filter Provider)
 *
 * Usage: pi loads this automatically from ~/.pi/agent/extensions/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import { matchesKey, Key, fuzzyFilter, truncateToWidth } from "@mariozechner/pi-tui";

// Model with enriched display info
interface EnrichedModel {
    model: Model<Api>;
    displayName: string;
    inputPrice: string;
    outputPrice: string;
    provider: string;
    fullId: string;
    inputPriceNum: number;
    outputPriceNum: number;
}

// Format cost per million tokens
function formatCost(costPerMillion: number | string): string {
    const num = typeof costPerMillion === "string" ? parseFloat(costPerMillion) : costPerMillion;
    if (isNaN(num) || num === 0) return "$0.00";
    if (Math.abs(num) >= 1000000) return "-";
    if (num < 0.01) return `$${num.toFixed(4)}`;
    return `$${num.toFixed(2)}`;
}

// Parse cost string back to number for sorting
function parseCost(costStr: string): number {
    return parseFloat(costStr.replace("$", "")) || 0;
}

// Format provider name for display
function formatProviderName(provider: string): string {
    const mappings: Record<string, string> = {
        "custom-openai": "Custom",
        "openai": "OpenAI",
        "anthropic": "Anthropic",
        "google": "Google",
        "vercel": "Vercel",
        "openrouter": "OpenRouter",
        "groq": "Groq",
        "ollama": "Ollama",
        "bedrock": "Bedrock",
        "vertex": "Vertex",
        "gemini": "Gemini",
        "xai": "xAI",
        "mistral": "Mistral",
        "cohere": "Cohere",
        "azure": "Azure",
    };

    return mappings[provider.toLowerCase()] || provider.charAt(0).toUpperCase() + provider.slice(1);
}

// Enrich models with display info
function enrichModels(models: Model<Api>[]): EnrichedModel[] {
    return models.map((model) => {
        const cost = model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const inputPrice = formatCost(cost.input);
        const outputPrice = formatCost(cost.output);
        return {
            model,
            displayName: model.name || model.id,
            inputPrice,
            outputPrice,
            inputPriceNum: cost.input,
            outputPriceNum: cost.output,
            provider: formatProviderName(model.provider),
            fullId: `${model.provider}/${model.id}`,
        };
    });
}

export default function modelSelectorExtension(pi: ExtensionAPI) {
    // Register /models as new command (leaves built-in /model untouched)
    pi.registerCommand("models", {
        description: "Select model with pricing information (Shift+Ctrl+I=sort IN, Shift+Ctrl+O=sort OUT, Shift+Ctrl+P=filter Provider)",
        handler: async (_args: string, ctx: any) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("models command requires interactive mode", "error");
                return;
            }

            // Get all available models
            const allModels = ctx.modelRegistry.getAvailable();
            if (allModels.length === 0) {
                ctx.ui.notify("No models available. Check your API keys.", "error");
                return;
            }

            const enrichedModels = enrichModels(allModels);
            const currentModel = ctx.model;
            const currentModelId = currentModel
                ? `${currentModel.provider}/${currentModel.id}`
                : undefined;

            // Get unique providers for filtering
            const uniqueProviders = Array.from(new Set(enrichedModels.map(m => m.provider))).sort();
            uniqueProviders.unshift("All"); // Add "All" at the beginning

            // Show custom UI
            const result = await ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
                // State
                let searchQuery = "";
                let filteredModels = [...enrichedModels];
                let selectedIndex = 0;
                let cursorY = 0;

                // Sort state
                type SortField = "none" | "input" | "output";
                type SortDir = "asc" | "desc";
                let sortField: SortField = "none";
                let sortDir: SortDir = "asc";

                // Provider filter state
                let providerFilterIndex = 0; // 0 = All

                // Apply current sort
                function applySort() {
                    filteredModels.sort((a, b) => {
                        // Current model always first
                        if (a.fullId === currentModelId) return -1;
                        if (b.fullId === currentModelId) return 1;

                        // Then apply selected sort
                        if (sortField === "input") {
                            return sortDir === "asc"
                                ? a.inputPriceNum - b.inputPriceNum
                                : b.inputPriceNum - a.inputPriceNum;
                        } else if (sortField === "output") {
                            return sortDir === "asc"
                                ? a.outputPriceNum - b.outputPriceNum
                                : b.outputPriceNum - a.outputPriceNum;
                        }

                        // Default: by provider then name
                        return a.provider.localeCompare(b.provider) || a.displayName.localeCompare(b.displayName);
                    });
                }

                // Apply provider filter
                function applyProviderFilter() {
                    const selectedProvider = uniqueProviders[providerFilterIndex];
                    if (selectedProvider === "All") {
                        filteredModels = [...enrichedModels];
                    } else {
                        filteredModels = enrichedModels.filter(m => m.provider === selectedProvider);
                    }
                    // Re-apply search if exists
                    if (searchQuery.trim()) {
                        const items = filteredModels.map((m) => ({
                            value: m.fullId,
                            label: m.displayName,
                            description: `${m.inputPrice} | ${m.outputPrice} | ${m.provider}`,
                        }));
                        const results = fuzzyFilter(items, searchQuery, (item) => `${item.label} ${item.description}`);
                        const matchedIds = new Set(results.map((r) => r.value));
                        filteredModels = filteredModels.filter((m) => matchedIds.has(m.fullId));
                    }
                    applySort();
                    selectedIndex = 0;
                    cursorY = 0;
                }

                // Initial sort
                applySort();

                function handleSelect() {
                    if (filteredModels.length === 0) return;
                    done(filteredModels[selectedIndex].model);
                }

                function handleInput(data: string) {
                    // Shift+Ctrl+I - Sort by IN price
                    if (matchesKey(data, Key.ctrlShift("i"))) { // Shift+Ctrl+I (0x09 is Tab, but Shift+Ctrl+I sends 0x09)
                        if (sortField === "input") {
                            sortDir = sortDir === "asc" ? "desc" : "asc";
                        } else {
                            sortField = "input";
                            sortDir = "asc";
                        }
                        applySort();
                        tui.requestRender();
                        return;
                    }

                    // Shift+Ctrl+O - Sort by OUT price
                    if (matchesKey(data, Key.ctrlShift("o"))) { // Shift+Ctrl+O
                        if (sortField === "output") {
                            sortDir = sortDir === "asc" ? "desc" : "asc";
                        } else {
                            sortField = "output";
                            sortDir = "asc";
                        }
                        applySort();
                        tui.requestRender();
                        return;
                    }

                    // Shift+Ctrl+P - Cycle through providers
                    if (matchesKey(data, Key.ctrlShift("p"))) { // Shift+Ctrl+P
                        providerFilterIndex = (providerFilterIndex + 1) % uniqueProviders.length;
                        applyProviderFilter();
                        tui.requestRender();
                        return;
                    }

                    // Navigation
                    if (matchesKey(data, Key.up)) {
                        selectedIndex = Math.max(0, selectedIndex - 1);
                        if (selectedIndex < cursorY) {
                            cursorY = selectedIndex;
                        }
                        tui.requestRender();
                        return;
                    }
                    if (matchesKey(data, Key.down)) {
                        selectedIndex = Math.min(filteredModels.length - 1, selectedIndex + 1);
                        const maxVisible = 12;
                        if (selectedIndex >= cursorY + maxVisible) {
                            cursorY = selectedIndex - maxVisible + 1;
                        }
                        tui.requestRender();
                        return;
                    }
                    if (matchesKey(data, Key.enter)) {
                        handleSelect();
                        return;
                    }
                    if (matchesKey(data, Key.escape)) {
                        done(null);
                        return;
                    }

                    // Backspace
                    if (matchesKey(data, Key.backspace) || data === "\x7f") {
                        if (searchQuery.length > 0) {
                            searchQuery = searchQuery.slice(0, -1);
                            applyProviderFilter(); // Re-apply filter with new search
                            tui.requestRender();
                        }
                        return;
                    }

                    // Regular text input
                    if (data.length === 1 && data >= " " && data <= "~") {
                        searchQuery += data;
                        applyProviderFilter(); // Re-apply filter with new search
                        tui.requestRender();
                        return;
                    }
                }

                function render(width: number): string[] {
                    const lines: string[] = [];

                    // Header with filter/sort info
                    const totalModels = enrichedModels.length;
                    const filteredCount = filteredModels.length;
                    const currentProvider = uniqueProviders[providerFilterIndex];

                    let sortIndicator = "";
                    if (sortField === "input") sortIndicator = ` | Sort: IN ${sortDir === "asc" ? "↑" : "↓"}`;
                    else if (sortField === "output") sortIndicator = ` | Sort: OUT ${sortDir === "asc" ? "↑" : "↓"}`;

                    const filterIndicator = currentProvider !== "All" ? ` | Filter: ${currentProvider}` : "";
                    const headerText = `Select Model (${filteredCount}/${totalModels})${sortIndicator}${filterIndicator}`;

                    lines.push(theme.fg("accent", "─".repeat(width)));
                    lines.push(` ${theme.fg("accent", theme.bold(headerText))}`);
                    lines.push(theme.fg("accent", "─".repeat(width)));

                    // Column headers
                    const colModelWidth = Math.max(30, Math.floor(width * 0.45));
                    const colInWidth = 12;
                    const colOutWidth = 12;
                    const colProviderWidth = Math.max(10, width - colModelWidth - colInWidth - colOutWidth - 8);

                    const headerModel = "Model".padEnd(colModelWidth);
                    const headerIn = "IN".padStart(colInWidth);
                    const headerOut = "OUT".padStart(colOutWidth);
                    const headerProvider = "Provider".padStart(colProviderWidth);
                    lines.push(
                        ` ${theme.fg("muted", headerModel)} ${theme.fg("success", headerIn)} ${theme.fg("warning", headerOut)} ${theme.fg("muted", headerProvider)}`,
                    );
                    lines.push(theme.fg("dim", "─".repeat(width)));

                    // Model list
                    const maxVisible = 12;
                    const endIdx = Math.min(filteredModels.length, cursorY + maxVisible);

                    for (let i = cursorY; i < endIdx; i++) {
                        const m = filteredModels[i];
                        const isSelected = i === selectedIndex;
                        const isCurrent = m.fullId === currentModelId;

                        const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
                        const inputPrice = truncateToWidth(m.inputPrice, colInWidth, "").padStart(colInWidth);
                        const outputPrice = truncateToWidth(m.outputPrice, colOutWidth, "").padStart(colOutWidth);
                        const provider = truncateToWidth(m.provider, colProviderWidth, "").padStart(colProviderWidth);

                        // Build name with optional current marker, then pad to stay within column
                        const nameWithMarker = isCurrent ? `${m.displayName} ●` : m.displayName;
                        const name = truncateToWidth(nameWithMarker, colModelWidth, "").padEnd(colModelWidth);

                        // Color coding
                        let nameColored: string;
                        if (isCurrent) {
                            nameColored = theme.fg("success", name);
                        } else if (isSelected) {
                            nameColored = theme.fg("accent", name);
                        } else {
                            nameColored = theme.fg("text", name);
                        }

                        const inputColored = theme.fg("success", inputPrice);
                        const outputColored = theme.fg("warning", outputPrice);
                        const providerColored = theme.fg("dim", provider);

                        lines.push(`${prefix}${nameColored} ${inputColored} ${outputColored} ${providerColored}`);
                    }

                    // Fill empty lines
                    for (let i = endIdx - cursorY; i < maxVisible; i++) {
                        lines.push("");
                    }

                    lines.push(theme.fg("dim", "─".repeat(width)));

                    // Search input
                    const searchDisplay = searchQuery || theme.fg("dim", "Type to filter...");
                    lines.push(` ${theme.fg("accent", ">")} ${searchDisplay}`);

                    // Help text
                    lines.push(theme.fg("dim", "─".repeat(width)));
                    const helpText = " ↑↓ navigate • Enter select • Esc cancel • Shift+Ctrl+I=sort IN • Shift+Ctrl+O=sort OUT • Shift+Ctrl+P=filter";
                    lines.push(theme.fg("dim", helpText));
                    lines.push(theme.fg("accent", "─".repeat(width)));

                    return lines;
                }

                return {
                    render,
                    invalidate: () => {},
                    handleInput,
                };
            });

            if (result === null) {
                ctx.ui.notify("Model selection cancelled", "info");
                return;
            }

            // Set the selected model
            const success = await pi.setModel(result);
            if (success) {
                ctx.ui.notify(`Switched to ${result.provider}/${result.id}`, "success");
            } else {
                ctx.ui.notify(`Failed to switch model (no API key?)`, "error");
            }
        },
    });
}
