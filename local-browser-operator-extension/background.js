const SERVER = "http://127.0.0.1:17654";
const clientId = crypto.randomUUID();
const DEFAULT_GROUP_TITLE = "My Browser";
const DEFAULT_GROUP_COLOR = "purple";

let polling = false;
let attachedTabId = null;
let lastAgentError = null;
let lastCommandAt = null;
let lastCompletedAt = null;
const logs = [];
const eventBuffers = {
  console: [],
  errors: [],
  requests: []
};

function log(message, data) {
  const entry = {
    at: new Date().toISOString(),
    message,
    data
  };
  logs.unshift(entry);
  logs.splice(80);
  console.log("[my-browser]", message, data ?? "");
}

function normalizeGroupTitle(title) {
  return String(title || DEFAULT_GROUP_TITLE).trim() || DEFAULT_GROUP_TITLE;
}

async function loadGroupId(title = DEFAULT_GROUP_TITLE) {
  const groupTitle = normalizeGroupTitle(title);
  const stored = await chrome.storage.local.get(["operatorGroupsByTitle", "operatorGroupId"]);
  const groups = stored.operatorGroupsByTitle && typeof stored.operatorGroupsByTitle === "object"
    ? stored.operatorGroupsByTitle
    : {};
  const value = Number(groups[groupTitle]);
  if (Number.isFinite(value) && value >= 0) return value;
  if (groupTitle === DEFAULT_GROUP_TITLE) {
    const legacyValue = Number(stored.operatorGroupId);
    if (Number.isFinite(legacyValue) && legacyValue >= 0) return legacyValue;
  }
  return null;
}

async function rememberGroup(title, groupId) {
  const groupTitle = normalizeGroupTitle(title);
  const stored = await chrome.storage.local.get("operatorGroupsByTitle");
  const groups = stored.operatorGroupsByTitle && typeof stored.operatorGroupsByTitle === "object"
    ? stored.operatorGroupsByTitle
    : {};
  groups[groupTitle] = groupId;
  await chrome.storage.local.set({
    operatorGroupsByTitle: groups,
    lastOperatorGroupTitle: groupTitle
  });
}

async function forgetGroup(title = null) {
  if (!title) {
    await chrome.storage.local.remove(["operatorGroupId", "operatorGroupsByTitle", "lastOperatorGroupTitle"]);
    return;
  }
  const groupTitle = normalizeGroupTitle(title);
  const stored = await chrome.storage.local.get("operatorGroupsByTitle");
  const groups = stored.operatorGroupsByTitle && typeof stored.operatorGroupsByTitle === "object"
    ? stored.operatorGroupsByTitle
    : {};
  delete groups[groupTitle];
  await chrome.storage.local.set({ operatorGroupsByTitle: groups });
}

async function loadLastGroupTitle() {
  const stored = await chrome.storage.local.get("lastOperatorGroupTitle");
  return normalizeGroupTitle(stored.lastOperatorGroupTitle);
}

async function loadGroupIdLegacy() {
  const stored = await chrome.storage.local.get("operatorGroupId");
  const value = Number(stored.operatorGroupId);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

async function attachTab(tabId) {
  if (attachedTabId === tabId) return;
  if (attachedTabId !== null) {
    await chrome.debugger.detach({ tabId: attachedTabId }).catch(() => {});
    attachedTabId = null;
  }
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabId = tabId;
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  await chrome.debugger.sendCommand({ tabId }, "Log.enable").catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Network.enable").catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Accessibility.enable").catch(() => {});
}

async function detachTab() {
  if (attachedTabId !== null) {
    await chrome.debugger.detach({ tabId: attachedTabId }).catch(() => {});
    attachedTabId = null;
  }
}

async function ensureAttached(command) {
  const tab = command.tabId ? { id: command.tabId } : await activeTab();
  await attachTab(tab.id);
  return tab.id;
}

async function evaluate(command) {
  const tabId = await ensureAttached(command);
  return chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: command.expression,
    awaitPromise: true,
    returnByValue: true
  });
}

