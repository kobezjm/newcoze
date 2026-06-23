const state = {
  workspaceId: null,
  files: [],
  activeFile: null,
  activeTab: 'files',
  terminalInput: '',
  terminalCwd: '/',
  terminalHistory: [],
  terminalHistoryIndex: -1,
  terminalBusy: false
};

const claudeOutputBuffers = new WeakMap();

const els = {
  workspaceId: document.querySelector('#workspaceId'),
  status: document.querySelector('#status'),
  messages: document.querySelector('#messages'),
  prompt: document.querySelector('#prompt'),
  chatForm: document.querySelector('#chatForm'),
  newWorkspace: document.querySelector('#newWorkspace'),
  refreshFiles: document.querySelector('#refreshFiles'),
  startPreview: document.querySelector('#startPreview'),
  deploy: document.querySelector('#deploy'),
  fileList: document.querySelector('#fileList'),
  activePath: document.querySelector('#activePath'),
  editor: document.querySelector('#editor'),
  saveFile: document.querySelector('#saveFile'),
  previewFrame: document.querySelector('#previewFrame'),
  previewUrl: document.querySelector('#previewUrl'),
  terminalSurface: document.querySelector('#terminalSurface'),
  terminalEntry: document.querySelector('#terminalEntry'),
  terminalOutput: document.querySelector('#terminalOutput'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  views: Array.from(document.querySelectorAll('.tab-view'))
};

function setStatus(value) {
  els.status.textContent = value;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {
      message = await response.text();
    }
    throw new Error(message);
  }

  return response.json();
}

function addMessage(role, text) {
  const node = document.createElement('div');
  node.className = `message ${role}`;
  node.textContent = text;
  els.messages.appendChild(node);
  scrollMessagesIfNeeded(true);
  return node;
}

function shouldStickToBottom() {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
}

function scrollMessagesIfNeeded(force = false) {
  if (force || shouldStickToBottom()) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

function appendMessage(node, text) {
  node.textContent += text;
  scrollMessagesIfNeeded();
}

function appendTextPart(container, text) {
  if (!text) return;

  let target = container.lastElementChild;
  if (!target || !target.classList.contains('message-text')) {
    target = document.createElement('div');
    target.className = 'message-text';
    container.appendChild(target);
  }

  target.textContent += text;
  scrollMessagesIfNeeded();
}

function renderToolCard(container, event) {
  const card = document.createElement('div');
  card.className = `tool-card ${event.kind || 'tool'}`;

  const header = document.createElement('div');
  header.className = 'tool-card-header';

  const label = document.createElement('span');
  label.className = 'tool-card-label';
  label.textContent = event.title || '工具调用';

  const name = document.createElement('span');
  name.className = 'tool-card-name';
  name.textContent = event.name || '';

  header.append(label, name);
  card.appendChild(header);

  const body = document.createElement('pre');
  body.className = 'tool-card-body';

  if (event.kind === 'command') {
    body.textContent = event.input?.command || JSON.stringify(event.input || {}, null, 2);
  } else if (event.text) {
    body.textContent = event.text;
  } else {
    body.textContent = JSON.stringify(event.input || {}, null, 2);
  }

  card.appendChild(body);
  container.appendChild(card);
  scrollMessagesIfNeeded();
}

function processClaudeOutputLine(container, line) {
  if (!line.trim()) return;

  try {
    const event = JSON.parse(line);
    if (event.kind === 'text' || event.kind === 'raw') {
      appendTextPart(container, event.text || '');
    } else {
      renderToolCard(container, event);
    }
  } catch {
    appendTextPart(container, `${line}\n`);
  }
}

function appendClaudeOutput(container, chunk = '', flush = false) {
  const buffered = claudeOutputBuffers.get(container) || '';
  const text = buffered + chunk;
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() || '';

  for (const line of lines) {
    processClaudeOutputLine(container, line);
  }

  if (flush) {
    processClaudeOutputLine(container, remainder);
    claudeOutputBuffers.delete(container);
    return;
  }

  claudeOutputBuffers.set(container, remainder);
}

function setActiveTab(tab) {
  state.activeTab = tab;
  els.tabs.forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  els.views.forEach((view) => {
    view.classList.toggle('active', view.dataset.view === tab);
  });
}

async function createWorkspace() {
  resetSessionView();
  setStatus('创建中');
  const workspace = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({}) });
  state.workspaceId = workspace.id;
  els.workspaceId.textContent = workspace.id;
  setStatus('就绪');
  addMessage('assistant', '工作区已就绪。你可以直接让 Claude Code 开发项目，也可以在终端里输入命令。');
  await refreshFiles();
}

