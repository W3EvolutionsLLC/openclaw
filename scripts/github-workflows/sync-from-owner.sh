#!/usr/bin/env bash
set -euo pipefail

# Required env vars (passed from workflow)
: "${UPSTREAM_OWNER:?missing}"
: "${UPSTREAM_REPO:?missing}"
: "${DEST_REPO:?missing}"
: "${GH_TOKEN:?missing}"

PRUNE_DELETIONS="${PRUNE_DELETIONS:-true}"
SKIP_WORKFLOW_CHANGES="${SKIP_WORKFLOW_CHANGES:-true}"
EXCLUDE_BRANCH="${EXCLUDE_BRANCH:-}"

git config --global --add safe.directory "$GITHUB_WORKSPACE"

mkdir -p repo
cd repo
git init --bare

git remote add upstream "https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}.git"
git remote add dest "https://x-access-token:${GH_TOKEN}@github.com/${DEST_REPO}.git"

git fetch upstream --prune --tags '+refs/heads/*:refs/remotes/upstream/*'
git fetch dest --prune '+refs/heads/*:refs/remotes/dest/*'

UPSTREAM_URL="https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}"
DEST_URL="https://github.com/${DEST_REPO}"

DEST_OWNER="${DEST_REPO%%/*}"

fork_default="$(git symbolic-ref --short refs/remotes/dest/HEAD 2>/dev/null | sed 's#^dest/##' || true)"
if [[ -z "${fork_default}" ]]; then
  fork_default="main"
fi

failed=0
mapfile -t UP_BRANCHES < <(git for-each-ref --format='%(refname:strip=3)' refs/remotes/upstream)

declare -A DEST_BRANCH_SHA
while read -r sha ref; do
  b="${ref#refs/heads/}"
  DEST_BRANCH_SHA["$b"]="$sha"
done < <(git ls-remote --heads dest)

for b in "${UP_BRANCHES[@]}"; do
  if [[ -n "${EXCLUDE_BRANCH}" && "$b" == "${EXCLUDE_BRANCH}" ]]; then
    echo "Skipping excluded branch: $b"
    continue
  fi

  up_ref="refs/remotes/upstream/$b"
  dst_ref="refs/remotes/dest/$b"

  up_sha="$(git rev-parse "$up_ref")"
  dst_sha="${DEST_BRANCH_SHA[$b]:-}"

  if [[ "$up_sha" == "$dst_sha" ]]; then
    echo "Branch unchanged, skipping: $b"
    continue
  fi

  if [[ -n "$dst_sha" ]]; then
    base_ref="${b}"
  else
    base_ref="${fork_default}"
  fi
  compare_url="${UPSTREAM_URL}/compare/${DEST_OWNER}:${base_ref}...${b}?expand=1"

  if [[ -n "$dst_sha" ]]; then
    commit_list="$(git rev-list --reverse "${dst_ref}..${up_ref}" 2>/dev/null || true)"
  else
    commit_list="$(git rev-list --reverse -n 20 "${up_ref}" 2>/dev/null || true)"
  fi

  if [[ "${SKIP_WORKFLOW_CHANGES}" == "true" && -n "$dst_sha" && "$b" != "main" ]]; then
    if git diff --name-only "${dst_ref}..${up_ref}" | grep -q '^.github/workflows/'; then
      echo "::warning title=Skipped branch (workflow changes detected)::Branch '${b}' includes changes under .github/workflows. Compare: ${compare_url}"
      echo "Commits that would be applied to ${DEST_REPO}:${b}:"
      while read -r sha; do
        [[ -z "$sha" ]] && continue
        echo " - ${UPSTREAM_URL}/commit/${sha}"
      done <<< "${commit_list}"
      continue
    fi
  fi

  echo "Branch changed, pushing: $b (${dst_sha:-<none>} -> $up_sha)"
  if ! git push dest "+${up_ref}:refs/heads/${b}"; then
    echo "::error title=Push rejected::Failed pushing branch '${b}'. Compare: ${compare_url}"
    failed=1
  else
    echo "Commits applied to ${DEST_REPO}:${b}:"
    while read -r sha; do
      [[ -z "$sha" ]] && continue
      echo " - ${UPSTREAM_URL}/commit/${sha}"
    done <<< "${commit_list}"
  fi
done

if [[ "${PRUNE_DELETIONS}" == "true" ]]; then
  UP_SET=" ${UP_BRANCHES[*]} "
  while read -r _ ref; do
    b="${ref#refs/heads/}"

    # ✅ Don't delete the syncer/default branch
    if [[ "$b" == "${EXCLUDE_BRANCH}" ]]; then
      echo "Skipping prune for excluded branch: $b"
      continue
    fi

    if [[ "$UP_SET" != *" $b "* ]]; then
      echo "Upstream deleted branch, deleting in dest: $b"
      if ! git push dest ":refs/heads/$b"; then
        echo "::error title=Branch delete failed::Failed deleting dest branch '${b}'"
        failed=1
      fi
    fi
  done < <(git ls-remote --heads dest)
fi

git push dest +refs/tags/*:refs/tags/* --prune || failed=1

exit $failed
