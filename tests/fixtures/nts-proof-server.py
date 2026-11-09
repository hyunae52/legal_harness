"""Real pinned provider, public raw fixtures, HTTP intercepted before parsing."""
import gzip
import json
from pathlib import Path
import sys

source = Path(sys.argv[1])
sys.path.insert(0, str(source / "src"))
import httpx
import respx
from korean_taxlaw_mcp.action_client import ACTION_URL
from korean_taxlaw_mcp.server import mcp

def fixture(name):
    with gzip.open(source / "tests" / "fixtures" / (name + ".json.gz"), "rt", encoding="utf-8") as stream:
        return json.load(stream)

def handler(request):
    form = dict(httpx.QueryParams(request.content.decode()))
    action = form["actionId"]
    assert action == "ASIPDI002PR01", "Unexpected extra source request"
    param = json.loads(form["paramData"])
    query = " ".join(param["icldVcbCtl"])
    if "__html__" in query:
        return httpx.Response(200, text="<html>Maintenance</html>")
    if "__missing__" in query:
        payload = {}
    elif "__positive__" in query or "__overflow__" in query or "__contradiction__" in query:
        payload = fixture("search_written")
        payload["body"] = payload["body"][:1] if "__positive__" in query else []
        payload["top"][0]["categoryMap"]["SUB_ID_CATEGORY"] = [{"name": "001_02", "count": "1" if "__positive__" in query else "12"}]
    else:
        payload = fixture("search_empty_question_v1")["data"][action]
    return httpx.Response(200, json={"status": "SUCCESS", "data": {action: payload}})

with respx.mock(assert_all_called=False) as mock:
    mock.post(ACTION_URL).mock(side_effect=handler)
    mcp.run(transport="stdio", show_banner=False)
