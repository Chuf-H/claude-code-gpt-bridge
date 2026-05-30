# GPT-CC Bridge Robustness Report

## Current Status

As of 2026-05-30 00:58 +08:00, the host2 GPT-CC bridge is usable for Claude Code tool sessions with `gpt-5.5`.

- Claude Code bridge endpoint: `127.0.0.1:8833`
- Codex Responses adapter endpoint: `127.0.0.1:8834`
- Active autoresearch primary model: `gpt-5.5`
- Fallback models in the research supervisor: `kimi-for-coding` after repeated failures, then `deepseek-v4-pro`
- Recent Manifold loop evidence: rounds 53, 55, and 56 passed validation; round 54 failed but was caught by the supervisor and recovered.

Short version: `GPT-CC + gpt-5.5` is now practical when wrapped by a strict supervisor, but the raw model/bridge pair is not enough for unattended long research loops by itself.

## Update - 2026-05-30 07:32 +08:00

Problem: Manifold round103 produced a useful project-local Python artifact, but its final log still contained repeated half-open `<tool_call>` / `<tool_call name="Edit">` fragments. This means the previous malformed-tool retry was catching the first bad protocol response, but a correction attempt could still return malformed protocol and leak it back to Claude Code as text.

Root cause: the bridge had only a single planning/protocol correction pass. If the upstream model answered the correction with another malformed XML-ish tool dialect, the second bad response was considered the final assistant message.

Solution:

- Added a bounded tool-compliance retry budget via `CLAUDE_GPT_TOOL_COMPLIANCE_RETRIES`, defaulting to 3.
- Escalated the correction prompt to explicitly require a single valid JSON object inside `<tool_call>{...}</tool_call>` and forbid nested XML tags, half-open tags, attribute-only wrappers, and bare tool-call text.
- Added a final quarantine path for malformed tool protocol after the retry budget is exhausted. The bridge will not execute guessed partial tools and will not pass raw malformed `<tool_call>` text through as if it were normal output.
- Added a regression test for the repeated open-tag pattern observed in round103.

Files changed:

- `src/claude-gpt-bridge.mjs`
- `test/bridge-unit.mjs`
- `report.md`

Validation:

- Local: `node test/bridge-unit.mjs` -> `bridge-unit ok`.
- Local: `./scripts/check-public-safe.sh` -> `Public safety scan passed.`
- Host2 validation was run after deploy with the same expected results.

Remaining risk: this prevents raw malformed protocol leakage and gives the model more chances to self-correct, but it still cannot invent a safe missing `content` or command for an incomplete tool. If the model repeatedly emits invalid protocol, the supervisor should mark that round as non-meaningful and switch model rather than guessing.

## Problems Found

### 1. Stale Bridge Process After Sync

The old bridge process could survive a code sync if the PID file was missing or replaced. In that state, `bridge stop` looked successful but the actual old Node process could still be serving traffic.

Impact: tests could appear to use the new bridge while still hitting an old process.

Fix:

- `bin/claude-gpt-bridge stop` now kills by PID file when available.
- It also falls back to `pkill -f "$NODE_BIN $SCRIPT"` and `pkill -f "$SCRIPT"` so stale bridge processes are removed even if the PID file is gone.

### 2. Planning-Only Responses Instead of Tool Calls

Some GPT responses said things like "I'll inspect the logs and run tests" but did not emit a tool call. Claude Code then treated the turn as completed text instead of actual host work.

Impact: a long research loop could waste rounds or falsely report progress.

Fix:

- `src/claude-gpt-bridge.mjs` now detects short planning-only assistant text when file/shell tools are available.
- The bridge retries once with a strict correction asking the model to emit exactly one `<tool_call>{...}</tool_call>`.
- Unit coverage was added in `test/bridge-unit.mjs`.

### 3. Tool Refusal / Protocol Drift

Some upstream GPT-style models may answer as if tools are unavailable, or they may drift away from the expected Claude Code tool protocol.

Impact: Claude Code sees prose rather than Anthropic-style `tool_use`, so the agent does not act.

Fix:

- Existing tool-denial correction is now part of a broader `retryToolComplianceOnce` path.
- Tool-denial retry runs first; planning-only retry runs after that if still needed.
- This gives one lightweight repair attempt before falling back to the configured fallback model.

### 4. Long Research Loop Failures Are Not Pure Bridge Failures

The bridge can translate tool calls, but it cannot guarantee that every generated script is correct or that every research round is meaningful.

