---
key: plan-openrouter-error-body-consumed-by-tool-routing-retry
tags:
  - plan
  - bugfix
  - openrouter
  - llm-driver
  - adr-242
  - error-reporting
created: 2026-10-09T23:09:02.484Z
updated: 2026-10-09T23:12:00.453Z
---

# Plan: Preserve the real OpenRouter error body when the tool-routing sniff declines (ADR 242)

**Status**: ready for execution · **Assignee**: `code` persona (single agent, all steps) · **Branch constraint**: do all work on the current branch `feat/swarm-config-startup-underlay` (user: unblocking fix, no new branch, single commit at the end). **ADR**: new `docs/adr/242-openrouter-error-body-consumed-by-tool-routing-retry.md` (241 is taken).

## Why

OpenRouter errors surface as `Error: OpenRouter API error (400): (could not read response body)` — the provider's real error JSON is destroyed before the error is thrown. Root cause: `maybeToolRoutingRetry` (`drone-agent/src/plugins/openai/openai-driver.ts:343-362`) unconditionally pre-reads the failed response body with `await failedResponse.text()` (line 354) to sniff OpenRouter's "No endpoints found that support tool use" 404. When it is NOT that error it returns `undefined` (line 361) with the body stream already consumed. The later `!response.ok` branch (lines 239-263) re-reads `response.text()` (line 242), which throws, so the catch (line 244) substitutes the placeholder `(could not read response body)` into the thrown `DroneLlmError` (message + `body` field). Every non-tool-routing failure loses its detail: 400 (invalid request / context length), 401, 402 (credits), 403 (data policy), 429, 5xx. `--debug llm` cannot recover it (the response debug print at lines 246-251 runs after the body is lost). The openrouter plugin hardcodes `toolRoutingRetry: true` (`drone-agent/src/plugins/openrouter/index.ts:33`); the OpenAI plugin does not set it and is unaffected. The anthropic and echo drivers are single-read and unaffected.

## Locked decisions (grilled with user 2026-10-09)

1. **Fix shape = option 2 (hand back the pre-read text).** `maybeToolRoutingRetry` returns the `errorText` it already read when it declines to retry; the error branch reuses that text, falling back to a fresh `response.text()` + placeholder only when the sniff itself could not read the body. Body is read exactly once in every path. (Option 1, gate the sniff on `status === 404`, was rejected: a non-routing 404 would still lose its body. Option 3, a cross-driver shared error-read helper, rejected: churn with no other affected driver.)
2. **Scope**: `drone-agent/src/plugins/openai/openai-driver.ts` only. No drone-core changes, no config/type/schema changes, `DroneLlmError` shape unchanged. The tool-routing retry path itself is byte-identical in behavior (still one sniff read + one retry fetch).
3. **Policy placement**: stays driver-internal — locked decision Q8 of the unified LLM retry design (coordinator wiki `drone-agent-llm-unified-retry-semantics`) keeps the `require_parameters` request-shaping retry inside the driver; the conversation-service retry loop is untouched.
4. **Tests**: regression test in `drone-agent/test/openrouter.test.ts` next to the existing 'does not retry for non-routing errors' test (~line 244), using that file's `vi.stubGlobal('fetch', …)` + `Response` + `createRegistrationCapture()` pattern. Plus one-line strengthening of the existing 429 test to assert the body text (its current `'OpenRouter API error (429)'` matcher passes even with the bug present).
5. **Docs**: ADR 242 following the ADR-210 house format; add it to `docs/adr/index.md`.
6. **Commit**: single commit on `feat/swarm-config-startup-underlay`, message `fix(llm): preserve real error body when openrouter tool-routing sniff declines (ADR 242)`. Per AGENTS.md, include the untracked `.drone-agent/memory/followup-openrouter-error-body-consumed-by-tool-routing-retry.md` (updated to resolved) and the new plan memory file in the commit.

## Steps (sequential; each depends on the previous)

### Step 1 — coder: return the pre-read text on decline
File: `drone-agent/src/plugins/openai/openai-driver.ts`, function `maybeToolRoutingRetry` (~line 343). Widen the return type and return the read text when declining:

```ts
async function maybeToolRoutingRetry(
  failedResponse: Response,
  request: import('drone-core').DroneChatRequest,
  buildBody: (
    request: import('drone-core').DroneChatRequest,
    providerHints?: { require_parameters: boolean }
  ) => OpenAiChatRequest,
  doFetch: (body: OpenAiChatRequest) => Promise<Response>,
  debug?: boolean
): Promise<
  { response: Response; body: OpenAiChatRequest } | { errorText: string } | undefined
> {
  let errorBody: OpenRouterErrorBody = {};
  let errorText: string | undefined;
  try {
    errorText = await failedResponse.text();
    errorBody = JSON.parse(errorText) as OpenRouterErrorBody;
  } catch {
    // body unreadable or non-JSON: sniff cannot match, fall through
  }

  if (!isToolRoutingError(failedResponse.status, errorBody)) {
    return errorText === undefined ? undefined : { errorText };
  }

  const retryBody = buildBody(request, { require_parameters: true });
  if (debug) {
    console.error('[llm:request] retrying with provider.require_parameters');
  }
  const response = await doFetch(retryBody);
  return { response, body: retryBody };
}
```

Semantics: `text()` threw → `errorText` stays `undefined` → decline returns `undefined` (error branch does its own read; genuine read failure still reaches the placeholder honestly). `JSON.parse` threw → `errorText` is the raw body → returned. Empty body → `{ errorText: '' }` returned (truthful).

### Step 2 — coder: reuse the text at the single call site
Same file, in `chat()` (~lines 226-263). Track a pre-read body and use it in the error branch:

