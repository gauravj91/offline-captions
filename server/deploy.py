# Deploy the license server to Cloudflare Workers via the REST API (no wrangler).
# Needs a Cloudflare API token (Workers Scripts + KV edit) sent as Authorization: Bearer on api.cloudflare.com.
# Secrets (Ed25519 private key, Paddle webhook secret, KV id) live in OC_SECRETS (default secrets.local.json, gitignored).
import json,os,subprocess,urllib.request,base64,sys
ACC="ad570fbf6da641d945cafc33e81c329c"; API="https://api.cloudflare.com/client/v4"; NAME="offline-captions-api"
SRC=os.path.join(os.path.dirname(os.path.abspath(__file__)),"src","worker.js")
SEC=os.environ.get("OC_SECRETS","secrets.local.json")  # never commit
def cf(m,p,body=None,ct="application/json",raw=None):
    data=raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r=urllib.request.Request(API+p,method=m,data=data,headers={"Content-Type":ct,"Authorization":"Bearer "+os.environ.get("CF_API_TOKEN","x")})
    try: return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: print(m,p,e.code,e.read().decode()[:500]); raise
sec=json.load(open(SEC)) if os.path.exists(SEC) else {}
if "LICENSE_PRIVATE_KEY" not in sec:
    out=subprocess.check_output(["node","-e","""const kp=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
console.log(JSON.stringify({priv:Buffer.from(await crypto.subtle.exportKey('pkcs8',kp.privateKey)).toString('base64url'),pub:Buffer.from(await crypto.subtle.exportKey('raw',kp.publicKey)).toString('base64url')}))""","--input-type=module"])
    k=json.loads(out); sec["LICENSE_PRIVATE_KEY"]=k["priv"]; sec["LICENSE_PUBLIC_KEY"]=k["pub"]
if "KV_ID" not in sec:
    ns=cf("GET",f"/accounts/{ACC}/storage/kv/namespaces?per_page=100")["result"]
    ex=[n for n in ns if n["title"]=="offline-captions-licenses"]
    sec["KV_ID"]=ex[0]["id"] if ex else cf("POST",f"/accounts/{ACC}/storage/kv/namespaces",{"title":"offline-captions-licenses"})["result"]["id"]
json.dump(sec,open(SEC,"w")); os.chmod(SEC,0o600)
meta={"main_module":"worker.js","compatibility_date":"2026-10-01","bindings":[
 {"type":"kv_namespace","name":"KV","namespace_id":sec["KV_ID"]},
 {"type":"plain_text","name":"PADDLE_ENV","text":"sandbox"},
 {"type":"plain_text","name":"DEVICE_LIMIT","text":os.environ.get("DEVICE_LIMIT","2")},
 {"type":"plain_text","name":"ALLOWED_ORIGINS","text":"*"},
 {"type":"plain_text","name":"LICENSE_PUBLIC_KEY","text":sec["LICENSE_PUBLIC_KEY"]}],
 "keep_bindings":["secret_text"]}
B="----ocb7a1"
body=(f"--{B}\r\nContent-Disposition: form-data; name=\"metadata\"; filename=\"metadata.json\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n"
 f"--{B}\r\nContent-Disposition: form-data; name=\"worker.js\"; filename=\"worker.js\"\r\nContent-Type: application/javascript+module\r\n\r\n").encode()+open(SRC,"rb").read()+f"\r\n--{B}--\r\n".encode()
r=cf("PUT",f"/accounts/{ACC}/workers/scripts/{NAME}",raw=body,ct=f"multipart/form-data; boundary={B}"); print("script",r["success"])
for n in ["LICENSE_PRIVATE_KEY","PADDLE_WEBHOOK_SECRET"]:
    if sec.get(n): print("secret",n,cf("PUT",f"/accounts/{ACC}/workers/scripts/{NAME}/secrets",{"name":n,"text":sec[n],"type":"secret_text"})["success"])
print("subdomain",cf("POST",f"/accounts/{ACC}/workers/scripts/{NAME}/subdomain",{"enabled":True,"previews_enabled":False})["success"])
print("pub",sec["LICENSE_PUBLIC_KEY"])