async function click(command) {
  const tabId = await ensureAttached(command);
  const clickCount = command.clickCount || 1;
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: command.x,
    y: command.y,
    button: "left",
    clickCount
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: command.x,
    y: command.y,
    button: "left",
    clickCount
  });
  return { clicked: true, x: command.x, y: command.y, clickCount };
}

async function hover(command) {
  const tabId = await ensureAttached(command);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: command.x,
    y: command.y
  });
  return { hovered: true, x: command.x, y: command.y };
}

async function typeText(command) {
  const tabId = await ensureAttached(command);
  await insertText({ tabId, text: command.text ?? "" });
  return { typed: command.text?.length ?? 0 };
}

function controlKeyForChar(char) {
  if (char === "\n" || char === "\r") return "Enter";
  if (char === "\t") return "Tab";
  return null;
}

async function keyboardType(command) {
  const tabId = await ensureAttached(command);
  for (const char of command.text ?? "") {
    const controlKey = controlKeyForChar(char);
    if (controlKey) {
      await press({ tabId, key: controlKey });
    } else {
      await insertText({ tabId, text: char });
    }
  }
  return { keyboardTyped: command.text?.length ?? 0 };
}

async function insertText(command) {
  const tabId = await ensureAttached(command);
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", {
    text: command.text ?? ""
  });
  return { inserted: command.text?.length ?? 0 };
}

function splitNthSelector(selector) {
  const match = /^(.*?)\s*>>\s*nth\s*=\s*(\d+)\s*$/.exec(selector);
  if (!match) return { selector, nth: 0 };
  return { selector: match[1].trim(), nth: Number(match[2]) };
}

async function uploadFiles(command) {
  const tabId = await ensureAttached(command);
  if (!command.selector && !command.backendDOMNodeId) throw new Error("Missing upload selector or backend node");
  if (!Array.isArray(command.files) || command.files.length === 0) throw new Error("Missing upload files");
  const { selector, nth } = splitNthSelector(command.selector || "");
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
  if (command.backendDOMNodeId) {
    await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
      backendNodeId: command.backendDOMNodeId,
      files: command.files
    });
    return {
      uploaded: true,
      backendDOMNodeId: command.backendDOMNodeId,
      selector: command.selector || null,
      files: command.files,
      fileNames: command.files.map((file) => file.split("/").at(-1))
    };
  }
  const { root } = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1, pierce: true });
  const { nodeIds } = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelectorAll", { nodeId: root.nodeId, selector });
  const nodeId = nodeIds?.[nth];
  if (!nodeId) throw new Error(`Upload input not found: ${command.selector}`);
  const { node } = await chrome.debugger.sendCommand({ tabId }, "DOM.describeNode", { nodeId }).catch(() => ({ node: null }));
  await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", { nodeId, files: command.files });
  return {
    uploaded: true,
    selector: command.selector,
    matchedSelector: selector,
    nth,
    backendDOMNodeId: node?.backendNodeId,
    files: command.files,
    fileNames: command.files.map((file) => file.split("/").at(-1))
  };
}

function valueOfAxProperty(properties = [], name) {
  return properties.find((property) => property.name === name)?.value?.value;
}

function roleAllowed(role) {
  return [
    "button",
    "link",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "option",
    "menuitem",
    "tab",
    "switch",
    "slider",
    "spinbutton"
  ].includes(role);
}

