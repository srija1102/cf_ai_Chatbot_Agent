import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  type StreamTextOnFinishCallback,
  type ToolSet
} from "ai";

// ── Types ──────────────────────────────────────────────────────────────

type ReviewEntry = {
  id: string;
  timestamp: string;
  language: string;
  score: number;
};

type AntiPattern = {
  pattern: string;
  category: string;
  frequency: number;
};

// ── Helpers ────────────────────────────────────────────────────────────

function buildStatsContext(history: ReviewEntry[], patterns: AntiPattern[]): string {
  const lines: string[] = [];

  if (history.length === 0) {
    lines.push("REVIEW HISTORY: No reviews yet.");
  } else {
    const avg = history.reduce((s, r) => s + r.score, 0) / history.length;
    const langs = [...new Set(history.map((r) => r.language))];
    const recent = history.slice(-5).reverse();
    lines.push("REVIEW HISTORY (use this when the user asks for stats):");
    lines.push(`- Total reviews: ${history.length}`);
    lines.push(`- Average score: ${avg.toFixed(1)}/10`);
    lines.push(`- Highest: ${Math.max(...history.map((r) => r.score))}/10`);
    lines.push(`- Lowest: ${Math.min(...history.map((r) => r.score))}/10`);
    lines.push(`- Languages reviewed: ${langs.join(", ")}`);
    lines.push(
      `- Recent: ${recent.map((r) => `${r.language} ${r.score}/10`).join(" | ")}`
    );
  }

  lines.push("");

  if (patterns.length === 0) {
    lines.push("RECURRING PATTERNS: None tracked yet.");
  } else {
    lines.push("RECURRING PATTERNS (use this when the user asks about patterns):");
    patterns.forEach((p, i) => {
      lines.push(`${i + 1}. [${p.category}] ${p.pattern} (seen ${p.frequency}x)`);
    });
  }

  return lines.join("\n");
}

// ── Durable Object ─────────────────────────────────────────────────────

export class CodeReviewAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const reviewHistory =
      (await this.ctx.storage.get<ReviewEntry[]>("reviewHistory")) ?? [];
    const antiPatterns =
      (await this.ctx.storage.get<AntiPattern[]>("antiPatterns")) ?? [];

    const statsContext = buildStatsContext(reviewHistory, antiPatterns);

    const systemPrompt = `You are an expert AI code reviewer and pair programmer.

When the user shares code for review:
1. State the detected language on the first line as: **Language: <name>**
2. Review thoroughly — bugs, security, performance, style
3. Be specific: mention variable/function names and line numbers
4. Always note what was done well, not just issues
5. Use severity labels: 🔴 Critical | 🟡 Warning | 🔵 Info | ✅ Good
6. End every review with: **Overall Score: X.X/10**
7. After the score, if you noticed a recurring anti-pattern worth remembering, add: **New Pattern: [category] description**

When the user asks about their history, stats, or patterns — answer using the data below.

---
${statsContext}
---

Today: ${new Date().toISOString().split("T")[0]}`;

    // Wrap onFinish to extract and save stats from the AI's text response
    const wrappedOnFinish: StreamTextOnFinishCallback<ToolSet> = async (event) => {
      await this.saveStatsFromText(event.text, reviewHistory, antiPatterns);
      await onFinish(event);
    };

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: systemPrompt,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      onFinish: wrappedOnFinish,
      stopWhen: stepCountIs(1),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  private async saveStatsFromText(
    text: string,
    currentHistory: ReviewEntry[],
    currentPatterns: AntiPattern[]
  ) {
    // Only save if the response looks like a code review (has a score)
    const scoreMatch = text.match(/\*\*Overall Score:\s*(\d+(?:\.\d+)?)\s*\/\s*10\*\*/i);
    if (!scoreMatch) return;

    const score = parseFloat(scoreMatch[1]);
    if (score < 0 || score > 10) return;

    // Extract language
    const langMatch =
      text.match(/\*\*Language:\s*([^\n*]+)\*\*/i) ||
      text.match(
        /\b(TypeScript|JavaScript|Python|Go|Rust|Java|C\+\+|C#|Ruby|PHP|Swift|Kotlin|SQL)\b/
      );
    const language = langMatch ? langMatch[1].trim() : "Unknown";

    // Save review entry
    const history = [...currentHistory];
    history.push({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      language,
      score
    });
    if (history.length > 100) history.shift();
    await this.ctx.storage.put("reviewHistory", history);

    // Extract and save new pattern if present
    const patternMatch = text.match(/\*\*New Pattern:\s*\[([^\]]+)\]\s*([^\n*]+)\*\*/i);
    if (patternMatch) {
      const category = patternMatch[1].trim().toLowerCase();
      const pattern = patternMatch[2].trim();
      const patterns = [...currentPatterns];
      const existing = patterns.find((p) => p.pattern === pattern);
      if (existing) {
        existing.frequency += 1;
      } else {
        patterns.push({ pattern, category, frequency: 1 });
      }
      patterns.sort((a, b) => b.frequency - a.frequency);
      if (patterns.length > 20) patterns.pop();
      await this.ctx.storage.put("antiPatterns", patterns);
    }
  }
}

// ── Worker entry ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
