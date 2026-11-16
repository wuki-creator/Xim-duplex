"""Original, quiet electronic ambience for Xim's concept film; no third-party samples."""
import math, wave, struct, sys
rate=48000;duration=26
with wave.open(sys.argv[1],"wb") as w:
    w.setparams((1,2,rate,0,"NONE","not compressed"))
    data=bytearray()
    for i in range(rate*duration):
        t=i/rate;fade=min(1,t/2,(duration-t)/3)
        chord=sum(math.sin(2*math.pi*f*t+.15*math.sin(t*.4)) for f in [130.81,196,261.63,329.63])/4
        pulse=math.exp(-((t%2.5)/.17)**2)*math.sin(2*math.pi*784*t)*.18
        v=(chord*.08+pulse*.045)*max(0,fade)
        data.extend(struct.pack('<h',int(v*32767)))
    w.writeframes(data)
