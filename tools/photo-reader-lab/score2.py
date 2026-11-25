import sys,glob,os
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from score import *
from rapidfuzz import fuzz
sys.stdout.reconfigure(encoding='utf-8')
def flat(t): return ' '.join(norm_words(t.replace('*','')))
def run(d,verbose=False):
    import re as _re,collections
    g=collections.OrderedDict()
    for f in sorted(glob.glob(os.path.join(d,'*.txt'))):
        k=_re.sub(r'_\d\d\.jpg\.txt$','',os.path.basename(f)); g.setdefault(k,[]).append(open(f,encoding='utf-8').read())
    outs=[flat('\n'.join(v)) for v in g.values()]
    allv=[];rows=[]
    for tag in ALB:
        Tr=truth(tag);v=[]
        for i,t in Tr.items():
            tw=flat(t)
            if len(tw)<40: continue
            best=max((fuzz.partial_ratio(tw,o) for o in outs),default=0)
            v.append(best)
        if v:
            rows.append((tag,len(v),sum(v)/len(v),sum(1 for x in v if x>=90),sum(1 for x in v if x<60)))
            allv+=v
    print(os.path.basename(d.rstrip('\\/')).ljust(14),' '.join(f'{t}:{m:5.1f}' for t,n,m,a,b in rows),f' | ALL {sum(allv)/len(allv):5.1f}  songs>=90: {sum(1 for x in allv if x>=90)}/{len(allv)}  <60: {sum(1 for x in allv if x<60)}')
if __name__=='__main__':
    for d in sys.argv[1:]: run(d)