```ts
      let preReadErrorBody: string | undefined;
      if (!response.ok && options.toolRoutingRetry) {
        const retry = await maybeToolRoutingRetry(
          response,
          request,
          buildBody,
          doFetch,
          debug
        );
        if (retry !== undefined) {
          if ('errorText' in retry) {
            preReadErrorBody = retry.errorText;
          } else {
            response = retry.response;
          }
        }
      }

      if (!response.ok) {
        let errorBody: string;
        if (preReadErrorBody !== undefined) {
          errorBody = preReadErrorBody;
        } else {
          try {
            errorBody = await response.text();
          } catch {
            errorBody = '(could not read response body)';
          }
        }
        // ... rest of the existing branch unchanged (debug print, retry-after
        // parse, DroneLlmError with status/retryAfterMs/retryable/body)
```

The debug print at lines 246-251 now prints the real body with no code change. If the sniff matched and the retry response is also `!ok`, `preReadErrorBody` is undefined and the error branch reads the retry response's own body — correct. `maybeToolRoutingRetry` has exactly one caller (verify with LSP find-references before editing; module-local, not exported).

### Step 3 — coder: tests in `drone-agent/test/openrouter.test.ts`
(a) New regression test beside 'does not retry for non-routing errors' (~line 244):

```ts
  it('surfaces the real error body when the tool-routing sniff declines', async () => {
    const capture = createRegistrationCapture();
    capture.config.openrouter.apiKey = 'test-openrouter-key';
    capture.config.openrouter.baseUrl = 'https://openrouter.ai/api/v1';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'This model requires more context: prompt exceeds limit',
            code: 400,
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );

    vi.stubGlobal('fetch', fetchMock);

    await openrouterPlugin.register(capture.registration);
    const provider = capture.getProviderViaDriver();

    const error = await provider
      .chat({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      })
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('prompt exceeds limit');
    expect(error.message).not.toContain('(could not read response body)');
    expect((error as { body?: string }).body).toContain('prompt exceeds limit');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
```

This test FAILS before steps 1-2 (message contains the placeholder) and passes after — run it before and after the change to prove it. (b) One-line strengthening of the existing 429 test: change `.rejects.toThrow('OpenRouter API error (429)')` to `.rejects.toThrow('rate limit exceeded')` so it also pins the real body.

### Step 4 — coder: ADR 242
New file `docs/adr/242-openrouter-error-body-consumed-by-tool-routing-retry.md`, frontmatter format copied from `docs/adr/210-beacon-proxy-error-forwarding.md` (tags + related). Structure: title ("OpenRouter error body survives the tool-routing sniff — read the failed response body exactly once"), Summary, Context (the consumed-stream mechanism with file:line refs; user-visible `(could not read response body)` masking 400/401/402/403/429/5xx), Decision (the three-branch single-read contract: sniff-decline returns `{ errorText }`; retry path unchanged; error branch prefers `preReadErrorBody`, falls back to fresh read, then placeholder), Rationale (option-2 over gate-on-404 over shared-helper), Implementation (openai-driver.ts only; openrouter plugin unchanged; unified-retry Q8 keeps it driver-internal), Tests (the two tests), Key Points, Related (ADR 082 debug-flag llm logging; unified-retry design record). Then add the 242 row to `docs/adr/index.md` (keep the table sorted).

### Step 5 — coder: validation gate (must pass before commit)
Run, in order, from the repo root:
1. Targeted: `pnpm --filter drone-agent exec vitest run test/openrouter.test.ts` (all green).
2. `pnpm run test` (fast suite, all packages).
3. `pnpm typecheck`.
4. `pnpm -r run build`.
5. `pnpm run lint` (ESLint + Prettier). AGENTS.md note: after lint reformats files, re-read any file before editing it again.
6. LSP: typescript diagnostics clean (`lsp__get_diagnostics`) — no errors, no warnings.

### Step 6 — coder: update memories + commit
1. Update the followup memory (key `followup-openrouter-error-body-consumed-by-tool-routing-retry`) to resolved: bug fixed via single-read contract in `maybeToolRoutingRetry` + call site, ADR 242, tests added.
2. Update this plan memory's Status to "executed".
3. Stage and commit on `feat/swarm-config-startup-underlay`: `openai-driver.ts`, `openrouter.test.ts`, `docs/adr/242-…md`, `docs/adr/index.md`, and both `.drone-agent/memory/` files. Message: `fix(llm): preserve real error body when openrouter tool-routing sniff declines (ADR 242)`. Verify the working tree is clean after (`git__status`; HOST.md: clean-tree commit errors are a known false alarm).

### Step 7 — final acceptance check (check the work against the validation criteria)
- [ ] New regression test fails on pre-fix code, passes on post-fix code (verify by reasoning or git stash if uncertain).
- [ ] All six Step-5 gates pass with zero errors; LSP diagnostics clean.
- [ ] Behavior audit: body read exactly once in all three paths (sniff-decline, sniff-retry→ok, sniff-retry→still-!ok); tool-routing retry behavior unchanged (`does not retry for non-routing errors` and the 404-retry tests both pass; fetch call counts unchanged).
- [ ] Diff touches only the files listed in Step 6. No drone-core changes (`pnpm -r build` fresh anyway).
- [ ] Working tree clean on `feat/swarm-config-startup-underlay`; single commit contains code + tests + ADR + index + memories.

## Out of scope
- Anthropic/echo drivers (already single-read), the openai plugin path (`toolRoutingRetry` unset), conversation-service retry policy, DroneLlmError shape, any new branch/PR flow (stay on the current branch per user instruction).