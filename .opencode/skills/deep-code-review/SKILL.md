---
name: opencode-deep-code-review
description: Perform a thorough, structured code review of a codebase, diff, or PR. Use when asked to review code, check a PR, audit changes, or do a deep analysis of code quality, security, and architecture. Covers correctness, security, performance, maintainability, and style.
---

# Deep Code Review Agent

## When to Use

Triggered when user says things like:
- "review this code"
- "check this PR / diff"
- "audit the changes"
- "analyze this for bugs"
- "do a deep code review"
- "check for security issues"
- "review my changes"

## Review Modes

### Mode 1: Full Codebase Review
Review an entire codebase or directory without a diff.

### Mode 2: PR / Diff Review
Review changes from a git diff (staged, unstaged, or from a PR).

## Process

### Step 1 — Pre-flight: Detect Project Conventions

Inspect these files (if they exist) to understand project-specific rules:
- `CLAUDE.md`, `AGENTS.md`
- `.github/workflows/` (CI/CD pipeline)
- `Makefile`, `package.json`, `pyproject.toml`
- `README.md`, `CONTRIBUTING.md`
- Linting/formatting configs (`.eslintrc`, `ruff.toml`, `prettierrc`, etc.)

Run all applicable safeguards **before** reviewing:
```bash
# JavaScript/TypeScript
npm run lint 2>/dev/null || npx eslint . 2>/dev/null
npm test 2>/dev/null || echo "No tests found"

# Python
make lint 2>/dev/null || ruff check . 2>/dev/null
make test 2>/dev/null || pytest . 2>/dev/null

# Go
make lint 2>/dev/null || golangci-lint run ./... 2>/dev/null
go test ./... 2>/dev/null
```

If safeguards fail, report but **still proceed** with review — the review is about quality, not CI status.

### Step 2 — Gather Context

**For full review (no diff):**
```bash
# List source files
find . -type f \( -name "*.py" -o -name "*.ts" -o -name "*.js" -o -name "*.go" -o -name "*.rs" \) | head -100

# Get file tree for the module
ls -la
```

**For PR/diff review:**
```bash
# View unstaged changes
git diff

# View staged changes
git diff --cached

# View commits on branch
git log --oneline main..HEAD 2>/dev/null || git log --oneline origin/main..HEAD 2>/dev/null

# GitHub PR info (if gh is available)
gh pr view 2>/dev/null || gh pr status 2>/dev/null
```

### Step 3 — Structured Review

For **every file** in scope, analyze:

#### A. Correctness
- Null/undefined pointer access
- Off-by-one errors in loops and array access
- Incorrect variable scope or closure issues
- Logic errors (wrong condition, inverted logic)
- Missing error handling on async operations
- Unhandled promise rejections
- Race conditions in concurrent code
- Incorrect type coercions

#### B. Security (OWASP Top 10)
- **Injection** — SQL, command, or code injection risks
- **Authentication** — broken or missing auth
- **Sensitive data** — hardcoded credentials, API keys, tokens, secrets
- **SSRF** — unchecked URL fetching from user input
- **Path traversal** — unsanitized file path operations
- **XXE** — XML external entity parsing
- **CSRF / XSS** — missing input sanitization, unsanitized HTML rendering
- **Insecure deserialization** — loading untrusted data
- **Broken rate limiting** — missing or bypassable throttling
- **Dependency vulnerabilities** — known vulnerable libraries

#### C. Performance
- N+1 query patterns (database loops)
- Unnecessary re-renders (frontend)
- Missing database indexes on queried columns
- Large in-memory collections without pagination
- Unbounded growth (caching without eviction)
- Sync blocking operations in async code
- Inefficient string concatenation in loops
- Missing query result caching

#### D. Maintainability
- Copy-paste code duplication
- Overly complex functions (>50 lines = smell)
- Deep nesting (>3 levels)
- God objects / files with too many responsibilities
- Magic numbers without named constants
- Poor naming (single letters, ambiguous names)
- Missing or inadequate comments/docstrings
- Inconsistent naming conventions
- Dead code (unused functions, imports, variables)

#### E. Style & Standards
- Formatting violations
- Unused imports or variables
- Missing `const`/`let` where `var` is used
- React class components instead of hooks
- Missing `key` props in React lists
- Improper async/await usage
- Missing async/await where callbacks are used

### Step 4 — Triage Findings

Classify every issue by **severity**:

| Severity | Meaning | Action |
|----------|---------|--------|
| 🔴 **CRITICAL** | Bug, security vulnerability, or data loss risk | MUST_FIX — blocks merge |
| 🟠 **WARNING** | Logic error, performance issue, or convention violation | SHOULD_FIX — fix before merge |
| 🟡 **SUGGESTION** | Style, readability, minor improvement | NICE_TO_FIX — non-blocking |
| 🔵 **INFO** | General observation, educational note | NO_ACTION_NEEDED |

**Critical examples:**
- `NullReferenceException` on null input
- SQL injection vulnerability
- Hardcoded AWS credentials
- Missing authentication check on sensitive endpoint
- Data loss risk (non-idempotent write)

**Warning examples:**
- `for` loop inside a database query (N+1)
- Async function without `await`
- Magic number `86400000` instead of named constant
- Function 200 lines long

**Suggestion examples:**
- Prefer `const` over `let`
- Add JSDoc to public function
- Extract duplicated HTML into component

### Step 5 — Output Format

Present findings in this structure:

```
## 📋 Code Review: {description}

**Files reviewed:** {N}
**Critical:** {N} | **Warning:** {N} | **Suggestion:** {N} | **Info:** {N}

---

### 🔴 CRITICAL

#### `{file.ts}` — {issue title}
{location} (line {N})
{explain why it's critical}

```typescript
// problematic code
```

**Fix:** {how to fix it}

---

### 🟠 WARNING

#### `{file.ts}` — {issue title}
{location} (line {N})
{explain the issue}

```typescript
// problematic code
```

**Fix:** {suggested fix}

---

### 🟡 SUGGESTION

#### `{file.ts}` — {suggestion}
{location}
{explain the improvement}

---

### ✅ Passed Checks

These areas looked good:
- {positive observation 1}
- {positive observation 2}

---

### 📝 Summary

{one-paragraph assessment of the overall code quality}
```

### Step 6 — Fix Suggestions (Optional)

If the user asks, provide **specific code fixes** for critical and warning issues using the `patch` tool.

## Key Principles

1. **Be specific** — always quote the actual code, don't summarize
2. **Explain the "why"** — not just what's wrong but why it matters
3. **Distinguish severity** — don't over-flag style issues as critical
4. **Acknowledge good patterns** — positive feedback is valuable
5. **No git write operations** — do NOT commit, push, or modify code unless explicitly asked
6. **Fix only what's asked** — if user only wants review, don't also fix

## Anti-Patterns to Avoid

- Flagging every style issue as CRITICAL
- Recommending rewrites when targeted fixes would suffice
- Missing the root cause and flagging symptoms
- Not checking for security implications of user input
- Ignoring existing project conventions

## Typical Invocations

- "review the changes in this PR"
- "do a security audit on the auth module"
- "check the new feature for bugs"
- "code review for this diff"
- "review my code for performance issues"
- "analyze this file for issues"
