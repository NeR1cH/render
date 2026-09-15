# Agent Instructions & Engineering Principles

Core principle: Do not optimize for cleverness. Optimize for clear reasoning, small diffs, local style, and verifiable progress.

## 1. Think Before Coding
- State assumptions explicitly. If uncertain, ask rather than guess.
- Present multiple interpretations when ambiguity exists.
- Push back when warranted — if a simpler approach exists, say so.

## 2. Simplicity First (Minimum Code)
- Implement the smallest thing that solves the problem. Nothing speculative.
- Do not create abstractions for one caller.
- Prefer direct implementation over bloated architecture. Solve today's problem.

## 3. Surgical Changes
- Touch ONLY files needed for the task.
- Do not reformat or reorganize adjacent code. Clean up only your own mess.
- Leave surrounding code recognizable.

## 4. Goal-Driven Execution
- Define clear success criteria before writing code.
- Verify changes narrowly. Loop until verified.

## 5. Autonomous Self-Verification Protocol
AFTER EVERY CODE CHANGE, THE MODEL IS REQUIRED TO EXECUTE AN AUTONOMOUS SELF-VERIFICATION:
1. **Run Static Type Checking** (equivalent to `tsc --noEmit` / `lint_applet`) — strictly 0 errors required.
2. **Verify Telegram Platform Limits**:
   - All `callback_data` payloads must strictly be < 64 bytes.
   - Every `bot.callbackQuery` handler must include a mandatory `await ctx.answerCallbackQuery()`.
   - All external and user-supplied strings must be wrapped in `escapeHtml()`.
3. **Verify Network Contracts and Resource Usage**:
   - No dead domains, pre-flight blocking pings, or calls to non-existent methods.
   - Streamed data processing (`stream.pipeline`) to prevent Out-Of-Memory errors.
4. **Include a concise "Self-Verification Checklist" block in the final response** reporting the status of each item.

## 6. Mandatory Documentation Protocol
UPON ANY FEATURE ADDITION OR BUG FIX, THE MODEL MUST SIMULTANEOUSLY UPDATE `CHANGELOG.md` (adding an entry to the [Unreleased] section describing the changes) AND UPDATE SYNTAX / USAGE EXAMPLES IN `README.md` AS NECESSARY.

---

# Project Specific Constraints (Anime Tracker)

- **TypeScript**: Ban `any`. Strict types and interfaces only.
- **Telegram Bot**: `callback_data` MUST be under 64 bytes. Always escape dynamic strings with `escapeHtml`. Always acknowledge callbacks with `ctx.answerCallbackQuery()`.
- **Media & Streams**: Do NOT run CLI FFmpeg against protected CDNs or Windows paths. Use Node.js HTTP streams (`axios` + `pipeline` / `createWriteStream`) for direct MP4 and native TS segments.
- **Environment**: Do NOT invoke CLI/terminal bash commands inside web sandboxes unless explicitly requested.