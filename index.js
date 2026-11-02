import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const MAX_ACTIVE_DOWNLOADS = 3;
const PUBLIC_PAGE = new URL('./public/index.html', import.meta.url);
let activeDownloads = 0;

function isPublicIPv4(address) {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255) return false;
  return true;
}

function ipv6Words(address) {
  let text = address.toLowerCase().split('%')[0];
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = text.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map(Number);
    text = `${text.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const parts = text.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const zeros = 8 - left.length - right.length;
  if ((parts.length === 1 && zeros !== 0) || (parts.length === 2 && zeros < 1)) return null;
  const words = [...left, ...Array(zeros).fill('0'), ...right].map(x => parseInt(x || '0', 16));
  return words.length === 8 && words.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? words : null;
}

function isPublicIPv6(address) {
  const words = ipv6Words(address);
  if (!words) return false;
  // Only accept global-unicast 2000::/3, excluding transition and documentation blocks.
  if (words[0] < 0x2000 || words[0] > 0x3fff) return false;
  if (words[0] === 0x2001 && (words[1] === 0x0db8 || words[1] === 0x0000 || words[1] === 0x0010)) return false;
  if (words[0] === 0x2002) return false; // 6to4
  return true;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

async function validateAndResolve(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error('Enter a valid direct media URL.'); }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP and HTTPS URLs are allowed.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.');
  if (url.hash) url.hash = '';
  if (url.port && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))) {
    throw new Error('Only standard HTTP/HTTPS ports are allowed.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.test') || hostname.endsWith('.invalid')) {
    throw new Error('Local or reserved hostnames are not allowed.');
  }

  let addresses;
  if (net.isIP(hostname)) addresses = [{ address: hostname, family: net.isIP(hostname) }];
  else {
    try { addresses = await dns.lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new Error('The media host could not be resolved.'); }
  }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    throw new Error('The URL must resolve only to public internet addresses.');
  }

  return { url, hostname, address: addresses[0].address, family: addresses[0].family };
}

function requestUpstream(target) {
  const { url, hostname, address, family } = target;
  const transport = url.protocol === 'https:' ? https : http;
  const requestOptions = {
    hostname,
    port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname || '/'}${url.search}`,
    method: 'GET',
    headers: { Accept: 'video/*, audio/*, application/octet-stream, */*;q=0.1', 'User-Agent': 'DirectMediaDownload/1.0' },
    lookup: (_host, options, callback) => {
      if (options && options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    },
  };
  if (url.protocol === 'https:' && !net.isIP(hostname)) requestOptions.servername = hostname;

  return new Promise((resolve, reject) => {
    const req = transport.request(requestOptions, resolve);
    req.setTimeout(30_000, () => req.destroy(new Error('The media host timed out.')));
    req.once('error', reject);
    req.end();
  });
}

async function openMedia(rawUrl, redirects = 0) {
  const target = await validateAndResolve(rawUrl);
  const upstream = await requestUpstream(target);
  const status = upstream.statusCode || 0;
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = upstream.headers.location;
    upstream.resume();
    if (!location) throw new Error('The media host returned an invalid redirect.');
    if (redirects >= MAX_REDIRECTS) throw new Error('Too many redirects.');
    const nextUrl = new URL(location, target.url).href;
    return openMedia(nextUrl, redirects + 1);
  }
  if (status < 200 || status >= 300) {
    upstream.resume();
    throw new Error(`The media host returned HTTP ${status}.`);
  }
  return { target, upstream };
}

function cleanFilename(url) {
  let name;
  try { name = decodeURIComponent(path.posix.basename(url.pathname)); }
  catch { name = path.posix.basename(url.pathname); }
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '').trim();
  if (!name || name === '.' || name === '..') name = 'media-file';
  if (name.length > 160) name = name.slice(0, 160);
  return name;
}

function sendJson(res, status, message) {
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify({ error: message });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function handleDownload(req, res, requestUrl) {
  if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) return sendJson(res, 429, 'The server is busy; try again shortly.');
  const rawUrl = requestUrl.searchParams.get('url');
  if (!rawUrl || rawUrl.length > 8192) return sendJson(res, 400, 'Provide one direct media-file URL.');

  activeDownloads += 1;
  try {
    const { target, upstream } = await openMedia(rawUrl);
    const rawType = (upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const isMedia = /^video\/[a-z0-9.+-]+$/.test(rawType) || /^audio\/[a-z0-9.+-]+$/.test(rawType) || rawType === 'application/octet-stream' || rawType === 'binary/octet-stream';
    if (!isMedia) {
      upstream.resume();
      return sendJson(res, 415, `The URL did not return a direct video/audio file (received ${rawType || 'unknown content type'}).`);
    }

    const lengthHeader = upstream.headers['content-length'];
    const declaredLength = lengthHeader ? Number(lengthHeader) : NaN;
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
      upstream.resume();
      return sendJson(res, 413, 'The file exceeds the 512 MiB limit.');
    }

    let received = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_BYTES) return callback(new Error('The file exceeds the 512 MiB limit.'));
        callback(null, chunk);
      },
    });
    const filename = cleanFilename(target.url);
    const fallback = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'media-file';
    const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const headers = {
      'Content-Type': rawType,
      'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (Number.isFinite(declaredLength) && declaredLength >= 0) headers['Content-Length'] = String(declaredLength);
    res.writeHead(200, headers);
    await pipeline(upstream, limit, res);
  } catch (error) {
    if (!res.headersSent) sendJson(res, 502, error.message || 'The download failed.');
    else res.destroy(error);
  } finally {
    activeDownloads -= 1;
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && requestUrl.pathname === '/') {
    try {
      const html = await readFile(PUBLIC_PAGE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(html);
    } catch { sendJson(res, 500, 'The page could not be loaded.'); }
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/api/download') {
    await handleDownload(req, res, requestUrl);
    return;
  }
  sendJson(res, 404, 'Not found.');
});

server.listen(PORT, HOST, () => console.log(`Direct media downloader listening on ${HOST}:${PORT}`));
