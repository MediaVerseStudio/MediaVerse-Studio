import sys,os,io,base64,time
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from vlm import prep,ask
from PIL import Image,ImageOps
sys.stdout.reconfigure(encoding='utf-8')
mode,outdir=sys.argv[1],sys.argv[2]
ROT={}
import json as _j
if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)),'rot.json')): ROT=_j.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'rot.json')))
def upright(p):
    im=ImageOps.exif_transpose(Image.open(p)).convert('RGB')
    a=ROT.get(os.path.basename(p),0)
    if a: im=im.rotate(-a,expand=True)
    q=os.path.join(os.path.dirname(os.path.abspath(__file__)),'upright');os.makedirs(q,exist_ok=True)
    o=os.path.join(q,os.path.basename(p));im.save(o,quality=95);return o
os.makedirs(outdir,exist_ok=True)
FULL=os.environ.get('PROMPT') or "This is a photo of a CD booklet lyric sheet. Transcribe all the song lyrics exactly as printed, one song at a time, with each song's title as a heading line starting with '# '. Keep the line breaks and stanza breaks. Ignore credits, thanks, addresses and artwork. Do not add commentary."
FIX="This is a photo of a CD booklet lyric sheet. Below is a first transcription of it, made by a machine that sometimes misreads words, drops apostrophes and commas, or merges and splits lines. Compare it with the photo line by line and output the corrected full transcription in the same format (each song title as a heading line starting with '# '). Only change what the photo shows differently. Do not add commentary.\n\nFirst transcription:\n"
TILE="This is one tile cut from a photo of a CD booklet lyric sheet. Lines cut off by the edge of the tile may be incomplete: skip a line if more than a few letters are cut off. Transcribe the lyric lines that are fully visible exactly as printed, keeping line and stanza breaks. If a song title heading is visible, put it on its own line starting with '# '. Do not add commentary."
def tiles(path,cols,rows,ov=0.15,maxside=2048):
    im=ImageOps.exif_transpose(Image.open(path)).convert('RGB');W,H=im.size
    out=[]
    for c in range(cols):
        for r in range(rows):
            x0=max(0,int(W*(c/cols-ov/2)));x1=min(W,int(W*((c+1)/cols+ov/2)))
            y0=max(0,int(H*(r/rows-ov/2)));y1=min(H,int(H*((r+1)/rows+ov/2)))
            t=im.crop((x0,y0,x1,y1));s=maxside/max(t.size)
            if s<1:t=t.resize((int(t.width*s),int(t.height*s)),Image.LANCZOS)
            b=io.BytesIO();t.save(b,'JPEG',quality=92);out.append(base64.b64encode(b.getvalue()).decode())
    return out
def dedupe(parts):
    # join tile texts; drop leading lines of a part that already end the previous text
    from rapidfuzz import fuzz
    res=[]
    for p in parts:
        ls=[l for l in p.splitlines()]
        if res:
            for k in range(min(len(ls),12),0,-1):
                head=[x.strip().lower() for x in ls[:k]]; tail=[x.strip().lower() for x in res[-k:]]
                if all(fuzz.ratio(a,b)>=85 for a,b in zip(head,tail)): ls=ls[k:];break
        res+=ls
    return '\n'.join(res)
for p in sys.argv[3:]:
    o=os.path.join(outdir,os.path.basename(p)+'.txt')
    if os.path.exists(o): continue
    t0=time.time()
    try:
        if mode.startswith('rot'): p2=upright(p)
        if mode=='rotfull': txt,_=ask(prep(p2,3072)[0],FULL,predict=8000)
        elif mode=='rottiles':
            parts=[ask(b,TILE,predict=3000)[0] for b in tiles(p2,*( (2,2) ))]
            txt=dedupe(parts)
        elif mode=='full4k': txt,_=ask(prep(p,4096)[0],FULL,predict=8000)
        elif mode=='think': txt,_=ask(prep(p,3072)[0],FULL,think=True,predict=16000,ctx=32768)
        elif mode=='fix':
            prev=open(os.path.join(sys.argv[3-0] if False else os.environ['PREV'],os.path.basename(p)+'.txt'),encoding='utf-8').read()
            txt,_=ask(prep(p,3072)[0],FIX+prev,predict=8000)
        elif mode.startswith('tiles'):
            c,r=[int(x) for x in mode[5:].split('x')]
            im=Image.open(p);im=ImageOps.exif_transpose(im)
            if im.height>im.width: c,r=r,c
            parts=[ask(b,TILE,predict=3000)[0] for b in tiles(p,c,r)]
            txt=dedupe(parts)
    except Exception as e: txt='ERROR '+str(e)
    open(o,'w',encoding='utf-8').write(txt); print(os.path.basename(p),round(time.time()-t0),flush=True)


