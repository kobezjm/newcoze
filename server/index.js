const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 5299);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SANDBOX_BASE_URL = (process.env.SANDBOX_BASE_URL || '').replace(/\/+$/, '');
const SANDBOX_API_TOKEN = process.env.SANDBOX_API_TOKEN || '';
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'newbolt-sandbox:mvp';
const SANDBOX_NETWORK = process.env.SANDBOX_NETWORK || '';
const ALLOW_SANDBOX_BUILD = process.env.ALLOW_SANDBOX_BUILD === '1';
const APP_IN_DOCKER = process.env.APP_IN_DOCKER === '1';
const DOCKER_VIA_SOCKET = process.env.DOCKER_VIA_SOCKET === '1';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const CLAUDE_FALLBACK = process.env.CLAUDE_FALLBACK === '1';
const CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
const SANDBOX_EXEC_USER = process.env.SANDBOX_EXEC_USER || 'agent';
const SANDBOX_ENV_PASSTHROUGH = (process.env.SANDBOX_ENV_PASSTHROUGH ||
  'ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_MODEL,ANTHROPIC_DEFAULT_HAIKU_MODEL,ANTHROPIC_DEFAULT_SONNET_MODEL,ANTHROPIC_DEFAULT_OPUS_MODEL,CLAUDE_CODE_OAUTH_TOKEN,CLAUDE_MODEL,CLAUDE_CODE_SUBAGENT_MODEL,HTTPS_PROXY,HTTP_PROXY,NO_PROXY')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const CONTAINER_PREFIX = 'newbolt-mvp-ws-';
const PREVIEW_PORT = 5173;

fs.mkdirSync(DATA_DIR, { recursive: true });

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

let sandboxImageChecked = false;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function notFound(res) {
  text(res, 404, 'Not found');
}

function fetchInit(method, headers, body) {
  return {
    method,
    headers,
    body,
    ...(body && typeof body.pipe === 'function' ? { duplex: 'half' } : {})
  };
}

async function sandboxRequest(pathname, options = {}) {
  if (!SANDBOX_BASE_URL) {
    throw new Error('SANDBOX_BASE_URL is not configured');
  }

  const response = await fetch(`${SANDBOX_BASE_URL}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(SANDBOX_API_TOKEN ? { Authorization: `Bearer ${SANDBOX_API_TOKEN}` } : {}),
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

async function proxySandboxStream(pathname, payload, res) {
  const response = await fetch(`${SANDBOX_BASE_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(SANDBOX_API_TOKEN ? { Authorization: `Bearer ${SANDBOX_API_TOKEN}` } : {})
    },
    body: JSON.stringify(payload || {})
  });

  res.writeHead(response.status, {
    'Content-Type': response.headers.get('content-type') || 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  });

  if (response.body) {
    Readable.fromWeb(response.body).pipe(res);
  } else {
    res.end();
  }
}

