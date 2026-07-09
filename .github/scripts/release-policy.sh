#!/usr/bin/env bash
# Shared release-gate helpers. Sourced by the release workflows. On write-credentialed
# jobs it is sourced from origin/main (the trusted base), never from the pushed tag tree.

RELEASE_TAG_REGEX='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
# Unprotected trigger tag that starts a release. It deliberately does NOT match the
# protected v*.*.* ruleset, so it can be created/deleted freely; the real vX.Y.Z tag
# is created once on the squash commit by post-merge-release.
PR_TAG_REGEX='^pr-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

# Workspace package.json files kept in lockstep (the "hybrid version-file"). The root
# package.json stays private at 0.0.0 and is NOT bumped. clients/tabby is canonical
# (the primary published artifact, tabby-peershell).
WORKSPACE_PKGS=(shared/package.json clients/web/package.json clients/tabby/package.json server/package.json)
CANONICAL_PKG='clients/tabby/package.json'

die() {
  echo "::error::$*" >&2
  exit 1
}

notice() {
  echo "::notice::$*"
}

is_release_tag() {
  [[ "${1:-}" =~ ${RELEASE_TAG_REGEX} ]]
}

validate_release_tag() {
  local tag="${1:-}"
  if ! is_release_tag "${tag}"; then
    die "Invalid release tag '${tag}'. Allowed formats are vX.Y.Z and vX.Y.Z-<suffix>."
  fi
}

# Any prerelease suffix (-rc1, -beta1, ...) marks a prerelease.
is_beta_tag() {
  [[ "${1:-}" == *-* ]]
}

is_pr_tag() {
  [[ "${1:-}" =~ ${PR_TAG_REGEX} ]]
}

# pr-vX.Y.Z -> vX.Y.Z (the release tag that will be CREATED at merge).
release_tag_from_pr_tag() {
  local pr_tag="${1:-}"
  if ! is_pr_tag "${pr_tag}"; then
    die "Invalid trigger tag '${pr_tag}'. Expected pr-vX.Y.Z or pr-vX.Y.Z-<suffix>."
  fi
  printf '%s\n' "${pr_tag#pr-}"
}

version_from_tag() {
  local tag="${1:-}"
  validate_release_tag "${tag}"
  printf '%s\n' "${tag#v}"
}

# Read the canonical workspace version at a git ref (via node, always present).
version_at_ref() {
  local ref="${1:-}"
  git show "${ref}:${CANONICAL_PKG}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).version)))'
}

# Rewrite .version in each workspace package.json (2-space indent + trailing newline).
set_version() {
  local version="${1:-}"
  local pkg
  for pkg in "${WORKSPACE_PKGS[@]}"; do
    node -e '
      const fs = require("fs");
      const [file, version] = process.argv.slice(1);
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      j.version = version;
      fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    ' "${pkg}" "${version}"
  done
}

# Assert every workspace version at <ref> equals the tag version (the lockstep invariant).
assert_versions_match_tag() {
  local ref="${1:-}"
  local tag="${2:-}"
  local expected pkg actual
  expected="$(version_from_tag "${tag}")"
  for pkg in "${WORKSPACE_PKGS[@]}"; do
    actual="$(git show "${ref}:${pkg}" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).version)))')"
    if [[ "${actual}" != "${expected}" ]]; then
      die "${pkg} version '${actual}' does not match tag '${tag}' (expected '${expected}')."
    fi
  done
}

extract_pr_marker() {
  local marker="${1:-}"
  PR_MARKER="${marker}" node -e '
    const body = process.env.PR_BODY || "";
    const marker = process.env.PR_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^<!-- " + marker + ": ([^<\\n]+) -->$", "m");
    const m = body.match(re);
    if (!m) { process.exit(1); }
    process.stdout.write(m[1].trim());
  '
}

delete_remote_tag() {
  local tag="${1:-}"
  git push origin ":refs/tags/${tag}" || \
    echo "::warning::Failed to delete tag ${tag} (non-fatal); it may need manual cleanup before this version can be re-released."
}

# Existence probes that DISTINGUISH absent from error (fail closed on error). Echo: present|absent|error.
remote_tag_state() {
  local tag="${1:-}"
  local rc=0
  git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1 || rc=$?
  case "${rc}" in
    0) echo "present" ;;
    2) echo "absent" ;;
    *) echo "error" ;;
  esac
}

remote_release_state() {
  local tag="${1:-}"
  local out
  local rc=0
  out="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${tag}" 2>&1)" || rc=$?
  if [[ "${rc}" -eq 0 ]]; then
    echo "present"
  elif printf '%s' "${out}" | grep -qi 'HTTP 404\|Not Found'; then
    echo "absent"
  else
    echo "error"
  fi
}

assert_release_tag_absent() {
  local tag="${1:-}"
  case "$(remote_tag_state "${tag}")" in
    present) die "Tag ${tag} already exists and is immutable." ;;
    error)   die "Could not determine whether tag ${tag} exists (git ls-remote failed); aborting." ;;
  esac
}

assert_release_absent() {
  local tag="${1:-}"
  case "$(remote_release_state "${tag}")" in
    present) die "Release ${tag} already exists." ;;
    error)   die "Could not determine whether release ${tag} exists (gh api failed); aborting." ;;
  esac
}
