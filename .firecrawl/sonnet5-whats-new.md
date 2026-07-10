[Claude Platform Docs](https://platform.claude.com/docs/en/home)

- [Messages](https://platform.claude.com/docs/en/intro)
- [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)
- [Admin](https://platform.claude.com/docs/en/manage-claude/admin-api)
- Resources

[API reference](https://platform.claude.com/docs/en/api/overview)

English [Console](https://platform.claude.com/) [Log in](https://platform.claude.com/login?returnTo=%2Fdocs%2Fen%2Fabout-claude%2Fmodels%2Fwhats-new-sonnet-5)





Search...

⌘K

Models

[Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) [Model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions) [Choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model) [Introducing Claude Fable 5 and Claude Mythos 5](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5) [What's new in Claude Opus 4.8](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8) [What's new in Claude Sonnet 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5) [Upgrade between model versions](https://platform.claude.com/docs/en/about-claude/models/migration-guide) [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) [Model cards](https://platform.claude.com/docs/en/resources/overview) [System prompts](https://platform.claude.com/docs/en/release-notes/system-prompts) [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)

[\\
Log in](https://platform.claude.com/login)

Models & pricingWhat's new in Claude Sonnet 5

Models & pricing/Models

# What's new in Claude Sonnet 5

Copy page



Overview of new features and behavior changes in Claude Sonnet 5.

Copy page



Claude Sonnet 5 is the next generation of Anthropic's Sonnet model family. It is a drop-in upgrade for Claude Sonnet 4.6 with three behavior changes: [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) is on by default, manual extended thinking now returns a 400 error (it was deprecated on Claude Sonnet 4.6), and setting sampling parameters (`temperature`, `top_p`, `top_k`) to non-default values returns a 400 error. This page summarizes everything new at launch, including a new tokenizer.

##     New model

| Model | API model ID | Description |
| --- | --- | --- |
| Claude Sonnet 5 | `claude-sonnet-5` | The best combination of speed and intelligence |

Claude Sonnet 5 supports the [1M token context window](https://platform.claude.com/docs/en/build-with-claude/context-windows) by default (1M tokens is both the default and the maximum; there is no smaller context variant), 128k max output tokens, [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking), and the same set of tools and platform features as Claude Sonnet 4.6, except [Priority Tier](https://platform.claude.com/docs/en/api/service-tiers#supported-models), which is not available on Claude Sonnet 5.

For complete pricing and specs, see the [models overview](https://platform.claude.com/docs/en/about-claude/models/overview).

##     Behavior changes

###     Adaptive thinking on by default

On Claude Sonnet 4.6, requests without a `thinking` field run without thinking. On Claude Sonnet 5, the same requests run with [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking). To turn thinking off, pass `thinking: {type: "disabled"}`. Because `max_tokens` is a hard limit on total output (thinking plus response text), revisit it for workloads that ran without thinking on Claude Sonnet 4.6.

###     Sampling parameters not accepted

Setting `temperature`, `top_p`, or `top_k` to a non-default value returns a 400 error. Remove these parameters when migrating; the default value (or omitting the parameter) is accepted. Use system-prompt instructions to guide model behavior. This is new for Sonnet-class models; the same constraint was previously introduced on Claude Opus 4.7.

###     Manual extended thinking removed

Manual extended thinking (`thinking: {type: "enabled", budget_tokens: N}`) was deprecated on Claude Sonnet 4.6; on Claude Sonnet 5 it is removed and returns a 400 error, the same as on Claude Opus 4.8 and Claude Opus 4.7. Use adaptive thinking with the [effort parameter](https://platform.claude.com/docs/en/build-with-claude/effort) instead.

Python



```
# Not supported on Claude Sonnet 5 (returns 400)
thinking = {"type": "enabled", "budget_tokens": 32000}

# Use this instead
thinking = {"type": "adaptive"}
```

##     New tokenizer

Claude Sonnet 5 uses a new tokenizer. The same input text produces approximately 30% more tokens than on Claude Sonnet 4.6. The exact increase depends on the content. This is not an API change: requests, responses, and streaming events keep the same shape, and no code changes are required.

The change affects anything you measure or budget in tokens:

- **Token counts:**`usage` fields and [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) results for the same text are higher than on Claude Sonnet 4.6. Don't reuse counts measured against earlier models; recount against Claude Sonnet 5.
- **Context window capacity in text terms:** the context window is 1M tokens, but each token covers less text on average, so the same window holds less text than on Claude Sonnet 4.6.
- **`max_tokens` budgets:** an output limit tuned for Claude Sonnet 4.6 may truncate equivalent output on Claude Sonnet 5. Revisit limits sized close to your expected output length.
- **Per-request cost:** per-token pricing is unchanged (see [Pricing](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#pricing)), but because the same text produces more tokens, the cost of an equivalent request can differ from Claude Sonnet 4.6.

##     API constraints inherited from Claude Sonnet 4.6



This constraint is unchanged from Claude Sonnet 4.6. Aside from the three [behavior changes](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#behavior-changes) (see [Migration guide](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#migration-guide)), code that already runs on Claude Sonnet 4.6 needs no other changes.

###     Assistant message prefilling not supported

Prefilling the assistant message returns a `400` error, unchanged from Claude Sonnet 4.6. Use [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), system prompt instructions, or `output_config.format` instead.

##     Capability improvements

Claude Sonnet 5 is a capability upgrade over Claude Sonnet 4.6 at the same price. It is also an option for workloads that need more capability than Claude Sonnet 4.6 provides without moving to an Opus-class model.

The largest gains over Claude Sonnet 4.6 are in coding and agentic tasks. For benchmark results, see [Anthropic's Transparency Hub](https://www.anthropic.com/transparency).

##     Cybersecurity safeguards

Claude Sonnet 5 is the first Sonnet-tier model with real-time cybersecurity safeguards. Requests that involve prohibited or high-risk cybersecurity topics may be refused. Refusals return as a successful HTTP 200 response with `stop_reason: "refusal"`, not an error. See [Safeguards, warnings, and appeals](https://support.claude.com/en/articles/8241253-safeguards-warnings-and-appeals) for background.

##     Pricing

Claude Sonnet 5 is priced at $3 per million input tokens and $15 per million output tokens, unchanged from Claude Sonnet 4.6. Because the [new tokenizer](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#new-tokenizer) produces approximately 30% more tokens for the same text, the cost of an equivalent request can differ from Claude Sonnet 4.6 even though per-token pricing is unchanged. The exact increase depends on the content and workload shape.

Introductory pricing of $2/$10 per million input/output tokens is in effect through August 31, 2026, after which the standard pricing of $3/$15 per million input/output tokens will take effect.

See [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) for complete pricing, including batch processing and prompt caching rates.

##     Availability

At launch, Claude Sonnet 5 is available on:

- **Claude API:** available to all customers.
- **AWS:** available through [Claude in Amazon Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock) and [Claude Platform on AWS](https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws). Claude Sonnet 5 is not available on [Claude on Amazon Bedrock (legacy)](https://platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock-legacy) (the `InvokeModel` and `Converse` APIs).
- **Google Cloud:** available through [Claude on Google Cloud](https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai).
- **Microsoft Foundry:** available through [Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry).

Claude Sonnet 5 supports [zero data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) for organizations with ZDR agreements.

##     Migration guide

Claude Sonnet 5 is a drop-in replacement for Claude Sonnet 4.6. Update your model ID:

```
model = "claude-sonnet-4-6"  # Before
model = "claude-sonnet-5"  # After
```



Then review the following:

1. **Token budgets and counts:** the [new tokenizer](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#new-tokenizer) produces approximately 30% more tokens for the same text. The exact increase depends on the content and workload shape. Recount prompts with [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting), and revisit `max_tokens` limits sized close to your expected output length.
2. **Extended thinking:** if you still set `budget_tokens`, migrate to [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking). Manual extended thinking (`thinking: {type: "enabled"}`) is not supported and returns a 400 error.
3. **Sampling parameters:** requests that set sampling parameters (`temperature`, `top_p`, `top_k`) to a non-default value return a 400 error; remove them when migrating. Tool definitions and response shapes are unchanged, and assistant message prefilling was already unsupported on Claude Sonnet 4.6.

See the [Claude Sonnet 5 section of the migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide#migrating-from-claude-sonnet-4-6-to-claude-sonnet-5) for details.

##     Next steps

[\\
\\
Models overview\\
\\
Complete specs and pricing for all current Claude models.](https://platform.claude.com/docs/en/about-claude/models/overview) [Token counting\\
\\
Measure your prompts under the new tokenizer before you migrate.](https://platform.claude.com/docs/en/build-with-claude/token-counting) [Adaptive thinking\\
\\
The recommended thinking-on mode on Claude Sonnet 5.](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) [Context windows\\
\\
How the 1M token context window works.](https://platform.claude.com/docs/en/build-with-claude/context-windows) [Pricing\\
\\
Complete pricing, including batch processing and prompt caching rates.](https://platform.claude.com/docs/en/about-claude/pricing)

Was this page helpful?



- [New model](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#new-model)
- [Behavior changes](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#behavior-changes)
- [Adaptive thinking on by default](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#adaptive-thinking-on-by-default)
- [Sampling parameters not accepted](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#sampling-parameters-not-accepted)
- [Manual extended thinking removed](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#manual-extended-thinking-removed)
- [New tokenizer](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#new-tokenizer)
- [API constraints inherited from Claude Sonnet 4.6](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#api-constraints-inherited-from-claude-sonnet-4-6)
- [Assistant message prefilling not supported](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#assistant-message-prefilling-not-supported)
- [Capability improvements](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#capability-improvements)
- [Cybersecurity safeguards](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#cybersecurity-safeguards)
- [Pricing](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#pricing)
- [Availability](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#availability)
- [Migration guide](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#migration-guide)
- [Next steps](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5#next-steps)

[Claude Platform Docs](https://platform.claude.com/docs)

[X (Twitter)](https://x.com/claudeai)[Threads](https://www.threads.com/@claudeai)[LinkedIn](https://www.linkedin.com/showcase/claude)[YouTube](https://www.youtube.com/@anthropic-ai)[Instagram](https://instagram.com/claudeai)

### Solutions

- [AI agents](https://claude.com/solutions/agents)
- [Code modernization](https://claude.com/solutions/code-modernization)
- [Coding](https://claude.com/solutions/coding)
- [Customer support](https://claude.com/solutions/customer-support)
- [Education](https://claude.com/solutions/education)
- [Financial services](https://claude.com/solutions/financial-services)
- [Government](https://claude.com/solutions/government)
- [Life sciences](https://claude.com/solutions/life-sciences)

### Partners

- [Claude on AWS](https://claude.com/partners/amazon-bedrock)
- [Claude on Google Cloud](https://claude.com/partners/google-cloud-vertex-ai)

### Learn

- [Blog](https://claude.com/blog)
- [Courses](https://claude.com/resources/courses)
- [Use cases](https://claude.com/resources/use-cases)
- [Connectors](https://claude.com/partners/mcp)
- [Customer stories](https://claude.com/customers)
- [Engineering at Anthropic](https://www.anthropic.com/engineering)
- [Events](https://www.anthropic.com/events)
- [Powered by Claude](https://claude.com/partners/powered-by-claude)
- [Service partners](https://claude.com/partners/services)
- [Startups program](https://claude.com/programs/startups)

### Company

- [Anthropic](https://www.anthropic.com/company)
- [Careers](https://www.anthropic.com/careers)
- [Economic Futures](https://www.anthropic.com/economic-futures)
- [Research](https://www.anthropic.com/research)
- [News](https://www.anthropic.com/news)
- [Responsible Scaling Policy](https://www.anthropic.com/news/announcing-our-updated-responsible-scaling-policy)
- [Security and compliance](https://trust.anthropic.com/)
- [Transparency](https://www.anthropic.com/transparency)

### Learn

- [Blog](https://claude.com/blog)
- [Courses](https://claude.com/resources/courses)
- [Use cases](https://claude.com/resources/use-cases)
- [Connectors](https://claude.com/partners/mcp)
- [Customer stories](https://claude.com/customers)
- [Engineering at Anthropic](https://www.anthropic.com/engineering)
- [Events](https://www.anthropic.com/events)
- [Powered by Claude](https://claude.com/partners/powered-by-claude)
- [Service partners](https://claude.com/partners/services)
- [Startups program](https://claude.com/programs/startups)

### Help and security

- [Availability](https://www.anthropic.com/supported-countries)
- [Status](https://status.claude.com/)
- [Support](https://support.claude.com/)
- [Discord](https://www.anthropic.com/discord)

### Terms and policies

- [Privacy policy](https://www.anthropic.com/legal/privacy)
- [Responsible disclosure policy](https://www.anthropic.com/responsible-disclosure-policy)
- [Terms of service: Commercial](https://www.anthropic.com/legal/commercial-terms)
- [Terms of service: Consumer](https://www.anthropic.com/legal/consumer-terms)
- [Usage policy](https://www.anthropic.com/legal/aup)

Ask Docs
![Chat avatar](https://platform.claude.com/docs/images/book-icon-light.svg)