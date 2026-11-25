import sys,os,glob,io,base64,re
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from vlm import ask
from score import norm_words
from PIL import Image,ImageOps
sys.stdout.reconfigure(encoding='utf-8')
V=set()
for f in glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)),'truth','*.txt')): V.update(norm_words(open(f,encoding='utf-8').read()))
Q="Read the first ten lines of printed text you can see in this photo, exactly as written. If you cannot read it, write the characters you see anyway."
def enc(im,side=1280):
    im=im.copy();im.thumbnail((side,side));b=io.BytesIO();im.save(b,'JPEG',quality=90);return base64.b64encode(b.getvalue()).decode()
def best_rotation(p):
    im=ImageOps.exif_transpose(Image.open(p)).convert('RGB');sc={}
    for a in (0,90,180,270):
        t,_=ask(enc(im.rotate(-a,expand=True) if a else im),Q,predict=250)
        w=[x for x in norm_words(t) if len(x)>=3]
        sc[a]=sum(1 for x in w if x in V)/max(1,len(w)) if len(w)>=5 else 0
    return max(sc,key=sc.get),sc
if __name__=='__main__':
    for p in open(sys.argv[1],encoding='utf-8').read().split('\n'):
        if p.strip():
            a,sc=best_rotation(p);print(os.path.basename(p),a,{k:round(v,2) for k,v in sc.items()},flush=True)
