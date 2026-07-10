import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { env } from '@/lib/env';

/**
 * LLM boundary. The client is injectable (tests use a recorded-fixture mock).
 * The model writes copy; it NEVER decides whether a limit is met — all
 * limits/scans are deterministic code in the gate.
 */

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export type LlmClient = (req: LlmRequest) => Promise<string>;

let _anthropic: Anthropic | null = null;

export function anthropicClient(): LlmClient {
  return async ({ system, user, maxTokens }) => {
    _anthropic ??= new Anthropic({ apiKey: env.anthropicApiKey(), timeout: 90_000 });
    const msg = await _anthropic.messages.create({
      model: env.anthropicModel(),
      max_tokens: maxTokens,
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
    if (!block || block.type !== 'text') {
      throw new Error('LLM returned no text content');
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
    });
    const parsed: unknown = JSON.parse(extractJson(text));
    return schema.parse(parsed);
  };
  try {
    return await attempt();
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 600) : String(e);
    try {
      return await attempt(detail);
    } catch (e2) {
      throw new Error(
        `Group '${groupName}' failed schema validation twice: ${e2 instanceof Error ? e2.message.slice(0, 300) : String(e2)}`,
      );
    }
  }
}
