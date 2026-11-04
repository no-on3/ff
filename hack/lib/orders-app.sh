# The small app's checks that hold on FF and on AWS alike, made from outside as a browser makes them: its page at its
# site, with the API's address beside it, and its function URL's CORS for the page's origin. hack/cli-e2e.sh checks
# the app on FF with them, hack/e2e-aws.sh on AWS itself. Sourced after hack/lib/checks.sh, whose check they call.

# <the page's address> <the API's address> <a file for the page>: the page, its title, and its config.json naming
# the API.
orders_page_check() {
  check "  ... a browser gets the page, and the API's address beside it" "200 Orders $2" \
    "$(curl -s -o "$3" -w '%{http_code}' "$1/") $(sed -n 's:.*<title>\(.*\)</title>.*:\1:p' "$3") $(curl -s "$1/config.json" | jq -r .api)"
}

# <the API's address> <the page's origin>: a browser's preflight for the page's POST, let in.
orders_cors_check() {
  check "  ... and the function URL lets the page's origin in, as the template's CORS says and a browser's preflight asks" "$2" \
    "$(curl -s -o /dev/null -D - -X OPTIONS "$1/orders" -H "Origin: $2" -H 'Access-Control-Request-Method: POST' \
      -H 'Access-Control-Request-Headers: content-type' | tr -d '\r' | sed -n 's/^access-control-allow-origin: //Ip')"
}