function resetSessionView() {
  state.workspaceId = null;
  state.files = [];
  state.activeFile = null;
  state.terminalInput = '';
  state.terminalCwd = '/';
  state.terminalHistory = [];
  state.terminalHistoryIndex = -1;
  state.terminalBusy = false;
  els.workspaceId.textContent = '创建中...';
  els.messages.innerHTML = '';
  els.fileList.innerHTML = '';
  els.activePath.textContent = '未选择文件';
  els.editor.value = '';
  els.previewFrame.removeAttribute('src');
  els.previewUrl.textContent = '未启动';
  els.previewUrl.removeAttribute('href');
  els.terminalOutput.textContent = '沙箱终端已打开。直接输入命令后按 Enter 执行。\n';
  renderTerminalInput();
  setActiveTab('files');
}

async function refreshFiles() {
  if (!state.workspaceId) return;
  const payload = await api(`/api/workspaces/${state.workspaceId}/files`);
  state.files = payload.files;
  renderFiles();
}

function renderFiles() {
  els.fileList.innerHTML = '';

  if (!state.files.length) {
    const empty = document.createElement('div');
    empty.className = 'message';
    empty.textContent = '暂无文件。';
    els.fileList.appendChild(empty);
    return;
  }

  for (const file of state.files) {
    const button = document.createElement('button');
    button.className = 'file-item';
    button.textContent = file.path;
    button.title = file.path;
    button.classList.toggle('active', file.path === state.activeFile);
    button.addEventListener('click', () => openFile(file.path));
    els.fileList.appendChild(button);
  }
}

async function openFile(file) {
  const payload = await api(`/api/workspaces/${state.workspaceId}/file?path=${encodeURIComponent(file)}`);
  state.activeFile = file;
  els.activePath.textContent = file;
  els.editor.value = payload.content;
  renderFiles();
}

async function saveFile() {
  if (!state.activeFile) return;
  setStatus('保存中');
  await api(`/api/workspaces/${state.workspaceId}/file`, {
    method: 'PUT',
    body: JSON.stringify({ path: state.activeFile, content: els.editor.value })
  });
  setStatus('就绪');
  await refreshFiles();
}

async function consumeNdjson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line));
    }
  }

  if (buffer.trim()) {
    onEvent(JSON.parse(buffer));
  }
}

async function streamPost(path, payload, onEvent) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  await consumeNdjson(response, onEvent);
}

async function sendPrompt(event) {
  event.preventDefault();
  const message = els.prompt.value.trim();
  if (!message || !state.workspaceId) return;

  els.prompt.value = '';
  addMessage('user', message);
  const assistant = addMessage('assistant structured', '');
  setStatus('Claude Code 执行中');

  try {
    await streamPost(`/api/workspaces/${state.workspaceId}/chat`, { message }, (item) => {
      if (item.type === 'status') renderToolCard(assistant, { kind: 'system', title: '状态', text: item.message });
      if (item.type === 'stdout') appendClaudeOutput(assistant, item.data);
      if (item.type === 'stderr') renderToolCard(assistant, { kind: 'error', title: '错误输出', text: item.data });
      if (item.type === 'error') renderToolCard(assistant, { kind: 'error', title: '错误', text: item.message });
      if (item.type === 'done') {
        appendClaudeOutput(assistant, '', true);
        renderToolCard(assistant, { kind: item.exitCode === 0 ? 'system' : 'error', title: '执行结束', text: `退出码 ${item.exitCode}` });
      }
    });
    setStatus('就绪');
    await refreshFiles();
  } catch (error) {
    setStatus('错误');
    appendMessage(assistant, `\n${error.message}`);
    assistant.classList.add('error');
  }
}

async function startPreview() {
  if (!state.workspaceId) return;
  setStatus('启动预览');
  const payload = await api(`/api/workspaces/${state.workspaceId}/preview/start`, { method: 'POST', body: JSON.stringify({}) });
  const previewUrl = `${payload.url}?t=${Date.now()}`;
  const absoluteUrl = new URL(payload.url, location.origin).href;
  els.previewUrl.href = absoluteUrl;
  els.previewUrl.textContent = absoluteUrl;
  els.previewFrame.src = previewUrl;
  setActiveTab('preview');
  setStatus('就绪');
}

