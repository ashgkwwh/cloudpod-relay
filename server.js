'use strict';
/**
 * CloudPod 云手机后端（混合模式）
 *  - 手机端 agent 通过 WebSocket 连上来，推送真实屏幕帧 + 接收触摸/按键
 *  - 客户端 APK 通过 HTTP(MJPEG) 拉流、HTTP POST 发指令
 *  - 无主机连入时，自动回退到演示画面（保证服务永远可用）
 */
const http = require('http');
const path = require('path');
const { spawn, execFile } = require('child_process');
const WebSocket = require('ws');
const PureImage = require('pureimage');
const { PassThrough } = require('stream');

const PORT = process.env.PORT || 8080;
const BOUND_IP = process.env.BOUND_IP || '0.0.0.0';

function getFont(weight) {
  const base = path.join(__dirname, 'fonts', 'DejaVuSans');
  return weight === 'bold' ? base + '-Bold.ttf' : base + '.ttf';
}

// ---------- 主机注册表（手机 agent）----------
const hosts = { android: null, windows: null };

function registerHost(mode, ws) {
  hosts[mode] = { ws, frameBuf: null, last: Date.now() };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const h = hosts[mode];
      if (h && h.ws === ws) { h.frameBuf = Buffer.from(data); h.last = Date.now(); }
    } else {
      console.log(`[host ${mode}] ${data.toString().slice(0, 80)}`);
    }
  });
  ws.on('close', () => { if (hosts[mode] && hosts[mode].ws === ws) hosts[mode] = null; });
  console.log(`[host] 手机主机已连入 (${mode})`);
}

function pushInputToHost(mode, cmd) {
  const h = hosts[mode];
  if (h && h.ws && h.ws.readyState === WebSocket.OPEN) {
    h.ws.send(cmd);
    return true;
  }
  return false;
}

// ---------- 演示画面（无主机时回退）----------
const W = 720, H = 1280;
function drawDemo(mode) {
  const img = PureImage.make(W, H);
  const c = img.getContext('2d');
  const dark = mode === 'windows';
  c.fillStyle = dark ? '#0a3a66' : '#0d1b2a';
  c.fillRect(0, 0, W, H);
  c.fillStyle = dark ? '#1a73e8' : '#056ccd';
  c.fillRect(0, 0, W, dark ? 60 : 14);
  try { c.font = PureImage.registerFont(getFont('bold'), 'bf'); c.font.size = 54; } catch (e) { c.font = '54px'; }
  c.fillStyle = '#e3f2fd';
  c.fillText(dark ? '云电脑 (Windows)' : '云手机 (Android)', 60, 160);
  const t = new Date();
  c.fillStyle = '#9ec5fe';
  try { c.font = PureImage.registerFont(getFont(), 'rf'); c.font.size = 40; } catch (e) { c.font = '40px'; }
  c.fillText(`${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`, 60, 260);
  c.fillText('混合云模式 · 等待手机主机', 60, 340);
  c.fillStyle = '#6c757d';
  c.fillText('演示画面 · 接入真机后显示实拍屏幕', 60, 420);
  return new Promise((resolve) => {
    const out = [];
    const stream = new PassThrough();
    stream.on('data', (chunk) => out.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(out)));
    PureImage.encodeJPEGToStream(img, stream, { quality: 80 });
  });
}

