# {{name}}

Thumbnails, in {{language}}: each image put in the bucket under `uploads/` makes its thumbnail under `thumbnails/`, at the same path with the extension `.webp`, a WebP of 200 pixels at most each way, its proportions kept, turned as the camera says it was held and never made larger. A file that is no image is left, its reason in the log. The same folder runs here with `ff local start`, on FF with `ff deploy --container`, and on AWS with `sam deploy`.

`src/` is the function's code, `CodeUri` in `template.yaml`: `src/app.{{extension}}` makes the thumbnails, `SIZE` pixels at most each way, with an image library whose code is native, sharp in JavaScript and Pillow in Python, so built for Linux x86_64, as FF and AWS Lambda run it. `tests/` tries it with stand-ins for the bucket and the library, `events/upload.json` is the event a bucket sends for an upload, S3's, and `samconfig.toml` names the stack, `{{name}}`.

The bucket is `{{name}}-images-<account>`, named after the stack and the account, as the function's policy names it for AWS: a bucket's name is lowercase, so the stack's is too.

## Here

```bash
{{install}}
{{test}}# the thumbnails' tests, no bucket and no image library needed
ff local start template.yaml                     # the function and its bucket, {{name}}-images-000000000000
curl -T photo.jpg http://127.0.0.1:3700/{{name}}-images-000000000000/uploads/photo.jpg   # an image of yours
curl --fail --retry 30 --retry-delay 1 --retry-all-errors -o photo.webp \
  http://127.0.0.1:3700/{{name}}-images-000000000000/thumbnails/photo.webp                 # its thumbnail, once made
```

The bucket's files are kept in `.ff/local/buckets/{{name}}-images-000000000000/` from a start to the next; `ff local reset` removes them. The AWS CLI reaches the bucket at `http://127.0.0.1:3700` too, with the key `ff local start` prints. The function's log, a line for each thumbnail made or file left, is on `ff local start`'s output.

## On FF

```bash
ff deploy template.yaml --container                # the stack {{name}}: the function and its bucket
bucket=<ImagesBucket>                              # the bucket's name, an output of the deploy
eval "$(ff keys create --bucket "$bucket" | grep '^export ')"      # a key to that bucket, for the AWS CLI
aws s3 cp photo.jpg "s3://$bucket/uploads/photo.jpg"
aws s3api wait object-exists --bucket "$bucket" --key thumbnails/photo.webp       # its thumbnail, once made
aws s3 cp "s3://$bucket/thumbnails/photo.webp" .
ff logs {{name}}-resize                            # each thumbnail made, or file left and why
```

`--container` installs the libraries in a container of the runtime's image, Linux's builds whatever this machine is: it needs Docker, Docker Desktop on macOS and Windows. On Linux x86_64, `ff deploy template.yaml` installs the same without it. `ff delete-stack` deletes the function and the bucket; a bucket that holds files stops it, as it stops CloudFormation: `ff buckets delete "$bucket" --force` deletes it with them, and `ff delete-stack` again the rest.

## On AWS

```bash
sam build && sam deploy --guided                   # the same template, the stack {{name}}
```

`samconfig.toml`'s `use_container` has `sam build` install the libraries in Lambda's own image, through Docker. `Policies` give the function's role the bucket by its name: a `!Ref` to it would make the bucket, which calls the function, and the function, whose role names the bucket, each wait for the other, which CloudFormation refuses.

## The same as on AWS

The template is SAM's, within what FF takes of it; the handler is AWS Lambda's, given S3's event (version 2.1) as a bucket's notification sends it, without waiting, a call that fails tried twice more; the bucket is S3's, reached by AWS's SDK at the endpoint and with the key the function's environment gives, a role's on AWS and the function's own on FF; the image library's native code is Linux x86_64's, the same build on both.