async function inspectBackendNode(tabId, backendDOMNodeId) {
  try {
    const resolved = await chrome.debugger.sendCommand({ tabId }, "DOM.resolveNode", { backendNodeId: backendDOMNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) return null;
    const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        if (!(this instanceof Element)) return null;
        const rect = this.getBoundingClientRect();
        const style = getComputedStyle(this);
        if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") return null;
        function cssPath(el) {
          const parts = [];
          let node = el;
          while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
            if (node.id) {
              parts.unshift("#" + CSS.escape(node.id));
              break;
            }
            const tag = node.tagName.toLowerCase();
            const parent = node.parentElement;
            if (!parent) break;
            const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
            const index = siblings.indexOf(node) + 1;
            parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
            node = parent;
          }
          return parts.join(" > ");
        }
        return {
          selector: cssPath(this),
          tag: this.tagName.toLowerCase(),
          type: this.getAttribute("type") || undefined,
          href: this.href || undefined,
          value: "value" in this ? this.value : undefined,
          checked: "checked" in this ? Boolean(this.checked) : undefined,
          placeholder: this.getAttribute("placeholder") || undefined,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      }`
    });
    return result.result?.value || null;
  } catch {
    return null;
  }
}

async function axSnapshot(command) {
  const tabId = await ensureAttached(command);
  const tree = await chrome.debugger.sendCommand({ tabId }, "Accessibility.getFullAXTree");
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const limit = command.limit || 60;
  const elements = [];
  for (const node of tree.nodes || []) {
    const role = node.role?.value;
    const name = String(node.name?.value || valueOfAxProperty(node.properties, "label") || "").replace(/\s+/g, " ").trim();
    if (!node.backendDOMNodeId || !roleAllowed(role)) continue;
    const details = await inspectBackendNode(tabId, node.backendDOMNodeId);
    if (!details) continue;
    elements.push({
      ref: `@e${elements.length + 1}`,
      role,
      name: name.slice(0, command.full ? 160 : 80),
      backendDOMNodeId: node.backendDOMNodeId,
      selector: details.selector,
      tag: details.tag,
      type: details.type,
      value: details.value,
      checked: details.checked,
      href: details.href,
      placeholder: details.placeholder,
      x: details.x,
      y: details.y,
      width: details.width,
      height: details.height
    });
    if (elements.length >= limit) break;
  }
  return {
    source: "accessibility",
    tabId,
    title: tab?.title || "",
    url: tab?.url || "",
    truncated: (tree.nodes || []).length > limit,
    elements
  };
}

async function elementBox(command) {
  const tabId = await ensureAttached(command);
  if (command.backendDOMNodeId) {
    const details = await inspectBackendNode(tabId, command.backendDOMNodeId);
    if (!details) throw new Error(`Element ref is stale: backendDOMNodeId ${command.backendDOMNodeId}`);
    return details;
  }
  if (!command.selector) throw new Error("Missing selector");
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(command.selector)});
    if (!el) throw new Error("Element not found");
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    return {
      selector: ${JSON.stringify(command.selector)},
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  })()`;
  const result = await evaluate({ type: "eval", tabId, expression });
  return result.result?.value;
}

async function screenshot(command) {
  const tabId = await ensureAttached(command);
  return chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  });
}

async function navigate(command) {
  if (command.group !== false) {
    return openInOperatorGroup({
      url: command.url,
      active: command.active,
      groupTitle: command.groupTitle,
      color: command.color,
      front: command.front
    });
  }
  const tabId = await ensureAttached(command);
  await chrome.debugger.sendCommand({ tabId }, "Page.navigate", {
    url: command.url
  });
  return { navigated: true, url: command.url };
}

async function existingGroup(groupId) {
  if (!groupId || groupId < 0) return null;
  try {
    return await chrome.tabGroups.get(groupId);
  } catch {
    return null;
  }
}

async function openInOperatorGroup(command) {
  const title = normalizeGroupTitle(command.groupTitle);
  const color = command.color || DEFAULT_GROUP_COLOR;
  const tab = await chrome.tabs.create({
    url: command.url || "about:blank",
    active: command.active === true
  });

  const rememberedGroupId = await loadGroupId(title);
  const group = await existingGroup(rememberedGroupId);
  const groupId = group
    ? await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] })
    : await chrome.tabs.group({ tabIds: [tab.id] });

  await chrome.tabGroups.update(groupId, { title, color });
  await rememberGroup(title, groupId);
  const groupMove = await moveGroupToFront(groupId);
  return {
    tabId: tab.id,
    groupId,
    title,
    color,
    url: tab.url,
    active: command.active === true,
    front: command.front === true,
    groupFront: groupMove.moved === true
  };
}

async function groupInfo() {
  const title = normalizeGroupTitle((await chrome.storage.local.get("lastOperatorGroupTitle")).lastOperatorGroupTitle);
  const group = await existingGroup(await loadGroupId(title));
  return {
    groupId: group?.id ?? null,
    title: group?.title ?? title,
    color: group?.color ?? null
  };
}

