import json,os,re,sys,time,urllib.parse,urllib.request
ENV={}
HERE=os.path.dirname(os.path.abspath(__file__))
for l in open(os.path.join(HERE,"..","..",".env"),encoding="utf-8"):
    l=l.strip()
    if l and not l.startswith("#") and "=" in l:
        k,v=l.split("=",1); ENV[k.strip()]=v.strip()
K=ENV["DATA_GO_KR_KEY"]; SEC=[K,urllib.parse.quote(K,safe="")]
def mask(t):
    for s in SEC: t=t.replace(s,"***")
    return t
B="https://apis.data.go.kr/B500001/dam"
def call(path,**p):
    q=dict(p); q.setdefault("_type","json"); q["serviceKey"]=K
    url=(path if path.startswith("http") else B+path)+"?"+urllib.parse.urlencode(q)
    t0=time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"}),timeout=60) as r: body=r.read().decode("utf-8","replace"); st=r.status
    except urllib.error.HTTPError as e: body=e.read().decode("utf-8","replace"); st=e.code
    except Exception as e: body=f"EXC {e}"; st=-1
    time.sleep(0.2)
    return st,mask(body),round(time.time()-t0,2)
def items(body):
    try: j=json.loads(body)
    except Exception: return None,None
    b=j.get("response",{}).get("body",{}); h=j.get("response",{}).get("header",{})
    it=b.get("items") or {}
    it=it.get("item",[]) if isinstance(it,dict) else it
    if isinstance(it,dict): it=[it]
    return (h.get("resultCode"),h.get("resultMsg"),b.get("totalCount")),it
if __name__=="__main__":
    path=sys.argv[1]; p=dict(a.split("=",1) for a in sys.argv[2:])
    st,body,dt=call(path,**p); meta,it=items(body)
    print("HTTP",st,dt,"s",meta, "rows",None if it is None else len(it))
    if it is None: print(body[:600])
    else:
        for r in it[:int(os.environ.get("N","3"))]: print(" ",r)
        if it and os.environ.get("TAIL"): print("  ...",it[-1])
