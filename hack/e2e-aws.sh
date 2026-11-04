#!/usr/bin/env bash
# The small app on AWS itself, once a month (.github/workflows/aws.yml): examples/orders-app's template.yaml deployed
# with `sam deploy` as it is, then checked there for what FF reads and leaves to AWS: each function's role, from its
# Policies; the queue's mapping; the function URL and its CORS; the page's bucket policy. Then the stack is deleted,
# its buckets emptied first. No database or cache is made, so the orders' own paths aren't called: a receipt is, as
# the queue's reader writes it and the API reads it back. hack/cli-e2e.sh makes the same checks of the page and the
# CORS on FF (hack/lib/orders-app.sh). AWS's credentials and region are the environment's: the workflow's role, by
# GitHub's OIDC, and AWS_REGION. Within AWS's free tier: a few calls of three functions, a queue, two buckets and a
# rule; the SAM CLI's own bucket for the code, which `sam deploy --resolve-s3` makes once, is kept between runs.
#   hack/e2e-aws.sh
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sam="$repo/hack/bin/sam"
work="$(mktemp -d)"
source "$repo/hack/lib/checks.sh"
source "$repo/hack/lib/orders-app.sh"
export SAM_CLI_TELEMETRY=0 AWS_PAGER=""
[ -x "$sam" ] || fail "the SAM CLI, which hack/install-tools.sh sam installs in hack/bin"
command -v aws >/dev/null || fail "the AWS CLI"
[ -n "${AWS_REGION:-}" ] || fail "the region to deploy in, AWS_REGION"
aws sts get-caller-identity >/dev/null || fail "AWS's credentials, in the environment"

# Names of this run's own: a bucket's name is unique across S3.
run="${GITHUB_RUN_ID:-$(date +%s)}"
stack="ff-monthly-$run"
receipts="ff-monthly-receipts-$run"
site="ff-monthly-site-$run"
app="$work/examples/orders-app"

# The stack and its buckets go at exit, whatever stopped the run; a bucket with files stops CloudFormation's deletion.
# Each function's log group, which Lambda makes at its first call and the stack doesn't hold, goes with them.
remove_stack() {
  local code=0
  if aws cloudformation describe-stacks --stack-name "$stack" >/dev/null 2>&1; then
    aws s3 rm "s3://$receipts" --recursive --only-show-errors 2>/dev/null || true
    aws s3 rm "s3://$site" --recursive --only-show-errors 2>/dev/null || true
    "$sam" delete --stack-name "$stack" --region "$AWS_REGION" --no-prompts >"$work/delete.log" 2>&1 || code=$?
  fi
  for function in api receipts nightly; do
    aws logs delete-log-group --log-group-name "/aws/lambda/$stack-$function" 2>/dev/null || true
  done
  return "$code"
}
on_exit 'remove_stack; rm -rf "$work"'

# <the page's origin>: the template deployed as it is, the run's names its parameters.
deploy() {
  (cd "$app" && "$sam" deploy --template-file template.yaml --stack-name "$stack" --region "$AWS_REGION" --resolve-s3 \
    --capabilities CAPABILITY_IAM --no-confirm-changeset --no-fail-on-empty-changeset \
    --parameter-overrides "ReceiptsBucketName=$receipts SiteBucketName=$site SiteOrigin=$1") >"$work/deploy.log" 2>&1
}
output() { # <the output's name>
  aws cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

section "the small app's template, deployed on AWS with sam deploy as it is"
# The files the repository keeps, its libraries installed as Lambda runs them; samconfig.toml left out, its values
# FF's development's.
(cd "$repo" && git ls-files -z examples/orders-app | xargs -0 cp --parents -t "$work")
rm -f "$app/samconfig.toml"
(cd "$app" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
code=0
deploy "https://example.com" || code=$?
check "deployed as a stack of its own: its functions, URL, queue, mapping, schedule and buckets" "0" "$code"
[ "$code" = 0 ] || { sed 's/^/       /' "$work/deploy.log"; fail "the stack, which every check after needs"; }
page="$(output OrdersPage)"
# The page's address is known once its bucket is made: a second deploy lets it in, the CORS's one change.
code=0
deploy "$page" || code=$?
check "deployed again, the page's address the URL's CORS lets in, which the first deploy told" "0" "$code"
[ "$code" = 0 ] || sed 's/^/       /' "$work/deploy.log"
api="$(output OrdersApi | sed 's:/$::')"
queue="$(output NewOrdersQueue)"

section "the app on AWS: its page, its URL's CORS, a receipt through the queue"
printf '{"api": "%s"}\n' "$api" >"$app/site/config.json"
code=0
aws s3 sync "$app/site" "s3://$site" --only-show-errors || code=$?
check "the app's page synced to its bucket, which its bucket policy makes public" "0" "$code"
orders_page_check "$page" "$api" "$work/page.html"
orders_cors_check "$api" "$page"
# An order as the API sends it, put in the queue: the mapping hands it to the receipts' function, whose role writes
# to the bucket; the API's role reads it back. A new mapping can take a minute to start reading.
aws sqs send-message --queue-url "$queue" --message-body \
  "$(jq -cn --arg at "$(date -u +%FT%TZ)" '{id: 1, item: "harissa", quantity: 2, email: null, created_at: $at}')" >/dev/null
read_receipt() { curl -s -o "$work/receipt.txt" -w '%{http_code}' "$api/orders/1/receipt"; }
for _ in $(seq 36); do
  [ "$(read_receipt)" = 200 ] && break
  sleep 5
done
check "an order put in the queue: its receipt written by the queue's reader, then read back at the URL" "200 Order 1" \
  "$(read_receipt) $(head -1 "$work/receipt.txt")"

section "the stack deleted, its buckets emptied first"
# A deletion that fails is said by the check; the exit tries it again.
remove_stack || sed 's/^/       /' "$work/delete.log"
check "the stack is gone, its buckets with it" "false false" \
  "$(aws cloudformation describe-stacks --stack-name "$stack" >/dev/null 2>&1 && echo true || echo false) $(aws s3api head-bucket --bucket "$receipts" >/dev/null 2>&1 && echo true || echo false)"
checks_done aws
