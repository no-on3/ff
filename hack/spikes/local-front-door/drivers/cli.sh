#!/usr/bin/env bash
# The AWS CLI, with its defaults, against one side's front doors: the spike's twelve checks, the same as sdk.mjs's and
# boto3_checks.py's. One JSON line per check, {client, check, passed, detail}.
#   WORK=<a folder of its own> S3_ENDPOINT=… SQS_ENDPOINT=… ACCOUNT=… KEY=… SECRET=… BUCKET=… QUEUE=… cli.sh
set -uo pipefail
prefix=cli/
export AWS_CONFIG_FILE="$WORK/aws-config" AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_ACCESS_KEY_ID="$KEY" \
  AWS_SECRET_ACCESS_KEY="$SECRET" AWS_REGION=tn-tunis-1 AWS_PAGER=
printf '[default]\ns3 =\n  addressing_style = path\n' >"$AWS_CONFIG_FILE"
s3api() { aws --endpoint-url "$S3_ENDPOINT" s3api "$@"; }
sqs() { aws --endpoint-url "$SQS_ENDPOINT" sqs "$@"; }

# check <name> <function>: the function prints what it got and fails when it isn't what it should be. It runs in this
# shell, not a subshell, so that the queue's URL and the receipt it reads reach the next checks.
check() {
  local passed=true
  "$2" >"$WORK/detail" 2>&1 || passed=false
  jq -nc --arg check "$1" --argjson passed "$passed" --rawfile detail "$WORK/detail" '{client: "cli", $check, $passed, detail: $detail[:200]}'
}
# expect <got> <wanted>
expect() {
  [[ $1 == "$2" ]] || { echo "got $1, not $2"; return 1; }
  echo "$1"
}
# refused_as <code> <command…>: the AWS CLI names the error's code in its message.
refused_as() {
  local code=$1 out
  shift
  if out="$("$@" 2>&1)"; then echo "accepted, not refused $code"; return 1; fi
  [[ $out == *"($code)"* ]] || { echo "${out//$'\n'/ }"; return 1; }
  echo "$code"
}

put_and_get() {
  printf Ahlan >"$WORK/hello.txt"
  # Its answer kept, for what each side gives back.
  s3api put-object --bucket "$BUCKET" --key "${prefix}hello é.txt" --body "$WORK/hello.txt" --content-type text/plain --metadata owner=me >"$WORK/put-answer.json" || return 1
  s3api get-object --bucket "$BUCKET" --key "${prefix}hello é.txt" "$WORK/got.txt" >"$WORK/got.json" || return 1
  expect "$(cat "$WORK/got.txt") $(jq -c '[.ContentType, .Metadata]' "$WORK/got.json")" 'Ahlan ["text/plain",{"owner":"me"}]'
}
big() {
  head -c $((5 * 1024 * 1024)) /dev/zero | tr '\0' '\7' >"$WORK/big.bin"
  s3api put-object --bucket "$BUCKET" --key "${prefix}big.bin" --body "$WORK/big.bin" >/dev/null || return 1
  s3api get-object --bucket "$BUCKET" --key "${prefix}big.bin" "$WORK/big-got.bin" >/dev/null || return 1
  expect "$(sha256sum <"$WORK/big-got.bin")" "$(sha256sum <"$WORK/big.bin")"
}
range() {
  s3api get-object --bucket "$BUCKET" --key "${prefix}hello é.txt" --range bytes=0-2 "$WORK/range.txt" >/dev/null || return 1
  expect "$(cat "$WORK/range.txt")" Ahl
}
listed() {
  local key token='' keys=()
  for key in a/1 a/2 b c; do
    s3api put-object --bucket "$BUCKET" --key "${prefix}list/$key" --body "$WORK/hello.txt" >/dev/null || return 1
  done
  expect "$(s3api list-objects-v2 --bucket "$BUCKET" --prefix "${prefix}list/" --delimiter / | jq -c '[[.CommonPrefixes[].Prefix], [.Contents[].Key]]')" \
    "[[\"${prefix}list/a/\"],[\"${prefix}list/b\",\"${prefix}list/c\"]]" >/dev/null || return 1
  # The CLI's own paging, --max-items with --page-size, follows each continuation token itself.
  expect "$(s3api list-objects-v2 --bucket "$BUCKET" --prefix "${prefix}list/" --page-size 3 | jq -c --arg cut "${prefix}list/" '[.Contents[].Key | ltrimstr($cut)]')" \
    '["a/1","a/2","b","c"]'
}
missing() { refused_as NoSuchKey s3api get-object --bucket "$BUCKET" --key "${prefix}nothing" "$WORK/nothing"; }
s3_wrong_secret() {
  AWS_SECRET_ACCESS_KEY=wrong-secret refused_as SignatureDoesNotMatch s3api get-object --bucket "$BUCKET" --key "${prefix}hello é.txt" "$WORK/nothing"
}