Observed failures:

- Invalid generated Python in round 51.
- Timeout / no accepted artifact in round 52 and round 54.
- Rounds that produced artifacts but were still operationally unhealthy.

Fix outside the bridge:

- The autoresearch driver now validates every round.
- A valid round must create durable non-log artifacts.
- New or edited Python must pass `python3 -m py_compile`.
- Planning-only / no-artifact rounds are rejected.
- Timeout and nonzero rc are recorded.
- The supervisor tracks failure streak and switches model after repeated failures.

### 5. Codex CLI Needs a Different Adapter Surface

Codex CLI cannot simply point at the same raw GPT API and become tool-capable. Codex expects an OpenAI Responses-style function-call lifecycle, while Claude Code uses Anthropic-style `tool_use` / `tool_result`.

Fix used on host2:

- A local Responses adapter runs on `127.0.0.1:8834`.
- It bridges Codex-style function calls to the GPT-CC bridge path.
- This is separate from the Claude Code bridge endpoint on `127.0.0.1:8833`.

## Files Updated In The Bridge

- `src/claude-gpt-bridge.mjs`
  - Added planning-only detection.
  - Added planning-only correction retry.
  - Combined tool-denial and planning-only retries under `retryToolComplianceOnce`.
  - Exported helper functions for tests.

- `test/bridge-unit.mjs`
  - Added coverage for planning-only detection and retry shaping.

- `bin/claude-gpt-bridge`
  - Switched to portable `/usr/bin/env bash`.
  - Hardened `stop` to kill stale bridge processes when PID files are stale/missing.

- `bin/claude-gpt`
  - Switched to portable `/usr/bin/env bash`.

## Validation Run Locally After Pullback

Commands run after syncing host2 code back into this local repo:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Results:

- `bridge-unit ok`
- `Public safety scan passed.`

## Operational Recommendation

Use this bridge as the tool-translation layer, not as the only reliability layer.

Recommended production shape for long-running research:

```text
Claude Code / Codex
  -> GPT-CC bridge or Responses adapter
  -> GPT-compatible API model
  -> strict research supervisor
  -> artifact validation, compile checks, timeout checks, model fallback
```

For current autoresearch:

- Keep `gpt-5.5` as the primary model.
- Keep `kimi-for-coding` as the first fallback.
- Keep `deepseek-v4-pro` as the stable fallback.
- Continue rejecting rounds that do not produce durable evidence.

## Remaining Work

- Fold the Codex Responses adapter into this repo if Codex CLI support should be first-class rather than host-local.
- Add an integration test that runs a tiny Claude Code task through the live bridge and verifies a file write.
- Add a regression test for stale PID handling if the test environment can safely spawn and stop a bridge process.
- Keep runtime files out of the repo: `.bridge/`, `.local/`, logs, PID files, and API settings.

## 2026-05-29 GPT Drop Follow-Up

### What Caused The GPT Drop

There were two separate failure modes:

1. Upstream transport failure was returned too bluntly.
   - Round58 showed `API Error: 500 fetch failed`.
   - The bridge was letting a failed `fetch()` escape to the top-level handler, so Claude Code saw a generic 500 from `127.0.0.1:8833`.
   - Because the error bypassed the normal upstream response path, the bridge did not retry the same model and did not invoke the configured fallback model.

2. Some models emitted XML-ish tool-call shapes that were not the bridge's original strict JSON format.
   - Example shape observed in a failed round:

```xml
<tool_call>
<tool_call name="Read">
{"file_path": "..."}
</tool_call>
</tool_call>
```

   - A second observed shape omitted the tool name and only emitted parameters:

```xml
<tool_call>
<parameter name="file_path">...</parameter>
</tool_call>
```

   - The old parser handled the intended JSON tag format, but not these variants.
   - Claude Code then received text instead of an Anthropic `tool_use` block, so the model looked like it had answered but no host tool actually ran. The supervisor correctly rejected that as `no_meaningful_artifacts_after_round`.

### Fix Applied

- Added bounded upstream retries for transient statuses and network errors.
- Converted `fetch failed` / timeout exceptions into structured 502/504 upstream errors.
- Allowed those transient errors to trigger model fallback instead of immediately surfacing as an opaque 500.
- Added `/health` as an alias of `/healthz`.
- Hardened tool-call parsing for the nested `<tool_call name="...">...</tool_call>` shape.
- Added parameter-only XML parsing with conservative tool-name inference for `Read`, `Bash`, `Write`, and `Edit`.
- Added unit coverage for nested tool calls, parameter-only tool calls, and `upstream_fetch_failed` fallback classification.

