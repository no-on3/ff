#!/usr/bin/env bash
# The latest release of each AWS tool the tests pin, for the nightly's tools job (hack/ci.sh tools), as the variables
# hack/install-tools.sh and hack/spikes/lambda/run.sh take: one NAME=value line each, the SAM CLI's checksum for this
# machine from its release's notes. Each from where its project publishes it: Docker Hub's tags for the AWS CLI's
# image, npm and PyPI for the SDKs, GitHub's releases for OpenTofu and the SAM CLI, HashiCorp's for Terraform and the
# registry for its AWS provider.
#   GH_TOKEN            for gh, GitHub's releases
#   hack/lib/latest-tools.sh
set -euo pipefail
fetch() { curl -fsSL --retry 3 "$1"; }

# The AWS CLI v2's newest image: its tags name each release, beside latest and the architectures'.
aws_cli="$(fetch 'https://hub.docker.com/v2/repositories/amazon/aws-cli/tags?page_size=100&ordering=last_updated' |
  jq -r '.results[].name | select(test("^2\\.[0-9]+\\.[0-9]+$"))' | sort -V | tail -1)"
sdk="$(npm view @aws-sdk/client-lambda version)"
boto3="$(fetch https://pypi.org/pypi/boto3/json | jq -r .info.version)"
tofu="$(gh api repos/opentofu/opentofu/releases/latest --jq .tag_name)"
terraform="$(fetch https://checkpoint-api.hashicorp.com/v1/check/terraform | jq -r .current_version)"
provider="$(fetch https://registry.terraform.io/v1/providers/hashicorp/aws | jq -r .version)"
sam_release="$(gh api repos/aws/aws-sam-cli/releases/latest)"
case "$(uname -m)" in x86_64 | amd64) sam_arch=x86_64 ;; *) sam_arch=arm64 ;; esac
# The notes' table: **aws-sam-cli-linux-x86_64.zip** | `<sha256>`
sam_sha256="$(jq -r .body <<<"$sam_release" | sed -n "s/^\*\*aws-sam-cli-linux-$sam_arch\.zip\*\* *| *\`\([0-9a-f]\{64\}\)\`.*/\1/p" | head -1)"

for value in "$aws_cli" "$sdk" "$boto3" "$tofu" "$terraform" "$provider" "$sam_sha256"; do
  [ -n "$value" ] && [ "$value" != null ] || { echo "a latest release was not found: the AWS CLI '$aws_cli', the SDK '$sdk', boto3 '$boto3', OpenTofu '$tofu', Terraform '$terraform', its provider '$provider', the SAM CLI's checksum '$sam_sha256'" >&2; exit 1; }
done
cat <<EOF
AWS_CLI_VERSION=$aws_cli
SDK_VERSION=$sdk
BOTO3_VERSION=$boto3
TOFU_VERSION=${tofu#v}
TERRAFORM_VERSION=$terraform
AWS_PROVIDER_VERSION=$provider
SAM_VERSION=$(jq -r '.tag_name | ltrimstr("v")' <<<"$sam_release")
SAM_SHA256=$sam_sha256
EOF
