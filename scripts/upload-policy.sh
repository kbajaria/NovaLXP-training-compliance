#!/usr/bin/env bash
# upload-policy.sh — Convert policy markdown to PDF and upload to S3.
#
# Usage:
#   scripts/upload-policy.sh --profile finova-sso [--region eu-west-2]
#
# Requirements:
#   - Pandoc + a LaTeX engine (e.g., wkhtmltopdf, or: brew install pandoc)
#     OR: print the policy markdown to PDF from a browser/editor manually
#   - The CloudFormation stack must already be deployed (to know the bucket name)
#
# If you don't have Pandoc, convert policy/finova-mandatory-training-policy.md
# to PDF manually (e.g., open in VS Code + Markdown PDF extension, or print
# from a browser) and run:
#   aws s3 cp /path/to/finova-mandatory-training-policy.pdf \
#     s3://<bucket-name>/policy/mandatory-training-policy.pdf

set -euo pipefail

PROFILE=""
REGION="eu-west-2"
STACK_NAME="novalxp-training-compliance"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)    PROFILE="$2";    shift 2 ;;
    --region)     REGION="$2";     shift 2 ;;
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$PROFILE" ]] || { echo "Usage: $0 --profile PROFILE [options]" >&2; exit 1; }

AWS="AWS_PROFILE=${PROFILE} aws --region ${REGION}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_MD="${ROOT_DIR}/policy/finova-mandatory-training-policy.md"
POLICY_PDF="/tmp/mandatory-training-policy.pdf"
S3_KEY="policy/mandatory-training-policy.pdf"

# Get bucket name from CloudFormation outputs
echo "[upload] Looking up S3 policy bucket name from stack: ${STACK_NAME}..."
BUCKET=$(eval "${AWS} cloudformation describe-stacks \
  --stack-name '${STACK_NAME}' \
  --query 'Stacks[0].Outputs[?OutputKey==\`PolicyBucketName\`].OutputValue' \
  --output text")

[[ -n "${BUCKET}" ]] || { echo "Could not determine bucket name from stack outputs." >&2; exit 1; }
echo "[upload] Bucket: ${BUCKET}"

# Convert markdown to PDF
if command -v pandoc &>/dev/null; then
  echo "[upload] Converting markdown to PDF with pandoc..."
  pandoc "${POLICY_MD}" -o "${POLICY_PDF}" \
    --pdf-engine=wkhtmltopdf \
    --margin-top=25mm --margin-bottom=25mm \
    --margin-left=20mm --margin-right=20mm \
    2>/dev/null || \
  pandoc "${POLICY_MD}" -o "${POLICY_PDF}" 2>/dev/null || {
    echo "[upload] Pandoc PDF conversion failed. Please convert manually."
    echo "  Source: ${POLICY_MD}"
    echo "  Then run: aws s3 cp /path/to/policy.pdf s3://${BUCKET}/${S3_KEY}"
    exit 1
  }
else
  echo "[upload] Pandoc not found. Please convert the policy markdown to PDF manually:"
  echo "  Source:  ${POLICY_MD}"
  echo "  Upload:  aws --profile ${PROFILE} s3 cp /path/to/policy.pdf s3://${BUCKET}/${S3_KEY}"
  exit 1
fi

# Upload to S3
echo "[upload] Uploading policy PDF to s3://${BUCKET}/${S3_KEY}..."
eval "${AWS} s3 cp '${POLICY_PDF}' 's3://${BUCKET}/${S3_KEY}' \
  --content-type application/pdf \
  --metadata 'source=finova-mandatory-training-policy.md'"

echo "[upload] Done. Policy PDF is live."
echo "[upload] The next compliance run will automatically use this policy version."
