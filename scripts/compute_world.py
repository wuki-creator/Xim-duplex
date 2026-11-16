"""Bounded engineering worker: arm inverse kinematics and free-fall estimates."""
import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

UPPER, LOWER, SHOULDER = 2.15, 1.75, 0.8


def vector(value):
    if not isinstance(value, list) or len(value) != 3 or not all(type(n) in (float, int) and math.isfinite(n) and abs(n) <= 12 for n in value):
        raise ValueError('coordinates')
    return value


def solve(target):
    x, y, z = target
    radial = math.hypot(x, z)
    elevation = y - SHOULDER
    radius = math.hypot(radial, elevation)
    if y < 0.12 or radius < abs(UPPER - LOWER) + 1e-6 or radius > UPPER + LOWER - 1e-6:
        raise ValueError('unreachable')
    elbow = -math.acos((radius * radius - UPPER**2 - LOWER**2) / (2 * UPPER * LOWER))
    shoulder = math.atan2(elevation, radial) - math.atan2(LOWER * math.sin(elbow), UPPER + LOWER * math.cos(elbow))
    return [math.atan2(z, x), shoulder, elbow]


def calculate(data):
    if data.get('job') == 'arm':
        start, target = vector(data.get('start')), vector(data.get('target'))
        frames = []
        for i in range(37):
            t = i / 36
            s = t * t * (3 - 2 * t)
            p = [a + (b - a) * s for a, b in zip(start, target)]
            frames.append({'time': round(t * 1.5, 4), 'position': p, 'joints': solve(p)})
        return {'job': 'arm', 'duration': 1.5, 'samples': frames, 'solver': 'three-joint-ik-v1'}
    if data.get('job') == 'physics':
        objects = data.get('objects')
        if not isinstance(objects, list) or len(objects) > 32:
            raise ValueError('scene')
        rows = []
        for obj in objects:
            if not isinstance(obj, dict) or not isinstance(obj.get('id'), str):
                raise ValueError('object')
            _, y, _ = vector(obj.get('position'))
            shape = obj.get('shape')
            if shape not in ('box', 'sphere', 'cylinder'):
                raise ValueError('shape')
            size = obj.get('size', 1)
            if type(size) not in (int, float) or not .2 <= size <= 2.5:
                raise ValueError('size')
            h = max(0, y - size / 2)
            rows.append({'id': obj['id'][:40], 'dropHeight': round(h, 3), 'fallTime': round(math.sqrt(2*h/9.81), 3), 'impactSpeed': round(math.sqrt(2*9.81*h), 3)})
        return {'job': 'physics', 'gravity': 9.81, 'objects': rows, 'solver': 'free-fall-to-floor-v1'}
    raise ValueError('job')


def execute(body):
    try:
        return 200, calculate(json.loads(body))
    except ValueError as error:
        return 400, {'error': 'UNREACHABLE' if str(error) == 'unreachable' else 'INVALID_COMPUTE_INPUT'}
    except (AttributeError, TypeError, OverflowError):
        return 400, {'error': 'INVALID_COMPUTE_INPUT'}


class Worker(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, status, data):
        raw = json.dumps(data, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.send_json(200 if self.path == '/health' else 404, {'ready': self.path == '/health'})

    def do_POST(self):
        if self.path != '/compute':
            return self.send_json(404, {'error': 'NOT_FOUND'})
        try:
            n = int(self.headers.get('Content-Length', 0))
        except ValueError:
            n = 0
        if not 0 < n <= 20000:
            return self.send_json(400, {'error': 'INVALID_COMPUTE_INPUT'})
        self.connection.settimeout(8)
        self.send_json(*execute(self.rfile.read(n)))


if __name__ == '__main__':
    if '--stdio' in sys.argv:
        print(json.dumps(execute(sys.stdin.buffer.read(20001))[1], allow_nan=False))
    else:
        server = HTTPServer(('127.0.0.1', int(os.environ.get('XIM_COMPUTE_PORT', '18794'))), Worker)
        server.serve_forever()