async function proxySandboxHttp(req, res, pathname) {
  const current = new URL(req.url, `http://${req.headers.host}`);
  const target = `${SANDBOX_BASE_URL}${pathname}${current.search}`;
  const headers = { ...req.headers };
  delete headers.host;
  if (SANDBOX_API_TOKEN) headers.authorization = `Bearer ${SANDBOX_API_TOKEN}`;

  const upstream = await fetch(target, fetchInit(
    req.method,
    headers,
    req.method === 'GET' || req.method === 'HEAD' ? undefined : req
  ));

  const outHeaders = Object.fromEntries(upstream.headers.entries());
  res.writeHead(upstream.status, outHeaders);
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

function sandboxHttpTarget(pathname, search = '') {
  const target = new URL(`${SANDBOX_BASE_URL}${pathname}${search}`);
  return target;
}

async function proxyRuntimeHttp(req, res, url) {
  if (!SANDBOX_BASE_URL) {
    notFound(res);
    return;
  }

  const runtimePrefix = '/api/runtime';
  const pathname = url.pathname.slice(runtimePrefix.length) || '/';
  const target = `${SANDBOX_BASE_URL}${pathname}${url.search}`;
  const headers = { ...req.headers };
  delete headers.host;
  if (SANDBOX_API_TOKEN) headers.authorization = `Bearer ${SANDBOX_API_TOKEN}`;
  let body = req.method === 'GET' || req.method === 'HEAD' || Number(headers['content-length'] || 0) === 0 ? undefined : req;

  const previewStartMatch = pathname.match(/^\/v1\/workspaces\/([a-z0-9-]{6,64})\/preview\/start$/);
  if (previewStartMatch && req.method === 'POST') {
    const payload = await parseBody(req);
    body = JSON.stringify({
      ...payload,
      publicBasePath: payload.publicBasePath || `/api/runtime/v1/workspaces/${previewStartMatch[1]}/preview/`
    });
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
  }

  const upstream = await fetch(target, fetchInit(req.method, headers, body));

  const deployMatch = pathname.match(/^\/v1\/workspaces\/([a-z0-9-]{6,64})\/deploy$/);
  if (deployMatch && req.method === 'POST') {
    const textBody = await upstream.text();
    if (!upstream.ok) {
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      res.end(textBody);
      return;
    }

    const payload = JSON.parse(textBody || '{}');
    json(res, upstream.status, {
      ...payload,
      url: `/api/runtime/v1/workspaces/${deployMatch[1]}/deployments/${payload.deployId}/`
    });
    return;
  }

  const outHeaders = Object.fromEntries(upstream.headers.entries());
  res.writeHead(upstream.status, outHeaders);
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

function proxyWebSocket(clientSocket, head, targetUrl, requestHeaders = {}) {
  const port = Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80));
  const upstream = net.connect(port, targetUrl.hostname, () => {
    const headers = {
      ...requestHeaders,
      Host: targetUrl.host
    };

    const lines = [`GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      lines.push(`${key}: ${value}`);
    }
    lines.push('', '');

    upstream.write(lines.join('\r\n'));
    if (head?.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });

  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
}

function handleSandboxWebSocket(req, socket, head) {
  if (!SANDBOX_BASE_URL) return false;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const runtimeMatch = url.pathname.match(/^\/api\/runtime\/v1\/workspaces\/([a-z0-9-]{6,64})\/preview(\/.*)?$/);
  if (runtimeMatch) {
    const id = runtimeMatch[1];
    const rest = runtimeMatch[2] || '/';
    const target = sandboxHttpTarget(`/v1/workspaces/${id}/preview${rest}`, url.search);
    const headers = { ...req.headers };
    if (SANDBOX_API_TOKEN) headers.authorization = `Bearer ${SANDBOX_API_TOKEN}`;
    proxyWebSocket(socket, head, target, headers);
    return true;
  }

  const match = url.pathname.match(/^\/api\/workspaces\/([a-z0-9-]{6,64})\/preview(\/.*)?$/);
  if (!match) return false;

  const id = match[1];
  const rest = match[2] || '/';
  const target = sandboxHttpTarget(`/v1/workspaces/${id}/preview${rest}`, url.search);
  const headers = { ...req.headers };
  if (SANDBOX_API_TOKEN) headers.authorization = `Bearer ${SANDBOX_API_TOKEN}`;
  proxyWebSocket(socket, head, target, headers);
  return true;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const stdout = [];
    const stderr = [];

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0 && !options.allowFailure) {
        const error = new Error(err || out || `${command} exited with ${code}`);
        error.code = code;
        error.stdout = out;
        error.stderr = err;
        reject(error);
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

function docker(args, options = {}) {
  return run('docker', args, options);
}

function sandboxEnv() {
  const env = [
    'TERM=xterm-256color',
    'LANG=C.UTF-8',
    'LC_ALL=C.UTF-8',
    `CLAUDE_FALLBACK=${CLAUDE_FALLBACK ? '1' : '0'}`,
    `CLAUDE_PERMISSION_MODE=${CLAUDE_PERMISSION_MODE}`
  ];

  for (const key of SANDBOX_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value) env.push(`${key}=${value}`);
  }

  return env;
}

function dockerPath(value) {
  return encodeURIComponent(value);
}

function dockerApi(method, apiPath, body, options = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const headers = {};

    if (Buffer.isBuffer(body)) {
      payload = body;
      headers['Content-Type'] = options.contentType || 'application/octet-stream';
    } else if (body !== undefined && body !== null) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
    }

    if (payload) {
      headers['Content-Length'] = payload.length;
    }

    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        method,
        path: apiPath,
        headers
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const result = {
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks)
          };

          if (response.statusCode >= 400 && !options.allowFailure) {
            reject(new Error(result.body.toString('utf8') || `Docker API ${method} ${apiPath} failed with ${response.statusCode}`));
            return;
          }

          resolve(result);
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseDockerJson(result) {
  const textBody = result.body.toString('utf8');
  return textBody ? JSON.parse(textBody) : {};
}

function demuxDockerStream(buffer) {
  let offset = 0;
  let stdout = '';
  let stderr = '';

  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);

    if (![0, 1, 2].includes(stream) || size < 0 || offset + 8 + size > buffer.length) {
      return { stdout: buffer.toString('utf8'), stderr: '' };
    }

    const textBody = buffer.slice(offset + 8, offset + 8 + size).toString('utf8');
    if (stream === 2) stderr += textBody;
    else stdout += textBody;
    offset += 8 + size;
  }

  if (offset < buffer.length) {
    stdout += buffer.slice(offset).toString('utf8');
  }

  return { stdout, stderr };
}

function createDockerFrameParser(onFrame) {
  let buffer = Buffer.alloc(0);
  let rawMode = false;

  return (chunk) => {
    if (rawMode) {
      onFrame(1, chunk.toString('utf8'));
      return;
    }

    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 8) {
      const stream = buffer[0];
      const size = buffer.readUInt32BE(4);

      if (![0, 1, 2].includes(stream) || size > 20 * 1024 * 1024) {
        rawMode = true;
        onFrame(1, buffer.toString('utf8'));
        buffer = Buffer.alloc(0);
        return;
      }

      if (buffer.length < 8 + size) return;

      onFrame(stream, buffer.slice(8, 8 + size).toString('utf8'));
      buffer = buffer.slice(8 + size);
    }
  };
}

function tarString(buffer, offset, length, value) {
  buffer.write(String(value).slice(0, length), offset, length, 'utf8');
}

function tarOctal(buffer, offset, length, value) {
  const octal = value.toString(8).padStart(length - 1, '0').slice(-(length - 1));
  buffer.write(octal, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function splitTarName(name) {
  if (Buffer.byteLength(name) <= 100) {
    return { name, prefix: '' };
  }

  const parts = name.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const rest = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) {
      return { name: rest, prefix };
    }
  }

  throw new Error(`Path is too long for tar upload: ${name}`);
}

function createTar(files) {
  const chunks = [];

  for (const file of files) {
    const content = Buffer.from(file.content || '', 'utf8');
    const header = Buffer.alloc(512, 0);
    const names = splitTarName(file.name);

    tarString(header, 0, 100, names.name);
    tarOctal(header, 100, 8, 0o644);
    tarOctal(header, 108, 8, 0);
    tarOctal(header, 116, 8, 0);
    tarOctal(header, 124, 12, content.length);
    tarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    tarString(header, 257, 6, 'ustar');
    tarString(header, 263, 2, '00');
    tarString(header, 345, 155, names.prefix);

    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, '0');
    header.write(checksumText, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;

    chunks.push(header, content);

    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }

  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

async function dockerImageExists(image) {
  if (!DOCKER_VIA_SOCKET) {
    const inspect = await docker(['image', 'inspect', image], { allowFailure: true });
    return inspect.code === 0;
  }

  const result = await dockerApi('GET', `/images/${dockerPath(image)}/json`, null, { allowFailure: true });
  return result.status === 200;
}

async function dockerContainerInspect(name) {
  if (!DOCKER_VIA_SOCKET) {
    const existing = await docker(['inspect', '-f', '{{json .}}', name], { allowFailure: true });
    if (existing.code !== 0) return null;
    return JSON.parse(existing.stdout);
  }

  const result = await dockerApi('GET', `/containers/${dockerPath(name)}/json`, null, { allowFailure: true });
  if (result.status === 404) return null;
  if (result.status >= 400) {
    throw new Error(result.body.toString('utf8') || `Docker inspect failed for ${name}`);
  }
  return parseDockerJson(result);
}

async function dockerStartContainer(name) {
  if (!DOCKER_VIA_SOCKET) {
    await docker(['start', name]);
    return;
  }

  await dockerApi('POST', `/containers/${dockerPath(name)}/start`, null, { allowFailure: true });
}

async function dockerCreateAndStartSandbox(id) {
  const name = containerName(id);

  if (!DOCKER_VIA_SOCKET) {
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `newbolt.workspace=${id}`,
      '-w',
      '/workspace',
      '-v',
      `${volumeName(id)}:/workspace`
    ];

    for (const entry of sandboxEnv()) {
      args.push('-e', entry);
    }

    if (SANDBOX_NETWORK) {
      args.push('--network', SANDBOX_NETWORK);
    } else {
      args.push('-p', `127.0.0.1::${PREVIEW_PORT}`);
      args.push('-p', '127.0.0.1::3000');
      args.push('-p', '127.0.0.1::4173');
    }

    args.push('--user', '0:0');
    args.push(SANDBOX_IMAGE, 'sh', '-lc', `mkdir -p /workspace && chown -R ${shellUserGroup(SANDBOX_EXEC_USER)} /workspace 2>/dev/null || true; tail -f /dev/null`);
    await docker(args);
    return;
  }

  const hostConfig = {
    Binds: [`${volumeName(id)}:/workspace`]
  };

  if (SANDBOX_NETWORK) {
    hostConfig.NetworkMode = SANDBOX_NETWORK;
  } else {
    hostConfig.PortBindings = {
      [`${PREVIEW_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }],
      '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
      '4173/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }]
    };
  }

  await dockerApi('POST', `/containers/create?name=${dockerPath(name)}`, {
    Image: SANDBOX_IMAGE,
    WorkingDir: '/workspace',
    Env: sandboxEnv(),
    Labels: {
      'newbolt.workspace': id
    },
    Cmd: ['sh', '-lc', `mkdir -p /workspace && chown -R ${shellUserGroup(SANDBOX_EXEC_USER)} /workspace 2>/dev/null || true; tail -f /dev/null`],
    User: '0:0',
    HostConfig: hostConfig
  });
  await dockerStartContainer(name);
}

