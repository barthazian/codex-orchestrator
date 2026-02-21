# codex-orchestrator — Safer Install & Distribution Plan (Claude-executable)

## Context (current risks to remove)
The repo currently promotes and/or performs these high-risk actions for end users:
- README instructs users to run a remote script directly (`bash <(curl ...)`) to install.
- The installer script itself runs another `curl | bash` (Bun installer).
- The default path implicitly installs “from `main`”, which is mutable and not verifiable by users.
- Plugin/skill install is comparatively safer (marketplace/file-copy), but the *runtime bootstrap* still pushes users into risky steps.

This plan converts installation into a **pinned, checksum-verified release workflow** and updates docs/skill to recommend it.

---

## Objectives
1. **No `curl | bash` anywhere in the default path** (README, plugin README, skill).
2. Ship **versioned GitHub Releases** containing:
   - `codex-agent` binaries for macOS/Linux/Windows
   - `SHA256SUMS` (checksums for each artifact)
3. Replace `install.sh` with:
   - download (release asset) → verify → install (no cloning repo, no Bun runtime requirement)
4. Make plugin install:
   - pin-able to immutable versions (tag + commit SHA)
5. Add clear security documentation for users.

## Non-goals
- Rewriting orchestration logic beyond install/distribution scope (except small safety fix if trivial).
- Implementing a full TUF/Sigstore pipeline (optional enhancements included).

---

## Phase 1 — Release artifacts (binaries + checksums)

### 1.1 Decide build strategy
Preferred: **Bun compile to standalone executable** per OS/arch (so users do not install Bun).

- Build from `src/cli.ts` into an executable called `codex-agent` (`codex-agent.exe` on Windows).
- Package into tar/zip release assets.

If Bun compile is not viable on Windows, fallback to a Node-based dist + minimal wrapper (but avoid postinstall scripts).

### 1.2 Add GitHub Actions release workflow
Create: `.github/workflows/release.yml`

**Trigger**
- On version tags: `v*.*.*`

**Matrix**
- `ubuntu-latest`, `macos-latest`, `windows-latest`

**Steps**
1. Checkout
2. Install Bun (CI only)
3. `bun install --frozen-lockfile`
4. Build:
   - `bun build --compile src/cli.ts --outfile codex-agent` (Windows: `codex-agent.exe`)
5. Smoke test:
   - `./codex-agent --help`
   - `./codex-agent health` (if health currently requires Codex auth, adjust health to be a pure local check)
6. Package:
   - Linux/macOS: `tar -czf codex-agent_<os>_<arch>.tar.gz codex-agent`
   - Windows: zip `codex-agent.exe`
7. Generate checksums:
   - `sha256sum * > SHA256SUMS` (use platform equivalent on macOS if needed)
8. Create GitHub Release:
   - Upload assets + `SHA256SUMS`

**Acceptance criteria**
- A GitHub release exists for `vX.Y.Z` with binaries and `SHA256SUMS`.
- A clean install can be performed without cloning the repo.

---

## Phase 2 — Replace installer with “download → verify → install” (no Bun install, no clone)

### 2.1 Replace script
Replace:
- `plugins/codex-orchestrator/scripts/install.sh`

With a script that:
- Requires explicit `--version vX.Y.Z` OR supports `--version latest` but **prints exact resolved tag** before download.
- Detects OS/arch and picks correct release asset.
- Downloads:
  - artifact
  - `SHA256SUMS`
- Verifies checksum before installing.
- Installs into:
  - default `~/.local/bin` (no sudo)
- Prints PATH instructions (does not edit shell rc by default).

**Implementation details**
- OS detection:
  - macOS: `Darwin`
  - Linux: `Linux`
  - Windows: treat Git Bash/MSYS as `MINGW*|MSYS*|CYGWIN*`
- Arch mapping:
  - `x86_64|amd64`
  - `arm64|aarch64`
- Checksum verification:
  - Linux: `sha256sum -c`
  - macOS: `shasum -a 256 -c` (or `openssl dgst -sha256`)
  - Windows:
    - prefer `sha256sum` if present
    - fallback to `certutil -hashfile`

**Behavioral requirements**
- Must fail closed: if checksum verification fails → abort.
- Must not `git clone` or run `bun install`.
- Must not run `curl | bash`.

**Acceptance criteria**
- New install script installs `codex-agent` successfully from a pinned release on macOS/Linux/Windows.
- Running `codex-agent --help` works after install.
- Script is readable, small, and prints what it’s doing.

---

