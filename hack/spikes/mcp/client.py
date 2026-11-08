"""A client of the spike's MCP server, as the specification describes one, for run.sh: the server started on stdio,
initialize, the initialized notification, tools/list, the tool called three ways (answered, a tool's error, a
protocol's error), ping, and a method the server hasn't. Prints one line of JSON per exchange: what was sent and
what came back.
  python3 -I client.py <server command…>
"""

import json
import subprocess
import sys


def main():
    server = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    next_id = 0

    def send(method, params=None, notification=False):
        nonlocal next_id
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        if not notification:
            next_id += 1
            message["id"] = next_id
        server.stdin.write(json.dumps(message) + "\n")
        server.stdin.flush()
        reply = None if notification else json.loads(server.stdout.readline())
        print(json.dumps({"sent": method, "params": params, "reply": reply}))

    send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "ff-spike-client", "version": "0.1.0"}})
    send("notifications/initialized", notification=True)
    send("tools/list")
    send("tools/call", {"name": "ff_functions", "arguments": {}})
    send("tools/call", {"name": "ff_functions", "arguments": {"fail": "tool"}})
    send("tools/call", {"name": "ff_functions", "arguments": {"fail": "protocol"}})
    send("ping")
    send("resources/list")
    server.stdin.close()
    server.wait(timeout=5)


if __name__ == "__main__":
    main()
