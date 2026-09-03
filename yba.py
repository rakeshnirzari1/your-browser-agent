#!/usr/bin/env python3
"""Minimal client for Your Browser Agent (relay on 127.0.0.1:7799).
Usage:
  python yba.py status
  python yba.py '<json>'              # POST /cmd, e.g. '{"cmd":"snapshot"}'
  python yba.py cmd [paramsJson]      # e.g. yba.py newTab '{"url":"https://x.com"}'
  python yba.py eval <tabId> '<expr>' # evaluate JS in a tab
Prints the relay's JSON response.
"""
import json, sys, urllib.request

BASE = "http://127.0.0.1:7799"

def call(cmd, params):
    body = json.dumps({"cmd": cmd, "params": params or {}}).encode()
    req = urllib.request.Request(BASE + "/cmd", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__); return
    if a[0] == "status":
        with urllib.request.urlopen(BASE + "/status", timeout=5) as r:
            print(json.dumps(json.loads(r.read())))
        return
    if a[0] == "eval" and len(a) >= 3:
        res = call("evaluate", {"tabId": int(a[1]), "expression": a[2]})
    elif a[0] == "cmd" and len(a) >= 2:
        res = call(a[1], json.loads(a[2]) if len(a) > 2 else {})
    else:
        try:
            res = call(json.loads(a[0]).get("cmd"), json.loads(a[0]).get("params"))
        except Exception:
            print(__doc__); return
    print(json.dumps(res, indent=1))

if __name__ == "__main__":
    main()
