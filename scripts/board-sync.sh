#!/usr/bin/env bash
# Add every open issue in ylove/snapwing to the "Snapwing build" project board.
# Needs a gh token with the `project` scope. Idempotent: adding an existing item is a no-op.
set -euo pipefail
PROJECT_ID="${PROJECT_ID:-PVT_kwHOACa_fs4BlZ29}"
REPO="${REPO:-ylove/snapwing}"
gh issue list -R "$REPO" --state open --limit 500 --json id --jq '.[].id' | while read -r id; do
  gh api graphql -f query='mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}' \
    -f p="$PROJECT_ID" -f c="$id" --silent
done
echo "board-sync: done"
