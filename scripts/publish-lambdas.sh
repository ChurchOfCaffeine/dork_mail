#!/usr/bin/env bash
# Builds Lambda functions and deploys them via aws lambda update-function-code.
# Terraform manages configuration; this script manages code.
#
# Usage:
#   scripts/publish-lambdas.sh [aws-region]
#
# Region defaults to the Terraform variable aws_region (us-east-1 if not set).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${1:-us-east-1}"
NAME_PREFIX="dork-mail"

echo "==> Building Lambda functions..."
cd "$REPO_ROOT"
pnpm build:functions

echo "==> Deploying to region ${REGION}..."

declare -A FUNCTIONS=(
  ["${NAME_PREFIX}-email-ingest"]="functions/dist-zip/email-ingest.zip"
  ["${NAME_PREFIX}-authorizer"]="functions/dist-zip/authorizer.zip"
  ["${NAME_PREFIX}-api-auth"]="functions/dist-zip/api-auth.zip"
  ["${NAME_PREFIX}-api-mail"]="functions/dist-zip/api-mail.zip"
  ["${NAME_PREFIX}-api-dns"]="functions/dist-zip/api-dns.zip"
)

for fn in "${!FUNCTIONS[@]}"; do
  zip="$REPO_ROOT/${FUNCTIONS[$fn]}"
  echo "  updating ${fn}..."
  aws lambda update-function-code \
    --function-name "$fn" \
    --zip-file "fileb://${zip}" \
    --region "$REGION" \
    --output json | jq -r '"    → \(.FunctionName) \(.CodeSize) bytes, \(.LastModified)"'
done

echo ""
echo "Done. All functions updated."
