from pathlib import Path
from PIL import Image
root=Path('/tmp/first-two-output'); out=Path('/tmp/first-two-safe-sensitive'); out.mkdir(exist_ok=True)
regions={'01-connected':(0,12000,720,13400),'01-face':(0,1800,720,3000),'01-bubbles':(0,5800,720,7400),'02-face-bubble':(0,1800,720,3100),'02-transparent':(0,5000,720,6400),'02-lower-bubble':(0,6800,720,7600)}
for name,box in regions.items():
    stem='01' if name.startswith('01') else '02'
    a=Image.open(root/f'{stem}.png').convert('RGB').crop(box)
    b=Image.open(root/f'{stem}-safe.png').convert('RGB').crop(box)
    s=Image.new('RGB',(a.width*2,a.height),'white'); s.paste(a,(0,0)); s.paste(b,(a.width,0)); s.save(out/f'{name}.png')