## Phase 3 — Documentation changes (remove risky defaults)

### 3.1 Update root `README.md`
File: `README.md`

**Changes**
- Remove the “automated installer” one-liner that pipes remote scripts into bash.
- Replace with:
  - “Download release + verify checksum” manual steps
  - Optional: “download installer script locally then run it” (not piped)
- Requirements section:
  - Remove “Bun via curl|bash” as default
  - Keep “Bun for contributors” in a separate “From Source (Contributors)” section
- Explicitly recommend:
  - `codex` install via official channels (npm/Homebrew/binary per OpenAI)
  - `codex-agent` via GitHub releases

**Acceptance criteria**
- README contains no `curl|bash` in the primary path.
- README has a pinned-version install example (e.g. `v2.1.0`).

### 3.2 Update plugin README
File: `plugins/codex-orchestrator/README.md`

**Changes**
- Mirror the root README’s safer install instructions.
- Remove any `curl|bash` for Bun.

---

## Phase 4 — Claude Code skill update (recommend safe setup protocol)

File:
- `plugins/codex-orchestrator/skills/codex-orchestrator/SKILL.md`

Add a “Setup Protocol” section Claude should follow:
1. Check `codex` is installed (`codex --version`)
2. Check user is authenticated (`codex auth status` if available; otherwise run a no-op)
3. Check `codex-agent` exists (`codex-agent --help`)
4. If missing: instruct **release install + checksum verify** (no curl|bash)
5. Verify `sqlite3` existence only if strictly required; otherwise prefer bundled SQLite usage or clear message

Also add:
- “Do not recommend `danger-full-access` unless user explicitly wants it.”

Acceptance criteria:
- Skill no longer nudges users into risky install commands.
- Skill provides deterministic setup steps.

---

## Phase 5 — Versioning alignment + marketplace pinning

### 5.1 Align versions across manifests
Update all to the same `X.Y.Z`:
- `package.json` `"version"`
- `.claude-plugin/marketplace.json` `metadata.version` and plugin `version`
- `plugins/codex-orchestrator/.claude-plugin/plugin.json` add `"version": "X.Y.Z"` if absent

### 5.2 Make marketplace source pin-able / immutable
In `.claude-plugin/marketplace.json`, consider switching plugin `source` to a GitHub source referencing:
- `ref`: `vX.Y.Z`
- `sha`: commit SHA of that tag

Acceptance criteria:
- Users can install a specific tag and be confident plugin bytes are stable.

---

## Phase 6 — Security documentation

Add: `docs/SECURITY.md`

Include:
- What gets written to disk (jobs folder, prompts/logs, state DB)
- What user data may be sent to Codex depending on file inclusion
- Recommended sandbox/approval defaults and meaning of “full-auto”
- How to uninstall + how to purge logs/state

Acceptance criteria:
- Users can understand data exposure and local persistence with minimal ambiguity.

---

## Optional: Small code safety fix (high value, low diff)
File: `src/exec.ts`

If the code currently passes both `-s <sandbox>` and `--full-auto`, make it non-contradictory:
- Only pass `--full-auto` when sandbox requested is `workspace-write`, OR
- Remove `--full-auto` and set approvals explicitly to match desired behavior.

Acceptance criteria:
- User’s sandbox selection cannot be accidentally overridden by a convenience preset.

---

## QA Checklist (run before PR)
1. `shellcheck` the installer script (Linux/macOS)
2. Build locally (where possible):
   - `bun install`
   - `bun build --compile src/cli.ts --outfile codex-agent`
3. Simulate install:
   - Download release asset + `SHA256SUMS`
   - Verify checksum
   - Install to `~/.local/bin`
4. Validate plugin structure:
   - `claude plugin validate .` (if available)
5. Confirm docs contain no `curl|bash` in the default path.

---

## PR deliverables (what must be in the PR)
- `.github/workflows/release.yml`
- Updated `plugins/codex-orchestrator/scripts/install.sh` (verify + install release assets)
- Updated `README.md`
- Updated `plugins/codex-orchestrator/README.md`
- Updated `plugins/.../skills/.../SKILL.md`
- Version alignment across manifests
- `docs/SECURITY.md`
- (Optional) `src/exec.ts` flag conflict fix

---

## Instructions to the executing agent (Claude)
- Work on a new branch: `security/install-hardening`
- Keep changes minimal and reviewable (small commits per phase).
- Do not introduce new remote script execution paths.
- Prefer deterministic, pinned installs (tag + checksum verification).
- Update documentation examples to use a specific version tag.
