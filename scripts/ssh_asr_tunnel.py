"""Forward a loopback ASR service through verified SSH; never persist credentials.

Requires paramiko. Host must already be present in ~/.ssh/known_hosts.
The remote ASR service must listen on 127.0.0.1, not a public interface.
"""
import argparse,getpass,os,select,socketserver,subprocess,sys,threading,time
from pathlib import Path
import paramiko

parser=argparse.ArgumentParser()
parser.add_argument('--host',required=True)
parser.add_argument('--user',required=True)
parser.add_argument('--ssh-port',type=int,default=22)
parser.add_argument('--local-port',type=int,default=18791)
parser.add_argument('--remote-port',type=int,default=18792)
parser.add_argument('--background',action='store_true')
args=parser.parse_args()
password=os.environ.pop('XIM_SSH_PASSWORD',None) or getpass.getpass('SSH password: ')
if args.background:
    env=os.environ.copy();env['XIM_SSH_PASSWORD']=password
    command=[sys.executable,str(Path(__file__).resolve()),*[x for x in sys.argv[1:] if x!='--background']]
    child=subprocess.Popen(command,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0,start_new_session=os.name!='nt')
    print('Tunnel process started:',child.pid,'; verify /health before using it.')
    sys.exit(0)

client=paramiko.SSHClient();client.load_host_keys(str(Path.home()/'.ssh/known_hosts'))
client.connect(args.host,port=args.ssh_port,username=args.user,password=password,allow_agent=False,look_for_keys=False,timeout=12)
password=None
transport=client.get_transport();transport.set_keepalive(15)
limit=threading.BoundedSemaphore(4)
class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        if not limit.acquire(False):return
        channel=None
        try:
            self.request.settimeout(30)
            channel=transport.open_channel('direct-tcpip',('127.0.0.1',args.remote_port),self.client_address,timeout=10)
            channel.settimeout(30)
            while transport.is_active():
                ready,_,_=select.select([self.request,channel],[],[],30)
                if not ready:break
                for source in ready:
                    data=source.recv(65536)
                    if not data:return
                    (channel if source is self.request else self.request).sendall(data)
        except (OSError,EOFError,paramiko.SSHException):pass
        finally:
            if channel:channel.close()
            limit.release()
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True
    daemon_threads=True
with Server(('127.0.0.1',args.local_port),Handler) as server:
    def monitor():
        while transport.is_active():time.sleep(2)
        server.shutdown()
    threading.Thread(target=monitor,daemon=True).start()
    print('Loopback tunnel ready on port',args.local_port,flush=True)
    try:server.serve_forever()
    finally:client.close()