async function deploy() {
  if (!state.workspaceId) return;
  setStatus('部署中');
  const payload = await api(`/api/workspaces/${state.workspaceId}/deploy`, { method: 'POST', body: JSON.stringify({}) });
  addMessage('assistant', `部署快照已生成：\n${location.origin}${payload.url}`);
  els.previewFrame.src = payload.url;
  setActiveTab('preview');
  setStatus('就绪');
}

function renderTerminalInput() {
  const prompt = els.terminalSurface.querySelector('.terminal-prompt');
  if (prompt) prompt.textContent = `${state.terminalCwd || '/'} $`;
  els.terminalEntry.textContent = state.terminalInput;
  scrollTerminalToBottom();
}

function scrollTerminalToBottom() {
  els.terminalSurface.scrollTop = els.terminalSurface.scrollHeight;
}

async function runTerminalCommand(command) {
  if (!command || !state.workspaceId) return;
  if (state.terminalBusy) return;

  state.terminalBusy = true;
  state.terminalInput = '';
  state.terminalHistory.push(command);
  state.terminalHistoryIndex = state.terminalHistory.length;
  renderTerminalInput();
  els.terminalOutput.textContent += `${state.terminalCwd || '/'} $ ${command}\n`;
  setStatus('命令执行中');

  try {
    await streamPost(`/api/workspaces/${state.workspaceId}/commands`, { command }, (item) => {
      if (item.type === 'stdout') els.terminalOutput.textContent += item.data;
      if (item.type === 'stderr') els.terminalOutput.textContent += item.data;
      if (item.type === 'cwd') {
        state.terminalCwd = item.cwd || '/';
        renderTerminalInput();
      }
      if (item.type === 'done') els.terminalOutput.textContent += `\n退出码 ${item.exitCode}\n`;
      scrollTerminalToBottom();
    });
    setStatus('就绪');
    await refreshFiles();
  } catch (error) {
    els.terminalOutput.textContent += `\n${error.message}\n`;
    setStatus('错误');
  } finally {
    state.terminalBusy = false;
    scrollTerminalToBottom();
  }
}

function handleTerminalKey(event) {
  if (state.activeTab !== 'terminal') return;

  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'l') {
      event.preventDefault();
      els.terminalOutput.textContent = '';
    }
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    const command = state.terminalInput.trim();
    runTerminalCommand(command);
    return;
  }

  if (event.key === 'Backspace') {
    event.preventDefault();
    state.terminalInput = state.terminalInput.slice(0, -1);
    renderTerminalInput();
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (!state.terminalHistory.length) return;
    state.terminalHistoryIndex = Math.max(0, state.terminalHistoryIndex - 1);
    state.terminalInput = state.terminalHistory[state.terminalHistoryIndex] || '';
    renderTerminalInput();
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (!state.terminalHistory.length) return;
    state.terminalHistoryIndex = Math.min(state.terminalHistory.length, state.terminalHistoryIndex + 1);
    state.terminalInput = state.terminalHistory[state.terminalHistoryIndex] || '';
    renderTerminalInput();
    return;
  }

  if (event.key.length === 1) {
    event.preventDefault();
    state.terminalInput += event.key;
    renderTerminalInput();
  }
}

function handleTerminalPaste(event) {
  event.preventDefault();
  const text = event.clipboardData?.getData('text') || '';
  state.terminalInput += text.replace(/\r?\n/g, ' ');
  renderTerminalInput();
}

els.chatForm.addEventListener('submit', sendPrompt);
els.newWorkspace.addEventListener('click', createWorkspace);
els.refreshFiles.addEventListener('click', refreshFiles);
els.saveFile.addEventListener('click', saveFile);
els.startPreview.addEventListener('click', startPreview);
els.deploy.addEventListener('click', deploy);
els.terminalSurface.addEventListener('keydown', handleTerminalKey);
els.terminalSurface.addEventListener('paste', handleTerminalPaste);
els.terminalSurface.addEventListener('click', () => els.terminalSurface.focus());
els.tabs.forEach((button) => {
  button.addEventListener('click', () => {
    setActiveTab(button.dataset.tab);
    if (button.dataset.tab === 'terminal') {
      setTimeout(() => els.terminalSurface.focus(), 0);
    }
  });
});

createWorkspace().catch((error) => {
  setStatus('错误');
  addMessage('error', error.message);
});
