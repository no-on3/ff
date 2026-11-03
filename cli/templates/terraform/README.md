# {{name}}

An app as Terraform describes one, for FF: four modules in `modules/`, each written to apply on FF and, with only
`providers.tf` changed, on AWS. `main.tf` uses each once:

- `modules/function`, the API: a function zipped from `src/`, published at each change of its code, its alias
  `live` moved to the new version, a URL anyone may call on that alias, and the settings of its asynchronous calls;
- `modules/queue-worker`, the jobs: a queue, its dead-letter queue, and a function that reads the queue in batches;
- `modules/bucket-function`, the uploads: a bucket whose new files each run a function, with the permission S3
  needs to call it;
- `modules/site`, the site: `site/`'s files in a bucket with a website configuration, public to read.

The code, in {{language}}, is in `src/`: `api`, `worker` and `uploads`, one file each.

## On FF

`providers.tf` holds FF's region and endpoints, as `ff init` read them. Terraform's AWS provider takes a key of the
account's, as it takes one of AWS's. A key reaches what it names alone, as an IAM policy does: this one names the
project's three functions, at write access, its two buckets and its two queues, before they are made. A function,
bucket or queue added to `main.tf` needs a key that names it too.

```sh
{{key}}
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…           # the two it printed
tofu init && tofu apply                        # or terraform init && terraform apply
tofu plan                                      # nothing to change
curl "$(tofu output -raw api_url)"
ff sites get {{name}}-site                     # the site's address
```

A bucket's name is once across FF, as it is across S3: change `{{name}}-uploads` and `{{name}}-site` in
`main.tf` if one is taken. `destroy` removes everything, but a bucket that holds files is refused, as S3 refuses
it: empty the uploads' bucket first (`aws s3 rm s3://{{name}}-uploads --recursive`); the site's files are
Terraform's own and go with it.

What FF keeps without effect, for the move to AWS: each function's role (FF has no IAM: a function's own key stands
for it), the permissions that let S3 and anyone with the URL call a function, and the site's bucket policy and
public access block (on FF the website configuration alone makes a bucket public).

## On AWS

In `providers.tf`: set an AWS region, remove the lines between the two "FF" comments, and set `function_role` to
`null`, so that each module makes its function's role. Then `terraform apply` with an AWS account's key. Nothing
else changes.