queue_url() {
  url="$(sqs get-queue-url --queue-name "$QUEUE" --query QueueUrl --output text)" || return 1
  expect "$url" "$SQS_ENDPOINT/$ACCOUNT/$QUEUE"
}
send_and_receive() {
  sqs send-message --queue-url "$url" --message-body 'مرحبا' --message-attributes \
    '{"city": {"DataType": "String", "StringValue": "تونس"}, "count": {"DataType": "Number", "StringValue": "12"}, "raw": {"DataType": "Binary", "BinaryValue": "AAEC/w=="}}' >/dev/null || return 1
  sqs receive-message --queue-url "$url" --message-attribute-names All --message-system-attribute-names All --wait-time-seconds 1 >"$WORK/received.json" || return 1
  handle="$(jq -r '.Messages[0].ReceiptHandle' "$WORK/received.json")"
  expect "$(jq -c '.Messages[0] | [.Body, .MessageAttributes.city.StringValue, .MessageAttributes.count.StringValue, .MessageAttributes.raw.BinaryValue, .Attributes.ApproximateReceiveCount]' "$WORK/received.json")" \
    '["مرحبا","تونس","12","AAEC/w==","1"]'
}
delete_then_empty() {
  sqs delete-message --queue-url "$url" --receipt-handle "$handle" || return 1
  local started=$EPOCHREALTIME answer
  answer="$(sqs receive-message --queue-url "$url" --wait-time-seconds 1)" || return 1
  expect "${answer:-none} $(( (${EPOCHREALTIME/./} - ${started/./}) >= 900000 ))" 'none 1'
}
long_poll_ended() {
  local started=$EPOCHREALTIME poll
  sqs receive-message --queue-url "$url" --wait-time-seconds 10 >"$WORK/polled.json" &
  poll=$!
  sleep 0.3
  sqs send-message --queue-url "$url" --message-body during >/dev/null || return 1
  wait "$poll" || return 1
  sqs delete-message --queue-url "$url" --receipt-handle "$(jq -r '.Messages[0].ReceiptHandle' "$WORK/polled.json")" || return 1
  expect "$(jq -r '.Messages[0].Body' "$WORK/polled.json") $(( (${EPOCHREALTIME/./} - ${started/./}) < 3000000 ))" 'during 1'
}
no_queue() { refused_as AWS.SimpleQueueService.NonExistentQueue sqs get-queue-url --queue-name nowhere; }
sqs_wrong_secret() { AWS_SECRET_ACCESS_KEY=wrong-secret refused_as SignatureDoesNotMatch sqs get-queue-url --queue-name "$QUEUE"; }

url='' handle=''
check 'put and get, with its type and metadata' put_and_get
check 'put 5 MB as a stream, aws-chunked with a trailing checksum, and get the same bytes' big
check 'get a range' range
check 'list by a prefix and a delimiter, then page by page' listed
check 'a missing key: NoSuchKey' missing
check 'S3 with a wrong secret: SignatureDoesNotMatch' s3_wrong_secret
check "GetQueueUrl: the queue's URL under the endpoint and the account" queue_url
check 'send with attributes of each type and Arabic text; receive them back, the SDK checking the MD5 sums' send_and_receive
check 'delete it, then an empty queue answers after its wait' delete_then_empty
check 'a message sent during a long poll ends it at once' long_poll_ended
check 'a queue that is not there: QueueDoesNotExist' no_queue
check 'SQS with a wrong secret: SignatureDoesNotMatch' sqs_wrong_secret
