import sys,os,glob,time
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from vlm import prep,ask
sys.stdout.reconfigure(encoding='utf-8')
model,maxside,outdir=sys.argv[1],int(sys.argv[2]),sys.argv[3]
os.makedirs(outdir,exist_ok=True)
PROMPT="This is a photo of a CD booklet lyric sheet. Transcribe all the song lyrics exactly as printed, one song at a time, with each song's title as a heading line starting with '# '. Keep the line breaks and stanza breaks. Ignore credits, thanks, addresses and artwork. Do not add commentary."
for p in sys.argv[4:]:
    o=os.path.join(outdir,os.path.basename(p)+'.txt')
    if os.path.exists(o): continue
    b,sz=prep(p,maxside)
    try: txt,sec=ask(b,PROMPT,model=model)
    except Exception as e: txt,sec='ERROR '+str(e),0
    open(o,'w',encoding='utf-8').write(txt); print(os.path.basename(p),sz,round(sec),flush=True)
