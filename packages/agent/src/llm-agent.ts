import Anthropic from "@anthropic-ai/sdk";
import type { Proposal } from "@mercury/core";
import { sha256Hex } from "@mercury/core";
import type {
  GateFeedback,
  Negotiator,
  NegotiationResult,
  NegotiationRound,
  NegotiationTurn,
  NegotiatorContext,
} from "./negotiator.js";
import { promptHash, systemPrompt } from "./prompts.js";
import { type OfferSink, buyerTools, revenueTools } from "./tools.js";

/**
 * The Revenue Agent, backed by Claude.
 *
 * What this class is careful about:
 *
 *   - It never computes a final price. It calls `submit_offer`, which calls
 *     Dwaar, which recomputes the total from the catalogue. The model's
 *     arithmetic is checked and then discarded.
 *   - The cached prefix is `tools -> system`, and both are frozen for the life
 *     of a merchant. Volatile turn state goes in a mid-conversation `system`
 *     message *after* the breakpoint, so injecting a Dwaar verdict or an
 *     envelope balance costs nothing in cache terms.
 *   - Adaptive thinking with a configurable effort. Negotiation under hard
 *     constraints is exactly the kind of work that benefits from it.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmOptions {
  /** Injectable so tests can pass a fake with the same surface. */
  client?: Anthropic;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Bound on API round-trips per turn. Each offer costs one. */
  maxIterations?: number;
}

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_EFFORT: Effort = "high";

export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): Anthropic {
  // A bare constructor also resolves an `ant auth login` profile, so an unset
  // ANTHROPIC_API_KEY is not by itself a missing credential.
  const key = env["ANTHROPIC_API_KEY"];
  return key === undefined || key === "" ? new Anthropic() : new Anthropic({ apiKey: key });
}

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const m = env["MERCURY_MODEL"];
  return m === undefined || m === "" ? DEFAULT_MODEL : m;
}

export function effortFromEnv(env: NodeJS.ProcessEnv = process.env): Effort {
  const e = env["MERCURY_EFFORT"];
  const allowed: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  return allowed.includes(e as Effort) ? (e as Effort) : DEFAULT_EFFORT;
}

/** Accumulates the offers made during one turn and knows when to stop. */
class Sink implements OfferSink {
  readonly list: NegotiationRound[] = [];
  #settled: NegotiationRound | undefined;

  record(proposal: Proposal, feedback: GateFeedback): void {
    const round: NegotiationRound = { proposal, feedback };
    this.list.push(round);
    if (feedback.outcome !== "DENY") this.#settled = round;
  }

  settled(): boolean {
    return this.#settled !== undefined;
  }

  rounds(): number {
    return this.list.length;
  }

  get accepted(): NegotiationRound | undefined {
    return this.#settled;
  }
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export class LlmRevenueAgent implements Negotiator {
  readonly mode = "llm" as const;
  readonly #ctx: NegotiatorContext;
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #effort: Effort;
  readonly #maxTokens: number;
  readonly #maxIterations: number;

  constructor(ctx: NegotiatorContext, opts: LlmOptions = {}) {
    this.#ctx = ctx;
    this.#client = opts.client ?? clientFromEnv();
    this.#model = opts.model ?? modelFromEnv();
    this.#effort = opts.effort ?? effortFromEnv();
    this.#maxTokens = opts.maxTokens ?? 8_000;
    // Each offer is one round-trip; leave room for catalogue lookups and a close.
    this.#maxIterations = opts.maxIterations ?? (this.#ctx.maxRounds ?? 3) * 2 + 4;
  }

  async negotiate(turn: NegotiationTurn): Promise<NegotiationResult> {
    const sink = new Sink();
    const tools = revenueTools(this.#ctx, sink);
    const system = systemPrompt(this.#ctx.persona);

    const history: Anthropic.Beta.BetaMessageParam[] = (turn.history ?? []).map((h) => ({
      role: h.role === "buyer" ? "user" : "assistant",
      content: h.text,
    }));

    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...history,
      { role: "user", content: turn.buyer_message },
      // Volatile operator state. Deliberately a mid-conversation system message
      // rather than an edit to the top-level system prompt: it carries operator
      // authority, is not confusable with buyer text, and leaves the cached
      // prefix byte-identical.
      {
        role: "system",
        content:
          `Session ${turn.session_id}. Merchant ${this.#ctx.profile.merchant_id} ` +
          `(${this.#ctx.profile.display_name}), vertical ${this.#ctx.profile.vertical}. ` +
          `You may submit at most ${this.#ctx.maxRounds ?? 3} offers this turn. ` +
          `End your turn with a short message to the buyer, not with a tool call.`,
      },
    ];

    const started = Date.now();
    const runner = this.#client.beta.messages.toolRunner({
      model: this.#model,
      max_tokens: this.#maxTokens,
      max_iterations: this.#maxIterations,
      thinking: { type: "adaptive" },
      output_config: { effort: this.#effort },
      // The breakpoint sits at the end of the frozen system prompt. Everything
      // above it (tools, then system) is stable for the life of the merchant.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      tools,
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let last: Anthropic.Beta.BetaMessage | undefined;

    for await (const message of runner) {
      last = message;
      inputTokens += message.usage.input_tokens;
      outputTokens += message.usage.output_tokens;
      cacheRead += message.usage.cache_read_input_tokens ?? 0;
      // A server tool can pause a turn; the runner does not auto-resume.
      if (message.stop_reason === "pause_turn") {
        runner.pushMessages({ role: "assistant", content: message.content });
      }
    }

    const reply = last === undefined ? "" : textOf(last.content);
    const accepted = sink.accepted;

    return {
      reply,
      rounds: sink.list,
      ...(accepted === undefined ? {} : { settled: accepted }),
      llm: {
        model: this.#model,
        effort: this.#effort,
        input_hash: promptHash(system + "\n" + turn.buyer_message),
        output_hash: sha256Hex(JSON.stringify({ reply, rounds: sink.list })),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        latency_ms: Date.now() - started,
      },
    };
  }
}

/**
 * The buyer's agent -- the counterparty, simulated.
 *
 * It has no access to the merchant's tools and no key of its own. It exists so
 * the demo is two agents negotiating rather than one agent talking to a script,
 * and so F1 has a genuine adversary applying price pressure.
 */
export class LlmBuyerAgent {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #effort: Effort;
  readonly #persona: string;

  constructor(persona: string, opts: LlmOptions = {}) {
    this.#persona = persona;
    this.#client = opts.client ?? clientFromEnv();
    this.#model = opts.model ?? modelFromEnv();
    this.#effort = opts.effort ?? "medium";
  }

  async respond(merchantMessage: string, history: readonly string[] = []): Promise<string> {
    let captured = "";
    const tools = buyerTools((m) => {
      captured = m;
    });

    await this.#client.beta.messages.toolRunner({
      model: this.#model,
      max_tokens: 2_000,
      max_iterations: 3,
      thinking: { type: "adaptive" },
      output_config: { effort: this.#effort },
      system: [{ type: "text", text: this.#persona, cache_control: { type: "ephemeral" } }],
      messages: [
        ...history.map<Anthropic.Beta.BetaMessageParam>((h) => ({ role: "user", content: h })),
        { role: "user", content: merchantMessage },
      ],
      tools,
    });

    return captured;
  }
}