### Validation

Commands:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Results:

- `bridge-unit ok`
- `Public safety scan passed.`

Host2 bridge was safely restarted after the active autoresearch round ended, so the patch is live on `127.0.0.1:8833` without interrupting that round.

## 2026-05-29 XML Tool Dialect Follow-Up

### Problem Found

After the previous GPT drop fix, Manifold rounds 67-71 still failed validation with `no_meaningful_artifacts_after_round`.
The bridge and upstream API were alive, but several model responses used additional XML-ish tool-call dialects that were not converted into Claude Code `tool_use` blocks.

Observed shapes included:

```xml
<tool_calls>
  <invoke name="Read">
    <parameter name="file_path" string="true">...</parameter>
  </invoke>
</tool_calls>
```

```xml
<tool_call>
  <id="toolu_abc">Bash</id>
  <arg name="command">pwd</arg>
  <arg name="description">Check directory</arg>
</tool_call>
```

```xml
<tool_call name="Bash">
  <command>pwd</command>
  <description>Check directory</description>
</tool_call>
```

### Root Cause

The bridge already handled normal JSON-in-tag tool calls and a smaller set of nested/parameter-only XML variants.
It did not yet support:

- `<invoke name="...">` wrappers under `<tool_calls>`.
- `<arg name="...">` parameters.
- direct child tags such as `<command>...</command>` or `<file_path>...</file_path>`.
- tool-name recovery from malformed id-like tags such as `<id="toolu_abc">Bash</id>`.

So Claude Code saw plain assistant text instead of executable tool calls. The autoresearch supervisor correctly rejected those rounds because no durable artifact was produced.

### Solution Applied

- Replaced the narrow parameter parser with `parseXmlToolInput`, which understands `<parameter>`, `<arg>`, and direct child tags.
- Added conservative type coercion for XML parameter values.
- Added malformed-body tool-name inference for cases where the model writes the tool name inside an id-like tag.
- Added explicit extraction for `<invoke name="...">...</invoke>` blocks.
- Extended loose/nested tool extraction to use the new XML parser and name inference.
- Added unit tests for the three newly observed dialects.

### Files Changed

- `src/claude-gpt-bridge.mjs`
- `test/bridge-unit.mjs`
- `report.md`

### Validation

Host2:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Results:

- `bridge-unit ok`
- `Public safety scan passed.`

Local after sync-back:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Expected result:

- `bridge-unit ok`
- `Public safety scan passed.`

### Runtime Handling

The patched files were deployed to host2 while Manifold round72 was still active.
To avoid disturbing the current autoresearch round, the bridge restart is deferred until there is no active project-local Claude/timeout process.
If the round is still running, an after-round watcher restarts `127.0.0.1:8833` in the idle gap.

### Remaining Risk

This fixes the concrete dialects seen in rounds 67-71, but long research loops can still expose new model-specific tool-call text formats.
The bridge should keep treating parser failures as first-class robustness bugs: capture the exact failed shape, add a minimal parser rule, add a unit test, validate on host2 and local, then sync the bridge back to this folder.

## 2026-05-29 Missing-Brace Tool JSON Follow-Up

### Problem Found

Manifold round72 failed immediately after the XML dialect fix with another malformed-but-recoverable tool-call shape:

```xml
<tool_call>{"id":"toolu_...","name":"Bash","arguments":{"command":"...","description":"..."}</tool_call>
```

The tool name and arguments were complete, but the outer JSON object was missing its final `}` before `</tool_call>`.
Claude Code therefore received assistant text rather than a `tool_use` block, and the supervisor rejected the round with `no_meaningful_artifacts_after_round`.

### Root Cause

The parser was intentionally strict for JSON inside `<tool_call>`.
It could parse balanced JSON and could extract the first balanced JSON object from surrounding text, but it did not repair a nearly complete JSON object that had only lost trailing closing delimiters.

### Solution Applied

- Added `repairTriviallyUnbalancedJson`.
- The repair only runs when the body begins with `{` or `[`.
- It scans the string with JSON-string escaping rules.
- It refuses to repair if the text ends inside a quoted string, has mismatched closers, or is missing more than three closing delimiters.
- It appends only the missing closers implied by the stack, then lets `JSON.parse` validate the repaired candidate.
- Added a regression test matching round72's missing-outer-brace pattern.