async function moveGroupToFront(groupId, groupTitle = null) {
  const targetGroupId = groupId || await loadGroupId(groupTitle || await loadLastGroupTitle()) || await loadGroupIdLegacy();
  const group = await existingGroup(targetGroupId);
  if (!group) return { moved: false, reason: "No operator group" };
  const tabs = await chrome.tabs.query({ groupId: group.id, windowId: group.windowId });
  const tabIds = tabs
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.id)
    .filter(Boolean);
  if (!tabIds.length) return { moved: false, reason: "No tabs in operator group", groupId: group.id };
  await chrome.tabs.move(tabIds, { index: 0 });
  return { moved: true, groupId: group.id, tabIds };
}

async function groupForget() {
  await forgetGroup();
  return { forgotGroup: true };
}

function keyDetails(key) {
  return {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
    Delete: { code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 }
  }[key] || {};
}

function modifierMask(parts) {
  return parts.reduce((mask, part) => {
    const normalized = part.toLowerCase();
    if (normalized === "alt" || normalized === "option") return mask | 1;
    if (normalized === "control" || normalized === "ctrl") return mask | 2;
    if (normalized === "meta" || normalized === "cmd" || normalized === "command") return mask | 4;
    if (normalized === "shift") return mask | 8;
    return mask;
  }, 0);
}

async function press(command) {
  const tabId = await ensureAttached(command);
  const parts = String(command.key || "").split("+").filter(Boolean);
  const key = parts.at(-1);
  const modifiers = modifierMask(parts.slice(0, -1));
  const details = keyDetails(key);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    modifiers,
    ...details
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    modifiers,
    ...details
  });
  return { pressed: command.key, key, modifiers };
}

async function mouse(command) {
  const tabId = await ensureAttached(command);
  const action = command.action;
  if (action === "move") {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: command.x,
      y: command.y
    });
    return { mouse: "move", x: command.x, y: command.y };
  }
  if (action === "down" || action === "up") {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: action === "down" ? "mousePressed" : "mouseReleased",
      x: command.x,
      y: command.y,
      button: command.button || "left",
      clickCount: command.clickCount || 1
    });
    return { mouse: action, x: command.x, y: command.y, button: command.button || "left" };
  }
  if (action === "wheel") {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: command.x ?? 1,
      y: command.y ?? 1,
      deltaX: command.deltaX || 0,
      deltaY: command.deltaY || 0
    });
    return { mouse: "wheel", deltaX: command.deltaX || 0, deltaY: command.deltaY || 0 };
  }
  throw new Error(`Unsupported mouse action: ${action}`);
}

async function closeTab(command) {
  const tab = command.tabId ? { id: command.tabId } : await activeTab();
  await chrome.tabs.remove(tab.id);
  if (attachedTabId === tab.id) attachedTabId = null;
  return { closed: true, tabId: tab.id };
}

async function tabs() {
  return chrome.tabs.query({});
}

function pushEvent(kind, event) {
  const entry = { at: new Date().toISOString(), ...event };
  eventBuffers[kind].unshift(entry);
  eventBuffers[kind].splice(80);
}

function runtimeDiagnostics() {
  return {
    polling,
    clientId,
    attachedTabId,
    lastAgentError,
    lastCommandAt,
    lastCompletedAt,
    queuePollingMs: 800,
    groupTitle: DEFAULT_GROUP_TITLE,
    manifestVersion: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    logs: logs.slice(0, 20),
    events: {
      console: eventBuffers.console.length,
      errors: eventBuffers.errors.length,
      requests: eventBuffers.requests.length
    }
  };
}

function readEvents(command) {
  const kind = command.kind;
  if (!eventBuffers[kind]) throw new Error(`Unsupported event kind: ${kind}`);
  const items = eventBuffers[kind].slice(0, command.limit || 40);
  if (command.clear) eventBuffers[kind] = [];
  return { kind, count: items.length, items };
}

