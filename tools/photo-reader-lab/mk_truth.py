import json,sys,os
sys.stdout.reconfigure(encoding='utf-8')
p=os.path.join(os.environ['APPDATA'],'MediaVerse Studio','lyric-ai','page-reader','sessions',sys.argv[1]+'.json')  # the session file of the album
d=json.load(open(p,encoding='utf-8'))['state']
out=os.path.join(os.path.dirname(os.path.abspath(__file__)),'truth')
os.makedirs(out,exist_ok=True)
m={0:1,1:2,2:3,3:4,6:5,7:6}
for k,v in d['edited'].items():
    t=v.strip()+'\n'
    open(os.path.join(out,f'mxpx_{m[int(k)]:02d}.txt'),'w',encoding='utf-8').write(t)
    print(m[int(k)],len(t.splitlines()))