async function dockerExecCommand(name, command, options = {}) {
  if (!DOCKER_VIA_SOCKET) {
    const args = ['exec', '-i'];
    if (options.user) args.push('-u', options.user);
    else if (SANDBOX_EXEC_USER) args.push('-u', SANDBOX_EXEC_USER);
    args.push(name, 'sh', '-lc', command);
    return run('docker', args, options);
  }

  const create = await dockerApi('POST', `/containers/${dockerPath(name)}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: options.user || SANDBOX_EXEC_USER,
    WorkingDir: '/workspace',
    Cmd: ['sh', '-lc', command]
  });
  const execId = parseDockerJson(create).Id;
  const started = await dockerApi('POST', `/exec/${dockerPath(execId)}/start`, {
    Detach: false,
    Tty: false
  });
  const inspected = await dockerApi('GET', `/exec/${dockerPath(execId)}/json`);
  const exitCode = parseDockerJson(inspected).ExitCode ?? 0;
  const output = demuxDockerStream(started.body);

  if (exitCode !== 0 && !options.allowFailure) {
    const error = new Error(output.stderr || output.stdout || `Command exited with ${exitCode}`);
    error.code = exitCode;
    error.stdout = output.stdout;
    error.stderr = output.stderr;
    throw error;
  }

  return { code: exitCode, stdout: output.stdout, stderr: output.stderr };
}

async function streamDockerExec(name, command, res) {
  if (!DOCKER_VIA_SOCKET) {
    const args = ['exec', '-i'];
    if (SANDBOX_EXEC_USER) args.push('-u', SANDBOX_EXEC_USER);
    args.push(name, 'sh', '-lc', command);
    const child = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return child;
  }

  const create = await dockerApi('POST', `/containers/${dockerPath(name)}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: SANDBOX_EXEC_USER,
    WorkingDir: '/workspace',
    Cmd: ['sh', '-lc', command]
  });
  const execId = parseDockerJson(create).Id;

  const parser = createDockerFrameParser((stream, data) => {
    res.write(`${JSON.stringify({ type: stream === 2 ? 'stderr' : 'stdout', data })}\n`);
  });

  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        method: 'POST',
        path: `/exec/${dockerPath(execId)}/start`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length
        }
      },
      (response) => {
        response.on('data', parser);
        response.on('end', async () => {
          const inspected = await dockerApi('GET', `/exec/${dockerPath(execId)}/json`);
          resolve(parseDockerJson(inspected).ExitCode ?? 0);
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function dockerUploadFile(name, filePath, content) {
  const safe = safeWorkspacePath(filePath);
  const parent = path.posix.dirname(safe);
  if (parent && parent !== '.') {
    await dockerExecCommand(name, `mkdir -p ${shellQuote(`/workspace/${parent}`)}`);
  }

  if (!DOCKER_VIA_SOCKET) {
    const target = `/workspace/${safe}`;
    const script = 'target="$1"; mkdir -p "$(dirname "$target")"; cat > "$target"';
    await run('docker', ['exec', '-i', name, 'sh', '-lc', script, 'sh', target], {
      stdin: String(content || '')
    });
    return;
  }

  const archive = createTar([{ name: safe, content: String(content || '') }]);
  await dockerApi(
    'PUT',
    `/containers/${dockerPath(name)}/archive?path=${encodeURIComponent('/workspace')}`,
    archive,
    { contentType: 'application/x-tar' }
  );
  await dockerExecCommand(name, `chown -R ${shellUserGroup(SANDBOX_EXEC_USER)} ${shellQuote(`/workspace/${safe}`)} 2>/dev/null || true`, { user: '0:0', allowFailure: true });
}

async function dockerMappedPort(name, port) {
  if (!DOCKER_VIA_SOCKET) {
    const result = await docker(['port', name, `${port}/tcp`]);
    const first = result.stdout.trim().split(/\r?\n/)[0];
    return first.replace(/^0\.0\.0\.0:/, '127.0.0.1:').replace(/^\[::\]:/, '127.0.0.1:');
  }

  const inspected = await dockerContainerInspect(name);
  const bindings = inspected?.NetworkSettings?.Ports?.[`${port}/tcp`];
  if (!bindings || !bindings[0]) {
    throw new Error(`Sandbox port ${port} is not published`);
  }

  const hostIp = bindings[0].HostIp === '0.0.0.0' || bindings[0].HostIp === '::' ? '127.0.0.1' : bindings[0].HostIp;
  return `${hostIp}:${bindings[0].HostPort}`;
}

function workspaceId() {
  return crypto.randomBytes(4).toString('hex');
}

function assertWorkspaceId(id) {
  if (!/^[a-z0-9-]{6,64}$/.test(id || '')) {
    throw new Error('Invalid workspace id');
  }
}

function containerName(id) {
  assertWorkspaceId(id);
  return `${CONTAINER_PREFIX}${id}`;
}

function volumeName(id) {
  assertWorkspaceId(id);
  return `newbolt_ws_${id.replace(/-/g, '_')}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellUserGroup(user) {
  const value = String(user || 'root');
  if (/^[a-zA-Z0-9_.-]+$/.test(value)) {
    return `${value}:${value}`;
  }
  return `${shellQuote(value)}:${shellQuote(value)}`;
}

function safeWorkspacePath(input) {
  const raw = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error('Invalid file path');
  }
  if (normalized.includes('\0')) {
    throw new Error('Invalid file path');
  }
  return normalized;
}

async function ensureSandboxImage() {
  if (sandboxImageChecked) return;

  if (await dockerImageExists(SANDBOX_IMAGE)) {
    sandboxImageChecked = true;
    return;
  }

  if (!ALLOW_SANDBOX_BUILD) {
    throw new Error(`Sandbox image ${SANDBOX_IMAGE} is missing. Build it first or set ALLOW_SANDBOX_BUILD=1.`);
  }

  await docker(['build', '-t', SANDBOX_IMAGE, '-f', 'sandbox/Dockerfile', '.'], {
    cwd: path.join(__dirname, '..')
  });
  sandboxImageChecked = true;
}

async function ensureSandbox(id) {
  assertWorkspaceId(id);
  await ensureSandboxImage();

  const name = containerName(id);
  const existing = await dockerContainerInspect(name);

  if (existing) {
    if (!existing.State?.Running) {
      await dockerStartContainer(name);
    }
    return name;
  }

  await dockerCreateAndStartSandbox(id);
  await seedWorkspace(id);
  return name;
}

async function seedWorkspace(id) {
  const name = containerName(id);
  const script = [
    'mkdir -p /workspace/.newbolt',
    'touch /workspace/.newbolt/seeded',
    `chown -R ${shellUserGroup(SANDBOX_EXEC_USER)} /workspace 2>/dev/null || true`
  ].join('\n');
  await dockerExecCommand(name, script, { user: '0:0' });
}

async function execInSandbox(id, command, options = {}) {
  const name = await ensureSandbox(id);
  return dockerExecCommand(name, command, options);
}

function streamSandboxCommand(id, command, res) {
  return new Promise(async (resolve) => {
    const name = await ensureSandbox(id);

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive'
    });

    function send(event) {
      res.write(`${JSON.stringify(event)}\n`);
    }

    send({ type: 'status', message: '沙箱已就绪' });

    if (DOCKER_VIA_SOCKET) {
      try {
        const code = await streamDockerExec(name, command, res);
        send({ type: 'done', exitCode: code });
      } catch (error) {
        send({ type: 'error', message: error.message });
      } finally {
        res.end();
        resolve();
      }
      return;
    }

    const child = await streamDockerExec(name, command, res);
    child.stdin.end();
    child.stdout.on('data', (chunk) => send({ type: 'stdout', data: chunk.toString('utf8') }));
    child.stderr.on('data', (chunk) => send({ type: 'stderr', data: chunk.toString('utf8') }));
    child.on('error', (error) => {
      send({ type: 'error', message: error.message });
      res.end();
      resolve();
    });
    child.on('close', (code) => {
      send({ type: 'done', exitCode: code });
      res.end();
      resolve();
    });
  });
}

async function listFiles(id) {
  const command = [
    'find .',
    "-path './.newbolt' -prune -o",
    "-path './node_modules' -prune -o",
    "-path './.git' -prune -o",
    "-path './.vscode' -prune -o",
    '-type f -maxdepth 6 -print',
    "| sed 's#^./##'",
    '| sort',
    '| head -300'
  ].join(' ');
  const result = await execInSandbox(id, command, { allowFailure: true });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => ({ path: file, name: path.posix.basename(file) }));
}

async function readSandboxFile(id, filePath) {
  const safe = safeWorkspacePath(filePath);
  const result = await execInSandbox(id, `cat -- ${shellQuote(`/workspace/${safe}`)}`);
  return result.stdout;
}

async function writeSandboxFile(id, filePath, content) {
  const name = await ensureSandbox(id);
  await dockerUploadFile(name, filePath, content);
}

async function startPreview(id) {
  const previewBase = `/api/workspaces/${id}/preview/`;
  const portCheck = `node -e "require('net').connect(${PREVIEW_PORT}, '127.0.0.1').on('connect', function(){process.exit(0)}).on('error', function(){process.exit(1)})"`;

  await execInSandbox(id, [
    'mkdir -p .newbolt',
    'has_dev_script() { [ -f package.json ] && node -e "const p=require(\'./package.json\'); process.exit(p.scripts&&p.scripts.dev?0:1)" >/dev/null 2>&1; }',
    'is_vite_project() { [ -f package.json ] && node -e "const p=require(\'./package.json\'); const d=Object.assign({},p.dependencies,p.devDependencies); process.exit(d.vite || /vite/.test((p.scripts&&p.scripts.dev)||\'\') ? 0 : 1)" >/dev/null 2>&1; }',
    `if has_dev_script && command -v pgrep >/dev/null 2>&1 && pgrep -f "newbolt-preview ${PREVIEW_PORT}" >/dev/null 2>&1; then`,
    `  pkill -f "newbolt-preview ${PREVIEW_PORT}" 2>/dev/null || true`,
    '  sleep 0.3',
    'fi',
    `if ${portCheck}; then exit 0; fi`,
    'rm -f .newbolt/preview.log',
    'if has_dev_script; then',
    '  echo "启动项目开发服务器..." > .newbolt/preview.log',
    '  if [ ! -d node_modules ] && command -v npm >/dev/null 2>&1; then',
    '    echo "安装项目依赖..." >> .newbolt/preview.log',
    '    if command -v timeout >/dev/null 2>&1; then',
    '      timeout 180 npm install >> .newbolt/preview.log 2>&1',
    '    else',
    '      npm install >> .newbolt/preview.log 2>&1',
    '    fi',
    '  fi',
    `  dev_args="-- --host 0.0.0.0 --port ${PREVIEW_PORT}"`,
    `  if is_vite_project; then dev_args="$dev_args --base ${previewBase}"; fi`,
    '  nohup npm run dev $dev_args >> .newbolt/preview.log 2>&1 &',
    '  echo "$!" > .newbolt/preview.pid',
    'else',
    `  nohup node /usr/local/bin/newbolt-preview ${PREVIEW_PORT} > .newbolt/preview.log 2>&1 &`,
    '  echo "$!" > .newbolt/preview.pid',
    'fi',
    `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do if ${portCheck}; then exit 0; fi; sleep 0.5; done`,
    'echo "预览启动失败："',
    'tail -80 .newbolt/preview.log 2>/dev/null || true',
    'exit 1'
  ].join('\n'));
}

async function getLocalPreviewBase(id, port) {
  if (APP_IN_DOCKER && SANDBOX_NETWORK) {
    return `http://${containerName(id)}:${port}`;
  }

  return `http://${await dockerMappedPort(containerName(id), port)}`;
}

function previewHeaders(headers) {
  const result = Object.fromEntries(headers.entries());
  delete result['content-length'];
  delete result['content-encoding'];
  delete result['transfer-encoding'];
  return result;
}

function shouldRewritePreviewResponse(contentType) {
  return /text\/html|text\/css|javascript|typescript/.test(contentType || '');
}

function rewritePreviewBody(body, routePrefix) {
  const base = routePrefix.endsWith('/') ? routePrefix : `${routePrefix}/`;

  return body
    .replace(/((?:src|href|action)\s*=\s*["'])\/(?!\/|api\/workspaces\/)/gi, (_match, prefix) => `${prefix}${base}`)
    .replace(/(url\(\s*["']?)\/(?!\/|api\/workspaces\/)/gi, (_match, prefix) => `${prefix}${base}`)
    .replace(/(\bfrom\s*["'])\/(?!\/|api\/workspaces\/)/g, (_match, prefix) => `${prefix}${base}`)
    .replace(/(\bimport\s*["'])\/(?!\/|api\/workspaces\/)/g, (_match, prefix) => `${prefix}${base}`)
    .replace(/(\bimport\s*\(\s*["'])\/(?!\/|api\/workspaces\/)/g, (_match, prefix) => `${prefix}${base}`);
}

async function sendSandboxProxyResponse(upstream, res, rewritePrefix) {
  const headers = previewHeaders(upstream.headers);
  const contentType = headers['content-type'] || '';

  if (rewritePrefix && shouldRewritePreviewResponse(contentType)) {
    const body = rewritePreviewBody(await upstream.text(), rewritePrefix);
    res.writeHead(upstream.status, headers);
    res.end(body);
    return;
  }

  res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

async function proxyToSandbox(req, res, id, routePrefix, port, rewritePrefix = routePrefix) {
  await ensureSandbox(id);
  const base = await getLocalPreviewBase(id, port);
  const current = new URL(req.url, `http://${req.headers.host}`);
  const rest = current.pathname.slice(routePrefix.length) || '/';
  const target = new URL(rest + current.search, base);

  const headers = { ...req.headers };
  delete headers.host;

  const upstream = await fetch(target, fetchInit(
    req.method,
    headers,
    req.method === 'GET' || req.method === 'HEAD' ? undefined : req
  ));

  await sendSandboxProxyResponse(upstream, res, rewritePrefix);
}

async function proxyPreviewRootRequest(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.pathname.startsWith('/api/workspaces/') || url.pathname === '/api/health') return false;

  const referer = req.headers.referer || req.headers.referrer;
  if (!referer) return false;

  let refererUrl;
  try {
    refererUrl = new URL(referer, `http://${req.headers.host}`);
  } catch {
    return false;
  }

  const match = refererUrl.pathname.match(/^\/api\/workspaces\/([a-z0-9-]{6,64})\/preview(?:\/|$)/);
  if (!match) return false;

  const id = match[1];
  if (SANDBOX_BASE_URL) {
    await proxySandboxHttp(req, res, `/v1/workspaces/${id}/preview${url.pathname}`);
    return true;
  }
  await proxyToSandbox(req, res, id, '', PREVIEW_PORT, `/api/workspaces/${id}/preview`);
  return true;
}

async function deployWorkspace(id) {
  const deployId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const script = [
    `deploy=${shellQuote(deployId)}`,
    'dest="/workspace/.newbolt/deployments/$deploy/public"',
    'rm -rf "$dest"',
    'mkdir -p "$dest"',
    'if [ -f package.json ] && node -e "const p=require(\'./package.json\'); process.exit(p.scripts&&p.scripts.build?0:1)" >/dev/null 2>&1; then',
    '  npm run build',
    'fi',
    'if [ -d dist ]; then',
    '  (cd dist && tar -cf - .) | tar -C "$dest" -xf -',
    'else',
    '  tar --exclude=./.newbolt --exclude=./node_modules --exclude=./.git -cf - . | tar -C "$dest" -xf -',
    'fi',
    'echo "$deploy"'
  ].join('\n');
  const result = await execInSandbox(id, script);
  return result.stdout.trim().split(/\r?\n/).pop() || deployId;
}

async function serveDeployment(req, res, id, deployId, routePrefix) {
  if (!/^[0-9]{14}$/.test(deployId)) {
    text(res, 400, 'Invalid deployment id');
    return;
  }

  const current = new URL(req.url, `http://${req.headers.host}`);
  let rel = current.pathname.slice(routePrefix.length) || '/index.html';
  if (rel === '/') rel = '/index.html';
  const safe = safeWorkspacePath(rel);
  const file = `/workspace/.newbolt/deployments/${deployId}/public/${safe}`;
  const exists = await execInSandbox(id, `test -f ${shellQuote(file)}`, { allowFailure: true });

  let target = file;
  if (exists.code !== 0) {
    target = `/workspace/.newbolt/deployments/${deployId}/public/index.html`;
  }

  const result = await execInSandbox(id, `cat -- ${shellQuote(target)}`, { allowFailure: true });
  if (result.code !== 0) {
    notFound(res);
    return;
  }

  const type = contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(result.stdout);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clean = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  const target = path.join(PUBLIC_DIR, clean);

  if (!target.startsWith(PUBLIC_DIR) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    notFound(res);
    return;
  }

  const type = contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(target).pipe(res);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/api/health') {
    if (SANDBOX_BASE_URL) {
      const sandbox = await sandboxRequest('/v1/health');
      json(res, 200, { ok: true, sandboxMode: 'http', sandbox });
      return;
    }
    json(res, 200, { ok: true, sandboxMode: 'docker', sandboxImage: SANDBOX_IMAGE });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/workspaces') {
    if (SANDBOX_BASE_URL) {
      const workspace = await sandboxRequest('/v1/workspaces', { method: 'POST', body: {} });
      json(res, 201, workspace);
      return;
    }
    const id = workspaceId();
    await ensureSandbox(id);
    json(res, 201, { id, name: `Workspace ${id}` });
    return;
  }

  if (parts[0] !== 'api' || parts[1] !== 'workspaces' || !parts[2]) {
    notFound(res);
    return;
  }

  const id = parts[2];
  assertWorkspaceId(id);

  if (req.method === 'GET' && parts[3] === 'files') {
    if (SANDBOX_BASE_URL) {
      json(res, 200, await sandboxRequest(`/v1/workspaces/${id}/files`));
      return;
    }
    json(res, 200, { files: await listFiles(id) });
    return;
  }

  if (req.method === 'GET' && parts[3] === 'file') {
    const file = url.searchParams.get('path');
    if (SANDBOX_BASE_URL) {
      json(res, 200, await sandboxRequest(`/v1/workspaces/${id}/file?path=${encodeURIComponent(file || '')}`));
      return;
    }
    json(res, 200, { path: file, content: await readSandboxFile(id, file) });
    return;
  }

  if (req.method === 'PUT' && parts[3] === 'file') {
    const body = await parseBody(req);
    if (SANDBOX_BASE_URL) {
      json(res, 200, await sandboxRequest(`/v1/workspaces/${id}/file`, { method: 'PUT', body }));
      return;
    }
    await writeSandboxFile(id, body.path, body.content);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && parts[3] === 'commands') {
    const body = await parseBody(req);
    if (SANDBOX_BASE_URL) {
      await proxySandboxStream(`/v1/workspaces/${id}/commands`, { command: String(body.command || 'pwd') }, res);
      return;
    }
    await streamSandboxCommand(id, String(body.command || 'pwd'), res);
    return;
  }

  if (req.method === 'POST' && parts[3] === 'chat') {
    const body = await parseBody(req);
    if (SANDBOX_BASE_URL) {
      await proxySandboxStream(`/v1/workspaces/${id}/chat`, { message: String(body.message || '') }, res);
      return;
    }
    const prompt = String(body.message || '');
    await writeSandboxFile(id, '.newbolt/last-prompt.txt', prompt);
    const agentCommand = [
      'set +e',
      'prompt_file="/workspace/.newbolt/last-prompt.txt"',
      'session_file="/workspace/.newbolt/claude-session-id"',
      'tmp_output="/workspace/.newbolt/claude-last-output.ndjson"',
      'status_file="/workspace/.newbolt/claude-last-status"',
      'fallback="${CLAUDE_FALLBACK:-0}"',
      'permission_mode="${CLAUDE_PERMISSION_MODE:-bypassPermissions}"',
      'model="${CLAUDE_MODEL:-${ANTHROPIC_MODEL:-}}"',
      'model_args=""',
      'if [ -n "$model" ]; then model_args="--model $model"; fi',
      'run_claude() {',
      '  if [ -s "$session_file" ]; then',
      '    claude -p "$(cat "$prompt_file")" --resume "$(cat "$session_file")" $model_args --output-format stream-json --verbose --permission-mode "$permission_mode"',
      '  else',
      '    claude -p "$(cat "$prompt_file")" $model_args --output-format stream-json --verbose --permission-mode "$permission_mode"',
      '  fi',
      '}',
      'extract_session() {',
      '  node -e "const fs=require(\'fs\'); const input=fs.readFileSync(0,\'utf8\').trim().split(/\\n+/); for (const line of input) { try { const item=JSON.parse(line); const id=item.session_id || item.sessionId || (item.message && (item.message.session_id || item.message.sessionId)); if (id) { console.log(id); process.exit(0); } } catch {} } process.exit(1);"',
      '}',
      'if ! command -v claude >/dev/null 2>&1; then',
      '  echo "[newbolt] 未找到 claude 命令，请在沙箱镜像中安装 Claude Code。" >&2',
      '  if [ "$fallback" = "1" ]; then node /usr/local/bin/newbolt-agent < "$prompt_file"; exit $?; fi',
      '  exit 127',
      'fi',
      'rm -f "$tmp_output" "$status_file"',
      '( run_claude; echo "$?" > "$status_file" ) 2>&1 | tee "$tmp_output" | node /usr/local/bin/newbolt-claude-presenter',
      'claude_code="$(cat "$status_file" 2>/dev/null || echo 1)"',
      'case "$claude_code" in ""|*[!0-9]*) claude_code=1;; esac',
      'session_id="$(extract_session < "$tmp_output" || true)"',
      'if [ -n "$session_id" ]; then printf "%s" "$session_id" > "$session_file"; fi',
      'if [ "$claude_code" -eq 0 ]; then',
      '  exit 0',
      'fi',
      'echo "[newbolt] Claude Code 执行失败，退出码 $claude_code。" >&2',
      'if [ "$fallback" = "1" ]; then',
      '  echo "[newbolt] CLAUDE_FALLBACK=1，切换到本地兜底 Agent。" >&2',
      '  node /usr/local/bin/newbolt-agent < "$prompt_file"',
      '  exit $?',
      'fi',
      'exit "$claude_code"'
    ].join('\n');
    await streamSandboxCommand(id, agentCommand, res);
    return;
  }

  if (req.method === 'POST' && parts[3] === 'preview' && parts[4] === 'start') {
    if (SANDBOX_BASE_URL) {
      json(res, 200, await sandboxRequest(`/v1/workspaces/${id}/preview/start`, {
        method: 'POST',
        body: { publicBasePath: `/api/workspaces/${id}/preview/` }
      }));
      return;
    }
    await startPreview(id);
    json(res, 200, { url: `/api/workspaces/${id}/preview/` });
    return;
  }

  if (parts[3] === 'preview') {
    if (SANDBOX_BASE_URL) {
      const rest = `/${parts.slice(4).join('/')}`;
      await proxySandboxHttp(req, res, `/v1/workspaces/${id}/preview${rest === '/' ? '/' : rest}`);
      return;
    }
    await proxyToSandbox(req, res, id, `/api/workspaces/${id}/preview`, PREVIEW_PORT);
    return;
  }

  if (req.method === 'POST' && parts[3] === 'deploy') {
    if (SANDBOX_BASE_URL) {
      const deployment = await sandboxRequest(`/v1/workspaces/${id}/deploy`, { method: 'POST', body: {} });
      json(res, 200, {
        ...deployment,
        url: `/api/workspaces/${id}/deployments/${deployment.deployId}/`
      });
      return;
    }
    const deployId = await deployWorkspace(id);
    json(res, 200, {
      deployId,
      url: `/api/workspaces/${id}/deployments/${deployId}/`
    });
    return;
  }

  if (parts[3] === 'deployments' && parts[4]) {
    if (SANDBOX_BASE_URL) {
      const rest = `/${parts.slice(5).join('/')}`;
      await proxySandboxHttp(req, res, `/v1/workspaces/${id}/deployments/${parts[4]}${rest === '/' ? '/' : rest}`);
      return;
    }
    const routePrefix = `/api/workspaces/${id}/deployments/${parts[4]}`;
    await serveDeployment(req, res, id, parts[4], routePrefix);
    return;
  }

  notFound(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (await proxyPreviewRootRequest(req, res, url)) {
      return;
    }
    if (url.pathname.startsWith('/api/runtime/')) {
      await proxyRuntimeHttp(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  if (handleSandboxWebSocket(req, socket, head)) {
    return;
  }
  socket.destroy();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NewBolt MVP gateway listening on http://0.0.0.0:${PORT}`);
});
