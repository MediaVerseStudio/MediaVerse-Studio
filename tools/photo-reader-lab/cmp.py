import sys,glob,os,re,collections
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from score import *
from rapidfuzz import fuzz
sys.stdout.reconfigure(encoding='utf-8')
def flat(t): return ' '.join(norm_words(t.replace('*','')))
def load(d,group):
    g=collections.OrderedDict()
    for f in sorted(glob.glob(os.path.join(d,'*.txt'))):
        k=re.sub(r'_\d\d\.jpg\.txt$','',os.path.basename(f)) if group else os.path.basename(f)
        g.setdefault(k,[]).append(open(f,encoding='utf-8').read())
    return [flat('\n'.join(v)) for v in g.values()],[flat(x) for v in g.values() for x in v]
def persong(d,group=False):
    G,S=load(d,group);res={}
    for tag in ALB:
        for i,t in truth(tag).items():
            tw=flat(t)
            if len(tw)<40: continue
            res[(tag,i)]=max(max((fuzz.partial_ratio(tw,o) for o in G),default=0),max((fuzz.partial_ratio(tw,o) for o in S),default=0))
    return res
if __name__=='__main__':
    ds=sys.argv[1:]
    R={d:persong(d,'c' in os.path.basename(d.rstrip('\\/'))[-1:]) for d in ds}
    keys=[k for k in R[ds[0]] if max(R[d][k] for d in ds)>=70]
    print(len(keys),'covered songs (best read >= 70 by any method)')
    for d in ds:
        v=[R[d][k] for k in keys]
        by=collections.defaultdict(list)
        for k in keys: by[k[0]].append(R[d][k])
        print(os.path.basename(d.rstrip('\\/')).ljust(10),f'mean {sum(v)/len(v):5.1f}  >=95: {sum(1 for x in v if x>=95)}  >=90: {sum(1 for x in v if x>=90)}  <80: {sum(1 for x in v if x<80)} |',' '.join(f'{t}:{sum(x)/len(x):.0f}' for t,x in by.items()))
