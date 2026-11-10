# shellcheck shell=bash
# The development realm in Keycloak, as the suites drive it at $keycloak: its admin's token, a customer made as the
# console's sign-up leaves one, and its pages read and posted as a browser does them (L5's sign-up, the ff suite's
# device login). Uses $work for the pages and the cookies.

# keycloak_admin: an access token of the master realm's admin, as the compose file's Keycloak sets it.
keycloak_admin() {
  curl -sS -X POST "$keycloak/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin | jq -r .access_token
}

# keycloak_user <e-mail> <password> <first name>: a customer of the realm, made through the admin API with that
# address, verified, and that password, as the console's sign-up leaves one. Prints the answer's status: 201 when made.
keycloak_user() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$keycloak/admin/realms/ff/users" \
    -H "authorization: Bearer $(keycloak_admin)" -H 'content-type: application/json' \
    -d "$(jq -cn --arg email "$1" --arg password "$2" --arg first "$3" '{username: $email, email: $email,
      emailVerified: true, enabled: true, firstName: $first, lastName: "Test",
      credentials: [{type: "password", value: $password, temporary: false}]}')"
}

# page_form <html file>: the page's first form, however its tags are cut into lines: "action", then each of its inputs
# and buttons as its type, name and value, one a line, the unit separator between them, so that an empty one stays.
# The file is read whole as one record, never through a pipe that could close before its writer is done.
page_form() {
  awk -v RS='\001' -v OFS='\037' '
    function attribute(tag, name,   value) {
      if (!match(tag, "[ \t\n]" name "=\"[^\"]*\"")) return ""
      value = substr(tag, RSTART + length(name) + 3, RLENGTH - length(name) - 4)
      gsub(/&amp;/, "\\&", value)
      return value
    }
    {
      rest = $0
      while (match(rest, /<(form|input|button)[^>]*>/)) {
        tag = substr(rest, RSTART, RLENGTH)
        rest = substr(rest, RSTART + RLENGTH)
        if (tag ~ /^<form/) {
          if (forms++) break
          print "action", attribute(tag, "action")
        } else if (forms) {
          type = attribute(tag, "type")
          if (type == "") type = tag ~ /^<button/ ? "submit" : "text"
          print type, attribute(tag, "name"), attribute(tag, "value")
        }
      }
    }' "$1"
}

# form_action <html file> [page's address]: where the page's first form is posted, an action relative to the page,
# such as Keycloak's consent form's, taken against the page's address as a browser takes it.
form_action() {
  local action page_address="${2:-}"
  action="$(page_form "$1" | awk -F '\037' '$1 == "action" { print $2 }')"
  case $action in
    http://* | https://* | '') ;;
    /*) action="$(sed -E 's#^(https?://[^/]+).*#\1#' <<<"$page_address")$action" ;;
    *) action="${page_address%/*}/$action" ;;
  esac
  echo "$action"
}

# keycloak_approve_device <address> <code> <e-mail> <password>: the user's part of OAuth's device flow at the realm's
# pages, as a browser does it, its cookies kept: the address the device printed opened, then on each page the code
# given when it asks for it, the login form filled, or the device approved with the page's accept button, with the
# page's hidden fields. Every page is asked for as HTML, as a browser asks: the realm's /device takes a form posted to
# it as the user's code only then, and as a device's request for one otherwise. Prints the pages met, as "the login
# form, the device's approval, Device Login Successful".
keycloak_approve_device() {
  local jar="$work/device.jar" page="$work/device.html" form="$work/device.form" met=() data kind type name value joined
  local address
  rm -f "$jar"
  address="$(curl -sS -L -c "$jar" -b "$jar" -H 'accept: text/html' -o "$page" -w '%{url_effective}' "$1")"
  for _ in 1 2 3 4 5; do
    page_form "$page" >"$form"
    if [ ! -s "$form" ]; then
      met+=("$(awk -v RS='\001' 'match($0, /Device Login [A-Z][a-z]+/) { print substr($0, RSTART, RLENGTH) }' "$page")")
      break
    fi
    data=() kind=
    while IFS=$'\037' read -r type name value; do
      case "$type:$name" in
        hidden:*) data+=(--data-urlencode "$name=$value") ;;
        *:device_user_code | *:user_code) data+=(--data-urlencode "$name=$2") kind="the code given" ;;
        *:username) data+=(--data-urlencode "username=$3") kind="the login form" ;;
        *:password) data+=(--data-urlencode "password=$4") ;;
        submit:accept) data+=(--data-urlencode "accept=$value") kind="the device's approval" ;;
      esac
    done < <(tail -n +2 "$form")
    if [ -z "$kind" ]; then
      met+=("a page whose form this test doesn't know, posted to $(form_action "$page" "$address")")
      break
    fi
    met+=("$kind")
    address="$(curl -sS -L -c "$jar" -b "$jar" -H 'accept: text/html' -o "$page" -w '%{url_effective}' "${data[@]}" \
      "$(form_action "$page" "$address")")"
  done
  joined="$(printf '%s, ' "${met[@]}")"
  echo "${joined%, }"
}