async function handleCommand(command) {
  switch (command.type) {
    case "tabs":
      return tabs();
    case "attach-active": {
      const tab = await activeTab();
      await attachTab(tab.id);
      return { attachedTabId: tab.id, title: tab.title, url: tab.url };
    }
    case "detach":
      await detachTab();
      return { detached: true };
    case "close":
      return closeTab(command);
    case "open":
      return navigate(command);
    case "group-open":
      return openInOperatorGroup(command);
    case "group-info":
      return groupInfo();
    case "group-front":
      return moveGroupToFront(command.groupId, command.groupTitle);
    case "group-forget":
      return groupForget();
    case "diagnostics":
      return runtimeDiagnostics();
    case "events":
      return readEvents(command);
    case "snapshot":
      return axSnapshot(command);
    case "element-box":
      return elementBox(command);
    case "eval":
      return evaluate(command);
    case "click":
      return click(command);
    case "dblclick":
      return click({ ...command, clickCount: 2 });
    case "hover":
      return hover(command);
    case "type":
      return typeText(command);
    case "keyboard-type":
      return keyboardType(command);
    case "insert-text":
      return insertText(command);
    case "upload":
      return uploadFiles(command);
    case "press":
      return press(command);
    case "mouse":
      return mouse(command);
    case "screenshot":
      return screenshot(command);
    default:
      throw new Error(`Unsupported command type: ${command.type}`);
  }
}

async function postResult(command, payload) {
  await fetch(`${SERVER}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: command.id, clientId, ...payload })
  });
}

async function pollOnce() {
  const response = await fetch(`${SERVER}/next?clientId=${encodeURIComponent(clientId)}`);
  const command = await response.json();
  lastAgentError = null;
  if (!command) return;
  lastCommandAt = new Date().toISOString();
  log("Command received", command);
  try {
    const result = await handleCommand(command);
    await postResult(command, { ok: true, result });
    lastCompletedAt = new Date().toISOString();
    log("Command completed", command.type === "diagnostics" ? { diagnostics: true } : result);
  } catch (error) {
    const message = String(error?.message ?? error);
    await postResult(command, { ok: false, error: message });
    log("Command failed", message);
  }
}

async function startPolling() {
  if (polling) return { polling: true, clientId };
  polling = true;
  log("Background operator started", { clientId });
  while (polling) {
    try {
      await pollOnce();
    } catch (error) {
      lastAgentError = String(error?.message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return { polling, clientId };
}

function status() {
  return {
    polling,
    clientId,
    attachedTabId,
    lastAgentError,
    lastCommandAt,
    lastCompletedAt,
    logs: logs.slice(0, 20)
  };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("my-browser-pulse", { periodInMinutes: 1 });
  startPolling();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("my-browser-pulse", { periodInMinutes: 1 });
  startPolling();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "my-browser-pulse") startPolling();
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === attachedTabId) attachedTabId = null;
  log("Debugger detached", { source, reason });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return;
  if (method === "Runtime.consoleAPICalled") {
    pushEvent("console", {
      tabId: source.tabId,
      type: params.type,
      text: (params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ").slice(0, 1000),
      url: params.stackTrace?.callFrames?.[0]?.url,
      lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber
    });
  }
  if (method === "Runtime.exceptionThrown") {
    pushEvent("errors", {
      tabId: source.tabId,
      text: params.exceptionDetails?.text,
      description: params.exceptionDetails?.exception?.description,
      url: params.exceptionDetails?.url,
      lineNumber: params.exceptionDetails?.lineNumber
    });
  }
  if (method === "Log.entryAdded") {
    const entry = params.entry || {};
    if (entry.level === "error") {
      pushEvent("errors", {
        tabId: source.tabId,
        text: entry.text,
        source: entry.source,
        url: entry.url,
        lineNumber: entry.lineNumber
      });
    }
  }
  if (method === "Network.responseReceived" || method === "Network.loadingFailed") {
    const response = params.response || {};
    pushEvent("requests", {
      tabId: source.tabId,
      method,
      requestId: params.requestId,
      url: response.url || params.request?.url,
      status: response.status,
      type: params.type,
      errorText: params.errorText
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "status") return status();
    if (message?.type === "connect") return startPolling();
    if (message?.type === "attach-active") return handleCommand({ type: "attach-active" });
    if (message?.type === "detach") return handleCommand({ type: "detach" });
    if (message?.type === "logs") return logs.slice(0, 80);
    throw new Error(`Unsupported runtime message: ${message?.type}`);
  })()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});

startPolling();
