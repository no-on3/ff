"""The user's part of the device flow, as a browser does it: Keycloak's device page opened at the address ff prints, the
code given when the page asks for it, the login form filled, and the grant approved or denied. Python's standard
library alone: cookies kept, each page's first form read and sent with the button pressed. Prints each page's title
and what was done on it, then the last page's message.
  python3 -I browser.py <verification address, complete or not> <user code> <username> <password> approve|deny
"""

import html
import http.cookiejar
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser


class LocalhostIsSecure(http.cookiejar.DefaultCookiePolicy):
    """Keycloak's cookies are Secure, even over http: browsers send them to localhost all the same, which they hold to
    be a secure context, and so does this one; Python's jar would send them over https alone."""

    def return_ok_secure(self, cookie, request):
        host = urllib.parse.urlsplit(request.get_full_url()).hostname
        return host in ("localhost", "127.0.0.1") or super().return_ok_secure(cookie, request)


class Page(HTMLParser):
    """A page's title, its first form's action, inputs and submit buttons, and its text, for the message."""

    def __init__(self):
        super().__init__()
        self.title, self.action, self.inputs, self.buttons, self.text = "", None, {}, [], []
        self._in_title = self._in_form = self._in_code = False
        self._forms = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self._in_title = True
        elif tag in ("script", "style"):
            self._in_code = True
        elif tag == "form":
            self._forms += 1
            if self._forms == 1:
                self._in_form, self.action = True, html.unescape(a.get("action") or "")
        elif self._in_form and tag in ("input", "button"):
            kind = (a.get("type") or ("submit" if tag == "button" else "text")).lower()
            if kind == "submit":
                if a.get("name"):
                    self.buttons.append((a["name"], a.get("value") or ""))
            elif a.get("name"):
                self.inputs[a["name"]] = a.get("value") or ""

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag in ("script", "style"):
            self._in_code = False
        elif tag == "form":
            self._in_form = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data.strip()
        elif data.strip() and not self._in_code:
            self.text.append(data.strip())


def main():
    address, user_code, username, password, choice = sys.argv[1:6]
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar(LocalhostIsSecure()))
    )
    # HTML asked for, as a browser asks: Keycloak's /device answers a form posted to it as the user's code when the
    # client accepts HTML, and as a device's request for a code, refused without its client, when it doesn't.
    opener.addheaders = [("Accept", "text/html,application/xhtml+xml"), ("User-Agent", "ff-device-flow-spike")]

    def open_page(url, data=None):
        # A page answered 4xx is still a page to read, as a browser shows it.
        try:
            return opener.open(url, data)
        except urllib.error.HTTPError as error:
            return error

    response = open_page(address)
    for _ in range(8):
        page = Page()
        page.feed(response.read().decode("utf-8", "replace"))
        url = response.geturl()
        if page.action is None:
            message = " ".join(t for t in page.text if not t.startswith(("{", "<")))[:300]
            print(f"{page.title}: {message}")
            return
        fields = dict(page.inputs)
        button = None
        if "user_code" in fields or "device_user_code" in fields:
            fields["user_code" if "user_code" in fields else "device_user_code"] = user_code
            done = "the code given"
        elif "username" in fields or "password" in fields:
            fields.update(username=username, password=password)
            fields.pop("rememberMe", None)
            done = "logged in"
        else:
            # The grant: the button whose name says yes or no.
            wanted = ("accept", "yes", "approve") if choice == "approve" else ("cancel", "no", "deny")
            button = next((b for b in page.buttons if b[0].lower() in wanted), None)
            if button is None:
                print(f"{page.title}: no {choice} button among {page.buttons}")
                sys.exit(1)
            done = f"{'approved' if choice == 'approve' else 'denied'} with the {button[0]} button"
        if button is None and page.buttons and not done.startswith("logged"):
            button = page.buttons[0]
        if button:
            fields[button[0]] = button[1]
        print(f"{page.title}: {done}")
        data = urllib.parse.urlencode(fields).encode()
        response = open_page(urllib.parse.urljoin(url, page.action), data)
    print("too many pages")
    sys.exit(1)


if __name__ == "__main__":
    main()
