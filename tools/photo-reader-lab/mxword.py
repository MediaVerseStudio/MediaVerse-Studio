import sys,os,glob
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from score import *
sys.stdout.reconfigure(encoding='utf-8')
def semi(tw,ow):
    n=len(tw);prev=[0]*(len(ow)+1)
    for i in range(1,n+1):
        cur=[i]+[0]*len(ow)
        a=tw[i-1]
        for j in range(1,len(ow)+1):
            cur[j]=min(prev[j-1]+(a!=ow[j-1]),prev[j]+1,cur[j-1]+1)
        prev=cur
    return min(prev)
def wordacc(d,photo,songs):
    ow=norm_words(open(os.path.join(d,photo+'.txt'),encoding='utf-8').read().replace('*',''))
    tot=err=0
    for i in songs:
        tw=norm_words(truth('mx')[i]);e=semi(tw,ow);tot+=len(tw);err+=e
    return tot,err
if __name__=='__main__':
  for d in sys.argv[1:]:
    t,e=wordacc(d,'PXL_20261120_230532419.jpg',[1,2,3,4])
    print(os.path.basename(d).ljust(12),f'MxPx songs 1-4: word errors {e}/{t}  accuracy {100*(1-e/t):.1f}%')
