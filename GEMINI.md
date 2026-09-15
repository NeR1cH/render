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
ПОСЛЕ КАЖДОГО ИЗМЕНЕНИЯ КОДА МОДЕЛЬ ОБЯЗАНА ПРОВОДИТЬ АВТОНОМНУЮ САМОПРОВЕРКУ:
1. **Запуск статической проверки типов** (эквивалент `tsc --noEmit` / `lint_applet`) — ошибок должно быть строго 0.
2. **Проверка лимитов Telegram**:
   - Все `callback_data` строго < 64 байт.
   - Каждый обработчик `bot.callbackQuery` содержит обязательный `await ctx.answerCallbackQuery()`.
   - Все внешние и пользовательские строки обернуты в `escapeHtml()`.
3. **Проверка сетевых контрактов и ресурсов**:
   - Никаких мертвых доменов, предварительных блокирующих пингов или вызовов отсутствующих методов.
   - Потоковая передача данных (`stream.pipeline`) для предотвращения Out-Of-Memory.
4. **Предоставление в ответе краткого блока "Self-Verification Checklist" со статусом каждого пункта.**

---

# Project Specific Constraints (Anime Tracker)

- **TypeScript**: Ban `any`. Strict types and interfaces only.
- **Telegram Bot**: `callback_data` MUST be under 64 bytes. Always escape dynamic strings with `escapeHtml`. Always acknowledge callbacks with `ctx.answerCallbackQuery()`.
- **Media & Streams**: Do NOT run CLI FFmpeg against protected CDNs or Windows paths. Use Node.js HTTP streams (`axios` + `pipeline` / `createWriteStream`) for direct MP4 and native TS segments.
- **Environment**: Do NOT invoke CLI/terminal bash commands inside web sandboxes unless explicitly requested.