This is deliberately narrow: it fixes common model truncation around tool tags without turning arbitrary malformed prose into executable tools.

### Files Changed

- `src/claude-gpt-bridge.mjs`
- `test/bridge-unit.mjs`
- `report.md`

### Validation

Local before deploy, host2 after deploy, and local again after sync-back:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Results:

- `bridge-unit ok`
- `Public safety scan passed.`

### Remaining Risk

This should handle the exact round72 failure class.
If models emit structurally different malformed tags, the same process should be repeated: collect the raw shape, add one constrained parser rule, add one regression test, validate on host2 and local, and sync the bridge back.

## 2026-05-29 Tool-Argument XML Follow-Up

### Problem Found

Manifold round73 exposed another model-specific XML dialect:

```xml
<tool_call>
  <tool_name>Read</tool_name>
  <tool_args>
    <tool_argument name="file_path" value="..."/>
  </tool_args>
</tool_call>
```

The request was semantically complete, but the bridge did not recognize `<tool_name>` plus self-closing `<tool_argument .../>` tags.
Again, Claude Code saw text rather than executable `tool_use`, so the research supervisor rejected the round with `no_meaningful_artifacts_after_round`.

### Root Cause

The XML parser supported `<parameter>...</parameter>`, `<arg>...</arg>`, and direct child tags.
It did not parse self-closing argument tags where the value is stored in an XML attribute, and tool-name inference did not yet read `<tool_name>`.

### Solution Applied

- Added `<tool_argument>...</tool_argument>` and self-closing `<tool_argument name="..." value="..."/>` parsing.
- Extended self-closing parsing to the same constrained parameter path used for other model dialects.
- Added `<tool_name>...</tool_name>` tool-name inference.
- Added a regression test for the exact round73-style `tool_name/tool_args/tool_argument` shape.

### Files Changed

- `src/claude-gpt-bridge.mjs`
- `test/bridge-unit.mjs`
- `report.md`

### Validation

Local before deploy:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Results:

- `bridge-unit ok`
- `Public safety scan passed.`

### Remaining Risk

DeepSeek-style fallback models are producing many ad hoc XML dialects.
The bridge is now more robust, but the long-loop reliability risk is not zero until one full autoresearch round after this patch creates real durable artifacts through the live restarted bridge.

## 2026-05-29 Malformed Arguments And Argument-Tag Follow-Up

### Problem Found

After the previous parser fixes, Manifold made one real validated step in round75, then rounds76-77 failed with two additional tool-call formats.

Round76 emitted malformed JSON where `arguments` was not an object:

```xml
<tool_call>{"id":"toolu_...","name":"Bash","arguments":"command":"ls ...","description":"Check ..."}</tool_call>
```

Round77 emitted nested XML with `<argument>` tags:

```xml
<tool_call>
  <tool_call id="toolu_..." name="Bash">
    <argument name="command" description="Inspect ...">python3 -c "..."</argument>
  </tool_call>
</tool_call>
```

Both contain enough information to safely recover a Claude Code `tool_use`, but the bridge did not yet parse either form.

### Root Cause

The parser had become robust to several XML-ish variants, but the fallback model was still emitting nonstandard hybrid formats:

- `arguments` flattened into a `"command":"..."` pseudo-field instead of a JSON object.
- `<argument>` tags instead of `<arg>`, `<parameter>`, or `<tool_argument>`.
- Useful metadata such as the tool call id in XML attributes was not propagated for XML-derived inputs.

### Solution Applied

- Added `repairMalformedToolJson`, a constrained repair path for the exact flattened `arguments:"command":...,"description":...` pattern.
- Added `<argument>...</argument>` and self-closing `<argument .../>` support to the XML parameter parser.
- Preserved command descriptions from XML attributes.
- Propagated XML `id` attributes into the final Claude Code tool_use id.
- Added regression tests for the round76 malformed-arguments shape and the round77 nested `<argument>` shape.

### Files Changed

- `src/claude-gpt-bridge.mjs`
- `test/bridge-unit.mjs`
- `report.md`

### Validation

Local before deploy:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Results:

- `bridge-unit ok`
- `Public safety scan passed.`

### Remaining Risk

Round75 proves the bridge can now support at least one successful long-loop round, but the fallback model still emits many bespoke tool dialects.
This patch handles the concrete round76-77 failures. The next reliability checkpoint is whether the next post-restart round produces durable artifacts without another parser fix.

