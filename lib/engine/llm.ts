import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
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
  return candidate.slice(start, end + 1);
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
    logServer('llm.reparse', { group: groupName, detail: detail.slice(0, 200) });
    try {
      return await attempt(detail);
    } catch (e2) {
      throw new Error(
        `Group '${groupName}' failed schema validation twice: ${e2 instanceof Error ? e2.message.slice(0, 300) : String(e2)}`,
      );
    }
  }
}
