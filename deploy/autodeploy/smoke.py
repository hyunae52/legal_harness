"""Small, read-only MCP checks after both real providers have initialized."""
import json, os, urllib.request

def rpc(number, method, params, allow_error=False):
    port = os.environ.get('SMOKE_PORT', '3100')
    assert port in ('3100', '3101')
    request=urllib.request.Request('http://127.0.0.1:'+port+'/mcp',data=json.dumps({'jsonrpc':'2.0','id':number,'method':method,'params':params}).encode(),
        headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'})
    with urllib.request.urlopen(request,timeout=55) as response: data=json.load(response)
    assert 'result' in data and (allow_error or data['result'].get('isError') is not True)
    return data['result']

def main():
    rpc(1,'initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'auto-deploy-smoke','version':'1'}})
    catalog=rpc(2,'tools/list',{})
    names={t['name'] for t in catalog['tools']}
    assert {'get_law_text','get_tax_document','review_legal_reasoning','prepare_correction_pr'}<=names
    invalid=rpc(3,'tools/call',{'name':'get_tax_document','arguments':{'ntst_dcm_id':'invalid'}},allow_error=True)
    assert invalid['structuredContent']['error']['code']=='INVALID_INPUT'
    law=rpc(4,'tools/call',{'name':'get_law_text','arguments':{'lawId':'001586','jo':'제18조'}})
    assert any(c.get('type')=='text' and '국세기본법' in c.get('text','') for c in law.get('content',[]))
    tax=rpc(5,'tools/call',{'name':'lookup_tax_document','arguments':{'document_number':'서면-2020-부동산-4503','include_full_text':True}})
    data=tax.get('structuredContent',{})
    assert data.get('document',{}).get('bodyUnavailable') is not True
    assert data.get('document',{}).get('answer') or data.get('ambiguous') is True or len(data.get('candidates',[]))>1
    return {'status':'pass','tool_count':len(names),'law_lookup':True,'tax_lookup':True,'github_writes':0}

if __name__=='__main__':
    try: print(json.dumps(main()))
    except Exception as error:
        print(json.dumps({'status':'failed','error_type':type(error).__name__})); raise SystemExit(1)