// ---------- 本地 adb 设备抓屏（可选回退）----------
function hasLocalAdbDevice() {
  try {
    const out = require('child_process').execSync('adb get-state 2>/dev/null').toString();
    return out.trim() === 'device';
  } catch (e) { return false; }
}
function startAdbCapture(mode, res) {
  const p = spawn('adb', ['exec-out', 'screenrecord', '--output-format=h264', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const ff = spawn('ffmpeg', ['-fflags', 'nobuffer', '-flags', 'low_delay', '-f', 'h264', '-i', '-', '-vf', `scale=${W}:-2`, '-q:v', '5', '-f', 'mjpeg', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  p.stdout.pipe(ff.stdin);
  let buf = Buffer.alloc(0);
  ff.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let start;
    while ((start = buf.indexOf(Buffer.from([0xff, 0xd8]))) >= 0) {
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start);
      if (end < 0) break;
      const frame = buf.slice(start, end + 2);
      buf = buf.slice(end + 2);
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
    }
  });
  return () => { try { p.kill(); ff.kill(); } catch (e) {} };
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>CloudPod 后端运行中</h2>
<p>混合云模式：手机端 agent 通过 WebSocket 连入后，返回 <b>真实屏幕</b>；否则回退演示画面。</p>
<p>当前主机状态：云手机=${hosts.android ? '已连入' : '未连接'} / 云电脑=${hosts.windows ? '已连入' : '未连接'}</p>
<p>端点：<code>/android/stream</code> <code>/windows/stream</code> <code>/android/input</code> <code>/api/devices</code></p>`);
    return;
  }

  if (url === '/api/devices') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      android: hosts.android ? 'phone-host' : (hasLocalAdbDevice() ? 'local-adb' : 'demo'),
      windows: hosts.windows ? 'phone-host' : 'demo',
    }));
    return;
  }

  const m = url.match(/^\/(android|windows)\/stream$/);
  if (m) {
    const mode = m[1];
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    if (hosts[mode] && hosts[mode].frameBuf) {
      const h = hosts[mode];
      const timer = setInterval(() => {
        if (!h.frameBuf) return;
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${h.frameBuf.length}\r\n\r\n`);
        res.write(h.frameBuf);
        res.write('\r\n');
      }, 1000 / 15);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (hasLocalAdbDevice()) {
      const stop = startAdbCapture(mode, res);
      req.on('close', stop);
      return;
    }
    const timer = setInterval(async () => {
      try {
        const jpg = await drawDemo(mode);
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`);
        res.write(jpg);
        res.write('\r\n');
      } catch (e) {}
    }, 1000 / 12);
    req.on('close', () => clearInterval(timer));
    return;
  }

  const im = url.match(/^\/(android|windows)\/input$/);
  if (im && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const mode = im[1];
      const cmd = decodeURIComponent(body);
      if (pushInputToHost(mode, cmd)) { res.writeHead(200); res.end('relayed'); return; }
      if (hasLocalAdbDevice()) { applyAdbInput(cmd); res.writeHead(200); res.end('adb'); return; }
      res.writeHead(200); res.end('demo-ignored');
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

function applyAdbInput(cmd) {
  if (cmd === 'home') return execFile('adb', ['shell', 'input', 'keyevent', '3']);
  if (cmd === 'back') return execFile('adb', ['shell', 'input', 'keyevent', '4']);
  if (cmd === 'recents') return execFile('adb', ['shell', 'input', 'keyevent', '187']);
  if (cmd === 'power') return execFile('adb', ['shell', 'input', 'keyevent', '26']);
  const t = cmd.match(/^tap (\d+\.?\d*) (\d+\.?\d*)$/);
  if (t) return execFile('adb', ['shell', 'input', 'tap', Math.round(t[1] * W), Math.round(t[2] * H)]);
  const s = cmd.match(/^swipe (\d+\.?\d*) (\d+\.?\d*) (\d+\.?\d*) (\d+\.?\d*)$/);
  if (s) return execFile('adb', ['shell', 'input', 'swipe', Math.round(s[1] * W), Math.round(s[2] * H), Math.round(s[3] * W), Math.round(s[4] * H)]);
}

// ---------- WebSocket：手机主机接入 ----------
const wss = new WebSocket.Server({ server, path: '/host' });
wss.on('connection', (ws, req) => {
  let mode = 'android';
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    if (q.get('mode') === 'windows') mode = 'windows';
  } catch (e) {}
  ws.on('message', (data, isBinary) => {
    if (!isBinary && data.toString().startsWith('{')) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'register') { mode = msg.mode || mode; registerHost(mode, ws); }
        return;
      } catch (e) {}
    }
    if (isBinary) {
      const h = hosts[mode];
      if (h && h.ws === ws) { h.frameBuf = Buffer.from(data); h.last = Date.now(); }
    }
  });
  ws.send(JSON.stringify({ type: 'welcome', note: 'connect with ?mode=android|windows' }));
});

server.listen(PORT, BOUND_IP, () => {
  console.log(`CloudPod 混合后端已启动: http://${BOUND_IP}:${PORT}`);
  console.log(`手机主机接入: ws://<this-host>/host?mode=android`);
});
