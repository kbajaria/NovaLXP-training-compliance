#!/usr/bin/env bash
# deploy.sh — Build and deploy the compliance Lambda function.
#
# Usage:
#   scripts/deploy.sh --profile finova-sso [--region eu-west-2] [--stack-name novalxp-training-compliance]
#
# First-time deploy (creates the CloudFormation stack):
#   scripts/deploy.sh --profile finova-sso --create-stack --alert-email kamila.bajaria@finova.tech
#
# After creating the stack you must:
#   1. Update the BambooHR secret in Secrets Manager with the real API key
#   2. Update the Moodle secret in Secrets Manager with the real Moodle token
#   3. Upload the policy PDF: scripts/upload-policy.sh --profile finova-sso

set -euo pipefail

PROFILE=""
REGION="eu-west-2"
STACK_NAME="novalxp-training-compliance"
FUNCTION_NAME="${STACK_NAME}"
CREATE_STACK=false
ALERT_EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)      PROFILE="$2";      shift 2 ;;
    --region)       REGION="$2";       shift 2 ;;
    --stack-name)   STACK_NAME="$2";   FUNCTION_NAME="${STACK_NAME}"; shift 2 ;;
    --create-stack) CREATE_STACK=true; shift ;;
    --alert-email)  ALERT_EMAIL="$2";  shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$PROFILE" ]] || { echo "Usage: $0 --profile PROFILE [options]" >&2; exit 1; }

AWS="AWS_PROFILE=${PROFILE} aws --region ${REGION}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAMBDA_DIR="${ROOT_DIR}/lambda"
BUILD_DIR="${LAMBDA_DIR}/.build"
ZIP_FILE="${BUILD_DIR}/function.zip"

# ── Build ──────────────────────────────────────────────────────────────────────
echo "[build] Cleaning build directory..."
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

echo "[build] Copying function source..."
cp "${LAMBDA_DIR}"/*.mjs "${BUILD_DIR}/"
cp "${LAMBDA_DIR}/package.json" "${BUILD_DIR}/"

echo "[build] Installing dependencies..."
(cd "${BUILD_DIR}" && npm install --omit=dev 2>&1 | tail -5)

echo "[build] Creating deployment package..."
(cd "${BUILD_DIR}" && zip -qr "${ZIP_FILE}" .)

ZIP_SIZE=$(du -sh "${ZIP_FILE}" | cut -f1)
echo "[build] Package size: ${ZIP_SIZE}"

# ── Create stack (first-time only) ────────────────────────────────────────────
if [[ "${CREATE_STACK}" == "true" ]]; then
  [[ -n "${ALERT_EMAIL}" ]] || { echo "--alert-email is required with --create-stack" >&2; exit 1; }

  echo "[stack] Creating CloudFormation stack: ${STACK_NAME}..."
  eval "${AWS} cloudformation create-stack \
    --stack-name '${STACK_NAME}' \
    --template-body file://${ROOT_DIR}/infra/template.yaml \
    --parameters \
      ParameterKey=ProjectName,ParameterValue='${STACK_NAME}' \
      ParameterKey=AlertEmail,ParameterValue='${ALERT_EMAIL}' \
    --capabilities CAPABILITY_NAMED_IAM \
    --output table"

  echo "[stack] Waiting for stack creation to complete..."
  eval "${AWS} cloudformation wait stack-create-complete --stack-name '${STACK_NAME}'"
  echo "[stack] Stack created."
fi

# ── Deploy Lambda code ─────────────────────────────────────────────────────────
echo "[deploy] Uploading Lambda code to: ${FUNCTION_NAME}..."
eval "${AWS} lambda update-function-code \
  --function-name '${FUNCTION_NAME}' \
  --zip-file 'fileb://${ZIP_FILE}' \
  --query '{FunctionName:FunctionName,CodeSize:CodeSize,LastModified:LastModified}' \
  --output table"

echo "[deploy] Waiting for update to propagate..."
eval "${AWS} lambda wait function-updated \
  --function-name '${FUNCTION_NAME}'"

echo "[deploy] Done. ${FUNCTION_NAME} is deployed and ready."
echo ""
echo "Next steps:"
echo "  1. Upload the policy PDF:  scripts/upload-policy.sh --profile ${PROFILE}"
echo "  2. Update BambooHR secret: aws secretsmanager put-secret-value ..."
echo "  3. Update Moodle secret:   aws secretsmanager put-secret-value ..."
echo "  4. Test with dry run:      aws lambda invoke --function-name ${FUNCTION_NAME}"
echo "                               --payload '{\"dryRun\":true}' /tmp/out.json"