## 2026-05-29 Plural Tool-Calls And Raw Command JSON Follow-Up

### Problem Found

After the malformed-arguments fix went live, the long autoresearch loop still surfaced another set of model-specific tool dialects in rounds 83-86.

Rounds 83-84 emitted singular tool calls using plural tags and attribute chains:

```xml
<tool_calls>
  <tool_calls id="toolu_...">
    <tool_calls name="Bash">
      <tool_calls arguments="{"command":"mkdir -p ...","description":"Ensure control directory exists"}</tool_calls>
    </tool_calls>
  </tool_calls>
</tool_calls>
```

Round85 emitted a nested plural JSON block:

```xml
<tool_calls>
  <tool_calls>
    <tool_calls>{"name":"Write","arguments":{"file_path":"...","content":"..."}}</tool_calls>
  </tool_calls>
</tool_calls>
```

Round86 emitted a normal `<tool_call>` tag, but the JSON body contained a raw multi-line shell command with unescaped quotes/newlines inside `arguments.command`:

```xml
<tool_call>{"id":"toolu_...","name":"Bash","arguments":{"command":"python3 -c "
...
" 2>&1","description":"Check available functions"}}</tool_call>
```

These are semantically clear tool calls, but they were not executable because the bridge only treated `<tool_call>` as the main tag and the malformed JSON repair path only handled the earlier flattened `arguments:"command":...` pattern.

### Root Cause

The fallback model keeps varying the surface form of tool calls while preserving the semantic content.
The parser lacked:

- `<tool_calls>` as a singular-call tag alias.
- recursive nested plural-tag extraction.
- recovery from attribute-chain plural tags carrying `id`, `name`, and malformed `arguments`.
- recovery from raw-command JSON where `arguments` is an object but `command` contains unescaped newlines/quotes.

### Solution Applied

- Generalized tagged extraction from `<tool_call>` to `<tool_call>` or `<tool_calls>`.
- Added recursive nested plural-tag handling.
- Added `extractMalformedToolCallsAttrs` for the `id/name/arguments` attribute-chain dialect.
- Extended `repairMalformedToolJson` to handle both flattened `arguments:"command":...` and object-form `arguments:{"command":...}` raw command bodies.
- Added regression tests for:
  - plural attribute-chain `tool_calls`;
  - plural nested JSON `tool_calls`;
  - object-form raw multi-line command JSON.

### Files Changed

- `src/claude-gpt-bridge.mjs`
- `test/bridge-unit.mjs`
- `report.md`

### Validation

Local before deploy:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Results:

- `bridge-unit ok`
- `Public safety scan passed.`

### Remaining Risk

This patch covers the concrete round83-86 parser failures.
The remaining operational risk is now less about one known syntax bug and more about model/tool-protocol drift in long loops: if a future round leaks a new surface form, capture it, add one narrow parser rule, add a regression test, validate on host2/local, and sync the bridge back.

## 2026-05-29 Name/Arguments XML And Array Content Follow-Up

### Problem Found

After the unified tasking benchmark succeeded in round90, rounds92-93 again failed validation with no durable artifacts. The logs showed semantically valid tool calls emitted as ordinary text:

```xml
<tool_call>
{"id":"toolu_...","name":"Write","arguments":{"file_path":"...","content":"..."}}
</tool_call>
```

and:

```xml
<tool_call>
  <name>Bash</name>
  <arguments>{"command":"ls ... && echo \"EXISTS\" || echo \"MISSING\"","description":"Check ..."}</arguments>
</tool_call>
```

The second dialect was not recognized by the bridge because `<name>` and `<arguments>` were not treated as tool-name/input fields. The first dialect is already covered for string `message.content`, but array-form OpenAI content could bypass parsing because `anthropicBlocksFromOpenAIMessage` only inspected string content.

### Root Cause

The long-loop models keep using plausible Anthropic-ish XML wrappers that differ from the bridge prompt. Two gaps remained:

- XML child tags named `<name>` and `<arguments>` were not normalized into a Claude Code tool call.
- Assistant responses whose OpenAI `message.content` is an array were converted to text for retry heuristics, but not for final Anthropic block conversion.

### Solution Applied

- Added `<arguments>...</arguments>` JSON extraction and merge into XML tool input.
- Added `<name>...</name>` as a tool-name inference source, alongside `<tool_name>`.
- Changed final Anthropic block conversion to use `openAIMessageText(message)` so string and array-form content go through the same tool-call parser.
- Added regression tests for the round93 `<name>/<arguments>` dialect and array-form content containing a normal `<tool_call>{...}</tool_call>`.

