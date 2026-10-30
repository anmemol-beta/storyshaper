"""Runway POC: prepare locally, submit once, poll, download, manually review."""
import argparse
import json
import os
from pathlib import Path
import sys
from .runway_api import RunwayClient,RunwayError,TaskLedger,submit_once,poll_once,download_unreviewed
from .runway_approval import review

def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument("--ledger",type=Path,default=Path(".tmp/runway-tasks.sqlite3"))
    sub=p.add_subparsers(dest="cmd",required=True)
    prep=sub.add_parser("prepare");prep.add_argument("--out",required=True)
    submit=sub.add_parser("submit");submit.add_argument("--request",type=Path,required=True)
    submit.add_argument("--run-id",required=True);submit.add_argument("--confirm-paid-submit",action="store_true")
    for name in ("poll","status","download","approve","reject"):
        x=sub.add_parser(name);x.add_argument("--run-id",required=True)
        if name=="download":x.add_argument("--out",type=Path,required=True)
        if name=="approve":x.add_argument("--scene-key",required=True);x.add_argument("--root",default=".")
    a=p.parse_args(argv)
    if a.cmd=="prepare":
        from .prepare import main as prepare_main
        old=sys.argv
        try:
            sys.argv=[old[0],"--out",a.out]
            prepare_main()
        finally:sys.argv=old
        return 0
    if a.cmd=="submit" and not a.confirm_paid_submit:
        print("paid_submit_confirmation_required",file=sys.stderr);return 2
    if a.cmd in ("submit","poll","download") and not os.environ.get("RUNWAYML_API_SECRET"):
        print("missing_api_key",file=sys.stderr);return 2
    ledger=TaskLedger(a.ledger)
    try:
        client=RunwayClient()
        if a.cmd=="submit":
            result=submit_once(client,ledger,a.run_id,json.loads(a.request.read_text(encoding="utf-8")))
        elif a.cmd=="poll":result=poll_once(client,ledger,a.run_id)
        elif a.cmd=="download":result=download_unreviewed(client,ledger,a.run_id,a.out)
        elif a.cmd=="approve":result=review(ledger,a.run_id,a.scene_key,root=a.root,approve=True)
        elif a.cmd=="reject":result=review(ledger,a.run_id,None,approve=False)
        else:result=ledger.get(a.run_id)
        print(json.dumps({k:v for k,v in result.items() if k!="request_hash"},indent=2));return 0
    except (RunwayError,ValueError,OSError,KeyError) as exc:
        print("runway_error: "+(exc.code if isinstance(exc,RunwayError) else type(exc).__name__),file=sys.stderr)
        return 1
    finally:ledger.close()

if __name__=="__main__":sys.exit(main())
