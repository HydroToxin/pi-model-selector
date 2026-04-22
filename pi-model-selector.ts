/**
 * Model Selector Extension - Enhanced model selection with pricing info
 *
 * Features:
 * - Adds /models command (leaves built-in /model untouched)
 * - Shows: Model | Provider | Ctx | In($/M) | Out($/M) | Total($) | Total(tok)
 * - Cumulative usage tracking per model from session history
 * - Shortcuts: Shift+Ctrl+I (sort IN), Shift+Ctrl+O (sort OUT), Shift+Ctrl+P (filter Provider), Shift+Ctrl+A (toggle all sessions this month)
 *
 * Usage: pi loads this automatically from ~/.pi/agent/extensions/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import { matchesKey, Key, fuzzyFilter, truncateToWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

interface CumulativeUsage {
    totalCost: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    callCount: number;
}

type UsageScope = "current" | "all-month";

interface EnrichedModel {
    model: Model<Api>;
    displayName: string;
    inputPrice: string;
    outputPrice: string;
    provider: string;
    fullId: string;
    inputPriceNum: number;
    outputPriceNum: number;
    contextWindow: string;
    contextWindowNum: number;
    cumulativeCost: string;
    cumulativeTokens: string;
    cumulativeCostNum: number;
    cumulativeTokensNum: number;
}

function formatCost(costPerMillion: number): string {
    if (costPerMillion === 0) return "$0.00";
    if (Math.abs(costPerMillion) >= 1_000_000) return "-";
    if (Math.abs(costPerMillion) < 0.01) return `$${costPerMillion.toFixed(4)}`;
    return `$${costPerMillion.toFixed(2)}`;
}

function formatCumulativeCost(cost: number): string {
    if (cost <= 0) return "-";
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
    if (tokens <= 0) return "-";
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
    return `${tokens}`;
}

function formatContextWindow(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
    return `${tokens}`;
}

function formatProviderName(provider: string): string {
    return provider;
}

function extractUsageFromLine(line: string, usageMap: Map<string, CumulativeUsage>): void {
    if (!line.trim()) return;
    try {
        const entry = JSON.parse(line);
        let msg: any = entry;
        if (entry.type === "message") msg = entry.message;
        else if (entry.type === "session") return;
        if (!msg || msg.role !== "assistant") return;
        const usage = msg.usage;
        if (!usage) return;
        const modelId = typeof msg.model === "string" ? msg.model : msg.model?.id;
            const provider = msg.provider || (typeof msg.model === "object" ? msg.model?.provider : "unknown");
            if (!modelId) return;
            const key = `${provider}/${modelId}`;
        const ex = usageMap.get(key) || {
            totalCost: 0, totalTokens: 0, inputTokens: 0,
            outputTokens: 0, cacheRead: 0, cacheWrite: 0, callCount: 0,
        };
        const cost = usage.cost || {};
        ex.totalCost += typeof cost.total === "number" ? cost.total : 0;
        ex.inputTokens += usage.input || 0;
        ex.outputTokens += usage.output || 0;
        ex.cacheRead += usage.cacheRead || 0;
        ex.cacheWrite += usage.cacheWrite || 0;
        ex.totalTokens += usage.totalTokens || 0;
        ex.callCount += 1;
        usageMap.set(key, ex);
    } catch {}
}

function parseSessionFile(fp: string, usageMap: Map<string, CumulativeUsage>): void {
    try {
        let content = "";
        if (fp.endsWith(".gz")) {
            content = zlib.gunzipSync(fs.readFileSync(fp)).toString("utf-8");
        } else {
            content = fs.readFileSync(fp, "utf-8");
        }
        for (const line of content.split("\n")) {
            extractUsageFromLine(line, usageMap);
        }
    } catch {}
}

function collectCurrentSessionUsage(ctx: any): Map<string, CumulativeUsage> {
    const usageMap = new Map<string, CumulativeUsage>();
    try {
        // Try sessionManager.getEntries() first
        const sm = ctx.sessionManager;
        let entries: any[] = [];
        if (sm?.getEntries) {
            entries = sm.getEntries();
        } else if (sm?.getSessionDir) {
            // Fallback: read session file directly
            const sd = sm.getSessionDir() as string;
            if (sd && fs.existsSync(sd)) {
                const content = fs.readFileSync(sd, "utf-8");
                for (const line of content.split("\n")) {
                    if (!line.trim()) continue;
                    try { entries.push(JSON.parse(line)); } catch {}
                }
            }
        }
        for (const entry of entries) {
            let msg: any = entry;
            if (entry.type === "message") msg = entry.message;
            else if (entry.type === "session") continue;
            if (!msg || msg.role !== "assistant") continue;
            const usage = msg.usage;
            if (!usage) continue;
            const modelId = typeof msg.model === "string" ? msg.model : msg.model?.id;
            const provider = msg.provider || (typeof msg.model === "object" ? msg.model?.provider : "unknown");
            if (!modelId) continue;
            const key = `${provider}/${modelId}`;
            const ex = usageMap.get(key) || {
                totalCost: 0, totalTokens: 0, inputTokens: 0,
                outputTokens: 0, cacheRead: 0, cacheWrite: 0, callCount: 0,
            };
            const cost = usage.cost || {};
            ex.totalCost += typeof cost.total === "number" ? cost.total : 0;
            ex.inputTokens += usage.input || 0;
            ex.outputTokens += usage.output || 0;
            ex.cacheRead += usage.cacheRead || 0;
            ex.cacheWrite += usage.cacheWrite || 0;
            ex.totalTokens += usage.totalTokens || 0;
            ex.callCount += 1;
            usageMap.set(key, ex);
        }
    } catch {}
    return usageMap;
}

function collectAllSessionsMonthUsage(ctx: any): Map<string, CumulativeUsage> {
    const usageMap = new Map<string, CumulativeUsage>();
    try {
        const sm = ctx.sessionManager;
        if (!sm?.getSessionDir) return usageMap;
        const sd = sm.getSessionDir() as string;
        if (!sd) return usageMap;
        const sessionsPath = path.dirname(sd);
        if (!fs.existsSync(sessionsPath)) return usageMap;
        const now = new Date();
        const curMonth = now.getMonth();
        const curYear = now.getFullYear();
        for (const de of fs.readdirSync(sessionsPath, { withFileTypes: true })) {
            if (!de.isDirectory()) continue;
            const sp = path.join(sessionsPath, de.name);
            const files = fs.readdirSync(sp);
            const jsonl = files.find(f => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz"));
            if (!jsonl) continue;
            const fp = path.join(sp, jsonl);
            try {
                let first = "";
                if (fp.endsWith(".gz")) {
                    first = zlib.gunzipSync(fs.readFileSync(fp)).toString("utf-8").slice(0, 500).split("\n")[0];
                } else {
                    first = fs.readFileSync(fp, "utf-8").slice(0, 500).split("\n")[0];
                }
                if (!first) continue;
                const h = JSON.parse(first);
                if (h.type === "session" && h.timestamp) {
                    const fd = new Date(h.timestamp);
                    if (fd.getMonth() !== curMonth || fd.getFullYear() !== curYear) continue;
                }
            } catch { continue; }
            parseSessionFile(fp, usageMap);
        }
    } catch {}
    return usageMap;
}

function enrichModels(models: Model<Api>[], usage: Map<string, CumulativeUsage>): EnrichedModel[] {
    return models.map((model, idx) => {
        const cost = model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const fullId = `${model.provider}/${model.id}`;
        const u = usage.get(fullId);
        const hasUsage = u && u.callCount > 0;
        return {
            model,
            displayName: model.name || model.id,
            provider: formatProviderName(model.provider),
            fullId,
            inputPrice: formatCost(cost.input),
            outputPrice: formatCost(cost.output),
            inputPriceNum: cost.input || 0,
            outputPriceNum: cost.output || 0,
            contextWindow: formatContextWindow(model.contextWindow),
            contextWindowNum: model.contextWindow || 0,
            cumulativeCost: hasUsage ? formatCumulativeCost(u.totalCost) : "-",
            cumulativeTokens: hasUsage ? formatTokens(u.totalTokens) : "-",
            cumulativeCostNum: hasUsage ? (u?.totalCost ?? 0) : 0,
            cumulativeTokensNum: hasUsage ? (u?.totalTokens ?? 0) : 0,
        };
    });
}

export default function modelSelectorExtension(pi: ExtensionAPI) {
    pi.registerCommand("models", {
        description: "Select model with pricing and cumulative usage (Shift+Ctrl+I=sort IN, Shift+Ctrl+O=sort OUT, Shift+Ctrl+P=filter Provider, Shift+Ctrl+A=all sessions)",
        handler: async (_args: string, ctx: any) => {
            if (!ctx.hasUI) { ctx.ui.notify("models requires interactive mode", "error"); return; }
            const allModels = ctx.modelRegistry.getAvailable();
            if (allModels.length === 0) { ctx.ui.notify("No models available", "error"); return; }

            const cumUsage = collectCurrentSessionUsage(ctx);
            const emodels = enrichModels(allModels, cumUsage);
            let allMonthUsage: Map<string, CumulativeUsage> | null = null;
            let scope: UsageScope = "current";
            const curModel = ctx.model;
            const curModelId = curModel ? `${curModel.provider}/${curModel.id}` : undefined;
            const providers = Array.from(new Set(emodels.map(m => m.provider))).sort();
            providers.unshift("All");

            function refreshScope(newScope: UsageScope) {
                scope = newScope;
                const u = scope === "all-month"
                    ? (allMonthUsage ?? (allMonthUsage = collectAllSessionsMonthUsage(ctx)))
                    : cumUsage;
                const byId = new Map(emodels.map(m => [m.fullId, m]));
                for (const [k, v] of u) {
                    const e = byId.get(k);
                    if (e) {
                        e.cumulativeCost = formatCumulativeCost(v.totalCost);
                        e.cumulativeTokens = formatTokens(v.totalTokens);
                        e.cumulativeCostNum = v.totalCost;
                        e.cumulativeTokensNum = v.totalTokens;
                    }
                }
                for (const e of emodels) {
                    if (!u.has(e.fullId)) {
                        e.cumulativeCost = "-";
                        e.cumulativeTokens = "-";
                        e.cumulativeCostNum = 0;
                        e.cumulativeTokensNum = 0;
                    }
                }
            }

            const result = await ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
                let q = "", filtered = [...emodels], selIdx = 0, curY = 0;
                type SF = "none" | "input" | "output";
                let sf: SF = "none", sd: "asc" | "desc" = "asc", pfi = 0;

                function doSort() {
                    filtered.sort((a, b) => {
                        if (a.fullId === curModelId) return -1;
                        if (b.fullId === curModelId) return 1;
                        if (sf === "input") return sd === "asc" ? a.inputPriceNum - b.inputPriceNum : b.inputPriceNum - a.inputPriceNum;
                        if (sf === "output") return sd === "asc" ? a.outputPriceNum - b.outputPriceNum : b.outputPriceNum - a.outputPriceNum;
                        return a.provider.localeCompare(b.provider) || a.displayName.localeCompare(b.displayName);
                    });
                }

                function doFilter() {
                    const sel = providers[pfi];
                    if (sel === "All") filtered = [...emodels];
                    else filtered = emodels.filter(m => m.provider === sel);
                    if (q.trim()) {
                        const items = filtered.map(m => ({ value: m.fullId, label: m.displayName, description: `${m.inputPrice} | ${m.outputPrice} | ${m.provider}` }));
                        const results = fuzzyFilter(items, q, it => `${it.label} ${it.description}`);
                        const s = new Set(results.map(r => r.value));
                        filtered = filtered.filter(m => s.has(m.fullId));
                    }
                    doSort(); selIdx = 0; curY = 0;
                }
                doSort();

                function handleInput(data: string) {
                    if (matchesKey(data, Key.ctrlShift("i"))) {
                        if (sf === "input") sd = sd === "asc" ? "desc" : "asc"; else { sf = "input"; sd = "asc"; }
                        doSort(); tui.requestRender(); return;
                    }
                    if (matchesKey(data, Key.ctrlShift("o"))) {
                        if (sf === "output") sd = sd === "asc" ? "desc" : "asc"; else { sf = "output"; sd = "asc"; }
                        doSort(); tui.requestRender(); return;
                    }
                    if (matchesKey(data, Key.ctrlShift("p"))) {
                        pfi = (pfi + 1) % providers.length; doFilter(); tui.requestRender(); return;
                    }
                    if (matchesKey(data, Key.ctrlShift("a"))) {
                        refreshScope(scope === "current" ? "all-month" : "current"); doFilter(); tui.requestRender(); return;
                    }
                    if (matchesKey(data, Key.up)) {
                        selIdx = Math.max(0, selIdx - 1); if (selIdx < curY) curY = selIdx; tui.requestRender(); return;
                    }
                    if (matchesKey(data, Key.down)) {
                        selIdx = Math.min(filtered.length - 1, selIdx + 1); if (selIdx >= curY + 12) curY = selIdx - 11; tui.requestRender(); return;
                    }
                    if (matchesKey(data, Key.enter)) { if (filtered[selIdx]) done(filtered[selIdx].model); return; }
                    if (matchesKey(data, Key.escape)) { done(null); return; }
                    if (matchesKey(data, Key.backspace) || data === "\x7f") {
                        if (q.length > 0) { q = q.slice(0, -1); doFilter(); tui.requestRender(); } return;
                    }
                    if (data.length === 1 && data >= " " && data <= "~") { q += data; doFilter(); tui.requestRender(); return; }
                }

                // Build table row - AUTO-SIZE columns based on longest content
                function col(prefix: string, model: string, provider: string, ctx: string, inp: string, out: string, totCost: string, totTok: string, isSel: boolean, isCur: boolean, isFooter: boolean = false): string {
                    // Calculate max widths from ALL data
                    const allModels = [...filtered, ...emodels];
                    let maxModelLen = 5, maxProvLen = 8;
                    for (const m of allModels) {
                        maxModelLen = Math.max(maxModelLen, m.displayName.length, m.cumulativeCost.length, m.cumulativeTokens.length);
                        maxProvLen = Math.max(maxProvLen, m.provider.length);
                    }
                    maxModelLen = Math.min(50, Math.max(20, maxModelLen));
                    maxProvLen = Math.min(20, Math.max(10, maxProvLen));
                    
                    const CW = 8, IW = 10, OW = 10, TW = 10, KW = 12;
                    
                    // Build each cell
                    const modelCell = (model.slice(0, maxModelLen) + " ".repeat(maxModelLen)).slice(0, maxModelLen);
                    const provCell = (provider.slice(0, maxProvLen) + " ".repeat(maxProvLen)).slice(0, maxProvLen);
                    const ctxCell = (" ".repeat(CW) + ctx).slice(-CW);
                    const inCell = (" ".repeat(IW) + inp).slice(-IW);
                    const outCell = (" ".repeat(OW) + out).slice(-OW);
                    const totCell = (" ".repeat(TW) + totCost).slice(-TW);
                    const tokCell = (" ".repeat(KW) + totTok).slice(-KW);
                    
                    // Colors
                    let modelColor = isFooter ? "accent" : (isCur ? "success" : (isSel ? "accent" : "text"));
                    const totCostColor = (totCost === "-" && !isFooter) ? "dim" : "warning";
                    const totTokColor = (totTok === "-" && !isFooter) ? "dim" : "success";
                    
                    return prefix + theme.fg(modelColor, modelCell) + " " + 
                           theme.fg("dim", provCell) + " " + 
                           theme.fg("success", ctxCell) + " " + 
                           theme.fg("dim", inCell) + " " + 
                           theme.fg("dim", outCell) + " " + 
                           theme.fg(totCostColor, totCell) + " " + 
                           theme.fg(totTokColor, tokCell);
                }

                function render(w: number): string[] {
                    const out: string[] = [];
                    const mv = 12;

                    const totalM = emodels.length, filtC = filtered.length;
                    const curProv = providers[pfi];
                    let si = "";
                    if (sf === "input") si = ` | Sort: IN ${sd === "asc" ? "↑" : "↓"}`;
                    else if (sf === "output") si = ` | Sort: OUT ${sd === "asc" ? "↑" : "↓"}`;
                    const fi = curProv !== "All" ? ` | Filter: ${curProv}` : "";
                    const sci = scope === "all-month" ? " | Scope: Month" : "";
                    out.push(` ${theme.fg("accent", truncateToWidth(`Select Model (${filtC}/${totalM})${si}${fi}${sci}`, w - 1, ""))}`);
                    out.push(theme.fg("dim", "─".repeat(w - 1)));

                    // --- Header using same function as rows ---
                    out.push(col("  ", "Model", "Provider", "Ctx", "In($/M)", "Out($/M)", "Total($)", "Total(tok)", false, false, true));
                    out.push(theme.fg("dim", "─".repeat(w - 1)));

                    // --- Rows ---
                    const endM = Math.min(filtered.length, curY + mv);
                    for (let i = curY; i < endM; i++) {
                        const m = filtered[i];
                        const isSel = i === selIdx, isCur = m.fullId === curModelId;
                        const prefix = isSel ? " ►" : "  ";
                        out.push(col(prefix, m.displayName, m.provider, m.contextWindow, m.inputPrice, m.outputPrice, m.cumulativeCost, m.cumulativeTokens, isSel, isCur, false));
                    }
                    for (let i = endM - curY; i < mv; i++) out.push("");

                    // --- Footer ---
                    out.push(theme.fg("dim", "─".repeat(w - 1)));
                    // Sum from filtered models
                    let tCost = 0, tTok = 0;
                    for (const em of filtered) {
                        tCost += em.cumulativeCostNum || 0;
                        tTok += em.cumulativeTokensNum || 0;
                    }
                    const fc = tCost > 0 ? formatCumulativeCost(tCost) : "-";
                    const ft = tTok > 0 ? formatTokens(tTok) : "-";
                    out.push(col("  ", "Total", "", "", "", "", fc, ft, false, false, true));

                    // Search
                    out.push(theme.fg("dim", "─".repeat(w - 1)));
                    out.push(truncateToWidth(` ${theme.fg("accent", "›")} ${q || theme.fg("dim", "Type to filter...")}`, w - 1, ""));

                    // Help
                    out.push(theme.fg("dim", "─".repeat(w - 1)));
                    out.push(truncateToWidth(theme.fg("dim", " Ctrl+I=IN  Ctrl+O=OUT  Ctrl+P=provider  Ctrl+A=all sessions  ↑↓ sel  Enter select  Esc cancel"), w - 1, ""));
                    return out;
                }

                return { render, invalidate: () => {}, handleInput };
            });

            if (result === null) return;
            ctx.model = result;
            ctx.ui.notify(`Switched to ${result.name || result.id}`, "info");
        },
    });
}
