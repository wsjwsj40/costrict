# Dicode branding build

The Dicode VSIX is generated from the normal production VSIX so that backend protocol identifiers remain compatible while all packaged product-facing branding is replaced.

## Icon

Place the internal PNG icon at:

```text
branding/dicode-icon.png
```

The recommended size is 256x256 pixels. If the file is absent, the build uses the current extension icon as a placeholder and prints a warning.

An SVG named `branding/dicode-icon.svg` is used for both the VS Code Activity Bar and the login/account pages. VSIX/Marketplace metadata still requires a PNG, so provide both files for a production package.

## Build

Install the pinned toolchain and dependencies, then package Dicode:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm vsix:dicode
```

The result is written to:

```text
bin/dicode-<version>.vsix
```

Optional metadata can be set with environment variables:

```text
DICODE_PUBLISHER
DICODE_VERSION
DICODE_DESCRIPTION
DICODE_HOMEPAGE
DICODE_REPOSITORY
DICODE_ICON_PATH
```

Cloud UI contributions and static assets are removed from the Dicode package, and runtime UI selection is compiled in classic-only mode.

The Dicode build is offline-safe. If `src/bundled-skills` has already been populated, those review skills are packaged from the local cache. If it is empty, the optional skills are skipped; the built-in Code Review prompts and review flow remain available.

## Import review skills from an installed extension

An installed CoStrict extension normally writes the two review skills below:

```text
Windows: %USERPROFILE%\.costrict\skills-review\review
Windows: %USERPROFILE%\.costrict\skills-security-review\security-review
Linux:   ~/.costrict/skills-review/review
Linux:   ~/.costrict/skills-security-review/security-review
```

Point `DICODE_REVIEW_SKILLS_PATH` at that `.costrict` directory. The build validates `SKILL.md`, imports the locale and version from `.version`, removes the installed-copy `.version` files, and packages the skills as Dicode bundled resources.

PowerShell:

```powershell
$env:DICODE_REVIEW_SKILLS_PATH = "$env:USERPROFILE\.costrict"
pnpm vsix:dicode
```

Bash:

```bash
DICODE_REVIEW_SKILLS_PATH="$HOME/.costrict" pnpm vsix:dicode
```
