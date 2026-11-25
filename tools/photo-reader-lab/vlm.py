import sys,json,base64,io,time,urllib.request
from PIL import Image,ImageOps
def prep(path,maxside=2048,box=None):
    im=ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    if box:
        W,H=im.size; im=im.crop((int(box[0]*W),int(box[1]*H),int(box[2]*W),int(box[3]*H)))
    s=maxside/max(im.size)
    if s<1: im=im.resize((int(im.width*s),int(im.height*s)),Image.LANCZOS)
    b=io.BytesIO(); im.save(b,'JPEG',quality=92); return base64.b64encode(b.getvalue()).decode(),im.size
def ask(img_b64,prompt,model=__import__('os').environ.get('MODEL','qwen3.8:27b'),think=False,ctx=16384,predict=6000):
    body={'model':model,'stream':False,'think':think,'messages':[{'role':'user','content':prompt,'images':[img_b64]}],
          'options':{'temperature':0,'num_ctx':ctx,'num_predict':predict}}
    r=urllib.request.Request('http://localhost:11434/api/chat',json.dumps(body).encode(),{'Content-Type':'application/json'})
    t=time.time(); d=json.load(urllib.request.urlopen(r,timeout=1800))
    return d['message']['content'],time.time()-t
if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    path=sys.argv[1]; ms=int(sys.argv[2]) if len(sys.argv)>2 else 2048
    b,sz=prep(path,ms); print(sz,file=sys.stderr)
    txt,sec=ask(b,"This is a photo of a CD booklet lyric sheet. Transcribe all the song lyrics exactly as printed, one song at a time, with each song's title as a heading. Keep line breaks. Do not add commentary.")
    print(txt); print('SECONDS',sec,file=sys.stderr)