### Files Changed

- `src/claude-gpt-bridge.mjs`
- `test/bridge-unit.mjs`
- `report.md`

### Validation

Local before deploy:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Host2 after deploy:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Results:

- `bridge-unit ok`
- `Public safety scan passed.`

The active round94 completed before restart, so the bridge was restarted in an idle gap after validation.

### Remaining Risk

The patch should reduce another concrete class of no-artifact rounds. It does not make the scientific story strict best-paper ready by itself: Manifold still needs real closed-loop or materially stronger real-trace evidence, while the current strong results are deterministic BFCL tasking benchmarks.

## 2026-05-29 Tool Alias And Keyed Call Follow-Up

### Problem Found

Rounds95-96 surfaced another small but recurring model dialect. Instead of using Claude Code's exact `Read` tool name, the model emitted:

```xml
<tool_call>
{"read_file":{"file_path":"...","limit":150}}
</tool_call>
```

and:

```xml
<tool_call>{"read_file","arguments":{"file_path":"..."}}</tool_call>
```

Both were semantically clear requests to call `Read`, but the bridge did not normalize object-keyed tool calls or common snake_case aliases.

### Root Cause

The bridge previously expected either a standard `name`/`arguments` object or XML attributes/tags that could infer the tool. It did not handle:

- single-key objects where the key is the tool name and the value is the arguments;
- invalid comma-name objects like `{"read_file","arguments":{...}}`;
- aliases such as `read_file`, `write_file`, `run_shell_command`, and `list_dir`.

### Solution Applied

- Added `canonicalToolName` with conservative aliases for Claude Code tools.
- Added `singleKeyedToolCall` to recover `{ "read_file": { ... } }`-style calls.
- Extended malformed JSON repair for `{"tool_alias","arguments":{...}}`.
- Added regression tests for the round95 keyed `read_file` form and the round96 comma-name `read_file` form.

### Files Changed

- `src/claude-gpt-bridge.mjs`
- `test/bridge-unit.mjs`
- `report.md`

### Validation

Local before deploy:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Host2 after deploy:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Results:

- `bridge-unit ok`
- `Public safety scan passed.`

The patch was deployed while round98 was active, so the bridge restart was staged for the next idle gap rather than interrupting the active autoresearch round.

### Remaining Risk

This covers the concrete round95-96 dialects without broad unsafe command guessing. Future aliases should be added only when a real log shows a semantically clear mapping to an allowed Claude Code tool.

## 2026-05-29 Malformed Incomplete Tool XML Retry Follow-Up

### Problem Found

Round100 emitted an incomplete malformed tool XML block:

```xml
<tool_call>
<tool_call_name="Write</tool_call_name>
<tool_call_name="file_path</tool_call_name>/path/current_round_plan.md</tool_call_name>"
</tool>
```

This was not safe to execute because it did not contain the required `content` argument for `Write`. Treating it as a normal text response caused the round to fail validation with no durable artifact.

### Root Cause

The bridge could retry planning-only text and explicit tool-denial text, but it did not treat unparseable `<tool_call...>`-style protocol fragments as a compliance failure deserving a correction retry.

### Solution Applied

- Added malformed tool-protocol detection for responses that contain tool-call-like XML but parse into zero executable tool calls.
- Routed those responses through the existing planning/tool correction retry path instead of returning the malformed text as a final assistant answer.
- Updated the correction prompt to explicitly mention malformed/incomplete tool XML.
- Added a regression test using the round100 incomplete `tool_call_name` shape.

### Files Changed

- `src/claude-gpt-bridge.mjs`
- `test/bridge-unit.mjs`
- `report.md`

### Validation

Local before deploy:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Host2 after deploy:

```bash
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

Results:

- `bridge-unit ok`
- `Public safety scan passed.`

The patch was deployed while round101 was active, so the bridge restart was staged for the next idle gap rather than interrupting the active autoresearch round.

### Remaining Risk

This patch intentionally does not execute incomplete tools. It only asks the model to retry with a complete standard `<tool_call>{"name":"...","arguments":{...}}</tool_call>` block. If the retry also returns malformed text, the autoresearch driver may still mark the round failed, but at least the bridge will no longer silently accept a visibly broken tool protocol fragment.
