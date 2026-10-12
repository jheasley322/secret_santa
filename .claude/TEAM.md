# Team Map: secret_santa

> Generated 2026-10-11 | Re-run `python generate_agent_team.py` to refresh

## What This Repo Is

A tiny Secret Santa web app for a group of kids. An adult Elf creates a Circle, adds kids by first name and mobile number, and the app texts each kid a private link to fill in a wish list. When every list is done the Elf draws names in the database and the app texts every kid who they drew. Wish lists are public within the circle; matches are private to the giver and the Elf.

**Tech stack:** Static HTML + ES modules + CSS (no build step), supabase-js (pinned CDN), Supabase Postgres + RLS + SECURITY DEFINER RPCs, Supabase Auth (email magic link, Elf only), Supabase Edge Function (Deno) for SMS, Textbelt SMS API, pg_cron, pgTAP, Vitest, Playwright, GitHub Pages / Netlify
**Domains covered:** Database schema, RLS, token RPCs and the draw, SMS sending (Edge Function, secrets, rate limits), Elf and member front end, Tests written from the spec, Adversarial security and spoiler-leak review, Quality gate, Technical and family-facing docs

## The Team

### backend-engineer — Postgres + Edge Function engineer

- **Model:** opus
- **Tools:** Read, Write, Edit, Grep, Glob, Bash, mcp__claude_ai_Supabase__list_tables, mcp__claude_ai_Supabase__list_migrations, mcp__claude_ai_Supabase__execute_sql, mcp__claude_ai_Supabase__apply_migration, mcp__claude_ai_Supabase__get_advisors, mcp__claude_ai_Supabase__list_extensions, mcp__claude_ai_Supabase__search_docs, mcp__claude_ai_Supabase__list_edge_functions, mcp__claude_ai_Supabase__get_edge_function, mcp__claude_ai_Supabase__deploy_edge_function
- **Cannot use:** mcp__claude_ai_Supabase__create_edge_function_secret
- **Rationale:** All of the app's privacy and fairness rules live in Postgres and one Edge Function. Merging SQL and the Edge Function into one owner keeps the draw-lock-then-send sequence in one head.

**Triggers when:** Use for anything under supabase/: migrations, tables, RLS policies, SECURITY DEFINER RPCs (member_view, save_my_list, set_list_done, start_draw, reshuffle, undo_draw), the pg_cron phone-erasure job, and the send-texts Edge Function. Invoke after test-author has written the failing tests for the phas

### frontend-builder — Front-end builder and designer

- **Model:** sonnet
- **Tools:** Read, Write, Edit, Grep, Glob, Bash, WebSearch, WebFetch
- **Rationale:** Three small pages for two audiences (kids and a parent). A separate designer agent is overkill at this size, so design responsibility is folded in with a propose-first rule.

**Triggers when:** Use for all UI work: the Elf pages (sign-in, my circles, circle dashboard), the member page (/m/#token), css/styles.css, and how anything looks or feels. Proposes 2-3 options before building any new screen. Invoke after backend-engineer has the RPCs a page needs. Does not write migrations or tests.

### test-author — Spec-driven test writer

- **Model:** opus
- **Tools:** Read, Write, Edit, Grep, Glob, Bash, mcp__claude_ai_Supabase__list_tables, mcp__claude_ai_Supabase__execute_sql
- **Rationale:** The draw and the privacy rules are exactly the kind of logic where an implementer's tests would encode their own bugs. Writing tests first, from the spec, keeps the implementation honest.

**Triggers when:** Use at the START of every phase, before implementation exists, to write pgTAP, Vitest, Deno and Playwright tests and maintain tests/SCENARIOS.md. Works from .zReference/original_specs.md, deliberately not from the implementation. Re-invoke when the spec changes.

### security-auditor — Adversarial privacy and security reviewer

- **Model:** opus
- **Tools:** Read, Grep, Glob, Bash, mcp__claude_ai_Supabase__list_tables, mcp__claude_ai_Supabase__execute_sql, mcp__claude_ai_Supabase__get_advisors, mcp__claude_ai_Supabase__search_docs
- **Cannot use:** Write, Edit
- **Rationale:** The product's whole promise is a secret that only the Elf can see, for an audience of minors. Spoiler leaks and phone exposure need someone whose only job is to try to break them.

**Triggers when:** Use after any migration that touches tables, policies, grants or RPCs; after any change to the send-texts Edge Function; and before every phase gate. Read-only. Tries to break the app from each role: spoil the draw, read phone numbers, burn SMS credit, leak secrets.

### qa-gate — Quality gate enforcer

- **Model:** sonnet
- **Tools:** Read, Grep, Glob, Bash
- **Cannot use:** Write, Edit
- **Rationale:** A small app is easy to ship half-tested. An independent, read-only gate that runs everything and blocks on red keeps the draw and the privacy rules trustworthy.

**Triggers when:** Invoke automatically after ANY implementation agent (backend-engineer, frontend-builder) finishes, and before a phase is reported done. Runs every test suite and the phase checklist. Never writes code or tests. A FAIL blocks the phase.

### doc-writer — Technical and family-facing docs

- **Model:** sonnet
- **Tools:** Read, Write, Edit, Grep, Glob, Bash
- **Rationale:** Two very different readers (Joe as maintainer; parents and kids as users), plus a texting setup with secrets and a whitelist step that will be forgotten by next December.

**Triggers when:** Use at the end of every phase to update README.md (technical) and /help/ (for parents and kids). Required before qa-gate will pass a phase. The two registers never mix.


## How They Work Together

Each phase in .zReference/master_plan.md runs in the same order. 1) test-author turns the spec into SCENARIOS.md and failing tests. 2) backend-engineer builds the migrations and Edge Function until the database tests pass. 3) security-auditor attacks the result read-only, and any confirmed findings go back to backend-engineer. 4) frontend-builder builds the pages on top of the RPCs, proposing options to Joe first for any new screen. 5) doc-writer updates README and /help/. 6) qa-gate runs everything and either passes the phase or sends exact failures to the owning agent. The lead (main session) coordinates, and Joe approves design options and anything that costs money or sends a real text.

## Enabling Agent Teams

```bash
# Add to your shell profile or .env
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

# Requires Claude Code v2.1.32+
claude --version
```

## Re-generating This Team

Run whenever the repo evolves significantly (new services, major refactors,
new tech added):

```bash
python generate_agent_team.py /path/to/repo
```

The tool will diff existing agents against new proposals and prompt before
overwriting any file.
