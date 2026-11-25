import sys,os,re,glob
from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein as L
ALB={'mx':r"MxPx\Living In The Chaos",'rh':r"Random Hand\Random Hand",'br':r"Bad Religion\How Could Hell Be Any Worse_",'cv':r"Choking Victim\No Gods - No Managers",'pa':r"Propagandhi\At Peace",'pv':r"Propagandhi\Victory Lap"}
HERE=os.path.dirname(os.path.abspath(__file__))
def norm_words(t):
    t=t.lower().replace('’',"'").replace('‘',"'")
    t=re.sub(r"[^a-z0-9\s]",'',t)
    return t.split()
def norm_line(l): return ' '.join(norm_words(l))
def titles(tag):
    fs=sorted(glob.glob(os.path.join(os.path.expanduser("~"),"Music",ALB[tag],"*.mp3")))
    out=[]
    for f in fs:
        n=os.path.splitext(os.path.basename(f))[0]
        n=re.sub(r'^\s*\d+\s*[-.]?\s*','',n); out.append(n)
    return out
def truth(tag):
    d={}
    for f in sorted(glob.glob(os.path.join(HERE,'truth',tag+'*_*.txt'))):
        i=int(re.search(r'_(\d+)\.txt',f).group(1))
        t=open(f,encoding='utf-8').read()
        if tag!='mx' and '\n#\n' in t: t=t.split('\n#\n',1)[1]
        d[i]=t
    return d
def parse_blocks(text):
    """split transcription into (title, body) using lines starting with '#'"""
    blocks=[];cur=None
    for ln in text.splitlines():
        if ln.startswith('#'):
            cur=[re.sub(r'^#+\s*','',ln).strip(),[]];blocks.append(cur)
        elif cur is not None: cur[1].append(ln)
    return [(t,'\n'.join(b)) for t,b in blocks]
def score_blocks(tag,blocks):
    T=titles(tag);Tr=truth(tag);res={}
    for i,tr in Tr.items():
        cands=[b for b in blocks if fuzz.ratio(norm_line(b[0]),norm_line(T[i-1]))>=60]
        tw=norm_words(tr);tl=[norm_line(x) for x in tr.splitlines() if x.strip()]
        best=None
        for title,body in cands:
            bw=norm_words(body);d=L.distance(tw,bw)
            if best is None or d<best[0]: best=(d,body)
        if best is None: continue
        d,body=best
        bl=set(norm_line(x) for x in body.splitlines() if x.strip())
        exact=sum(1 for x in tl if x in bl)
        res[i]=(100,1-d/max(1,len(tw)),exact/max(1,len(tl)),len(tw),d)
    return res

def report(tag,res,label=''):
    tot_w=sum(r[3] for r in res.values());tot_d=sum(r[4] for r in res.values())
    print(f'{label} {tag}: songs scored {len(res)}  word accuracy {100*(1-tot_d/max(1,tot_w)):.1f}%  exact lines {100*sum(r[2] for r in res.values())/max(1,len(res)):.1f}%  word errors {tot_d}/{tot_w}')
    for i in sorted(res): print(f'   {i:2d} acc {100*res[i][1]:.0f}%  lines {100*res[i][2]:.0f}%  errs {res[i][4]}')
if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    tag=sys.argv[1]; txt=open(sys.argv[2],encoding='utf-8').read()
    report(tag,score_blocks(tag,parse_blocks(txt)),sys.argv[2])


