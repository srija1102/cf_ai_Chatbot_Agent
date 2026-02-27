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
  typoCount: number;
  vulnCount: number;
  criticalCount: number;
};

type AntiPattern = {
  pattern: string;
  category: string;
  frequency: number;
};

// ── Helpers ────────────────────────────────────────────────────────────

function buildStatsContext(
  history: ReviewEntry[],
  patterns: AntiPattern[]
): string {
  const lines: string[] = [];

  if (history.length === 0) {
    lines.push("REVIEW HISTORY: No reviews completed yet.");
  } else {
    const avg = history.reduce((s, r) => s + r.score, 0) / history.length;
    const langs = [...new Set(history.map((r) => r.language))];
    const recent = history.slice(-5).reverse();
    const totalTypos = history.reduce((s, r) => s + (r.typoCount ?? 0), 0);
    const totalVulns = history.reduce((s, r) => s + (r.vulnCount ?? 0), 0);
    const totalCritical = history.reduce(
      (s, r) => s + (r.criticalCount ?? 0),
      0
    );
    lines.push("REVIEW HISTORY:");
    lines.push(`- Total reviews completed: ${history.length}`);
    lines.push(`- Average score: ${avg.toFixed(1)}/10`);
    lines.push(
      `- Highest score: ${Math.max(...history.map((r) => r.score))}/10`
    );
    lines.push(
      `- Lowest score: ${Math.min(...history.map((r) => r.score))}/10`
    );
    lines.push(`- Languages reviewed: ${langs.join(", ")}`);
    lines.push(`- Total typos found across all reviews: ${totalTypos}`);
    lines.push(`- Total vulnerabilities found: ${totalVulns}`);
    lines.push(`- Total critical issues: ${totalCritical}`);
    lines.push(
      `- Recent reviews: ${recent.map((r) => `${r.language} ${r.score}/10`).join(" | ")}`
    );
  }

  lines.push("");

  if (patterns.length === 0) {
    lines.push("RECURRING PATTERNS: None tracked yet.");
  } else {
    lines.push("RECURRING PATTERNS:");
    patterns.forEach((p, i) => {
      lines.push(
        `${i + 1}. [${p.category}] ${p.pattern} (seen ${p.frequency}x)`
      );
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
    console.log("[DEBUG] onChatMessage called, messages:", this.messages.length);
    const workersai = createWorkersAI({ binding: this.env.AI });

    // Safe storage reads — never crash the agent on storage failure
    let reviewHistory: ReviewEntry[] = [];
    let antiPatterns: AntiPattern[] = [];
    try {
      reviewHistory =
        (await this.ctx.storage.get<ReviewEntry[]>("reviewHistory")) ?? [];
      antiPatterns =
        (await this.ctx.storage.get<AntiPattern[]>("antiPatterns")) ?? [];
    } catch (err) {
      console.error("Storage read error:", err);
    }

    const statsContext = buildStatsContext(reviewHistory, antiPatterns);

    const systemPrompt = `You are a production-grade AI code reviewer and security engineer.

Today: ${new Date().toISOString().split("T")[0]}

════════════════════════════════════════════════════════
STEP 1 — CLASSIFY (decide this before doing anything else)
════════════════════════════════════════════════════════

Read the last user message and follow exactly ONE path:

PATH A — STATS/HISTORY
  User asks about scores, history, patterns, past reviews, or stats
  → Answer using the DATA section immediately below. Do NOT run the 5-pass format.

PATH B — CONVERSATION
  Greeting or general question with no code present
  → Reply conversationally. Do NOT run the 5-pass format.

PATH C — CODE REVIEW
  User submits code or asks for a code review
  → Run the full 5-pass analysis below.

════════════════════════════════════════════════════════
DATA — REVIEW HISTORY & PATTERNS (for PATH A)
════════════════════════════════════════════════════════

${statsContext}

════════════════════════════════════════════════════════
ACCURACY RULES (apply to PATH C)
════════════════════════════════════════════════════════

OUTPUT: Plain markdown only. NEVER output JSON, XML, tool call syntax, or any structured data.

NO HALLUCINATION — every finding MUST reference a specific line or construct visible in the submitted code.
BANNED phrases (never use as a finding basis):
  "it's not clear if" · "it's unclear whether" · "might not be sufficient" · "could potentially" · "it's not shown"

NEVER flag correct security practices as vulnerabilities:
  · Secrets in env vars → CORRECT, praise it
  · Parameterised queries (? or $1 placeholders) → CORRECT, praise it
  · jwt.verify() with explicit algorithms array → CORRECT, praise it
  · Rate limiting middleware → CORRECT, praise it
  · HS256 JWT algorithm → WIDELY ACCEPTED, do not flag
  · bcrypt / argon2 / scrypt for password hashing → CORRECT, praise it

NEVER speculate about infrastructure (log rotation, monitoring, secret rotation) — those are ops concerns.
If code is clean, say so clearly and score 8–10. A false positive is as harmful as a missed vulnerability.

════════════════════════════════════════════════════════
5-PASS FRAMEWORK (PATH C only)
════════════════════════════════════════════════════════

PASS 1 · TYPO DETECTION
Scan every identifier, string literal, comment, config key, and regex for:
- Misspelled names (passwrod, authetication, permision, chekc)
- Copy-paste errors: same block with a subtly wrong variable name
- Typos in routing paths, permission names, HTTP header names, env var keys, feature flags
- Regex typos that silently break validation (wrong character class, missing anchor, wrong quantifier)
- Off-by-one in constants or magic numbers
- Identifier shadowing from a typo resolving to a different outer-scope variable
For every typo: exact location · what was found · what was intended · security/correctness impact.

PASS 2 · SECURITY VULNERABILITIES (OWASP Top 10 + extras)
🔴 A01 Broken Access Control — missing auth guards, IDOR, privilege escalation, path traversal
🔴 A02 Cryptographic Failures — MD5/SHA1 for passwords, plaintext secrets, Math.random() for tokens, ECB mode
🔴 A03 Injection — SQL/NoSQL/Command injection, XSS (reflected/stored/DOM), SSTI, LDAP, log injection
🔴 A04 Insecure Design — no rate limiting, no CSRF tokens, open redirects, mass assignment
🔴 A05 Misconfiguration — CORS wildcard, debug endpoints exposed, verbose error stack traces, default credentials
🔴 A06 Vulnerable Components — deprecated or known-bad APIs, crypto primitives
🔴 A07 Auth & Session Failures — no token expiry, weak session IDs, session fixation, no lockout, tokens in URLs
🔴 A08 Integrity Failures — prototype pollution, unsafe deserialization, eval/Function() with user input
🔴 A09 Logging Failures — missing security event logs, logging passwords/tokens/PII
🔴 A10 SSRF — unvalidated URLs in fetch/HTTP, internal IP access, cloud metadata
+ ReDoS, TOCTOU race conditions, hardcoded secrets, type coercion (== vs ===), innerHTML with user input

PASS 3 · TYPO → VULNERABILITY CHAINS
For each typo in Pass 1, trace if it creates or amplifies a security issue:
- Wrong variable in auth check → auth bypass
- Typo in permission string → wrong access level
- Wrong HTTP header name → security header silently dropped (X-Frame-Option → clickjacking)
- Typo in env var key → undefined → insecure default
- Off-by-one in bounds check → out-of-bounds read / data leak
If no typos: "No chains — no typos detected in Pass 1."

PASS 4 · PRODUCTION READINESS
- Auth middleware wired BEFORE route handlers? (JWT verify, session lookup — not just a role check)
- Null safety on req.user / session objects? (user.role crashes if user is undefined)
- Every route branch sends exactly one response? (missing branch = hanging request + memory leak)
- Every async call awaited or .then()/.catch()? Bare calls silently drop errors.
- Error responses leak stack traces or internal paths to the client?
- All user/external inputs validated and sanitised at the boundary?
- DB connections, file handles, timers properly closed?
- Secrets from env vars, not hardcoded?
- Security-relevant events logged (login, permission change, deletion)?
- External HTTP calls have timeouts?
- Unbounded caches or event listeners never removed?

PASS 5 · CODE QUALITY
- Dead code, unreachable branches, commented-out blocks
- Async without await (silent promise drops)
- Missing return after async ops in route handlers
- Overly complex / deeply nested logic
- Inconsistent naming that causes confusion
- Positive observations: what is done well and why it matters

════════════════════════════════════════════════════════
OUTPUT FORMAT — use this exact structure for PATH C
════════════════════════════════════════════════════════

**Language: <name>**

### 🔍 Pass 1 — Typo Detection
<findings or "None detected">

### 🔐 Pass 2 — Security Vulnerabilities
<findings with: 🔴 Critical | 🟡 High | 🟠 Medium | 🔵 Low | ✅ Good>

### ⛓️ Pass 3 — Typo → Vulnerability Chains
<chains or "No chains — no typos detected in Pass 1.">

### 🚀 Pass 4 — Production Readiness
<findings>

### 🧹 Pass 5 — Code Quality
<findings>

### 📊 Summary
| Category | Count |
|---|---|
| Typos | N |
| Critical vulnerabilities | N |
| High vulnerabilities | N |
| Medium vulnerabilities | N |
| Low vulnerabilities | N |
| Production issues | N |

**Overall Score: X.X/10**

After the score line, if a recurring anti-pattern was identified: **New Pattern: [category] description**`;

    const wrappedOnFinish: StreamTextOnFinishCallback<ToolSet> = async (
      event
    ) => {
      await this.saveStatsFromText(event.text, reviewHistory, antiPatterns);
      await onFinish(event);
    };

    // Limit to last 20 messages to prevent token overflow on long sessions
    const modelMessages = await convertToModelMessages(this.messages);
    const recentMessages = pruneMessages({
      messages: modelMessages.slice(-20),
      toolCalls: "before-last-2-messages"
    });

    console.log("[DEBUG] calling streamText, recentMessages count:", recentMessages.length);

    let result;
    try {
      result = streamText({
        model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        system: systemPrompt,
        messages: recentMessages,
        maxOutputTokens: 4096,
        onFinish: wrappedOnFinish,
        stopWhen: stepCountIs(1),
        abortSignal: options?.abortSignal
      });
    } catch (err) {
      console.error("[DEBUG] streamText threw:", err);
      throw err;
    }

    console.log("[DEBUG] streamText result created, returning stream response");
    return result.toUIMessageStreamResponse();
  }

  private async saveStatsFromText(
    text: string,
    currentHistory: ReviewEntry[],
    currentPatterns: AntiPattern[]
  ) {
    // Only process completed code reviews (must have a score line)
    const scoreMatch = text.match(
      /\*\*Overall Score:\s*(\d+(?:\.\d+)?)\s*\/\s*10\*\*/i
    );
    if (!scoreMatch) return;

    const score = parseFloat(scoreMatch[1]);
    if (score < 0 || score > 10) return;

    // Language: use only the "**Language: X**" header — never fall back to body text
    // to avoid false matches (e.g. "common in JavaScript" in a TypeScript review)
    const langMatch = text.match(/\*\*Language:\s*([^\n*]+)\*\*/i);
    const language = langMatch ? langMatch[1].trim() : "Unknown";

    // Extract counts from the Summary table
    const typoMatch = text.match(/\|\s*Typos\s*\|\s*(\d+)\s*\|/i);
    const criticalMatch = text.match(
      /\|\s*Critical vulnerabilities\s*\|\s*(\d+)\s*\|/i
    );
    const highMatch = text.match(
      /\|\s*High vulnerabilities\s*\|\s*(\d+)\s*\|/i
    );
    const mediumMatch = text.match(
      /\|\s*Medium vulnerabilities\s*\|\s*(\d+)\s*\|/i
    );
    const lowMatch = text.match(/\|\s*Low vulnerabilities\s*\|\s*(\d+)\s*\|/i);

    const typoCount = typoMatch ? parseInt(typoMatch[1]) : 0;
    const criticalCount = criticalMatch ? parseInt(criticalMatch[1]) : 0;
    const highCount = highMatch ? parseInt(highMatch[1]) : 0;
    const mediumCount = mediumMatch ? parseInt(mediumMatch[1]) : 0;
    const lowCount = lowMatch ? parseInt(lowMatch[1]) : 0;
    const vulnCount = criticalCount + highCount + mediumCount + lowCount;

    // Persist review entry
    try {
      const history = [...currentHistory];
      history.push({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        language,
        score,
        typoCount,
        vulnCount,
        criticalCount
      });
      if (history.length > 100) history.shift();
      await this.ctx.storage.put("reviewHistory", history);
    } catch (err) {
      console.error("Failed to save review history:", err);
    }

    // Persist recurring anti-pattern if the model flagged one
    const patternMatch = text.match(
      /\*\*New Pattern:\s*\[([^\]]+)\]\s*([^\n*]+)\*\*/i
    );
    if (patternMatch) {
      try {
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
      } catch (err) {
        console.error("Failed to save anti-patterns:", err);
      }
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
