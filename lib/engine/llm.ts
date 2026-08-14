import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { ZodError, type z } from 'zod';
import { env } from '@/lib/env';
import { logServer } from '@/lib/server/log';

/**
 * LLM boundary. The client is injectable (tests use a recorded-fixture mock).
 * The model writes copy; it NEVER decides whether a limit is met — all
 * limits/scans are deterministic code in the gate.
 */

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Optional group label for structured latency logs. */
  groupName?: string;
}

export type LlmClient = (req: LlmRequest) => Promise<string>;

let _anthropic: Anthropic | null = null;

export function anthropicClient(): LlmClient {
  return async ({ system, user, maxTokens, groupName }) => {
    _anthropic ??= new Anthropic({ apiKey: env.anthropicApiKey(), timeout: 90_000 });
    const started = Date.now();
    // Claude Sonnet 5 enables adaptive thinking by default; with modest
    // max_tokens that can consume the whole budget and return zero text.
    // Structured JSON copy does not need thinking — disable it explicitly.
    const msg = await _anthropic.messages.create({
      model: env.anthropicModel(),
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      system: [
        {
          type: 'text',
          text: system,
          // Prompt-cache the shared rules/compliance preamble across the
          // 8 group calls and repair rounds (dominant input cost).
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: user }],
    });
    const block = msg.content.find((b) => b.type === 'text');
    const textBlocks = msg.content.filter((b) => b.type === 'text').length;
    logServer('llm.group', {
      group: groupName ?? 'unknown',
      ms: Date.now() - started,
      stopReason: msg.stop_reason,
      contentTypes: msg.content.map((b) => b.type),
      textBlocks,
      inputTokens: msg.usage?.input_tokens,
      outputTokens: msg.usage?.output_tokens,
    });
    if (!block || block.type !== 'text' || !block.text.trim()) {
      throw new Error(
        `LLM returned no text content (stop_reason=${msg.stop_reason}; blocks=${msg.content.map((b) => b.type).join(',') || 'none'})`,
      );
    }
    return block.text;
  };
}

function extractJson(text: string): string {
  // Tolerate ```json fences and surrounding prose.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in LLM output');
  }
  return sanitizeJsonControlChars(candidate.slice(start, end + 1));
}

/**
 * LLMs sometimes emit raw newlines/tabs inside JSON string values.
 * Escape those control characters so JSON.parse can succeed (zod still validates shape).
 */
function sanitizeJsonControlChars(json: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!;
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      out += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      out += c;
      continue;
    }
    if (inString) {
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        // drop other control chars
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * Failing schema PATHS only ("bullets.0.text") — never messages, never values.
 * Model output must never reach the log stream.
 */
function zodIssuePaths(e: unknown): string[] {
  if (!(e instanceof ZodError)) return [];
  return [...new Set(e.issues.map((i) => i.path.join('.') || '(root)'))].slice(0, 20);
}

/**
 * D1 — a group that could not be produced, as a TYPED failure.
 *
 * The caller has to be able to degrade one group without losing the run, and
 * to say WHY in a log line, without ever touching `message`: a zod message
 * embeds the offending model OUTPUT (see the reparse note above), so only the
 * classification and the failing schema PATHS travel on this object.
 */
export type GroupFailureReason = 'truncated-or-unparseable' | 'schema' | 'transport';

export class GroupGenerationError extends Error {
  constructor(
    readonly group: string,
    readonly reason: GroupFailureReason,
    readonly issuePaths: string[],
    message: string,
  ) {
    super(message);
    this.name = 'GroupGenerationError';
  }
}

function classify(e: unknown): GroupFailureReason {
  if (e instanceof ZodError) return 'schema';
  // A truncated response fails at JSON.parse (SyntaxError), and a response the
  // extractor found no object in fails with our own Error from `extractJson` —
  // both are the max_tokens signature, and both are unusable JSON.
  if (e instanceof SyntaxError) return 'truncated-or-unparseable';
  if (e instanceof Error && e.message.includes('No JSON object found')) return 'truncated-or-unparseable';
  return 'transport';
}

/**
 * Generate one group: prompt → JSON → zod parse; ONE reparse retry with the
 * validation error appended (separate from the gate's repair budget).
 */
export async function generateGroup<S extends z.ZodType>(
  llm: LlmClient,
  groupName: string,
  system: string,
  user: string,
  schema: S,
  maxTokens: number,
): Promise<z.infer<S>> {
  const attempt = async (extra?: string): Promise<z.infer<S>> => {
    const text = await llm({
      system,
      user: extra ? `${user}\n\nIMPORTANT — your previous output was invalid: ${extra}\nReturn corrected JSON only.` : user,
      maxTokens,
      groupName,
    });
    const parsed: unknown = JSON.parse(extractJson(text));
    return schema.parse(parsed);
  };
  try {
    return await attempt();
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 600) : String(e);
    // NEVER log `detail` — a zod message embeds the offending model OUTPUT.
    // Only the error name and the failing schema PATHS are safe to record.
    logServer('llm.reparse', {
      group: groupName,
      error: e instanceof Error ? e.name : 'unknown',
      issuePaths: zodIssuePaths(e),
    });
    try {
      return await attempt(detail);
    } catch (e2) {
      throw new GroupGenerationError(
        groupName,
        classify(e2),
        zodIssuePaths(e2),
        `Group '${groupName}' failed schema validation twice: ${e2 instanceof Error ? e2.message.slice(0, 300) : String(e2)}`,
      );
    }
  }
}
